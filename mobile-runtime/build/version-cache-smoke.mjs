import assert from "node:assert/strict";
import { readFileSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 判据不变（多次读只打一次原生桥 / 换桥要重读 / 没桥读成 null），
// 只是被测模块搬了家：版本号那一行 0.11.x 从端侧侧栏小字 chip 搬到了上游设置页
// （packages/ui/src/settings/appVersionUpdateRow.tsx），读版本的那段缓存逻辑
// 也跟着搬到了上游的桥口 packages/ui/src/settings/mobileAppBridge.ts。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = path.join(root, "zcode/packages/ui/src/settings/mobileAppBridge.ts");
const output = path.join(root, "tmp", `version-cache-${process.pid}.mjs`);
const esbuild = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"))("esbuild");
await esbuild.build({ stdin: { contents: readFileSync(source, "utf8"), sourcefile: source, loader: "ts" }, outfile: output, bundle: true, format: "esm", platform: "node" });
try {
  const { readAppVersionInfo } = await import(pathToFileURL(output).href);
  let calls = 0;
  globalThis.zcodeDevice = { deviceInfo() { calls++; return JSON.stringify({ appVersion: "0.8.4", appVersionCode: 8004 }); } };
  for (let i = 0; i < 100; i++) assert.deepEqual(readAppVersionInfo(), { version: "0.8.4", versionCode: 8004 });
  assert.equal(calls, 1, "多次页面更新不应反复同步访问版本桥");
  globalThis.zcodeDevice = { deviceInfo() { calls++; return JSON.stringify({ appVersion: "0.8.5" }); } };
  assert.deepEqual(readAppVersionInfo(), { version: "0.8.5", versionCode: null });
  assert.equal(calls, 2, "桥替换后应重新读取版本");
  delete globalThis.zcodeDevice;
  assert.equal(readAppVersionInfo(), null);
  console.log("version-cache-smoke: PASS");
} finally {
  delete globalThis.zcodeDevice;
  unlinkSync(output);
}
