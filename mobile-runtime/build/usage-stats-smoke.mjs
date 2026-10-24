// 端侧用量统计的聚合冒烟（Phase 1 启用 usageStatsService）。
// usage-stats.ts 只有类型 import（运行时自包含），esbuild 转译后可以直接测真函数。
// 判据不是"能跑出个 JSON"，是**数字算得对不对**：tokens 相加、按天归桶、工具错误率、
// 模型分布、连击天数、range 裁剪、Coding Plan 面如实抛——装机用量屏第一次有真数据，
// 这里先把聚合逻辑钉死，免得屏上显示"0 tokens"时又要从三版前开始猜。
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const root = path.resolve(here, "..");
const zcodeRoot = path.join(root, "../zcode");
const require = createRequire(path.join(zcodeRoot, "apps/zcode-cli/package.json"));
const esbuild = require("esbuild");

const tmp = path.join(os.tmpdir(), `azcode-usage-smoke-${Date.now()}.mjs`);
await esbuild.build({
  entryPoints: [path.join(root, "ui/usage-stats.ts")],
  outfile: tmp,
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  write: true,
  logLevel: "warning",
});
const { createMobileUsageStatsService } = await import(pathToFileURL(tmp).href);
fs.rmSync(tmp, { force: true });

const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (e) {
    results.push({ name, ok: false, why: String(e?.message ?? e).slice(0, 300) });
  }
};
const eq = (got, want, label) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${label}: 得 ${JSON.stringify(got)} 期望 ${JSON.stringify(want)}`);
};

const DAY = 86_400_000;
// 固定时区避免本机时区把 dayKey 归到隔壁天（UTC 下时间戳就是整日边界）。
const TZ = "UTC";
const now = Date.now();

function turn(turnId, createdAt, usage, extra = {}) {
  return [
    { kind: "turnHeader", rowId: 1, turnId, createdAt, state: "completedSuccess", ...extra.header },
    { kind: "userInput", rowId: 2, turnId, createdAt, text: "写一个排序" },
    { kind: "assistantText", rowId: 3, turnId, createdAt: createdAt + 1000, text: "好的", state: "complete", model: "glm-4.7" },
    ...(extra.toolCalls ?? []),
  ];
}

const store = {
  listAllStates: () => [
    {
      sessionId: "s1",
      workspacePath: "/work/a",
      updatedAt: now,
      state: {
        rows: [
          ...turn("t1", now - 2 * DAY, { inputTokens: 100, outputTokens: 40 }),
          ...turn("t2", now - 2 * DAY + 5 * 60_000, { inputTokens: 60, outputTokens: 20 }, {
            // 工具调用：一错一成（errorRate 的分子/分母），失败轮单独标 header.state=failed。
            toolCalls: [
              { kind: "toolCall", rowId: 4, turnId: "t2", createdAt: now - 2 * DAY + 6 * 60_000, toolName: "bash", status: "error" },
              { kind: "toolCall", rowId: 5, turnId: "t2", createdAt: now - 2 * DAY + 7 * 60_000, toolName: "read", status: "success" },
            ],
            header: { state: "failed" },
          }),
        ],
        turnUsage: { t1: { inputTokens: 100, outputTokens: 40 }, t2: { inputTokens: 60, outputTokens: 20 } },
        config: { model: "glm-4.7" },
        phase: "idle",
      },
    },
    {
      // 第二条会话：9 天前 → 只有 range=all 能看到（7d/30d 裁剪的判据）。
      sessionId: "s2",
      workspacePath: "/work/b",
      updatedAt: now - 9 * DAY,
      state: {
        rows: turn("t3", now - 9 * DAY, { inputTokens: 500, outputTokens: 200 }),
        turnUsage: { t3: { inputTokens: 500, outputTokens: 200 } },
        config: { model: "glm-4.7" },
        phase: "idle",
      },
    },
  ],
  engine: () => "test",
};

const svc = createMobileUsageStatsService({ sessionStore: store, onDiagnostic: () => {} });

await check("App Usage（all）：tokens/轮数/工具错误率/模型错误率全部算对", async () => {
  const snap = await svc.getAppUsageSnapshot({ range: "all", timeZone: TZ });
  eq(snap.summary.totalTokens, 920, "totalTokens=100+40+60+20+500+200");
  eq(snap.summary.inputTokens, 660, "inputTokens");
  eq(snap.summary.outputTokens, 260, "outputTokens");
  eq(snap.summary.totalSessions, 2, "totalSessions");
  eq(snap.summary.totalTurns, 3, "totalTurns");
  eq(snap.summary.toolCallCount, 2, "toolCallCount");
  eq(snap.summary.toolErrorRate, 0.5, "1 error / 2 calls");
  eq(snap.summary.modelErrorRate, 1 / 3, "1 failed turn / 3 turns");
  eq(snap.summary.activeDays, 2, "昨天(相对)9天前 + 2天前 = 2 个活动日");
  // 端侧没有的细分：恒 0/null，不拿别的凑。
  eq(snap.summary.reasoningTokens, 0, "reasoningTokens 如实 0");
  eq(snap.summary.avgTimeToFirstTokenMs, null, "TTFT 如实 null");
  eq(snap.source, "agent-db", "source 字面量（schema 要求）");
  return { tokens: snap.summary.totalTokens };
});

await check("range=7d 裁掉 9 天前的会话（30d 留着）", async () => {
  const s7 = await svc.getAppUsageSnapshot({ range: "7d", timeZone: TZ });
  const s30 = await svc.getAppUsageSnapshot({ range: "30d", timeZone: TZ });
  eq(s7.summary.totalSessions, 1, "7d 只剩 s1");
  eq(s7.summary.totalTokens, 220, "7d tokens=100+40+60+20");
  eq(s30.summary.totalSessions, 2, "30d 两条都在");
  return { s7: s7.summary.totalSessions, s30: s30.summary.totalSessions };
});

await check("热力图按天归桶：cell 的 tokens/轮数与周矩阵对齐", async () => {
  const snap = await svc.getAppUsageSnapshot({ range: "all", timeZone: TZ });
  const cells = snap.heatmap.weeks.flatMap((w) => w.days).filter(Boolean);
  const withData = cells.filter((c) => c.totalTokens > 0);
  eq(withData.length, 2, "两个活动日");
  const sum = withData.reduce((a, c) => a + c.totalTokens, 0);
  eq(sum, 920, "热力图 token 总和 = summary");
  eq(snap.heatmap.maxTokens, 700, "maxTokens=峰值日(9天前的 s2：500+200)");
  return { days: withData.map((c) => c.date), sum };
});

await check("模型分布：单模型 share=1、favoriteModel 与 dailyModelUsage 一致", async () => {
  const snap = await svc.getAppUsageSnapshot({ range: "all", timeZone: TZ });
  eq(snap.models.length, 1, "一个模型");
  eq(snap.models[0].modelId, "glm-4.7", "modelId");
  eq(snap.models[0].share, 1, "share=1");
  eq(snap.summary.favoriteModel?.modelId, "glm-4.7", "favorite");
  const dayTokens = snap.dailyModelUsage.reduce((a, d) => a + d.models.reduce((x, m) => x + m.totalTokens, 0), 0);
  eq(dayTokens, 920, "dailyModelUsage 总和一致");
  return { models: snap.models[0].requestCount };
});

await check("连击天数：2 天前 + 9 天前两个孤立日 → current/longest 各按语义", async () => {
  const snap = await svc.getAppUsageSnapshot({ range: "all", timeZone: TZ });
  // 活动日不连续（差 7 天），今天也没活动 → current=0（今天与昨天都没数据），longest=1。
  eq(snap.summary.currentStreakDays, 0, "current：今天昨天都没用");
  eq(snap.summary.longestStreakDays, 1, "longest：单日");
  return { cur: snap.summary.currentStreakDays, longest: snap.summary.longestStreakDays };
});

await check("legacy getSnapshot：token 估算走字符口径 + daily 补零序列", async () => {
  const snap = await svc.getSnapshot({ range: "all", timeZone: TZ });
  eq(snap.source, "local", "source=local");
  eq(snap.estimatedTokenCharDivisor, 3, "divisor");
  // 两条 userInput + 两条 assistantText（每 turn 的文本行）：消息数 6
  eq(snap.summary.totalMessages, 6, "userInput+assistantText 行数");
  // totalCharacters：user "写一个排序"(5) + asst "好的"(2) 每轮 = 7/轮… 三行文本 ×2 轮 + 3 轮 = 21
  eq(snap.summary.totalCharacters, 21, "chars 求和");
  eq(snap.summary.firstActivityDate, new Date(now - 9 * DAY).toISOString().slice(0, 10), "first");
  eq(snap.summary.lastActivityDate, new Date(now - 2 * DAY).toISOString().slice(0, 10), "last");
  eq(snap.daily.length, 8, "first..last 连续补零(含头尾)=8 天");
  eq(snap.daily.every((d) => Number.isFinite(d.activityScore)), true, "daily 每项可用");
  return { days: snap.daily.length };
});

await check("getEntitlementSnapshot：端侧无配额 → authenticated:false + not_configured（角标安静不出、不抛）", async () => {
  const snap = await svc.getEntitlementSnapshot({});
  eq(snap.authenticated, false, "authenticated");
  eq(snap.unavailableReason, "not_configured", "reason");
  eq(snap.quota, null, "quota null");
  return snap.unavailableReason;
});

await check("Coding Plan 的 5 个服务端面：调用即抛具体原因（不空画面、不编数）", () => {
  const names = [
    "getCodingPlanUsageSnapshot",
    "getCodingPlanResetStatus",
    "requestCodingPlanResetOpportunity",
    "useCodingPlanReset",
    "markCodingPlanResetHistoryRead",
  ];
  for (const n of names) {
    let threw = "";
    try {
      svc[n]({});
    } catch (e) {
      threw = String(e?.message ?? e);
    }
    if (!threw.includes("端侧未接入")) throw new Error(`${n} 没有抛具体原因：${threw || "没抛"}`);
  }
  return { faces: names.length };
});

await check("store 为 null（持久化没起来）：空快照而不是崩", async () => {
  const empty = createMobileUsageStatsService({ sessionStore: null });
  const snap = await empty.getAppUsageSnapshot({ range: "all", timeZone: TZ });
  eq(snap.summary.totalTokens, 0, "空聚合 tokens=0");
  eq(snap.summary.favoriteModel, null, "favorite null");
  eq(snap.heatmap.weeks, [], "热力空");
  const legacy = await empty.getSnapshot({ range: "7d" });
  eq(legacy.daily, [], "daily 空数组");
  return { ok: true };
});

const failed = results.filter((r) => !r.ok);
for (const r of results) process.stdout.write(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  → ${r.why}`}\n`);
process.stdout.write(`\n端侧用量统计冒烟：${results.length - failed.length}/${results.length} PASS\n`);
process.exit(failed.length ? 1 : 0);
