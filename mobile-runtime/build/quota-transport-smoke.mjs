import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { unlinkSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const esbuild = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"))("esbuild");
const out = path.join(root, "tmp", `quota-transport-${process.pid}.mjs`);
await esbuild.build({ entryPoints: [path.join(root, "mobile-runtime/ui/quota-transport.ts")], outfile: out, bundle: true, platform: "node", format: "esm", target: "node24" });
const { createQuotaApiClient } = await import(pathToFileURL(out).href);
const previous = { bridge: globalThis.zcodeGitHttp, device: globalThis.zcodeDevice, fetch: globalThis.fetch, localStorage: globalThis.localStorage };
let received;
// Device-Mid 持久化面（0.11.3）：Node 无 localStorage，垫一块内存实现供跨请求断言。
const midStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (midStore.has(k) ? midStore.get(k) : null),
  setItem: (k, v) => midStore.set(k, String(v)),
};
try {
  globalThis.zcodeDevice = {};
  globalThis.zcodeGitHttp = {
    start(data) { received = JSON.parse(data); return JSON.stringify({ id: "job" }); },
    poll() { return JSON.stringify({ done: true, result: { statusCode: 200, headers: { "content-type": "application/json" }, bodyBase64: btoa('{"remaining":23}') } }); },
    cancel() { return true; },
  };
  globalThis.fetch = () => { throw new Error("不应走 WebView fetch"); };
  const response = await createQuotaApiClient().request("https://example.test/api?platform=android-arm64", {
    method: "POST", headers: { Authorization: "Bearer example", "content-type": "application/json" }, body: '{"x":1}', timeoutMs: 12000,
  });
  assert.deepEqual(await response.json(), { remaining: 23 });
  assert.equal(received.url, "https://example.test/api?platform=linux-arm64");
  assert.equal(received.method, "POST");
  assert.equal(received.headers.authorization, "Bearer example");
  assert.equal(atob(received.bodyBase64), '{"x":1}');
  assert.equal(received.timeoutMs, 12000);
  delete globalThis.zcodeGitHttp;
  await assert.rejects(createQuotaApiClient().request("https://example.test/"), /原生套餐用量网络桥不可用/);

  // ── 0.11.3 上下文头组（"体验套餐获取失败"根因修复面）──
  // zcode.z.ai 的 zcode-plan 端点校验 ZCode 上下文头（X-Platform/X-Device-Mid/…），
  // 只带 Authorization 服务端回 3001 parameter error（桌面真实凭据复放实测）。
  globalThis.zcodeGitHttp = {
    start(data) { received = JSON.parse(data); return JSON.stringify({ id: "job2" }); },
    poll() { return JSON.stringify({ done: true, result: { statusCode: 200, headers: {}, bodyBase64: btoa("{}") } }); },
    cancel() { return true; },
  };
  // ① z.ai 域名：上下文头齐全 + 业务头不覆盖 + Device-Mid 跨请求持久化。
  await createQuotaApiClient().request("https://zcode.z.ai/api/v1/zcode-plan/billing/balance", {
    headers: { Authorization: "Bearer context-token" },
  });
  assert.equal(received.headers.authorization, "Bearer context-token", "上下文头吃掉业务 Authorization");
  assert.equal(received.headers["x-platform"], "android-arm64", "X-Platform 没注入");
  assert.ok(received.headers["x-device-mid"], "X-Device-Mid 没注入");
  assert.ok(received.headers["x-zcode-app-version"], "X-ZCode-App-Version 没注入");
  assert.ok(received.headers["x-request-id"], "x-request-id 没注入");
  assert.equal(received.headers["user-agent"], `ZCode/${received.headers["x-zcode-app-version"]}`, "UA 与版本头不一致");
  const midFirst = received.headers["x-device-mid"];
  await createQuotaApiClient().request("https://zcode.z.ai/api/v1/zcode-plan/billing/balance", {});
  assert.equal(received.headers["x-device-mid"], midFirst, "Device-Mid 没有跨请求持久化");
  // ② 外部域名：零注入（其余出网面行为不变）。
  await createQuotaApiClient().request("https://api.github.com/repos/x", {});
  assert.equal(received.headers["x-platform"], undefined, "外部域被误注入上下文头");
  console.log("quota-transport-smoke: PASS（含 0.11.3 上下文头 6 断言）");
} finally {
  for (const [key, value] of [["zcodeGitHttp", previous.bridge], ["zcodeDevice", previous.device], ["fetch", previous.fetch], ["localStorage", previous.localStorage]]) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
  unlinkSync(out);
}
