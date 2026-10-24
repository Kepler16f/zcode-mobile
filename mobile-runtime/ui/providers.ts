// 端侧 Provider / 模型选择：直接复用上游的 ProviderRuntime，不自己拼一份模型清单。
//
// 为什么这条能原样搬：`model-provider/providerFacadeServices.ts` 只是 facade 的薄封装，
// 而 facade 由 `providerRuntime.ts` 用 `@zcode/provider-node` 的文件仓库 + Registry 组出来；
// 闭包实测 299 模块、0 个缺失 node 垫片（probe-ui-closure.mjs svc:model-provider/providerFacadeServices.ts），
// 唯一卡点是 provider-node 里的 `fs.watch`（跨进程一致性），端侧传 watch:false 绕过。
//
// 账号来源边界：`createProviderRuntime` 不给 accountSource 时用的是 `EmptyAccountProviderConfigSource`
// （providerRuntime.ts:50），它按当前 Built-in revision 生成 access.entitled=false 的 Overlay，
// 也就是**账号型 Provider 一律 fail-closed**。这是"没有登录态"时的正确默认，绝不能让它变成
// "登录了还是 fail-closed"——所以 ui/services.ts 在 Keystore 凭据桥在场时，把上游那套
// accountSource（ui/account.ts）装进来；桥不在（桌面跑开发自检）就继续 fail-closed，
// 而不是给个能收 token 却存不下的登录面。个人 API Key（自己的免费额度）走 personalFilePath，
// 与登录无关、端侧一直可用。全程符合"只用官方 OAuth / 自己的额度、不碰反向代理"。
import { materializeZCodeBuiltinProviderConfig, NodeModelSelectionConfigRepository } from "@zcode/provider-node";
import { createProviderConfigRuntime } from "@zcode/services/deep/model-provider/providerConfigRuntime.js";
import { createProviderRuntimeFromConfigRuntime } from "@zcode/services/deep/model-provider/providerRuntime.js";
// accountSource / testConnectivity 这两格的类型直接取消费方那一份声明（providerRuntime.ts:33-36），
// 不写 unknown 再 as never：上一版就是这么写的，tsc 一跑就是 TS2345 "accountSource: unknown
// 不能赋给 RefreshableProviderSource<AccountProviderConfigSnapshot>"。
import type { ProviderRuntimeDependencies } from "@zcode/services/deep/model-provider/providerRuntime.js";
import { getAppConfigDir } from "@zcode/services/deep/paths.js";

// 随包基线：构建时把仓库里的 config/provider/zcode-builtin.json 嵌进来，
// 与上游 server 的 tsup define 同一个符号、同一份内容（packages/server/tsup.config.ts:23）。
// 不嵌的话首屏只能等远端 CDN——而远端刷新是后台自动行为，按既定规则必须先是可关的，所以这一版不做。
declare const __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: string | undefined;

export function bundledZCodeBuiltinProviderConfig(): string {
  if (typeof __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__ !== "string") {
    throw new Error("端侧构建没有嵌入 ZCode Built-in Provider Config（见 bundle-ui.mjs 的 define）");
  }
  return __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__;
}

export async function createMobileProviderRuntime(options: {
  /**
   * 账号来源要在 configRuntime 之后、ProviderRuntime 之前造（上游 node.ts:1562 也是这个顺序：
   * accountSource 要吃 configService 的快照，而 ProviderRuntime 要把 accountSource 装进 Registry）。
   * 不给就是 fail-closed：账号型 provider 可见但不可用。
   *
   * 返回的是 `{ accountSource }` 而不是 accountSource 本身：造它的调用方（ui/services.ts）还要拿走
   * 同一次构造里的 Coding Plan 凭据解析器给 agent 面用。让这个函数只返回一个值，那条通路就得再造一遍。
   */
  buildAccountSource?: (
    configService: unknown,
  ) => { accountSource: NonNullable<ProviderRuntimeDependencies["accountSource"]> } | undefined;
  /**
   * 设置页每行模型上的"测试"按钮读的就是这一格（上游 providerRuntime.ts:107 把它交给
   * createProviderSettingsService）。不传的后果不是"按钮没了"：providerFacadeServices.ts:170-171
   * 会抛"当前 Environment 未装配模型连通性测试能力"，用户点下去看到的是一句像端侧坏了的话。
   */
  testConnectivity?: ProviderRuntimeDependencies["testConnectivity"];
} = {}) {
  const zcodeBuiltinFilePath = await materializeZCodeBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: bundledZCodeBuiltinProviderConfig(),
  });
  const configRuntime = createProviderConfigRuntime({
    zcodeBuiltinFilePath,
    watch: false,
    // 个人配置轮询在桌面上是为了发现"另一个进程改了同一个文件"；端侧只有这一个运行时，
    // 改配置的路径全在本进程内，留下定时器就是白烧电。
    personalPollingIntervalMs: false,
  });
  const account = options.buildAccountSource?.(configRuntime.configService);
  // 模型选择的"默认模型"配置源原来由 createProviderRuntime 内部顺手建；这里改用
  // createProviderRuntimeFromConfigRuntime 手动装配，就得把它补回来，否则默认模型会丢。
  const modelSelectionConfiguredDefaultSource = new NodeModelSelectionConfigRepository({
    personalRepository: configRuntime.personalRepository,
  });
  return createProviderRuntimeFromConfigRuntime({
    configRuntime,
    ...(account ? { accountSource: account.accountSource } : {}),
    ...(options.testConnectivity ? { testConnectivity: options.testConnectivity } : {}),
    modelSelectionConfiguredDefaultSource,
    disposeModelSelectionConfiguredDefaultSource: () =>
      modelSelectionConfiguredDefaultSource.dispose(),
  });
}
