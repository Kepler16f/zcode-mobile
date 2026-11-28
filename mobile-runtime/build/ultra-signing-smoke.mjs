// ultra 签名链路冒烟：用与官方同构的假服务端（模拟握手 + agent/configs 路由下发），
// 验证端侧实现（ultra-signing.ts）：
//   1. Coding Plan（open.bigmodel.cn / api.z.ai → ultra / ultra-zai）路由与 Ed25519 五头签名；
//   2. Start Plan（zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages）绝不重写到 ultra；
//   3. 凭据解析、握手 sig 复算、sessionId fail-closed。
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { unlinkSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const esbuild = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"))("esbuild");
const out = path.join(root, "tmp", `ultra-signing-${process.pid}.mjs`);
await esbuild.build({ entryPoints: [path.join(root, "mobile-runtime/ui/ultra-signing.ts")], outfile: out, bundle: true, platform: "node", format: "esm", target: "node24" });
// Node harness 垫 btoa/atob（ultra-signing 用到）。
if (typeof globalThis.btoa !== "function") {
  globalThis.btoa = (s) => Buffer.from(s, "binary").toString("base64");
  globalThis.atob = (s) => Buffer.from(s, "base64").toString("binary");
}
const subtle = webcrypto.subtle;
const signing = await import(pathToFileURL(out).href);

// ── 测试私钥与 privateCipher 生成（模拟服务端下发流程）──
const API_KEY_ID = "ak-test-123";
const SECRET = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCIsInNpZ25fdHlwZSI6IlNJR04ifQ",
  Buffer.from(JSON.stringify({ token_use: "project_access", api_key: API_KEY_ID })).toString("base64url"),
  "sig-does-not-matter",
].join(".");

const te = (s) => Buffer.from(s, "utf8");
async function hkdfBytes(secret, info) {
  const key = await subtle.importKey("raw", te(secret), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: te("WD_CLIENT_SIGN_KDF_SALT"), info: te(info) }, key, 256));
}
const keyPair = await subtle.generateKey("Ed25519", true, ["sign"]);
const pkcs8 = await subtle.exportKey("pkcs8", keyPair.privateKey);
const pkcs8B64 = Buffer.from(pkcs8).toString("base64");
const aesKeyBytes = await hkdfBytes(SECRET, "ed25519_priv");
const aesKey = await subtle.importKey("raw", aesKeyBytes, "AES-GCM", false, ["encrypt"]);
const iv = webcrypto.getRandomValues(new Uint8Array(12));
const cipher = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: te(API_KEY_ID), tagLength: 128 }, aesKey, te(pkcs8B64)));
const privateCipher = Buffer.from(iv).toString("base64") + Buffer.from(cipher).toString("base64");

// ── fetch 假服务端 ──
let handshakeBody = null;
let handshakeAuth = null;
let ultraRequest = null;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.includes("/api/v1/agent/configs")) {
    return new Response(JSON.stringify({
      code: 0,
      data: { proxyEndpoint: { mapping: [{ from: "https://open.bigmodel.cn/api/anthropic/v1/messages", to: "https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages", zcodeAuthorizationHeader: "X-Zcode-Authorization" }] } },
    }), { status: 200 });
  }
  if (url.includes("/api/paas/c1f3a7e2/v2/client")) {
    handshakeBody = JSON.parse(init.body);
    handshakeAuth = Object.fromEntries(new Headers(init.headers).entries()).authorization ?? null;
    return new Response(JSON.stringify({ code: 200, msg: "ok", data: { privateCipher } }), { status: 200 });
  }
  if (url.includes("/ultra/anthropic/v1/messages")) {
    ultraRequest = { url, headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body };
    return new Response("event: message_start\ndata: {\"type\":\"message_start\"}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  return new Response("{}", { status: 200 });
};

const clientVersion = "4.0.0";
const sessionId = "abc123def456";

// ── ① 握手：请求形状（body 字段 accessToken、nonce 32hex、sig 用 HKDF-HMAC 可复算）──
{
  const headers = await signing.buildUltraSigningHeaders({
    apiKey: SECRET,
    sessionId,
    clientVersion,
    bigmodelOrigin: "https://open.bigmodel.cn",
  });
  assert.ok(headers, "握手+签名应成功");
  assert.equal(handshakeBody.accessToken, SECRET, "JWT 凭据必须走 accessToken 字段");
  assert.equal(handshakeAuth, SECRET, "握手 Authorization 必须是凭据原值（无 Bearer 前缀）");
  assert.match(handshakeBody.nonce, /^[0-9a-f]{32}$/, "nonce 必须是 32 hex");
  assert.match(handshakeBody.ts, /^\d{13}$/, "ts 必须是毫秒时间戳");
  assert.equal(typeof handshakeBody.sig, "string");
  // 复算握手 sig：HKDF(secret, getSignKey_hmac) → HMAC("get_sign_key\napiKeyId\nts\nnonce")
  const hmacKeyBytes = await hkdfBytes(SECRET, "getSignKey_hmac");
  const hmacKey = await subtle.importKey("raw", hmacKeyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expectedSig = Buffer.from(await subtle.sign("HMAC", hmacKey, te(`get_sign_key\n${API_KEY_ID}\n${handshakeBody.ts}\n${handshakeBody.nonce}`))).toString("base64");
  assert.equal(handshakeBody.sig, expectedSig, "握手 sig 必须与官方算法（HKDF-HMAC-SHA256）逐字一致");
  // 签名五头形状
  assert.match(headers["X-Client-Sig"], /^[A-Za-z0-9+/]+={0,2}$/, "x-client-sig 必须是 base64（Ed25519 64 字节→88 字符）");
  assert.equal(headers["X-Client-Version"], clientVersion);
  assert.equal(headers["X-App-Id"], "zcode");
  assert.match(headers["X-Client-Pow"], /^[0-9a-f]{24}[0-9a-f]{8}$/, "x-client-pow 必须是 24 随机 hex + 8 hex 计数器");
}

// ── ② URL 路由（Coding Plan → ultra；Start Plan zcode-plan 原样保留）──
{
  const codingPlan = await signing.resolveUltraRoute(
    "https://open.bigmodel.cn/api/anthropic/v1/messages",
    (input, init) => fetch(input, init),
  );
  assert.equal(codingPlan.routed, true);
  assert.equal(codingPlan.includeZCodeAuthorization, true);
  assert.equal(codingPlan.url, "https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages", "Coding Plan 端点必须按 mapping 重写到 ultra");

  const startPlan = await signing.resolveUltraRoute(
    "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages",
    (input, init) => fetch(input, init),
  );
  assert.equal(startPlan.routed, false, "Start Plan 不得路由到 ultra");
  assert.equal(startPlan.includeZCodeAuthorization, false);
  assert.equal(startPlan.url, "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages", "Start Plan 端点必须保持原样");
}

// ── ③ 第二次签名：pow 的计数器随机但形状稳定；不同请求 nonce 不同 ──
{
  const first = await signing.buildUltraSigningHeaders({ apiKey: SECRET, sessionId, clientVersion, bigmodelOrigin: "https://open.bigmodel.cn" });
  const second = await signing.buildUltraSigningHeaders({ apiKey: SECRET, sessionId, clientVersion, bigmodelOrigin: "https://open.bigmodel.cn" });
  assert.notEqual(first["X-Client-Nonce"], second["X-Client-Nonce"], "nonce 每请求必须随机");
  assert.notEqual(first["X-Client-Ts"], undefined);
}

// ── ④ sessionId 缺失 fail-closed ──
{
  const headers = await signing.buildUltraSigningHeaders({ apiKey: SECRET, sessionId: "  ", clientVersion, bigmodelOrigin: "https://open.bigmodel.cn" });
  assert.equal(headers, null, "sessionId 缺失必须 fail-closed（官方语义）");
}

// ── ⑤ parseSigningCredential：JWT → apiKeyId=api_key / accessToken；id.secret → apiKey ──
{
  const parsed = signing.parseSigningCredential(SECRET);
  assert.equal(parsed.apiKeyId, API_KEY_ID);
  assert.equal(parsed.handshakeBodyField, "accessToken");
  const dotted = signing.parseSigningCredential("keyid-9.secret-part");
  assert.equal(dotted.apiKeyId, "keyid-9");
  assert.equal(dotted.handshakeBodyField, "apiKey");
}

console.log("ultra-signing-smoke: PASS（握手形状/往返解密/签名五头/CodingPlan路由与StartPlan直发/fail-closed/凭据解析）");
unlinkSync(out);
