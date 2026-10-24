// 把"UI 选出来的那个模型"换成"真能发 HTTP 的那个落点"（baseUrl + Key + 协议种类）。
//
// 数据源只有 ProviderRuntime 的 modelSelection 视图：桌面上 CLI 也是拿同一份配置快照自己解析的
// （node.ts:2241 把 zcodeBuiltinFilePath / personalFilePath 两个路径塞进子进程环境，子进程重读同一批文件），
// 端侧没有子进程，就在本进程读同一个视图。桌面那条链上没有任何一步把 Key 传给 UI，
// 而端侧的 agent 面本来就和 UI 同进程 —— 这是本次移植**唯一**一处必须由我们自己对凭据负责的地方，
// 所以这里的规则写死成一条：Key 只用来构造发往该 Provider base URL 的请求，绝不进 snapshot、
// 不进 row、不进日志，也不回给 UI 的任何其他面。
//
// 两类 Provider 的 Key 来源不同，必须分开处理：
//   - 个人 Key（用户自己填的免费额度）：`access.apiKey` 就在配置快照里，明文（上游本来也明文存
//     provider_config.json，且 serializeRegistryProviderConfig 不脱敏）。
//   - 账号型（登录换来的 Coding Plan）：快照里**没有** Key，`access.type === "zhipu-account"`，
//     真正的值是登录时按 `apiKey.secretKey` 复合形式现取、缓存在凭据层里的
//     （AccountProviderApiKeyResolver + accountProviderCredentialService）。桌面把它交给 CLI 前
//     也是在这一步现取（node.ts:1507），所以端侧取同一个函数，不自建第二套。
import type { ModelTarget } from "./model-stream.js";
// 只引类型的那一句在编译期就被擦掉，不进 bundle；这个联合是上游按它查表的，自己抄一份字面量迟早会漂。
import { normalizeProviderFamilyDomain, type ModelProviderFamilyId } from "@zcode/shared";

export type ModelApiFormat =
  | "anthropic-messages"
  | "openai-chat-completions"
  | "openai-responses";

export interface ModelSelectionValue {
  providerId: string;
  modelId: string;
  options?: { reasoningLevel?: string };
}

/** modelSelection.getView() 里我们要读的那几个键（按结构写，不把上游类型拖进端侧编译面）。 */
interface ProviderConfigLike {
  api?: { type?: string; baseUrl?: string; headers?: Record<string, string> };
  access?: { type?: string; apiKey?: string; accountType?: string; entitled?: boolean };
  enabled?: boolean;
}

interface ProviderViewLike {
  providerId: string;
  config?: ProviderConfigLike;
  models?: Array<{
    modelId?: string;
    /** 模型级配置（桌面 RegistryModelConfigObject 的结构子集）：思考档位与输出上限在这里。 */
    config?: {
      optionSpecs?: {
        reasoningLevel?: { values?: unknown; map?: unknown };
        maxOutputTokens?: { max?: unknown };
      };
    };
  }>;
}

interface SelectionViewLike {
  providers?: readonly ProviderViewLike[];
  preferredSelection?: ModelSelectionValue | null;
}

export interface ResolvedModelTarget extends ModelTarget {
  providerId: string;
  /** 配置里的 access.type；报告要用它区分"个人 Key"和"账号套餐"。 */
  accessType: string;
}

export class ProviderTargetError extends Error {
  constructor(readonly reasonCode: string, message: string) {
    super(message);
    this.name = "ProviderTargetError";
  }
}

export interface ModelTargetResolver {
  view: () => Promise<SelectionViewLike>;
  /**
   * 账号型 Provider 的 Coding Plan Key。`family` 的类型是 ModelProviderFamilyId 而不是 string：
   * 配置里的 `access.accountType` 是自由文本，收成联合这一步在 resolveModelTarget 里做，
   * 收成不了就直接报错给屏幕（一个填错的 accountType 不该退化成"这个 Provider 没有可用 Key"）。
   */
  codingPlanApiKey?: (input: {
    providerId: string;
    family: ModelProviderFamilyId;
    forceRefresh: boolean;
  }) => Promise<string | null>;
}

const KNOWN_FORMATS: readonly ModelApiFormat[] = [
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
];

/**
 * 这个视图里"能真跑"这件事不是靠某个布尔位表达的：**能出现在 view.providers 里就是事实**。
 * Registry 只收录 providerIssues 为空、且至少有一个 executable 模型的 Provider
 * （resolver.ts:309-324），模型清单本身也已经按 `model.executable` 过滤过一遍。
 *
 * 之前这里写的是 `p.executable === true` —— `ModelSelectionProviderView` 上没有这个字段
 * （facades.ts:188-195 只有 providerId / providerName / templateId / config / models；
 * `executable` 是另一张视图 `ProviderSettingsProviderView` 的字段，facades.ts:157）。
 * 于是这个 filter 恒为空，每一轮都在起跑线上判"Provider 不在可执行列表里"，
 * 而屏幕上那条红字看起来像是配置没填全。
 */
function executableProviders(view: SelectionViewLike): ProviderViewLike[] {
  return (view.providers ?? []).filter((p) => Boolean(p.config?.api?.baseUrl));
}

export async function resolveDefaultSelection(
  resolver: ModelTargetResolver,
): Promise<ModelSelectionValue | null> {
  const view = await resolver.view();
  const preferred = view.preferredSelection;
  if (preferred?.providerId && preferred.modelId) return preferred;
  const first = executableProviders(view)[0];
  const modelId = first?.models?.[0]?.modelId;
  if (first?.providerId && modelId) return { providerId: first.providerId, modelId };
  return null;
}

/** 供 snapshot.config 用：这个模型声明的思考档位（view 的 optionSpecs.reasoningLevel.values，
 *  与桌面 composer 选择器同一数据源——不是自己编一份默认列表）。 */
export async function resolveThoughtLevels(
  resolver: ModelTargetResolver,
  providerId: string,
  modelId: string,
): Promise<string[]> {
  const view = await resolver.view();
  const provider = (view.providers ?? []).find((p) => p.providerId === providerId);
  const model = provider?.models?.find((m) => m.modelId === modelId);
  const spec = (
    model?.config as
      | { optionSpecs?: { reasoningLevel?: { values?: unknown } } }
      | undefined
  )?.optionSpecs?.reasoningLevel;
  return Array.isArray(spec?.values) ? spec.values.filter((l): l is string => typeof l === "string") : [];
}

export async function resolveModelTarget(
  resolver: ModelTargetResolver,
  selection: ModelSelectionValue,
): Promise<ResolvedModelTarget> {
  const view = await resolver.view();
  const provider = executableProviders(view).find(
    (p) => p.providerId === selection.providerId,
  );
  if (!provider) {
    throw new ProviderTargetError(
      "provider.notExecutable",
      `Provider「${selection.providerId}」不在可执行列表里（配置不全或没有可用凭据）`,
    );
  }
  const api = provider.config?.api ?? {};
  const access = provider.config?.access ?? {};
  const apiFormat = api.type as ModelApiFormat | undefined;
  if (!apiFormat || !KNOWN_FORMATS.includes(apiFormat)) {
    throw new ProviderTargetError(
      "provider.unknownApiFormat",
      `端侧还不认识这种 Provider 协议：${String(api.type)}`,
    );
  }
  if (!provider.models?.some((m) => m.modelId === selection.modelId)) {
    throw new ProviderTargetError(
      "provider.modelUnknown",
      `模型「${selection.modelId}」不在 Provider「${selection.providerId}」的清单里`,
    );
  }
  // 思考档位 + 输出上限（0.5.1）：与桌面同一数据源（view 的 model.config.optionSpecs）。
  // level 来自用户选择（selection.options.reasoningLevel），values/max 来自模型声明——
  // 两边在 buildRequest 汇合：声明了而选择不在列内就不发，宁可档位不生效也不发 400 字段。
  const selectedModel = provider.models?.find((m) => m.modelId === selection.modelId);
  const optionSpecs = selectedModel?.config?.optionSpecs;
  const reasoningValues = Array.isArray(optionSpecs?.reasoningLevel?.values)
    ? (optionSpecs.reasoningLevel.values as unknown[]).filter(
        (l): l is string => typeof l === "string",
      )
    : undefined;
  const maxOutputTokensCap =
    typeof optionSpecs?.maxOutputTokens?.max === "number" && optionSpecs.maxOutputTokens.max > 0
      ? optionSpecs.maxOutputTokens.max
      : undefined;
  const reasoningLevel =
    typeof selection.options?.reasoningLevel === "string" && selection.options.reasoningLevel.trim()
      ? selection.options.reasoningLevel.trim()
      : undefined;

  let apiKey = typeof access.apiKey === "string" && access.apiKey.trim() ? access.apiKey.trim() : "";
  if (access.type === "zhipu-account" || !apiKey) {
    // 账号型没有存好的 Key；按桌面同一口径现取（缓存命中就不发网络请求）。
    // 配置里的 accountType 是自由文本，上游查表用的是 "zai" | "bigmodel" 这个联合。
    // 用上游自己的 normalizeProviderFamilyDomain 收成联合（不是在这里再抄一份字面量），
    // 收不成就是配置写错了——单独报出来，不并入下面那句"没有可用的 API Key"：
    // 后者会把"填错一个字母"读成"这个 Provider 没配 Key"，于是设置页怎么改都对不上。
    const family = normalizeProviderFamilyDomain(access.accountType);
    if (!family && access.accountType) {
      throw new ProviderTargetError(
        "provider.accountTypeUnknown",
        `账号型 Provider 的 accountType「${String(access.accountType)}」不是端侧认识的账号族（zai / bigmodel）`,
      );
    }
    if (!family || !resolver.codingPlanApiKey) {
      throw new ProviderTargetError(
        "provider.accountCredentialMissing",
        access.type === "zhipu-account"
          ? "账号型 Provider 需要登录后的 Coding Plan 凭据，当前取不到（登录态可能已失效）"
          : "这个 Provider 没有可用的 API Key",
      );
    }
    const minted = await resolver.codingPlanApiKey({
      providerId: selection.providerId,
      family,
      forceRefresh: false,
    });
    if (!minted) {
      throw new ProviderTargetError(
        "provider.accountCredentialMissing",
        "登录后的 Coding Plan 凭据取不到（套餐未连接或登录态已过期，请重新登录）",
      );
    }
    apiKey = minted;
  }

  return {
    providerId: selection.providerId,
    accessType: String(access.type ?? "unknown"),
    apiFormat,
    baseUrl: String(api.baseUrl),
    apiKey,
    ...(api.headers ? { headers: api.headers } : {}),
    model: selection.modelId,
    // 思考档位链（0.5.1）：用户选的档位 + 模型声明的合法档位 + 单轮输出上限，全在 target 上，
    // streamModelCompletion 的 buildRequest 按它们拼请求体；没选档位时这三个键缺席，请求体不变。
    ...(reasoningLevel ? { reasoningLevel } : {}),
    ...(reasoningValues ? { reasoningValues } : {}),
    ...(maxOutputTokensCap ? { maxOutputTokensCap } : {}),
  };
}
