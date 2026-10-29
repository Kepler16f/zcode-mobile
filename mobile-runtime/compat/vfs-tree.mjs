// SAF 授权的外部工作区（`/mnt/<名>/…`）：把 node fs 的同步形状压到 globalThis.zcodeTree
// （TreeBridge.kt，DocumentFile 走 SAF 授权 URI）那条同步桥上。
//
// 为什么单独一个后端而不是塞进 vfs-native：FsBridge 的 resolve() 被 canonical 越界闸钉死在
// 应用私有目录里（R11：工具不能借符号链接摸出沙箱），外部目录必须走 DocumentFile —— 两条路
// 的形状不同（没有符号链接、跨树不 rename），合并只会让私有树那侧多背一层假语义。
//
// 已知窄化（与 TreeBridge.kt 头注一致，调用方按 fs 错误码处理即可）：
//  - lstat/readlink/symlink 如实 EPERM：SAF provider 没有链接语义，不是权限问题；
//  - rename 只支持同级改文件名，跨目录/跨树报 EXDEV；
//  - 没有 watch；大文件整读进 JS 堆（和真盘同一约束，§7 R18）。
import { NotFound } from "./vfs-memory.mjs";
import { toBytes, fromBytes } from "./vfs-bytes.mjs";

export { NotFound };

function bridge() {
  return globalThis.zcodeTree;
}

export function isTreeBridgeAvailable() {
  return typeof bridge()?.call === "function";
}

/**
 * 树命名空间自己的 norm，chroot 在 `/mnt`：`..` 顶到 /mnt 就停住。
 * 这是派发正确性的前提 —— 派发按原始前缀判后端（见 compat/vfs.mjs），
 * 如果这里允许 `/mnt/x/../../work` 解成 `/work`，一个"从树里出发"的路径就会静默落进私有盘后端：
 * 工具越过的不是目录边界而是后端边界，报的还是成功。chroot 后它停在 `/mnt/work`，
 * 由 TreeBridge 按"没有这个挂载点"如实 ENOENT —— 留在树命名空间里死，比跨命名空间里活诚实。
 */
function norm(p) {
  const s = String(p ?? "");
  const abs = s.startsWith("/") ? s : "/mnt/" + s;
  const out = [];
  for (const seg of abs.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      // "mnt" 是树根，不出：out 只剩根（或空）时 .. 就是 no-op。
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(seg);
  }
  if (out[0] !== "mnt") out.unshift("mnt");
  return "/" + out.join("/");
}

export function toPath(p) {
  return norm(String(p ?? ""));
}

function call(op, path, extra = {}, syscall = op) {
  return callRaw({ op, path, ...extra }, path, syscall);
}

function callRaw(payload, path, syscall) {
  const b = bridge();
  if (!b || typeof b.call !== "function") {
    throw new NotFound("ENOENT", path, syscall, null, "外部工作区桥（zcodeTree）不可用");
  }
  let res;
  try {
    res = JSON.parse(b.call(JSON.stringify(payload)));
  } catch (e) {
    throw new NotFound("EACCES", path, syscall, e);
  }
  if (!res.ok) {
    throw new NotFound(res.code || "EIO", res.path || path, syscall, null, res.message);
  }
  return res;
}

function statJSON(path) {
  try {
    return call("stat", path, {}, "stat");
  } catch (e) {
    // 撤销授权或 provider 故障不是文件不存在，必须把真实错误传给调用方。
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

function mkStat(path, st) {
  const mtimeMs = Number(st.mtimeMs ?? 0);
  return {
    isFile: () => st.kind === "file",
    isDirectory: () => st.kind === "dir",
    // 树里没有链接：lstat 的形状也必须如实"不是链接"，否则 fs 垫片会追一次永远读不到的 readlink。
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    size: Number(st.size ?? 0),
    mtime: new Date(mtimeMs),
    mtimeMs,
    atime: new Date(mtimeMs),
    birthtime: new Date(mtimeMs),
    mode: Number(st.mode ?? 0o644),
    uid: 0,
    gid: 0,
    ino: hashPath(path),
    dev: 0,
    nlink: 1,
  };
}

function hashPath(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function statSync(p) {
  const path = norm(p);
  const st = statJSON(path);
  if (!st || !st.exists) throw new NotFound("ENOENT", path, "stat");
  return mkStat(path, st);
}

/** lstat 与 stat 同形（没有链接可区分），这是如实语义不是近似。 */
export function lstatSync(p) {
  return statSync(p);
}

export function existsSync(p) {
  const st = statJSON(norm(p));
  return !!st && st.exists === true;
}

export function accessSync(p) {
  const path = norm(p);
  if (!existsSync(path)) throw new NotFound("ENOENT", path, "access");
}

export function mkdir(p, opts = {}, syscall = "mkdir") {
  const path = norm(p);
  if (!opts.recursive) {
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    const st = statJSON(parent);
    if (!st || !st.exists) throw new NotFound("ENOENT", parent, syscall);
    if (st.kind !== "dir") throw new NotFound("ENOTDIR", parent, syscall);
  }
  try {
    call("mkdir", path, { recursive: !!opts.recursive }, syscall);
  } catch (e) {
    if (e.code === "EEXIST" && opts.recursive && statJSON(path)?.kind === "dir") return undefined;
    throw e;
  }
  return undefined;
}

export function writeFile(p, data, opts = {}, syscall = "writeFile") {
  const path = norm(p);
  const o = typeof opts === "string" ? { encoding: opts } : opts ?? {};
  const bytes = toBytes(data, o);
  const append = typeof o.flag === "string" && o.flag.includes("a");
  // 与 FsBridge 不同：这里不 ensureParents —— TreeBridge 对"父目录不存在"报 ENOENT，语义已一致。
  // 与 vfs-bytes 共用一份换算（内存盘/真盘同一签名），base64 的编解码都走 fromBytes/toBytes。
  call("write", path, { base64: fromBytes(bytes, "base64"), append }, syscall);
}


export function readFileSync(p, opts) {
  const path = norm(p);
  const o = typeof opts === "string" ? { encoding: opts } : opts ?? {};
  const res = call("read", path, {}, "open");
  const bytes = toBytes(res.base64, { encoding: "base64" });
  return o.encoding ? fromBytes(bytes, o.encoding) : bytes;
}

/** 批量读一次过桥（§7 R23：逐文件读在 3000 个文件上是 3000 次 JS→Java 同步往返）。
 *  契约与 vfs-native 一致：单项失败不抛，整批等长，按 path 认项不认下标。 */
export function readMany(paths) {
  const list = (paths ?? []).map((p) => norm(p));
  if (list.length === 0) return [];
  let res;
  try {
    res = callRaw({ op: "readMany", paths: list }, list[0], "open");
  } catch (e) {
    // 整桥失败（桥没了/抛异常）：每项如实带同一个错误，调用方跳过整批。
    return list.map((path) => ({ path, ok: false, code: e.code ?? "EIO", message: String(e.message ?? e) }));
  }
  const items = Array.isArray(res.items) ? res.items : [];
  const byPath = new Map();
  for (const item of items) if (item && typeof item.path === "string") byPath.set(item.path, item);
  return list.map((path) => {
    const item = byPath.get(path);
    if (!item || item.ok !== true) {
      return { path, ok: false, code: item?.code ?? "EIO", message: item?.message ?? "桥没有返回这一项" };
    }
    return { path, ok: true, bytes: toBytes(item.base64, { encoding: "base64" }) };
  });
}


export function readdirSync(p, opts) {
  const path = norm(p);
  const res = call("readdir", path, {}, "scandir");
  const names = res.entries.map((e) => e.name);
  if (!opts?.withFileTypes) return names;
  const kinds = new Map(res.entries.map((e) => [e.name, e.kind]));
  const prefix = path === "/" ? "/" : path + "/";
  return names.map((name) => ({
    name,
    isFile: () => kinds.get(name) === "file",
    isDirectory: () => kinds.get(name) === "dir",
    isSymbolicLink: () => false,
    path: prefix + name,
  }));
}

export function unlinkSync(p) {
  call("unlink", norm(p), {}, "unlink");
}

export function rmdir(p) {
  call("rmdir", norm(p), {}, "rmdir");
}

export function rmSync(p, opts = {}) {
  const path = norm(p);
  try {
    call("rm", path, { recursive: !!opts.recursive, force: !!opts.force }, "unlink");
  } catch (e) {
    if (e.code === "ENOENT" && opts.force) return;
    throw e;
  }
}

export function renameSync(from, to) {
  const a = norm(from);
  const b = norm(to);
  if (!existsSync(a)) throw new NotFound("ENOENT", a, "rename");
  call("rename", a, { to: b }, "rename");
}

export function symlinkSync() {
  throw new NotFound("EPERM", "/mnt", "symlink", null, "SAF 树没有符号链接语义（不是权限问题）");
}

export function readlinkSync(p) {
  throw new NotFound("EPERM", norm(p), "readlink", null, "SAF 树没有符号链接语义（不是权限问题）");
}

export function realpathSync(p) {
  const path = norm(p);
  if (!existsSync(path)) throw new NotFound("ENOENT", path, "realpath");
  // 没有链接可解：输入即 canonical，identity 返回才是真话。
  return path;
}

export function mkdtempSync(prefix = "/mnt/") {
  // prefix 语义与真盘一致：给"父目录"，在它下面建 `zcode-<rand>`。norm 掉了尾斜杠，这里补回分隔符。
  const base = norm(prefix);
  const dir = base.endsWith("/") ? base : base + "/";
  for (let i = 0; i < 10; i++) {
    const candidate = dir + "zcode-" + Math.random().toString(36).slice(2, 10);
    try {
      mkdir(candidate, { recursive: false }, "mkdtemp");
      return candidate;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  throw new NotFound("EEXIST", base, "mkdtemp");
}

/** 绝不清外部树：那等于删用户文件。这一后端没有 reset 语义，返回 undefined 让派发层跳过。 */
export function reset() {}

export function dump(limit = 50) {
  const out = [];
  const walk = (dir) => {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      const full = dir + "/" + e.name;
      if (e.isDirectory()) {
        out.push([full, "<dir>"]);
        walk(full);
      } else out.push([full, statJSON(full)?.size ?? 0]);
    }
  };
  walk("/mnt");
  return out;
}

export const backend = { nodes: null, FILE: 2, DIR: 1, LINK: 3, norm };
