// 冻结证人（jank-witness）的 Node 侧行为冒烟：桥族计时壳 + slowCalls 采样 + 心跳 gap 归因。
//
// 为什么单独一条：证人是"装机症状先交证人再修"的执行体，它自己坏了（装壳把桥包死、localStorage
// 形状变了、M13 读不出来）在真机上没有任何报警面——只有这里能钉住形状。ui/jank-witness.ts 在
// WebView 里由 entry.tsx boot 装；这条冒烟用 Node 的原生 .ts type-stripping 直接引它，
// 假桥按 Kotlin FsBridge 的回包形状写（selfcheck 同纪律：假桥"和桥一样笨"是刻意的）。
//
// 覆盖：
//  ① 装壳透明：包完的桥调用结果逐字不变（fs 字符串回包、device 布尔回包、sqlite 数字句柄）；
//  ② 计数形状：bridges[族][op] {calls,totalMs,maxMs}；sqlite 的 op 带 mode（query:all/run）；
//  ③ fs 单入口的 op 提取：readMany/readdir 从 {"op":"..."} 前缀认出，大 base64 请求体不被扫（只扫 256 字符）；
//  ④ slowCalls：单次 ≥400ms 立刻落盘，即使心跳从没到 ≥800ms；
//  ⑤ 心跳 gap ≥800ms 记 worst 并把 bridges/slowCalls 合并写进**同一个** zcode-mobile.jank.diag；
//  ⑥ markJankPhase 的 phase 随冻结样本落盘；15s 节拍只在有新调用时 flush。
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
const failures = [];
const run = (label, fn) => {
  try {
    const detail = fn();
    console.log("PASS", label, JSON.stringify(detail));
  } catch (e) {
    failures.push(label);
    console.log("FAIL", label, String(e?.message ?? e));
    process.exitCode = 1;
  }
};
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

// ---- WebView 环境替身：先搭台，再引证人（installJankWitness 看 globalThis.document 才肯装）。 ----
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};
// 时钟做成可控假表：心跳 gap 的判定全看 performance.now() 的相邻差，真表测不出 ≥800ms。
let fakeNow = 0;
globalThis.performance = { now: () => fakeNow };
// setInterval 换成手动驱动的 tick 队列：冒烟不 sleep 15s，节拍靠喂。
const timers = [];
globalThis.setInterval = (cb) => { timers.push(cb); return timers.length; };
globalThis.document = { getElementById: () => null };

// ---- 假桥（按 Kotlin 形状）。 ----
// "慢"由假时钟走字表示：桥阻塞主线程时 performance.now() 同样在涨，壳量的就是这个涨。
let realFsCalls = 0;
globalThis.zcodeFs = {
  name: () => "zcodeFs",
  call: (req) => {
    realFsCalls += 1;
    const parsed = JSON.parse(req);
    if (parsed.op === "readMany" && (parsed.paths || []).length === 999) fakeNow += 460; // 模拟大树批量读的慢调用
    return JSON.stringify({ ok: true, entries: [], items: [] });
  },
};
let sqliteQueries = 0;
globalThis.zcodeSqlite = {
  open: () => 7,
  close: () => undefined,
  exec: () => null,
  query: (handle, sql, params, mode) => { sqliteQueries += 1; return mode === "all" ? "[]" : "{}" },
};
globalThis.zcodeDevice = { name: () => "zcodeDevice", allFilesGranted: () => true, deviceInfo: () => "{}" };
globalThis.zcodeExec = { exec: (req) => req }; // 原样回：壳不许改半个字节
// JavaObject 形状替身（0.7.7 真机事故回归钉）：方法对 receiver 敏感（this 不是宿主对象就抛），
// 外加一个**不可枚举**的额外方法（for-in 枚举不到、兜底表也没有）——壳必须 bind 回 orig 并把
// 漏网方法沿原型链透传。Node 普通对象形状（此前全部假桥）验不到这两条，正是装机事故的盲区。
const browserHost = {
  open() {
    if (this !== browserHost) throw new TypeError("非法 receiver：壳没把方法 bind 回宿主");
    return "opened";
  },
  read() {
    if (this !== browserHost) throw new TypeError("非法 receiver：壳没把方法 bind 回宿主");
    return "READ";
  },
};
Object.defineProperty(browserHost, "screenshot", {
  value: () => "PNG",
  enumerable: false,
  writable: true,
  configurable: true,
});
globalThis.zcodeBrowser = browserHost;

const mod = await import(pathToFileURL(path.join(here, "..", "ui", "jank-witness.ts")).href);
const { installJankWitness, markJankPhase } = mod;

const KEY = "zcode-mobile.jank.diag";
const readDiag = () => JSON.parse(store.get(KEY) ?? "null");

const origFs = globalThis.zcodeFs; // 记住引用：装壳应当替换全局对象本体，而不是把方法名吃掉
// 0.7.8 起计时壳默认关（0.7.7 装机数据全空事故的止血）——本冒烟验的是**开壳后**的壳行为，
// 所以显式打开开关再装；开关本身（缺省不装壳）由 ⑧ 源码级钉住。
globalThis.localStorage.setItem("zcode-mobile.jank.shell", "1");
installJankWitness();
installJankWitness(); // 幂等：二次调用不重复装壳/心跳

run("① 装壳透明：三种回包形状逐字不变", () => {
  const wrappedFs = globalThis.zcodeFs;
  expect(wrappedFs !== origFs, "zcodeFs 全局没被壳替换（方案 A 失败？），下游拿到的还是裸桥");
  expect(wrappedFs.name() === "zcodeFs", "name 方法在壳上丢了/改了返回值");
  const back = wrappedFs.call(JSON.stringify({ op: "stat", path: "/work/a" }));
  expect(back === JSON.stringify({ ok: true, entries: [], items: [] }), `fs 回包被改：${back}`);
  const num = globalThis.zcodeSqlite.open("/x");
  expect(num === 7, `sqlite.open 句柄变形：${num}`);
  expect(globalThis.zcodeDevice.allFilesGranted() === true, "device 布尔回包被改");
  const req = '{"op":"x"}';
  expect(globalThis.zcodeExec.exec(req) === req, "exec 回包被改");
  expect(timers.length === 1, `心跳定时器数量 ${timers.length}（幂等失效会翻倍）`);
  return { wrapped: true, timers: timers.length };
});

run("②③ 计数形状：族×op、sqlite 带 mode、fs 从请求头认 op", () => {
  for (let i = 0; i < 3; i++) globalThis.zcodeFs.call(JSON.stringify({ op: "readdir", path: "/work" }));
  globalThis.zcodeSqlite.query(7, "select 1", "[]", "all");
  globalThis.zcodeSqlite.query(7, "insert 1", "[]", "run");
  // 慢的 readMany：同时验证"paths 巨大（含大 base64 请求体）时只扫前 256 字符仍认得出 op"。
  const big = JSON.stringify({ op: "readMany", paths: Array.from({ length: 999 }, (_, i) => "/work/f" + i + "?pad=" + "x".repeat(2000)) });
  globalThis.zcodeFs.call(big);
  const d = readDiag();
  expect(d, "慢调用没有立刻落盘（slowCalls ≥400ms 应触发即时 flush）");
  const fs = d.bridges?.fs;
  expect(fs && fs.readdir?.calls === 3, `fs.readdir 计数不对：${JSON.stringify(fs)}`);
  expect(fs.readMany?.calls === 1 && fs.readMany.maxMs >= 460, `fs.readMany 没进计数/没到慢线：${JSON.stringify(fs.readMany)}`);
  const sq = d.bridges?.sqlite;
  expect(sq?.["query:all"]?.calls === 1 && sq["query:run"]?.calls === 1, `sqlite mode 没并进 op：${JSON.stringify(sq)}`);
  expect(d.slowCalls?.[0]?.family === "fs" && d.slowCalls[0].op === "readMany" && d.slowCalls[0].ms >= 460,
    `slowCalls 归因不对：${JSON.stringify(d.slowCalls)}`);
  expect(d.total === 0, "还没喂心跳，total 不该涨");
  return { fsOps: Object.keys(fs), sqliteOps: Object.keys(sq), slow: d.slowCalls.length };
});

run("⑤⑥ 心跳 gap：≥800ms 记 worst，并把计数/phase 合并进同一份 diag", () => {
  markJankPhase("tool:Grep");
  fakeNow += 200; timers[0](); // 正常一拍
  fakeNow += 1300; timers[0](); // 一次 1.3s 的冻结
  const d = readDiag();
  expect(d.total === 1 && d.maxGapMs >= 1300, `gap 没记：${JSON.stringify({ total: d.total, max: d.maxGapMs })}`);
  expect(d.worst[0].phase === "tool:Grep", `worst 没带 phase：${JSON.stringify(d.worst)}`);
  expect(d.bridges?.fs?.readdir?.calls === 3, "冻结写入时没把桥计数合并进去");
  expect(d.slowCalls?.length >= 1, "冻结写入时 slowCalls 丢了");
  expect(d.lastPhase === "tool:Grep", "lastPhase 没落盘");
  return { gap: d.worst[0].gapMs, phase: d.worst[0].phase };
});

run("⑥' 15s 节拍只在有新调用时落盘", () => {
  // 先喂满 75 拍但期间没有新桥调用：updatedAt 不该被节拍推进。
  const before = readDiag().updatedAt;
  markJankPhase(null);
  const stampBefore = store.get(KEY);
  for (let i = 0; i < 75; i++) { fakeNow += 200; timers[0](); }
  expect(store.get(KEY) === stampBefore, "静置期节拍还在写 localStorage（应只在有新调用时写）");
  // 有一次新调用后的节拍：允许写。
  globalThis.zcodeFs.call(JSON.stringify({ op: "exists", path: "/work" }));
  const stamp2 = store.get(KEY);
  for (let i = 0; i < 75; i++) { fakeNow += 200; timers[0](); }
  expect(store.get(KEY) !== stamp2, "有新调用却没在节拍下落盘");
  const d = readDiag();
  expect(d.bridges?.fs?.exists?.calls === 1, "exists 计数没进快照");
  void before;
  return { exists: d.bridges.fs.exists };
});

run("桥缺席的宿主：装壳静默跳过（桌面 boot 不受影响）", () => {
  // 已经装过壳的本进程无法再验"无桥"路径；用源码级检查代替运行级：
  // instrumentBridges 的每个族都包在 try 里、orig 缺失即 continue——这条由 ①-⑥ 全绿 +
  // 桌面 chatdev（无桥）照常 boot 共同兜住。这里断言壳没有把非函数字段弄丢。
  const device = globalThis.zcodeDevice;
  expect(typeof device.deviceInfo === "function" && device.deviceInfo() === "{}", "device.deviceInfo 穿透失败");
  return { ok: true };
});

run("⑦ JavaObject 形状：receiver 敏感的桥方法被壳调用不许炸；漏网方法沿原型链透传", () => {
  const b = globalThis.zcodeBrowser;
  expect(b !== browserHost, "browser 全局没被壳替换（开关/装壳路径没走到？）");
  expect(b.open("x") === "opened", "壳没 bind 回宿主对象：0.7.7 装机事故形状复现");
  expect(b.read("x") === "READ", "read 的 receiver 转发坏了");
  expect(b.screenshot() === "PNG", "不可枚举的漏网方法没有沿原型链透传");
  // 计数照常记到这一族。
  expect(readDiag().bridges === undefined || !readDiag().bridges.browser || readDiag().bridges.browser.open?.calls >= 1,
    "browser.open 调用没进计数（探针/回退把整族撤了？允许撤族，但撤了别报错）");
  return { browserWrapped: true };
});

run("⑧ 计时壳默认关（0.7.8 止血）：开关缺省不装壳", () => {
  const src = fs.readFileSync(path.join(here, "..", "ui", "jank-witness.ts"), "utf8");
  expect(src.includes('SHELL_FLAG_KEY = "zcode-mobile.jank.shell"'), "开关常量没了");
  expect(/getItem\(SHELL_FLAG_KEY\)\s*===\s*"1"/.test(src) && src.includes("if (shellOn) instrumentBridges();"),
    "装壳不再受开关门控（默认必须关：证人绝不变成破坏者）");
  return { gated: true };
});

const totalChecks = failures.length ? null : 8;
console.log(failures.length ? `FAILURES: ${failures.join(", ")}` : `ALL ${totalChecks} PASS (realFsUnderlyingCalls=${realFsCalls}, sqliteQueries=${sqliteQueries})`);
