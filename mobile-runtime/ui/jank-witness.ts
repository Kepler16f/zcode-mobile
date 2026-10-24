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
const JANK_KEY = "zcode-mobile.jank.diag";
const HEARTBEAT_MS = 200;
/** gap 超过这个数（≈4 个心跳丢拍）才记为一次冻结——正常 GC/渲染抖动够不到这条线。 */
const JANK_THRESHOLD_MS = 800;
const KEEP_WORST = 12;

type JankSample = { at: number; gapMs: number; phase: string | null };
interface JankDiag {
  updatedAt: number;
  total: number;
  maxGapMs: number;
  /** 最近一次 UI 侧活动标记（runTurn 起止、Grep 扫描等由其它模块 set 进来），冻结归因用。 */
  lastPhase: string | null;
  worst: JankSample[];
}

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

let installed = false;
export function installJankWitness(): void {
  if (installed || !globalThis.document) return;
  installed = true;
  let last = Number(performance.now());
  // setInterval 而非 rAF：主线程堵死时 rAF 根本不排帧，量不出 gap；setTimeout 的迟到本身就是证据。
  globalThis.setInterval(() => {
    const now = Number(performance.now());
    const gap = now - last;
    last = now;
    if (gap < JANK_THRESHOLD_MS) return;
    const d = read();
    d.total += 1;
    d.maxGapMs = Math.max(d.maxGapMs, Math.round(gap));
    d.updatedAt = Date.now();
    d.lastPhase = phase;
    d.worst.push({ at: Date.now(), gapMs: Math.round(gap), phase });
    // 只留最坏的 KEEP_WORST 条：装机报告要看的是"最长那几次堵在哪段"。
    d.worst.sort((a, b) => b.gapMs - a.gapMs);
    d.worst = d.worst.slice(0, KEEP_WORST);
    write(d);
  }, HEARTBEAT_MS);
}
