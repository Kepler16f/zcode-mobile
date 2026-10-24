// 端侧会话持久化：把每一轮的时间线（rows）、模型配置、token 用量存进 SQLite，跨重启还原。
//
// 为什么必须有这一层：0.3.2 之前对话只活在 agent.ts 的内存 Map 里，杀进程后
// subscribeConversationV4 只能回 missingSession 的占位（"这台设备上看不到之前那次对话的内容"）——
// 用户症状就是"退出后无法还原"。侧栏的 task-index 库本来就落盘（TaskIndexRepo → node:sqlite
// 垫片 → Android SqliteBridge 真文件），但点开那一行是空对话，行在也等于不在。
//
// 存储引擎复用已装配好的 node:sqlite 垫片（compat/shims/sqlite.mjs）：
//   Android = zcodeSqlite 原生桥（真文件，落 ZcodePaths.databasesRoot）；
//   桌面自检 = sql.js + vfs byteStore。
// 引擎没就绪（isSqliteReady() 为 false）时本层返回 null，agent 面退回纯内存并如实报
// "没有持久化"，绝不静默假装存下了。
//
// 写频是**每轮一次**（startTurn / settleTurn / 配置变更），不是逐 token：两个后端的写都是
// 同步通道（JNI 往返 / WASM 内存写），逐 token 写会把流式渲染卡住——与帧协议 30 ms 合并
// 增量（agent.ts 的 FLUSH_WINDOW_MS）是同一个理由。
//
// SQL 只用 INSERT OR REPLACE，不用 UPSERT（ON CONFLICT DO UPDATE 要 SQLite 3.24+，
// 而 minSdk 26 的设备框架库是 3.19）。
import type {
  ConversationRow,
  SessionConfigState,
  SessionControl,
  SessionSummary,
} from "@zcode/shared/zcode-protocol-v4";
// node:sqlite 的垫片（.mjs）。tsconfig 是 allowJs+checkJs:false，导入合法但类型是 any，
// 所以本文件用自己声明的窄接口 SyncDatabase 收口，不让 any 漏进调用方。
import { DatabaseSync, isSqliteReady, sqliteEngine } from "../compat/shims/sqlite.mjs";

/** 与 tasks-index.sqlite 同一棵树；Android 侧 SqliteBridge.resolve 把它映射进应用私有目录。 */
export const MOBILE_SESSIONS_DB_PATH = "/work/.zcode/mobile-sessions.sqlite";

/** 一次重启最多水合进侧栏的历史会话数。手机上一屏放不下更多，也不该把库全读进内存。 */
const HYDRATE_LIMIT = 200;

export interface PersistedTurnUsage {
  inputTokens: number;
  outputTokens: number;
}

/** 会话的完整可还原状态。control 不整体存：它由 phase + lastError 在还原时重新派生。 */
export interface PersistedSessionState {
  rows: ConversationRow[];
  config: SessionConfigState;
  revision: number;
  cumulative: { inputTokens: number; outputTokens: number };
  nextRowId: number;
  /** 每轮的网关用量。readSession 的 snapshot 按轮报 tokens，丢了它还原后全变 0。 */
  turnUsage: Record<string, PersistedTurnUsage>;
  phase: SessionControl["phase"];
  lastError: SessionControl["lastError"];
}

export interface PersistedSession {
  sessionId: string;
  workspacePath: string;
  /** 存的时候 workspaceId 是占位（路径）；水合进 sessions-index 时由调用方换成 workspaceKey。 */
  summary: SessionSummary;
  state: PersistedSessionState;
  updatedAt: number;
}

export interface MobileSessionStore {
  save(entry: Omit<PersistedSession, "updatedAt">): void;
  load(sessionId: string): PersistedSession | null;
  /** 摘要级列表（侧栏水合用）：只读 summary 列，不把全部历史行拖进内存。 */
  listSummaries(
    workspacePath: string,
    limit?: number,
  ): Array<{ sessionId: string; summary: SessionSummary; updatedAt: number }>;
  /**
   * 跨 workspace 列全部会话的完整可还原状态（用量统计聚合用）。
   * 侧栏的 listSummaries 只按单 workspace 读摘要；App Usage 要的是"这台设备一共用了多少"，
   * 所以这一格跨 workspace、带 state（tokens 在 state 里）。limit 兜内存：手机不该把全部历史
   * 行拖进堆，超过就按 updated_at 新→旧截断，用量统计是"最近这么多会话"的口径，可接受。
   */
  listAllStates(
    limit?: number,
  ): Array<{ sessionId: string; workspacePath: string; state: PersistedSessionState; updatedAt: number }>;
  engine(): string;
}

/** 垫片返回的联合类型收窄成本层真正用到的那一面（两个后端形状一致，见 sqlite.mjs 头注）。 */
interface SyncDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): Record<string, unknown> | undefined;
    all(...args: unknown[]): Array<Record<string, unknown>>;
  };
  close(): void;
}

function parseState(raw: unknown): PersistedSessionState | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedSessionState>;
    // 形状判据只挑"还原后一定会被用到"的三格：rows 不是数组、config/phase 缺失，
    // 与其还原出一个会在投影里炸的会话，不如当成没有（调用方会如实报"找不到"）。
    if (!Array.isArray(parsed.rows) || !parsed.config || typeof parsed.phase !== "string") return null;
    return {
      rows: parsed.rows as ConversationRow[],
      config: parsed.config as SessionConfigState,
      revision: Number(parsed.revision ?? 0),
      cumulative: {
        inputTokens: Number(parsed.cumulative?.inputTokens ?? 0),
        outputTokens: Number(parsed.cumulative?.outputTokens ?? 0),
      },
      nextRowId: Number(parsed.nextRowId ?? parsed.rows.length + 1),
      turnUsage: (parsed.turnUsage ?? {}) as Record<string, PersistedTurnUsage>,
      phase: parsed.phase as SessionControl["phase"],
      lastError: (parsed.lastError ?? null) as SessionControl["lastError"],
    };
  } catch {
    return null;
  }
}

function parseSummary(raw: unknown): SessionSummary | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as SessionSummary;
    if (typeof parsed?.sessionId !== "string" || typeof parsed?.phase !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function createMobileSessionStore(
  options: { dbPath?: string; onDiagnostic?: (message: string) => void } = {},
): MobileSessionStore | null {
  const say = options.onDiagnostic ?? (() => {});
  if (!isSqliteReady()) {
    say("会话持久化不可用：SQLite 引擎没就绪（原生桥不在，WASM 也没配置）——对话只活在本进程");
    return null;
  }
  const dbPath = options.dbPath ?? MOBILE_SESSIONS_DB_PATH;
  let db: SyncDatabase;
  try {
    // timeout 与 TaskIndexRepo 同值：抢不到写锁等 5 秒，不是直接失败。
    db = DatabaseSync(dbPath, { timeout: 5000 }) as unknown as SyncDatabase;
    db.exec(
      "CREATE TABLE IF NOT EXISTS mobile_sessions (" +
        "session_id TEXT PRIMARY KEY, " +
        "workspace_path TEXT NOT NULL, " +
        "summary TEXT NOT NULL, " +
        "state TEXT NOT NULL, " +
        "updated_at INTEGER NOT NULL)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_mobile_sessions_workspace ON mobile_sessions(workspace_path)",
    );
  } catch (e) {
    // 建库失败（磁盘满、桥异常）不打死组合根：退回纯内存，屏幕上如实报。
    say(`会话持久化建库失败（${dbPath}）：${String((e as Error)?.message ?? e)}`);
    return null;
  }
  say(`会话持久化就绪：${dbPath}（引擎=${sqliteEngine()}）`);

  return {
    save(entry) {
      db.prepare(
        "INSERT OR REPLACE INTO mobile_sessions (session_id, workspace_path, summary, state, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(
        entry.sessionId,
        entry.workspacePath,
        JSON.stringify(entry.summary),
        JSON.stringify(entry.state),
        Date.now(),
      );
    },

    load(sessionId) {
      const row = db
        .prepare(
          "SELECT session_id, workspace_path, summary, state, updated_at FROM mobile_sessions WHERE session_id = ?",
        )
        .get(sessionId);
      if (!row) return null;
      const state = parseState(row["state"]);
      const summary = parseSummary(row["summary"]);
      if (!state || !summary) {
        say(`会话 ${sessionId} 的持久化记录解析失败，按没有处理（不还原半截状态）`);
        return null;
      }
      return {
        sessionId,
        workspacePath: String(row["workspace_path"] ?? ""),
        summary,
        state,
        updatedAt: Number(row["updated_at"] ?? 0),
      };
    },

    listSummaries(workspacePath, limit = HYDRATE_LIMIT) {
      const rows = db
        .prepare(
          "SELECT session_id, summary, updated_at FROM mobile_sessions WHERE workspace_path = ? ORDER BY updated_at DESC LIMIT ?",
        )
        .all(workspacePath, limit);
      const out: Array<{ sessionId: string; summary: SessionSummary; updatedAt: number }> = [];
      for (const row of rows) {
        const summary = parseSummary(row["summary"]);
        if (!summary) continue;
        out.push({
          sessionId: String(row["session_id"] ?? summary.sessionId),
          summary,
          updatedAt: Number(row["updated_at"] ?? 0),
        });
      }
      return out;
    },

    listAllStates(limit = HYDRATE_LIMIT) {
      const rows = db
        .prepare(
          "SELECT session_id, workspace_path, state, updated_at FROM mobile_sessions ORDER BY updated_at DESC LIMIT ?",
        )
        .all(limit);
      const out: Array<{
        sessionId: string;
        workspacePath: string;
        state: PersistedSessionState;
        updatedAt: number;
      }> = [];
      for (const row of rows) {
        const state = parseState(row["state"]);
        // state 解析不出来（半截 JSON/旧形状）就跳过：用量统计宁可少算一条，
        // 也不能把 null 当 0 混进聚合里——那会把"存过但还原不了"读成"没怎么用过"。
        if (!state) continue;
        out.push({
          sessionId: String(row["session_id"] ?? ""),
          workspacePath: String(row["workspace_path"] ?? ""),
          state,
          updatedAt: Number(row["updated_at"] ?? 0),
        });
      }
      return out;
    },

    engine() {
      return sqliteEngine();
    },
  };
}
