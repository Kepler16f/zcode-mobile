// 移动 Agent 的回归：用真实协议入口和模型流，验证跨轮历史、计划模式与中途持久化。
import assert from "node:assert/strict";
import path from "node:path";
import { unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const esbuild = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"))("esbuild");
const out = path.join(root, "mobile-runtime/build", `.tmp-reliability-${process.pid}.mjs`);
await esbuild.build({
  stdin: {
    contents: `export {createMobileAgentService} from "${root.replaceAll("\\", "/")}/mobile-runtime/ui/agent.ts";
export {createCommandEnvelope,getV4ClientId} from "${root.replaceAll("\\", "/")}/zcode/packages/ui/src/v4/commandFactory.ts";`,
    resolveDir: path.join(root, "mobile-runtime/ui"),
  },
  outfile: out, bundle: true, format: "esm", platform: "node", target: "node24",
  jsx: "automatic", logLevel: "warning",
  alias: { "@": path.join(root, "zcode/packages/ui/src") },
  nodePaths: ["web", "ui", "client", "services", "shared"].map(p => path.join(root, "zcode/packages", p, "node_modules")).concat(path.join(root, "zcode/node_modules")),
});

const { createMobileAgentService, createCommandEnvelope, getV4ClientId } = await import(pathToFileURL(out).href);
const records = new Map();
const requests = [];
const executed = [];
let nextTool = null;
let holdStream = false;
let partialMarker = "PARTIAL_CHECKPOINT";
let hookRewrite = null;
let streamController;
let childRequests = 0;
let holdChildStream = false;
let memoryEnabled = false;
const grantedMemoryRoots=[];
const store = {
  save(entry) { records.set(entry.sessionId, structuredClone({ ...entry, updatedAt: Date.now() })); },
  load(id) { return records.get(id) ?? null; },
  listSummaries(workspacePath) { return [...records.values()].filter(x => x.workspacePath === workspacePath); },
  listAllStates() { return [...records.values()]; },
  engine() { return "test-memory"; },
};
const oldFetch = globalThis.fetch;
const sse = (delta, reason = "stop") => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`;
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  requests.push(body);
  if (String(body.messages?.[0]?.content).includes("CHILD_INSTRUCTIONS")) {
    childRequests++;
    if(holdChildStream){holdChildStream=false;return new Response(new ReadableStream({start(c){
      streamController=c;c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({choices:[{index:0,delta:{content:"PARTIAL_CHILD_CHECKPOINT"},finish_reason:null}]})}\n\n`));
    }}),{headers:{"content-type":"text/event-stream"}});}
    if (childRequests === 1) return new Response(sse({ tool_calls: [{ index: 0, id: "child-read", type: "function", function: { name: "Read", arguments: '{"file_path":"inside.txt"}' } }] }, "tool_calls"), { headers: { "content-type": "text/event-stream" } });
    return new Response(sse({ content: "CHILD_FINISHED" }), { headers: { "content-type": "text/event-stream" } });
  }
  if (nextTool) {
    const call = nextTool; nextTool = null;
    return new Response(sse({ tool_calls: [{ index: 0, id: "test-call", type: "function", function: call }] }, "tool_calls"), { headers: { "content-type": "text/event-stream" } });
  }
  if (holdStream) {
    holdStream = false;
    return new Response(new ReadableStream({ start(c) {
      streamController = c;
      c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: partialMarker }, finish_reason: null }] })}\n\n`));
    }}), { headers: { "content-type": "text/event-stream" } });
  }
  return new Response(sse({ content: "Done." }), { headers: { "content-type": "text/event-stream" } });
};
const agent = createMobileAgentService({
  sessionStore: store,
  memoryContext:async()=>memoryEnabled?{root:"/work/profile/memory",content:"MEMORY_INDEX_SENTINEL"}:null,
  capabilities: {
    skillsService: { list: async () => ({ skills: [{ id: "test-skill", name: "review", description: "review test", body: "SKILL_INSTRUCTIONS", path: "/work/test/.zcode/skills/review/SKILL.md", scope: "workspace", enabled: true }], diagnostics: [] }) },
    subagentsService: { list: async () => ({ agents: [{ id: "general", name: "general-purpose", description: "test agent", systemPrompt: "CHILD_INSTRUCTIONS", scope: "built-in", source: "built-in", enabled: true, tools: ["Read"] }], diagnostics: [] }) },
  },
  hookRuntimeFactory: async () => ({
    enabled: hookRewrite !== null,
    diagnostics: [],
    run: async (event) => event === "PreToolUse" && hookRewrite
      ? { updatedInput: hookRewrite, permissionBehavior: "allow" }
      : {},
  }),
  modelTargets: { view: async () => ({ providers: [{ providerId: "test", models: [{ modelId: "mock", config: { properties: { contextWindow: 32000 } } }], config: { api: { type: "openai-chat-completions", baseUrl: "https://test.invalid/v1" }, access: { type: "personal-api-key", apiKey: "test" } } }], preferredSelection: { providerId: "test", modelId: "mock" } }) },
  toolEngine: async () => ({
    tools: ["Read", "Fetch", "Git"].map(name => ({ name, description: name, parameters: { type: "object", properties: {} } })),
    approvalRequired: () => false,
    execute: async call => { executed.push(call); return { isError: false, content: "TOOL_RESULT_SENTINEL" }; },
    grantRoot(root) {grantedMemoryRoots.push(root);}, revokeRoot() {},
  }),
});
try {
  const hello = await agent.helloConversationV4();
  await agent.initializeConversationV4({ kind: "clientHello", protocolVersion: hello.protocolVersion, clientId: getV4ClientId(), clientKind: "mobileApp", appVersion: "test" });
  const send = (type, sessionId, payload) => agent.sendConversationCommandV4({ workspacePath: "/work/test", envelope: createCommandEnvelope({ type, sessionId, payload }) });
  const created = await send("createSession", null, { workspaceId: "test" });
  const sessionId = created.result.sessionId;
  const repeated = createCommandEnvelope({ type: "sendText", sessionId, payload: { text: "workspace test" } });
  await assert.rejects(agent.sendConversationCommandV4({ workspacePath: "/work/other", envelope: repeated }), /workspaceMismatch/);
  await assert.rejects(agent.readSession({ workspacePath: "/work/other", sessionId }), /workspaceMismatch/);
  await assert.rejects(agent.attachmentBeginV4({ workspacePath: "/work/other", sessionId, uploadId: "cross-workspace", fileName: "x.png", mime: "image/png", totalBytes: 1, totalChunks: 1, checksum: "sha256:0" }), /workspaceMismatch/);
  async function wait(predicate, message, timeoutMs=5000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(message);
      await new Promise(r => setTimeout(r, 20));
    }
  }
  async function submit(payload) {
    const count = requests.length;
    const ack = await send("sendText", sessionId, payload);
    assert.equal(ack.status, "accepted");
    await wait(() => requests.length > count && records.get(sessionId)?.state.phase === "completedSuccess", "turn timed out");
  }
  nextTool = { name: "Read", arguments: '{"file_path":"a.txt"}' };
  await submit({ text: "Read a file" });
  const reopened = createMobileAgentService({ sessionStore: store });
  await assert.rejects(reopened.readSession({ workspacePath: "/work/other", sessionId }), /workspaceMismatch/);
  reopened.disposeAll();
  nextTool = { name: "Skill", arguments: '{"skill":"review"}' };
  const skillRequest = requests.length;
  await submit({ text: "Use $review" });
  assert.match(JSON.stringify(requests[skillRequest]), /SKILL_INSTRUCTIONS/, "显式技能应进入主模型请求");
  assert.match(JSON.stringify(requests.at(-1).messages), /SKILL_INSTRUCTIONS/, "Skill 调用的正文应回传主模型");
  nextTool = { name: "Agent", arguments: '{"prompt":"inspect"}' };
  const childExecuted = executed.length;
  await submit({ text: "Delegate inspection" });
  assert.equal(childRequests, 2, "子代理必须执行真实的模型与工具循环");
  assert.equal(executed[childExecuted]?.name, "Read", "子代理工具必须经过父执行器");
  assert.match(JSON.stringify(requests.at(-1).messages), /CHILD_FINISHED/, "子代理结果应回传主模型");
  nextTool={name:"Agent",arguments:'{"prompt":"stream checkpoint"}'};
  holdChildStream=true;streamController=undefined;
  await send("sendText",sessionId,{text:"Delegate with long output"});
  await wait(()=>Boolean(streamController),"子会话流未启动");
  await wait(()=>[...records.values()].some(entry=>entry.sessionId.startsWith("mobile-subagent-")&&JSON.stringify(entry.state).includes("PARTIAL_CHILD_CHECKPOINT")),"子会话没有形成正文检查点",8000);
  streamController.enqueue(new TextEncoder().encode(sse({content:" done"})));streamController.close();streamController=undefined;
  await wait(()=>records.get(sessionId)?.state.phase==="completedSuccess","子会话未收轮");
  assert.ok(!JSON.stringify(requests).includes("MEMORY_INDEX_SENTINEL"),"记忆关闭时不注入");
  memoryEnabled=true;await submit({text:"Use project memory"});
  assert.match(JSON.stringify(requests.at(-1).messages),/MEMORY_INDEX_SENTINEL/,"记忆开启后进入模型系统上下文");
  assert.ok(grantedMemoryRoots.includes("/work/profile/memory"),"记忆目录通过同一个文件授权根交给工具");
  memoryEnabled=false;
  assert.equal(requests[0].max_tokens, 8000, "输出预算应依据模型窗口收紧");
  assert.equal(records.get(sessionId).state.contextWindow, 32000, "模型窗口应随会话保存");
  const before = requests.length;
  await submit({ text: "What did it say?" });
  assert.match(JSON.stringify(requests[before].messages), /TOOL_RESULT_SENTINEL/, "工具结果应在下一轮保留");

  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aWQAAAAASUVORK5CYII=";
  const imageBytes = Uint8Array.from(atob(image), c => c.charCodeAt(0));
  const digest = await crypto.subtle.digest("SHA-256", imageBytes);
  const checksum = "sha256:" + [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, "0")).join("");
  const upload = { workspacePath: "/work/test", sessionId, uploadId: "image-test" };
  await agent.attachmentBeginV4({ ...upload, fileName: "pixel.png", mime: "image/png", totalBytes: imageBytes.length, totalChunks: 1, checksum });
  await agent.attachmentChunkV4({ ...upload, chunkIndex: 0, dataBase64: image });
  const committed = await agent.attachmentCommitV4(upload);
  const resumed = await agent.attachmentBeginV4({ ...upload, fileName: "pixel.png", mime: "image/png", totalBytes: imageBytes.length, totalChunks: 1, checksum });
  assert.equal(resumed.state, "committed", "重复提交应返回原附件");
  await assert.rejects(agent.attachmentBeginV4({ ...upload, fileName: "other.png", mime: "image/png", totalBytes: imageBytes.length, totalChunks: 1, checksum }), /不可覆盖/);
  const attachment = { ref: committed.ref, fileName: "pixel.png", mime: "image/png", bytes: imageBytes.length };
  const attachmentRequest = requests.length;
  await submit({ text: "Describe the picture", attachments: [attachment] });
  assert.ok(JSON.stringify(requests[attachmentRequest].messages).includes(image), "模型请求必须包含图片内容");
  const savedRow = records.get(sessionId).state.rows.find(r => r.kind === "userInput" && r.text === "Describe the picture");
  assert.equal(savedRow.attachments[0].ref, attachment.ref, "时间线必须保留附件引用");
  const read = await agent.attachmentReadV4({ workspacePath: "/work/test", sessionId, ref: attachment.ref, offset: 0, limit: 512 });
  assert.equal(read.dataBase64, image, "预览必须读取已提交的真实内容");
  await assert.rejects(agent.attachmentReadV4({ workspacePath: "/work/test", sessionId, ref: attachment.ref, target: { rowId: savedRow.rowId, entityId: "wrong" }, attachmentIndex: 0, offset: 0, limit: 512 }), /不属于/);
  const attachmentRestored = createMobileAgentService({ sessionStore: store });
  const restoredHello = await attachmentRestored.helloConversationV4();
  await attachmentRestored.initializeConversationV4({ kind: "clientHello", protocolVersion: restoredHello.protocolVersion, clientId: getV4ClientId(), clientKind: "mobileApp", appVersion: "test" });
  const restoredImage = await attachmentRestored.attachmentReadV4({ workspacePath: "/work/test", sessionId, ref: attachment.ref, offset: 0, limit: 512 });
  assert.equal(restoredImage.dataBase64, image, "重建 Agent 后应能读取已保存附件");
  attachmentRestored.disposeAll();
  await assert.rejects(agent.attachmentBeginV4({ ...upload, uploadId: "bad", fileName: "x.exe", mime: "application/octet-stream", totalBytes: 1, totalChunks: 1, checksum }), /不支持/);

  holdStream = true;
  await send("sendText", sessionId, { text: "Hold the turn" });
  await wait(() => Boolean(streamController), "流式请求未启动");
  const queued = await send("sendText", sessionId, { text: "Queued image", attachments: [attachment] });
  assert.equal(queued.status, "accepted");
  const requestCount = requests.length;
  streamController.enqueue(new TextEncoder().encode(sse({ content: "Finished" })));
  streamController.close();
  streamController = undefined;
  await wait(() => requests.length > requestCount && records.get(sessionId)?.state.phase === "completedSuccess", "附件队列未排空");
  assert.ok(JSON.stringify(requests[requestCount].messages).includes(image), "排队输入的附件不能丢失");

  for (const call of [
    { name: "Fetch", arguments: '{"action":"download","url":"https://test.invalid","path":"a"}' },
    { name: "Git", arguments: '{"action":"init"}' },
  ]) {
    const count = executed.length;
    nextTool = call;
    await submit({ text: "Plan only", mode: "plan", planEnabled: true });
    assert.equal(executed.length, count, `计划模式不得执行 ${call.name} 写操作`);
  }
  nextTool = { name: "Fetch", arguments: '{"action":"fetch","url":"https://test.invalid"}' };
  const readCount = executed.length;
  await submit({ text: "Inspect", mode: "plan", planEnabled: true });
  assert.equal(executed.length, readCount + 1, "计划模式应允许只读 Fetch");
  hookRewrite = { action: "download", url: "https://test.invalid", path: "rewritten" };
  nextTool = { name: "Fetch", arguments: '{"action":"fetch","url":"https://test.invalid"}' };
  const beforeHook = executed.length;
  await submit({ text: "Inspect with hook", mode: "plan", planEnabled: true });
  assert.equal(executed.length, beforeHook, "钩子改成写操作后必须再次检查计划模式");
  hookRewrite = null;

  holdStream = true;
  partialMarker = "PARTIAL_RECOVERY";
  await send("sendText", sessionId, { text: "Stream slowly", mode: "build", planEnabled: false });
  // 产品按5秒合并正文检查点；测试给定时器少量调度余量，不能在同一5秒边界抢先判失败。
  await wait(() => JSON.stringify(records.get(sessionId)?.state).includes("PARTIAL_RECOVERY"), "流中正文没有按时保存",8000);
  assert.equal(records.get(sessionId).state.phase, "running");
  const recovered = createMobileAgentService({ sessionStore: store });
  const restored = await recovered.readSession({ sessionId, workspacePath: "/work/test" });
  assert.ok(JSON.stringify(restored).includes("PARTIAL_RECOVERY"), "中途重启后应恢复已保存正文");
  assert.equal(restored.session.status, "completed", "中断轮次不得恢复为仍在执行");
  assert.ok(restored.messages.some(m => m.info.finish === "interrupted"), "恢复的助手内容应标记为中断");
  recovered.disposeAll();
  console.log("runtime-reliability-smoke: PASS");
} finally {
  agent.disposeAll();
  streamController?.error(new Error("test cleanup"));
  globalThis.fetch = oldFetch;
  unlinkSync(out);
}
