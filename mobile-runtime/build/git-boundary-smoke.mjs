import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"));
const git = createRequire(path.join(root, "mobile-runtime/package.json"))("isomorphic-git");
const out = path.join(root, "mobile-runtime/build", `.tmp-git-boundary-${process.pid}.mjs`);
await require("esbuild").build({ stdin: { contents: `export {createMobileGitService} from "./git-service.ts"; export {runGitAction,makeGitTool} from "./git-tool.ts"; export {scopedGitFs} from "./git-path.ts";`, resolveDir: path.join(root, "mobile-runtime/ui") }, outfile: out, bundle: true, format: "esm", platform: "node", target: "node24", logLevel: "warning" });
fs.mkdirSync(path.join(root, "tmp"), { recursive: true });
const dir = fs.mkdtempSync(path.join(root, "tmp/git-boundary-")).replaceAll("\\", "/");
const outside = fs.mkdtempSync(path.join(root, "tmp/git-outside-")).replaceAll("\\", "/");
try {
  const { createMobileGitService, runGitAction, makeGitTool, scopedGitFs } = await import(pathToFileURL(out).href);
  const action = (name, input = {}) => runGitAction(git, fs, dir, name, input);
  await git.init({ fs, dir, defaultBranch: "main" });
  fs.writeFileSync(`${dir}/file with space.txt`, "first\n");
  fs.writeFileSync(`${dir}/deleted.txt`, "delete me\n");
  await action("add", { path: "." });
  await git.commit({ fs, dir, message: "initial", author: { name: "Test", email: "test@example.invalid" } });
  const stat = fs.statSync(`${dir}/file with space.txt`);
  fs.writeFileSync(`${dir}/file with space.txt`, "other\n");
  fs.utimesSync(`${dir}/file with space.txt`, stat.atime, stat.mtime);
  assert.match(await action("status"), /file with space\.txt.*未暂存修改/);
  await action("add", { path: "file with space.txt" });
  assert.match(await action("status"), /file with space\.txt.*暂存修改/);
  fs.unlinkSync(`${dir}/deleted.txt`);
  await action("add", { path: "." });
  assert.match(await action("status"), /deleted\.txt.*暂存删除/);
  const before = fs.readFileSync(`${dir}/.git/index`);
  await assert.rejects(action("add", { paths: ["file with space.txt", "../outside"] }), /越出/);
  assert.deepEqual(fs.readFileSync(`${dir}/.git/index`), before);
  await assert.rejects(action("add", { path: ".git/config" }), /路径/);
  const scoped = scopedGitFs(fs, dir);
  await assert.rejects(scoped.promises.writeFile(`${outside}/outside.txt`, "bad"), /越出/);
  fs.mkdirSync(`${dir}/nonempty`);
  fs.writeFileSync(`${dir}/nonempty/keep.txt`, "keep");
  await assert.rejects(action("clone", { url: "https://example.invalid/repo", dir: "nonempty" }), /非空/);
  assert.equal(fs.readFileSync(`${dir}/nonempty/keep.txt`, "utf8"), "keep");
  try {
    fs.symlinkSync(outside, `${dir}/escape`, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(scoped.promises.writeFile(`${dir}/escape/outside.txt`, "bad"), /符号链接/);
    assert.equal(fs.existsSync(`${outside}/outside.txt`), false);
    fs.unlinkSync(`${dir}/escape`);
  } catch (error) {
    if (!["EPERM", "EACCES"].includes(error?.code)) throw error;
    console.log("symlink test skipped: host denied symlink creation");
  }
  const linkedRepo = fs.mkdtempSync(path.join(root, "tmp/git-linked-")).replaceAll("\\", "/");
  try {
    fs.symlinkSync(`${dir}/.git`, `${linkedRepo}/.git`, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(runGitAction(git, fs, linkedRepo, "status", {}), /符号链接/);
  } catch (error) {
    if (!["EPERM", "EACCES"].includes(error?.code)) throw error;
    console.log(".git symlink test skipped: host denied symlink creation");
  }
  const denied = { ...git, currentBranch: async () => "main", push: async () => ({ ok: false }) };
  await assert.rejects(runGitAction(denied, fs, dir, "push", {}), /拒绝/);
  const remote = { ...git, listRemotes: async () => [{ remote: "origin", url: "https://user:secret@example.com/repo" }] };
  const shown = await runGitAction(remote, fs, dir, "remote", {});
  assert.doesNotMatch(shown, /secret|user@/);
  assert.doesNotMatch(fs.readFileSync(`${dir}/.git/config`, "utf8"), /secret|user@/);
  await action("remote", { remote: "private", url: "https://user:secret@example.com/repo", force: true });
  assert.equal(await git.getConfig({ fs, dir, path: "remote.private.url" }), "https://example.com/repo");
  await assert.rejects(action("remote", { url: "https://example.com/repo?token=secret" }), /查询参数/);
  await git.setConfig({ fs, dir, path: "remote.private.url", value: "https://user:secret@example.com/repo" });
  const displayed = await action("remote");
  assert.doesNotMatch(displayed, /secret/);
  assert.equal(await git.getConfig({ fs, dir, path: "remote.private.url" }), "https://user:secret@example.com/repo", "查看远端不得删除已有凭据");
  let usedAuth;
  const authenticated = { ...git, currentBranch: async () => "main", push: async options => { usedAuth = options.onAuth(options.url); return { ok: true }; } };
  await runGitAction(authenticated, fs, dir, "push", { remote: "private" });
  assert.deepEqual(usedAuth, { username: "user", password: "secret" });
  assert.equal(await git.getConfig({ fs, dir, path: "remote.private.url" }), "https://user:secret@example.com/repo", "网络操作不得改写已有凭据");
  let clonedUrl, cloneAuth;
  const cloned = { ...git, clone: async options => { clonedUrl = options.url; cloneAuth = options.onAuth(options.url); }, listBranches: async () => [] };
  const cloneOutput = await runGitAction(cloned, fs, dir, "clone", { url: "https://name:p%40ss@example.com/repo", dir: "cloned" });
  assert.equal(clonedUrl, "https://example.com/repo");
  assert.deepEqual(cloneAuth, { username: "name", password: "p@ss" });
  assert.doesNotMatch(cloneOutput, /p%40ss|p@ss/);
  const failedAuth = { ...git, fetch: async () => { throw new Error("Server echoed sensitive-token"); } };
  await assert.rejects(runGitAction(failedAuth, fs, dir, "fetch", { remote: "private", username: "user", password: "sensitive-token" }), error => !String(error).includes("sensitive-token"));
  globalThis.git = git;
  const unsupported = makeGitTool(dir, fs, { ensure: async () => {}, snapshot: () => ({}), writeBack: async () => ({ failed: 0, errors: [] }) });
  await assert.rejects(unsupported.handler({ action: "status" }), /并发安全/);
  const tool = makeGitTool(dir, fs, { transactionSafe: true, ensure: async () => {}, snapshot: () => ({}), writeBack: async () => ({ failed: 1, errors: ["denied"] }) });
  await assert.rejects(tool.handler({ action: "status" }), /回写失败/);
  const incomplete = makeGitTool(dir, fs, { transactionSafe: true, ensure: async () => ({ skipped: 1 }), snapshot: () => ({}), writeBack: async () => ({ failed: 0, errors: [] }) });
  await assert.rejects(incomplete.handler({ action: "status" }), /镜像不完整/);

  // 由系统 Git 建立真正的多阶段索引，确认冲突不会被当成普通暂存文件。
  const mergeDir = fs.mkdtempSync(path.join(root, "tmp/git-conflict-")).replaceAll("\\", "/");
  const cmd = (...args) => spawnSync("git", args, { cwd: mergeDir, encoding: "utf8", windowsHide: true });
  assert.equal(cmd("init", "-b", "main").status, 0);
  assert.equal(cmd("config", "user.name", "Test").status, 0);
  assert.equal(cmd("config", "user.email", "test@example.invalid").status, 0);
  fs.writeFileSync(`${mergeDir}/conflict.txt`, "base\n");
  assert.equal(cmd("add", ".").status, 0);
  assert.equal(cmd("commit", "-m", "base").status, 0);
  assert.equal(cmd("checkout", "-b", "feature").status, 0);
  fs.writeFileSync(`${mergeDir}/conflict.txt`, "feature\n");
  assert.equal(cmd("commit", "-am", "feature").status, 0);
  assert.equal(cmd("checkout", "main").status, 0);
  fs.writeFileSync(`${mergeDir}/conflict.txt`, "main\n");
  assert.equal(cmd("commit", "-am", "main").status, 0);
  assert.equal(cmd("merge", "feature").status, 1);
  const service = createMobileGitService({ load: async workspacePath => ({ git, fs, dir: workspacePath, isRepository: true }) });
  const sameBranch = await service.switchBranch({ workspacePath: mergeDir, targetBranchName: "main" });
  assert.equal(sameBranch.didChange, false);
  const conflicts = await service.getChanges({ workspacePath: mergeDir, sourceId: "unstaged" });
  assert.equal(conflicts.find(item => item.repoRelativePath === "conflict.txt")?.isConflicted, true);
  assert.equal((await service.getDiff({ workspacePath: mergeDir, path: "conflict.txt" })).availability, "unavailable");
  assert.match(await runGitAction(git, fs, mergeDir, "status", {}), /conflict\.txt.*冲突/);
  fs.writeFileSync(`${mergeDir}/conflict.txt`, "resolved\n");
  await service.stagePaths({ workspacePath: mergeDir, paths: ["conflict.txt"] });
  assert.equal((await service.getChanges({ workspacePath: mergeDir, sourceId: "unstaged" })).some(item => item.isConflicted), false);
  const newborn = fs.mkdtempSync(path.join(root, "tmp/git-newborn-")).replaceAll("\\", "/");
  await git.init({ fs, dir: newborn });
  assert.deepEqual((await service.getCommitGraph({ workspacePath: newborn })).commits, []);
  console.log("git-boundary-smoke: PASS");
} finally {
  fs.unlinkSync(out);
}
