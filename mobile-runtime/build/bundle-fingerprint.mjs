// 构建指纹同时覆盖输入和打包结果；Gradle 复制资产前必须复核。
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const stamp = path.join(root, "mobile-runtime/build/.mobile-build-fingerprint.json");
const inputRoots = [
  "mobile-runtime/ui", "mobile-runtime/compat", "mobile-runtime/ports", "mobile-runtime/vendor",
  "zcode/packages/ui/src", "zcode/packages/web/src", "zcode/packages/web/public",
  "zcode/packages/shared/src", "zcode/packages/rpc/src", "zcode/packages/client/src",
  "zcode/packages/services/src", "zcode/packages/provider/src", "zcode/packages/provider-node/src",
  "zcode/apps/zcode-cli/packages",
];
const inputFiles = [
  "mobile-runtime/build/bundle-ui.mjs", "mobile-runtime/build/bundle.mjs", "mobile-runtime/build/entry.mjs",
  "mobile-runtime/build/bundle-fingerprint.mjs", "mobile-runtime/build/gen-toybox-registry.mjs",
  "mobile-runtime/build/build-mobile.mjs", "mobile-runtime/build/rebind-dark.mjs",
  "mobile-runtime/build/mobile-ui-assets.mjs",
  "mobile-runtime/package-lock.json", "zcode/pnpm-lock.yaml", "zcode/package.json",
  "zcode/apps/zcode-cli/pnpm-lock.yaml",
  "zcode/config/provider/zcode-builtin.json", "zcode/scripts/builtin-provider-config.mjs",
];
const outputRoots = ["mobile-runtime/build/dist-ui", "mobile-runtime/build/dist"];
function collect(relative, out, cliPackages = false) {
  const absolute = path.join(root, relative);
  const stat = statSync(absolute, { throwIfNoEntry: false });
  if (!stat) throw new Error(`构建指纹缺少文件：${relative}`);
  if (stat.isFile()) { out.push(relative.replaceAll("\\", "/")); return; }
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || ["node_modules", "dist", "build", ".git", ".turbo"].includes(entry.name)) continue;
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) collect(child, out, cliPackages);
    else if (entry.isFile()) out.push(child.replaceAll("\\", "/"));
  }
}
function digest(paths) {
  const hash = createHash("sha256");
  for (const relative of [...new Set(paths)].sort()) {
    const bytes = readFileSync(path.join(root, relative));
    hash.update(relative).update("\0").update(String(bytes.length)).update("\0").update(bytes);
  }
  return hash.digest("hex");
}
function calculate() {
  const inputs = [...inputFiles];
  const outputs = [];
  for (const entry of inputRoots) collect(entry, inputs);
  for (const entry of outputRoots) collect(entry, outputs);
  if (!outputs.some(p => p.endsWith("/dist-ui/entry.js")) || !outputs.some(p => p.endsWith("/dist-ui/zcode-ui.css")) ||
      !outputs.some(p => p.endsWith("/dist/zcode-core.mobile.js"))) throw new Error("移动端构建产物不完整");
  return { version: 1, environment: process.env.ZCODE_ENV?.trim().toLowerCase() || "production", inputs: digest(inputs), outputs: digest(outputs) };
}
const mode = process.argv[2];
if (mode === "write") {
  writeFileSync(stamp, JSON.stringify(calculate()) + "\n");
  console.log("移动端源码与 bundle 指纹已记录");
} else if (mode === "check") {
  let expected;
  try { expected = JSON.parse(readFileSync(stamp, "utf8")); }
  catch { throw new Error("缺少移动端构建指纹；请先执行 node mobile-runtime/build/build-mobile.mjs"); }
  const actual = calculate();
  if (expected.version !== actual.version || expected.environment !== actual.environment || expected.inputs !== actual.inputs || expected.outputs !== actual.outputs) {
    throw new Error("移动端源码或 bundle 已变化；请先重新执行 node mobile-runtime/build/build-mobile.mjs");
  }
  console.log("移动端源码与 bundle 指纹一致");
} else {
  throw new Error("用法：node bundle-fingerprint.mjs write|check");
}
