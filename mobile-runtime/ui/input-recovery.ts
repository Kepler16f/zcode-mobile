// 弹层卸载后遗留的 body:pointer-events:none 会使 JS 仍运行但所有按钮无法接收触摸。
// 仅恢复没有可见弹层持有的锁；真正的审批/菜单仍保持模态。
const MODAL_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], [data-slot="dialog-overlay"], [data-slot="sheet-overlay"]';

export function recoverOrphanedInputLock(d: Document = document): boolean {
  if (d.body?.style.pointerEvents !== "none" || d.visibilityState === "hidden") return false;
  for (const el of d.querySelectorAll<HTMLElement>(`${MODAL_SELECTOR}, [style*="pointer-events"]`)) {
    if (el === d.body || el.hasAttribute("data-closed") || el.getAttribute("data-state") === "closed" || el.closest("[inert], [hidden]")) continue;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) continue;
    if (el.matches(MODAL_SELECTOR) || el.style.pointerEvents === "auto") return false;
  }
  d.body.style.removeProperty("pointer-events");
  try {
    const key = "zcode-mobile.input-recovery";
    const previous = JSON.parse(localStorage.getItem(key) ?? "[]") as number[];
    localStorage.setItem(key, JSON.stringify([...previous, Date.now()].slice(-12)));
  } catch { /* 诊断失败不影响恢复输入 */ }
  return true;
}

export function installInputRecovery(): void {
  if (!document.body) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer !== null || document.body.style.pointerEvents !== "none") return;
    // 等待正常弹层交接及退场动画完成，再检查持有者。
    timer = setTimeout(() => { timer = null; recoverOrphanedInputLock(); }, 350);
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, attributes: true,
    attributeFilter: ["style", "data-state", "data-closed", "hidden", "inert"] });
  document.addEventListener("visibilitychange", schedule);
  globalThis.addEventListener("pageshow", schedule);
  schedule();
}
