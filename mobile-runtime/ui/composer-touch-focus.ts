// Composer 触摸聚焦垫片（0.4.10，装机"输入框要双击才出输入法，有时整屏卡死"）。
//
// 为什么要有这一格：桌面探针（topbar-tap-probe.mjs）证明 tap 输入区 → activeElement
// 就是 v4-composer-input——上游焦点链（Lexical ContentEditable）对合成触摸是通的。
// 装机却要"双击才唤起输入法"：真机 WebView 上第一次 tap 被上游某处消耗（拖拽/文本选择
// 的 touchstart preventDefault 一类桌面鼠标语义），焦点只在第二次才进。用户点名
// "改成触摸逻辑"：垫片在 touchend 落点若在输入区而焦点没进去时，代按一次 focus()——
// focus 发生在用户手势的同步窗口里，Android WebView 会照常弹出 IME。
//
// 只动"焦点没进"的那一拍：焦点已对（正常链走通了）就一个字节都不多做事。
// 只在窄屏（触屏优化开）生效——桌面鼠标链路不碰。
//
// 证人（配合 [[device-blank-list-no-more-guessing]] 的纪律）：每次垫片真的补了一次
// focus（= 上游链在该设备上没走通的那一拍），写进 localStorage `zcode-mobile.focus.diag`
// 计数 + 最后一拍现场；自检 M12 回读。装机报告若 focusDiag 计数 >0，说明 WebView 确实
// 在吞第一次 tap，垫片正在顶上；=0 且用户仍报卡，方向就得换（焦点之外的层）。
const FOCUS_DIAG_KEY = "zcode-mobile.focus.diag";
const EDITABLE_SELECTOR = "#root [contenteditable], #root [data-testid='v4-composer-input']";

type FocusDiag = { updatedAt: number; rescueCount: number; last: string | null };

function readDiag(): FocusDiag {
  try {
    const raw = globalThis.localStorage?.getItem(FOCUS_DIAG_KEY);
    if (raw) return JSON.parse(raw) as FocusDiag;
  } catch {
    /* 读数坏了当没有 */
  }
  return { updatedAt: Date.now(), rescueCount: 0, last: null };
}

function writeDiag(d: FocusDiag): void {
  try {
    globalThis.localStorage?.setItem(FOCUS_DIAG_KEY, JSON.stringify(d));
  } catch {
    /* 写不进不当事 */
  }
}

function isNarrowNow(): boolean {
  return globalThis.document?.documentElement.classList.contains("zcode-narrow") === true;
}

export function installComposerTouchFocus(): void {
  const d = globalThis.document;
  if (!d) return;
  d.addEventListener(
    "touchend",
    (event) => {
      if (!isNarrowNow()) return;
      const touch = event.changedTouches?.[0];
      if (!touch) return;
      // 落点元素（elementFromPoint 用的是最后一次触摸坐标；touchend 时 DOM 已就位）。
      const hit = d.elementFromPoint(touch.clientX, touch.clientY);
      const editable = hit?.closest<HTMLElement>(EDITABLE_SELECTOR);
      if (!editable) return;
      const a = d.activeElement;
      // 只认"焦点就在输入区里"这一种已经到位（含其子节点）。**别拿 a.contains(editable)
      // 当已聚焦**：焦点在 body（比如抢焦抢在禁用按钮上失败落回 body）时 body 包含一切，
      // 会把"上游吞了第一次 tap"的现场误判成"焦点已对"——合成测试正是这样抓到这条的。
      const already = a === editable || editable.contains(a);
      if (already) return;
      // 上游链没把焦点带进来——垫片代按一次。focus() 在 touchend 的同步栈里跑，
      // 保住了"用户手势"上下文，IME 才会弹（异步补 focus 会被当程序性聚焦、不出键盘）。
      editable.focus?.({ preventScroll: false });
      const diag = readDiag();
      diag.rescueCount += 1;
      diag.updatedAt = Date.now();
      diag.last = `active=${a?.tagName ?? "?"}(${a?.getAttribute?.("data-testid") ?? "-"}) → ${editable.tagName}(${editable.getAttribute("data-testid") ?? "ce"})`;
      writeDiag(diag);
    },
    { passive: true, capture: true },
  );
}
