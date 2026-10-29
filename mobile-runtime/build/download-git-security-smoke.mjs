// 覆盖下载路径授权、原生主题异常和 Git 附着；网络与仓库均为本地隔离夹具。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.resolve(root, "..");
const require = createRequire(path.join(workspace, "zcode/apps/zcode-cli/package.json"));
const esbuild = require("esbuild");
const git = createRequire(path.join(root, "package.json"))("isomorphic-git");
const tmp = fs.mkdtempSync(path.join(workspace, "tmp/download-git-smoke-"));
const bundle = path.join(tmp, "bundle.mjs");
await esbuild.build({
  stdin: {
    contents: `export {makeFetchTool} from ${JSON.stringify(path.join(root, "ui/fetch-tool.ts"))};
export {makeGitTool} from ${JSON.stringify(path.join(root, "ui/git-tool.ts"))};
export {installSystemThemeMediaShim} from ${JSON.stringify(path.join(root, "ui/system-theme-media.ts"))};
export {createMobileFileSystemPort} from ${JSON.stringify(path.join(root, "ports/file-system.mjs"))};
export * as vfs from ${JSON.stringify(path.join(root, "compat/vfs.mjs"))};`,
    resolveDir: path.join(root, "ui"),
  },
  outfile: bundle, bundle: true, format: "esm", platform: "node", target: "node24", logLevel: "warning",
});
const { makeFetchTool, makeGitTool, installSystemThemeMediaShim, createMobileFileSystemPort, vfs } = await import(pathToFileURL(bundle).href);
const check = (condition, message) => { if (!condition) throw new Error(message); };
const denied = async (action) => {
  try { await action(); } catch (error) {
    check(error.code === "permission_denied", `错误码应为 permission_denied：${String(error)}`);
    return;
  }
  throw new Error("越界写入未被拒绝");
};
vfs.setFsEngine("memory");
vfs.mkdir("/work/audit-a", { recursive: true });
vfs.mkdir("/work/audit-b", { recursive: true });
const port = createMobileFileSystemPort(vfs, { workspaceRoot: "/work/audit-a" });
let requests = 0;
const payload = Uint8Array.from([0, 255, 1, 128, 42]);
globalThis.zcodeGitHttp = { call() {
  requests++;
  return JSON.stringify({ statusCode: 200, headers: {"content-type": "application/octet-stream"}, bodyBase64: Buffer.from(payload).toString("base64") });
} };
const download = makeFetchTool("/work/audit-a", port);
const args = { action: "download", url: "https://audit.invalid/file", path: "nested/binary.bin" };
await download.handler(args);
check(Buffer.from(vfs.readFileSync("/work/audit-a/nested/binary.bin")).equals(Buffer.from(payload)), "下载二进制字节不一致");
const beforeDenied = requests;
await denied(() => download.handler({ ...args, path: "../audit-b/out.bin" }));
await denied(() => download.handler({ ...args, path: "/work/audit-b/out.bin" }));
check(requests === beforeDenied, "授权失败时不应先发 HTTP 请求");
port.grantRoot("/work/audit-b/out.bin");
await download.handler({ ...args, path: "../audit-b/out.bin" });
check(Buffer.from(vfs.readFileSync("/work/audit-b/out.bin")).equals(Buffer.from(payload)), "授权后未写入");
port.revokeRoot("/work/audit-b/out.bin");
await denied(() => download.handler({ ...args, path: "../audit-b/out.bin" }));
vfs.symlinkSync("../audit-b", "/work/audit-a/other");
await denied(() => download.handler({ ...args, path: "other/linked.bin" }));
check(!vfs.existsSync("/work/audit-b/linked.bin"), "符号链接绕过授权");
console.log("PASS 下载：二进制、预检、路径越界、授权重试和符号链接");

globalThis.zcodeUi = { systemDark() { throw new Error("mock theme failure"); } };
globalThis.matchMedia = () => ({ matches: false });
installSystemThemeMediaShim();
check(globalThis.matchMedia("(prefers-color-scheme: dark)").matches === false, "主题桥失败应使用默认值");
delete globalThis.zcodeUi;
console.log("PASS 主题：首次调用抛错时仍可启动");

const source = path.join(tmp, "remote");
const target = path.join(tmp, "target");
fs.mkdirSync(source); fs.mkdirSync(target);
const gitCmd = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
gitCmd(["init", "--initial-branch=trunk", source]);
fs.writeFileSync(path.join(source, "README.md"), "remote content\n");
gitCmd(["-C", source, "add", "."]);
gitCmd(["-C", source, "-c", "user.name=Audit", "-c", "user.email=audit@example.invalid", "commit", "-m", "fixture"]);
fs.writeFileSync(path.join(target, "README.md"), "local changes\n");
globalThis.self = globalThis;
globalThis.git = git;
globalThis.zcodeGitHttp = { call(raw) {
  const input = JSON.parse(raw);
  const body = input.method === "POST"
    ? execFileSync("git", ["upload-pack", "--stateless-rpc", source], { input: Buffer.from(input.bodyBase64, "base64") })
    : Buffer.concat([Buffer.from("001e# service=git-upload-pack\n0000"), execFileSync("git", ["upload-pack", "--stateless-rpc", "--advertise-refs", source])]);
  return JSON.stringify({ statusCode: 200, headers: { "content-type": input.method === "POST" ? "application/x-git-upload-pack-result" : "application/x-git-upload-pack-advertisement" }, bodyBase64: body.toString("base64") });
} };
const tool = makeGitTool(target.replaceAll("\\", "/"), fs);
const result = await tool.handler({action: "clone", url: "https://audit-user:audit-token@audit.invalid/repo.git", dir: "."});
check(!(fs.readFileSync(path.join(target, ".git/config"), "utf8").includes("audit-token")), "clone 将凭据写入仓库配置");
check(!result.includes("audit-token"), "clone 输出泄露凭据");
check((await git.currentBranch({fs, dir: target})) === "trunk", `默认分支附着失败：${result}`);
check((await git.resolveRef({fs, dir: target, ref:"HEAD"})) === gitCmd(["-C", source, "rev-parse", "HEAD"]).trim(), "HEAD 未指向远端提交");
check(fs.readFileSync(path.join(target, "README.md"), "utf8") === "local changes\n", "附着时覆盖了工作树");
await tool.handler({action: "clone", url: "https://audit-user:audit-token@audit.invalid/repo.git", dir: "child-clone"});
check(!(fs.readFileSync(path.join(target, "child-clone/.git/config"), "utf8").includes("audit-token")), "子目录 clone 将凭据写入仓库配置");
const beforeRemotes = await git.listRemotes({fs, dir: target});
try { await tool.handler({action:"clone", url:"https://audit.invalid/other.git", dir:"."}); throw new Error("已有仓库未被拒绝"); }
catch (error) { check(String(error).includes("已有") || String(error).includes("已存在"), `已有仓库错误不明确：${error}`); }
check(JSON.stringify(await git.listRemotes({fs, dir: target})) === JSON.stringify(beforeRemotes), "已有远端被覆盖");
console.log("PASS Git：附着默认分支、保留工作树、保护已有仓库");
