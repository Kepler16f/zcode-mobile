// 主 bundle 把 typescript externalize 掉了（§1.5.1：它一个人占 8.9 MB）。
// M1 关卡不测动态工作流，但 dynamic-workflow 的编译器在模块初始化时就读
// ts.ScriptTarget.ESNext 这类常量，所以桩必须对任意形状都取值不炸 —— 用深层 Proxy。
// 真机上应由宿主按需异步加载真 typescript（或干脆不装工作流编译器）。
const cache = new WeakMap();

function ghost(path) {
  const f = cache.get(path);
  if (f) return f;
  const fn = (...a) => {
    throw new Error(`mobile-compat: typescript 未加载，被调用的是 ${path.join(".")}`);
  };
  Object.defineProperty(fn, "name", { value: path.at(-1) ?? "ts" });
  cache.set(path, fn);
  return fn;
}

function deep(namePath) {
  const target = function () {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => namePath.join(".");
      if (prop === "then") return undefined; // 别被当成 thenable
      if (typeof prop === "symbol") return undefined;
      if (prop === "default") return deep(namePath);
      return deep([...namePath, String(prop)]);
    },
    apply() {
      throw new Error(`mobile-compat: typescript 未加载，被调用的是 ${namePath.join(".") || "ts()"}`);
    },
    has() { return true; },
  });
}

const ts = deep([]);
export default ts;
export const ScriptTarget = ts.ScriptTarget;
export const ScriptKind = ts.ScriptKind;
export const ModuleKind = ts.ModuleKind;
export const JsxFlags = ts.JsxFlags;
export const SyntaxKind = ts.SyntaxKind;
export const createSourceFile = ts.createSourceFile;
export const createProgram = ts.createProgram;
export const flattenDiagnosticMessageText = ts.flattenDiagnosticMessageText;
export const version = "0.0.0-stub";
