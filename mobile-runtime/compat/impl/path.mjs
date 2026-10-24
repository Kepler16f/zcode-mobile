// 只实现被实测用到的那 9 个函数（见 surface-probe.mjs 的输出），POSIX 语义。
export const sep = "/";
export const delimiter = ":";

function parts(p) {
  const abs = p.startsWith("/");
  const out = p.split("/").filter((s) => s && s !== ".");
  return { abs, out };
}

export function normalize(p) {
  const { abs, out } = parts(String(p));
  const up = [];
  for (const s of out) {
    if (s === "..") {
      if (up.length && up[up.length - 1] !== "..") up.pop();
      else if (!abs) up.push("..");
    } else up.push(s);
  }
  const joined = up.join("/") || (abs ? "" : ".");
  return abs ? "/" + joined : joined;
}

export function isAbsolute(p) {
  return String(p).startsWith("/");
}

export function resolve(...segs) {
  let target = "";
  let resolvedAbsolute = false;
  for (let i = segs.length - 1; i >= 0 && !resolvedAbsolute; i--) {
    const p = String(segs[i]);
    if (!p) continue;
    target = p + "/" + target;
    resolvedAbsolute = p.startsWith("/");
  }
  if (!resolvedAbsolute) target = "/work" + (target ? "/" + target : "");
  const out = normalize(target).replace(/\/+$/, "");
  return out.startsWith("/") ? out : "/" + out;
}

function split(p) {
  const s = normalize(p).replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return { dir: i <= 0 ? "/" : s.slice(0, i), base: s.slice(i + 1) };
}

export function dirname(p) {
  return split(p).dir;
}

export function basename(p, ext) {
  const b = split(p).base;
  return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
}

export function extname(p) {
  const b = split(p).base;
  const i = b.lastIndexOf(".");
  return i <= 0 ? "" : b.slice(i);
}

export function join(...segs) {
  return normalize(segs.filter(Boolean).join("/"));
}

export function relative(from, to) {
  const a = resolve(from).slice(1).split("/");
  const b = resolve(to).slice(1).split("/");
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return [...Array(a.length - i).fill(".."), ...b.slice(i)].join("/");
}

export function toPosix(p) {
  return String(p).replace(/\\/g, "/");
}

export function parse(p) {
  const { dir, base } = split(p);
  const i = base.lastIndexOf(".");
  return { root: dir === "/" ? "/" : "", dir, base, ext: i <= 0 ? "" : base.slice(i), name: i <= 0 ? base : base.slice(0, i) };
}

const path = { sep, delimiter, normalize, isAbsolute, resolve, dirname, basename, extname, join, relative, parse, posix: null };
export default path;
path.posix = path;
