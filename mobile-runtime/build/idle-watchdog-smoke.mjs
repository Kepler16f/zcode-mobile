// 空闲看门狗的单元冒烟（0.4.6：装机反馈"输入框有时自己卡住，要新建对话才能用"）。
//
// 根因（源码读数，非猜）：ConversationComposer.tsx:2255 `disabled = disabled || mode === "reject"`，
// 端侧 inputRouting 是 running?reject（agent.ts:236），而 streamModelCompletion 此前**没有任何
// 空闲上限**——网关连上 headers 后不吐字节（慢查询/代理挂起/SSE 半开），reader.read() 永远挂着、
// runTurn 永不 settle → session.run 一直非空 → composer 永久禁用，正是用户撞到的那个"卡死"。
//
// 这条冒烟钉死修好的那部分：超时用注入的毫秒级（默认 45s/30s 在真机合理，测试不可能真等），
// 假 fetch 的 body 流监听 signal.abort ——和真 fetch 收到 signal 后的行为一致，看门狗 abort 时
// 挂住的 read() 才会 reject，从而把 model.streamIdle 抛出来。
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

const tmp = path.join(os.tmpdir(), `azcode-idle-${Date.now()}.mjs`);
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
const { streamModelCompletion, ModelStreamError } = mod;

const results = [];
const check = async (name, fn) => {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, detail });
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, why: String(e?.message ?? e).slice(0, 300) });
  }
};

const TARGET = { apiFormat: "openai-chat-completions", baseUrl: "http://idle.test/v1", apiKey: "k", model: "m" };
const MSGS = [{ role: "user", content: "hi" }];

const sseFrame = (content) => ({
  id: "x",
  object: "chat.completion.chunk",
  created: 1,
  model: "m",
  choices: [{ index: 0, delta: { content }, finish_reason: null }],
});

/**
 * 装一条假 fetch：headers 先给，body 按 frames 吐。两种收尾：
 *   - closeAfter=true（正常流）：frames 吐完后 ctrl.close() → read() 返回 done → 用例正常收口；
 *   - closeAfter=false（卡住）：frames 吐完后 pull 里那个 Promise 永不 resolve——复刻"网关半开不吐字节"；
 *     一旦 signal 被 abort，用 rejectRead 打断挂住的 read（复刻真 fetch 的 abort→reject 语义），
 *     否则看门狗"叫得响但没人应"，测的就不是真链路。
 */
function installFakeFetch(frames, { closeAfter = true, errorBody = false } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const encoder = new TextEncoder();
    let i = 0;
    let rejectRead = null;
    init?.signal?.addEventListener?.("abort", () => rejectRead?.(new Error("aborted")));
    const body = new ReadableStream({
      pull(ctrl) {
        return new Promise((resolve, reject) => {
          rejectRead = reject;
          if (errorBody && i >= frames.length) {
            ctrl.error(new Error("boom mid-stream"));
            resolve();
            return;
          }
          if (i < frames.length) {
            ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(frames[i++])}\n\n`));
            resolve();
            return;
          }
          if (closeAfter) {
            // 正常流：补一帧 [DONE] 再 close，让 reader 循环干净退出（consumeFrame 会忽略它）。
            ctrl.enqueue(encoder.encode("data: [DONE]\n\n"));
            ctrl.close();
            resolve();
            return;
          }
          // 卡住：永不 resolve，直到 signal.abort 用 rejectRead 打断。
        });
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return () => (globalThis.fetch = original);
}

const collect = [];
const onDelta = (t) => collect.push(t);

await check("正常流不受影响：看门狗全程续期、不报错", async () => {
  const restore = installFakeFetch([sseFrame("你"), sseFrame("好")]);
  try {
    const r = await streamModelCompletion({
      target: TARGET,
      messages: MSGS,
      onDelta,
      // 故意给极宽的窗口：它们不该被触发，正常两帧早就跑完了。
      firstByteTimeoutMs: 5_000,
      frameIdleTimeoutMs: 5_000,
    });
    if (r.text !== "你好") throw new Error("文本不对: " + JSON.stringify(r.text));
    return { text: r.text, deltas: collect.length };
  } finally {
    restore();
    collect.length = 0;
  }
});

await check("首字节前卡住 → model.streamIdle（45s/30s 用注入值 60ms 代跑）", async () => {
  const restore = installFakeFetch([], { closeAfter: false }); // headers 给完就再也不吐字节
  try {
    let err = null;
    try {
      await streamModelCompletion({ target: TARGET, messages: MSGS, onDelta, firstByteTimeoutMs: 60, frameIdleTimeoutMs: 60 });
    } catch (e) {
      err = e;
    }
    if (!(err instanceof ModelStreamError)) throw new Error("没抛 ModelStreamError：" + String(err));
    if (err.reasonCode !== "model.streamIdle") throw new Error("reasonCode 不对：" + err.reasonCode);
    if (!/没有响应|终止|重发/.test(err.message)) throw new Error("文案丢了行动指引：" + err.message);
    return { reasonCode: err.reasonCode };
  } finally {
    restore();
  }
});

await check("吐了一帧后卡住 → 仍报 model.streamIdle（帧间上限独立生效）", async () => {
  const restore = installFakeFetch([sseFrame("第一段")], { closeAfter: false }); // 第二帧永不到
  try {
    let err = null;
    try {
      await streamModelCompletion({ target: TARGET, messages: MSGS, onDelta, firstByteTimeoutMs: 5_000, frameIdleTimeoutMs: 80 });
    } catch (e) {
      err = e;
    }
    if (!(err instanceof ModelStreamError)) throw new Error("没抛 ModelStreamError：" + String(err));
    if (err.reasonCode !== "model.streamIdle") throw new Error("reasonCode 不对：" + err.reasonCode);
    // 第一帧的 delta 必须已经吐给 UI（"半截答案"比整轮挂死诚实），这是 onDelta 的既有契约。
    if (!collect.includes("第一段")) throw new Error("首帧 delta 没上报：" + JSON.stringify(collect));
    return { reasonCode: err.reasonCode, partialDeltas: collect.length };
  } finally {
    restore();
    collect.length = 0;
  }
});

await check("用户主动停止（外部 signal）仍是原语义：不被看门狗改写成 idle", async () => {
  const restore = installFakeFetch([], { closeAfter: false });
  try {
    const ctrl = new AbortController();
    let err = null;
    setTimeout(() => ctrl.abort(), 40);
    try {
      await streamModelCompletion({
        target: TARGET,
        messages: MSGS,
        onDelta,
        signal: ctrl.signal,
        // 外部 abort 在 40ms 到、看门狗 2s 才到：先到的必须是用户那条。
        firstByteTimeoutMs: 2_000,
        frameIdleTimeoutMs: 2_000,
      });
    } catch (e) {
      err = e;
    }
    // 真 fetch abort 会 reject 一个 AbortError；runTurn 靠 params.signal.aborted 判 interrupted，
    // 看门狗不能抢这个判断（idleTimedOut 仍 false）。这里断言它没被伪装成 idle。
    if (err && err.reasonCode === "model.streamIdle") throw new Error("用户停止被看门狗冒充了");
    return { threw: err ? String(err.name ?? err.message ?? err).slice(0, 60) : "none" };
  } finally {
    restore();
  }
});

const failed = results.filter((r) => r.ok === false);
for (const r of results)
  process.stdout.write(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? `  ${JSON.stringify(r.detail)}` : `  → ${r.why}`}\n`);
process.stdout.write(`\n空闲看门狗冒烟：${results.length - failed.length}/${results.length} PASS\n`);
process.exit(failed.length ? 1 : 0);
