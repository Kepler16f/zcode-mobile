// 官方 4.0.0 Coding Plan ultra 网关的客户端签名与路由链路。
//
// 地面真相（官方桌面 4.0.0 CLI zcode.cjs）：
//   1. Start Plan（https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages）：
//      不走 agent/configs 重写，也不带 c1f3a7e2 签名（requiresClientRequestSigning 明确返回 false）。
//   2. Coding Plan（https://open.bigmodel.cn/api/anthropic/v1/messages 或 https://api.z.ai/api/anthropic/v1/messages）：
//      GET  /api/v1/agent/configs                  → 下发 proxyEndpoint.mapping（coding-plan → ultra/ultra-zai）
//      POST {origin}/api/paas/c1f3a7e2/v2/client   → 握手换 Ed25519 私钥
//      POST /api/v1/ultra[/ultra-zai]/anthropic/v1/messages + 签名五头（+ 可选 X-ZCode-Authorization）
// 签名协议逆向报告：D:/Zcode/tmp/signing-protocol-report.md（bundle 字节偏移齐全）。
// 算法全部可用 WebView crypto.subtle 原生实现（Ed25519 需 Chromium ≥137，端侧 157 ✓）。
//
// 官方语义纪律：
//   - fail-open：握手失败/签名异常时按 unsigned 照发（官方 failOpenEligible 同语义，
//     端侧若 fail-closed 反而会被网关风控观测为异类）。
//   - 签名五元组不绑定 method/URL/body：apiKeyId/ts/clientVersion/sessionId/nonce。
//   - sessionId 缺失 fail-closed（官方如此），端侧对话链路恒有（withZCodeChatTraceHeaders）。
//   - 私钥进程内缓存（Map<apiKey, CryptoKey>），401+VERIFY_SIGNATURE_INVALID/
//     VERIFY_APIKEY_EXPIRED 时重握手一次，再拒则永久 bypass（官方语义照抄）。

const KDF_SALT = "WD_CLIENT_SIGN_KDF_SALT";
const HKDF_INFO_HANDSHAKE = "getSignKey_hmac";
const HKDF_INFO_PRIV = "ed25519_priv";
const POW_PREFIX = "get_sign_key";
const HANDSHAKE_PATH = "/api/paas/c1f3a7e2/v2/client";
const APP_ID = "zcode";
const POW_BITS = 8;
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** agent/configs 的成功 TTL 与失败冷却（对齐官方 _vt 常量：300s/30s）。 */
const MAPPING_TTL_MS = 300_000;
const MAPPING_FAILURE_COOLDOWN_MS = 30_000;

const te = (s: string): Uint8Array<ArrayBuffer> => {
  const encoded = new TextEncoder().encode(s);
  const out = new Uint8Array(encoded.byteLength);
  out.set(encoded);
  return out;
};

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function randomHex(bytes: number): string {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  return toHex(raw);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

async function hkdf(secret: string, info: string): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", te(secret), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: te(KDF_SALT), info: te(info) },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** Start Plan 凭据是 ZCode JWT：apiKeyId=payload.api_key，secret=整个 JWT 原文（官方 cBr）。 */
export interface ParsedSigningCredential {
  apiKeyId: string;
  secret: string;
  handshakeBodyField: "accessToken" | "apiKey";
}

export function parseSigningCredential(apiKey: string): ParsedSigningCredential | null {
  const parts = apiKey.split(".");
  if (parts.length === 3 && parts[2] && parts[2]!.trim()) {
    try {
      const payloadJson = atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"));
      const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(payloadJson, (c) => c.charCodeAt(0)))) as {
        api_key?: unknown;
      };
      const apiKeyId = typeof payload.api_key === "string" ? payload.api_key.trim() : "";
      if (!apiKeyId) return null;
      return { apiKeyId, secret: apiKey, handshakeBodyField: "accessToken" };
    } catch {
      return null;
    }
  }
  const dot = apiKey.indexOf(".");
  if (dot <= 0 || dot !== apiKey.lastIndexOf(".")) return null;
  const id = apiKey.slice(0, dot).trim();
  const secret = apiKey.slice(dot + 1);
  if (!id || !secret) return null;
  return { apiKeyId: id, secret, handshakeBodyField: "apiKey" };
}

/** 握手响应 envelope 校验（uBr）：code=200 + data.privateCipher。 */
function readHandshakeResponse(raw: unknown): { privateCipher: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const envelope = raw as { code?: unknown; data?: { privateCipher?: unknown } };
  if (envelope.code !== 200) return null;
  const cipher = envelope.data?.privateCipher;
  return typeof cipher === "string" && cipher ? { privateCipher: cipher } : null;
}

export interface SigningKeyState {
  apiKeyId: string;
  privateKey: CryptoKey;
}

const keyCache = new Map<string, Promise<SigningKeyState | null>>();
/** 永久 bypass 的 apiKey 集合（两次签名校验失败后，官方语义）。 */
const bypassedKeys = new Set<string>();

async function performHandshake(apiKey: string, parsed: ParsedSigningCredential, bigmodelOrigin: string): Promise<SigningKeyState | null> {
  const ts = String(Date.now());
  const nonce = randomHex(16);
  const hmacKeyBytes = await hkdf(parsed.secret, HKDF_INFO_HANDSHAKE);
  const hmacKey = await crypto.subtle.importKey("raw", hmacKeyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", hmacKey, te(`${POW_PREFIX}\n${parsed.apiKeyId}\n${ts}\n${nonce}`)),
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);
  try {
    const response = await fetch(`${bigmodelOrigin}${HANDSHAKE_PATH}`, {
      method: "POST",
      headers: { Authorization: parsed.secret, "Content-Type": "application/json" },
      body: JSON.stringify({ [parsed.handshakeBodyField]: apiKey, nonce, sig: toBase64(mac), ts }),
      signal: controller.signal,
    });
    if (response.status !== 200) return null;
    const envelope = readHandshakeResponse(await response.json().catch(() => null));
    if (!envelope) return null;
    // privateCipher 解密（a0o）：AES-256-GCM，iv=前 12B，AAD=utf8(apiKeyId)，明文=base64(PKCS8)。
    const raw = base64ToBytes(envelope.privateCipher);
    if (raw.byteLength <= 12 + 16) return null;
    const aesKeyBytes = await hkdf(parsed.secret, HKDF_INFO_PRIV);
    const aesKey = await crypto.subtle.importKey("raw", aesKeyBytes, "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: raw.slice(0, 12), additionalData: te(parsed.apiKeyId), tagLength: 128 },
        aesKey,
        raw.slice(12),
      ),
    );
    const pkcs8Bytes = base64ToBytes(new TextDecoder().decode(plain));
    const pkcs8 = new Uint8Array(pkcs8Bytes.byteLength);
    pkcs8.set(pkcs8Bytes);
    const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", false, ["sign"]);
    return { apiKeyId: parsed.apiKeyId, privateKey };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function ensurePrivateKey(apiKey: string, bigmodelOrigin: string): Promise<SigningKeyState | null> {
  const cached = keyCache.get(apiKey);
  if (cached) return cached;
  const pending = (async () => {
    const parsed = parseSigningCredential(apiKey);
    if (!parsed) return null;
    return performHandshake(apiKey, parsed, bigmodelOrigin);
  })();
  keyCache.set(apiKey, pending);
  return pending;
}

/** PoW（l0o）：digest=SHA256(apiKeyId\nappId\nsessionId\nts) 前 32 hex；attempt=随机 24hex+计数器 8hex；内层 hash 前 8 bit 全零。 */
export async function solveProofOfWork(apiKeyId: string, sessionId: string, ts: string): Promise<string> {
  const digestInput = te(`${apiKeyId}\n${APP_ID}\n${sessionId}\n${ts}`);
  const digestHex = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput))).slice(0, 32);
  const prefix = randomHex(12);
  for (let counter = 0; counter <= 4294967295; counter += 1) {
    const attempt = `${prefix}${counter.toString(16).padStart(8, "0")}`;
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", te(`${digestHex}\n${attempt}`)));
    // 前 8 bit 全零（Mpa，powBits=8）。
    if (hash[0] === 0) return attempt;
  }
  throw new Error("Unable to solve client request proof of work");
}

/** ultra 签名五头（X-Client-Ts/Version/Sig/Session-Id/Nonce/App-Id/Pow——官方 sendSigned 头组）。 */
export interface UltraSigningHeaders {
  "X-Client-Ts": string;
  "X-Client-Version": string;
  "X-Client-Sig": string;
  "X-Client-Nonce": string;
  "X-Client-Pow": string;
  "X-App-Id": string;
}

export async function buildUltraSigningHeaders(input: {
  apiKey: string;
  sessionId: string;
  clientVersion: string;
  bigmodelOrigin: string;
}): Promise<UltraSigningHeaders | null> {
  if (bypassedKeys.has(input.apiKey)) return null;
  const parsed = parseSigningCredential(input.apiKey);
  if (!parsed || !input.sessionId.trim()) return null;
  let state: SigningKeyState | null = null;
  try {
    state = await ensurePrivateKey(input.apiKey, input.bigmodelOrigin);
  } catch {
    return null; // fail-open：握手失败按 unsigned 照发
  }
  if (!state) return null;
  const ts = String(Date.now());
  const nonce = randomHex(16);
  let pow = "";
  try {
    pow = await solveProofOfWork(parsed.apiKeyId, input.sessionId, ts);
  } catch {
    return null;
  }
  try {
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        state.privateKey,
        te(`${parsed.apiKeyId}\n${ts}\n${input.clientVersion}\n${input.sessionId}\n${nonce}`),
      ),
    );
    return {
      "X-Client-Ts": ts,
      "X-Client-Version": input.clientVersion,
      "X-Client-Sig": toBase64(signature),
      "X-Client-Nonce": nonce,
      "X-Client-Pow": pow,
      "X-App-Id": APP_ID,
    };
  } catch {
    return null;
  }
}

/** 401 + VERIFY_SIGNATURE_INVALID/VERIFY_APIKEY_EXPIRED：重握手一次；再拒永久 bypass（官方语义）。 */
export function invalidateSigningKey(apiKey: string): void {
  keyCache.delete(apiKey);
}

export function markSigningBypassed(apiKey: string): void {
  bypassedKeys.add(apiKey);
  keyCache.delete(apiKey);
}

export function isSigningBypassed(apiKey: string): boolean {
  return bypassedKeys.has(apiKey);
}

/** 401 响应体里的签名失败 reason（Fgn/pdt：顶层或 data/error 内的 msg/reason）。 */
export function readSigningFailureReason(bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as {
      msg?: unknown;
      reason?: unknown;
      data?: { msg?: unknown; reason?: unknown };
      error?: { msg?: unknown; reason?: unknown };
    };
    const candidates = [parsed.msg, parsed.reason, parsed.data?.msg, parsed.data?.reason, parsed.error?.msg, parsed.error?.reason];
    for (const candidate of candidates) {
      if (typeof candidate === "string") return candidate;
    }
    return "";
  } catch {
    return "";
  }
}

/** agent/configs 的 mapping 缓存（TTL 300s/失败冷却 30s，对齐官方 _vt）。 */
export interface UltraRouteEntry {
  fromPrefix: string;
  toPrefix: string;
  includeZCodeAuthorization: boolean;
}

export interface UltraRouteMapping {
  entries: UltraRouteEntry[];
  fetchedAt: number;
}

export interface UltraRouteResolution {
  url: string;
  routed: boolean;
  includeZCodeAuthorization: boolean;
}

const OFFICIAL_AGENT_CONFIGS_URL = "https://zcode.z.ai/api/v1/agent/configs";
const OFFICIAL_ENDPOINT_ORIGIN = "https://zcode.z.ai";
let mappingCache: UltraRouteMapping | null = null;
let mappingLastFailureAt = 0;

/** 内置回退映射（agent/configs 拉不到时，与官方实测 mapping 的 coding-plan → ultra 一致）。 */
const FALLBACK_MAPPING: UltraRouteMapping = {
  entries: [
    {
      fromPrefix: "https://open.bigmodel.cn/api/anthropic/v1/messages",
      toPrefix: "https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages",
      includeZCodeAuthorization: true,
    },
    {
      fromPrefix: "https://api.z.ai/api/anthropic/v1/messages",
      toPrefix: "https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages",
      includeZCodeAuthorization: true,
    },
  ],
  fetchedAt: 0,
};

function normalizePathNoTrailing(pathname: string): string {
  return pathname === "/" ? "/" : pathname.replace(/\/+$/u, "") || "/";
}

function canonicalEndpointKey(parsed: URL): string {
  const port = parsed.port || "443";
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${port}${normalizePathNoTrailing(parsed.pathname)}`;
}

/**
 * 拉 agent/configs 的路由映射（response envelope code=0 + data.proxyEndpoint.mapping）。
 * 失败回退内置映射；TTL/冷却对齐官方。响应头要求官方身份归一——由调用方提供。
 */
export async function fetchUltraRouteMapping(clientFetch: typeof fetch): Promise<UltraRouteMapping> {
  if (mappingCache && Date.now() - mappingCache.fetchedAt < MAPPING_TTL_MS) return mappingCache;
  if (Date.now() - mappingLastFailureAt < MAPPING_FAILURE_COOLDOWN_MS) {
    return mappingCache ?? FALLBACK_MAPPING;
  }
  try {
    const response = await clientFetch(OFFICIAL_AGENT_CONFIGS_URL, { headers: { Accept: "application/json" } });
    if (response.status !== 200) throw new Error(`agent/configs HTTP ${response.status}`);
    const envelope = (await response.json()) as {
      code?: unknown;
      data?: { proxyEndpoint?: { mapping?: Array<{ from?: unknown; to?: unknown; zcodeAuthorizationHeader?: unknown }> } };
    };
    if (envelope.code !== 0) throw new Error("agent_configs_nonzero_code");
    const raw = envelope.data?.proxyEndpoint?.mapping ?? [];
    const entries: UltraRouteEntry[] = [];
    for (const item of raw.slice(0, 256)) {
      if (typeof item.from !== "string" || typeof item.to !== "string") continue;
      const fromUrl = new URL(item.from);
      const toUrl = new URL(item.to);
      if (fromUrl.protocol !== "https:" || toUrl.protocol !== "https:") continue;
      if (fromUrl.username || fromUrl.password || toUrl.username || toUrl.password) continue;
      const authHeader = typeof item.zcodeAuthorizationHeader === "string" ? item.zcodeAuthorizationHeader.trim() : "";
      const includeZCodeAuthorization = authHeader.length > 0;
      const normalizedToPath = normalizePathNoTrailing(toUrl.pathname);
      // 安全校验对齐官方 YSa：X-ZCode-Authorization 只准发给 official ultra/ultra-zai 路径。
      if (
        includeZCodeAuthorization &&
        (authHeader.toLowerCase() !== "x-zcode-authorization" ||
          toUrl.origin !== OFFICIAL_ENDPOINT_ORIGIN ||
          !/^\/api\/v1\/ultra(-zai)?(\/|$)/.test(normalizedToPath))
      ) {
        continue;
      }
      entries.push({
        fromPrefix: item.from,
        toPrefix: item.to,
        includeZCodeAuthorization,
      });
    }
    if (entries.length === 0) throw new Error("agent_configs_empty_mapping");
    mappingCache = { entries, fetchedAt: Date.now() };
    return mappingCache;
  } catch {
    mappingLastFailureAt = Date.now();
    return mappingCache ?? FALLBACK_MAPPING;
  }
}

/**
 * 按官方 agent/configs proxyEndpoint.mapping 解析路由（对齐官方 ProviderEndpointRoutingService._vt）：
 *   - 仅命中 mapping.from 的 Coding Plan 请求（open.bigmodel.cn / api.z.ai）会重写到 ultra/ultra-zai；
 *   - Start Plan（zcode.z.ai/api/v1/zcode-plan/anthropic/...）不在 mapping 中，保持 routed: false 原样直发。
 */
export async function resolveUltraRoute(
  url: string,
  clientFetch: typeof fetch,
): Promise<UltraRouteResolution> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, routed: false, includeZCodeAuthorization: false };
  }
  if (parsed.protocol !== "https:") {
    return { url, routed: false, includeZCodeAuthorization: false };
  }
  const mapping = await fetchUltraRouteMapping(clientFetch);
  const reqKey = canonicalEndpointKey(parsed);
  for (const entry of mapping.entries) {
    let fromUrl: URL;
    try {
      fromUrl = new URL(entry.fromPrefix);
    } catch {
      continue;
    }
    const fromKey = canonicalEndpointKey(fromUrl);
    if (reqKey === fromKey || reqKey.startsWith(`${fromKey}/`)) {
      const targetUrl = new URL(entry.toPrefix);
      const baseToPath = normalizePathNoTrailing(targetUrl.pathname);
      const suffix = reqKey.slice(fromKey.length);
      targetUrl.pathname = `${baseToPath}${suffix}`;
      targetUrl.search = parsed.search;
      return {
        url: targetUrl.href,
        routed: true,
        includeZCodeAuthorization: entry.includeZCodeAuthorization,
      };
    }
  }
  return { url, routed: false, includeZCodeAuthorization: false };
}

/** URL 重写包装：返回解析后的目标 URL（未命中 mapping 时原样返回）。 */
export async function rewriteToUltraUrl(
  url: string,
  familyOrClientFetch: "bigmodel" | "zai" | typeof fetch,
  maybeClientFetch?: typeof fetch,
): Promise<string> {
  const clientFetch = typeof familyOrClientFetch === "function" ? familyOrClientFetch : maybeClientFetch!;
  const resolved = await resolveUltraRoute(url, clientFetch);
  return resolved.url;
}
