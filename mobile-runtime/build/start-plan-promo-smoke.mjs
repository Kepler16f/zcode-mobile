/**
 * Start Plan 赠送活动全链路冒烟：
 *   1. 版本伪装与包内 ZCODE_VERSION 注入（跟随实挖的官方版本，而非 0.0.0-dev）；
 *   2. 官方请求头对齐（zcode.z.ai 鉴权 + 对话追踪头，第三方域零泄漏）；
 *   3. 识别非 "start plan" 字面的限时赠送活动（如 ZCODE WEEKEND BUILD），并拒掉过期 active 脏数据；
 *   4. billing/preview + marketing/touch 合并发现与 billing/claim（含 3007 验证重放 + touch 确认）；
 *   5. 端侧 Start Plan JWT 凭据跨 family / zcodejwttoken 兜底解析。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { readFileSync, unlinkSync } from "node:fs";
import { readOfficialCompatVersion } from "./official-version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const esbuild = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"))("esbuild");
const officialVersion = readOfficialCompatVersion(root);
assert.match(officialVersion, /^\d+\.\d+\.\d+$/, "官方兼容版本应为三段数字（实挖或兜底）");
assert.notEqual(officialVersion, "0.0.0-dev", "不能把开发版本号发给服务端");

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
        assert.equal(hdrs["X-Aliyun-Captcha-Region"], undefined, "不应发送非官方头 X-Aliyun-Captcha-Region");
        assert.equal(hdrs["X-Aliyun-Captcha-Verify-Region"], "cn", "必须携带官方头 X-Aliyun-Captcha-Verify-Region");
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

  // ── 6. v4.0.0 全面对齐回归（GLM-5.4 + highspeed Schema + Aliyun V3 Captcha + 半登录态清理 + 时钟偏移 + 遗留家族域纠偏 + 流式 3007 重试）──
  const builtinJson = JSON.parse(
    readFileSync(path.join(root, "zcode/config/provider/zcode-builtin.json"), "utf8"),
  );
  assert.ok(builtinJson.revision >= 48, "内置 zcode-builtin.json 至少同步至 revision 48");
  const bmStartRule = builtinJson.config.providerConfigRules.providerRules.find(
    (r) => r.providerId === "account:bigmodel-start-plan",
  );
  assert.ok(
    bmStartRule?.config?.builtinModelIds?.includes("GLM-5.4"),
    "account:bigmodel-start-plan 必须包含 GLM-5.4",
  );
  const { decodeZCodeBuiltinRelease } = await bundleModule(
    "zcode/packages/provider-node/src/zcode-builtin-release.ts",
  );
  assert.equal(
    decodeZCodeBuiltinRelease(builtinJson).revision,
    builtinJson.revision,
    "zcode-builtin.json（含 highspeed 模式与 GLM-5.4）必须通过完整 Release Schema 校验",
  );

  const glmIdMod = await bundleModule("zcode/packages/shared/src/official-glm-model-id.ts");
  assert.equal(
    glmIdMod.normalizeOfficialGlmModelId("glm-5.4"),
    "GLM-5.4",
    "billing/balance 返回的小写 model:glm-5.4 必须规范化为大写 GLM-5.4 以匹配 Registry",
  );

  // Aliyun Captcha V3 分离式核验静态守卫（禁止退回 V2 captchaVerifyCallback）
  const browserBridgeKt = readFileSync(
    path.join(root, "android-app/app/src/main/kotlin/cn/zcode/mobile/BrowserBridge.kt"),
    "utf8",
  );
  assert.match(browserBridgeKt, /success:\s*function\s*\(\s*captchaVerifyParam\s*\)/);
  assert.match(browserBridgeKt, /fail:\s*function\s*\(\s*result\s*\)/);
  assert.match(browserBridgeKt, /showErrorTip:\s*false/);
  assert.match(browserBridgeKt, /startTracelessVerification/);
  assert.ok(
    !/captchaVerifyCallback\s*:/.test(browserBridgeKt),
    "BrowserBridge.kt 严禁传入 V2 captchaVerifyCallback（会导致 AliyunCaptcha.js 退回 2.0 耦合模式使验证失效）",
  );

  // 登录前遗留 providerFamilyDomain="zai" 时，bigmodel/zai_cn 登录仍必须把 bigmodel Start Plan 判为当前可用
  const zaiCnCredMap = new Map([
    ["oauth:active_provider", "zai_cn"],
    ["oauth:zai_cn:access_token", "cn-access"],
    ["oauth:zai_cn:user_info", JSON.stringify({ user_id: "u_cn_1", name: "CNUser" })],
    ["zcodejwttoken", "jwt-cn-valid"],
  ]);
  const zaiCnCreds = {
    load: async (k) => zaiCnCredMap.get(k) ?? null,
    save: async (k, v) => {
      zaiCnCredMap.set(k, v);
    },
    delete: async (k) => zaiCnCredMap.delete(k),
  };
  const leftoverDomainAuth = accountMod.createMobileAccountRequestAuthService({
    apiClient: balancesOnlyApi,
    credentialService: zaiCnCreds,
    settingService: {
      get: async () => ({ providerFamilyDomain: "zai", providerFamilyConnectionSelections: {} }),
    },
    configSource: {},
  });
  const leftoverResolved = await leftoverDomainAuth.resolveAccessCurrent({
    type: "zhipu-account",
    accountType: "bigmodel",
    mode: "start-plan",
  });
  assert.deepEqual(
    leftoverResolved,
    { type: "zhipu-account", family: "bigmodel", planKind: "start-plan" },
    "未保存 zai 付费选择时，遗留 providerFamilyDomain=zai 不得锁死已登录的国内 Start Plan",
  );

  // OAuthService：1) 缺失 zcodejwttoken 的 bigmodel 半登录态必须清理并返回 signed-out；2) server_time 时钟偏移容错
  const { OAuthService } = await bundleModule("zcode/packages/services/src/oauth/oauthService.ts");
  const halfCredMap = new Map([
    ["oauth:active_provider", "bigmodel"],
    ["oauth:bigmodel:user_info", JSON.stringify({ id: "u_bm", username: "bm", displayName: "bm" })],
    ["oauth:bigmodel:access_token", "bm-access"],
  ]);
  const halfOAuth = new OAuthService(
    {
      load: async (k) => halfCredMap.get(k) ?? null,
      save: async (k, v) => {
        halfCredMap.set(k, v);
      },
      delete: async (k) => halfCredMap.delete(k),
    },
    {
      apiClient: {
        request: async () =>
          new Response(
            JSON.stringify({
              code: 0,
              data: {
                flow_id: "f_skew",
                authorize_url: "https://zchat.z.ai/api/oauth/authorize?state=st_skew",
                server_time: 1_700_000_000,
                expires_at: 1_700_000_300,
                poll_interval_sec: 2,
              },
            }),
            { status: 200 },
          ),
      },
      // 模拟手机本地时钟比服务端快 10 分钟（+600s）
      now: () => 1_700_000_600_000,
      env: {},
    },
  );
  const halfRestored = await halfOAuth.restoreCachedSessionState();
  assert.equal(halfRestored.status, "signed-out", "缺失 zcodejwttoken 的 bigmodel 半登录态必须按未登录清理");
  assert.equal(halfCredMap.has("oauth:active_provider"), false, "半登录态清理后不应残留 active_provider");
  const skewStart = await halfOAuth.startOAuthWithPolling("zai_cn");
  assert.equal(skewStart.provider, "zai_cn");
  assert.match(decodeURIComponent(skewStart.authorizeUrl), /provider=zai_cn/);
  await halfOAuth.cancelPending();

  // 官网活动页注入脚本必须携带 oauth:active_provider 与 oauth:zai_cn:access_token
  const webviewMod = await bundleModule(
    "zcode/packages/ui/src/settings/model-provider-section/codingPlanEmbeddedWebview.ts",
  );
  const injScript = webviewMod.createCodingPlanAuthInjectionScript({
    provider: "bigmodel",
    loginProvider: "zai_cn",
    credentials: { zcodeJwtToken: "jwt-cn", zaiCnAccessToken: "cn-tok" },
    theme: "zai-dark",
    locale: "zh-CN",
  });
  assert.match(injScript, /"oauth:active_provider",\s*"zai_cn"/);
  assert.match(injScript, /"oauth:zai_cn:access_token",\s*"cn-tok"/);

  // 模型对话流触发 3007 安全验证时自动附带阿里云验证头重试，且请求体/UA/metadata 严格对齐官方 ZCode 4.0.0 白名单（防 HTTP 405）
  const streamMod = await bundleModule("mobile-runtime/ui/model-stream.ts");
  const connectivityMod = await bundleModule("mobile-runtime/ui/model-connectivity.ts");
  let streamCalls = 0;
  let capturedVerifyHdr = null;
  let capturedModelReq = null;
  globalThis.zcodeModelHttp = {
    start(req) {
      streamCalls++;
      const parsed = JSON.parse(req);
      capturedModelReq = parsed;
      capturedVerifyHdr = hdr(parsed.headers, "x-aliyun-captcha-verify-param") ?? null;
      pollStep = 0;
      return JSON.stringify({ id: `s_${streamCalls}` });
    },
    poll() {
      pollStep++;
      if (pollStep > 1) return JSON.stringify({ done: true });
      if (streamCalls === 1) {
        return JSON.stringify({
          status: 403,
          headers: { "content-type": "application/json" },
          bodyBase64: btoa('{"code":3007,"msg":"captcha verification required"}'),
          done: true,
        });
      }
      return JSON.stringify({
        status: 200,
        headers: { "content-type": "application/json" },
        bodyBase64: btoa('{"type":"message","stop_reason":"end_turn","content":[{"type":"text","text":"OK-5.4"}]}'),
        done: true,
      });
    },
    cancel() {
      return true;
    },
  };
  globalThis.__zcodeResolveModelVerificationHeaders = async () => ({
    "X-Aliyun-Captcha-Verify-Param": "stream-verified-token",
    "X-Aliyun-Captcha-Verify-Region": "cn",
  });
  let streamed = "";
  const streamRes = await streamMod.streamModelCompletionWithRetry({
    target: {
      apiFormat: "anthropic-messages",
      baseUrl: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
      apiKey: "jwt-test",
      model: "GLM-5.4",
      reasoningLevel: "max",
      reasoningValues: ["low", "high", "max"],
    },
    messages: [
      { role: "system", content: "You are ZCode, an interactive coding agent\nMobile instructions." },
      { role: "user", content: "ping" },
    ],
    onDelta: (d) => {
      streamed += d;
    },
  });
  assert.equal(streamCalls, 2, "流式对话遇 3007 安全验证应自动完成一次带凭证重放");
  assert.equal(capturedVerifyHdr, "stream-verified-token");
  assert.equal(streamRes.text, "OK-5.4");
  assert.equal(streamed, "OK-5.4");
  const wireBody = JSON.parse(capturedModelReq.body);
  assert.ok(Array.isArray(wireBody.system), "zcode-plan/anthropic 请求体 system 必须是数组而非裸字符串");
  assert.deepEqual(wireBody.system[0], {
    type: "text",
    text: "You are ZCode, an interactive coding agent",
  });
  assert.equal(wireBody.system[1]?.type, "text");
  assert.match(wireBody.system[1]?.text ?? "", /^\nMobile instructions\./);
  assert.deepEqual(wireBody.thinking, { type: "enabled" }, "GLM-5.4 推理字段不得携带非法 budget_tokens");
  assert.deepEqual(wireBody.output_config, { effort: "max" }, "GLM-5.4 必须发送 output_config.effort");
  assert.deepEqual(wireBody.messages, [{ role: "user", content: [{ type: "text", text: "ping" }] }]);
  const parsedMetaUserId = JSON.parse(wireBody.metadata?.user_id ?? "{}");
  assert.equal(typeof parsedMetaUserId.device_id, "string");
  assert.equal(parsedMetaUserId.account_uuid, "");
  assert.equal(typeof parsedMetaUserId.session_id, "string");
  assert.match(
    String(hdr(capturedModelReq.headers, "user-agent") ?? ""),
    /^ZCode\/\d+\.\d+\.\d+ ai-sdk\/provider-utils\/\d+\.\d+\.\d+ runtime\/node\.js\/\d+$/,
  );
  delete globalThis.__zcodeResolveModelVerificationHeaders;

  // 连通性探测（设置页「测试连接」）必须发送官方白名单消息对 + provider_settings_connectivity
  streamCalls = 2;
  const tester = connectivityMod.createMobileConnectivityTester({
    resolver: {
      view: async () => ({
        providers: [
          {
            providerId: "account:bigmodel-start-plan",
            models: [
              {
                modelId: "GLM-5.4",
                config: {
                  optionSpecs: {
                    reasoningLevel: { values: ["low", "high", "max"] },
                    maxOutputTokens: { max: 128000 },
                  },
                },
              },
            ],
            config: {
              api: {
                type: "anthropic-messages",
                baseUrl: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
              },
              access: { type: "zhipu-account", accountType: "bigmodel" },
            },
          },
        ],
      }),
      codingPlanApiKey: async () => "jwt-test",
    },
  });
  const probeOutcome = await tester({
    workspacePath: "/work",
    providerId: "account:bigmodel-start-plan",
    modelId: "GLM-5.4",
  });
  assert.equal(probeOutcome.success, true);
  const probeBody = JSON.parse(capturedModelReq.body);
  assert.deepEqual(probeBody.system, [
    { type: "text", text: "You are ZCode connectivity probe." },
  ]);
  assert.deepEqual(probeBody.messages, [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  assert.equal(probeBody.max_tokens, 512);
  assert.deepEqual(probeBody.output_config, { effort: "low" });
  assert.equal(hdr(capturedModelReq.headers, "x-zcode-query-source"), "provider_settings_connectivity");
  assert.equal(hdr(capturedModelReq.headers, "x-zcode-session-type"), "other");

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
