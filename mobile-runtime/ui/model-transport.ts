import { getOrCreateSessionId, isZCodeContextHost, officialIdentityRequest } from "./quota-transport.js";
import { officialAiSdkAnthropicVersion } from "./server-compat.js";

function headerHas(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  const found = Object.keys(headers).find((key) => key.toLowerCase() === lower);
  return found ? headers[found] : undefined;
}

function withZCodeChatTraceHeaders(url: URL, headers: Record<string, string>): Record<string, string> {
  if (!isZCodeContextHost(url)) return headers;
  const out = { ...headers };
  const fallbackId = () => `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
  if (!headerHas(out, "x-query-id")) out["x-query-id"] = crypto.randomUUID?.() ?? fallbackId();
  if (!headerHas(out, "x-session-id")) out["x-session-id"] = getOrCreateSessionId();
  if (!headerHas(out, "x-zcode-query-source")) out["x-zcode-query-source"] = "main_turn";
  if (!headerHas(out, "x-zcode-trace-id")) out["x-zcode-trace-id"] = crypto.randomUUID?.() ?? fallbackId();
  return out;
}

// ── 模型请求取证（0.11.6）──
// 装机报模型请求 405 "This client is not supported"时端侧没有任何读数（沿用套餐线
// plan.diag 的教训：网络症状必须先交证人）。把每次模型请求的关键事实写进
// zcode-mobile.model.diag：URL、是否带 dangerous 浏览器自报头、是否带 ZCode-Agent、状态码、错误。
const MODEL_DIAG_KEY = "zcode-mobile.model.diag";
const MODEL_DIAG_MAX = 30;

interface ModelDiagEntry {
  at: number;
  url: string;
  dangerousBrowserHeader: boolean;
  hasZcodeAgent: boolean;
  /** 实际发出的头名清单（小写、只记名不记值）——装机报告可与官方请求逐头对比。 */
  headerNames?: string[];
  userAgent?: string;
  status?: number;
  errorBody?: string;
  error?: string;
}

/** 从取证 Packet 收集错误响应体（前 300 字）；无 body/解不了返回空串。 */
async function readErrorBodySnippet(packet: Packet): Promise<string> {
  if (!packet.bodyBase64) return "";
  const raw = atob(packet.bodyBase64);
  return raw.slice(0, 300);
}

function recordModelDiag(entry: ModelDiagEntry): void {
  try {
    const raw = globalThis.localStorage?.getItem(MODEL_DIAG_KEY);
    const list: ModelDiagEntry[] = raw ? (JSON.parse(raw) as ModelDiagEntry[]) : [];
    list.push(entry);
    while (list.length > MODEL_DIAG_MAX) list.shift();
    globalThis.localStorage?.setItem(MODEL_DIAG_KEY, JSON.stringify(list));
  } catch {
    /* 取证失败不影响主流程 */
  }
}

export function readModelDiag(): ModelDiagEntry[] {
  try {
    const raw = globalThis.localStorage?.getItem(MODEL_DIAG_KEY);
    return raw ? (JSON.parse(raw) as ModelDiagEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * 0.11.6（模型请求 405 "This client is not supported"的修复）：
 * `anthropic-dangerous-direct-browser-access` 是**浏览器 CORS 自报家门头**——官方桌面 CLI
 * （node 运行时，无 CORS 概念）从不发它；服务端看到这个头就能断定"这是网页内直接调用，
 * 不是官方客户端"，回 405 让用户去用官方客户端。端侧原生桥（HttpURLConnection）同样没有
 * CORS 概念，这个头在原生路径上没有任何作用、只有暴露身份的副作用——原生路径上一律剥掉。
 * （buildHeaders 对 anthropic 无条件发它是 0.4.x 给 WebView 直连路径写的，当时没有原生桥。）
 */
function stripBrowserOnlyHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === "anthropic-dangerous-direct-browser-access") continue;
    out[name] = value;
  }
  return out;
}
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
const modelWakers = new Map<string, () => void>();
let sawNativeModelWake = false;

function ensureModelWakeHook() {
  const host = globalThis as { __zcodeModelWake?: ((id: string) => void) & { __zcodeOwned?: boolean } };
  if (typeof host.__zcodeModelWake === "function" && host.__zcodeModelWake.__zcodeOwned) return;
  const wake = Object.assign(
    (id: string) => {
      if (typeof id !== "string") return;
      sawNativeModelWake = true;
      modelWakers.get(id)?.();
    },
    { __zcodeOwned: true },
  );
  host.__zcodeModelWake = wake;
}

export async function mobileModelFetch(url: string, init: { headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<Response> {
  // 模型请求走原生桥/直连 fetch，不经过全局 fetch 的身份归一；zcode-plan（Start Plan 赠送额度）
  // 网关按 ZCode 客户端身份头放行，缺头就 3001/拒绝，表现为"领到了额度却用不了"。
  // 只对官方域生效，第三方网关零注入。
  const identity = officialIdentityRequest(url, init.headers);
  // UA 对齐官方桌面 CLI 的双层拼接形状（0.12.6）：官方 ai-sdk/anthropic 客户端用 UO()
  // 把上下文层 UA 与 SDK UA 空格连接成 `ZCode/3.18.2 ai-sdk/anthropic/3.0.81`——归一层
  // 只给了前半截，这里补后半截（仅官方域；第三方网关不读 UA，零影响）。
  const officialModelHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(identity.headers)) {
    if (name.toLowerCase() === "user-agent" && isZCodeContextHost(identity.url)) {
      const suffix = ` ai-sdk/anthropic/${officialAiSdkAnthropicVersion()}`;
      officialModelHeaders[name] = value.includes("ai-sdk/anthropic/") ? value : `${value}${suffix}`;
      continue;
    }
    officialModelHeaders[name] = value;
  }
  url = identity.url.toString();
  // 原生路径剥掉浏览器 CORS 自报头（官方桌面 CLI 不发它；服务端据此回 405 "This client
  // is not supported"——0.11.6 装机主诉）。桌面浏览器 harness 的 fetch 路径保留原头（CORS 需要）。
  const diagHeaders = init.headers;
  init = { ...init, headers: withZCodeChatTraceHeaders(identity.url, stripBrowserOnlyHeaders(officialModelHeaders)) };
  const diagHeaderNames = Object.keys(init.headers).map((name) => name.toLowerCase()).sort();
  const diagUserAgent = headerValue(init.headers, "user-agent");
  const bridge = (globalThis as { zcodeModelHttp?: NativeModelBridge }).zcodeModelHttp;
  if (!bridge) {
    // 壳里缺桥 = 应用装配坏了（桥注册失败 / 装的是旧包 / 页面在装配前就发了请求）。
    // 这时回退 fetch 只会得到 `Failed to fetch`，把真因藏起来——直接说清楚。
    if (isAndroidShell()) {
      recordModelDiag({ at: Date.now(), url, dangerousBrowserHeader: headerHas(diagHeaders, "anthropic-dangerous-direct-browser-access"), hasZcodeAgent: headerHas(diagHeaders, "x-zcode-agent"), headerNames: diagHeaderNames, userAgent: diagUserAgent, error: "原生模型桥不可用" });
      throw new Error("原生模型桥不可用：请重新安装最新版本应用（模型请求需要走原生网络通道，WebView 直连会被跨源策略拦截）");
    }
    return fetch(url, { ...init, method: "POST" });
  }
  // 「桥在但方法不全」也是装配坏了，同样要立刻报错，不能掉到 fetch 上。
  if (![bridge.start, bridge.poll, bridge.cancel].every(method => typeof method === "function")) {
    throw new Error("原生模型流桥不完整：请重新安装最新版本应用（模型请求需要走原生网络通道）");
  }
  if (init.signal?.aborted) throw abortError();
  ensureModelWakeHook();
  const started = JSON.parse(bridge.start(JSON.stringify({ url, headers: init.headers, body: init.body }))) as { id?: string; error?: string };
  if (!started.id) throw new Error(started.error ?? "无法启动原生模型请求");
  const id = started.id;
  let released = false;
  let wokeBeforeWait = false;
  let flushWaiter: (() => void) | null = null;
  const release = (cancel: boolean) => {
    if (released) return;
    released = true;
    modelWakers.delete(id);
    const flush = flushWaiter;
    flushWaiter = null;
    flush?.();
    init.signal?.removeEventListener("abort", onAbort);
    if (cancel) { try { bridge.cancel(id); } catch { /* 仍须释放 JS 等待 */ } }
  };
  modelWakers.set(id, () => {
    wokeBeforeWait = true;
    const flush = flushWaiter;
    flushWaiter = null;
    flush?.();
  });
  const waitWake = async () => {
    if (init.signal?.aborted) throw abortError();
    if (wokeBeforeWait) { wokeBeforeWait = false; return; }
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        if (flushWaiter === done) flushWaiter = null;
        init.signal?.removeEventListener("abort", onSignalAbort);
      };
      const done = () => { cleanup(); resolve(); };
      const onSignalAbort = () => { cleanup(); reject(abortError()); };
      flushWaiter = done;
      init.signal?.addEventListener("abort", onSignalAbort, { once: true });
      timer = setTimeout(done, sawNativeModelWake ? 250 : 20);
    });
  };
  const onAbort = () => release(true);
  init.signal?.addEventListener("abort", onAbort, { once: true });
  const poll = (): Packet => {
    if (init.signal?.aborted) throw abortError();
    // 在进入 JNI poll 前复位标记，防止 poll 返回空包期间到达的 wake 被吞掉。
    wokeBeforeWait = false;
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
      await waitWake();
    }
    const status = initial.status!;
    const headers = initial.headers;
    // 0.12.4：4xx/5xx 时把响应体前 300 字也记进取证——405 "This client is not
    // supported" 这类服务端判定，只有响应体能给出"到底差在哪"（缺什么头/什么参数）。
    const diagStatusEntry: ModelDiagEntry = {
      at: Date.now(),
      url,
      dangerousBrowserHeader: headerHas(diagHeaders, "anthropic-dangerous-direct-browser-access"),
      hasZcodeAgent: headerHas(diagHeaders, "x-zcode-agent"),
      headerNames: diagHeaderNames,
      userAgent: diagUserAgent,
      status,
    };
    if (status >= 400) {
      // 收集完错误响应体（前 300 字）后再落盘；取证失败不影响响应回传。
      const errorBody = await readErrorBodySnippet(initial).catch(() => "");
      recordModelDiag({ ...diagStatusEntry, errorBody });
    } else {
      recordModelDiag(diagStatusEntry);
    }
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
            await waitWake();
          }
        } catch (error) { release(true); controller.error(error); }
      },
      cancel() { release(true); },
    });
    if ([204, 205, 304].includes(status)) { await body.cancel(); return new Response(null, { status, headers }); }
    return new Response(body, { status, headers });
  } catch (error) { release(true); throw error; }
}
