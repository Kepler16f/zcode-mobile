// 端侧用量统计（Phase 1：启用 usageStatsService，之前一直在 stubbed 名单里）。
//
// 为什么这是"真做"而不是替身：桌面 App Usage 面板读的是 `getAppUsageSnapshot`
// （usageStatsService.ts:118 注释——agent 数据库真实统计），端侧没有那条 agent 数据库，
// 但**每轮的真实网关用量一直存在 session-store 里**（agent.ts 把 turnUsage 按 turnId 落库、
// 连同 rows/config/cumulative）。这一格就是跨 workspace 把这些读数聚合回 UI 要的形状——
// tokens、轮数、工具调用数/错误率、按天热力、模型分布，全是设备上真实发生过的事。
//
// 三条如实的窄化，写在明处（端侧结构上就没有的数据，一律 0/null，不拿 0 冒充"没用过"，
// 也不编一个非零）：
//   - reasoningTokens / cache* / avgTimeToFirstTokenMs：端侧网关回包没带这些细分，恒 0/null；
//   - Coding Plan 的 monitor/reset 全家（getCodingPlanUsageSnapshot / *Reset* / getSnapshot 的
//     monitor 路）：要服务端 BigModel 配额接口，端侧 P1 没接，**显式抛原因**（这些面只在
//     Coding-Plan 专属屏触发，抛错会被上层 catch 成错误态，比给一屏假的 0 诚实）；
//   - getEntitlementSnapshot：底部配额角标，返回 authenticated:false + unavailableReason
//     "not_configured"（端侧没接服务端配额链路），让角标安静地不出，而不是 error-loop。
//
// 会话聚合走 sessionStore.listAllStates()（本次新加的跨 workspace 读数口），store 没起来时
// 返回空快照（结构齐全、全 0）而不是抛——用量屏不该因为持久化没就绪就崩。
import type { PersistedSessionState } from "./session-store.js";
import type { MobileSessionStore } from "./session-store.js";
import type { IUsageStatsService } from "@zcode/services/deep/usage-stats/usageStats.js";

/** 委托给上游真服务的子集（0.7.3 entitlement 接通）：除 App Usage 聚合外的全部服务端面。 */
type UpstreamEntitlement = Pick<
  IUsageStatsService,
  | "getEntitlementSnapshot"
  | "getCodingPlanUsageSnapshot"
  | "getCodingPlanResetStatus"
  | "requestCodingPlanResetOpportunity"
  | "useCodingPlanReset"
  | "markCodingPlanResetHistoryRead"
>;

/** 与 @zcode/shared 的 ESTIMATED_TOKEN_CHAR_DIVISOR 同值；端侧不复用 import 以免牵进共享桶的副作用。 */
const ESTIMATED_TOKEN_CHAR_DIVISOR = 3;

type Row = Record<string, unknown>;
type UsageStatsRange = "all" | "7d" | "30d";

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 时间戳 → 该时区的 YYYY-MM-DD（热力/按天归桶的唯一真相；不用本地时区免得跨时区机器算错天）。 */
function dayKey(ms: number, timeZone: string): string {
  try {
    let formatter = dayFormatters.get(timeZone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      });
      if (dayFormatters.size >= 8) dayFormatters.clear();
      dayFormatters.set(timeZone, formatter);
    }
    const parts = formatter.formatToParts(new Date(ms));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    // 未知时区串（调用方传了系统不认的）退回 UTC：宁可归到"世界日"，也不让整块聚合抛。
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  }
}
const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** 一次会话里的"轮"聚合：以 turnId 归并 rows，取该轮的用量、模型、消息、工具、时间。 */
interface TurnFact {
  turnId: string;
  createdAt: number;
  endedAt: number;
  inputTokens: number;
  outputTokens: number;
  chars: number;
  messages: number;
  model: string | null;
  toolCalls: number;
  toolErrors: number;
  failed: boolean;
}

/** 把一条持久化会话摊成一串轮事实（轮是 UI 与统计的共同单位，与桌面 product turn 一致）。 */
function turnsOf(state: PersistedSessionState): TurnFact[] {
  const byTurn = new Map<string, Row[]>();
  for (const row of state.rows as Row[]) {
    const turnId = typeof row?.turnId === "string" ? row.turnId : "";
    if (!turnId) continue;
    const list = byTurn.get(turnId);
    if (list) list.push(row);
    else byTurn.set(turnId, [row]);
  }
  const out: TurnFact[] = [];
  for (const [turnId, rows] of byTurn) {
    const usage = state.turnUsage?.[turnId];
    let createdAt = Infinity;
    let endedAt = 0;
    let chars = 0;
    let messages = 0;
    let toolCalls = 0;
    let toolErrors = 0;
    let failed = false;
    for (const row of rows) {
      const ts = asNumber(row.createdAt);
      if (ts) createdAt = Math.min(createdAt, ts);
      const end = asNumber(row.endedAt);
      if (end) endedAt = Math.max(endedAt, end);
      if (row.kind === "userInput" || row.kind === "assistantText") {
        messages += 1;
        chars += typeof row.usageChars === "number" ? row.usageChars : typeof row.text === "string" ? row.text.length : 0;
      }
      if (row.kind === "toolCall") {
        toolCalls += 1;
        if (row.status === "error") toolErrors += 1;
      }
      // turnHeader 的终态把失败轮标出来（modelErrorRate 的分子）。
      if (row.kind === "turnHeader" && row.state === "failed") failed = true;
    }
    if (!Number.isFinite(createdAt)) continue; // 整轮没有可用时间戳（异常行），不计数
    out.push({
      turnId,
      createdAt,
      endedAt: Math.max(endedAt, createdAt),
      inputTokens: asNumber(usage?.inputTokens),
      outputTokens: asNumber(usage?.outputTokens),
      chars,
      messages,
      // 请求已经切换模型时会话config可能仍是旧模型，历史不能据此改归属。
      model: usage?.modelId ?? (rows.find(row => row.kind === "assistantText" && typeof row.model === "string" && row.model)?.model as string | undefined) ?? null,
      toolCalls,
      toolErrors,
      failed,
    });
  }
  return out;
}

interface Agg {
  totalSessions: number;
  totalTurns: number;
  totalMessages: number;
  totalChars: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  toolErrors: number;
  failedTurns: number;
  /** 按天的桶：token、轮数、工具数、消息数、字符数、会话集。 */
  byDay: Map<string, { tokens: number; turns: number; tools: number; messages: number; chars: number; sessions: Set<string> }>;
  /** 按模型：input/output 与轮数（favoriteModel / models[] 都从这里出）。 */
  byModel: Map<string, { input: number; output: number; turns: number }>;
  /** (day, model) → tokens：App Usage 的 dailyModelUsage 从这来，不另起一轮遍历。 */
  byDayModel: Map<string, Map<string, number>>;
  longestSessionMs: number;
  /** 有活动的最小/最大日期（热力图与 firstActivityDate 用）。 */
  firstDay: string | null;
  lastDay: string | null;
}

function newDay(agg: Agg, key: string) {
  let d = agg.byDay.get(key);
  if (!d) {
    d = { tokens: 0, turns: 0, tools: 0, messages: 0, chars: 0, sessions: new Set<string>() };
    agg.byDay.set(key, d);
  }
  return d;
}

function bumpModel(agg: Agg, model: string | null, input: number, output: number, day: string) {
  const key = model ?? "(unknown)";
  const m = agg.byModel.get(key) ?? { input: 0, output: 0, turns: 0 };
  m.input += input;
  m.output += output;
  m.turns += 1;
  agg.byModel.set(key, m);
  let perModel = agg.byDayModel.get(day);
  if (!perModel) {
    perModel = new Map<string, number>();
    agg.byDayModel.set(day, perModel);
  }
  perModel.set(key, (perModel.get(key) ?? 0) + input + output);
}

/** 核心聚合：一次遍历把所有屏要的读数摊出来。range 按轮创建时间裁剪（all 不裁）。 */
function aggregate(entries: Array<{ sessionId: string; state: PersistedSessionState }>, range: UsageStatsRange, timeZone: string): Agg {
  const cutoff = range === "7d" ? Date.now() - 7 * 86_400_000 : range === "30d" ? Date.now() - 30 * 86_400_000 : 0;
  const agg: Agg = {
    totalSessions: 0,
    totalTurns: 0,
    totalMessages: 0,
    totalChars: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    toolErrors: 0,
    failedTurns: 0,
    byDay: new Map(),
    byModel: new Map(),
    byDayModel: new Map(),
    longestSessionMs: 0,
    firstDay: null,
    lastDay: null,
  };
  for (const entry of entries) {
    const turns = turnsOf(entry.state).filter((t) => t.createdAt >= cutoff);
    if (turns.length === 0) continue;
    agg.totalSessions += 1;
    let sessionStart = Infinity;
    let sessionEnd = 0;
    for (const t of turns) {
      agg.totalTurns += 1;
      agg.totalMessages += t.messages;
      agg.totalChars += t.chars;
      agg.inputTokens += t.inputTokens;
      agg.outputTokens += t.outputTokens;
      agg.toolCalls += t.toolCalls;
      agg.toolErrors += t.toolErrors;
      if (t.failed) agg.failedTurns += 1;
      const tokens = t.inputTokens + t.outputTokens;
      const day = dayKey(t.createdAt, timeZone);
      bumpModel(agg, t.model, t.inputTokens, t.outputTokens, day);
      const d = newDay(agg, day);
      d.tokens += tokens;
      d.turns += 1;
      d.tools += t.toolCalls;
      d.messages += t.messages;
      d.chars += t.chars;
      d.sessions.add(entry.sessionId);
      agg.firstDay = agg.firstDay === null || day < agg.firstDay ? day : agg.firstDay;
      agg.lastDay = agg.lastDay === null || day > agg.lastDay ? day : agg.lastDay;
      sessionStart = Math.min(sessionStart, t.createdAt);
      sessionEnd = Math.max(sessionEnd, t.endedAt);
    }
    const span = sessionEnd - sessionStart;
    if (span > agg.longestSessionMs) agg.longestSessionMs = span;
  }
  return agg;
}

/** 连击天数：从最后一个活动日往回数连续有活动的那串（今天没活动不算断，从今天/昨天起算）。 */
function computeStreak(byDay: Map<string, unknown>, lastDay: string | null): { current: number; longest: number } {
  if (!lastDay) return { current: 0, longest: 0 };
  const days = new Set(byDay.keys());
  const toDate = (key: string) => new Date(key + "T00:00:00Z");
  const keyOf = (dt: Date) => dt.toISOString().slice(0, 10);
  // longest：把活动日按时间排序，扫连续段。
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const key of [...days].sort()) {
    if (prev && Math.round((toDate(key).getTime() - toDate(prev).getTime()) / 86_400_000) === 1) run += 1;
    else run = 1;
    longest = Math.max(longest, run);
    prev = key;
  }
  // current：从今天往前，若今天无活动但昨天有，则从昨天起算（与桌面"今天还没用不算断"一致）。
  const todayKey = keyOf(new Date());
  const yesterdayKey = keyOf(new Date(Date.now() - 86_400_000));
  let cursor = days.has(todayKey) ? todayKey : days.has(yesterdayKey) ? yesterdayKey : null;
  let current = 0;
  while (cursor && days.has(cursor)) {
    current += 1;
    cursor = keyOf(new Date(toDate(cursor).getTime() - 86_400_000));
  }
  return { current, longest };
}

function levelOf(tokens: number, maxTokens: number): 0 | 1 | 2 | 3 | 4 {
  if (tokens <= 0 || maxTokens <= 0) return 0;
  return Math.min(4, Math.ceil((tokens / maxTokens) * 4)) as 0 | 1 | 2 | 3 | 4;
}

/** 把 byDay 铺成热力图（按周日对齐的整周矩阵，空格 null）。all 时封顶 60 周，界内存与渲染。 */
function buildHeatmap(agg: Agg, timeZone: string): {
  startDate: string | null;
  endDate: string | null;
  maxTokens: number;
  weeks: Array<{ weekIndex: number; days: Array<Record<string, unknown> | null> }>;
} {
  if (agg.byDay.size === 0) return { startDate: null, endDate: null, maxTokens: 0, weeks: [] };
  const maxTokens = Math.max(...[...agg.byDay.values()].map((d) => d.tokens), 1);
  const start = new Date(agg.firstDay as string);
  // 前推到本周日：JS getDay 里周日=0，减掉得到这一周的第一天。
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  const end = new Date(agg.lastDay as string);
  end.setUTCDate(end.getUTCDate() + (6 - end.getUTCDay()));
  const WEEK_CAP = 60;
  const weeks: Array<{ weekIndex: number; days: Array<Record<string, unknown> | null> }> = [];
  const totalDays = Math.min(
    WEEK_CAP * 7,
    Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1,
  );
  const cursor = new Date(start.getTime());
  for (let day = 0; day < totalDays; day++) {
    const slot = day % 7;
    if (slot === 0) weeks.push({ weekIndex: Math.floor(day / 7), days: new Array(7).fill(null) });
    const key = cursor.toISOString().slice(0, 10);
    const d = agg.byDay.get(key);
    const week = weeks[weeks.length - 1];
    // slot===0 分支保证这之前 push 过，week 逻辑上不可能 undefined；tsc 的
    // noUncheckedIndexedAccess 看不穿这层不变式。守卫是 no-op 兜底（真缺就跳该格，不炸屏）。
    if (!week) continue;
    week.days[slot] = {
      date: key,
      level: levelOf(d?.tokens ?? 0, maxTokens),
      totalTokens: d?.tokens ?? 0,
      turnCount: d?.turns ?? 0,
      toolCallCount: d?.tools ?? 0,
    };
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  void timeZone;
  return {
    startDate: weeks[0]?.days[0]?.date ?? agg.firstDay,
    endDate: agg.lastDay,
    maxTokens,
    weeks,
  } as { startDate: string | null; endDate: string | null; maxTokens: number; weeks: Array<{ weekIndex: number; days: Array<Record<string, unknown> | null> }> };
}

function modelTokens(m: { input: number; output: number }): number {
  return m.input + m.output;
}

function favoriteModelOf(agg: Agg) {
  let best: { modelId: string | null; tokens: number } | null = null;
  for (const [model, m] of agg.byModel) {
    const tokens = modelTokens(m);
    if (!best || tokens > best.tokens) best = { modelId: model === "(unknown)" ? null : model, tokens };
  }
  if (!best || best.tokens === 0) return null;
  const total = agg.inputTokens + agg.outputTokens || 1;
  return { modelId: best.modelId, totalTokens: best.tokens, share: best.tokens / total };
}

function modelsOf(agg: Agg) {
  const total = agg.inputTokens + agg.outputTokens || 1;
  return [...agg.byModel.entries()]
    .map(([modelId, m]) => ({
      modelId: modelId === "(unknown)" ? null : modelId,
      totalTokens: modelTokens(m),
      inputTokens: m.input,
      outputTokens: m.output,
      requestCount: m.turns,
      share: modelTokens(m) / total,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

export function createMobileUsageStatsService(deps: {
  /** 可空：SQLite 引擎没就绪时 agent 只活在本进程，用量屏返回空快照而不是崩。 */
  sessionStore: MobileSessionStore | null;
  onDiagnostic?: (message: string) => void;
  /**
   * 服务端配额链路（0.7.3，用户报"体验套餐仍然无法查看"）。缺省时保持旧行为
   * （entitlement 恒"未配置"、Coding Plan 面显式抛原因）；给值时把这些面**原样委托**给
   * 上游 createUsageStatsService（BigModelUsageQuotaProvider 就是桌面那份真读取）——
   * App Usage 聚合仍是本机 sessionStore 的真数据，两条数据源不相干。
   */
  upstream?: UpstreamEntitlement;
}) {
  const say = deps.onDiagnostic ?? (() => {});
  const timeZone = () => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  };

  const codingPlanOnly = (face: string): never => {
    // 这些面是服务端 BigModel 配额/监控链路，端侧 P1 没接；抛**具体原因**而不是空画面，
    // 上层会 catch 成错误态（Coding-Plan 专属屏才触发）。
    throw new Error(`端侧未接入 Coding Plan 的${face}：需要服务端配额/监控接口，不是本机能力缺失`);
  };

  return {
    async getAppUsageSnapshot(request: { range?: UsageStatsRange; timeZone?: string }) {
      const range: UsageStatsRange = request?.range ?? "all";
      const tz = request?.timeZone || timeZone();
      const entries = deps.sessionStore ? await (deps.sessionStore.listUsageStates?.() ?? deps.sessionStore.listAllStates()) : [];
      const agg = aggregate(entries, range, tz);
      const streak = computeStreak(agg.byDay, agg.lastDay);
      const heatmap = buildHeatmap(agg, tz);
      const totalTokens = agg.inputTokens + agg.outputTokens;
      const peakDayTokens = Math.max(0, ...[...agg.byDay.values()].map((d) => d.tokens));
      say(`usage/app snapshot range=${range} sessions=${agg.totalSessions} turns=${agg.totalTurns} tokens=${totalTokens}`);
      return {
        range,
        generatedAt: Date.now(),
        timeZone: tz,
        // schema 要求字面量 agent-db（桌面同名面板的口径）；端侧数据其实来自 session-store，
        // 语义等价——都是"这台设备上真跑过的轮次统计"，不是缓存也不是估算。
        source: "agent-db",
        summary: {
          totalTokens,
          inputTokens: agg.inputTokens,
          outputTokens: agg.outputTokens,
          // 端侧网关回包没细分这些，如实 0（不拿别的字段凑数）。
          reasoningTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          cacheHitRate: 0,
          totalSessions: agg.totalSessions,
          totalTurns: agg.totalTurns,
          toolCallCount: agg.toolCalls,
          toolErrorRate: agg.toolCalls ? agg.toolErrors / agg.toolCalls : 0,
          modelErrorRate: agg.totalTurns ? agg.failedTurns / agg.totalTurns : 0,
          avgTimeToFirstTokenMs: null,
          avgTurnDurationMs: null,
          activeDays: agg.byDay.size,
          currentStreakDays: streak.current,
          longestSessionMs: agg.longestSessionMs,
          longestStreakDays: streak.longest,
          peakDayTokens,
          favoriteModel: favoriteModelOf(agg),
        },
        heatmap,
        dailyModelUsage: [...agg.byDayModel.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([date, perModel]) => ({
            date,
            models: [...perModel.entries()]
              .map(([modelId, tokens]) => ({
                modelId: modelId === "(unknown)" ? null : modelId,
                totalTokens: tokens,
              }))
              .sort((a, b) => b.totalTokens - a.totalTokens),
          })),
        models: modelsOf(agg),
        tools: [],
      };
    },

    // legacy 统计屏（设置页那张按天曲线）。桌面注释说 getSnapshot 只服务 Coding Plan monitor，
    // 但入参 dataSource 允许 "local"；端侧统一走本地真聚合返回（source:"local"），
    // 这样无论哪个屏调它，看到都是设备真实数据而不是一句 monitor 错误。
    async getSnapshot(request: { range?: UsageStatsRange; dataSource?: string; timeZone?: string }) {
      const range: UsageStatsRange = request?.range ?? "all";
      const tz = request?.timeZone || timeZone();
      const entries = deps.sessionStore ? await (deps.sessionStore.listUsageStates?.() ?? deps.sessionStore.listAllStates()) : [];
      const agg = aggregate(entries, range, tz);
      const days = [...agg.byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
      const total = agg.inputTokens + agg.outputTokens;
      return {
        range,
        generatedAt: Date.now(),
        timeZone: tz,
        estimatedTokenCharDivisor: ESTIMATED_TOKEN_CHAR_DIVISOR,
        summary: {
          totalSessions: agg.totalSessions,
          totalMessages: agg.totalMessages,
          totalCharacters: agg.totalChars,
          totalEstimatedTokens: Math.round(agg.totalChars / ESTIMATED_TOKEN_CHAR_DIVISOR),
          activeDays: agg.byDay.size,
          mostActiveDay: days.length
            ? {
                date: days.reduce((a, b) => (b[1].tokens > a[1].tokens ? b : a))[0],
                label: "",
                totalCharacters: 0,
                totalEstimatedTokens: 0,
                sessionCount: 0,
                messageCount: 0,
                activityScore: 0,
              }
            : null,
          favoriteModel: (() => {
            const f = favoriteModelOf(agg);
            return f ? { modelId: f.modelId, totalCharacters: agg.totalChars, totalEstimatedTokens: total, share: f.share } : null;
          })(),
          longestSessionMs: agg.longestSessionMs,
          longestStreakDays: computeStreak(agg.byDay, agg.lastDay).longest,
          currentStreakDays: computeStreak(agg.byDay, agg.lastDay).current,
          firstActivityDate: agg.firstDay,
          lastActivityDate: agg.lastDay,
          peakHour: null,
        },
        daily: (() => {
          // 接口契约：连续补齐、空白日补 0（趋势图直接遍历）。只出活动日会让断档在图上
          // 变成"消失"而不是"零"，那是另一类把没有读成不知道。
          const out: Array<{
            date: string;
            label: string;
            totalCharacters: number;
            totalEstimatedTokens: number;
            sessionCount: number;
            messageCount: number;
            activityScore: number;
          }> = [];
          if (!agg.firstDay || !agg.lastDay) return out;
          for (
            let t = new Date(agg.firstDay + "T00:00:00Z").getTime();
            t <= new Date(agg.lastDay + "T00:00:00Z").getTime();
            t += 86_400_000
          ) {
            const key = new Date(t).toISOString().slice(0, 10);
            const d = agg.byDay.get(key);
            out.push({
              date: key,
              label: "",
              totalCharacters: d?.chars ?? 0,
              totalEstimatedTokens: Math.round((d?.chars ?? 0) / ESTIMATED_TOKEN_CHAR_DIVISOR),
              sessionCount: d?.sessions.size ?? 0,
              messageCount: d?.messages ?? 0,
              activityScore: d?.tokens ?? 0,
            });
          }
          return out;
        })(),
        heatmap: (() => {
          const hm = buildHeatmap(agg, tz);
          return {
            startDate: hm.startDate,
            endDate: hm.endDate,
            maxActivityScore: hm.maxTokens,
            weeks: hm.weeks.map((w) => ({
              weekIndex: w.weekIndex,
              days: w.days.map((c) => (c ? {
                date: c.date as string,
                level: (c.level ?? 0) as 0 | 1 | 2 | 3 | 4,
                totalCharacters: 0,
                totalEstimatedTokens: c.totalTokens as number,
                sessionCount: 0,
                messageCount: c.turnCount as number,
                activityScore: (c.totalTokens as number) || (c.turnCount as number),
              } : null)),
            })),
            monthLabels: [],
          };
        })(),
        models: modelsOf(agg).map((m) => ({
          modelId: m.modelId,
          totalCharacters: agg.totalChars,
          totalEstimatedTokens: m.totalTokens,
          inputCharacters: 0,
          inputEstimatedTokens: m.totalTokens,
          outputCharacters: 0,
          outputEstimatedTokens: 0,
          sessionCount: 0,
          messageCount: m.requestCount,
          share: m.share,
        })),
        source: "local",
        sourceProvider: null,
        tools: [],
      };
    },

    async getEntitlementSnapshot(request?: unknown) {
      // 0.7.3 接通服务端 entitlement（体验套餐/编程套餐的额度与状态）。upstream 在 → 原样
      // 委托给上游那套真读取（BigModelUsageQuotaProvider：start-plan 走 billing/balance、
      // 编程套餐走配额接口，凭据按当前账号连接现取）；不在（登录桥没起来/自检 harness）
      // 才回"未配置"的完整快照——角标据此安静地不渲染，而不是抛错触发失败链。
      if (deps.upstream) {
        return deps.upstream.getEntitlementSnapshot(request as never);
      }
      return {
        generatedAt: Date.now(),
        authenticated: false,
        unavailableReason: "not_configured",
        provider: null,
        remaining: null,
        subscription: null,
        quota: null,
        mcpQuota: null,
      };
    },

    // Coding Plan 全家：upstream 在就委托（套餐屏真读服务端配额/重置活动）；不在才显式抛原因。
    getCodingPlanUsageSnapshot: (request: unknown) =>
      deps.upstream
        ? deps.upstream.getCodingPlanUsageSnapshot(request as never)
        : codingPlanOnly("用量监控读取"),
    getCodingPlanResetStatus: (request: unknown) =>
      deps.upstream
        ? deps.upstream.getCodingPlanResetStatus(request as never)
        : codingPlanOnly("重置额度状态查询"),
    requestCodingPlanResetOpportunity: (request: unknown) =>
      deps.upstream
        ? deps.upstream.requestCodingPlanResetOpportunity(request as never)
        : codingPlanOnly("重置机会申请"),
    useCodingPlanReset: (request: unknown) =>
      deps.upstream
        ? deps.upstream.useCodingPlanReset(request as never)
        : codingPlanOnly("使用重置额度"),
    markCodingPlanResetHistoryRead: (request: unknown) =>
      deps.upstream
        ? deps.upstream.markCodingPlanResetHistoryRead(request as never)
        : Promise.resolve(codingPlanOnly("重置历史已读上报")),
  };
}
