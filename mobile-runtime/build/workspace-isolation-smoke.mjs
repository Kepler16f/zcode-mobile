import assert from "node:assert/strict";
import * as fs from "../compat/vfs-memory.mjs";
import { createMobileFileSystemPort } from "../ports/file-system.mjs";
import * as nativeFs from "../compat/vfs-native.mjs";
import * as treeFs from "../compat/vfs-tree.mjs";

fs.reset();
fs.mkdir("/sdcard/project-a", { recursive: true });
fs.mkdir("/sdcard/project-b", { recursive: true });
fs.writeFile("/sdcard/project-a/inside.txt", "inside");
fs.writeFile("/sdcard/project-b/secret.txt", "secret");
globalThis.zcodeDevice = { allFilesGranted: () => true };
const a = createMobileFileSystemPort(fs, { workspaceRoot: "/sdcard/project-a" });
const b = createMobileFileSystemPort(fs, { workspaceRoot: "/sdcard/project-a" });
const denied = async fn => assert.rejects(fn, e => e.code === "permission_denied");

assert.equal((await a.readTextFile({ path: "inside.txt" })).content, "inside");
assert.equal((await a.readTextFile({ path: "/storage/emulated/0/project-a/inside.txt" })).content, "inside");
assert.equal((await a.readTextFile({ path: "/storage/self/primary/project-a/inside.txt" })).content, "inside");
assert.equal((await a.readTextFile({ path: "/ext/project-a/inside.txt" })).content, "inside");
for (const outside of ["../project-b/secret.txt", "/sdcard/project-b/secret.txt", "/storage/emulated/0/project-b/secret.txt", "/ext/project-b/secret.txt"]) {
  await denied(() => a.readTextFile({ path: outside }));
  await denied(() => a.writeTextFile({ path: outside, content: "changed" }));
  await denied(() => a.removeFile({ path: outside }));
}
await denied(() => a.listDirectory({ path: "/sdcard/project-b" }));
await denied(() => a.searchText({ path: "/sdcard/project-b", pattern: "secret" }));
await assert.rejects(a.searchText({ path: ".", pattern: "[" }), e => e.code === "invalid_pattern");
const ioFs = { ...fs, readdirSync: () => { throw Object.assign(new Error("device read failed"), { code: "EIO" }); } };
const ioPort = createMobileFileSystemPort(ioFs, { workspaceRoot: "/sdcard/project-a" });
await assert.rejects(ioPort.searchText({ path: ".", pattern: "x" }), e => e.code === "EIO", "搜索读取失败不能冒充目录不存在");

fs.symlinkSync("../project-b", "/sdcard/project-a/other");
fs.symlinkSync("../project-b/secret.txt", "/sdcard/project-a/secret-link");
await denied(() => a.readTextFile({ path: "other/secret.txt" }));
await denied(() => a.readBinaryFile({ path: "secret-link" }));
await denied(() => a.writeBinaryFile({ path: "other/new.bin", content: new Uint8Array([1]) }));
await denied(() => a.listDirectory({ path: "other" }));
const search = await a.searchText({ path: ".", pattern: "secret", outputMode: "files_with_matches" });
assert.deepEqual(search.files, [], "批量搜索不得跟随指向其他工作区的文件链接");
await a.removeFile({ path: "secret-link" });
assert.equal(fs.existsSync("/sdcard/project-b/secret.txt"), true, "删除链接不能删除其目标");

a.grantRoot("/storage/emulated/0/project-b/secret.txt");
assert.equal((await a.readTextFile({ path: "/sdcard/project-b/secret.txt" })).content, "secret");
await denied(() => b.readTextFile({ path: "/sdcard/project-b/secret.txt" }));
a.revokeRoot("/sdcard/project-b/secret.txt");
await denied(() => a.readTextFile({ path: "/sdcard/project-b/secret.txt" }));
assert.equal(fs.readFileSync("/sdcard/project-b/secret.txt", "utf8"), "secret");
fs.symlinkSync("project-a", "/sdcard/selected-link");
const selected = createMobileFileSystemPort(fs, { workspaceRoot: "/sdcard/selected-link" });
assert.equal((await selected.readTextFile({ path: "inside.txt" })).content, "inside", "选择的链接目录应以真实目录为根");
assert.equal((await selected.readTextFile({ path: "/sdcard/selected-link/inside.txt" })).content, "inside", "选择的链接路径也必须可用");
globalThis.zcodeFs = { call: () => JSON.stringify({ ok: false, code: "EACCES", message: "denied" }) };
assert.throws(() => nativeFs.existsSync("/work/unreadable"), e => e.code === "EACCES", "权限错误不得冒充文件不存在");
delete globalThis.zcodeFs;
globalThis.zcodeTree = { call: () => JSON.stringify({ ok: false, code: "EACCES", message: "denied" }) };
assert.throws(() => treeFs.existsSync("/mnt/example/unreadable"), e => e.code === "EACCES", "SAF 权限错误不得冒充文件不存在");
delete globalThis.zcodeTree;
console.log("workspace-isolation-smoke: PASS");
