// 0.7.9 装机症状两条的冒烟（用户原话：①"工作区指定没有生效，各个会话和项目没有在指定的本地
// 文件夹里面工作"；②"如果我指定了本地文件夹，就不要用什么虚拟磁盘映射了"）。
//
// 覆盖三块，缺一不可：
//  A. 端口相对路径归一**绑定本工作区根**（ports/file-system.mjs normalizePath 的 fallbackRoot）：
//     写死 "/work" 时，非 /work 工作区里模型给的相对路径会被折进私有盘——正是"选了目录、文件
//     却出现在别处"。现在相对段落在 root 下；指向 /work 的绝对路径在非 /work 工作区当场拒绝。
//  B. 真路径工作区不触发物化（compat/vfs-stage.mjs mountOf 只认 /mnt/）：/sdcard/…、/storage/…
//     的工作区没有镜像、没有回写两拍；系统提示/工具回包/终端 cwd 与所选目录同一拼写。
//  C. JS↔Kotlin 两侧对撞（与 vfs-smoke 最后一条同法，不靠一边想象另一边）：
//     - WorkspaceBridge.handleResult 先试 realPathOfExternalTree（真路径直发），失败才 registerTree；
//     - TreeBridge.realPathOfExternalTree 的三道闸（MANAGE 授予 / 主卷 / 目录存在）与 /sdcard 拼写；
//     - ExecBridge.workspaceFile 与 FsBridge.isExternalSpelling 共用 ZcodePaths.isExternalStorageSpelling；
//     - 该判定与 file-system.mjs guard 直通支认的前缀集合逐字一致（{sdcard, storage}）。
//
// 跑法：node build/workspace-realpath-smoke.mjs（纯 Node，假桥来自 selfcheck.mjs）。
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const ktDir = path.resolve(root, "../android-app/app/src/main/kotlin/cn/zcode/mobile");

const { makeFakeFsBridge, makeFakeTreeBridge } = await import(pathToFileURL(path.join(here, "selfcheck.mjs")).href);

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

// 桥与后端：假 fs（私有树+外部拼写都只是平表节点）+ 假树桥（/mnt/fake 挂载），与 stage-grant-smoke 同一对。
globalThis.zcodeFs = makeFakeFsBridge();
globalThis.zcodeTree = makeFakeTreeBridge();

const vfs = await import(pathToFileURL(path.join(root, "compat/vfs.mjs")).href);
await vfs.ensureReady();
vfs.setFsEngine("native");

const { createMobileFileSystemPort } = await import(pathToFileURL(path.join(root, "ports/file-system.mjs")).href);
const stage = await import(pathToFileURL(path.join(root, "compat/vfs-stage.mjs")).href);

class SmokePortError extends Error {
  constructor(opts) {
    super(opts?.message ?? "FileSystemPortError");
    this.name = "FileSystemPortError";
    this.code = opts?.code;
    this.path = opts?.path;
  }
}
function createPort(workspaceRoot) {
  return createMobileFileSystemPort(vfs, { workspaceRoot, FileSystemPortError: SmokePortError });
}

// ── A. 相对路径绑定工作区根 ──
await step("A1 工作区 /sdcard/Download/proj：相对路径落在工作区根，不落 /work", async () => {
  const port = createPort("/sdcard/Download/proj");
  await port.writeTextFile({ path: "notes/a.txt", content: "hi\n" });
  const back = await port.readTextFile({ path: "notes/a.txt", maxBytes: 100 });
  expect(back.path === "/sdcard/Download/proj/notes/a.txt", `回包路径漂移：${back.path}`);
  expect(back.content === "hi\n", `内容不对：${back.content}`);
  // 同一个假桥上 /work 平表里不该冒出这份文件（旧行为：normalizePath 写死 /work 就发生在这）。
  expect(!vfs.existsSync("/work/notes/a.txt"), "相对路径仍被折进 /work —— fallbackRoot 没生效");
  return { path: back.path };
});

await step("A2 工作区 /mnt/fake：相对路径落在挂载根；指向 /work 的绝对路径拒绝", async () => {
  const port = createPort("/mnt/fake");
  await port.writeTextFile({ path: "rel.txt", content: "x" });
  const back = await port.readTextFile({ path: "rel.txt", maxBytes: 10 });
  expect(back.path === "/mnt/fake/rel.txt", `树工作区相对路径漂移：${back.path}`);
  let code = null;
  try {
    await port.readTextFile({ path: "/work/sneak.txt", maxBytes: 10 });
  } catch (e) {
    code = e?.code ?? e?.name;
  }
  expect(code === "permission_denied", `期望 permission_denied，得到 ${code}`);
  return { rel: back.path, denied: code };
});

await step("A3 工作区 /work：旧行为逐字不变（回归钉）", async () => {
  const port = createPort("/work");
  await port.writeTextFile({ path: "legacy.txt", content: "same" });
  const back = await port.readTextFile({ path: "legacy.txt", maxBytes: 10 });
  expect(back.path === "/work/legacy.txt", `/work 语义变了：${back.path}`);
  return { path: back.path };
});

await step("A4 真路径工作区：工作区根与共享存储直通支都放行（0.7.4 语义不回退）", async () => {
  const port = createPort("/sdcard/Download/proj");
  // 工作区根的绝对路径永远放行。
  await port.writeTextFile({ path: "/sdcard/Download/proj/src/i.ts", content: "1" });
  // 0.7.4 起共享存储整棵树对已授权 app 开放（guard 第一分支 return n，系统权限是唯一开关）：
  // 工作区外的 /sdcard 路径在文件工具层放行、由原生落真盘——本条钉住该行为不被 0.7.9 改动回退。
  await port.createDirectory({ path: "/sdcard/Other" });
  expect(vfs.existsSync("/sdcard/Other"), "guard 直通支被改窄：/sdcard 全盘读写退化");
  return { direct: true };
});

// ── B. 真路径工作区不走物化 ──
await step("B1 mountOf：/sdcard 与 /storage 无挂载（staging 永不触发），/mnt 照旧", () => {
  expect(stage.mountOf("/sdcard/Download/proj") === null, "/sdcard 被判成树挂载——会走镜像两拍");
  expect(stage.mountOf("/storage/emulated/0/Download") === null, "/storage 被判成树挂载");
  expect(stage.mountOf("/work") === null, "/work 不该有挂载");
  expect(stage.mountOf("/mnt/fake/src") === "/mnt/fake", "/mnt 挂载判定漂了");
  return { noneMounted: true };
});

// ── C. JS↔Kotlin 两侧源码对撞 ──
const workspaceBridgeSrc = readFileSync(path.join(ktDir, "WorkspaceBridge.kt"), "utf8");
const treeBridgeSrc = readFileSync(path.join(ktDir, "TreeBridge.kt"), "utf8");
const execBridgeSrc = readFileSync(path.join(ktDir, "ExecBridge.kt"), "utf8");
const fsBridgeSrc = readFileSync(path.join(ktDir, "FsBridge.kt"), "utf8");
const zcodePathsSrc = readFileSync(path.join(ktDir, "ZcodePaths.kt"), "utf8");
const portSrc = readFileSync(path.join(root, "ports/file-system.mjs"), "utf8");

await step("C1 WorkspaceBridge：真路径判定先于 registerTree，未命中才回落 /mnt 挂载", () => {
  const realIdx = workspaceBridgeSrc.indexOf("realPathOfExternalTree(uri)");
  const mountIdx = workspaceBridgeSrc.indexOf("registerTree(uri, grantFlags)");
  expect(realIdx >= 0, "WorkspaceBridge 没有走真路径直发");
  expect(mountIdx >= 0, "WorkspaceBridge 丢了 SAF 回落挂载（未授权机器仍需 /mnt）");
  expect(realIdx < mountIdx, "顺序错了：应先试真路径，失败才挂载 /mnt");
  expect(/deliver\(realPath\)/.test(workspaceBridgeSrc), "真路径命中后没有 deliver");
  return { order: "real-first" };
});

await step("C2 TreeBridge.realPathOfExternalTree：三道闸 + /sdcard 拼写", () => {
  const fn = treeBridgeSrc.match(/fun realPathOfExternalTree[\s\S]*?\n    \}/);
  expect(fn, "TreeBridge 没有 realPathOfExternalTree");
  const body = fn[0];
  expect(body.includes("isExternalStorageManager()"), "少了 MANAGE 授予闸（未授权时真路径是假的）");
  expect(body.includes('"com.android.externalstorage.documents"'), "少了主存储 provider 权威闸");
  expect(body.includes('"primary"') && body.includes('"home"'), "少了主卷 documentId 判定");
  expect(body.includes('"/sdcard"') || body.includes('"/sdcard/"'), "返回拼写不是 /sdcard（与 FsBridge.virtual 反演不一致）");
  expect(body.includes('".."'), "少了 .. 逃逸防御");
  expect(body.includes("isDirectory"), "少了目录当场存在核验");
  return { gates: ["manage", "authority", "primary/home", "isDirectory"] };
});

await step("C3 ExecBridge 与 FsBridge 共用 ZcodePaths 判定（两侧不再各写各的）", () => {
  expect(/ZcodePaths\.isExternalStorageSpelling\(path\)/.test(execBridgeSrc), "ExecBridge.cwd 没有外部拼写直通");
  expect(/ZcodePaths\.isExternalStorageSpelling\(path\)/.test(fsBridgeSrc), "FsBridge.isExternalSpelling 没有收敛到 ZcodePaths");
  const ktPred = zcodePathsSrc.match(/fun isExternalStorageSpelling[\s\S]*?\n    \}/);
  expect(ktPred, "ZcodePaths 缺共享判定");
  expect(ktPred[0].includes('first == "sdcard"') && ktPred[0].includes('first == "storage"'), `ZcodePaths 判定集合漂了：${ktPred[0]}`);
  // ZcodePaths 判定集合必须与 guard 的**直通支**逐字一致（{sdcard, storage}）。/ext 是别名前缀，
  // 由 extAllowed() 单独裁决、原生侧另有一道 externalRootIfGranted，不进这条对撞。
  const directBranch = portSrc.match(/if \(([^;{]*)\) \{\r?\n      return n;\r?\n    \}/);
  expect(directBranch, "guard 的直通支形状变了，本冒烟的钉点需要随迁");
  const jsSet = [...new Set([...directBranch[1].matchAll(/"\/(\w+)(?:\/")?/g)].map((m) => m[1]))];
  expect(jsSet.includes("sdcard") && jsSet.includes("storage"), `guard 直通支缺拼写：${jsSet}`);
  expect(jsSet.length === 2, `guard 直通支多了拼写（原生 ZcodePaths 不认）：${jsSet}`);
  return { shared: ["sdcard", "storage"] };
});

await step("C4 冒烟自守：file-system.mjs 不再出现写死的相对段 /work/", () => {
  const fnMatch = portSrc.match(/function normalizePath[\s\S]*?\n\}/);
  expect(fnMatch, "normalizePath 结构变了，本冒烟的钉点需要随迁");
  expect(!/"\/work\/" \+ out\.join/.test(fnMatch[0]), "normalizePath 仍把相对段写死进 /work");
  expect(fnMatch[0].includes("fallbackRoot"), "normalizePath 没有 fallbackRoot 参数");
  expect(/normalizePath\(p, root\)/.test(portSrc), "guard 没把本端口根传给归一化");
  return { bound: true };
});

// ── 汇总 ──
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length, results }, null, 2));
if (failed.length > 0) {
  console.error(`FAIL ${failed.length}/${results.length}：${failed.map((f) => f.name).join("；")}`);
  process.exitCode = 1;
} else {
  console.log(`OK：工作区指定与真路径映射冒烟 ${results.length} 条全绿`);
}
