import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { unlinkSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const esbuild = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"))("esbuild");
const out = path.join(root, "mobile-runtime/build", `.tmp-responses-${process.pid}.mjs`);
await esbuild.build({ entryPoints: [path.join(root, "mobile-runtime/ui/model-stream.ts")], outfile: out, bundle: true, format: "esm", platform: "node", target: "node24", logLevel: "warning" });
const { streamModelCompletion } = await import(pathToFileURL(out).href);
const oldFetch = globalThis.fetch;
let request;
globalThis.fetch = async (_url, init) => {
  request = JSON.parse(init.body);
  const frames = [
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "Read", arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":' },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: '"a.txt"}' },
    { type: "response.function_call_arguments.done", output_index: 0, arguments: '{"path":"a.txt"}' },
    { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call_1", name: "Read", arguments: '{"path":"a.txt"}' } },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: 42, output_tokens: 17 } } },
  ];
  return new Response(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
};
try {
  const result = await streamModelCompletion({
    target: { apiFormat: "openai-responses", baseUrl: "https://test.invalid/v1", apiKey: "test", model: "mock" },
    messages: [
      { role: "system", content: "System" },
      { role: "user", content: "Read", attachments: [{ fileName: "a.pdf", mime: "application/pdf", dataBase64: "JVBERg==" }] },
      { role: "assistant", content: "", toolCalls: [{ id: "old-call", name: "Read", arguments: "{}" }] },
      { role: "tool", toolCallId: "old-call", content: "old-result" },
    ],
    tools: [{ name: "Read", description: "Read", parameters: { type: "object", properties: {} } }],
    maxOutputTokens: 100, onDelta() {},
  });
  assert.equal(request.input[0].role, "system");
  assert.equal(request.input[1].content[1].file_data, "data:application/pdf;base64,JVBERg==");
  assert.equal(request.tools[0].name, "Read");
  assert.ok(request.input.some(x => x.type === "function_call" && x.call_id === "old-call"));
  assert.ok(request.input.some(x => x.type === "function_call_output" && x.call_id === "old-call" && x.output === "old-result"));
  assert.deepEqual(result.toolCalls, [{ id: "call_1", name: "Read", arguments: '{"path":"a.txt"}' }]);
  assert.deepEqual(result.usage, { inputTokens: 42, outputTokens: 17 });
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: "completed",
    output: [
      { type: "message", content: [{ type: "output_text", text: "hello" }] },
      { type: "function_call", call_id: "call_2", name: "Read", arguments: "{}" },
    ],
  }), { headers: { "content-type": "application/json" } });
  const whole = await streamModelCompletion({
    target: { apiFormat: "openai-responses", baseUrl: "https://test.invalid/v1", apiKey: "test", model: "mock" },
    messages: [{ role: "user", content: "Read" }], maxOutputTokens: 100, onDelta() {},
  });
  assert.equal(whole.text, "hello");
  assert.deepEqual(whole.toolCalls, [{ id: "call_2", name: "Read", arguments: "{}" }]);
  console.log("responses-smoke: PASS");
} finally {
  globalThis.fetch = oldFetch;
  unlinkSync(out);
}
