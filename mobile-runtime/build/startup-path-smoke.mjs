// 0.9.0 启动路径回归冒烟（runtime_regression_audit）。
//
// 三个判据，全部用**真引擎**（sql.js WASM = 端侧 sqlite 垫片的桌面形态）与**真 SQL**：
//
//   A. taskIndexRepo.queryTaskList 的 excludeTaskIdPrefix 谓词
//      （substr(task_id,1,?) != ?）到底走索引还是全表扫；
//      带/不带这个谓词，列表查询与 COUNT 查询各差多少。
//   B. session-store.save() 现在写**两份**（mobile_sessions + mobile_session_usage），
//      每次落盘的额外成本（agent.ts 的 checkpoint 每 5 秒一次，这条是它的放大器）。
//   C. listUsageStates() 读用量投影要发多少条 SQL —— 端侧每条都是一次 JNI 往返。
//
// 输出：人类可读的 PASS/FAIL + 一段 JSON（供 tmp/ 日志与人工比对）。
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

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: Boolean(ok), detail });
const out = { startedAt: new Date().toISOString() };

// ── 真引擎：sql.js（= 端侧 node:sqlite 垫片的 WASM 分支，SQL 语义一致）──
const initSqlJs = require(path.join(root, "vendor/sql-wasm.js"));
const { configureSqlite } = await import(
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
  prefer: "wasm",
});
const { DatabaseSync } = await import(
  pathToFileURL(path.join(root, "compat/shims/sqlite.mjs")).href
);

// ── 真 schema：直接从仓库里那份 tasksDatabase/schema-v1.ts 取，不手抄 ──
// 输出必须落在 mobile-runtime/build/ 里：session-store.ts 的 external 路径
// "../compat/shims/sqlite.mjs" 是相对 outfile 解析的（与 session-store-smoke.mjs 同规矩）。
const schemaOut = path.join(here, `.tmp-startup-path-schema.mjs`);
await esbuild.build({
  entryPoints: [path.join(zcodeRoot, "packages/services/src/session/tasksDatabase/schema-v1.ts")],
  outfile: schemaOut,
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: true,
  logLevel: "warning",
});
const { TASK_INDEX_SCHEMA } = await import(pathToFileURL(schemaOut).href);
fs.rmSync(schemaOut, { force: true });

// ══ A. taskIndexRepo.queryTaskList 的 excludeTaskIdPrefix 谓词 ══════════════
// WHERE 逐字照抄 taskIndexRepo.ts:1813-1837（kind=active + provider + excludeTaskIdPrefix）。
const WORKSPACE_KEY = "ws-mobile-1";
const PREFIX = "mobile-subagent-";
const PROVIDER = "zcode";
const WHERE_BASE = "deleted = 0 AND workspace_key IN (?) AND pinned = 0 AND archived = 0";
const WHERE_WITH_PREFIX = `${WHERE_BASE} AND substr(task_id, 1, ?) != ? AND provider = ?`;
const WHERE_WITHOUT_PREFIX = `${WHERE_BASE} AND provider = ?`;

const db = new DatabaseSync("/work/.zcode/task-index.sqlite");
db.exec(TASK_INDEX_SCHEMA);
// schema-v1 是「0001 接管已有分散建表」，后面几版 migration 还会给 tasks 补列与补索引
// （migrations.ts:13-39）。这里按声明补齐，免得查询计划与真机不一致。
for (const [table, column, definition] of [
  ["tasks", "searchable_text", "TEXT NOT NULL DEFAULT ''"],
  ["tasks", "cron_automation_id", "TEXT"],
  ["tasks", "off_peak_task_id", "TEXT"],
]) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); } catch { /* 已存在 */ }
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_cron_automation ON tasks(cron_automation_id, updated_at DESC)
    WHERE cron_automation_id IS NOT NULL AND deleted=0`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_off_peak_task ON tasks(off_peak_task_id, updated_at DESC)
    WHERE off_peak_task_id IS NOT NULL AND deleted=0`);
const insert = db.prepare(
  `INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, task_status,
     provider, mode, model, created_at, updated_at, pinned, archived, deleted, searchable_text, meta_json)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const TASK_COUNT = 3000;
const SUBAGENT_COUNT = 300;
const body = "正文摘要".repeat(200); // searchable_text 约 800 字符，接近真实会话摘要量级
const t0 = Date.now();
for (let i = 0; i < TASK_COUNT; i++) {
  const isSub = i < SUBAGENT_COUNT;
  const taskId = isSub ? `${PREFIX}${String(i).padStart(5, "0")}` : `task-${String(i).padStart(5, "0")}`;
  insert.run(
    WORKSPACE_KEY,
    "/work/demo",
    null,
    taskId,
    `会话 ${i}`,
    "idle",
    PROVIDER,
    "build",
    "glm-4.7",
    1_700_000_000_000 + i,
    1_700_000_000_000 + i,
    0,
    0,
    0,
    body,
    "{}",
  );
}
const seedMs = Date.now() - t0;

const planOf = (where) =>
  db.prepare(`EXPLAIN QUERY PLAN SELECT task_id FROM tasks WHERE ${where}`).all(...(
    where === WHERE_WITH_PREFIX ? [WORKSPACE_KEY, PREFIX.length, PREFIX, PROVIDER] : [WORKSPACE_KEY, PROVIDER]
  )).map((r) => r.detail);

const planWith = planOf(WHERE_WITH_PREFIX);
const planWithout = planOf(WHERE_WITHOUT_PREFIX);
out.sqlPlan = { withPrefix: planWith, withoutPrefix: planWithout };

const scanOf = (plan) => plan.some((d) => /^SCAN tasks\b/i.test(d));
check(
  "A1 excludeTaskIdPrefix 不导致全表扫描（走 workspace+pinned 偏索引）",
  !scanOf(planWith) && planWith.some((d) => /idx_tasks_workspace_pinned_updated/.test(d)),
  `plan=${JSON.stringify(planWith)}`,
);
check(
  "A2 带/不带谓词的查询计划一致（substr 只是行内过滤器）",
  JSON.stringify(planWith) === JSON.stringify(planWithout),
  `with=${JSON.stringify(planWith)} without=${JSON.stringify(planWithout)}`,
);

const timeQuery = (where, args) => {
  const sql = `SELECT workspace_key, workspace_path, workspace_identity, task_id, title, task_status,
  provider, mode, model, migration_source, forked_from_task_id, cron_automation_id, off_peak_task_id,
  created_at, updated_at, unread_at, pinned, archived, deleted, title_overridden, searchable_text, meta_json
  FROM tasks WHERE ${where} ORDER BY updated_at DESC, created_at DESC, task_id DESC LIMIT ?`;
  const stmt = db.prepare(sql);
  // 预热一次（statement cache / 页缓存），再量 5 次取中位数。
  stmt.all(...args);
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const s = process.hrtime.bigint();
    stmt.all(...args);
    runs.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  runs.sort((a, b) => a - b);
  return runs[2];
};
const countTime = (where, args) => {
  const stmt = db.prepare(`SELECT COUNT(1) AS total FROM tasks WHERE ${where}`);
  stmt.get(...args);
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const s = process.hrtime.bigint();
    stmt.get(...args);
    runs.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  runs.sort((a, b) => a - b);
  return runs[2];
};
const argsWith = [WORKSPACE_KEY, PREFIX.length, PREFIX, PROVIDER];
const argsWithout = [WORKSPACE_KEY, PROVIDER];
const listWith = timeQuery(WHERE_WITH_PREFIX, [...argsWith, 50]);
const listWithout = timeQuery(WHERE_WITHOUT_PREFIX, [...argsWithout, 50]);
const countWith = countTime(WHERE_WITH_PREFIX, argsWith);
const countWithout = countTime(WHERE_WITHOUT_PREFIX, argsWithout);
out.sqlTiming = {
  taskCount: TASK_COUNT,
  subagentCount: SUBAGENT_COUNT,
  seedMs,
  listWithPrefixMs: Number(listWith.toFixed(2)),
  listWithoutPrefixMs: Number(listWithout.toFixed(2)),
  countWithPrefixMs: Number(countWith.toFixed(2)),
  countWithoutPrefixMs: Number(countWithout.toFixed(2)),
};
// 谓词是行内过滤器：带与不带应当同量级（允许 2 倍以内的抖动）。
check(
  "A3 excludeTaskIdPrefix 谓词本身不带来数量级开销（列表+COUNT 都在 2x 以内）",
  listWith <= listWithout * 2 + 1 && countWith <= countWithout * 2 + 1,
  `list ${listWith.toFixed(2)}ms vs ${listWithout.toFixed(2)}ms, count ${countWith.toFixed(2)}ms vs ${countWithout.toFixed(2)}ms`,
);
const totalWith = db.prepare(`SELECT COUNT(1) AS total FROM tasks WHERE ${WHERE_WITH_PREFIX}`).get(...argsWith).total;
const totalWithout = db.prepare(`SELECT COUNT(1) AS total FROM tasks WHERE ${WHERE_WITHOUT_PREFIX}`).get(...argsWithout).total;
check(
  "A4 谓词口径正确：total 与 items 都按排除子会话后的集合算",
  totalWith === TASK_COUNT - SUBAGENT_COUNT && totalWithout === TASK_COUNT,
  `totalWith=${totalWith} totalWithout=${totalWithout}`,
);

// ══ B. session-store.save() 现在的双写 ══════════════════════════════════════
// agent.ts 的 persistSession → store.save()；0.9.0 的 scheduleCheckpoint 让它每 5 秒跑一次。
const storeOut = path.join(here, `.tmp-startup-path-store.mjs`);
await esbuild.build({
  entryPoints: [path.join(root, "ui/session-store.ts")],
  outfile: storeOut,
  bundle: true,
  format: "esm",
  platform: "neutral",
  external: ["../compat/shims/sqlite.mjs"],
  write: true,
  logLevel: "warning",
});
const { createMobileSessionStore } = await import(pathToFileURL(storeOut).href);
fs.rmSync(storeOut, { force: true });

const ROWS = 400;
const rows = [];
for (let i = 0; i < ROWS; i++) {
  rows.push({
    kind: i % 3 === 0 ? "userInput" : "assistantText",
    rowId: i + 1,
    turnId: `t${Math.floor(i / 4)}`,
    createdAt: 1_700_000_000_000 + i,
    text: "x".repeat(1200),
    state: "complete",
    model: "glm-4.7",
  });
}
const entry = {
  sessionId: "sess-bench",
  workspacePath: "/work/demo",
  summary: { sessionId: "sess-bench", title: "bench", lastActivityAt: Date.now() },
  state: {
    rows,
    config: { provider: PROVIDER, model: "glm-4.7" },
    revision: 1,
    cumulative: { inputTokens: 10, outputTokens: 20 },
    nextRowId: ROWS + 1,
    turnUsage: {},
    phase: "running",
    lastError: null,
  },
};
const stateJsonBytes = JSON.stringify(entry.state).length;
// 语句计数：把真引擎的 prepare 装一层计数代理，量「一次落盘发几条 SQL」。
const sqlCount = { prepare: 0, get: 0, all: 0, run: 0 };
// shim 里 DatabaseSync 是个**工厂函数**，实例是 WasmDatabaseSync/BridgeDatabaseSync——
// 所以要打在实例的原型上，不是函数原型上。
const probeDb = new DatabaseSync("/work/.zcode/.probe.sqlite");
const engineProto = Object.getPrototypeOf(probeDb);
const originalPrepare = engineProto.prepare;
engineProto.prepare = function patched(source) {
  sqlCount.prepare++;
  const stmt = originalPrepare.call(this, source);
  const rawGet = stmt.get.bind(stmt);
  const rawAll = stmt.all.bind(stmt);
  const rawRun = stmt.run.bind(stmt);
  stmt.get = (...a) => { sqlCount.get++; return rawGet(...a); };
  stmt.all = (...a) => { sqlCount.all++; return rawAll(...a); };
  stmt.run = (...a) => { sqlCount.run++; return rawRun(...a); };
  return stmt;
};

const store = createMobileSessionStore({ dbPath: "/work/.zcode/mobile-sessions-save.sqlite" });
sqlCount.prepare = 0; sqlCount.get = 0; sqlCount.all = 0; sqlCount.run = 0;
const saveTimes = [];
for (let i = 0; i < 5; i++) {
  const s = process.hrtime.bigint();
  store.save(entry);
  saveTimes.push(Number(process.hrtime.bigint() - s) / 1e6);
}
saveTimes.sort((a, b) => a - b);
const saveMedian = saveTimes[2];
out.storeSave = {
  rows: ROWS,
  stateJsonBytes,
  saveMedianMs: Number(saveMedian.toFixed(2)),
  allRuns: saveTimes.map((n) => Number(n.toFixed(2))),
  statementsPerSave: { prepare: sqlCount.prepare / 5, run: sqlCount.run / 5 },
};
check(
  "B1 一次落盘确实发了两条 INSERT（主表 + usage 投影表）",
  sqlCount.run / 5 === 2,
  `每落盘 prepare=${sqlCount.prepare / 5} run=${sqlCount.run / 5}（0.9.0 之前只有 1 条）`,
);

// 单独量「只写主表」的代价：拿 store 建好的那份库（同一引擎、同一张表）比一条手写 INSERT。
const benchDb = new DatabaseSync("/work/.zcode/mobile-sessions-save.sqlite");
benchDb.exec("CREATE TABLE IF NOT EXISTS mobile_sessions (session_id TEXT PRIMARY KEY, workspace_path TEXT, summary TEXT, state TEXT, updated_at INTEGER)");
const benchIns = benchDb.prepare("INSERT OR REPLACE INTO mobile_sessions (session_id, workspace_path, summary, state, updated_at) VALUES (?,?,?,?,?)");
const singleTimes = [];
for (let i = 0; i < 5; i++) {
  const s = process.hrtime.bigint();
  benchIns.run(entry.sessionId, entry.workspacePath, JSON.stringify(entry.summary), JSON.stringify(entry.state), Date.now());
  singleTimes.push(Number(process.hrtime.bigint() - s) / 1e6);
}
singleTimes.sort((a, b) => a - b);
const singleMedian = singleTimes[2];
out.storeSave.singleWriteMedianMs = Number(singleMedian.toFixed(2));
out.storeSave.doubleWriteOverheadMs = Number((saveMedian - singleMedian).toFixed(2));
check(
  "B2 双写让单次落盘成本不超过 3 倍（agent.ts 每 5 秒落一次盘）",
  saveMedian <= singleMedian * 3 + 2,
  `双写 ${saveMedian.toFixed(2)}ms vs 单写 ${singleMedian.toFixed(2)}ms（${ROWS} 行 / ${stateJsonBytes} 字节）`,
);

// ══ C. listUsageStates() 的语句条数（端侧每条 = 一次 JNI 往返）════════════════
// 统计 DatabaseSync.prepare 的调用次数：给真引擎装一层计数代理。
const SESSIONS = 40;
const CHUNK = 400;
// 灌老数据：只写主表 mobile_sessions，不写 usage 表 → listUsageStates 必然走
// 「老记录分块迁移」那条路。sql.js 在 close() 时才把整库写回 byteStore，所以灌完要 close。
const seedDb = new DatabaseSync("/work/.zcode/mobile-sessions-usage.sqlite");
seedDb.exec("CREATE TABLE IF NOT EXISTS mobile_sessions (session_id TEXT PRIMARY KEY, workspace_path TEXT NOT NULL, summary TEXT NOT NULL, state TEXT NOT NULL, updated_at INTEGER NOT NULL)");
seedDb.exec("CREATE INDEX IF NOT EXISTS idx_mobile_sessions_workspace ON mobile_sessions(workspace_path)");
for (let s = 0; s < SESSIONS; s++) {
  const sRows = [];
  for (let i = 0; i < CHUNK; i++) {
    sRows.push({ kind: "assistantText", rowId: i + 1, turnId: "t1", createdAt: 1_700_000_000_000 + i, text: "y".repeat(1500), state: "complete", model: "glm-4.7" });
  }
  const bigState = {
    rows: sRows,
    config: { provider: PROVIDER, model: "glm-4.7" },
    revision: 1,
    cumulative: { inputTokens: 1, outputTokens: 1 },
    nextRowId: CHUNK + 1,
    turnUsage: {},
    phase: "completedSuccess",
    lastError: null,
  };
  seedDb.prepare("INSERT OR REPLACE INTO mobile_sessions (session_id, workspace_path, summary, state, updated_at) VALUES (?,?,?,?,?)")
    .run(`sess-${s}`, "/work/demo", "{}", JSON.stringify(bigState), 1_700_000_000_000 + s);
}
seedDb.close();

const usageStore = createMobileSessionStore({ dbPath: "/work/.zcode/mobile-sessions-usage.sqlite" });
sqlCount.prepare = 0; sqlCount.get = 0; sqlCount.all = 0; sqlCount.run = 0;
const usageT0 = Date.now();
const usageStates = await usageStore.listUsageStates();
const usageMs = Date.now() - usageT0;
const firstReadSql = { ...sqlCount };
// 再跑一次「已经迁移过」的读取（命中 usage 表缓存）：量第二次读的成本。
sqlCount.prepare = 0; sqlCount.get = 0; sqlCount.all = 0; sqlCount.run = 0;
const usageT1 = Date.now();
await usageStore.listUsageStates();
const usageCachedMs = Date.now() - usageT1;
out.usageRead = {
  sessions: SESSIONS,
  rowsPerSession: CHUNK,
  elapsedMs: usageMs,
  sql: firstReadSql,
  cachedReadMs: usageCachedMs,
  cachedReadSql: { ...sqlCount },
  returned: usageStates.length,
};
check(
  "C1 listUsageStates 迁返回回全部会话（没漏读）",
  usageStates.length === SESSIONS,
  `returned=${usageStates.length}/${SESSIONS}`,
);
check(
  "C2 用量读取的 SQL 条数可接受（端侧每条是一次 JNI 往返）",
  sqlCount.prepare <= SESSIONS * 12,
  `prepare=${sqlCount.prepare} get=${sqlCount.get} all=${sqlCount.all} run=${sqlCount.run}（${SESSIONS} 会话）`,
);

engineProto.prepare = originalPrepare;

out.results = results;
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.detail ? `\n     ${r.detail}` : ""}`);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} PASS`);
console.log("JSON " + JSON.stringify(out));
process.exitCode = results.some((r) => !r.ok) ? 1 : 0;
