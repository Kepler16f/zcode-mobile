import def from "../impl/path.mjs";

export * from "../impl/path.mjs";
export { default } from "../impl/path.mjs";

// impl 那份默认导出已经把自己挂到 .posix 上，与 Node 的 `path.posix` 同形。
export const posix = def;

// 端侧三个宿主（Android、HarmonyOS、浏览器）全是 POSIX 语义，`path.win32` 只可能来自上游的
// 跨平台守卫（core/src/tool/path-normalization.ts:12 按 platform 选边）。这里不能把它悄悄做成
// posix 的别名，也不能只缺着：前者会让 Windows 分支在手机上按错误的规则算路径、静默出错，
// 后者会让 `win32.sep` 读成 undefined 一样静默。所以任何一次属性访问都当场报错。
export const win32 = new Proxy({}, {
  get(_t, key) {
    throw new Error(
      `mobile-compat: 端侧访问了 path.win32.${String(key)}（宿主都是 POSIX，先查选边的 platform 从哪来）`,
    );
  },
});
def.win32 = win32;
