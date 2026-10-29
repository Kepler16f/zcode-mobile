/** Android 模型请求不受 WebView CORS 限制，仍由同一模型解析器消费增量 Response。 */
type NativeModelBridge = { start(request: string): string; poll(id: string): string; cancel(id: string): boolean };
type Packet = { status?: number; headers?: Record<string, string>; bodyBase64?: string; done?: boolean; error?: string };
function abortError(): DOMException { return new DOMException("模型请求已取消", "AbortError"); }

/**
 * 这个运行时是不是 Android 应用壳。判据是**别的原生桥在不在**：`zcodeFs`/`zcodeSqlite`/
 * `zcodeDevice` 都是 MainActivity 装配时注册的另一条通道，桌面浏览器里一个都没有。
 *
 * 为什么要有这个判据：模型请求在 Android 上必须走原生桥（WebView 的跨源预检会拦掉
 * MiniMax 这类带鉴权头的网关）。一旦桥缺失还去 fetch，用户看到的就是 `Failed to fetch`——
 * 一句完全指不到真因的错误。所以在壳里，桥缺失要**立刻报"原生模型桥不可用"**；
 * 只有桌面浏览器里的开发自检（那里本来就没有 CORS 限制）才允许退回 fetch。
 */
function isAndroidShell(): boolean {
  const g = globalThis as { zcodeFs?: unknown; zcodeSqlite?: unknown; zcodeDevice?: unknown };
  return Boolean(g.zcodeFs ?? g.zcodeSqlite ?? g.zcodeDevice);
}

function pause(signal?: AbortSignal, delayMs = 20): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
export async function mobileModelFetch(url: string, init: { headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<Response> {
  const bridge = (globalThis as { zcodeModelHttp?: NativeModelBridge }).zcodeModelHttp;
  if (!bridge) {
    // 壳里缺桥 = 应用装配坏了（桥注册失败 / 装的是旧包 / 页面在装配前就发了请求）。
    // 这时回退 fetch 只会得到 `Failed to fetch`，把真因藏起来——直接说清楚。
    if (isAndroidShell()) throw new Error("原生模型桥不可用：请重新安装最新版本应用（模型请求需要走原生网络通道，WebView 直连会被跨源策略拦截）");
    return fetch(url, { ...init, method: "POST" });
  }
  // 「桥在但方法不全」也是装配坏了，同样要立刻报错，不能掉到 fetch 上。
  if (![bridge.start, bridge.poll, bridge.cancel].every(method => typeof method === "function")) {
    throw new Error("原生模型流桥不完整：请重新安装最新版本应用（模型请求需要走原生网络通道）");
  }
  if (init.signal?.aborted) throw abortError();
  const started = JSON.parse(bridge.start(JSON.stringify({ url, headers: init.headers, body: init.body }))) as { id?: string; error?: string };
  if (!started.id) throw new Error(started.error ?? "无法启动原生模型请求");
  const id = started.id;
  let released = false;
  const release = (cancel: boolean) => {
    if (released) return;
    released = true;
    init.signal?.removeEventListener("abort", onAbort);
    if (cancel) { try { bridge.cancel(id); } catch { /* 仍须释放 JS 等待 */ } }
  };
  const onAbort = () => release(true);
  init.signal?.addEventListener("abort", onAbort, { once: true });
  const poll = (): Packet => {
    if (init.signal?.aborted) throw abortError();
    const packet = JSON.parse(bridge.poll(id)) as Packet;
    if (packet.error) throw new Error(packet.error);
    return packet;
  };
  try {
    if (init.signal?.aborted) throw abortError();
    let initial: Packet | null = null;
    for (;;) {
      const packet = poll();
      if (packet.status !== undefined) { initial = packet; break; }
      if (packet.done) throw new Error("原生模型响应缺少 HTTP 状态");
      await pause(init.signal);
    }
    const status = initial.status!;
    const headers = initial.headers;
    let lastYieldAt = performance.now();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          // 原生队列持续非空时，每次 read 都是立即完成的 Promise，长响应会一直占据
          // 微任务队列，触摸、停止按钮和绘制得不到执行。按时间片主动让出一次宏任务。
          if (performance.now() - lastYieldAt >= 16) {
            await pause(init.signal, 0);
            lastYieldAt = performance.now();
          }
          for (;;) {
            const packet: Packet = initial ?? poll();
            initial = null;
            if (init.signal?.aborted) throw abortError();
            if (packet.bodyBase64) {
              const raw = atob(packet.bodyBase64);
              controller.enqueue(Uint8Array.from(raw, char => char.charCodeAt(0)));
            }
            if (packet.done) { release(false); controller.close(); return; }
            if (packet.bodyBase64) return;
            await pause(init.signal);
          }
        } catch (error) { release(true); controller.error(error); }
      },
      cancel() { release(true); },
    });
    if ([204, 205, 304].includes(status)) { await body.cancel(); return new Response(null, { status, headers }); }
    return new Response(body, { status, headers });
  } catch (error) { release(true); throw error; }
}
