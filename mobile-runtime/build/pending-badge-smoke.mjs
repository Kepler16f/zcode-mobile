// 侧栏「等待确认」标识的生命周期：挂起时必须出现，确认后必须消失。
// 这里驱动真实的移动端 Agent：模型发一个需要审批的工具调用 → 端侧立一条 pendingInteraction →
// 用户点「允许」→ 端侧必须再投一帧没有 pendingInteraction 的会话摘要。
// 判据落在**端侧发布的 sessions-index 帧**上：UI 的侧栏标识就是从这份摘要投影出来的。
import assert from "node:assert/strict";
import path from "node:path";
import { unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"));
const esbuild = require("esbuild");
const out = path.join(root, "mobile-runtime/build", `.tmp-pending-badge-${process.pid}.mjs`);
await esbuild.build({
  stdin: {
    contents: `export {createMobileAgentService} from "${root.replaceAll("\\", "/")}/mobile-runtime/ui/agent.ts";\nexport {createCommandEnvelope,getV4ClientId} from "${root.replaceAll("\\", "/")}/zcode/packages/ui/src/v4/commandFactory.ts";`,
    resolveDir: path.join(root, "mobile-runtime/ui"),
  },
  outfile: out, bundle: true, format: "esm", platform: "node", target: "node24",
  jsx: "automatic", logLevel: "warning",
  alias: { "@": path.join(root, "zcode/packages/ui/src") },
  nodePaths: ["web", "ui", "client", "services", "shared"].map((p) => path.join(root, "zcode/packages", p, "node_modules")).concat(path.join(root, "zcode/node_modules")),
});
const { createMobileAgentService, createCommandEnvelope, getV4ClientId } = await import(pathToFileURL(out).href);

const records = new Map();
const store = {
  save: (entry) => records.set(entry.sessionId, structuredClone({ ...entry, updatedAt: Date.now() })),
  load: (id) => records.get(id) ?? null,
  listSummaries: () => [...records.values()],
  listAllStates: () => [...records.values()],
  engine: () => "test-memory",
};

const sse = (delta, reason = "stop") =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`;
let step = 0;
const oldFetch = globalThis.fetch;
globalThis.fetch = async () => {
  step++;
  if (step === 1) {
    return new Response(sse({ tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "Bash", arguments: JSON.stringify({ command: "echo hi" }) } }] }, "tool_calls"), { headers: { "content-type": "text/event-stream" } });
  }
  return new Response(sse({ content: "DONE" }), { headers: { "content-type": "text/event-stream" } });
};

const summaries = [];
const agent = createMobileAgentService({
  sessionStore: store,
  modelTargets: {
    view: async () => ({
      providers: [{ providerId: "test", models: [{ modelId: "mock", config: { properties: { contextWindow: 32000 } } }], config: { api: { type: "openai-chat-completions", baseUrl: "https://test.invalid/v1" }, access: { type: "personal-api-key", apiKey: "test" } } }],
      preferredSelection: { providerId: "test", modelId: "mock" },
    }),
  },
  toolEngine: async () => ({
    tools: [{ name: "Bash", description: "run", parameters: { type: "object", properties: {} } }],
    approvalRequired: () => true,
    execute: async () => ({ isError: false, content: "ran" }),
    grantRoot() {}, revokeRoot() {},
  }),
});

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: Boolean(ok), detail });
const wait = async (predicate, message, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((r) => setTimeout(r, 20));
  }
};

try {
  const hello = await agent.helloConversationV4();
  await agent.initializeConversationV4({ kind: "clientHello", protocolVersion: hello.protocolVersion, clientId: getV4ClientId(), clientKind: "mobileApp", appVersion: "test" });
  const send = (type, sessionId, payload) =>
    agent.sendConversationCommandV4({ workspacePath: "/work/test", envelope: createCommandEnvelope({ type, sessionId, payload }) });
  const created = await send("createSession", null, { workspaceId: "test" });
  const sessionId = created.result.sessionId;

  // 订阅 sessions-index：UI 的侧栏标识就是从这份摘要投影出来的。
  const subscription = await agent.subscribeSessionsIndexV4({ workspacePath: "/work/test" });
  // onDynamic* 是 RPC 事件面：先取事件，再订阅（上游同一形状）。
  const sessionsIndexEvent = agent.onDynamicSessionsIndexFrame();
  sessionsIndexEvent((frame) => {
    // 端侧投的是**线格式**帧：小帧是 kind=complete，逻辑帧在 frame 里。
    const logical = frame?.kind === "complete" ? frame.frame : null;
    const payload = logical?.payload;
    if (payload?.kind === "deltas") {
      for (const delta of payload.deltas) if (delta.op === "session.upserted") summaries.push(delta.session);
    } else if (payload?.kind === "snapshot") {
      for (const session of payload.snapshot.sessions ?? []) summaries.push(session);
    }
  });

  await send("sendText", sessionId, { text: "跑一个需要审批的命令" });
  await wait(() => summaries.some((s) => s.pendingInteraction), "端侧没有投出带 pendingInteraction 的会话摘要");
  const pendingSummary = summaries.find((s) => s.pendingInteraction);
  check("挂起审批时摘要带 pendingInteraction", Boolean(pendingSummary?.pendingInteraction));
  check("挂起审批时摘要带 pendingInteractionSummary", (pendingSummary?.pendingInteractionSummary?.permissionCount ?? 0) > 0, JSON.stringify(pendingSummary?.pendingInteractionSummary));

  const interactionId = pendingSummary.pendingInteraction.interactionId;
  const ack = await send("resolveInteraction", sessionId, { interactionId, answer: { optionId: "allow_once" } });
  check("确认命令被受理", ack.status === "accepted", JSON.stringify(ack));
  await wait(() => summaries.length > 0 && !summaries[summaries.length - 1].pendingInteraction, "确认后端侧没有投出清除 pendingInteraction 的摘要");
  const after = summaries[summaries.length - 1];
  check("确认后摘要不再带 pendingInteraction", !after.pendingInteraction, JSON.stringify(after.pendingInteraction));
  check("确认后摘要的待确认计数归零", (after.pendingInteractionSummary?.permissionCount ?? 0) === 0 && (after.pendingInteractionSummary?.userInputCount ?? 0) === 0, JSON.stringify(after.pendingInteractionSummary));
  // 这一轮要在确认之后继续跑完（工具执行 → 模型回复 → 收口），收口是异步的：等它，不催它。
  await wait(
    () => records.get(sessionId)?.state.phase === "completedSuccess",
    "确认后这一轮没有收口",
    8000,
  );
  check("确认后这一轮收口", records.get(sessionId)?.state.phase === "completedSuccess", records.get(sessionId)?.state.phase);

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : `  → ${r.detail}`}`);
  console.log(`\n待确认标识冒烟：${results.length - failed.length}/${results.length} PASS`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  globalThis.fetch = oldFetch;
  agent.disposeAll();
  unlinkSync(out);
}
