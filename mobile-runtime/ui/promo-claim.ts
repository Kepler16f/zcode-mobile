/**
 * Start Plan 赠送活动（非付费订阅）的端侧激活上报与人机验证入口：
 *   1. `/api/v1/event/report`：按官方客户端 16 字段协议发送 `app_launch` 与 `app_daily_active`
 *      （按账号+日期去重，非阻塞后台执行），确保服务端认定当前客户端为最新官方版本并正常下发活动资格。
 *   2. 阿里云验证码人机核验（3007）：若 `POST /api/v1/zcode-plan/billing/claim` 触发安全验证，
 *      调用原生 `BrowserBridge.openCaptchaChallenge` 拉起官方 Aliyun Captcha SDK 页面由用户本人完成拼图，
 *      拿到真实的 `X-Aliyun-Captcha-Verify-Param` 后重试领取。
 */
import type { RequestVerificationConfig, RequestVerificationProof } from "@zcode/shared";
import {
  decodeJwtUserId,
  getOrCreateDeviceMid,
  officialIdentityRequest,
} from "./quota-transport.js";
import { officialCompatibilityVersion } from "./server-compat.js";

const DAILY_ACTIVE_CACHE_KEY = "zcode-mobile.startPlanDailyActiveDay";
const EVENT_REPORT_URL = "https://zcode.z.ai/api/v1/event/report";
const VERIFICATION_GLOBAL_KEY = "__zcodeRequestClaimVerification";

type CaptchaPollResult = {
  done?: boolean;
  ok?: boolean;
  cancelled?: boolean;
  captchaVerifyParam?: string;
  region?: string;
};

type NativeCaptchaBridge = {
  openCaptchaChallenge?(request: string): string;
  pollCaptchaResult?(id: string): string;
};

let launchReportedInSession = false;

function currentTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  } catch {
    return "Asia/Shanghai";
  }
}

function currentLanguage(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "zh-CN";
  } catch {
    return "zh-CN";
  }
}

function todayKey(userId: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return `${userId || "anon"}:${day}`;
}

function makeUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

async function postEvent(
  apiRequest: (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }) => Promise<unknown>,
  elementName: string,
  userId: string,
  jwt: string | null,
  deviceMid: string,
): Promise<void> {
  const version = officialCompatibilityVersion();
  const body = JSON.stringify({
    event_id: makeUuid(),
    client_timezone: currentTimezone(),
    client_language: currentLanguage(),
    element_name: elementName,
    event_region: "app",
    event_type: "view",
    event_text: "",
    event_extra_detail: {},
    user_id: userId,
    screen_resolution: "1920x1080",
    app_version: version,
    device_os_category: "linux",
    device_os_version: "6.8.0-45-generic",
    device_mid: deviceMid,
    mac_id: "",
    marketing_params: "{}",
  });
  const baseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
  };
  const identity = officialIdentityRequest(EVENT_REPORT_URL, baseHeaders);
  await apiRequest(identity.url.toString(), {
    method: "POST",
    headers: identity.headers,
    body,
    timeoutMs: 8_000,
  });
}

export async function reportStartPlanActivationEvents(options: {
  apiRequest: (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }) => Promise<unknown>;
  loadJwt: () => Promise<string | null>;
}): Promise<void> {
  try {
    const jwt = (await options.loadJwt())?.trim() || null;
    const userId = decodeJwtUserId(jwt) ?? "";
    const deviceMid = getOrCreateDeviceMid();
    if (!launchReportedInSession) {
      launchReportedInSession = true;
      await postEvent(options.apiRequest, "app_launch", userId, jwt, deviceMid).catch(() => {});
    }
    const dayKey = todayKey(userId);
    const prevDay = globalThis.localStorage?.getItem(DAILY_ACTIVE_CACHE_KEY);
    if (prevDay !== dayKey && userId) {
      await postEvent(options.apiRequest, "app_daily_active", userId, jwt, deviceMid)
        .then(() => {
          globalThis.localStorage?.setItem(DAILY_ACTIVE_CACHE_KEY, dayKey);
        })
        .catch(() => {});
    }
  } catch {
    // 激活事件只做尽最大努力上报，不阻断主流程。
  }
}

export function installMobilePromoVerificationHook(): void {
  const g = globalThis as Record<string, unknown>;
  g[VERIFICATION_GLOBAL_KEY] = async (
    config: RequestVerificationConfig,
  ): Promise<RequestVerificationProof | null> => {
    const bridge = (globalThis as { zcodeBrowser?: NativeCaptchaBridge }).zcodeBrowser;
    if (!bridge?.openCaptchaChallenge || !bridge?.pollCaptchaResult) {
      return null;
    }
    const dark =
      typeof document !== "undefined" && document.documentElement.classList.contains("dark");
    const lang = currentLanguage().toLowerCase().startsWith("zh") ? "cn" : "en";
    const startRaw = bridge.openCaptchaChallenge(
      JSON.stringify({
        prefix: config.prefix,
        sceneId: config.sceneId,
        region: config.region || "cn",
        lang,
        theme: dark ? "dark" : "light",
      }),
    );
    let challengeId = "";
    try {
      const parsed = JSON.parse(startRaw) as { ok?: boolean; id?: string; error?: string };
      if (!parsed.ok || !parsed.id) return null;
      challengeId = parsed.id;
    } catch {
      return null;
    }

    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      let poll: CaptchaPollResult | null = null;
      try {
        poll = JSON.parse(bridge.pollCaptchaResult(challengeId)) as CaptchaPollResult;
      } catch {
        continue;
      }
      if (!poll?.done) continue;
      if (poll.ok && poll.captchaVerifyParam) {
        return {
          captchaVerifyParam: poll.captchaVerifyParam,
          ...(poll.region ? { captchaVerifyRegion: poll.region } : {}),
        };
      }
      return null;
    }
    return null;
  };
}
