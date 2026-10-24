// server-compat.ts 的契约冒烟：platform 改写的判据来自 2026-10-07 的实测记录——
// 服务端对 android-* 回 {"code":3001,"msg":"parameter error"}，对 linux-arm64 回 code:0
// 且 data.configs.startPlanPreview 齐全。改写的边界：只动带 platform 参数且值以 android 开头的。
import { rewritePlatformForServer } from "../ui/server-compat.ts";

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, why: String(e?.message ?? e) });
  }
};

const q = (out) => {
  if (typeof out === "string") return new URL(out).searchParams;
  return out.searchParams;
};

check("android-arm64 → linux-arm64（真机主路径）", () => {
  const out = rewritePlatformForServer("https://zcode.z.ai/api/v1/client/configs?app_version=3.14.3&platform=android-arm64");
  const p = q(out).get("platform");
  if (p !== "linux-arm64") throw new Error(`得到 ${p}`);
});

check("android-x64 → linux-x64（模拟器宿主）", () => {
  const out = rewritePlatformForServer("https://zcode.z.ai/api/v1/client/configs?platform=android-x64");
  const p = q(out).get("platform");
  if (p !== "linux-x64") throw new Error(`得到 ${p}`);
});

check("android-arm → linux-arm64（armeabi 宿主：android 开头一律映射到 arm64 族）", () => {
  const out = rewritePlatformForServer("https://zcode.z.ai/api/v1/client/configs?platform=android-arm");
  if (q(out).get("platform") !== "linux-arm64") throw new Error("未映射");
});

check("其余参数原样保留（app_version 不能被改写吞掉）", () => {
  const out = rewritePlatformForServer("https://zcode.z.ai/api/v1/client/configs?app_version=0.3.6&platform=android-arm64");
  const sp = q(out);
  if (sp.get("app_version") !== "0.3.6") throw new Error(`app_version=${sp.get("app_version")}`);
});

check("URL 对象入参也认（上游传的是 URL）", () => {
  const out = rewritePlatformForServer(new URL("https://zcode.z.ai/api/v1/client/configs?platform=android-arm64"));
  if (q(out).get("platform") !== "linux-arm64") throw new Error("URL 入参没改写");
});

// 不改写的三种：没有 platform；platform 不是 android族；解析不了的怪值原样交回 fetch。
check("不带 platform 的请求原样放行（OAuth 那族）", () => {
  const src = "https://zcode.z.ai/api/v1/oauth/cli/init";
  if (rewritePlatformForServer(src) !== src) throw new Error("被动过了");
});

check("platform=linux-arm64（已是支持的键）不动", () => {
  const src = "https://x/api?platform=linux-arm64";
  const out = rewritePlatformForServer(src);
  if (q(out).get("platform") !== "linux-arm64") throw new Error("被重复映射");
});

check("platform=androidology 这种前缀撞车的值不误伤（要整个值以 android 开头才算）", () => {
  const src = "https://x/api?platform=androidology";
  const out = rewritePlatformForServer(src);
  if (q(out).get("platform") !== "androidology") throw new Error("误改写");
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  process.stdout.write(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  → ${r.why}`}\n`);
}
process.stdout.write(`\n出网 platform 改写冒烟：${results.length - failed.length}/${results.length} PASS\n`);
process.exitCode = failed.length > 0 ? 1 : 0;
