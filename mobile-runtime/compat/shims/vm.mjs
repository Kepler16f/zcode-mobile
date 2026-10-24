// 端侧关闭 Node REPL 工具（§3.3），所以 vm 不提供真求值 —— 明确报错比静默降级好。
export function createContext() {
  throw new Error("mobile-compat: node:vm 未启用，端侧不提供脚本级沙箱（Node REPL 工具已在 registry 中关闭）");
}
export const runInContext = createContext;
export const runInNewContext = createContext;
export const Script = class { constructor() { createContext(); } };
