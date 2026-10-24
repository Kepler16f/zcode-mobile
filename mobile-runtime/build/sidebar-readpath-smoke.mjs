// 侧栏根因的端到端复现冒烟（2026-10-07 装机报告里唯一 FAIL 的那条）。
//
// 真机报告：命名参数绑定探针 FAIL —— "prepare().all 失败 (Java exception was raised…)"。
// 根因：Android SQLiteDatabase.rawQuery(sql, String[]) 对每个绑定值调 bindString，
// **null 元素当场抛**。侧栏 listTaskMetas 用 `@workspace_key IS NULL OR …` 查全部时绑 null，
// 于是真机每次读列表都死、同步器把异常吞成空列表。桌面 sql.js 容忍 null，所以桌面全绿——
// 连 selfcheck 那个照 Kotlin 写的假桥当时也没复现（它把 null 直接 return null 了）。
//
// 这一条把假桥做到"像 Android"：get/all 收到任何 null 绑定就抛。修法是 JS 侧把读参数
// 内联成字面量（readWire），过桥的 params 恒为空。底座用 Node 自带的真 node:sqlite，
// 比 sql.js 更接近设备上的框架 SQLite。
import { DatabaseSync } from "node:sqlite";

// 桥收到的 get/all 请求里带过 null 绑定的次数——修复生效的话必须是 0。
let nullBindSeen = 0;

function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function makeAndroidStrictBridge() {
  const dbs = new Map();
  let next = 1;
  return {
    open(path) {
      const id = next++;
      dbs.set(id, new DatabaseSync(":memory:"));
      return id;
    },
    close(id) {
      dbs.get(id)?.close();
      dbs.delete(id);
    },
    exec(id, sql) {
      try {
        dbs.get(id).exec(sql);
        return null;
      } catch (e) {
        return String(e?.message ?? e);
      }
    },
    query(id, sql, paramsJson, mode) {
      const db = dbs.get(id);
      const params = JSON.parse(paramsJson || "[]");
      // 模拟 decodeParams：{"__b64__":..} 还原 BLOB。
      const bound = params.map((value) =>
        value && typeof value === "object" && typeof value.__b64__ === "string"
          ? new Uint8Array(Buffer.from(value.__b64__, "base64"))
          : value,
      );
      if (mode === "run") {
        // 写路径：typed bind，null 合法（Android 的 compileStatement+bindNull 正是如此，真机 17/18 全绿）。
        db.prepare(sql).run(...bound);
        return JSON.stringify({ changes: 0, lastInsertRowid: 0 });
      }
      // 读路径：rawQuery(String[])——任何 null 绑定都抛，一个都不放过。
      for (const value of bound) {
        if (value === null || value === undefined) nullBindSeen += 1;
      }
      if (bound.some((value) => value === null || value === undefined)) {
        throw new Error("Queries can be performed using SQLiteDatabase query or rawQuery methods only (null bind)");
      }
      const rows = db.prepare(sql).all(...bound.map((v) => (typeof v === "object" ? v : v)));
      return JSON.stringify(
        rows.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? { __b64__: b64(v) } : v]),
          ),
        ),
      );
    },
  };
}

globalThis.zcodeSqlite = makeAndroidStrictBridge();

// sqlite.mjs 的 DatabaseSync 派发：zcodeSqlite 在 → BridgeDatabaseSync → 走 readWire 内联。
const { DatabaseSync: ShimDatabaseSync } = await import("../compat/shims/sqlite.mjs");

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, why: String(e?.message ?? e).slice(0, 160) });
  }
};

const db = new ShimDatabaseSync("/work/.zcode/sidebar-probe.sqlite");
db.exec("CREATE TABLE t (k TEXT, n TEXT, deleted INTEGER DEFAULT 0, updated_at INTEGER)");
db.prepare("INSERT INTO t (k, n, deleted, updated_at) VALUES (?, ?, ?, ?)").run("ws/a", "one", 0, 100);
db.prepare("INSERT INTO t (k, n, deleted, updated_at) VALUES (?, ?, ?, ?)").run("ws/b", "two", 0, 200);

// 判据 1 = 装机报告里 FAIL 的那条：查全部时 @k 绑 null，必须不炸且返回两行。
check("查全部（@k IS NULL 那支）：null 绑定不再过桥，rawQuery 语义下不抛", () => {
  const rows = db
    .prepare(`SELECT n FROM t WHERE (@k IS NULL OR k = @k) AND deleted = 0 AND '-- @notaparam' <> '' ORDER BY updated_at DESC`)
    .all({ k: null })
    .map((r) => r.n);
  if (JSON.stringify(rows) !== JSON.stringify(["two", "one"])) throw new Error(`两行查丢：${JSON.stringify(rows)}`);
  if (nullBindSeen !== 0) throw new Error(`有 ${nullBindSeen} 个 null 绑定进了桥（readWire 没生效）`);
});

check("按值过滤：@k='ws/a' 只回 one", () => {
  const rows = db.prepare("SELECT n FROM t WHERE (@k IS NULL OR k = @k) AND deleted = 0").all({ k: "ws/a" });
  if (JSON.stringify(rows.map((r) => r.n)) !== JSON.stringify(["one"])) throw new Error(JSON.stringify(rows));
});

check("位置参数（run/get/all 混用）也正常：statement.get 走内联", () => {
  const row = db.prepare("SELECT n FROM t WHERE k = ?").get("ws/b");
  if (row?.n !== "two") throw new Error(JSON.stringify(row));
});

check("参数名对不上照旧抛（rewrite 守门不被内联绕过）", () => {
  let threw = false;
  try {
    db.prepare("SELECT n FROM t WHERE k = @nope").all({ k: "ws/a" });
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("缺参数静默跑了");
});

// listTaskMetas 的真实形状（taskIndexRepo.ts:1668）：5 个命名参数，"查全部任务"这一支
// workspace_key/provider/pinned/archived 全是 null，只有 include_deleted 是 0/1 数字。
// 这一条就是装机报告 FAIL 的正体——多个 null 同时过 rawQuery(String[]) 必抛。
check("listTaskMetas 真实形状：5 个命名参数、4 个为 null，一次读全部", () => {
  db.exec("CREATE TABLE tasks (workspace_key TEXT, provider TEXT, pinned INTEGER, archived INTEGER, deleted INTEGER, updated_at INTEGER, task_id TEXT)");
  db.prepare(
    "INSERT INTO tasks (workspace_key, provider, pinned, archived, deleted, updated_at, task_id) VALUES (?,?,?,?,?,?,?)",
  ).run("ws/a", "glm", 0, 0, 0, 100, "ses-a");
  db.prepare(
    "INSERT INTO tasks (workspace_key, provider, pinned, archived, deleted, updated_at, task_id) VALUES (?,?,?,?,?,?,?)",
  ).run("ws/b", "glm", 0, 0, 0, 200, "ses-b");
  const rows = db
    .prepare(
      `SELECT task_id FROM tasks WHERE (@workspace_key IS NULL OR workspace_key = @workspace_key)
       AND (@include_deleted = 1 OR deleted = 0)
       AND (@provider IS NULL OR provider = @provider)
       AND (@pinned IS NULL OR pinned = @pinned)
       AND (@archived IS NULL OR archived = @archived)
       ORDER BY updated_at DESC`,
    )
    .all({ workspace_key: null, include_deleted: 0, provider: null, pinned: null, archived: null });
  const ids = rows.map((r) => r.task_id);
  if (JSON.stringify(ids) !== JSON.stringify(["ses-b", "ses-a"])) throw new Error(`读丢/读乱：${JSON.stringify(ids)}`);
  if (nullBindSeen !== 0) throw new Error(`桥又收到 null 绑定（readWire 漏了多参数场景）：${nullBindSeen}`);
});

db.close();

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  process.stdout.write(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  → ${r.why}`}\n`);
}
process.stdout.write(`\n侧栏读路径（Android 严格桥）冒烟：${results.length - failed.length}/${results.length} PASS\n`);
process.exitCode = failed.length > 0 ? 1 : 0;
