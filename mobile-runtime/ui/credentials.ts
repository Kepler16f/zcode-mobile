// 端侧凭据服务（§8 M6）：把上游 ICredentialService 的三个方法接到 Android Keystore 桥上。
//
// 上游桌面版是"密文文件 + node:crypto 对称密钥"，密钥没有 ZCODE_CREDENTIAL_SECRET 时退回
// sha256(platform + homedir + username) —— 那个退路在手机上等于把钥匙和锁放在同一个抽屉里。
// 所以这里不搬实现，只搬接口：加密在 CredentialBridge.kt 里做，密钥由 AndroidKeyStore 持有、
// 不可导出，JS 从头到尾拿不到密钥材料，只拿到密文的进出。
//
// 桥是同步的（和 FsBridge/SqliteBridge 同一套），但接口契约是 Promise，所以包装层不需要
// 假装同步。失败一律 reject，不静默返回 null —— 静默 null 会被上层读成"用户没登录过"。
import type { ICredentialService } from "@zcode/services";

/** 与 CredentialBridge.kt 一一对应的协议：单入口 call(JSON)，同步返回 JSON 字符串。 */
interface CredentialBridgeFace {
  call(request: string): string;
  engine?(): string;
  name?(): string;
}

const DECRYPT_FAILED = "decrypt_failed";
/** shared/src/oauth.ts:18 的稳定码；OAuthCredentialRepo 靠它把"解不开"按损坏会话清理。 */
export const CREDENTIAL_DECRYPT_ERROR_CODE = "ZCODE_CREDENTIAL_DECRYPT_FAILED";

function bridge(): CredentialBridgeFace | undefined {
  const b = (globalThis as { zcodeCredentials?: CredentialBridgeFace }).zcodeCredentials;
  return b && typeof b.call === "function" ? b : undefined;
}

/** 有真 Keystore 桥才谈得上登录；能力清单与启动屏上写的是这个返回值。 */
export function credentialEngine(): string | null {
  const b = bridge();
  if (!b) return null;
  return typeof b.engine === "function" ? b.engine() : "android-keystore-aes-gcm";
}

/** CredentialBridge.kt 的回包形状（load/save/remove 三个 op 共用）。 */
interface BridgeReply {
  ok: boolean;
  value?: unknown;
  code?: string;
  error?: string;
}

function call(op: string, key: string, value?: string): BridgeReply {
  const b = bridge();
  if (!b) throw new Error(`凭据桥缺失：${op}(${key}) 无法执行`);
  const payload = value === undefined ? { op, key } : { op, key, value };
  const raw = b.call(JSON.stringify(payload));
  // JS↔Kotlin 的边界，按边界处理：桥回的字符串先解析、再验 `ok` 真是布尔。
  // 以前这里直接 `as` 成上面那个形状就返回，于是桥坏了（回一句 HTML 错误页、或被别的注入覆盖）
  // 时 `!res.ok` 会被读成"这条凭据不存在"，屏幕上是一句"请先登录"，而真因在桥那一侧。
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`凭据桥回包不是 JSON：${op}(${key}) → ${raw.slice(0, 80)}`);
  }
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as BridgeReply).ok !== "boolean") {
    throw new Error(`凭据桥回包缺少 ok：${op}(${key})`);
  }
  return parsed as BridgeReply;
}

function decryptError(reason: string): Error {
  return Object.assign(new Error(`凭据解密失败：${reason}`), { code: CREDENTIAL_DECRYPT_ERROR_CODE });
}

export function createMobileCredentialService(): ICredentialService {
  return {
    async load(key) {
      const res = call("load", key);
      if (!res.ok) {
        if (res.code === DECRYPT_FAILED) throw decryptError(String(res.error ?? key));
        throw new Error(`凭据读取失败(${key}): ${res.error ?? res.code ?? "unknown"}`);
      }
      // Kotlin 侧"没有这条凭据"回的是 value: null（JSONObject.NULL），不是缺字段。
      return res.value == null ? null : String(res.value);
    },
    async save(key, value) {
      const res = call("save", key, value);
      if (!res.ok) throw new Error(`凭据写入失败(${key}): ${res.error ?? res.code ?? "unknown"}`);
    },
    async delete(key) {
      const res = call("remove", key);
      if (!res.ok) throw new Error(`凭据删除失败(${key}): ${res.error ?? res.code ?? "unknown"}`);
    },
  };
}

/**
 * 桌面开发宿主用的内存凭据桥：让 Chromium 里能跑完整登录链路做验证。
 * **只在显式带 ?devCredentials=1 时安装**（见 entry.tsx），出厂 UI 里没有这条路，
 * 页面一刷新凭据就没了 —— 它证明的是形状对，不是"端侧凭据这么存"。
 */
export function installMemoryCredentialBridge(): void {
  const store = new Map<string, string>();
  (globalThis as { zcodeCredentials?: CredentialBridgeFace }).zcodeCredentials = {
    engine: () => "memory-dev-only",
    call(request: string) {
      const req = JSON.parse(request) as { op: string; key: string; value?: string };
      if (req.op === "load") {
        return JSON.stringify({ ok: true, value: store.has(req.key) ? store.get(req.key) : null });
      }
      if (req.op === "save") {
        store.set(req.key, String(req.value));
        return JSON.stringify({ ok: true, bytes: String(req.value).length });
      }
      if (req.op === "remove") {
        return JSON.stringify({ ok: true, removed: store.delete(req.key) });
      }
      return JSON.stringify({ ok: false, code: "bad_request", error: `未知 op: ${req.op}` });
    },
  };
}
