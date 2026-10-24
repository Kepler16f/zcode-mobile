// 真盘后端：把 Node fs 的同步形状压到 globalThis.zcodeFs（FsBridge.kt）那条同步桥上。
// 与 compat/vfs-memory.mjs 导出同一组函数名与语义，compat/vfs.mjs 只按可用性派发，
// 调用方（ports/file-system.mjs、compat/shims/fs*.mjs、core 的 Read/Write/Edit/Glob/Grep）不分叉。
//
// 每次调用是一次 JS→Java 同步往返，且内容只能过 base64 字符串：
// 这是"文件真的在盘上"的代价，也是 §7 R18 记下的性能边界（大文件整读进 JS 堆、无流式）。
import { NotFound } from "./vfs-memory.mjs";
import { toBytes, fromBytes } from "./vfs-bytes.mjs";

const FILE = 2;
const DIR = 1;
const LINK = 3;

export { NotFound };

function bridge() {
  return globalThis.zcodeFs;
}

export function isNativeFsAvailable() {
  const b = bridge();
  return typeof b?.call === "function";
}

/** 虚拟绝对路径归一化：与内存盘逐字一致，相对路径同样落到 /work 下。 */
function norm(p) {
  const s = String(p ?? "");
  const abs = s.startsWith("/") ? s : "/work/" + s;
  const out = [];
  for (const seg of abs.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}

export function toPath(p) {
  return norm(String(p ?? ""));
}

function call(op, path, extra = {}, syscall = op) {
  return callRaw({ op, path, ...extra }, path, syscall);
}

/**
 * 请求体自己拼的那一支：`readMany` 的主体是一批路径而不是单个 `path`，
 * 走 `call()` 就得伪造一个没意义的路径进去。错误处理仍只有这一份实现。
 */
function callRaw(payload, path, syscall) {
  const b = bridge();
  if (!b || typeof b.call !== "function") {
    throw new NotFound("ENOENT", path, syscall);
  }
  let res;
  try {
    res = JSON.parse(b.call(JSON.stringify(payload)));
  } catch (e) {
    // 桥抛回来通常是 WebView 侧的 RuntimeException（比如主线程被回收），原样带上 cause。
    throw new NotFound("EACCES", path, syscall, e);
  }
  if (!res.ok) {
    // 桥给的 message 必须带上来，否则 Kotlin 侧的 JSONException / IOException 全被 errno 文案盖掉。
    throw new NotFound(res.code || "EIO", res.path || path, syscall, null, res.message);
  }
  return res;
}

function parentOf(p) {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

function ensureParents(p, syscall) {
  const parts = p.split("/").filter(Boolean);
  let cur = "";
  for (let i = 0; i < parts.length - 1; i++) {
    cur += "/" + parts[i];
    const st = statJSON(cur);
    if (!st || !st.exists) throw new NotFound("ENOENT", cur, syscall);
    if (st.kind !== "dir") throw new NotFound("ENOTDIR", cur, syscall);
  }
}

function statJSON(path) {
  try {
    return call("stat", path, {}, "stat");
  } catch (e) {
    return null;
  }
}

function mkStat(path, st) {
  const mtimeMs = Number(st.mtimeMs ?? 0);
  return {
    isFile: () => st.kind === "file",
    isDirectory: () => st.kind === "dir",
    isSymbolicLink: () => st.kind === "link",
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    size: Number(st.size ?? 0),
    mtime: new Date(mtimeMs),
    mtimeMs,
    atime: new Date(mtimeMs),
    birthtime: new Date(mtimeMs),
    mode: Number(st.mode ?? 0),
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

/**
 * statSync 跟符号链接、lstatSync 不跟（Node 语义）。桥那边的 stat 是 lstat 形状
 * （NOFOLLOW_LINKS），所以跟链这条要在 JS 侧自己解一层：读到 link 就取它的目标再 stat。
 */
function statOf(p, followLinks) {
  const path = norm(p);
  const st = statJSON(path);
  if (!st || !st.exists) throw new NotFound("ENOENT", path, followLinks ? "stat" : "lstat");
  if (!followLinks || st.kind !== "link") return mkStat(path, st);
  const target = readTarget(path);
  const resolved = norm(target.startsWith("/") ? target : parentOf(path) + "/" + target);
  const inner = statJSON(resolved);
  if (!inner || !inner.exists) throw new NotFound("ENOENT", path, "stat");
  return mkStat(resolved, inner);
}

function readTarget(path) {
  return String(call("readlink", path, {}, "readlink").link);
}

export function statSync(p) {
  return statOf(p, true);
}

export function lstatSync(p) {
  return statOf(p, false);
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
  if (path === "/") return undefined;
  if (!opts.recursive) ensureParents(path, syscall);
  try {
    call("mkdir", path, { recursive: !!opts.recursive }, syscall);
  } catch (e) {
    // 内存盘对"已存在的目录 + recursive"是成功的，桥那边也一样；剩下的 EEXIST 原样抛。
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
  // 和内存盘一致：父目录不存在就是 ENOENT，append 也不替你建目录。
  // 要建目录请显式 mkdir（FileSystemPort 在 createParents!==false 时就是这么做的）。
  ensureParents(path, syscall);
  call("write", path, { base64: encodeBase64(bytes), append }, syscall);
}

// 大文件避免手写查表：WebView 有 atob/btoa，比逐字符拼串快一个量级。
function encodeBase64(bytes) {
  let bin = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function decodeBase64(text) {
  const bin = atob(String(text));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function readFileSync(p, opts) {
  const path = norm(p);
  const o = typeof opts === "string" ? { encoding: opts } : opts ?? {};
  const res = call("read", path, {}, "open");
  const bytes = decodeBase64(res.base64);
  return o.encoding ? fromBytes(bytes, o.encoding) : bytes;
}

/**
 * 批量读：一批路径只过桥一次。返回与入参等长的数组，每项 `{path, ok, bytes}` 或
 * `{path, ok:false, code, message}` —— 单个文件读不到不该让整批抛异常，否则调用方只能退回逐文件。
 *
 * 加它的原因是 §7 R23 那个数：真盘 grep 3000 个文件 = 3063 次同步往返 = 1231.8 ms。
 * 这 1231.8 ms 里"往返"和"搬运 16 MB base64"各占多少，桌面分不出来（假桥是同进程函数调用，
 * 没有跨语言成本），只有装机能判 —— 所以自检的关卡 3 现在把次数和数据量两个数一起报回来。
 */
export function readMany(paths) {
  const list = (paths ?? []).map((p) => norm(p));
  if (list.length === 0) return [];
  const res = callRaw({ op: "readMany", paths: list }, list[0], "open");
  const items = Array.isArray(res.items) ? res.items : [];
  // 按 path 认项，不认下标：桥要是漏返一项，按下标对齐会把后面每一项的内容错配给前一个路径——
  // 那是静默的数据错位，比读不到更糟。对不上就报 EIO，让调用方跳过这个文件。
  const byPath = new Map();
  for (const item of items) if (item && typeof item.path === "string") byPath.set(item.path, item);
  return list.map((path) => {
    const item = byPath.get(path);
    if (!item || item.ok !== true) {
      return { path, ok: false, code: item?.code ?? "EIO", message: item?.message ?? "桥没有返回这一项" };
    }
    return { path, ok: true, bytes: decodeBase64(item.base64) };
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
    isSymbolicLink: () => kinds.get(name) === "link",
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

export function symlinkSync(target, p) {
  const path = norm(p);
  call("symlink", path, { target: String(target) }, "symlink");
}

export function readlinkSync(p) {
  return readTarget(norm(p));
}

export function realpathSync(p) {
  const path = norm(p);
  if (!existsSync(path)) throw new NotFound("ENOENT", path, "realpath");
  return String(call("realpath", path, {}, "realpath").path);
}

export function mkdtempSync(prefix = "/tmp/") {
  const base = norm(prefix.endsWith("/") ? prefix : parentOf(prefix) + "/");
  for (let i = 0; i < 10; i++) {
    const candidate = base + "zcode-" + Math.random().toString(36).slice(2, 10);
    try {
      mkdir(candidate, { recursive: false }, "mkdtemp");
      return candidate;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  throw new NotFound("EEXIST", base, "mkdtemp");
}

/** 内存盘的 reset() 会清空整棵树；真盘不能这么干——那等于删掉用户工作区。只清 /tmp。 */
export function reset() {
  try {
    rmSync("/tmp", { recursive: true, force: true });
  } catch {
    /* tmp 本来就不存在 */
  }
  mkdir("/tmp", { recursive: true }, "mkdtemp");
}

/** 自检里的 vfs.dump() 只做规模展示，真盘上限量遍历，不做全树扫描。 */
export function dump(limit = 200) {
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
      const full = (dir === "/" ? "" : dir) + "/" + e.name;
      if (e.isDirectory()) {
        out.push([full, "<dir>"]);
        walk(full);
      } else out.push([full, e.isSymbolicLink() ? "<link>" : statJSON(full)?.size ?? 0]);
    }
  };
  walk("/");
  return out;
}

export const backend = { nodes: null, FILE, DIR, LINK, norm };
