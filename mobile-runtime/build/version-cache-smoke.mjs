import assert from "node:assert/strict";
import { readFileSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = path.join(root, "mobile-runtime/ui/web-mobile-shell.ts");
const output = path.join(root, "tmp", `version-cache-${process.pid}.mjs`);
const esbuild = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"))("esbuild");
await esbuild.build({ stdin: { contents: `${readFileSync(source, "utf8")}\nexport { readAppVersion };`, sourcefile: source, loader: "ts" }, outfile: output, bundle: true, format: "esm", platform: "node" });
try {
  const { readAppVersion } = await import(pathToFileURL(output).href);
  let calls = 0;
  globalThis.zcodeDevice = { deviceInfo() { calls++; return JSON.stringify({ appVersion: "0.8.4", appVersionCode: 8004 }); } };
  for (let i = 0; i < 100; i++) assert.equal(readAppVersion(), "aZCode 0.8.4 (8004)");
  assert.equal(calls, 1, "多次页面更新不应反复同步访问版本桥");
  globalThis.zcodeDevice = { deviceInfo() { calls++; return JSON.stringify({ appVersion: "0.8.5" }); } };
  assert.equal(readAppVersion(), "aZCode 0.8.5");
  assert.equal(calls, 2, "桥替换后应重新读取版本");
  delete globalThis.zcodeDevice;
  assert.equal(readAppVersion(), null);
  console.log("version-cache-smoke: PASS");
} finally {
  delete globalThis.zcodeDevice;
  unlinkSync(output);
}
