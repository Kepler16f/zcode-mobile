// vfs 派发层 —— 调用方只认这一份，后端按可用性切换：
//   1. globalThis.zcodeFs（FsBridge.kt）存在 → 真盘（Android 应用私有工作区）；
//   2. 否则内存盘（桌面浏览器里的自检/harness，以及鸿蒙 ArkWeb 未接桥时的兜底）。
// 之所以逐函数转发而不是 import 时定型：桥由 WebView 注入，注入时机与脚本执行有先后风险，
// 而且自检要能在两种后端之间来回切，固定绑定做不到。
//
// `/mnt/<挂载名>/…` 走第三个后端（compat/vfs-tree.mjs → TreeBridge.kt：SAF 授权的外部工作区，
// DocumentFile 读写）。派发按**路径**而不是按可用性：外部目录被 scoped storage 关在私有树之外，
// 只能经授权 URI 走，但 Read/Write/Glob/Grep 看到的仍然是一条路径树，调用方不分叉。
// 桥不在（桌面 harness）时 `/mnt/...` 如实 ENOENT，绝不在内存盘里假装挂载过。
//
// 这里刻意不做的事：不在内存盘上假装持久化。真盘不可用时自检显式报 "memory"，
// 因为"文件重启就没了"是产品级缺陷，不能靠措辞盖过去。
import * as memory from "./vfs-memory.mjs";
import * as native from "./vfs-native.mjs";
import * as tree from "./vfs-tree.mjs";
import * as stage from "./vfs-stage.mjs";

export const NotFound = memory.NotFound;

let forced = null; // "memory" | "native"，自检用例用它固定引擎；null = 按可用性

export function isNativeFsAvailable() {
  return native.isNativeFsAvailable();
}

export function setFsEngine(next) {
  forced = next;
}

export function engine() {
  const picked = forced ?? (isNativeFsAvailable() ? "native" : "memory");
  return picked === "native" && !isNativeFsAvailable() ? "memory" : picked;
}

function impl() {
  return engine() === "native" ? native : memory;
}

/** 路径派发：`/mnt/` 前缀进 SAF 树后端；其余按当前 engine。自检报告里 treeEngine() 单列这一路的可用性。 */
function implFor(p) {
  return String(p ?? "").startsWith("/mnt/") ? tree : impl();
}

export function treeBridgeAvailable() {
  return tree.isTreeBridgeAvailable();
}

export const toPath = (p) => implFor(p).toPath(p);
export const mkdir = (p, opts, syscall) => {
  const r = implFor(p).mkdir(p, opts, syscall);
  // 终端 staging 写入透传（0.5.0，见 vfs-stage.mjs）：staging 没就绪时是 no-op。
  stage.mirror("mkdir", p, {});
  return r;
};
export const writeFile = (p, data, opts, syscall) => {
  const r = implFor(p).writeFile(p, data, opts, syscall);
  stage.mirror("write", p, { data, opts });
  return r;
};
export const readFileSync = (p, opts) => implFor(p).readFileSync(p, opts);
/** 一批路径可能混合前缀：分组各走各的后端，再拼回原顺序（契约是"等长数组、单项不抛"）。 */
export const readMany = (paths) => {
  const list = (paths ?? []).map((p) => String(p ?? ""));
  const treeIdx = [];
  const otherIdx = [];
  list.forEach((p, i) => (p.startsWith("/mnt/") ? treeIdx : otherIdx).push(i));
  const out = new Array(list.length);
  if (treeIdx.length) {
    tree.readMany(treeIdx.map((i) => list[i])).forEach((item, k) => {
      out[treeIdx[k]] = item;
    });
  }
  if (otherIdx.length) {
    impl().readMany(otherIdx.map((i) => list[i])).forEach((item, k) => {
      out[otherIdx[k]] = item;
    });
  }
  return out;
};
export const existsSync = (p) => implFor(p).existsSync(p);
export const statSync = (p) => implFor(p).statSync(p);
export const lstatSync = (p) => implFor(p).lstatSync(p);
export const readdirSync = (p, opts) => implFor(p).readdirSync(p, opts);
export const unlinkSync = (p) => {
  const r = implFor(p).unlinkSync(p);
  stage.mirror("unlink", p, {});
  return r;
};
export const rmdir = (p) => {
  const r = implFor(p).rmdir(p);
  stage.mirror("rmdir", p, {});
  return r;
};
export const rmSync = (p, opts) => {
  const r = implFor(p).rmSync(p, opts);
  stage.mirror("rm", p, { recursive: opts?.recursive, force: opts?.force });
  return r;
};
/** rename 看两端：任一端在树上就走树后端（跨树移动由 TreeBridge 如实报 EXDEV，不在这里偷偷换后端）。 */
export const renameSync = (a, b) => {
  const useTree = String(a).startsWith("/mnt/") || String(b).startsWith("/mnt/");
  const r = (useTree ? tree : impl()).renameSync(a, b);
  stage.mirror("rename", a, { to: b });
  return r;
};
export const symlinkSync = (t, p) => implFor(p).symlinkSync(t, p);
export const readlinkSync = (p) => implFor(p).readlinkSync(p);
export const realpathSync = (p) => implFor(p).realpathSync(p);
export const accessSync = (p, mode) => implFor(p).accessSync(p, mode);
export const mkdtempSync = (prefix) => implFor(prefix).mkdtempSync(prefix);
export const dump = () => impl().dump();
export const reset = () => impl().reset();

// 内存盘的 nodes 表只对内存引擎有意义；真盘下返回 null，调用方不能靠它判断内容存在。
export const backend = {
  get nodes() {
    return impl().backend?.nodes ?? null;
  },
  FILE: memory.backend.FILE,
  DIR: memory.backend.DIR,
  LINK: memory.backend.LINK,
  norm: (p) => impl().backend.norm(p),
};

/** 真盘首次使用前先建根目录；失败就退回内存盘并如实报原因，而不是让第一个 Write 莫名其妙炸掉。 */
export function ensureReady() {
  if (engine() !== "native") return { engine: engine(), rootReady: true };
  try {
    const res = JSON.parse(globalThis.zcodeFs.call(JSON.stringify({ op: "touchRoot", path: "/" })));
    if (!res.ok) throw new Error(res.message || "touchRoot 失败");
    return { engine: "native", rootReady: true, root: res.root };
  } catch (e) {
    setFsEngine("memory");
    return { engine: "memory", rootReady: false, error: String(e?.message ?? e) };
  }
}

export { memory, native, tree, stage };
