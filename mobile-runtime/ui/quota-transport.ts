// 套餐额度接口由供应商提供，可能不支持 WebView 的跨域预检。
// Android 使用可取消的原生 HTTP 任务；浏览器开发环境继续使用标准 fetch。
import { callNativeJob, hasNativeJobs } from "../ports/native-async.mjs";
import type { MobileApiClient } from "./oauth.js";
import { rewritePlatformForServer } from "./server-compat.js";

type Bridge = { start(request: string): string; poll(id: string): string; cancel(id: string): boolean };
type Reply = { statusCode?: number; statusMessage?: string; headers?: Record<string, string>; bodyBase64?: string; error?: string };

function encode(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export function createQuotaApiClient(): MobileApiClient {
  return {
    async request(input, init = {}) {
      const { timeoutMs, ...rest } = init;
      const signal = timeoutMs
        ? rest.signal ? AbortSignal.any([rest.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
        : rest.signal;
      const url = rewritePlatformForServer(input);
      const bridge = (globalThis as { zcodeGitHttp?: Bridge }).zcodeGitHttp;
      const shell = globalThis as { zcodeFs?: unknown; zcodeSqlite?: unknown; zcodeDevice?: unknown };
      if (!hasNativeJobs(bridge)) {
        if (shell.zcodeFs || shell.zcodeSqlite || shell.zcodeDevice) throw new Error("原生套餐用量网络桥不可用");
        return fetch(url, { ...rest, signal });
      }
      const request = new Request(url, { ...rest, signal });
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
