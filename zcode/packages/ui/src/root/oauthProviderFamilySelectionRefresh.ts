import type { IServiceAccessor } from "@zcode/services";
import type { AccountProviderState } from "@zcode/provider";
import type {
  AppSettings,
  OAuthProviderId,
  ProviderFamilyDomain,
  UsageEntitlementSnapshot,
  ZCodeAccountAccess,
  ZCodeProviderAccountAccess,
} from "@zcode/shared";
import {
  getModelProviderFamilySpec,
  OAUTH_LINKED_BIGMODEL_KEY,
  resolveProviderFamilyDomainFromOAuthProvider,
  resolveStartPlanFamilyFromOAuthProvider,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import { resolveAccountProviderInspectionAccess } from "@/lib/accountProviderAccess.js";
import {
  type ModelProviderFamilyConnectionSelection,
  resolveAutomaticModelProviderFamilyConnectionSelection,
} from "@/lib/modelProviderFamilyConnectionSelection.js";

import { getEnterprisePricingProductsOrEmpty } from "@/root/oauthTeamPricing.js";

async function resolveAvailableFamiliesForProvider(
  services: IServiceAccessor,
  provider: OAuthProviderId | string | null | undefined,
): Promise<{
  families: ProviderFamilyDomain[];
  startFamily: ProviderFamilyDomain | null;
}> {
  const direct = resolveProviderFamilyDomainFromOAuthProvider(provider);
  const startFamily = resolveStartPlanFamilyFromOAuthProvider(provider);
  const families: ProviderFamilyDomain[] = direct ? [direct] : [];
  if (!families.includes("bigmodel")) {
    try {
      const rawLinked = await services.credentialService.load(OAUTH_LINKED_BIGMODEL_KEY);
      if (rawLinked) {
        const parsed = JSON.parse(rawLinked) as { customerId?: unknown; accessToken?: unknown };
        if (
          typeof parsed?.customerId === "string" &&
          parsed.customerId.trim() &&
          typeof parsed?.accessToken === "string" &&
          parsed.accessToken.trim()
        ) {
          families.push("bigmodel");
        }
      }
    } catch {
      // 忽略损坏关联材料
    }
  }
  return { families, startFamily };
}

/**
 * 同步上游 v4.0.0：纠正当前账号不可用的登录前遗留 providerFamilyDomain。
 * 未登录时 API Key 页“跳过”会写入默认 domain（如 zai），之后用国内入口（bigmodel/zai_cn）
 * 登录时若原样沿用，会导致 Start 与个人/团队套餐都不是当前连接、剩余用量与试用模型全部被隐藏。
 */
async function correctUnusableProviderFamilyDomain(
  services: IServiceAccessor,
  settings: AppSettings,
  provider: OAuthProviderId,
): Promise<AppSettings> {
  const current = settings.providerFamilyDomain;
  if (!current) return settings;
  const { families, startFamily } = await resolveAvailableFamiliesForProvider(services, provider);
  if (families.includes(current) || current === startFamily) return settings;
  if (settings.providerFamilyConnectionSelections?.[current]) return settings;
  const next = families[0] ?? startFamily;
  if (!next) return settings;
  try {
    await services.settingService.update(
      {
        providerFamilyDomain: next,
        providerFamilyDomainUpdatedAt: Date.now(),
        providerFamilyDomainMigrated: true,
      },
      {
        providerFamilyDomain: current,
        providerFamilyConnectionSelections: settings.providerFamilyConnectionSelections,
      },
    );
  } catch (error) {
    logger.warn("[Root] 纠正 provider family 时设置已变化，按最新设置继续", {
      name: error instanceof Error ? error.name : "unknown",
    });
    return services.settingService.get();
  }
  logger.info("[Root] 已纠正当前账号不可用的 provider family", {
    loginProvider: provider,
    from: current,
    to: next,
  });
  return services.settingService.get();
}

async function getUsageEntitlementSnapshotOrNull(params: {
  services: IServiceAccessor;
  providerId: string;
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
}): Promise<UsageEntitlementSnapshot | null> {
  try {
    return await params.services.usageStatsService.getEntitlementSnapshot({
      includeSubscription: true,
      preferredProviderId: params.providerId,
      accountAccess: params.accountAccess,
      allowDisabledPreferredProvider: true,
      requirePreferredProvider: true,
      allowEnvApiKey: false,
    });
  } catch (error) {
    logger.warn("[Root] 刷新登录后权益快照失败", {
      providerId: params.providerId,
      error,
    });
    return null;
  }
}

async function refreshAccountProviderAccesses(params: {
  services: IServiceAccessor;
  providerIds: readonly string[];
  reason: string;
}): Promise<{
  accesses: ReadonlyMap<string, ZCodeProviderAccountAccess | ZCodeAccountAccess>;
  states: ReadonlyMap<string, AccountProviderState>;
  refreshed: boolean;
  error?: unknown;
}> {
  const providerSettingsService = params.services.providerSettingsService;

  try {
    const view = await providerSettingsService.refresh(params.reason);
    const accesses = new Map(
      params.providerIds.flatMap((providerId) => {
        const resolved = resolveAccountProviderInspectionAccess(view, providerId);
        if (!resolved) return [];
        const access = resolved.access;
        // 登录/启动检查属于套餐只读查询。静态 mode 会经执行期 current 解析，
        // 把未选中或 pending 的 Start 当作当前 Coding 查询；此处必须明确查询套餐自身。
        const query: ZCodeProviderAccountAccess | ZCodeAccountAccess =
          access.mode === "start-plan" || access.mode === "individual-coding-plan"
            ? { type: "zhipu-account", family: access.accountType, planKind: access.mode }
            : access;
        return [[providerId, query] as const];
      }),
    );
    return {
      refreshed: true,
      accesses,
      states: new Map(
        view.providers.flatMap((provider) =>
          provider.accountState ? [[provider.providerId, provider.accountState] as const] : [],
        ),
      ),
    };
  } catch (error) {
    logger.warn("[Root] 刷新 Account Provider 访问身份失败", {
      providerIds: params.providerIds,
      error,
    });
    return { refreshed: false, accesses: new Map(), states: new Map(), error };
  }
}

export async function refreshLatestModelProviderFamilySelectionAfterLogin(params: {
  provider: OAuthProviderId;
  services: IServiceAccessor;
}): Promise<ModelProviderFamilyConnectionSelection | null> {
  const currentSettings = await correctUnusableProviderFamilyDomain(
    params.services,
    await params.services.settingService.get(),
    params.provider,
  );
  const { families, startFamily } = await resolveAvailableFamiliesForProvider(
    params.services,
    params.provider,
  );
  const domain = currentSettings.providerFamilyDomain ?? families[0] ?? startFamily ?? null;
  if (!domain) {
    return null;
  }

  const familySpec = getModelProviderFamilySpec(domain);
  const expectedAccountSettings = {
    providerFamilyDomain: currentSettings.providerFamilyDomain,
    providerFamilyConnectionSelections: currentSettings.providerFamilyConnectionSelections,
  };
  const codingPlanProviderId = familySpec.individualCodingPlanProviderId;
  const startPlanProviderId = familySpec.startPlanProviderId;
  const codingPlanProviderIds = [
    familySpec.individualCodingPlanProviderId,
    familySpec.startPlanProviderId,
    familySpec.teamCodingPlanProviderId,
  ];
  const { accesses, states, refreshed } = await refreshAccountProviderAccesses({
    services: params.services,
    providerIds: codingPlanProviderIds,
    reason: "oauth-login-entitlement",
  });
  if (!refreshed) return null;
  // 登录后的刷新也可能仍在等待旧 Team 补组织；未知不是可按排序重选的首次连接。
  if (
    !currentSettings.providerFamilyConnectionSelections?.[domain] &&
    codingPlanProviderIds.every((id) => states.get(id)?.availability === "unknown")
  )
    return null;

  const [codingPlanEntitlement, startPlanEntitlement, teamProducts] = await Promise.all([
    getUsageEntitlementSnapshotOrNull({
      services: params.services,
      providerId: codingPlanProviderId,
      accountAccess: accesses.get(codingPlanProviderId),
    }),
    getUsageEntitlementSnapshotOrNull({
      services: params.services,
      providerId: startPlanProviderId,
      accountAccess: accesses.get(startPlanProviderId),
    }),
    getEnterprisePricingProductsOrEmpty(params.services, domain),
  ]);
  // 旧 Start 连接只保留读取，不以权益失效为由删除或自动替换成付费连接。
  const savedSelection = currentSettings.providerFamilyConnectionSelections?.[domain];
  if (savedSelection?.kind === "start-plan") return savedSelection;
  const selection = resolveAutomaticModelProviderFamilyConnectionSelection({
    providerFamilyDomain: domain,
    codingPlanEntitlement,
    startPlanEntitlement,
    teamProducts,
    codingPlanAvailable: states.has(codingPlanProviderId)
      ? states.get(codingPlanProviderId)!.availability === "available"
      : undefined,
    startPlanAvailable: states.has(startPlanProviderId)
      ? states.get(startPlanProviderId)!.availability === "available"
      : undefined,
  });
  if (!selection) {
    return null;
  }

  await params.services.settingService.update(
    {
      providerFamilyDomain: domain,
      providerFamilyDomainUpdatedAt: Date.now(),
      providerFamilyDomainMigrated: true,
      providerFamilyConnectionSelections: {
        ...currentSettings.providerFamilyConnectionSelections,
        [domain]: selection,
      },
    },
    expectedAccountSettings,
  );
  return selection;
}

export async function refreshRestoredOAuthProviderFamilyAfterStartup(params: {
  activeProvider: OAuthProviderId | null;
  services: IServiceAccessor;
  refreshAppSettings?: () => Promise<void>;
}): Promise<ModelProviderFamilyConnectionSelection | null> {
  if (!params.activeProvider) return null;
  const storedSettings = await params.services.settingService.get();
  const settings = await correctUnusableProviderFamilyDomain(
    params.services,
    storedSettings,
    params.activeProvider,
  );
  if (settings !== storedSettings) {
    await params.refreshAppSettings?.();
  }
  const { families, startFamily } = await resolveAvailableFamiliesForProvider(
    params.services,
    params.activeProvider,
  );
  const domain = settings.providerFamilyDomain ?? families[0] ?? startFamily ?? null;
  if (!domain) return null;
  const saved = settings.providerFamilyConnectionSelections?.[domain];
  if (saved) {
    // 原因：启动时的不可用不是本次运行中发生的失效，不能替用户更换已保存连接。
    // 刷新账号事实仍照常执行；只有后续真实失效提示的点击动作允许选择替代套餐。
    try {
      await params.services.providerSettingsService.refresh("oauth-restore-entitlement");
    } catch (error) {
      logger.warn("[Root] 启动账号刷新失败，保留原连接", { error });
    }
    return saved;
  }
  try {
    // 仅真正没有选择才沿用首次初始化；该入口保留旧连接待迁移的 unknown 保护及条件写入。
    const selection = await refreshLatestModelProviderFamilySelectionAfterLogin({
      provider: params.activeProvider,
      services: params.services,
    });
    if (selection) await params.refreshAppSettings?.();
    return selection;
  } catch (error) {
    logger.warn("[Root] 启动初始化连接失败", { error });
    return null;
  }
}
