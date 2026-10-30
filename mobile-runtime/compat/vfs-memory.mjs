// 内存虚拟 FS —— M1 用它在浏览器里验证「core 能不能真跑」，现在它降级成**兜底后端**：
// 真机自检证明 WebView 没有 OPFS，落真盘要走 compat/vfs-native.mjs，由 compat/vfs.mjs 派发。
// 接口保持 Node fs 的形状，两个后端可换，调用方不分叉。
import { toBytes, fromBytes, concat } from "./vfs-bytes.mjs";

const DIR = 1;
const FILE = 2;
const LINK = 3;

const now = () => new Date();

// errno 文案表。之前这里对任何非枚举 code 一律印 "permission denied"，
// 真机 0.0.2 的 rename 失败就是这么被读成权限问题的——底层桥给的其实是别的错。
const REASON = {
  ENOENT: "no such file or directory",
  ENOTDIR: "not a directory",
  EISDIR: "illegal operation on a directory",
  EEXIST: "file already exists",
  ENOTEMPTY: "directory not empty",
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  EINVAL: "invalid argument",
};

export class NotFound extends Error {
  constructor(code, path, syscall, cause, reason) {
    super(`${syscall} ${code}: ${reason ?? REASON[code] ?? code}: ${path}`);
    this.code = code;
    this.path = path;
    this.syscall = syscall;
    this.errno = -2;
    if (cause) this.cause = cause;
  }
}

// key: 归一化后的绝对路径
const nodes = new Map();

export function reset() {
  nodes.clear();
  mkdir("/tmp", { recursive: true }, "mkdtemp");
}

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

function parentOf(p) {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

function ensureParents(p, syscall) {
  const parts = p.split("/").filter(Boolean);
  let cur = "";
  for (let i = 0; i < parts.length - 1; i++) {
    cur += "/" + parts[i];
    const n = nodes.get(cur);
    if (!n) throw new NotFound("ENOENT", cur, syscall);
    if (n.kind !== DIR) throw new NotFound("ENOTDIR", cur, syscall);
  }
}

export function mkdir(p, opts = {}, syscall = "mkdir") {
  const path = norm(p);
  if (path === "/") return undefined;
  const rec = nodes.get(path);
  if (rec) {
    if (rec.kind === DIR && opts.recursive) return undefined;
    throw new NotFound("EEXIST", path, syscall);
  }
  if (!opts.recursive) ensureParents(path, syscall);
  else {
    const parts = path.split("/").filter(Boolean);
    let cur = "";
    for (const seg of parts) {
      cur += "/" + seg;
      if (!nodes.has(cur)) nodes.set(cur, mkDir(cur));
    }
    return undefined;
  }
  nodes.set(path, mkDir(path));
  return undefined;
}

function mkDir(path) {
  return { kind: DIR, path, mtime: now(), mtimeMs: Date.now(), mode: 0o755 };
}

export function writeFile(p, data, opts = {}, syscall = "writeFile") {
  const path = norm(p);
  ensureParents(path, syscall);
  const bytes = toBytes(data, typeof opts === "string" ? { encoding: opts } : opts);
  const prev = nodes.get(path);
  if (prev?.kind === DIR) throw new NotFound("EISDIR", path, syscall);
  const append = (typeof opts === "object" && opts.flag === "a") || opts === "a";
  const body = append && prev ? concat(prev.data, bytes) : bytes;
  nodes.set(path, {
    kind: FILE,
    path,
    data: body,
    mtime: now(),
    mtimeMs: Date.now(),
    mode: 0o644,
  });
}

export function readFileSync(p, opts) {
  const path = norm(p);
  // open() 跟符号链接是 POSIX 行为，真盘桥（File.readBytes）也是跟的，内存盘必须给同样的结果，
  // 否则"桌面过了、端侧不过"这种差异就藏在了后端之间。
  const n = follow(path);
  if (!n) throw new NotFound("ENOENT", path, "open");
  if (n.kind === DIR) throw new NotFound("EISDIR", path, "read");
  const o = typeof opts === "string" ? { encoding: opts } : opts ?? {};
  return o.encoding ? fromBytes(n.data, o.encoding) : n.data.slice();
}

/** 与真盘后端同形状（见 vfs-native.mjs）：等长数组，逐项成功/失败，不整批抛。 */
export function readMany(paths) {
  return (paths ?? []).map((p) => {
    const path = norm(p);
    try {
      return { path, ok: true, bytes: readFileSync(path) };
    } catch (e) {
      return { path, ok: false, code: e.code ?? "EIO", message: e.message };
    }
  });
}

export function existsSync(p) {
  return nodes.has(norm(p));
}

export function statSync(p) {
  const path = norm(p);
  const n = resolveLink(nodes.get(path) ?? follow(path), path, "stat");
  if (!n) throw new NotFound("ENOENT", path, "stat");
  return mkStat(n);
}

/** 批量 stat（内存盘形态）：与真盘同名接口同形状，供 vfs 派发层统一调用。 */
export function statMany(paths) {
  return (paths ?? []).map((path) => {
    const p = norm(path);
    try {
      const st = statSync(p);
      return {
        path: p,
        ok: true,
        exists: true,
        kind: st.isDirectory() ? "dir" : st.isSymbolicLink() ? "link" : "file",
        mtimeMs: Number(st.mtimeMs ?? 0),
        size: Number(st.size ?? 0),
      };
    } catch (error) {
      return { path: p, ok: false, exists: false, kind: "missing", mtimeMs: 0, size: 0, message: String(error?.message ?? error) };
    }
  });
}

function follow(path) {
  let cur = nodes.get(path);
  let hops = 0;
  while (cur?.kind === LINK && hops++ < 10) {
    const target = norm(resolveRelative(path, cur.link));
    cur = nodes.get(target);
  }
  return cur;
}

function resolveLink(n, path, syscall) {
  if (n?.kind === LINK) {
    const t = nodes.get(norm(resolveRelative(path, n.link)));
    if (!t) throw new NotFound("ENOENT", path, syscall);
    return t;
  }
  return n;
}

function resolveRelative(from, to) {
  if (to.startsWith("/")) return to;
  return parentOf(from) + "/" + to;
}

function mkStat(n) {
  return {
    isFile: () => n.kind === FILE,
    isDirectory: () => n.kind === DIR,
    isSymbolicLink: () => n.kind === LINK,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    size: n.kind === FILE ? n.data.length : 0,
    mtime: n.mtime,
    mtimeMs: n.mtimeMs,
    atime: n.mtime,
    birthtime: n.mtime,
    mode: n.mode,
    uid: 0,
    gid: 0,
    ino: hashPath(n.path),
    dev: 0,
    nlink: 1,
  };
}

function hashPath(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function lstatSync(p) {
  const path = norm(p);
  const n = nodes.get(path);
  if (!n) throw new NotFound("ENOENT", path, "lstat");
  return mkStat(n);
}

export function readdirSync(p, opts) {
  const path = norm(p);
  const n = nodes.get(path);
  if (!n) throw new NotFound("ENOENT", path, "scandir");
  if (n.kind !== DIR) throw new NotFound("ENOTDIR", path, "scandir");
  const names = [];
  const prefix = path === "/" ? "/" : path + "/";
  for (const key of nodes.keys()) {
    if (!key.startsWith(prefix) || key === path) continue;
    const rest = key.slice(prefix.length);
    if (!rest) continue;
    const first = rest.split("/")[0];
    if (rest.includes("/") && nodes.get(prefix + first)?.kind === FILE) {
      throw new NotFound("ENOTDIR", prefix + first, "scandir");
    }
    if (!rest.includes("/") || nodes.get(prefix + first)?.kind === DIR) {
      if (!names.includes(first)) names.push(first);
    }
  }
  return opts?.withFileTypes
    ? names.map((name) => ({
        name,
        isFile: () => nodes.get(prefix + name)?.kind === FILE,
        isDirectory: () => nodes.get(prefix + name)?.kind === DIR,
        isSymbolicLink: () => nodes.get(prefix + name)?.kind === LINK,
      }))
    : names;
}

export function unlinkSync(p) {
  const path = norm(p);
  if (!nodes.has(path)) throw new NotFound("ENOENT", path, "unlink");
  nodes.delete(path);
}

export function rmdir(path) {
  const n = nodes.get(path);
  if (!n) throw new NotFound("ENOENT", path, "rmdir");
  if (n.kind !== DIR) throw new NotFound("ENOTDIR", path, "rmdir");
  const kids = readdirSync(path);
  if (kids.length) throw new NotFound("ENOTEMPTY", path, "rmdir");
  nodes.delete(path);
}

export function rmSync(p, opts = {}) {
  const path = norm(p);
  const n = nodes.get(path);
  if (!n) {
    if (opts.force) return;
    throw new NotFound("ENOENT", path, "unlink");
  }
  if (n.kind !== DIR) {
    nodes.delete(path);
    return;
  }
  const prefix = path === "/" ? "/" : path + "/";
  const kids = [...nodes.keys()].filter((k) => k.startsWith(prefix));
  if (kids.length && !opts.recursive) throw new NotFound("ENOTEMPTY", path, "rmdir");
  for (const k of kids) nodes.delete(k);
  nodes.delete(path);
}

export function renameSync(from, to) {
  const a = norm(from);
  const b = norm(to);
  const n = nodes.get(a);
  if (!n) throw new NotFound("ENOENT", a, "rename");
  if (n.kind === DIR) {
    const prefix = a === "/" ? "/" : a + "/";
    for (const [k, v] of nodes) {
      if (k.startsWith(prefix)) {
        nodes.delete(k);
        v.path = b + k.slice(prefix.length - 1);
        nodes.set(v.path, v);
      }
    }
  }
  n.path = b;
  nodes.set(b, n);
  nodes.delete(a);
}

export function symlinkSync(target, path) {
  const p = norm(path);
  if (nodes.has(p)) throw new NotFound("EEXIST", p, "symlink");
  nodes.set(p, { kind: LINK, path: p, link: String(target), mtime: now(), mtimeMs: Date.now(), mode: 0o777 });
}

export function readlinkSync(p) {
  const path = norm(p);
  const n = nodes.get(path);
  if (!n) throw new NotFound("ENOENT", path, "readlink");
  if (n.kind !== LINK) throw new NotFound("EINVAL", path, "readlink");
  return n.link;
}

export function realpathSync(p) {
  const path = norm(p);
  const n = follow(path);
  if (!n) throw new NotFound("ENOENT", path, "realpath");
  return n.path;
}

export function accessSync(p, mode) {
  const path = norm(p);
  const n = nodes.get(path);
  if (!n) throw new NotFound("ENOENT", path, "access");
  // X_OK 只在真文件系统上有意义；这里当作"存在即可"，权限模型由 port 层负责。
  if (mode && n.kind === DIR && false) throw new NotFound("EACCES", path, "access");
}

export function mkdtempSync(prefix = "/tmp/") {
  const path = norm(prefix + Math.random().toString(36).slice(2, 10));
  mkdir(path, { recursive: true }, "mkdtemp");
  return path;
}

export const backend = { nodes, FILE, DIR, LINK, norm };
export function dump() {
  return [...nodes.entries()].map(([k, v]) => [k, v.kind === FILE ? v.data.length : v.kind === DIR ? "<dir>" : "<link>"]);
}

reset();
