// 只实现被引用到的符号；depth/null 参数按 Node 文档处理，其余降级为可读输出。
const seen = new WeakSet();

function fmt(v, opts, depth, indent) {
  const { depth: maxDepth = 2 } = opts;
  const pad = " ".repeat(indent);
  if (maxDepth !== null && depth > maxDepth && (typeof v === "object" && v !== null)) {
    return Array.isArray(v) ? "[Array]" : "[Object]";
  }
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  const t = typeof v;
  if (t === "string") return JSON.stringify(v);
  if (t === "number" || t === "boolean" || t === "bigint") return String(v) + (t === "bigint" ? "n" : "");
  if (t === "function") return `[Function ${(v.name || "anonymous")}]`;
  if (t === "symbol") return v.toString();
  if (v instanceof Error) return `${v.name} [${v.code ?? ""}] ${v.message}`.replace(" []", "");
  if (ArrayBuffer.isView(v)) {
    const n = "byteLength" in v ? v.byteLength : 0;
    return `${v.constructor.name}(${n}) { ... }`;
  }
  if (seen.has(v)) return "[Circular]";
  seen.add(v);
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    const items = v.map((x) => pad + "  " + fmt(x, opts, depth + 1, indent + 2));
    return "[\n" + items.join(",\n") + "\n" + pad + "]";
  }
  if (v instanceof Map) {
    const entries = [...v.entries()].map(([k, val]) => pad + "  " + fmt(k, opts, depth + 1, indent + 2) + " => " + fmt(val, opts, depth + 1, indent + 2));
    return `Map(${v.size}) {${entries.length ? "\n" + entries.join(",\n") + "\n" + pad : ""}}`;
  }
  if (v instanceof Set) {
    const entries = [...v.values()].map((x) => pad + "  " + fmt(x, opts, depth + 1, indent + 2));
    return `Set(${v.size}) {${entries.length ? "\n" + entries.join(",\n") + "\n" + pad : ""}}`;
  }
  const keys = Object.keys(v);
  if (!keys.length) return "{}";
  const lines = keys.map((k) => pad + "  " + k + ": " + fmt(v[k], opts, depth + 1, indent + 2));
  const ctor = v.constructor && v.constructor.name !== "Object" ? v.constructor.name + " " : "";
  return `${ctor}{\n${lines.join(",\n")}\n${pad}}`;
}

export function inspect(v, opts) {
  if (typeof opts === "number") opts = { depth: opts };
  return fmt(v, opts ?? {}, 0, "");
}

inspect.defaultOptions = {};

export function promisify(fn) {
  return (...args) =>
    new Promise((resolve, reject) => {
      fn(...args, (err, ...rest) => (err ? reject(err) : resolve(rest.length > 1 ? rest : rest[0])));
    });
}

export function callbackify(fn) {
  return (...args) => {
    const cb = args.pop();
    Promise.resolve()
      .then(() => fn(...args))
      .then((r) => cb(null, r), (e) => cb(e));
  };
}

export function deprecate(fn, msg) {
  return fn;
}

// accountProviderConnectionResolver.ts:2 用它判断"快照变了没有"，决定要不要发 change 事件。
// 这里比较错了不会报错，只会让登录后的模型列表安静地不刷新，所以按 Node 的严格语义实现：
// 类型、原型、键集合、NaN 都要一致才算相等。
function tagOf(v) {
  return Object.prototype.toString.call(v);
}

export function isDeepStrictEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;

  if (a instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp) return a.source === b.source && a.flags === b.flags;
  if (a instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !isDeepStrictEqual(v, b.get(k))) return false;
    }
    return true;
  }
  if (a instanceof Set) {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }
  if (ArrayBuffer.isView(a)) {
    const av = a;
    const bv = b;
    if (av.byteLength !== bv.byteLength) return false;
    const aBytes = new Uint8Array(av.buffer, av.byteOffset, av.byteLength);
    const bBytes = new Uint8Array(bv.buffer, bv.byteOffset, bv.byteLength);
    return aBytes.every((x, i) => x === bBytes[i]);
  }

  const aKeys = Reflect.ownKeys(a);
  const bKeys = Reflect.ownKeys(b);
  if (aKeys.length !== bKeys.length) return false;
  // 可枚举性也要一致：上游靠 enumerable 的替面对象做过形状检查，不可枚举属性藏不住差异。
  for (const key of aKeys) {
    if (!bKeys.includes(key)) return false;
    if (!isDeepStrictEqual(a[key], b[key])) return false;
  }
  return true;
}

export * as types from "./util-types.mjs";
