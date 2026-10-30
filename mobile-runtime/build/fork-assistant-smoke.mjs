// 会话分叉（forkAssistant）的端侧回归。
//
// 覆盖 spec（mobile-runtime/specs/fork-assistant.md）里的四条：
//   ① 合法分叉产出独立子会话（forkNotice + 复制到边界行的历史 + 父会话多一条 forkCreated）；
//   ② 父会话不受影响；
//   ③ guard 拒绝路径（assistant-only / 目标不稳定 / 压缩锁）；
//   ④ 子会话可继续对话并落盘；同一 commandId 重复分叉回到同一个子会话。
import assert from "node:assert/strict";
import path from "node:path";
import { unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const esbuild = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"))("esbuild");
const out = path.join(root, "mobile-runtime/build", `.tmp-fork-${process.pid}.mjs`);
await esbuild.build({
  stdin: {
    contents: `export {createMobileAgentService} from "${root.replaceAll("\\", "/")}/mobile-runtime/ui/agent.ts";
export {createCommandEnvelope,getV4ClientId} from "${root.replaceAll("\\", "/")}/zcode/packages/ui/src/v4/commandFactory.ts";`,
    resolveDir: path.join(root, "mobile-runtime/ui"),
  },
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  jsx: "automatic",
  logLevel: "warning",
  alias: { "@": path.join(root, "zcode/packages/ui/src") },
  nodePaths: ["web", "ui", "client", "services", "shared"]
    .map((p) => path.join(root, "zcode/packages", p, "node_modules"))
    .concat(path.join(root, "zcode/node_modules")),
});

const { createMobileAgentService, createCommandEnvelope, getV4ClientId } = await import(pathToFileURL(out).href);

const records = new Map();
const store = {
  save(entry) {
    records.set(entry.sessionId, structuredClone({ ...entry, updatedAt: Date.now() }));
  },
  load(id) {
    return records.get(id) ?? null;
  },
  listSummaries(workspacePath) {
    return [...records.values()].filter((x) => x.workspacePath === workspacePath);
  },
  listAllStates() {
    return [...records.values()];
  },
  engine() {
    return "test-memory";
  },
};

const sse = (delta, reason = "stop") =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`;
const oldFetch = globalThis.fetch;
let holdStream = false;
let streamController;
globalThis.fetch = async () => {
  if (holdStream) {
    holdStream = false;
    return new Response(
      new ReadableStream({
        start(c) {
          streamController = c;
          c.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "HELD" }, finish_reason: null }] })}\n\n`,
            ),
          );
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  }
  return new Response(sse({ content: "Done." }), { headers: { "content-type": "text/event-stream" } });
};

const agent = createMobileAgentService({
  sessionStore: store,
  modelTargets: {
    view: async () => ({
      providers: [
        {
          providerId: "test",
          models: [{ modelId: "mock", config: { properties: { contextWindow: 32000 } } }],
          config: {
            api: { type: "openai-chat-completions", baseUrl: "https://test.invalid/v1" },
            access: { type: "personal-api-key", apiKey: "test" },
          },
        },
      ],
      preferredSelection: { providerId: "test", modelId: "mock" },
    }),
  },
  toolEngine: async () => ({
    tools: [],
    approvalRequired: () => false,
    execute: async () => ({ isError: false, content: "" }),
    grantRoot() {},
    revokeRoot() {},
  }),
});

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
};
async function wait(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((r) => setTimeout(r, 20));
  }
}

try {
  const hello = await agent.helloConversationV4();
  await agent.initializeConversationV4({
    kind: "clientHello",
    protocolVersion: hello.protocolVersion,
    clientId: getV4ClientId(),
    clientKind: "mobileApp",
    appVersion: "test",
  });
  const send = (type, sessionId, payload, extra = {}) =>
    agent.sendConversationCommandV4({
      workspacePath: "/work/test",
      envelope: createCommandEnvelope({ type, sessionId, payload, ...extra }),
    });

  const created = await send("createSession", null, { workspaceId: "test" });
  const sessionId = created.result.sessionId;
  await send("sendText", sessionId, { text: "第一句" });
  await wait(() => records.get(sessionId)?.state.phase === "completedSuccess", "第一轮未收轮");

  const parentRows = records.get(sessionId).state.rows;
  const assistant = parentRows.find((row) => row.kind === "assistantText");
  check("完成的助手回复带 canFork", assistant?.actions?.canFork === true, JSON.stringify(assistant?.actions));

  const subscribed = await agent.subscribeConversationV4({ workspacePath: "/work/test", sessionId });
  const logEpoch = subscribed.ack.logEpoch;
  const revision = () => records.get(sessionId)?.state.revision ?? 0;

  // ① 合法分叉
  const forkEnvelope = createCommandEnvelope({
    type: "forkAssistant",
    sessionId,
    payload: { target: { rowId: assistant.rowId, entityId: assistant.entityId } },
    baseRevision: revision(),
    baseLogEpoch: logEpoch,
  });
  const ack = await agent.sendConversationCommandV4({ workspacePath: "/work/test", envelope: forkEnvelope });
  check("合法分叉被接受", ack.status === "accepted", JSON.stringify(ack));
  check("回执带子会话 id", ack.result?.type === "forkAssistant" && typeof ack.result.sessionId === "string");
  const childId = ack.result.sessionId;

  const child = records.get(childId);
  check("子会话已落盘", Boolean(child), String(childId));
  const notice = child.state.rows.find((row) => row.marker?.type === "forkNotice");
  check("子会话首部有 forkNotice", Boolean(notice) && notice.rowId === 1, JSON.stringify(child.state.rows[0]?.marker));
  check("forkNotice 指向父会话与父行号", notice?.marker?.parentSessionId === sessionId && notice?.marker?.parentRowId === assistant.rowId);
  const copiedAssistant = child.state.rows.find((row) => row.kind === "assistantText");
  check("子会话复制了边界行的正文", copiedAssistant?.text === assistant.text, JSON.stringify(copiedAssistant?.text));
  check("子会话重新编号行号", copiedAssistant?.rowId !== assistant.rowId, String(copiedAssistant?.rowId));
  check(
    "子会话保留更早的历史",
    child.state.rows.some((row) => row.kind === "userInput" && row.text === "第一句"),
  );

  // ② 父会话不受影响
  const afterRows = records.get(sessionId).state.rows;
  const created2 = afterRows.find((row) => row.marker?.type === "forkCreated");
  check("父会话多出一条 forkCreated", Boolean(created2) && created2.marker.childSessionId === childId);
  const parentAssistant = afterRows.find((row) => row.kind === "assistantText");
  check("父会话行号与正文不变", parentAssistant.rowId === assistant.rowId && parentAssistant.text === assistant.text);
  check("父会话没有多出历史", afterRows.filter((row) => row.kind === "userInput").length === 1);

  // ③ 拒绝路径
  const userRow = parentRows.find((row) => row.kind === "userInput");
  const rejectUser = await send(
    "forkAssistant",
    sessionId,
    { target: { rowId: userRow.rowId, entityId: userRow.entityId } },
    { baseRevision: revision(), baseLogEpoch: logEpoch },
  );
  check("用户输入行被拒（assistant-only）", rejectUser.status === "rejected" && rejectUser.reasonCode === "guard.forkAssistantOnly", JSON.stringify(rejectUser));

  const rejectStale = await send(
    "forkAssistant",
    sessionId,
    { target: { rowId: assistant.rowId, entityId: "stale-entity" } },
    { baseRevision: revision(), baseLogEpoch: logEpoch },
  );
  check("陈旧目标被拒（目标不稳定）", rejectStale.status === "rejected" && rejectStale.reasonCode === "guard.forkTargetNotStable", JSON.stringify(rejectStale));

  holdStream = true;
  await send("sendText", sessionId, { text: "还在跑" });
  await wait(() => Boolean(streamController), "流式请求未启动");
  const streaming = records.get(sessionId).state.rows.find((row) => row.kind === "assistantText" && row.state === "streaming");
  const rejectStreaming = await send(
    "forkAssistant",
    sessionId,
    { target: { rowId: streaming.rowId, entityId: streaming.entityId } },
    { baseRevision: revision(), baseLogEpoch: logEpoch },
  );
  check(
    "未完成的助手回复被拒（目标不稳定）",
    rejectStreaming.status === "rejected" && rejectStreaming.reasonCode === "guard.forkTargetNotStable",
    JSON.stringify(rejectStreaming),
  );
  streamController.enqueue(new TextEncoder().encode(sse({ content: " ok" })));
  streamController.close();
  streamController = undefined;
  await wait(() => records.get(sessionId)?.state.phase === "completedSuccess", "收尾轮未收轮");

  // ④ 子会话可继续对话并落盘；重复 commandId 回到同一个子会话
  const childSend = await agent.sendConversationCommandV4({
    workspacePath: "/work/test",
    envelope: createCommandEnvelope({ type: "sendText", sessionId: childId, payload: { text: "继续" } }),
  });
  check("子会话可继续发消息", childSend.status === "accepted", JSON.stringify(childSend));
  await wait(() => records.get(childId)?.state.phase === "completedSuccess", "子会话那一轮未收轮");
  check(
    "子会话的新输入已落盘",
    records.get(childId).state.rows.some((row) => row.kind === "userInput" && row.text === "继续"),
  );

  const duplicate = await agent.sendConversationCommandV4({ workspacePath: "/work/test", envelope: forkEnvelope });
  check("重复 commandId 回到同一个子会话", duplicate.status === "duplicate" && duplicate.result.sessionId === childId, JSON.stringify(duplicate));

  // 重启后子会话仍可还原
  const reopened = createMobileAgentService({ sessionStore: store });
  const reopenedHello = await reopened.helloConversationV4();
  await reopened.initializeConversationV4({
    kind: "clientHello",
    protocolVersion: reopenedHello.protocolVersion,
    clientId: getV4ClientId(),
    clientKind: "mobileApp",
    appVersion: "test",
  });
  const restored = await reopened.readSession({ workspacePath: "/work/test", sessionId: childId });
  check("重启后子会话可还原", Boolean(restored) && restored.session.sessionId === childId);
  reopened.disposeAll();
} finally {
  agent.disposeAll();
  globalThis.fetch = oldFetch;
  unlinkSync(out);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  process.stdout.write(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : `  → ${r.detail}`}\n`);
}
process.stdout.write(`\n会话分叉冒烟：${results.length - failed.length}/${results.length} PASS\n`);
process.exitCode = failed.length > 0 ? 1 : 0;
