// 原生任务负责执行和取消，JS 只保存 ID。真实 Android 桥通过 __zcodeJobDone 回调零轮询唤醒，
// 仅在回调缺失或旧版 Mock 桥上退回轮询，使停止和 UI 事件保持响应。
export function hasNativeJobs(bridge) {
  return Boolean(bridge && typeof bridge.start === "function" && typeof bridge.poll === "function" && typeof bridge.cancel === "function");
}

function abortError() {
  const error = new Error("操作已取消");
  error.name = "AbortError";
  return error;
}

const pendingJobHandlers = new Map();
const earlyJobEnvelopes = new Map();
const EARLY_RESULT_LIMIT = 64;

function ensureJobDoneHook() {
  if (typeof globalThis.__zcodeJobDone === "function" && globalThis.__zcodeJobDone.__zcodeOwned) return;
  const dispatch = (id, envelope) => {
    if (typeof id !== "string") return;
    const handler = pendingJobHandlers.get(id);
    if (handler) {
      handler(envelope);
      return;
    }
    if (earlyJobEnvelopes.size >= EARLY_RESULT_LIMIT) {
      const oldestKey = earlyJobEnvelopes.keys().next().value;
      if (oldestKey !== undefined) earlyJobEnvelopes.delete(oldestKey);
    }
    earlyJobEnvelopes.set(id, envelope);
  };
  dispatch.__zcodeOwned = true;
  globalThis.__zcodeJobDone = dispatch;
}

function ackNativeJob(bridge, id) {
  if (typeof bridge?.ack !== "function") return;
  try { bridge.ack(id); } catch { /* 清理失败不影响已拿到的结果 */ }
}

export async function callNativeJob(bridge, request, signal) {
  if (signal?.aborted) throw abortError();
  ensureJobDoneHook();
  const pushCapable = typeof bridge?.ack === "function";
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
      pendingJobHandlers.delete(id);
      earlyJobEnvelopes.delete(id);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(value);
    };
    const handleEnvelope = (state, fromPush) => {
      if (state?.error) {
        if (fromPush) ackNativeJob(bridge, id);
        finish(cancelled ? abortError() : new Error(state.error));
        return true;
      }
      if (state?.done) {
        if (fromPush) ackNativeJob(bridge, id);
        finish(cancelled ? abortError() : null, state.result);
        return true;
      }
      return false;
    };
    const onAbort = () => {
      if (cancelled || settled) return;
      cancelled = true;
      try { bridge.cancel(id); } catch { /* 任务可能刚好已经完成。 */ }
      // 等原生任务真正收口再返回，避免 SAF 回写与仍在运行的子进程并发修改同一目录。
      clearTimeout(timer);
      if (pushCapable) {
        timer = setTimeout(poll, 100);
      } else {
        poll();
      }
    };
    const poll = () => {
      if (settled) return;
      try {
        const state = JSON.parse(String(bridge.poll(id)));
        if (handleEnvelope(state, false)) return;
        timer = setTimeout(poll, pushCapable ? 500 : 50);
      } catch (error) {
        try { bridge.cancel(id); } catch { /* 保留原始读取错误。 */ }
        finish(cancelled ? abortError() : error);
      }
    };
    pendingJobHandlers.set(id, envelope => {
      try {
        const state = typeof envelope === "string" ? JSON.parse(envelope) : envelope;
        handleEnvelope(state, true);
      } catch (error) {
        finish(cancelled ? abortError() : error);
      }
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (earlyJobEnvelopes.has(id)) {
      const early = earlyJobEnvelopes.get(id);
      earlyJobEnvelopes.delete(id);
      try {
        const state = typeof early === "string" ? JSON.parse(early) : early;
        if (handleEnvelope(state, true)) return;
      } catch (error) {
        finish(cancelled ? abortError() : error);
        return;
      }
    }
    // start 和订阅之间也可能取消；检查一次以免漏掉事件。
    if (signal?.aborted) {
      onAbort();
    } else if (pushCapable) {
      timer = setTimeout(poll, 500);
    } else {
      poll();
    }
  });
}
