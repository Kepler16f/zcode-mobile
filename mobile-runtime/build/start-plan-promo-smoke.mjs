/**
 * Start Plan 赠送活动全链路冒烟：
 *   1. 版本伪装与包内 ZCODE_VERSION 注入（3.18.2，而非 0.0.0-dev）；
 *   2. 官方请求头对齐（zcode.z.ai 鉴权 + 对话追踪头，第三方域零泄漏）；
 *   3. 识别非 "start plan" 字面的限时赠送活动（如 ZCODE WEEKEND BUILD），并拒掉过期 active 脏数据；
 *   4. billing/preview + marketing/touch 合并发现与 billing/claim（含 3007 验证重放 + touch 确认）；
 *   5. 端侧 Start Plan JWT 凭据跨 family / zcodejwttoken 兜底解析。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { unlinkSync } from "node:fs";
import { readOfficialCompatVersion } from "./official-version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const esbuild = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"))("esbuild");
const officialVersion = readOfficialCompatVersion(root);
assert.match(officialVersion, /^3\.18\./, "官方兼容版本应保持在 3.18.x 最新线");

const tempFiles = [];
async function bundleModule(relPath, extraDefine = {}) {
  const out = path.join(root, "tmp", `${path.basename(relPath)}-${process.pid}-${tempFiles.length}.mjs`);
  tempFiles.push(out);
  await esbuild.build({
    entryPoints: [path.join(root, relPath)],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
    define: { __ZCODE_VERSION__: JSON.stringify(officialVersion), ...extraDefine },
  });
  return import(pathToFileURL(out).href);
}

const prevStorage = globalThis.localStorage;
const prevGitHttp = globalThis.zcodeGitHttp;
const prevModelHttp = globalThis.zcodeModelHttp;
const prevDevice = globalThis.zcodeDevice;
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};

try {
  // ── 1. ZCODE_VERSION 注入与对话 trace 头校验 ──
  const shared = await bundleModule("zcode/packages/shared/src/version.ts");
  assert.equal(shared.ZCODE_VERSION, officialVersion);

  let modelReq = null;
  let pollStep = 0;
  globalThis.zcodeDevice = {};
  globalThis.zcodeModelHttp = {
    start(req) {
      modelReq = JSON.parse(req);
      pollStep = 0;
      return JSON.stringify({ id: "m1" });
    },
    poll() {
      pollStep++;
      if (pollStep === 1) {
        return JSON.stringify({
          status: 200,
          headers: { "content-type": "application/json" },
          bodyBase64: btoa('{"id":"msg_1"}'),
          done: true,
        });
      }
      return JSON.stringify({ done: true });
    },
    cancel() {
      return true;
    },
  };
  const { mobileModelFetch } = await bundleModule("mobile-runtime/ui/model-transport.ts");
  await mobileModelFetch("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages", {
    headers: { Authorization: "Bearer jwt-123", "content-type": "application/json" },
    body: "{}",
  });
  const hdr = (obj, name) => {
    const key = Object.keys(obj ?? {}).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? obj[key] : undefined;
  };
  assert.equal(hdr(modelReq.headers, "x-zcode-app-version"), officialVersion);
  assert.equal(hdr(modelReq.headers, "x-title"), "Z Code@electron");
  assert.equal(hdr(modelReq.headers, "x-release-channel"), "production");
  assert.equal(hdr(modelReq.headers, "x-zcode-agent"), "glm");
  assert.equal(hdr(modelReq.headers, "x-zcode-session-type"), "main");
  assert.equal(hdr(modelReq.headers, "x-zcode-query-source"), "main_turn");
  assert.ok(hdr(modelReq.headers, "x-query-id"));
  assert.ok(hdr(modelReq.headers, "x-session-id"));
  assert.ok(hdr(modelReq.headers, "x-zcode-trace-id"));
  assert.ok(hdr(modelReq.headers, "x-device-mid"));

  await mobileModelFetch("https://api.openai.com/v1/chat/completions", {
    headers: { Authorization: "Bearer sk-test" },
    body: "{}",
  });
  assert.equal(hdr(modelReq.headers, "x-zcode-query-source"), undefined, "第三方域不应泄漏 ZCode 头");

  // ── 2. 赠送活动（非 "start plan" 字面）availability + quota 识别 ──
  const availMod = await bundleModule("zcode/packages/services/src/model-provider/codingPlanProviderAvailability.ts");
  const quotaMod = await bundleModule("zcode/packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts");
  const fakeCreds = { load: async (k) => (k === "zcodejwttoken" ? "jwt-promo" : null) };
  const activePromoEnvelope = {
    code: 0,
    data: {
      server_time: 1_700_000_000,
      plans: [
        {
          user_plan_id: "up_expired",
          plan_id: "zcode-old-promo",
          name: "Expired Promo",
          status: "active",
          ends_at: 1_699_999_000,
        },
        {
          user_plan_id: "up_weekend",
          plan_id: "zcode-weekend-build",
          name: "ZCODE WEEKEND BUILD",
          status: "active",
          starts_at: 1_699_999_500,
          ends_at: 1_700_100_000,
        },
      ],
      balances: [
        {
          bucket_id: "b1",
          user_plan_id: "up_weekend",
          plan_id: "zcode-weekend-build",
          entitlement_id: "ent_53",
          show_name: "GLM-5.3",
          capabilities: ["model:GLM-5.3"],
          total_units: 3_000_000,
          used_units: 500_000,
          remaining_units: 2_500_000,
          period_end: 1_700_100_000,
        },
      ],
    },
  };
  const promoApiClient = {
    request: async () => new Response(JSON.stringify(activePromoEnvelope), { status: 200, headers: { "content-type": "application/json" } }),
  };
  const availMap = await availMod.validateZaiAccountProviderAvailability(
    [{ providerId: "account:zai-start-plan", family: "zai", planKind: "start-plan" }],
    { apiClient: promoApiClient, credentialService: fakeCreds },
  );
  const availResult = availMap["account:zai-start-plan"];
  assert.equal(availResult?.kind, "available", "ZCODE WEEKEND BUILD 赠送活动必须判定为可用");
  assert.deepEqual(availResult?.models, ["GLM-5.3"]);

  const accountMod = await bundleModule("mobile-runtime/ui/account.ts");
  const jwtOnlyCreds = {
    load: async (k) => (k === "zcodejwttoken" ? "jwt-promo" : null),
    save: async () => {},
    delete: async () => false,
  };
  const accountSource = accountMod.createMobileAccountSource({
    apiClient: promoApiClient,
    credentialService: jwtOnlyCreds,
    settingService: { get: async () => ({}) },
    configSource: {},
  });
  assert.equal(
    await accountSource.resolveCodingPlanApiKey({
      providerId: "account:zai-start-plan",
      family: "zai",
      forceRefresh: false,
    }),
    "jwt-promo",
    "仅有 zcodejwttoken 时 Start Plan 模型调用也应正确拿到 JWT",
  );

  const accountRequestAuthService = accountMod.createMobileAccountRequestAuthService({
    apiClient: promoApiClient,
    credentialService: jwtOnlyCreds,
    settingService: { get: async () => ({}) },
    configSource: {},
  });
  const usageProvider = new quotaMod.BigModelUsageQuotaProvider({
    apiClient: promoApiClient,
    credentialService: fakeCreds,
    accountRequestAuthService,
  });
  const usageSnapshot = await usageProvider.getSnapshotForRequest({
    preferredProviderId: "account:zai-start-plan",
    accountAccess: {
      type: "zhipu-account",
      family: "zai",
      planKind: "start-plan",
    },
  });
  assert.equal(usageSnapshot.subscription?.details?.[0]?.productName, "ZCODE WEEKEND BUILD");
  assert.equal(usageSnapshot.remaining?.count, 2_500_000);
  assert.equal(usageSnapshot.quota?.limits?.[0]?.remaining, 2_500_000);

  // ── 3. billing/preview + marketing/touch + billing/claim（含 3007 验证码重试 + confirm）──
  const { createCodingPlanSubscriptionService } = await bundleModule(
    "zcode/packages/services/src/coding-plan-subscription/codingPlanSubscriptionService.ts",
  );
  const requests = [];
  let claimAttempt = 0;
  const subApi = {
    request: async (input, init = {}) => {
      const url = input instanceof URL ? input.href : String(input);
      requests.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
      if (url.includes("/api/v1/zcode-plan/billing/preview")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              server_time: 1_700_000_000,
              plans: [
                {
                  plan_id: "zcode-v3-start-plan",
                  name: "Start Plan",
                  description: "Free Starter Pack",
                  priority: 100,
                  entitlements: [
                    { entitlement_id: "e1", show_name: "GLM-5.3", meter: "model_usage", unit_type: "token", capabilities: ["model:GLM-5.3"], grant_units: 3_000_000, period: "daily", priority: 1 },
                  ],
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/v1/marketing/touch?")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              deliveries: [
                {
                  campaign_id: "camp_weekend",
                  priority: 200,
                  banner: {
                    buttons: [{ text: "Weekend Token Gift", action: { type: "claim_zcode_plan", args: { plan_id: "zcode-weekend-build" } } }],
                  },
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/v1/zcode-plan/billing/claim")) {
        claimAttempt++;
        const hdrs = init.headers ?? {};
        if (!hdrs["X-Aliyun-Captcha-Verify-Param"]) {
          // 模拟真实服务端返回 HTTP 400 + 拼写错的 "captcha vertify failed"，不能抛错阻断 3007 弹窗流程
          return new Response(JSON.stringify({ code: 3007, msg: "captcha vertify failed" }), { status: 400 });
        }
        assert.equal(hdrs["X-Aliyun-Captcha-Region"], "cn", "必须携带 X-Aliyun-Captcha-Region");
        assert.equal(hdrs["X-Aliyun-Captcha-Verify-Region"], "cn", "同时兼容 X-Aliyun-Captcha-Verify-Region");
        return new Response(
          JSON.stringify({
            code: 0,
            msg: "ok",
            data: { server_time: 1_700_000_010, plan: { user_plan_id: "up_1", plan_id: "zcode-weekend-build", status: "active" } },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/v1/marketing/touch/action")) {
        return new Response(JSON.stringify({ code: 0 }), { status: 200 });
      }
      if (url.includes("/api/v1/client/configs")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: { configs: { captcha: { enabled: true, prefix: "no8xfe", region: "cn", sceneId: "11xygtvd", skipModelRequest: true } } },
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected url: ${url}`);
    },
  };
  const subService = createCodingPlanSubscriptionService({ apiClient: subApi, credentialService: fakeCreds });
  const offers = await subService.getManualClaimPlanPreviews();
  assert.deepEqual(offers.plans.map((p) => p.planId), ["zcode-weekend-build", "zcode-v3-start-plan"]);
  const cfg = await subService.getRequestVerificationConfig();
  assert.equal(cfg?.prefix, "no8xfe");
  assert.equal(cfg?.sceneId, "11xygtvd");

  const blocked = await subService.claimManualPlan({ planId: "zcode-weekend-build", campaignId: "camp_weekend" });
  assert.equal(blocked.success, false);
  assert.equal(blocked.code, 3007);

  const claimed = await subService.claimManualPlan({
    planId: "zcode-weekend-build",
    campaignId: "camp_weekend",
    captchaVerifyParam: "verified-param",
    captchaVerifyRegion: "cn",
  });
  assert.equal(claimed.success, true);
  assert.equal(claimed.plan?.status, "active");
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(requests.some((r) => r.url.includes("/api/v1/marketing/touch/action")));

  // ── 4. 仅返回 balances（plans 为空）+ 毫秒时间戳兜底识别 ──
  const balancesOnlyApi = {
    request: async () =>
      new Response(
        JSON.stringify({
          code: 0,
          data: {
            server_time: 1_700_000_000_000,
            plans: [],
            balances: [
              {
                bucket_id: "b_only",
                plan_id: "zcode-free-gift",
                entitlement_id: "ent_gift",
                show_name: "GLM-5.1",
                capabilities: ["model:GLM-5.1"],
                total_units: 2_000_000,
                used_units: 200_000,
                period_end: 1_700_200_000_000,
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  };
  const fallbackAvail = await availMod.validateBigModelAccountProviderAvailability(
    [{ providerId: "account:bigmodel-start-plan", family: "bigmodel", planKind: "start-plan" }],
    { apiClient: balancesOnlyApi, credentialService: fakeCreds },
  );
  assert.equal(
    fallbackAvail["account:bigmodel-start-plan"]?.kind,
    "available",
    "balances 有正额但 plans 为空时也必须识别为已领取可用",
  );
  const fallbackUsage = new quotaMod.BigModelUsageQuotaProvider({
    apiClient: balancesOnlyApi,
    credentialService: fakeCreds,
    accountRequestAuthService: accountMod.createMobileAccountRequestAuthService({
      apiClient: balancesOnlyApi,
      credentialService: jwtOnlyCreds,
      settingService: { get: async () => ({}) },
      configSource: {},
    }),
  });
  const fallbackSnap = await fallbackUsage.getSnapshotForRequest({
    preferredProviderId: "account:bigmodel-start-plan",
    accountAccess: {
      type: "zhipu-account",
      family: "bigmodel",
      planKind: "start-plan",
    },
  });
  assert.equal(fallbackSnap.subscription?.details?.[0]?.productId, "zcode-free-gift");
  assert.equal(fallbackSnap.remaining?.count, 1_800_000);

  // ── 5. 回归验证：data:null 不报 manual_claim_preview_missing_data / 429 冷却不连发 / 无 providerFamilyDomain 时 Start Plan 仍 current & 可解析 / X-Platform android-* 归一 ──
  const nullDataSub = createCodingPlanSubscriptionService({
    apiClient: {
      request: async (input) => {
        const url = input instanceof URL ? input.href : String(input);
        if (url.includes("/api/v1/zcode-plan/billing/preview")) {
          return new Response(JSON.stringify({ code: 0, data: null }), { status: 200 });
        }
        return new Response(JSON.stringify({ code: 0, data: { deliveries: [] } }), { status: 200 });
      },
    },
    credentialService: fakeCreds,
  });
  const emptyOffers = await nullDataSub.getManualClaimPlanPreviews();
  assert.deepEqual(emptyOffers.plans, [], "billing/preview 返回 data:null 应视作空列表而不是抛 manual_claim_preview_missing_data");

  let rateLimitedCalls = 0;
  const rateLimitSub = createCodingPlanSubscriptionService({
    apiClient: {
      request: async (input) => {
        const url = input instanceof URL ? input.href : String(input);
        if (url.includes("/api/v1/zcode-plan/billing/preview")) {
          rateLimitedCalls++;
          return new Response(JSON.stringify({ code: 429, msg: "Too Many Requests" }), { status: 429 });
        }
        return new Response(JSON.stringify({ code: 0, data: { deliveries: [] } }), { status: 200 });
      },
    },
    credentialService: fakeCreds,
  });
  await assert.rejects(() => rateLimitSub.getManualClaimPlanPreviews(), /manual_claim_preview_rate_limited/);
  await assert.rejects(() => rateLimitSub.getManualClaimPlanPreviews(), /manual_claim_preview_rate_limited/);
  assert.equal(rateLimitedCalls, 1, "遇 HTTP 429 必须进入冷却窗口，禁止连续重试打爆接口");

  // 无 providerFamilyDomain（国内/免绑付费套餐登录）时，Start Plan 仍应解析出当前访问上下文
  const noDomainAuth = accountMod.createMobileAccountRequestAuthService({
    apiClient: balancesOnlyApi,
    credentialService: jwtOnlyCreds,
    settingService: { get: async () => ({ providerFamilyDomain: null }) },
    configSource: {},
  });
  const resolvedStartAccess = await noDomainAuth.resolveAccessCurrent({
    type: "zhipu-account",
    accountType: "bigmodel",
    mode: "start-plan",
  });
  assert.deepEqual(resolvedStartAccess, {
    type: "zhipu-account",
    family: "bigmodel",
    planKind: "start-plan",
  });

  // X-Platform: android-arm64 请求头必须被归一为 linux-arm64
  const quotaTransportMod = await bundleModule("mobile-runtime/ui/quota-transport.ts");
  const normReq = quotaTransportMod.officialIdentityRequest(
    "https://zcode.z.ai/api/v1/zcode-plan/billing/claim",
    { "X-Platform": "android-arm64", Authorization: "Bearer jwt-promo" },
  );
  assert.equal(normReq.headers["X-Platform"], "linux-arm64");

  console.log("start-plan-promo-smoke: ALL PASS");
} finally {
  if (prevStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = prevStorage;
  if (prevGitHttp === undefined) delete globalThis.zcodeGitHttp;
  else globalThis.zcodeGitHttp = prevGitHttp;
  if (prevModelHttp === undefined) delete globalThis.zcodeModelHttp;
  else globalThis.zcodeModelHttp = prevModelHttp;
  if (prevDevice === undefined) delete globalThis.zcodeDevice;
  else globalThis.zcodeDevice = prevDevice;
  for (const file of tempFiles) {
    try { unlinkSync(file); } catch {}
  }
}
