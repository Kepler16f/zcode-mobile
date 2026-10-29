import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const esbuild = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"))("esbuild");
const output = path.join(root, "mobile-runtime/build", `.tmp-platform-${process.pid}.mjs`);
await esbuild.build({
  stdin: { contents: `export { createMobilePlatform } from "${path.join(root, "mobile-runtime/ui/platform.ts").replaceAll("\\", "/")}";\nexport * as vfs from "${path.join(root, "mobile-runtime/compat/vfs.mjs").replaceAll("\\", "/")}";`, resolveDir: root },
  outfile: output, bundle: true, format: "esm", platform: "node", target: "node24", logLevel: "warning",
  nodePaths: [path.join(root, "zcode/node_modules")],
});
try {
  const { createMobilePlatform, vfs } = await import(pathToFileURL(output).href);
  vfs.setFsEngine("memory");
  vfs.mkdir("/work/one", { recursive: true });
  vfs.mkdir("/work/two", { recursive: true });
  let requestId;
  let calls = 0;
  globalThis.zcodeWorkspace = { pickDirectory(id) { requestId = id; calls++; return JSON.stringify({ started: true }); } };
  const platform = createMobilePlatform();
  const first = platform.selectDirectory();
  const concurrent = platform.selectDirectory();
  assert.equal(calls, 1, "并发选择应共用同一请求");
  globalThis.__zcodeWorkspacePicked("/work/two", "old-id");
  globalThis.__zcodeWorkspacePicked("/work/one", requestId);
  assert.equal(await first, "/work/one");
  assert.equal(await concurrent, "/work/one");
  const next = platform.selectDirectory();
  assert.equal(calls, 2);
  globalThis.__zcodeWorkspacePicked(null, requestId);
  assert.equal(await next, null);
  const attachment = await platform.createTempTextAttachment({ text: "Hello", filename: "test.txt", workspacePath: "/work/two" });
  assert.match(attachment.localPath, /^\/work\/two\/\.zcode\/attachments\//);
  assert.equal(vfs.readFileSync(attachment.localPath, "utf8"), "Hello");
  assert.equal(attachment.sizeBytes, 5);
  await assert.rejects(platform.createTempTextAttachment({ text: "x" }), /未指定附件所属工作区/);
  console.log("platform-workspace-smoke: PASS");
} finally {
  delete globalThis.zcodeWorkspace;
  delete globalThis.__zcodeWorkspacePicked;
  unlinkSync(output);
}
