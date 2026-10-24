// 内置 git（0.6.1 起）的单元冒烟：isomorphic-git + vfs 适配器的形状契约。
//
// 钉五条链：init 建 .git → status 看见新文件 → add/commit 落历史 → log 读回 →
// ⑤ SAF 全链（假树桥 + 假盘桥）：物化镜像 → git 在镜像上提交 → diff 回写 → 树里真有 .git。
// ①-④ 在内存盘跑（Node 没桥）；⑤ 装假桥后同一份 vfs 实例自动切 native/树后端——
// 引擎选择是逐调用求值的（compat/vfs.mjs impl()），装桥不需要重新 import。
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const zcodeRoot = path.join(root, "../zcode");
const require = createRequire(path.join(zcodeRoot, "apps/zcode-cli/package.json"));
const esbuild = require("esbuild");

// git-tool.ts 依赖 ui/ 里的相对模块（git-fs-adapter 是纯 mjs 直引）；esbuild 直接从
// mobile-runtime/node_modules 解析 isomorphic-git（npm install 落在 mobile-runtime）。
const tmp = path.join(os.tmpdir(), `azcode-git-${Date.now()}.mjs`);
await esbuild.build({
  stdin: {
    contents: `
import * as git from "isomorphic-git";
import { createGitFs } from ${JSON.stringify(path.join(root, "compat/git-fs-adapter.mjs"))};
import * as vfs from ${JSON.stringify(path.join(root, "compat/vfs.mjs"))};
globalThis.__git = git;
globalThis.__gitFs = createGitFs(vfs);
globalThis.__createGitFs = createGitFs;
globalThis.__vfs = vfs;
`,
    resolveDir: path.join(root, "ui"),
    sourcefile: "git-smoke-entry.mjs",
  },
  outfile: tmp,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  write: true,
  logLevel: "warning",
  nodePaths: [path.join(root, "node_modules")],
  // isomorphic-git 的 CJS 链（sha.js→safe-buffer）require("buffer") 等 node 内建：
  // ESM 输出里的动态 require 用 createRequire 补回来。
  banner: {
    js: `import { createRequire as __cR } from "node:module"; const require = __cR(import.meta.url);`,
  },
});
const mod = await import(pathToFileURL(tmp).href).then(() => globalThis);
fs.rmSync(tmp, { force: true });
const git = globalThis.__git;
const gitFs = globalThis.__gitFs;
const vfs = globalThis.__vfs;

const results = [];
const check = async (name, fn) => {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, detail });
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, why: String(e?.message ?? e).slice(0, 300) });
  }
};
const expect = (cond, why) => {
  if (!cond) throw new Error(why);
};

const DIR = "/work/demo-repo";

await check("① init：.git 落盘", async () => {
  vfs.rmSync(DIR, { recursive: true, force: true });
  await git.init({ fs: gitFs, dir: DIR });
  expect(vfs.existsSync(`${DIR}/.git/config`), ".git/config 不存在——init 没落到 vfs");
  return { ok: true };
});

await check("② status：新文件被看见", async () => {
  vfs.writeFile(`${DIR}/README.md`, "# demo\n");
  vfs.mkdir(`${DIR}/src`, { recursive: true });
  vfs.writeFile(`${DIR}/src/index.ts`, "export const v = 1;\n");
  const matrix = await git.statusMatrix({ fs: gitFs, dir: DIR });
  const newFiles = matrix.filter((row) => row[1] === 0 && row[2] === 2 && row[3] === 0).map((r) => r[0]);
  expect(newFiles.includes("README.md"), `README.md 不在新增清单：${JSON.stringify(matrix.slice(0, 5))}`);
  expect(newFiles.includes("src/index.ts"), "src/index.ts 不在新增清单");
  return { newFiles };
});

await check("③ add + commit：历史落库", async () => {
  await git.add({ fs: gitFs, dir: DIR, filepath: "." });
  const sha = await git.commit({
    fs: gitFs,
    dir: DIR,
    message: "first commit",
    author: { name: "aZCode", email: "azcode@local" },
  });
  expect(typeof sha === "string" && sha.length >= 10, `commit sha 异常：${sha}`);
  return { sha: String(sha).slice(0, 10) };
});

await check("④ log + branch + 二次改动 status", async () => {
  const log = await git.log({ fs: gitFs, dir: DIR, depth: 5 });
  expect(log.length === 1 && log[0].commit.message.includes("first commit"), "log 读不回提交");
  const branch = await git.currentBranch({ fs: gitFs, dir: DIR });
  expect(typeof branch === "string" && branch.length > 0, `当前分支异常：${branch}`);
  await git.branch({ fs: gitFs, dir: DIR, ref: "feature-x", checkout: true });
  const after = await git.currentBranch({ fs: gitFs, dir: DIR });
  expect(after === "feature-x", `切分支失败：${after}`);
  vfs.writeFile(`${DIR}/README.md`, "# demo\n# changed\n");
  const matrix = await git.statusMatrix({ fs: gitFs, dir: DIR });
  // statusMatrix 行 = [file, head, workdir, stage]，各位 0/1/2：head=1 且 workdir=2 即改动未暂存。
  const modified = matrix.filter((row) => row[1] === 1 && row[2] === 2).map((r) => r[0]);
  expect(modified.includes("README.md"), `改动没被看见：${JSON.stringify(matrix)}`);
  return { branch, after, modified };
});

// ⑤ SAF 全链（0.6.2）：装上假树桥 + 假盘桥（selfcheck 的"和桥一样笨"语义），同一份 vfs
// 实例自动切到 native/树后端。git 经 staging 镜像在"私有盘"上提交，diff 回写后 SAF 树里
// 必须真有 .git——这正是装机 "/mnt 里 git 启用不了" 的修复链。
await check("⑤ SAF 全链：树 → 镜像 → git 提交 → 回写 → 树里有 .git", async () => {
  const { makeFakeFsBridge, makeFakeTreeBridge } = await import(pathToFileURL(path.join(here, "selfcheck.mjs")).href);
  globalThis.zcodeFs = makeFakeFsBridge();
  globalThis.zcodeTree = makeFakeTreeBridge();
  await vfs.ensureReady();
  const MOUNT = "/mnt/fake";
  // 树里先有一个小项目（走树后端写 SAF 假桥）。
  vfs.mkdir(`${MOUNT}/src`, { recursive: true });
  vfs.writeFile(`${MOUNT}/app.ts`, "export const v = 1;\n");

  // 与 tool-engine 相同的组装：gitFs 走 native 后端（= staging 镜像），纪律两拍来自 vfs.stage。
  const nativeFs = globalThis.__createGitFs(vfs.native);
  const stage = vfs.stage;
  await stage.ensureStaging(MOUNT);
  const snap = stage.snapshotStaging(MOUNT);
  expect(snap instanceof Map && snap.size > 0, "镜像快照为空");

  const gitFsStaged = nativeFs;
  await git.init({ fs: gitFsStaged, dir: MOUNT });
  await git.add({ fs: gitFsStaged, dir: MOUNT, filepath: "." });
  await git.commit({
    fs: gitFsStaged,
    dir: MOUNT,
    message: "saf first",
    author: { name: "aZCode", email: "azcode@local" },
  });
  const wb = await stage.writeBackStaging(MOUNT, snap);
  expect(wb && wb.failed === 0, `回写失败：${JSON.stringify(wb)}`);
  // 树（SAF 假桥）里验证：.git 真的落回了工作区。
  expect(vfs.existsSync(`${MOUNT}/.git/config`), "回写后 .git/config 不在树里");
  // 镜像与树内容一致：工作区文件也在树里。
  expect(vfs.existsSync(`${MOUNT}/app.ts`), "工作区文件不在树里（回写误伤）");
  // 下一轮 status 在镜像上照常工作（.git 已在镜像里，历史可读）。
  const log = await git.log({ fs: gitFsStaged, dir: MOUNT, depth: 5 });
  expect(log.length === 1 && log[0].commit.message.includes("saf first"), "镜像上的历史读不回");
  return { written: wb.written, deleted: wb.deleted, logOk: true };
});

const passed = results.filter((r) => r.ok).length;
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.why}`);
console.log(`内置 git 冒烟：${passed}/${results.length} PASS`);
if (passed !== results.length) process.exit(1);
