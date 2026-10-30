import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const esbuild = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"))("esbuild");
const out = path.join(root, "mobile-runtime/build", `.tmp-subagents-${process.pid}.mjs`);
await esbuild.build({ entryPoints: [path.join(root, "mobile-runtime/ui/skills-subagents.ts")], outfile: out, bundle: true,
  format: "esm", platform: "node", target: "node24", logLevel: "warning",
  nodePaths: ["shared", "services"].map(p => path.join(root, "zcode/packages", p, "node_modules")).concat(path.join(root, "zcode/node_modules")) });
const oldFetch = globalThis.fetch;
try {
  const api = await import(pathToFileURL(out).href);
  const skill = { id: "s1", name: "review", description: "Review & check", body: "Read ${ZCODE_SKILL_DIR}/guide.md", path: "/work/a/.zcode/skills/review/SKILL.md", scope: "workspace", enabled: true };
  const disabled = { ...skill, id: "s2", name: "hidden", enabled: false };
  const profile = { id: "general", name: "general-purpose", description: "test", systemPrompt: "CHILD_INSTRUCTIONS", path: "builtin://general", scope: "built-in", source: "built-in", enabled: true, tools: ["Read"] };
  const services = {
    skillsService: { list: async context => { assert.equal(context.workspacePath, "/work/a"); return { skills: [skill, disabled], capability: { userScopeAvailable: false }, diagnostics: [] }; } },
    subagentsService: { list: async context => { assert.equal(context.workspacePath, "/work/a"); return { agents: [profile], userAgents: [], pluginAgents: [], capability: { userScopeAvailable: false }, diagnostics: [] }; } },
  };
  const discovered = await api.discoverMobileCapabilities(services, { workspacePath: "/work/a" }, "Please use $review");
  assert.deepEqual(discovered.activatedSkillNames, ["review"]);
  assert.match(discovered.catalog, /Review &amp; check/);
  assert.match(discovered.catalog, /Read \/work\/a\/.zcode\/skills\/review\/guide.md/);
  assert.ok(!discovered.catalog.includes("name=\"hidden\""));
  assert.equal(api.executeMobileSkill(discovered.skills, '{"skill":"review"}').isError, false);
  assert.equal(api.executeMobileSkill(discovered.skills, '{"skill":"hidden"}').isError, true);
  assert.equal(api.executeMobileSkill([skill, { ...skill, id: "duplicate" }], '{"skill":"review"}').isError, true);
  assert.match(api.executeMobileSkill([{ ...skill, body: "x".repeat(20_000) }], '{"skill":"review"}').content, /truncated/);

  const target = { apiFormat: "openai-chat-completions", baseUrl: "https://test.invalid/v1", apiKey: "secret", model: "test-model" };
  const resolver = { view: async () => ({ providers: [{ providerId: "other", models: [{ modelId: "child" }], config: { api: { type: "openai-chat-completions", baseUrl: "https://child.invalid/v1" }, access: { type: "personal-api-key", apiKey: "child-secret" } } }] }) };
  const tools = ["Read", "Write", "Agent"].map(name => ({ name, description: name, parameters: { type: "object", properties: {} } }));
  const requests = [];
  const executed = [];
  let pending = [{ name: "Read", arguments: '{"file_path":"a.txt"}' }];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    const call = pending.shift();
    const delta = call ? { tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: call }] } : { content: "CHILD_RESULT" };
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  };
  const options = { rawArguments: '{"prompt":"Inspect the project"}', agents: [profile], skills: discovered.skills, workspacePath: "/work/a", mode: "build", parentTarget: target, modelTargets: resolver,
    availableTools: tools, executeTool: async (call, context) => { executed.push({ call, context }); return { isError: false, content: "REAL_READ_RESULT" }; } };
  const result = await api.runMobileSubagent(options);
  assert.equal(result.isError, false);
  const resultData = JSON.parse(result.content);
  assert.equal(resultData.status, "completed");
  assert.equal(resultData.content[0].text, "CHILD_RESULT");
  assert.equal(resultData.totalToolUseCount, 1);
  assert.equal(executed[0].call.name, "Read");
  assert.equal(executed[0].context.mode, "build");
  assert.deepEqual(executed[0].context.allowedToolNames, ["Read"]);
  assert.deepEqual(requests[0].body.tools.map(t => t.function.name), ["Read"]);
  assert.match(requests[0].body.messages[0].content, /CHILD_INSTRUCTIONS/);
  assert.match(JSON.stringify(requests[1].body.messages), /REAL_READ_RESULT/);

  const transcripts = [];
  await api.runMobileSubagent({ ...options, complete: async ({ messages }) => {
    transcripts.push(structuredClone(messages));
    return transcripts.length === 1
      ? { text: "", toolCalls: [{ id: "", name: "Read", arguments: "{}" }] }
      : { text: "done", toolCalls: [] };
  } });
  const transcriptCalls = transcripts[1].find(message => message.role === "assistant").toolCalls;
  const transcriptResult = transcripts[1].find(message => message.role === "tool");
  assert.ok(transcriptCalls[0].id);
  assert.equal(transcriptResult.toolCallId, transcriptCalls[0].id);

  pending = [{ name: "Write", arguments: '{"file_path":"bad.txt"}' }];
  const before = executed.length;
  const denied = await api.runMobileSubagent({ ...options, mode: "plan", agents: [{ ...profile, tools: undefined }] });
  assert.equal(denied.isError, false);
  assert.equal(executed.length, before, "计划模式不得把写操作交给父执行器");
  assert.match(JSON.stringify(requests.at(-1).body.messages), /未获准/);
  pending = [];
  const override = await api.runMobileSubagent({ ...options, agents: [{ ...profile, modelSelection: { providerId: "other", modelId: "child" } }] });
  assert.equal(override.isError, false);
  assert.equal(requests.at(-1).url, "https://child.invalid/v1/chat/completions");
  assert.equal(requests.at(-1).body.model, "child");
  // 后台执行（0.9.2）：不再拒绝，立即返回「已启动」；真正的后台生命周期由
  // subagent-background-smoke 覆盖，这里只钉住工具面的形状。
  let backgroundHandle = null;
  const background = await api.runMobileSubagent({
    ...options,
    rawArguments: '{"prompt":"x","run_in_background":true}',
    onBackground: handle => { backgroundHandle = handle; handle.controller.abort(); },
  });
  assert.equal(background.isError, false);
  assert.match(background.content, /"status":"running"/);
  await backgroundHandle.done;
  // 跨轮续接：没有对应记录时明确拒绝（端侧没有上一次子代理 transcript 的持久化形状）。
  assert.equal((await api.runMobileSubagent({ ...options, rawArguments: '{"prompt":"x","resume":"abc"}' })).isError, true);
  // profile 自己声明 background：默认后台运行（调用方显式 false 可覆盖）。
  let backgroundProfileHandle = null;
  const backgroundProfile = await api.runMobileSubagent({
    ...options,
    agents: [{ ...profile, background: true }],
    rawArguments: '{"prompt":"x"}',
    onBackground: handle => { backgroundProfileHandle = handle; handle.controller.abort(); },
  });
  assert.equal(backgroundProfile.isError, false);
  assert.match(backgroundProfile.content, /"status":"running"/);
  await backgroundProfileHandle.done;
  assert.equal((await api.runMobileSubagent({ ...options, agents: [{ ...profile, tools: ["Bash(git status)"] }] })).isError, true);
  assert.equal((await api.runMobileSubagent({ ...options, agents: [{ ...profile, mcpServers: [{ name: "x" }] }] })).isError, true);
  const aborted = new AbortController(); aborted.abort();
  const cancelled = await api.runMobileSubagent({ ...options, signal: aborted.signal });
  assert.equal(cancelled.errorCode, "mobile.subagentCancelled");
  console.log("skills-subagents-smoke: PASS");
} finally {
  globalThis.fetch = oldFetch;
  fs.unlinkSync(out);
}
