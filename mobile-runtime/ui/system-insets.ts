// 状态栏沉浸的页面侧读数（0.3.8 起：留边改由原生做，这里只发布 CSS 变量）。
//
// 0.3.7 的做法是 JS 给 <html> 垫 padding，装机反馈仍然遮挡——所以这一版按用户要求换成
// 安卓原生接口：MainActivity 的 WindowInsets 监听给 WebView 容器本身 setPadding，
// 与页面 JS 完全无关（不存在"垫片没跑/跑晚了/被缓存顶掉"这类失效面）。
// JS 这边留两条：
//  1. 四个 CSS 变量（--zcs-inset-*）供想用"贴屏幕沿再自己垫"的组件取用；
//  **不再写 padding** —— 原生已经垫过，JS 再垫一遍就是双重留边。
//  2. 读数口（safeInsets 初值 + __zcodeInsets 推送）继续维护，自检 M9 靠它判"insets 通道活着"。
type InsetsBridge = { safeInsets?(): string } | undefined;

function bridge(): InsetsBridge {
  const b = (globalThis as { zcodeUi?: { safeInsets?(): string } }).zcodeUi;
  return b && typeof b.safeInsets === "function" ? b : undefined;
}

function applyCssPx(px: number): string {
  const dpr = globalThis.devicePixelRatio || 1;
  // 保留两位小数：1080p 屏 DPR 常是 2.75/3，四舍五入到整数会在一边多出一丝缝。
  return `${Math.round((px / dpr) * 100) / 100}px`;
}

/** 最近一次收到的原始设备像素读数（自检与调试用；__zcodeInsets 推来的也会经过这里）。 */
let latest: { top: number; right: number; bottom: number; left: number } = { top: 0, right: 0, bottom: 0, left: 0 };

export function currentInsets(): typeof latest {
  return latest;
}

function setInsets(read: { top?: number; right?: number; bottom?: number; left?: number }): void {
  const v = {
    top: Number(read?.top ?? 0) || 0,
    right: Number(read?.right ?? 0) || 0,
    bottom: Number(read?.bottom ?? 0) || 0,
    left: Number(read?.left ?? 0) || 0,
  };
  latest = v;
  const root = globalThis.document?.documentElement;
  if (!root) return;
  // 只写变量，不动几何：WebView 的留边是原生的事（见本文件头注）。
  root.style.setProperty("--zcs-inset-top", applyCssPx(v.top));
  root.style.setProperty("--zcs-inset-right", applyCssPx(v.right));
  root.style.setProperty("--zcs-inset-bottom", applyCssPx(v.bottom));
  root.style.setProperty("--zcs-inset-left", applyCssPx(v.left));
  // 变更广播（0.4.9）：CSS 变量是"声明侧"，需要一个"命令侧"信号给消费者重算行内样式
  // （ime-lift 垫 composer 靠它；键盘弹收都走这一拍）。事件名与 touch-opt-changed 同一族。
  globalThis.dispatchEvent?.(new Event("zcode-mobile:insets-changed"));
}

/**
 * 挂上原生推送口并读初始值。必须尽早（entry.tsx 首屏之前）调用：
 * Activity 重建/前后台回来都会重推一次，而冷启动第一次派发可能早于 JS —— 那条存在桥的
 * lastInsetsJson 里，safeInsets() 读回来就补上了，不会"等下一次变化才不跳版"。
 */
export function installInsetsChannel(): void {
  const host = globalThis as {
    __zcodeInsets?: (read: Record<string, number>) => void;
    __zcodeInsetsDebug?: { current(): typeof latest; set(read: Record<string, number>): void };
  };
  // 单点挂接：重复调用（热重启/验证 harness 二次 boot）只换实现，不留双份监听。
  host.__zcodeInsets = (read) => setInsets(read ?? {});
  // 自检与桌面验证的读/注入口：真机上没有 devtools，"insets 到底推没推到"要能被报告回收。
  host.__zcodeInsetsDebug = { current: currentInsets, set: (read) => setInsets(read ?? {}) };
  const b = bridge();
  if (!b) return;
  try {
    const initial = JSON.parse(String(b.safeInsets?.() ?? "{}"));
    setInsets(initial ?? {});
  } catch {
    // 读数坏了不当事：后续每次窗口 insets 变化原生都会重推，最坏晚一帧对上。
  }
}
