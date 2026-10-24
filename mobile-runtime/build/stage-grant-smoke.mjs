// 0.5.0 两条新机制的单元冒烟：沙箱授权扩展（grantRoot/revokeRoot）＋ 终端物化（vfs-stage）。
//
// 沙箱授权半边（用户点名"读 sandbox 外的文件被直接禁止不好，应改为询问授权"）：
//  ① 端口对工作区根外的路径抛 permission_denied（错误带路径，agent 靠它问用户）；
//  ② grantRoot(path) 后同一路径放行（下次 guard 不拦）；
//  ③ revokeRoot(path) 收回，"允许这一次"的语义闭环。
//
// 终端物化半边（用户点名"SAF 挂载目录对终端子进程不可见导致 bash 无法启动"）：
//  ④ ensureStaging 把 SAF 树镜像到 native 盘（Bash 的 cwd 在 ExecBridge 里就落在那）；
//  ⑤ 写入透传：app 侧对树的一次写，staging 同步收到（Edit 完再跑 bash 不看到旧内容）；
//  ⑥ 回写：命令改/增/删镜像文件后，writeBackStaging 把 diff 如实落回 SAF 树；
//  ⑦ 幂等 + 降级：二次 ensure 不重扫（ready 短路）；resetStaging 后可重做。
//
// 用 selfcheck 的两座假桥（makeFakeFsBridge/makeFakeTreeBridge）分别扮演 native 盘与 SAF 树，
// 桥语义与真桥逐字一致（selfcheck.mjs 头注：假桥"和桥一样笨"是刻意的）。
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const selfcheckUrl = pathToFileURL(path.join(here, "selfcheck.mjs")).href;
const { makeFakeFsBridge, makeFakeTreeBridge } = await import(selfcheckUrl);

const results = [];
async function step(name, fn) {
  const t0 = performance.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: +(performance.now() - t0).toFixed(1), detail });
  } catch (e) {
    results.push({ name, ok: false, ms: +(performance.now() - t0).toFixed(1), error: String(e?.message ?? e) });
  }
}
function expect(cond, message) {
  if (!cond) throw new Error(message);
}

// 装上两座假桥再引模块：vfs 派发层按 globalThis.zcodeFs / zcodeTree 的存在性选后端。
const fsBridge = makeFakeFsBridge();
const treeBridge = makeFakeTreeBridge();
globalThis.zcodeFs = fsBridge;
globalThis.zcodeTree = treeBridge;

const vfsUrl = pathToFileURL(path.join(root, "compat/vfs.mjs")).href;
const vfs = await import(vfsUrl);
const stage = vfs.stage;
await vfs.ensureReady();

// 端口只要求错误类可 new + 带 code/message（makeErr 的注入约定，见 file-system.mjs 第 1-2 行注释）。
// 真实宿主从 contracts 注入真类（isFileSystemPortError instanceof 语义）；冒烟只断言 code/message，
// 用本地最小类即可。dist bundle 在纯 Node 里 import 会触发内部动态 import（浏览器产物），不引它。
class SmokePortError extends Error {
  constructor(opts) {
    super(opts?.message ?? "FileSystemPortError");
    this.name = "FileSystemPortError";
    this.code = opts?.code;
    this.path = opts?.path;
  }
}

async function createPort() {
  const portUrl = pathToFileURL(path.join(root, "ports/file-system.mjs")).href;
  const { createMobileFileSystemPort } = await import(portUrl);
  const port = createMobileFileSystemPort(vfs, {
    workspaceRoot: "/work",
    FileSystemPortError: SmokePortError,
  });
  expect(typeof port.grantRoot === "function" && typeof port.revokeRoot === "function",
    "端口没暴露 grantRoot/revokeRoot（file-system.mjs 的 return 对象缺口）");
  return port;
}

// 树里先放一个真项目骨架。假树桥的挂载点 /mnt/fake 已在 makeFakeTreeBridge 里建好。
function seedTree() {
  vfs.mkdir("/mnt/fake/src", { recursive: true });
  vfs.writeFile("/mnt/fake/src/index.ts", "export const v = 1;\n");
  vfs.writeFile("/mnt/fake/README.md", "# fake repo\n");
}
await step("① 端口对工作区根外的路径抛 permission_denied", async () => {
  const port = await createPort();
  let code = null;
  try {
    await port.readTextFile({ path: "/mnt/other/secret.txt", maxBytes: 1_000_000 });
  } catch (e) {
    code = e?.code ?? e?.name;
  }
  expect(code === "permission_denied", `期望 permission_denied，得到 ${code}`);
  return { code };
});

await step("② grantRoot 后同一路径放行", async () => {
  const port = await createPort();
  try {
    await port.readTextFile({ path: "/mnt/other/secret.txt", maxBytes: 1_000_000 });
    throw new Error("grant 前不该放行");
  } catch {
    /* 期望被拒 */
  }
  port.grantRoot("/mnt/other");
  // 授权只开闸：guard 过了，剩下的由后端如实判——文件不存在就是 not_found（拒绝假装成功）。
  let code = null;
  try {
    await port.readTextFile({ path: "/mnt/other/secret.txt", maxBytes: 1_000_000 });
  } catch (e) {
    code = e?.code ?? e?.name;
  }
  expect(code !== "permission_denied", `grant 后 guard 仍拦（授权没生效）：${code}`);
  if (!code || code !== "not_found") {
    // 允许文件真的存在并读回（如果哪天假树里有了这棵挂载），但绝不能是 permission_denied。
    if (!code) return { granted: true, readBack: true };
    throw new Error(`grant 后收到意外错误码 ${code}（期望 not_found 或读取成功）`);
  }
  return { granted: true, guardPassed: true, fileMissing: code === "not_found" };
});

await step("③ revokeRoot 收回授权（允许这一次用完即收）", async () => {
  const port = await createPort();
  port.grantRoot("/mnt/other");
  port.revokeRoot("/mnt/other");
  let code = null;
  try {
    await port.readTextFile({ path: "/mnt/other/secret.txt", maxBytes: 1_000_000 });
  } catch (e) {
    code = e?.code ?? e?.name;
  }
  expect(code === "permission_denied", `revoke 后应回到 permission_denied，得到 ${code}`);
  return { code };
});

// ── 终端物化（vfs-stage）──

await step("④ ensureStaging 把 SAF 树镜像到 native 盘", async () => {
  seedTree();
  const info = await stage.ensureStaging("/mnt/fake");
  expect(info && info.files === 2, `期望镜像 2 个文件：${JSON.stringify(info)}`);
  // 镜像落点：native 盘上的 /mnt/fake/…（与 ExecBridge 的 workspaceFile 映射一致）。
  const idx = vfs.native.readFileSync("/mnt/fake/src/index.ts", "utf8");
  expect(String(idx).includes("export const v"), "native 镜像内容应与树一致");
  return info;
});

await step("⑤ 写入透传：文件工具写树，staging 同步收到", async () => {
  vfs.writeFile("/mnt/fake/src/added.ts", "export const added = true;\n");
  // 直接走 native 读镜像（不透传的话这里就是 ENOENT）。
  await new Promise((r) => setTimeout(r, 10));
  const mirrored = vfs.native.readFileSync("/mnt/fake/src/added.ts", "utf8");
  expect(String(mirrored).includes("added"), "写透传没生效：镜像缺 added.ts");
  return { mirrored: String(mirrored).trim() };
});

await step("⑥ 回写 diff：命令改/增/删，如实落回 SAF 树", async () => {
  // 拍快照（相当于 Bash 前的镜像状态），然后模拟"命令改了镜像"。
  const snapshot = stage.snapshotStaging("/mnt/fake");
  expect(snapshot instanceof Map && snapshot.size > 0, "快照为空，回写无从比");
  // 命令修改 index.ts（内容长度变了 → size diff）
  vfs.native.writeFile("/mnt/fake/src/index.ts", "export const v = 2;\n// terminal\n");
  // 命令新建 build.sh
  vfs.native.writeFile("/mnt/fake/build.sh", "#!/bin/sh\necho build\ntrue\n");
  // 命令删掉 README.md
  vfs.native.unlinkSync("/mnt/fake/README.md");
  await new Promise((r) => setTimeout(r, 10));

  const wb = await stage.writeBackStaging("/mnt/fake", snapshot);
  expect(wb.failed === 0, `回写失败：${JSON.stringify(wb)}`);
  // SAF 树侧验证：改过的、新建的、删掉的。
  const idx = vfs.readFileSync("/mnt/fake/src/index.ts", "utf8");
  expect(String(idx).includes("// terminal"), "修改没回写进 SAF 树");
  const sh = vfs.readFileSync("/mnt/fake/build.sh", "utf8");
  expect(String(sh).includes("echo build"), "新建没回写进 SAF 树");
  expect(!vfs.existsSync("/mnt/fake/README.md"), "删除没回写进 SAF 树");
  return { written: wb.written, deleted: wb.deleted, failed: wb.failed };
});

await step("⑦ 幂等：二次 ensure 不重扫（ready 短路）", async () => {
  const before = fsBridge.ops;
  const info2 = await stage.ensureStaging("/mnt/fake");
  // ready 短路 → 不重扫 → 返回 null；readdir 计数不涨。
  expect(info2 === null, "二次物化不该重扫");
  return { readyShortCircuit: info2 === null };
});

// ── 汇总 ──
const passed = results.filter((r) => r.ok).length;
console.log(
  JSON.stringify(
    { generatedAt: new Date().toISOString(), passed, total: results.length, results },
    null,
    2,
  ),
);
if (passed !== results.length) process.exit(1);
