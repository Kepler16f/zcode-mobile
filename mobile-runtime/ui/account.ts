// 登录后把"账号能提供的那些模型"接回来：桌面用 accountSource 做这件事，端侧复用同一套工厂。
//
// 为什么必须一起接：ProviderRuntime 不给 accountSource 时走 EmptyAccountProviderConfigSource
// （model-provider/providerRuntime.ts:50），账号型 provider 一律 `access.entitled=false`。
// 于是登录成功、身份显示出来，模型列表却还是空的 —— 那比不给登录更让人以为坏了。
//
// 闭包实测（probe-ui-closure.mjs "svc:model-provider/accountProviderConnectionResolver.js"）：
// 328 模块 / 1.25 MB / **0 个缺失垫片**。前提是两个垫片先补上：
//   - node:util 的 isDeepStrictEqual —— 它判"快照变了没有"，比较错了不会报错，只会让登录后
//     的模型列表安静地不刷新（compat/shims/util.mjs）。
//   - undici 换成构造即抛的替身 —— 引它的是 Node 版 ApiClient 的网络栈（nodeApiNetwork.ts:3），
//     端侧的 ApiClient 由 ui/oauth.ts 注入 fetch 版，这条路径不会被调用。
//
// entitlement 不是"有 JWT 就算通过"：accountProvider-resolution.ts:112 只认
// connection.status === "available"，而那来自远端的套餐/团队查询
// （/api/biz/customer/getCustomerInfo、/api/biz/subscription/list）。这里如实把上游那套
// 解析器接上，不自己判"看起来登录了就算有权限"。
import type { ICredentialService, ISettingService } from "@zcode/services";
import {
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  isStartPlanModelProviderId,
  type ModelProviderFamilyId,
} from "@zcode/shared";

import { OAuthCredentialRepo } from "@zcode/services/deep/oauth/repo/oauthCredentialRepo.js";
import { createAccountProviderCredentialService } from "@zcode/services/deep/model-provider/accountProviderCredentialService.js";
import { createAccountProviderCredentialStore } from "@zcode/services/deep/model-provider/accountProviderCredentialStore.js";
import { AccountProviderApiClient } from "@zcode/services/deep/model-provider/accountProviderApiClient.js";
import { AccountProviderApiKeyResolver } from "@zcode/services/deep/model-provider/accountProviderApiKeyResolver.js";
import {
  createAccountProviderConfigSource,
  createCodingPlanFamilyAvailabilityResolver,
  resolveCurrentAccountAccess,
} from "@zcode/services/deep/model-provider/accountProviderConnectionResolver.js";
import { createAccountRequestAuthService } from "@zcode/services/deep/model-provider/accountRequestAuthService.js";
import { createAccountProviderRequestAuthService } from "@zcode/services/deep/model-provider/accountProviderRequestAuthService.js";
import { resolveAccountTeamPlanRuntimeApiKey } from "@zcode/services/deep/model-provider/accountProviderTeamPlanRequestKey.js";
// accountSource 这一格的类型跟着它的**消费方**写：ProviderRuntime 要的是
// RefreshableProviderSource<AccountProviderConfigSnapshot>（providerRuntime.ts:35），
// 在这里写 unknown、到 providers.ts 再 as never，等于把"接得上接不上"这句话从编译期推到运行时。
import type { ProviderRuntimeDependencies } from "@zcode/services/deep/model-provider/providerRuntime.js";
import type { IAccountRequestAuthService } from "@zcode/services/deep/model-provider/accountRequestAuthService.js";

import type { MobileApiClient } from "./oauth.js";

interface MobileAccountOptions {
  credentialService: ICredentialService;
  settingService: ISettingService;
  apiClient: MobileApiClient;
}

/**
 * 账号事实的内部件（repo/远端换 Key/凭据服务）：accountSource 与 accountRequestAuthService
 * 两个工厂共用一段构造，避免各自持有一份缓存（两份缓存就是两条真相——401 重换时各换各的）。
 */
function buildAccountRuntime(options: MobileAccountOptions) {
  const { credentialService, settingService, apiClient } = options;

  const credentialRepo = new OAuthCredentialRepo(credentialService, {
    providerIds: [ZAI_PROVIDER_ID, BIGMODEL_PROVIDER_ID],
  });

  // 桌面在这里还串了一段"旧版账号连接迁移"（node.ts:1477 的 prepareLegacyAccountConnections）。
  // 端侧没有旧配置可迁（第 0 版就是新配置），所以 unresolvedFamilies 恒为空 —— 明写空数组
  // 而不是省略，免得以后有人以为迁移被漏掉了。
  const readSettings = async () => {
    const settings = await settingService.get();
    return {
      providerFamilyDomain: settings.providerFamilyDomain ?? null,
      selections: settings.providerFamilyConnectionSelections ?? {},
      unresolvedFamilies: [],
    };
  };

  const loadAccountIdentity = async (family: "zai" | "bigmodel") =>
    (await credentialRepo.loadUserProfile(family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID))
      ?.id ?? null;

  const remoteApiClient = new AccountProviderApiClient(apiClient as never);
  const apiKeyResolver = new AccountProviderApiKeyResolver(
    remoteApiClient.fetchRemoteData.bind(remoteApiClient),
  );

  const credentialServiceForPlan = createAccountProviderCredentialService({
    credentialStore: createAccountProviderCredentialStore({ credentialService }),
    async loadOAuthAccessToken(family) {
      return (
        (await credentialRepo.loadTokenSet(family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID))
          ?.accessToken ?? null
      );
    },
    resolveProviderApiKey: (family, accessToken) =>
      apiKeyResolver.resolveProviderApiKey(
        family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID,
        accessToken,
      ),
  });

  // 这两个入口必须共用一段逻辑：如果 agent 面自己再调一次 apiKeyResolver，就等于把同一份
  // Coding Plan 凭据建了两条通路 —— 上游那两层的缓存与并发合流都绕过去了，端上表现为
  // "模型列表里有，一发对话就说凭据不可用"（每 401 都真的走一次远端换取）。
  const codingPlanApiKey = async (
    providerId: string,
    family: ModelProviderFamilyId,
    accountIdentity: string,
    forceRefresh: boolean,
  ) => {
    if (isStartPlanModelProviderId(providerId)) return null;
    return credentialServiceForPlan.loadCodingPlanApiKey({
      providerId,
      family,
      accountIdentity,
      forceRefresh,
    });
  };

  return { credentialRepo, readSettings, loadAccountIdentity, credentialServiceForPlan, codingPlanApiKey };
}

export function createMobileAccountSource(options: {
  credentialService: ICredentialService;
  settingService: ISettingService;
  apiClient: MobileApiClient;
  /** 上游 createProviderRuntime 里那个 configService，accountSource 要跟着它的快照走。 */
  configSource: { read(): Promise<unknown>; onDidChange?(l: () => void): unknown };
}): {
  accountSource: NonNullable<ProviderRuntimeDependencies["accountSource"]>;
  /**
   * 账号型 Provider 的请求凭据（Coding Plan 的 `apiKey.secretKey` 复合值）。
   * 桌面把它交给 CLI 前也是在这一步现取（node.ts:1507），缓存与并发合并都在上游那两层里；
   * 端侧没有子进程，agent 面直接调同一个函数拿同一个值 —— 不要再建第二套凭据通路。
   */
  resolveCodingPlanApiKey: (input: {
    providerId: string;
    /**
     * 类型收成 ModelProviderFamilyId（不是 string）是因为上游那两层最终按这个联合查表：
     * loadCodingPlanApiKey → credentialService（accountProviderCredentialService.ts）只认
     * "zai" | "bigmodel"，端侧以前用 string 传，tsc 一跑就是 TS2322。
     * 自由形态的配置值（provider.config.access.accountType）在 provider-target.ts 里
     * 用上游的 normalizeProviderFamilyDomain 收成这个联合，认不出来的在那一步报错给屏幕，
     * 不在这里静默降级。
     */
    family: ModelProviderFamilyId;
    forceRefresh: boolean;
  }) => Promise<string | null>;
} {
  const { credentialService, apiClient, settingService } = options;
  const runtime = buildAccountRuntime({ credentialService, settingService, apiClient });

  const accountSource = createAccountProviderConfigSource({
    configSource: options.configSource as never,
    readSettings: runtime.readSettings as never,
    loadCodingPlanApiKey: runtime.codingPlanApiKey as never,
    loadAccountIdentity: runtime.loadAccountIdentity as never,
    resolveFamilyAvailability: createCodingPlanFamilyAvailabilityResolver({
      apiClient: apiClient as never,
      credentialService,
    }) as never,
  });

  return {
    accountSource,
    resolveCodingPlanApiKey: async ({ providerId, family, forceRefresh }) => {
      // Start Plan消费账号ZCode JWT，不签发Coding Plan API key。
      if (isStartPlanModelProviderId(providerId)) {
        return (await runtime.credentialRepo.loadTokenSet(family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID))?.zcodeJwtToken ?? null;
      }
      const accountIdentity = await runtime.loadAccountIdentity(family);
      // 没有身份 = 这个 family 根本没登录，返回 null 让上层给出"请先登录"，
      // 而不是拿 undefined 去调远端换取、再报一句看不懂的 HTTP 错。
      if (!accountIdentity) return null;
      return runtime.codingPlanApiKey(providerId, family, accountIdentity, forceRefresh);
    },
  };
}

/**
 * 体验套餐/编程套餐的服务端读取链（0.7.3，用户报"体验套餐无法查看"）要的那一面：
 * BigModelUsageQuotaProvider 按"当前账号连接"解析请求凭据（start-plan 走 OAuth token，
 * 编程套餐走换来的 api key），桌面把它叫 accountRequestAuthService（node.ts:1494）。
 * 端侧按同一份构造接上——同一个 repo、同一段换 Key 逻辑，不建第二套凭据通路。
 */
export function createMobileAccountRequestAuthService(options: MobileAccountOptions): IAccountRequestAuthService {
  const runtime = buildAccountRuntime(options);
  return createAccountRequestAuthService(
    createAccountProviderRequestAuthService({
      resolveCurrentAccountAccess: (access) =>
        resolveCurrentAccountAccess({
          access,
          readSettings: runtime.readSettings as never,
          loadAccountIdentity: runtime.loadAccountIdentity as never,
        }),
      loadOAuthTokenSet: (providerId) => runtime.credentialRepo.loadTokenSet(providerId),
      async loadIndividualPlanApiKey(providerId, family) {
        const accountIdentity = await runtime.loadAccountIdentity(family);
        if (!accountIdentity) return null;
        return runtime.credentialServiceForPlan.loadCodingPlanApiKey({
          providerId,
          family,
          accountIdentity,
        });
      },
      resolveTeamPlanApiKey: (access) =>
        resolveAccountTeamPlanRuntimeApiKey({
          apiClient: options.apiClient as never,
          credentialService: options.credentialService,
          access,
        }),
    }),
  );
}
