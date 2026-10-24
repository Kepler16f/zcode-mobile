// 主线程冻结证人（0.4.10，装机"有时候不仅是输入框，整个应用都会卡死"）。
//
// 与 [[device-blank-list-no-more-guessing]] 同一纪律：装机症状先交证人，别再猜根因。
// 桌面探针（topbar-tap-probe / M10 的 grepBridgeCalls：readdir 62 次、payload 12.5 MB/批）
// 已指向"同步桥往返把 Chromium 主线程堵死"这一形状，但真机上到底堵在哪一段、堵多久，
// 只有设备上量得出。这一格就是那个量法：
//
//   一个 200ms 的 setInterval 心跳，记每次相邻回调的**实际间隔**。正常 ≈200ms；
//   主线程被一段同步工作（一次大 readMany、一整次 walk）堵死时，回调迟到，
//   gap = 真实阻塞时长。gap ≥ 800ms 记一笔（时间戳、阻塞毫秒、当时在跑什么由调用侧标注）。
//
//   localStorage `zcode-mobile.jank.diag`：最近 12 条最坏的 gap，附总次数与最大 gap。
//   自检 M13 回读——装机报告直接回答"卡死发生过几次、最长一次堵了多少毫秒"，
//   把"整屏没反应"从主观感受变成可核对的数字。读数仍归读数、修复归修复：
//   即便这一格抓不到（用户没在卡死时开自检），它的开销也只有一个 200ms 定时器，可忽略。
//
// 桥族计时壳（本轮，"偶发卡死"残留源头的证人增强）：gap 只说"堵了多久"，不说"堵在哪个桥的哪一下"。
// 给主要同步桥族（zcodeFs/zcodeTree → fs/tree，zcodeSqlite → sqlite，zcodeExec → exec，
// zcodeBrowser → browser，zcodeDevice → device，zcodeGitHttp → githttp）的每个方法套一层计时壳：
// 族×操作两级计数（次数 / 总耗时 / 最慢一次及其时刻），单次 ≥ BRIDGE_SLOW_CALL_MS 的调用记进
// slowCalls 环（最坏 12 条）并**立刻落盘**——即便整段没到 ≥800ms 心跳线，"readMany 一次 2.6s"
// "exec 一条 60s 超时" "githttp 一次 9s 网络" 这些最慢单次也能被自检直接点名归因。
// 计数平时攒在内存，随心跳每 BRIDGE_FLUSH_TICKS 拍（≈15s）合并写进**同一个**诊断键；
// 冻结事件发生时（写 worst 那条）顺带把最新计数一起写，两边读数永远在同一份 JSON 里。
//
// 开销与降级纪律：壳的成本是每次调用一对 performance.now()（微秒级），桥本身一次是毫秒级 JNI
// 往返，壳不会成为新的卡点。装壳在 boot 最早段（entry.tsx 的 installJankWitness，先于任何端口
// 抓取桥引用）；全局不可重赋就退回原地换方法，两条路都走不通就静默跳过——证人绝不弄挂启动。
// 桌面宿主没有这些桥，installBridges 找不到对象，行为与 0.4.10 完全一致。
const JANK_KEY = "zcode-mobile.jank.diag";
const HEARTBEAT_MS = 200;
/** gap 超过这个数（≈4 个心跳丢拍）才记为一次冻结——正常 GC/渲染抖动够不到这条线。 */
const JANK_THRESHOLD_MS = 800;
const KEEP_WORST = 12;
/** 单次桥调用慢到这个量级就单独记一笔：≈4 个心跳丢拍里只要塞进了一次，用户就"点不动"了。 */
const BRIDGE_SLOW_CALL_MS = 400;
const KEEP_SLOW = 12;
/** 桥计数随心跳合并落盘的间隔（拍）：75×200ms=15s。没新调用就不写，静置时零开销。 */
const BRIDGE_FLUSH_TICKS = 75;

type JankSample = { at: number; gapMs: number; phase: string | null };
/** 一个桥族里一个操作（fs 的 readdir、sqlite 的 query:all……）的累计形状。 */
interface BridgeOpStat { calls: number; totalMs: number; maxMs: number; maxAt: number }
type BridgeSnap = Record<string, Record<string, BridgeOpStat>>;
interface SlowBridgeCall { at: number; family: string; op: string; ms: number }
interface JankDiag {
  updatedAt: number;
  total: number;
  maxGapMs: number;
  /** 最近一次 UI 侧活动标记（runTurn 起止、Grep 扫描等由其它模块 set 进来），冻结归因用。 */
  lastPhase: string | null;
  worst: JankSample[];
  /** 桥族×操作的累计计数快照（装壳后才有；无桥宿主缺省）。 */
  bridges?: BridgeSnap | null;
  /** 最慢的若干次**单个**桥调用（含族与 op），slowCalls[0] 就是"这台设备最堵的一下"。 */
  slowCalls?: SlowBridgeCall[];
}

/**
 * 每个桥族要包的方法。列表按 Kotlin @JavascriptInterface 源码写死而不是运行时枚举：
 * addJavascriptInterface 注入的是 JavaObject，Chromium 对它的方法是否可枚举并不保证
 * （有的版本方法在原型上且不可枚举）——枚举可能拿到空列表，证人就瞎了。
 * 枚举到的额外方法会并进来，所以桥加了新方法也不会漏计，只是兜底靠这张表。
 */
const BRIDGE_FAMILIES: Array<{ global: string; family: string; methods: string[] }> = [
  { global: "zcodeFs", family: "fs", methods: ["call"] },
  { global: "zcodeTree", family: "tree", methods: ["call"] },
  { global: "zcodeSqlite", family: "sqlite", methods: ["open", "close", "exec", "query"] },
  { global: "zcodeExec", family: "exec", methods: ["exec"] },
  { global: "zcodeBrowser", family: "browser", methods: ["open", "navigate", "back", "read", "close"] },
  { global: "zcodeDevice", family: "device", methods: ["openExternal", "execL1", "execL2", "allFilesGranted", "deviceInfo"] },
  { global: "zcodeGitHttp", family: "githttp", methods: ["call"] },
];

function blank(): JankDiag {
  return { updatedAt: Date.now(), total: 0, maxGapMs: 0, lastPhase: null, worst: [] };
}

function read(): JankDiag {
  try {
    const raw = globalThis.localStorage?.getItem(JANK_KEY);
    if (raw) {
      const d = JSON.parse(raw) as JankDiag;
      if (d && Array.isArray(d.worst)) return d;
    }
  } catch {
    /* 坏了当没有 */
  }
  return blank();
}

function write(d: JankDiag): void {
  try {
    globalThis.localStorage?.setItem(JANK_KEY, JSON.stringify(d));
  } catch {
    /* 写不进不当事（隐私模式） */
  }
}

/** 供其它模块标注"现在在跑什么"（如 tool-engine 在 Grep 前置 "grep:/mnt/tree"），冻结采样会带上。 */
let phase: string | null = null;
export function markJankPhase(p: string | null): void {
  phase = p;
  const d = read();
  d.lastPhase = p;
  write(d);
}

// ---- 桥族计时壳 ----

/** 内存累计区：族 → op → 统计。落盘只从这里出快照，读侧永远看 localStorage。 */
const stats: Record<string, Record<string, BridgeOpStat>> = {};
let slowRing: SlowBridgeCall[] = [];
let wrappedFamilies = 0;
let callsSinceFlush = 0;

function labelFor(family: string, method: string, args: unknown[]): string {
  // fs/tree/githttp 的 call(JSON) 单入口：op 永远在请求最前（两侧都是字面量 {op:..} 起手），
  // 所以只扫前 256 字符，绝不对几十 MB 的 base64 请求体做全串匹配。
  if ((family === "fs" || family === "tree" || family === "githttp") && method === "call" && typeof args[0] === "string") {
    const m = /"op"\s*:\s*"([^"]{1,32})"/.exec(args[0].slice(0, 256));
    if (m && typeof m[1] === "string") return m[1];
  }
  // sqlite 的 query(handle, sql, params, mode)：mode 决定调用形状（run 一次一写 / all 整表进 JSON），
  // 不带上它就是"sqlite 慢"这种没用的读数。
  if (family === "sqlite" && method === "query" && typeof args[3] === "string") return "query:" + args[3];
  return method;
}

function recordBridge(family: string, op: string, ms: number): void {
  callsSinceFlush += 1;
  let fam = stats[family];
  if (!fam) fam = stats[family] = {};
  let s = fam[op];
  if (!s) s = fam[op] = { calls: 0, totalMs: 0, maxMs: 0, maxAt: 0 };
  s.calls += 1;
  s.totalMs += ms;
  if (ms > s.maxMs) { s.maxMs = ms; s.maxAt = Date.now(); }
  if (ms >= BRIDGE_SLOW_CALL_MS) {
    slowRing.push({ at: Date.now(), family, op, ms: Math.round(ms) });
    if (slowRing.length > KEEP_SLOW) {
      slowRing.sort((a, b) => b.ms - a.ms);
      slowRing = slowRing.slice(0, KEEP_SLOW);
    }
    // 慢调用本身就是"证人时刻"：立刻落盘，不等 15s 节拍——用户卡完马上开自检也该看得见这一条。
    flushBridgeStats();
  }
}

function snapshotBridges(): BridgeSnap {
  const out: BridgeSnap = {};
  for (const [family, fam] of Object.entries(stats)) {
    const ops: Record<string, BridgeOpStat> = {};
    for (const [op, s] of Object.entries(fam)) {
      ops[op] = { calls: s.calls, totalMs: Math.round(s.totalMs), maxMs: Math.round(s.maxMs), maxAt: s.maxAt };
    }
    out[family] = ops;
  }
  return out;
}

function flushBridgeStats(): void {
  if (!wrappedFamilies) return;
  const d = read();
  d.bridges = snapshotBridges();
  d.slowCalls = slowRing;
  d.updatedAt = Date.now();
  write(d);
  callsSinceFlush = 0;
}

function instrumentOne(family: string, method: string, fn: (...args: unknown[]) => unknown) {
  return function (this: unknown, ...args: unknown[]) {
    const t0 = Number(performance.now());
    try {
      return fn.apply(this, args);
    } finally {
      recordBridge(family, labelFor(family, method, args), Number(performance.now()) - t0);
    }
  };
}

/**
 * 给一个桥对象装壳。首选**整包替换全局**（globalThis.zcodeFs = 壳对象）：所有 JS 侧调用方
 * （vfs-native/vfs-tree/sqlite-native/execution-bridge/fetch-tool…）都是在调用或装配时读
 * globalThis，installJankWitness 又跑在 boot 最前，替换对下游透明。
 * 个别宿主把注入属性做成只读——退回第二方案：原地把方法换成壳（JavaObject 的方法赋值在
 * Chromium 可行；两条路都验签，静默失败就跳过这个族）。
 */
function instrumentBridges(): void {
  const g = globalThis as unknown as Record<string, any>;
  for (const spec of BRIDGE_FAMILIES) {
    try {
      const orig = g[spec.global];
      if (!orig || typeof orig !== "object") continue;
      // 收集要包的方法名：兜底表 ∩ 存在且可调用，再并上枚举到的其余函数属性。
      const names = new Set<string>();
      for (const m of spec.methods) if (typeof orig[m] === "function") names.add(m);
      for (const k in orig) {
        try { if (typeof orig[k] === "function") names.add(k); } catch { /* JavaObject 属性读取可能抛 */ }
      }
      if (!names.size) continue;
      const wrapped: Record<string, unknown> = {};
      for (const name of names) wrapped[name] = instrumentOne(spec.family, name, orig[name]);
      // 方案 A：替换全局。
      let done = false;
      try {
        g[spec.global] = wrapped;
        done = g[spec.global] === wrapped;
      } catch {
        done = false;
      }
      if (done) { wrappedFamilies += 1; continue; }
      // 方案 B：原地换方法（先试，成功几个算几个）。
      let patched = 0;
      for (const name of names) {
        try {
          orig[name] = wrapped[name];
          if (orig[name] === wrapped[name]) patched += 1;
        } catch { /* 方法不可写：这个族跳过，不影响别的族 */ }
      }
      if (patched) wrappedFamilies += 1;
    } catch {
      /* 证人的任何一步失败都不许弄挂 boot */
    }
  }
}

let installed = false;
export function installJankWitness(): void {
  if (installed || !globalThis.document) return;
  installed = true;
  // 装壳必须先于任何端口抓桥引用（entry.tsx 在 createMobileServices 之前调本函数）。
  instrumentBridges();
  let last = Number(performance.now());
  let ticks = 0;
  // setInterval 而非 rAF：主线程堵死时 rAF 根本不排帧，量不出 gap；setTimeout 的迟到本身就是证据。
  globalThis.setInterval(() => {
    const now = Number(performance.now());
    const gap = now - last;
    last = now;
    if (gap < JANK_THRESHOLD_MS) {
      ticks += 1;
      if (ticks >= BRIDGE_FLUSH_TICKS) {
        ticks = 0;
        // 只在有新调用时写：静置的 app 这份证人自己也不制造 localStorage 流量。
        if (callsSinceFlush > 0) flushBridgeStats();
      }
      return;
    }
    const d = read();
    d.total += 1;
    d.maxGapMs = Math.max(d.maxGapMs, Math.round(gap));
    d.updatedAt = Date.now();
    d.lastPhase = phase;
    d.worst.push({ at: Date.now(), gapMs: Math.round(gap), phase });
    // 只留最坏的 KEEP_WORST 条：装机报告要看的是"最长那几次堵在哪段"。
    d.worst.sort((a, b) => b.gapMs - a.gapMs);
    d.worst = d.worst.slice(0, KEEP_WORST);
    // 冻结时刻顺带把桥计数与最慢单次一起写：M13 一条读数就能回答"这次 gap 期间谁在堵"。
    d.bridges = snapshotBridges();
    d.slowCalls = slowRing;
    write(d);
    callsSinceFlush = 0;
  }, HEARTBEAT_MS);
}
