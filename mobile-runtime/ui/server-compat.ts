// 端侧出网的"服务端兼容"改写：被 ui/oauth.ts 的 fetch ApiClient 调用，别处不经过。
//
// 为什么必须在端侧改：体验套餐与套餐列表都走 GET /api/v1/client/configs?platform=<os>-<arch>，
// 服务端按这个平台键过滤下发。实测（2026-10-07）：`platform=android-arm64` 被直接拒
// `{"code":3001,"msg":"parameter error"}`，而 `linux-arm64`/`win32-arm64` 正常返回、
// `data.configs.startPlanPreview` 齐全——服务端白名单根本没有 android 这一族。
// 上游 provider 用 `process.platform-arch` 生成这个键，而端侧的 process 垫片**如实报 android**
// （ExecutionPort/Bash 的语义要用真值），所以两边都不能动，只在出网这一条口子上把
// "服务端没有的键"换成语义最近的已支持键：Android 内核就是 Linux，arch 原样继承。
//
// 只改写带 platform 参数且值以 android 开头的 URL（client/configs 是唯一的此类请求）；
// 其余 OAuth/payment/企业定价请求原样放行。解析失败也原样放行——那是 fetch 自己该报的错，
// 不该由这里吞掉或改写。

export const DESKTOP_COMPATIBILITY_VERSION_KEY = "zcode-mobile.desktopCompatibilityVersion";
/**
 * 兜底用官方发行版本号（CI/无官方安装的机器上 define 缺席时才生效）。**不要在这里跟随
 * 上游**——0.12.6（用户点名"ZCode/3.18.2 这种不要写死，很可能要跟随上游更新"）起，
 * 真值由构建期 official-version.mjs 从本机官方安装包实挖（官方壳主进程同样写死版本并
 * 经 env 传给 CLI，"壳带版本"就是官方自己的形状），经 `__ZCODE_VERSION__` define 注入。
 */
export const OFFICIAL_COMPAT_VERSION = "3.18.2";
/**
 * 官方桌面 CLI 模型请求的 ai-sdk/anthropic UA 版本兜底（同上，构建期实挖经
 * `__ZCODE_AI_SDK_ANTHROPIC_VERSION__` 注入）。官方模型请求的 UA 是上下文层与 SDK 层
 * **空格拼接**：`ZCode/3.18.2 ai-sdk/anthropic/3.0.81`（官方 UO() 把已有 user-agent 与
 * SDK UA join）。zcode-plan 网关 405 "This client is not supported" 的判定若看 UA，
 * 差这个后缀就是差异点。
 */
export const OFFICIAL_AI_SDK_ANTHROPIC_VERSION = "3.0.81";

/** 用户覆盖优先，其次构建期实挖值（跟随上游），写死常量只在 define 缺席时兜底。 */
export function officialCompatibilityVersion(): string {
  try {
    const v = globalThis.localStorage?.getItem(DESKTOP_COMPATIBILITY_VERSION_KEY)?.trim();
    if (v && /^\d+\.\d+\.\d+/.test(v)) return v;
  } catch { /* localStorage 不可用走缺省 */ }
  // typeof 守卫：esbuild 只在注入了 define 的 bundle 里替换该标识符；Node harness
  // 直跑源码时它未声明，typeof 对未声明变量安全返回 "undefined"（不抛 ReferenceError）。
  if (typeof __ZCODE_VERSION__ !== "undefined" && /^\d+\.\d+\.\d+/.test(__ZCODE_VERSION__)) {
    return __ZCODE_VERSION__;
  }
  return OFFICIAL_COMPAT_VERSION;
}

/** ai-sdk/anthropic 的 UA 版本：优先构建期实挖，写死常量兜底（口径同上）。 */
export function officialAiSdkAnthropicVersion(): string {
  if (
    typeof __ZCODE_AI_SDK_ANTHROPIC_VERSION__ !== "undefined" &&
    /^\d+\.\d+\.\d+/.test(__ZCODE_AI_SDK_ANTHROPIC_VERSION__)
  ) {
    return __ZCODE_AI_SDK_ANTHROPIC_VERSION__;
  }
  return OFFICIAL_AI_SDK_ANTHROPIC_VERSION;
}
export function desktopCompatibilityVersion(fallback: string): string {
  try {return globalThis.localStorage?.getItem(DESKTOP_COMPATIBILITY_VERSION_KEY)?.trim() || fallback;} catch {return fallback;}
}
export function setDesktopCompatibilityVersion(version: string): void {
  if (version && !/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:[-+][\w.-]+)?$/.test(version)) throw new Error("版本号格式无效，例如3.0.0");
  if (version) globalThis.localStorage.setItem(DESKTOP_COMPATIBILITY_VERSION_KEY,version);
  else globalThis.localStorage.removeItem(DESKTOP_COMPATIBILITY_VERSION_KEY);
}
export function rewritePlatformForServer(input: string | URL): string | URL {
  try {
    const url = typeof input === "string" ? new URL(input, globalThis.location?.href ?? "https://zcode.z.ai") : new URL(input.href);
    const platform = url.searchParams.get("platform");
    let changed = false;
    const compatVersion = desktopCompatibilityVersion("");
    if (compatVersion && url.searchParams.has("app_version") &&
        (url.hostname.endsWith(".z.ai") || url.hostname.endsWith(".bigmodel.cn"))) {
      url.searchParams.set("app_version",compatVersion);changed=true;
    }
    // 判据收紧成"整个值就是 android，或 android-<arch>"：上游的取值永远是 `${platform}-${arch}`
    // （process 垫片报 android/arm64），而裸 startsWith("android") 会把 androidology 这种
    // 不相干的值也改写掉——冒烟里那条判据抓的就是它。
    if (!platform || (platform !== "android" && !platform.startsWith("android-"))) return changed ? url : input;
    // x64 的模拟器宿主（android-x64/android-x86_64）落到 linux-x64；真机 arm 族落到 linux-arm64。
    const mapped = /x64|x86_64/i.test(platform) ? "linux-x64" : "linux-arm64";
    url.searchParams.set("platform", mapped);
    return url;
  } catch {
    return input;
  }
}
