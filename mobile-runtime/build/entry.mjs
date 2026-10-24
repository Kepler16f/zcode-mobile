// 移动端 runtime 的入口：core 的全部导出 + 端侧垫片自己暴露出来的能力。
// M2 的 createMobileServices() 会挂在这里。
import * as core from "../../zcode/apps/zcode-cli/packages/core/dist/index.js";
import * as vfs from "../compat/vfs.mjs";

export * from "../../zcode/apps/zcode-cli/packages/core/dist/index.js";
// core 的 index 没有转发 FileSystemPortError，但端口必须抛 contracts 里那个类：
// isFileSystemPortError() 走的是 instanceof，自造同名类会被当成未知错误。
export { FileSystemPortError, HttpClientPortError, isFileSystemPortError } from "../../zcode/apps/zcode-cli/packages/contracts/dist/index.js";
export { createMobileFileSystemPort } from "../ports/file-system.mjs";
export { createMobileHttpClientPort } from "../ports/http-client.mjs";
export { createMobileExecutionPort } from "../ports/execution.mjs";
export { createNativeExecBridge, isNativeExecAvailable } from "../ports/execution-bridge-android.mjs";
// 端侧不自建 schema：直接复用桌面那套 sqlite-session-store（+1052 KB、只多要 node:sqlite），
// 于是迁移、31 个方法、与桌面同格式的 db.sqlite 都免费拿到。见 §1.5.3。
export { createSqliteSessionStore, SqliteSessionStore } from "../../zcode/apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts";
export { configureSqlite, DatabaseSync, isSqliteReady, sqliteEngine } from "../compat/shims/sqlite.mjs";
// 自检里的假桥要和 SqliteBridge.kt 用同一条"一次一句"判据，所以拆分器必须是 runtime 的一部分。
export { splitSqlStatements, transactionKeyword } from "../compat/shims/sql-split.mjs";
// 真盘文件桥（zcodeFs）的引擎选择权必须暴露给自检：OPFS 在 WebView 里不可用是实测结论，
// vfs 现在有两个后端，报告里必须说清这次跑的是哪一个。
export { isNativeFsAvailable, setFsEngine, engine as fsEngine } from "../compat/vfs.mjs";
export { vfs };
export default core;
