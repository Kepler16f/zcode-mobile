// 套餐额度接口由供应商提供，可能不支持 WebView 的跨域预检。
// Android 使用可取消的原生 HTTP 任务；浏览器开发环境继续使用标准 fetch。
//
// 0.11.3（装机主诉"体验套餐获取失败"的根因修复）：zcode.z.ai 的 zcode-plan 端点
// （billing/balance、企业定价等）会校验 **ZCode 上下文头组**——只带 Authorization 时
// 服务端回 400 `{"code":3001,"msg":"parameter error"}`（2026-11-07 桌面真实凭据复放
// 实测：补齐池子/桌面同款 X-* 头后 code=0 plans=1）。这里的头组与池子 Rust 客户端
// （zai_billing_headers_with_mid）逐项对齐：UA/Referer/X-Title/X-ZCode-App-Version/
// X-Platform/X-Release-Channel/X-Client-*/X-Os-*/X-Device-Mid/x-request-id。
// 版本读 zcodeDevice.deviceInfo().appVersion（真构建版本，不写死）；Device-Mid 是
// 本地持久化的随机 UUID（首次生成后固定，服务端按它识别设备）。
import { callNativeJob, hasNativeJobs } from "../ports/native-async.mjs";
import type { MobileApiClient } from "./oauth.js";
import { officialCompatibilityVersion, rewritePlatformForServer } from "./server-compat.js";

type Bridge = { start(request: string): string; poll(id: string): string; cancel(id: string): boolean };
type Reply = { statusCode?: number; statusMessage?: string; headers?: Record<string, string>; bodyBase64?: string; error?: string };

const DEVICE_MID_KEY = "zcode-mobile.deviceMid";
const SESSION_ID_KEY = "zcode-mobile.sessionId";
/** 官方域：zcode.z.ai（套餐/配置面）、api.z.ai（Z.ai 业务面：客户信息/订阅清单/换 Key）、
 *  bigmodel.cn / bigmodel.com.cn（BigModel 业务面）。.z.ai 后缀覆盖 api.z.ai 与 zcode.z.ai。 */
const CONTEXT_HOSTS = [".z.ai", ".bigmodel.cn", ".bigmodel.com.cn"];
/**
 * 套餐查询取证（0.11.5）：装机报"体验套餐获取失败"而端侧自检里没有任何读数——
 * 真机失败时看不到请求打到哪、带了什么头、回了什么，于是只能靠猜（本项目已因此空转数轮）。
 * 这里把每次套餐请求的**关键事实**写进 localStorage 诊断键，装机报告/自检页可直接读出：
 * 请求路径与归一后的 URL、是否带上上下文头、HTTP 状态、业务 code/msg、异常消息。
 */
const PLAN_DIAG_KEY = "zcode-mobile.plan.diag";
const PLAN_DIAG_MAX = 40;

export interface PlanDiagEntry {
  at: number;
  url: string;
  method: string;
  hasAuth: boolean;
  identityHeaders: boolean;
  appVersionParam: string | null;
  status?: number;
  businessCode?: unknown;
  businessMsg?: string;
  error?: string;
}

function recordPlanDiag(entry: PlanDiagEntry): void {
  try {
    const raw = globalThis.localStorage?.getItem(PLAN_DIAG_KEY);
    const list: PlanDiagEntry[] = raw ? (JSON.parse(raw) as PlanDiagEntry[]) : [];
    list.push(entry);
    while (list.length > PLAN_DIAG_MAX) list.shift();
    globalThis.localStorage?.setItem(PLAN_DIAG_KEY, JSON.stringify(list));
  } catch {
    /* 取证失败不影响主流程 */
  }
}

export function readPlanDiag(): PlanDiagEntry[] {
  try {
    const raw = globalThis.localStorage?.getItem(PLAN_DIAG_KEY);
    return raw ? (JSON.parse(raw) as PlanDiagEntry[]) : [];
  } catch {
    return [];
  }
}

function encode(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function randomUUID(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // noUncheckedIndexedAccess：下标访问是 number | undefined，取值前先收窄。
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 本机设备 Mid：首次生成后固定（localStorage），供 X-Device-Mid 计费头使用。 */
export function getOrCreateDeviceMid(): string {
  try {
    const existing = globalThis.localStorage?.getItem(DEVICE_MID_KEY);
    if (existing) return existing;
    const mid = randomUUID();
    globalThis.localStorage?.setItem(DEVICE_MID_KEY, mid);
    return mid;
  } catch {
    return randomUUID();
  }
}

/** 当前会话 UUID：跨官方请求复用同一 session_id 保持会话粘性。 */
export function getOrCreateSessionId(): string {
  try {
    const existing = globalThis.localStorage?.getItem(SESSION_ID_KEY);
    if (existing) return existing;
    const sid = randomUUID();
    globalThis.localStorage?.setItem(SESSION_ID_KEY, sid);
    return sid;
  } catch {
    return randomUUID();
  }
}

/** 从 ZCode JWT载荷里提取 user_id / sub（无签名校验，仅用于遥测与页面回传上下文）。 */
export function decodeJwtUserId(jwt: string | null | undefined): string | null {
  const token = jwt?.trim().replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = JSON.parse(atob(padded)) as { user_id?: unknown; userId?: unknown; sub?: unknown };
    const candidate = json.user_id ?? json.userId ?? json.sub;
    return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
  } catch {
    return null;
  }
}

export function isZCodeContextHost(url: URL): boolean {
  return isContextHost(url);
}

function appVersion(): string {
  try {
    const bridge = (globalThis as { zcodeDevice?: { deviceInfo?(): string } }).zcodeDevice;
    const info = bridge?.deviceInfo?.() ? JSON.parse(String(bridge.deviceInfo())) : null;
    const v = typeof info?.appVersion === "string" ? info.appVersion.trim() : "";
    return v || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * 官方客户端身份（0.11.4，实测定性）：zcode-plan 端点按"官方客户端身份"校验——
 * `x-platform: android-arm64`、`x-os-category: android`、自报版本号（0.11.x）这类
 * 不存在于 ZCode 发行版的值就是强拒绝信号（3001 parameter error）。参考实现
 * （HarmonyOS 移植层 ohos-identity.cjs，官方 AppImage 原样跑、Start Plan 可用）
 * 的归一口径：x-platform→linux-arm64、x-os-category→linux、x-os-version→Linux
 * 内核串、x-zcode-app-version/user-agent→**官方发行版本号**。用户可经
 * desktopCompatibilityVersion（localStorage）覆盖，缺省跟当前官方发行版。
 */
/** X-Os-Version 的统一口径；官方 system 的 env 段（OS Version 行）也用同一个值。 */
export const OFFICIAL_LINUX_KERNEL = "6.8.0-45-generic";

function officialVersion(): string {
  return officialCompatibilityVersion();
}

function locale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "unknown";
  } catch {
    return "unknown";
  }
}

function timezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
  } catch {
    return "unknown";
  }
}

function isContextHost(url: URL): boolean {
  const host = url.hostname;
  return CONTEXT_HOSTS.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
}

/**
 * ZCode 上下文头组（0.11.3 注入 / 0.11.4 值归一）：zcode-plan/套餐端点的必验参数
 * （缺失即 3001 parameter error；值不像官方客户端同样被拒——实测
 * `x-platform: android-arm64`/自报 0.11.x → 3001，`linux-arm64`/官方版本号 → code=0）。
 * 只对 z.ai / bigmodel.cn 域名注入；调用方显式给过的键不覆盖。
 */
export function zcodeContextHeaders(url: URL): Record<string, string> {
  if (!isContextHost(url)) return {};
  const version = officialVersion();
  return {
    "User-Agent": `ZCode/${version}`,
    "HTTP-Referer": `${url.protocol}//${url.host}`,
    "X-Title": "Z Code@electron",
    "X-ZCode-App-Version": version,
    "X-Platform": "linux-arm64",
    "X-Release-Channel": "production",
    // 官方运行时（CLI/Desktop）模型与活动请求带的两条身份头；zcode-plan 网关按它们识别 ZCode 客户端。
    "X-ZCode-Agent": "glm",
    "X-ZCode-Session-Type": "main",
    "X-Client-Language": locale(),
    "X-Client-Timezone": timezone(),
    "X-Os-Category": "linux",
    "X-Os-Version": OFFICIAL_LINUX_KERNEL,
    "X-Device-Mid": getOrCreateDeviceMid(),
    "x-request-id": randomUUID(),
  };
}

function mergeContextHeaders(url: URL, headers: Record<string, string>): Record<string, string> {
  const context = zcodeContextHeaders(url);
  const merged: Record<string, string> = { ...context };
  for (const [key, value] of Object.entries(headers)) {
    // 调用方显式给的键优先（Authorization 等业务头绝不被上下文头覆盖）；
    // 但官方域的 X-Platform 若被上游 process 垫片填成 android-*，仍需归一成 linux-*，避免服务端 3001。
    const lower = key.toLowerCase();
    let normalizedValue = value;
    if (lower === "x-platform" && (value === "android" || value.startsWith("android-"))) {
      normalizedValue = /x64|x86_64/i.test(value) ? "linux-x64" : "linux-arm64";
    }
    const contextKey = Object.keys(context).find((k) => k.toLowerCase() === lower);
    if (contextKey) delete merged[contextKey];
    merged[key] = normalizedValue;
  }
  return merged;
}

/**
 * 公共出口（0.11.5）：给任意官方域请求补上身份归一头 + app_version 归一。
 * 参考实现（HarmonyOS 移植层）就是在全局 fetch 上做同一件事——官方域的每个请求都受益。
 * 非官方域原样放行；调用方显式给的键不被覆盖。
 *
 * 形状：{ url, headers }——url 是**归一后的新 URL**（调用方必须用这个 url 发请求，
 * 否则 app_version 归一不会生效：上游 URL 是字符串/URL 实例，字符串路径必须取返回值）。
 */
export function officialIdentityRequest(
  input: string | URL,
  headers: Record<string, string> = {},
): { url: URL; headers: Record<string, string> } {
  let parsed: URL;
  try {
    parsed = input instanceof URL ? new URL(input.href) : new URL(String(input), globalThis.location?.href ?? "https://zcode.z.ai");
  } catch {
    return { url: input instanceof URL ? input : new URL("https://zcode.z.ai"), headers };
  }
  if (!isContextHost(parsed)) return { url: parsed, headers };
  parsed = rewriteOfficialUrl(parsed);
  return { url: parsed, headers: mergeContextHeaders(parsed, headers) };
}

/** app_version 归一（0.11.4）：上游用 ZCODE_VERSION（仓库构建=0.0.0-dev）填参，服务端
 * 3001 parameter error。官方发行版本号可经 desktopCompatibilityVersion 覆盖。 */
function rewriteOfficialUrl(input: URL): URL {
  if (!isContextHost(input)) return input;
  const parsed = input;
  // 0.12.4 回滚：0.12.3 曾把 zcode-plan/anthropic 迁到 open.bigmodel.cn（Coding Plan 的
  // 端点）——方向错误。Start Plan（赠送试用 token）与 Coding Plan（付费订阅）是两个
  // 不同的额度体系，模型请求都走 zcode.z.ai 的 zcode-plan 网关；405 是服务端**客户端
  // 身份校验**（"请用官方 ZCode 客户端"），不是端点废弃。
  if (parsed.searchParams.has("app_version")) {
    parsed.searchParams.set("app_version", officialVersion());
  }
  return parsed;
}

/** 只取头（URL 归一结果由调用方自行处理时用；**注意** app_version 归一不会体现在返回值里）。 */
export function officialIdentityHeaders(
  input: string | URL,
  headers: Record<string, string> = {},
): Record<string, string> {
  return officialIdentityRequest(input, headers).headers;
}

export function createQuotaApiClient(): MobileApiClient {
  return {
    async request(input, init = {}) {
      const { timeoutMs, ...rest } = init;
      const signal = timeoutMs
        ? rest.signal ? AbortSignal.any([rest.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
        : rest.signal;
      const url = rewritePlatformForServer(input);
      // 0.12.3：官方域统一归一（Start Plan anthropic 端点迁移 + app_version 口径）。
      let parsed = url instanceof URL ? new URL(url.href) : new URL(url, globalThis.location?.href ?? "https://zcode.z.ai");
      parsed = rewriteOfficialUrl(parsed);
      const callerHeaders = Object.fromEntries(new Headers(rest.headers).entries());
      const contextHeaders = mergeContextHeaders(parsed, callerHeaders);
      const diagBase = {
        url: parsed.toString(),
        method: String(rest.method ?? "GET"),
        hasAuth: Object.keys(callerHeaders).some((k) => k.toLowerCase() === "authorization"),
        identityHeaders: Object.keys(contextHeaders).some((k) => k.toLowerCase() === "x-device-mid"),
        appVersionParam: parsed.searchParams.get("app_version"),
      };
      const bridge = (globalThis as { zcodeGitHttp?: Bridge }).zcodeGitHttp;
      const shell = globalThis as { zcodeFs?: unknown; zcodeSqlite?: unknown; zcodeDevice?: unknown };
      if (!hasNativeJobs(bridge)) {
        if (shell.zcodeFs || shell.zcodeSqlite || shell.zcodeDevice) {
          const error = "原生套餐用量网络桥不可用";
          recordPlanDiag({ at: Date.now(), ...diagBase, error });
          throw new Error(error);
        }
        const response = await fetch(parsed, { ...rest, headers: contextHeaders, signal });
        recordPlanDiag({
          at: Date.now(),
          ...diagBase,
          status: response.status,
          ...(await readBusinessSummary(response).catch(() => ({}))),
        });
        return response;
      }
      const request = new Request(parsed, { ...rest, headers: contextHeaders, signal });
      const body = request.body ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array();
      let result: Reply;
      try {
        result = (await callNativeJob(bridge, {
          url: request.url, method: request.method, headers: Object.fromEntries(request.headers.entries()),
          bodyBase64: encode(body), ...(timeoutMs ? { timeoutMs } : {}),
        }, request.signal)) as Reply;
      } catch (error) {
        recordPlanDiag({ at: Date.now(), ...diagBase, error: String((error as Error)?.message ?? error) });
        throw error;
      }
      if (result.error || typeof result.statusCode !== "number") {
        const error = `套餐用量网络请求失败：${result.error ?? "原生响应缺少状态"}`;
        recordPlanDiag({ at: Date.now(), ...diagBase, error });
        throw new Error(error);
      }
      const binary = atob(result.bodyBase64 ?? "");
      const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      const response = new Response([204, 205, 304].includes(result.statusCode) ? null : bytes, {
        status: result.statusCode, statusText: result.statusMessage ?? "", headers: result.headers,
      });
      recordPlanDiag({
        at: Date.now(),
        ...diagBase,
        status: result.statusCode,
        ...(await readBusinessSummary(response).catch(() => ({}))),
      });
      return response;
    },
  };
}

/** 读业务信封的 code/msg（套餐端点用 {"code":N,"msg":"..."} 形状）；不是 JSON 就跳过。 */
async function readBusinessSummary(response: Response): Promise<{ businessCode?: unknown; businessMsg?: string }> {
  try {
    const clone = response.clone();
    const body = (await clone.json()) as { code?: unknown; msg?: unknown };
    if (!body || typeof body !== "object") return {};
    return {
      ...(body.code !== undefined ? { businessCode: body.code } : {}),
      ...(typeof body.msg === "string" ? { businessMsg: body.msg } : {}),
    };
  } catch {
    return {};
  }
}
