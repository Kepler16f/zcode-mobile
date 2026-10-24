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

import { createMobileAgentService } from "../ui/agent.js";
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
let toolCallSent = false;
/** cutOnce 模式的"只砍第一次"开关：第一次请求发两片就掐线（复刻切后台连接被杀），
 *  之后的请求按正常流走——自动续写的新请求必须能拿到完整回复。 */
let cutOnceArmed = false;
/** cutMany 模式：前 CUT_MANY 次请求各发两片就掐线，之后正常——旧版 MAX_CONTINUATIONS=3
 *  会在第 3 次续写后放弃、整轮带"截断标注"收口；0.7.0 去上限后应一路续到成功。 */
let cutManyRemaining = 0;
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
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        if (mockMode === "businessError") {
          send({ success: false, providerCode: 50001, message: "套餐额度不足，请换一个模型" });
          send("[DONE]");
          res.end();
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
        if (mockToolCall && !toolCallSent) {
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
                      function: { name: mockToolCall.name, arguments: mockToolCall.arguments },
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
) {
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
              models: [{ modelId: "mock-model" }],
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
      listed.plugins.some((p) => p.id === "browser-use@zcode-plugins-official" && p.enabled === true),
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
