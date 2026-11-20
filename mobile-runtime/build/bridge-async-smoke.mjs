import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { callNativeJob } from "../ports/native-async.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const esbuild = require(require.resolve("esbuild", { paths: [here, resolve(here, ".."), resolve(here, "../../zcode")] }));

async function loadTsModule(tsPath) {
  const result = await esbuild.build({
    entryPoints: [tsPath],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    logLevel: "silent",
  });
  const code = Buffer.from(result.outputFiles[0].contents).toString("base64");
  return await import(`data:text/javascript;base64,${code}`);
}

const results = [];
const test = async (name, fn) => {
  await fn();
  results.push(name);
};

await test("推模式任务：收到 __zcodeJobDone 零轮询直达且调用 ack", async () => {
  let polls = 0;
  const acked = [];
  const bridge = {
    start() {
      setTimeout(() => {
        globalThis.__zcodeJobDone("push-job-1", { done: true, result: { exitCode: 0, stdout: "ok" } });
      }, 15);
      return JSON.stringify({ id: "push-job-1" });
    },
    poll() {
      polls += 1;
      return JSON.stringify({ done: false });
    },
    cancel() { return true; },
    ack(id) { acked.push(id); return true; },
  };
  const out = await callNativeJob(bridge, { cmd: "echo ok" });
  assert.deepEqual(out, { exitCode: 0, stdout: "ok" });
  assert.equal(polls, 0);
  assert.deepEqual(acked, ["push-job-1"]);
});

await test("早到竞态：start 返回前已推送 __zcodeJobDone 不丢结果", async () => {
  let polls = 0;
  const acked = [];
  const bridge = {
    start() {
      globalThis.__zcodeJobDone("early-job-1", { done: true, result: { early: true } });
      return JSON.stringify({ id: "early-job-1" });
    },
    poll() {
      polls += 1;
      return JSON.stringify({ done: false });
    },
    cancel() { return true; },
    ack(id) { acked.push(id); return true; },
  };
  const out = await callNativeJob(bridge, { cmd: "fast" });
  assert.deepEqual(out, { early: true });
  assert.equal(polls, 0);
  assert.deepEqual(acked, ["early-job-1"]);
});

await test("推模式取消：必须等原生完成推回后才以 AbortError 收口", async () => {
  const controller = new AbortController();
  let cancelledNative = false;
  let settled = false;
  const acked = [];
  const bridge = {
    start() { return JSON.stringify({ id: "cancel-push-1" }); },
    poll() { return JSON.stringify({ done: false }); },
    cancel() {
      cancelledNative = true;
      setTimeout(() => {
        globalThis.__zcodeJobDone("cancel-push-1", { done: true, result: { exitCode: 130 } });
      }, 25);
      return true;
    },
    ack(id) { acked.push(id); return true; },
  };
  const pending = callNativeJob(bridge, { cmd: "sleep" }, controller.signal).finally(() => { settled = true; });
  await new Promise(r => setTimeout(r, 10));
  controller.abort();
  assert.equal(cancelledNative, true);
  assert.equal(settled, false);
  await assert.rejects(() => pending, error => error.name === "AbortError");
  assert.deepEqual(acked, ["cancel-push-1"]);
});

await test("兼容旧版轮询 Mock：无 ack 方法时正常轮询完成", async () => {
  let count = 0;
  const bridge = {
    start() { return JSON.stringify({ id: "poll-only-1" }); },
    poll() {
      count += 1;
      if (count < 2) return JSON.stringify({ done: false });
      return JSON.stringify({ done: true, result: { ok: 1 } });
    },
    cancel() { return true; },
  };
  const out = await callNativeJob(bridge, { cmd: "legacy" });
  assert.deepEqual(out, { ok: 1 });
  assert.equal(count, 2);
});

await test("模型流唤醒：__zcodeModelWake 推送 headers/chunk/done 无多余轮询", async () => {
  const { mobileModelFetch } = await loadTsModule(resolve(here, "../ui/model-transport.ts"));
  const packets = [];
  let pollCalls = 0;
  const prevBridge = globalThis.zcodeModelHttp;
  globalThis.zcodeModelHttp = {
    start() {
      setTimeout(() => {
        packets.push({ status: 200, headers: { "content-type": "text/event-stream" } });
        globalThis.__zcodeModelWake?.("model-1");
      }, 10);
      setTimeout(() => {
        packets.push({ bodyBase64: Buffer.from("data: hi\n\n").toString("base64") });
        globalThis.__zcodeModelWake?.("model-1");
      }, 25);
      setTimeout(() => {
        packets.push({ done: true });
        globalThis.__zcodeModelWake?.("model-1");
      }, 40);
      return JSON.stringify({ id: "model-1" });
    },
    poll() {
      pollCalls += 1;
      return JSON.stringify(packets.shift() ?? {});
    },
    cancel() { return true; },
  };
  try {
    const res = await mobileModelFetch("https://api.example.com/v1/chat/completions", {
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, "data: hi\n\n");
    assert.ok(pollCalls <= 5, `期望仅在初始与 3 次 wake 时 poll，实际 poll=${pollCalls}`);
  } finally {
    globalThis.zcodeModelHttp = prevBridge;
  }
});

console.log(`bridge-async-smoke: ${results.length}/${results.length} PASS`);
for (const name of results) console.log(`  ✓ ${name}`);
