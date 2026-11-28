import { getOrCreateSessionId, isZCodeContextHost, officialIdentityRequest } from "./quota-transport.js";
import {
  buildUltraSigningHeaders,
  invalidateSigningKey,
  isSigningBypassed,
  markSigningBypassed,
  readSigningFailureReason,
  resolveUltraRoute,
} from "./ultra-signing.js";
import { officialCompatibilityVersion } from "./server-compat.js";
import {
  officialAiSdkProviderUtilsVersion,
  OFFICIAL_NODE_RUNTIME_UA,
} from "./server-compat.js";

function headerHas(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  const found = Object.keys(headers).find((key) => key.toLowerCase() === lower);
  return found ? headers[found] : undefined;
}

function setHeaderCaseInsensitive(headers: Record<string, string>, name: string, value: string): void {
  const lower = name.toLowerCase();
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === lower) delete headers[existing];
  }
  headers[name] = value;
}

function isConnectivityProbeBody(body: string): boolean {
  return typeof body === "string" && body.includes("You are ZCode connectivity probe.");
}

function withZCodeChatTraceHeaders(
  url: URL,
  headers: Record<string, string>,
  body: string,
): Record<string, string> {
  if (!isZCodeContextHost(url)) return headers;
  const out = { ...headers };
  const connectivityProbe = isConnectivityProbeBody(body);
  const fallbackId = () => `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
  if (!headerHas(out, "x-query-id")) out["x-query-id"] = crypto.randomUUID?.() ?? fallbackId();
  if (!headerHas(out, "x-session-id")) out["x-session-id"] = getOrCreateSessionId();
  if (!headerHas(out, "x-zcode-query-source")) {
    out["x-zcode-query-source"] = connectivityProbe ? "provider_settings_connectivity" : "main_turn";
  }
  if (connectivityProbe) {
    setHeaderCaseInsensitive(out, "X-ZCode-Session-Type", "other");
  }
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
  /** 请求体结构摘要（0.12.9）：网关 3012 按请求体判客户端，只有头清单不够定位。 */
  bodyShape?: {
    model?: string;
    systemBlocks?: number;
    systemFirstChars?: string;
    hasMetadata?: boolean;
    toolsCount?: number;
    maxTokens?: number;
    stream?: boolean;
    bodyBytes?: number;
  };
  status?: number;
  errorBody?: string;
  error?: string;
}

/** 从请求体 JSON 提取结构摘要（只记形状不记对话内容——隐私与体积都安全）。 */
function readBodyShape(body: string): ModelDiagEntry["bodyShape"] | undefined {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const system = parsed.system;
    const systemBlocks = Array.isArray(system)
      ? system.length
      : typeof system === "string" && system.trim()
        ? 1
        : 0;
    const systemFirst = Array.isArray(system)
      ? String((system[0] as { text?: string } | undefined)?.text ?? "").slice(0, 48)
      : typeof system === "string"
        ? system.slice(0, 48)
        : "";
    const tools = parsed.tools;
    return {
      model: typeof parsed.model === "string" ? parsed.model : undefined,
      systemBlocks,
      systemFirstChars: systemFirst,
      hasMetadata: parsed.metadata != null,
      toolsCount: Array.isArray(tools) ? tools.length : undefined,
      maxTokens: typeof parsed.max_tokens === "number" ? parsed.max_tokens : undefined,
      stream: parsed.stream === true,
      bodyBytes: body.length,
    };
  } catch {
    return undefined;
  }
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

let ultraZCodeJwtLoader: (() => Promise<string | null | undefined>) | null = null;

/** 注册 ZCode OAuth JWT 读取器（Coding Plan 经 agent/configs 路由到 ultra 时按需附带 X-ZCode-Authorization）。 */
export function setUltraZCodeJwtLoader(loader: (() => Promise<string | null | undefined>) | null): void {
  ultraZCodeJwtLoader = loader;
}

function isCodingPlanUltraUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (host !== "open.bigmodel.cn" && host !== "api.z.ai") return false;
    return /^\/api\/anthropic(\/v1)?\/messages(\/|$)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

async function readNormalizedZCodeAuthorization(): Promise<string | undefined> {
  if (!ultraZCodeJwtLoader) return undefined;
  try {
    const raw = (await ultraZCodeJwtLoader())?.trim();
    if (!raw || !/^[\x20-\x7e]+$/u.test(raw)) return undefined;
    return /^Bearer\s/iu.test(raw) ? raw : `Bearer ${raw}`;
  } catch {
    return undefined;
  }
}

/**
 * Coding Plan ultra 签名链路的资格判定与头组/URL 准备。
 * 官方 4.0.0（zcode.cjs _vt + qpa）：
 *   - Start Plan（zcode.z.ai/api/v1/zcode-plan/anthropic）直发 zcode-plan，不进 ultra、不做 c1f3a7e2 签名；
 *   - Coding Plan（open.bigmodel.cn / api.z.ai 的 /api/anthropic/v1/messages）按 agent/configs 路由到
 *     /api/v1/ultra[/ultra-zai]/anthropic/v1/messages 并附带 c1f3a7e2 签名五头及可选 X-ZCode-Authorization。
 */
/** 同步资格判定：非候选路径必须在零 await 下短路（idle 看门狗对 fetch 首字节时序敏感）。 */
function isUltraCandidateSync(url: string, headers: Record<string, string>): boolean {
  if (!isCodingPlanUltraUrl(url)) return false;
  const rawAuthorization = headerValue(headers, "authorization") ?? "";
  const apiKey = rawAuthorization.replace(/^Bearer\s+/i, "").trim() || headerValue(headers, "x-api-key")?.trim() || "";
  if (!apiKey || isSigningBypassed(apiKey)) return false;
  return true;
}

async function rewriteToUltraUrlIfEligible(
  url: string,
  headers: Record<string, string>,
): Promise<{ url: string; headers: Record<string, string> } | null> {
  if (!isCodingPlanUltraUrl(url)) return null;
  const rawAuthorization = headerValue(headers, "authorization") ?? "";
  const apiKey = rawAuthorization.replace(/^Bearer\s+/i, "").trim() || headerValue(headers, "x-api-key")?.trim() || "";
  if (!apiKey || isSigningBypassed(apiKey)) return null;
  const sessionId = headerValue(headers, "x-session-id")?.trim() ?? "";
  const origin = new URL(url).origin;
  const configsFetch: typeof fetch = (input, init) => {
    const rawHeaders = new Headers(init?.headers ?? {});
    const normalized = officialIdentityRequest(
      input instanceof Request ? input.url : String(input),
      Object.fromEntries(rawHeaders.entries()),
    );
    return fetch(normalized.url, { ...init, headers: normalized.headers });
  };
  try {
    const [route, signingHeaders] = await Promise.all([
      resolveUltraRoute(url, configsFetch),
      buildUltraSigningHeaders({
        apiKey,
        sessionId,
        clientVersion: officialCompatibilityVersion(),
        bigmodelOrigin: origin,
      }),
    ]);
    if (!route.routed) return null;
    const extra: Record<string, string> = { ...(signingHeaders ?? {}) };
    if (route.includeZCodeAuthorization) {
      const zcodeAuth = await readNormalizedZCodeAuthorization();
      if (zcodeAuth) extra["X-ZCode-Authorization"] = zcodeAuth;
    }
    return { url: route.url, headers: extra };
  } catch {
    return null; // fail-open
  }
}

/** ultra 401 + 签名失败 reason：重握手（invalidate），再犯进 bypass（官方语义）。 */
function handleUltraSigningRejection(apiKey: string, bodyText: string): void {
  const reason = readSigningFailureReason(bodyText);
  if (!/VERIFY_SIGNATURE_INVALID|VERIFY_APIKEY_EXPIRED/i.test(reason)) return;
  if (keyInvalidatedOnce.has(apiKey)) {
    markSigningBypassed(apiKey);
    keyInvalidatedOnce.delete(apiKey);
  } else {
    invalidateSigningKey(apiKey);
    keyInvalidatedOnce.add(apiKey);
  }
}

const keyInvalidatedOnce = new Set<string>();
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
  // UA 对齐官方 4.0.0 桌面 CLI 的实测三段形状（dump req-001）：`ZCode/<ver>
  // ai-sdk/provider-utils/<utils> runtime/node.js/<node>`——4.0.0 起不再拼 ai-sdk/anthropic
  // 段（官方 n2() 只在 postToApi 一层拼 provider-utils 与 runtime）。仅官方域，第三方零影响。
  const officialModelHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(identity.headers)) {
    if (name.toLowerCase() === "user-agent" && isZCodeContextHost(identity.url)) {
      officialModelHeaders[name] = value.includes("ai-sdk/provider-utils/")
        ? value
        : `${value} ai-sdk/provider-utils/${officialAiSdkProviderUtilsVersion()} ${OFFICIAL_NODE_RUNTIME_UA}`;
      continue;
    }
    officialModelHeaders[name] = value;
  }
  // 官方 ultra 请求带 anthropic-beta（dump req-001 实测）：三条 system 消息合并的
  // mid-conversation 标记。端侧官方域对话请求同带；探测请求（单块 system）不带。
  if (
    isZCodeContextHost(identity.url) &&
    !officialModelHeaders["anthropic-beta"] &&
    !isConnectivityProbeBody(init.body)
  ) {
    officialModelHeaders["anthropic-beta"] = "mid-conversation-system-2026-04-07";
  }
  url = identity.url.toString();
  // 原生路径剥掉浏览器 CORS 自报头（官方桌面 CLI 不发它；服务端据此回 405 "This client
  // is not supported"——0.11.6 装机主诉）。桌面浏览器 harness 的 fetch 路径保留原头（CORS 需要）。
  init = {
    ...init,
    headers: withZCodeChatTraceHeaders(
      identity.url,
      stripBrowserOnlyHeaders(officialModelHeaders),
      init.body,
    ),
  };
  // ── Coding Plan ultra 签名链路（仅限 open.bigmodel.cn / api.z.ai 的 /api/anthropic/v1/messages）：
  // Start Plan（zcode-plan/anthropic）直发原端点且不签名；Coding Plan 按 agent/configs 路由并做
  // c1f3a7e2 握手签名（fail-open）。同步资格判定先短路：非候选路径零 await（idle 看门狗时序敏感）。
  const ultraTarget =
    isConnectivityProbeBody(init.body) || !isUltraCandidateSync(url, init.headers)
      ? null
      : await rewriteToUltraUrlIfEligible(url, init.headers);
  if (ultraTarget) {
    url = ultraTarget.url;
    for (const [name, value] of Object.entries(ultraTarget.headers)) {
      setHeaderCaseInsensitive(init.headers, name, value);
    }
  }
  const diagHeaders = init.headers;
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
      bodyShape: readBodyShape(init.body),
      status,
    };
    if (status >= 400) {
      // 收集完错误响应体（前 300 字）后再落盘；取证失败不影响响应回传。
      const errorBody = await readErrorBodySnippet(initial).catch(() => "");
      recordModelDiag({ ...diagStatusEntry, errorBody });
      // ultra 链路的 401 签名拒绝：重握手一次，再犯进 bypass（官方语义）。
      if (status === 401 && url.includes("/ultra")) {
        const apiKey =
          headerValue(init.headers, "authorization")?.replace(/^Bearer\s+/i, "").trim() ||
          headerValue(init.headers, "x-api-key")?.trim() ||
          "";
        if (apiKey) handleUltraSigningRejection(apiKey, errorBody);
      }
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
