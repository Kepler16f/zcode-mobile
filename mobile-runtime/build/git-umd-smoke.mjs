// 0.6.4 修"Git 工具空壳"（装机全 action `e.init is not a function`）的形状冒烟。
//
// 根因：isomorphic-git 的 index.umd.min.js 里 `module.exports=` 写在 UMD 包装函数**内部**
//（是形参不是顶层标识符），esbuild 的 CJS 探测只认顶层 → 判成 ESM 打包 → 不发 module/exports
// 垫片 → UMD 三个分支全落空，落到全局分支 **self.git = factory()**，模块命名空间是空的。
// 设备上 loadGit 返回 {} → 全 action "not a function"。之前 git-smoke 走的是裸包名 CJS 入口
//（index.cjs），从来没验过设备这条相对路径 UMD 加载——本文件就是那条路径的形状契约。
//
// 跑法：esbuild 用**浏览器平台**参数打包 entry（与 bundle-ui 同形状），产物在 Node 里执行
//（先垫 self=globalThis，复刻浏览器全局契约），动态 import UMD chunk，断言 self.git 形状
// 并跑通 init/add/commit 全链。
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

const tmp = path.join(os.tmpdir(), `azcode-git-umd-${Date.now()}.mjs`);
await esbuild.build({
  stdin: {
    contents: `
// 与 ui/git-tool.ts 的 loadGit 逐字同形状（相对路径直引 UMD）
globalThis.self = globalThis; // Node 没有 self；浏览器契约垫片
import * as vfs from ${JSON.stringify(path.join(root, "compat/vfs.mjs"))};
import { createGitFs } from ${JSON.stringify(path.join(root, "compat/git-fs-adapter.mjs"))};
const holder = globalThis;
if (!holder.git) {
  await import(${JSON.stringify(path.join(root, "node_modules/isomorphic-git/index.umd.min.js"))});
}
globalThis.__api = holder.git;
globalThis.__vfs = vfs;
globalThis.__gitFs = createGitFs(vfs);
`,
    resolveDir: path.join(root, "ui"),
    sourcefile: "git-umd-entry.mjs",
  },
  outfile: tmp,
  bundle: true,
  format: "esm",
  platform: "browser", // 关键：与设备同一平台参数，同一条 CJS 探测/垫片路径
  target: "es2022",
  write: true,
  logLevel: "warning",
  nodePaths: [path.join(root, "node_modules")],
});
let mod;
try {
  mod = await import(pathToFileURL(tmp).href);
} finally {
  fs.rmSync(tmp, { force: true });
}

const api = globalThis.__api;
const vfs = globalThis.__vfs;
const gitFs = globalThis.__gitFs;

const results = [];
const check = async (name, fn) => {
  const t0 = Date.now();
  try {
    results.push({ name, ok: true, ms: Date.now() - t0, detail: await fn() });
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, why: String(e?.message ?? e).slice(0, 300) });
  }
};
const expect = (cond, why) => {
  if (!cond) throw new Error(why);
};

await check("① UMD 全局分支：self.git 挂上且 init/statusMatrix 是函数", async () => {
  expect(typeof api === "object" && api !== null, `self.git 没挂上：${String(api)}`);
  expect(typeof api.init === "function", `init 不是函数（形状还是错的）`);
  expect(typeof api.statusMatrix === "function", "statusMatrix 不是函数");
  expect(typeof api.clone === "function" && typeof api.push === "function", "clone/push 不是函数");
  return { keys: Object.keys(api).length };
});

await check("② 浏览器形状全链：init → add → commit 在 self.git 上跑通", async () => {
  const DIR = "/work/umd-repo";
  vfs.rmSync(DIR, { recursive: true, force: true });
  await api.init({ fs: gitFs, dir: DIR });
  vfs.writeFile(`${DIR}/a.ts`, "export const a = 1;\n");
  await api.add({ fs: gitFs, dir: DIR, filepath: "." });
  const sha = await api.commit({ fs: gitFs, dir: DIR, message: "umd ok", author: { name: "aZCode", email: "azcode@local" } });
  const log = await api.log({ fs: gitFs, dir: DIR, depth: 3 });
  expect(log.length === 1 && log[0].commit.message.includes("umd ok"), "历史读不回");
  return { sha: String(sha).slice(0, 10) };
});

const passed = results.filter((r) => r.ok).length;
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.why}`);
console.log(`git UMD 加载冒烟：${passed}/${results.length} PASS`);
if (passed !== results.length) process.exit(1);
