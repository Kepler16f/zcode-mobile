// 0.5.1 两条修复的单元冒烟：思考档位上请求体（thought→wire）＋ 看门狗"迟到即赦免"。
//
// 截断问题（用户："对话有时候到一半就中途被截断"）的两条根因通道：
//  ① 看门狗在后台冻结后准点误杀——切后台 timer 冻结，回前台积压 timer 立刻触发，
//     elapsed 远超上限。修法："迟到即赦免"（elapsed > 3×上限 或页面 hidden → 重新计时）。
//  ② 输出预算 4096 → finish_reason=length 拦腰截断。修法：预算放宽 + length 可见化（agent 侧）。
// 思考档位（用户："调节似乎是无效的"）：config.thought 原先只写不读，请求体里没有任何
//  reasoning 字段。修法：档位随 selection 走到 target，buildRequest 按格式拼标准字段。
//
// 本文件钉的是 ① 的赦免语义与 ② 的请求体形状（agent 侧的 length 标注与预算收紧在
// chat-smoke/e2e 层，那里有整轮 harness）。
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

const tmp = path.join(os.tmpdir(), `azcode-thought-${Date.now()}.mjs`);
process.on("unhandledRejection", (e) => {
  console.error("[unhandledRejection]", e instanceof Error ? `${e.name}: ${e.message}` : e);
  if (e instanceof Error && e.stack) console.error(e.stack.split("\n").slice(1, 4).join("\n"));
});
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
const { streamModelCompletion, reasoningBodyFields, ModelStreamError } = mod;

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
const expect = (cond, why) => {
  if (!cond) throw new Error(why);
};

const TARGET = { apiFormat: "openai-chat-completions", baseUrl: "http://t.test/v1", apiKey: "k", model: "m" };
const MSGS = [{ role: "user", content: "hi" }];
const sseFrame = (content) => ({
  id: "x",
  object: "chat.completion.chunk",
  created: 1,
  model: "m",
  choices: [{ index: 0, delta: { content }, finish_reason: null }],
});

// ── ① 看门狗：迟到即赦免 ──

function installFakeFetch({ hangForever = false, hangUntilRelease = null } = {}) {
  const original = globalThis.fetch;
  let rejectRead = null;
  globalThis.fetch = async (_url, init) => {
    const encoder = new TextEncoder();
    init?.signal?.addEventListener?.("abort", () => rejectRead?.(new Error("aborted")));
    const body = new ReadableStream({
      pull(ctrl) {
        return new Promise((resolve, reject) => {
          rejectRead = reject;
          if (hangUntilRelease) {
            // 挂住直到测试显式放行：watchdog 的迟到判定与取帧互不竞争（确定性）。
            // 放行时流可能已被 watchdog abort（error 态）——enqueue 会再抛一个
            // "Controller is already closed"，那是测试夹具的次生噪音，吞掉。
            hangUntilRelease
              .then(() => {
                ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(sseFrame("好"))}\n\n`));
                ctrl.enqueue(encoder.encode("data: [DONE]\n\n"));
                ctrl.close();
                resolve();
              })
              .catch(() => {});
            return;
          }
          if (hangForever) return; // 永不给帧：模拟"网关死了"（真死锁，前台准点要掐）
          ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(sseFrame("好"))}\n\n`));
          ctrl.enqueue(encoder.encode("data: [DONE]\n\n"));
          ctrl.close();
          resolve();
        });
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return () => (globalThis.fetch = original);
}

/** 同步堵死事件循环 ms 毫秒：让已到点的 setTimeout"迟到"——复刻后台冻结后回前台的积压触发。 */
function blockEventLoop(ms) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

await check("①a 页面隐藏时看门狗不误杀：hidden → 赦免重新计时，回前台照常收口", async () => {
  // 后台冻结的产品语义：页面 hidden 期间 timer 被宿主冻结/积压，fire 时必须赦免而不是 abort。
  // 这里直接钉 hidden 分支（比 Atomics 堵循环确定——那条路在 CI 机器上会跟 deadline 赛跑）。
  let release;
  const gate = new Promise((r) => (release = r));
  const restoreFetch = installFakeFetch({ hangUntilRelease: gate });
  const realDocument = globalThis.document;
  globalThis.document = { visibilityState: "hidden" };
  try {
    const p = streamModelCompletion({
      target: TARGET,
      messages: MSGS,
      onDelta: () => {},
      firstByteTimeoutMs: 30,
      frameIdleTimeoutMs: 30,
    });
    // 看门狗在 hidden 期间到点若干次（每次赦免重计）；放行取帧后流正常收口。
    await new Promise((r) => setTimeout(r, 100));
    release();
    globalThis.document = realDocument; // "回到前台"
    const r = await p;
    expect(r.text === "好", `流应正常完成，得到 ${JSON.stringify(r.text)}`);
    return { text: r.text, forgivenWhileHidden: true };
  } finally {
    globalThis.document = realDocument;
    restoreFetch();
  }
});

await check("①b 前台真死锁仍然准点掐：hangForever → model.streamIdle", async () => {
  const restore = installFakeFetch({ hangForever: true });
  try {
    let code = "";
    try {
      await streamModelCompletion({
        target: TARGET,
        messages: MSGS,
        onDelta: () => {},
        firstByteTimeoutMs: 60,
        frameIdleTimeoutMs: 60,
      });
    } catch (e) {
      code = e instanceof ModelStreamError ? e.reasonCode : String(e);
    }
    expect(code === "model.streamIdle", `期望 model.streamIdle，得到 ${code}`);
    return { code };
  } finally {
    restore();
  }
});

// ── ② 思考档位 → 请求体 ──

await check("②a 未选档位：请求体不带任何 reasoning 字段（与 0.5.0 逐字节一致）", async () => {
  expect(reasoningBodyFields({ apiFormat: "openai-chat-completions" }) === null, "空档位应返回 null");
  expect(reasoningBodyFields({ apiFormat: "openai-chat-completions", reasoningLevel: "" }) === null, "空串应返回 null");
  return { clean: true };
});

await check("②b GLM 二值档位 → thinking.type", async () => {
  const on = reasoningBodyFields({ apiFormat: "openai-chat-completions", reasoningLevel: "enabled" });
  const off = reasoningBodyFields({ apiFormat: "openai-chat-completions", reasoningLevel: "disabled" });
  expect(JSON.stringify(on) === '{"thinking":{"type":"enabled"}}', `enabled: ${JSON.stringify(on)}`);
  expect(JSON.stringify(off) === '{"thinking":{"type":"disabled"}}', `disabled: ${JSON.stringify(off)}`);
  return { on, off };
});

await check("②c 档位型 → reasoning_effort（GLM-5.2 high/max、GLM-5.3 low）", async () => {
  const high = reasoningBodyFields({ apiFormat: "openai-chat-completions", reasoningLevel: "high" });
  const max = reasoningBodyFields({ apiFormat: "openai-chat-completions", reasoningLevel: "max" });
  const low = reasoningBodyFields({ apiFormat: "openai-chat-completions", reasoningLevel: "low" });
  expect(high?.reasoning_effort === "high", `high: ${JSON.stringify(high)}`);
  expect(max?.reasoning_effort === "max", `max: ${JSON.stringify(max)}`);
  expect(low?.reasoning_effort === "low", `low: ${JSON.stringify(low)}`);
  return { high, max, low };
});

await check("②d 模型声明了 values 而档位不在列内 → 不发（宁可无效不 400）", async () => {
  const out = reasoningBodyFields({
    apiFormat: "openai-chat-completions",
    reasoningLevel: "xhigh",
    reasoningValues: ["disabled", "enabled"],
  });
  expect(out === null, `应为 null，得到 ${JSON.stringify(out)}`);
  const ok = reasoningBodyFields({
    apiFormat: "openai-chat-completions",
    reasoningLevel: "max",
    reasoningValues: ["disabled", "high", "max"],
  });
  expect(ok?.reasoning_effort === "max", `列内应放行: ${JSON.stringify(ok)}`);
  return { guarded: true };
});

await check("②e anthropic：effort → thinking.budget_tokens，且被 max_tokens 收口", async () => {
  const hi = reasoningBodyFields({ apiFormat: "anthropic-messages", reasoningLevel: "high" });
  expect(hi?.thinking?.type === "enabled" && hi.thinking.budget_tokens === 8192, `high: ${JSON.stringify(hi)}`);
  const off = reasoningBodyFields({ apiFormat: "anthropic-messages", reasoningLevel: "disabled" });
  expect(off?.thinking?.type === "disabled", `disabled: ${JSON.stringify(off)}`);
  return { hi, off };
});

await check("②f responses：effort → reasoning.effort；off 不发", async () => {
  const low = reasoningBodyFields({ apiFormat: "openai-responses", reasoningLevel: "low" });
  expect(low?.reasoning?.effort === "low", `low: ${JSON.stringify(low)}`);
  const off = reasoningBodyFields({ apiFormat: "openai-responses", reasoningLevel: "disabled" });
  expect(off === null, `off 应为 null: ${JSON.stringify(off)}`);
  return { low, offClean: off === null };
});

await check("②g 整请求体：选了档位才进 body，没选逐字节不变", async () => {
  let captured = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init?.body ?? "{}");
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(sseFrame("好"))}\n\ndata: [DONE]\n\n`));
        ctrl.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    await streamModelCompletion({ target: { ...TARGET, reasoningLevel: "max" }, messages: MSGS, onDelta: () => {} });
    expect(captured.reasoning_effort === "max", `带档位应有 reasoning_effort: ${JSON.stringify(captured)}`);
    captured = null;
    await streamModelCompletion({ target: TARGET, messages: MSGS, onDelta: () => {} });
    expect(!("reasoning_effort" in captured) && !("thinking" in captured), `不带档位不应有任何 reasoning 字段: ${JSON.stringify(captured)}`);
    return { wired: true };
  } finally {
    globalThis.fetch = original;
  }
});

const passed = results.filter((r) => r.ok).length;
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.why}`);
console.log(`思考档位/看门狗冒烟：${passed}/${results.length} PASS`);
if (passed !== results.length) process.exit(1);
