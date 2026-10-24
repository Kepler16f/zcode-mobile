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

export function rewritePlatformForServer(input: string | URL): string | URL {
  try {
    const url = typeof input === "string" ? new URL(input, globalThis.location?.href ?? "https://zcode.z.ai") : new URL(input.href);
    const platform = url.searchParams.get("platform");
    // 判据收紧成"整个值就是 android，或 android-<arch>"：上游的取值永远是 `${platform}-${arch}`
    // （process 垫片报 android/arm64），而裸 startsWith("android") 会把 androidology 这种
    // 不相干的值也改写掉——冒烟里那条判据抓的就是它。
    if (!platform || (platform !== "android" && !platform.startsWith("android-"))) return input;
    // x64 的模拟器宿主（android-x64/android-x86_64）落到 linux-x64；真机 arm 族落到 linux-arm64。
    const mapped = /x64|x86_64/i.test(platform) ? "linux-x64" : "linux-arm64";
    url.searchParams.set("platform", mapped);
    return url;
  } catch {
    return input;
  }
}
