// node:timers/promises 的两个符号。上游用它做退避与让出主线程，语义在浏览器里完全等价。
export function setTimeout(delay, value, options = {}) {
  return new Promise((resolve, reject) => {
    const t = globalThis.setTimeout(() => resolve(value), delay);
    options?.signal?.addEventListener?.("abort", () => {
      globalThis.clearTimeout(t);
      const err = new Error("Operation aborted");
      err.name = "AbortError";
      reject(err);
    }, { once: true });
  });
}

// 必须是**宏任务**：上游用 setImmediate 是为把一个长循环切成片、让事件循环有机会处理别的活，
// queueMicrotask 切不断微任务队列，端侧就会表现成"整个 WebView 卡住"。
export function setImmediate(value) {
  return new Promise((resolve) => globalThis.setTimeout(() => resolve(value), 0));
}

export async function* setInterval(delay, value) {
  while (true) {
    await setTimeout(delay);
    yield value;
  }
}
