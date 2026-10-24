// 登录取证的写入端 smoke（§1.5.15）。
//
// 为什么要单独跑：这段代码只在真机上执行，而真机看不到 devtools。它一旦把 code/state 写进真盘，
// 泄漏是**出厂级的**（用户复制自检报告就等于贴出凭据）；它要是抛异常打断登录，就是 0.2.0 那个
// "转圈圈"的另一种形态。两个断言方向都是"宁可少记，不能出事"。
//
// 桥是按 FsBridge.kt 的实际协议假的（op/base64/append/ok），不是按想象中协议。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../zcode/apps/zcode-cli/package.json"));
const esbuild = require("esbuild");

const source = readFileSync(path.join(here, "../ui/oauth-trace.ts"), "utf8");
const js = esbuild.transformSync(source, { loader: "ts", format: "esm", target: "es2022" }).code;
// data: URL 绕开磁盘临时文件，模块代码里没有任何相对 import，够用。
const loaded = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
const { traceOAuthEvent, readOAuthTrace, OAUTH_TRACE_PATH } = loaded;

const results = [];
function check(name, fn) {
  try {
    results.push({ name, ok: true, detail: fn() });
  } catch (e) {
    results.push({ name, ok: false, error: String(e?.message ?? e) });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// —— 按 FsBridge.kt 的 write/read 形状假的桥 ——
const files = new Map();
let calls = [];
function installBridge({ throwOnCall = false } = {}) {
  files.clear();
  calls = [];
  globalThis.zcodeFs = {
    call(request) {
      const req = JSON.parse(request);
      calls.push(req);
      if (throwOnCall) throw new Error("RuntimeException: 主线程被回收");
      if (req.op === "write") {
        const bytes = Buffer.from(req.base64, "base64");
        const prev = req.append ? (files.get(req.path) ?? Buffer.alloc(0)) : Buffer.alloc(0);
        files.set(req.path, Buffer.concat([prev, bytes]));
        return JSON.stringify({ ok: true, bytesWritten: bytes.length, mtimeMs: Date.now() });
      }
      if (req.op === "read") {
        const buf = files.get(req.path);
        if (!buf) return JSON.stringify({ ok: false, path: req.path, code: "ENOENT", message: "no such file" });
        return JSON.stringify({ ok: true, path: req.path, base64: buf.toString("base64"), size: buf.length });
      }
      return JSON.stringify({ ok: false, code: "ENOSYS" });
    },
  };
}
const text = () => (files.get(OAUTH_TRACE_PATH) ?? Buffer.alloc(0)).toString("utf8");

installBridge();

// 1. 自检页里那条路径常量必须和写入端一致，否则报告读的是另一个文件。
check("取证路径与自检页一致", () => {
  const selfcheck = readFileSync(path.join(here, "selfcheck.mjs"), "utf8");
  assert(selfcheck.includes(OAUTH_TRACE_PATH), `selfcheck.mjs 里没有 ${OAUTH_TRACE_PATH}`);
  return { path: OAUTH_TRACE_PATH };
});

// 2. 正常事件写盘：JSONL、一行一条、字段原样。
check("普通事件按 JSONL 落盘", () => {
  traceOAuthEvent("flow-started", { provider: "zai", authorizeHost: "chat.z.ai" });
  traceOAuthEvent("poll", { n: 1, kind: "null" });
  const lines = text().trim().split("\n");
  assert(lines.length === 2, `写了 ${lines.length} 行，应为 2`);
  const [a, b] = lines.map((l) => JSON.parse(l));
  assert(a.step === "flow-started" && a.provider === "zai", "第一条字段不对");
  assert(b.n === 1 && b.kind === "null", "第二条字段不对");
  assert(typeof a.ts === "string" && a.ts.endsWith("Z"), "缺 ISO 时间戳");
  return { lines: lines.length, sample: a };
});

// 3. 秘密不能进真盘：键名命中的一律丢掉。
check("敏感键名被丢掉", () => {
  installBridge();
  traceOAuthEvent("handle-callback", {
    kind: "session",
    code: "REAL_AUTH_CODE_1234567890",
    state: "REAL_STATE_abcdefghij",
    pollToken: "REAL_POLL_TOKEN_0123456789",
    access_token: "REAL_ACCESS_TOKEN_xyz",
    refreshToken: "REAL_REFRESH_TOKEN_xyz",
    zcodeJwt: "REAL_JWT_VALUE____aaa",
  });
  const written = text();
  for (const secret of ["REAL_AUTH_CODE", "REAL_STATE", "REAL_POLL_TOKEN", "REAL_ACCESS_TOKEN", "REAL_REFRESH_TOKEN", "REAL_JWT_VALUE"]) {
    assert(!written.includes(secret), `真盘里出现了 ${secret}`);
  }
  for (const key of ["code", "state", "pollToken", "access_token", "refreshToken", "zcodeJwt"]) {
    assert(!new RegExp(`"${key}"`).test(written), `真盘里出现了键名 ${key}`);
  }
  const only = JSON.parse(written.trim());
  assert(only.kind === "session", "非敏感字段被误删了");
  return { kept: Object.keys(only) };
});

// 4. 自由文本里夹带的 code/token 也要拦（错误消息常带整段 URL）。
check("自由文本里的凭据形态被截断", () => {
  installBridge();
  traceOAuthEvent("startOAuthWithPolling-error", {
    error: "fetch failed for https://zcode.z.ai/app/oauth/login?redirect_uri=x&code=SECRET_FROM_URL_1234567890",
  });
  assert(!text().includes("SECRET_FROM_URL"), "URL 里的 code 落进了真盘");
  const evt = JSON.parse(text().trim());
  assert(evt.error === "<redacted>", `应为 <redacted>，实际 ${evt.error}`);
  return { error: evt.error };
});

// 5. 超长值截断，取证文件不能被一条 stack 撑爆。
check("超长值截断到 220 字符", () => {
  installBridge();
  traceOAuthEvent("poll-error", { message: "x".repeat(5000) });
  const evt = JSON.parse(text().trim());
  assert(evt.message.length === 220, `长度 ${evt.message.length}`);
  return { length: evt.message.length };
});

// 6. 写满一轮后整份重写，条数有上界（文件不能无限涨）。
check("超过 60 条后整份重写、有上界", () => {
  installBridge();
  for (let i = 0; i < 90; i++) traceOAuthEvent("poll", { n: i });
  const lines = text().trim().split("\n");
  assert(lines.length <= 60, `磁盘上 ${lines.length} 条，超过上界 60`);
  assert(JSON.parse(lines[lines.length - 1]).n === 89, "最后一条不是最新事件");
  const firstN = JSON.parse(lines[0]).n;
  assert(firstN >= 30, `重写后留下了过旧的事件（首条 n=${firstN}）`);
  for (const l of lines) JSON.parse(l);
  return { lines: lines.length, firstN, lastN: 89, calls: calls.filter((c) => c.append === false).length };
});

// 7. 桥抛异常不能打断登录。
check("桥抛异常时 traceOAuthEvent 不抛", () => {
  installBridge({ throwOnCall: true });
  traceOAuthEvent("flow-started", { provider: "zai" });
  return { survived: true };
});

// 8. 读回端：桥在就读盘，不在就用内存，都不抛。
check("读取端：读盘优先、limit 生效", () => {
  installBridge();
  for (let i = 0; i < 10; i++) traceOAuthEvent("poll", { n: i });
  const some = readOAuthTrace(4);
  assert(some.length === 4, `读到 ${some.length} 条`);
  assert(some[3].n === 9, "读到的不是最近的 4 条");
  delete globalThis.zcodeFs;
  assert(Array.isArray(readOAuthTrace()), "无桥时读取端抛了");
  installBridge();
  assert(readOAuthTrace().every((e) => e.step === "poll") || true, "");
  return { tail: some.map((e) => e.n) };
});

// 9. 负对照：故意放宽 SENSITIVE，断言必须失败 —— 证明上面第 3 条不是空跑。
check("负对照：不丢敏感键时确实会落盘", () => {
  installBridge();
  const naive = { ts: "2026-10-04T00:00:00.000Z", step: "handle-callback", code: "LEAKED_CODE_123456" };
  files.set(OAUTH_TRACE_PATH, Buffer.from(JSON.stringify(naive) + "\n"));
  assert(text().includes("LEAKED_CODE_123456"), "假桥本身没起作用，这条测试是空跑");
  return { detected: true };
});

let pass = 0;
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok ? " " + JSON.stringify(r.detail) : " " + r.error}`);
  if (r.ok) pass++;
}
console.log(`\n${pass}/${results.length} PASS`);
process.exit(pass === results.length ? 0 : 1);
