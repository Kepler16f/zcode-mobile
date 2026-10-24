// anthropic v1/messages 客户端形状冒烟（0.6.6，用户点名"研究怎么兼容 anthropic 的 v1/messages"）。
//
// 覆盖三块（此前 anthropic 路径零测试）：
//  ① SSE 全事件流：message_start → content_block_start(text) → content_block_delta(text_delta)
//     → content_block_delta(thinking_delta，不进正文) → message_delta(stop_reason) → message_stop；
//     断言正文抽取、finishReason、终止账（sawTerminal，防"无收尾帧当成功"）。
//  ② 流内错误帧 {"type":"error","error":{...}}（不带 event: error 行的形状）如实报错。
//  ③ HTTP 4xx body {"error":{"message":"…"}} → 错误信息可读（不是一串 JSON 原文）。
//  ④ anthropic 请求头：x-api-key + anthropic-version + anthropic-dangerous-direct-browser-access。
//  ⑤ 非流式 message JSON（池子对无 stream 请求的应答形状，8899 实测如此）整包解析。
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const zcodeRoot = path.join(root, "../zcode");
const require = createRequire(path.join(zcodeRoot, "apps/zcode-cli/package.json"));
const esbuild = require("esbuild");

const tmp = path.join(os.tmpdir(), `azcode-anth-${Date.now()}.mjs`);
await esbuild.build({
  entryPoints: [path.join(root, "ui/model-stream.ts")],
  outfile: tmp,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  write: true,
  logLevel: "warning",
});
const mod = await import(pathToFileURL(tmp).href);
fs.rmSync(tmp, { force: true });
const { streamModelCompletion, ModelStreamError, modelRequestUrl } = mod;

const results = [];
const check = async (name, fn) => {
  const t0 = Date.now();
  try {
    results.push({ name, ok: true, ms: Date.now() - t0, detail: await fn() });
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, why: String(e?.message ?? e).slice(0, 300) });
  }
};
const expect = (cond, why) => {
  if (!cond) throw new Error(why);
};

const TARGET = {
  apiFormat: "anthropic-messages",
  baseUrl: "http://pool.test:8899",
  apiKey: "whatever",
  model: "GLM-5.3-Flash",
};
const MSGS = [{ role: "user", content: "hi" }];

function installFakeSse(frames, { statusCode = 200 } = {}) {
  const original = globalThis.fetch;
  let capturedInit = null;
  globalThis.fetch = async (url, init) => {
    capturedInit = { url: String(url), init };
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(ctrl) {
        for (const f of frames) ctrl.enqueue(encoder.encode(`event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`));
        ctrl.close();
      },
    });
    return new Response(body, { status: statusCode, headers: { "content-type": "text/event-stream" } });
  };
  return { restore: () => (globalThis.fetch = original), captured: () => capturedInit };
}

await check("① SSE 全事件流：text_delta 进正文、thinking_delta 不进、stop_reason/终止账正确", async () => {
  const frames = [
    { event: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 62 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "让我想想" } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "text" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "你好" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "，世界" } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
  const { restore, captured } = installFakeSse(frames);
  try {
    const r = await streamModelCompletion({ target: TARGET, messages: MSGS, onDelta: () => {} });
    expect(r.text === "你好，世界", `正文抽取错：${JSON.stringify(r.text)}`);
    expect(r.finishReason === "end_turn", `finishReason：${r.finishReason}`);
    expect(r.truncated === false, "有 message_stop 就不是截断");
    expect(String(captured().url) === "http://pool.test:8899/v1/messages", `URL：${captured().url}`);
    return { text: r.text, finishReason: r.finishReason };
  } finally {
    restore();
  }
});

await check("② 流内 anthropic 错误帧（无 event 行）→ model.business.*，不装作空回答", async () => {
  const frames = [
    { event: "message", data: { type: "error", error: { type: "overloaded_error", message: "池子过载了" } } },
  ];
  const { restore } = installFakeSse(frames);
  try {
    let code = "";
    try {
      await streamModelCompletion({ target: TARGET, messages: MSGS, onDelta: () => {} });
    } catch (e) {
      code = e instanceof ModelStreamError ? e.reasonCode : String(e);
    }
    expect(code.startsWith("model.business."), `期望业务错误，得到 ${code}`);
    return { code };
  } finally {
    restore();
  }
});

await check("③ HTTP 4xx 的 anthropic 错误 body → 人话", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "模型名不认识" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  try {
    let message = "";
    try {
      await streamModelCompletion({ target: TARGET, messages: MSGS, onDelta: () => {} });
    } catch (e) {
      message = String(e?.message ?? e);
    }
    expect(message.includes("模型名不认识"), `错误应带人话：${message}`);
    return { message };
  } finally {
    globalThis.fetch = original;
  }
});

await check("④ anthropic 请求头三件套齐（x-api-key / version / browser-access）", async () => {
  const { restore, captured } = installFakeSse([
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
  try {
    await streamModelCompletion({ target: TARGET, messages: MSGS, onDelta: () => {} });
    const h = captured().init.headers;
    expect(h["x-api-key"] === "whatever", `x-api-key：${h["x-api-key"]}`);
    expect(h["anthropic-version"] === "2023-06-01", `anthropic-version：${h["anthropic-version"]}`);
    expect(h["anthropic-dangerous-direct-browser-access"] === "true", "缺 browser-access 头");
    return { ok: true };
  } finally {
    restore();
  }
});

await check("⑤ 非流式 message JSON（8899 实测形状，含 thinking 块）整包解析", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        id: "msg_x",
        type: "message",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "想了一句", signature: "e9da" },
          { type: "text", text: "最终回答" },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 62, output_tokens: 30 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  try {
    const r = await streamModelCompletion({ target: TARGET, messages: MSGS, onDelta: () => {} });
    expect(r.text === "最终回答", `非流式抽取：${JSON.stringify(r.text)}`);
    expect(r.finishReason === "end_turn", `finishReason：${r.finishReason}`);
    return { text: r.text };
  } finally {
    globalThis.fetch = original;
  }
});

let passed = 0;
for (const r of results) {
  if (r.ok) passed += 1;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.why}`);
}
console.log(`anthropic v1/messages 冒烟：${passed}/${results.length} PASS`);
if (passed !== results.length) process.exit(1);
