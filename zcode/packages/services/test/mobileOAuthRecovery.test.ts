import assert from "node:assert/strict";
import test from "node:test";
import { OAuthService } from "../src/oauth/oauthService.js";
import pendingModule from "../../../../mobile-runtime/ui/oauth-pending.js";

const { withPendingOAuthPersistence } = pendingModule;

const providerId = "audit-provider";
const credentials = () => {
  const entries = new Map<string, string>();
  return {
    load: async (key: string) => entries.get(key) ?? null,
    save: async (key: string, value: string) => { entries.set(key, value); },
    delete: async (key: string) => { entries.delete(key); },
  };
};
const adapter = {
  providerId,
  meta: { id: providerId, displayName: "Test", enabled: true, order: 0 },
  redirectUri: "zcode://oauth/callback",
  apiClient: { request: async () => new Response() },
  buildAuthorizeUrl: ({ state }: { state: string }) => `https://example.test/login?state=${state}`,
  parseCallbackParams: (url: string) => ({ state: new URL(url).searchParams.get("state")!, code: "code" }),
  exchangeToken: async () => ({ accessToken: "test-token" }),
  normalizeError: (error: unknown) => error instanceof Error ? error : new Error(String(error)),
};

test("pending OAuth survives restart with state validation and single use", async () => {
  const creds = credentials();
  const first = new OAuthService(creds, { adapters: [adapter] });
  const start = await first.startOAuth(providerId);
  const snapshot = first.exportPendingOAuth();
  assert.ok(snapshot);
  await first.cancelPending();
  const restored = new OAuthService(creds, { adapters: [adapter] });
  try {
    assert.equal(restored.restorePendingOAuth(snapshot), true);
    await assert.rejects(restored.handleCallback("zcode://oauth/callback?state=wrong&code=x"), /state/);
    const result = await restored.handleCallback(`zcode://oauth/callback?state=${start.state}&code=x`);
    assert.equal(result?.kind, "session");
    assert.equal(restored.exportPendingOAuth(), null);
    assert.equal((await restored.handleCallback(`zcode://oauth/callback?state=${start.state}&code=x`))?.kind, "duplicate");
  } finally {
    await restored.cancelPending();
  }
});

test("expired, malformed and unknown-provider snapshots cannot be restored", async () => {
  const service = new OAuthService(credentials(), { adapters: [adapter], now: () => 2_000_000 });
  assert.equal(service.restorePendingOAuth({ version: 1, state: "x", provider: providerId, expiresAt: 1, phase: "awaiting-attribution-or-code" }), false);
  assert.equal(service.restorePendingOAuth({ version: 1, state: "", provider: providerId, expiresAt: 2_010_000, phase: "awaiting-attribution-or-code" }), false);
  assert.equal(service.restorePendingOAuth({ version: 1, state: "x", provider: "unknown", expiresAt: 2_010_000, phase: "awaiting-attribution-or-code" }), false);
  assert.equal(service.exportPendingOAuth(), null);
});

test("mobile wrapper restores encrypted pending flow before processing callback", async () => {
  const store = credentials();
  const firstOwner = new OAuthService(store, { adapters: [adapter] });
  const first = withPendingOAuthPersistence(firstOwner, store);
  const start = await first.startOAuth(providerId);
  assert.ok(await store.load("mobile:oauth:pending:v1"));
  // 模拟进程消失：只销毁内存状态，不发用户取消命令。
  await firstOwner.cancelPending();
  const nextOwner = new OAuthService(store, { adapters: [adapter] });
  const next = withPendingOAuthPersistence(nextOwner, store);
  try {
    await assert.rejects(next.handleCallback("zcode://oauth/callback?state=wrong&code=x"), /state/);
    assert.ok(await store.load("mobile:oauth:pending:v1"));
    const result = await next.handleCallback(`zcode://oauth/callback?state=${start.state}&code=x`);
    assert.equal(result?.kind, "session");
    assert.equal(await store.load("mobile:oauth:pending:v1"), null);
  } finally {
    await next.cancelPending();
  }
});
