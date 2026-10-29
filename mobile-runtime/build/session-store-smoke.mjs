// 会话持久化层（ui/session-store.ts）的契约冒烟：真 SQL 往返 + 损坏记录守门。
//
// 与 chat-smoke 判据 6 的分工：那边用内存版 store 验 agent.ts 的落盘/还原/水合逻辑，
// 这边验 session-store.ts 自己 —— 建表 SQL、INSERT OR REPLACE（minSdk 26 的框架库没有
// UPSERT）、按 workspace 的摘要列表与排序、JSON 往返、缺失/损坏记录如实回 null。
//
// 引擎用 sql.js（vendor/sql-wasm.js）+ 一个 Map byteStore。sql.js 的持久化语义是
// **close() 才把整库写回 byteStore**（sqlite.mjs:150），所以本冒烟严格遵守"同一路径
// 一次只有一个句柄、用完即 close"：需要预置/篡改库内容时，先用裸 DatabaseSync 写好再 close，
// 然后才开 store 读它。真机上 SqliteBridge 是实时落盘、没有这条约束（那边由 selfcheck/m1-run
// 在真机验），跨"重启"的还原链路由 chat-smoke 判据 6 用共享 store 覆盖。
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require = createRequire(path.join(root, "../zcode/apps/zcode-cli/package.json"));
const esbuild = require("esbuild");

// sqlite.mjs 必须 external：configureSqlite 配置的是**磁盘上那一份**的模块级 runtime，
// 打进产物就是第二个实例，isSqliteReady() 永远 false（services-smoke 对 vfs 同理）。
const tmpOut = path.join(here, ".tmp-session-store-smoke.mjs");
await esbuild.build({
  entryPoints: [path.join(root, "ui/session-store.ts")],
  outfile: tmpOut,
  bundle: true,
  format: "esm",
  platform: "neutral",
  external: ["../compat/shims/sqlite.mjs"],
  write: true,
  logLevel: "warning",
});

const initSqlJs = require(path.join(root, "vendor/sql-wasm.js"));
const { configureSqlite, DatabaseSync } = await import(
  pathToFileURL(path.join(root, "compat/shims/sqlite.mjs")).href
);

const disk = new Map();
await configureSqlite({
  sqlJsFactory: initSqlJs,
  locateFile: () => path.join(root, "vendor/sql-wasm.wasm"),
  byteStore: {
    read: (p) => disk.get(p) ?? null,
    write: (p, bytes) => disk.set(p, bytes),
  },
  prefer: null,
});

const { createMobileSessionStore } = await import(pathToFileURL(tmpOut).href);
rmSync(tmpOut, { force: true });

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: Boolean(ok), detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEntry(sessionId, overrides = {}) {
  const workspacePath = overrides.workspacePath ?? "/work/smoke";
  return {
    sessionId,
    workspacePath,
    summary: {
      sessionId,
      workspaceId: workspacePath,
      title: "重启前的一句",
      titleSource: "generated",
      phase: "completedSuccess",
      sessionEnded: true,
      hasBackgroundWork: false,
      lastActivityAt: 1759000000000,
      createdAt: 1758999990000,
      ...overrides.summary,
    },
    state: {
      rows: [
        { rowId: 1, turnId: "t1", entityId: "t1", createdAt: 1758999991000, createdAtSeq: 1, kind: "turnHeader", origin: "userInput", executionKind: "agent", state: "completedSuccess", startedAt: 1758999991000 },
        { rowId: 2, turnId: "t1", entityId: "2", createdAt: 1758999991000, createdAtSeq: 2, kind: "userInput", text: "重启前的一句", origin: "realUser", visibility: "visible", actions: { canEdit: true, canRetry: true } },
        { rowId: 3, turnId: "t1", entityId: "3", createdAt: 1758999992000, createdAtSeq: 3, kind: "assistantText", text: "端侧对话自检：一、二、三", state: "complete" },
      ],
      config: { provider: "mock-provider", model: "mock-model", thought: "", thoughtLevels: [], followupMode: "queue", mode: "build", ...overrides.config },
      revision: 2,
      cumulative: { inputTokens: 11, outputTokens: 7 },
      nextRowId: 4,
      turnUsage: { t1: { inputTokens: 11, outputTokens: 7 } },
      phase: "completedSuccess",
      lastError: null,
      ...overrides.state,
    },
  };
}

// ── A. 引擎就绪 + 建库 ──
const DB = "/work/.zcode/smoke-sessions.sqlite";
const store = createMobileSessionStore({ dbPath: DB });
check("引擎就绪后建库成功（返回 store 而不是 null）", store !== null, String(store));
check("engine() 报的是 sql.js（Node 冒烟里没有原生桥）", store?.engine() === "sql.js-wasm", store?.engine());

// ── B. save → load 完整往返 ──
store.save(makeEntry("ses-1"));
const loaded = store.load("ses-1");
check("load 读回同一条会话", loaded?.sessionId === "ses-1", JSON.stringify(loaded?.sessionId));
check(
  "rows 往返无损（3 行、用户与助手文本都在）",
  loaded?.state.rows.length === 3 &&
    loaded.state.rows[1]?.text === "重启前的一句" &&
    loaded.state.rows[2]?.text === "端侧对话自检：一、二、三",
  JSON.stringify(loaded?.state.rows.map((r) => [r.kind, r.text ?? ""])),
);
check(
  "config/revision/nextRowId/turnUsage 都跟着回来",
  loaded?.state.config.provider === "mock-provider" &&
    loaded?.state.revision === 2 &&
    loaded?.state.nextRowId === 4 &&
    loaded?.state.turnUsage.t1?.inputTokens === 11,
  JSON.stringify({ revision: loaded?.state.revision, nextRowId: loaded?.state.nextRowId, turnUsage: loaded?.state.turnUsage }),
);
check(
  "summary 往返无损（标题/phase）",
  loaded?.summary.title === "重启前的一句" && loaded?.summary.phase === "completedSuccess",
  JSON.stringify(loaded?.summary),
);

// ── C. INSERT OR REPLACE：同一 sessionId 再存是覆盖不是重复（minSdk 26 无 UPSERT）──
store.save(
  makeEntry("ses-1", {
    state: {
      rows: [{ rowId: 1, turnId: "t2", entityId: "1", createdAt: 1759000001000, createdAtSeq: 1, kind: "userInput", text: "第二句", origin: "realUser", visibility: "visible", actions: { canEdit: true, canRetry: true } }],
      config: { provider: "mock-provider", model: "mock-model", thought: "", thoughtLevels: [], followupMode: "queue", mode: "build" },
      revision: 3,
      cumulative: { inputTokens: 20, outputTokens: 9 },
      nextRowId: 2,
      turnUsage: {},
      phase: "completedSuccess",
      lastError: null,
    },
  }),
);
const replaced = store.load("ses-1");
check(
  "重复 save 是覆盖（rows 变成新的 1 行、revision 前进）",
  replaced?.state.rows.length === 1 && replaced.state.rows[0]?.text === "第二句" && replaced.state.revision === 3,
  JSON.stringify({ rows: replaced?.state.rows.map((r) => r.text), revision: replaced?.state.revision }),
);

// ── D. 缺失记录 = null，不是异常 ──
check("load 不存在的会话返回 null", store.load("ses-nope") === null);

// ── E. listSummaries 按 workspace 过滤、按 updated_at 倒序、limit 生效 ──
await sleep(3);
store.save(makeEntry("ses-2", { summary: { title: "别的会话" } }));
store.save(makeEntry("ses-other", { workspacePath: "/work/elsewhere", summary: { title: "别的工作区" } }));
const listed = store.listSummaries("/work/smoke");
const ids = listed.map((e) => e.sessionId);
check(
  "listSummaries 只回本 workspace 的会话（ses-other 属于别处，被滤掉）",
  ids.length === 2 && ids.includes("ses-1") && ids.includes("ses-2") && !ids.includes("ses-other"),
  JSON.stringify(ids),
);
check(
  "listSummaries 按 updated_at 倒序（最近存过的 ses-2 在前）",
  ids[0] === "ses-2" && ids[1] === "ses-1",
  JSON.stringify(ids),
);
check(
  "listSummaries 的 limit 生效",
  store.listSummaries("/work/smoke", 1).length === 1,
  JSON.stringify(store.listSummaries("/work/smoke", 1).map((e) => e.sessionId)),
);

// ── F. 损坏记录守门：state/summary 不是合法 JSON 时 load 回 null（不抛、不还原半截状态）──
// sql.js 只在 close 落盘，所以先用裸句柄把库写进 byteStore 再 close，然后才开 store 读。
const CORRUPT_DB = "/work/.zcode/smoke-corrupt.sqlite";
{
  const raw = DatabaseSync(CORRUPT_DB, { timeout: 1000 });
  raw.exec(
    "CREATE TABLE IF NOT EXISTS mobile_sessions (session_id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL, summary TEXT NOT NULL, state TEXT NOT NULL, updated_at INTEGER NOT NULL)",
  );
  const insert = raw.prepare(
    "INSERT OR REPLACE INTO mobile_sessions (session_id, workspace_path, summary, state, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  insert.run("ses-bad-state", "/work/smoke", JSON.stringify(makeEntry("ses-bad-state").summary), "{不是JSON", 1);
  insert.run("ses-bad-summary", "/work/smoke", "也不是JSON", JSON.stringify(makeEntry("ses-bad-summary").state), 2);
  raw.close(); // 落盘到 byteStore，下一个句柄才读得到
}
const corruptStore = createMobileSessionStore({ dbPath: CORRUPT_DB });
check("损坏库上仍能建 store", corruptStore !== null);
check("state 损坏 → load 回 null（parseState 守门）", corruptStore.load("ses-bad-state") === null);
check("summary 损坏 → load 回 null（parseSummary 守门）", corruptStore.load("ses-bad-summary") === null);
// listSummaries 只读 summary 列：state 坏的那条 summary 仍合法，应当照常列出（摘要级读取不碰 state）。
const corruptListed = corruptStore.listSummaries("/work/smoke").map((e) => e.sessionId);
check(
  "listSummaries 是摘要级：state 坏的照常列出、summary 坏的被跳过",
  corruptListed.includes("ses-bad-state") && !corruptListed.includes("ses-bad-summary"),
  JSON.stringify(corruptListed),
);

// 旧版大会话：正文超过 Android 单个 CursorWindow 通常可容纳的大小。
const LARGE_DB = "/work/.zcode/smoke-large.sqlite";
{
  const raw = DatabaseSync(LARGE_DB);
  raw.exec("CREATE TABLE mobile_sessions (session_id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL, summary TEXT NOT NULL, state TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  const insert = raw.prepare("INSERT INTO mobile_sessions VALUES (?, ?, ?, ?, ?)");
  for (let i = 0; i < 205; i++) {
    const entry = makeEntry(`legacy-${i}`);
    if (i === 0) entry.state.rows[0].text = "大段历史😀".repeat(400000);
    insert.run(entry.sessionId, entry.workspacePath, JSON.stringify(entry.summary), JSON.stringify(entry.state), i + 1);
  }
  raw.close();
}
const largeStore = createMobileSessionStore({ dbPath: LARGE_DB });
let migrationTicks = 0;
const heartbeat = setInterval(() => { migrationTicks++; }, 0);
const usageRead = largeStore.listUsageStates();
check("用量面板并发读取共用同一次旧数据迁移", usageRead === largeStore.listUsageStates());
const facts = await usageRead;
clearInterval(heartbeat);
check("用量统计不受侧栏200会话上限截断", facts.length === 205, String(facts.length));
const large = facts.find(entry => entry.sessionId === "legacy-0");
check("多MB旧会话分块读取后只保留统计字段", JSON.stringify(large.state).length < 5000 && large.state.rows[0].usageChars > 2000000);
check("迁移长历史时界面计时器仍可运行", migrationTicks > 20, String(migrationTicks));
const again = await largeStore.listUsageStates();
check("迁移后的投影保留真实轮次用量", JSON.stringify(again[0].state.turnUsage) === JSON.stringify(facts[0].state.turnUsage));

// 读用量让出主线程时保存新会话：不能混拼正文或覆盖新投影。
const racingStore = createMobileSessionStore({dbPath:"/work/.zcode/smoke-racing.sqlite"});
const oldEntry = makeEntry("racing");
oldEntry.state.rows[2].text = "旧正文".repeat(100000);
racingStore.save(oldEntry);
const newEntry = makeEntry("racing", {state:{cumulative:{inputTokens:123,outputTokens:456},turnUsage:{t1:{inputTokens:123,outputTokens:456}}}});
const reading = racingStore.listUsageStates();
setTimeout(() => { racingStore.save(newEntry); racingStore.saveUsageProjection(newEntry); }, 0);
const raced = await reading;
check("分块读取与收轮并发时返回新版本", raced[0]?.state.cumulative.inputTokens === 123);
check("旧迁移不能覆盖新投影", (await racingStore.listUsageStates())[0]?.state.cumulative.outputTokens === 456);
const originalNow = Date.now;
try {
  Date.now = () => originalNow() + 100000;
  const frozen = Date.now(); Date.now = () => frozen;
  racingStore.save(oldEntry); racingStore.saveUsageProjection(oldEntry);
  racingStore.save(newEntry);
  check("同毫秒保存使旧投影失效", (await racingStore.listUsageStates())[0]?.state.cumulative.inputTokens === 123);
} finally { Date.now = originalNow; }

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  process.stdout.write(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : `  → ${r.detail}`}\n`);
}
process.stdout.write(`\n会话持久化冒烟：${results.length - failed.length}/${results.length} PASS\n`);
// 不用 process.exit()：sql.js 的 WASM 上下文在 Windows 上与 libuv teardown 偶发竞态
// （UV_HANDLE_CLOSING 断言），本冒烟没有悬挂计时器，设 exitCode 让它自然退出即可。
process.exitCode = failed.length > 0 ? 1 : 0;
