// 侧栏诊断链路（0.3.9，用户第三次报"侧栏还是没有对话列表"后的重构）。
//
// 为什么要有这一格：连着 0.3.6/0.3.7/0.3.8 三版，"侧栏空"的根因每次都是靠猜
// （null 绑定 → 修了；缓存顶包 → 关了），桌面 e2e 全绿但装机复现，中间那层是黑的。
// 侧栏这条链的真机唯一证人只有两个：UI 页里读取口的真实返回值，和 task-index 库里真实的行。
// 这里把前者的关键读数**持续写进 localStorage**（与自检页同源共享），装机报告一复制
// 就带回"链上每一环的最后已知状态"——下一次再出现这个症状，不必再猜，直接按读数定位：
//
//   readLast       listTaskList 最后一次 {kind, scopes, 返回/total}
//                  —— 返回 0/0 且库里其实有行 ⇒ 谓词/provider 过滤卡住；scopes 为空 ⇒ UI 根本没带工作区来问。
//   watched        watchScope 见过的 workspace 键 —— 快照只会投影这里出现过的 scope。
//   snapshotLast   最近一次 tasks-index 快照帧 {tasks, 合法与否}
//                  —— 快照里行数为 0 ⇒ 投影链（rowsOf）断；有行而屏上没有 ⇒ 帧没被 UI 消费（订阅/水位）。
//   deltas         累计 task.upserted / task.removed 帧计数
//                  —— 会话跑完一次、deltas.upserted 还是 0 ⇒ 同步器→Controller 那一跳没发生。
//   rejects        帧校验被拒的次数与第一因（say 的同类读数也进 agentLog，这里留计数）。
//
// 只在"会被报告回收"的失败面聚合，不记逐 token 的流水：localStorage 写入是同步的，
// 这条链每个事件最多写一次合并后的 JSON，量级是列表操作而不是消息流。
const STORAGE_KEY = "zcode-mobile.sidebar.diag";

export interface SidebarDiagnostics {
  updatedAt: number;
  readLast: null | { kind: string; scopes: string[]; items: number; total: number };
  watched: string[];
  snapshotLast: null | { tasks: number; at: number };
  deltas: { upserted: number; removed: number };
  rejects: number;
  lastReject: string | null;
}

function blank(): SidebarDiagnostics {
  return {
    updatedAt: Date.now(),
    readLast: null,
    watched: [],
    snapshotLast: null,
    deltas: { upserted: 0, removed: 0 },
    rejects: 0,
    lastReject: null,
  };
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // 隐私模式/配额炸：诊断掉线可以接受，绝不能把读路径带崩。
    return null;
  }
}

export function readSidebarDiagnostics(): SidebarDiagnostics {
  const s = storage();
  if (!s) return blank();
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return blank();
    const parsed = JSON.parse(raw);
    // 形状兼容：字段缺了就补默认，别拿"上一版结构"当"这版没数据"读。
    return { ...blank(), ...parsed, deltas: { ...blank().deltas, ...(parsed?.deltas ?? {}) } };
  } catch {
    return blank();
  }
}

function write(next: SidebarDiagnostics): void {
  const s = storage();
  if (!s) return;
  next.updatedAt = Date.now();
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* 配额满：诊断让路 */
  }
}

/** 聚合更新：读-改-写一条通道，调用方只描述"哪一环发生了什么"。 */
export function recordSidebar(
  mutate: (diag: SidebarDiagnostics) => void,
): void {
  const diag = readSidebarDiagnostics();
  mutate(diag);
  write(diag);
}

export function sidebarReadout(
  kind: string,
  scopes: string[],
  items: number,
  total: number,
): void {
  recordSidebar((d) => {
    d.readLast = { kind, scopes, items, total };
  });
}

export function sidebarWatched(scopeKey: string): void {
  recordSidebar((d) => {
    if (!d.watched.includes(scopeKey)) d.watched.push(scopeKey);
  });
}

export function sidebarSnapshot(tasks: number): void {
  recordSidebar((d) => {
    d.snapshotLast = { tasks, at: Date.now() };
  });
}

export function sidebarDelta(op: "upserted" | "removed"): void {
  recordSidebar((d) => {
    d.deltas[op] += 1;
  });
}

export function sidebarFrameReject(reason: string): void {
  recordSidebar((d) => {
    d.rejects += 1;
    d.lastReject ??= reason;
  });
}
