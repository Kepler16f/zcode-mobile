package cn.zcode.mobile

import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteStatement
import android.util.Base64
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * R16 的主修：端侧存储用框架自带的 SQLite（真文件），而不是把整库读进 WASM 堆。
 *
 * 为什么必须走 @JavascriptInterface 而不是异步通道：node:sqlite 的 DatabaseSync 从构造到
 * `prepare().run()` 全是同步的，而桌面那套 repositories 要在不改一行的前提下复用，
 * JS→原生的通道就只能同步阻塞。WebView 的名字注入恰好是同步的（JS 线程阻塞在 Java 方法上）。
 *
 * 三条通道带来的窄化，都写在注释里而不是靠调用方猜：
 *  1. 参数与返回值只能过字符串，所以统一 JSON；BLOB 双向都用 {"__b64__":".."}，
 *     不用前缀字符串——字符串列里真出现那个前缀就会被误解码。
 *  2. 读取走 rawQuery，它只接受 String[]。桌面 store 的 WHERE 绑的是 id 类 TEXT 列
 *     （实测 `WHERE id=? AND session_id=?`），靠 SQLite 列亲和性成立；出现按 BLOB 等值
 *     读取时要改 NDK 层 sqlite3_bind_*。写入不受这条限制：SQLiteStatement 有 typed bind。
 *  3. execSQL 一次只能一条语句，多语句拆分在 JS 侧 compat/shims/sql-split.mjs 完成并有实测。
 *
 * 这里刻意不调 enableWriteAheadLogging()：WAL 下 Android 会把 rawQuery 路由到只读连接，
 * 而 migration-runner 用 rawQuery 跑 `pragma journal_mode`、dwf-journal 用 `.get()` 跑
 * `insert ... returning`（repositories/dwf-journal.ts:401），这两类在只读连接上都会失败。
 * 单连接下这两条都成立，journal 模式仍由 store 自己的 pragma 决定。
 */
class SqliteBridge(private val context: Context) {

    private val dbs = ConcurrentHashMap<Long, SQLiteDatabase>()
    private val nextId = AtomicLong(1)

    @JavascriptInterface
    fun open(path: String): Long {
        val db = SQLiteDatabase.openOrCreateDatabase(resolve(path), null)
        val id = nextId.getAndIncrement()
        dbs[id] = db
        return id
    }

    @JavascriptInterface
    fun close(handle: Long) {
        dbs.remove(handle)?.close()
    }

    @JavascriptInterface
    fun exec(handle: Long, sql: String): String? {
        val db = dbs[handle] ?: return "no such database $handle"
        return try {
            // 判据必须大小写不敏感：桌面两套 store 的 pragma 写法不一致——session 的 migration-runner
            // 全用小写 `pragma busy_timeout`，而 TaskIndexRepo.initialize() 用大写
            // `PRAGMA busy_timeout = 5000` / `PRAGMA journal_mode = WAL`。原来这里按小写 startsWith
            // 判，大写 pragma 漏进 execSQL —— Android 的 execSQL 对"会返回结果集的语句"直接抛
            // （busy_timeout/journal_mode 都回一行），task-index 于是死在建库第一条语句上：
            // 表一张都建不出来，ensureReady 被 memoize 成永久 rejected，列表读取口每次抛、
            // 被上游吞成空列表 —— 这就是 0.3.6～0.3.9 装机"侧栏永远没有对话"的真根因
            // （0.3.9 报告 M10：库开着、只有 android_metadata、无 tasks 表）。
            if (sql.trimStart().startsWith("pragma", ignoreCase = true)) {
                // execSQL 拒绝会返回结果集的语句（`pragma busy_timeout = N` 会回一行），
                // 报 "Queries can be performed using SQLiteDatabase query or rawQuery methods only"。
                db.rawQuery(sql, null).use { it.count }
            } else {
                db.execSQL(sql)
            }
            null
        } catch (e: Exception) {
            e.message ?: e.javaClass.simpleName
        }
    }

    /**
     * @param mode "run" | "get" | "all"
     * @return run 返回 `{"changes":n,"lastInsertRowid":x}`；get/all 返回行数组 JSON。
     */
    @JavascriptInterface
    fun query(handle: Long, sql: String, params: String, mode: String): String {
        val db = dbs[handle] ?: throw IllegalStateException("no such database $handle")
        if (mode == "run") {
            return runStatement(db, sql, decodeParams(params))
        }
        // 读取侧只能按字符串绑定，见类注释第 2 条。
        val bound = decodeParams(params).map { value ->
            when (value) {
                null -> null
                is ByteArray -> throw IllegalArgumentException("原生桥不支持按 BLOB 等值查询，见类注释")
                else -> value.toString()
            }
        }.toTypedArray()
        val rows = JSONArray()
        db.rawQuery(sql, bound).use { cursor ->
            val columns = cursor.columnNames
            while (cursor.moveToNext()) {
                val row = JSONObject()
                columns.forEachIndexed { i, name ->
                    when (val value = typedValue(cursor, i)) {
                        null -> row.put(name, JSONObject.NULL)
                        is ByteArray -> row.put(name, JSONObject().put(BLOB_KEY, base64(value)))
                        else -> row.put(name, JSONObject.wrap(value))
                    }
                }
                rows.put(row)
            }
        }
        return rows.toString()
    }

    private fun runStatement(db: SQLiteDatabase, sql: String, bound: Array<Any?>): String {
        val statement = db.compileStatement(sql)
        bindParams(statement, bound)
        // 与上面 pragma 的 ignoreCase 同一条纪律：TaskIndexRepo 的迁移与 upsert 发的是**大写**
        // `INSERT INTO ...`（sqlite-session-store 那侧小写混用），按小写判会把 INSERT 误投进
        // executeUpdateDelete 分支——虽然 last_insert_rowid() 兜底不至于丢 rowid，但这是"侧栏空"
        // 那格栽过的同一类大小写不对称，这里一次改稳，别再留给下一个人踩。
        val head = sql.trimStart().take(8).lowercase()
        val isInsert = head.startsWith("insert") || head.startsWith("replace")
        val changes: Long
        val rowId: Long
        if (isInsert) {
            rowId = statement.executeInsert()
            changes = db.compileStatement("SELECT changes()").simpleQueryForLong() ?: 0
        } else {
            changes = statement.executeUpdateDelete().toLong()
            rowId = db.compileStatement("SELECT last_insert_rowid()").simpleQueryForLong() ?: 0
        }
        return JSONObject().put("changes", changes).put("lastInsertRowid", rowId).toString()
    }

    private fun bindParams(statement: SQLiteStatement, bound: Array<Any?>) {
        bound.forEachIndexed { i, value ->
            val index = i + 1
            when (value) {
                null -> statement.bindNull(index)
                is Long -> statement.bindLong(index, value)
                is Int -> statement.bindLong(index, value.toLong())
                is Double -> statement.bindDouble(index, value)
                is Boolean -> statement.bindLong(index, if (value) 1L else 0L)
                is ByteArray -> statement.bindBlob(index, value)
                else -> statement.bindString(index, value.toString())
            }
        }
    }

    /** JS 侧的路径是 vfs 命名空间（`/zcode-mobile/db.sqlite`），落不到 Android 的真实目录，
     *  所以统一挂到应用私有的 zcode/databases 下，同时挡掉 `..` 逃逸。 */
    private fun resolve(path: String): File {
        val relative = path.trimStart('/').replace('\\', '/')
        require(!relative.split('/').any { it == ".." } && relative.isNotEmpty()) {
            "非法数据库路径：$path"
        }
        val file = File(dir(), relative)
        file.parentFile?.mkdirs()
        return file
    }

    private fun dir(): File = ZcodePaths.databasesRoot(context)

    private fun typedValue(cursor: Cursor, index: Int): Any? = when (cursor.getType(index)) {
        Cursor.FIELD_TYPE_NULL -> null
        Cursor.FIELD_TYPE_BLOB -> cursor.getBlob(index)
        Cursor.FIELD_TYPE_FLOAT -> cursor.getDouble(index)
        Cursor.FIELD_TYPE_STRING -> cursor.getString(index)
        else -> cursor.getLong(index)
    }

    private fun base64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)

    private fun decodeParams(json: String): Array<Any?> {
        if (json.isEmpty() || json == "[]") return emptyArray()
        val array = JSONArray(json)
        return Array(array.length()) { i ->
            when (val value = array.get(i)) {
                JSONObject.NULL -> null
                is JSONObject ->
                    if (value.has(BLOB_KEY)) Base64.decode(value.getString(BLOB_KEY), Base64.NO_WRAP)
                    else value.toString()
                is JSONArray -> value.toString()
                is Number -> if (value.toString().contains('.')) value.toDouble() else value.toLong()
                else -> value
            }
        }
    }

    private companion object {
        const val BLOB_KEY = "__b64__"
    }
}
