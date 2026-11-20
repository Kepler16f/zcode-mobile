import type { ApiClient } from "@zcode/shared";
import {
  buildRuntimeZCodeEndpointUrls,
  normalizeOfficialGlmModelId,
  ZCODE_VERSION,
} from "@zcode/shared";
import { readApiJson } from "../providers/api/apiJson.js";

const REQUEST_TIMEOUT_MS = 15_000;
const ZAI_START_PLAN_BALANCE_URL = buildRuntimeZCodeEndpointUrls(
  process.env,
).zcodePlanBillingBalanceUrl;

export interface ZaiStartPlanPlan {
  // user_plan_id 标识用户套餐实例；额度提醒用它关联同一实例的 entitlement 周期类型。
  user_plan_id?: string;
  plan_id?: string;
  name?: string;
  status?: string;
  starts_at?: number | string | null;
  ends_at?: number | string | null;
  entitlements?: Array<{
    entitlement_id?: string | null;
    show_name?: string | null;
    period?: string | null;
    effective_at?: number | string | null;
  }>;
}

export interface ZaiStartPlanBalanceEnvelope {
  code?: number;
  success?: boolean;
  msg?: string;
  data?: {
    server_time?: number;
    plans?: ZaiStartPlanPlan[];
    balances?: Array<{
      bucket_id?: string;
      user_plan_id?: string;
      plan_id?: string;
      entitlement_id?: string;
      show_name?: string;
      meter?: string;
      unit_type?: string;
      capabilities?: string[];
      total_units?: number | string | null;
      used_units?: number | string | null;
      reserved_units?: number | string | null;
      remaining_units?: number | string | null;
      available_units?: number | string | null;
      period_start?: number | string | null;
      period_end?: number | string | null;
      expires_at?: number | string | null;
    }>;
  };
}

const inflightBalanceRequests = new WeakMap<
  ApiClient,
  Map<string, Promise<ZaiStartPlanBalanceEnvelope>>
>();

export function buildZaiStartPlanBalanceUrl(): string {
  const url = new URL(ZAI_START_PLAN_BALANCE_URL);
  // Start Plan balance 接口按真实 app_version 判定能力；
  // 开发环境也不能固定 3.0.0，否则本地验证会绕过当前 App 版本的后端策略。
  url.searchParams.set("app_version", ZCODE_VERSION);
  return url.toString();
}

export async function fetchZaiStartPlanBalanceEnvelope(
  apiClient: ApiClient,
  authorization: string,
  invalidateCache = false,
): Promise<ZaiStartPlanBalanceEnvelope> {
  const requestKey = JSON.stringify({
    authorization: authorization.trim(),
    url: buildZaiStartPlanBalanceUrl(),
  });

  let requests = inflightBalanceRequests.get(apiClient);
  if (!requests) {
    requests = new Map();
    inflightBalanceRequests.set(apiClient, requests);
  }

  if (invalidateCache) requests.delete(requestKey);
  const inflight = requests.get(requestKey);
  if (inflight) {
    return inflight;
  }

  const url = buildZaiStartPlanBalanceUrl();
  const startedAt = Date.now();
  let responseTime: number | undefined;
  let rateLimited = false;
  const observedApi: ApiClient = {
    request: async (input, init) => {
      const response = await apiClient.request(input, init);
      if (response.status === 429) rateLimited = true;
      const date = Date.parse(response.headers.get("date") ?? "");
      if (Number.isFinite(date)) responseTime = date / 1000;
      return response;
    },
  };
  const request = readApiJson<ZaiStartPlanBalanceEnvelope>(observedApi, url, {
    method: "GET",
    timeoutMs: REQUEST_TIMEOUT_MS,
    headers: {
      Authorization: authorization,
    },
  })
    .then((payload) => normalizeStartPlanExpiry(payload, responseTime))
    .finally(() => {
      // 账号校验先完成，用量查询随后到达：保留同一响应至发起后 1 秒；
      // 遇 429 延长退避窗口至 5 秒，避免立刻重复打爆限流。
      const evict = () => {
        if (requests?.get(requestKey) !== request) return;
        requests.delete(requestKey);
        if (requests.size === 0) inflightBalanceRequests.delete(apiClient);
      };
      const holdMs = rateLimited ? 5_000 : 1_000;
      const remainingMs = holdMs - (Date.now() - startedAt);
      if (remainingMs > 0) setTimeout(evict, remainingMs);
      else evict();
    });

  requests.set(requestKey, request);
  return request;
}

export function resolveZaiStartPlanBalanceModelIds(payload: ZaiStartPlanBalanceEnvelope): string[] {
  const seen = new Set<string>();
  const modelIds: string[] = [];

  for (const balance of payload.data?.balances ?? []) {
    const fromCapabilities = (balance.capabilities ?? [])
      .map((capability) => {
        const normalized = capability.trim();
        return normalized.toLowerCase().startsWith("model:")
          ? normalized.slice("model:".length).trim()
          : "";
      })
      .filter(Boolean);
    const candidates = fromCapabilities.length > 0 ? fromCapabilities : [balance.show_name ?? ""];
    for (const candidate of candidates) {
      const modelId = normalizeOfficialGlmModelId(candidate.trim());
      const key = modelId.toLowerCase();
      if (!modelId || seen.has(key)) {
        continue;
      }
      seen.add(key);
      modelIds.push(modelId);
    }
  }

  return modelIds;
}

function toUnixSeconds(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric > 1e11 ? numeric / 1000 : numeric;
}

/** HTTP Date 与本次响应配对，避免旧 JSON 时间让过期 active 记录继续提供权益。 */
function normalizeStartPlanExpiry(
  payload: ZaiStartPlanBalanceEnvelope,
  responseTime?: number,
): ZaiStartPlanBalanceEnvelope {
  if (!payload.data) return payload;
  const serverTime = toUnixSeconds(payload.data.server_time);
  const now = responseTime ?? serverTime ?? Date.now() / 1000;
  const plans = (payload.data.plans ?? []).map((plan) => {
    const end = toUnixSeconds(plan.ends_at);
    return plan.status?.trim().toLowerCase() === "active" &&
      end !== null &&
      end <= now
      ? { ...plan, status: "expired" }
      : plan;
  });
  const balances = payload.data.balances?.filter((balance) => {
    const owners = plans.filter((plan) =>
      balance.user_plan_id && plan.user_plan_id
        ? plan.user_plan_id === balance.user_plan_id
        : plan.plan_id?.trim().toLowerCase() === balance.plan_id?.trim().toLowerCase(),
    );
    // 无归属桶继续由既有诊断处理，不能误删同商品另一个有效实例的余额。
    return !owners.length || owners.some((plan) => plan.status?.trim().toLowerCase() !== "expired");
  });
  return { ...payload, data: { ...payload.data, plans, balances } };
}
