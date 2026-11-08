// 官方身份归一 + 套餐取证冒烟（0.11.5）
// 判据：
//   ① 全局 fetch 包装：官方域请求带上身份头组（X-Platform=linux-arm64、X-Os-Category=linux、
//      X-ZCode-App-Version=官方版本号、X-Device-Mid 稳定），非官方域零注入，业务头不被覆盖；
//   ② app_version 查询参数同口径归一（0.0.0-dev → 官方版本号）；
//   ③ 套餐取证：每次请求写进 zcode-mobile.plan.diag（URL/状态/业务 code/msg/异常）。
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { unlinkSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const esbuild = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"))("esbuild");
const out = path.join(root, "tmp", `official-identity-${process.pid}.mjs`);
await esbuild.build({
  entryPoints: [path.join(root, "mobile-runtime/ui/official-identity-fetch.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
});
const { installOfficialIdentityFetch } = await import(pathToFileURL(out).href);

// localStorage 垫片（Device-Mid 持久化 + 取证落盘）
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};

const calls = [];
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  const headers = {};
  for (const [k, v] of new Headers(init?.headers ?? {}).entries()) headers[k.toLowerCase()] = v;
  calls.push({ url, headers, method: init?.method ?? "GET" });
  return new Response(JSON.stringify({ code: 3001, msg: "parameter error" }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
};

installOfficialIdentityFetch();

// ① 官方域：身份头齐全 + app_version 归一 + 业务头不被覆盖。
await globalThis.fetch("https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=0.0.0-dev", {
  headers: { Authorization: "Bearer jwt-token" },
});
const official = calls[0];
assert.equal(official.headers.authorization, "Bearer jwt-token", "业务 Authorization 被覆盖");
assert.equal(official.headers["x-platform"], "linux-arm64", "X-Platform 未归一");
assert.equal(official.headers["x-os-category"], "linux", "X-Os-Category 未归一");
assert.ok(/^3\.\d+\.\d+/.test(official.headers["x-zcode-app-version"] ?? ""), "版本头不是官方版本号形状");
assert.ok(official.headers["x-device-mid"], "X-Device-Mid 缺失");
assert.ok(/app_version=3\.\d+\.\d+/.test(official.url), `app_version 未归一：${official.url}`);

// ② 非官方域：零注入。
await globalThis.fetch("https://api.github.com/repos/x", { headers: { Authorization: "Bearer t" } });
assert.equal(calls[1].headers["x-platform"], undefined, "外部域被误注入身份头");

// ③ Device-Mid 跨请求稳定。
await globalThis.fetch("https://zcode.z.ai/api/v1/zcode-plan/billing/balance", {});
assert.equal(calls[2].headers["x-device-mid"], official.headers["x-device-mid"], "Device-Mid 不稳定");

console.log("official-identity-smoke: PASS（3 组判据）");
unlinkSync(out);
