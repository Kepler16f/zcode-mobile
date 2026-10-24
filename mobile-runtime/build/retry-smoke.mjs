// 自动重连的单元冒烟（0.4.10，用户点名"支持类似桌面端的自动重连机制"）。
//
// 桌面端的重连在 AI SDK 层（streamText 的 maxRetries），端侧手写 fetch/SSE 没有这层——
// streamModelCompletionWithRetry 补的正是这个缺口。这条冒烟钉死它的四个语义：
//  ① 连接失败（model.network）会重试，成功后文本只有一份；
//  ② 已经吐过增量的请求**不重试**（旧文本会被重复贴一遍——桌面 SDK 同款取舍）；
//  ③ 不可重试类（401 业务/鉴权）一次都不重；
//  ④ 用户在退避等待中点了停止 → 不再重试，错误原样抛出。
// 重试节奏用注入的毫秒级退避（retryBaseWaitMs），测试不真等 1s/2s。
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

const tmp = path.join(os.tmpdir(), `azcode-retry-${Date.now()}.mjs`);
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
const { streamModelCompletionWithRetry, ModelStreamError } = mod;

let pass = 0, fail = 0;
function check(name, cond, evidence = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  → ${evidence}`}`);
  cond ? pass++ : fail++;
}

const TARGET = { apiFormat: "openai-chat-completions", baseUrl: "http://retry.test/v1", apiKey: "k", model: "m" };
const MSGS = [{ role: "user", content: "hi" }];

const sseFrame = (content) => JSON.stringify({
  id: "x", object: "chat.completion.chunk", created: 1, model: "m",
  choices: [{ index: 0, delta: { content }, finish_reason: null }],
});
function sseResponse(frames) {
  const body = new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(new TextEncoder().encode(`data: ${f}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return { ok: true, status: 200, headers: new Headers({ "content-type": "text/event-stream" }), body };
}
function errorStatus(status) {
  return { ok: false, status, headers: new Headers({ "content-type": "text/plain" }), body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"error":"nope"}')); c.close(); } }) };
}

const original = globalThis.fetch;
function sequence(...behaviors) {
  let call = 0;
  globalThis.fetch = async (url, init) => {
    const b = behaviors[Math.min(call, behaviors.length - 1)];
    call++;
    if (b instanceof Error) throw b;
    if (typeof b === "function") return b(init);
    return b;
  };
  return () => call;
}
const restore = () => { globalThis.fetch = original; };

// ① 连接失败 → 重试 → 成功：文本一份、恰好两次请求、onRetry 报过一次
{
  const attempts = sequence(new TypeError("Failed to fetch"), sseResponse([sseFrame("你好")]));
  const retries = [];
  let text = "";
  const r = await streamModelCompletionWithRetry({
    target: TARGET, messages: MSGS,
    onDelta: (t) => { text += t; },
    onRetry: (attempt, waitMs, reason) => retries.push({ attempt, reason }),
    retryBaseWaitMs: 10,
  });
  check("①连接失败自动重连成功", r.text === "你好" && text === "你好" && attempts() === 2,
    `text=${JSON.stringify(text)} attempts=${attempts()} retries=${JSON.stringify(retries)}`);
  check("①onRetry 报出原因码", retries.length === 1 && retries[0].reason === "model.network" && retries[0].attempt === 2, JSON.stringify(retries));
  restore();
}

// ② 吐了一半才断（model.stream）→ **不重试**、错误上抛（重复贴文本是不可接受的）
{
  let first = true;
  const halfBroken = {
    ok: true, status: 200, headers: new Headers({ "content-type": "text/event-stream" }),
    // pull 只在"首帧已被读走、队列空"时被调——那才是真机的"吐了一帧后连接断"时序；
    // start 里同步 error 会让 read() 直接 reject（deltas=0），测不到 sawDelta 护栏。
    body: new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(`data: ${sseFrame("半句")}\n\n`)); },
      pull(c) {
        if (first) { first = false; return; } // 首帧进队列，先让消费方读走
        c.error(new TypeError("socket hang up"));
      },
    }),
  };
  globalThis.fetch = async () => halfBroken;
  let threw = null;
  let deltas = 0;
  try {
    await streamModelCompletionWithRetry({
      target: TARGET, messages: MSGS, onDelta: () => { deltas++; }, retryBaseWaitMs: 10,
    });
  } catch (e) { threw = e; }
  check("②已吐增量再断：不重试、原样抛", threw instanceof ModelStreamError && deltas >= 1,
    `threw=${threw?.constructor?.name}:${threw?.reasonCode ?? "-"} deltas=${deltas}`);
  restore();
}

// ③ 401（鉴权类）：一次都不重试
{
  const attempts = sequence(errorStatus(401));
  let threw = null;
  try {
    await streamModelCompletionWithRetry({
      target: TARGET, messages: MSGS, onDelta: () => {}, retryBaseWaitMs: 10,
    });
  } catch (e) { threw = e; }
  check("③401 不可重试（恰好一次请求）", threw instanceof ModelStreamError && attempts() === 1,
    `threw=${threw?.reasonCode ?? "-"} attempts=${attempts()}`);
  restore();
}

// ④ 用户在退避等待里点了停止：不再重试，原错抛出
{
  let attempts = 0;
  const ac = new AbortController();
  globalThis.fetch = async () => { attempts++; throw new TypeError("Failed to fetch"); };
  const p = streamModelCompletionWithRetry({
    target: TARGET, messages: MSGS, signal: ac.signal, onDelta: () => {}, retryBaseWaitMs: 1000,
  });
  await new Promise((r) => setTimeout(r, 50)); // 第一次请求已失败、正在退避等待中
  ac.abort();
  let threw = null;
  try { await p; } catch (e) { threw = e; }
  check("④退避等待中停止：不再重试", threw !== null && attempts === 1,
    `threw=${threw?.constructor?.name ?? "-"} attempts=${attempts}`);
  restore();
}

// ⑤ 三次尝试用尽：最后一次错误上抛，runTurn 会 settle failed（composer 恢复可用）
{
  const attempts = sequence(
    new TypeError("net1"),
    new TypeError("net2"),
    new TypeError("net3"),
  );
  let threw = null;
  try {
    await streamModelCompletionWithRetry({
      target: TARGET, messages: MSGS, onDelta: () => {}, retryBaseWaitMs: 10,
    });
  } catch (e) { threw = e; }
  check("⑤3 次用尽后如实抛错", threw instanceof ModelStreamError && threw.reasonCode === "model.network" && attempts() === 3,
    `threw=${threw?.reasonCode ?? "-"} attempts=${attempts()}`);
  restore();
}

console.log(`\n自动重连冒烟：${pass}/${pass + fail} PASS`);
process.exit(fail > 0 ? 1 : 0);
