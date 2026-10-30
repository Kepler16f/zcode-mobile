import type { GitBranchComparison, GitFileChange, GitGenerateCommitMessageResult, GitPushResult, GitRepositorySummary } from "@zcode/shared";
import type { IGitService } from "@zcode/services/deep/git/git.js";
import { createGitFs } from "../compat/git-fs-adapter.mjs";
import { loadGit, pushGitBranch } from "./git-tool.js";
import { loadCoreFromAsset } from "./tool-engine.js";
import { mobileGitDiff } from "./git-diff.js";
import { gitRelativePath, scopedGitFs } from "./git-path.js";
import { localWorkspacePath } from "../compat/workspace-aliases.mjs";
import { compareTrees, scanGitStates, readGitVersion, sameGitVersion, stageGitPaths, type GitFileState } from "./git-state.js";

// 面板与 Agent 读取同一份 core VFS；SAF 的镜像尚无跨调用事务锁，不能伪装成完整面板。
type GitApi = Record<"readObject" | "getConfig" | "walk" | "TREE" | "STAGE" | "WORKDIR" | "hashBlob" | "isIgnored" |
  "currentBranch" | "log" | "listBranches" | "resolveRef" | "readCommit" | "checkout" | "branch" | "deleteBranch" |
  "add" | "remove" | "resetIndex" | "commit" | "push" | "listRemotes" | "setConfig", (...args: any[]) => any>;
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
  async function summary(workspacePath: string, contextSnapshot?: GitContext | null, stateSnapshot?: GitFileState[]): Promise<GitRepositorySummary> {
    const ctx = contextSnapshot === undefined ? await safeLoad(workspacePath) : contextSnapshot;
    const base: GitRepositorySummary = { workspacePath, repoRoot: workspacePath, workspaceInRepoPath: "",
      autoRefreshWatchPaths: [], branchName: null, trackingBranchName: null, headRefType: "branch",
      ahead: 0, behind: 0, isDirty: false, isGitAvailable: Boolean(ctx), isRepository: Boolean(ctx?.isRepository) };
    if (!ctx?.isRepository) return base;
    const { branchName, tracking, ahead, behind } = await branchInfo(ctx);
    const states = stateSnapshot ?? await scanGitStates(ctx);
    return { ...base, branchName, trackingBranchName: tracking, headRefType: branchName ? "branch" : "detached",
      ahead, behind, isDirty: states.length > 0 };
  }

  /**
   * 分支与上游的事实（当前分支、上游分支名、领先/落后计数）。
   * summary、分支比较与推送都从这里读「当前在哪个分支、上游是谁」——
   * 同一件事有三份读法就会各自漂移（尤其「上游存在但远端引用已删」这种半真状态）。
   */
  async function branchInfo(ctx: GitContext): Promise<{
    branchName: string | null;
    tracking: string | null;
    ahead: number;
    behind: number;
  }> {
    const branchName = await ctx.git.currentBranch({ fs: ctx.fs, dir: ctx.dir, fullname: false }).catch(() => null) as string | null;
    const remote = branchName ? await ctx.git.getConfig({ fs: ctx.fs, dir: ctx.dir, path: `branch.${branchName}.remote` }).catch(() => null) as string | null : null;
    const merge = branchName ? await ctx.git.getConfig({ fs: ctx.fs, dir: ctx.dir, path: `branch.${branchName}.merge` }).catch(() => null) as string | null : null;
    let tracking = remote && merge?.startsWith("refs/heads/") ? `${remote}/${merge.slice(11)}` : null;
    let ahead = 0, behind = 0;
    if (branchName && tracking) {
      try {
        await ctx.git.resolveRef({ fs: ctx.fs, dir: ctx.dir, ref: `refs/remotes/${tracking}` });
      } catch (error) {
        // 上游配置在、远端引用却不在（例如还没 fetch）：如实当作「没有上游」，不编造领先/落后。
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
    return { branchName, tracking, ahead, behind };
  }
  async function identity(workspacePath: string) {
    const ctx = await context(workspacePath);
    const [userName, userEmail] = await Promise.all(["user.name", "user.email"].map((path) =>
      ctx.git.getConfig({ fs: ctx.fs, dir: ctx.dir, path }).catch(() => null)));
    return { userName: userName ?? null, userEmail: userEmail ?? null, nameSource: null, emailSource: null };
  }

  /**
   * 丢弃改动。桌面用 `git restore` 的两种形态：
   *   - 未暂存（staged=false）：`git restore --worktree` —— 工作树回到**索引**内容；
   *   - 已暂存（staged=true）：`git restore --source=HEAD --staged --worktree` —— 索引与工作树都回到 HEAD。
   * isomorphic-git 的 checkout 恰好是同一套语义：给了 ref 就从该提交恢复，没给 ref 但给了
   * filepaths 就从索引恢复（它内部把这两种情况分别叫 TREE({ref}) 与 STAGE()）。
   *
   * 未跟踪文件没有索引内容可恢复——桌面那条 restore 同样会失败，这里如实报错让人手动处理，
   * 不静默删掉用户的文件。
   */
  async function discardPaths(ctx: GitContext, paths: string[], staged: boolean): Promise<void> {
    const files = [...new Set(paths.map(path => relative(ctx.dir, path)))];
    if (!files.length) return;
    const states = await scanGitStates(ctx);
    if (!staged) {
      for (const filepath of files) {
        const state = states.find(row => row.file === filepath);
        if (state?.index) continue;
        // 索引里没有这一项时只有两种可能：从未被跟踪过，或已被暂存删除（HEAD 里还有）。
        // 两者的补救方式不同，因此必须分开说，不能笼统报「无法丢弃」。
        const reason = state?.head ? "该文件已被暂存删除，请改用丢弃暂存改动" : "未跟踪的文件无法丢弃，请手动删除";
        throw new Error(`${reason}：${filepath}`);
      }
    }
    await ctx.git.checkout({
      fs: ctx.fs,
      dir: ctx.dir,
      filepaths: files,
      force: true,
      ...(staged ? { ref: "HEAD", noUpdateHead: true } : {}),
    });
  }

  /**
   * 本地分支相对上游的差异（桌面 `git diff --numstat upstream...HEAD` 的三点语义）。
   * 三点 = 从**共同祖先**比到 HEAD：只看两端会把上游自己的新提交也算成「本地多了什么」。
   * 共同祖先在两条历史里按提交顺序找第一个公共提交；找不到就如实报错，不给一个假的比较基准。
   */
  async function branchComparison(workspacePath: string, ctx: GitContext): Promise<GitBranchComparison> {
    const { branchName, tracking } = await branchInfo(ctx);
    const headRef = branchName ?? "HEAD";
    if (!tracking) return { baseRef: null, headRef, comparisonLabel: null, changes: [] };
    const localLog = await ctx.git.log({ fs: ctx.fs, dir: ctx.dir, ref: "HEAD" }) as Array<{ oid: string }>;
    const remoteLog = await ctx.git.log({ fs: ctx.fs, dir: ctx.dir, ref: `refs/remotes/${tracking}` }) as Array<{ oid: string }>;
    const remoteIds = new Set(remoteLog.map(commit => commit.oid));
    const base = localLog.find(commit => remoteIds.has(commit.oid))?.oid ?? null;
    if (!base) throw new Error("本地分支与上游没有共同祖先，无法比较差异。");
    const rows = await compareTrees(ctx, base, "HEAD");
    const changes: GitFileChange[] = [];
    for (const row of rows) {
      // 行级增删复用差异引擎（git-diff.ts），不另写一套行数统计。
      const { added, removed } = await mobileGitDiff(`${ctx.dir}/${row.file}`, row.file, row.base, row.head,
        version => readGitVersion(ctx, version));
      changes.push({
        path: `${ctx.dir}/${row.file}`,
        repoRelativePath: row.file,
        workspaceRelativePath: row.file,
        kind: row.base && row.head ? "modified" : row.head ? "added" : "deleted",
        section: "branch",
        added,
        removed,
        isStaged: false,
        isUntracked: false,
        isConflicted: false,
      });
    }
    return {
      baseRef: tracking,
      headRef,
      comparisonLabel: branchName ? `${branchName} -> ${tracking}` : `HEAD -> ${tracking}`,
      changes,
    };
  }

  /**
   * 本地生成提交信息。桌面的这一格走模型，端侧没有那个生成器，也不该在这里联网：
   * 因此只依据**真实改动**（文件名与行级增删）拼一条说明，不编造改动内容。
   * providerId/model 如实标注为本地生成，界面上不会把它当成某个模型的产物。
   */
  async function generateCommitMessage(
    ctx: GitContext,
    options: { includeUnstaged: boolean; currentSessionFilePaths?: string[] },
  ): Promise<GitGenerateCommitMessageResult> {
    const states = await scanGitStates(ctx);
    const staged = await changes(ctx, "staged", states);
    const unstaged = options.includeUnstaged ? await changes(ctx, "unstaged", states) : [];
    let files = [...unstaged, ...staged];
    const sessionPaths = options.currentSessionFilePaths?.map(path => path.replace(/\\/g, "/"));
    if (sessionPaths?.length) {
      // 与桌面一致：只描述本次会话碰过的文件，别把整个仓库的改动算进来。
      const allowed = new Set(sessionPaths);
      files = files.filter(file =>
        allowed.has(file.path.replace(/\\/g, "/")) || allowed.has(`${ctx.dir}/${file.repoRelativePath}`));
    }
    if (!files.length) throw new Error("没有可用的改动，无法生成提交信息。");
    const added = files.filter(file => file.kind === "added").length;
    const deleted = files.filter(file => file.kind === "deleted").length;
    const verb = added === files.length ? "新增" : deleted === files.length ? "删除" : "更新";
    const describe = (file: GitFileChange) => file.kind === "added" ? "新增"
      : file.kind === "deleted" ? "删除"
      : `+${file.added}/-${file.removed}`;
    const shown = files.slice(0, 5).map(file => `${file.repoRelativePath}（${describe(file)}）`).join("、");
    const more = files.length > 5 ? ` 等 ${files.length} 个文件` : "";
    return {
      message: `${verb} ${files.length} 个文件：${shown}${more}`,
      providerId: "mobile-local-git",
      model: "diff-summary",
    };
  }

  /** 建分支的起点：分支名、标签名或完整提交号。解析不到就报错，不猜一个默认起点。 */
  async function resolveStartPoint(ctx: GitContext, startPoint: string): Promise<string> {
    const value = startPoint.trim();
    if (!value) throw new Error("起点引用为空。");
    for (const ref of [`refs/heads/${value}`, `refs/tags/${value}`, value]) {
      const oid = await ctx.git.resolveRef({ fs: ctx.fs, dir: ctx.dir, ref }).catch(() => null) as string | null;
      if (oid) return oid;
    }
    if (/^[0-9a-f]{40}$/i.test(value)) return value.toLowerCase();
    throw new Error(`找不到起点引用：${value}（已尝试同名分支、标签与完整提交号）。`);
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
        // 指定起点：以该提交为基点建分支（桌面的 startPoint 语义）。
        const object = startPoint ? await resolveStartPoint(ctx, startPoint) : undefined;
        await ctx.git.branch({ fs: ctx.fs, dir: ctx.dir, ref: branchName, ...(object ? { object } : {}) });
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
      const states = ctx?.isRepository ? await scanGitStates(ctx) : [];
      // 同一刷新共用扫描事实，避免 summary 与 changes 重复读盘/hash，并减少两次读取间的状态漂移。
      const repo = await summary(workspacePath, ctx, states);
      return { summary: repo, identity: includeIdentity && ctx?.isRepository ? await identity(workspacePath) : null,
        unstagedChanges: ctx?.isRepository ? await changes(ctx, "unstaged", states) : [],
        stagedChanges: ctx?.isRepository ? await changes(ctx, "staged", states) : [],
        branchComparison: includeBranchComparison && ctx?.isRepository ? await branchComparison(workspacePath, ctx) : null };
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
    async getBranchComparison({ workspacePath }) {
      return branchComparison(workspacePath, await context(workspacePath));
    },
    async discardPaths({ workspacePath, paths, staged }) {
      await discardPaths(await context(workspacePath), paths, staged ?? false);
    },
    async generateCommitMessage({ workspacePath, includeUnstaged, currentSessionFilePaths }) {
      return generateCommitMessage(await context(workspacePath), {
        includeUnstaged: includeUnstaged ?? true,
        ...(currentSessionFilePaths ? { currentSessionFilePaths } : {}),
      });
    },
    async push({ workspacePath }): Promise<GitPushResult> {
      const ctx = await context(workspacePath);
      const { branchName, tracking } = await branchInfo(ctx);
      if (!branchName) throw new Error("当前处于游离 HEAD 状态，无法推送。");
      const remotes = (await ctx.git.listRemotes({ fs: ctx.fs, dir: ctx.dir })) as Array<{ remote: string; url: string }>;
      // 远端选择与桌面一致：有上游用上游的远端，否则用唯一已配置远端，再退回 origin。
      const remoteName = tracking
        ? tracking.split("/")[0]
        : remotes.length === 1 ? remotes[0]!.remote : "origin";
      if (!remotes.some(remote => remote.remote === remoteName)) {
        throw new Error(`远端 ${remoteName} 不存在${remotes.length ? `（可用远端：${remotes.map(remote => remote.remote).join("、")}）` : "（仓库还没有配置任何远端）"}。`);
      }
      // 传输、远端解析与凭据处理都归 git-tool 所有（与 Git 工具的 action=push 同一实现）。
      const outcome = await pushGitBranch({
        core: ctx.git as unknown as Parameters<typeof pushGitBranch>[0]["core"],
        fs: ctx.fs,
        dir: ctx.dir,
        branch: branchName,
        input: { remote: remoteName },
        // 桌面在原先没有上游时用 `git push --set-upstream`；端侧等价写法是写这两条配置。
        establishUpstream: !tracking,
      });
      return {
        branchName,
        trackingBranchName: outcome.trackingBranchName,
        remoteName: outcome.remoteName,
        setUpstream: outcome.setUpstream,
        summary: await summary(workspacePath),
      };
    },
  };
}
