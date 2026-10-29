import assert from "node:assert/strict";
import { callNativeJob } from "../ports/native-async.mjs";
import { createNativeExecBridge } from "../ports/execution-bridge-android.mjs";
import { createMobileExecutionPort } from "../ports/execution.mjs";

const pending = new Map();
let next = 0;
let cancelled = 0;
const fake = {
  start(payload) {
    const id = String(++next);
    const request = JSON.parse(payload);
    pending.set(id, request);
    return JSON.stringify({ id });
  },
  poll(id) {
    const request = pending.get(id);
    if (!request) return JSON.stringify({ error: "missing" });
    if (request.hold) return JSON.stringify({ done: false });
    pending.delete(id);
    return JSON.stringify({ done: true, result: { exitCode: 0, stdout: "ok", stderr: "" } });
  },
  cancel(id) { cancelled++; pending.delete(id); return true; },
};

const controller = new AbortController();
let timerRan = false;
const waiting = callNativeJob(fake, { hold: true }, controller.signal);
setTimeout(() => { timerRan = true; controller.abort(); }, 10);
await assert.rejects(waiting, (error) => error.name === "AbortError");
assert.equal(timerRan, true, "异步等待期间必须让事件循环运行");
assert.equal(cancelled, 1, "取消必须通知原生任务一次");

globalThis.zcodeExec = { ...fake, exec() { throw new Error("不能退回同步入口"); } };
const bridge = createNativeExecBridge();
const port = createMobileExecutionPort({ bridge });
const result = await port.run({ command: { mode: "shell", command: "echo ok" } });
assert.equal(result.status, "completed");
assert.equal(result.stdout.text, "ok");

const activeAbort = new AbortController();
const originalStart = globalThis.zcodeExec.start;
globalThis.zcodeExec.start = (payload) => originalStart(JSON.stringify({ ...JSON.parse(payload), hold: true }));
const running = port.run({ command: { mode: "shell", command: "sleep 60" } }, { signal: activeAbort.signal });
setTimeout(() => activeAbort.abort(), 10);
const stopped = await running;
assert.equal(stopped.cancelled, true);
assert.equal(stopped.status, "cancelled");
assert.equal(cancelled, 2);

let nativeStopped = false;
let returned = false;
const delayed = {
  start: () => JSON.stringify({ id: "delayed" }),
  poll: () => JSON.stringify(nativeStopped ? { done: true, result: { cancelled: true } } : { done: false }),
  cancel: () => { setTimeout(() => { nativeStopped = true; }, 80); return true; },
};
const cancelAfter = new AbortController();
const delayedResult = callNativeJob(delayed, {}, cancelAfter.signal).finally(() => { returned = true; });
cancelAfter.abort();
await new Promise(resolve => setTimeout(resolve, 25));
assert.equal(returned, false, "原生任务未停止时不能提前执行回写");
await assert.rejects(delayedResult, error => error.name === "AbortError");
assert.equal(nativeStopped, true);

globalThis.zcodeExec = { exec() { return JSON.stringify({ exitCode: 0, stdout: "legacy", stderr: "" }); } };
const legacy = await createNativeExecBridge().exec({ shell: true, command: "echo legacy" });
assert.equal(legacy.stdout, "legacy");
console.log("native async bridge: 5/5 PASS");
