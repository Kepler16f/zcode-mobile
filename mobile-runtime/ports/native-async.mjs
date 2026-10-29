// 原生任务负责执行和取消，JS 只保存 ID。短轮询会让出事件循环，使停止和 UI 事件能运行。
export function hasNativeJobs(bridge) {
  return Boolean(bridge && typeof bridge.start === "function" && typeof bridge.poll === "function" && typeof bridge.cancel === "function");
}

function abortError() {
  const error = new Error("操作已取消");
  error.name = "AbortError";
  return error;
}

export async function callNativeJob(bridge, request, signal) {
  if (signal?.aborted) throw abortError();
  const started = JSON.parse(String(bridge.start(JSON.stringify(request))));
  if (started.error || typeof started.id !== "string") throw new Error(started.error ?? "原生任务启动失败");
  const id = started.id;
  return await new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    let cancelled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => {
      if (cancelled || settled) return;
      cancelled = true;
      try { bridge.cancel(id); } catch { /* 任务可能刚好已经完成。 */ }
      // 等原生任务真正收口再返回，避免 SAF 回写与仍在运行的子进程并发修改同一目录。
      clearTimeout(timer);
      poll();
    };
    const poll = () => {
      try {
        const state = JSON.parse(String(bridge.poll(id)));
        if (state.error) return finish(cancelled ? abortError() : new Error(state.error));
        if (state.done) return finish(cancelled ? abortError() : null, state.result);
        timer = setTimeout(poll, 50);
      } catch (error) {
        try { bridge.cancel(id); } catch { /* 保留原始读取错误。 */ }
        finish(cancelled ? abortError() : error);
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // start 和订阅之间也可能取消；检查一次以免漏掉事件。
    if (signal?.aborted) onAbort(); else poll();
  });
}
