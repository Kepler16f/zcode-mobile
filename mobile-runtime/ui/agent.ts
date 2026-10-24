// 端侧 Agent 面：把 v4 对话协议的另一端从"CLI 子进程"换成"本进程里的一次模型调用"。
//
// 为什么必须自己实现这一面（而不是注入上游工厂）：`createZCodeAgentService` 内部硬建三个
// ZCodeAgentProcessManager 走 stdio 子进程（services/src/zcode-agent/），根本没有传输层接缝，
// 手机上也没有可 spawn 的 Node。所以这里按**协议**实现，不按**实现**复用：UI 那一侧
// （packages/ui/src/v4/*）一行都不改，它以为自己在跟桌面上的 CLI 说话。
//
// 这一面的正确性完全由客户端的校验规则决定，而那几条都很硬：
//   1. 帧序号（conversationProjectionStore.ts:600-730）：snapshot 帧是"整体替换"，delta 帧必须
//      fromSeq === 本地 seq 才接得上；接不上就是重订阅，记账错了就是死循环。所以 seq 只在
//      **真的发出一帧**之后推进，且帧的 (fromSeq, toSeq] 右端点必须等于帧里带的那个 seq。
//   2. logicalFrameOrdinal 每条 (topic, subscriptionId) 严格递增（wire-assembler.ts:191-206）：
//      重号不同 id 是 typed fault，小于是静默丢弃。所以计数器挂在订阅上，不挂在会话上。
//      deliveryKind 必须是 initial/online/recovery 之一 —— 它决定客户端要不要消费 awaitingInitial 闸门。
//   3. 乐观气泡的收口（store:1294-1317）：sendText 的 overlay 只有在出现一条
//      `kind==="userInput" && origin==="realUser" && sourceCommandId===envelope.commandId` 的行之后才退场。
//      所以 userInput 行必须把 commandId 原样带回去 —— 那是"我收到了你那句话"的唯一凭据。
//   4. 公共 subscribe 响应严格只含 ACK（transport.ts:441-447）：初始快照走 notification，
//      而 notification 可能先到 —— 客户端的 ack-activation barrier 就是为此存在的。
//      这里在返回 ACK 之前就把初始帧压进出站队列，并把订阅 id 写在帧上，交给 barrier 暂存。
//
// 明确没做的（写在这里，不让它安静地变成一个假画面）：
//   - MCP / 子代理 / compact / goal / 工作流：命令一律 ack rejected + 原因码，
//     对应入口在 availability 里就是关的，不会出现"按钮能点、点了没反应"。
//   - 会话持久化：会话只活在这个进程里。重启后 UI 拿旧 sessionId 来回看，这里如实回
//     "这台设备上看不到之前那次对话的内容"，绝不拿空时间线冒充历史。
//   - 排队（0.7.1 起已接）：一轮进行中入队（inputRouting=enqueue），队列项可删/改/重排/
//     立即发送（打断插入＝原子停当前轮再跑该项），收轮按 autoDrain 排空；stop/失败把队列
//     置为暂停（pauseReason），下一条消息或面板「恢复」重新开排。队列不持久化——进程死了
//     就丢，与桌面裁决一致（snapshot.ts 的 queue 段）。
//   - 执行模式 / 访问调节（0.7.2 起已接）：提交带的 mode（build/edit/plan/yolo）+ planEnabled
//     落进 session.config，运行侧据此决定审批与禁写（表在 MOBILE_EXECUTION_MODE 段）。
import { Emitter, type Event, type IDisposable } from "@zcode/rpc";
import {
  PROTOCOL_V4_LIMITS,
  V4_WIRE_PROTOCOL_VERSION,
  clientHelloSchema,
  conversationTopic,
  conversationTopicFrameSchema,
  encodeTopicWireFrames,
  measureTopicNotificationEnvelopeBytes,
  parseCommandEnvelope,
  sessionsIndexTopic,
  sessionsIndexTopicFrameSchema,
  workspaceConfigTopic,
  workspaceConfigTopicFrameSchema,
  type CommandAck,
  type CommandEnvelope,
  type CommandResult,
  type CommandsQueryParams,
  type CommandsQueryResult,
  type ConversationDelta,
  type ConversationRow,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type ConversationTopicWireCandidate,
  type HostCapabilities,
  type HelloMessage,
  type SessionConfigState,
  type PendingInteraction,
  type SessionControl,
  type SessionSummary,
  type SessionsIndexTopicFrame,
  type SessionsIndexTopicWireCandidate,
  type TopicFrameDeliveryKind,
  type ToolCallRow,
  type TurnHeaderRow,
  type WorkspaceConfigSnapshot,
  type WorkspaceConfigState,
  type WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";

import type {
  ZCodeMessageWithParts,
  ZCodeSessionMode,
  ZCodeSessionStateSnapshot,
  ZCodeSlashCommand,
  ZCodeWorkspacePresentation,
} from "@zcode/shared";
import { ZCODE_PROTOCOL_NAME, ZCODE_PROTOCOL_VERSION } from "@zcode/shared";
import type { ZCodeAgentRuntimeLifecycleEvent } from "@zcode/services";

import {
  ProviderTargetError,
  resolveDefaultSelection,
  resolveModelTarget,
  resolveThoughtLevels,
  type ModelSelectionValue,
  type ModelTargetResolver,
} from "./provider-target.js";
import {
  ModelStreamError,
  streamModelCompletionWithRetry,
  type ModelStreamResult,
  type ModelTurnMessage,
  type ModelTarget,
} from "./model-stream.js";
import type { ToolEngine, ToolEngineFactory } from "./tool-engine.js";
import { capToolContent } from "./tool-engine.js";
import { parseDsmlCalls } from "./dsml.js";
import { markJankPhase } from "./jank-witness.js";
import type { MobileSessionStore, PersistedTurnUsage } from "./session-store.js";
import { createMobilePluginFace } from "./plugins-mobile.js";
import {
  createMobileHookRuntime,
  grantWorkspaceHookTrust,
  type MobileHookLifecycleEvent,
  type MobileHookRuntime,
} from "./hooks-mobile.js";

/** 与上游 continuous profile 同一个值（core.ts:38）：30 ms 内的增量并成一帧。 */
const FLUSH_WINDOW_MS = 30;
const SNAPSHOT_WINDOW_ROWS = PROTOCOL_V4_LIMITS.snapshotTailWindowRows;
/** 送给模型的历史消息条数上限。超过只带最近这些 —— 压缩（compact）在 P0 还没有。 */
const HISTORY_MESSAGES_MAX = 40;
/** P0 的单轮输出上限。真实值应由模型能力配置给出，这里先给一个不会把回答截断得太狠的数。 */
/** 单轮输出预算的默认上限。0.5.1：4096 → 16384——P0 的临时值把长回答拦腰截在
 *  finish_reason=length 上（用户看到的"说到一半就断了"），且思考档位开启后推理 token
 *  也计入输出预算，4096 连一轮带工具调用的推理都装不下。实际预算还会与模型声明的
 *  单轮上限（target.maxOutputTokensCap）取 min，不会超过网关允许的值。 */
const MAX_OUTPUT_TOKENS = 16_384;
/** 一轮里模型-工具往返的步数：**没有上限**（0.5.0，用户点名"12 步限制应该完全解除"）。
 *  复杂重构/排查的合理轮次远超 12 步，而撞墙的收场是整轮作废——代价不对等。
 *  失控保护不靠步数上限，靠下面的"同签名连续出错"检测：真死循环（同一调用同样错误连发）
 *  会被提前掐掉；正常长任务每次调用都在推进，签名不会重复。上下文的自然护栏是 provider：
 *  transcript 撑爆窗口时流式请求如实报错，轮次随失败收场，不需要人造墙。 */
/** 同签名（工具名+入参+错误回包）连续出现次数上限：达到就停轮——这是"失控循环"的判据，
 *  不是"步数多"。只统计**出错**的重复：同一调用连发但结果在变（分页读取、递增等待）是推进不是循环。 */
const MAX_REPEAT_SIGNATURES = 3;
/** 流中断续写只认网络类错误码（0.6.9）：业务错误（provider 拒绝）、鉴权失败重来还是那个
 *  答案，续写只会把失败重复一遍还可能重复正文；abort 是用户主动停，不归这里管。
 *  HTTP 错误码形状是 `model.http.<status>`（model-stream.ts 的 throw 点），5xx/429 属于
 *  "网关抖一下"值得续，4xx 其余（401/403/404）续了也是同一个答案，不进表。
 *  0.7.0：续写不再限次数（坏网络一句一掐时 3 次额度秒光＝用户报的"几乎一句话就截断"）；
 *  判据＝本轮累计正文比上次续写时严格变长，否则停手抛错走正常收口。transcript 每次续写
 *  都变长，撑爆上下文由 provider 报错自然收口，所以"有进展就续"不会真的无底洞。 */
const CONTINUABLE_STREAM_CODES = new Set([
  "model.network",
  "model.streamIdle",
  "model.stream",
  "model.http.408",
  "model.http.429",
  "model.http.500",
  "model.http.502",
  "model.http.503",
  "model.http.504",
]);
/** 快照里消息的 agent 归属。端侧只有一个 agent 面，所以这就是它，不随 Provider 变。 */
const MOBILE_AGENT_NAME = "zcode";

// ── 执行模式（0.7.2，用户点名"访问调节（完全访问/自主模式/变更前确认）功能无效"）──
// 值域 = 协议的 submissionModeSchema（build/edit/plan/yolo），"计划"在前端是独立勾选项
// （planEnabled），resolveExecutionState 把两者合成一个执行态。端侧按自己的真实能力落语义：
//   build（变更前确认）：跑命令（Bash）与删文件（Delete）都先问；
//   edit（自动编辑）：文件改动自动（删除也不再问），跑命令仍问——命令是另一档风险；
//   yolo（完全访问）：一律不问（含越界路径授权，按"始终允许"放行）；
//   plan（计划模式）：改文件（Write/Edit/Delete）一律不执行，让模型先出计划；
//     命令（Bash）仍走审批闸——计划模式要能查（ls/git status），但不能静默改状态。
// 之前整个 mode 只是快照上的一格展示值，agent 从不读它——选择器点了没反应就是这条。
type MobileExecutionMode = "build" | "edit" | "plan" | "yolo";
/** 计划模式下不执行的工具：**改文件**那几个。Bash 只读探查照走审批闸，不在拦截集里。 */
const PLAN_MODE_BLOCKED_TOOLS = new Set(["Write", "Edit", "Delete"]);

function normalizeExecutionMode(raw: unknown): MobileExecutionMode {
  return raw === "yolo" || raw === "edit" || raw === "plan" ? raw : "build";
}

export interface MobileAgentServiceOptions {
  /** 模型落点的来源。没有 ProviderRuntime（组合根那步构造失败）时整个面按"取不到模型"报出去。 */
  modelTargets?: ModelTargetResolver;
  /** 写进 anthropic 的 `metadata.user_id`，与桌面的设备标识同源。 */
  deviceId?: string;
  /** 把可读原因报给组合根/自检报告。这里不往 UI 抛，抛出去打死的是整个时间线。 */
  onDiagnostic?: (message: string) => void;
  /**
   * 会话持久化。给了它，每轮对话就会落进 SQLite、重启后能被还原；不给（或引擎建不起来时
   * 组合根传 null）就退回纯内存，missingSession 的文案仍如实说"这台设备上看不到之前的对话"。
   * 为什么是可选而不是必填：桌面自检（chat-smoke）跑在 sql.js 上，那台宿主的持久化不是
   * 产品判据，强行要求会把它和"对话协议对不对"这两件事混在一起。
   */
  sessionStore?: MobileSessionStore | null;
  /**
   * 工具引擎（Phase 1 第 5 项）：不给（或引擎加载失败）就退回纯文本对话——请求体里永远
   * 不会有 tools 字段，模型无从"承诺工具"。见 ui/tool-engine.ts：实例按 workspace 缓存，
   * registry/端口/错误类全从 core bundle 的同一份模块图取（isFileSystemPortError 的
   * instanceof 只有同源才成立）。
   */
  toolEngine?: ToolEngineFactory | null;
  /**
   * 钩子运行时工厂（默认 = hooks-mobile.createMobileHookRuntime，走出货的 core bundle 路径）。
   * 自检注入用：Node 里那条 `../mobile/dist/zcode-core.mobile.js` 解析不到，注入的工厂
   * 直接拿源码里的 createConfiguredHookRunner + 假执行桥，把 agent 这一层的接线也测到。
   */
  hookRuntimeFactory?: (options: {
    workspacePath: string;
    onLifecycleEvent?: (event: MobileHookLifecycleEvent) => void;
    onDiagnostic?: (message: string) => void;
  }) => Promise<MobileHookRuntime | null>;
}

interface MobileSession {
  sessionId: string;
  /** 建这个会话时所在的 workspace；disposeWorkspace 就按它匹配（命令通路只有 path，没有 identity）。 */
  workspacePath: string;
  logEpoch: string;
  revision: number;
  /** 已发出的最后一帧的右端点，也是 snapshot 的对齐水位。 */
  seq: number;
  rows: ConversationRow[];
  nextRowId: number;
  control: SessionControl;
  config: SessionConfigState;
  cumulative: { inputTokens: number; outputTokens: number };
  /** 挂起的审批（当前只有 Bash 会产生一条）。buildSnapshot 把它原样投进快照的 pendingInteractions，
   *  UI 的 V4InteractionDialogs 据此弹窗，用户点选走 resolveInteraction 命令。 */
  pendingInteractions: PendingInteraction[];
  /** 正在跑的这一轮。stop 与"忙不忙"都只看它。 */
  run: { abort: AbortController; executionId: string; turnId: string } | null;
  /** 等待队列（0.7.1）。queueItem 形状逐字对齐协议 queueItemSchema（帧会被 schema 校验）。 */
  queue: MobileQueueState;
  /** 正在流式的那条 reasoning 行（0.7.3，用户点名"思考过程没有跟桌面一样分开显示"）。
   *  null = 当前没有开着的思考行。正文/工具/收口出现时关掉它（complete + durationMs）。 */
  reasoningRowId: number | null;
  reasoningStartedAt: number;
  /** "立即发送/打断插入"抢占下来的输入：当前轮 abort 后由 afterTurnSettled 立刻起跑，
   *  优先级高于队列排空。同一时刻最多一条（第二次抢占会 abort 掉同一条待跑项）。 */
  pendingStartNow?: MobileQueueItem;
  /** 这台设备上找不回历史：订阅时要如实说出来。 */
  missing: boolean;
}

/** 队列项。字段与 shared 的 conversationInputIntentSchema(+queueItemSchema) 一致且必填项齐全——
 *  多写/少写都会在 emitFrame 的 schema 校验里变成一条"帧不合法"诊断（宁可写在这里）。 */
interface MobileQueueItem {
  queueItemId: string;
  sourceCommandId: string;
  clientId: string;
  kind: "sendText";
  text: string;
  attachments: unknown[];
  delivery: {
    requested: "auto" | "startNow" | "queue" | "guide";
    admitted: "queue";
    fallbackReasonCode?: string;
  };
  order: { admissionSeq: number; queuePosition?: number };
  steer: { state: "notRequested" | "submitting" | "steering" | "guided" | "fellBack"; reasonCode?: string };
  dispatch: { state: "queued" | "reserved" | "promoting" };
  admittedAt: number;
  provenance: { sourceCommandId: string; queueItemId: string; clientId: string };
  /** 提交那次带的模型选择；起跑时作为本轮 selection（缺省沿用会话当前配置）。 */
  modelSelection?: ModelSelectionValue;
  /** 提交那次的执行模式意图（协议 intent 的 mode/planEnabled 两格）：排到它时落进会话配置。 */
  mode?: MobileExecutionMode;
  planEnabled?: boolean;
}

interface MobileQueueState {
  items: MobileQueueItem[];
  autoDrain: boolean;
  pauseReason?: "stopped" | "manual" | "error";
  nextAdmissionSeq: number;
}

interface MobileSubscription {
  subscriptionId: string;
  topic: string;
  sessionId: string;
  workspacePath: string;
  /** 每条 (topic, subscriptionId) 自己的物理帧序号，从 1 开始。 */
  ordinal: number;
}

interface TurnHandles {
  turnId: string;
  headerRowId: number;
  inputRowId: number;
  assistantRowId: number;
  inputId: string;
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function now(): number {
  return Date.now();
}

function draftControl(): SessionControl {
  return {
    phase: "draft",
    sessionEnded: false,
    canStop: false,
    stopState: "idle",
    stopTargetKind: "unknown",
    activeWorks: [],
    lastError: null,
    apiRetry: null,
  };
}

function settledControl(
  phase: SessionControl["phase"],
  lastError: SessionControl["lastError"],
): SessionControl {
  return {
    phase,
    sessionEnded: phase === "completedSuccess" || phase === "completedInterrupted",
    canStop: false,
    stopState: "idle",
    stopTargetKind: "unknown",
    activeWorks: [],
    lastError,
    apiRetry: null,
  };
}

function runningControl(startedAt: number, executionId: string): SessionControl {
  return {
    phase: "running",
    sessionEnded: false,
    canStop: true,
    stopState: "stoppable",
    stopTargetKind: "assistant",
    activeWorks: [{ kind: "primaryTurn", foregroundExecutionId: executionId, startedAt }],
    lastError: null,
    apiRetry: null,
  };
}

function errorInfo(
  code: string,
  message: string,
  source: "provider" | "runtime" | "tool" | "network",
  recoverable: boolean,
): NonNullable<SessionControl["lastError"]> {
  return {
    code,
    message,
    recoverable,
    at: now(),
    source,
    attribution: { reason: message.slice(0, 160), errorPhase: "stream" },
  };
}

/**
 * 会话级动作门禁。UI 上那 8 个入口只认这张表，所以"允许了却又命令失败"会变成点了没反应的按钮 ——
 * 关掉是对的。0.7.1 起队列三件套（改/立即发/恢复）随"队列里有没有待跑项"开合：
 * 队列空的会话上这些入口没有意义，开着就是给用户一个必然报错的按钮。
 */
function buildAvailability(running: boolean, switchModel: boolean, hasQueuedItems: boolean) {
  const closed = { allowed: false as const, reasonCode: "mobile.p0.notImplemented" };
  const busy = { allowed: false as const, reasonCode: "mobile.p0.busy" };
  const gate = running ? busy : closed;
  const queueReady = { allowed: true } as const;
  const queueEmpty = { allowed: false as const, reasonCode: "mobile.queue.empty" };
  return {
    fork: gate,
    compact: gate,
    switchModelConfig: running
      ? busy
      : switchModel
        ? ({ allowed: true } as const)
        : closed,
    setFollowupMode: running ? busy : ({ allowed: true } as const),
    queueEdit: hasQueuedItems ? queueReady : queueEmpty,
    sendQueuedNow: hasQueuedItems ? queueReady : queueEmpty,
    pauseGoal: closed,
    resumeGoal: closed,
  };
}

function firstUserText(rows: ConversationRow[]): string | null {
  for (const row of rows) {
    if (row.kind === "userInput") return row.text;
  }
  return null;
}

export function createMobileAgentService(options: MobileAgentServiceOptions = {}) {
  const sessions = new Map<string, MobileSession>();
  const store = options.sessionStore ?? null;
  const subscriptions = new Map<string, MobileSubscription>();
  /**
   * turnId -> 这一轮网关报回的用量。为什么要单独记一份：ConversationRow 的形状是协议定的
   * （客户端按 zod 严格校验，多一个键就整帧被拒），而 readSession 那条读取路径要按**每一轮**
   * 报 tokens —— 拿会话累计值填到每条消息上，就是把第一轮用量重复计了 N 遍。
   * 网关这一轮没报用量就记 0：0 的含义是"没报"，不是"没用"。
   */
  const turnUsage = new Map<string, { inputTokens: number; outputTokens: number }>();
  // Bash 审批的挂起表：interactionId → resolve。runTurn 里 await 它，UI 的 resolveInteraction
  // 命令到达时兑现。先到先得（协议里写明）：第二次 resolve 找不到表项，如实回 noop。
  const pendingInteractionResolvers = new Map<string, (optionId: string | undefined) => void>();
  /** commandId -> ACK。幂等只在这台设备活着期间成立，与上游"accepted 不承诺跨进程存活"同一口径。 */
  const commandResults = new Map<string, CommandAck>();
  let boundClientId: string | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingDeltas = new Map<string, ConversationDelta[]>();

  const frameEmitter = new Emitter<ConversationTopicWireCandidate>();
  const restartEmitter = new Emitter<{ workspaceKey: string }>();
  const say = (message: string) => options.onDiagnostic?.(message);

  // ── workspace 级 topic：sessions-index（侧栏那一行的来源）与 workspace-config ──
  // 这两条与 conversation 用的是同一套"五件套"帧协议（transport.ts:222-291），差别只在归属：
  // conversation 按 sessionId 找订阅，这两条按 workspaceKey 找。为什么要单独一路：
  // 任务索引同步器（zcodeTaskIndexSyncer.ts:1417-1514）**只被 sessions-index 帧驱动**，
  // 而它是"发完一句 → 写 task-index 行 → 广播列表变更"那条链的唯一入口（同文件 :501-531）。
  // 没有这一路，端侧的会话永远进不了侧栏 —— 屏幕上就是"我发过一句，列表里根本没有"。
  const indexEmitter = new Emitter<SessionsIndexTopicWireCandidate>();
  const configEmitter = new Emitter<WorkspaceConfigTopicWireCandidate>();
  interface WorkspaceTopicState {
    workspaceKey: string;
    workspacePath: string;
    logEpoch: string;
    /** 两条 topic 各自一条日志水位（上游就是把它们做成彼此独立的代际）。 */
    indexSeq: number;
    configSeq: number;
    summaries: Map<string, SessionSummary>;
    /** 端侧此刻的 workspace 级配置目录真的是空的：模型目录走 conversation 的 config 面。 */
    config: WorkspaceConfigState;
  }
  interface WorkspaceTopicSubscription {
    subscriptionId: string;
    topic: string;
    ordinal: number;
  }
  const workspaceTopics = new Map<string, WorkspaceTopicState>();
  /** workspacePath -> 订阅时实际使用的 workspaceKey，发布摘要时要用同一个键，否则帧会按 topic 被静默过滤。 */
  const workspaceKeyByPath = new Map<string, string>();
  const indexSubs = new Map<string, WorkspaceTopicSubscription>();
  const configSubs = new Map<string, WorkspaceTopicSubscription>();

  function workspaceTopicOf(target: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): WorkspaceTopicState {
    const workspaceKey = target.workspaceIdentity?.trim() || target.workspacePath;
    workspaceKeyByPath.set(target.workspacePath, workspaceKey);
    let state = workspaceTopics.get(workspaceKey);
    if (!state) {
      state = {
        workspaceKey,
        workspacePath: target.workspacePath,
        logEpoch: newId("wsepoch"),
        indexSeq: 0,
        configSeq: 0,
        summaries: new Map(),
        config: { configOptions: [], slashCommands: [] },
      };
      workspaceTopics.set(workspaceKey, state);
    }
    return state;
  }

  function stateForSessionPath(workspacePath: string): WorkspaceTopicState {
    const known = workspaceKeyByPath.get(workspacePath);
    return workspaceTopicOf({
      workspacePath,
      ...(known && known !== workspacePath ? { workspaceIdentity: known } : {}),
    });
  }

  /**
   * "这条 workspace 的 runtime 活了"的广播。
   *
   * 为什么端侧必须有这一条（而不是等 initialize）：任务索引同步器只在
   * onAgentRuntimeLifecycle(available) 里建立它自己的 sessions-index 订阅
   * （zcodeTaskIndexSyncer.ts:1546、1569-1593），而它是侧栏那一行唯一的写入者。
   * 桌面另外那条通往 ensureWorkspaceSubscription 的路是 zcodeSessionService.initializeWorkspace，
   * 它在整个仓库里只有一个调用方 —— packages/desktop/src/host/index.ts:1507，即桌面主进程；
   * 纯 v4 的 UI 一路（手机上就是这一路）根本不会走到那儿，上游自己在 :707 也写了这句。
   * 所以不接这条事件 = 同步器永远不订阅 = 发完一句，库里没有那一行。
   *
   * generation 恒为 1：桌面那个数指的是 CLI 子进程换代，端侧没有子进程，
   * 会话只活在内存里，页面活着 runtime 就活着（重启后本来就查不到了，见 readSession 的注释）。
   */
  const runtimeLifecycleEmitter = new Emitter<ZCodeAgentRuntimeLifecycleEvent>();
  const announcedWorkspaces = new Set<string>();

  function announceWorkspaceRuntime(workspacePath: string): void {
    const state = stateForSessionPath(workspacePath);
    if (!state.workspaceKey || announcedWorkspaces.has(state.workspaceKey)) return;
    // 水合必须排在 lifecycle 事件之前：同步器收到 "available" 才订阅 sessions-index，
    // 而它拿到的首帧就是这一刻 state.summaries 的内容。晚了首帧就是空的，侧栏只剩
    // task-index 库里的旧行撑着（点开仍然空），用户看到的就是"历史没了"。
    hydrateWorkspaceFromStore(workspacePath);
    announcedWorkspaces.add(state.workspaceKey);
    say(`workspace=${state.workspaceKey} 的端侧 runtime 起来了（同步器据此订阅 sessions-index）`);
    runtimeLifecycleEmitter.fire({
      workspaceKey: state.workspaceKey,
      workspacePath: state.workspacePath,
      runtimeIdentity: {
        generation: 1,
        identity: newId("mobile-runtime"),
        workspaceKey: state.workspaceKey,
      },
      state: "available",
    });
  }

  /**
   * workspace 级 topic 的共用法帧，纪律与 emitFrame 完全一致：
   * snapshot 不推进水位（它是当前这一拍的整张照片）、delta 一帧一格、
   * ordinal 挂在订阅上、超过 1 MiB 的分片交给上游 codec。
   * 水位只在**真的发出去至少一帧**之后才推进 —— 预推进会让下一帧的 fromSeq 对不上，
   * 而同步器把对不上当作断档，会退订重订，表现是列表每隔一会儿整片闪空。
   */
  function emitWorkspaceTopicFrame(
    kind: "sessions-index" | "workspace-config",
    state: WorkspaceTopicState,
    payload: SessionsIndexTopicFrame["payload"] | { kind: "snapshot"; snapshot: WorkspaceConfigSnapshot } | { kind: "deltas"; deltas: unknown[] },
    deliveryKind: TopicFrameDeliveryKind,
    onlyFor?: WorkspaceTopicSubscription,
  ): void {
    const isIndex = kind === "sessions-index";
    const topic = isIndex ? sessionsIndexTopic(state.workspaceKey) : workspaceConfigTopic(state.workspaceKey);
    const subs = isIndex ? indexSubs : configSubs;
    const currentSeq = isIndex ? state.indexSeq : state.configSeq;
    const nextSeq = payload.kind === "deltas" ? currentSeq + 1 : currentSeq;
    const frameSchema = isIndex ? sessionsIndexTopicFrameSchema : workspaceConfigTopicFrameSchema;
    let advanced = false;
    for (const sub of subs.values()) {
      if (sub.topic !== topic) continue;
      if (onlyFor && sub !== onlyFor) continue;
      const parsed = frameSchema.safeParse({
        topic,
        subscriptionId: sub.subscriptionId,
        fromSeq: payload.kind === "snapshot" ? 0 : nextSeq - 1,
        toSeq: nextSeq,
        sentAt: now(),
        payload,
      });
      if (!parsed.success) {
        say(
          `${topic} 帧不合法（${deliveryKind}）：${parsed.error.issues[0]?.message ?? "未知"}`,
        );
        continue;
      }
      advanced = true;
      sub.ordinal += 1;
      const wires = encodeTopicWireFrames(parsed.data, {
        deliveryKind,
        topic,
        subscriptionId: sub.subscriptionId,
        logicalFrameId: `${sub.subscriptionId}/${sub.ordinal}`,
        logicalFrameOrdinal: sub.ordinal,
        measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
      });
      for (const wire of wires) {
        if (isIndex) indexEmitter.fire(wire as SessionsIndexTopicWireCandidate);
        else configEmitter.fire(wire as WorkspaceConfigTopicWireCandidate);
      }
    }
    if (advanced) {
      if (isIndex) state.indexSeq = nextSeq;
      else state.configSeq = nextSeq;
    }
  }

  function summaryOf(session: MobileSession, workspaceId: string): SessionSummary {
    const rows = session.rows;
    const firstText = firstUserText(rows) ?? "";
    let lastAssistantText = "";
    let lastActivityAt = 0;
    for (const row of rows) {
      if (row.kind === "assistantText" && row.text.length > 0) lastAssistantText = row.text;
      lastActivityAt = Math.max(
        lastActivityAt,
        row.createdAt,
        "endedAt" in row && typeof row.endedAt === "number" ? row.endedAt : 0,
      );
    }
    return {
      sessionId: session.sessionId,
      workspaceId,
      // 与 buildSnapshot 的 meta.title 同一个取法（同文件里那份 meta）：列表标题是那句话的前 40 字。
      title: firstText.slice(0, 40),
      titleSource: firstText ? "generated" : "default",
      phase: session.control.phase,
      sessionEnded: session.control.sessionEnded,
      // 端侧没有后台任务（backgroundWorks 恒空），所以这一格是真的 false，不是"先报没有"。
      hasBackgroundWork: false,
      lastActivityAt: lastActivityAt || now(),
      ...(lastAssistantText ? { lastAssistantPreview: lastAssistantText.slice(0, 120) } : {}),
      createdAt: rows[0]?.createdAt ?? now(),
    };
  }

  /**
   * 把一条会话的当前事实投进 sessions-index。两道闸：
   *   - `missing`（重启后回看的历史占位）与零行的草稿都不进：那条链一旦写进 task-index，
   *     列表里就会出现一行点开是空的假任务，比"没有这一行"更糟。
   *   - 与上一拍完全相同就不发：同步器对每个 upsert 都要回源 readSession 并广播列表变更，
   *     逐 token 广播会让侧栏在每一轮流式输出里重拉一次。
   */
  function publishSessionIndex(session: MobileSession): void {
    if (session.missing || session.rows.length === 0) return;
    const state = stateForSessionPath(session.workspacePath);
    const summary = summaryOf(session, state.workspaceKey);
    const previous = state.summaries.get(session.sessionId);
    if (previous && JSON.stringify(previous) === JSON.stringify(summary)) return;
    state.summaries.set(session.sessionId, summary);
    emitWorkspaceTopicFrame(
      "sessions-index",
      state,
      { kind: "deltas", deltas: [{ op: "session.upserted", session: summary }] },
      "online",
    );
  }

  // ── 发帧 ──
  // ordinal 计数器挂在订阅上；分片交给上游 codec（超过 1 MiB 自动拆），端侧不另造一套分帧规则。
  /** 队列状态进快照的形状（对应协议 queueStateSchema；pauseReason 缺席 = 没在暂停）。 */
  function queueStateOf(session: MobileSession): ConversationSnapshot["queue"] {
    return {
      items: session.queue.items as unknown as ConversationSnapshot["queue"]["items"],
      autoDrain: session.queue.autoDrain,
      ...(session.queue.pauseReason ? { pauseReason: session.queue.pauseReason } : {}),
    };
  }

  /** 队列变了就发一拍 state.updated（键级整体替换，delta.ts 的既有语义）。 */
  function emitQueue(session: MobileSession, reason: string): void {
    say(`队列：${reason}（${session.queue.items.length} 条，autoDrain=${session.queue.autoDrain}）`);
    updateState(session, { revision: session.revision + 1, queue: queueStateOf(session) });
  }

  /**
   * 关掉当前开着的思考行（0.7.3，用户点名"思考过程和正文混在一起全输出为回复"）。
   * 调用时机：正文开始（一步的思考先于正文）、本步要落工具行、以及 settleTurn 兜底。
   * 只动 streaming 行（幂等：没有开着的行就静默返回）。
   */
  function closeReasoningRow(session: MobileSession, state: "complete" | "interrupted" = "complete"): void {
    const rowId = session.reasoningRowId;
    if (rowId === null) return;
    session.reasoningRowId = null;
    const row = session.rows.find((r) => r.rowId === rowId);
    if (!row || row.kind !== "reasoning" || row.state !== "streaming") return;
    upsertRow(session, {
      ...row,
      state,
      durationMs: Math.max(0, now() - session.reasoningStartedAt),
    });
  }

  /** 开一条思考行（懒建：一步的第一段 reasoning 增量到达时才落行，空步不留泡）。 */
  function openReasoningRow(session: MobileSession, turnId: string): void {
    const rowId = takeRowId(session);
    session.reasoningRowId = rowId;
    session.reasoningStartedAt = now();
    appendRow(session, {
      rowId,
      turnId,
      entityId: String(rowId),
      createdAt: now(),
      createdAtSeq: session.seq,
      kind: "reasoning",
      text: "",
      state: "streaming",
    } as ConversationRow);
  }

  /** 输入路由（0.7.1）：跑着 = enqueue（一句话进等待队列）；空闲但队列被暂停（stop/失败留下的
   *  待跑项）= choice（客户端渲染"清空队列后发送/保留队列立即发送"确认框）；其余 startNow。 */
  function inputRoutingOf(session: MobileSession): ConversationSnapshot["inputRouting"] {
    const hasQueued = session.queue.items.length > 0;
    return session.run
      ? { mode: "enqueue" }
      : hasQueued && !session.queue.autoDrain
        ? { mode: "choice" }
        : { mode: "startNow" };
  }

  function availabilityOf(session: MobileSession): ConversationSnapshot["availability"] {
    return buildAvailability(
      session.run !== null,
      Boolean(options.modelTargets),
      session.queue.items.length > 0,
    );
  }

  function buildSnapshot(session: MobileSession): ConversationSnapshot {
    const window = session.rows.slice(-SNAPSHOT_WINDOW_ROWS);
    const firstText = firstUserText(session.rows);
    return {
      protocolVersion: 1,
      sessionId: session.sessionId,
      logEpoch: session.logEpoch,
      seq: session.seq,
      revision: session.revision,
      control: session.control,
      availability: availabilityOf(session),
      inputRouting: inputRoutingOf(session),
      meta: {
        title: firstText ? firstText.slice(0, 40) : "",
        titleSource: firstText ? "generated" : "default",
      },
      config: session.config,
      usage: usageState(session),
      queue: queueStateOf(session),
      pendingInteractions: session.pendingInteractions,
      pendingCommands: [],
      backgroundWorks: [],
      goal: null,
      plan: null,
      // 这两格在协议里是 `nullable().default(null)`（snapshot.ts:489、:505）：
      // modelTransition = "这一轮正在换模型配置"，workspaceHookAdmission = 工作区 hook 的准入判定。
      // 端侧两个功能都还没接，写 null 是如实说"没有这一回事"，不是先给个乐观默认 ——
      // 这一版 tsc 报 TS2739 报的就是它们：ConversationSnapshot 是 schema 的**输出**类型，
      // 带 default 的字段在输出类型里是必填的，省略就等于让 UI 读到 undefined。
      modelTransition: null,
      workspaceHookAdmission: null,
      rows: {
        window,
        totalCount: session.rows.length,
        firstRowId: session.rows[0]?.rowId ?? null,
      },
    };
  }

  /**
   * 发一帧。snapshot 不改变 seq（它就是当前水位的照片），deltas 把这帧的右端点写回水位。
   * 两种 payload 的 seq 语义不同，是 store 那三条规则的根，所以这里分开处理、不写成一条通用路径。
   */
  function emitFrame(
    session: MobileSession,
    payload: ConversationTopicFrame["payload"],
    deliveryKind: TopicFrameDeliveryKind,
    onlyFor?: MobileSubscription,
  ): void {
    if (payload.kind === "deltas") session.seq += 1;
    const frame: ConversationTopicFrame = {
      topic: conversationTopic(session.sessionId),
      subscriptionId: "",
      fromSeq: payload.kind === "snapshot" ? 0 : session.seq - 1,
      toSeq: session.seq,
      sentAt: now(),
      payload,
    };
    for (const sub of subscriptions.values()) {
      if (sub.sessionId !== session.sessionId) continue;
      if (onlyFor && sub !== onlyFor) continue;
      const wired: ConversationTopicFrame = { ...frame, subscriptionId: sub.subscriptionId };
      // 过一遍自己的 schema：字段写错要在这里变成一条明确诊断，而不是到手机上表现为"时间线永远空白"。
      const parsed = conversationTopicFrameSchema.safeParse(wired);
      if (!parsed.success) {
        say(
          `帧不合法（${session.sessionId} / ${deliveryKind}）：${parsed.error.issues[0]?.message ?? "未知"}`,
        );
        continue;
      }
      sub.ordinal += 1;
      const wires = encodeTopicWireFrames(parsed.data, {
        deliveryKind,
        topic: wired.topic,
        subscriptionId: sub.subscriptionId,
        logicalFrameId: `${sub.subscriptionId}/${sub.ordinal}`,
        logicalFrameOrdinal: sub.ordinal,
        // 度量函数返回的是三层承载的一叠数字，编码器要的是"这一帧多大"这**一个**数：
        // 直接把 measure 函数递过去，`对象 <= 上限` 永远是 false，每一帧都会被推进分片分支，
        // 然后以 proto.frameEnvelopeTooLarge 打死整条订阅（chat-smoke.mjs 实测）。
        // 桌面上游取的就是 .maxBytes（v4-gateway.ts:520），这里跟它同一取法。
        measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
      });
      for (const wire of wires) frameEmitter.fire(wire as ConversationTopicWireCandidate);
    }
  }

  /** 增量先攒 30 ms 再成帧：逐 token 一帧会占满 RPC 通道，手机上先卡住的是渲染。 */
  function stageDelta(session: MobileSession, delta: ConversationDelta): void {
    const list = pendingDeltas.get(session.sessionId) ?? [];
    list.push(delta);
    pendingDeltas.set(session.sessionId, list);
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      for (const [sessionId, deltas] of pendingDeltas) {
        pendingDeltas.delete(sessionId);
        const session = sessions.get(sessionId);
        if (session && deltas.length > 0) emitFrame(session, { kind: "deltas", deltas }, "online");
      }
    }, FLUSH_WINDOW_MS);
  }

  /** 整行事件（append/upsert/state）之前必须先把攒着的增量发出去，否则 delta 会落在 row 出现之前。 */
  function flushPending(session: MobileSession): void {
    const deltas = pendingDeltas.get(session.sessionId);
    if (!deltas || deltas.length === 0) return;
    pendingDeltas.delete(session.sessionId);
    emitFrame(session, { kind: "deltas", deltas }, "online");
  }

  function takeRowId(session: MobileSession): number {
    return session.nextRowId++;
  }

  function appendRow(session: MobileSession, row: ConversationRow): void {
    session.rows.push(row);
    flushPending(session);
    emitFrame(session, { kind: "deltas", deltas: [{ op: "row.appended", row }] }, "online");
  }

  function upsertRow(session: MobileSession, row: ConversationRow): void {
    const index = session.rows.findIndex((r) => r.rowId === row.rowId);
    if (index >= 0) session.rows[index] = row;
    else session.rows.push(row);
    flushPending(session);
    emitFrame(session, { kind: "deltas", deltas: [{ op: "row.upserted", row }] }, "online");
  }

  /** A 区更新：字段级整体替换，绝不深合并。 */
  function updateState(
    session: MobileSession,
    patch: {
      revision?: number;
      control?: SessionControl;
      config?: SessionConfigState;
      usage?: ConversationSnapshot["usage"];
      pendingInteractions?: PendingInteraction[];
      /** 队列的新形状（0.7.1）。给值 = 这一拍要发 queue 键；不给 = 该键保持不动。 */
      queue?: ConversationSnapshot["queue"];
    },
  ): void {
    if (patch.revision !== undefined) session.revision = patch.revision;
    if (patch.control) session.control = patch.control;
    if (patch.config) session.config = patch.config;
    if (patch.pendingInteractions) session.pendingInteractions = patch.pendingInteractions;
    flushPending(session);
    emitFrame(
      session,
      {
        kind: "deltas",
        deltas: [
          {
            op: "state.updated",
            patch: {
              revision: session.revision,
              ...(patch.control ? { control: session.control } : {}),
              // control 变 = 忙/闲变了（startTurn 先置 run、settleTurn 先清 run）；queue 变 =
              // 队列长短/暂停态变了。两者都会改输入路由与动作门禁，跟着一起下发——不带它们
              // 的话客户端要等下一次 snapshot 才知道"现在能不能排队/该不该弹确认框"，
              // 实测表现是 inputRouting 永远停在上一次的取值。
              ...(patch.control || patch.queue
                ? { inputRouting: inputRoutingOf(session), availability: availabilityOf(session) }
                : {}),
              ...(patch.config ? { config: session.config } : {}),
              ...(patch.usage ? { usage: patch.usage } : {}),
              ...(patch.pendingInteractions ? { pendingInteractions: patch.pendingInteractions } : {}),
              ...(patch.queue ? { queue: patch.queue } : {}),
            },
          },
        ],
      },
      "online",
    );
  }

  function emptyConfig(): SessionConfigState {
    return {
      provider: "",
      model: "",
      thought: "",
      thoughtLevels: [],
      followupMode: "queue",
      mode: "build",
    };
  }

  /** 本次执行的有效模式：mode=plan 或 planEnabled=true 都按计划模式（与 UI 的 resolveExecutionState 同判据）。 */
  function executionModeOf(session: MobileSession): MobileExecutionMode {
    const mode = normalizeExecutionMode(session.config.mode);
    if (mode === "plan" || session.config.planEnabled === true) return "plan";
    return mode;
  }

  /** 系统"所有文件访问"是否已授予（0.7.4）：桥在且回 true 才算，Node harness 无桥 → false。 */
  function hasAllFilesAccess(): boolean {
    const bridge = (globalThis as { zcodeDevice?: { allFilesGranted?(): boolean } }).zcodeDevice;
    try {
      return typeof bridge?.allFilesGranted === "function" ? bridge.allFilesGranted() === true : false;
    } catch {
      return false;
    }
  }

  /**
   * 一次提交带的执行意图（sendText.mode/planEnabled、firstInput、switchCollaborationMode）落进会话配置。
   * UI 的工具栏读 config.mode 显示"当前值"，运行侧读同一份决定审批与禁写——一份事实两处消费。
   * 值不在列内（旧发送端/脏草稿）按 build 落，并在 agentLog 里能看出来。
   */
  function applyExecutionIntent(
    session: MobileSession,
    mode: unknown,
    planEnabled: unknown,
  ): void {
    const nextMode = mode === undefined ? session.config.mode : normalizeExecutionMode(mode);
    const nextPlan =
      typeof planEnabled === "boolean" ? planEnabled : session.config.planEnabled;
    if (nextMode === session.config.mode && nextPlan === session.config.planEnabled) return;
    updateState(session, {
      revision: session.revision + 1,
      config: {
        ...session.config,
        mode: nextMode,
        ...(nextPlan !== undefined ? { planEnabled: nextPlan } : {}),
      },
    });
    persistSession(session);
    say(`执行模式：${nextMode}${nextPlan === true ? "（计划）" : ""}`);
  }

  /** 思考档位清单（0.5.1）：从 view 的 model.config.optionSpecs.reasoningLevel.values 读，
   *  与桌面 composer 选择器同一数据源。异步旁路（命令通路是同步的）：读到了就写进 config，
   *  快照的 settings.thoughtLevel.available 随之有值，UI 的档位选择器不再是空壳。 */
  function refreshThoughtLevels(session: MobileSession): void {
    const targets = options.modelTargets;
    const providerId = session.config.modelSelection?.providerId ?? session.config.provider;
    const modelId = session.config.modelSelection?.modelId ?? session.config.model;
    if (!targets || !providerId || !modelId) return;
    void resolveThoughtLevels(targets, providerId, modelId)
      .then((levels) => {
        if (levels.length === 0) return;
        if (JSON.stringify(session.config.thoughtLevels) === JSON.stringify(levels)) return;
        updateState(session, {
          revision: session.revision + 1,
          config: { ...session.config, thoughtLevels: levels },
        });
      })
      .catch(() => {
        // 视图读不到（provider 没起来/会话已删）：档位清单留空，不影响对话本身。
      });
  }

  function register(session: MobileSession): MobileSession {
    sessions.set(session.sessionId, session);
    return session;
  }

  function createSession(
    sessionId: string,
    config: SessionConfigState,
    workspacePath: string,
  ): MobileSession {
    return register({
      sessionId,
      workspacePath,
      logEpoch: newId("epoch"),
      revision: 0,
      seq: 0,
      rows: [],
      nextRowId: 1,
      control: draftControl(),
      config,
      cumulative: { inputTokens: 0, outputTokens: 0 },
      run: null,
      pendingInteractions: [],
      // 队列不持久化（协议裁决：进程死了就丢，重启后由用户决定重发），所以每次建会话都是空的。
      queue: { items: [], autoDrain: true, nextAdmissionSeq: 0 },
      reasoningRowId: null,
      reasoningStartedAt: 0,
      missing: false,
    });
  }

  /** UI 订阅一个我们没建过的会话：只可能是重启后回看历史，如实说明，不给空白时间线。 */
  function missingSession(sessionId: string, workspacePath: string): MobileSession {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    return register({
      sessionId,
      workspacePath,
      logEpoch: newId("epoch"),
      revision: 0,
      seq: 0,
      rows: [],
      nextRowId: 1,
      control: {
        ...settledControl("error", null),
        lastError: errorInfo(
          "mobile.session.notRestored",
          store
            ? "这条会话在持久化库里没有找到（可能来自别的设备，或记录已损坏）。"
            : "端侧的会话持久化没有起来：这台设备上看不到之前那次对话的内容。",
          "runtime",
          false,
        ),
      },
      config: emptyConfig(),
      cumulative: { inputTokens: 0, outputTokens: 0 },
      run: null,
      pendingInteractions: [],
      queue: { items: [], autoDrain: true, nextAdmissionSeq: 0 },
      reasoningRowId: null,
      reasoningStartedAt: 0,
      missing: true,
    });
  }

  // ── 持久化：每轮落盘、订阅时还原、workspace 起来时水合侧栏 ──

  /**
   * 只取**属于这条会话**的每轮用量。turnUsage 是按 turnId 全局记的，整表存进每一条会话
   * 会让库随会话数平方增长，而且还原时把别人的用量算到自己头上。
   */
  function turnUsageOf(session: MobileSession): Record<string, PersistedTurnUsage> {
    const out: Record<string, PersistedTurnUsage> = {};
    for (const row of session.rows) {
      const usage = turnUsage.get(row.turnId);
      if (usage) out[row.turnId] = usage;
    }
    return out;
  }

  /**
   * 把这条会话的当前事实写进 SQLite。写频是每轮一次（startTurn / settleTurn / 改配置），
   * 不是逐 token：两个后端的写都是同步通道，逐 token 写会先把流式渲染卡死。
   * 失败只报诊断、不抛——落盘失败不该打死正在进行的对话。
   */
  function persistSession(session: MobileSession): void {
    if (!store || session.missing) return;
    try {
      const summary = summaryOf(session, stateForSessionPath(session.workspacePath).workspaceKey);
      store.save({
        sessionId: session.sessionId,
        workspacePath: session.workspacePath,
        summary,
        state: {
          rows: session.rows,
          config: session.config,
          revision: session.revision,
          cumulative: { ...session.cumulative },
          nextRowId: session.nextRowId,
          turnUsage: turnUsageOf(session),
          phase: session.control.phase,
          lastError: session.control.lastError,
        },
      });
    } catch (e) {
      say(`会话 ${session.sessionId} 落盘失败（重启后将看不到这一轮）：${String((e as Error)?.message ?? e)}`);
    }
  }

  /**
   * 进程死在半路时，库里的行还带着瞬态标记（turnHeader "running"、assistantText "streaming"）。
   * 照原样还原，UI 会画一个永远转圈的轮次头和永远闪光标的气泡 —— 而设备上其实什么请求都没有。
   * 与 phase 的"running → completedInterrupted"是同一条事实，行级也要跟上（rows.ts:77/:162 的枚举）。
   */
  function settleDanglingRows(rows: ConversationRow[]): ConversationRow[] {
    const ended = now();
    return rows.map((row) => {
      if (row.kind === "turnHeader" && row.state === "running") {
        return {
          ...row,
          state: "completedInterrupted" as const,
          endedAt: ended,
          activeMs: Math.max(0, ended - row.startedAt),
        };
      }
      if (row.kind === "assistantText" && row.state === "streaming") {
        return { ...row, state: "interrupted" as const };
      }
      // 思考行同理（0.7.3）：重启前开着流式思考，还原后不能停在 streaming（光标永远闪）。
      if (row.kind === "reasoning" && row.state === "streaming") {
        return { ...row, state: "interrupted" as const };
      }
      return row;
    });
  }

  /**
   * 内存里没有时从库里还原。还原出来的会话 `missing=false`，于是它和时间线、readSession、
   * 以及"接着说下一句"都是通的 —— 这才叫还原，不只是把旧文字画出来。
   *
   * 三处必须改写而不是照抄库里的值：
   *   1. **phase 停在 running/prewarming 的那一轮**：进程已经死了，设备上没有任何在跑的请求，
   *      而 `run` 还原不出来（AbortController 不可序列化）。照抄 running 会让 UI 永远转圈、
   *      停止键也按不动，所以一律收成"被打断"并写明原因；行级瞬态由 settleDanglingRows 收口。
   *   2. **logEpoch 与 seq 归零重来**：它们是这一次进程内的帧水位，拿旧值会让客户端以为
   *      可以 resume，然后用旧投影拼新 delta —— 时间线会长出假内容。
   *   3. **turnUsage 按轮恢复进全局表**：snapshotFor 按 turnId 查它给每轮报 tokens，
   *      不恢复的话还原后的会话用量全是 0（屏幕上的 token 计数直接读 snapshot）。
   */
  function restoreSession(sessionId: string, workspacePath: string): MobileSession | null {
    if (!store) return null;
    let persisted;
    try {
      persisted = store.load(sessionId);
    } catch (e) {
      say(`读取会话 ${sessionId} 的持久化记录失败：${String((e as Error)?.message ?? e)}`);
      return null;
    }
    if (!persisted) return null;
    const diedMidTurn =
      persisted.state.phase === "running" || persisted.state.phase === "prewarming";
    const phase = diedMidTurn ? "completedInterrupted" : persisted.state.phase;
    const lastError = diedMidTurn
      ? errorInfo(
          "mobile.session.interruptedByRestart",
          "上一次退出时这一轮还没跑完；重启后不会自动继续，可以重新发一次。",
          "runtime",
          true,
        )
      : persisted.state.lastError;
    for (const [turnId, usage] of Object.entries(persisted.state.turnUsage)) {
      turnUsage.set(turnId, usage);
    }
    const session = register({
      sessionId,
      workspacePath: persisted.workspacePath || workspacePath,
      logEpoch: newId("epoch"),
      revision: persisted.state.revision,
      seq: 0,
      rows: diedMidTurn ? settleDanglingRows(persisted.state.rows) : persisted.state.rows,
      nextRowId: persisted.state.nextRowId,
      control: settledControl(phase, lastError),
      config: persisted.state.config,
      cumulative: { ...persisted.state.cumulative },
      run: null,
      pendingInteractions: [],
      // 队列刻意不还原：协议裁决"CLI 进程死亡即丢，重新对齐后由用户决定重发"。
      queue: { items: [], autoDrain: true, nextAdmissionSeq: 0 },
      reasoningRowId: null,
      reasoningStartedAt: 0,
      missing: false,
    });
    say(`从持久化还原会话 ${sessionId}（${session.rows.length} 行，phase=${phase}）`);
    return session;
  }

  /** 内存 → 持久化 → 占位，三级兜底。所有"按 sessionId 找会话"的入口都走这一条。 */
  function sessionOrRestore(sessionId: string, workspacePath: string): MobileSession {
    return sessions.get(sessionId) ?? restoreSession(sessionId, workspacePath) ?? missingSession(sessionId, workspacePath);
  }

  /**
   * workspace 第一次被用到时，把库里的历史会话摘要灌进 sessions-index 的快照。
   *
   * 为什么必须在 announceWorkspaceRuntime 之前：同步器只在收到 lifecycle "available" 之后
   * 才订阅 sessions-index（zcodeTaskIndexSyncer.ts:1546），而它拿到的**首帧**就是这里的快照。
   * 不水合的话首帧是空的 —— 侧栏那一行只能靠 task-index 库里的旧记录撑着，而一旦那条链
   * 有任何一环没跑通，用户看到的就是"退出后历史全没了"。
   */
  function hydrateWorkspaceFromStore(workspacePath: string): void {
    if (!store) return;
    const state = stateForSessionPath(workspacePath);
    // 本进程内已经建过内容就别覆盖：内存里的是活的事实，库里的是上一拍的快照。
    if (state.summaries.size > 0) return;
    let entries;
    try {
      entries = store.listSummaries(workspacePath);
    } catch (e) {
      say(`水合 workspace=${workspacePath} 的历史会话失败：${String((e as Error)?.message ?? e)}`);
      return;
    }
    if (entries.length === 0) return;
    for (const { sessionId, summary } of entries) {
      // workspaceId 要换成当前这把 key：库里存的是当时的值，而帧是按 workspaceKey 过滤的，
      // 对不上就会被静默丢掉（emitWorkspaceTopicFrame 的那道 topic 校验）。
      state.summaries.set(sessionId, { ...summary, workspaceId: state.workspaceKey });
    }
    say(`从持久化水合 ${entries.length} 条历史会话进 workspace=${state.workspaceKey} 的索引`);
  }

  async function configWithDefaultModel(): Promise<SessionConfigState> {
    const base = emptyConfig();
    if (!options.modelTargets) return base;
    const selection = await resolveDefaultSelection(options.modelTargets).catch(() => null);
    if (!selection) return base;
    return { ...base, provider: selection.providerId, model: selection.modelId, modelSelection: selection };
  }

  // ── 一轮执行 ──
  /**
   * 工具循环里**本轮私有**的模型历史：持久化的 session.rows 只有文本行（跨轮的 tool 消息
   * 不重建 —— 下一轮的历史只需要对话文本，OpenAI 也不要求带着上一轮的工具往返）。
   * 但**当前这一轮内**的 assistant(tool_calls) → tool(结果) 必须原样带回去，否则第二步起
   * 模型看不到自己调了什么、拿到什么结果，循环直接死在"重复调用同一个工具"上。
   * 所以循环用的是局部 transcript，不是 historyMessages(session)。
   */
  function historyMessages(session: MobileSession): ModelTurnMessage[] {
    const out: ModelTurnMessage[] = [];
    for (const row of session.rows) {
      if (row.kind === "userInput" && row.origin === "realUser") {
        out.push({ role: "user", content: row.text });
      } else if (row.kind === "assistantText" && row.text) {
        out.push({ role: "assistant", content: row.text });
      }
    }
    return out.slice(-HISTORY_MESSAGES_MAX);
  }

  /**
   * 提示词按引擎在不在现场分两种：没有引擎时保留"工具不可用"的实话（0.4.2 及以前的全部
   * 出货行为），有了引擎才允许模型调工具 —— prompt 永远不许诺这一轮做不到的事。
   * engine 参数是本轮解析出的引擎（可能为 null：core 加载失败、或组合根没接）。
   */
  function systemPrompt(workspacePath: string, engine: ToolEngine | null, mode: MobileExecutionMode = "build"): string {
    const lines = [
      "You are ZCode running on a phone.",
      "Reply in the language the user writes in.",
    ];
    if (engine) {
      lines.push(
        "You can read and edit files inside the workspace using the provided tools. Use them when the user asks to inspect or change files; call a tool, read its result, then continue.",
      );
    } else {
      lines.push(
        "Tool use, file editing and MCP are not available in this build; if the user asks for them, say so plainly.",
      );
    }
    // 执行模式（0.7.2）：写进提示词让模型的行为与"访问调节"一致——计划模式别硬试写类工具
    // （试了也会被拦），完全访问不必反复请示。两句话都只是把闸门的存在说清楚，不替用户做决定。
    if (mode === "plan") {
      lines.push(
        "Execution mode: PLAN. Do not modify files (Write/Edit/Delete are blocked); inspect with read-only tools and commands, present a plan, then wait for the user to confirm.",
      );
    } else if (mode === "yolo") {
      lines.push(
        "Execution mode: FULL ACCESS. You may make changes and run commands without asking for confirmation.",
      );
    }
    lines.push(`Workspace path on device: ${workspacePath}`);
    // 全部文件访问已授予（0.7.4）：告诉模型真实路径就在手边——不然它不知道能直接读写
    // /sdcard，更不会知道"下载文件夹"= /sdcard/Download（用户点名的"找不到下载文件夹"）。
    // Node harness 没有 zcodeDevice 桥 → 这一句不出现，systemPrompt 逐字不变（回归不受影响）。
    if (hasAllFilesAccess()) {
      lines.push(
        "All-files access is granted: you can read and write the phone's real files directly via absolute paths. Shared storage is under /sdcard — the Downloads folder is /sdcard/Download, Documents is /sdcard/Documents. Prefer these real paths when the user names a folder rather than staying inside the private workspace.",
      );
    }
    return lines.join("\n");
  }

  function startTurn(
    session: MobileSession,
    params: { workspacePath: string; text: string; sourceCommandId?: string; config?: Partial<SessionConfigState> },
  ): TurnHandles {
    const turnId = newId("turn");
    const startedAt = now();
    const executionId = newId("exec");
    const headerRowId = takeRowId(session);
    const inputRowId = takeRowId(session);
    const assistantRowId = takeRowId(session);

    if (params.config) session.config = { ...session.config, ...params.config };
    session.run = { abort: new AbortController(), executionId, turnId };

    const header: TurnHeaderRow = {
      rowId: headerRowId,
      turnId,
      entityId: turnId,
      createdAt: startedAt,
      createdAtSeq: session.seq,
      kind: "turnHeader",
      origin: "userInput",
      executionKind: "agent",
      ...(params.sourceCommandId ? { sourceCommandId: params.sourceCommandId } : {}),
      state: "running",
      startedAt,
    };
    appendRow(session, header);
    appendRow(session, {
      rowId: inputRowId,
      turnId,
      entityId: String(inputRowId),
      createdAt: startedAt,
      createdAtSeq: session.seq,
      kind: "userInput",
      text: params.text,
      // realUser 是这条协议里"真的是人打出来的"唯一取值；其余（synthetic/mailbox/…）会被 UI 折进别处。
      origin: "realUser",
      ...(params.sourceCommandId ? { sourceCommandId: params.sourceCommandId } : {}),
      visibility: "visible",
      actions: { canEdit: true, canRetry: true },
    });
    appendRow(session, {
      rowId: assistantRowId,
      turnId,
      entityId: String(assistantRowId),
      createdAt: now(),
      createdAtSeq: session.seq,
      kind: "assistantText",
      text: "",
      state: "streaming",
    });
    updateState(session, { revision: session.revision + 1, control: runningControl(startedAt, executionId) });
    publishSessionIndex(session);
    // 开轮就落一次：进程在这一轮中间被杀（Android 后台回收是常态）时，库里至少已有
    // 用户那句话和这一轮的头部；收口那一次再把终态盖上去。
    persistSession(session);
    return { turnId, headerRowId, inputRowId, assistantRowId, inputId: turnId };
  }

  function settleTurn(
    session: MobileSession,
    handles: TurnHandles,
    outcome:
      | { kind: "success"; text: string; model: string }
      | { kind: "empty" }
      | { kind: "interrupted" }
      | { kind: "failed"; code: string; message: string; source: "provider" | "runtime" | "network" },
  ): void {
    flushPending(session);
    // 收口兜底（0.7.3）：这一轮以何种结局收场，开着的思考行都不能停在 streaming——
    // 光标会一直闪在"深度思考"卡上，看起来像整个应用还在忙。
    closeReasoningRow(session, outcome.kind === "interrupted" ? "interrupted" : "complete");
    const ended = now();
    const header = session.rows.find((r) => r.rowId === handles.headerRowId);
    if (header && header.kind === "turnHeader") {
      upsertRow(session, {
        ...header,
        state:
          outcome.kind === "failed"
            ? "failed"
            : outcome.kind === "interrupted"
              ? "completedInterrupted"
              : "completedSuccess",
        endedAt: ended,
        activeMs: ended - header.startedAt,
      });
    }
    const assistant = session.rows.find((r) => r.rowId === handles.assistantRowId);
    if (assistant && assistant.kind === "assistantText") {
      const state =
        outcome.kind === "failed"
          ? "failed"
          : outcome.kind === "interrupted"
            ? "interrupted"
            : "complete";
      upsertRow(session, {
        ...assistant,
        state,
        ...(outcome.kind === "success" ? { text: outcome.text, model: outcome.model } : {}),
      });
    }

    session.run = null;
    // 空补全不是"模型正常回了个空"就完了：它必须能被看出来，否则屏幕上是空气泡，报告里也是空气泡。
    const emptyNote =
      outcome.kind === "empty"
        ? errorInfo(
            "mobile.model.emptyCompletion",
            "模型这一轮没有返回任何正文（可能是额度用尽、上下文超限，或服务端只回了用量）。",
            "provider",
            true,
          )
        : outcome.kind === "failed"
          ? errorInfo(outcome.code, outcome.message, outcome.source, true)
          : session.control.lastError;
    updateState(session, {
      revision: session.revision + 1,
      usage: usageState(session),
      control: settledControl(
        outcome.kind === "failed"
          ? "error"
          : outcome.kind === "interrupted"
            ? "completedInterrupted"
            : "completedSuccess",
        emptyNote,
      ),
    });
    if (outcome.kind === "failed") {
      say(`轮次失败（${session.sessionId}）：${outcome.code} —— ${outcome.message}`);
    }
    // 收口之后必须再投一次：同步器要靠"非终态 → 终态"这次迁移写 status 并广播
    // （zcodeTaskIndexSyncer.ts:678-685 applyTerminalTransition），只发开头那一帧的话，
    // 侧栏那一行会永远停在"进行中"。
    publishSessionIndex(session);
    // 收口这一拍是权威的落盘点：终态 control、完整 assistant 正文、这一轮的真实用量都在此刻齐了。
    persistSession(session);
  }

  // ── 等待队列（0.7.1）──
  // 生命线：sendText(忙) → enqueueInput → emitQueue；run 收口 → afterTurnSettled →
  // pendingStartNow（抢占）优先，其次 autoDrain 排空；stop/失败 → 队列暂停待用户恢复。
  // 事务性注意：所有队列改动都先改 session.queue 再 emitQueue（一帧就是当前事实），
  // 不存在"帧发了、状态没改"的中间态可供客户端读到。

  /** 把一条忙时输入放进队列（不 emit，调用方决定何时发帧——抢占路径要连删带放一起说）。 */
  function enqueueInput(
    session: MobileSession,
    envelope: CommandEnvelope,
    input: {
      text: string;
      modelSelection?: ModelSelectionValue;
      mode?: unknown;
      planEnabled?: unknown;
      requested: "auto" | "startNow" | "queue" | "guide";
      admitted: "queue";
      fallbackReasonCode?: string;
    },
  ): MobileQueueItem {
    session.queue.nextAdmissionSeq += 1;
    const queueItemId = newId("q");
    // 模式随队列项走（协议 intent 里就有 mode/planEnabled 两格）：排到它时才落进会话配置，
    // 中途用户改了模式也不会把"这条消息当时的意图"改掉。
    const itemMode = input.mode === undefined ? undefined : normalizeExecutionMode(input.mode);
    const itemPlan = typeof input.planEnabled === "boolean" ? input.planEnabled : undefined;
    const item: MobileQueueItem = {
      queueItemId,
      sourceCommandId: envelope.commandId,
      clientId: boundClientId ?? "mobile-client",
      kind: "sendText",
      text: input.text,
      // 附件面端侧还没接（composer 的附件上传走的是桌面传输层）；协议要数组，给空。
      attachments: [],
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(itemMode ? { mode: itemMode } : {}),
      ...(itemPlan !== undefined ? { planEnabled: itemPlan } : {}),
      delivery: {
        requested: input.requested,
        admitted: input.admitted,
        ...(input.fallbackReasonCode ? { fallbackReasonCode: input.fallbackReasonCode } : {}),
      },
      order: { admissionSeq: session.queue.nextAdmissionSeq, queuePosition: session.queue.items.length + 1 },
      steer: {
        state: input.requested === "guide" ? "fellBack" : "notRequested",
        ...(input.requested === "guide" ? { reasonCode: "mobile.queue.guideFallsBack" } : {}),
      },
      dispatch: { state: "queued" },
      admittedAt: now(),
      provenance: { sourceCommandId: envelope.commandId, queueItemId, clientId: boundClientId ?? "mobile-client" },
    };
    session.queue.items = [...session.queue.items, item];
    return item;
  }

  /** 队列项起跑：先出队（连同帧），再按它带的文本/选择/模式开一轮。 */
  function startQueuedItem(session: MobileSession, item: MobileQueueItem): void {
    session.queue.items = session.queue.items.filter(
      (candidate) => candidate.queueItemId !== item.queueItemId,
    );
    emitQueue(session, `排到队首，开跑「${item.text.slice(0, 16)}」`);
    // 队列项带着提交那一刻的模式意图：起跑时落地（中途用户改模式不影响已排队的意图）。
    applyExecutionIntent(session, item.mode, item.planEnabled);
    const handles = startTurn(session, {
      workspacePath: session.workspacePath,
      text: item.text,
      sourceCommandId: item.sourceCommandId,
      config: item.modelSelection ? { modelSelection: item.modelSelection } : undefined,
    });
    runTurnThenContinue(session, handles, {
      workspacePath: session.workspacePath,
      selection: item.modelSelection ?? session.config.modelSelection ?? null,
    });
  }

  /** 收轮后的续跑：抢占项优先，其次 autoDrain 排空；stop/失败把队列置为暂停。 */
  function afterTurnSettled(session: MobileSession): void {
    if (sessions.get(session.sessionId) !== session) return; // dispose 过的会话不再续跑
    const pending = session.pendingStartNow;
    if (pending) {
      session.pendingStartNow = undefined;
      startQueuedItem(session, pending);
      return;
    }
    const hasQueued = session.queue.items.some((item) => item.dispatch.state === "queued");
    const phase = session.control.phase;
    if (phase !== "completedSuccess") {
      // 中断（用户按了停止）或失败：待跑项保留但不再自动跑（协议文案："由于你中断了当前响应，
      // 队列已暂停"/"由于当前响应出错，队列已暂停（内容未丢失）"）。下一句新消息或面板「恢复」解开。
      if (hasQueued && session.queue.autoDrain) {
        session.queue.autoDrain = false;
        session.queue.pauseReason = phase === "error" ? "error" : "stopped";
        emitQueue(session, phase === "error" ? "出错，队列已暂停" : "已停止，队列已暂停");
      }
      return;
    }
    if (!hasQueued || !session.queue.autoDrain) return;
    const next = session.queue.items.find((item) => item.dispatch.state === "queued");
    if (next) startQueuedItem(session, next);
  }

  /** 带收轮续跑的 runTurn 包装：两处起跑点（新建会话首条 / sendText）都走它。 */
  function runTurnThenContinue(
    session: MobileSession,
    handles: TurnHandles,
    params: { workspacePath: string; selection: ModelSelectionValue | null },
  ): void {
    void runTurn(session, handles, params)
      .catch((e) => {
        // runTurn 内部已把失败收口成 settleTurn；这里兜的是它自己抛出来的意外（不该发生），
        // 兜住是为了队列排空不被一个未捕获 rejection 打断。
        say(`轮次意外异常：${String((e as Error)?.message ?? e)}`);
      })
      .finally(() => afterTurnSettled(session));
  }

  /**
   * 立一条 Bash 审批交互并等待裁决。resolve 的来源只有两个：resolveInteraction 命令（用户点了
   * 弹窗）、abort/超时（拒绝收场）。pendingInteractions 走 state.updated 进快照（键级整体替换，
   * 协议 apply.ts 的既有语义），无论哪个出口都必须把它清空——留着一张没人点的弹窗，composer
   * 会永远被挡住。
   */
  // "始终允许"的会话级记忆（0.4.8，用户点名"给出记忆命令然后始终同意的选项"）：
  // key = 工具名 + 命令/路径文本（上游 allowAlways 的 command scope 语义：相同命令不再问）。
  // 只存内存（WeakMap，随 session 走）不落盘——跨会话持久放行任意命令是另一档风险，
  // 需要时再做。Bash 按命令文本精确匹配；Delete 按路径精确匹配。
  const alwaysApproved = new WeakMap<MobileSession, Set<string>>();
  function alwaysKey(call: { name: string; arguments: string }): string {
    if (call.name === "Delete") {
      try {
        const parsed = JSON.parse(call.arguments) as { path?: unknown };
        return `Delete:${typeof parsed?.path === "string" ? parsed.path : call.arguments.slice(0, 200)}`;
      } catch {
        return `Delete:${call.arguments.slice(0, 200)}`;
      }
    }
    return `Bash:${tryParseCommandText(call.arguments)}`;
  }

  function requestToolApproval(
    session: MobileSession,
    interactionId: string,
    toolCallId: string,
    call: { name: string; arguments: string },
  ): Promise<"allow" | "deny" | "abort"> {
    // 命中"始终允许"记忆：不再弹窗，直接放行（弹窗消失、composer 不进 pending 态）。
    if (alwaysApproved.get(session)?.has(alwaysKey(call))) return Promise.resolve("allow");
    const signal = session.run?.abort.signal;
    const payload = {
      kind: "permission" as const,
      toolCallId,
      toolName: call.name,
      summary: `端上请求执行${call.name === "Bash" ? "命令" : "操作"}：${call.name}`,
      // 0.7.2：Delete 也进了审批面（build=变更前确认），弹窗里要显示"删哪个"而不是一坨 JSON。
      detail: { command: approvalDetailOf(call) },
      options: [
        { optionId: "allow_once", label: "允许这一次", kind: "allowOnce" as const },
        { optionId: "allow_always", label: "始终允许", kind: "allowAlways" as const },
        { optionId: "deny", label: "拒绝", kind: "deny" as const },
      ],
    };
    const interaction = {
      interactionId,
      kind: "permission" as const,
      anchorRowId: null,
      createdAt: now(),
      payload,
    };
    updateState(session, {
      revision: session.revision + 1,
      pendingInteractions: [interaction as unknown as PendingInteraction],
    });
    const decision = new Promise<"allow" | "deny">((resolveDecision) => {
      pendingInteractionResolvers.set(interactionId, (optionId) => {
        if (optionId === "allow_always") {
          const set = alwaysApproved.get(session) ?? new Set<string>();
          set.add(alwaysKey(call));
          alwaysApproved.set(session, set);
          resolveDecision("allow");
          return;
        }
        resolveDecision(optionId === "allow_once" ? "allow" : "deny");
      });
    });
    const aborted = signal
      ? new Promise<"abort">((resolveAbort) => {
          if (signal.aborted) resolveAbort("abort");
          else signal.addEventListener("abort", () => resolveAbort("abort"), { once: true });
        })
      : null;
    // 无限时等待（0.5.1，用户点名"审批弹窗的限时应当取消，后台不动回来还是按原来那样原地
    // 继续"）：弹窗挂多久都行——切后台 WebView 冻结 timer，120s 上限会在用户回前台那一刻
    // 准点"超时拒绝"，把一次正常离开变成一轮被掐死的对话。取消限时后唯一的收口是用户
    // 自己点选项或按停止（aborted 仍在 race 里）；process 死亡由 restore 侧清理挂起交互。
    const race = [decision, ...(aborted ? [aborted] : [])];
    return Promise.race(race).finally(() => {
      pendingInteractionResolvers.delete(interactionId);
      // 出口统一清交互：弹窗消失、composer 的 pending 判定解除。
      if (session.pendingInteractions.some((pi) => pi.interactionId === interactionId)) {
        updateState(session, {
          revision: session.revision + 1,
          pendingInteractions: session.pendingInteractions.filter(
            (pi) => pi.interactionId !== interactionId,
          ),
        });
      }
    });
  }

  /** 工具入参的 JSON 解析（钩子 stdin 的 tool_input 要的是对象，不是 JSON 字符串）；
   *  解析不了就把原文递过去——钩子拿到的东西"是什么就说什么"，不在这里替它猜。 */
  function safeParseToolInput(argsJson: string): unknown {
    try {
      return JSON.parse(argsJson) as unknown;
    } catch {
      return argsJson;
    }
  }

  /** 审批弹窗里的"要执行什么"：Bash 给命令文本，Delete 给路径，其余回原文（只展示，不校验）。 */
  function approvalDetailOf(call: { name: string; arguments: string }): string {
    if (call.name === "Bash") return tryParseCommandText(call.arguments);
    const parsed = safeParseToolInput(call.arguments);
    if (parsed && typeof parsed === "object") {
      const record = parsed as { path?: unknown; file_path?: unknown };
      const target =
        typeof record.path === "string"
          ? record.path
          : typeof record.file_path === "string"
            ? record.file_path
            : "";
      if (target) return target;
    }
    return call.arguments.slice(0, 200);
  }

  /** Bash 入参里把 command 抽出来给弹窗看；解析不了就回原文（弹窗只展示，不承担校验）。 */
  function tryParseCommandText(argsJson: string): string {
    try {
      const parsed = JSON.parse(argsJson) as { command?: unknown };
      return typeof parsed?.command === "string" ? parsed.command : argsJson.slice(0, 200);
    } catch {
      return argsJson.slice(0, 200);
    }
  }

  // ── 沙箱授权（0.5.0）──

  /** 从文件端口的 permission_denied 回包里抠出被拒的路径（消息形状见 file-system.mjs 的 guard）。 */
  function deniedPathOf(outcome: { isError: boolean; errorCode?: string; errorMessage?: string; content: string }): string | null {
    if (!outcome.isError || outcome.errorCode !== "permission_denied") return null;
    const m = /路径越出授权工作区[:：]\s*(\S+)/.exec(`${outcome.errorMessage ?? ""}\n${outcome.content}`);
    const p = m?.[1]?.trim();
    return p && p.startsWith("/") ? p : null;
  }

  /** 授权粒度：/mnt/<名>/… 归一到挂载根（挂载就是"一个根"的自然单位，同挂载内不再逐文件问）；
   *  其余路径批它自己。绝不上浮到 "/"——那等于把沙箱整个拆掉，不是"询问授权"。 */
  function grantScopeOf(path: string): string {
    const m = /^(\/mnt\/[^/]+)\//.exec(path);
    return m && m[1] ? m[1] : path;
  }

  /** 路径授权弹窗：形状与 Bash 审批同构（同样的 permission payload，PermissionDialog 直接渲染）。
   *  与 Bash 审批的区别在返回值：这里必须区分"允许这一次"和"本会话允许"——前者重试后收回
   *  授权根，后者留到会话结束（对齐 allowedAlways 的语义，不做静默的永久放行）。 */
  function requestPathApproval(
    session: MobileSession,
    interactionId: string,
    toolCallId: string,
    call: { name: string; arguments: string },
    deniedPath: string,
    scope: string,
  ): Promise<"allow_once" | "allow_always" | "deny" | "abort"> {
    const alwaysKey = `Path:${scope}`;
    if (alwaysApproved.get(session)?.has(alwaysKey)) return Promise.resolve("allow_always");
    const signal = session.run?.abort.signal;
    const payload = {
      kind: "permission" as const,
      toolCallId,
      toolName: call.name,
      summary: `模型请求访问工作区外的路径：${deniedPath}`,
      detail: { path: deniedPath, scope, tool: call.name },
      options: [
        { optionId: "allow_once", label: "允许这一次", kind: "allowOnce" as const },
        { optionId: "allow_always", label: "本会话允许该目录", kind: "allowAlways" as const },
        { optionId: "deny", label: "拒绝", kind: "deny" as const },
      ],
    };
    const interaction = {
      interactionId,
      kind: "permission" as const,
      anchorRowId: null,
      createdAt: now(),
      payload,
    };
    updateState(session, {
      revision: session.revision + 1,
      pendingInteractions: [interaction as unknown as PendingInteraction],
    });
    const decision = new Promise<"allow_once" | "allow_always" | "deny">((resolveDecision) => {
      pendingInteractionResolvers.set(interactionId, (optionId) => {
        if (optionId === "allow_always") {
          const set = alwaysApproved.get(session) ?? new Set<string>();
          set.add(alwaysKey);
          alwaysApproved.set(session, set);
          resolveDecision("allow_always");
          return;
        }
        resolveDecision(optionId === "allow_once" ? "allow_once" : "deny");
      });
    });
    const aborted = signal
      ? new Promise<"abort">((resolveAbort) => {
          if (signal.aborted) resolveAbort("abort");
          else signal.addEventListener("abort", () => resolveAbort("abort"), { once: true });
        })
      : null;
    // 同 Bash 审批（0.5.1）：无限时等待，后台回来原地继续；收口只有用户选项/停止。
    return Promise.race([decision, ...(aborted ? [aborted] : [])]).finally(() => {
      pendingInteractionResolvers.delete(interactionId);
      if (session.pendingInteractions.some((pi) => pi.interactionId === interactionId)) {
        updateState(session, {
          revision: session.revision + 1,
          pendingInteractions: session.pendingInteractions.filter(
            (pi) => pi.interactionId !== interactionId,
          ),
        });
      }
    });
  }

  /** resolveInteraction 命令：兑现挂起的审批。先到先得，晚到 noop（协议注释的语义）。 */
  function resolvePendingInteraction(interactionId: string, optionId: string | undefined): "accepted" | "noop" {
    const resolve = pendingInteractionResolvers.get(interactionId);
    if (!resolve) return "noop";
    resolve(optionId);
    return "accepted";
  }

  async function runTurn(
    session: MobileSession,
    handles: TurnHandles,
    params: { workspacePath: string; selection: ModelSelectionValue | null },
  ): Promise<void> {
    const signal = session.run?.abort.signal;
    if (!signal) return;
    const targets = options.modelTargets;
    if (!targets) {
      settleTurn(session, handles, {
        kind: "failed",
        code: "mobile.providerUnavailable",
        message: "端侧 Provider 运行时没有起来，模型调不到。",
        source: "runtime",
      });
      return;
    }
    const selection = params.selection ?? session.config.modelSelection ?? null;
    let target: ModelTarget;
    if (!selection || !selection.providerId || !selection.modelId) {
      settleTurn(session, handles, {
        kind: "failed",
        code: "mobile.modelNotSelected",
        message: "还没有可用的模型：端侧没有可执行的 Provider 配置，或登录态取不到凭据。",
        source: "provider",
      });
      return;
    }
    try {
      target = await resolveModelTarget(targets, selection);
      if (options.deviceId) target.metadataUserId = options.deviceId;
    } catch (e) {
      settleTurn(session, handles, {
        kind: "failed",
        code: e instanceof ProviderTargetError ? e.reasonCode : "mobile.providerResolveFailed",
        message: String((e as Error)?.message ?? e),
        source: "provider",
      });
      return;
    }

    // 引擎按 workspace 取（首轮加载 core bundle，之后命中缓存）；null = 这台没工具，
    // 下面整段与 0.4.2 的行为逐字一致：不发 tools 字段、prompt 保留"工具不可用"的实话。
    const engine = options.toolEngine ? await options.toolEngine(params.workspacePath) : null;

    // ── 钩子（0.7.1，用户点名"钩子未接入，请接入"）──
    // 一轮装配一次：读工作区/用户配置 → 建快照与信任门禁 → 从 core bundle 拿桌面同款 runner。
    // 装配失败/没有配置回 null，下面每个调用点都先看它在不在 —— 钩子层坏了绝不打断对话。
    // 事件 → 时间线行的投影挂在这里：runner 每发一条 hook_run_* 生命周期事件就 upsert 一条
    // hookInvocation 行（用户在时间线上看得见钩子跑没跑、成没成、谁拦了）。
    const hookStartedRuns = new Set<string>();
    const hookRowIds = new Map<string, number>();
    function hookLaneOf(eventName: string): "assistantWork" | "toolBefore" | "toolAfter" {
      if (eventName === "PreToolUse" || eventName === "PermissionRequest") return "toolBefore";
      if (eventName === "PostToolUse" || eventName === "PostToolUseFailure") return "toolAfter";
      return "assistantWork";
    }
    function onHookLifecycleEvent(event: MobileHookLifecycleEvent): void {
      const payload = event.payload ?? {};
      const invocationId = String(payload.hookInvocationId ?? "");
      const hookRunId = String(payload.hookRunId ?? "");
      if (!invocationId || !hookRunId) return;
      const type = String(event.type);
      const isStart = type === "hook_run_started";
      if (isStart) hookStartedRuns.add(hookRunId);
      const eventName = String(payload.hookEventName ?? "PreToolUse");
      const sourceKindRaw = String(payload.descriptor?.sourceKind ?? "user");
      const sourceKind: "user" | "plugin" | "project" =
        sourceKindRaw === "project" ? "project" : sourceKindRaw === "plugin" ? "plugin" : "user";
      const entry = {
        hookRunId,
        hookIndex: Number(payload.hookIndex ?? 0),
        didExecute: hookStartedRuns.has(hookRunId),
        state: isStart ? ("running" as const) : type === "hook_run_failed" ? ("failed" as const) : ("completed" as const),
        ...(typeof payload.outcome === "string" ? { outcome: payload.outcome as never } : {}),
        ...(payload.blockReason ? { blockReason: String(payload.blockReason).slice(0, 200) } : {}),
        startedAt: Number(payload.startedAt ?? now()),
        ...(isStart ? {} : { endedAt: now() }),
        ...(typeof payload.durationMs === "number" ? { durationMs: payload.durationMs } : {}),
        displayName: String(payload.descriptor?.statusMessage ?? payload.descriptor?.commandDisplay ?? "hook").slice(0, 120),
        sourceKind,
        ...(payload.descriptor?.pluginName ? { pluginName: payload.descriptor.pluginName } : {}),
        ...(payload.toolName ? { toolName: String(payload.toolName) } : {}),
      };
      const existingRowId = hookRowIds.get(invocationId);
      if (existingRowId === undefined) {
        const rowId = takeRowId(session);
        hookRowIds.set(invocationId, rowId);
        appendRow(session, {
          rowId,
          turnId: handles.turnId,
          entityId: invocationId,
          createdAt: now(),
          createdAtSeq: session.seq,
          kind: "hookInvocation",
          hookInvocationId: invocationId,
          hookEventName: eventName as never,
          hookCount: Math.max(1, Number(payload.hookCount ?? 1) || 1),
          state: entry.state,
          startedAt: entry.startedAt,
          lane: hookLaneOf(eventName),
          ...(payload.toolCallId ? { anchorToolCallId: String(payload.toolCallId) } : {}),
          executions: [entry as never],
        } as never);
        return;
      }
      const row = session.rows.find((candidate) => candidate.rowId === existingRowId);
      if (!row || row.kind !== "hookInvocation") return;
      const executions = [...row.executions];
      const index = executions.findIndex((candidate) => candidate.hookRunId === hookRunId);
      const current = index >= 0 ? executions[index] : undefined;
      if (current) executions[index] = { ...current, ...(entry as unknown as Record<string, unknown>) } as never;
      else executions.push(entry as never);
      const anyRunning = executions.some((candidate) => candidate.state === "running");
      const anyFailed = executions.some((candidate) => candidate.state === "failed");
      upsertRow(session, {
        ...row,
        executions,
        state: anyRunning ? "running" : anyFailed ? "failed" : "completed",
        ...(anyRunning ? {} : { endedAt: now() }),
      } as never);
    }
    let hookRuntime: MobileHookRuntime | null = null;
    try {
      const createRuntime = options.hookRuntimeFactory ?? createMobileHookRuntime;
      hookRuntime = await createRuntime({
        workspacePath: params.workspacePath,
        onLifecycleEvent: onHookLifecycleEvent,
        onDiagnostic: say,
      });
      for (const line of hookRuntime?.diagnostics ?? []) say(`钩子：${line}`);
    } catch (e) {
      say(`钩子装配失败（本轮不跑钩子）：${String((e as Error)?.message ?? e)}`);
      hookRuntime = null;
    }
    const hookInputBase = () => ({
      sessionId: session.sessionId,
      turnId: handles.turnId,
      cwd: params.workspacePath,
    });

    // 单轮输出预算（0.5.1）：4096 是 P0 临时值，长回答在那里被 finish_reason=length 拦腰截断
    // （"对话到一半被截断"的直接来源之一）。默认提到 16384；模型声明了上限（optionSpecs.
    // maxOutputTokens.max，GLM-5 系 64k/128k）就取两者的较小值——预算超上限网关直接 400。
    const maxOutputTokens = Math.min(
      MAX_OUTPUT_TOKENS,
      ...(target.maxOutputTokensCap ? [target.maxOutputTokensCap] : []),
    );

    let streamed = "";
    // 本轮内跨步累加：正文拼进气泡（单个 assistant 行），用量求和（网关一步报一步的）。
    const roundUsage = { inputTokens: 0, outputTokens: 0 };
    // ── 会话/提交钩子：SessionStart 只在会话第一轮；UserPromptSubmit 每轮都跑。──
    // 两者都能注入 additionalContext（进系统提示，与桌面同类）；UserPromptSubmit 还能阻止
    // 这次提交（continue:false / decision:block）——阻止时这一轮不开跑，如实收成失败并写出原因。
    const hookNotes: string[] = [];
    if (hookRuntime?.enabled && !signal.aborted) {
      const promptRow = session.rows.find((candidate) => candidate.rowId === handles.inputRowId);
      const promptText = promptRow && promptRow.kind === "userInput" ? promptRow.text : "";
      const isFirstTurn = !session.rows.some(
        (candidate) => candidate.kind === "userInput" && candidate.rowId !== handles.inputRowId,
      );
      try {
        if (isFirstTurn) {
          const sessionStart = await hookRuntime.run("SessionStart", { ...hookInputBase() });
          hookNotes.push(...(sessionStart.additionalContexts ?? []));
        }
        const submitted = await hookRuntime.run("UserPromptSubmit", {
          ...hookInputBase(),
          prompt: promptText,
        });
        hookNotes.push(...(submitted.additionalContexts ?? []));
        if (submitted.preventContinuation || submitted.blockRequested) {
          const reason = String(submitted.stopReason ?? "UserPromptSubmit 钩子阻止了这次提交。");
          say(`钩子阻止了本轮提交：${reason}`);
          settleTurn(session, handles, {
            kind: "failed",
            code: "mobile.hookBlocked",
            message: reason,
            source: "runtime",
          });
          return;
        }
      } catch (e) {
        // 钩子自己的异常不该打死对话（与桌面 runner 同判据：失败进诊断，turn 继续）。
        say(`提交钩子执行异常（已忽略）：${String((e as Error)?.message ?? e)}`);
      }
    }
    // Stop 钩子的续跑账（0.7.1）：continue 语义给一次机会就够多数场景；上限只防"钩子自己
    // 写了个死循环"。达到上限后不再续，正常收口——宁可少续一次，不在这里制造新的无界循环。
    let stopHookContinues = 0;
    const MAX_STOP_HOOK_CONTINUES = 5;
    // 本轮私有的模型 transcript：历史 + 每步的 assistant(tool_calls)/tool(结果)。
    // 循环第二步起模型必须看得见"自己调了什么、拿到什么"，否则只会重复调用。
    // 执行模式（0.7.2）：本轮所有审批/禁写判据的唯一来源（提交时已落进 session.config）。
    const execMode = executionModeOf(session);
    const transcript: ModelTurnMessage[] = [
      {
        role: "system",
        content: [
          systemPrompt(params.workspacePath, engine, execMode),
          ...hookNotes.map((note) => `Hook context: ${note}`),
        ].join("\n"),
      },
      ...historyMessages(session),
    ];
    // 重复签名账本（0.5.0）：key = 工具名+入参+错误回包摘要，value = 连续次数。
    // 只在**出错**的调用上累计（见调用点），任何一次成功调用/新的不同签名都清零——
    // 长任务里"同一工具连发、内容不同"是正常推进，不该被误判成循环。
    let lastSig = "";
    let lastSigCount = 0;
    // 截断续写：0.7.0 起**取消次数上限**（用户点名"几乎一句话就被截断，彻底取消不合理的
    // 截断限制"）。判据从"续了几次"换成"这次有没有真推进"——本轮累计正文（streamed）比上次
    // 续写时更长才续；没变长（残文一字不增 / 返回空文本却仍报截断的死局）就停手，交回正常
    // 收口（带截断标注）。transcript 每次续写都变长，撑爆上下文由 provider 报错自然收口，
    // 所以"有进展就续"放开了坏网络的连环掐线，又不会在真死局里无限空转。
    let lastContinuedLen = 0;
    // 每步一行正文（0.6.0，用户点名"最后的总结文字输出应当在工具流下面"）：startTurn 预建的
    // assistantText 行接第 0 步的叙述；工具行之后再有正文，懒建新行接续——时间线变成
    // 叙述/工具/叙述/工具/总结的自然顺序，与桌面 v4 的消息序一致，总结天然在工具流下面。
    // 懒建而不是预建：纯工具步（无叙述）不再留一排空气泡。
    let currentAssistantRowId = handles.assistantRowId;
    let needNewTextRow = false;
    try {
      for (let step = 0; ; step++) {
        if (signal.aborted) {
          settleTurn(session, handles, { kind: "interrupted" });
          return;
        }
        // 0.5.0：步数硬上限已删除（用户点名"12 步限制完全解除"）。这一轮的收口靠三样：
        // 模型自己不再发工具调用（正常收口）、同签名连续出错检测（失控循环）、abort/上下文
        // 撑爆（provider 如实报错进 catch）。`step` 只留给日志与诊断用。
        void step;
        // 本步正文的独立账（0.6.9）：流中断自动续写要把"这一步已生成的部分"回填 transcript——
        // `streamed` 是整轮累加（跨步），直接用它会把前几步的正文重复喂回模型。
        let stepText = "";
        let result: ModelStreamResult;
        try {
          result = await streamModelCompletionWithRetry({
            target,
            messages: transcript,
            maxOutputTokens,
            signal,
            // 有引擎才声明工具；无引擎时整个键缺席，请求体与 0.4.2 逐字节一致（地基冒烟钉过）。
            ...(engine ? { tools: engine.tools } : {}),
            // 重连旁路（0.4.10）：只记进 agentLog（装机报告可读"这一轮悄悄重连了几次"），
            // 不进正文、不改状态——用户看到的是"慢一点但成了"，而不是桌面端同款的重试噪音。
            onRetry: (attempt, waitMs, reason) =>
              say(`模型请求重连：第 ${attempt} 次尝试（上次 ${reason}，已等 ${Math.round(waitMs / 1000)} 秒）`),
            // 思考流（0.7.3）：与正文分道——reasoning 增量落 reasoning 行（可折叠"深度思考"卡），
            // content 增量落正文行；两段交替时先关旧行再开新行（openReasoning 懒建、close 幂等）。
            onReasoning: (piece) => {
              if (session.reasoningRowId === null) openReasoningRow(session, handles.turnId);
              // 服务端副本同步累加（与正文靠 streamed/settleTurn 回填同理）：row.delta 只走线，
              // session.rows 不跟着变的话，closeReasoningRow 的 upsert 会把整行 text:"" 发回去，
              // 客户端攒好的思考全文被盖成空（chat-smoke 判据 11 抓到的正是这条）。
              const rRow = session.rows.find((r) => r.rowId === session.reasoningRowId);
              if (rRow && rRow.kind === "reasoning") rRow.text += piece;
              stageDelta(session, {
                op: "row.delta",
                rowId: session.reasoningRowId as number,
                path: "text",
                append: piece,
              });
            },
            onDelta: (piece) => {
              // 正文开始 = 本步的思考结束：先关思考行再落正文，两行在时间线上前后分明。
              closeReasoningRow(session);
              streamed += piece;
              stepText += piece;
              // 懒建本步正文行（见 needNewTextRow 注释）：第一片 delta 到达时才落行，空步不留泡。
              if (needNewTextRow) {
                needNewTextRow = false;
                const rowId = takeRowId(session);
                appendRow(session, {
                  rowId,
                  turnId: handles.turnId,
                  entityId: String(rowId),
                  createdAt: now(),
                  createdAtSeq: session.seq,
                  kind: "assistantText",
                  text: "",
                  state: "streaming",
                });
                currentAssistantRowId = rowId;
                handles.assistantRowId = rowId; // settleTurn / DSML / 截断标注都跟最新一行走
              }
              stageDelta(session, {
                op: "row.delta",
                rowId: currentAssistantRowId,
                path: "text",
                append: piece,
              });
            },
          });
        } catch (e) {
          // 流中断自动续写（0.6.9 引入，0.7.0 去上限）：切后台时 Android 会杀长连接——回来后
          // read() 要么立刻 reject（TCP reset），要么半开放到看门狗 90s 才判死。此前对网络类
          // 错误（不含业务错误/401/abort）且本步已有正文的，回填残文继续这一轮，模型接着写。
          // 0.7.0：去掉次数上限（坏网络一句一掐时额度秒光＝"几乎一句话就截断"），判据换成
          // 严格进展——本轮累计正文比上次续写时更长才续；没变长（连一次新字都没有）就停手抛错
          // 走正常收口。总正文受上下文窗口天然封顶（每次续写 transcript 变长，撑爆即 provider
          // 报错收口），所以"有进展就无限续"不会真的无界空转。
          const networkish =
            e instanceof ModelStreamError &&
            CONTINUABLE_STREAM_CODES.has(e.reasonCode);
          const progressed = streamed.length > lastContinuedLen;
          lastContinuedLen = streamed.length;
          if (networkish && !signal.aborted && stepText && progressed) {
            transcript.push({ role: "assistant", content: stepText });
            say(`模型流中断（${(e as ModelStreamError).reasonCode}），从已生成的部分继续续写`);
            // 不置 needNewTextRow：续写是同一句话的下半段，追加进当前气泡（与截断续写同形）。
            continue;
          }
          throw e;
        }
        if (signal.aborted) {
          settleTurn(session, handles, { kind: "interrupted" });
          return;
        }
        roundUsage.inputTokens += result.usage?.inputTokens ?? 0;
        roundUsage.outputTokens += result.usage?.outputTokens ?? 0;
        session.cumulative.inputTokens += result.usage?.inputTokens ?? 0;
        session.cumulative.outputTokens += result.usage?.outputTokens ?? 0;

        if (result.toolCalls.length === 0) {
          // GLM 方言兜底（0.4.8）：模型偶发把工具调用写成 DSML 标记文本而不是 tool_calls JSON，
          // 装机表现为气泡里出现 <|DSML|>calls 原文、工具不执行。这里在收口处解析——
          // 检出成块的就转成工具调用走下面同一条循环，气泡文本替换为去块后的正文
          // （DSML 原文已经流式 append 进行内，用 upsertRow 整行换掉）。
          const dsml = parseDsmlCalls(result.text || streamed);
          if (dsml && dsml.calls.length > 0 && engine) {
            const row = session.rows.find((r) => r.rowId === handles.assistantRowId);
            if (row && row.kind === "assistantText") {
              row.text = dsml.rest;
              upsertRow(session, row);
            }
            result.toolCalls = dsml.calls;
            result.text = dsml.rest;
            streamed = dsml.rest;
          } else {
            // 截断自动续写（0.6.0 引入，0.7.0 去次数上限）：两条通道——
            // ① finish_reason=length（输出预算见顶）；② result.truncated（流被网关干净关闭且
            // 无收尾帧——代理空闲超时掐 SSE 的形状，read() 正常 done 没有错误可抛）。
            // 半截正文回填 transcript 后继续，模型看到残文接着说，气泡无缝续上。
            // 判据＝严格进展：本轮累计正文比上次续写时更长才续（result.text 非空即变长）；
            // 某次续写正文没变长（返回空文本却仍报截断的死局）就停手，正常收口带截断标注。
            const hitCap = result.finishReason === "length" || result.truncated === true;
            const progressed = streamed.length > lastContinuedLen;
            lastContinuedLen = streamed.length;
            if (hitCap && progressed && result.text) {
              transcript.push({ role: "assistant", content: result.text });
              say(
                result.finishReason === "length"
                  ? "回答达到输出上限，自动续写"
                  : "模型流被中断（无收尾帧），自动续写",
              );
              continue;
            }
            const text = streamed;
            // 仍被截且停手（正文没再变长）：如实标注，不能让半截冒充完整回答。
            if (hitCap && text) {
              const noted = `${text}\n\n（回答被截断且续写没有再生成新内容——可能是网络持续不通，请稍后追问"接着说"。）`;
              const row = session.rows.find((r) => r.rowId === handles.assistantRowId);
              if (row && row.kind === "assistantText") {
                row.text = noted;
                upsertRow(session, row);
              }
            }
            // ── Stop 钩子（0.7.1）：模型自己要收口了，钩子可以"拦住继续"（decision:block /
            // continue:true + reason），reason 作为用户消息回填 transcript，模型接着干。
            // stopHookActive 让钩子知道"这是被我叫回来的"，守规矩的钩子不会无限续。
            if (hookRuntime?.enabled && !signal.aborted) {
              try {
                const stopResult = await hookRuntime.run("Stop", {
                  ...hookInputBase(),
                  responseText: text,
                  responsePreview: text.slice(0, 400),
                  stopHookActive: stopHookContinues > 0,
                });
                if (stopResult.stopShouldContinue && stopHookContinues < MAX_STOP_HOOK_CONTINUES) {
                  stopHookContinues += 1;
                  const note = [
                    String(stopResult.stopReason ?? "Stop 钩子要求继续。"),
                    ...(stopResult.additionalContexts ?? []),
                  ].join("\n");
                  say(`Stop 钩子要求继续（第 ${stopHookContinues} 次）`);
                  transcript.push({ role: "user", content: note });
                  needNewTextRow = true;
                  // 新段落：累计正文归零。settleTurn 会用整轮 `streamed` 覆盖最后一行，
                  // 不归零就等于把上一段的文本再写进新段（气泡里同一句话出现两遍）。
                  streamed = "";
                  lastContinuedLen = 0;
                  continue;
                }
                if (stopResult.additionalContexts?.length) {
                  transcript.push({
                    role: "user",
                    content: stopResult.additionalContexts.join("\n"),
                  });
                  needNewTextRow = true;
                  streamed = "";
                  lastContinuedLen = 0;
                  continue;
                }
              } catch (e) {
                say(`Stop 钩子执行异常（已忽略）：${String((e as Error)?.message ?? e)}`);
              }
            }
            if (roundUsage.inputTokens || roundUsage.outputTokens) turnUsage.set(handles.turnId, { ...roundUsage });
            settleTurn(
              session,
              handles,
              text ? { kind: "success", text, model: target.model } : { kind: "empty" },
            );
            return;
          }
        }

        // 有工具调用：assistant 消息（含 tool_calls）与每个 tool 结果按 OpenAI 协议进 transcript。
        // 思考先行于工具：落第一条工具行前关掉思考行（0.7.3），时间线序＝思考→工具→思考→…
        closeReasoningRow(session);
        // 用**本步**的 result.text，不用累加的 streamed —— 否则第 2 步会重复看到第 1 步的正文。
        transcript.push({ role: "assistant", content: result.text, toolCalls: result.toolCalls });
        for (const call of result.toolCalls) {
          const rowId = takeRowId(session);
          const toolCallId = call.id || `tool-${rowId}`;
          const base: Omit<ToolCallRow, "status"> & { status: ToolCallRow["status"] } = {
            rowId,
            turnId: handles.turnId,
            entityId: String(rowId),
            createdAt: now(),
            createdAtSeq: session.seq,
            kind: "toolCall",
            toolCallId,
            toolName: call.name,
            status: "running",
            inputText: call.arguments,
          };
          appendRow(session, base);
          // ── 执行模式闸（0.7.2）：计划模式不落盘——写类工具拦在入口，理由原样回给模型，
          // 让它把"打算怎么改"写成计划，而不是靠执行失败去猜。──
          if (execMode === "plan" && PLAN_MODE_BLOCKED_TOOLS.has(call.name)) {
            const planNote = `计划模式：${call.name} 不会被执行。请先把计划写出来（改哪些文件、每处怎么改），等用户确认后再动手。`;
            say(`计划模式拦下 ${call.name}`);
            upsertRow(session, { ...base, status: "cancelled" });
            transcript.push({ role: "tool", content: planNote, toolCallId });
            continue;
          }
          // ── PreToolUse 钩子（0.7.1）：桌面语义逐条对齐——matcher 按工具名匹配；
          // permissionDecision=deny 拦截（工具不执行，原因回给模型）、allow 跳过交互审批、
          // updatedInput 改写入参；additionalContext 追加进给模型的结果。──
          let hookDeniedReason: string | null = null;
          let hookAllowedByDecision = false;
          let hookExtraContext: string[] = [];
          if (hookRuntime?.enabled && !signal.aborted) {
            try {
              const preResult = await hookRuntime.run(
                "PreToolUse",
                {
                  ...hookInputBase(),
                  toolName: call.name,
                  toolInput: safeParseToolInput(call.arguments),
                  toolCallId,
                },
                { matchValues: [call.name], signal },
              );
              hookExtraContext = [...(preResult.additionalContexts ?? [])];
              if (preResult.updatedInput !== undefined) {
                try {
                  call.arguments = JSON.stringify(preResult.updatedInput);
                } catch {
                  say("PreToolUse 钩子的 updatedInput 不能序列化，已忽略改写");
                }
              }
              if (preResult.permissionBehavior === "deny") {
                hookDeniedReason = String(
                  preResult.hookPermissionDecisionReason ??
                    preResult.stopReason ??
                    "PreToolUse 钩子阻止了这次工具调用。",
                );
              } else if (preResult.permissionBehavior === "allow") {
                hookAllowedByDecision = true;
              }
            } catch (e) {
              say(`PreToolUse 钩子执行异常（已忽略）：${String((e as Error)?.message ?? e)}`);
            }
          }
          if (hookDeniedReason) {
            say(`钩子阻止工具 ${call.name}：${hookDeniedReason}`);
            upsertRow(session, {
              ...base,
              status: "error",
              error: { code: "mobile.hookBlocked", message: hookDeniedReason },
            });
            transcript.push({ role: "tool", content: `已阻止：${hookDeniedReason}`, toolCallId });
            continue;
          }
          // 审批闸（引擎标了 approvalRequired 的调用才走）：先立一条 permission 交互投进
          // 快照（UI 的 V4InteractionDialogs 据此弹窗），await 用户点头/摇头或本轮被停止。
          // 0.5.1 起无限时等待（用户点名"审批限时取消，后台回来原地继续"）：切后台 timer 冻结
          // 会让固定上限在回前台那一刻准点误杀，不如等用户自己决定；收口是选项或停止键。
          // 先判交互再判 execute：审批没过的调用绝不能碰到执行器。
          // 0.7.2 起"要不要问"由执行模式定（见文件头模式表）：
          //   yolo（完全访问）一律不问；
          //   build（变更前确认）问引擎标过的全部（Bash + Delete）；
          //   edit（自动编辑）只问命令（Delete 不再问——"改动自动"的题中之义）；
          //   plan（计划模式）时 Delete 已在上面被拦，走到这里的是 Bash：照问（不静默跑命令）。
          const modeNeedsApproval =
            execMode === "yolo" || (execMode === "edit" && call.name === "Delete")
              ? false
              : engine!.approvalRequired(call.name);
          if (modeNeedsApproval && !hookAllowedByDecision) {
            // ── PermissionRequest 钩子（0.7.1）：可以在弹窗之前就把裁决给掉
            // （decision.behavior=allow 静默放行 / deny 静默拒绝），弹窗只在钩子没表态时出现。──
            let hookPermission: { behavior?: "allow" | "deny"; message?: string } | null = null;
            if (hookRuntime?.enabled && !signal.aborted) {
              try {
                const permissionResult = await hookRuntime.run(
                  "PermissionRequest",
                  {
                    ...hookInputBase(),
                    toolName: call.name,
                    toolInput: safeParseToolInput(call.arguments),
                    toolCallId,
                  },
                  { matchValues: [call.name], signal },
                );
                hookExtraContext.push(...(permissionResult.additionalContexts ?? []));
                hookPermission = permissionResult.permissionRequestResult ?? null;
                if (permissionResult.permissionBehavior === "deny" && !hookPermission) {
                  hookPermission = {
                    behavior: "deny",
                    message: permissionResult.hookPermissionDecisionReason ?? permissionResult.stopReason,
                  };
                } else if (permissionResult.permissionBehavior === "allow" && !hookPermission) {
                  hookPermission = { behavior: "allow" };
                }
              } catch (e) {
                say(`PermissionRequest 钩子执行异常（已忽略）：${String((e as Error)?.message ?? e)}`);
              }
            }
            if (hookPermission?.behavior === "deny") {
              const reason = String(hookPermission.message ?? "PermissionRequest 钩子拒绝了这次调用。");
              say(`钩子拒绝 ${call.name}：${reason}`);
              upsertRow(session, { ...base, status: "cancelled" });
              transcript.push({ role: "tool", content: `已拒绝：${reason}`, toolCallId });
              continue;
            }
            if (hookPermission?.behavior !== "allow") {
              const interactionId = `pi-${rowId}`;
              const decided = await requestToolApproval(session, interactionId, toolCallId, call);
              if (decided === "abort") {
                settleTurn(session, handles, { kind: "interrupted" });
                return;
              }
              if (decided !== "allow") {
                upsertRow(session, { ...base, status: "cancelled" });
                transcript.push({ role: "tool", content: "用户拒绝了这条命令。", toolCallId });
                continue;
              }
            }
          }
          // 冻结归因标注（0.4.10）：工具执行是同步桥重区（Grep/Read 一次几十条桥往返），
          // 心跳证人会把这一段里发生的长 gap 标上"tool:<name>"，装机报告直接看出堵在哪。
          markJankPhase(`tool:${call.name}`);
          let outcome = await engine!.execute(call);
          // 沙箱授权闸（0.5.0，用户点名"读 sandbox 外的文件被直接禁止不好，应改为询问授权"）：
          // 文件端口对越界路径抛 permission_denied（消息带路径）。这里接住 → 弹一条 permission
          // 交互问用户 → 批了就把该路径（/mnt/<名> 归一为挂载根，其余为文件本身）加进授权根
          // 重试一次；"允许这一次"用完即 revoke（会话级），"始终允许"留到会话结束。
          // 没批/超时/中断都如实把原错误回给模型——不替用户点头。
          const deniedPath = outcome.isError ? deniedPathOf(outcome) : null;
          if (deniedPath && !signal.aborted) {
            const scope = grantScopeOf(deniedPath);
            if (execMode === "yolo") {
              // 完全访问（0.7.2）：越界路径不再弹窗——按"始终允许"授权后重试，本轮不再问同一处。
              say(`完全访问：越界路径自动授权 ${scope}`);
              engine!.grantRoot(scope);
              outcome = await engine!.execute(call);
            } else {
              const interactionId = `pi-${rowId}-fs`;
              const decided = await requestPathApproval(session, interactionId, toolCallId, call, deniedPath, scope);
              if (decided === "abort") {
                markJankPhase(null);
                upsertRow(session, { ...base, status: "cancelled" });
                settleTurn(session, handles, { kind: "interrupted" });
                return;
              }
              if (decided === "allow_once" || decided === "allow_always") {
                markJankPhase(`tool:${call.name}`);
                engine!.grantRoot(scope);
                outcome = await engine!.execute(call);
                // "允许这一次"用完即收：不留会话级放行（对齐选项名，不做静默的永久授权）。
                if (decided === "allow_once") engine!.revokeRoot(scope);
              } else {
                markJankPhase(null);
                upsertRow(session, { ...base, status: "cancelled" });
                transcript.push({ role: "tool", content: "用户拒绝了对该路径的访问。", toolCallId });
                continue;
              }
            }
          }
          markJankPhase(null);
          if (signal.aborted) {
            // 执行途中被打断：行落到 cancelled（留在 running 会把"停了"说成"还在跑"）。
            upsertRow(session, { ...base, status: "cancelled" });
            settleTurn(session, handles, { kind: "interrupted" });
            return;
          }
          // 失控循环检测（0.5.0 放宽步数上限的配套闸）：同签名**出错**回包连续 N 次 → 停轮。
          // 签名含错误文本：模型换姿势重试（参数/错误都变了）不算，原地复读才停。
          if (outcome.isError) {
            const sig = `${call.name}:${call.arguments}:${(outcome.errorMessage ?? outcome.content).slice(0, 160)}`;
            if (sig === lastSig) lastSigCount += 1;
            else {
              lastSig = sig;
              lastSigCount = 1;
            }
          } else {
            lastSig = "";
            lastSigCount = 0;
          }
          upsertRow(
            session,
            outcome.isError
              ? {
                  ...base,
                  status: "error",
                  error: { code: outcome.errorCode ?? "mobile.toolFailed", message: outcome.errorMessage ?? outcome.content },
                }
              : {
                  ...base,
                  status: "success",
                  output: {
                    text: capToolContent(outcome.content),
                    // 结构化展示载荷透传（0.7.3）：Write/Edit 的 file_diff（含 structuredPatch）、
                    // Bash 的 bash_output——桌面卡片读这一格出正文；缺了它 file_diff 卡就是空框。
                    ...(outcome.display !== undefined ? { display: outcome.display as never } : {}),
                  },
                },
          );
          // ── PostToolUse / PostToolUseFailure 钩子（0.7.1）：工具跑完后注入上下文
          // （additionalContext 追加在工具结果后面回给模型，与桌面同一条路）。──
          if (hookRuntime?.enabled && !signal.aborted) {
            try {
              const postResult = await hookRuntime.run(
                outcome.isError ? "PostToolUseFailure" : "PostToolUse",
                {
                  ...hookInputBase(),
                  toolName: call.name,
                  toolInput: safeParseToolInput(call.arguments),
                  toolCallId,
                  ...(outcome.isError
                    ? {
                        error: { message: outcome.errorMessage ?? outcome.content },
                        isInterrupt: signal.aborted,
                      }
                    : { toolResponse: { text: capToolContent(outcome.content) } }),
                },
                { matchValues: [call.name], signal },
              );
              hookExtraContext.push(...(postResult.additionalContexts ?? []));
            } catch (e) {
              say(`PostToolUse 钩子执行异常（已忽略）：${String((e as Error)?.message ?? e)}`);
            }
          }
          transcript.push({
            role: "tool",
            content: [
              capToolContent(outcome.content),
              ...hookExtraContext.map((note) => `Hook context: ${note}`),
            ].join("\n"),
            toolCallId,
          });
          if (lastSigCount >= MAX_REPEAT_SIGNATURES) {
            settleTurn(session, handles, {
              kind: "failed",
              code: "mobile.toolLoopRepeatDetected",
              message: `检测到失控循环：同一工具调用以相同错误连续返回 ${lastSigCount} 次，本轮终止。`,
              source: "runtime",
            });
            return;
          }
        }
        // 工具流之后若还有正文，懒建新行接续（0.6.0 每步一行）——总结落在工具流下面。
        needNewTextRow = true;
        // 下一步继续（step 计数在循环头上管）：streamed 不清零——最终气泡是整轮文本的拼接。
      }
    } catch (e) {
      if (signal.aborted) {
        settleTurn(session, handles, { kind: "interrupted" });
        return;
      }
      settleTurn(session, handles, {
        kind: "failed",
        code: e instanceof ModelStreamError ? e.reasonCode : "mobile.modelStreamFailed",
        message: String((e as Error)?.message ?? e),
        source: e instanceof ModelStreamError && e.statusCode ? "provider" : "network",
      });
    }
  }

  /**
   * 会话状态快照（`readSession` 的正文）。这份东西不是给时间线画气泡用的——时间线走的是
   * v4 那条帧通路；它是**任务索引**唯一的回源口：zcodeTaskIndexSyncer.ts:501-531 拿这一份
   * 算标题、状态、用量，再写 task-index 行（syncSnapshotAndBroadcast → buildMetaFromSnapshot）。
   * 端侧此前没有这一条，所以"发完一句、右侧没有这条会话"是必然结果，不是偶发故障。
   *
   * 每一条都只从我们自己记下的事实里取：
   *   - 标题 = 第一条真人输入（titleSource "first_input"）；没有输入就是空串，
   *     让索引侧"还没有用户内容就别广播"那条规则（syncer:1691）照旧生效。
   *   - tokens 按轮取 turnUsage，网关没报就是 0。
   *   - contextWindow 是 0：端侧此刻没有"这个模型窗口多大"这份配置（SessionConfigState 里
   *     没有这一项），编一个数只会让屏幕上的用量条变成一个假比例。
   */
  function snapshotFor(session: MobileSession): ZCodeSessionStateSnapshot {
    const statusByPhase: Record<
      SessionControl["phase"],
      ZCodeSessionStateSnapshot["session"]["status"]
    > = {
      draft: "idle",
      prewarming: "running",
      running: "running",
      completedSuccess: "completed",
      completedInterrupted: "completed",
      error: "error",
    };
    const messages: ZCodeMessageWithParts[] = [];
    // assistant 消息的 parentMessageId 指向同一轮那条用户消息；协议里它必填，
    // 所以对不上（只有补全没有输入）的那条就不写，不拿别的行的 id 凑。
    const userMessageIdByTurn = new Map<string, string>();
    let firstUserText = "";
    for (const row of session.rows) {
      if (row.kind === "userInput" && row.origin === "realUser") {
        const messageId = `msg-user-${row.rowId}`;
        userMessageIdByTurn.set(row.turnId, messageId);
        if (!firstUserText) firstUserText = row.text;
        messages.push({
          info: {
            messageId,
            sessionId: session.sessionId,
            role: "user",
            time: { created: row.createdAt },
            agent: MOBILE_AGENT_NAME,
            visibility: "user-visible",
            semantics: {
              origin: "real_user",
              kind: "user_prompt",
              uiVisibility: "visible",
              providerVisibility: "visible",
              transcriptVisibility: "visible",
            },
          },
          parts: [
            {
              partId: `part-user-${row.rowId}`,
              sessionId: session.sessionId,
              messageId,
              type: "text",
              text: row.text,
            },
          ],
        });
      } else if (row.kind === "assistantText") {
        const parentMessageId = userMessageIdByTurn.get(row.turnId);
        if (!parentMessageId) continue;
        if (!row.text && row.state !== "failed") continue;
        const usage = turnUsage.get(row.turnId);
        const messageId = `msg-assistant-${row.rowId}`;
        messages.push({
          info: {
            messageId,
            sessionId: session.sessionId,
            role: "assistant",
            time: { created: row.createdAt, ...(row.state === "streaming" ? {} : { completed: row.createdAt }) },
            parentMessageId,
            agent: MOBILE_AGENT_NAME,
            ...(session.config.modelSelection ? { model: session.config.modelSelection } : {}),
            path: { cwd: session.workspacePath, root: session.workspacePath },
            cost: 0,
            tokens: {
              input: usage?.inputTokens ?? 0,
              output: usage?.outputTokens ?? 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            finish:
              row.state === "failed"
                ? "error"
                : row.state === "interrupted"
                  ? "interrupted"
                  : "stop",
            ...(row.state === "failed" && session.control.lastError
              ? {
                  error: {
                    code: session.control.lastError.code,
                    message: session.control.lastError.message,
                  },
                }
              : {}),
            semantics: {
              origin: "agent_runtime",
              kind: "assistant_response",
              uiVisibility: "visible",
              providerVisibility: "visible",
              transcriptVisibility: "visible",
            },
          },
          parts: row.text
            ? [
                {
                  partId: `part-assistant-${row.rowId}`,
                  sessionId: session.sessionId,
                  messageId,
                  type: "text",
                  text: row.text,
                },
              ]
            : [],
        });
      }
    }
    const status = statusByPhase[session.control.phase];
    const lastError = session.control.lastError;
    return {
      protocol: { name: ZCODE_PROTOCOL_NAME, version: ZCODE_PROTOCOL_VERSION },
      session: {
        sessionId: session.sessionId,
        // workspaceKey 与上游同一条规则（identity 优先，否则路径）：端侧会话没有 identity，
        // 所以这里就是路径。写成别的（比如加前缀）会让这一行归不到当前工作区下，列表照样是空的。
        workspace: { workspacePath: session.workspacePath, workspaceKey: session.workspacePath },
        sessionKind: "interactive",
        title: firstUserText,
        titleSource: firstUserText ? "first_input" : "default",
        mode: session.config.mode as ZCodeSessionMode,
        status,
        ...(session.config.modelSelection ? { model: session.config.modelSelection } : {}),
        createdAt: session.rows[0]?.createdAt ?? now(),
        updatedAt: session.rows.at(-1)?.createdAt ?? now(),
      },
      settings: {
        model: {
          available: [],
          ...(session.config.modelSelection ? { current: session.config.modelSelection } : {}),
        },
        thoughtLevel: {
          enabled: session.config.thoughtLevels.length > 0,
          ...(session.config.thought ? { current: session.config.thought } : {}),
          // 档位清单来自 view 的 optionSpecs（refreshThoughtLevels 写进 config）——与桌面
          // composer 选择器同一数据源；端上此前恒为 []，选择器是空壳（0.5.1 修）。
          // 快照形状是 option 对象（value/label）；label 端上没有 i18n 词条，原样给档位名，
          // 上游 thoughtLevelLabelId 认得 disabled/low/…/max 这些值并自行翻译。
          available: session.config.thoughtLevels.map((level) => ({ value: level, label: level })),
        },
        mode: { current: session.config.mode as ZCodeSessionMode },
      },
      projection: {
        sessionId: session.sessionId,
        status,
        mode: session.config.mode as ZCodeSessionMode,
        turnCount: messages.filter((m) => m.info.role === "user").length,
        totalTokenCount: session.cumulative.inputTokens + session.cumulative.outputTokens,
        contextUsed: session.cumulative.inputTokens,
        contextWindow: 0,
        ...(session.run ? { currentTurnId: session.run.turnId } : {}),
        pendingPermissions: [],
        activeToolCalls: [],
        backgroundJobs: [],
        ...(lastError
          ? {
              lastError: {
                type: lastError.source,
                ...(lastError.code ? { code: lastError.code } : {}),
                message: lastError.message,
                ...(lastError.detail ? { detail: lastError.detail } : {}),
                ...(lastError.attribution ? { attribution: lastError.attribution } : {}),
              },
            }
          : {}),
      },
      runtime: {
        eventSeq: session.seq,
        stateRevision: session.revision,
        pendingRequestIds: [],
      },
      messages,
    };
  }

  // ── 命令 ──
  function commandKey(envelope: Pick<CommandEnvelope, "commandId" | "sessionId">): string {
    return `${envelope.sessionId ?? "-"}\0${envelope.commandId}`;
  }

  function ackFor(
    envelope: CommandEnvelope,
    session: MobileSession | null,
    status: CommandAck["status"],
    extra: { reasonCode?: string; message?: string; result?: CommandResult } = {},
  ): CommandAck {
    return {
      commandId: envelope.commandId,
      status,
      ...(extra.reasonCode ? { reasonCode: extra.reasonCode } : {}),
      ...(extra.message ? { message: extra.message } : {}),
      revisionAtDecision: session?.revision ?? 0,
      ...(extra.result ? { result: extra.result } : {}),
    };
  }

  async function executeCommand(
    workspacePath: string,
    envelope: CommandEnvelope,
  ): Promise<CommandAck> {
    // 命令通路是端侧"这个 workspace 开始被使用"的最早时刻，也是同步器该醒来的时刻。
    // 幂等靠 announcedWorkspaces，不在这里判命令类型：所有命令都带 workspacePath。
    announceWorkspaceRuntime(workspacePath);
    const payload = envelope.payload as Record<string, unknown>;

    if (envelope.type === "createSession") {
      const requested = payload.config as Partial<SessionConfigState> | undefined;
      const firstInput = payload.firstInput as
        | {
            text?: string;
            modelSelection?: ModelSelectionValue;
            mode?: unknown;
            planEnabled?: unknown;
          }
        | undefined;
      const base = await configWithDefaultModel();
      const selection = requested?.modelSelection as ModelSelectionValue | undefined;
      // 执行模式（0.7.2）：草稿 config 与 firstInput 都可能带；首条输入是"这次提交"的意图，
      // 优先于建会话时的草稿值（与桌面"Submission 覆盖会话缺省"同一口径）。
      const initialMode = normalizeExecutionMode(firstInput?.mode ?? requested?.mode);
      const initialPlan =
        typeof firstInput?.planEnabled === "boolean"
          ? firstInput.planEnabled
          : typeof requested?.planEnabled === "boolean"
            ? requested.planEnabled
            : undefined;
      const config: SessionConfigState = {
        ...base,
        ...(requested?.provider ? { provider: requested.provider } : {}),
        ...(requested?.model ? { model: requested.model } : {}),
        ...(requested?.followupMode ? { followupMode: requested.followupMode } : {}),
        mode: initialMode,
        ...(initialPlan !== undefined ? { planEnabled: initialPlan } : {}),
        ...(selection ? { modelSelection: selection } : {}),
      };
      const session = createSession(newId("session"), config, workspacePath);
      session.revision = 1;
      refreshThoughtLevels(session);
      if (!firstInput?.text) {
        // 只有会话、没有输入：预热的草稿。不缓存 ACK —— 它的幂等要由后续 sendText 的 commandId 承担。
        return ackFor(envelope, session, "accepted", {
          result: { type: "createSession", sessionId: session.sessionId },
        });
      }
      const handles = startTurn(session, {
        workspacePath,
        text: firstInput.text,
        config: firstInput.modelSelection ? { modelSelection: firstInput.modelSelection } : undefined,
      });
      const ack = ackFor(envelope, session, "accepted", {
        result: {
          type: "createSession",
          sessionId: session.sessionId,
          input: { delivery: "startNow", inputId: handles.inputId },
        },
      });
      commandResults.set(commandKey(envelope), ack);
      runTurnThenContinue(session, handles, {
        workspacePath,
        selection: (firstInput.modelSelection as ModelSelectionValue | undefined) ?? session.config.modelSelection ?? null,
      });
      return ack;
    }

    // 命令通路（sendText/stop/改配置）同样要先还原：重启后用户点开历史会话接着说，
    // 第一条 sendText 就落在这里 —— 内存里没有就去库里找，找不到才是真的 notFound。
    const session = envelope.sessionId ? sessionOrRestore(envelope.sessionId, workspacePath) : null;
    if (!session) {
      return ackFor(envelope, null, "rejected", {
        reasonCode: "mobile.session.notFound",
        message: "端侧没有这个会话（内存与持久化库里都没有）。",
      });
    }
    if (session.missing) {
      return ackFor(envelope, session, "rejected", {
        reasonCode: "mobile.session.notRestored",
        message: session.control.lastError?.message ?? "这个会话在这台设备上没有内容。",
      });
    }

    switch (envelope.type) {
      case "sendText": {
        const text = String(payload.text ?? "").trim();
        if (!text) return ackFor(envelope, session, "rejected", { reasonCode: "mobile.input.empty" });
        // 执行模式（0.7.2）：这次提交带的模式意图落进会话配置——UI 工具栏读 config.mode
        // 显示"当前值"，运行侧读同一份决定审批与禁写。之前这里整个字段被丢掉，
        // 选择器点了没有任何效果（用户报的"访问调节功能无效"）。
        applyExecutionIntent(session, payload.mode, payload.planEnabled);
        const requestedDelivery =
          payload.requestedDelivery === "startNow" || payload.requestedDelivery === "queue" || payload.requestedDelivery === "guide"
            ? (payload.requestedDelivery as "startNow" | "queue" | "guide")
            : "auto";
        const modelSelection =
          (payload.modelSelection as ModelSelectionValue | undefined) ?? undefined;

        // ── 空闲路径（含 held/choice）──
        if (!session.run && !session.pendingStartNow) {
          const hasQueued = session.queue.items.length > 0;
          if (hasQueued && !session.queue.autoDrain && requestedDelivery !== "startNow") {
            // held（completed + 队列非空 + autoDrain=false）：不静默入队也不静默丢弃，
            // 让客户端弹"清空队列后发送 / 保留队列立即发送"（composer 认这个 reasonCode）。
            const disposition = payload.heldQueueDisposition;
            if (disposition !== "clearQueueAndSend" && disposition !== "keepQueueAndSend") {
              return ackFor(envelope, session, "rejected", {
                reasonCode: "guard.heldQueueConfirmationStale",
                message: "有暂停中的等待队列：请确认清空它再发送，或保留它立即发送。",
              });
            }
            const expected = payload.expectedHeldQueueItemIds;
            if (Array.isArray(expected)) {
              const currentIds = session.queue.items.map((item) => item.queueItemId);
              const same =
                currentIds.length === expected.length &&
                currentIds.every((id, index) => id === expected[index]);
              if (!same) {
                // 确认框看到的队列和现在的队列不是同一份：让客户端拿新快照重新确认。
                return ackFor(envelope, session, "rejected", {
                  reasonCode: "guard.heldQueueConfirmationStale",
                  message: "等待队列在你确认期间变化过，请按最新队列重新确认。",
                });
              }
            }
            if (disposition === "clearQueueAndSend") {
              session.queue = { ...session.queue, items: [], pauseReason: undefined };
              emitQueue(session, "按确认清空队列");
            } else {
              emitQueue(session, "保留队列，立即发送新消息");
            }
          }
          const handles = startTurn(session, {
            workspacePath,
            text,
            sourceCommandId: envelope.commandId,
            config: modelSelection ? { modelSelection } : undefined,
          });
          const ack = ackFor(envelope, session, "accepted", {
            result: { type: "inputAccepted", delivery: "startNow", inputId: handles.inputId },
          });
          commandResults.set(commandKey(envelope), ack);
          runTurnThenContinue(session, handles, {
            workspacePath,
            selection: modelSelection ?? session.config.modelSelection ?? null,
          });
          return ack;
        }

        // ── 忙路径（0.7.1）：默认入队；requestedDelivery=startNow 才原子抢占 ──
        if (requestedDelivery === "startNow") {
          const item = enqueueInput(session, envelope, {
            text,
            modelSelection,
            mode: payload.mode,
            planEnabled: payload.planEnabled,
            requested: "startNow",
            admitted: "queue",
            fallbackReasonCode: "mobile.queue.stealAsNext",
          });
          // 抢占 = 停当前轮 + 把这条放到"下一个就跑"的位置（afterTurnSettled 优先消费）。
          session.queue.items = session.queue.items.filter(
            (candidate) => candidate.queueItemId !== item.queueItemId,
          );
          session.pendingStartNow = { ...item, dispatch: { state: "promoting" } };
          emitQueue(session, "立即发送：抢占当前轮（新消息排到队首）");
          session.run?.abort.abort();
          const ack = ackFor(envelope, session, "accepted", {
            result: { type: "inputAccepted", delivery: "startNow", inputId: item.queueItemId },
          });
          commandResults.set(commandKey(envelope), ack);
          return ack;
        }

        const item = enqueueInput(session, envelope, {
          text,
          modelSelection,
          mode: payload.mode,
          planEnabled: payload.planEnabled,
          requested: requestedDelivery,
          admitted: "queue",
          ...(requestedDelivery === "guide"
            ? { fallbackReasonCode: "mobile.queue.guideFallsBack" }
            : {}),
        });
        // 新消息就是"继续跑"的显式意图：把 stop/失败留下的暂停一并解除。
        if (!session.queue.autoDrain) {
          session.queue.autoDrain = true;
          session.queue.pauseReason = undefined;
        }
        emitQueue(session, "新消息入队");
        const ack = ackFor(envelope, session, "accepted", {
          result: { type: "inputAccepted", delivery: "queue", inputId: item.queueItemId },
        });
        commandResults.set(commandKey(envelope), ack);
        return ack;
      }
      case "deleteQueueItem": {
        const queueItemId = String(payload.queueItemId ?? "");
        const item = session.queue.items.find((candidate) => candidate.queueItemId === queueItemId);
        if (!item) return ackFor(envelope, session, "noop", { reasonCode: "mobile.queueItem.notFound" });
        if (item.dispatch.state !== "queued") {
          // reserved/promoting 是"正在被消费"的中间态，删它会让收轮排空指向一条不存在的项。
          return ackFor(envelope, session, "noop", { reasonCode: "mobile.queueItem.locked" });
        }
        session.queue.items = session.queue.items.filter(
          (candidate) => candidate.queueItemId !== queueItemId,
        );
        emitQueue(session, "删掉一条等待消息");
        return ackFor(envelope, session, "accepted");
      }
      case "editQueueItem": {
        // 协议里 editQueueItem 只改正文；设置页/UI 的"编辑"走的是 deleteQueueItem +
        // 把内容退回输入框（SessionPane 的 resolveQueuedComposerRestore），这里两条都支持。
        const queueItemId = String(payload.queueItemId ?? "");
        const newText = String(payload.newText ?? "").trim();
        if (!newText) return ackFor(envelope, session, "rejected", { reasonCode: "mobile.input.empty" });
        const item = session.queue.items.find((candidate) => candidate.queueItemId === queueItemId);
        if (!item) return ackFor(envelope, session, "noop", { reasonCode: "mobile.queueItem.notFound" });
        if (item.dispatch.state !== "queued") {
          return ackFor(envelope, session, "noop", { reasonCode: "mobile.queueItem.locked" });
        }
        item.text = newText;
        emitQueue(session, "改了一条等待消息");
        return ackFor(envelope, session, "accepted");
      }
      case "reorderQueueItem": {
        const queueItemId = String(payload.queueItemId ?? "");
        const beforeRaw = payload.beforeQueueItemId;
        const beforeQueueItemId = typeof beforeRaw === "string" ? beforeRaw : null;
        const item = session.queue.items.find((candidate) => candidate.queueItemId === queueItemId);
        if (!item) return ackFor(envelope, session, "noop", { reasonCode: "mobile.queueItem.notFound" });
        const rest = session.queue.items.filter((candidate) => candidate.queueItemId !== queueItemId);
        const index = beforeQueueItemId
          ? rest.findIndex((candidate) => candidate.queueItemId === beforeQueueItemId)
          : -1;
        if (beforeQueueItemId && index < 0) {
          return ackFor(envelope, session, "noop", { reasonCode: "mobile.queueItem.notFound" });
        }
        if (index < 0) rest.push(item);
        else rest.splice(index, 0, item);
        session.queue.items = rest;
        emitQueue(session, "重排了等待队列");
        return ackFor(envelope, session, "accepted");
      }
      case "sendQueuedNow": {
        const queueItemId = String(payload.queueItemId ?? "");
        const item = session.queue.items.find((candidate) => candidate.queueItemId === queueItemId);
        if (!item) return ackFor(envelope, session, "noop", { reasonCode: "mobile.queueItem.notFound" });
        if (item.dispatch.state !== "queued") {
          return ackFor(envelope, session, "noop", { reasonCode: "mobile.queueItem.locked" });
        }
        // 从队列摘出来再跑：同一条消息不能既在队列里又被执行。
        session.queue.items = session.queue.items.filter(
          (candidate) => candidate.queueItemId !== queueItemId,
        );
        if (session.run) {
          // 打断插入：abort 当前轮，这条排到"下一个就跑"，由 afterTurnSettled 起跑。
          session.pendingStartNow = { ...item, dispatch: { state: "promoting" } };
          emitQueue(session, "立即发送：打断当前轮");
          session.run.abort.abort();
        } else {
          // 空闲：直接开跑（startQueuedItem 自己出队 + 发帧）。
          startQueuedItem(session, item);
        }
        return ackFor(envelope, session, "accepted");
      }
      case "setAutoDrain": {
        const autoDrain = payload.autoDrain === true;
        if (autoDrain === session.queue.autoDrain) {
          return ackFor(envelope, session, "noop", { reasonCode: "proto.alreadyResolved" });
        }
        session.queue.autoDrain = autoDrain;
        if (autoDrain) session.queue.pauseReason = undefined;
        emitQueue(session, autoDrain ? "恢复自动排空" : "暂停自动排空");
        // 空闲（不是刚被 stop 的收口路径）时点恢复：队列里还有待跑项就立刻开跑。
        if (autoDrain && !session.run && !session.pendingStartNow) {
          const next = session.queue.items.find((candidate) => candidate.dispatch.state === "queued");
          if (next) startQueuedItem(session, next);
        }
        return ackFor(envelope, session, "accepted");
      }
      case "stop": {
        const run = session.run;
        if (!run) return ackFor(envelope, session, "noop", { reasonCode: "mobile.stop.idle" });
        const expected = payload.expectedForegroundExecutionId as string | undefined;
        if (expected && expected !== run.executionId) {
          return ackFor(envelope, session, "rejected", { reasonCode: "stale.stopTarget" });
        }
        run.abort.abort();
        return ackFor(envelope, session, "accepted");
      }
      case "switchModelConfig": {
        const provider = String(payload.provider ?? "");
        const model = String(payload.model ?? "");
        const thought = String(payload.thought ?? "");
        if (!provider || !model) {
          return ackFor(envelope, session, "rejected", { reasonCode: "mobile.modelNotSelected" });
        }
        // 思考档位（0.5.1）：档位随 selection 走（options.reasoningLevel），resolveModelTarget
        // 读它、buildRequest 拼进请求体——config.thought 只是快照展示的 current，两者都要写。
        updateState(session, {
          revision: session.revision + 1,
          config: {
            ...session.config,
            provider,
            model,
            thought,
            modelSelection: {
              providerId: provider,
              modelId: model,
              ...(thought ? { options: { reasoningLevel: thought } } : {}),
            },
          },
        });
        refreshThoughtLevels(session);
        persistSession(session);
        return ackFor(envelope, session, "accepted");
      }
      case "setFollowupMode": {
        const mode = payload.mode === "guide" ? "guide" : "queue";
        updateState(session, {
          revision: session.revision + 1,
          config: { ...session.config, followupMode: mode },
        });
        persistSession(session);
        return ackFor(envelope, session, "accepted");
      }
      case "switchCollaborationMode": {
        // 协议里的会话级模式切换（composer 现在只改草稿，但这条命令是冻结面的一部分：
        // 端侧接上，将来任何 UI 路径发它都能生效——语义与 sendText 提交的模式完全一致）。
        applyExecutionIntent(session, payload.mode, undefined);
        return ackFor(envelope, session, "accepted");
      }
      case "resolveInteraction": {
        const interactionId = String(payload.interactionId ?? "");
        const answer = (payload.answer ?? {}) as { optionId?: unknown };
        const outcome = resolvePendingInteraction(interactionId,
          typeof answer.optionId === "string" ? answer.optionId : undefined);
        // noop 不是错误：晚到的第二张票（双击/重发）按协议回 noop，客户端据此收口 flight。
        return ackFor(envelope, session, outcome === "accepted" ? "accepted" : "noop",
          outcome === "accepted" ? undefined : { reasonCode: "proto.alreadyResolved" });
      }
      default:
        return ackFor(envelope, session, "rejected", {
          reasonCode: "mobile.p0.commandUnsupported",
          message: `端侧 P0 还不支持「${envelope.type}」这个命令。`,
        });
    }
  }

  function requireHandshake(): void {
    if (boundClientId === null) throw new Error("fault.connection.helloRequired");
  }

  /**
   * 每一路注册一条独立通道，并先攒着：UI 那侧的监听者要等一个 RPC round-trip 才挂得上，
   * 而首帧就在这一趟里发。少了这层缓冲，首帧会在监听者出现之前 fire 掉，表现是"会话永远转圈"。
   * 桌面在同一处用的是 post-response outbox，这里是它的进程内版本，语义一致。
   * conversation / sessions-index / workspace-config 三条 topic 共用这一份实现，
   * 但每次取事件仍各自建通道与攒帧区 —— 与"每个监听者一条独立通道"的原语义一致。
   */
  function bufferedFrameEvent<T>(emitter: Emitter<T>): () => Event<T> {
    return () => {
      const stash: T[] = [];
      let flushing = false;
      const out = new Emitter<T>({
        onDidRemoveLastListener: () => upstream.dispose(),
      });
      const upstream = emitter.event((wire) => {
        if (flushing) out.fire(wire);
        else stash.push(wire);
      });
      return (listener) => {
        const disposable = out.event(listener);
        if (!flushing) {
          flushing = true;
          for (const wire of stash.splice(0, stash.length)) out.fire(wire);
        }
        return { dispose: () => disposable.dispose() };
      };
    };
  }
  const onConversationFrameEvent = bufferedFrameEvent(frameEmitter);
  const onSessionsIndexFrameEvent = bufferedFrameEvent(indexEmitter);
  const onWorkspaceConfigFrameEvent = bufferedFrameEvent(configEmitter);

  function workspaceSnapshotOf(
    kind: "sessions-index" | "workspace-config",
    state: WorkspaceTopicState,
  ): SessionsIndexTopicFrame["payload"] | { kind: "snapshot"; snapshot: WorkspaceConfigSnapshot } {
    return kind === "sessions-index"
      ? {
          kind: "snapshot",
          snapshot: {
            protocolVersion: 1,
            workspaceId: state.workspaceKey,
            logEpoch: state.logEpoch,
            sessions: [...state.summaries.values()],
          },
        }
      : {
          kind: "snapshot",
          snapshot: {
            protocolVersion: 1,
            workspaceId: state.workspaceKey,
            logEpoch: state.logEpoch,
            config: state.config,
          },
        };
  }

  /**
   * sessions-index 与 workspace-config 是同一条"订阅 = ACK + 一帧 initial snapshot"的形状，
   * 这里只写一次。首帧一律给 snapshot 而不是按 base 续传增量：端侧没有事件日志，重建不出
   * (base.seq, 现在] 那一段 —— 与 collectDeltasSince 同一判断，宁可多回一份全量，也不能拼一半。
   */
  function subscribeWorkspaceTopic(
    kind: "sessions-index" | "workspace-config",
    params: { workspacePath: string; workspaceIdentity?: string },
  ): { ack: { subscriptionId: string; mode: "snapshot"; logEpoch: string } } {
    const state = workspaceTopicOf(params);
    const isIndex = kind === "sessions-index";
    const sub: WorkspaceTopicSubscription = {
      subscriptionId: newId(isIndex ? "isub" : "csub"),
      topic: isIndex
        ? sessionsIndexTopic(state.workspaceKey)
        : workspaceConfigTopic(state.workspaceKey),
      ordinal: 0,
    };
    (isIndex ? indexSubs : configSubs).set(sub.subscriptionId, sub);
    emitWorkspaceTopicFrame(kind, state, workspaceSnapshotOf(kind, state), "initial", sub);
    say(`${kind} 订阅 workspace=${state.workspaceKey}`);
    return {
      ack: { subscriptionId: sub.subscriptionId, mode: "snapshot", logEpoch: state.logEpoch },
    };
  }

  function resyncWorkspaceTopic(
    kind: "sessions-index" | "workspace-config",
    params: { subscriptionId: string },
  ): { ack: { subscriptionId: string; mode: "snapshot"; logEpoch: string } } {
    const isIndex = kind === "sessions-index";
    const subs = isIndex ? indexSubs : configSubs;
    const sub = subs.get(params.subscriptionId);
    if (!sub) throw new Error("fault.subscription.notOwned");
    const state = workspaceTopics.get(sub.topic.slice(sub.topic.indexOf("/") + 1));
    if (!state) throw new Error("fault.subscription.notOwned");
    emitWorkspaceTopicFrame(kind, state, workspaceSnapshotOf(kind, state), "recovery", sub);
    return {
      ack: { subscriptionId: sub.subscriptionId, mode: "snapshot", logEpoch: state.logEpoch },
    };
  }

  return {
    // ── 握手 ──
    async helloConversationV4(): Promise<HelloMessage> {
      const capabilities: HostCapabilities = {
        nativeDialogs: false,
        localTerminal: false,
        binaryFrames: false,
        compression: "none",
        // 独立计划态（0.7.2）：端侧真的把 planEnabled 存进 session.config 并按计划模式执行
        // （写类工具拦在入口），所以如实声明。不声明的话客户端的 transport 会直接拒发
        // 带 planEnabled 的提交（proto.independentPlanUnsupported）——计划勾选项整条链路是断的。
        independentPlanState: true,
        // 不声明 workflowRunDeltas：客户端判的是 `!== true`，谎报会让 UI 发出端侧解不了的载荷，
        // 而那时的失败点离原因更远。
      };
      return {
        kind: "hello",
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        connectionId: "mobile-in-process",
        clientMode: "desktop-continuous",
        deliveryProfile: "continuous",
        serverTime: now(),
        capabilities,
        auth: {},
      };
    },

    async initializeConversationV4(clientHello: unknown): Promise<void> {
      const parsed = clientHelloSchema.parse(clientHello);
      if (boundClientId !== null && boundClientId !== parsed.clientId) {
        throw new Error("fault.connection.clientChanged");
      }
      boundClientId = parsed.clientId;
    },

    // ── 订阅 ──
    async subscribeConversationV4(params: {
      workspacePath: string;
      sessionId: string;
      base?: { logEpoch: string; seq: number };
      visibility?: "foreground" | "background";
    }): Promise<{
      ack: { subscriptionId: string; mode: "snapshot" | "resume"; logEpoch: string };
    }> {
      requireHandshake();
      // 订阅是"点开侧栏那一行"的第一个落点：内存里没有就先去库里找（重启后回看历史），
      // 找不到才给 missing 占位。时间线画的是 buildSnapshot 里还原回来的 rows。
      const session = sessionOrRestore(params.sessionId, params.workspacePath);
      const subscriptionId = newId("sub");
      const sub: MobileSubscription = {
        subscriptionId,
        topic: conversationTopic(params.sessionId),
        sessionId: params.sessionId,
        workspacePath: params.workspacePath,
        ordinal: 0,
      };
      subscriptions.set(subscriptionId, sub);

      // resume 只在"客户端手里的水位仍然自洽"时给。猜错这里的后果不是报错，是客户端拿旧投影
      // 拼新 delta —— 时间线会安静地长出假内容，所以宁可退回 snapshot。
      const base = params.base;
      const resumable =
        base !== undefined && base.logEpoch === session.logEpoch && base.seq <= session.seq;
      if (base && resumable) {
        const deltas = collectDeltasSince(session, base.seq);
        if (deltas) {
          emitFrame(session, { kind: "deltas", deltas }, "initial", sub);
          return { ack: { subscriptionId, mode: "resume", logEpoch: session.logEpoch } };
        }
      }
      emitFrame(session, { kind: "snapshot", snapshot: buildSnapshot(session) }, "initial", sub);
      return { ack: { subscriptionId, mode: "snapshot", logEpoch: session.logEpoch } };
    },

    async resyncConversationV4(params: {
      subscriptionId: string;
      base: { logEpoch: string; seq: number } | null;
      forceSnapshot?: boolean;
    }): Promise<{
      ack: { subscriptionId: string; mode: "snapshot" | "resume"; logEpoch: string };
    }> {
      requireHandshake();
      const sub = subscriptions.get(params.subscriptionId);
      if (!sub) throw new Error("fault.subscription.notOwned");
      const session = sessionOrRestore(sub.sessionId, sub.workspacePath);
      const deltas =
        params.forceSnapshot || !params.base || params.base.logEpoch !== session.logEpoch
          ? null
          : collectDeltasSince(session, params.base.seq);
      if (deltas) {
        emitFrame(session, { kind: "deltas", deltas }, "recovery", sub);
        return { ack: { subscriptionId: sub.subscriptionId, mode: "resume", logEpoch: session.logEpoch } };
      }
      emitFrame(session, { kind: "snapshot", snapshot: buildSnapshot(session) }, "recovery", sub);
      return {
        ack: { subscriptionId: sub.subscriptionId, mode: "snapshot", logEpoch: session.logEpoch },
      };
    },

    async unsubscribeConversationV4(params: { subscriptionId: string }): Promise<void> {
      subscriptions.delete(params.subscriptionId);
    },

    // ── 命令 ──
    async sendConversationCommandV4(params: {
      workspacePath: string;
      envelope: CommandEnvelope;
    }): Promise<CommandAck> {
      requireHandshake();
      if (params.envelope.clientId !== boundClientId) {
        throw new Error("fault.command.clientMismatch");
      }
      const validated = parseCommandEnvelope(params.envelope);
      if (!validated.ok) {
        return {
          commandId: params.envelope.commandId,
          status: "rejected",
          reasonCode: "proto.commandPayloadInvalid",
          message: validated.error.issues[0]?.message ?? "命令载荷不符合协议",
          revisionAtDecision: 0,
        };
      }
      const key = commandKey(validated.envelope);
      const cached = commandResults.get(key);
      if (cached) {
        return { ...cached, status: "duplicate", commandId: params.envelope.commandId };
      }
      return executeCommand(params.workspacePath, validated.envelope);
    },

    async queryConversationCommandsV4(params: {
      commands: CommandsQueryParams["commands"];
      clock?: true;
    }): Promise<CommandsQueryResult> {
      return {
        results: params.commands.map((key) => ({
          key,
          result: commandResults.get(commandKey(key)) ?? ("unknown" as const),
        })),
        ...(params.clock ? { clock: clockPayload() } : {}),
      };
    },

    async conversationRowsRangeV4(params: {
      sessionId: string;
      limit: number;
      beforeRowId?: number;
    }): Promise<{ rows: ConversationRow[]; hasMore: boolean }> {
      // 翻页读历史行：内存 miss 时也去库里还原（workspacePath 这条通路没有，
      // restoreSession 会用持久化记录里存的那份）。
      const session = sessionOrRestore(params.sessionId, "");
      if (!session || session.missing) return { rows: [], hasMore: false };
      const before = params.beforeRowId ?? Number.MAX_SAFE_INTEGER;
      const eligible = session.rows.filter((r) => r.rowId < before);
      const limit = Math.min(params.limit, PROTOCOL_V4_LIMITS.rowsRangeMaxLimit);
      const page = eligible.slice(-limit);
      return { rows: page, hasMore: eligible.length > page.length };
    },

    // ── 会话状态快照（任务索引的回源口）──
    /**
     * 只认"这台设备上真有的那条会话"——内存里，或持久化库里还原得回来。两处都查不到才如实报错，
     * 绝不回一份空 snapshot：空 messages 走到 syncer 那里会被当成"这条会话还没内容"，内容是画不出来
     * 了，但那一行也会一起消失——用户看到的是"我发过一句，列表里根本没有"。
     */
    async readSession(params: { sessionId: string; workspacePath?: string }): Promise<ZCodeSessionStateSnapshot> {
      const session = sessionOrRestore(params.sessionId, params.workspacePath ?? "");
      if (!session || session.missing) {
        throw new Error(
          `端侧找不到这条会话（sessionId=${params.sessionId}）：内存与持久化库里都没有它的记录。`,
        );
      }
      return snapshotFor(session);
    },

    // ── 帧与生命周期 ──
    onDynamicConversationFrame: onConversationFrameEvent,

    /**
     * 侧栏那一条的来源。同步器（zcodeTaskIndexSyncer）只认这一路帧：没有它，
     * "发完一句 → 写 task-index 行 → 广播列表变更"整条链一步都不会跑，
     * 屏幕上就是用户报的那个症状 —— 回答在流，列表里没有。
     */
    onDynamicSessionsIndexFrame: onSessionsIndexFrameEvent,

    async subscribeSessionsIndexV4(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      base?: { logEpoch: string; seq: number };
      visibility?: "foreground" | "background";
    }): Promise<{ ack: { subscriptionId: string; mode: "snapshot"; logEpoch: string } }> {
      return subscribeWorkspaceTopic("sessions-index", params);
    },

    async resyncSessionsIndexV4(params: {
      subscriptionId: string;
      base: { logEpoch: string; seq: number } | null;
      forceSnapshot?: boolean;
    }): Promise<{ ack: { subscriptionId: string; mode: "snapshot"; logEpoch: string } }> {
      return resyncWorkspaceTopic("sessions-index", params);
    },

    async unsubscribeSessionsIndexV4(params: { subscriptionId: string }): Promise<void> {
      indexSubs.delete(params.subscriptionId);
    },

    /**
     * workspace 级配置目录。这一路存在的理由不是"有配置可给"，而是**没有**：
     * 同步器把它当暂态订阅失败去退避重试（zcodeTaskIndexSyncer.ts:1458-1497），
     * 让它一直抛 EUNSUPPORTED 就等于每分钟 60 次重试 + 一条生产 warn。
     * 空目录在这里是实话（端侧的模型目录走 conversation 的 config 面），
     * 而且不会造成假画面：同步器对 `configOptions.length === 0` 明确不下发给 UI
     * （同文件 :1131-1136，理由写的是"清掉工具栏模型目录"）。
     */
    onDynamicWorkspaceConfigFrame: onWorkspaceConfigFrameEvent,

    async subscribeWorkspaceConfigV4(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      base?: { logEpoch: string; seq: number };
      visibility?: "foreground" | "background";
    }): Promise<{ ack: { subscriptionId: string; mode: "snapshot"; logEpoch: string } }> {
      return subscribeWorkspaceTopic("workspace-config", params);
    },

    async resyncWorkspaceConfigV4(params: {
      subscriptionId: string;
      base: { logEpoch: string; seq: number } | null;
      forceSnapshot?: boolean;
    }): Promise<{ ack: { subscriptionId: string; mode: "snapshot"; logEpoch: string } }> {
      return resyncWorkspaceTopic("workspace-config", params);
    },

    async unsubscribeWorkspaceConfigV4(params: { subscriptionId: string }): Promise<void> {
      configSubs.delete(params.subscriptionId);
    },

    onAgentRuntimeRestarted: restartEmitter.event,

    /** 见上面 announceWorkspaceRuntime 那段：侧栏那一行的起点就是这条事件。 */
    onAgentRuntimeLifecycle: runtimeLifecycleEmitter.event,

    hasActiveCuaOperationTurn(): boolean {
      return false;
    },

    /**
     * workspace 的"可显示事实"：mode 与 slash 命令目录。
     *
     * 为什么必须实现这一条而不是让它继续报 EUNSUPPORTED：UI 的草稿目录水合
     * （useDraftConfigControl.ts:363 → workspacePrepareRpc.ts:28）把它失败记成
     * `configOptionsStatus = "error"`，而 V4ComposerToolbar.tsx:845-863 在
     * "configOptionsError + 自选 Provider + API Key" 时**不选择模型**，改走 recovery 分支直接 return。
     * 于是屏幕上表现为"点了模型没反应、发送键永远是灰的"，真正的原因在水合那一步。
     *
     * 返回的内容里没有任何编造：mode 取端侧每个会话的起始值（空 config 就是 build，
     * 见 emptyConfig），slashCommands 为空是因为端侧确实没有命令目录 —— 目录非空但执行不了，
     * 才会变成"能补全、回车报错"。这两条都是"现在真的是这样"，不是"先装作有"。
     */
    async readWorkspacePresentation(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      remoteSessionId?: string;
    }): Promise<ZCodeWorkspacePresentation> {
      const mode: ZCodeSessionMode = "build";
      const slashCommands: ZCodeSlashCommand[] = [];
      return {
        workspace: {
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
          // 与上游同一个取法（task-realtime-core.ts:82）：有 identity 用 identity，否则用路径。
          workspaceKey: params.workspaceIdentity?.trim() || params.workspacePath,
        },
        mode,
        slashCommands,
      };
    },

    /**
     * 回收某个 workspace 的执行体。桌面上是"终止那台 CLI 子进程"；端侧没有按 workspace 存活的进程，
     * 但**有**在跑的模型流：UI 在离开 workspace 时调这条（useWorkspaceShellLifecycle.ts:79、
     * workspaceRuntimeRelease.ts:13），什么都不做等于用户已经走了、请求还在烧他自己的免费额度。
     * 按 workspacePath 匹配而不是 workspaceKey：命令通路（sendConversationCommandV4）的参数里只有
     * workspacePath，两边来源不同，用 key 会静默匹配不上。
     *
     * 这里**不**删订阅：调用方自己的守卫是"有活动任务或正在流式输出时不回收"（shell lifecycle:50-56），
     * 也就是说这条只会在"纯预热"的 workspace 上触发；把订阅一起删掉会让之后回来的
     * resyncConversationV4 报 fault.subscription.notOwned，而桌面上那条订阅 id 仍然有效。
     */
    async disposeWorkspace(params: { workspacePath: string }): Promise<void> {
      for (const session of sessions.values()) {
        if (session.workspacePath === params.workspacePath) session.run?.abort.abort();
      }
    },


    disposeAll(): void {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      pendingDeltas.clear();
      for (const session of sessions.values()) session.run?.abort.abort();
      subscriptions.clear();
      indexSubs.clear();
      configSubs.clear();
    },

    // ── 插件面（0.7.1，装机"浏览器控制显示端侧 agent 运行时未接入"）──
    // 消费方是 pluginManagementService（薄代理）；手机上没有插件市场，
    // 但"端侧有没有浏览器控制"该由端侧如实回答：内建 browser-use 条目 + 开关落旗子。
    ...createMobilePluginFace(),

    /**
     * Hook 预信任（设置页「信任」按钮的落点）。桌面上这条转发到 CLI authority；
     * 端侧的 authority 就是本进程：重新发现快照 → 校验 bundleDigest → 把声明摘要写进
     * hooksService 读的同一份 trust store 文件。之后运行时门禁（hooks-mobile 的 admission）
     * 与设置页展示都认这一份事实。
     */
    async grantWorkspaceHookTrust(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      bundleDigest: string;
      hookDeclarationDigest: string;
    }): Promise<{ accepted: boolean; reasonCode?: string }> {
      const result = await grantWorkspaceHookTrust(params);
      say(
        result.accepted
          ? `Hook 已信任：${params.hookDeclarationDigest.slice(0, 12)}…`
          : `Hook 信任被拒：${result.reasonCode ?? "unknown"}`,
      );
      return result;
    },
  };
}

/**
 * usage 的完整形状。为什么要单独一个函数、且放在模块层：A 区的 `state.updated` 是**整键替换**，
 * 收口那一轮如果只发 control 不发 usage，模型回的真实用量就永远停在 0 —— 屏幕上的 token 计数
 * 是 UI 直接从 snapshot 读的（ConversationTokenUsageSummary），没有"下一次全量再补上"的机会
 * （chat-smoke 的 usage 判据抓的就是这个）。而 resume 那条重建路径在模块层，两边都得能用。
 */
function usageState(session: MobileSession): ConversationSnapshot["usage"] {
  return {
    contextWindow: null,
    cumulative: {
      inputTokens: session.cumulative.inputTokens,
      outputTokens: session.cumulative.outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  };
}

/** TTFT 校准用的时钟回包。端侧只有一个进程，往返差恒为 0 —— 这是实话，不是凑数。 */
function clockPayload(): NonNullable<CommandsQueryResult["clock"]> {
  const at = Date.now();
  return { instanceId: "mobile-in-process", receivedAt: at, sentAt: at };
}

/**
 * 把 (baseSeq, seq] 的增量重建出来；超出可复原范围就返回 null，调用方退回 snapshot。
 * 端侧没有事件日志，只能从当前行集合重建"这些行是新加的"。宁可多退一次全量，
 * 也不能拼一半 —— 拼错的投影会一直显示在屏幕上，而且再也对不回真值。
 */
function collectDeltasSince(session: MobileSession, baseSeq: number): ConversationDelta[] | null {
  if (baseSeq <= 0 || baseSeq > session.seq) return null;
  const newest = session.rows.filter((r) => r.createdAtSeq > baseSeq);
  if (newest.length === 0) return null;
  return [
    ...newest.map((row) => ({ op: "row.appended" as const, row })),
    {
      op: "state.updated" as const,
      patch: {
        revision: session.revision,
        control: session.control,
        config: session.config,
        usage: usageState(session),
      },
    },
  ];
}
