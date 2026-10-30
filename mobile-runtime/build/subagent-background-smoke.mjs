// 子代理后台执行与续接回归（0.9.2 桌面对齐）。
//
// 覆盖：父轮不等后台子代理、状态回填父会话、父轮已收口时按停止能取消后台任务、
// 后台子代理的工具调用仍受父轮模式约束、以及续接沿用上一次的 transcript 与子会话。
// 用真实的 Agent 协议入口和真实的模型流夹具；父模型与子模型用系统提示分流，
// 子代理那一路可以被闸门挡住，从而确定性地制造「父轮已收口、子代理还在跑」的窗口。
import assert from "node:assert/strict";
import path from "node:path";
import { unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const esbuild = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"))("esbuild");
const out = path.join(root, "mobile-runtime/build", `.tmp-subagent-bg-${process.pid}.mjs`);
await esbuild.build({
  stdin: {
    contents: `export {createMobileAgentService} from "${root.replaceAll("\\", "/")}/mobile-runtime/ui/agent.ts";\nexport {createCommandEnvelope,getV4ClientId} from "${root.replaceAll("\\", "/")}/zcode/packages/ui/src/v4/commandFactory.ts";`,
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
    .map(p => path.join(root, "zcode/packages", p, "node_modules"))
    .concat(path.join(root, "zcode/node_modules")),
});

const { createMobileAgentService, createCommandEnvelope, getV4ClientId } = await import(pathToFileURL(out).href);

const records = new Map();
const requests = [];
const childRequests = [];
const executed = [];
const store = {
  save(entry) {
    records.set(entry.sessionId, structuredClone({ ...entry, updatedAt: Date.now() }));
  },
  load(id) {
    return records.get(id) ?? null;
  },
  listSummaries(workspacePath) {
    return [...records.values()].filter(x => x.workspacePath === workspacePath);
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

// 闸门：挡住子代理，制造「父轮已收口、子代理还在跑」的窗口；
// abort 必须能把它打断，否则测不出「停止能取消后台子代理」。
let releaseGate = null;
function gate(signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 10_000);
    releaseGate = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

// 父/子模型各自的剧本：tool 表示这一轮发工具调用，text 表示这一轮给正文，
// gate 表示这一轮先被闸门挡住。tool 可以是函数，用来从上一轮的请求里取值
// （续接场景要从父模型的工具结果里取出上一次的 agentId）。
let parentPlan = [];
let childPlan = [];
const oldFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  requests.push(body);
  const system = String(body.messages?.[0]?.content ?? "");
  const isChild = system.includes("CHILD_INSTRUCTIONS");
  if (isChild) childRequests.push(body);
  const plan = isChild ? childPlan : parentPlan;
  const step = plan.shift() ?? { text: isChild ? "CHILD_DONE" : "PARENT_DONE" };
  if (step.gate) await step.gate(init.signal);
  if (step.tool) {
    const tool = typeof step.tool === "function" ? step.tool(body) : step.tool;
    return new Response(
      sse({ tool_calls: [{ index: 0, id: `call-${Math.random().toString(36).slice(2)}`, type: "function", function: tool }] }, "tool_calls"),
      { headers: { "content-type": "text/event-stream" } },
    );
  }
  return new Response(sse({ content: step.text }), { headers: { "content-type": "text/event-stream" } });
};

const agent = createMobileAgentService({
  sessionStore: store,
  capabilities: {
    skillsService: { list: async () => ({ skills: [], diagnostics: [] }) },
    subagentsService: {
      list: async () => ({
        agents: [
          {
            id: "general",
            name: "general-purpose",
            description: "test agent",
            systemPrompt: "CHILD_INSTRUCTIONS",
            scope: "built-in",
            source: "built-in",
            enabled: true,
            tools: ["Read"],
          },
        ],
        diagnostics: [],
      }),
    },
  },
  modelTargets: {
    view: async () => ({
      providers: [
        {
          providerId: "test",
          models: [{ modelId: "mock", config: { properties: { contextWindow: 32000 } } }],
          config: { api: { type: "openai-chat-completions", baseUrl: "https://test.invalid/v1" }, access: { type: "personal-api-key", apiKey: "test" } },
        },
      ],
      preferredSelection: { providerId: "test", modelId: "mock" },
    }),
  },
  toolEngine: async () => ({
    tools: ["Read", "Fetch", "Git"].map(name => ({ name, description: name, parameters: { type: "object", properties: {} } })),
    approvalRequired: () => false,
    execute: async call => {
      executed.push(call);
      return { isError: false, content: "TOOL_RESULT_SENTINEL" };
    },
    grantRoot() {},
    revokeRoot() {},
  }),
});

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: Boolean(ok), detail });

async function wait(predicate, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise(r => setTimeout(r, 20));
  }
}

function subagentRows(sessionId) {
  return records.get(sessionId)?.state.rows.filter(row => row.kind === "subagent") ?? [];
}

const agentTool = args => ({ name: "Agent", arguments: JSON.stringify(args) });

try {
  const hello = await agent.helloConversationV4();
  await agent.initializeConversationV4({
    kind: "clientHello",
    protocolVersion: hello.protocolVersion,
    clientId: getV4ClientId(),
    clientKind: "mobileApp",
    appVersion: "test",
  });
  const send = (type, sessionId, payload) =>
    agent.sendConversationCommandV4({ workspacePath: "/work/test", envelope: createCommandEnvelope({ type, sessionId, payload }) });
  const created = await send("createSession", null, { workspaceId: "test" });
  const sessionId = created.result.sessionId;

  // ── A. 后台调用立即返回，父轮不等子代理 ──
  parentPlan = [{ tool: agentTool({ prompt: "background work", subagent_type: "general-purpose", run_in_background: true }) }];
  childPlan = [{ gate: signal => gate(signal) }, { text: "CHILD_DONE" }];
  const ack = await send("sendText", sessionId, { text: "Delegate in background" });
  assert.equal(ack.status, "accepted");
  await wait(() => records.get(sessionId)?.state.phase === "completedSuccess", "父轮未收轮");
  check("父轮在子代理仍在跑时就已收口（没有等它）", records.get(sessionId).state.phase === "completedSuccess");
  check("父会话插入子代理行且状态为 running", subagentRows(sessionId).at(-1)?.status === "running", JSON.stringify(subagentRows(sessionId).at(-1)?.status));
  check("父模型看到的工具结果是「已在后台启动」", JSON.stringify(requests.at(-1)?.messages).includes("running"));
  // 子代理已经发起第一次模型请求，但被闸门挡住——还没有任何结果产出。
  check("子代理还卡在第一次模型请求上（没有产出结果）", childRequests.length === 1, String(childRequests.length));

  // ── B. 用户停止能取消后台子代理 ──
  const stop = await send("stop", sessionId, {});
  check("父轮已收口时按停止仍被受理（而不是 noop）", stop.status === "accepted", JSON.stringify(stop));
  await wait(() => subagentRows(sessionId).at(-1)?.status === "cancelled", "后台子代理没有被取消", 8000);
  check("后台子代理被取消后回填父会话（cancelled）", subagentRows(sessionId).at(-1)?.status === "cancelled");
  const childRecord = [...records.values()].find(entry => entry.sessionId.startsWith("mobile-subagent-"));
  check("被取消的子会话也落盘了终态", childRecord?.state.phase === "completedInterrupted", childRecord?.state.phase);

  // ── C. 后台子代理正常完成时回填父会话 ──
  parentPlan = [{ tool: agentTool({ prompt: "background work again", subagent_type: "general-purpose", run_in_background: true }) }];
  childPlan = [{ text: "CHILD_DONE" }];
  await send("sendText", sessionId, { text: "Delegate in background again" });
  await wait(() => subagentRows(sessionId).at(-1)?.status === "success", "后台子代理没有回填成功状态", 10000);
  check("后台子代理完成后父会话的行变为 success", subagentRows(sessionId).at(-1)?.status === "success");
  check("子代理跑完了真实模型循环", childRequests.length >= 2, String(childRequests.length));

  // ── D. 后台子代理的工具调用仍受父轮模式约束 ──
  const executedBefore = executed.length;
  parentPlan = [{ tool: agentTool({ prompt: "plan background", subagent_type: "general-purpose", run_in_background: true }) }];
  childPlan = [{ tool: { name: "Fetch", arguments: '{"action":"download","url":"https://test.invalid","path":"a"}' } }, { text: "CHILD_DONE" }];
  await send("sendText", sessionId, { text: "Plan background", mode: "plan", planEnabled: true });
  await wait(
    () => ["success", "failed"].includes(subagentRows(sessionId).at(-1)?.status),
    "计划模式下的后台子代理没有收口",
    10000,
  );
  check("计划模式下后台子代理的写操作被挡住", executed.length === executedBefore, String(executed.length - executedBefore));

  // ── E. 续接：沿用上一次的子会话与 transcript ──
  parentPlan = [
    { tool: agentTool({ prompt: "first task", subagent_type: "general-purpose" }) },
    // 续接的 agentId 从父模型上一轮收到的工具结果里取——和真实模型看到的一样。
    { tool: body => {
      // 工具结果是原样的字符串（不是被再转义过的 JSON），从**最近一条**工具结果里取 agentId——
      // 父会话的历史里还有前几轮子代理的结果，取第一条会续接错对象。
      const toolText = body.messages.filter(m => m.role === "tool").at(-1)?.content ?? "";
      const found = /"agentId":"([^"]+)"/.exec(toolText);
      assert.ok(found, "父模型的工具结果里应有上一次的 agentId");
      return agentTool({ prompt: "second task", resume: found[1] });
    } },
  ];
  childPlan = [{ text: "CHILD_FIRST_ROUND" }, { text: "CHILD_SECOND_ROUND" }];
  const childRequestsBefore = childRequests.length;
  const rowsBefore = subagentRows(sessionId).length;
  await send("sendText", sessionId, { text: "Delegate then resume" });
  // 这一轮会新增两行：第一次调用一行，续接那一轮再一行。
  await wait(() => subagentRows(sessionId).length >= rowsBefore + 2, "续接那轮没有落到父会话", 10000);
  await wait(() => subagentRows(sessionId).at(-1)?.status === "success", "续接的子代理没有完成", 10000);
  const rows = subagentRows(sessionId);
  const firstLink = rows.at(-2);
  const resumeLink = rows.at(-1);
  check("续接沿用同一个子会话", firstLink?.childSessionId === resumeLink?.childSessionId, `${firstLink?.childSessionId} vs ${resumeLink?.childSessionId}`);
  check("续接也成功了", resumeLink?.status === "success");
  const resumedRequest = childRequests[childRequests.length - 1];
  const resumedText = JSON.stringify(resumedRequest?.messages ?? []);
  check("续接的请求带着上一次的 transcript（子代理记得上一次）", resumedText.includes("first task"), resumedText.slice(0, 200));
  check("续接的请求带着上一次的结论", resumedText.includes("CHILD_FIRST_ROUND"), resumedText.slice(0, 200));
  check("续接确实又跑了一轮子代理模型", childRequests.length >= childRequestsBefore + 2, String(childRequests.length - childRequestsBefore));

  // ── F. 续接不存在的子代理：如实报错，不假装续接 ──
  parentPlan = [{ tool: agentTool({ prompt: "ghost", resume: "mobile-subagent-does-not-exist" }) }];
  childPlan = [];
  await send("sendText", sessionId, { text: "Resume ghost" });
  await wait(
    () => JSON.stringify(requests.at(-1)?.messages ?? []).includes("不在本次运行中"),
    "续接不存在的子代理没有如实报错",
  );
  check("续接不存在的子代理如实报错", JSON.stringify(requests.at(-1)?.messages).includes("不在本次运行中"));

  const failed = results.filter(r => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : `  → ${r.detail}`}`);
  console.log(`\n后台子代理与续接冒烟：${results.length - failed.length}/${results.length} PASS`);
  process.exitCode = failed.length > 0 ? 1 : 0;
} finally {
  releaseGate?.();
  agent.disposeAll();
  globalThis.fetch = oldFetch;
  unlinkSync(out);
}
