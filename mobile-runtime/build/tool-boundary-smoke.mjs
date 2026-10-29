// 验证真实 core executor 对文件端口错误的投影，确保 Agent 能弹出路径授权。
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const esbuild = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"))("esbuild");
const output = path.join(root, "mobile-runtime/build", `.tmp-tool-boundary-${process.pid}.mjs`);
await esbuild.build({
  stdin: {
    contents: `export {createToolEngineFactory} from "${path.join(root, "mobile-runtime/ui/tool-engine.ts").replaceAll("\\", "/")}";
export {createMobileFileSystemPort} from "${path.join(root, "mobile-runtime/ports/file-system.mjs").replaceAll("\\", "/")}";
export * as core from "${path.join(root, "mobile-runtime/build/dist/zcode-core.mobile.js").replaceAll("\\", "/")}";`,
    resolveDir: root,
  },
  alias: { typescript: path.join(root, "mobile-runtime/build/dist/shims/typescript-stub.js") },
  outfile: output,
  bundle: true, format: "esm", platform: "node", target: "node24", logLevel: "warning",
});
try {
  const { createToolEngineFactory, createMobileFileSystemPort, core } = await import(pathToFileURL(output).href);
  core.vfs.setFsEngine("memory");
  core.vfs.mkdir("/work/a", { recursive: true });
  globalThis.zcodeGitHttp = { call() { throw new Error("越权下载不得发起网络请求"); } };
  const engine = await createToolEngineFactory({ loadCore: async () => core, bashEnabled: false })("/work/a");
  assert.ok(engine, "工具引擎应装配成功");
  const result = await engine.execute({ id: "fetch-denied", name: "Fetch", arguments: JSON.stringify({ action: "download", url: "https://example.invalid", path: "../b/file.txt" }) });
  assert.equal(result.isError, true);
  assert.equal(result.errorCode, "permission_denied");
  assert.match(result.errorMessage, /路径越出授权工作区.*\/work\/b\/file\.txt/);
  core.vfs.mkdir("/work/b", { recursive: true });
  core.vfs.writeFile("/work/b/secret.txt", "other workspace");
  const factory = createToolEngineFactory({ loadCore: async () => ({ ...core, createMobileFileSystemPort }), bashEnabled: false });
  const first = await factory("/work/a", "session-one");
  const second = await factory("/work/a", "session-two");
  assert.notEqual(first, second, "每个会话须有独立授权状态");
  assert.equal(await factory("/work/a", "session-one"), first, "同一会话复用其授权状态");
  first.grantRoot("/work/b/secret.txt");
  const download = { id: "download-secret", name: "Fetch", arguments: '{"action":"download","url":"https://example.invalid","path":"/work/b/secret.txt"}' };
  const allowed = await first.execute(download);
  assert.notEqual(allowed.errorCode, "permission_denied", "用户批准的会话应通过文件路径授权检查");
  assert.equal((await second.execute(download)).errorCode, "permission_denied", "其他会话不能继承授权");
  let writebacks = 0;
  const stage = {
    mountOf: () => "/mnt/stage",
    ensureStaging: async () => ({ files: 1, dirs: 1, skipped: 0 }),
    snapshotStaging: () => new Map([["file", { kind: "file", mtimeMs: 0, size: 1 }]]),
    writeBackStaging: async () => { writebacks++; return { written: 0, deleted: 0, failed: 1, errors: ["模拟回写失败"] }; },
  };
  globalThis.zcodeExec = { exec() { return "{}"; } };
  const stageCore = {
    ...core,
    vfs: { ...core.vfs, stage },
    createNativeExecBridge: () => ({}),
    createMobileExecutionPort: () => ({}),
    createToolExecutor: () => ({ execute: async () => ({ error: { code: "mock.failure", message: "命令失败" } }) }),
  };
  const stageEngine = await createToolEngineFactory({ loadCore: async () => stageCore })("/mnt/stage");
  assert.ok(stageEngine, "SAF 工具引擎应装配成功");
  const failed = await stageEngine.execute({ id: "bash-failed", name: "Bash", arguments: '{"command":"false"}' });
  assert.equal(writebacks, 0, "不完整的 SAF 镜像不得执行命令或回写");
  assert.equal(failed.errorCode, "mobile.safBashUnsafe");
  console.log("tool-boundary-smoke: PASS");
} finally {
  delete globalThis.zcodeGitHttp;
  delete globalThis.zcodeExec;
  unlinkSync(output);
}
