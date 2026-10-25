// 内置网络下载（0.7.3，用户点名"内置 curl/wget 工具，申请对全部文件的管理权限"）。
//
// 为什么是端侧自建工具、而不是"给用户装 curl"：Android toybox 沙箱里没有 curl/wget，
// 也装不上（无 root、无包管理器，见 tool-engine 的 bash 守卫）。但模型要取远端资源
// （下依赖、看 API 返回、抓网页）是真实需求，且 fetch 走 WebView 又是跨源——git 那套
// 已经证明第三方端点不答 CORS（0.6.7）。所以这里复用 **同一条原生 HTTP 桥**
// （GitHttpBridge.kt 的 bridgeHttpRaw：HttpURLConnection 代发，没有 CORS 概念），
// 下载落盘走 vfs（工作区内，与文件工具同一棵树；越界仍由 file-system port 的授权闸拦）。
//
// curl 与 wget 的两个动作合成一个工具的两个 mode：
//   - fetch：GET 一个 URL，把响应体回给模型（文本预览，二进制只报大小/类型，别把字节灌进对话）；
//   - download：GET 一个 URL，把字节写进工作区某个路径（wget 的 -O），回一句落盘事实。
// URL 只允许 http/https；其余协议（file://、gopher://…）直接拒——curl 能读本地文件，
// 端侧有了这个就等于绕过沙箱，这条必须堵死。
import { bridgeHttpRaw, bytesFromBase64 } from "./git-tool.js";

export const FETCH_TOOL = "Fetch";

/** 回给模型的文本预览上限：一次网页抓取能到几 MB，原样喂回去会把下一轮请求撑爆。 */
const PREVIEW_MAX_CHARS = 20_000;
/** download 落盘上限（字节）：防模型一口气拉一个超大文件把私有盘写满。 */
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

function base64FromBytes(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** content-type 判"这是不是能当文本预览的内容类型"。未知/二进制只报元信息。 */
function looksTextual(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return (
    ct.includes("text/") ||
    ct.includes("json") ||
    ct.includes("xml") ||
    ct.includes("javascript") ||
    ct.includes("html") ||
    ct.includes("csv") ||
    ct.includes("yaml") ||
    ct.trim() === "" // 很多 API 不给 content-type，按文本处理更可用（下面预览仍会截断）。
  );
}

/**
 * 写工作区文件走 vfs 派发层：与 Write 工具/文件端口同一棵树，SAF(/mnt/<名>) 与
 * 私有盘(/work) 各自路由；vfs 的 writeFile 收 base64/字符串/Uint8Array 三种 data
 * （见 compat/vfs-*.mjs 的 encodeBase64 分支），这里统一传 Uint8Array。
 */
function writeFileBytes(
  vfs: {
    writeFile(p: string, data: unknown, opts?: unknown, syscall?: string): void;
    mkdir?(p: string, opts?: unknown): unknown;
  },
  path: string,
  bytes: Uint8Array,
): void {
  // 逐级建父目录：download 到嵌套路径（如 deps/a/b.bin）时 vfs 不会自动建中间层。
  const parent = path.slice(0, path.lastIndexOf("/"));
  if (parent && typeof vfs.mkdir === "function") {
    try {
      vfs.mkdir(parent, { recursive: true });
    } catch {
      // 已存在/建不了都会在下面 writeFile 处以更准确的原语错误暴露，这里不抢它的错误。
    }
  }
  vfs.writeFile(path, bytes, {}, "writeFile");
}

/**
 * 解析 URL：只放行 http/https。返回归一化后的 URL 或 null（协议不允许）。
 * 单独抽出是因为这条是安全边界——curl 能 file:// 读本地、gopher:// 打内网，端侧工具
 * 绝不能给模型开这个口子（原生桥也会真发出去）。
 */
function normalizeAllowedUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

/** 相对下载路径按工作区根解析（与文件工具/删除同一语义）。 */
function resolveDownloadPath(workspacePath: string, rawPath: string): string {
  return rawPath.startsWith("/") ? rawPath : `${workspacePath}/${rawPath}`;
}

/**
 * 造一个 Fetch 工具的注册对象（handler 闭包持有 vfs + 工作区根）。
 * 不依赖原生执行桥（curl/wget 本来就不是 shell 命令），只要有 HTTP 桥就注册——
 * 与 Browser 同一条纪律：桥不在（桌面纯 harness）就不声明，模型无从发起没人接的调用。
 */
export function makeFetchTool(
  workspacePath: string,
  vfs: {
    writeFile(p: string, data: unknown, opts?: unknown, syscall?: string): void;
    mkdir?(p: string, opts?: unknown): unknown;
  },
) {
  const bridgePresent = () => {
    const bridge = (globalThis as { zcodeGitHttp?: { call(request: string): string } }).zcodeGitHttp;
    return Boolean(bridge && typeof bridge.call === "function");
  };
  return {
    // 0.8.0 事故修复：schema 住条目顶层（ToolEntry.inputSchema），不嵌 metadata——嵌了
    // toContracts 拿 undefined，模型收到空参数声明（详见 git-tool.ts 同批注释）。
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["fetch", "download"], description: "fetch=读取并返回内容；download=下载到工作区文件" },
        url: { type: "string", description: "http/https 完整地址（必填）" },
        path: { type: "string", description: "download 时的落盘路径（工作区相对，或绝对 /work、/mnt/<名>、/sdcard/…；action=download 必填）" },
        headers: { type: "object", description: "可选请求头（string→string）" },
      },
      required: ["action", "url"],
      additionalProperties: false,
    },
    metadata: {
      name: FETCH_TOOL,
      description:
        "网络下载（内置，等效 curl/wget，无需安装）。action=fetch：GET 一个 http/https URL，把响应内容回给你（文本类给正文预览，二进制只报大小/类型不落盘）；" +
        "action=download：把 URL 的字节下载并写进工作区 path（等效 wget -O），可用于取依赖、抓文件。" +
        "path 是工作区相对路径即可；绝对路径按当前工作区根（/work、/mnt/<名> 或 /sdcard/… 真路径工作区）解析。" +
        "只允许 http/https；工作区外的路径会被授权闸拦下按询问授权处理。",
    },
    handler: async (raw: unknown) => {
      if (!bridgePresent()) throw new Error("端侧没有原生 HTTP 桥（zcodeGitHttp），发不了出网请求");
      const input = (raw ?? {}) as {
        action?: unknown;
        url?: unknown;
        path?: unknown;
        headers?: unknown;
      };
      const action = typeof input.action === "string" ? input.action : "";
      if (action !== "fetch" && action !== "download") {
        throw new Error(`未知 action：${action}（应为 fetch 或 download）`);
      }
      const url = typeof input.url === "string" ? normalizeAllowedUrl(input.url) : null;
      if (!url) throw new Error("url 必须是 http/https 完整地址（其它协议一律拒绝）");
      const headers: Record<string, string> = {};
      if (input.headers && typeof input.headers === "object" && !Array.isArray(input.headers)) {
        for (const [k, v] of Object.entries(input.headers as Record<string, unknown>)) {
          if (typeof v === "string") headers[k] = v;
        }
      }
      const res = await bridgeHttpRaw({ url, method: "GET", headers });
      const contentType = String(res.headers?.["content-type"] ?? res.headers?.["Content-Type"] ?? "");
      const status = res.statusCode ?? 0;
      const bytes = res.bodyBase64 ? bytesFromBase64(res.bodyBase64) : new Uint8Array(0);
      if (status >= 400) {
        // 4xx/5xx 也是"工具执行成功、HTTP 报错"——按 curl -f 之外默认行为：把状态与
        // 简短响应回给模型，它自己判断要不要重试，别在这里 throw 丢内容。
        const detail = looksTextual(contentType)
          ? ` ${new TextDecoder().decode(bytes.subarray(0, 500))}`
          : "";
        throw new Error(`HTTP ${status}（${url}）${detail}`);
      }
      if (action === "download") {
        const rawPath = typeof input.path === "string" ? input.path.trim() : "";
        if (!rawPath) throw new Error("action=download 需要 path（落盘路径）");
        if (bytes.length > MAX_DOWNLOAD_BYTES) {
          throw new Error(`下载内容 ${bytes.length} 字节，超过 ${MAX_DOWNLOAD_BYTES} 上限，拒绝落盘`);
        }
        const resolved = resolveDownloadPath(workspacePath, rawPath);
        writeFileBytes(vfs, resolved, bytes);
        return `已下载 ${bytes.length} 字节 → ${resolved}（HTTP ${status}${contentType ? `，${contentType}` : ""}）`;
      }
      // fetch：文本给预览，二进制只报元信息（不把几 MB 字节灌进对话）。
      if (!looksTextual(contentType)) {
        return `（二进制内容，${bytes.length} 字节${contentType ? `，${contentType}` : ""}；如需保存用 action=download 指定 path）`;
      }
      const text = new TextDecoder().decode(bytes);
      const preview = text.length > PREVIEW_MAX_CHARS
        ? `${text.slice(0, PREVIEW_MAX_CHARS)}\n…(截断，原长 ${text.length} 字符)`
        : text;
      return `HTTP ${status}${contentType ? ` · ${contentType}` : ""} · ${bytes.length} 字节\n${preview}`;
    },
  };
}
