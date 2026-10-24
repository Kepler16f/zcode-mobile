// 端侧自己写的服务面的契约测试（§1.5.17）。
//
// 为什么要单独跑：这些面在桌面上是 `skipped`，在手机上表现为"某个界面空白 / 报错文案看不出所以然"。
// 最关键的一条不是 info() 返回了什么字符串，而是**UI 拿着这个字符串去 readdir 会不会炸** ——
// 那才是 DirectoryBrowser 打开工作区时的真实动作。所以这里把 vfs 真的接进来跑，不用假对象。
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../zcode/apps/zcode-cli/package.json"));
const esbuild = require("esbuild");

// 把 ui/system.ts 打成临时 ESM：类型 import 会被擦掉，vfs 留成 external ——
// 产物写在 build/ 下，`../compat/vfs.mjs` 这个相对路径在运行时正好指到真的那一份。
const tmpOut = path.join(here, ".tmp-system-smoke.mjs");
await esbuild.build({
  entryPoints: [path.join(here, "../ui/system.ts")],
  outfile: tmpOut,
  bundle: true,
  format: "esm",
  platform: "neutral",
  external: ["../compat/vfs.mjs"],
  write: true,
});

const { createMobileSystemService } = await import(pathToFileURL(tmpOut).href);
rmSync(tmpOut, { force: true });

const vfs = await import(pathToFileURL(path.join(here, "../compat/vfs.mjs")).href);

const results = [];
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const throwsCode = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e.code ?? "THROW";
  }
};

const service = createMobileSystemService();
vfs.setFsEngine("memory");

// —— 五条真判据 ——
const cases = [
  ["info() 的 homedir 能被 readdir（不是能返回就完事）", async () => {
    const info = await service.info();
    assert(info.homedir === "/work", `homedir 是 ${info.homedir}，不是 /work`);
    assert(info.platform === "android", `platform 是 ${info.platform}`);
    const listed = vfs.readdirSync(info.homedir);
    assert(Array.isArray(listed), "readdir 没返回列表");
    return { homedir: info.homedir, platform: info.platform, entries: listed.length };
  }],
  ["空磁盘上 info() 会把这一层建出来（否则浏览器一开就报读取失败）", async () => {
    // 内存盘是模块级单例，`setFsEngine("memory")` 只改选哪个引擎、不清数据；
    // 要一张干净盘只能走 memory.reset()（自检也是这么做的）。
    vfs.memory.reset();
    const before = throwsCode(() => vfs.readdirSync("/work"));
    assert(before === "ENOENT", `新内存盘上 /work 居然是可列的（${before}），这条判据失去意义`);
    await service.info();
    assert(throwsCode(() => vfs.readdirSync("/work")) === null, "info() 之后 /work 还是不可列");
    return { before, after: "listable" };
  }],
  ["没有集成终端时 shell 列表是空，不是编一个用不了的", async () => {
    const shells = await service.listIntegratedTerminalShells();
    assert(Array.isArray(shells) && shells.length === 0, `返回了 ${JSON.stringify(shells)}`);
    return { shells: [] };
  }],
  ["probeIntranet 显式做不到，而不是伪造一个\"不在内网\"", async () => {
    let error = null;
    try {
      await service.probeIntranet({ targets: [], attempts: 1, requiredSuccessCount: 1 });
    } catch (e) {
      error = String(e?.message ?? e);
    }
    assert(error !== null, "probeIntranet 居然成功了 —— 端侧没有 TCP socket，这不可能是真探测");
    assert(/TCP socket/.test(error) && /不是权限问题/.test(error), `错误文案没交代原因：${error}`);
    return { rejectedWith: error };
  }],
  ["负对照：真路径（/data/...）当 homedir 时 readdir 当场炸", async () => {
    // 这条保证上面第一条不是空跑：如果谁把 homedir 改成宿主真实路径，UI 会拿到 ENOENT。
    const code = throwsCode(() => vfs.readdirSync("/data/user/0/cn.zcode.mobile/files/zcode/workspace"));
    assert(code === "ENOENT", `真路径居然可列（${code}），说明这条负对照没生效`);
    return { realPathReaddir: code };
  }],
];

for (const [name, fn] of cases) {
  try {
    results.push({ name, ok: true, detail: await fn() });
  } catch (e) {
    results.push({ name, ok: false, error: String(e?.message ?? e) });
  }
}

let pass = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok ? " " + JSON.stringify(r.detail) : " " + r.error}`);
  if (r.ok) pass++;
}
console.log(`\n${pass}/${results.length} PASS`);
process.exit(pass === results.length ? 0 : 1);
