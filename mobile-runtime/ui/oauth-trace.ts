// 登录链路取证（§1.5.15）。
//
// 端上没有 devtools，而 0.2.0 装机报的"点了连接、浏览器登录完回来一直转圈"恰好是**只有真机才会
// 出现**的那类问题：轮询在不在跑、flow 有没有被网站标成 ready、深链有没有回到 App。没有这一步，
// 下一轮还是靠猜。
//
// 落点是 `/work/.zcode/oauth-login-trace.jsonl`（和会话库同一棵树），自检页把它原样打出来 ——
// 自检页是另一个 document，内存里的记录切页就没了，所以必须落盘。
//
// **只记步骤与状态，绝不记秘密**：code / state / pollToken / access_token 一律不进这个文件。
// 键名命中 SENSITIVE 的直接丢掉，值里出现 `code=`/`token=` 这类形态也整条截断，宁缺勿滥。
const TRACE_PATH = "/work/.zcode/oauth-login-trace.jsonl";
const MAX_EVENTS = 60;
const SENSITIVE = /^(code|state|polltoken|access[_-]?token|refresh[_-]?token|zcodejwt|token)$/i;

type TraceEvent = Record<string, unknown> & { ts: string; step: string };

/** 桌面（没有 zcodeFs）时留在内存里，至少 __zcodeMobileMeta 能看到这一段。 */
const memory: TraceEvent[] = [];

function bridge(): { call(request: string): string } | null {
  const b = (globalThis as { zcodeFs?: { call(request: string): string } }).zcodeFs;
  return b && typeof b.call === "function" ? b : null;
}

function sanitize(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE.test(key)) continue;
    if (typeof value === "string" && /(code|token|state|secret)=%?[\w-]{8,}/i.test(value)) {
      // 自由文本里的错误消息可能整段带上 URL；宁可不记，也不把 code 写进真盘。
      out[key] = "<redacted>";
      continue;
    }
    out[key] = typeof value === "string" && value.length > 220 ? value.slice(0, 220) : value;
  }
  return out;
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function traceOAuthEvent(step: string, fields: Record<string, unknown> = {}): void {
  const event: TraceEvent = { ts: new Date().toISOString(), step, ...sanitize(fields) };
  memory.push(event);
  if (memory.length > MAX_EVENTS) memory.shift();
  const b = bridge();
  if (!b) return;
  try {
    // 追加写；超过一轮会话的量就整份重写，只留最近 MAX_EVENTS 条，取证文件不能无限涨。
    b.call(JSON.stringify({ op: "write", path: TRACE_PATH, base64: toBase64(JSON.stringify(event) + "\n"), append: true }));
    if (memory.length >= MAX_EVENTS) {
      b.call(JSON.stringify({
        op: "write",
        path: TRACE_PATH,
        base64: toBase64(memory.map((e) => JSON.stringify(e)).join("\n") + "\n"),
        append: false,
      }));
    }
  } catch {
    // 取证写不进去绝不能把登录打死：内存里那份还在。
  }
}

/** 自检页用的读取端：路径常量和写入端一致，改一处必须改两处。 */
export function readOAuthTrace(limit = 30): TraceEvent[] {
  const b = bridge();
  if (!b) return memory.slice(-limit);
  try {
    const res = JSON.parse(b.call(JSON.stringify({ op: "read", path: TRACE_PATH })));
    if (!res.ok || typeof res.base64 !== "string") return [];
    const text = new TextDecoder().decode(Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0)));
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .slice(-limit)
      .map((line) => JSON.parse(line) as TraceEvent);
  } catch {
    return [];
  }
}

export const OAUTH_TRACE_PATH = TRACE_PATH;
