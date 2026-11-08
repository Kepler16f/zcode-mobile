// 全局 fetch 身份归一（0.11.5）
//
// 为什么不是"给某一个客户端注入头"：官方域（zcode.z.ai / api.z.ai / bigmodel.cn）会校验
// 一组 ZCode 客户端身份头（X-Platform / X-ZCode-App-Version / X-Os-Category / X-Device-Mid …），
// 缺失或不像官方客户端就回 400 {"code":3001,"msg":"parameter error"}。这组头必须在**每一个**
// 官方请求上都在——上游代码里既有走 ApiClient 的，也有直接 fetch 的（OAuth 兑换、provider
// runtime 的 client/configs、套餐预览…）。参考实现（HarmonyOS 移植层 ohos-identity.cjs）就是
// 在全局 fetch 上一层做归一，官方域的每个请求都受益。
//
// 端侧口径与它一致（且与池子 Rust 客户端一致）：
//   x-platform: linux-arm64（Android 内核就是 Linux；自报 android-arm64 是"非官方客户端"信号）
//   x-os-category: linux、x-os-version: Linux 内核串
//   x-zcode-app-version / user-agent: 官方发行版本号（可用
//   localStorage["zcode-mobile.desktopCompatibilityVersion"] 覆盖，缺省 3.17.2）
//   app_version 查询参数同口径归一
//
// 纪律：只在官方域生效；调用方显式给的同名头不被覆盖；包装失败一律放行原 fetch（不弄挂启动）。
import { officialIdentityRequest } from "./quota-transport.js";

const OFFICIAL_HOST_SUFFIXES = [".z.ai", ".bigmodel.cn", ".bigmodel.com.cn"];

function isOfficial(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return OFFICIAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

let installed = false;

export function installOfficialIdentityFetch(): void {
  if (installed) return;
  const original = globalThis.fetch;
  if (typeof original !== "function") return;
  installed = true;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), globalThis.location?.href);
      if (!isOfficial(url)) return await original(input, init);
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      // officialIdentityRequest 返回归一后的 URL（app_version 查询参数）与合并后的头。
      const normalized = officialIdentityRequest(url, Object.fromEntries(headers.entries()));
      return await original(normalized.url, { ...init, headers: normalized.headers });
    } catch {
      // 归一任何一步出错都放行原请求：身份头是"让服务端认得我们"，不是功能前提。
      return await original(input, init);
    }
  }) as typeof globalThis.fetch;
}
