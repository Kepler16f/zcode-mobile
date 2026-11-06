import { useCallback, useEffect, useState } from "react";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useCodingPlanEntitlements } from "@/settings/model-provider-section/useCodingPlanEntitlements.js";
import { BUILTIN_MODEL_PROVIDER_IDS, type EnterpriseCodingPlanPricingProduct } from "@zcode/shared";
import { buildOwnedEntryPlanList } from "@/lib/codingPlanOwnedEntryPlans.js";
import { resolveAccountProviderInspectionAccess } from "@/lib/accountProviderAccess.js";
import { logger } from "@/logger.js";

export interface CodingPlanEntryInventory {
  entryPlanList: string;
  status: "loading" | "error" | "ready";
  retry: () => void;
}

export function useCodingPlanEntryPlanList(): CodingPlanEntryInventory {
  const { state, reload } = useProviderSettingsView();
  const providerSettingsView = state.status === "ready" ? state.view : null;
  const loading = state.status === "loading";
  const { credentialService, codingPlanSubscriptionService } = useServices();
  const user = useZCodeStore((state) => state.user);
  // 不传当前选中的团队上下文，四种 Start/个人连接分别使用已有权益缓存。
  const { entitlements, refresh } = useCodingPlanEntitlements({
    providerSettingsView,
    suppressProviderFingerprintAutoRefresh: true,
  });
  const [generation, setGeneration] = useState(0);
  const retry = useCallback(() => {
    if (state.status === "error") reload();
    setGeneration((value) => value + 1);
  }, [state.status, reload]);
  const [teams, setTeams] = useState<{
    user: typeof user;
    view: typeof providerSettingsView;
    sources: { token: string | null; products: EnterpriseCodingPlanPricingProduct[] | null }[];
    generation: number;
  } | null>(null);
  useEffect(() => {
    if (!providerSettingsView) return;
    let cancelled = false;
    // 团队订阅以 authenticated pricing 为准，不用静态商品目录推断已购套餐。
    void Promise.all([
      refresh({ force: true, silent: true }),
      Promise.all(
        (["bigmodel", "zai"] as const).map(async (family) => {
          let token: string | null = null;
          try {
            token = (await credentialService.load(`oauth:${family}:access_token`))?.trim() || null;
            if (!token) return { token, products: [] };
            const result = await codingPlanSubscriptionService.getEnterprisePricing({
              authenticated: true,
              family,
            });
            return { token, products: result.productList };
          } catch (error) {
            logger.warn("[purchaseTelemetry] 读取团队套餐失败", { family, error });
            return { token, products: null };
          }
        }),
      ),
    ]).then(([, sources]) => {
      if (!cancelled)
        setTeams((previous) => ({
          user,
          view: providerSettingsView,
          generation,
          sources: sources.map((source, index) => {
            // 刷新失败不等于未购；仅在账号、family 和凭据一致时复用成功结果。
            const cached = previous?.sources[index];
            return source.products === null &&
              source.token &&
              previous?.user === user &&
              cached?.token === source.token
              ? { ...source, products: cached.products }
              : source;
          }),
        }));
    });
    return () => {
      cancelled = true;
    };
  }, [
    credentialService,
    codingPlanSubscriptionService,
    user,
    providerSettingsView,
    generation,
    loading,
    refresh,
  ]);
  const sameIdentity = teams?.user === user && teams.view === providerSettingsView;
  const current = sameIdentity && teams.generation === generation;
  // 0.11.2：团队定价查询失败（products=null）不再全局阻断入口——3.16.3 把这类失败
  // 分类成 per-provider 的 unknown 状态，领取界面自己拉公开预览。上次成功的缓存
  // （下方 sources 合并逻辑）仍会尽力还原已购列表；本次失败的家族在 owned 列表里
  // 缺席，比"整个入口打不开"诚实且有用。unusedTeams 留给调试日志。
  const unusedTeams = sameIdentity && teams.sources.some((source) => source.products === null);
  const planIds: readonly string[] = [
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
    BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
  ];
  // 账号模型没有 Personal API Key；沿用权益 hook 的只读 Access 判定，不能过滤未选中/禁用套餐。
  const required = planIds
    .filter((providerId) =>
      resolveAccountProviderInspectionAccess(providerSettingsView, providerId),
    )
    .map((providerId) => entitlements[providerId]);
  // 错误描述的是本次刷新，不能否定仍可用的历史快照（含成功确认未开通）。
  // 0.11.2（对齐已装桌面 3.16.3 的 per-provider 语义）：unavailable＝"该 provider 的
  // 服务端查询失败但原因已知"（余额 401/业务错，分类见 bigmodelUsageQuotaProvider）——
  // 它不该一票否决整个领取入口（装机主诉"Start Plan 查询失败"就是它放大的）；
  // 领取界面自己会重新拉公开预览。真正拦截的是"未登录/未配置"（not_authenticated /
  // not_configured）——那是要用户先登录的硬前提。
  const missing = required.filter((item) => {
    const snapshot = item?.snapshot;
    return (
      !snapshot ||
      (snapshot.unavailableReason !== "no_plan" &&
        snapshot.unavailableReason !== "unavailable" &&
        (!snapshot.authenticated || snapshot.unavailableReason))
    );
  });
  const pending = loading || !current || missing.some((item) => item?.loading);
  const failed = missing.length > 0;
  const status =
    state.status === "error" ? "error" : pending ? "loading" : failed ? "error" : "ready";
  useEffect(() => {
    logger.debug("[purchaseTelemetry] 套餐入口查询状态", {
      status,
      configuredSources: required.length,
      generation,
      teamQueryIncomplete: unusedTeams,
    });
  }, [status, required.length, generation, unusedTeams]);
  return {
    status,
    retry,
    entryPlanList:
      status === "ready"
        ? buildOwnedEntryPlanList({
            snapshots: required.map((item) => item?.snapshot),
            teamProducts: teams?.sources.flatMap((source) => source.products ?? []) ?? [],
          })
        : "",
  };
}
