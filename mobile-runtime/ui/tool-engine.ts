// 工具引擎装配（Phase 1 第 5 项的底座）：注册表 + 执行器 + 文件系统端口，一条链全从
// **core bundle 的同一份模块实例**里拿。
//
// 为什么运行时 dynamic import 而不是静态 import "@zcode/core"：
//   1. instanceof 一致性——执行器内部用 contracts 的 isFileSystemPortError() 认端口错误，
//      端口又必须抛同一个类（build/entry.mjs 头注早就记过这条）。core bundle 与 dist-ui
//      是两张独立模块图：静态引 = 两份 contracts，端口错误在执行器眼里全成"未知错误"。
//      m1-run.mjs 全部从 `rt` 解构（registry/executor/PermissionService/vfs/FileSystemPortError），
//      真机上那 5 个工具就是这么过桥的——照抄同一张图才叫验证过。
//   2. 体积——core 是 3.4 MB 的既有产物（assets/mobile/dist/，自检页加载的那份，
//      copyMobileRuntime 本来就在复制）。运行时 import 同一个已出货的文件，APK 零新增字节；
//      静态引它等于把工具层在 dist-ui 里再打一份。
//   3. 失败面——加载不了（文件缺失/解析炸）时返回 null：对话退回纯文本形状，请求体里永远
//      不会出现 tools 字段，不存在"承诺了工具又执行不了"的半程状态。桌面 chatdev 为同源解析
//      加了 /mobile/dist/ 路由（见 chatdev.mjs），测试走的与设备逐字一致。
// 状态写 localStorage（与自检页同源）：agentLog 切页即丢，"引擎到底加载没有"必须进装机报告。
import type { ModelToolCall, ModelToolSpec } from "./model-stream.js";
import { createGitFs } from "../compat/git-fs-adapter.mjs";
import { makeGitTool } from "./git-tool.js";
import { sanitizeToolArguments } from "./tool-sanitize.js";
import { browserControlEnabled, BROWSER_CONTROL_EVENT } from "./plugins-mobile.js";
import { makeFetchTool } from "./fetch-tool.js";

/** 移动端开哪些工具。
 *  文件五件套（Read/Write/Edit/Glob/Grep）：只读写 app 私有工作区，越界由端口 guard 拒——工作区内自动放行。
 *  Bash：能跑 toybox 任意命令（真机 L1 已证 argv/shell/timeout 三条可用），风险高——**每条都要审批**
 *  （permissionBroker 在 core 侧返回 needs_approval 后由 agent 落一条 pendingInteraction，用户点头才执行）。
 *  所以 Bash 只有在注入了 requestApproval 回调时才注册；没有回调（如某些桌面 harness）就连声明都不声明，
 *  模型无从发起一个端上没人批的命令。 */
const FILE_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"] as const;
const BASH_TOOL = "Bash";
const DELETE_TOOL = "Delete";
const BROWSER_TOOL = "Browser";

/** core bundle 的运行时位置：相对 entry.js（assets/ui/）→ assets/mobile/dist/zcode-core.mobile.js。 */
const CORE_BUNDLE_HREF = "../mobile/dist/zcode-core.mobile.js";

/** 工具结果回给模型的截断上限：单次 Grep 全文命中能到几百 KB，原样喂回去会把下一轮请求撑爆。 */
export const TOOL_RESULT_MAX_CHARS = 20_000;

export function capToolContent(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  return `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n…(已截断，原长 ${text.length} 字符)`;
}

/** 工具一次调用的回包：content 喂回模型，isError 决定 role:tool 消息的语义；错误码/原因供行上留痕。 */
export interface ToolRunResult {
  content: string;
  isError: boolean;
  errorCode?: string;
  errorMessage?: string;
  /**
   * 工具结果的结构化展示载荷（core call-runner 算好的 output.display，0.7.3）：
   * Bash→{kind:"bash_output"}、Edit/Write→{kind:"file_diff", structuredPatch…}。
   * 桌面卡片渲染就读这一格；端侧此前只发 output.text，Write/Edit 的 file_diff 卡拿不到
   * patch 就整张渲染成"一个空框"（用户点名"text/kotlin 等工具调用的输出气泡没内容"）。
   * 原样透传，不重新拼装（display 的派生规则在 core 的 result-display.ts，别在端侧造第二份）。
   */
  display?: unknown;
}

export interface ToolEngine {
  tools: ModelToolSpec[];
  /** 哪些调用需要用户点头才能执行（Bash 是唯一一个；审批闸在 agent 的循环里，见 runTurn）。 */
  approvalRequired: (toolName: string) => boolean;
  execute: (call: ModelToolCall) => Promise<ToolRunResult>;
  /** 0.5.0 沙箱授权（"读 sandbox 外的文件应先询问"）：全量文件端口挂在引擎上，
   *  agent 在审批通过后调 grantRoot，拒绝/用完即 revokeRoot。未装配引擎（null）时不存在。 */
  grantRoot: (path: string) => void;
  revokeRoot: (path: string) => void;
}

/** agent.ts 消费的形状：按 workspacePath 取（并缓存）一台引擎；null = 这台没工具。 */
export type ToolEngineFactory = (workspacePath: string) => Promise<ToolEngine | null>;

/** core bundle 暴露的这一小片面（形状来自 build/entry.mjs 的再导出，不另起一份类型事实）。 */
interface CoreLike {
  /** compat/vfs 的 node:fs 兼容面（Delete 工具用 rmSync；fileSystemPort 消费其余面）。
   *  stage 是 0.5.0 的终端物化面（vfs-stage.mjs）——必须走**同一份模块实例**拿它：
   *  vfs.mjs 的写入透传用的是这份实例，dist-ui 里再引一份独立拷贝会各记各的状态
   *  （ensureStaging 物化的镜像，mirror 看不见），这正是 core bundle 存在的理由。 */
  vfs: {
    rmSync(p: string, opts?: { recursive?: boolean; force?: boolean }): void;
    /** Fetch 工具的 download 落盘用（与 compat/vfs.mjs 的 writeFile 派发层同签名）。 */
    writeFile(p: string, data: unknown, opts?: unknown, syscall?: string): void;
    mkdir(p: string, opts?: unknown): unknown;
    /** 只声明用到的窄面，签名与 compat/vfs-stage.mjs 逐字一致。 */
    stage?: {
      mountOf(path: string): string | null;
      isStagingReady(path: string): boolean;
      ensureStaging(mountPath: string): Promise<{ files: number; dirs: number; skipped: number } | null>;
      snapshotStaging(mountPath: string): Map<string, { kind: string; mtimeMs: number; size: number }> | null;
      writeBackStaging(
        mountPath: string,
        snapshot: Map<string, { kind: string; mtimeMs: number; size: number }>,
      ): Promise<{ written: number; deleted: number; failed: number; errors: string[] } | null>;
    };
    /** vfs-native 真盘后端（git 在 SAF 工作区经镜像直跑私有盘时用）。 */
    native?: unknown;
  };
  FileSystemPortError: unknown;
  createToolRegistry: () => {
    list(): string[];
    toContracts(): Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }>;
    /** 自定义工具注册（Delete 走这里；builtInTools 之外的 entry）。 */
    register(entry: unknown, options?: { silentDuplicateWarnings?: boolean }): void;
  };
  registerBuiltInTools: (
    registry: unknown,
    options: { allowedTools: readonly string[]; silentDuplicateWarnings?: boolean },
  ) => void;
  PermissionService: new () => unknown;
  createMobileFileSystemPort: (
    vfs: unknown,
    options: { workspaceRoot: string; FileSystemPortError: unknown },
  ) => unknown;
  /** Bash 的落地口：bridge 是 zcodeExec（Kotlin ExecBridge），没有它这个端口只会回 spawn_error。 */
  createNativeExecBridge?: () => unknown | null;
  createMobileExecutionPort?: (deps?: { bridge?: unknown }) => unknown;
  createToolExecutor: (options: Record<string, unknown>) => {
    execute: (
      call: { id: string; name: string; input: Record<string, unknown> },
      ctx: { traceContext: { traceId: string; spanId: string } },
    ) => Promise<Record<string, unknown>>;
  };
}

async function loadCoreFromAsset(): Promise<CoreLike | null> {
  try {
    const href = new URL(CORE_BUNDLE_HREF, import.meta.url).href;
    const mod = (await import(/* @vite-ignore */ href)) as { default?: CoreLike } & Partial<CoreLike>;
    // entry.mjs 同时给具名导出与 default（core 命名空间）；两个口都认，prefer 具名。
    return typeof mod?.createToolRegistry === "function" ? (mod as CoreLike) : (mod.default ?? null);
  } catch {
    // 加载失败是降级信号不是错误：没有工具、纯文本对话照旧。原因由调用方日志带出。
    return null;
  }
}

// ── 装机可见的状态读数（M11 自检与 e2e 都读这份）──

const TOOLS_DIAG_KEY = "zcode…diag";

export interface ToolsDiag {
  state: "ready" | "failed" | "absent";
  tools: string[];
  error: string | null;
  updatedAt: number;
}

function recordToolsDiag(state: ToolsDiag["state"], tools: string[], error: string | null): void {
  try {
    globalThis.localStorage?.setItem(
      TOOLS_DIAG_KEY,
      JSON.stringify({ state, tools, error, updatedAt: Date.now() } satisfies ToolsDiag),
    );
  } catch {
    /* 隐私模式/配额：诊断掉线不能带崩对话 */
  }
}

export function readToolsDiag(): ToolsDiag | null {
  try {
    const raw = globalThis.localStorage?.getItem(TOOLS_DIAG_KEY);
    return raw ? (JSON.parse(raw) as ToolsDiag) : null;
  } catch {
    return null;
  }
}

/**
 * 引擎按 workspace 缓存：端口的 workspaceRoot（越界闸）与 readFileState（Edit 的"必须先 Read"
 * 账本）都属于这个工作区；换 workspace 换实例，A 项目读过的文件不会给 B 的 Edit 当凭据。
 *
 * loadCore 为什么可注入：instanceof 一致性要求执行器、端口、错误类来自**同一份模块实例**。
 * 浏览器里由"同一个 dynamic import"天然保证；Node 冒烟（chat-smoke）传自己的 loader
 * （直接 import core dist，同 URL 经 ESM 缓存折叠成一份），而不是赌两处静态 import 合并。
 */
export function createToolEngineFactory(
  options: {
    loadCore?: () => Promise<CoreLike | null>;
    onDiagnostic?: (message: string) => void;
    /**
     * Bash 是否注册（默认开，0.4.6）。审批往返本身 0.4.5 就浏览器实测打通（弹窗→允许→执行→回传）；
     * 当时把"Bash 输出过不了 core 的 strict BashOutputSchema"归罪于 perf 遥测，实测复现证明误诊：
     * perf（含 detail.kind=command）真 schema parse 通过，唯一拒载是 **signal: null**——Android 桥
     * （ports/execution-bridge-android.mjs）硬编码的空值一路透传到 toBashOutput。契约
     * ExecutionResult.signal 是 string 可选，桌面 node adapter 也是 `signal ?? undefined`；桥侧折叠
     * 空值后 schema 过、默认翻正。关口保留为显式传 `bashEnabled: false`（某些桌面 harness 没
     * requestApproval 回调时仍不该声明 Bash）。
     */
    bashEnabled?: boolean;
  } = {},
): ToolEngineFactory {
  const loadCore = options.loadCore ?? loadCoreFromAsset;
  const say = options.onDiagnostic ?? (() => {});
  const bashEnabled = options.bashEnabled !== false;
  let corePromise: Promise<CoreLike | null> | null = null;
  const engines = new Map<string, Promise<ToolEngine | null>>();

  // 浏览器控制开关（0.7.1）改的是工具清单，而引擎是按 workspace 缓存的对象：不清缓存
  // 就得等应用重启才生效。事件由 plugins-mobile.setBrowserControlEnabled 广播（设置页开关）。
  let browserFlagListenerArmed = false;
  const armBrowserFlagListener = () => {
    if (browserFlagListenerArmed) return;
    browserFlagListenerArmed = true;
    globalThis.addEventListener?.(BROWSER_CONTROL_EVENT, () => {
      engines.clear();
      say("浏览器控制开关变化：工具引擎缓存已失效，下一轮按新旗子重建");
    });
  };
  armBrowserFlagListener();

  const coreOnce = () => {
    if (!corePromise) {
      corePromise = loadCore().then((core) => {
        if (!core) {
          say("工具引擎：core bundle 加载失败，退回纯文本对话");
          recordToolsDiag("failed", [], "core bundle 加载失败");
        }
        return core;
      });
    }
    return corePromise;
  };

  const build = async (workspacePath: string): Promise<ToolEngine | null> => {
    const core = await coreOnce();
    if (!core) return null;
    try {
      const registry = core.createToolRegistry();
      const execBridge = core.createNativeExecBridge ? core.createNativeExecBridge() : null;
      // Bash 注册要两个条件：原生执行桥在（否则跑了必 spawn_error）**且** bashEnabled（默认开，见上）。
      // 0.4.6：Bash 输出过不了 strict BashOutputSchema 的真凶是 Android 桥的 signal:null 透传
      //（不是 0.4.5 记的 perf 遥测——perf 实测 parse 通过），桥侧折叠空值后默认翻正。
      const bashOn = bashEnabled && Boolean(execBridge);
      const allowedTools = bashOn ? [...FILE_TOOLS, BASH_TOOL] : [...FILE_TOOLS];
      core.registerBuiltInTools(registry, { allowedTools, silentDuplicateWarnings: true });
      // Delete（0.4.8，装机"让它删文件折腾半天"）：上游没有独立删除工具（桌面靠 Bash rm），
      // 而端侧的 SAF 工作区（/mnt/…）在终端子进程里根本不存在、共享存储（/storage/…）无 POSIX
      // 权限——模型用 rm 删永远失败。这里补一个走 vfs 的删除工具：私有盘走真盘、树挂载走
      // DocumentFile.delete（TreeBridge unlink/rmdir，M8 语义已验）。破坏性操作，注册与 Bash
      // 同闸（bashOn）：approvalRequired 只认 bashOn 的 Delete，若在这里无条件下挂，桌面 harness
      // 上模型就能不经审批删文件——闸与注册必须同开同关。
      if (bashOn) {
        registry.register(
        {
          metadata: {
            name: DELETE_TOOL,
            description:
              "删除工作区里的文件或目录。SAF/树挂载的工作区（/mnt/… 路径）必须用这个工具——终端 rm 对这些路径既看不到也无权限。目录需 recursive=true。",
            inputSchema: {
              type: "object",
              properties: {
                path: { type: "string", description: "要删除的文件/目录（工作区相对或绝对路径）" },
                recursive: { type: "boolean", description: "目录递归删除（默认 false）" },
              },
              required: ["path"],
              additionalProperties: false,
            },
          },
          handler: async (raw: unknown) => {
            const input = (raw ?? {}) as { path?: unknown; recursive?: unknown };
            const rawPath = typeof input.path === "string" ? input.path.trim() : "";
            if (!rawPath) throw new Error("path 不能为空");
            // 路径归一与文件工具同一语义：相对路径按工作区根解析（vfs 的根就是 /work 或 /mnt/<名>）。
            const resolved = rawPath.startsWith("/") ? rawPath : `${workspacePath}/${rawPath}`;
            core.vfs.rmSync(resolved, {
              recursive: input.recursive === true,
              force: false,
            });
            return `已删除：${resolved}${input.recursive === true ? "（递归）" : ""}`;
          },
        },
        { silentDuplicateWarnings: true },
        );
      }
      // 内置浏览器（0.6.0，用户点名"接入内置浏览器功能"）：端上没有 Playwright/CDU 那套
      // 桌面 CUA 运行时，等价物是 app 自己的浏览器页（BrowserActivity）+ zcodeBrowser 同步桥。
      // 模型用 Browser 工具开 URL / 跳转 / 返回 / 读页面（标题+正文纯文本）；用户全程看得见、
      // 随时接管点按——read 拿的是用户操作后的最新状态。桥不在（桌面 harness）就不注册：
      // 模型无从发起一个没人接的工具调用，与 Bash 同一条纪律。
      // 0.7.1：再叠一层"浏览器控制"开关（设置页那枚，旗子由 plugins-mobile 存）。
      // 开关关掉 = 新的一轮起不再声明 Browser 工具（引擎缓存按事件失效，见 createToolEngineFactory）。
      const browserApi = (globalThis as { zcodeBrowser?: Record<string, (req?: unknown) => string> }).zcodeBrowser;
      if (browserApi && typeof browserApi.open === "function" && browserControlEnabled()) {
        registry.register(
          {
            metadata: {
              name: BROWSER_TOOL,
              description:
                "内置浏览器：打开网页并读取页面内容（标题+正文纯文本）。用户能看见浏览器页面并随时自己操作。" +
                "只支持 http/https。适合查资料/看文档/验证线上页面；登录态与工作区文件无关。",
              inputSchema: {
                type: "object",
                properties: {
                  action: {
                    type: "string",
                    enum: ["open", "back", "read", "close"],
                    description: "open=打开/跳转到 url（必填 url）；back=返回上一页；read=读取当前页面；close=关闭浏览器",
                  },
                  url: { type: "string", description: "要打开的完整地址（action=open 时必填，http/https）" },
                },
                required: ["action"],
                additionalProperties: false,
              },
            },
            handler: async (raw: unknown) => {
              const input = (raw ?? {}) as { action?: unknown; url?: unknown };
              const action = typeof input.action === "string" ? input.action : "";
              const call = (fn: string, req?: unknown) => {
                const api = (globalThis as { zcodeBrowser?: Record<string, (r?: unknown) => string> }).zcodeBrowser;
                if (!api || typeof api[fn] !== "function") throw new Error(`浏览器桥不可用（${fn}）`);
                return api[fn](typeof req === "string" ? req : undefined);
              };
              switch (action) {
                case "open": {
                  const url = typeof input.url === "string" ? input.url.trim() : "";
                  if (!url) throw new Error("action=open 需要 url");
                  return call("open", JSON.stringify({ url }));
                }
                case "back":
                  return call("back");
                case "read":
                  return call("read");
                case "close":
                  return call("close");
                default:
                  throw new Error(`未知 action：${action}（open/back/read/close）`);
              }
            },
          },
          { silentDuplicateWarnings: true },
        );
      }
      // 内置网络下载（0.7.3，用户点名"内置 curl/wget 工具"）：等效 curl/wget，复用 0.6.7 的
      // 原生 HTTP 桥（bridgeHttpRaw，HttpURLConnection 代发、无 CORS 概念），落盘走 vfs（工作区内，
      // 越界仍由文件端口的授权闸拦）。不依赖 shell，只要有 HTTP 桥就注册（桌面 harness 桥不在就不声明）。
      registry.register(makeFetchTool(workspacePath, core.vfs), { silentDuplicateWarnings: true });
      // 内置 git（0.6.1 起；0.6.2 扩到 SAF）：isomorphic-git（纯 JS）+ vfs 适配器。
      //  - /work 工作区：gitFs 走派发层（私有盘直通）。
      //  - /mnt/<名>（SAF）工作区：gitFs 走 **native 后端**——/mnt/<名> 的虚拟路径经
      //    FsBridge 正好落在终端物化镜像（workspaceRoot/mnt/<名>）上，逐文件操作是私有盘
      //    速度而不是 SAF 的 30-40ms；命令前后走 Bash 同一套 staging 纪律
      //    （ensureStaging → 快照 → 命令 → diff 回写 SAF，.git 与工作区改动都落回）。
      //    首次全量物化可能较慢（进度走 say），之后命令级增量。
      const stageApiForGit = core.vfs.stage;
      const gitMount =
        !workspacePath.startsWith("/work") && stageApiForGit ? stageApiForGit.mountOf(workspacePath) : null;
      if (workspacePath.startsWith("/work") || gitMount) {
        const nativeBackend = (core.vfs as { native?: unknown }).native;
        const gitFs = createGitFs(gitMount && nativeBackend ? nativeBackend : core.vfs);
        const stageControl =
          gitMount && stageApiForGit
            ? {
                ensure: async () => {
                  const info = await stageApiForGit.ensureStaging(gitMount);
                  if (info) {
                    say(
                      `git 镜像：${gitMount} → ${info.files} 个文件/${info.dirs} 个目录` +
                        (info.skipped > 0 ? `（跳过 ${info.skipped} 个超限文件）` : ""),
                    );
                  }
                },
                snapshot: () => stageApiForGit.snapshotStaging(gitMount),
                writeBack: (snap: unknown) =>
                  stageApiForGit.writeBackStaging(
                    gitMount,
                    snap as Map<string, { kind: string; mtimeMs: number; size: number }>,
                  ),
              }
            : undefined;
        registry.register(makeGitTool(workspacePath, gitFs, stageControl), { silentDuplicateWarnings: true });
      }
      const fileSystemPort = core.createMobileFileSystemPort(core.vfs, {
        workspaceRoot: workspacePath,
        FileSystemPortError: core.FileSystemPortError,
      }) as {
        grantRoot?: (path: string) => void;
        revokeRoot?: (path: string) => void;
      };
      const executionPort = execBridge && core.createMobileExecutionPort
        ? core.createMobileExecutionPort({ bridge: execBridge })
        : undefined;
      const executor = core.createToolExecutor({
        registry,
        permissionService: new core.PermissionService(),
        // 端侧没有桌面那套审批 UI：工作区之内自动放行（越界由端口 guard 拒 permission_denied），
        // 与 m1-run 真机验证过的形状逐字一致。Bash 的审批不走这里——闸在 agent 的循环里
        // （approvalRequired → 先立 pendingInteraction 等用户点头，点了才 execute），
        // 所以 broker 对已经过闸的调用直接 allow，不出现"桌面弹窗 + 端上弹窗"两道门。
        permissionBroker: {
          requestPermission: async (request: { input: unknown }) => ({
            decision: "allow",
            resolvedAt: new Date(),
            updatedInput: request.input,
          }),
        },
        emitEvent: async () => {},
        sessionId: "mobile-agent",
        fileSystemPort,
        ...(executionPort ? { executionPort } : {}),
        workingDirectory: workspacePath,
        workspaceRoot: workspacePath,
        getWorkingDirectory: () => workspacePath,
        readFileState: new Map(),
        clientMode: "desktop-continuous",
        embeddedSearchBackend: "internal-cli",
      });
      const tools: ModelToolSpec[] = registry.toContracts().map((c) => ({
        name: c.name,
        description: c.description ?? "",
        parameters: c.inputSchema ?? { type: "object", properties: {} },
      }));
      if (tools.length === 0) {
        // 注册面变了（名字全对不上）：宁可不带工具，也不发一份空声明。
        say("工具引擎：注册表为空，退回纯文本对话");
        recordToolsDiag("failed", [], "注册表为空");
        return null;
      }
      say(`工具引擎就绪（${tools.map((t) => t.name).join("/")} @ ${workspacePath}）`);
      recordToolsDiag("ready", tools.map((t) => t.name), null);
      return {
        tools,
        approvalRequired: (toolName: string) =>
          bashOn && (toolName === BASH_TOOL || toolName === DELETE_TOOL),
        // 沙箱授权口（0.5.0）：端口上确实挂了才暴露，没挂就如实 no-op（老 core bundle 兼容）。
        grantRoot: (path: string) => fileSystemPort.grantRoot?.(path),
        revokeRoot: (path: string) => fileSystemPort.revokeRoot?.(path),
        execute: async (call) => {
          let input: Record<string, unknown> = {};
          let parseError = "";
          // 隐形字符净化（0.6.8，装机"命令碎成一列竖排"）：GLM 系偶发把零宽/双向控制字符
          // 吐进 arguments——夹在 JSON 结构里炸 parse，落在 command 里让 shell 收到乱码。
          // 所有工具统一过一刀；剥了几枚写进 agentLog（装机报告直接读数，不靠猜）。
          const sanitized = sanitizeToolArguments(call.arguments || "{}");
          if (sanitized.stripped > 0) {
            say(`工具入参净化：${call.name} 剥除 ${sanitized.stripped} 枚隐形字符（模型流式输出夹带）`);
          }
          try {
            const parsed = JSON.parse(sanitized.clean);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
            else parseError = "工具入参不是 JSON object";
          } catch (e) {
            parseError = `工具入参解析失败：${String((e as Error)?.message ?? e)}`;
          }
          if (parseError) {
            // 模型吐出坏 JSON：如实回给模型（isError），它下一轮能自纠。
            return { content: parseError, isError: true, errorCode: "mobile.toolInputInvalid", errorMessage: parseError };
          }
          // Bash 前置守卫（0.4.8，装机"删文件折腾半天"的根因通道之一）：终端子进程跑在
          // app 私有目录，/storage//sdcard（共享存储，无 POSIX 权限）对它不可达——不拦的话
          // 模型只会收到一句 No such file or directory / Permission denied，然后反复换姿势重试。
          //
          // 0.5.0 终端物化（用户点名"SAF 挂载目录对终端子进程不可见导致 bash 无法启动"）：
          // SAF 工作区（/mnt/<本挂载>）在 Bash 跑之前被镜像到私有盘（vfs-stage），**当前挂载
          // 的前缀因此可达**——但别家挂载（/mnt/<别家>）没物化，仍然拦。原先"凡 /mnt/ 全拦"
          // 的规则在物化落地后会把合法命令也误拦，这里按"是不是当前工作区挂载"分叉。
          const stageApi = core.vfs.stage;
          const stageMount = call.name === BASH_TOOL && stageApi ? stageApi.mountOf(workspacePath) : null;
          if (call.name === BASH_TOOL) {
            const command = typeof input.command === "string" ? input.command : "";
            const mountRefRe = /(^|[\s"'(])\/mnt\/([^\s"'/;&|)]+)/g;
            const refs: string[] = [];
            for (const m of command.matchAll(mountRefRe)) refs.push(`/mnt/${m[2]}`);
            const foreignMounts = refs.filter((r) => r !== stageMount);
            // 共享存储可达性看系统"所有文件访问"权限（0.7.4）：授予后终端子进程与 app 同 uid、
            // 同挂 /sdcard 的 FUSE，能直接 ls/cat/下载目录；没授予时它仍是够不着的——维持拦截，
            // 否则模型只会在 No such file or directory 上反复换姿势。
            const allFiles =
              (globalThis as { zcodeDevice?: { allFilesGranted?(): boolean } }).zcodeDevice?.allFilesGranted?.() ===
              true;
            const shared =
              !allFiles && /(^|[\s"'(])\/storage\/|(^|[\s"'(])\/sdcard\//.test(command);
            if (foreignMounts.length > 0 || shared) {
              const why =
                foreignMounts.length > 0
                  ? `引用了未物化的别的 SAF 挂载（${foreignMounts.slice(0, 2).join("、")}）`
                  : "引用了共享存储（/storage//sdcard，未授予\"所有文件访问\"前终端够不着）";
              const hint =
                `命令${why}，终端子进程看不到。当前工作区${stageMount ? `（${stageMount}）已镜像给终端，用相对路径或 ${stageMount}/… 绝对路径都可以` : "（/work）用相对路径即可"}；` +
                `工作区文件也可以用文件工具（Read/Write/Edit/Glob/Grep）操作，删除用 Delete 工具。`;
              return { content: hint, isError: true, errorCode: "mobile.bashPathUnreachable", errorMessage: hint };
            }
          }
          // 终端物化两拍：跑命令前确保镜像在场并拍快照，跑完按 diff 回写 SAF。
          // 快照拍在物化之后、命令之前——命令改了哪些文件，diff 说了算。
          let stageSnapshot: ReturnType<NonNullable<typeof stageApi>["snapshotStaging"]> = null;
          const stageNotes: string[] = [];
          if (stageMount && stageApi) {
            const info = await stageApi.ensureStaging(stageMount);
            if (info) {
              say(
                `终端物化：${stageMount} → ${info.files} 个文件/${info.dirs} 个目录` +
                  (info.skipped > 0 ? `（跳过 ${info.skipped} 个超限文件）` : ""),
              );
              if (info.skipped > 0) {
                stageNotes.push(
                  `注意：${info.skipped} 个超过 8MB 的文件没有镜像给终端（ls/cat 看不到它们，不等于被删）。`,
                );
              }
            }
            stageSnapshot = stageApi.snapshotStaging(stageMount);
          }
          // 包管理器前置守卫（0.6.0，用户问"pkg/apt 等包管理器不存在，是不是应该内置"）：
          // 端侧终端是 Android toybox，没有 apt/dpkg/pkg/pacman 也没有 root——装包管理器
          // 意味着整套 Termux 生态（proot + 独立仓库），不是一个二进制的事。这里把真话
          // 前置给模型，别让它反复 apt-get install 撞 "sh: apt: not found"。
          if (call.name === BASH_TOOL) {
            const command = typeof input.command === "string" ? input.command : "";
            // git 前置守卫（0.6.0 起置真话；0.6.1 起端上有内置 Git 工具了，指路）：
            // bash 里没有 git 二进制，`git status` 只会得到 "sh: git: not found"。
            if (/(?:^|[;&|]+\s*|\b(?:sudo|env)\s+)git\s/.test(command)) {
              const hint =
                "端侧 bash 没有 git 二进制（Android 沙箱不带版本控制工具）。git 操作请改用 **Git 工具**" +
                "（action: init/clone/status/add/commit/log/branch，纯 JS 实现；" +
                (workspacePath.startsWith("/work")
                  ? "私有盘工作区直跑）。"
                  : "SAF 工作区会自动经终端镜像在私有盘上加速执行并回写工作区，首次较慢）。");
              return { content: hint, isError: true, errorCode: "mobile.bashGitUnavailable", errorMessage: hint };
            }
            if (/(?:^|[;&|]+\s*|\b(?:sudo|env)\s+)(?:apt|apt-get|dpkg|pkg|pacman|yum|dnf|brew|apk)\s/.test(command)) {
              const hint =
                "端侧终端是 Android 的 toybox shell：没有 apt/dpkg/pkg/pacman 等包管理器，" +
                "也无法安装它们（需要 root 或整套 Termux/proot 环境）。请改用不依赖系统包的方案：" +
                "纯 JS/静态二进制（放进工作区）、或把依赖说明写进 README 让用户在桌面环境执行。";
              return { content: hint, isError: true, errorCode: "mobile.bashPackageManagerUnavailable", errorMessage: hint };
            }
          }
          try {
            const r = await executor.execute(
              { id: call.id || `tool-${Date.now().toString(36)}`, name: call.name, input },
              { traceContext: { traceId: "mobile-agent", spanId: call.name } },
            );
            // 回包映射照 m1-run 的实测形状：{error} 是执行器错误；content/output 双形状都见过。
            if (r?.error) {
              const err = r.error as { message?: string; code?: string; details?: unknown; context?: unknown };
              // zod 的 issues 数组藏在 error.context/details 里：只留 message 会把
              // "哪个字段哪一项不合法"的定位信息丢掉（0.4.5 排查 Write strict 拒载时正缺它）。
              const extra = (err?.details ?? err?.context) ? JSON.stringify(err.details ?? err.context).slice(0, 800) : "";
              const message = (typeof r.error === "string" ? r.error : (err?.message ?? JSON.stringify(r.error))) + (extra ? ` :: ${extra}` : "");
              return {
                content: `工具执行失败：${message}`,
                isError: true,
                errorCode: err?.code ?? "mobile.toolFailed",
                errorMessage: String(message).slice(0, 500),
              };
            }
            const content = (r as { content?: unknown }).content ?? (r as { output?: unknown }).output ?? r;
            let text = typeof content === "string" ? content : JSON.stringify(content);
            // 回写（物化工作区的另一半）：命令对镜像的改动落回 SAF。失败必须可见——"命令说改了、
            // 模型 Read 一看没变"这种半真状态比报错更难查（TreeBridge 侧的窄化清单同级纪律）。
            if (stageMount && stageApi && stageSnapshot) {
              const wb = await stageApi.writeBackStaging(stageMount, stageSnapshot);
              if (wb && wb.failed > 0) {
                stageNotes.push(
                  `回写告警：${wb.failed} 处改动未能写回工作区（${wb.errors.join("；")}）。` +
                    `这些文件在终端镜像里已改，但文件工具读到的是未改版本。`,
                );
              }
            }
            if (stageNotes.length > 0) text = `${text || "（无输出）"}\n\n${stageNotes.join("\n")}`;
            // display 透传（0.7.3）：core 已算好的结构化展示载荷直接带回，agent 落进行卡的 output.display。
            return { content: text || "（无输出）", isError: false, display: (r as { display?: unknown }).display };
          } catch (e) {
            const message = String((e as Error)?.message ?? e);
            return { content: `工具执行异常：${message}`, isError: true, errorCode: "mobile.toolThrew", errorMessage: message.slice(0, 500) };
          }
        },
      };
    } catch (e) {
      const error = String((e as Error)?.message ?? e);
      say(`工具引擎装配失败（退回纯文本对话）：${error}`);
      recordToolsDiag("failed", [], error.slice(0, 300));
      return null;
    }
  };

  return (workspacePath: string) => {
    let engine = engines.get(workspacePath);
    if (!engine) {
      engine = build(workspacePath);
      engines.set(workspacePath, engine);
    }
    return engine;
  };
}
