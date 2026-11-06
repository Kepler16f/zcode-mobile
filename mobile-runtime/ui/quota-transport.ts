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
import { rewritePlatformForServer } from "./server-compat.js";

type Bridge = { start(request: string): string; poll(id: string): string; cancel(id: string): boolean };
type Reply = { statusCode?: number; statusMessage?: string; headers?: Record<string, string>; bodyBase64?: string; error?: string };

const DEVICE_MID_KEY = "zcode-mobile.deviceMid";
const CONTEXT_HOSTS = [".z.ai", ".bigmodel.cn"];

function encode(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function randomUUID(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  (c?.getRandomValues ?? ((b: Uint8Array) => b.forEach((_, i) => (b[i] = Math.floor(Math.random() * 256)))))(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 本机设备 Mid：首次生成后固定（localStorage），供 X-Device-Mid 计费头使用。 */
function deviceMid(): string {
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
 * ZCode 上下文头组（0.11.3）：zcode-plan/套餐端点的必验参数（缺失即 3001 parameter
 * error）。只对 z.ai / bigmodel.cn 域名注入；调用方显式给过的键不覆盖。
 */
export function zcodeContextHeaders(url: URL): Record<string, string> {
  if (!isContextHost(url)) return {};
  const version = appVersion();
  return {
    "User-Agent": `ZCode/${version}`,
    "HTTP-Referer": `${url.protocol}//${url.host}`,
    "X-Title": "Z Code@android",
    "X-ZCode-App-Version": version,
    "X-Platform": "android-arm64",
    "X-Release-Channel": "stable",
    "X-Client-Language": locale(),
    "X-Client-Timezone": timezone(),
    "X-Os-Category": "android",
    "X-Device-Mid": deviceMid(),
    "x-request-id": randomUUID(),
  };
}

function mergeContextHeaders(url: URL, headers: Record<string, string>): Record<string, string> {
  const context = zcodeContextHeaders(url);
  const merged: Record<string, string> = { ...context };
  for (const [key, value] of Object.entries(headers)) {
    // 调用方显式给的键优先（Authorization 等业务头绝不被上下文头覆盖）。
    const lower = key.toLowerCase();
    const contextKey = Object.keys(context).find((k) => k.toLowerCase() === lower);
    if (contextKey) delete merged[contextKey];
    merged[key] = value;
  }
  return merged;
}

export function createQuotaApiClient(): MobileApiClient {
  return {
    async request(input, init = {}) {
      const { timeoutMs, ...rest } = init;
      const signal = timeoutMs
        ? rest.signal ? AbortSignal.any([rest.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
        : rest.signal;
      const url = rewritePlatformForServer(input);
      const parsed = url instanceof URL ? url : new URL(url, globalThis.location?.href ?? "https://zcode.z.ai");
      const contextHeaders = mergeContextHeaders(parsed, Object.fromEntries(new Headers(rest.headers).entries()));
      const bridge = (globalThis as { zcodeGitHttp?: Bridge }).zcodeGitHttp;
      const shell = globalThis as { zcodeFs?: unknown; zcodeSqlite?: unknown; zcodeDevice?: unknown };
      if (!hasNativeJobs(bridge)) {
        if (shell.zcodeFs || shell.zcodeSqlite || shell.zcodeDevice) throw new Error("原生套餐用量网络桥不可用");
        return fetch(parsed, { ...rest, headers: contextHeaders, signal });
      }
      const request = new Request(parsed, { ...rest, headers: contextHeaders, signal });
      const body = request.body ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array();
      const result = await callNativeJob(bridge, {
        url: request.url, method: request.method, headers: Object.fromEntries(request.headers.entries()),
        bodyBase64: encode(body), ...(timeoutMs ? { timeoutMs } : {}),
      }, request.signal) as Reply;
      if (result.error || typeof result.statusCode !== "number") throw new Error(`套餐用量网络请求失败：${result.error ?? "原生响应缺少状态"}`);
      const binary = atob(result.bodyBase64 ?? "");
      const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      return new Response([204, 205, 304].includes(result.statusCode) ? null : bytes, {
        status: result.statusCode, statusText: result.statusMessage ?? "", headers: result.headers,
      });
    },
  };
}
