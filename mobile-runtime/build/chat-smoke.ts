// 端侧对话链路的协议自检（只在 Node 里跑，不进 APK）。见 PORTING §1.5.18。
//
// 为什么长这样：这一段要证明的不是"我们发的帧看着合理"，而是**上游真客户端把我们的帧收下了**。
// 所以三条都是上游的原物，没有一条是我们重写的替身：
//   - `createAgentConversationTransport` / `ConversationProjectionStore`（packages/ui/src/v4/）
//     就是手机上 Root.tsx 用来渲染时间线的那套状态机，含 ack activation barrier、
//     wire assembler、seq 对齐、乐观气泡退场。
//   - `ProxyChannel` + `ChannelServer`/`ChannelClient`（@zcode/rpc）：帧必须真的过一次 RPC，
//     才会撞上 `onDynamic*` 的命名约定与"先 listen 后 call"的时序 —— 0.0.2 那次跨语言漂移
//     就是在这一层发生的，把它绕过去等于没测。
//   - 模型侧是本地 SSE mock：断网、断额度、断流都只能由它演，真网关不能作为自检依赖。
//
// 五条判据（每一条都是手机上"装上去能干什么"的具体形态，不是内部指标）：
//   1. 发一句话能看到流式回来的正文，且那句用户消息自己退场（乐观气泡不永远转圈）。
//   2. 同一个会话发第二句：不重订阅、不 resync（seq 记账对了）。
//   3. 网关在 200 里塞业务错误：正文是空的 + 屏幕上有一条可读的失败，而不是把错误当回答。
//   4. HTTP 5xx：同上，原因能读出来。
//   5. 中途点停止：这一轮落到"被打断"，assistant 行不再是 streaming。
import http from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ChannelClient, ChannelServer, ProxyChannel, createQueuePair } from "@zcode/rpc";
import { conversationTopic } from "@zcode/shared/zcode-protocol-v4";

import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { createAgentConversationTransport } from "@/v4/agentConversationTransport.js";
import { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import { deriveTaskLeadingIndicator } from "@/lib/taskListItemPresentation.js";
import { buildTaskListItemIdentityKey } from "@/v4/taskListItemStabilization.js";

import { createMobileAgentService } from "../ui/agent.js";
import { planCompactPass, planCompactPasses } from "../ui/compact.js";
import { createMobileHookRuntime } from "../ui/hooks-mobile.js";
import { createConfiguredHookRunner } from "../../zcode/apps/zcode-cli/packages/core/src/hooks/configured-runner.js";
import { createMobileExecutionPort } from "../ports/execution.mjs";
import { createNativeExecBridge } from "../ports/execution-bridge-android.mjs";
import { withUnsupportedFallback } from "../ui/stand-in.js";
import type { MobileSessionStore, PersistedSession } from "../ui/session-store.js";

type MockMode = "stream" | "slow" | "businessError" | "http500" | "cutOnce" | "cutMany" | "hold" | "reason";

const REPLY = "端侧对话自检：一、二、三";

let mockMode: MockMode = "stream";
let requestLog: Array<{ path: string; body: unknown }> = [];
/** hold 模式：第一片之后停 holdMs 再继续——给"一轮还在跑"造一段确定长度的窗口，
 *  队列判据（忙时入队/删除/立即发送/打断插入）全在这段窗口里发命令，不靠碰运气。 */
let holdMs = 1200;
/** 判据 10 用：下一次模型回复改成一个工具调用（用一次就复位，后续请求回普通文本）。 */
let mockToolCall: { name: string; arguments: string } | null = null;
let mockToolQueue: Array<{ name: string; arguments: string }> = [];
let toolCallSent = false;
/** cutOnce 模式的"只砍第一次"开关：第一次请求发两片就掐线（复刻切后台连接被杀），
 *  之后的请求按正常流走——自动续写的新请求必须能拿到完整回复。 */
let cutOnceArmed = false;
/** cutMany 模式：前 CUT_MANY 次请求各发两片就掐线，之后正常——旧版 MAX_CONTINUATIONS=3
 *  会在第 3 次续写后放弃、整轮带"截断标注"收口；0.7.0 去上限后应一路续到成功。 */
let cutManyRemaining = 0;
/** 判据 13（自动压缩）用：mock 认出"上下文压缩引擎"系统提示的请求后回这段固定摘要。
 *  agent.ts 的 runCompact 请求里必含 "context-compaction engine"（压缩 system 提示的原文），
 *  这一条识别只存在于自检 mock，产品代码零 mock 痕迹。置 null 时压缩请求走正常流。 */
let compactionSummaryText: string | null = null;
let compactionFinishReason = "stop";
/** 判据 17 用：压缩请求的序号。摘要文本里的 "{n}" 会被换成第几次压缩请求，
 *  用来验证"分段摘要时前一段的摘要带进了后一段"。 */
let compactionRequestCount = 0;
/** 判据 18 用：压缩请求一律 500（模拟"网关拒绝摘要请求"），用来验证自动压缩的熔断。 */
let compactionFails = false;
const CUT_MANY = 5;

/** 一个足够真的 OpenAI Chat Completions SSE 端点（协议细节按 model-stream.ts 的解析面来）。 */
function startMock(): Promise<{ url: string; close(): void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        let body: unknown = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          // 空 body 的探测请求不重要的
        }
        requestLog.push({ path: req.url ?? "", body });
        // 用 res 的 close、不是 req 的：req 在请求体读完就 close，把它当"客户端挂断"会让
        // mock 在第一片都没发出去时就自认被取消，端侧看到的是一条永远不结束的流。
        const abort = new AbortController();
        res.on("close", () => abort.abort());

        if (mockMode === "http500") {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "网关 500：模型服务不可用" } }));
          return;
        }
        // 判据 13/17 的仪器：压缩请求（系统提示含 "context-compaction engine"）走另一条路，
        // 与正常对话流区分开——自动压缩发生在对话轮装配前，那条流的回复必须是另一段文本。
        const isCompactionRequest = JSON.stringify(body).includes("context-compaction engine");
        if (isCompactionRequest && compactionFails) {
          // 400 而不是 500：5xx 会被流层当"这一枪没打响"重试（每次压缩就发 3 次请求），
          // 这里要的是"一次摘要请求真的失败了"，不是"重连几次能成"。
          // 这条分支必须在 SSE 的 200 头之前——头都发出去了就改不了状态码了。
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "网关 400：摘要请求被拒绝" } }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        if (mockMode === "businessError") {
          send({ success: false, providerCode: 50001, message: "套餐额度不足，请换一个模型" });
          send("[DONE]");
          res.end();
          return;
        }
        if (compactionSummaryText !== null && isCompactionRequest) {
          compactionRequestCount += 1;
          const done = (content: string) => {
            send({
              id: "chatcmpl-smoke",
              object: "chat.completion.chunk",
              created: 1,
              model: "mock-model",
              choices: [{ index: 0, delta: { content }, finish_reason: null }],
            });
            send({
              id: "chatcmpl-smoke",
              object: "chat.completion.chunk",
              created: 1,
              model: "mock-model",
              choices: [{ index: 0, delta: {}, finish_reason: compactionFinishReason }],
              usage: { prompt_tokens: 900, completion_tokens: 30, total_tokens: 930 },
            });
            send("[DONE]");
            res.end();
          };
          done(compactionSummaryText.replace(/\{n\}/g, String(compactionRequestCount)));
          return;
        }
        const pieces = mockMode === "slow" ? ["慢", "慢", "慢", "慢", "慢"] : [..."端侧对话自检：一、二、三"];
        const step = mockMode === "slow" ? 140 : 8;
        // reason（0.7.3，用户点名"思考和正文混在一起全输出为回复"）：GLM/DeepSeek 方言——
        // 思考走 delta.reasoning_content，正文走 delta.content，两者同一条流里先后出现。
        // 判据：时间线必须有独立的 reasoning 行（text=思考全文），且正文行不含思考文字。
        if (mockMode === "reason") {
          for (const t of ["让我", "先想想", "这道题"]) {
            send({
              id: "chatcmpl-smoke",
              object: "chat.completion.chunk",
              created: 1,
              model: "mock-model",
              choices: [{ index: 0, delta: { reasoning_content: t }, finish_reason: null }],
            });
          }
          let k = 0;
          const pushBody = () => {
            if (k < pieces.length) {
              send({
                id: "chatcmpl-smoke",
                object: "chat.completion.chunk",
                created: 1,
                model: "mock-model",
                choices: [{ index: 0, delta: { content: pieces[k] }, finish_reason: null }],
              });
              k += 1;
              setTimeout(pushBody, step);
              return;
            }
            send({
              id: "chatcmpl-smoke",
              object: "chat.completion.chunk",
              created: 1,
              model: "mock-model",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
            });
            send("[DONE]");
            res.end();
          };
          pushBody();
          return;
        }
        // cutOnce：发两片后直接 destroy 连接（无 finish_reason、无 [DONE]）——复刻
        // "切后台回来连接被杀"的形状：客户端 read() reject → model.stream 错误。
        if (mockMode === "cutOnce" && cutOnceArmed) {
          cutOnceArmed = false;
          let j = 0;
          const cut = () => {
            if (j < 2) {
              send({
                id: "chatcmpl-smoke",
                object: "chat.completion.chunk",
                created: 1,
                model: "mock-model",
                choices: [{ index: 0, delta: { content: pieces[j] }, finish_reason: null }],
              });
              j += 1;
              setTimeout(cut, step);
              return;
            }
            res.destroy();
          };
          cut();
          return;
        }
        let i = 0;
        // cutMany：前 CUT_MANY 次各发两片就掐线，最后一次正常收尾。旧版 MAX_CONTINUATIONS=3
        // 会在额度耗尽后放弃（整轮 error）；0.7.0 的严格进展阀每次都有"端侧"入账（streamed
        // 一直在变长），一路续到第 6 次成功收口——这就是"取消不合理截断限制"的可测证明。
        if (mockMode === "cutMany" && cutManyRemaining > 0) {
          cutManyRemaining -= 1;
          let j = 0;
          const cut = () => {
            if (j < 2) {
              send({
                id: "chatcmpl-smoke",
                object: "chat.completion.chunk",
                created: 1,
                model: "mock-model",
                choices: [{ index: 0, delta: { content: pieces[j] }, finish_reason: null }],
              });
              j += 1;
              setTimeout(cut, step);
              return;
            }
            res.destroy();
          };
          cut();
          return;
        }
        // 一次性工具调用（判据 10 的执行模式场景）：第一次请求回一个 tool_call（finish=tool_calls），
        // 后续请求按普通文本回——正好复刻"模型要动手 → agent 按模式放行/拦截 → 再收口"。
        const queuedCall = mockToolQueue.shift();
        const nextToolCall = queuedCall ?? (mockToolCall && !toolCallSent ? mockToolCall : null);
        if (nextToolCall) {
          toolCallSent = true;
          send({
            id: "chatcmpl-smoke",
            object: "chat.completion.chunk",
            created: 1,
            model: "mock-model",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-mode-1",
                      type: "function",
                      function: { name: nextToolCall.name, arguments: nextToolCall.arguments },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
          send({
            id: "chatcmpl-smoke",
            object: "chat.completion.chunk",
            created: 1,
            model: "mock-model",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          });
          send("[DONE]");
          res.end();
          return;
        }
        const push = () => {
          if (abort.signal.aborted) return;
          if (i < pieces.length) {
            send({
              id: "chatcmpl-smoke",
              object: "chat.completion.chunk",
              created: 1,
              model: "mock-model",
              choices: [{ index: 0, delta: { content: pieces[i] }, finish_reason: null }],
            });
            i += 1;
            // hold 模式：第一片之后停 holdMs（给忙时命令留窗口），其余按常速。
            setTimeout(push, mockMode === "hold" && i === 1 ? holdMs : step);
            return;
          }
          send({
            id: "chatcmpl-smoke",
            object: "chat.completion.chunk",
            created: 1,
            model: "mock-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
          });
          send("[DONE]");
          res.end();
        };
        push();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        close: () => server.close(),
      });
    });
  });
}

/**
 * 内存版 MobileSessionStore：判据 6（重启还原）的仪器。
 *
 * 为什么不是真 SQLite：真库的往返（SqliteBridge / sql.js）已由设备自检（m1-run.mjs、selfcheck.mjs）
 * 覆盖，这一条要验的是 **agent.ts 里我写的那三段逻辑** —— 落盘、订阅时还原、announce 时水合侧栏。
 * 用同一个 Map 实例喂给两个先后创建的 agent，就精确复现了"进程死了、库还在、新进程重建会话"
 * 这一次重启，而不需要真的杀进程或落盘。形状与 session-store.ts 的接口逐字对齐。
 */
function makeMemorySessionStore(): MobileSessionStore {
  const rows = new Map<string, PersistedSession & { updatedAt: number }>();
  return {
    save(entry) {
      rows.set(entry.sessionId, { ...entry, updatedAt: Date.now() });
    },
    load(sessionId) {
      const hit = rows.get(sessionId);
      return hit ? { sessionId, workspacePath: hit.workspacePath, summary: hit.summary, state: hit.state, updatedAt: hit.updatedAt } : null;
    },
    listSummaries(workspacePath) {
      const out: Array<{ sessionId: string; summary: PersistedSession["summary"]; updatedAt: number }> = [];
      for (const [sessionId, rec] of rows) {
        if (rec.workspacePath === workspacePath) out.push({ sessionId, summary: rec.summary, updatedAt: rec.updatedAt });
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    },
    engine() {
      return "memory-smoke";
    },
  };
}

/**
 * 每次场景一套全新的 agent + RPC 通道。
 * 计数代理是判据 2 的仪器：subscribe/resync 的次数只能从调用侧数，投影本身看不出来。
 */
function makeRig(
  baseUrl: string,
  sessionStore?: MobileSessionStore | null,
  hookRuntimeFactory?: (options: {
    workspacePath: string;
    onLifecycleEvent?: (event: { type: string; payload: Record<string, unknown> }) => void;
    onDiagnostic?: (message: string) => void;
  }) => Promise<unknown>,
  toolEngineFactory?: (workspacePath: string) => Promise<unknown>,
  agentOptions?: Record<string, unknown>,
) {
  const testContextWindow = (agentOptions as { testContextWindow?: number } | undefined)?.testContextWindow;
  const counts = { subscribe: 0, resync: 0, commands: 0 };
  const diagnostics: string[] = [];
  const frames: string[] = [];
  const agent = withUnsupportedFallback(
    createMobileAgentService({
      onDiagnostic: (m) => diagnostics.push(m),
      modelTargets: {
        view: async () => ({
          providers: [
            {
              providerId: "mock-provider",
              executable: true,
              models: [{ modelId: "mock-model", ...(testContextWindow ? { config: { properties: { contextWindow: testContextWindow } } } : {}) }],
              config: {
                api: { type: "openai-chat-completions", baseUrl },
                access: { type: "personal-api-key", apiKey: "sk-mock" },
              },
            },
          ],
          preferredSelection: { providerId: "mock-provider", modelId: "mock-model" },
        }),
      },
      deviceId: "smoke-device",
      ...(sessionStore !== undefined ? { sessionStore } : {}),
      ...(hookRuntimeFactory ? { hookRuntimeFactory: hookRuntimeFactory as never } : {}),
      ...(toolEngineFactory ? { toolEngine: toolEngineFactory as never } : {}),
      ...(agentOptions ?? {}),
    }),
    "mobile:zcodeAgentService",
  );

  const [serverSide, clientSide] = createQueuePair();
  const server = new ChannelServer(serverSide, "smoke-host", 5000, true);
  const counting = new Proxy(agent as never as Record<string, unknown>, {
    get(obj, key) {
      const value = Reflect.get(obj, key);
      if (key === "subscribeConversationV4") {
        return (arg: unknown) => {
          counts.subscribe += 1;
          return (value as (x: unknown) => unknown)(arg);
        };
      }
      if (key === "resyncConversationV4") {
        return (arg: unknown) => {
          counts.resync += 1;
          return (value as (x: unknown) => unknown)(arg);
        };
      }
      if (key === "sendConversationCommandV4") {
        return (arg: unknown) => {
          counts.commands += 1;
          return (value as (x: unknown) => unknown)(arg);
        };
      }
      return value;
    },
  });
  server.registerChannel("zcodeAgentService", ProxyChannel.fromService(counting));
  server.ready();
  const client = new ChannelClient(clientSide);
  const service = ProxyChannel.toService<Record<string, unknown>>(client.getChannel("zcodeAgentService"));
  const transport = createAgentConversationTransport(service as never, { workspacePath: "/work/smoke" });
  const faults: Array<{ reasonCode?: string; subscriptionId?: string }> = [];
  transport.onAssemblyFault((f) => faults.push(f as never));
  transport.onFrame((frame, context) =>
    frames.push(
      `${frame.payload.kind}:${frame.fromSeq}->${frame.toSeq} sub=${frame.subscriptionId} dk=${context?.deliveryKind ?? "?"}`,
    ),
  );
  return { transport, service, faults, counts, dispose: () => agent.disposeAll(), diagnostics, frames };
}

type Rig = ReturnType<typeof makeRig>;

async function openSession(rig: Rig): Promise<{ store: ConversationProjectionStore; sessionId: string }> {
  const envelope = createCommandEnvelope({
    type: "createSession",
    sessionId: null,
    payload: { workspaceId: "ws-smoke" },
  });
  const ack = (await rig.transport.sendCommand(envelope)) as {
    status: string;
    reasonCode?: string;
    message?: string;
    result?: { sessionId?: string };
  };
  if (ack.status !== "accepted" || !ack.result?.sessionId) {
    throw new Error(`createSession 没有 accepted：${JSON.stringify(ack)}`);
  }
  const sessionId = ack.result.sessionId;
  const store = new ConversationProjectionStore(conversationTopic(sessionId), rig.transport);
  // store 自己不订阅帧：真机上是 SessionDataLayer 那一条"连接级单监听、按 topic 扇入"
  // （sessionDataLayer.ts:62-64）。少了这一步，帧到了也没人 apply —— 这就是"转圈圈"。
  rig.transport.onFrame((frame, context) => {
    if (frame.topic === store.topic) store.handleFrame(frame, context);
  });
  await store.connect();
  // ACK 先到、初始 snapshot 后到是这套协议的正常形状（公共响应严格只含 ACK）。
  // 所以"连上了"必须等到投影真的有东西，否则后面每条断言都在和一个空壳比。
  await waitFor(() => store.getState().snapshot !== null, "订阅后没有收到初始 snapshot", 4000, () => ({
    status: store.getState().status,
    storeSubId: store.getState().subscriptionId,
    frames: rig.frames,
    faults: rig.faults,
    agentDiag: rig.diagnostics,
  }));
  return { store, sessionId };
}

async function openExistingSession(rig: Rig, sessionId: string): Promise<ConversationProjectionStore> {
  const store = new ConversationProjectionStore(conversationTopic(sessionId), rig.transport);
  rig.transport.onFrame((frame, context) => {
    if (frame.topic === store.topic) store.handleFrame(frame, context);
  });
  await store.connect();
  await waitFor(
    () => store.getState().snapshot !== null,
    `订阅子会话 ${sessionId} 后没有收到 snapshot`,
    4000,
    () => ({ frames: rig.frames, faults: rig.faults, agentDiag: rig.diagnostics }),
  );
  return store;
}

const settle = (store: ConversationProjectionStore) => {
  const phase = store.getState().snapshot?.control.phase;
  return phase !== undefined && phase !== "running" && phase !== "draft" && phase !== "prewarming";
};

async function waitFor(
  predicate: () => boolean,
  message: string,
  budgetMs = 8000,
  dump?: () => unknown,
): Promise<void> {
  // 有上限的等待，不是"等不到就算过"：超时一律以 message 失败退出。
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > budgetMs) {
      throw new Error(`超时：${message} —— ${JSON.stringify(dump?.() ?? null)}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

function sendTurn(rig: Rig, store: ConversationProjectionStore, sessionId: string, text: string) {
  const envelope = createCommandEnvelope({
    type: "sendText",
    sessionId,
    payload: { text },
  });
  store.markCommandPending({ commandId: envelope.commandId, type: "sendText", issuedAt: Date.now() });
  return { envelope, ack: rig.transport.sendCommand(envelope) };
}

const rowsOf = (store: ConversationProjectionStore) => store.getState().snapshot?.rows.window ?? [];
const userRows = (store: ConversationProjectionStore) =>
  rowsOf(store).filter((r: { kind: string }) => r.kind === "userInput");
const assistantRows = (store: ConversationProjectionStore) =>
  rowsOf(store).filter((r: { kind: string }) => r.kind === "assistantText");

async function main() {
  const mock = await startMock();
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail });
  const indicatorTask = {
    taskId: "indicator-task",
    traceId: "indicator-trace",
    title: "indicator",
    workspacePath: "/work/a",
    createdAt: 1,
    updatedAt: 1,
    mode: "build" as const,
    unreadAt: 2,
  };
  const indicatorActivity = (phase: "draft" | "prewarming" | "running" | "completedSuccess" | "completedInterrupted" | "error") => ({
    phase,
    lastActivityAt: 1,
    hasBackgroundWork: false,
  });
  check("侧栏实时运行态优先显示旋转动画（包括未读任务）",
    deriveTaskLeadingIndicator(indicatorTask, indicatorActivity("running")) === "loading" &&
    deriveTaskLeadingIndicator(indicatorTask, indicatorActivity("prewarming")) === "loading");
  check("侧栏失败状态优先显示错误，结束后停止动画并保留未读状态",
    deriveTaskLeadingIndicator(indicatorTask, indicatorActivity("error")) === "error" &&
    deriveTaskLeadingIndicator(indicatorTask, indicatorActivity("completedSuccess")) === "unread" &&
    deriveTaskLeadingIndicator({ ...indicatorTask, unreadAt: undefined }, indicatorActivity("completedInterrupted")) === "none");
  check("上次落盘的 running 不会在未收到当前 workspace 活动时继续转圈",
    deriveTaskLeadingIndicator({ ...indicatorTask, unreadAt: undefined, status: "running" }, null) === "none" &&
    buildTaskListItemIdentityKey({ ...indicatorTask, workspacePath: "/work/a" }) !==
      buildTaskListItemIdentityKey({ ...indicatorTask, workspacePath: "/work/b" }));
  // 超时必须把"卡在哪一层"一起带出来：没有这份读数，一条"第一轮没有落到终态"等于没说。
  const describe = (rig: Rig, store: ConversationProjectionStore) => () => ({
    status: store.getState().status,
    hasSnapshot: store.getState().snapshot !== null,
    phase: store.getState().snapshot?.control.phase,
    rows: rowsOf(store).map((r: { kind: string }) => r.kind),
    storeError: store.getState().lastError,
    controlError: store.getState().snapshot?.control.lastError,
    frames: rig.frames,
    faults: rig.faults,
    counts: rig.counts,
    agentDiag: rig.diagnostics,
    requests: requestLog.length,
  });

  try {
    // ── 判据 1 / 2：一句正常对话 + 同会话第二句 ──
    mockMode = "stream";
    const rig = makeRig(mock.url);
    const { store, sessionId } = await openSession(rig);
    check(
      "订阅后真的收到了初始 snapshot（status=live 只说明 ACK 回来了）",
      store.getState().status === "live" && store.getState().snapshot !== null,
      `status=${store.getState().status} hasSnapshot=${store.getState().snapshot === null} frames=${JSON.stringify(rig.frames)}`,
    );

    const first = sendTurn(rig, store, sessionId, "第一句");
    const firstAck = (await first.ack) as { status: string; message?: string };
    check("sendText 被 accepted", firstAck.status === "accepted", JSON.stringify(firstAck));
    await waitFor(() => settle(store), "第一轮没有落到终态", 8000, describe(rig, store));

    check(
      "正文真的流式回来了（不是空回复）",
      assistantRows(store).some((r: { text?: string }) => r.text === REPLY),
      JSON.stringify(assistantRows(store).map((r: { text?: string }) => r.text)),
    );
    check(
      "乐观气泡退场了（用户消息由权威投影接管）",
      store.getState().optimisticCommands.length === 0,
      JSON.stringify(store.getState().optimisticCommands),
    );
    check(
      "服务端回的用户消息带回了 commandId（那是'我收到了'的唯一凭据）",
      userRows(store).some(
        (r: { sourceCommandId?: string }) => r.sourceCommandId === first.envelope.commandId,
      ),
      JSON.stringify(userRows(store).map((r: { sourceCommandId?: string }) => r.sourceCommandId)),
    );
    check(
      "这一轮是 completedSuccess",
      store.getState().snapshot?.control.phase === "completedSuccess",
      String(store.getState().snapshot?.control.phase),
    );
    check(
      "usage 记到了 token 上（不是 0，说明响应真的解析了）",
      (store.getState().snapshot?.usage.cumulative.inputTokens ?? 0) === 11,
      JSON.stringify(store.getState().snapshot?.usage.cumulative),
    );
    check("装配侧没有 protocol fault", rig.faults.length === 0, JSON.stringify(rig.faults));
    check("上下文占用为最新请求输入加输出token，不是请求次数", store.getState().snapshot?.usage.contextWindow?.usedTokens === 18,
      JSON.stringify(store.getState().snapshot?.usage));
    check("订阅只发生一次", rig.counts.subscribe === 1, String(rig.counts.subscribe));
    check("没有 resync（seq 记账是对的）", rig.counts.resync === 0, String(rig.counts.resync));

    const second = sendTurn(rig, store, sessionId, "第二句");
    await second.ack;
    await waitFor(() => settle(store) && userRows(store).length >= 2, "第二轮没有跑完");
    check(
      "同一会话能接着说第二句（历史带着走：system + 上一问 + 上一答 + 这一问）",
      requestLog.length === 2 &&
        ((requestLog[1].body as { messages?: unknown[] })?.messages?.length ?? 0) === 4,
      JSON.stringify(requestLog.map((r) => (r.body as { messages?: unknown[] })?.messages?.length)),
    );
    check(
      "第二句之后仍然没有重订阅、没有 resync",
      rig.counts.subscribe === 1 && rig.counts.resync === 0 && rig.faults.length === 0,
      `subscribe=${rig.counts.subscribe} resync=${rig.counts.resync} faults=${JSON.stringify(rig.faults)}`,
    );
    rig.dispose();

    // ── 判据 3：200 里塞业务错误 ──
    mockMode = "businessError";
    const rigErr = makeRig(mock.url);
    const sErr = await openSession(rigErr);
    await sendTurn(rigErr, sErr.store, sErr.sessionId, "会失败的一句").ack;
    await waitFor(() => settle(sErr.store), "业务错误这一轮没有落到终态");
    check(
      "业务错误没被当成回答（正文是空的）",
      assistantRows(sErr.store).every((r: { text?: string }) => (r.text ?? "") === ""),
      JSON.stringify(assistantRows(sErr.store).map((r: { text?: string }) => r.text)),
    );
    check(
      "失败原因写在屏幕上读得出来（phase=error + lastError）",
      sErr.store.getState().snapshot?.control.phase === "error" &&
        (sErr.store.getState().snapshot?.control.lastError?.message ?? "").includes("套餐额度不足"),
      JSON.stringify(sErr.store.getState().snapshot?.control.lastError),
    );
    rigErr.dispose();

    // ── 判据 4：HTTP 5xx ──
    mockMode = "http500";
    const rig500 = makeRig(mock.url);
    const s500 = await openSession(rig500);
    await sendTurn(rig500, s500.store, s500.sessionId, "网关挂了").ack;
    await waitFor(() => settle(s500.store), "500 这一轮没有落到终态");
    check(
      "HTTP 500 也是明确的失败，不是空回复",
      s500.store.getState().snapshot?.control.phase === "error" &&
        (s500.store.getState().snapshot?.control.lastError?.message ?? "").length > 0,
      JSON.stringify(s500.store.getState().snapshot?.control.lastError),
    );
    rig500.dispose();

    // ── 判据 4.5：流中途被掐（切后台回来连接被杀）→ 自动续写 ──
    // 0.6.9（用户点名"切出来再切回去就断了，宁可暂停了回来再继续"）：mock 发两片就 destroy
    // 连接（无收尾帧）——端侧 read() reject → model.stream → 自动续写把部分正文回填
    // transcript 再请求一次 → 第二次 mock 按正常流走 → 轮次成功收口，气泡是"部分 + 完整"。
    mockMode = "cutOnce";
    cutOnceArmed = true;
    requestLog = [];
    const rigCut = makeRig(mock.url);
    const sCut = await openSession(rigCut);
    await sendTurn(rigCut, sCut.store, sCut.sessionId, "会被掐的一句").ack;
    await waitFor(() => settle(sCut.store), "被掐的这一轮没有落到终态", 12000, describe(rigCut, sCut.store));
    check(
      "流被掐后自动续写，轮次成功收口（不是 error）",
      sCut.store.getState().snapshot?.control.phase === "completedSuccess",
      `phase=${String(sCut.store.getState().snapshot?.control.phase)} lastError=${JSON.stringify(
        sCut.store.getState().snapshot?.control.lastError,
      )}`,
    );
    check(
      "气泡是'部分正文 + 续写完整回复'的拼接（无缝续上）",
      assistantRows(sCut.store).some((r: { text?: string }) => r.text === "端侧" + REPLY),
      JSON.stringify(assistantRows(sCut.store).map((r: { text?: string }) => r.text)),
    );
    check(
      "续写真的发了第二次请求（transcript 带着部分正文）",
      requestLog.length === 2,
      `requests=${requestLog.length} messages=${JSON.stringify(
        requestLog.map((r) => (r.body as { messages?: unknown[] })?.messages?.length),
      )}`,
    );
    rigCut.dispose();
    mockMode = "stream";

    // ── 判据 4.6：坏网络一句一掐（连掐 5 次）→ 无上限续写到成功 ──
    // 0.7.0（用户点名"几乎一句话就被截断，彻底取消不合理的截断限制"）：旧版 MAX_CONTINUATIONS=3
    // 在第 4 次掐线后放弃（phase=error + 截断标注）；进展阀下每次掐线正文都在变长，
    // 一路续到第 6 次成功收口。5 > 3 就是新旧行为的分水岭。
    mockMode = "cutMany";
    cutManyRemaining = CUT_MANY;
    requestLog = [];
    const rigMany = makeRig(mock.url);
    const sMany = await openSession(rigMany);
    await sendTurn(rigMany, sMany.store, sMany.sessionId, "坏网络的一句").ack;
    await waitFor(() => settle(sMany.store), "连掐的这一轮没有落到终态", 15000, describe(rigMany, sMany.store));
    check(
      "连掐 5 次仍自动续写到成功收口（旧上限 3 次会 error）",
      sMany.store.getState().snapshot?.control.phase === "completedSuccess",
      `phase=${String(sMany.store.getState().snapshot?.control.phase)} lastError=${JSON.stringify(
        sMany.store.getState().snapshot?.control.lastError,
      )}`,
    );
    check(
      "气泡=5 段残文 + 完整回复的拼接",
      assistantRows(sMany.store).some((r: { text?: string }) => r.text === "端侧".repeat(CUT_MANY) + REPLY),
      JSON.stringify(assistantRows(sMany.store).map((r: { text?: string }) => r.text)),
    );
    check(
      "发了 6 次请求（1 原始 + 5 续写）",
      requestLog.length === CUT_MANY + 1,
      `requests=${requestLog.length}`,
    );
    rigMany.dispose();
    mockMode = "stream";

    // ── 判据 5：中途停止 ──
    mockMode = "slow";
    const rigStop = makeRig(mock.url);
    const sStop = await openSession(rigStop);
    await sendTurn(rigStop, sStop.store, sStop.sessionId, "慢慢说").ack;
    await waitFor(
      () => assistantRows(sStop.store).some((r: { text?: string }) => (r.text ?? "").length > 0),
      "停止前没有拿到任何增量",
    );
    const stopEnvelope = createCommandEnvelope({
      type: "stop",
      sessionId: sStop.sessionId,
      payload: {},
    });
    const stopAck = (await rigStop.transport.sendCommand(stopEnvelope)) as { status: string };
    check("停止命令被 accepted", stopAck.status === "accepted", JSON.stringify(stopAck));
    await waitFor(() => settle(sStop.store), "停止后没有落到终态");
    check(
      "这一轮记为被打断，而不是成功",
      sStop.store.getState().snapshot?.control.phase === "completedInterrupted",
      String(sStop.store.getState().snapshot?.control.phase),
    );
    check(
      "assistant 行不再是 streaming（否则手机上永远闪光标）",
      assistantRows(sStop.store).every(
        (r: { state?: string }) => r.state !== "streaming" && r.state !== undefined,
      ),
      JSON.stringify(assistantRows(sStop.store).map((r: { state?: string }) => r.state)),
    );
    rigStop.dispose();

    // ── 判据 7：等待队列（0.7.1，用户点名"发出信息进入等待队列，再删除/修改/打断插入"）──
    // 7.1 忙时第二句入队（不打断当前轮）→ 删除一条 → 收轮自动排空
    mockMode = "hold";
    holdMs = 1500;
    requestLog = [];
    const rigQ = makeRig(mock.url);
    const sQ = await openSession(rigQ);
    await sendTurn(rigQ, sQ.store, sQ.sessionId, "队列甲").ack;
    await waitFor(
      () => sQ.store.getState().snapshot?.control.phase === "running",
      "第一轮没有进入 running，队列窗口没打开",
      4000,
      describe(rigQ, sQ.store),
    );
    check(
      "忙时 inputRouting=enqueue（不再是 reject——用户要的队列入口）",
      sQ.store.getState().snapshot?.inputRouting.mode === "enqueue",
      JSON.stringify(sQ.store.getState().snapshot?.inputRouting),
    );
    // 忙时入队第二条（乐观气泡要能退场：队列项带 sourceCommandId，store 靠它对账）
    const q2 = sendTurn(rigQ, sQ.store, sQ.sessionId, "队列乙");
    const q2Ack = (await q2.ack) as { status: string; result?: { delivery?: string } };
    check(
      "忙时 sendText 被 accepted 且 delivery=queue（排上了，不是假装跑）",
      q2Ack.status === "accepted" && q2Ack.result?.delivery === "queue",
      JSON.stringify(q2Ack),
    );
    await waitFor(
      () => (sQ.store.getState().snapshot?.queue.items.length ?? 0) === 1,
      "队列里没有出现第二条",
      4000,
      describe(rigQ, sQ.store),
    );
    check(
      "队列项带原 commandId（乐观气泡按它对账退场）",
      sQ.store.getState().snapshot?.queue.items[0]?.sourceCommandId === q2.envelope.commandId,
      JSON.stringify(sQ.store.getState().snapshot?.queue.items.map((i) => i.sourceCommandId)),
    );
    check(
      "入队后乐观气泡退场（store 的 reconcileOptimistic 认 queue 项）",
      sQ.store.getState().optimisticCommands.length === 0,
      JSON.stringify(sQ.store.getState().optimisticCommands),
    );
    // 再入一条，然后删掉它（删除判据）
    const q3 = sendTurn(rigQ, sQ.store, sQ.sessionId, "队列丙");
    await q3.ack;
    await waitFor(
      () => (sQ.store.getState().snapshot?.queue.items.length ?? 0) === 2,
      "队列丙没有入队",
      4000,
      describe(rigQ, sQ.store),
    );
    const q3ItemId = sQ.store.getState().snapshot?.queue.items.find(
      (item) => item.sourceCommandId === q3.envelope.commandId,
    )?.queueItemId;
    const deleteAck = (await rigQ.transport.sendCommand(
      createCommandEnvelope({
        type: "deleteQueueItem",
        sessionId: sQ.sessionId,
        payload: { queueItemId: q3ItemId },
        baseRevision: sQ.store.getState().snapshot?.revision ?? 0,
      }),
    )) as { status: string };
    check("deleteQueueItem 被 accepted", deleteAck.status === "accepted", JSON.stringify(deleteAck));
    await waitFor(
      () => sQ.store.getState().snapshot?.queue.items.length === 1,
      "删掉之后队列还是两条",
      4000,
      describe(rigQ, sQ.store),
    );
    check(
      "删掉的是队列丙（队列乙还在）",
      sQ.store.getState().snapshot?.queue.items[0]?.text === "队列乙",
      JSON.stringify(sQ.store.getState().snapshot?.queue.items.map((i) => i.text)),
    );
    // 第一轮跑完 → autoDrain 应自动把"队列乙"排出去
    await waitFor(
      () =>
        settle(sQ.store) &&
        requestLog.length >= 2 &&
        userRows(sQ.store).some((r: { text?: string }) => r.text === "队列乙"),
      "第一轮收口后没有自动排空队列乙",
      10000,
      describe(rigQ, sQ.store),
    );
    check(
      "收轮自动排空：队列乙真的被跑起来了（时间线里有它）",
      userRows(sQ.store).filter((r: { text?: string }) => r.text === "队列乙").length === 1,
      JSON.stringify(userRows(sQ.store).map((r: { text?: string }) => r.text)),
    );
    check(
      "队列跑空后是空的（没有幽灵项）",
      (sQ.store.getState().snapshot?.queue.items.length ?? -1) === 0,
      JSON.stringify(sQ.store.getState().snapshot?.queue.items),
    );
    check(
      "两轮各发了一次模型请求（甲 + 排空的乙）",
      requestLog.length === 2,
      `requests=${requestLog.length}`,
    );
    rigQ.dispose();

    // 7.2 立即发送 = 打断插入（abort 当前轮，排空它而不是排它后面）
    mockMode = "hold";
    holdMs = 4000;
    requestLog = [];
    const rigNow = makeRig(mock.url);
    const sNow = await openSession(rigNow);
    await sendTurn(rigNow, sNow.store, sNow.sessionId, "打断甲").ack;
    await waitFor(
      () => sNow.store.getState().snapshot?.control.phase === "running",
      "打断甲没有进入 running",
      4000,
      describe(rigNow, sNow.store),
    );
    const nowItem = sendTurn(rigNow, sNow.store, sNow.sessionId, "插入乙");
    await nowItem.ack;
    await waitFor(
      () => (sNow.store.getState().snapshot?.queue.items.length ?? 0) === 1,
      "插入乙没有入队",
      4000,
      describe(rigNow, sNow.store),
    );
    const nowItemId = sNow.store.getState().snapshot?.queue.items[0]?.queueItemId;
    const sendNowAck = (await rigNow.transport.sendCommand(
      createCommandEnvelope({
        type: "sendQueuedNow",
        sessionId: sNow.sessionId,
        payload: { queueItemId: nowItemId },
        baseRevision: sNow.store.getState().snapshot?.revision ?? 0,
      }),
    )) as { status: string };
    check("sendQueuedNow 被 accepted", sendNowAck.status === "accepted", JSON.stringify(sendNowAck));
    await waitFor(
      () =>
        sNow.store.getState().snapshot?.control.phase === "completedSuccess" &&
        userRows(sNow.store).some((r: { text?: string }) => r.text === "插入乙"),
      "立即发送没有把插入乙跑起来",
      12000,
      describe(rigNow, sNow.store),
    );
    check(
      "打断插入：插入乙跑了、队列空了、当前轮是成功收口",
      (sNow.store.getState().snapshot?.queue.items.length ?? -1) === 0 &&
        sNow.store.getState().snapshot?.control.phase === "completedSuccess",
      `queue=${JSON.stringify(sNow.store.getState().snapshot?.queue.items.length)} phase=${String(sNow.store.getState().snapshot?.control.phase)}`,
    );
    const headersNow = rowsOf(sNow.store).filter((r: { kind: string }) => r.kind === "turnHeader");
    check(
      "被打断的甲留在时间线上（completedInterrupted，不是消失）",
      headersNow.length === 2 &&
        (headersNow[0] as { state?: string }).state === "completedInterrupted" &&
        (headersNow[1] as { state?: string }).state === "completedSuccess",
      JSON.stringify(headersNow.map((r: { state?: string }) => r.state)),
    );
    rigNow.dispose();

    // 7.3 停止 → 队列暂停（choice）→ 恢复（setAutoDrain）后自己排空
    mockMode = "hold";
    holdMs = 4000;
    requestLog = [];
    const rigPause = makeRig(mock.url);
    const sPause = await openSession(rigPause);
    await sendTurn(rigPause, sPause.store, sPause.sessionId, "暂停甲").ack;
    await waitFor(
      () => sPause.store.getState().snapshot?.control.phase === "running",
      "暂停甲没有进入 running",
      4000,
      describe(rigPause, sPause.store),
    );
    const pauseItem = sendTurn(rigPause, sPause.store, sPause.sessionId, "暂停乙");
    await pauseItem.ack;
    await waitFor(
      () => (sPause.store.getState().snapshot?.queue.items.length ?? 0) === 1,
      "暂停乙没有入队",
      4000,
      describe(rigPause, sPause.store),
    );
    await rigPause.transport.sendCommand(
      createCommandEnvelope({ type: "stop", sessionId: sPause.sessionId, payload: {} }),
    );
    await waitFor(() => settle(sPause.store), "停止后没有落到终态", 6000, describe(rigPause, sPause.store));
    check(
      "停止后队列被暂停（autoDrain=false + pauseReason=stopped，条目未丢）",
      sPause.store.getState().snapshot?.queue.autoDrain === false &&
        sPause.store.getState().snapshot?.queue.pauseReason === "stopped" &&
        (sPause.store.getState().snapshot?.queue.items.length ?? 0) === 1,
      JSON.stringify(sPause.store.getState().snapshot?.queue),
    );
    check(
      "暂停后 inputRouting=choice（客户端据此弹'清空/保留'确认框）",
      sPause.store.getState().snapshot?.inputRouting.mode === "choice",
      JSON.stringify(sPause.store.getState().snapshot?.inputRouting),
    );
    // 点「恢复」→ 队列自己接着跑
    const resumeAck = (await rigPause.transport.sendCommand(
      createCommandEnvelope({
        type: "setAutoDrain",
        sessionId: sPause.sessionId,
        payload: { autoDrain: true },
        baseRevision: sPause.store.getState().snapshot?.revision ?? 0,
      }),
    )) as { status: string };
    check("setAutoDrain(true) 被 accepted", resumeAck.status === "accepted", JSON.stringify(resumeAck));
    await waitFor(
      () =>
        settle(sPause.store) &&
        userRows(sPause.store).some((r: { text?: string }) => r.text === "暂停乙"),
      "恢复后队列没有接着排空",
      12000,
      describe(rigPause, sPause.store),
    );
    check(
      "恢复后暂停乙被跑掉（队列空 + 成功收口）",
      (sPause.store.getState().snapshot?.queue.items.length ?? -1) === 0 &&
        sPause.store.getState().snapshot?.control.phase === "completedSuccess",
      `queue=${sPause.store.getState().snapshot?.queue.items.length} phase=${String(sPause.store.getState().snapshot?.control.phase)}`,
    );
    rigPause.dispose();
    mockMode = "stream";

    // ── 判据 6：重启后还原（用户报的那个症状：退出后历史没了、侧栏空）──
    mockMode = "stream";
    // 同一个 store 实例喂给先后两个 agent = 一次重启：内存 Map 清了，"库"还在。
    const persisted = makeMemorySessionStore();
    const rigA = makeRig(mock.url, persisted);
    const sA = await openSession(rigA);
    await sendTurn(rigA, sA.store, sA.sessionId, "重启前的一句").ack;
    await waitFor(() => settle(sA.store), "重启前那一轮没有落到终态", 8000, describe(rigA, sA.store));
    const survivedSessionId = sA.sessionId;
    const rowsBeforeRestart = rowsOf(sA.store).map(
      (r: { kind: string; text?: string }) => `${r.kind}:${r.text ?? ""}`,
    );
    rigA.dispose();
    // 清掉"重启前"那一轮的请求记录：判据 6 后半段要数的是"重启后接着说"发出的那一条。
    requestLog.length = 0;

    const rigB = makeRig(mock.url, persisted);
    const storeB = new ConversationProjectionStore(conversationTopic(survivedSessionId), rigB.transport);
    rigB.transport.onFrame((frame, context) => {
      if (frame.topic === storeB.topic) storeB.handleFrame(frame, context);
    });
    await storeB.connect();
    await waitFor(
      () => storeB.getState().snapshot !== null,
      "重启后订阅旧会话没有收到 snapshot",
      4000,
      describe(rigB, storeB),
    );
    check(
      "重启后订阅旧会话拿回的是真时间线，不是 missing 占位",
      (storeB.getState().snapshot?.control.lastError?.code ?? "") !== "mobile.session.notRestored",
      JSON.stringify(storeB.getState().snapshot?.control.lastError),
    );
    check(
      "重启后用户那句话和模型回答都还在",
      userRows(storeB).some((r: { text?: string }) => r.text === "重启前的一句") &&
        assistantRows(storeB).some((r: { text?: string }) => r.text === REPLY),
      `重启后=${JSON.stringify(rowsOf(storeB).map((r: { kind: string; text?: string }) => `${r.kind}:${r.text ?? ""}`))} ` +
        `重启前=${JSON.stringify(rowsBeforeRestart)}`,
    );
    check(
      "重启后 token 用量没有归零（按轮的用量跟着还原回来了）",
      (storeB.getState().snapshot?.usage.cumulative.inputTokens ?? 0) === 11,
      JSON.stringify(storeB.getState().snapshot?.usage.cumulative),
    );
    check(
      "重启后终态还是终态（不会永远转圈、停止键也不会按不动）",
      settle(storeB),
      String(storeB.getState().snapshot?.control.phase),
    );

    const afterRestart = sendTurn(rigB, storeB, survivedSessionId, "重启后接着说");
    const afterRestartAck = (await afterRestart.ack) as { status: string; message?: string };
    check(
      "重启后的会话能接着发消息（还原的是活会话，读的历史）",
      afterRestartAck.status === "accepted",
      JSON.stringify(afterRestartAck),
    );
    await waitFor(
      () => userRows(storeB).length >= 2 && settle(storeB),
      "重启后接着说的那一轮没有跑完",
      8000,
      describe(rigB, storeB),
    );
    check(
      "重启后历史带着走（system + 旧问 + 旧答 + 新问 = 4 条，证明还原的不是空壳）",
      requestLog.length === 1 &&
        ((requestLog[0].body as { messages?: unknown[] })?.messages?.length ?? 0) === 4,
      JSON.stringify(requestLog.map((r) => (r.body as { messages?: unknown[] })?.messages?.length)),
    );

    // 侧栏那一行：水合发生在 announceWorkspaceRuntime（命令通路的第一行），
    // 必须赶在同步器订阅 sessions-index 之前 —— 顺序错了首帧就是空的，侧栏只剩一行点开是空的。
    const indexSnapshots: Array<Array<{ sessionId: string; title: string }>> = [];
    const serviceB = rigB.service as unknown as {
      // onDynamic* 是 bufferedFrameEvent 的产物：双层函数（() => (listener) => disposable），
      // 与上游 onDid… 事件的命名约定一致，这里必须真的调两层才挂得上监听。
      // 发出来的是 wire 帧（wire-codec.ts:188 的 complete 形状）：协议帧嵌在 `frame` 字段里，
      // 不是顶层 payload —— 真机上的消费者（wire-assembler）也是从这一格取的。
      onDynamicSessionsIndexFrame(): (
        listener: (wire: {
          frame?: { payload?: { snapshot?: { sessions?: Array<{ sessionId: string; title: string }> } } };
        }) => void,
      ) => { dispose(): void };
      subscribeSessionsIndexV4(params: { workspacePath: string }): Promise<unknown>;
    };
    const offIndex = serviceB.onDynamicSessionsIndexFrame()((wire) => {
      const listed = wire.frame?.payload?.snapshot?.sessions;
      if (listed) indexSnapshots.push(listed);
    });
    await serviceB.subscribeSessionsIndexV4({ workspacePath: "/work/smoke" });
    await waitFor(() => indexSnapshots.length > 0, "没有收到 sessions-index 快照", 4000, () => ({
      agentDiag: rigB.diagnostics,
    }));
    check(
      "侧栏索引里有这条重启前的会话（标题取自第一句话）",
      (indexSnapshots[0] ?? []).some(
        (s) => s.sessionId === survivedSessionId && s.title.includes("重启前的一句"),
      ),
      JSON.stringify(indexSnapshots[0] ?? []),
    );
    offIndex.dispose();
    rigB.dispose();

    // ── 判据 8：插件面（0.7.1，装机"浏览器控制显示端侧 agent 运行时未接入"）──
    // 设置页的 pluginManagementService 是薄代理，直连 agent：这条 RPC 如果报
    // EUNSUPPORTED(zcodeAgentService): listPlugins，屏幕上就是那句红色错误。
    // 这里断言端侧如实投影内建 browser-use 条目 + 开关真的落旗子（localStorage）。
    const storageBackup = (globalThis as { localStorage?: unknown }).localStorage;
    const storageMap = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => storageMap.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storageMap.set(key, String(value));
      },
      removeItem: (key: string) => {
        storageMap.delete(key);
      },
    };
    const rigPlug = makeRig(mock.url);
    const plugins = rigPlug.service as unknown as {
      listPlugins(params: { workspacePath: string }): Promise<{
        plugins: Array<{ id: string; name: string; enabled: boolean }>;
        diagnostics: unknown[];
      }>;
      getPluginsOverview(params: { workspacePath: string }): Promise<{
        marketplaces: unknown[];
        capability: { supported: boolean; reason?: string };
      }>;
      setPluginEnabled(params: {
        workspacePath: string;
        pluginId: string;
        enabled: boolean;
      }): Promise<{ enabled: boolean; plugin: { id: string; enabled: boolean } }>;
    };
    const listed = await plugins.listPlugins({ workspacePath: "/work/smoke" });
    check(
      "listPlugins 返回内建 browser-use 条目（不再 EUNSUPPORTED）",
      listed.plugins.some((p) => p.id === "browser-use@zcode-plugins-official" && p.enabled === false),
      JSON.stringify(listed),
    );
    const overview = await plugins.getPluginsOverview({ workspacePath: "/work/smoke" });
    check(
      "getPluginsOverview 如实说'端侧没有插件市场'（capability.supported=false + 原因）",
      overview.capability?.supported === false && Boolean(overview.capability?.reason),
      JSON.stringify(overview.capability),
    );
    const off = await plugins.setPluginEnabled({
      workspacePath: "/work/smoke",
      pluginId: "browser-use@zcode-plugins-official",
      enabled: false,
    });
    const afterOff = await plugins.listPlugins({ workspacePath: "/work/smoke" });
    check(
      "关掉浏览器控制：setPluginEnabled 落旗子，下一次 listPlugins 读到 false",
      off.enabled === false && afterOff.plugins[0]?.enabled === false,
      JSON.stringify({ off, listed: afterOff.plugins.map((p) => p.enabled) }),
    );
    const browserBackup = (globalThis as { zcodeBrowser?: unknown }).zcodeBrowser;
    (globalThis as { zcodeBrowser?: unknown }).zcodeBrowser = { open() {} };
    const backOn = await plugins.setPluginEnabled({
      workspacePath: "/work/smoke",
      pluginId: "browser-use@zcode-plugins-official",
      enabled: true,
    });
    check("再打开：旗子回到 true（开关是可逆的）", backOn.enabled === true, JSON.stringify(backOn));
    const unknownRejected = await plugins
      .setPluginEnabled({ workspacePath: "/work/smoke", pluginId: "not-a-plugin", enabled: true })
      .then(() => false)
      .catch(() => true);
    check("未知插件 id 明确报错（不装成设置成功）", unknownRejected === true);
    if (browserBackup === undefined) delete (globalThis as { zcodeBrowser?: unknown }).zcodeBrowser;
    else (globalThis as { zcodeBrowser?: unknown }).zcodeBrowser = browserBackup;
    rigPlug.dispose();
    if (storageBackup === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
    else (globalThis as { localStorage?: unknown }).localStorage = storageBackup;

    // ── 判据 9：钩子在 agent 层真的跑（0.7.1，用户点名"钩子未接入，请接入"）──
    // 9.1 用户级（端侧 home）钩子：UserPromptSubmit 注入上下文 + Stop 拦住继续一次。
    //   - 注入的上下文必须真的进系统提示（模型看得见）；
    //   - Stop 拦住继续 → 同一条消息发第二次请求，且第二次 transcript 里带着"要求继续"的 note；
    //   - 时间线上出现 hookInvocation 行（行投影 + schema 校验都过）。
    const hookBase = path.join(path.dirname(fileURLToPath(import.meta.url)), ".tmp-chat-hooks");
    const hookHome = path.join(hookBase, "home");
    const stopMarker = path.join(hookBase, "stop-called");
    mkdirSync(path.join(hookHome, ".zcode", "cli"), { recursive: true });
    writeFileSync(
      path.join(hookHome, ".zcode", "cli", "config.json"),
      JSON.stringify(
        {
          hooks: {
            enabled: true,
            events: {
              UserPromptSubmit: [
                { hooks: [{ type: "command", command: `echo '{"additionalContext":"钩子上文：记得先看 README"}'` }] },
              ],
              Stop: [
                {
                  hooks: [
                    {
                      type: "command",
                      command: `if [ -f "${stopMarker}" ]; then echo '{}'; else touch "${stopMarker}" ; echo '{"decision":"block","reason":"还没验完，再跑一遍"}'; fi`,
                    },
                  ],
                },
              ],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    // Node 版假执行桥（与 Android ExecBridge 同契约）：钩子命令在这里真的被 bash 执行。
    const bashPath = process.env.ZCODE_SMOKE_BASH ?? "C:/Program Files/Git/bin/bash.exe";
    (globalThis as { zcodeExec?: unknown }).zcodeExec = {
      exec(payloadJson: string): string {
        const req = JSON.parse(payloadJson) as {
          useShell?: boolean;
          command?: string;
          cwd?: string;
          env?: { set?: Record<string, string> };
          timeoutMs?: number;
        };
        const startedAt = Date.now();
        try {
          // 工作区路径是端侧虚拟路径（/work/smoke），在这台 Windows 上不存在——
          // 钩子命令的 cwd 落到临时目录，否则每次都是 ENOENT 假失败。
          const cwd = req.cwd && existsSync(req.cwd) ? req.cwd : hookBase;
          const out = execFileSync(bashPath, ["-c", req.command ?? ""], {
            cwd,
            env: { ...process.env, ...(req.env?.set ?? {}) },
            timeout: req.timeoutMs,
            encoding: "utf8",
          });
          return JSON.stringify({ stdout: String(out ?? ""), stderr: "", exitCode: 0, durationMs: Date.now() - startedAt });
        } catch (e) {
          const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
          return JSON.stringify({
            stdout: typeof err.stdout === "string" ? err.stdout : "",
            stderr: typeof err.stderr === "string" ? err.stderr : String(err.message ?? e),
            exitCode: typeof err.status === "number" ? err.status : 1,
            durationMs: Date.now() - startedAt,
          });
        }
      },
    };
    const makeHookFactory = () => (opts: { workspacePath: string; onLifecycleEvent?: never; onDiagnostic?: never }) =>
      createMobileHookRuntime({
        workspacePath: opts.workspacePath,
        homeDir: hookHome,
        loadCore: async () => ({ createConfiguredHookRunner, createMobileExecutionPort, createNativeExecBridge }),
        ...(opts.onLifecycleEvent ? { onLifecycleEvent: opts.onLifecycleEvent } : {}),
        ...(opts.onDiagnostic ? { onDiagnostic: opts.onDiagnostic } : {}),
      });

    mockMode = "stream";
    requestLog = [];
    const rigHook = makeRig(mock.url, undefined, makeHookFactory());
    const sHook = await openSession(rigHook);
    await sendTurn(rigHook, sHook.store, sHook.sessionId, "钩子这一句").ack;
    await waitFor(
      () => settle(sHook.store),
      "带钩子的一轮没有落到终态",
      10000,
      describe(rigHook, sHook.store),
    );
    check(
      "UserPromptSubmit 注入的上下文进了系统提示（模型看得见）",
      String((requestLog[0]?.body as { messages?: Array<{ role: string; content: string }> })?.messages?.[0]?.content ?? "").includes(
        "钩子上文：记得先看 README",
      ),
      JSON.stringify((requestLog[0]?.body as { messages?: unknown })?.messages).slice(0, 200),
    );
    check(
      "Stop 钩子拦住继续 → 同一条消息发了第二次请求",
      requestLog.length === 2,
      `requests=${requestLog.length}`,
    );
    check(
      "第二次 transcript 里带着'要求继续'的 note（钩子的话变成了用户消息）",
      String(
        JSON.stringify((requestLog[1]?.body as { messages?: unknown })?.messages ?? []),
      ).includes("还没验完，再跑一遍"),
      JSON.stringify((requestLog[1]?.body as { messages?: unknown })?.messages ?? []).slice(0, 300),
    );
    check(
      "时间线上有 hookInvocation 行（行投影过 schema，没被丢帧）",
      rowsOf(sHook.store).some((r: { kind: string }) => r.kind === "hookInvocation"),
      JSON.stringify(rowsOf(sHook.store).map((r: { kind: string }) => r.kind)),
    );
    check(
      "两段正文各归各行、没有把上一段重复写进新段",
      assistantRows(sHook.store).filter((r: { text?: string }) => r.text === REPLY).length === 2,
      JSON.stringify(assistantRows(sHook.store).map((r: { text?: string }) => r.text)),
    );
    check(
      "钩子事件没有制造帧装配故障",
      rigHook.faults.length === 0,
      JSON.stringify(rigHook.faults),
    );
    rigHook.dispose();

    // 9.2 UserPromptSubmit 返回 continue:false → 这一轮不开跑，如实收成失败并写出原因。
    writeFileSync(
      path.join(hookHome, ".zcode", "cli", "config.json"),
      JSON.stringify(
        {
          hooks: {
            enabled: true,
            events: {
              UserPromptSubmit: [
                { hooks: [{ type: "command", command: `echo '{"continue":false,"stopReason":"这条被钩子拦下了"}'` }] },
              ],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    requestLog = [];
    const rigBlocked = makeRig(mock.url, undefined, makeHookFactory());
    const sBlocked = await openSession(rigBlocked);
    await sendTurn(rigBlocked, sBlocked.store, sBlocked.sessionId, "会被钩子拦下的一句").ack;
    await waitFor(
      () => settle(sBlocked.store),
      "被钩子拦下的一轮没有落到终态",
      8000,
      describe(rigBlocked, sBlocked.store),
    );
    check(
      "UserPromptSubmit 阻止提交：phase=error + 原因可读（不是静默丢弃）",
      sBlocked.store.getState().snapshot?.control.phase === "error" &&
        (sBlocked.store.getState().snapshot?.control.lastError?.message ?? "").includes("被钩子拦下"),
      JSON.stringify(sBlocked.store.getState().snapshot?.control.lastError),
    );
    check(
      "被拦下的一轮没有发出模型请求（拦在入口，不是拦在回答后）",
      requestLog.length === 0,
      `requests=${requestLog.length}`,
    );
    rigBlocked.dispose();
    delete (globalThis as { zcodeExec?: unknown }).zcodeExec;
    rmSync(hookBase, { recursive: true, force: true });

    // ── 判据 10：执行模式 / 访问调节（0.7.2，用户点名"完全访问/自主模式/变更前确认 功能无效"）──
    // 10.1 提交带的模式意图真的落进会话配置，并且模型看得见（系统提示里带执行模式）。
    mockMode = "stream";
    requestLog = [];
    const rigMode = makeRig(mock.url);
    const sMode = await openSession(rigMode);
    const yoloTurn = createCommandEnvelope({
      type: "sendText",
      sessionId: sMode.sessionId,
      payload: { text: "随便改，不用问", mode: "yolo" },
    });
    await rigMode.transport.sendCommand(yoloTurn);
    await waitFor(() => settle(sMode.store), "yolo 这一轮没有落到终态", 8000, describe(rigMode, sMode.store));
    check(
      "mode=yolo 落进会话配置（工具栏当前值有地方可读）",
      sMode.store.getState().snapshot?.config.mode === "yolo",
      String(sMode.store.getState().snapshot?.config.mode),
    );
    check(
      "系统提示写进了 FULL ACCESS（模型知道这轮不用请示）",
      String((requestLog[0]?.body as { messages?: Array<{ content?: string }> })?.messages?.[0]?.content ?? "").includes(
        "FULL ACCESS",
      ),
      JSON.stringify((requestLog[0]?.body as { messages?: unknown })?.messages?.[0]).slice(0, 200),
    );
    const planTurn = createCommandEnvelope({
      type: "sendText",
      sessionId: sMode.sessionId,
      payload: { text: "先给我计划", mode: "build", planEnabled: true },
    });
    await rigMode.transport.sendCommand(planTurn);
    await waitFor(() => settle(sMode.store), "计划这一轮没有落到终态", 8000, describe(rigMode, sMode.store));
    check(
      "planEnabled=true 也识别成计划模式（与 UI 的 resolveExecutionState 同判据）",
      sMode.store.getState().snapshot?.config.planEnabled === true &&
        String((requestLog[1]?.body as { messages?: Array<{ content?: string }> })?.messages?.[0]?.content ?? "").includes(
          "Execution mode: PLAN",
        ),
      JSON.stringify(requestLog[1]?.body).slice(0, 300),
    );
    const switchAck = (await rigMode.transport.sendCommand(
      createCommandEnvelope({
        type: "switchCollaborationMode",
        sessionId: sMode.sessionId,
        payload: { mode: "edit" },
        baseRevision: sMode.store.getState().snapshot?.revision ?? 0,
      }),
    )) as { status: string };
    check("switchCollaborationMode 被 accepted（协议命令接上了）", switchAck.status === "accepted", JSON.stringify(switchAck));
    await waitFor(
      () => sMode.store.getState().snapshot?.config.mode === "edit",
      "会话级模式切换没有生效",
      4000,
      describe(rigMode, sMode.store),
    );
    check("会话级切换真的改了 config.mode", sMode.store.getState().snapshot?.config.mode === "edit");
    rigMode.dispose();

    // 10.2 工具面：注入一台假引擎（approvalRequired = Bash/Delete），验三档模式行为真不同。
    mockMode = "stream";
    const makeFakeEngine = () => {
      const calls: string[] = [];
      return {
        calls,
        engine: {
          tools: [
            { name: "Write", description: "写文件", inputSchema: { type: "object", properties: {} } },
            { name: "Edit", description: "编辑文件", inputSchema: { type: "object", properties: {} } },
            { name: "Delete", description: "删文件", inputSchema: { type: "object", properties: {} } },
            { name: "Bash", description: "跑命令", inputSchema: { type: "object", properties: {} } },
          ],
          approvalRequired: (name: string) => name === "Bash" || name === "Delete",
          execute: async (call: { name: string }) => {
            calls.push(call.name);
            return { content: `${call.name} 完成`, isError: false };
          },
          grantRoot: () => {},
          revokeRoot: () => {},
        },
      };
    };

    // sessions-index 必须随审批挂起/解除同步投影交互摘要，但不能夹带工具参数或弹窗 payload。
    const approvalIndexEngine = makeFakeEngine();
    mockToolCall = { name: "Bash", arguments: '{"command":"echo secret-command"}' };
    toolCallSent = false;
    const rigApprovalIndex = makeRig(mock.url, undefined, undefined, async () => approvalIndexEngine.engine);
    const sApprovalIndex = await openSession(rigApprovalIndex);
    const indexService = rigApprovalIndex.service as unknown as {
      onDynamicSessionsIndexFrame(): (listener: (wire: { frame?: { payload?: {
        kind?: string;
        snapshot?: { sessions?: Array<Record<string, unknown>> };
        deltas?: Array<{ op: string; session?: Record<string, unknown> }>;
      } } }) => void) => { dispose(): void };
      subscribeSessionsIndexV4(params: { workspacePath: string }): Promise<unknown>;
    };
    const approvalIndexFrames: Array<Record<string, unknown>> = [];
    const offApprovalIndex = indexService.onDynamicSessionsIndexFrame()((wire) => {
      const payload = wire.frame?.payload;
      if (payload?.kind === "snapshot") {
        for (const summary of payload.snapshot?.sessions ?? []) approvalIndexFrames.push(summary);
      } else {
        for (const delta of payload?.deltas ?? []) {
          if (delta.op === "session.upserted" && delta.session) approvalIndexFrames.push(delta.session);
        }
      }
    });
    await indexService.subscribeSessionsIndexV4({ workspacePath: "/work/smoke" });
    await rigApprovalIndex.transport.sendCommand(createCommandEnvelope({
      type: "sendText", sessionId: sApprovalIndex.sessionId,
      payload: { text: "审批等待状态", mode: "build" },
    }));
    await waitFor(
      () => approvalIndexFrames.some(summary => summary.sessionId === sApprovalIndex.sessionId &&
        (summary.pendingInteractionSummary as { permissionCount?: number } | undefined)?.permissionCount === 1),
      "审批等待时 sessions-index 未发布权限摘要", 8000,
      () => ({ frames: approvalIndexFrames, pending: sApprovalIndex.store.getState().snapshot?.pendingInteractions }),
    );
    const waitingSummary = approvalIndexFrames.findLast(summary => summary.sessionId === sApprovalIndex.sessionId &&
      (summary.pendingInteractionSummary as { permissionCount?: number } | undefined)?.permissionCount === 1);
    check("真实 sessions-index 订阅在审批出现时发布权限计数且不含敏感 payload",
      (waitingSummary?.pendingInteractionSummary as { permissionCount?: number } | undefined)?.permissionCount === 1 &&
      (waitingSummary?.pendingInteraction as { kind?: string } | undefined)?.kind === "permission" &&
      !JSON.stringify(waitingSummary).includes("secret-command") &&
      !("detail" in (waitingSummary?.pendingInteraction as Record<string, unknown> ?? {})) &&
      !("toolName" in (waitingSummary?.pendingInteraction as Record<string, unknown> ?? {})),
      JSON.stringify(waitingSummary));
    const approvalIndexInteraction = sApprovalIndex.store.getState().snapshot?.pendingInteractions[0];
    await rigApprovalIndex.transport.sendCommand(createCommandEnvelope({
      type: "resolveInteraction", sessionId: sApprovalIndex.sessionId,
      payload: { interactionId: approvalIndexInteraction?.interactionId, answer: { optionId: "allow_once" } },
    }));
    await waitFor(() => settle(sApprovalIndex.store) &&
      approvalIndexFrames.some(summary => summary.sessionId === sApprovalIndex.sessionId &&
        (summary.pendingInteractionSummary as { permissionCount?: number } | undefined)?.permissionCount === 0 &&
        summary.phase === "completedSuccess"),
    "审批处理后 sessions-index 权限计数没有清零", 10000,
    () => ({ frames: approvalIndexFrames, phase: sApprovalIndex.store.getState().snapshot?.control.phase }));
    check("审批处理后真实 sessions-index 摘要清零并收口非运行态",
      approvalIndexFrames.some(summary => summary.sessionId === sApprovalIndex.sessionId &&
        (summary.pendingInteractionSummary as { permissionCount?: number } | undefined)?.permissionCount === 0 &&
        summary.phase === "completedSuccess") && approvalIndexEngine.calls.includes("Bash"));
    offApprovalIndex.dispose();
    mockToolCall = null;
    rigApprovalIndex.dispose();

    // 计划模式：Write 不执行（拦在入口），理由回给模型。
    requestLog = [];
    const fakePlan = makeFakeEngine();
    mockToolCall = { name: "Write", arguments: '{"file_path":"/work/x.txt","content":"hi"}' };
    toolCallSent = false;
    const rigPlan = makeRig(mock.url, undefined, undefined, async () => fakePlan.engine);
    const sPlan = await openSession(rigPlan);
    await rigPlan.transport.sendCommand(
      createCommandEnvelope({
        type: "sendText",
        sessionId: sPlan.sessionId,
        payload: { text: "帮我把文件改了", mode: "plan" },
      }),
    );
    await waitFor(() => settle(sPlan.store), "计划模式这一轮没有落到终态", 10000, describe(rigPlan, sPlan.store));
    check(
      "计划模式：写类工具一次都没执行（拦在入口，不是执行失败）",
      !fakePlan.calls.includes("Write"),
      JSON.stringify(fakePlan.calls),
    );
    check(
      "计划模式：工具行留在时间线上标记为 cancelled（用户看得见被拦）",
      rowsOf(sPlan.store).some((r: { kind: string; status?: string }) => r.kind === "toolCall" && r.status === "cancelled"),
      JSON.stringify(rowsOf(sPlan.store).map((r: { kind: string; status?: string }) => `${r.kind}:${r.status ?? ""}`)),
    );
    check(
      "计划模式：模型的下一步请求里收到'先出计划'的理由",
      String(JSON.stringify((requestLog[1]?.body as { messages?: unknown })?.messages ?? [])).includes("计划模式"),
      JSON.stringify((requestLog[1]?.body as { messages?: unknown })?.messages ?? []).slice(0, 300),
    );
    // 计划模式下的 Bash：不在拦截集里（要能查），但必须走审批——不静默跑命令。
    mockToolCall = { name: "Bash", arguments: '{"command":"ls /work"}' };
    toolCallSent = false;
    await rigPlan.transport.sendCommand(
      createCommandEnvelope({
        type: "sendText",
        sessionId: sPlan.sessionId,
        payload: { text: "看看目录", mode: "plan" },
      }),
    );
    await waitFor(
      () => (sPlan.store.getState().snapshot?.pendingInteractions.length ?? 0) > 0,
      "计划模式下 Bash 没有走审批",
      8000,
      describe(rigPlan, sPlan.store),
    );
    const planBashId = sPlan.store.getState().snapshot?.pendingInteractions[0]?.interactionId ?? "";
    check("计划模式：Bash 仍走审批闸（能查目录，但不静默跑命令）", planBashId !== "", planBashId);
    await rigPlan.transport.sendCommand(
      createCommandEnvelope({
        type: "resolveInteraction",
        sessionId: sPlan.sessionId,
        payload: { interactionId: planBashId, answer: { optionId: "allow_once" } },
      }),
    );
    await waitFor(() => settle(sPlan.store), "计划模式 Bash 那一轮没有落到终态", 10000, describe(rigPlan, sPlan.store));
    check(
      "计划模式：审批通过后命令执行了（闸门是审批，不是硬禁）",
      fakePlan.calls.includes("Bash"),
      JSON.stringify(fakePlan.calls),
    );
    mockToolCall = null;
    rigPlan.dispose();

    // Skills/Agent 穿过真实主轮、模型往返、子工具 Hook、结果回收。
    requestLog = [];
    const childCalls: string[] = [];
    const childHooks: string[] = [];
    const childEngine = {
      tools: [{ name: "Read", description: "read", parameters: { type: "object", properties: {} } }],
      approvalRequired: () => false,
      execute: async (call: { name: string }) => { childCalls.push(call.name); return { content: "ACTUAL_CHILD_READ", isError: false }; },
      grantRoot: () => {}, revokeRoot: () => {},
    };
    const skill = { id: "skill-1", name: "audit", description: "audit", body: "AUDIT_SKILL_INSTRUCTIONS", path: "/work/smoke/.zcode/skills/audit/SKILL.md", scope: "workspace", enabled: true };
    const profile = { id: "agent-1", name: "general-purpose", description: "child", systemPrompt: "ACTUAL_CHILD_PROFILE", path: "builtin:general-purpose", scope: "built-in", source: "built-in", enabled: true, tools: ["Read"] };
    const capabilityServices = {
      skillsService: { list: async () => ({ skills: [skill], diagnostics: [] }) },
      subagentsService: { list: async () => ({ agents: [profile], diagnostics: [] }) },
    };
    const childHookFactory = async () => ({ enabled: true, diagnostics: [], run: async (event: string, input: { toolName?: string }) => {
      if (input.toolName) childHooks.push(`${event}:${input.toolName}`);
      return {};
    } });
    mockToolQueue = [
      { name: "Agent", arguments: '{"prompt":"Inspect"}' },
      { name: "Read", arguments: '{"file_path":"a.txt"}' },
    ];
    const childSessionStore = makeMemorySessionStore();
    const rigChild = makeRig(mock.url, childSessionStore, childHookFactory, async () => childEngine, { capabilities: capabilityServices });
    const sChild = await openSession(rigChild);
    await rigChild.transport.sendCommand(createCommandEnvelope({ type: "sendText", sessionId: sChild.sessionId,
      payload: { text: "请按 $audit 检查", mode: "build" } }));
    await waitFor(() => settle(sChild.store), "子代理主轮没有落到终态", 10000, describe(rigChild, sChild.store));
    check("Skills 被发现并注入主轮", JSON.stringify(requestLog[0]?.body).includes("AUDIT_SKILL_INSTRUCTIONS"));
    check("主模型实际收到 Agent 和 Skill 工具", JSON.stringify(requestLog[0]?.body).includes('"name":"Agent"') && JSON.stringify(requestLog[0]?.body).includes('"name":"Skill"'));
    check("子代理工具进入同一 Hook 与引擎", childCalls.includes("Read") && childHooks.includes("PreToolUse:Read") && childHooks.includes("PostToolUse:Read"), JSON.stringify({ childCalls, childHooks }));
    check("子代理收到真实工具结果", requestLog.some(req => JSON.stringify(req.body).includes("ACTUAL_CHILD_READ")));
    // 子代理回包是一段 JSON 字符串，进请求体时会被二次转义（\"agentType\"），所以不能拿
    // 未转义的字面量去搜整段 body——那样搜不到不代表没送到。改成顺着 messages 找父轮的
    // tool 消息，再看它的 content 里有没有子代理的真实结果字段。
    const parentSawSubagentResult = requestLog.some(req => {
      const messages = (req.body as { messages?: Array<{ role?: string; content?: unknown }> })?.messages;
      if (!Array.isArray(messages)) return false;
      return messages.some(m => m?.role === "tool" && typeof m.content === "string"
        && m.content.includes("agentType") && m.content.includes("general-purpose")
        && m.content.includes("completed"));
    });
    check("主轮收到子代理实际结果", parentSawSubagentResult,
      JSON.stringify(requestLog.map(r => (r.body as { messages?: Array<{ role?: string; content?: unknown }> })?.messages)).slice(0, 3000));
    const subagentRow = rowsOf(sChild.store).find((row: { kind: string }) => row.kind === "subagent") as
      | { childSessionId?: string; status?: string }
      | undefined;
    const childSessionId = subagentRow?.childSessionId;
    check("Agent 结果行关联真实 childSessionId 并收口成功",
      Boolean(childSessionId) && subagentRow?.status === "success", JSON.stringify(subagentRow));
    const childStore = childSessionId ? await openExistingSession(rigChild, childSessionId) : null;
    const childRows = childStore?.getState().snapshot?.rows.window ?? [];
    check("子会话 conversation snapshot 可读用户提示、回答与工具结果",
      childRows.some((row: { kind: string; text?: string }) => row.kind === "userInput" && row.text === "Inspect") &&
      childRows.some((row: { kind: string; text?: string }) => row.kind === "assistantText" && Boolean(row.text)) &&
      childRows.some((row: { kind: string; toolName?: string; status?: string; output?: { text?: string } }) =>
        row.kind === "toolCall" && row.toolName === "Read" && row.status === "success" && row.output?.text === "ACTUAL_CHILD_READ"),
      JSON.stringify(childRows.map((row: { kind: string; toolName?: string; status?: string }) => ({ kind: row.kind, toolName: row.toolName, status: row.status }))));
    if (childStore && childSessionId) {
      await childStore.close();
      const resubscribedChild = await openExistingSession(rigChild, childSessionId);
      check("同一 childSessionId 重订阅后仍能读取子会话行",
        (resubscribedChild.getState().snapshot?.rows.window.length ?? 0) >= childRows.length);
      await resubscribedChild.close();
      const childAgent = rigChild.service as unknown as {
        subscribeConversationV4(params: { workspacePath: string; sessionId: string }): Promise<unknown>;
      };
      let workspaceRejected = false;
      try {
        await childAgent.subscribeConversationV4({ workspacePath: "/work/other", sessionId: childSessionId });
      } catch (error) {
        workspaceRejected = String(error).includes("workspaceMismatch");
      }
      check("childSessionId 不能从其他工作区订阅", workspaceRejected);
      rigChild.dispose();
      const rigChildRestart = makeRig(mock.url, childSessionStore);
      const recoveredChild = await openExistingSession(rigChildRestart, childSessionId);
      const recoveredRows = recoveredChild.getState().snapshot?.rows.window ?? [];
      check("重启后 childSessionId 恢复用户、回答和工具历史",
        recoveredRows.some((row: { kind: string; text?: string }) => row.kind === "userInput" && row.text === "Inspect") &&
        recoveredRows.some((row: { kind: string; toolName?: string; status?: string; output?: { text?: string } }) =>
          row.kind === "toolCall" && row.toolName === "Read" && row.status === "success" && row.output?.text === "ACTUAL_CHILD_READ"),
        JSON.stringify(recoveredRows.map((row: { kind: string; toolName?: string; status?: string }) => ({ kind: row.kind, toolName: row.toolName, status: row.status }))));
      await recoveredChild.close();
      rigChildRestart.dispose();
    } else {
      rigChild.dispose();
    }

    // 子代理写入与主 Agent 共用同一执行模式、审批选项和目标记忆。
    const approvalChildCalls: string[] = [];
    const approvalChildEngine = {
      tools: [{ name: "Write", description: "write", inputSchema: { type: "object", properties: {} } }],
      approvalRequired: () => false,
      execute: async (call: { name: string; arguments: string }) => {
        approvalChildCalls.push(call.arguments);
        return { content: "CHILD_WRITE_OK", isError: false };
      },
      grantRoot: () => {}, revokeRoot: () => {},
    };
    const approvalChildProfile = { ...profile, tools: ["Write"] };
    const approvalChildCapabilities = {
      skillsService: capabilityServices.skillsService,
      subagentsService: { list: async () => ({ skills: [], agents: [approvalChildProfile], diagnostics: [] }) },
    };
    const rigApprovalChild = makeRig(mock.url, undefined, childHookFactory, async () => approvalChildEngine,
      { capabilities: approvalChildCapabilities });
    const sApprovalChild = await openSession(rigApprovalChild);
    const sendChildWrite = async (args: string, index: number) => {
      mockToolQueue = [
        { name: "Agent", arguments: '{"prompt":"write a file"}' },
        { name: "Write", arguments: args },
      ];
      await rigApprovalChild.transport.sendCommand(createCommandEnvelope({
        type: "sendText", sessionId: sApprovalChild.sessionId,
        payload: { text: `child write ${index}`, mode: "build" },
      }));
    };
    await sendChildWrite('{"file_path":"/work/child.txt","content":"first"}', 1);
    await waitFor(() => (sApprovalChild.store.getState().snapshot?.pendingInteractions.length ?? 0) > 0,
      "子代理的 build Write 没有弹审批", 10000, describe(rigApprovalChild, sApprovalChild.store));
    let childInteraction = sApprovalChild.store.getState().snapshot?.pendingInteractions[0];
    check("子代理：build Write 进入与主 Agent 相同的审批弹窗", Boolean(childInteraction));
    await rigApprovalChild.transport.sendCommand(createCommandEnvelope({
      type: "resolveInteraction", sessionId: sApprovalChild.sessionId,
      payload: { interactionId: childInteraction?.interactionId, answer: { optionId: "allow_always" } },
    }));
    await waitFor(() => settle(sApprovalChild.store), "子代理 allow_always 后没有收口", 10000, describe(rigApprovalChild, sApprovalChild.store));
    check("子代理：始终允许确实执行了 Write", approvalChildCalls.length === 1);
    await sendChildWrite('{"file_path":"/work/child.txt","content":"second"}', 2);
    await waitFor(() => settle(sApprovalChild.store) && approvalChildCalls.length === 2,
      "子代理同目标始终允许没有放行", 10000, describe(rigApprovalChild, sApprovalChild.store));
    check("子代理：始终允许按目标生效", approvalChildCalls.length === 2 &&
      (sApprovalChild.store.getState().snapshot?.pendingInteractions.length ?? -1) === 0);
    await sendChildWrite('{"file_path":"/work/other-child.txt","content":"third"}', 3);
    await waitFor(() => (sApprovalChild.store.getState().snapshot?.pendingInteractions.length ?? 0) > 0,
      "子代理 allow_always 错误放行了另一个目标", 10000, describe(rigApprovalChild, sApprovalChild.store));
    childInteraction = sApprovalChild.store.getState().snapshot?.pendingInteractions[0];
    await rigApprovalChild.transport.sendCommand(createCommandEnvelope({
      type: "resolveInteraction", sessionId: sApprovalChild.sessionId,
      payload: { interactionId: childInteraction?.interactionId, answer: { optionId: "deny" } },
    }));
    await waitFor(() => settle(sApprovalChild.store), "子代理拒绝后没有收口", 10000, describe(rigApprovalChild, sApprovalChild.store));
    check("子代理：拒绝不执行另一目标", approvalChildCalls.length === 2);
    mockToolQueue = [];
    rigApprovalChild.dispose();

    // 变更前确认（build）：Delete 要弹审批；拒绝后不执行。
    requestLog = [];
    const fakeBuild = makeFakeEngine();
    mockToolCall = { name: "Delete", arguments: '{"path":"/work/old.txt","recursive":false}' };
    toolCallSent = false;
    const rigBuild = makeRig(mock.url, undefined, undefined, async () => fakeBuild.engine);
    const sBuild = await openSession(rigBuild);
    await rigBuild.transport.sendCommand(
      createCommandEnvelope({
        type: "sendText",
        sessionId: sBuild.sessionId,
        payload: { text: "删掉旧文件", mode: "build" },
      }),
    );
    await waitFor(
      () => (sBuild.store.getState().snapshot?.pendingInteractions.length ?? 0) > 0,
      "变更前确认模式没有弹出审批",
      8000,
      describe(rigBuild, sBuild.store),
    );
    const pendingId = sBuild.store.getState().snapshot?.pendingInteractions[0]?.interactionId ?? "";
    check("变更前确认：Delete 弹出了审批交互", pendingId !== "", pendingId);
    await rigBuild.transport.sendCommand(
      createCommandEnvelope({
        type: "resolveInteraction",
        sessionId: sBuild.sessionId,
        payload: { interactionId: pendingId, answer: { optionId: "deny" } },
      }),
    );
    await waitFor(() => settle(sBuild.store), "拒绝审批后这一轮没有落到终态", 10000, describe(rigBuild, sBuild.store));
    check(
      "变更前确认：拒绝之后 Delete 没有执行（审批是真闸门）",
      !fakeBuild.calls.includes("Delete"),
      JSON.stringify(fakeBuild.calls),
    );
    for (const [name, args, optionId] of [
      ["Write", '{"file_path":"/work/new.txt","content":"new"}', "allow_once"],
      ["Edit", '{"file_path":"/work/edit.txt","old_string":"old","new_string":"new"}', "allow_always"],
    ] as const) {
      mockToolCall = { name, arguments: args };
      toolCallSent = false;
      await rigBuild.transport.sendCommand(createCommandEnvelope({
        type: "sendText", sessionId: sBuild.sessionId,
        payload: { text: `${name} should ask`, mode: "build" },
      }));
      await waitFor(
        () => (sBuild.store.getState().snapshot?.pendingInteractions.length ?? 0) > 0,
        `变更前确认模式下 ${name} 没有弹审批`, 8000, describe(rigBuild, sBuild.store),
      );
      const interaction = sBuild.store.getState().snapshot?.pendingInteractions[0];
      const detail = interaction?.payload.kind === "permission" ? interaction.payload.detail : undefined;
      check(
        `变更前确认：${name} 弹窗带桌面文件预览入参`,
        Boolean(detail && typeof detail === "object" && "file_path" in detail),
        JSON.stringify(detail),
      );
      await rigBuild.transport.sendCommand(createCommandEnvelope({
        type: "resolveInteraction", sessionId: sBuild.sessionId,
        payload: { interactionId: interaction?.interactionId, answer: { optionId } },
      }));
      await waitFor(() => settle(sBuild.store), `${name} 审批后本轮没有收口`, 10000, describe(rigBuild, sBuild.store));
      check(`变更前确认：${name} 选择 ${optionId} 后执行`, fakeBuild.calls.includes(name), JSON.stringify(fakeBuild.calls));
    }
    // allow_always 只记住本工具+目标；同目标放行，新目标必须再问。
    mockToolCall = { name: "Edit", arguments: '{"file_path":"/work/edit.txt","old_string":"old","new_string":"new"}' };
    toolCallSent = false;
    await rigBuild.transport.sendCommand(createCommandEnvelope({
      type: "sendText", sessionId: sBuild.sessionId, payload: { text: "same edit", mode: "build" },
    }));
    await waitFor(() => settle(sBuild.store), "始终允许的同目标 Edit 没有收口", 10000, describe(rigBuild, sBuild.store));
    check("始终允许仅放行同一工具与目标", fakeBuild.calls.filter((name) => name === "Edit").length === 2 &&
      (sBuild.store.getState().snapshot?.pendingInteractions.length ?? -1) === 0);
    mockToolCall = { name: "Edit", arguments: '{"file_path":"/work/other.txt","old_string":"old","new_string":"new"}' };
    toolCallSent = false;
    await rigBuild.transport.sendCommand(createCommandEnvelope({
      type: "sendText", sessionId: sBuild.sessionId, payload: { text: "different edit", mode: "build" },
    }));
    await waitFor(() => (sBuild.store.getState().snapshot?.pendingInteractions.length ?? 0) > 0,
      "始终允许错误地覆盖了另一个 Edit 目标", 8000, describe(rigBuild, sBuild.store));
    const otherEdit = sBuild.store.getState().snapshot?.pendingInteractions[0];
    await rigBuild.transport.sendCommand(createCommandEnvelope({
      type: "resolveInteraction", sessionId: sBuild.sessionId,
      payload: { interactionId: otherEdit?.interactionId, answer: { optionId: "deny" } },
    }));
    await waitFor(() => settle(sBuild.store), "拒绝其他目标的 Edit 后没有收口", 10000, describe(rigBuild, sBuild.store));
    check("始终允许不会放行其他目标", fakeBuild.calls.filter((name) => name === "Edit").length === 2);
    mockToolCall = null;
    rigBuild.dispose();

    // 完全访问（yolo）：Delete 不问直接执行。
    requestLog = [];
    const fakeYolo = makeFakeEngine();
    mockToolCall = { name: "Delete", arguments: '{"path":"/work/old.txt","recursive":false}' };
    toolCallSent = false;
    const rigYolo = makeRig(mock.url, undefined, undefined, async () => fakeYolo.engine);
    const sYolo = await openSession(rigYolo);
    await rigYolo.transport.sendCommand(
      createCommandEnvelope({
        type: "sendText",
        sessionId: sYolo.sessionId,
        payload: { text: "删掉旧文件", mode: "yolo" },
      }),
    );
    await waitFor(() => settle(sYolo.store), "完全访问这一轮没有落到终态", 10000, describe(rigYolo, sYolo.store));
    check(
      "完全访问：Delete 直接执行（没有弹审批）",
      fakeYolo.calls.includes("Delete") &&
        (sYolo.store.getState().snapshot?.pendingInteractions.length ?? -1) === 0,
      `calls=${JSON.stringify(fakeYolo.calls)} pending=${JSON.stringify(sYolo.store.getState().snapshot?.pendingInteractions)}`,
    );
    mockToolCall = null;
    rigYolo.dispose();

    // 自动编辑（edit）：文件类不问、命令仍问——Delete 直接执行（与 build 的差别就在这一档）。
    requestLog = [];
    const fakeEdit = makeFakeEngine();
    mockToolCall = { name: "Delete", arguments: '{"path":"/work/old.txt","recursive":false}' };
    toolCallSent = false;
    const rigEdit = makeRig(mock.url, undefined, undefined, async () => fakeEdit.engine);
    const sEdit = await openSession(rigEdit);
    await rigEdit.transport.sendCommand(
      createCommandEnvelope({
        type: "sendText",
        sessionId: sEdit.sessionId,
        payload: { text: "删掉旧文件", mode: "edit" },
      }),
    );
    await waitFor(() => settle(sEdit.store), "自动编辑这一轮没有落到终态", 10000, describe(rigEdit, sEdit.store));
    check(
      "自动编辑：Delete 不问直接执行（与'变更前确认'的差别可测）",
      fakeEdit.calls.includes("Delete") &&
        (sEdit.store.getState().snapshot?.pendingInteractions.length ?? -1) === 0,
      `calls=${JSON.stringify(fakeEdit.calls)}`,
    );
    mockToolCall = { name: "Write", arguments: '{"file_path":"/work/auto.txt","content":"ok"}' };
    toolCallSent = false;
    await rigEdit.transport.sendCommand(createCommandEnvelope({
      type: "sendText", sessionId: sEdit.sessionId, payload: { text: "write in edit mode", mode: "edit" },
    }));
    await waitFor(() => settle(sEdit.store), "自动编辑 Write 没有收口", 10000, describe(rigEdit, sEdit.store));
    check("自动编辑：Write 直接执行", fakeEdit.calls.includes("Write") &&
      (sEdit.store.getState().snapshot?.pendingInteractions.length ?? -1) === 0);
    mockToolCall = { name: "Bash", arguments: '{"command":"echo ask"}' };
    toolCallSent = false;
    await rigEdit.transport.sendCommand(createCommandEnvelope({
      type: "sendText", sessionId: sEdit.sessionId, payload: { text: "bash in edit mode", mode: "edit" },
    }));
    await waitFor(() => (sEdit.store.getState().snapshot?.pendingInteractions.length ?? 0) > 0,
      "自动编辑模式 Bash 没有弹审批", 8000, describe(rigEdit, sEdit.store));
    const editBash = sEdit.store.getState().snapshot?.pendingInteractions[0];
    check("自动编辑：Bash 仍需审批", Boolean(editBash));
    await rigEdit.transport.sendCommand(createCommandEnvelope({
      type: "resolveInteraction", sessionId: sEdit.sessionId,
      payload: { interactionId: editBash?.interactionId, answer: { optionId: "allow_once" } },
    }));
    await waitFor(() => settle(sEdit.store), "自动编辑 Bash 审批后没有收口", 10000, describe(rigEdit, sEdit.store));
    check("允许一次：Bash 通过后实际执行", fakeEdit.calls.includes("Bash"));
    // 同一轮在 PreToolUse 等待期间切到 yolo，执行闸必须读取最新会话模式，而非开轮快照。
    let enteredPreToolUse!: () => void;
    let releasePreToolUse!: () => void;
    const preToolUseEntered = new Promise<void>((resolve) => { enteredPreToolUse = resolve; });
    const preToolUseGate = new Promise<void>((resolve) => { releasePreToolUse = resolve; });
    const rigSwitch = makeRig(mock.url, undefined, async () => ({
      enabled: true, diagnostics: [],
      run: async (event: string) => {
        if (event === "PreToolUse") { enteredPreToolUse(); await preToolUseGate; }
        return {};
      },
    }), async () => fakeEdit.engine);
    const sSwitch = await openSession(rigSwitch);
    mockToolCall = { name: "Write", arguments: '{"file_path":"/work/switched.txt","content":"ok"}' };
    toolCallSent = false;
    await rigSwitch.transport.sendCommand(createCommandEnvelope({
      type: "sendText", sessionId: sSwitch.sessionId, payload: { text: "switch while running", mode: "build" },
    }));
    await preToolUseEntered;
    await rigSwitch.transport.sendCommand(createCommandEnvelope({
      type: "switchCollaborationMode", sessionId: sSwitch.sessionId,
      baseRevision: sSwitch.store.getState().snapshot?.revision ?? 0,
      payload: { mode: "yolo" },
    }));
    releasePreToolUse();
    await waitFor(() => settle(sSwitch.store), "运行中切模式后的 Write 没有收口", 10000, describe(rigSwitch, sSwitch.store));
    check("运行中切换到完全访问立即影响后续审批判定", fakeEdit.calls.filter((name) => name === "Write").length === 2 &&
      (sSwitch.store.getState().snapshot?.pendingInteractions.length ?? -1) === 0);
    mockToolCall = null;
    rigSwitch.dispose();
    // 已弹出的审批也必须随模式切换收口，不能只影响下一次工具调用。
    const fakePending = makeFakeEngine();
    const rigPending = makeRig(mock.url, undefined, undefined, async () => fakePending.engine);
    const sPending = await openSession(rigPending);
    mockToolCall = { name: "Write", arguments: '{"file_path":"/work/pending.txt","content":"ok"}' };
    toolCallSent = false;
    await rigPending.transport.sendCommand(createCommandEnvelope({
      type: "sendText", sessionId: sPending.sessionId, payload: { text: "switch pending approval", mode: "build" },
    }));
    await waitFor(() => (sPending.store.getState().snapshot?.pendingInteractions.length ?? 0) === 1,
      "未进入待审批状态", 10000, describe(rigPending, sPending.store));
    await rigPending.transport.sendCommand(createCommandEnvelope({
      type: "switchCollaborationMode", sessionId: sPending.sessionId,
      baseRevision: sPending.store.getState().snapshot?.revision ?? 0, payload: { mode: "yolo" },
    }));
    await waitFor(() => settle(sPending.store), "切换完全访问未解除已挂起审批", 10000, describe(rigPending, sPending.store));
    check("完全访问兑现已挂起审批，无需再点允许", fakePending.calls.includes("Write") &&
      sPending.store.getState().snapshot?.pendingInteractions.length === 0);
    mockToolCall = { name: "Write", arguments: '{"file_path":"/work/pending.txt","content":"ok"}' };
    toolCallSent = false;
    await rigPending.transport.sendCommand(createCommandEnvelope({type:"sendText",sessionId:sPending.sessionId,
      payload:{text:"切回确认模式后相同目标也必须审批",mode:"build"}}));
    await waitFor(()=> (sPending.store.getState().snapshot?.pendingInteractions.length ?? 0) === 1,
      "模式自动放行错误写入了始终允许记忆",10000,describe(rigPending,sPending.store));
    const tightenedPermission = sPending.store.getState().snapshot?.pendingInteractions[0];
    await rigPending.transport.sendCommand(createCommandEnvelope({type:"resolveInteraction",sessionId:sPending.sessionId,
      payload:{interactionId:tightenedPermission?.interactionId,answer:{optionId:"deny"}}}));
    await waitFor(()=>settle(sPending.store),"拒绝后没有收口",10000,describe(rigPending,sPending.store));
    check("模式自动放行不污染始终允许记忆，切回确认模式再次审批",fakePending.calls.length === 1);
    rigPending.dispose();
    // 用户复现：切换后才到达的新调用仍弹审批。第一步只读正在执行时切模式，
    // 随后的新Write/Bash来自下一次模型请求，全程不再发送用户消息。
    const fakeFuture = makeFakeEngine();
    let startedRead!: () => void;
    let releaseRead!: () => void;
    const readStarted = new Promise<void>(resolve => { startedRead = resolve; });
    const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
    const rigFuture = makeRig(mock.url, undefined, undefined, async () => ({
      ...fakeFuture.engine,
      tools: [...fakeFuture.engine.tools, { name: "Read", description: "read", inputSchema: { type: "object", properties: {} } }],
      execute: async (call: { name: string }) => {
        if (call.name === "Read") { startedRead(); await readGate; }
        return fakeFuture.engine.execute(call);
      },
    }));
    const sFuture = await openSession(rigFuture);
    mockToolCall = null;
    mockToolQueue = [
      {name:"Read", arguments:'{"file_path":"/work/a.txt"}'},
      {name:"Write", arguments:'{"file_path":"/work/b.txt","content":"ok"}'},
      {name:"Bash", arguments:'{"command":"echo no-approval"}'},
    ];
    await rigFuture.transport.sendCommand(createCommandEnvelope({type:"sendText", sessionId:sFuture.sessionId,
      payload:{text:"先读再写和运行命令",mode:"build"}}));
    await readStarted;
    await rigFuture.transport.sendCommand(createCommandEnvelope({type:"switchCollaborationMode",sessionId:sFuture.sessionId,
      baseRevision:sFuture.store.getState().snapshot?.revision ?? 0,payload:{mode:"yolo"}}));
    releaseRead();
    await waitFor(()=>settle(sFuture.store),"切换后新工具调用仍在等待审批",10000,describe(rigFuture,sFuture.store));
    check("切换完全访问后新到达的Write和Bash直接执行，不依赖再次发送消息",
      fakeFuture.calls.join(",") === "Read,Write,Bash" && sFuture.store.getState().snapshot?.pendingInteractions.length === 0,
      JSON.stringify(fakeFuture.calls));
    rigFuture.dispose();
    mockToolCall = null;
    rigEdit.dispose();

    // ── 判据 11：思考流单独成行（0.7.3，用户点名"思考和执行过程没跟桌面一样分开显示，
    // 全部输出为回复"）。mock 先发 reasoning_content 三段再发正文——
    // 判据：时间线有独立 reasoning 行（text=思考全文、state=complete、带 durationMs），
    // 且正文行**不含**任何思考文字（混在一起＝这条必红）。──
    mockMode = "reason";
    requestLog = [];
    const rigReason = makeRig(mock.url);
    const sReason = await openSession(rigReason);
    await sendTurn(rigReason, sReason.store, sReason.sessionId, "想想再说").ack;
    await waitFor(() => settle(sReason.store), "带思考的这一轮没有落到终态", 8000, describe(rigReason, sReason.store));
    const reasoningRows = rowsOf(sReason.store).filter((r: { kind: string }) => r.kind === "reasoning");
    check(
      "时间线有独立 reasoning 行（不是并进正文）",
      reasoningRows.length === 1 && (reasoningRows[0] as { text?: string }).text === "让我先想想这道题",
      JSON.stringify(reasoningRows.map((r: { kind: string }) => r.kind)),
    );
    check(
      "思考行收口成 complete 且带 durationMs（折叠卡有'深度思考 · Ns'的原料）",
      reasoningRows.length === 1 &&
        (reasoningRows[0] as { state?: string }).state === "complete" &&
        typeof (reasoningRows[0] as { durationMs?: number }).durationMs === "number",
      JSON.stringify(reasoningRows[0]),
    );
    check(
      "正文行不含思考文字（思考/正文两条流，互不混入）",
      assistantRows(sReason.store).some((r: { text?: string }) => r.text === REPLY) &&
        assistantRows(sReason.store).every(
          (r: { text?: string }) => !(r.text ?? "").includes("让我") && !(r.text ?? "").includes("先想想"),
        ),
      JSON.stringify(assistantRows(sReason.store).map((r: { text?: string }) => r.text)),
    );
    check(
      "思考行投影没制造帧装配故障（schema 全过）",
      rigReason.faults.length === 0,
      JSON.stringify(rigReason.faults),
    );
    rigReason.dispose();
    mockMode = "stream";

    // ── 判据 12：插话不失忆（0.7.4 症状①）──
    // 被打断的半截正文必须进**下一轮**发给模型的 messages。旧行为：正文只走 row.delta，
    // session.rows 的行内 text 永远停在开轮预建的空串，historyMessages 跳过它 → 下一轮
    // 模型看不见自己上一轮说到哪儿，"完全忘记做到一半的工作重新开始"。
    mockMode = "slow";
    requestLog = [];
    const rigP = makeRig(mock.url);
    const sP = await openSession(rigP);
    await sendTurn(rigP, sP.store, sP.sessionId, "慢慢说第一句").ack;
    await waitFor(
      () => assistantRows(sP.store).some((r: { text?: string }) => (r.text ?? "").length > 0),
      "停止前没有拿到任何增量",
    );
    const stopA = (await rigP.transport.sendCommand(
      createCommandEnvelope({ type: "stop", sessionId: sP.sessionId, payload: {} }),
    )) as { status: string };
    check("插前：停止被 accepted", stopA.status === "accepted", JSON.stringify(stopA));
    await waitFor(() => settle(sP.store), "被打断的这一轮没有落到终态", 8000, describe(rigP, sP.store));
    requestLog = [];
    const contA = sendTurn(rigP, sP.store, sP.sessionId, "接着上一句说");
    await contA.ack;
    await waitFor(() => settle(sP.store) && userRows(sP.store).length >= 2, "第二句没有跑完");
    {
      const secondBody = requestLog[0]?.body as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const msgs = secondBody?.messages ?? [];
      const partialKept = msgs.some(
        (m) => m.role === "assistant" && (m.content ?? "").startsWith("慢"),
      );
      check(
        "打断后下一轮 messages 含半截 assistant 正文（插话不失忆，症状①判据 a）",
        partialKept,
        JSON.stringify(msgs.map((m) => `${m.role}:${(m.content ?? "").slice(0, 12)}`)),
      );
      const noEmptyAssistant = msgs.every(
        (m) => !(m.role === "assistant" && (m.content ?? "") === ""),
      );
      check(
        "下一轮历史里没有空气泡 assistant（半截正文真的落了账）",
        noEmptyAssistant,
        JSON.stringify(msgs.map((m) => `${m.role}:${(m.content ?? "").length}`)),
      );
    }
    rigP.dispose();
    mockMode = "stream";

    // ── 判据 13：/compact 前缀 + compact 命令（0.7.4 症状②手动路径）──
    // keepRecentRows=1 让两三句历史就够出压缩边界（判据只看接线，不看摘要质量）。
    const SUMMARY_TEXT = "【压缩摘要】前两轮工作已归档";
    compactionSummaryText = SUMMARY_TEXT;
    const rigC = makeRig(mock.url, undefined, undefined, undefined, { compactKeepRecentRows: 1 });
    const sC = await openSession(rigC);
    for (const t of ["历史甲一句", "历史乙一句"]) {
      const r = sendTurn(rigC, sC.store, sC.sessionId, t);
      await r.ack;
      await waitFor(() => settle(sC.store) && userRows(sC.store).length >= (t === "历史甲一句" ? 1 : 2), `「${t}」没跑完`);
    }
    check(
      "空闲时 availability.compact 开着（入口不再是假按钮）",
      sC.store.getState().snapshot?.availability.compact.allowed === true,
      JSON.stringify(sC.store.getState().snapshot?.availability.compact),
    );
    requestLog = [];
    const slash = sendTurn(rigC, sC.store, sC.sessionId, "/compact");
    const slashAck = (await slash.ack) as { status: string };
    check("sendText '/compact' 被 accepted", slashAck.status === "accepted", JSON.stringify(slashAck));
    await waitFor(
      () =>
        rowsOf(sC.store).some(
          (r: { kind: string; marker?: { type?: string; status?: string } }) =>
            r.kind === "timelineMarker" && r.marker?.type === "compact" && r.marker?.status === "success",
        ),
      "压缩的 marker 系统行没有落成 success",
      8000,
      describe(rigC, sC.store),
    );
    check(
      "时间线落了 timelineMarker(compact) 系统行（协议里的'已压缩上下文'行）",
      rowsOf(sC.store).some(
        (r: { kind: string; marker?: { type?: string } }) =>
          r.kind === "timelineMarker" && r.marker?.type === "compact",
      ),
      JSON.stringify(rowsOf(sC.store).map((r: { kind: string }) => r.kind)),
    );
    check(
      "压缩请求真的发给当前模型（mock 认出 context-compaction 指令）",
      requestLog.some((r) => JSON.stringify(r.body).includes("context-compaction engine")),
      JSON.stringify(requestLog.map((r) => r.path)),
    );
    check(
      "/compact 的乐观气泡退场（userInput 行带回 commandId，输入没被吞）",
      sC.store.getState().optimisticCommands.length === 0 &&
        userRows(sC.store).some((r: { text?: string }) => r.text === "/compact"),
      JSON.stringify(sC.store.getState().optimisticCommands),
    );
    requestLog = [];
    const afterC = sendTurn(rigC, sC.store, sC.sessionId, "压缩后继续说");
    await afterC.ack;
    await waitFor(() => settle(sC.store) && userRows(sC.store).length >= 4, "压缩后这一轮没跑完");
    {
      const body = requestLog[0]?.body as { messages?: Array<{ role?: string; content?: string }> };
      const msgs = body?.messages ?? [];
      const text = JSON.stringify(msgs);
      check(
        "压缩后下一轮 messages 含摘要文本（摘要替换 transcript 前部）",
        text.includes(SUMMARY_TEXT),
        text.slice(0, 400),
      );
      check(
        "压缩后早期原文不再逐字送模型（被摘要顶替）",
        !text.includes("历史甲一句"),
        text.slice(0, 400),
      );
    }
    // v4 compact 维护命令（UI 的 context usage 面板入口）同一路由
    const cmdAck = (await rigC.transport.sendCommand(
      createCommandEnvelope({ type: "compact", sessionId: sC.sessionId, payload: {} }),
    )) as { status: string };
    check(
      "compact 维护命令被 accepted（不再是 P0 rejected）",
      cmdAck.status === "accepted",
      JSON.stringify(cmdAck),
    );
    compactionSummaryText = null;
    rigC.dispose();

    // ── 判据 14：自动压缩接上（0.7.4 症状②自动路径）──
    // 注入极小阈值（50 token 估算）：三四句短对话就逼出开轮前自动压缩；缺省 60k 的判据
    // 由代码走同一条 runCompact，这里只测接线与收场。
    compactionSummaryText = "【自动压缩摘要】更早的来回已归档";
    const rigAuto = makeRig(mock.url, undefined, undefined, undefined, {
      compactTriggerTokens: 10,
      compactKeepRecentRows: 1,
    });
    const sAuto = await openSession(rigAuto);
    let autoFired = false;
    for (const t of ["自动压第一句", "自动压第二句", "自动压第三句", "自动压第四句"]) {
      const r = sendTurn(rigAuto, sAuto.store, sAuto.sessionId, t);
      await r.ack;
      await waitFor(() => settle(sAuto.store), `「${t}」没跑完`, 8000, describe(rigAuto, sAuto.store));
      if (
        rowsOf(sAuto.store).some(
          (row: { kind: string; marker?: { type?: string; origin?: string } }) =>
            row.kind === "timelineMarker" &&
            row.marker?.type === "compact" &&
            row.marker?.origin === "auto" &&
            row.marker?.status === "success",
        )
      ) {
        autoFired = true;
        break;
      }
    }
    check(
      "超过估算阈值自动压缩（开轮前压成摘要 + marker 落 success）",
      autoFired,
      JSON.stringify(rowsOf(sAuto.store).map((row: { kind: string }) => row.kind)),
    );
    rigAuto.dispose();
    compactionSummaryText = null;

    // ── 判据 17：早期历史装不下时分段摘要，不丢历史（0.8.4）──
    // 桌面端在摘要请求装不下时是把更早的轮次**丢掉**再重试（compact-selection.ts 的
    // selectCompactEntriesAfterPromptTooLong）——那等于悄悄丢历史。端侧改成分段摘要：
    // 装不下就分几段，前一段的摘要带进后一段，整段早期历史都被摘要覆盖。
    // 这里注入极小的单段预算（compactPassInputTokens），确定性地逼出"分段"这条路径。
    check(
      "分段切分按整轮切、单轮超预算也不被丢掉（纯函数口径）",
      JSON.stringify(planCompactPasses([100, 100, 900], 250)) ===
        JSON.stringify([{ start: 0, end: 2 }, { start: 2, end: 3 }]) &&
        planCompactPass([100, 100, 900], 250) === 2,
      JSON.stringify(planCompactPasses([100, 100, 900], 250)),
    );
    compactionSummaryText = "【压缩摘要·第{n}段】";
    compactionRequestCount = 0;
    const chunkBody = "正文".repeat(500); // 单轮完整正文约 1000 汉字，仍能与摘要指令一起装入单段预算
    const rigChunk = makeRig(mock.url, undefined, undefined, undefined, {
      compactEnabled: false,       // 只测手动压缩这一条路，别让自动压缩插进来搅乱计数
      compactKeepRecentRows: 2,    // 保留最近一轮（两行）
      compactPassInputTokens: 2000, // 单段预算压小 → 早期段必然分段
    });
    const sChunk = await openSession(rigChunk);
    const chunkTexts = ["早期第一轮", "早期第二轮", "早期第三轮", "早期第四轮"];
    for (const t of chunkTexts) {
      const r = sendTurn(rigChunk, sChunk.store, sChunk.sessionId, t + chunkBody);
      await r.ack;
      await waitFor(() => settle(sChunk.store), `「${t}」没跑完`, 8000, describe(rigChunk, sChunk.store));
    }
    requestLog = [];
    const chunkSlash = sendTurn(rigChunk, sChunk.store, sChunk.sessionId, "/compact");
    await chunkSlash.ack;
    await waitFor(
      () =>
        rowsOf(sChunk.store).some(
          (r: { kind: string; marker?: { type?: string; status?: string } }) =>
            r.kind === "timelineMarker" && r.marker?.type === "compact" && r.marker?.status === "success",
        ),
      "分段摘要的 marker 没有落成 success",
      8000,
      describe(rigChunk, sChunk.store),
    );
    const chunkRequests = requestLog.filter((r) => JSON.stringify(r.body).includes("context-compaction engine"));
    check(
      "早期段装不下时分成多段摘要（不是一次塞不下就失败）",
      chunkRequests.length >= 2,
      `压缩请求数=${chunkRequests.length}`,
    );
    check(
      "前一段的摘要带进了后一段（分段摘要是滚动的，不是各段独立）",
      chunkRequests.length >= 2 &&
        JSON.stringify(chunkRequests[1]!.body).includes("【压缩摘要·第1段】"),
      JSON.stringify(chunkRequests[1]?.body).slice(0, 300),
    );
    check(
      "最早那段原文进了第一段摘要请求（历史没有被丢掉）",
      chunkRequests.length >= 1 && JSON.stringify(chunkRequests[0]!.body).includes("早期第一轮"),
      JSON.stringify(chunkRequests[0]?.body).slice(0, 300),
    );
    check(
      "早期段最后一段的原文进了最后一段摘要请求（整段早期历史都被摘要覆盖）",
      chunkRequests.length >= 2 &&
        JSON.stringify(chunkRequests[chunkRequests.length - 1]!.body).includes("早期第三轮"),
      `压缩请求数=${chunkRequests.length}`,
    );
    requestLog = [];
    const afterChunk = sendTurn(rigChunk, sChunk.store, sChunk.sessionId, "压缩后再说一句");
    await afterChunk.ack;
    await waitFor(() => settle(sChunk.store), "分段压缩后这一轮没跑完");
    {
      const body = requestLog[0]?.body as { messages?: Array<{ role?: string; content?: string }> };
      const text = JSON.stringify(body?.messages ?? []);
      check(
        "分段摘要的最终摘要顶上了历史前部",
        text.includes(`【压缩摘要·第${chunkRequests.length}段】`),
        text.slice(0, 300),
      );
      check(
        "被摘要的早期原文不再逐字送模型",
        !text.includes("早期第一轮"),
        text.slice(0, 300),
      );
    }
    // 摘要流被模型输出上限截断时，旧摘要与未覆盖原文必须继续生效。
    const failedBefore = rowsOf(sChunk.store).filter((row: any) => row.kind === "timelineMarker" && row.marker?.status === "failed").length;
    compactionFinishReason = "length";
    await sendTurn(rigChunk, sChunk.store, sChunk.sessionId, "/compact").ack;
    await waitFor(() => rowsOf(sChunk.store).filter((row: any) => row.kind === "timelineMarker" && row.marker?.status === "failed").length > failedBefore &&
      sChunk.store.getState().snapshot?.availability.compact.allowed === true, "被截断的摘要没有失败收口");
    compactionFinishReason = "stop";
    requestLog = [];
    await sendTurn(rigChunk, sChunk.store, sChunk.sessionId, "摘要失败后继续").ack;
    await waitFor(() => settle(sChunk.store) && requestLog.length > 0, "摘要失败后未能继续使用旧上下文");
    const afterFailedSummary = JSON.stringify(requestLog[0]?.body);
    check("截断摘要失败后旧摘要仍生效", afterFailedSummary.includes(`【压缩摘要·第${chunkRequests.length}段】`));
    check("截断摘要失败不推进原文覆盖水位", afterFailedSummary.includes("早期第四轮"));
    compactionSummaryText = null;
    rigChunk.dispose();

    // ── 判据 18：自动压缩连续失败后熔断（0.8.4）──
    // 摘要请求连着失败就是连着失败：再自动压一次也是同样的结果，只会每轮白烧一次
    // 全文请求（桌面端 compact/policy.ts 的 MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES 同口径）。
    // 端侧连败 3 次就停掉自动压缩，并把这件事告诉用户。
    compactionFails = true;
    compactionSummaryText = null;
    const rigFuse = makeRig(mock.url, undefined, undefined, undefined, {
      compactTriggerTokens: 10,
      compactKeepRecentRows: 1,
    });
    const sFuse = await openSession(rigFuse);
    requestLog = [];
    for (let i = 1; i <= 6; i++) {
      const r = sendTurn(rigFuse, sFuse.store, sFuse.sessionId, `熔断第${i}句`);
      await r.ack;
      await waitFor(() => settle(sFuse.store), `第 ${i} 句没跑完`, 8000, describe(rigFuse, sFuse.store));
    }
    const fuseCompactRequests = requestLog.filter((r) => JSON.stringify(r.body).includes("context-compaction engine"));
    check(
      "自动压缩连败 3 次后不再重试（每轮白烧全文请求的止损）",
      fuseCompactRequests.length === 3,
      `压缩请求数=${fuseCompactRequests.length}`,
    );
    check(
      "自动压缩熔断时如实告诉用户（不静默放弃）",
      rigFuse.diagnostics.some((d: string) => d.includes("自动压缩已连续失败")),
      JSON.stringify(rigFuse.diagnostics.slice(-4)),
    );
    compactionFails = false;
    rigFuse.dispose();

    // ── 判据 15：没有模型窗口配置时不再按固定条数丢弃历史 ──
    // 关闭压缩并累积 22 轮，最后一次请求应能看到全部用户与助手消息；时间线展示与模型历史一致。
    const rigFallback = makeRig(mock.url, undefined, undefined, undefined, { compactEnabled: false });
    const sFB = await openSession(rigFallback);
    const NB_TURNS = 22;
    let fullHistorySeen = false;
    for (let i = 1; i <= NB_TURNS; i++) {
      const r = sendTurn(rigFallback, sFB.store, sFB.sessionId, `兜底第${i}句`);
      await r.ack;
      await waitFor(() => settle(sFB.store) && userRows(sFB.store).length >= i, `第 ${i} 句没跑完`);
      const lastBody = requestLog[requestLog.length - 1]?.body as
        | { messages?: Array<{ role?: string; content?: string }> }
        | undefined;
      const msgs = lastBody?.messages ?? [];
      if (i === NB_TURNS) {
        const history = msgs.slice(1);
        fullHistorySeen = history.filter((m) => m.role === "user").length === NB_TURNS &&
          history.filter((m) => m.role === "assistant").length === NB_TURNS - 1 &&
          !history.some((m) => (m.content ?? "").includes("早期历史已省略"));
        check("无 contextWindow 时完整历史不受固定消息条数限制", fullHistorySeen, `messages=${msgs.length}`);
      }
    }
    if (!fullHistorySeen) check("无固定历史条数限制（未触发）", false, `turns=${NB_TURNS} 没有观察到完整历史`);
    rigFallback.dispose();
    mockMode = "stream";

    // ── 判据 16：翻页读历史行的纪元字段（0.7.4 症状④展示层回放）──
    // store.loadOlder 按 atLogEpoch === 本地 snapshot.logEpoch 整页校验；缺字段 = 每页被
    // 整体丢弃 = "更早的历史翻不出来"。直接打服务面验返回形状（时间线行本身全量保留已由
    // 判据 6 的重启回放覆盖，SNAPSHOT_WINDOW_ROWS 只管尾窗不管展示集）。
    {
      const rigD = makeRig(mock.url);
      const sD = await openSession(rigD);
      const turnD = sendTurn(rigD, sD.store, sD.sessionId, "翻页用的一句");
      await turnD.ack;
      await waitFor(() => settle(sD.store), "这一轮没跑完");
      const rangeResult = (await (rigD.service as Record<string, (...a: unknown[]) => Promise<unknown>>)[
        "conversationRowsRangeV4"
      ].call(rigD.service, {
        workspacePath: "/work/smoke",
        sessionId: sD.sessionId,
        limit: 200,
      })) as { rows: unknown[]; hasMore: boolean; atLogEpoch?: string; atSeq?: number; atRevision?: number };
      const snap = sD.store.getState().snapshot;
      check(
        "rowsRange 返回带 atLogEpoch/atSeq/atRevision（loadOlder 不再整页丢弃，症状④）",
        typeof rangeResult.atLogEpoch === "string" &&
          rangeResult.atLogEpoch === snap?.logEpoch &&
          typeof rangeResult.atSeq === "number" &&
          typeof rangeResult.atRevision === "number",
      JSON.stringify(rangeResult).slice(0, 200),
      );
      check(
        "rowsRange 全量可读：时间线行都翻得回来（压缩只动历史取用，不动展示集）",
        rangeResult.rows.length === (snap?.rows.totalCount ?? -1) && rangeResult.hasMore === false,
        `range=${rangeResult.rows.length} total=${snap?.rows.totalCount}`,
      );
      rigD.dispose();
    }
  } catch (e) {
    results.push({ name: "自检本身跑完了", ok: false, detail: String((e as Error)?.stack ?? e) });
  } finally {
    mock.close();
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    process.stdout.write(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  → ${r.detail}`}\n`);
  }
  process.stdout.write(`\n端侧对话自检：${results.length - failed.length}/${results.length} PASS\n`);
  // 投影层的乐观输入看门狗是长定时器，不主动收场这个进程会一直挂着（自检要能被 CI 等）。
  process.exit(failed.length > 0 ? 1 : 0);
}

void main();
