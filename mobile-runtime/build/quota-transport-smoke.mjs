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
const previous = { bridge: globalThis.zcodeGitHttp, device: globalThis.zcodeDevice, fetch: globalThis.fetch };
let received;
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
  console.log("quota-transport-smoke: PASS");
} finally {
  for (const [key, value] of [["zcodeGitHttp", previous.bridge], ["zcodeDevice", previous.device], ["fetch", previous.fetch]]) {
    if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
  unlinkSync(out);
}
