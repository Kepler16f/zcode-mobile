// R16 的 Android 侧引擎：node:sqlite 的 DatabaseSync 形状不变，底下换成框架原生 SQLite。
// 与 sql-wasm 那版的分工——sql.js 整库进内存（实测桌面 db.sqlite 已 36 MB + 4 MB WAL），
// 原生桥只把行传给 JS，字节不进堆；所以有 zcodeSqlite 就一定优先用它。
//
// 通道约束：@JavascriptInterface 只过得去基本类型和字符串，所以参数走 JSON，
// BLOB 双向都用 {"__b64__":..}。写入侧 Kotlin 用 SQLiteStatement 的 typed bind（含 bindBlob），
// 读取侧的参数在 JS 里**内联成 SQL 字面量**（readWire），桥收到的是无参数的 SQL：
// rawQuery(String[]) 对 null 元素会抛 Java 异常，而侧栏的 listTaskMetas 恰恰用
// "@k IS NULL OR k = @k" 的 null 语义查全部——桌面 sql.js 容忍 null、真机不容忍，
// 装机自检 2026-10-07 的"命名参数绑定 FAIL"就是这条通道限制，内联绕开它。
import { splitSqlStatements, transactionKeyword } from "./sql-split.mjs";
import { inlinePositionalParameters, normalizeBindValues } from "./sqlite-named.mjs";

const BLOB_KEY = "__b64__";
const SQLITE_BUSY = 5;

/**
 * 把原生桥的错误还原成 node:sqlite 的形状。
 *
 * 为什么必须补：migration-runner 的 isSqliteBusyError() 只认 `error.errcode`（node:sqlite 才有的字段），
 * 而 Android 的 SQLiteException 把结果码塞在消息文本里（"[5] database is locked" / "[SQLITE_BUSY]"）。
 * 不补这一层，瞬时锁冲突就不算锁冲突 —— 同步迁移路径里 Atomics.wait 又被 prelude 降级成 no-op，
 * 结果是"别人正持有写锁"直接变成启动失败，而不是等一会儿重试。
 */
function bridgeError(message, cause) {
  const error = new Error(message);
  if (/SQLITE_BUSY|\[5\]|database is locked|lock table is full/i.test(message)) {
    error.errcode = SQLITE_BUSY;
    error.code = "SQLITE_BUSY";
  }
  if (cause) error.cause = cause;
  return error;
}

/** 同步桥的调用点统一走这里：Java 侧异常到 JS 只剩消息文本。 */
function throughBridge(label, fn) {
  try {
    return fn();
  } catch (e) {
    throw bridgeError(`${label} 失败 (${String(e?.message ?? e).slice(0, 200)})`, e);
  }
}

function toWire(value) {
  if (value === true) return 1;
  if (value === false) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object" && typeof value.byteLength === "number") {
    return { [BLOB_KEY]: base64Encode(value instanceof Uint8Array ? value : new Uint8Array(value)) };
  }
  return value ?? null;
}

function fromWire(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    // BLOB 用 {"__b64__":".."} 而不是前缀字符串：字符串列里真出现 "b64:" 就会被误解码。
    out[key] =
      value && typeof value === "object" && typeof value[BLOB_KEY] === "string"
        ? base64Decode(value[BLOB_KEY])
        : value;
  }
  return out;
}

function base64Encode(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64Decode(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

class BridgeStatementSync {
  constructor(db, source) {
    this.db = db;
    this.source = source;
  }

  /**
   * 过桥前的参数折叠：node:sqlite 允许 `stmt.all({ workspace_key: null })` 这种命名参数写法
   * （上游 taskIndexRepo 就在用），而 Android 的 SQLiteDatabase 只有位置绑定、
   * 也没有能查参数名的接口。所以在 JS 侧统一改写成 `?` + 有序数组，Kotlin 一行都不用改。
   * 见 sqlite-named.mjs 顶部那段"为什么在这一侧改写"。
   */
  wire(args) {
    const { sql, positional } = normalizeBindValues(this.source, args);
    return [sql, JSON.stringify(positional.map(toWire))];
  }

  /**
   * 读路径专用：把位置参数内联成字面量后以**空参数数组**过桥。
   *
   * 为什么 get/all 不能像 run 那样走位置绑定：run 底下是 compileStatement + typed bind
   * （bindNull 支持 NULL，真机 17/18 全绿），而 get/all 底下的 rawQuery(String[]) 会对
   * 每个绑定值调 bindString，**null 元素当场抛 Java 异常**。侧栏的 listTaskMetas 在
   * "查全部任务"时 @workspace_key 绑的就是 null（`@k IS NULL OR k = @k` 那支），于是
   * 真机上每次读列表都死、同步器把异常吞成空列表 —— 装机自检 2026-10-07 那条
   * "命名参数绑定 FAIL（Java exception was raised…）"就是它。sql.js 会把 null 静默绑成
   * NULL，所以桌面全绿、只有真机炸。内联掉 null 就绕开了这条 Kotlin 通道的硬限制，
   * 顺带把 BLOB 等值读也支持了（x'…' 字面量，不用改 NDK）。
   */
  readWire(args) {
    const { sql, positional } = normalizeBindValues(this.source, args);
    // 不做 toWire 折叠：那是给"值过 JSON 通道"准备的（Uint8Array→{"__b64__":..}），
    // 而内联器自己认 Uint8Array/Date/bigint/布尔——先 toWire 反而把 BLOB 变成内联器拒收的裸对象。
    return [inlinePositionalParameters(sql, positional), "[]"];
  }

  run(...args) {
    const [sql, json] = this.wire(args);
    return JSON.parse(
      throughBridge("prepare().run", () => this.db.bridge.query(this.db.handle, sql, json, "run")),
    );
  }

  all(...args) {
    const [sql, json] = this.readWire(args);
    const rows = JSON.parse(
      throughBridge("prepare().all", () => this.db.bridge.query(this.db.handle, sql, json, "all")),
    );
    return rows.map(fromWire);
  }

  get(...args) {
    const [sql, json] = this.readWire(args);
    const rows = JSON.parse(
      throughBridge("prepare().get", () => this.db.bridge.query(this.db.handle, sql, json, "get")),
    );
    return rows.length ? fromWire(rows[0]) : undefined;
  }

  iterate(...args) {
    return this.all(...args)[Symbol.iterator]();
  }
}

export class BridgeDatabaseSync {
  constructor(path, options = {}) {
    const bridge = globalThis.zcodeSqlite;
    if (!bridge) throw new Error("zcodeSqlite 桥不存在：这个 WebView 没装上原生 SQLite 通道");
    this.bridge = bridge;
    this.path = path;
    this.handle = throughBridge("open", () => bridge.open(path));
    this.open = true;
    this.inTransaction = false;
    // node:sqlite 用第二参的 timeout 表达"抢不到写锁时最多等多久"，桌面 store 的构造函数
    // 一定会传（默认 5 秒），并且要求在首条 PRAGMA 之前生效。原生桥不接这条就等于把
    // 并发启动的等待语义丢了——所以在这里立刻落成 pragma busy_timeout。
    const timeoutMs = Number(options?.timeout);
    if (Number.isFinite(timeoutMs) && timeoutMs >= 0) {
      throughBridge("pragma busy_timeout", () =>
        this.bridge.exec(this.handle, `pragma busy_timeout = ${Math.round(timeoutMs)}`),
      );
    }
  }

  exec(source) {
    // 一次一条：Android 的 nativePrepareStatement 见到分号后仍有内容直接抛。
    for (const statement of splitSqlStatements(source)) {
      const error = throughBridge(`exec (${statement.slice(0, 60)})`, () => this.bridge.exec(this.handle, statement));
      if (error) throw bridgeError(`SQLite exec failed (${this.path}): ${error}`);
      const kind = transactionKeyword(statement);
      if (kind) this.inTransaction = kind === "open";
    }
  }

  get isTransaction() {
    return this.inTransaction;
  }

  prepare(source) {
    return new BridgeStatementSync(this, source);
  }

  exportBytes() {
    // 原生库自己落盘，没有"整库导出"这一步；调用方拿它做备份时会拿到 undefined。
    return undefined;
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.bridge.close(this.handle);
  }
}

export function isNativeSqliteAvailable() {
  return typeof globalThis.zcodeSqlite?.open === "function";
}
