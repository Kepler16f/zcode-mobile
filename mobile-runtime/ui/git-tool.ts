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
import { callNativeJob, hasNativeJobs } from "../ports/native-async.mjs";
import { stripInvisibleChars } from "./tool-sanitize.js";
import { scopedGitFs, gitRelativePath } from "./git-path.js";
import { scanGitStates, sameGitVersion, stageGitPaths } from "./git-state.js";

const GIT_TOOL = "Git";
const DEFAULT_AUTHOR = { name: "aZCode", email: "azcode@local" };

/**
 * action 集合的**单一事实源**（0.7.6 装机案：模型传 "Clone"/"clone " /夹零宽字符，
 * 任意 Git 调用报"未知 action"）。schema enum、入口校验、分发分支、错误文案的
 * 支持清单全部从这里派生；分发表又用 Record<GitActionName, …> 把"键 ↔ 分支"钉死在
 * tsc 上——加/删动作只改这一处，三张手写清单互相漂移的老路从此封死。
 */
export const GIT_ACTIONS = [
  "init", "clone", "status", "add", "commit", "log", "branch", "remote", "push", "pull", "fetch",
] as const;
export type GitActionName = (typeof GIT_ACTIONS)[number];

// isomorphic-git 的命令都是 `({fs, dir, ...}) => Promise<...>`；类型面只声明用到的窄形状
// （tsconfig 开了 noUncheckedIndexedAccess，索引签名会把每次调用判 undefined，这里点名方法）。
interface LogEntry {
  oid: string;
  commit: { message: string; author: { name: string; timestamp?: number } };
}
interface GitModule {
  init(a: { fs: unknown; dir: string }): Promise<void>;
  clone(a: { fs: unknown; http: unknown; dir: string; url: string; singleBranch?: boolean; depth?: number; onAuth?: (url: string) => GitAuth | undefined }): Promise<void>;
  readObject(a: any): Promise<any>;
  getConfig(a: any): Promise<any>;
  walk(a: any): Promise<any>;
  TREE(a: any): any;
  STAGE(): any;
  WORKDIR(a: any): any;
  hashBlob(a: any): Promise<any>;
  isIgnored(a: any): Promise<boolean>;
  add(a: { fs: unknown; dir: string; filepath: string }): Promise<void>;
  remove(a: { fs: unknown; dir: string; filepath: string }): Promise<void>;
  commit(a: { fs: unknown; dir: string; message: string; author: { name: string; email: string } }): Promise<string>;
  log(a: { fs: unknown; dir: string; depth?: number }): Promise<LogEntry[]>;
  listBranches(a: { fs: unknown; dir: string; remote?: string }): Promise<string[]>;
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
  resolveRef(a: { fs: unknown; dir: string; ref: string }): Promise<string>;
  writeRef(a: { fs: unknown; dir: string; ref: string; value: string; force?: boolean; symbolic?: boolean }): Promise<void>;
  setConfig(a: { fs: unknown; dir: string; path: string; value: string }): Promise<void>;
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
export async function loadGit(): Promise<GitModule> {
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
export async function loadGitHttp(signal?: AbortSignal): Promise<unknown> {
  const holder = globalThis as { zcodeGitHttp?: { call(request: string): string } };
  if (!holder.zcodeGitHttp || typeof holder.zcodeGitHttp.call !== "function") {
    const mod: unknown = await import("../node_modules/isomorphic-git/http/web/index.js");
    const withDefault = mod as { default?: unknown };
    const client = (withDefault.default ?? mod) as { request(req: GitHttpRequest): Promise<unknown> };
    return { request: (req: GitHttpRequest) => client.request({ ...req, signal: signal ?? req.signal }) };
  }
  return { request: (req: GitHttpRequest) => bridgeHttpRequest({ ...req, signal: signal ?? req.signal }) };
}

/**
 * 推送当前分支的**唯一实现**：Git 工具的 action=push 与设置页 Git 面板的「推送」共用它。
 * 传输（原生 HTTP 桥 / 浏览器 fetch）、远端地址解析与凭据应答都归 git-tool 所有——
 * 面板另写一份就会立刻漂移成两套凭据语义，而 Git 端点的鉴权失败只有一种正确表现。
 *
 * 面板那一侧没有凭据输入框，只能用远端地址里已有的内嵌凭据；工具那一侧还能由模型
 * 传 username/password。两者都通过同一个 input 形状进来，凭据只用于本次请求。
 */
export async function pushGitBranch(options: {
  core: GitModule;
  fs: unknown;
  dir: string;
  branch: string;
  /** url / username / password / force / remote —— 与 Git 工具的入参同形。 */
  input?: Record<string, unknown>;
  signal?: AbortSignal;
  /**
   * 推送后是否建立上游关系（等价桌面 `git push --set-upstream`）。
   * 面板在原先没有上游时置真；Git 工具不传，保持它今天「不写配置」的行为。
   */
  establishUpstream?: boolean;
}): Promise<{ remoteName: string; trackingBranchName: string; setUpstream: boolean }> {
  const { core, fs, dir, branch, signal } = options;
  const input = options.input ?? {};
  if (!branch) throw new Error("当前不在分支上，无法推送。");
  const requested = typeof input.remote === "string" && input.remote.trim() ? input.remote.trim() : "";
  const remoteName = requested || "origin";
  const { url, onAuth } = await networkRemote(core, fs, dir, remoteName, input);
  const http = await loadGitHttp(signal);
  const pushResult = (await core.push({
    fs,
    http,
    dir,
    remote: remoteName,
    ...(url ? { url } : {}),
    ref: branch,
    force: input.force === true,
    onAuth,
  })) as { ok?: boolean; refs?: Record<string, string> };
  // 凭据失败时 isomorphic-git 会抛 UnexpectedServerResponse/401——如实上抛给调用方，
  // 它能拿着错误原文去向用户要令牌。
  if (pushResult.ok === false) throw new Error("Git 推送失败：远端拒绝更新。");
  if (options.establishUpstream) {
    await core.setConfig({ fs, dir, path: `branch.${branch}.remote`, value: remoteName });
    await core.setConfig({ fs, dir, path: `branch.${branch}.merge`, value: `refs/heads/${branch}` });
  }
  return { remoteName, trackingBranchName: `${remoteName}/${branch}`, setUpstream: Boolean(options.establishUpstream) };
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
    signal: req.signal,
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
  signal?: AbortSignal;
}): Promise<{
  statusCode?: number;
  statusMessage?: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
  error?: string;
}> {
  const bridge = (globalThis as { zcodeGitHttp?: { call(request: string): string; start?(request: string): string; poll?(id: string): string; cancel?(id: string): boolean } }).zcodeGitHttp;
  if (!bridge || typeof bridge.call !== "function") {
    throw new Error("原生 HTTP 桥不在（zcodeGitHttp）：这台宿主发不了出网请求");
  }
  const payload = JSON.stringify({
    url: req.url,
    method: req.method ?? "GET",
    headers: req.headers ?? {},
    bodyBase64: req.bodyBase64 ?? "",
  });
  // 网络等待交给原生后台任务，JS 轮询时仍可渲染和取消；旧壳继续接受同步协议。
  const res = (hasNativeJobs(bridge)
    ? await callNativeJob(bridge, JSON.parse(payload), req.signal)
    : JSON.parse(String(bridge.call(payload)))) as {
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
  /** 仅在镜像完整且与所有文件入口互斥时设置；当前 SAF 实现尚不能提供此保证。 */
  transactionSafe?: boolean;
  /** 命令前：确保镜像在场（首次全量物化，异步让出）。 */
  ensure(): Promise<void | { skipped?: number; failed?: number }>;
  /** 命令前（ensure 之后）：镜像快照，回写 diff 的基准。 */
  snapshot(): unknown;
  /** 命令后：把镜像 diff 落回 SAF；failed>0 时 errors 里带前三条原因。 */
  writeBack(snapshot: unknown): Promise<{ failed: number; errors: string[] } | null>;
}

/**
 * action 入口归一化（0.7.6 装机"未知 action"案的修复面）：剥隐形字符 → trim → 小写。
 * tool-engine.execute 已在 arguments JSON **原文**上过一次 sanitizeToolArguments，但那道闸
 * 只覆盖 agent 一个入口，且码点表（18 枚）之外的隐形字符照样漏网——这里对取值再补一刀，
 * 任何直连 handler 的路径（冒烟/自检/未来入口）形状等价。大小写与首尾空白则是净化管不着、
 * 模型又高频提交的形态（"Clone" / "clone "），严格 === 会把它们全打进 default 分支。
 */
export function normalizeGitAction(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return stripInvisibleChars(raw).trim().toLowerCase();
}

export function isGitActionName(action: string): action is GitActionName {
  return (GIT_ACTIONS as readonly string[]).includes(action);
}

/**
 * 把收到的值渲染成"截图后仍然可读"的码点形式：可打印 ASCII 原样保留，其余
 * （空格、制表/换行、零宽、双向控制）一律换成 U+XXXX 记号。装机案的错误文案是
 * `未知 action：<值>（...）`——值若全是空白/隐形字符，截图里就成了"未知 action：（...）"，
 * 看不出模型传了什么，锅没法定。
 */
export function printableCodepoints(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x21 && cp <= 0x7e) {
      out += ch;
    } else {
      if (out.length > 0 && !out.endsWith(" ")) out += " ";
      out += `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
    }
  }
  return out.trimEnd();
}

/** 未知 action 的报错三件套：收到什么（码点可打印）+ 归一化成什么 + 支持什么。 */
function unknownActionError(raw: string, normalized: string): string {
  const head =
    raw.length === 0
      ? "未知 action：未收到（空字符串或非字符串入参）"
      : `未知 action：收到值 "${printableCodepoints(raw)}"`;
  let normalizedNote = "";
  if (raw.length > 0 && normalized !== raw) {
    normalizedNote =
      normalized.length === 0
        ? "，归一化后为空（原值只有空白/隐形字符）"
        : `，归一化后 "${printableCodepoints(normalized)}"`;
  }
  return (
    `${head}${normalizedNote}（空白/隐形字符以 U+XXXX 码点显示）。` +
    `支持的动作：${GIT_ACTIONS.join("/")}。` +
    `大小写、首尾空白与零宽/双向字符已自动处理，这个值仍不在表内（如 checkout/diff 不是本工具的能力）——请从支持清单选一个重发。`
  );
}

export function makeGitTool(workspacePath: string, fs: unknown, stage?: GitStageControl) {
  return {
    // 0.8.0 事故修复：上游 ToolRegistry.toContracts() 从条目**顶层** inputSchema 取 schema
    // （registry.ts:114，ToolEntry.inputSchema 是顶层必填字段）——此前 schema 嵌在 metadata 里，
    // toContracts 拿到 undefined，发给模型的 function.parameters 退化成空对象，模型不知道有
    // action 这个必填参数 → 不带参调用 → 装机"未知 action：未收到"。schema 必须住顶层。
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...GIT_ACTIONS],
          description:
            "动作名对大小写不敏感，首尾空白与零宽/双向字符会自动剥除。" +
            "init=在当前工作区建 .git；clone=url 克隆到 dir（必传 url）；status=改动清单；add=暂存（path 或 '.'）；" +
            "commit=message 提交暂存；log=最近 depth 条（默认 20）；branch=分支名列表 / ref 建分支+切换；" +
            "remote=url 添加名为 remote 的远端 / 无 url 列出远端；push=推送当前分支到 remote（默认 origin）；" +
            "pull=拉取并快进合并 remote 的同名分支；fetch=只取不合并",
        },
        url: { type: "string", description: "HTTP(S) 远端地址，可内嵌 user:token（凭据仅本次使用、不保存）；不支持查询串或片段" },
        dir: {
          type: "string",
          description:
            "clone 目标目录（工作区相对路径）。'.' 或省略 = **附着模式**：把远端历史挂到当前工作区" +
            "（init+origin+fetch+对齐 HEAD，不覆盖现有文件）——目录里已有文件就用这个，" +
            "不要 clone 到子目录再搬 .git（会把仓库搬坏）",
        },
        path: { type: "string", description: "add 的单个文件/目录，包含空格时无需拆分（'.' = 全部）" },
        paths: { type: "array", items: { type: "string" }, description: "add 的多个文件/目录，与 path 二选一" },
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
    metadata: {
      name: GIT_TOOL,
      description:
        `内置 git（纯 JS 实现）：${GIT_ACTIONS.join("/")}。` +
        "提交身份默认 aZCode <azcode@local>（commit 入参可传 author.name/email 覆盖）。" +
        "优先使用本地文件夹；SAF 镜像在完整性和并发事务得到保障前不能执行 Git。" +
        "clone/push/pull/fetch 需要凭据时传 username/password；URL 内嵌凭据也仅在本次使用，不会保存。" +
        "（GitHub/GitLab 用 PAT 当 password）；没有凭据时先向用户要令牌再调用，不要盲试。",
    },
    handler: async (raw: unknown, context?: { abortSignal?: AbortSignal }) => {
      const input = (raw ?? {}) as Record<string, unknown>;
      // action 入口归一化 + 表外短路（0.7.6 装机"未知 action"案）：非法动作直接拒——
      // 不为它付 loadGit，也不触发 SAF 镜像两拍（首次全量物化可达秒级～十秒级）。
      // 错误文案带收到值的码点形式，截图即可定责（模型拼错 vs 入参夹不可见字符）。
      const rawAction = typeof input.action === "string" ? input.action : "";
      const action = normalizeGitAction(rawAction);
      if (!isGitActionName(action)) throw new Error(unknownActionError(rawAction, action));
      if (stage && stage.transactionSafe !== true) throw new Error("SAF 工作区镜像尚不能保证完整性和并发安全，Git 暂不可用；请使用本地文件夹。");
      if (action === "add") addPaths(workspacePath, input);
      if (action === "clone" && typeof input.dir === "string" && input.dir.trim() && ![".", "./"].includes(input.dir.trim())) cloneSubdirectory(workspacePath, input.dir.trim());
      const core = await loadGit();
      const dir = workspacePath;
      // SAF 纪律两拍（见 GitStageControl）：镜像在场 → 拍快照 → 跑命令 → diff 回写。
      // 命令失败也要回写（半程 clone/commit 已经写了一堆文件）；回写失败必须可见——
      // "git 说提交了、工作区里没有 .git"这种半真状态比报错更难查。
      let snapshot: unknown = null;
      if (stage) {
        const prepared = await stage.ensure();
        if (prepared && ((prepared.skipped ?? 0) > 0 || (prepared.failed ?? 0) > 0)) throw new Error("SAF 工作区镜像不完整，无法安全执行 Git；请使用本地文件夹。");
        snapshot = stage.snapshot();
        if (!snapshot) throw new Error("无法创建 SAF 工作区快照，Git 未执行；请使用本地文件夹。");
      }
      let result: string | null = null;
      let failure: unknown = null;
      try {
        result = await runGitAction(core, fs, dir, action, input, context?.abortSignal);
      } catch (e) {
        failure = e;
      }
      let wbNote = "";
      if (stage && snapshot) {
        try {
          const wb = await stage.writeBack(snapshot);
          if (!wb || wb.failed > 0) {
            wbNote =
              `\n\n回写失败：${wb ? `${wb.failed} 处 git 改动未能写回工作区（${wb.errors.join("；")}）` : "无法确认回写结果"}。` +
              `这些改动在终端镜像里已生效，但文件工具读到的是未写回版本。`;
          }
        } catch (e) {
          wbNote = `\n\n回写失败：${String((e as Error)?.message ?? e)}`;
        }
      }
      if (failure !== null) {
        if (wbNote) throw new Error(`${String((failure as Error)?.message ?? failure)}${wbNote}`, { cause: failure });
        throw failure;
      }
      if (wbNote) throw new Error(wbNote.trim());
      return result;
    },
  };
}

/** 老 runGitAction 的参数面收进上下文对象，让分发表每项签名一致（不新增动作，纯一致性修复）。 */
interface GitActionCtx {
  core: GitModule;
  fs: unknown;
  dir: string;
  input: Record<string, unknown>;
  signal?: AbortSignal;
}

/** 附着只针对未建仓库的目录；不能静默覆盖已有 origin 或 HEAD。 */
async function assertNoRepository(fs: unknown, dir: string): Promise<void> {
  const api = (fs as { promises?: { stat(path: string): Promise<unknown> } }).promises;
  if (!api || typeof api.stat !== "function") throw new Error("文件系统不能检查已有 Git 仓库");
  try {
    await api.stat(`${dir}/.git`);
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("当前目录已有 Git 仓库；请直接使用现有仓库，不会覆盖其远端配置。");
}

/** clone 子目录始终位于工作区，禁止通过 ../ 或绝对路径写到另一工作区。 */
function cloneSubdirectory(dir: string, raw: string): string {
  const normalized = raw.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) throw new Error("clone 目标必须是工作区内的相对路径");
  return `${dir.replace(/\/+$/, "")}/${gitRelativePath(dir, normalized)}`;
}

function addPaths(dir: string, input: Record<string, unknown>): string[] {
  if (input.path !== undefined && input.paths !== undefined) throw new Error("path 和 paths 只能传一个");
  const paths = input.paths === undefined ? [input.path === undefined ? "." : input.path] : input.paths;
  if (!Array.isArray(paths) || !paths.length || paths.some(path => typeof path !== "string" || !path)) throw new Error("add 需要非空的文件路径");
  return paths.map(path => gitRelativePath(dir, path as string, true));
}

function redactRemoteUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch { return value.replace(/(https?:\/\/)[^/@\s]+@/gi, "$1***@"); }
}

/** URL 凭据只驻留本次调用的内存，绝不进入 clone 自动创建的 origin 配置。 */
function parseRemoteUrl(value: string): { url: string; auth?: GitAuth } {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("Git 远端地址无效，请使用 HTTP(S) 地址。"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Git 远端只支持 HTTP(S) 地址。");
  if (parsed.search || parsed.hash) throw new Error("Git 远端地址不能包含查询参数或片段，请重新配置并使用用户名/密码认证。");
  let username: string, password: string;
  try { username = decodeURIComponent(parsed.username); password = decodeURIComponent(parsed.password); }
  catch { throw new Error("Git 远端凭据的编码无效。"); }
  parsed.username = "";
  parsed.password = "";
  return { url: parsed.toString(), ...(username || password ? { auth: { username, password } } : {}) };
}

/** 查看远端不得修改用户现有凭据；仅在内存中提取并脱敏。 */
async function cleanConfiguredRemotes(core: GitModule, fs: unknown, dir: string, selected?: string): Promise<Array<{ remote: string; url: string; auth?: GitAuth }>> {
  const remotes = await core.listRemotes({ fs, dir });
  const parsed = remotes.filter(remote => !selected || remote.remote === selected).map(remote => ({
    ...remote,
    clean: /^https?:\/\//i.test(remote.url) ? parseRemoteUrl(remote.url) : { url: redactRemoteUrl(remote.url), auth: undefined },
  }));
  return parsed.map(remote => ({ remote: remote.remote, url: remote.clean.url, auth: remote.clean.auth }));
}

async function networkRemote(core: GitModule, fs: unknown, dir: string, remote: string, input: Record<string, unknown>) {
  const remotes = await cleanConfiguredRemotes(core, fs, dir, remote);
  const configured = remotes.find(item => item.remote === remote);
  if (configured && !/^https?:\/\//i.test(configured.url)) throw new Error("Git 远端只支持 HTTP(S) 地址，请重新配置。");
  const explicit = typeof input.url === "string" && input.url.trim() ? parseRemoteUrl(input.url.trim()) : undefined;
  return { url: explicit?.url ?? configured?.url, onAuth: authFrom(input, explicit?.auth ?? configured?.auth) };
}

/**
 * 分发表：键与 GIT_ACTIONS 一一对应——Record<GitActionName, …> 让 tsc 对"漏分支"
 * （缺键）与"多分支"（字面量多键）都报错，enum/校验/分发从此不靠人肉同步。
 * 分支体为原 switch case 逐字平移，行为零改动。
 */
const gitActionHandlers: Record<GitActionName, (ctx: GitActionCtx) => Promise<string>> = {
  init: async ({ core, fs, dir }) => {
    await assertNoRepository(fs, dir);
    await core.init({ fs, dir });
    return `已在 ${dir} 初始化 git 仓库（.git 已创建，默认分支 master）。`;
  },
  clone: async ({ core, fs, dir, input, signal }) => {
    const remote = parseRemoteUrl(typeof input.url === "string" ? input.url.trim() : "");
    const { url } = remote;
    const onAuth = authFrom(input, remote.auth);
    const http = await loadGitHttp(signal);
    const subdir = typeof input.dir === "string" && input.dir.trim() ? input.dir.trim() : "";
    // 附着模式（0.6.8，装机"clone 到子目录再搬 .git 到根"的脆弱舞蹈）：dir="." 或省略
    // = 把历史挂到**当前目录**：init → 连 origin → fetch → 对齐 HEAD 到远端默认分支，
    // **不 checkout**（现有快照文件原地不动，statusMatrix 会如实报差异）。
    // 这正是"目录已有文件又想有 git 历史"的正解——isomorphic-git 的 clone 对非空目录
    // 会把远端文件盖下来，模型不敢用才去搬 .git，搬的过程中 refs 布局一乱就全崩。
    if (!subdir || subdir === "." || subdir === "./") {
      await assertNoRepository(fs, dir);
      await core.init({ fs, dir });
      await core.addRemote({ fs, dir, remote: "origin", url });
      const info = await core
        .getRemoteInfo({ http, url, onAuth })
        .catch(() => ({ HEAD: undefined, refs: undefined }));
      const headRef = typeof info.HEAD === "string" ? /^(?:ref:\s*)?refs\/heads\/(.+)$/.exec(info.HEAD)?.[1] : undefined;
      const fetched = await core.fetch({ fs, http, dir, remote: "origin", depth: 50, onAuth });
      // fetch 只建立 refs/remotes/origin/*，不自动建立 refs/heads/*。
      const branches = (await core.listBranches({ fs, dir, remote: "origin" })).filter((branch) => branch !== "HEAD");
      const target = headRef && branches.includes(headRef)
        ? headRef
        : branches.includes("main")
          ? "main"
          : branches.includes("master")
            ? "master"
            : branches[0] ?? "";
      if (target) {
        const sha = await core.resolveRef({ fs, dir, ref: `refs/remotes/origin/${target}` });
        await core.writeRef({ fs, dir, ref: `refs/heads/${target}`, value: sha });
        await core.writeRef({ fs, dir, ref: "HEAD", value: `refs/heads/${target}`, symbolic: true, force: true });
        await core.setConfig({ fs, dir, path: `branch.${target}.remote`, value: "origin" });
        await core.setConfig({ fs, dir, path: `branch.${target}.merge`, value: `refs/heads/${target}` });
      return `已把 ${redactRemoteUrl(url)} 的历史挂到 ${dir}（分支 ${target} @ ${String(sha ?? "?").slice(0, 10)}，未改动现有文件；用 status 看差异）。`;
      }
      return `已连接 ${redactRemoteUrl(url)} 并 fetch，但远端没有可对齐的分支${fetched.fetchHead ? `（HEAD ${fetched.fetchHead.slice(0, 10)}）` : "（远端可能是空仓库）"}。`;
    }
    const target = cloneSubdirectory(dir, subdir);
    try {
      const entries = await (fs as any).promises.readdir(target);
      if (entries.length) throw new Error("clone 目标目录非空；为保护现有文件已取消。");
    } catch (error) {
      if ((error as { code?: string })?.code !== "ENOENT") throw error;
    }
    await core.clone({ fs, http, dir: target, url, singleBranch: false, depth: 50, onAuth });
    const branches = ((await core.listBranches({ fs, dir: target }).catch(() => [])) as string[]) ?? [];
    return `已克隆 ${redactRemoteUrl(url)} → ${target}（分支：${branches.slice(0, 5).join("、") || "?"}）。`;
  },
  status: async ({ core, fs, dir }) => {
    const states = await scanGitStates({ git: core, fs, dir });
    const changed = states.map(({ file, head, index, work, conflicted }) => {
      const marks: string[] = [];
      if (conflicted) marks.push("冲突");
      else {
        if (!sameGitVersion(head, index)) marks.push(!index ? "暂存删除" : !head ? "暂存新增" : "暂存修改");
        if (!sameGitVersion(index, work)) marks.push(!work ? "未暂存删除" : !index ? "未跟踪" : "未暂存修改");
      }
      return `${file}  ${marks.join("、")}`;
    });
    const { branch } = await repoContext(core, fs, dir);
    return `分支：${branch}\n改动 ${changed.length} 个文件：\n${changed.slice(0, 200).join("\n") || "（干净）"}${changed.length > 200 ? `\n（另有 ${changed.length - 200} 个文件）` : ""}`;
  },
  add: async ({ core, fs, dir, input }) => {
    const paths = addPaths(dir, input);
    await stageGitPaths({ git: core, fs, dir }, paths);
    return `已暂存：${paths.join("、")}`;
  },
  commit: async ({ core, fs, dir, input }) => {
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
  },
  log: async ({ core, fs, dir, input }) => {
    const depth = typeof input.depth === "number" && input.depth > 0 ? Math.min(input.depth, 100) : 20;
    const commits = (await core.log({ fs, dir, depth })) as LogEntry[];
    return commits
      .map((c) => `${String(c.oid).slice(0, 10)} ${c.commit.author.name} ${c.commit.author.timestamp ? new Date(c.commit.author.timestamp * 1000).toISOString().slice(0, 16) : ""}\n  ${c.commit.message.split("\n")[0]}`)
      .join("\n");
  },
  branch: async ({ core, fs, dir, input }) => {
    const ref = typeof input.ref === "string" && input.ref.trim() ? input.ref.trim() : "";
    if (ref) {
      await core.branch({ fs, dir, ref, checkout: true });
      return `已创建并切换到分支 ${ref}。`;
    }
    const branches = (await core.listBranches({ fs, dir })) as string[];
    const { branch } = await repoContext(core, fs, dir);
    return `当前分支：${branch}\n全部分支：${branches.join("、")}`;
  },
  remote: async ({ core, fs, dir, input }) => {
    const url = typeof input.url === "string" && input.url.trim() ? input.url.trim() : "";
    const remoteName = typeof input.remote === "string" && input.remote.trim() ? input.remote.trim() : "origin";
    if (url) {
      const clean = parseRemoteUrl(url);
      await core.addRemote({ fs, dir, remote: remoteName, url: clean.url, force: input.force === true });
      return `远端 ${remoteName} 已指向 ${clean.url}。${clean.auth ? "凭据未保存，后续网络操作请提供 username/password。" : ""}`;
    }
    const remotes = await cleanConfiguredRemotes(core, fs, dir);
    return remotes.length > 0
      ? remotes.map((r) => `${r.remote}\t${r.url}${r.auth ? "（现有配置包含凭据）" : ""}`).join("\n")
      : "（还没有配置远端——用 action=remote + url 添加。）";
  },
  push: async ({ core, fs, dir, input, signal }) => {
    const remoteName = typeof input.remote === "string" && input.remote.trim() ? input.remote.trim() : "origin";
    const branch = (await core.currentBranch({ fs, dir, fullname: false })) as string | null;
    // 推送走共享实现（与设置页 Git 面板同一个函数）：传输、远端解析与凭据语义只有一份。
    await pushGitBranch({ core, fs, dir, branch: branch ?? "", input, signal });
    return `已推送 ${branch ?? "?"} → ${remoteName}。`;
  },
  pull: async ({ core, fs, dir, input, signal }) => {
    const http = await loadGitHttp(signal);
    const remoteName = typeof input.remote === "string" && input.remote.trim() ? input.remote.trim() : "origin";
    const { url, onAuth } = await networkRemote(core, fs, dir, remoteName, input);
    const branch = (await core.currentBranch({ fs, dir, fullname: false })) as string | null;
    const pullResult = (await core.pull({
      fs,
      http,
      dir,
      remote: remoteName,
      ...(url ? { url } : {}),
      ...(branch ? { ref: input.ref && typeof input.ref === "string" && input.ref.trim() ? input.ref.trim() : branch } : {}),
      fastForward: true, // 只快进：分叉时如实报错让模型决断，不静默造合并提交
      onAuth,
      author: DEFAULT_AUTHOR,
    })) as { fetchHead?: string; newHead?: string };
    return `已拉取 ${remoteName}（${branch ?? "?"}）${pullResult.newHead ? `，更新到 ${String(pullResult.newHead).slice(0, 10)}` : "，已是最新"}。`;
  },
  fetch: async ({ core, fs, dir, input, signal }) => {
    const http = await loadGitHttp(signal);
    const remoteName = typeof input.remote === "string" && input.remote.trim() ? input.remote.trim() : "origin";
    const { url, onAuth } = await networkRemote(core, fs, dir, remoteName, input);
    const depth = typeof input.depth === "number" && input.depth > 0 ? input.depth : undefined;
    await core.fetch({
      fs,
      http,
      dir,
      remote: remoteName,
      ...(url ? { url } : {}),
      ...(depth ? { depth } : {}),
      onAuth,
    });
    return `已从 ${remoteName} 取回远端引用（未合并——用 branch/pull 落地）。`;
  },
};

/**
 * 分发入口：action 必须已是归一化且过校验的 GitActionName（handler 入口短路，表外字符串
 * 走不到这里；分发表键又被 Record 类型钉成 GIT_ACTIONS——三层同源）。
 */
export async function runGitAction(
  core: GitModule,
  fs: unknown,
  dir: string,
  action: GitActionName,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new DOMException("操作已取消", "AbortError");
  try {
    return await gitActionHandlers[action]({ core, fs: scopedGitFs(fs, dir), dir, input, signal });
  } catch (error) {
    let message = String((error as Error)?.message ?? error).replace(/https?:\/\/[^\s"'<>]+/gi, redactRemoteUrl);
    for (const secret of rememberedSecrets.get(input) ?? []) message = message.split(secret).join("[已隐藏]");
    // 不把可能包含令牌的原始异常附在 cause 中，避免上层日志再次泄露。
    throw new Error(message);
  }
}

const rememberedSecrets = new WeakMap<Record<string, unknown>, string[]>();
/** 入参里的凭据 → onAuth 应答；没有就返回 undefined（服务器拒绝时错误原文上抛）。 */
function authFrom(input: Record<string, unknown>, embedded?: GitAuth): ((url: string) => GitAuth | undefined) | undefined {
  const username = typeof input.username === "string" ? input.username.trim() : embedded?.username ?? "";
  const password = typeof input.password === "string" ? input.password : embedded?.password ?? "";
  if (!username && !password) return undefined;
  rememberedSecrets.set(input, [...new Set([password, embedded?.password].filter((value): value is string => Boolean(value)))]);
  return () => ({ username: username || password, password });
}
