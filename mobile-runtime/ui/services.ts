// 端侧服务组合根：把上游 services 层里"闭包干净"的那部分原样搬进 WebView，其余明确留空。
//
// 三条实测依据（数字来自 mobile-runtime/build/probe-ui-closure.mjs，见 PORTING §1.5.13）：
//   1. `@zcode/services` 根入口 403 模块 / 1.27 MB / 0 个缺失垫片 —— 标识符与 descriptor 全部可用，
//      所以下面的 channel 名一律用上游的，不自造（自造就会重演 0.0.2 的 from/path 跨语言漂移）。
//   2. 单个工厂能不能搬，看它自己的闭包：setting/file/task/session/mcp-sync/hooks/... 都是 0 缺失垫片，
//      而 credential（同步 AES-GCM）、terminal（node-pty）、git（child_process）、bots（飞书 SDK）不是。
//   3. `createZCodeAgentService` 根本没有传输层接缝（内部硬建三个 ZCodeAgentProcessManager 走 stdio 子进程），
//      所以端侧 Agent 要另写一条 runtime 内的执行路径，不能靠注入这个工厂。
//
// 深引实现文件是上游自己的惯例（services/src/index.ts:88 写明根入口故意不导工厂，免得把 Node 依赖拖进浏览器包），
// `@zcode/services/deep/<相对 src 的路径>` 由 build/bundle-ui.mjs 映射到真实文件。
import {
  ServiceCollection,
  IBroadcastService,
  ICommandsService,
  ICredentialService,
  IFileService,
  IHooksService,
  IMcpSyncService,
  IMemoryService,
  IModelSelectionService,
  IOnboardingRecordService,
  IOAuthService,
  IPluginManagementService,
  IPluginsService,
  IPromptAttachmentTransferService,
  IProviderSettingsService,
  ISettingService,
  IZCodeAgentService,
  ISettingsSyncService,
  ISkillsService,
  ISubagentsService,
  IMediaPreviewService,
  ISystemService,
  IWindowControllerService,
  IZCodeSessionService,
  IZCodeTaskService,
  ICodingPlanSubscriptionService,
  IUsageStatsService,
  IClientConfigService,
  IClientScenesService,
  IFileWatcherService,
} from "@zcode/services";
import { ZCODE_VERSION, buildRuntimeZCodeEndpointUrls } from "@zcode/shared";
import { createClientConfigService } from "@zcode/services/deep/client-config/clientConfigService.js";
import { createClientScenesService } from "@zcode/services/deep/client-scenes/clientScenesService.js";
import { createQueuePair, ChannelServer } from "@zcode/rpc";

import { createSettingServiceWithMigrations } from "@zcode/services/deep/setting/settingService.js";
import { createObservableSettingService } from "@zcode/services/deep/setting/observableSettingService.js";
import { createBroadcastService } from "@zcode/services/deep/broadcast/broadcastService.js";
import { createFileService } from "@zcode/services/deep/file/fileService.js";
import { createMediaPreviewService } from "@zcode/services/deep/media-preview/mediaPreview.js";
import { createCommandsService } from "@zcode/services/deep/commands/commandsService.js";
import { createMemoryService } from "@zcode/services/deep/memory/memoryService.js";
import { createSettingsSyncService } from "@zcode/services/deep/settings-sync/settingsSyncService.js";
import { createPluginsService } from "@zcode/services/deep/plugins/pluginsService.js";
import { createPluginManagementService } from "@zcode/services/deep/plugins/pluginManagementService.js";
import { createHooksService } from "@zcode/services/deep/hooks/hooksService.js";
import { createMcpSyncService } from "@zcode/services/deep/mcp-sync/mcpSyncService.js";
import { createLocalPromptAttachmentTransferService } from "@zcode/services/deep/prompt-attachment-transfer/promptAttachmentTransferService.js";
import { createOnboardingRecordService } from "@zcode/services/deep/onboarding/onboardingRecordService.js";
import { TaskIndexRepo } from "@zcode/services/deep/session/taskIndexRepo.js";
import { createZCodeTaskIndexSyncer } from "@zcode/services/deep/zcode-agent/zcodeTaskIndexSyncer.js";
import { createZCodeTaskServiceAdapter } from "@zcode/services/deep/zcode-agent/zcodeTaskServiceAdapter.js";
import { createZCodeSessionService } from "@zcode/services/deep/zcode-session/zcodeSessionService.js";
import { createCodingPlanSubscriptionService } from "@zcode/services/deep/coding-plan-subscription/codingPlanSubscriptionService.js";
import { IGitService } from "@zcode/services/deep/git/git.js";

import { configureSqlite, sqliteEngine } from "../compat/shims/sqlite.mjs";
import * as vfs from "../compat/vfs.mjs";
import { setDataBaseDir } from "@zcode/services/deep/paths.js";
import { createMobileProviderRuntime } from "./providers.js";
import { createMobileCredentialService, credentialEngine } from "./credentials.js";
import { createFetchApiClient, createMobileOAuthService, createTracedOAuthService } from "./oauth.js";
import { createQuotaApiClient } from "./quota-transport.js";
import { createMobileAccountSource, createMobileAccountRequestAuthService } from "./account.js";
import { createUsageStatsService } from "@zcode/services/deep/usage-stats/usageStatsService.js";
import { createMobileAgentService } from "./agent.js";
import { createMobileGitService } from "./git-service.js";
import { createMobileHooksService } from "./capability-services.js";
import { createSkillsService } from "@zcode/services/deep/skills/skillsService.js";
import { createSubagentsService } from "@zcode/services/deep/subagents/subagentsService.js";
import { createMobileSessionStore } from "./session-store.js";
import type { ModelTargetResolver } from "./provider-target.js";
import { createMobileConnectivityTester } from "./model-connectivity.js";
import { createMobileSystemService } from "./system.js";
import { createMobileUsageStatsService } from "./usage-stats.js";
import { createMobileMemoryContext } from "./memory-context.js";
import { createMobileFileWatcherService } from "./file-watcher.js";
import { desktopCompatibilityVersion } from "./server-compat.js";
import { createToolEngineFactory } from "./tool-engine.js";
import { createMobileMcpRuntime } from "./mcp-runtime.js";
import { localWorkspacePath } from "../compat/workspace-aliases.mjs";
import { createMobileWindowControllerService } from "./window-controller.js";
import { notSupportedDeferred, withUnsupportedFallback, unsupportedCalls } from "./stand-in.js";

export interface MobileRuntime {
  collection: ServiceCollection;
  /** 与 UI 之间那条内存 RPC 的两端；服务端在组合根里，客户端交给 RemoteServiceAccess。 */
  protocolPair: ReturnType<typeof createQueuePair>;
  /** 端侧此刻还没接的 channel 名，用于屏幕上的"能力清单"和自检报告。 */
  stubbed: string[];
  /** 表里有、但在端侧构造失败的服务与原因。要出现在启动屏上，不能只剩一句白屏。 */
  degraded: Array<{ name: string; error: string }>;
  /** 端侧 agent 报回来的每一轮结果。屏幕上已有时间线，这里给的是能被自检报告回收的那一份。 */
  agentLog: string[];
  fsEngine: string;
  /** 最近被调用过的未实现面（界面把失败吞掉时，这是唯一的线索）。 */
  unsupportedCalls: () => Array<{ face: string; count: number; at: number }>;
  /**
   * task-index 库里的行。为什么要暴露：侧栏那一行有两个可能的说谎地点 ——
   * "库里没有这行"（sessions-index 那条链没跑通）和"库里有、屏幕上没画"（Controller 读取口或
   * UI 重拉那一层）。只看屏幕分不开这两件事，而它们的修法完全不同。
   */
  taskRows: () => Promise<Array<{ taskId: string; title: string; status?: string; updatedAt: number }>>;
  sqliteEngine: string;
  /** 会话持久化的引擎；null = 没起来（对话只活在本进程，重启即失忆）。启动屏与自检报告都读它。 */
  sessionStoreEngine: string | null;
}

// sql.js 是内存库：byteStore 不落真盘的话，close() 之后什么都没剩下。
// 自检里用的是 Map 版（newMemoryByteStore），那对一次性探针没问题，
// 但 UI 的会话列表要跨启动存活，所以组合根必须给 vfs 版。
const vfsByteStore = {
  read: (p: string) => {
    try {
      return vfs.readFileSync(p);
    } catch {
      return null;
    }
  },
  write: (p: string, bytes: Uint8Array) => {
    vfs.writeFile(p, bytes, {}, "writeFile");
  },
};

/**
 * 端侧 SQLite 必须先异步加载引擎（node:sqlite 的构造函数是同步的，WASM 加载不是），
 * 所以组合根在装服务之前要先把它准备好。原生桥在时优先原生桥。
 */
async function prepareSqlite(initSqlJs?: (options: { locateFile: (f: string) => string }) => Promise<unknown>, wasmFile = "./sql-wasm.wasm") {
  if (sqliteEngine() === "native-android-sqlite") return;
  if (!initSqlJs) throw new Error("端侧没有 SQLite 引擎：原生桥不在，也没载入 sql-wasm.js");
  await configureSqlite({
    sqlJsFactory: initSqlJs as never,
    locateFile: () => wasmFile,
    byteStore: vfsByteStore,
    // 显式写 null = "不强制换引擎"。这条路径上面已经因为原生桥在而 return 过了，
    // 到这儿一定是 wasm；留这一格是给 compat/shims/sqlite.mjs 那个 prefer:"wasm" 诊断开关
    // 一个明确的默认值（selfcheck.mjs 复位引擎用的就是同一个 null），不靠参数缺省表达意图。
    prefer: null,
  });
}

export async function createMobileServices(options: {
  initSqlJs?: (o: { locateFile: (f: string) => string }) => Promise<unknown>;
  wasmFile?: string;
  /** 写进模型请求的 metadata.user_id，与 UI 的流式 clientId 同源（设备指纹，不是账号身份）。 */
  deviceId?: string;
  /**
   * 只给本机验证用（build/chatdev-entry.ts）：把"选出来的模型落到哪儿"换成一个本地 mock 网关。
   * 出货路径永远不给这个值，端侧的落点仍由 ProviderRuntime + 凭据层决定；
   * 有了这个缝，浏览器里那条"发消息→流式回话"的链路能在不动任何真账号、不发任何真请求的前提下跑通。
   */
  agentModelTargets?: ModelTargetResolver;
  /** 走到哪一步了。屏幕上的启动进度与自检报告都靠它，不要拿 console 代替。 */
  onStep?: (step: string) => void;
} = {}): Promise<MobileRuntime> {
  const say = options.onStep ?? (() => {});
  // 上游所有数据路径都从 getDataBaseDir() 起（paths.ts:31：setDataBaseDir > env HOME > homedir()）。
  // 端侧的 homedir() 是垫片里的 "/root"，不改就全写到一个不存在的地方；"/work" 是 vfs 的根，
  // 也和自检 harness 用的 /work/.zcode 对齐（build/m1-run.mjs:264）。
  setDataBaseDir("/work");
  say("vfs");
  const fsReady = vfs.ensureReady();
  say(`sqlite`);
  await prepareSqlite(options.initSqlJs, options.wasmFile);


  // 任务/会话/MCP/插件管理这几个工厂在构造时只订阅、不调用，所以给它们一个替身（stand-in.ts）。
  //
  // 为什么这些适配器拿的还是替身、而 RPC 通道拿真 agent（见下面 table 的
  // providerRuntime 分组）：端侧 agent 此刻只实现了 v4 对话那一面，其余命令会回一条
  // `EUNSUPPORTED(mobile:zcodeAgentService.…)`，而"抛一次异步错误"与"在适配器构造期就把整条链带崩"
  // 是两件事。P0 只要对话能跑，把没有实现的面留在原来的明确报错上，
  // 比让它半死不活更容易在报告里点名。
  const agent = notSupportedDeferred<never>("zcodeAgentService");
  const cuaResolver = notSupportedDeferred<never>("cuaProductMcpServerResolver", "端侧没有 CUA 助手");

  const localSettings = createSettingServiceWithMigrations();
  const settingService = createObservableSettingService(localSettings.service);
  const taskIndexRepo = new TaskIndexRepo();
  // 同步器挪到真 agent 建好之后再造（见下面 taskIndexSyncer）：给它这个替身就等于
  // "发完一句、右侧列表里没有这条会话"——它读不到 readSession，那一行就永远写不进 task-index，
  // 而失败被 syncer 自己 catch 成一行 logger.warn，屏幕上一点痕迹都没有。
  const fileService = createFileService({});

  const degraded: Array<{ name: string; error: string }> = [];

  // agentLog / trace 必须在任何"要进启动屏与自检报告"的读数之前声明。
  // 之前它建在 providerRuntime 附近，结果 task-index 探测只能走 say()（启动屏瞬时文字，装机后读不回）；
  // 提到最前面，成功与失败都进 agentLog，下一次装机报告能直接回答"侧栏空是不是写库失败"。
  const agentLog: string[] = [];
  const trace = (message: string) => {
    agentLog.push(message);
    if (agentLog.length > 40) agentLog.splice(0, agentLog.length - 40);
  };

  // 主动探一次 task-index：桌面 e2e（sql.js）、真 node:sqlite 冒烟、真机 SQLite 桥自检三处各自都绿，
  // 但那条链的真机唯一变数是 TaskIndexRepo 的**迁移 + 读写走原生桥**——它要是 ensureReady() 抛错
  // （Android 框架 SQLite 的 FK/WAL/RETURNING 与 sql.js 语义有出入），同步器只会把错误 catch 成一行
  // logger.warn，屏幕上什么都看不到，表现恰是用户报的"侧栏永远空"。这里在启动时就把它逼出来：
  // 成功则留一条 ready 读数进启动屏，失败则进 degraded，让下一次装机报告直接回答"断没断在写库这步"。
  // 这条探测与后面的 provider 运行时互不依赖（一个动 SQLite，一个读配置与凭据），
  // 串行等就是两段首屏时间白扔。这里改成并行启动、装配结束前再统一等结果。
  const taskIndexReady = (async () => {
    try {
      await taskIndexRepo.ensureReady();
      const readyLine = `task-index 就绪（引擎=${sqliteEngine()}）`;
      trace(readyLine);
    } catch (e) {
      const error = String((e as Error)?.message ?? e);
      trace(`task-index 初始化失败：${error}`);
      degraded.push({
        name: "taskIndexRepo",
        error: `侧栏读写的 task-index 建不起来，对话记录进不了列表：${error}`,
      });
    }
  })();

  // 顺序是"凭据 → accountSource → ProviderRuntime"：accountSource 要吃 configService 的快照，
  // 而 ProviderRuntime 要把 accountSource 装进 Registry（上游 node.ts:1562 也是这个先后）。
  // 凭据桥不在（桌面跑开发自检时就没有 Keystore），就把 credentialService/oauthService 两面
  // 按"未接入"报出去，账号型 provider 继续 fail-closed —— 不给一个能收 token 却存不下的登录面。
  const credentialsAvailable = credentialEngine() !== null;
  if (!credentialsAvailable) {
    degraded.push(
      {
        name: "credentialService",
        error: "端侧外壳未提供凭据桥 zcodeCredentials（登录需要的 Keystore 加密存储）",
      },
      { name: "oauthService", error: "凭据桥缺失，登录态无处可存" },

    );
  }
  const credentialService = credentialsAvailable ? createMobileCredentialService() : null;
  const apiClient = createFetchApiClient();

  // 服务端 entitlement（0.7.3，用户报"体验套餐仍然无法查看、活动领取界面也看不到"）。
  // App Usage 屏继续读本机 sessionStore 聚合；但套餐额度、体验套餐预览、活动领取/重置机会
  // 要读 Z.ai/BigModel 的配额接口——上游那份 createUsageStatsService（BigModelUsageQuotaProvider）
  // 按 accountRequestAuthService 现取请求凭据，端侧原样接上，只在本地 facade 里把这几面委托过去。
  // credentialService 不在（没有 Keystore 桥的开发自检）就不建：那种机器上 entitlement 本该如实
  // 回"未配置"，硬接会把"没有凭据桥"错报成"没有套餐"。
  let usageEntitlementUpstream: ReturnType<typeof createUsageStatsService> | null = null;
  if (credentialService) {
    try {
      const quotaApiClient = createQuotaApiClient();
      usageEntitlementUpstream = createUsageStatsService({
        apiClient: quotaApiClient as never,
        accountRequestAuthService: createMobileAccountRequestAuthService({
          credentialService,
          settingService,
          apiClient: quotaApiClient,
        }),
        credentialService,
        // 只为满足形状：getAppUsageSnapshot 由端侧本地聚合实现，上游这一格永远不会被调到；
        // 真被调到时抛具体原因，而不是回一份假数据。
        zcodeAgentService: {
          getAppUsageStats: async () => {
            throw new Error("端侧 App Usage 走 sessionStore 本地聚合，不经 agent 数据库");
          },
        } as never,
      });
      say("entitlement 服务就绪（体验套餐/编程套餐读真配额接口）");
    } catch (e) {
      const error = String((e as Error)?.message ?? e);
      say(`entitlement 服务装配失败（套餐屏回未配置）：${error}`);
      trace(`entitlement 服务装配失败：${error}`);
    }
  }

  // ProviderRuntime 起不来的时候（随包配置没嵌进去、物化写不进盘）只降级掉依赖它的三个面
  // ——模型设置、模型选择、对话，不连带打死整个组合根：首屏仍然要能出现，
  // 屏幕上要写的是"哪一面没了、为什么"。
  say("provider 运行时");
  let providerRuntime: Awaited<ReturnType<typeof createMobileProviderRuntime>> | null = null;
  // accountSource 与"Coding Plan 凭据解析器"必须来自同一次构造：桌面也是在这一层把
  // apiKey.secretKey 取出来再交给执行侧（node.ts:1507），端侧没有子进程，agent 面直接调同一个函数。
  // 分成两次构造就会有两份缓存，表现是"模型列表里有，一发对话就说凭据不可用"。
  let codingPlanApiKey:
    | Awaited<ReturnType<typeof createMobileAccountSource>>["resolveCodingPlanApiKey"]
    | null = null;
  // 端侧 agent 面和"测试连接"共用这一条日志（agentLog 已在上面 task-index 探测之前声明）。

  // 对话与"测试连接"必须解析到**同一个**落点（同一份 modelSelection 视图、同一个 Coding Plan
  // 凭据缓存）。分成两份就是两条真相：表现为"测试说通，一发对话就说凭据不可用"。
  // 这里的 view 是懒的——providerRuntime 在下一段才赋值，而它只在用户点按钮/发消息时被读。
  const modelTargets: ModelTargetResolver = options.agentModelTargets ?? {
    view: async () => (await providerRuntime!.modelSelection.getView()) as never,
    // 同样必须懒读：codingPlanApiKey 要到 createMobileProviderRuntime 里那次
    // buildAccountSource 回调跑完才有值，而这一段在它之前。写成品值就是永远 undefined，
    // 表现为"账号型 Provider（登录换来的 Coding Plan）在模型列表里看得见、一发对话就说取不到凭据"。
    codingPlanApiKey: (input) =>
      codingPlanApiKey === null
        ? Promise.reject(new Error("账号凭据解析器还没装配完成（Provider 运行时未启动）"))
        : codingPlanApiKey(input),
  };
  const connectivityTester = createMobileConnectivityTester({
    resolver: modelTargets,
    onDiagnostic: trace,
  });
  try {
    providerRuntime = await createMobileProviderRuntime({
      ...(credentialService
        ? {
            buildAccountSource: (configService: unknown) => {
              const created = createMobileAccountSource({
                credentialService,
                settingService,
                apiClient,
                configSource: configService as never,
              });
              codingPlanApiKey = created.resolveCodingPlanApiKey;
              return created;
            },
          }
        : {}),
      // 上游缝：providerRuntime.ts:107 → createProviderSettingsService 的第三个参数。
      // 这里以前写 `connectivityTester as never`，而 §1.5.19 那次"Provider「undefined」"就错在这格上——
      // as never 把这一格的形状检查整个取消了，于是错到屏幕上才被发现。现在按消费方的类型传，
      // 形状对不对由 tsc（mobile-runtime/tsconfig.json）判。
      testConnectivity: connectivityTester,
    });
  } catch (e) {
    const error = String((e as Error)?.message ?? e);
    degraded.push({ name: "providerSettingsService", error }, { name: "modelSelectionService", error });
  }

  // 会话持久化：引擎就绪后建库（Android = SqliteBridge 真文件，桌面自检 = sql.js + vfs）。
  // 建不起来（引擎没配置、磁盘满）返回 null，agent 面退回纯内存并如实报"没有持久化"——
  // 侧栏历史与"重启后还原对话"这条产品路径就靠它，绝不能静默假装存下了。
  say("session-store");
  const sessionStore = createMobileSessionStore({ onDiagnostic: trace });
  // 并行那条到这里必须已经落地：后面的同步器要用 task-index 写库。
  await taskIndexReady;

  // 启动扫描全部历史会阻塞首屏；一次瞬时读取失败还会经 degraded→stubbed
  // 将已注册的统计服务永久替换为空面，刷新也无法恢复。统计按打开页面时读取，
  // 数据错误由页面呈现并允许重试，不把读取故障提升为服务装配失败。
  const usageReady = `用量统计就绪（按需读取；存储=${sessionStore?.engine() ?? "未启用"}）`;
  say(usageReady);
  trace(usageReady);

  // 端侧 agent 面：v4 对话协议 + 真模型流。providerRuntime 没起来就不建：那时模型落点解析不出来，
  // 注册一个空面只会让 UI 以为运行时在，然后每一轮都失败在离原因更远的地方。
  // 工具引擎（Phase 1 第 5 项）。工厂只建对象，core bundle 在首轮对话时才动态加载；
  // 加载失败/装配失败一律 engine=null → 请求体不带 tools、prompt 说"工具不可用"，
  // 与 0.4.2 行为逐字一致（地基冒烟钉过）。没有额外开关：null 回退本身就是安全网，
  // 而出包前这条循环必须先在 Node/浏览器端到端证明过（chat-smoke 的工具判据 + e2e）。
  // Bash 默认开（0.4.6）：0.4.5 的"输出过不了 BashOutputSchema 所以默认关"已被复现推翻——
  // 真凶是端侧 Android 桥硬编码的 signal:null（perf 遥测实测 parse 通过），桥侧折叠空值即治本。
  // 是否注册仍由执行桥在不在决定（tool-engine：bashEnabled && execBridge）：纯 WebView（鸿蒙一期、
  // 未接桥的桌面 harness）没有 zcodeExec ⇒ Bash 连声明都不声明，非 exec 档逐字不回归。
  const mcpConfigService = createMcpSyncService();
  const mcpRuntime = createMobileMcpRuntime({ loadServers: request => mcpConfigService.loadMcpFromUserDirectory(request) });
  const mcpService: IMcpSyncService = {
    ...mcpConfigService,
    listWorkspaceMcpServerStatuses: params => mcpRuntime.listStatuses(params),
    async saveMcpToUserDirectory(payload) {
      try { await mcpConfigService.saveMcpToUserDirectory(payload); }
      finally { mcpRuntime.invalidate(); }
    },
    async importMcpServers(params) {
      try { return await mcpConfigService.importMcpServers(params); }
      finally { mcpRuntime.invalidate(); }
    },
  };
  const baseToolEngine = createToolEngineFactory({ onDiagnostic: trace });
  // 设置页和运行时共用实例；端侧 /root 由持久化 VFS 承载用户级数据。
  const skillsService = createSkillsService({ isDesktopRuntime: true });
  const subagentsService = createSubagentsService({ isDesktopRuntime: true });
  const toolEngine: typeof baseToolEngine = async (path, sessionId, signal) => {
    path = localWorkspacePath(path);
    const base = await baseToolEngine(path, sessionId);
    return base ? mcpRuntime.wrap(base, path, sessionId, signal) : null;
  };
  const mobileAgent = providerRuntime
    ? withUnsupportedFallback(
        createMobileAgentService({
          modelTargets,
          deviceId: options.deviceId,
          onDiagnostic: trace,
          sessionStore,
          toolEngine,
          releaseWorkspaceTools: path => mcpRuntime.releaseWorkspace(localWorkspacePath(path)),
          releaseAllTools: () => mcpRuntime.invalidate(),
          capabilities: { skillsService, subagentsService },
          memoryContext: createMobileMemoryContext(settingService),
        }),
        "mobile:zcodeAgentService",
      )
    : null;
  if (!mobileAgent) {
    degraded.push({ name: "zcodeAgentService", error: "Provider 运行时没起来，端侧对话面不注册" });
  }

  // 任务索引同步器：这一条是"发完一句，右侧列表里出现这条会话"的唯一通路。
  // 它不订阅事件、也不自己造行，而是拿 agent 的 readSession 回源算标题/状态/用量
  // （zcodeTaskIndexSyncer.ts:501-531 → syncSnapshotAndBroadcast → buildMetaFromSnapshot），
  // 所以给它那个报 EUNSUPPORTED 的替身 = 这一行永远写不进 task-index。
  // 写完那一声 workspace_task_list_changed 由 windowControllerService 投成 Controller 帧，
  // 侧栏才会重拉（见 ui/window-controller.ts 顶部），这里不再额外插诊断代理。
  const taskIndexSyncer = createZCodeTaskIndexSyncer({
    agentService: (mobileAgent ?? agent) as never,
    taskIndexRepo,
  });

  // 给会话/任务适配器用的 agent 必须是**真 agent**，不能是上面那个替身。
  // 这两处不是"订阅一下就完事"的工厂：它们把 agent 的方法原样转发给 UI，
  // 而 UI 的草稿目录水合（workspacePrepareRpc.ts:28）读的正是 `readWorkspacePresentation`。
  // 让它们拿替身 = 明明白白告诉 UI "端侧没有这个面"，于是 configOptionsStatus 落成 "error"，
  // V4ComposerToolbar.tsx:845 从此拒绝选模型，屏幕上只剩下一个永远灰着的发送键。
  // ProviderRuntime 没起来时仍回替身：那条路径上根本没有对话面可给。
  const agentForAdapters = (mobileAgent ?? agent) as never;

  // 一张表而不是链式 register：某个服务在端侧构造不出来时，要能点名是它、并让它自己变成
  // "调用即抛错"的面，而不是整个组合根起不来、屏幕上什么都不出现。
  // 每一个 make() 都必须在闭包里惰性拿 agent —— 上游那些适配器构造时只订阅、不调用。
  const table: Array<{ name: string; descriptor: { channelName: string }; make: () => unknown }> = [
    { name: "settingService", descriptor: ISettingService, make: () => settingService },
    { name: "broadcastService", descriptor: IBroadcastService, make: () => createBroadcastService(null) },
    // fileService 只建一次：mediaPreviewService 是它的薄工厂（stat + readMediaPreview），
    // 两个实例会在 vfs 上各走各的缓存，预览与文件工具看到的就不是同一棵树。
    { name: "fileService", descriptor: IFileService, make: () => fileService },
    { name: "systemService", descriptor: ISystemService, make: () => createMobileSystemService() },
    // 用量统计（Phase 1 启用，之前一直在 stubbed 名单）：App Usage 面板读 getAppUsageSnapshot，
    // 这里跨 workspace 把 session-store 的真实轮次用量（turnUsage/cumulative/rows/config）聚合回
    // UI 的形状；端侧没有的服务端面（Coding Plan monitor/reset/entitlement 配额）如实报不可用，
    // 不编数。sessionStore 没起来时返回空快照而不是崩——用量屏不该被持久化就绪状态带崩。
    {
      name: "usageStatsService",
      descriptor: IUsageStatsService,
      make: () =>
        createMobileUsageStatsService({
          sessionStore,
          onDiagnostic: trace,
          ...(usageEntitlementUpstream
            ? {
                upstream: {
                  getEntitlementSnapshot: usageEntitlementUpstream.getEntitlementSnapshot,
                  getCodingPlanUsageSnapshot: usageEntitlementUpstream.getCodingPlanUsageSnapshot,
                  getCodingPlanResetStatus: usageEntitlementUpstream.getCodingPlanResetStatus,
                  requestCodingPlanResetOpportunity:
                    usageEntitlementUpstream.requestCodingPlanResetOpportunity,
                  useCodingPlanReset: usageEntitlementUpstream.useCodingPlanReset,
                  markCodingPlanResetHistoryRead: usageEntitlementUpstream.markCodingPlanResetHistoryRead,
                },
              }
            : {}),
        }),
    },
    // 预览面：≤8 MB 的图片/音视频按 base64 内联（vfs 读出来就有），更大的显式报"太大"。
    // 桌面那条 local-url 分支需要 HTTP 服务，端侧没有，所以不传那两个可选回调 —— 不是漏接。
    { name: "mediaPreviewService", descriptor: IMediaPreviewService, make: () => createMediaPreviewService({ fileService }) },
    {
      name: "windowControllerService",
      descriptor: IWindowControllerService,
      // 接了两件事：listTaskList 读取口 + Controller 那两个 topic 的实时帧（tasks-index / workspaces）。
      // 后者是"库里有了、屏上没有"的真正答案：侧栏的重查触发只看 registry 的 revision
      // （windowControllerTaskListRegistry.ts:124-185 → useGlobalTaskList.ts:193-202），
      // 不推帧就永远不会再读一次 sqlite。置顶/归档/删除仍然报 EUNSUPPORTED —— 端侧真的没有。
      make: () =>
        withUnsupportedFallback(
          createMobileWindowControllerService({
            taskIndexRepo,
            taskIndexSyncer,
            onDiagnostic: trace,
            isSessionRunning: id => mobileAgent?.isSessionRunning(id) === true,
            // 实时会话摘要：侧栏的「等待确认」与转圈都从这份投影来（桌面 windowHostControllerService 同款）。
            sessionSummaries: workspacePath => mobileAgent?.liveSessionSummaries(workspacePath) ?? [],
          }),
          "mobile:windowControllerService",
          "端侧接了列表读取口与 tasks-index/workspaces 实时帧，列表组织操作（置顶/归档/删除）没有",
        ),
    },
    { name: "skillsService", descriptor: ISkillsService, make: () => skillsService },
    {
      // 文件监视（0.9.3）：桌面用 fs.watch，Android 没有 inotify，改用有上限的轮询签名。
      // 工作区文件树与 Git 面板的自动刷新都走这一面；页面不可见时自动停摆。
      name: "fileWatcherService",
      descriptor: IFileWatcherService,
      make: () => createMobileFileWatcherService({ onDiagnostic: trace }),
    },
    { name: "subagentsService", descriptor: ISubagentsService, make: () => subagentsService },
    { name: "commandsService", descriptor: ICommandsService, make: () => createCommandsService({ isDesktopRuntime: false }) },
    { name: "memoryService", descriptor: IMemoryService, make: () => createMemoryService() },
    { name: "clientConfigService", descriptor: IClientConfigService, make: () => createClientConfigService({
      apiClient: apiClient as never,
      resolveRequestContext: () => ({endpointOrigin:buildRuntimeZCodeEndpointUrls({}).origin,
        appVersion:desktopCompatibilityVersion(ZCODE_VERSION), platform:"linux-arm64"}),
    }) },
    { name: "clientScenesService", descriptor: IClientScenesService, make: () => createClientScenesService({apiClient:apiClient as never}) },
    { name: "settingsSyncService", descriptor: ISettingsSyncService, make: () => createSettingsSyncService({ settingService }) },
    { name: "pluginsService", descriptor: IPluginsService, make: () => createPluginsService({ isDesktopRuntime: false }) },
    {
      name: "pluginManagementService",
      descriptor: IPluginManagementService,
      // 0.7.1：必须给**真 agent**（端侧插件面实现在 agent 服务上），不能再给替身——
      // 替身会把 `EUNSUPPORTED(zcodeAgentService): listPlugins —— 端侧 Agent 运行时尚未接入`
      // 直接顶到「浏览器控制」/「钩子」两屏上（装机报的就是这句）。
      make: () => createPluginManagementService({ zcodeAgentService: agentForAdapters as never }),
    },
    {
      name: "mcpSyncService",
      descriptor: IMcpSyncService,
      make: () => mcpService,
    },
    {
      name: "hooksService",
      descriptor: IHooksService,
      make: () => {
        const ports = agentForAdapters as NonNullable<Parameters<typeof createHooksService>[0]>;
        return createMobileHooksService(createHooksService({ grantWorkspaceHookTrust: ports.grantWorkspaceHookTrust }),
          () => typeof (globalThis as { zcodeExec?: { exec?: unknown } }).zcodeExec?.exec === "function");
      },
    },
    { name: "promptAttachmentTransferService", descriptor: IPromptAttachmentTransferService, make: () => createLocalPromptAttachmentTransferService() },
    {
      name: "onboardingRecordService",
      descriptor: IOnboardingRecordService,
      make: () => createOnboardingRecordService({
        // 端侧此刻没有登录身份（M6 才接 Keystore/OAuth 凭据层），所以恒为 null：
        // 引导记录是纯本地、纯匿名的文件，不存在"把设备指纹关联到某个账号"的通路。
        loadUserId: async () => null,
        hasExistingLocalTask: async () => (await taskIndexRepo.listTaskMetas({})).length > 0,
      }),
    },
    ...(providerRuntime
      ? [
          { name: "providerSettingsService", descriptor: IProviderSettingsService, make: () => providerRuntime!.providerSettings },
          { name: "modelSelectionService", descriptor: IModelSelectionService, make: () => providerRuntime!.modelSelection },
          // 对话面：UI 那侧的 agent 传输只认这一条 channel，注册它 = 手机上的时间线真的有内容进来。
          { name: "zcodeAgentService", descriptor: IZCodeAgentService, make: () => mobileAgent! },
        ]
      : []),
    ...(credentialService
      ? [
          { name: "credentialService", descriptor: ICredentialService, make: () => credentialService },
          { name: "oauthService", descriptor: IOAuthService, make: () => createTracedOAuthService(createMobileOAuthService(credentialService)) },
        ]
      : []),
    // 体验套餐（StartPlanCard/套餐列表）：只读公开的 client/configs，apiClient 用 fetch 版。
    // 闭包实测 279 模块 / 1.20 MB / 0 缺失垫片（probe-ui-closure）；resolveOffPeakModelSelectionView
    // 只有 getOffPeakClientConfig 会用，端侧 P0 没有闲时任务面，不给即 undefined——不拖 providerRuntime 进来。
    // 凭据桥不在时用只读替身：预览能读，购买/余额类接口拿不到 token 就如实报错，不假装有权益。
    {
      name: "codingPlanSubscriptionService",
      descriptor: ICodingPlanSubscriptionService,
      make: () =>
        createCodingPlanSubscriptionService({
          apiClient,
          credentialService: credentialService ?? { load: async () => null },
        }),
    },
    {
      name: "zcodeTaskService",
      descriptor: IZCodeTaskService,
      make: () => createZCodeTaskServiceAdapter({
        zcodeAgentService: agentForAdapters,
        taskIndexRepo,
        taskIndexSyncer,
        settingService,
        cuaProductMcpServerResolver: cuaResolver as never,
      }),
    },
    // 面板与 Agent 使用同一份 isomorphic-git / VFS；未接入的操作明确返回不可用。
    {
      name: "gitService",
      descriptor: IGitService,
      make: () => createMobileGitService(),
    },
    {
      name: "zcodeSessionService",
      descriptor: IZCodeSessionService,
      make: () => createZCodeSessionService({
        agentService: agentForAdapters,
        taskIndexSyncer,
        cuaProductMcpServerResolver: cuaResolver as never,
      }),
    },
  ];

  const collection = new ServiceCollection();
  for (const { name, descriptor, make } of table) {
    say(`装配 ${name}`);
    try {
      collection.register(descriptor as never, make());
    } catch (e) {
      // 记下原因：这条要出现在启动屏与自检报告里，"某个服务没起来"不能只剩一句白屏。
      degraded.push({ name, error: String((e as Error)?.message ?? e) });
    }
  }

  const [serverSide, clientSide] = createQueuePair();
  // deferInit=true：channel 还没注册完就先发 Initialize 的话，客户端可能带着 pending 请求
  // 撞上 1000 ms 的服务器端超时（ChannelServer 的 timeoutDelay 默认值）。
  const server = new ChannelServer(serverSide, "mobile-host", 1000, true);
  collection.exposeOnChannelServer(server);
  server.ready();

  // accessor 上还有二十来个 channel 是端侧此刻没有的：git/terminal/bots/分享/用量统计…
  // 它们在客户端被换成"调用即抛错"的面，服务端不注册，于是也不会有人误以为连上了真后端。
  // 对话面已经不在这份名单里了；Provider 运行时没起来时它经由上面 degraded 那一路重新出现，
  // 报的是具体原因而不是一句"没接"。
  const stubbed = [
    "terminalService",
    // 闲时任务面：`list()` 在 UI 里是被 catch 的（offPeakTaskStore.ts:181），不注册也能起屏，
    // 但它仍然要出现在"未接入"清单上——屏幕上不写出来的缺口，下一个人会当成已经做完了。
    "offPeakTaskService",
    // gitService 已经不在这份名单里了（0.4.11 A3）：注册了诚实降级面（isGitAvailable:false），
    // UI 的 Git 面板走"Git 不可用"分支而不是报错。gitCheckpointService 仍在（依赖真 git）。
    "gitCheckpointService", "botsService", "feedbackService",
    "skillSyncService", "pluginSyncService",
    // windowControllerService 已经不在这份名单里了：listTaskList 与那两个 topic 的实时帧都是真的
    // （侧栏那一行从这里读、重拉从这里触发）。
    // 仍然会在未实现账本里点名的是 mutateTask / deleteArchivedTask 那几面（置顶、归档、删除）。
    // usageStatsService 已经不在这份名单里了（Phase 1 启用）：App Usage 读 session-store 的真实
    // 轮次用量做本地聚合；端侧没有的服务端面（Coding Plan monitor/reset）调用时才抛具体原因，
    // 那些屏才触发，不影响用量主面板。
    // 套餐预览在无凭据桥时也已注册；不能列入 degraded，否则 entry 会用不可用占位覆盖它。
    "conversationShareService", "cuaPermissionService",
    // 表里构造失败的也算进去：屏幕与报告仍然报它，只是报的是具体原因而不是"没接"。
    ...degraded.map((d) => d.name),
  ];

  return {
    collection,
    protocolPair: [serverSide, clientSide],
    stubbed,
    degraded,
    agentLog,
    fsEngine: fsReady.engine,
    unsupportedCalls: () => unsupportedCalls(),
    taskRows: async () =>
      (await taskIndexRepo.listTaskMetas({})).map((meta) => ({
        taskId: meta.taskId,
        title: meta.title,
        ...(meta.status ? { status: meta.status } : {}),
        updatedAt: meta.updatedAt,
      })),
    sqliteEngine: sqliteEngine(),
    sessionStoreEngine: sessionStore?.engine() ?? null,
  };
}
