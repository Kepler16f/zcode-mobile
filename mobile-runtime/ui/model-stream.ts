// 端侧模型流：直接对 Provider 配置里的 base URL 发 SSE 请求，不在手机上装 Node、也不起 CLI 进程。
//
// 为什么这一面可以自己写而不算"另起一套模型层"：请求形状不是我们发明的，它由 Provider 配置里的
// `api.type` 决定，而三种取值各自对应上游 `@zcode/adapters` 里的那个 AI SDK provider
// （model-execution.ts:355-371 的 toAiSdkProviderConfig 就是这张映射表）。这里做的是同一张表的
// 手写展开：URL 拼接规则、鉴权头、SSE 帧分隔都逐条对齐上游，而不是按"通用 Anthropic 客户端"的印象猜。
// 换成手写的代价是**没有工具调用**（P0 只要文本对话），收益是闭包里不出现 node:http/https/proxy-agent。
//
// 业务错误必须当成错误：z.ai / bigmodel 这一族网关在 HTTP 200 的 event-stream 里夹
// `{"success":false,"providerCode":3007,...}`，AI SDK 看不见它就把它当空补全交给上层，
// 最终报"模型返回空内容"（model-execution.ts:842-900 的判定就是这个原因）。
// 所以帧里只要命中 success===false 或非零 providerCode/error_code/code，或者 event: error，
// 这里直接抛，绝不把载荷交给渲染。
import type { ModelApiFormat } from "./provider-target.js";
import { mobileModelFetch } from "./model-transport.js";

export type { ModelApiFormat };

/**
 * 鉴权方式：端侧自己发 HTTP，所以"用哪个头带凭据"必须由配置说了算。
 *
 * 为什么不能一律 `Authorization: Bearer`：Azure 用 `api-key`、Google 用 `x-goog-api-key`、
 * 还有些网关把 Key 放在 query 里。默认塞 Bearer 等于给网关**同时**递两份凭据——严格网关
 * 直接拒（双认证），宽松网关取错那一份（拿 Bearer 里的 Key 去比 api-key，判无效）。
 */
export type ModelAuthMode =
  /** Anthropic 兼容网关：`x-api-key` 与 `Authorization: Bearer` 同时发（MiniMax 等依赖这个组合）。 */
  | "anthropic"
  | "bearer"
  | "x-api-key"
  | "api-key"
  | "x-goog-api-key"
  /** 完全不带凭据（Key 走 query 参数等其它通道）。 */
  | "none";

/** 认证头名 → 模式。用户显式配了哪一个，就只认哪一个（大小写不敏感）。 */
const AUTH_HEADER_MODES: ReadonlyArray<readonly [string, ModelAuthMode]> = [
  ["authorization", "bearer"],
  ["x-api-key", "x-api-key"],
  ["api-key", "api-key"],
  ["x-goog-api-key", "x-goog-api-key"],
];

/** 一次模型调用的落点：全部来自 Provider 配置快照，不接受 UI 传来的自由 URL。 */
export interface ModelTarget {
  apiFormat: ModelApiFormat;
  /** `config.api.baseUrl`，原样。 */
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  /** 鉴权方式。缺省时按已配置的认证头推断，推断不出再按 apiFormat 取默认。 */
  authMode?: ModelAuthMode;
  model: string;
  /** 设备标识：桌面把它写进 anthropic 请求的 `metadata.user_id`，端侧带同一个值。 */
  metadataUserId?: string;
  /** 用户选的思考档位（UI 选择器 → switchModelConfig → selection.options.reasoningLevel）。
   *  空/缺省 = 请求体不带任何 reasoning 字段（与 0.5.0 逐字节一致）。
   *  桌面的权威映射是 per-model 的 option-map CEL（optionSpecs.reasoningLevel.map → JSON merge
   *  patch）；端侧 view 里 map 缺失/为 "{}" 时退回内置表（见 buildRequest），表里没有的档位
   *  宁可不发也不猜一个必然 400 的字段。 */
  reasoningLevel?: string;
  /** 该模型声明的合法档位（view 的 optionSpecs.reasoningLevel.values）；声明了而 level 不在列内
   *  就不发——档位不生效的代价远小于整轮 400。 */
  reasoningValues?: readonly string[];
  /** 该模型声明的单轮输出上限（optionSpecs.maxOutputTokens.max）；agent 按它收紧默认预算。 */
  maxOutputTokensCap?: number;
  /** 模型声明的上下文窗口；没有声明时保持未知。 */
  contextWindow?: number;
  inputCapabilities?: { image?: boolean; pdf?: boolean; text?: boolean };
}

/**
 * 工具地基（Phase 2 前置，本轮只做协议层，不接回合循环）。
 * openai-chat-completions 与 anthropic-messages 都真带工具载荷（0.7.x 补齐 anthropic：
 * 请求侧 tools→input_schema、assistant tool_calls→tool_use 块、role=tool→user+tool_result 块；
 * 响应侧 content_block_start/input_json_delta 流式累加、非流式 message.content[] 摘取。
 * 装机症状"思考完说要开始工作就被截断"的端侧半因：anthropic 格式下请求从未声明过 tools，
 * 模型无工具可调只能 end_turn）。openai-responses 的 function_call 条目形态也已接上
 * （请求侧发 function 条目 tools，响应侧按 call_id 摘成 toolCalls）——
 * 没有 mock 验证过的形状不猜。
 */
export interface ModelToolCall {
  id: string;
  name: string;
  /** 模型产出的原始 JSON 字符串（增量拼完的样子）；调用方负责 parse 与容错。 */
  arguments: string;
}

export interface ModelToolSpec {
  name: string;
  description: string;
  /** JSON Schema（object 形态），原样进请求体的 function.parameters。 */
  parameters: Record<string, unknown>;
}

export interface ModelTurnMessage {
  /** "tool" 是工具结果回传；openai-chat-completions 原样发，anthropic-messages 折成 user+tool_result。 */
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  attachments?: Array<{ fileName: string; mime: string; dataBase64: string }>;
  /** assistant 消息带的工具调用（流式合并后的完整形状）。 */
  toolCalls?: ModelToolCall[];
  /** role==="tool" 时对应的调用 id。 */
  toolCallId?: string;
}

function attachmentText(attachment: { fileName: string; dataBase64: string }): string {
  const binary = atob(attachment.dataBase64);
  if (binary.length > 1024 * 1024) throw new ModelStreamError("model.attachmentTooLarge", `文本附件 ${attachment.fileName} 超过 1 MiB`);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return `[附件：${attachment.fileName}]\n${new TextDecoder("utf-8", { fatal: true }).decode(bytes)}`;
}

function attachmentBlocks(message: ModelTurnMessage, format: "chat" | "anthropic" | "responses"): unknown[] | null {
  if (!message.attachments?.length) return null;
  const blocks: unknown[] = [];
  if (message.content) blocks.push({ type: format === "responses" ? "input_text" : "text", text: message.content });
  for (const attachment of message.attachments) {
    const mime = attachment.mime.toLowerCase();
    if (mime.startsWith("text/") || mime === "application/json") {
      blocks.push({ type: format === "responses" ? "input_text" : "text", text: attachmentText(attachment) });
    } else if (mime.startsWith("image/")) {
      const dataUrl = `data:${mime};base64,${attachment.dataBase64}`;
      blocks.push(format === "anthropic"
        ? { type: "image", source: { type: "base64", media_type: mime, data: attachment.dataBase64 } }
        : format === "responses"
          ? { type: "input_image", image_url: dataUrl }
          : { type: "image_url", image_url: { url: dataUrl } });
    } else if (mime === "application/pdf") {
      const dataUrl = `data:application/pdf;base64,${attachment.dataBase64}`;
      blocks.push(format === "anthropic"
        ? { type: "document", source: { type: "base64", media_type: mime, data: attachment.dataBase64 }, title: attachment.fileName }
        : format === "responses"
          ? { type: "input_file", filename: attachment.fileName, file_data: dataUrl }
          : { type: "file", file: { filename: attachment.fileName, file_data: dataUrl } });
    } else {
      throw new ModelStreamError("model.attachmentUnsupported", `不支持附件类型：${attachment.mime}`);
    }
  }
  return blocks;
}

export interface ModelStreamUsage {
  inputTokens: number;
  outputTokens: number;
}

export class ModelStreamError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "ModelStreamError";
  }
}

const MAX_ERROR_BODY_CHARS = 8_192;
/** 空闲看门狗的两个上限（0.4.6：防"网关卡死把输入框永远禁用"）。0.5.1 放宽：
 *  高思考档的深度推理首帧可以远超 45s（装配大上下文 + 长链推理），45/30 会把
 *  "正在思考"误杀成"网关卡住"——装机表现就是"对话到一半被截断"。120s 首字节 /
 *  90s 帧间仍远小于"永远挂住"，防挂死语义保留；后台冻结另有专闸（见 fire 判定）。 */
const FIRST_BYTE_TIMEOUT_MS = 120_000;
const FRAME_IDLE_TIMEOUT_MS = 90_000;
/**
 * 看门狗"迟到即赦免"的判定改成**绝对迟到量**而不是倍数。
 *
 * 之前写的是「迟到超过 3 倍上限才赦免」，那是错的：页面被宿主冻结（切后台、锁屏）后回来，
 * 积压的 timer 会在「窗口 + 冻结时长」时触发——冻结 30–120 秒回来，迟到量只有 1–2 倍窗口，
 * 于是被当成"网关卡死"直接 abort，这一轮就此被掐断（用户报的就是"一锁屏/切后台工作流就没了"）。
 *
 * 正确的判据是：**JS 的 timer 只有在页面被冻结或主线程被长时间阻塞时才会晚点**。
 * 真的网关卡死发生在页面响应正常时，timer 准点响 → 照旧 abort。
 * 所以「迟到了」就重新计时（重新给满一窗），冻结多久都不会误杀；页面恢复后流真的死了，
 * 下一窗准点触发时照样收口。
 */
const IDLE_TIMER_LATE_TOLERANCE_MS = 1_000;
const ANTHROPIC_VERSION = "2023-06-01";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

// 上游只对 anthropic 做这一步（normalizeAnthropicBaseURL，model-execution.ts:411-434）：
// AI SDK 的 anthropic provider 只在 baseURL 后面接 `/messages`，所以网关根必须自己补上 `/v1`。
function anthropicMessagesUrl(baseUrl: string): string {
  const trimmed = trimTrailingSlash(baseUrl);
  return /\/v1$/iu.test(trimmed) ? `${trimmed}/messages` : `${trimmed}/v1/messages`;
}

function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/** 用户配的头算不算"配了"：空白值等于没配（否则会顶掉默认值又递不出凭据）。 */
function hasConfiguredHeader(headers: Record<string, string> | undefined, name: string): boolean {
  const value = headerValue(headers, name);
  return value !== undefined && value.trim() !== "";
}

/** 该模式要带哪几个认证头。anthropic 是两条腿（x-api-key + Bearer），其余各一条。 */
function authHeadersFor(mode: ModelAuthMode, apiKey: string): Array<{ name: string; value: string }> {
  if (apiKey.trim() === "") return [];
  switch (mode) {
    case "anthropic":
      return [
        { name: "x-api-key", value: apiKey },
        { name: "authorization", value: `Bearer ${apiKey}` },
      ];
    case "bearer":
      return [{ name: "authorization", value: `Bearer ${apiKey}` }];
    case "x-api-key":
      return [{ name: "x-api-key", value: apiKey }];
    case "api-key":
      return [{ name: "api-key", value: apiKey }];
    case "x-goog-api-key":
      return [{ name: "x-goog-api-key", value: apiKey }];
    case "none":
      return [];
  }
}

/**
 * 鉴权方式推断。**唯一口径**：provider-target 解析时算一次落进 target，
 * buildHeaders 直接用；这里再兜一次底，好让直接构造 ModelTarget 的调用方（自检、子代理）
 * 得到同样的结果——两处各算一套必然漂移。
 *
 * 优先级：显式 authMode → 用户已配的认证头 → apiFormat 默认。
 * 推断顺序与 AUTH_HEADER_MODES 一致：authorization → x-api-key → api-key → x-goog-api-key。
 */
export function inferAuthMode(
  headers: Record<string, string> | undefined,
  apiFormat: ModelApiFormat,
): ModelAuthMode {
  const configured = AUTH_HEADER_MODES.find(([name]) => hasConfiguredHeader(headers, name))?.[1];
  if (configured) return configured;
  return apiFormat === "anthropic-messages" ? "anthropic" : "bearer";
}

/**
 * 鉴权头与上游一致：Anthropic 兼容网关同时读 `x-api-key` 和 `Authorization: Bearer`，
 * 而 Coding Plan 的凭据是 `apiKey.secretKey` 这种带点的复合格式，只有 Bearer 那条读得通，
 * 所以两条都发（withAnthropicAuthorizationHeader + createAnthropic({apiKey}) 在桌面上也是这么并存的）。
 * 用户自己配的 `config.api.headers` 优先级最高——显式配置不该被我们盖掉。
 */
function buildHeaders(target: ModelTarget): Record<string, string> {
  const userHeaders = target.headers ?? {};
  // 显式 authMode 优先；没配就从用户的认证头推断；再没有才按 apiFormat 取默认。
  const mode: ModelAuthMode = target.authMode ?? inferAuthMode(userHeaders, target.apiFormat);

  // 小写名 → 值。键一律小写：HTTP 头名本身大小写不敏感，而 fetch 规范会把同名不同大小写的
  // 两个头**合并**成 "a, b"（值坏掉），所以必须在发出前就归一。
  const out = new Map<string, string>();
  out.set("content-type", "application/json");
  if (target.apiFormat === "anthropic-messages") {
    // 协议头：版本可由用户在 api.headers 里覆盖（大小写不敏感），没配才用默认。
    out.set("anthropic-version", ANTHROPIC_VERSION);
    // api.anthropic.com 对浏览器源请求要求这个自报家门头（会拒没有它的 CORS 请求）；
    // anthropic 兼容池子忽略它，无副作用——"兼容 v1/messages" 的两条腿之一。
    out.set("anthropic-dangerous-direct-browser-access", "true");
  }
  // 认证头：只在有 Key、且用户没自己配认证头时才注入（避免双认证被网关拒）。
  // 用户配了**任意**认证头 → 整套默认认证头都不注入：默认那套（尤其 anthropic 的
  // x-api-key + Bearer 两条腿）跟用户那份叠在一起就是双认证，严格网关直接拒，
  // 宽松网关取错那一份判凭据无效。用户既然显式配了，以他的为准。
  // 桌面 withAnthropicAuthorizationHeader 是"按同名头让位"（只让 authorization 那一条）；
  // 端侧要覆盖的协议族更杂（Azure api-key / Google x-goog-api-key / query 鉴权），
  // 统一按"用户配了认证头就整套让位"处理，避免留下第二条腿变成双认证。
  const userConfiguredAuth = AUTH_HEADER_MODES.some(([name]) => hasConfiguredHeader(userHeaders, name));
  if (!userConfiguredAuth) {
    for (const auth of authHeadersFor(mode, target.apiKey)) {
      out.set(auth.name, auth.value);
    }
  }
  // 用户显式配置优先，且大小写不敏感：同名（不论大小写）用用户的值覆盖默认值。
  for (const [name, value] of Object.entries(userHeaders)) {
    if (typeof value !== "string" || value.trim() === "") continue;
    out.set(name.toLowerCase(), value);
  }
  return Object.fromEntries(out);
}

/**
 * 这个落点最终打出去的 URL。**规则必须只有一处**：诊断文案里写的 URL 和真发出去的 URL 一旦
 * 是两个函数算出来的，"测试连接"就变成误导源（这一族 bug 见 §7 R20）。
 */
export function modelRequestUrl(
  target: Pick<ModelTarget, "apiFormat" | "baseUrl">,
): string {
  return target.apiFormat === "anthropic-messages"
    ? anthropicMessagesUrl(target.baseUrl)
    : target.apiFormat === "openai-responses"
      ? `${trimTrailingSlash(target.baseUrl)}/responses`
      : `${trimTrailingSlash(target.baseUrl)}/chat/completions`;
}

// ── 思考档位 → 请求体字段（0.5.1）──
// 桌面的权威映射是 per-model 的 option-map CEL（optionSpecs.reasoningLevel.map，一个 JSON merge
// patch 程序，"Option Map 是 reasoning 的唯一请求字段权威"）。端侧 view 里 map 缺失/为 "{}"
// （bundled 基线就是这样）时没有权威可读，这里退回一张**显式**表：按档位值的形状分三族，
// 每族只发该协议的标准字段。表覆盖不了的值原样不发——宁可档位不生效，不发必然 400 的字段。
const OFF_LEVELS = new Set(["disabled", "none", "off", "false", "nothink", "no-think", "no_think"]);
const ON_LEVELS = new Set(["enabled", "on", "true"]);
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** anthropic 的 thinking.budget_tokens 按档位给预算：必须在 (1024, max_tokens) 区间内。 */
const ANTHROPIC_THINKING_BUDGET: Record<string, number> = {
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
  max: 32768,
};

function isEffortLevel(level: string): boolean {
  return (EFFORT_ORDER as readonly string[]).includes(level);
}

/**
 * 档位 → 请求体增量。返回 null 表示这个档位在这个格式上没有可发字段（不发）。
 * level 为空 = 用户没选 → 一律 null（请求体与未接此功能前逐字节一致）。
 */
export function reasoningBodyFields(
  target: Pick<ModelTarget, "apiFormat" | "reasoningLevel" | "reasoningValues">,
): Record<string, unknown> | null {
  const level = target.reasoningLevel?.trim().toLowerCase();
  if (!level) return null;
  // 模型声明了合法档位而这个值不在列内：不发（发出去就是 400）。
  if (target.reasoningValues && target.reasoningValues.length > 0 && !target.reasoningValues.includes(level)) {
    return null;
  }
  if (target.apiFormat === "openai-chat-completions") {
    // GLM 家族（zai/bigmodel）的开关字段是 thinking.type；档位型（low/…/max）走 OpenAI 标准
    // reasoning_effort。两族互斥，不会同时发。
    if (OFF_LEVELS.has(level)) return { thinking: { type: "disabled" } };
    if (ON_LEVELS.has(level)) return { thinking: { type: "enabled" } };
    if (isEffortLevel(level)) return { reasoning_effort: level };
    return null;
  }
  if (target.apiFormat === "openai-responses") {
    if (OFF_LEVELS.has(level)) return null; // responses 没有"显式关"字段，缺省即默认
    if (isEffortLevel(level)) return { reasoning: { effort: level } };
    return null;
  }
  if (target.apiFormat === "anthropic-messages") {
    if (OFF_LEVELS.has(level)) return { thinking: { type: "disabled" } };
    if (ON_LEVELS.has(level)) return { thinking: { type: "enabled", budget_tokens: 4096 } };
    const budget = isEffortLevel(level) ? ANTHROPIC_THINKING_BUDGET[level] : undefined;
    if (budget) return { thinking: { type: "enabled", budget_tokens: budget } };
    return null;
  }
  return null;
}

/** OpenAI 形工具声明 → Anthropic tools（name/description/input_schema）。缺名条目丢弃，别给上游 400 的机会。 */
function toAnthropicTools(tools: ModelToolSpec[]): unknown[] {
  return tools
    .filter((t) => typeof t?.name === "string" && t.name.length > 0)
    .map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      input_schema: t.parameters && typeof t.parameters === "object" ? t.parameters : { type: "object", properties: {} },
    }));
}

/**
 * Anthropic 消息映射（工具链路）：
 *  - assistant 带 toolCalls → content 块序列（text 在前、tool_use 在后；input 必须是对象，
 *    参数 JSON 残缺就空对象兜底——半截 arguments 进 history 好过整请求 400）；
 *  - role=tool → **user** 消息里的 tool_result 块（Anthropic 协议如此）；连续多条工具结果
 *    合并进同一个 user 消息的块数组，与官方 SDK 的回放形态一致。
 */
function toAnthropicMessages(msgs: ModelTurnMessage[]): unknown[] {
  const out: Array<{ role: string; content: unknown }> = [];
  for (const m of msgs) {
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content };
      const last = out[out.length - 1];
      const lastIsToolResults =
        last?.role === "user" &&
        Array.isArray(last.content) &&
        (last.content as Array<{ type?: string }>).every((b) => b?.type === "tool_result");
      if (lastIsToolResults) (last!.content as unknown[]).push(block);
      else out.push({ role: "user", content: [block] });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) {
        let input: unknown = {};
        try {
          const parsed = JSON.parse(tc.arguments || "{}");
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed;
        } catch {
          // 残缺 JSON：空对象兜底（见上）。
        }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    out.push({ role: m.role, content: attachmentBlocks(m, "anthropic") ?? m.content });
  }
  return out;
}

function buildRequest(
  target: ModelTarget,
  messages: ModelTurnMessage[],
  maxOutputTokens: number,
  tools?: ModelToolSpec[],
): { url: string; headers: Record<string, string>; body: string } {
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      const mime = attachment.mime.toLowerCase();
      const unsupported = mime.startsWith("image/") ? target.inputCapabilities?.image === false
        : mime === "application/pdf" ? target.inputCapabilities?.pdf === false
          : target.inputCapabilities?.text === false;
      if (unsupported) throw new ModelStreamError("model.attachmentUnsupported", `当前模型不支持附件 ${attachment.fileName}（${attachment.mime}）`);
    }
  }
  const url = modelRequestUrl(target);

  // 思考档位（0.5.1）：只在用户显式选了档位时才进请求体。
  // Anthropic 语义：思考与正文**同计入** max_tokens（硬约束 budget < max_tokens）。旧做法是把
  // 超出的档位预算压到 max_tokens-1024——思考吃光正文额度：高档位下正文几百 token 就被
  // finish_reason=length 拦腰截，模型还会把没说完的思考当正文吐出来（装机症状：思考串正文＋
  // 会话半截断）。改为扩总包优先：正文保住本轮 maxOutputTokens，思考预算在其上叠加，模型声明
  // 了单轮上限就以其为顶；实在扩不进（无上限声明且档位也塞不下）才回退压预算（原逻辑）。
  const reasoningRaw = reasoningBodyFields(target);
  let reasoning: Record<string, unknown> | null = reasoningRaw;
  let anthropicMaxTokens = maxOutputTokens;
  if (reasoning && target.apiFormat === "anthropic-messages") {
    const thinking = reasoning.thinking as { type?: string; budget_tokens?: number } | undefined;
    const budget = thinking?.budget_tokens;
    if (budget !== undefined && budget >= maxOutputTokens) {
      const wanted = budget + maxOutputTokens;
      const total = target.maxOutputTokensCap ? Math.min(wanted, target.maxOutputTokensCap) : wanted;
      if (total > budget) {
        anthropicMaxTokens = total;
      } else {
        const clamped = Math.max(1024, maxOutputTokens - 1024);
        reasoning = clamped < maxOutputTokens
          ? { ...reasoning, thinking: { ...thinking, budget_tokens: clamped } }
          : null; // 预算塞不下就不发——半截的 thinking 配置比没有更糟
      }
    }
  }
  const reasoningSpread = reasoning ?? {};

  // 只有 anthropic 把 system 从 messages 里拆出去；另外两种留在消息序列里，与各自 SDK 的默认行为一致。
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");

  // 只有 openai-chat-completions 认工具那两种消息形状（assistant 带 tool_calls、role=tool 回结果）；
  // 另两种格式没有 mock 验证过它们的工具载荷（anthropic 是 content_block、responses 是 function_call 条目），
  // 映射保持 content-only，一行不猜 —— 等真接循环时按同一纪律逐格式补，而不是现在把没测的形状写进去。
  const toChatMessage = (m: ModelTurnMessage) => {
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content };
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    return { role: m.role, content: attachmentBlocks(m, "chat") ?? m.content };
  };

  const toResponsesItems = (m: ModelTurnMessage): unknown[] => {
    if (m.role === "tool") return [{ type: "function_call_output", call_id: m.toolCallId ?? "", output: m.content }];
    if (m.role === "assistant" && m.toolCalls?.length) {
      return [
        ...(m.content ? [{ role: "assistant", content: m.content }] : []),
        ...m.toolCalls.map((call) => ({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments })),
      ];
    }
    return [{ role: m.role, content: attachmentBlocks(m, "responses") ?? m.content }];
  };

  const body =
    target.apiFormat === "anthropic-messages"
      ? {
          model: target.model,
          max_tokens: anthropicMaxTokens,
          stream: true,
          ...(system ? { system } : {}),
          ...(target.metadataUserId
            ? { metadata: { user_id: target.metadataUserId } }
            : {}),
          // 0.7.x 工具载荷补齐：不声明 tools，模型就永远只能"说要开始工作"然后 end_turn
          // （装机截断症状的端侧半因）。
          ...(tools && tools.length > 0 ? { tools: toAnthropicTools(tools) } : {}),
          ...reasoningSpread,
          messages: toAnthropicMessages(rest),
        }
      : target.apiFormat === "openai-responses"
        ? {
            model: target.model,
            stream: true,
            max_output_tokens: maxOutputTokens,
            ...reasoningSpread,
            input: messages.flatMap(toResponsesItems),
            ...(tools?.length ? { tools: tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false })) } : {}),
          }
        : {
            model: target.model,
            stream: true,
            max_tokens: maxOutputTokens,
            stream_options: { include_usage: true },
            messages: messages.map(toChatMessage),
            // tools 不传时整个键缺席（不是 tools: []）——无工具路径的请求体逐字节不变。
            ...(tools && tools.length > 0
              ? {
                  tools: tools.map((t) => ({
                    type: "function",
                    function: { name: t.name, description: t.description, parameters: t.parameters },
                  })),
                }
              : {}),
            ...reasoningSpread,
            // 池子契约（0.7.5）：档位思考存在时随请求声明应用内设置的单轮输出上限，
            // 池子给思考扩总包时必须封顶在它之下（用户点名"设置了上限就跟随上限"）。
            // 只与 reasoning_effort 同现——不给非池端点凭空塞一个未知字段。
            ...(typeof (reasoningSpread as { reasoning_effort?: unknown }).reasoning_effort === "string" &&
            target.maxOutputTokensCap
              ? { max_output_tokens_hard_cap: target.maxOutputTokensCap }
              : {}),
          };

  return { url, headers: buildHeaders(target), body: JSON.stringify(body) };
}

// ── 业务错误载荷 ──

function toCodeString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function isNonZeroCode(code: string | null): boolean {
  if (!code) return false;
  const numeric = Number(code);
  return Number.isFinite(numeric) ? numeric !== 0 : code.toLowerCase() !== "ok";
}

interface BusinessError {
  code: string | null;
  message: string;
}

/** 载荷里找业务码。顺序与上游一致：providerCode 优先，只有它缺席才退回 code。 */
function detectBusinessError(payload: unknown): BusinessError | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const nested =
    typeof record.error === "object" && record.error !== null
      ? (record.error as Record<string, unknown>)
      : null;
  const source = nested ? { ...record, ...nested } : record;

  const code =
    toCodeString(source.providerCode) ??
    toCodeString(source.error_code) ??
    toCodeString(source.code);
  const failedBySuccess = source.success === false;
  // anthropic 的错误形状（流内 data 帧或 4xx body）：{"type":"error","error":{"type":"…","message":"…"}}——
  // 没有任何 code 字段，靠 type==="error" 认它；不认的话错误帧被当空 delta，最终报"模型返回空"。
  const anthropicError =
    record.type === "error" && nested && typeof nested.message === "string" ? true : false;
  if (!failedBySuccess && !isNonZeroCode(code) && !anthropicError) return null;
  const message =
    (typeof source.message === "string" && source.message) ||
    (typeof source.msg === "string" && source.msg) ||
    (typeof source.error_message === "string" && source.error_message) ||
    (anthropicError ? `anthropic 错误（${String(nested?.type ?? "unknown")}）` : "") ||
    `上游返回业务错误（code=${code ?? "unknown"}）`;
  return { code: code ?? (anthropicError ? String(nested?.type ?? "error") : null), message };
}

function businessErrorMessage(status: number, text: string): string {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 不是 JSON 就走下面的原文截断。
  }
  if (parsed !== null) {
    const detected = detectBusinessError(parsed);
    if (detected) return detected.message;
    // OpenAI / Anthropic 兼容网关在 4xx、5xx 上回的是 `{"error":{"message":"…"}}`：
    // 那里没有业务码，所以 detectBusinessError 正确地判它"不是业务错误"。
    // 不认这一形的话，屏幕上就是一整串 JSON 原文 —— 手机上读到它的人会以为是端上坏了。
    const nested = (parsed as { error?: { message?: unknown } }).error;
    const message = typeof nested?.message === "string" ? nested.message.trim() : "";
    if (message) return message;
  }
  const snippet = text.trim().slice(0, 300);
  return snippet || `模型服务返回 HTTP ${status}`;
}

async function readLimitedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        text += decoder.decode();
        break;
      }
      text += decoder.decode(chunk.value, { stream: true });
      if (text.length > MAX_ERROR_BODY_CHARS) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return text;
}

// ── SSE ──

// 帧分隔：\\r\\n\\r\\n、\\n\\n、\\r\\r 三种都要认。只按 \\n\\n 切会在 CRLF 服务端上把
// 每一帧都留在缓冲里，直到流结束才一次性吐出来——看起来就是"模型不流式、最后整段蹦出来"。
const FRAME_SPLIT = /\r\n\r\n|\n\n|\r\r/;

interface SseFrame {
  eventName: string | null;
  data: string[];
}

function parseFrame(raw: string): SseFrame {
  const data: string[] = [];
  let eventName: string | null = null;
  for (const line of raw.split(/\r\n|\n|\r/)) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /u, ""));
    else if (line.startsWith("event:")) eventName = line.slice(6).trim();
  }
  return { eventName, data };
}

function extractText(apiFormat: ModelApiFormat, payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const record = payload as Record<string, unknown>;
  if (apiFormat === "anthropic-messages") {
    if (record.type === "content_block_delta") {
      const delta = record.delta as { type?: string; text?: string } | undefined;
      return delta?.type === "text_delta" && typeof delta.text === "string" ? delta.text : "";
    }
    // 非流式整包 message（池子忽略 stream:true 时就是这个形状，8899 实测）：
    // content[] 里 text 块拼接为正文；thinking 块是推理内容，不进正文。
    if (record.type === "message" && Array.isArray(record.content)) {
      return (record.content as Array<{ type?: unknown; text?: unknown }>)
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("");
    }
    return "";
  }
  if (apiFormat === "openai-responses") {
    if (record.type === "response.output_text.delta" && typeof record.delta === "string") return record.delta;
    if (Array.isArray(record.output)) {
      return (record.output as Array<{ type?: string; content?: Array<{ type?: string; text?: unknown }> }>)
        .flatMap((item) => item.type === "message" && Array.isArray(item.content) ? item.content : [])
        .filter((part) => part.type === "output_text" && typeof part.text === "string")
        .map((part) => part.text as string).join("");
    }
    return "";
  }
  const choices = record.choices;
  if (Array.isArray(choices)) {
    const first = choices[0] as
      | { delta?: { content?: unknown }; message?: { content?: unknown } }
      | undefined;
    const content = first?.delta?.content ?? first?.message?.content;
    return typeof content === "string" ? content : "";
  }
  // 少数 OpenAI 兼容网关不走 choices，直接在顶层给 content。
  return typeof record.content === "string" ? record.content : "";
}

/** 收尾原因：openai 在 choices[].finish_reason；anthropic 在 message_delta.stop_reason；
 *  responses 在 response.completed 的 status/incomplete_details。取不到就 null（不猜）。 */
/**
 * 思考增量（0.7.3，用户点名"思考过程没有跟桌面一样显示，全部输出为回复"）。
 * 桌面把思考独立成 reasoning 行（可折叠"深度思考"卡），正文与思考是两条流；端侧此前
 * extractText 只认正文，GLM 经池子回 `delta.reasoning_content` 要么被丢、要么在旧网关里
 * 混进 content——两种都不是桌面的显示形状。这里单独提出思考流，交给上层落成 reasoning 行。
 *   - openai chat-completions：`choices[0].delta.reasoning_content`（DeepSeek/GLM/Kimi 方言）；
 *   - anthropic：`content_block_delta.delta.type === "thinking_delta"` 的 `delta.thinking`；
 *   - 非流式整包：message.content[] 里 type==="thinking" 的块（thinking 字段）。
 * 正文（extractText）绝不重复这段：thinking 块从一开始就不在 extractText 的取文分支里。
 */
function extractReasoning(apiFormat: ModelApiFormat, payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const record = payload as Record<string, unknown>;
  if (apiFormat === "anthropic-messages") {
    if (record.type === "content_block_delta") {
      const delta = record.delta as { type?: string; thinking?: unknown } | undefined;
      return delta?.type === "thinking_delta" && typeof delta.thinking === "string" ? delta.thinking : "";
    }
    if (record.type === "message" && Array.isArray(record.content)) {
      return (record.content as Array<{ type?: unknown; thinking?: unknown }>)
        .filter((block) => block?.type === "thinking" && typeof block.thinking === "string")
        .map((block) => block.thinking as string)
        .join("");
    }
    return "";
  }
  if (apiFormat === "openai-responses") return "";
  const choices = record.choices;
  if (Array.isArray(choices)) {
    const delta = (choices[0] as { delta?: { reasoning_content?: unknown } } | undefined)?.delta;
    return typeof delta?.reasoning_content === "string" ? delta.reasoning_content : "";
  }
  return "";
}

function extractFinishReason(apiFormat: ModelApiFormat, payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (apiFormat === "anthropic-messages") {
    if (record.type !== "message_delta") {
      // 非流式整包 message：stop_reason 在顶层。
      if (record.type === "message" && typeof record.stop_reason === "string") return record.stop_reason;
      return null;
    }
    const delta = record.delta as { stop_reason?: unknown } | undefined;
    return typeof delta?.stop_reason === "string" ? delta.stop_reason : null;
  }
  if (apiFormat === "openai-responses") {
    // response.completed 事件带 response.status；截断时 incomplete_details.reason = "max_output_tokens"。
    const response = record.response as
      | { status?: unknown; incomplete_details?: { reason?: unknown } | null }
      | undefined;
    if (!response) {
      const details = record.incomplete_details as { reason?: unknown } | null | undefined;
      if (details?.reason === "max_output_tokens") return "length";
      return typeof record.status === "string" ? record.status : null;
    }
    const reason = response.incomplete_details?.reason;
    if (typeof reason === "string" && reason) return reason === "max_output_tokens" ? "length" : reason;
    return typeof response.status === "string" ? response.status : null;
  }
  // chat-completions：choices[].finish_reason（流里逐帧带，取最后一个非空的）。
  const choices = record.choices as Array<{ finish_reason?: unknown }> | undefined;
  const finish = choices?.[0]?.finish_reason;
  return typeof finish === "string" && finish ? finish : null;
}

function extractUsage(apiFormat: ModelApiFormat, payload: unknown): Partial<ModelStreamUsage> | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  // Anthropic 流的输入和输出分别位于 message_start.message.usage 与
  // message_delta.usage；Responses 流的用量位于 response.completed.response.usage。
  // 非流式响应则直接放在顶层 usage。只取实际给出的字段，避免后续帧清零先前用量。
  const message = record.message as Record<string, unknown> | undefined;
  const response = record.response as Record<string, unknown> | undefined;
  const rawUsage = apiFormat === "anthropic-messages" && record.type === "message_start"
    ? message?.usage
    : apiFormat === "openai-responses" && response?.usage
      ? response.usage
      : record.usage;
  const usage = rawUsage as
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      }
    | undefined;
  if (!usage) return null;
  // Anthropic（包括 MiniMax 兼容接口）的 input_tokens 只含未命中缓存部分。
  // 缓存命中的提示词仍占上下文；遗漏它会把长会话显示为每次仅增加1~几token。
  const input = usage.prompt_tokens ?? (typeof usage.input_tokens === "number"
    ? usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
    : undefined);
  const output = usage.completion_tokens ?? usage.output_tokens;
  const result: Partial<ModelStreamUsage> = {};
  if (typeof input === "number" && Number.isFinite(input) && input >= 0) result.inputTokens = input;
  if (typeof output === "number" && Number.isFinite(output) && output >= 0) result.outputTokens = output;
  return Object.keys(result).length ? result : null;
}

/** 非流式 JSON 载荷里 OpenAI 的一次性 tool_calls（`choices[0].message.tool_calls`，已是完整形状）。 */
function chatToolCallsFromJson(payload: Record<string, unknown>): ModelToolCall[] {
  const choices = payload.choices;
  if (!Array.isArray(choices)) return [];
  const message = (choices[0] as { message?: { tool_calls?: unknown } } | undefined)?.message;
  const calls = message?.tool_calls;
  if (!Array.isArray(calls)) return [];
  const out: ModelToolCall[] = [];
  for (const raw of calls) {
    if (typeof raw !== "object" || raw === null) continue;
    const c = raw as { id?: string; function?: { name?: string; arguments?: string } };
    if (!c.function?.name) continue; // 没有函数名的调用项不完整，收下只会让下游拿到半条。
    out.push({ id: c.id ?? "", name: c.function.name, arguments: c.function.arguments ?? "" });
  }
  return out;
}

export interface ModelStreamResult {
  text: string;
  /** 思考流全文（0.7.3）：openai 的 reasoning_content / anthropic 的 thinking_delta 累加。
   *  与 text 互斥不重不漏——正文分支取不到它，思考分支也进不了正文。上层落成 reasoning 行。 */
  reasoning: string;
  usage: ModelStreamUsage | null;
  /** openai-chat-completions 与 anthropic-messages 都会填；流式按 index/块号合并后的完整调用列表。 */
  toolCalls: ModelToolCall[];
  /** 收尾原因（openai: finish_reason / anthropic: stop_reason）。"length" = 达到输出上限被截断
   *  ——上层据此如实标注，而不是让半截回答冒充完整回答（0.5.1 截断问题的可见化）。 */
  finishReason?: string | null;
  /** 流被**干净关闭但没发任何收尾帧**（[DONE]/finish_reason/message_stop/…）：真截断。
   *  网关/代理空闲超时把 SSE 掐了就是这个形状——read() 正常 done，没有错误可抛。 */
  truncated?: boolean;
}

/**
 * 一条 SSE 帧里 OpenAI 的 `delta.tool_calls`：`[{index, id?, function:{name?, arguments?}}]`。
 * id/name 只在首帧给、arguments 分多帧增量拼——按 index 累加进 `acc`，返回是否命中了工具帧
 * （命中就不该再走文本 delta 那条：同一帧可能既有 content 又有 tool_calls，两者不互斥，故不 return 提前退出）。
 * 这里只认 chat-completions 的形状；anthropic 见 accumulateAnthropicToolCalls，responses 仍未接（不猜）。
 */
function accumulateChatToolCalls(
  payload: Record<string, unknown>,
  acc: Map<number, ModelToolCall>,
): boolean {
  const choices = payload.choices;
  if (!Array.isArray(choices)) return false;
  const delta = (choices[0] as { delta?: { tool_calls?: unknown } } | undefined)?.delta;
  const calls = delta?.tool_calls;
  if (!Array.isArray(calls) || calls.length === 0) return false;
  for (const raw of calls) {
    if (typeof raw !== "object" || raw === null) continue;
    const c = raw as {
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    };
    const index = typeof c.index === "number" ? c.index : 0;
    const prev = acc.get(index) ?? { id: "", name: "", arguments: "" };
    if (typeof c.id === "string") prev.id = c.id;
    if (typeof c.function?.name === "string") prev.name = c.function.name;
    if (typeof c.function?.arguments === "string") prev.arguments += c.function.arguments;
    acc.set(index, prev);
  }
  return true;
}

/**
 * Anthropic 流的工具载荷：id/name 在 content_block_start（type=tool_use，含完整块索引），
 * arguments 由后续 input_json_delta.partial_json 逐帧拼接——键用 Anthropic 的 content block
 * index（thinking=0、text=1、tool_use=2…），与 OpenAI 的 0 基序号不同但同一条流内自洽，
 * flushToolCalls 按数值序输出即是块序。
 */
function accumulateAnthropicToolCalls(
  payload: Record<string, unknown>,
  acc: Map<number, ModelToolCall>,
): void {
  const index = typeof payload.index === "number" ? payload.index : 0;
  if (payload.type === "content_block_start") {
    const b = payload.content_block as { type?: string; id?: string; name?: string } | undefined;
    if (b?.type === "tool_use") {
      acc.set(index, { id: b.id ?? "", name: b.name ?? "", arguments: "" });
    }
    return;
  }
  if (payload.type === "content_block_delta") {
    const d = payload.delta as { type?: string; partial_json?: unknown } | undefined;
    if (d?.type !== "input_json_delta" || typeof d.partial_json !== "string") return;
    const prev = acc.get(index) ?? { id: "", name: "", arguments: "" };
    prev.arguments += d.partial_json;
    acc.set(index, prev);
  }
}

/** Responses 的 call_id 与 item id 是不同概念；回传结果必须使用 call_id。 */
function accumulateResponsesToolCalls(payload: Record<string, unknown>, acc: Map<number, ModelToolCall>): void {
  const index = typeof payload.output_index === "number" ? payload.output_index : 0;
  const item = payload.item as { type?: string; call_id?: string; name?: string; arguments?: string } | undefined;
  if ((payload.type === "response.output_item.added" || payload.type === "response.output_item.done") && item?.type === "function_call") {
    const previous = acc.get(index) ?? { id: "", name: "", arguments: "" };
    acc.set(index, {
      id: item.call_id ?? previous.id,
      name: item.name ?? previous.name,
      arguments: item.arguments ?? previous.arguments,
    });
  } else if (payload.type === "response.function_call_arguments.delta" && typeof payload.delta === "string") {
    const previous = acc.get(index) ?? { id: "", name: "", arguments: "" };
    previous.arguments += payload.delta;
    acc.set(index, previous);
  } else if (payload.type === "response.function_call_arguments.done" && typeof payload.arguments === "string") {
    const previous = acc.get(index) ?? { id: "", name: "", arguments: "" };
    previous.arguments = payload.arguments;
    if (typeof payload.name === "string") previous.name = payload.name;
    acc.set(index, previous);
  }
}

function responsesToolCallsFromJson(payload: Record<string, unknown>): ModelToolCall[] {
  if (!Array.isArray(payload.output)) return [];
  return payload.output.flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const call = item as { type?: string; call_id?: string; name?: string; arguments?: string };
    return call.type === "function_call" && call.call_id && call.name
      ? [{ id: call.call_id, name: call.name, arguments: call.arguments ?? "" }]
      : [];
  });
}

/** 非流式整包 message（池子忽略 stream:true 的形状）：content[] 里的 tool_use 块。 */
function anthropicToolCallsFromMessage(payload: Record<string, unknown>): ModelToolCall[] {
  if (payload.type !== "message" || !Array.isArray(payload.content)) return [];
  const out: ModelToolCall[] = [];
  for (const block of payload.content as Array<{
    type?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }>) {
    if (block?.type !== "tool_use" || !block.name) continue;
    out.push({ id: block.id ?? "", name: block.name, arguments: JSON.stringify(block.input ?? {}) });
  }
  return out;
}

/**
 * 发一次流式补全，把增量文本逐个交给 onDelta。
 * 中断（signal）与上游错误都以抛错结束；抛错时 onDelta 已经交出去的那部分文本由调用方负责收口
 * ——agent.ts 把它落成 state:"interrupted" 的行，而不是假装什么都没发生。
 */
export async function streamModelCompletion(params: {
  target: ModelTarget;
  messages: ModelTurnMessage[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
  onDelta: (text: string) => void;
  /** 思考流回调（0.7.3）：与 onDelta 平行，逐帧交出 reasoning 增量。不传就当没有（旧调用点不破）。 */
  onReasoning?: (text: string) => void;
  /** 工具地基：openai-chat-completions 与 anthropic-messages 会带进请求体；responses 忽略。 */
  tools?: ModelToolSpec[];
  /** 看门狗两个上限的注入点（默认用常量）。单测拿毫秒级即可确定性验证"卡死→报错"，不等 45 秒。 */
  firstByteTimeoutMs?: number;
  frameIdleTimeoutMs?: number;
}): Promise<ModelStreamResult> {
  const { target, onDelta } = params;
  const request = buildRequest(target, params.messages, params.maxOutputTokens ?? 4096, params.tools);

  // 空闲看门狗（0.4.6，装机反馈"输入框有时自己卡住、要新建对话才能用"）：网关连上后不吐字节
  // （慢查询、代理挂起、SSE 半开）时，reader.read() 会永远挂着、runTurn 永不 settle，于是
  // session.run 一直非空 → inputRouting 恒 reject → composer 永久禁用，用户只能开新会话。
  // 这里给"等首字节"和"两帧之间"各设上限：超时就 abort 掉 fetch（reader.read() 随之 reject），
  // 抛一个带 model.streamIdle 的 ModelStreamError 让上层如实收口（composer 立刻恢复）。
  // 用内部 AbortController 而不是复用 params.signal：params.signal 是"用户点了停止"，
  // 那条路 runTurn 会 settle 成 interrupted；看门狗是"网关卡死"，必须走 failed 让错误上屏。
  const idleAbort = new AbortController();
  const firstByteMs = params.firstByteTimeoutMs ?? FIRST_BYTE_TIMEOUT_MS;
  const frameIdleMs = params.frameIdleTimeoutMs ?? FRAME_IDLE_TIMEOUT_MS;
  let idleTimedOut = false;
  let lastArmedMs = firstByteMs;
  /** 本次计时的起点（armIdle 时）。fire 时用它判"是真超时还是后台冻结导致的迟到"。 */
  let armedAtMs = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdle = (ms: number) => {
    lastArmedMs = ms;
    armedAtMs = Date.now();
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const elapsed = Date.now() - armedAtMs;
      const hidden =
        typeof document !== "undefined" && document.visibilityState === "hidden";
      // 迟到即赦免（0.5.1，用户点名"后台不动回来还是按原来那样原地继续"）：Android WebView
      // 切后台/锁屏会冻结 setTimeout，回前台后积压的 timer 立刻触发——这不是网关卡死，
      // 是宿主把钟停了。真死锁发生在前台：timer 准点响，那才走到 abort。
      // 判据是「有没有迟到」而不是「迟到多少倍」：锁屏几十秒回来也是迟到，照样赦免。
      if (hidden || elapsed > ms + IDLE_TIMER_LATE_TOLERANCE_MS) {
        armIdle(ms);
        return;
      }
      idleTimedOut = true;
      idleAbort.abort();
    }, ms);
  };
  const clearIdle = () => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const idleError = () =>
    new ModelStreamError(
      "model.streamIdle",
      `模型在 ${Math.round(lastArmedMs / 1000)} 秒内没有响应（网关卡住了）。本轮已终止，可直接重发。`,
    );
  // 合并信号：外层 abort（用户停止）与看门狗 abort 都能掐断 fetch/body；
  // AbortSignal.any 缺失（极老宿主）时退回外层信号——那种情况下看门狗仅靠循环内检测兜底。
  const fetchSignal =
    typeof AbortSignal !== "undefined" && "any" in AbortSignal && params.signal
      ? AbortSignal.any([params.signal, idleAbort.signal])
      : params.signal ?? idleAbort.signal;

  let response: Response;
  try {
    armIdle(firstByteMs);
    response = await mobileModelFetch(request.url, {
      headers: request.headers,
      body: request.body,
      signal: fetchSignal,
    });
  } catch (e) {
    clearIdle();
    if (idleTimedOut) throw idleError();
    if (params.signal?.aborted) throw e;
    // WebView 里 CORS 预检失败、断网都落在这里，而且 message 是不可读的 "Failed to fetch"。
    // 带上 URL：报告里要能看出是哪个网关没通，而不是一句通用网络错误。
    throw new ModelStreamError(
      "model.network",
      `请求模型服务失败（${request.url}）：${String((e as Error)?.message ?? e)}`,
    );
  }

  if (!response.ok) {
    clearIdle();
    const text = await readLimitedText(response).catch(() => "");
    throw new ModelStreamError(
      `model.http.${response.status}`,
      // 带上真实 URL：网关回 "404 page not found" 这类纯文本时，只有地址能看出是
      // base URL 填成了完整端点（`.../v1/chat/completions` 后面又被接了一次路径）。
      `${businessErrorMessage(response.status, text)}（POST ${request.url} → HTTP ${response.status}）`,
      response.status,
    );
  }
  if (!response.body) {
    clearIdle();
    throw new ModelStreamError("model.emptyBody", "模型服务没有返回可读的响应体");
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const isEventStream = contentType.includes("event-stream");
  let text = "";
  // 思考流累加（0.7.3）：与 text 平行的一路，逐帧收进 reasoning，收尾一起交出去。
  let reasoning = "";
  let usage: ModelStreamUsage | null = null;
  let finishReason: string | null = null;
  // 终止帧账（0.6.0，"工作到一半被截断"的第二条通道）：网关/代理把 SSE **干净关闭**但没发
  // 任何收尾帧（[DONE] / finish_reason / message_stop / response.completed）时，read() 正常
  // done——旧代码把这当"模型说完了"，半截回答冒充完整回答。这里记账，done 时没账就报
  // streamTruncated，上层对"已吐过正文"的流自动续写（跟 finish_reason=length 同一条路）。
  let sawTerminal = false;
  // 按 index 累加的流式工具调用；Map 保序靠排序输出（见 flushToolCalls）。
  const toolAcc = new Map<number, ModelToolCall>();
  const flushToolCalls = (): ModelToolCall[] =>
    [...toolAcc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);

  const consumeFrame = (raw: string): void => {
    const frame = parseFrame(raw);
    if (frame.data.length === 0) return;
    const joined = frame.data.join("\n");
    if (!joined) return;
    if (joined === "[DONE]") {
      sawTerminal = true;
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(joined);
    } catch {
      // 有些网关在流尾塞心跳注释或非 JSON 行；不是错误，忽略。
      return;
    }
    const business = detectBusinessError(payload);
    if (business) {
      throw new ModelStreamError(
        `model.business.${business.code ?? "unknown"}`,
        business.message,
      );
    }
    if (frame.eventName === "error") {
      const message =
        (typeof (payload as { error?: { message?: unknown } })?.error?.message === "string" &&
          (payload as { error: { message: string } }).error.message) ||
        "模型服务在流里报了 error 事件";
      throw new ModelStreamError("model.streamError", message);
    }
    const nextUsage = extractUsage(target.apiFormat, payload);
    if (nextUsage) usage = {
      inputTokens: Math.max(nextUsage.inputTokens ?? 0, usage?.inputTokens ?? 0),
      outputTokens: Math.max(nextUsage.outputTokens ?? 0, usage?.outputTokens ?? 0),
    };
    const nextFinish = extractFinishReason(target.apiFormat, payload);
    if (nextFinish) {
      finishReason = nextFinish;
      sawTerminal = true;
    }
    // anthropic 的收尾事件（message_stop）与 responses 的完成事件（response.completed /
    // response.incomplete）也记终止账——它们不一定带 finish_reason 形状的字段。
    const record = payload as Record<string, unknown>;
    if (record.type === "message_stop" || record.type === "response.completed" || record.type === "response.incomplete") {
      sawTerminal = true;
    }
    // 工具帧常常没有 content（参数增量单独成帧），必须先累加再看文本 delta——放 delta 判断之后
    // 会让"只有 tool_calls 的帧"整帧被 return 掉，循环就永远等不到调用。
    if (target.apiFormat === "openai-chat-completions" && typeof payload === "object" && payload !== null) {
      accumulateChatToolCalls(payload as Record<string, unknown>, toolAcc);
    }
    if (target.apiFormat === "anthropic-messages" && typeof payload === "object" && payload !== null) {
      accumulateAnthropicToolCalls(payload as Record<string, unknown>, toolAcc);
    }
    if (target.apiFormat === "openai-responses" && typeof payload === "object" && payload !== null) {
      accumulateResponsesToolCalls(payload as Record<string, unknown>, toolAcc);
    }
    // 思考增量先于正文的 `if (!delta) return`：GLM/DeepSeek 的思考帧常常只有
    // reasoning_content、没有 content，早退会把整帧的思考一起丢掉（0.7.3 主诉）。
    const reasoningDelta = extractReasoning(target.apiFormat, payload);
    if (reasoningDelta) {
      reasoning += reasoningDelta;
      params.onReasoning?.(reasoningDelta);
    }
    const delta = extractText(target.apiFormat, payload);
    if (!delta) return;
    text += delta;
    onDelta(delta);
  };

  if (!isEventStream) {
    // 不是 event-stream：那就是"一次性 JSON"。补全内容照样要吐出去，否则配了非流式端点的
    // 个人 Provider 会显示成"模型回了个空"。
    let body: string;
    try {
      // 首字节看门狗（fetch 前 armIdle(FIRST_BYTE) 还在计）此时覆盖"整个 body 到齐"：
      // 网关 headers 给完就不吐 body 的话，idleAbort 会让 readLimitedText 的 reader 报错。
      body = await readLimitedText(response);
    } catch (e) {
      clearIdle();
      if (idleTimedOut) throw idleError();
      if (params.signal?.aborted) throw e;
      throw new ModelStreamError("model.stream", `读取模型响应中断：${String((e as Error)?.message ?? e)}`);
    }
    clearIdle();
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new ModelStreamError(
        "model.unexpectedBody",
        `模型服务返回了无法解析的内容（content-type=${contentType || "缺失"}）`,
      );
    }
    const business = detectBusinessError(payload);
    if (business) {
      throw new ModelStreamError(`model.business.${business.code ?? "unknown"}`, business.message);
    }
    const whole = extractText(target.apiFormat, payload);
    const wholeReasoning = extractReasoning(target.apiFormat, payload);
    const parsedUsage = extractUsage(target.apiFormat, payload);
    if (parsedUsage) usage = { inputTokens: parsedUsage.inputTokens ?? 0, outputTokens: parsedUsage.outputTokens ?? 0 };
    if (wholeReasoning) {
      reasoning = wholeReasoning;
      params.onReasoning?.(wholeReasoning);
    }
    if (whole) {
      text = whole;
      onDelta(whole);
    }
    let nonStreamToolCalls: ModelToolCall[] = [];
    if (typeof payload === "object" && payload !== null) {
      if (target.apiFormat === "openai-chat-completions") {
        nonStreamToolCalls = chatToolCallsFromJson(payload as Record<string, unknown>);
      } else if (target.apiFormat === "anthropic-messages") {
        nonStreamToolCalls = anthropicToolCallsFromMessage(payload as Record<string, unknown>);
      } else if (target.apiFormat === "openai-responses") {
        nonStreamToolCalls = responsesToolCallsFromJson(payload as Record<string, unknown>);
      }
    }
    // 非 event-stream 的整包 JSON 天然有终点（body 读完了），不存在半截截断。
    return { text, reasoning, usage, toolCalls: nonStreamToolCalls, finishReason: extractFinishReason(target.apiFormat, payload), truncated: false };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    // 首字节看门狗此刻仍在计（fetch 前 armIdle(FIRST_BYTE) 没被清）：它正好覆盖"headers 之后、
    // 第一帧内容之前"这段；拿到第一个 chunk 后改按帧间上限续。
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        clearIdle();
        pending += decoder.decode();
        break;
      }
      armIdle(frameIdleMs);
      pending += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const match = FRAME_SPLIT.exec(pending);
        if (!match) break;
        const raw = pending.slice(0, match.index);
        pending = pending.slice(match.index + match[0].length);
        consumeFrame(raw);
      }
    }
    if (pending.trim()) consumeFrame(pending);
  } catch (e) {
    clearIdle();
    // 看门狗到点 abort 的 fetch，其 reader.read() 会 reject（AbortError）——这不是"网络断了"
    // 而是"网关卡住不回"，单独报 model.streamIdle 让上层如实收口（composer 立刻恢复可用）。
    if (idleTimedOut) throw idleError();
    if (params.signal?.aborted) throw e;
    if (e instanceof ModelStreamError) throw e;
    throw new ModelStreamError("model.stream", `读取模型流中断：${String((e as Error)?.message ?? e)}`);
  } finally {
    // 解析失败也要关闭原生流，释放连接和有界队列，不能只解除 JS reader 锁。
    clearIdle();
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  return { text, reasoning, usage, toolCalls: flushToolCalls(), finishReason, truncated: !sawTerminal };
}

/**
 * 自动重连（0.4.10，用户点名"不支持自重连，45s 硬超时不一定合理"）。
 *
 * 对齐桌面端语义：桌面的重试在 AI SDK 层（streamText 的 maxRetries），手写 fetch/SSE
 * 这一层没有现成的——这里补一个窄版本。**只重试"还没吐出任何增量"的那一次请求**：
 * 已经流出一半再断的，重试会把旧文本重复贴一遍（桌面端同一取舍：SDK 也只对发起阶段重试），
 * 所以 sawDelta 一律直接抛，由 runTurn 如实收口（composer 立刻可用，用户重发）。
 * 可重试白名单：连接失败（model.network）、看门狗到点（model.streamIdle）、读流中断
 * （model.stream）、空响应体（model.emptyBody）、HTTP 429/5xx——都是"这一枪没打响"类，
 * 业务错误/401/404 不重（重来还是那个答案）。退避 1s→2s，共 3 次尝试；signal 在等待期
 * 内被 abort（用户点停止）则不再重试，把原错误抛出。
 */
const RETRYABLE_CODES = new Set(["model.network", "model.streamIdle", "model.stream", "model.emptyBody"]);
const MAX_STREAM_ATTEMPTS = 3;
const RETRY_BASE_WAIT_MS = 1_000;

function retriableError(e: unknown): boolean {
  if (!(e instanceof ModelStreamError)) return false;
  if (RETRYABLE_CODES.has(e.reasonCode)) return true;
  const st = e.statusCode;
  return st !== undefined && (st === 429 || st >= 500);
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

export async function streamModelCompletionWithRetry(params: {
  target: ModelTarget;
  messages: ModelTurnMessage[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
  onDelta: (text: string) => void;
  onReasoning?: (text: string) => void;
  tools?: ModelToolSpec[];
  firstByteTimeoutMs?: number;
  frameIdleTimeoutMs?: number;
  /** 重试发生时的旁路（attempt=第几次尝试、waitMs=本次已等待、reason=上次错误码）：
   *  调用方拿去写日志/状态，不进正文——重连对用户不可见是桌面端同款行为。 */
  onRetry?: (attempt: number, waitMs: number, reason: string) => void;
  /** 退避基准的注入点（默认 1s）：单测拿毫秒级即可确定性验证重试节奏，不等真秒。 */
  retryBaseWaitMs?: number;
}): Promise<ModelStreamResult> {
  let attempt = 0;
  for (;;) {
    attempt++;
    let sawDelta = false;
    try {
      return await streamModelCompletion({
        ...params,
        onDelta: (piece) => {
          sawDelta = true;
          params.onDelta(piece);
        },
        // 思考流也算"已经开始了"：吐过 reasoning 再盲重试会把思考重播一遍（正文重放同罪）。
        ...(params.onReasoning
          ? {
              onReasoning: (piece: string) => {
                sawDelta = true;
                params.onReasoning?.(piece);
              },
            }
          : {}),
      });
    } catch (e) {
      const stopped = params.signal?.aborted;
      if (attempt >= MAX_STREAM_ATTEMPTS || stopped || !retriableError(e) || sawDelta) throw e;
      const waitMs = (params.retryBaseWaitMs ?? RETRY_BASE_WAIT_MS) * 2 ** (attempt - 1);
      params.onRetry?.(attempt + 1, waitMs, e instanceof ModelStreamError ? e.reasonCode : String(e));
      await sleepWithAbort(waitMs, params.signal);
      if (params.signal?.aborted) throw e;
    }
  }
}
