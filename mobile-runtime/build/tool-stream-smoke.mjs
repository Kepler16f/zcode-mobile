// 工具地基（model-stream 的 tool_calls 协议层）的单元冒烟（0.4.2）。
// 只测协议层：回合循环还没接（那是下一个有意的决定），所以这条冒烟钉的是
// "将来接循环时脚下这块地基是对的"——增量合并按 index、无工具时请求体逐字节不变、
// 非流式一次性 JSON 也认、anthropic/responses 两分支一行未动。
// 底座：真 streamModelCompletion + 假 fetch（Node 的 Response/ReadableStream 都是标准件）。
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const root = path.resolve(here, "..");
const zcodeRoot = path.join(root, "../zcode");
const require = createRequire(path.join(zcodeRoot, "apps/zcode-cli/package.json"));
const esbuild = require("esbuild");

const tmp = path.join(os.tmpdir(), `azcode-toolstream-${Date.now()}.mjs`);
await esbuild.build({
  entryPoints: [path.join(root, "ui/model-stream.ts")],
  outfile: tmp,
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  write: true,
  logLevel: "warning",
});
const mod = await import(pathToFileURL(tmp).href);
fs.rmSync(tmp, { force: true });
const { streamModelCompletion } = mod;

const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (e) {
    results.push({ name, ok: false, why: String(e?.stack ?? e).split("\n").slice(0, 3).join(" | ").slice(0, 300) });
  }
};
const eq = (got, want, label) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${label}: 得 ${JSON.stringify(got)} 期望 ${JSON.stringify(want)}`);
  }
};

const TARGET = (apiFormat) => ({
  apiFormat,
  baseUrl: "http://mock.test/v1",
  apiKey: "k",
  model: "m",
});

/** 装一条假 fetch：记录请求体，回给定 SSE 帧（或一次性 JSON）。返回 {captured, restore}。 */
function mockFetch(frames, { json = false } = {}) {
  const captured = {};
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.url = String(url);
    captured.body = JSON.parse(init.body);
    if (json) {
      return new Response(init.__mockPayload ?? frames[0], {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  return { captured, restore: () => (globalThis.fetch = original) };
}

const chatFrame = (delta, finish = null) => ({
  id: "c1",
  object: "chat.completion.chunk",
  created: 1,
  model: "m",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

await check("无工具对话零回归：请求体没有 tools 键，messages 保持 {role,content}，toolCalls 空数组", async () => {
  const { captured, restore } = mockFetch([chatFrame({ content: "你好" }), chatFrame({}, "stop")]);
  try {
    const r = await streamModelCompletion({
      target: TARGET("openai-chat-completions"),
      messages: [{ role: "user", content: "hi" }],
      onDelta: () => {},
    });
    eq("tools" in captured.body, false, "body 不该出现 tools");
    eq(captured.body.messages, [{ role: "user", content: "hi" }], "messages 逐字节不变");
    eq(r.text, "你好", "文本");
    eq(r.toolCalls, [], "无工具时 toolCalls=[]");
    return { ok: true };
  } finally {
    restore();
  }
});

await check("流式增量合并：id/name 首帧、arguments 三帧拼接，按 index 收口", async () => {
  const { restore } = mockFetch([
    chatFrame({
      tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: '{"file_' } }],
    }),
    chatFrame({ tool_calls: [{ index: 0, function: { arguments: "path" } }] }),
    chatFrame({ tool_calls: [{ index: 0, function: { arguments: '":"/work/a"}' } }] }),
    chatFrame({}, "tool_calls"),
  ]);
  try {
    const r = await streamModelCompletion({
      target: TARGET("openai-chat-completions"),
      messages: [{ role: "user", content: "读文件" }],
      onDelta: () => {},
    });
    eq(r.toolCalls, [{ id: "call_1", name: "Read", arguments: '{"file_path":"/work/a"}' }], "合并结果");
    eq(JSON.parse(r.toolCalls[0].arguments), { file_path: "/work/a" }, "arguments 拼完可 parse");
    return { calls: r.toolCalls.length };
  } finally {
    restore();
  }
});

await check("两个并行调用按 index 分桶、输出保序（乱序到达也不串）", async () => {
  const { restore } = mockFetch([
    chatFrame({ tool_calls: [{ index: 1, id: "call_b", function: { name: "Grep", arguments: "{}" } }] }),
    chatFrame({ tool_calls: [{ index: 0, id: "call_a", function: { name: "Glob", arguments: "{}" } }] }),
    chatFrame({}, "tool_calls"),
  ]);
  try {
    const r = await streamModelCompletion({
      target: TARGET("openai-chat-completions"),
      messages: [{ role: "user", content: "x" }],
      onDelta: () => {},
    });
    eq(r.toolCalls.map((c) => c.id), ["call_a", "call_b"], "index 序");
    return { ids: r.toolCalls.map((c) => c.id) };
  } finally {
    restore();
  }
});

await check("混合帧：content 与 tool_calls 同帧共存时两条都收（不互斥）", async () => {
  const pieces = [];
  const { restore } = mockFetch([
    chatFrame({ content: "先说一句", tool_calls: [{ index: 0, id: "c1", function: { name: "Read", arguments: "{}" } }] }),
    chatFrame({}, "stop"),
  ]);
  try {
    const r = await streamModelCompletion({
      target: TARGET("openai-chat-completions"),
      messages: [{ role: "user", content: "x" }],
      onDelta: (t) => pieces.push(t),
    });
    eq(r.text, "先说一句", "文本没被工具帧吞掉");
    eq(pieces, ["先说一句"], "onDelta 照常");
    eq(r.toolCalls.length, 1, "工具也没丢");
    return { text: r.text, calls: r.toolCalls.length };
  } finally {
    restore();
  }
});

await check("tools 请求形状 + 多轮消息映射（assistant 带 tool_calls、tool 回结果）", async () => {
  const { captured, restore } = mockFetch([chatFrame({}, "stop")]);
  try {
    await streamModelCompletion({
      target: TARGET("openai-chat-completions"),
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "读 a" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_1", name: "Read", arguments: '{"file_path":"/work/a"}' }],
        },
        { role: "tool", content: "文件内容", toolCallId: "call_1" },
      ],
      tools: [{ name: "Read", description: "读文件", parameters: { type: "object", properties: { file_path: { type: "string" } } } }],
      onDelta: () => {},
    });
    eq(captured.body.tools, [
      {
        type: "function",
        function: {
          name: "Read",
          description: "读文件",
          parameters: { type: "object", properties: { file_path: { type: "string" } } },
        },
      },
    ], "tools 形状");
    eq(captured.body.messages[2], {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "Read", arguments: '{"file_path":"/work/a"}' } }],
    }, "assistant 工具消息");
    eq(captured.body.messages[3], { role: "tool", tool_call_id: "call_1", content: "文件内容" }, "tool 结果消息");
    return { mapped: true };
  } finally {
    restore();
  }
});

await check("非流式一次性 JSON 也认 message.tool_calls", async () => {
  const payload = JSON.stringify({
    choices: [{ message: { content: "", tool_calls: [{ id: "j1", function: { name: "Edit", arguments: '{"a":1}' } }] } }],
  });
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    new Response(payload, { status: 200, headers: { "content-type": "application/json" } });
  void original;
  try {
    const r = await streamModelCompletion({
      target: TARGET("openai-chat-completions"),
      messages: [{ role: "user", content: "x" }],
      onDelta: () => {},
    });
    eq(r.toolCalls, [{ id: "j1", name: "Edit", arguments: '{"a":1}' }], "JSON 路径");
    return { ok: true };
  } finally {
    globalThis.fetch = original;
  }
});

await check("openai-responses 工具载荷：请求体带 function 条目 tools，文本流 toolCalls 空", async () => {
  const { captured, restore } = mockFetch([{ type: "response.output_text.delta", delta: "hi" }]);
  try {
    const r = await streamModelCompletion({
      target: TARGET("openai-responses"),
      messages: [{ role: "user", content: "x" }],
      tools: [{ name: "Read", description: "d", parameters: {} }],
      onDelta: () => {},
    });
    // 0.7.x 工具载荷补齐后 responses 也声明 tools（此前只有 anthropic 有）。
    // 不声明的话模型永远只能"说要开始工作"然后 end_turn——装机截断症状的端侧半因。
    eq("tools" in captured.body, true, "responses 该带 tools");
    eq(captured.body.tools[0]?.type, "function", "responses 的 tools 条目形状不对");
    eq(captured.body.tools[0]?.name, "Read", "responses 的 tools 条目缺 name");
    eq(r.toolCalls, [], "responses toolCalls 空");
    eq(r.text, "hi", "responses 文本照旧");
  } finally {
    restore();
  }
  return { ok: true };
});

await check("openai-responses 工具调用：function_call 条目按 call_id 摘成 toolCalls", async () => {
  const { captured, restore } = mockFetch([
    { type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name: "Read", arguments: "{\"path\":\"a.txt\"}" } },
  ]);
  try {
    const r = await streamModelCompletion({
      target: TARGET("openai-responses"),
      messages: [{ role: "user", content: "x" }],
      tools: [{ name: "Read", description: "d", parameters: {} }],
      onDelta: () => {},
    });
    eq(r.toolCalls.length, 1, `responses 工具调用数不对：${JSON.stringify(r.toolCalls)}`);
    eq(r.toolCalls[0]?.name, "Read", "responses 工具名不对");
    // call_id 与 item id 是不同概念：回传结果必须用 call_id，否则上游认不出这条调用。
    eq(r.toolCalls[0]?.id, "call_1", `responses 工具 id 应取 call_id：${r.toolCalls[0]?.id}`);
  } finally {
    restore();
  }
  return { ok: true };
});

await check("anthropic 请求侧：tools→input_schema，assistant toolCalls→tool_use，role=tool→user+tool_result", async () => {
  const { captured, restore } = mockFetch([{ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }]);
  try {
    await streamModelCompletion({
      target: TARGET("anthropic-messages"),
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "克隆项目" },
        { role: "assistant", content: "", toolCalls: [{ id: "tu_1", name: "Bash", arguments: '{"cmd":"git clone"}' }] },
        { role: "tool", toolCallId: "tu_1", content: "ok" },
      ],
      tools: [{ name: "Bash", description: "跑命令", parameters: { type: "object", properties: { cmd: { type: "string" } } } }],
      onDelta: () => {},
    });
    const b = captured.body;
    eq("system" in b, true, "system 拆到顶层");
    eq(b.tools, [{ name: "Bash", description: "跑命令", input_schema: { type: "object", properties: { cmd: { type: "string" } } } }], "tools→input_schema");
    // user(文本)→assistant(tool_use)→user(tool_result) 三消息，工具结果合并进 user。
    eq(b.messages.length, 3, "消息数（user/assistant/tool-result 折进 user）");
    eq(b.messages[1].content, [{ type: "tool_use", id: "tu_1", name: "Bash", input: { cmd: "git clone" } }], "assistant→tool_use 块");
    eq(b.messages[2].role, "user", "role=tool 折成 user");
    eq(b.messages[2].content, [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }], "tool_result 块");
    return { ok: true };
  } finally {
    restore();
  }
});

await check("anthropic 流式工具：content_block_start(tool_use)+input_json_delta 拼接 arguments", async () => {
  const { restore } = mockFetch([
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_9", name: "Write" } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path"' } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ':"/a.txt"}' } },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
    { type: "message_stop" },
  ]);
  try {
    const r = await streamModelCompletion({
      target: TARGET("anthropic-messages"),
      messages: [{ role: "user", content: "写文件" }],
      onDelta: () => {},
    });
    eq(r.toolCalls, [{ id: "tu_9", name: "Write", arguments: '{"path":"/a.txt"}' }], "arguments 按块号拼完");
    eq(JSON.parse(r.toolCalls[0].arguments), { path: "/a.txt" }, "拼完可 parse");
    eq(r.finishReason, "tool_use", "finish_reason 透传 stop_reason");
    return { calls: r.toolCalls.length };
  } finally {
    restore();
  }
});

await check("anthropic 非流式整包：message.content[] 里 tool_use 块摘成 toolCalls", async () => {
  const payload = JSON.stringify({
    type: "message",
    content: [
      { type: "text", text: "开始" },
      { type: "tool_use", id: "tu_3", name: "Read", input: { file_path: "/x" } },
    ],
    stop_reason: "tool_use",
  });
  const { restore } = mockFetch([payload], { json: true });
  try {
    const r = await streamModelCompletion({
      target: TARGET("anthropic-messages"),
      messages: [{ role: "user", content: "读" }],
      onDelta: () => {},
    });
    eq(r.toolCalls, [{ id: "tu_3", name: "Read", arguments: '{"file_path":"/x"}' }], "tool_use 摘取");
    eq(r.text, "开始", "text 块进正文");
  } finally {
    restore();
  }
  return { ok: true };
});

const failed = results.filter((r) => !r.ok);
for (const r of results) process.stdout.write(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  → ${r.why}`}\n`);
process.stdout.write(`\n工具地基（model-stream）冒烟：${results.length - failed.length}/${results.length} PASS\n`);
process.exit(failed.length ? 1 : 0);
