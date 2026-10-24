// 键盘（IME）抬高输入条（0.4.9，装机反馈"输入框没随输入法抬高"）。
//
// 通道的现状：MainActivity 在 API 30+ 把 softInputMode 设成 ADJUST_NOTHING，把 IME 高度折进
// bottom 经 __zcodeInsets 推给页面，system-insets.ts 维护 --zcs-inset-bottom 并在每次读数
// 变化时广播 zcode-mobile:insets-changed。上游 RootShell 用 h-dvh，而 Android 30+ 上 dvh
// 不随键盘缩小（全屏候选窗模型），窗口也不 resize——没有任何东西把 composer 顶起来。
// 上游把 composer 做成滚动视口（data-testid=v4-timeline）内的 sticky bottom:0 dock，
// 所以端侧的修法就是给那个视口加 padding-bottom = 键盘高：dock 跟着垫到键盘沿上。
// 只在窄屏（zcode-narrow）生效——桌面 Web 没有虚拟键盘，也不该被端侧垫片碰。
//
// 读数的两条路取大者（不同 ROM 各喂一条）：
//  ① insets 通道（原生 IME 读数，本模块的主路）；
//  ② visualViewport 被压缩的高度（Chromium 在键盘弹起时的标准信号，厂商 ROM 走这条而
//     IME insets 迟迟不动时兜底）。
// >8px 才算键盘（导航条细缝/亚像素抖动归零），另加 8px 呼吸位。
// 输入条在焦点中才动：没在输入时垫高（比如候选窗闪一下）反而把用户的滚动位置顶走。
import { currentInsets } from "./system-insets.js";

const TIMELINE_SELECTOR = '[data-testid="v4-timeline"]';
const INSETS_EVENT = "zcode-mobile:insets-changed";

function doc(): Document | null {
  return globalThis.document ?? null;
}

function isNarrowNow(): boolean {
  return doc()?.documentElement.classList.contains("zcode-narrow") === true;
}

function focusedWantsLift(): boolean {
  const el = doc()?.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable === true;
}

function keyboardCssPx(): number {
  const dpr = globalThis.devicePixelRatio || 1;
  const insetPx = Math.round((Number(currentInsets().bottom ?? 0) || 0) / dpr);
  let vvPx = 0;
  const vv = globalThis.visualViewport;
  if (vv) {
    const layout = doc()?.documentElement?.clientHeight || globalThis.innerHeight || 0;
    vvPx = Math.round(layout - vv.height);
  }
  const k = Math.max(insetPx, vvPx);
  return k > 8 ? k : 0;
}

function apply(): void {
  const timeline = doc()?.querySelector<HTMLElement>(TIMELINE_SELECTOR);
  if (!timeline) return;
  const pad = isNarrowNow() && focusedWantsLift() ? keyboardCssPx() : 0;
  const want = pad > 0 ? `${pad + 8}px` : "";
  if (timeline.style.paddingBottom !== want) timeline.style.paddingBottom = want;
}

export function installImeLift(): void {
  // 三路信号同一收口：insets 推送、visual viewport 几何变化、输入焦点进出。
  globalThis.addEventListener?.(INSETS_EVENT, apply);
  globalThis.visualViewport?.addEventListener?.("resize", apply);
  globalThis.addEventListener?.("focusin", apply);
  globalThis.addEventListener?.("focusout", () => {
    // focusout 时 activeElement 可能已经是下一个输入（切换输入框）：下一拍重算。
    globalThis.setTimeout?.(apply, 0);
  });
  // timeline 是 React 挂载后才出现的：找到即收口一次（键盘已经弹着进入页面的场景）。
  const d = doc();
  if (d?.body) {
    const mo = new MutationObserver(() => {
      if (d.querySelector(TIMELINE_SELECTOR)) {
        mo.disconnect();
        apply();
      }
    });
    mo.observe(d.body, { childList: true, subtree: true });
  }
  apply();
}
