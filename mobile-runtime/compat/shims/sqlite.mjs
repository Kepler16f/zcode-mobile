// node:sqlite 的 DatabaseSync 垫片。桌面 store 只用 exec / prepare(run|get|all) / close。
//
// 参数绑定有两种形状，这里都支持（sqlite-named.mjs）：位置 `?`，以及 node:sqlite 那种
// 单个命名参数字典（taskIndexRepo.listTaskMetas 用的是 @workspace_key）。上一版这层的注释
// 写着"参数全是位置绑定，所以可以很薄"，那条假设被 listTaskMetas 当场证伪：
// 整个对象被当成一个位置参数递给 sql.js，报 "tried to bind a value of an unknown type"，
// 而它炸的是端侧读数口 taskRows() —— 侧栏为什么没行，本来应该由它回答。
//
// 为什么构造函数是同步的却能加载 WASM：宿主必须先 `await configureSqlite()`，
// 之后 DatabaseSync 才是同步的——这是 node:sqlite 契约要求的形状，不是我们的选择。
// 字节读写走注入的 byteStore（M2 里是 OPFS/SAF，探针里是内存 Map），
// 这样"打开已存在的库"和桌面端保持同一份 SQL、同一份文件格式。
import { normalizeBindValues } from "./sqlite-named.mjs";

let runtime = null;
// 默认 null：有原生桥就用桥（R16 的整库进内存问题只在这条路上不存在）。
// 只有自检的引擎对照会临时置成 "wasm"。
let forceWasmEngine = false;

function bindable(value) {
  if (value === true) return 1;
  if (value === false) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "bigint") return Number(value);
  return value ?? null;
}

// sql.js 的 Database 上没有 lastInsertRowid()/changes()（实测它的 prototype 只有
// getRowsModified 等少数具名方法），只能按 SQLite 的原语查回来。
function scalar(db, sql) {
  const res = db.exec(sql);
  if (!res.length || !res[0].values.length) return null;
  return res[0].values[0][0];
}

function changedRows(db) {
  return typeof db.getRowsModified === "function" ? db.getRowsModified() : scalar(db, "SELECT changes()");
}

class StatementSync {
  constructor(db, source) {
    this.db = db;
    this.source = source;
  }

  bind(args) {
    // 命名参数在这里被改写成一串 `?`，所以 prepare 用的是改写后的 SQL —— 两个后端从此只认位置绑定。
    const { sql, positional } = normalizeBindValues(this.source, args);
    const stmt = this.db.prepare(sql);
    try {
      if (positional.length) stmt.bind(positional.map(bindable));
      return stmt;
    } catch (e) {
      stmt.free();
      throw e;
    }
  }

  run(...args) {
    const stmt = this.bind(args);
    try {
      stmt.step();
    } finally {
      stmt.free();
    }
    return { changes: changedRows(this.db), lastInsertRowid: scalar(this.db, "SELECT last_insert_rowid()") };
  }

  get(...args) {
    const stmt = this.bind(args);
    try {
      return stmt.step() ? stmt.getAsObject() : undefined;
    } finally {
      stmt.free();
    }
  }

  all(...args) {
    const stmt = this.bind(args);
    const rows = [];
    try {
      while (stmt.step()) rows.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }
    return rows;
  }

  iterate(...args) {
    return this.all(...args)[Symbol.iterator]();
  }
}

import { BridgeDatabaseSync, isNativeSqliteAvailable } from "./sqlite-native.mjs";
import { splitSqlStatements, transactionKeyword } from "./sql-split.mjs";

// node:sqlite 的唯一入口。两个引擎按宿主能力在这里选，桌面 store 那边一行都不知道：
//   原生桥（Android zcodeSqlite）→ 真文件，只有行进 JS 堆，修的是 §7 R16；
//   sql.js（WASM）→ 唯一同步可用的纯 JS 引擎，鸿蒙没确认同步通道前先拿它兜底。
// 所以只要原生桥在，就绝不落回整库进内存的那条路。
export function DatabaseSync(path, options) {
  // options 必须原样转给桥：桌面 store 传的是 {timeout}（等写锁的毫秒数），丢了它
  // 并发启动就从"等一会儿"变成"直接失败"。WASM 那边是单线程内存库，没有锁可等。
  return isNativeSqliteAvailable() && !forceWasmEngine ? new BridgeDatabaseSync(path, options) : new WasmDatabaseSync(path, options);
}

class WasmDatabaseSync {
  constructor(path, options = {}) {
    if (!runtime) {
      throw new Error("DatabaseSync 需要先 await configureSqlite()：WASM 引擎加载是异步的，node:sqlite 的构造是同步的。");
    }
    this.path = path;
    this.options = options;
    const existing = runtime.byteStore?.read?.(path);
    this.db = existing ? new runtime.SQL.Database(existing) : new runtime.SQL.Database();
    this.open = true;
    this.inTransaction = false;
  }

  exec(source) {
    this.db.exec(source);
    // sql.js 允许一次跑多条，但 migration-runner 用 db.isTransaction 决定失败时要不要补
    // rollback；node:sqlite 有这个 getter，sql.js 和桥都没有，缺了它 rollback 会被静默跳过。
    for (const statement of splitSqlStatements(source)) {
      const kind = transactionKeyword(statement);
      if (kind) this.inTransaction = kind === "open";
    }
  }

  get isTransaction() {
    return this.inTransaction;
  }

  prepare(source) {
    return new StatementSync(this.db, source);
  }

  function(name, fn) {
    this.db.create_function(name, fn);
  }

  exportBytes() {
    return this.db.export();
  }

  close() {
    if (!this.open) return;
    this.open = false;
    // sql.js 是内存库：不在这一步落盘，关掉的瞬间写进文件系统的就只有半截事务。
    runtime.byteStore?.write?.(this.path, this.db.export());
    this.db.close();
  }
}

export async function configureSqlite({ sqlJsFactory, locateFile, byteStore, prefer }) {
  // 诊断用：prefer==="wasm" 时，即使原生桥在也照样加载 WASM 引擎。
  // 为什么要这个口子：0.0.2 在 WSA 上两条 0019 失败看起来像"WASM 也扛不住"，其实派发器
  // 见有桥就用桥，WASM 在那台宿主上一次都没跑过（§7 R21）。"是不是框架 SQLite 缺 JSON1"
  // 必须能在同一台宿主上用两个引擎各跑一遍才知道，而默认策略永远不给第二个引擎机会。
  forceWasmEngine = prefer === "wasm";
  // 原生桥在的话根本不需要 WASM 引擎：省掉 655 KB wasm 下载，也省掉整库进内存。
  if (isNativeSqliteAvailable() && !forceWasmEngine) return null;
  if (runtime) return runtime;
  const SQL = await sqlJsFactory(locateFile ? { locateFile } : undefined);
  runtime = { SQL, byteStore };
  return runtime;
}

export function isSqliteReady() {
  return (isNativeSqliteAvailable() && !forceWasmEngine) || runtime !== null;
}

export function sqliteEngine() {
  return isNativeSqliteAvailable() && !forceWasmEngine ? "native-android-sqlite" : runtime ? "sql.js-wasm" : "none";
}
