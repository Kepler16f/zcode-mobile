// Git 工具（0.6.1，用户点名"能不能内置 git"）：isomorphic-git（纯 JS，WebView 里跑）
// + compat/git-fs-adapter 适配 vfs。没有 git 二进制也能做版本控制——但只有 WebKit 之外
// 的诚实边界要先说清：
//  - 只在私有盘工作区（/work）注册。SAF 树（/mnt）的每次桥往返 30-40ms，statusMatrix
//    逐文件 stat 一棵大仓库要数分钟且全是同步往返——那里宁可不注册。
//  - clone/push/pull 走浏览器 HTTP：WebView 的 CORS 对 git 智能协议是真实约束（GitHub 的
//    git 端点带 CORS 头可直接用；别的自建远端可能要代理）。失败时错误原文如实上抛。
//  - 提交身份端上没有 git config 可读：固定 aZCode <azcode@local>，commit 入参可覆盖。
//  - 动态 import：entry.js 不为 git 付体积，首次调用才拉 chunk。
import { createGitFs } from "../compat/git-fs-adapter.mjs";

const GIT_TOOL = "Git";
const DEFAULT_AUTHOR = { name: "aZCode", email: "azcode@local" };

// isomorphic-git 的命令都是 `({fs, dir, ...}) => Promise<...>`；类型面只声明用到的窄形状
// （tsconfig 开了 noUncheckedIndexedAccess，索引签名会把每次调用判 undefined，这里点名方法）。
type StatusRow = [string, number, number, number];
interface LogEntry {
  oid: string;
  commit: { message: string; author: { name: string; timestamp?: number } };
}
interface GitModule {
  init(a: { fs: unknown; dir: string }): Promise<void>;
  clone(a: { fs: unknown; http: unknown; dir: string; url: string; singleBranch?: boolean; depth?: number }): Promise<void>;
  statusMatrix(a: { fs: unknown; dir: string }): Promise<StatusRow[]>;
  add(a: { fs: unknown; dir: string; filepath: string }): Promise<void>;
  commit(a: { fs: unknown; dir: string; message: string; author: { name: string; email: string } }): Promise<string>;
  log(a: { fs: unknown; dir: string; depth?: number }): Promise<LogEntry[]>;
  listBranches(a: { fs: unknown; dir: string }): Promise<string[]>;
  currentBranch(a: { fs: unknown; dir: string; fullname?: boolean }): Promise<string | null>;
  branch(a: { fs: unknown; dir: string; ref: string; checkout?: boolean }): Promise<void>;
  push(a: {
    fs: unknown; http: unknown; dir: string; remote?: string; url?: string; ref?: string; remoteRef?: string; force?: boolean;
    onAuth?: (url: string) => GitAuth | undefined;
  }): Promise<{ ok?: boolean; refs?: Record<string, string> }>;
  pull(a: {
    fs: unknown; http: unknown; dir: string; remote?: string; ref?: string; url?: string; fastForward?: boolean;
    onAuth?: (url: string) => GitAuth | undefined;
    author: { name: string; email: string };
  }): Promise<{ fetchHead?: string; newHead?: string }>;
  fetch(a: {
    fs: unknown; http: unknown; dir: string; remote?: string; url?: string; depth?: number;
    onAuth?: (url: string) => GitAuth | undefined;
  }): Promise<{ fetchHead?: string }>;
  addRemote(a: { fs: unknown; dir: string; remote: string; url: string; force?: boolean }): Promise<void>;
  listRemotes(a: { fs: unknown; dir: string }): Promise<Array<{ remote: string; url: string }>>;
  /** 附着模式用：问远端默认分支（不落盘，一次 GET info/refs）。 */
  getRemoteInfo(a: { http: unknown; url: string; onAuth?: (url: string) => GitAuth | undefined }): Promise<{ HEAD?: string; refs?: { heads?: Record<string, string> } }>;
  /** UMD 里没有 readRef（CJS 才有）——expandRef 等价（ref → oid，缺失抛 NotFoundError）。 */
  expandRef(a: { fs: unknown; dir: string; ref: string }): Promise<string | undefined>;
  writeRef(a: { fs: unknown; dir: string; ref: string; value: string; force?: boolean }): Promise<void>;
}

/** https 远端凭据：username + password（GitHub/GitLab 的 PAT 当 password 用，username 任意可
 *  再填同一个令牌）。isomorphic-git 对嵌在 URL 里的 https://user:pass@host/… 会自动取用，
 *  不经过这里；这里只负责 onAuth 回调的应答。 */
interface GitAuth {
  username: string;
  password: string;
}

/** 懒加载 isomorphic-git：浏览器侧**相对路径直引 index.umd.min.js**——那是预打包的自包含
 *  浏览器产物（Buffer/pako 全内联）；不能走裸包名，esbuild 浏览器平台会顺着 index.js 拉
 *  sha.js→safe-buffer→"buffer" 这条 node 依赖链打不过去。
 *
 *  0.6.4 修"Git 工具空壳"（装机 `e.init is not a function` 全 action 命中）：这个 UMD 的
 *  `module.exports=` 写在包装函数**内部**（是形参不是顶层标识符），esbuild 的 CJS 探测只认
 *  顶层 → 判成 ESM 打包 → 不发 module/exports 垫片 → UMD 三个分支全落空，落到最后的全局
 *  分支 **self.git = factory()**，模块命名空间是空的（git-umd-smoke 钉过）。所以加载后从
 *  `self.git`（window.git）取 API——这是 UMD 的全局分支契约，各版本稳定。
 *  Node 侧（git-smoke）不经过这里，直接用裸包名 index.cjs。 */
async function loadGit(): Promise<GitModule> {
  const holder = globalThis as { git?: GitModule };
  if (!holder.git) {
    await import("../node_modules/isomorphic-git/index.umd.min.js");
  }
  const api = holder.git;
  if (!api || typeof api.init !== "function") {
    throw new Error("isomorphic-git 没有装载成功（self.git 缺失或形状不对）");
  }
  return api;
}

/** clone/push/pull/fetch 用的 HTTP 传输。
 *  桌面 harness：isomorphic-git 自带的 web 传输（fetch）。
 *  端侧（0.6.7）：**原生桥传输**——WebView 页面在 https://appassets 源上，对任何 git 远端
 *  （含 GitHub）的 fetch 都是跨源请求，git 端点普遍不答 CORS（实测 GitHub /info/refs 无
 *  ACAO、OPTIONS 预检 405），fetch 层直接 "Failed to fetch"——装机"git 工具一直 fail to
 *  fetch"的根因。原生 HttpURLConnection 没有 CORS 概念；GitHttpBridge.kt 缓冲式一发一收。
 *  返回形状与 http/web/index.js 逐字段一致（isomorphic-git 的 HttpClient 契约）。 */
async function loadGitHttp(): Promise<unknown> {
  const holder = globalThis as { zcodeGitHttp?: { call(request: string): string } };
  if (!holder.zcodeGitHttp || typeof holder.zcodeGitHttp.call !== "function") {
    const mod: unknown = await import("../node_modules/isomorphic-git/http/web/index.js");
    const withDefault = mod as { default?: unknown };
    return withDefault.default ?? mod;
  }
  return { request: bridgeHttpRequest };
}

/** 桥传输的入参形状（isomorphic-git 会传 async iterable 的 body）。 */
interface GitHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | null;
  onProgress?: unknown;
  signal?: AbortSignal;
}

async function collectBody(body: GitHttpRequest["body"]): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const piece of body) {
    chunks.push(piece);
    total += piece.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const piece of chunks) {
    out.set(piece, offset);
    offset += piece.length;
  }
  return out;
}

async function bridgeHttpRequest(req: GitHttpRequest): Promise<{
  url: string;
  method: string;
  statusCode: number;
  statusMessage: string;
  body: AsyncIterable<Uint8Array>;
  headers: Record<string, string>;
}> {
  const bodyBytes = await collectBody(req.body);
  const res = await bridgeHttpRaw({
    url: req.url,
    method: req.method,
    headers: req.headers,
    bodyBase64: bodyBytes.length > 0 ? base64FromBytes(bodyBytes) : "",
  });
  const bytes = res.bodyBase64 ? bytesFromBase64(res.bodyBase64) : new Uint8Array(0);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers ?? {})) {
    if (typeof v === "string") headers[k.toLowerCase()] = v;
  }
  return {
    url: req.url,
    method: req.method ?? "GET",
    statusCode: res.statusCode ?? 0,
    statusMessage: res.statusMessage ?? "",
    headers,
    // isomorphic-git 只要求 body 是 Uint8Array 的 async iterable；一发一收单块即可。
    body: (async function* () {
      if (bytes.length > 0) yield bytes;
    })(),
  };
}

/**
 * 原生 HTTP 桥的一发一收（0.7.3 从 bridgeHttpRequest 抽出，导出给 Fetch 工具复用）。
 * 契约 = GitHttpBridge.kt：{url, method, headers, bodyBase64} →
 * {statusCode, statusMessage, headers, bodyBase64, error}。HttpURLConnection 代发，
 * **没有 WebView 的 CORS 概念**（0.6.7 为 git 远端建的通路，任何第三方端点通用）。
 * 桥不在或返回异常都以 Error 抛出，调用方别拿 undefined 当成功。
 */
export async function bridgeHttpRaw(req: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
}): Promise<{
  statusCode?: number;
  statusMessage?: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
  error?: string;
}> {
  const bridge = (globalThis as { zcodeGitHttp?: { call(request: string): string } }).zcodeGitHttp;
  if (!bridge || typeof bridge.call !== "function") {
    throw new Error("原生 HTTP 桥不在（zcodeGitHttp）：这台宿主发不了出网请求");
  }
  const payload = JSON.stringify({
    url: req.url,
    method: req.method ?? "GET",
    headers: req.headers ?? {},
    bodyBase64: req.bodyBase64 ?? "",
  });
  const res = JSON.parse(String(bridge.call(payload))) as {
    error?: string;
    statusCode?: number;
    statusMessage?: string;
    headers?: Record<string, string>;
    bodyBase64?: string;
  };
  if (res.error || typeof res.statusCode !== "number") {
    throw new Error(`git 传输失败：${res.error ?? "桥返回异常"}`);
  }
  return res;
}

/** base64（无填充）；浏览器/WebView 的 btoa 只吃 latin1，逐字节映射。 */
function base64FromBytes(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function bytesFromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** base64 → 字节（0.7.3 导出给 Fetch 工具：HTTP 桥的 body 一路都是 base64）。 */
export { bytesFromBase64 };

async function repoContext(core: GitModule, fs: unknown, dir: string) {
  const branch = ((await core.currentBranch({ fs, dir, fullname: false })) as string | null) ?? "(无分支)";
  return { branch };
}

/** SAF 工作区的 staging 纪律（0.6.2）：git 跑在终端物化镜像（私有盘）上，命令前确保镜像
 *  在场并拍快照，命令后把 diff（.git + 工作区改动）回写 SAF。与 Bash 的物化两拍同一套
 *  机制（compat/vfs-stage.mjs），这里只是把调用权交给 Git 工具。 */
export interface GitStageControl {
  /** 命令前：确保镜像在场（首次全量物化，异步让出）。 */
  ensure(): Promise<void>;
  /** 命令前（ensure 之后）：镜像快照，回写 diff 的基准。 */
  snapshot(): unknown;
  /** 命令后：把镜像 diff 落回 SAF；failed>0 时 errors 里带前三条原因。 */
  writeBack(snapshot: unknown): Promise<{ failed: number; errors: string[] } | null>;
}

export function makeGitTool(workspacePath: string, fs: unknown, stage?: GitStageControl) {
  return {
    metadata: {
      name: GIT_TOOL,
      description:
        "内置 git（纯 JS 实现）：init/clone/status/add/commit/log/branch/push/pull/fetch/remote。" +
        "提交身份默认 aZCode <azcode@local>（commit 入参可传 author.name/email 覆盖）。" +
        "SAF 工作区（/mnt/…）自动经终端镜像在私有盘上加速执行并把结果回写工作区，" +
        "大仓库首次会慢（全量镜像）。" +
        "push/pull/fetch 需要凭据的 https 远端：url 里内嵌（https://user:token@host/…）或传 username/password 参数" +
        "（GitHub/GitLab 用 PAT 当 password）；没有凭据时先向用户要令牌再调用，不要盲试。",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["init", "clone", "status", "add", "commit", "log", "branch", "remote", "push", "pull", "fetch"],
            description:
              "init=在当前工作区建 .git；clone=url 克隆到 dir（必传 url）；status=改动清单；add=暂存（path 或 '.'）；" +
              "commit=message 提交暂存；log=最近 depth 条（默认 20）；branch=分支名列表 / ref 建分支+切换；" +
              "remote=url 添加名为 remote 的远端 / 无 url 列出远端；push=推送当前分支到 remote（默认 origin）；" +
              "pull=拉取并快进合并 remote 的同名分支；fetch=只取不合并",
          },
          url: { type: "string", description: "clone/remote 的远端地址（https，可内嵌 user:token）" },
          dir: {
            type: "string",
            description:
              "clone 目标目录（工作区相对路径）。'.' 或省略 = **附着模式**：把远端历史挂到当前工作区" +
              "（init+origin+fetch+对齐 HEAD，不覆盖现有文件）——目录里已有文件就用这个，" +
              "不要 clone 到子目录再搬 .git（会把仓库搬坏）",
          },
          path: { type: "string", description: "add 的文件/目录（'.' = 全部）" },
          message: { type: "string", description: "commit 的提交说明" },
          depth: { type: "number", description: "log 条数（默认 20）/ fetch 深度" },
          ref: { type: "string", description: "branch 动作：建分支并切换；pull 动作：远端分支名（默认同名）" },
          remote: { type: "string", description: "远端名（默认 origin）" },
          force: { type: "boolean", description: "push/remote 的强制覆盖开关（默认 false，慎用）" },
          username: { type: "string", description: "https 远端凭据的用户名（push/pull/fetch 用）" },
          password: { type: "string", description: "https 远端凭据的密码/访问令牌（push/pull/fetch 用）" },
          authorName: { type: "string", description: "commit 覆盖作者名" },
          authorEmail: { type: "string", description: "commit 覆盖作者邮箱" },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    handler: async (raw: unknown) => {
      const input = (raw ?? {}) as Record<string, unknown>;
      const action = typeof input.action === "string" ? input.action : "";
      const core = await loadGit();
      const dir = workspacePath;
      // SAF 纪律两拍（见 GitStageControl）：镜像在场 → 拍快照 → 跑命令 → diff 回写。
      // 命令失败也要回写（半程 clone/commit 已经写了一堆文件）；回写失败必须可见——
      // "git 说提交了、工作区里没有 .git"这种半真状态比报错更难查。
      let snapshot: unknown = null;
      if (stage) {
        await stage.ensure();
        snapshot = stage.snapshot();
      }
      let result: string | null = null;
      let failure: unknown = null;
      try {
        result = await runGitAction(core, fs, dir, action, input);
      } catch (e) {
        failure = e;
      }
      let wbNote = "";
      if (stage && snapshot) {
        const wb = await stage.writeBack(snapshot);
        if (wb && wb.failed > 0) {
          wbNote =
            `\n\n回写告警：${wb.failed} 处 git 改动未能写回工作区（${wb.errors.join("；")}）。` +
            `这些改动在终端镜像里已生效，但文件工具读到的是未写回版本。`;
        }
      }
      if (failure !== null) throw failure;
      return result ? result + wbNote : result;
    },
  };
}

async function runGitAction(
  core: GitModule,
  fs: unknown,
  dir: string,
  action: string,
  input: Record<string, unknown>,
): Promise<string> {
  switch (action) {
    case "init": {
      await core.init({ fs, dir });
      return `已在 ${dir} 初始化 git 仓库（.git 已创建，默认分支 master）。`;
    }
    case "clone": {
      const url = typeof input.url === "string" ? input.url.trim() : "";
      if (!url.startsWith("https://") && !url.startsWith("http://")) {
        throw new Error(`clone 需要 http/https 地址：${url}`);
      }
      const http = await loadGitHttp();
      const subdir = typeof input.dir === "string" && input.dir.trim() ? input.dir.trim() : "";
      // 附着模式（0.6.8，装机"clone 到子目录再搬 .git 到根"的脆弱舞蹈）：dir="." 或省略
      // = 把历史挂到**当前目录**：init → 连 origin → fetch → 对齐 HEAD 到远端默认分支，
      // **不 checkout**（现有快照文件原地不动，statusMatrix 会如实报差异）。
      // 这正是"目录已有文件又想有 git 历史"的正解——isomorphic-git 的 clone 对非空目录
      // 会把远端文件盖下来，模型不敢用才去搬 .git，搬的过程中 refs 布局一乱就全崩。
      if (!subdir || subdir === "." || subdir === "./") {
        await core.init({ fs, dir });
        await core.addRemote({ fs, dir, remote: "origin", url, force: true });
        const info = await core
          .getRemoteInfo({ http, url, onAuth: authFrom(input) })
          .catch(() => ({ HEAD: undefined, refs: undefined }));
        // HEAD 形如 "ref: refs/heads/main"；拿不到默认分支就退回 fetch 后再猜。
        const headRef = typeof info.HEAD === "string" ? /^ref: refs\/heads\/(.+)$/.exec(info.HEAD)?.[1] : undefined;
        await core.fetch({ fs, http, dir, remote: "origin", depth: 50, onAuth: authFrom(input) });
        const branches = (await core.listBranches({ fs, dir })) as string[];
        const target = headRef && branches.includes(headRef)
          ? headRef
          : branches.includes("main")
            ? "main"
            : branches.includes("master")
              ? "master"
              : branches[0] ?? "";
        if (target) {
          const sha = await core.expandRef({ fs, dir, ref: `refs/heads/${target}` });
          await core.writeRef({ fs, dir, ref: "HEAD", value: `ref: refs/heads/${target}`, force: true });
          return `已把 ${url} 的历史挂到 ${dir}（分支 ${target} @ ${String(sha ?? "?").slice(0, 10)}，未改动现有文件；用 status 看差异）。`;
        }
        return `已连接 ${url} 并 fetch，但本地没有可对齐的分支（远端可能是空仓库）。`;
      }
      const target = `${dir}/${subdir.replace(/^\/+/, "")}`;
      await core.clone({ fs, http, dir: target, url, singleBranch: false, depth: 50 });
      const branches = ((await core.listBranches({ fs, dir: target }).catch(() => [])) as string[]) ?? [];
      return `已克隆 ${url} → ${target}（分支：${branches.slice(0, 5).join("、") || "?"}）。`;
    }
    case "status": {
      const matrix = (await core.statusMatrix({ fs, dir })) as StatusRow[];
      // statusMatrix 行 = [file, head, workdir, stage]，各位 0/1/2（0=无 1=同 2=不同）。
      const changed = matrix
        .filter((row) => !(row[1] === row[2] && row[2] === row[3]))
        .map((row) => {
          const [file, head, workdir] = row;
          const mark = head === 0 ? "  new file" : workdir === 0 ? "  deleted" : workdir === 2 && head === 1 ? "  modified" : "  changed";
          return `${file}${mark}`;
        });
      const { branch } = await repoContext(core, fs, dir);
      return `分支：${branch}\n改动 ${changed.length} 个文件：\n${changed.slice(0, 200).join("\n") || "（干净）"}`;
    }
    case "add": {
      const rawPath = typeof input.path === "string" && input.path.trim() ? input.path.trim() : ".";
      if (rawPath === ".") {
        await core.add({ fs, dir, filepath: "." });
        return "已暂存全部改动（add .）。";
      }
      for (const p of rawPath.split(/[,\s]+/).filter(Boolean)) {
        await core.add({ fs, dir, filepath: p.replace(/^\/+/, "") });
      }
      return `已暂存：${rawPath}`;
    }
    case "commit": {
      const message = typeof input.message === "string" ? input.message.trim() : "";
      if (!message) throw new Error("commit 需要 message");
      const sha = await core.commit({
        fs,
        dir,
        message,
        author: {
          name: typeof input.authorName === "string" && input.authorName.trim() ? input.authorName.trim() : DEFAULT_AUTHOR.name,
          email: typeof input.authorEmail === "string" && input.authorEmail.trim() ? input.authorEmail.trim() : DEFAULT_AUTHOR.email,
        },
      });
      return `已提交：${String(sha).slice(0, 10)} — ${message}`;
    }
    case "log": {
      const depth = typeof input.depth === "number" && input.depth > 0 ? Math.min(input.depth, 100) : 20;
      const commits = (await core.log({ fs, dir, depth })) as LogEntry[];
      return commits
        .map((c) => `${String(c.oid).slice(0, 10)} ${c.commit.author.name} ${c.commit.author.timestamp ? new Date(c.commit.author.timestamp * 1000).toISOString().slice(0, 16) : ""}\n  ${c.commit.message.split("\n")[0]}`)
        .join("\n");
    }
    case "branch": {
      const ref = typeof input.ref === "string" && input.ref.trim() ? input.ref.trim() : "";
      if (ref) {
        await core.branch({ fs, dir, ref, checkout: true });
        return `已创建并切换到分支 ${ref}。`;
      }
      const branches = (await core.listBranches({ fs, dir })) as string[];
      const { branch } = await repoContext(core, fs, dir);
      return `当前分支：${branch}\n全部分支：${branches.join("、")}`;
    }
    case "remote": {
      const url = typeof input.url === "string" && input.url.trim() ? input.url.trim() : "";
      const remoteName = typeof input.remote === "string" && input.remote.trim() ? input.remote.trim() : "origin";
      if (url) {
        if (!url.startsWith("https://") && !url.startsWith("http://")) {
          throw new Error(`remote 需要 http/https 地址：${url}`);
        }
        await core.addRemote({ fs, dir, remote: remoteName, url, force: input.force === true });
        return `远端 ${remoteName} 已指向 ${url}。`;
      }
      const remotes = (await core.listRemotes({ fs, dir })) as Array<{ remote: string; url: string }>;
      return remotes.length > 0
        ? remotes.map((r) => `${r.remote}\t${r.url}`).join("\n")
        : "（还没有配置远端——用 action=remote + url 添加。）";
    }
    case "push": {
      const http = await loadGitHttp();
      const remoteName = typeof input.remote === "string" && input.remote.trim() ? input.remote.trim() : "origin";
      const url = typeof input.url === "string" && input.url.trim() ? input.url.trim() : undefined;
      const branch = (await core.currentBranch({ fs, dir, fullname: false })) as string | null;
      const pushResult = (await core.push({
        fs,
        http,
        dir,
        remote: remoteName,
        ...(url ? { url } : {}),
        ref: branch ?? undefined,
        force: input.force === true,
        onAuth: authFrom(input),
      })) as { ok?: boolean; refs?: Record<string, string> };
      // 凭据失败时 isomorphic-git 会抛 UnexpectedServerResponse/401——如实上抛给模型，
      // 它能拿着错误原文去向用户要令牌。
      return `已推送 ${branch ?? "?"} → ${remoteName}${pushResult.ok === false ? "（远端返回 ok=false）" : ""}。`;
    }
    case "pull": {
      const http = await loadGitHttp();
      const remoteName = typeof input.remote === "string" && input.remote.trim() ? input.remote.trim() : "origin";
      const url = typeof input.url === "string" && input.url.trim() ? input.url.trim() : undefined;
      const branch = (await core.currentBranch({ fs, dir, fullname: false })) as string | null;
      const pullResult = (await core.pull({
        fs,
        http,
        dir,
        remote: remoteName,
        ...(url ? { url } : {}),
        ...(branch ? { ref: input.ref && typeof input.ref === "string" && input.ref.trim() ? input.ref.trim() : branch } : {}),
        fastForward: true, // 只快进：分叉时如实报错让模型决断，不静默造合并提交
        onAuth: authFrom(input),
        author: DEFAULT_AUTHOR,
      })) as { fetchHead?: string; newHead?: string };
      return `已拉取 ${remoteName}（${branch ?? "?"}）${pullResult.newHead ? `，更新到 ${String(pullResult.newHead).slice(0, 10)}` : "，已是最新"}。`;
    }
    case "fetch": {
      const http = await loadGitHttp();
      const remoteName = typeof input.remote === "string" && input.remote.trim() ? input.remote.trim() : "origin";
      const url = typeof input.url === "string" && input.url.trim() ? input.url.trim() : undefined;
      const depth = typeof input.depth === "number" && input.depth > 0 ? input.depth : undefined;
      await core.fetch({
        fs,
        http,
        dir,
        remote: remoteName,
        ...(url ? { url } : {}),
        ...(depth ? { depth } : {}),
        onAuth: authFrom(input),
      });
      return `已从 ${remoteName} 取回远端引用（未合并——用 branch/pull 落地）。`;
    }
    default:
      throw new Error(`未知 action：${action}（init/clone/status/add/commit/log/branch/remote/push/pull/fetch）`);
  }
}

/** 入参里的凭据 → onAuth 应答；没有就返回 undefined（服务器拒绝时错误原文上抛）。 */
function authFrom(input: Record<string, unknown>): ((url: string) => GitAuth | undefined) | undefined {
  const username = typeof input.username === "string" ? input.username.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (!username && !password) return undefined;
  return () => ({ username: username || password, password });
}
