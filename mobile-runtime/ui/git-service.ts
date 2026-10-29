import type { GitFileChange, GitRepositorySummary } from "@zcode/shared";
import type { IGitService } from "@zcode/services/deep/git/git.js";
import { createGitFs } from "../compat/git-fs-adapter.mjs";
import { loadGit } from "./git-tool.js";
import { loadCoreFromAsset } from "./tool-engine.js";
import { mobileGitDiff } from "./git-diff.js";
import { gitRelativePath, scopedGitFs } from "./git-path.js";
import { localWorkspacePath } from "../compat/workspace-aliases.mjs";
import { scanGitStates, readGitVersion, sameGitVersion, stageGitPaths, type GitFileState } from "./git-state.js";

// 面板与 Agent 读取同一份 core VFS；SAF 的镜像尚无跨调用事务锁，不能伪装成完整面板。
type GitApi = Record<"readObject" | "getConfig" | "walk" | "TREE" | "STAGE" | "WORKDIR" | "hashBlob" | "isIgnored" |
  "currentBranch" | "log" | "listBranches" | "resolveRef" | "readCommit" | "checkout" | "branch" | "deleteBranch" |
  "add" | "remove" | "resetIndex" | "commit", (...args: any[]) => any>;
type GitContext = { git: GitApi; fs: any; dir: string; isRepository: boolean };
export function createMobileGitService(options: { load?: (workspacePath: string) => Promise<GitContext | null> } = {}): IGitService {
  const load = options.load ?? (async (dir: string): Promise<GitContext | null> => {
    dir = localWorkspacePath(dir);
    if (dir === "/mnt" || dir.startsWith("/mnt/")) return null;
    const core = await loadCoreFromAsset();
    if (!core) return null;
    const vfs = core.vfs as typeof core.vfs & { existsSync(path: string): boolean };
    const git = await loadGit() as unknown as GitApi;
    return { git, fs: createGitFs(vfs), dir, isRepository: vfs.existsSync(`${dir}/.git`) };
  });
  const unavailable = () => new Error("此 Git 面板操作在移动端尚不可用，可使用 Agent 的 Git 工具");
  async function safeLoad(workspacePath: string): Promise<GitContext | null> {
    const ctx = await load(workspacePath);
    return ctx ? { ...ctx, fs: scopedGitFs(ctx.fs, ctx.dir) } : null;
  }
  async function context(workspacePath: string, requireRepository = true): Promise<GitContext> {
    const ctx = await safeLoad(workspacePath);
    if (!ctx) throw new Error("此工作区的 Git 面板暂不可用；请使用本地文件夹");
    if (requireRepository && !ctx.isRepository) throw new Error("当前工作区不是 Git 仓库");
    return ctx;
  }
  function relative(dir: string, input: string): string {
    return gitRelativePath(dir, input);
  }
  async function changes(ctx: GitContext, source: "staged" | "unstaged", states?: GitFileState[]): Promise<GitFileChange[]> {
    const out: GitFileChange[] = [];
    for (const { file, head, index, work, conflicted } of states ?? await scanGitStates(ctx)) {
      if (conflicted && source === "staged") continue;
      const before = source === "staged" ? head : index, after = source === "staged" ? index : work;
      if (!conflicted && sameGitVersion(before, after)) continue;
      const untracked = source === "unstaged" && !index && Boolean(work);
      const kind = conflicted ? "modified" : !after ? "deleted" : !before ? "added" : "modified";
      const section = conflicted ? "conflicted" : source === "staged" ? "staged" : untracked ? "untracked" : "unstaged";
      // 未解决冲突的 index 有多个阶段，单一 blob 不是可比较的暂存内容。
      const { added, removed } = conflicted ? { added: 0, removed: 0 } : await mobileGitDiff(`${ctx.dir}/${file}`, file, before, after, version => readGitVersion(ctx, version));
      out.push({ path: `${ctx.dir}/${file}`, repoRelativePath: file, workspaceRelativePath: file,
        kind, section, added, removed, isStaged: source === "staged", isUntracked: untracked, isConflicted: conflicted });
    }
    return out;
  }
  async function summary(workspacePath: string): Promise<GitRepositorySummary> {
    const ctx = await safeLoad(workspacePath);
    const base: GitRepositorySummary = { workspacePath, repoRoot: workspacePath, workspaceInRepoPath: "",
      autoRefreshWatchPaths: [], branchName: null, trackingBranchName: null, headRefType: "branch",
      ahead: 0, behind: 0, isDirty: false, isGitAvailable: Boolean(ctx), isRepository: Boolean(ctx?.isRepository) };
    if (!ctx?.isRepository) return base;
    const branchName = await ctx.git.currentBranch({ fs: ctx.fs, dir: ctx.dir, fullname: false }).catch(() => null) as string | null;
    const remote = branchName ? await ctx.git.getConfig({ fs: ctx.fs, dir: ctx.dir, path: `branch.${branchName}.remote` }).catch(() => null) as string | null : null;
    const merge = branchName ? await ctx.git.getConfig({ fs: ctx.fs, dir: ctx.dir, path: `branch.${branchName}.merge` }).catch(() => null) as string | null : null;
    let tracking = remote && merge?.startsWith("refs/heads/") ? `${remote}/${merge.slice(11)}` : null;
    let ahead = 0, behind = 0;
    if (branchName && tracking) {
      try {
        await ctx.git.resolveRef({ fs: ctx.fs, dir: ctx.dir, ref: `refs/remotes/${tracking}` });
      } catch (error) {
        if ((error as { code?: string })?.code !== "NotFoundError") throw error;
        tracking = null;
      }
    }
    if (branchName && tracking) {
        const [local, upstream] = await Promise.all([
          ctx.git.log({ fs: ctx.fs, dir: ctx.dir, ref: branchName }),
          ctx.git.log({ fs: ctx.fs, dir: ctx.dir, ref: `refs/remotes/${tracking}` }),
        ]) as [Array<{ oid: string }>, Array<{ oid: string }>];
        const localIds = new Set(local.map((c) => c.oid));
        const remoteIds = new Set(upstream.map((c) => c.oid));
        ahead = local.filter((c) => !remoteIds.has(c.oid)).length;
        behind = upstream.filter((c) => !localIds.has(c.oid)).length;
    }
    const states = await scanGitStates(ctx);
    return { ...base, branchName, trackingBranchName: tracking, headRefType: branchName ? "branch" : "detached",
      ahead, behind, isDirty: states.length > 0 };
  }
  async function identity(workspacePath: string) {
    const ctx = await context(workspacePath);
    const [userName, userEmail] = await Promise.all(["user.name", "user.email"].map((path) =>
      ctx.git.getConfig({ fs: ctx.fs, dir: ctx.dir, path }).catch(() => null)));
    return { userName: userName ?? null, userEmail: userEmail ?? null, nameSource: null, emailSource: null };
  }
  async function branchResult(workspacePath: string, action: "switch" | "create-and-switch", branchName: string, run: (ctx: GitContext) => Promise<void>) {
    try {
      const ctx = await context(workspacePath);
      if (action === "switch" && await ctx.git.currentBranch({ fs: ctx.fs, dir: ctx.dir, fullname: false }) === branchName) {
        return { ok: true, action, branchName, didChange: false, created: false, summary: await summary(workspacePath), issues: [] };
      }
      await run(ctx);
      return { ok: true, action, branchName, didChange: true, created: action === "create-and-switch", summary: await summary(workspacePath), issues: [] };
    } catch (e) {
      return { ok: false, action, branchName, didChange: false, created: false, summary: await summary(workspacePath),
        issues: [{ code: "unknown" as const, message: String((e as Error)?.message ?? e) }] };
    }
  }
  return {
    getRepositorySummary: ({ workspacePath }) => summary(workspacePath),
    async getWorkspaceRepositoryInfo({ workspacePath }) {
      const ctx = await safeLoad(workspacePath);
      return { workspacePath, kind: ctx?.isRepository ? "main-tree" : "not-repository", isGitAvailable: Boolean(ctx) };
    },
    async getLocalBranches({ workspacePath }) {
      const ctx = await context(workspacePath);
      const current = await ctx.git.currentBranch({ fs: ctx.fs, dir: ctx.dir, fullname: false }).catch(() => null) as string | null;
      const names = await ctx.git.listBranches({ fs: ctx.fs, dir: ctx.dir }) as string[];
      const branches = await Promise.all(names.map(async (name) => {
        const oid = await ctx.git.resolveRef({ fs: ctx.fs, dir: ctx.dir, ref: `refs/heads/${name}` }).catch(() => null) as string | null;
        const commit = oid ? await ctx.git.readCommit({ fs: ctx.fs, dir: ctx.dir, oid }).catch(() => null) : null;
        return { name, isCurrent: name === current, upstreamName: null, commitHash: oid, commitTimestampMs: commit?.commit?.author?.timestamp ? commit.commit.author.timestamp * 1000 : null };
      }));
      return { headRefType: current ? "branch" : "detached", currentBranchName: current, branches };
    },
    async getCommitGraph({ workspacePath, maxCount = 50, skip = 0 }) {
      const ctx = await context(workspacePath);
      try { await ctx.git.resolveRef({ fs: ctx.fs, dir: ctx.dir, ref: "HEAD" }); }
      catch (error) {
        if ((error as { code?: string })?.code === "NotFoundError") return { commits: [], hasMore: false };
        throw error;
      }
      const entries = await ctx.git.log({ fs: ctx.fs, dir: ctx.dir, depth: maxCount + skip + 1 }) as Array<{ oid: string; commit: { parent: string[]; message: string; author: { name: string; timestamp: number } } }>;
      return { commits: entries.slice(skip, skip + maxCount).map((entry) => ({ hash: entry.oid, parents: entry.commit.parent, refs: [], subject: entry.commit.message.split("\n")[0] ?? "", authorName: entry.commit.author.name, authoredAtMs: entry.commit.author.timestamp * 1000 })), hasMore: entries.length > skip + maxCount };
    },
    switchBranch: ({ workspacePath, targetBranchName }) => branchResult(workspacePath, "switch", targetBranchName,
      async (ctx) => { await ctx.git.checkout({ fs: ctx.fs, dir: ctx.dir, ref: targetBranchName, force: false }); }),
    createBranchAndSwitch: ({ workspacePath, branchName, startPoint }) => branchResult(workspacePath, "create-and-switch", branchName,
      async (ctx) => {
        if (startPoint) throw new Error("移动端暂不支持指定起点创建分支");
        await ctx.git.branch({ fs: ctx.fs, dir: ctx.dir, ref: branchName });
        try {
          await ctx.git.checkout({ fs: ctx.fs, dir: ctx.dir, ref: branchName, force: false });
        } catch (e) {
          await ctx.git.deleteBranch({ fs: ctx.fs, dir: ctx.dir, ref: branchName }).catch(() => undefined);
          throw e;
        }
      }),
    async getChanges({ workspacePath, sourceId }) { return changes(await context(workspacePath), sourceId); },
    async getIgnoredPaths({ workspacePath, paths }) {
      const ctx = await context(workspacePath);
      const results = await Promise.all(paths.map(async (path) => ({ path, ignored: await ctx.git.isIgnored({ fs: ctx.fs, dir: ctx.dir, filepath: relative(ctx.dir, path) }) })));
      return results.filter((x) => x.ignored).map((x) => x.path);
    },
    async stagePaths({ workspacePath, paths }) {
      const ctx = await context(workspacePath);
      await stageGitPaths(ctx, paths);
    },
    async unstagePaths({ workspacePath, paths }) {
      const ctx = await context(workspacePath);
      const files = paths.map((path) => relative(ctx.dir, path));
      for (const filepath of files) await ctx.git.resetIndex({ fs: ctx.fs, dir: ctx.dir, filepath });
    },
    async commit({ workspacePath, message, paths, stagedOnly }) {
      if (!message.trim()) throw new Error("提交信息不能为空");
      const ctx = await context(workspacePath);
      if (paths?.length) {
        const selected = new Set(paths.map((path) => relative(ctx.dir, path)));
        const staged = await changes(ctx, "staged");
        if (staged.some((entry) => !selected.has(entry.repoRelativePath))) {
          throw new Error("存在未选中的暂存文件；移动端暂不支持只提交部分暂存内容");
        }
        if (stagedOnly === false && (await changes(ctx, "unstaged")).some((entry) => selected.has(entry.repoRelativePath))) {
          throw new Error("请先暂存所选改动再提交");
        }
      }
      const { userName, userEmail } = await identity(workspacePath);
      if (!userName || !userEmail) throw new Error("请先配置 Git 用户名和邮箱");
      const commitHash = await ctx.git.commit({ fs: ctx.fs, dir: ctx.dir, message, author: { name: userName, email: userEmail } }) as string;
      return { commitHash, summary: await summary(workspacePath) };
    },
    getIdentity: ({ workspacePath }) => identity(workspacePath),
    async refresh({ workspacePath, includeIdentity, includeBranchComparison }) {
      const ctx = await safeLoad(workspacePath);
      const repo = await summary(workspacePath);
      const states = ctx?.isRepository ? await scanGitStates(ctx) : [];
      return { summary: repo, identity: includeIdentity && ctx?.isRepository ? await identity(workspacePath) : null,
        unstagedChanges: ctx?.isRepository ? await changes(ctx, "unstaged", states) : [],
        stagedChanges: ctx?.isRepository ? await changes(ctx, "staged", states) : [],
        branchComparison: includeBranchComparison ? null : null };
    },
    async getDiff({ workspacePath, path, sourceId, staged }) {
      const ctx = await context(workspacePath);
      const filepath = relative(ctx.dir, path);
      if (sourceId && sourceId !== "staged" && sourceId !== "unstaged") throw unavailable();
      const useStaged = sourceId === "staged" || (!sourceId && staged === true);
      const state = (await scanGitStates(ctx, filepath)).find(row => row.file === filepath);
      if (!state) return { path, availability: "unavailable", patch: null, beforeContent: null, afterContent: null, summary: "当前仓库中没有此文件。" };
      if (state.conflicted) return { path, availability: "unavailable", patch: null, beforeContent: null, afterContent: null, summary: "文件存在未解决的合并冲突；暂存区包含多个版本。" };
      return (await mobileGitDiff(path, filepath, useStaged ? state.head : state.index, useStaged ? state.index : state.work, version => readGitVersion(ctx, version))).diff;
    },
    async getBranchComparison() { throw unavailable(); },
    async discardPaths() { throw unavailable(); },
    async generateCommitMessage() { throw unavailable(); },
    async push() { throw unavailable(); },
  };
}
