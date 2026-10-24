// 端侧钩子运行时（0.7.1，用户点名"钩子未接入，请接入"）。
//
// 桌面的事实源在 zcode-cli 进程里：它读工作区 `.zcode/config.json`（以及遗留
// `.claude/.agents/settings.json`）里的 hooks，把命令挂到七个生命周期事件上执行，
// 用退出码 2 / stdout JSON 决定"阻断、放行、注入上下文、改写工具入参"。端侧没有那个进程
// （agent.ts 头注：按协议实现，不按实现复用），所以这一层就是端侧的执行器。
//
// 复用面刻意压到最大：**执行语义不另写一份**——`createConfiguredHookRunner` 从 core bundle
// 里拿（与工具引擎同一份模块实例），匹配器/超时/退出码 2→阻断/HookJSONOutput 解析/
// async hook/additionalContexts/updatedInput/permissionDecision 全是桌面那条链的原实现；
// 命令执行走端侧既有的 ExecutionPort（Bash 同一座桥）。这一层只补三样桌面在 CLI 里做的事：
//   1. 发现与装配：读配置 → 建快照（buildWorkspaceHookBundleSnapshot，与桌面同一份 digest 算法，
//      信任记录才有意义）→ HooksRuntimeConfig；
//   2. 信任门禁：项目级 hook 默认 pending_trust、不执行（fail-closed，与桌面同判据）；
//      信任记录落在 hooksService 读的同一个文件（`<home>/.zcode/security/workspace-hook-trust-v1.json`），
//      所以设置页里点「信任」和运行时放行是同一份事实；
//   3. 行投影：把 runner 发的 hook_run_* 事件转成时间线要的 hookInvocation 行（agent.ts 落行）。
//
// 明确没做的：legacy `.claude` / `.agents` 兼容导入（端侧不扫这两个目录——设置页也不展示，
// 与其半吊子兼容不如如实不做）；插件的 hook（端侧没有插件进程）；async hook 的跨轮存活
// （手机后台回收本就常态化，run 生命期外的东西不承诺）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  buildWorkspaceHookBundleSnapshot,
  readWorkspaceHookProjectSources,
  resolveWorkspaceHookRuntimeRoot,
  resolveWorkspaceHookTimeoutMs,
  workspaceHooksConfigSchema,
  type WorkspaceHooksConfig,
} from "@zcode/shared/workspace-hook-discovery";
import { parseWorkspaceHookTrustStoreContent } from "@zcode/shared/workspace-hook-trust-store-file";

export type MobileHookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PermissionRequest"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Stop";

const HOOK_EVENT_NAMES: readonly MobileHookEventName[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
];

const TRUST_STORE_SCHEMA_VERSION = 1;
const TRUST_STORE_FILE = "workspace-hook-trust-v1.json";
/** 安全边界默认值：与桌面 DEFAULT_WORKSPACE_HOOK_TIMEOUT_MS / MAX_OUTPUT_BYTES 同值。 */
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 32_768;

/** core bundle 的位置：与 tool-engine 同一个文件（`assets/ui/` → `assets/mobile/dist/`）。 */
const CORE_BUNDLE_HREF = "../mobile/dist/zcode-core.mobile.js";

/** Hook 运行结果（形状 = core 的 HookRunResult，只列端侧消费的字段；其余原样带过）。 */
export interface MobileHookRunResult {
  additionalContexts: string[];
  blockRequested?: boolean;
  preventContinuation?: boolean;
  stopShouldContinue?: boolean;
  stopReason?: string;
  permissionBehavior?: "allow" | "deny" | "ask";
  hookPermissionDecisionReason?: string;
  permissionRequestResult?: { behavior?: "allow" | "deny"; message?: string; updatedInput?: unknown; [k: string]: unknown };
  updatedInput?: unknown;
}

export interface MobileHookInput {
  sessionId: string;
  turnId: string;
  cwd: string;
  prompt?: string;
  toolName?: string;
  toolInput?: unknown;
  toolCallId?: string;
  toolResponse?: unknown;
  error?: { message: string };
  isInterrupt?: boolean;
  responseText?: string;
  responsePreview?: string;
  stopHookActive?: boolean;
  permissionSuggestions?: unknown;
  mode?: string;
}

/** runner 发出来的生命周期事件（只声明端侧行投影要读的字段）。 */
export interface MobileHookLifecycleEvent {
  type: string;
  payload: {
    descriptor?: {
      sourceKind?: string;
      pluginName?: string;
      commandDisplay?: string;
      statusMessage?: string;
    };
    hookEventName?: string;
    hookIndex?: number;
    hookCount?: number;
    hookInvocationId?: string;
    hookRunId?: string;
    startedAt?: number;
    toolName?: string;
    toolCallId?: string;
    durationMs?: number;
    outcome?: string;
    blockReason?: string;
    errorMessage?: string;
    [k: string]: unknown;
  };
}

export interface MobileHookRuntime {
  /** 本轮有没有可跑的 hook（装配失败/没有配置 = false，调用方零分支跳过）。 */
  enabled: boolean;
  /** 端侧发现了什么问题（写进 agentLog，装机报告可读）。 */
  diagnostics: string[];
  run(event: MobileHookEventName, input: MobileHookInput, options?: { matchValues?: readonly string[]; signal?: AbortSignal }): Promise<MobileHookRunResult>;
  /** 最近一次装配时用的快照（grantTrust / 调试用）。 */
  snapshot: unknown;
}

interface CoreHooksLike {
  createConfiguredHookRunner?: (options: Record<string, unknown>) => { run(input: unknown, options?: unknown): Promise<MobileHookRunResult> } | undefined;
  createMobileExecutionPort?: (deps?: { bridge?: unknown }) => unknown;
  createNativeExecBridge?: () => unknown;
}

async function loadCore(): Promise<CoreHooksLike | null> {
  try {
    const mod = (await import(/* @vite-ignore */ CORE_BUNDLE_HREF)) as { default?: CoreHooksLike } & Partial<CoreHooksLike>;
    return (mod.default ?? mod) as CoreHooksLike;
  } catch {
    return null;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** trust store 路径解析：与 hooksService.readPersistentWorkspaceHookTrustDigests 同一套规则。 */
function trustStorePath(homeDir?: string): string {
  const home = homeDir ?? homedir();
  let storageRoot = join(home, ".zcode");
  try {
    const configPath = join(home, ".zcode", "cli", "config.json");
    if (existsSync(configPath)) {
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
      const storage = isRecord(parsed) && isRecord(parsed.storage) ? parsed.storage : {};
      const configured = typeof storage.dir === "string" ? storage.dir.trim() : "";
      if (configured) {
        storageRoot = configured.startsWith("~/")
          ? join(home, configured.slice(2))
          : isAbsolute(configured)
            ? resolve(configured)
            : resolve(home, configured);
      }
    }
  } catch {
    // 读不动就按默认根：信任判定 fail-closed（读不到记录 = 未信任），不会因为这里放宽。
  }
  return join(storageRoot, "security", TRUST_STORE_FILE);
}

/** 读持久信任 digest。损坏/不可读一律空集（fail-closed）——与桌面同判据。 */
function readTrustedDigests(workspaceIdentity: string, homeDir?: string): Set<string> {
  const path = trustStorePath(homeDir);
  try {
    if (!existsSync(path)) return new Set();
    const parsed = parseWorkspaceHookTrustStoreContent(readFileSync(path, "utf8"));
    if (parsed.status !== "ok") return new Set();
    return new Set(
      parsed.file.records
        .filter((record) => record.workspaceIdentity === workspaceIdentity)
        .map((record) => record.hookDeclarationDigest),
    );
  } catch {
    return new Set();
  }
}

/** 用户级 hook 配置（端侧 home 下的 .zcode/cli/config.json，与 hooksService 的 user source 同一路径）。
 *  用户级 hook 不经信任审核（用户自己在这台设备上写的），所以这条路径读不动只记诊断。 */
function readUserHooksConfig(homeDir?: string): { hooks?: WorkspaceHooksConfig; diagnostic?: string } {
  try {
    const userConfigPath = join(homeDir ?? homedir(), ".zcode", "cli", "config.json");
    if (!existsSync(userConfigPath)) return {};
    const parsed = JSON.parse(readFileSync(userConfigPath, "utf8")) as unknown;
    const candidate = isRecord(parsed) ? parsed.hooks : undefined;
    const result = workspaceHooksConfigSchema.safeParse(candidate);
    if (result.success) return { hooks: result.data };
    if (candidate !== undefined) {
      return { diagnostic: "用户级 hook 配置不符合 schema，已忽略（workspaceHooksConfigSchema 校验不过）" };
    }
    return {};
  } catch (e) {
    return { diagnostic: `用户级 hook 配置读取失败：${String((e as Error)?.message ?? e)}` };
  }
}

function writeTrustedRecords(records: Array<Record<string, unknown>>, homeDir?: string): void {
  const path = trustStorePath(homeDir);
  mkdirSync(dirname(path), { recursive: true });
  let existing: Array<Record<string, unknown>> = [];
  try {
    if (existsSync(path)) {
      const parsed = parseWorkspaceHookTrustStoreContent(readFileSync(path, "utf8"));
      if (parsed.status === "ok") existing = parsed.file.records as Array<Record<string, unknown>>;
    }
  } catch {
    existing = [];
  }
  const byKey = new Map<string, Record<string, unknown>>();
  for (const record of [...existing, ...records]) {
    byKey.set(`${record.workspaceIdentity}\u0000${record.hookDeclarationDigest}`, record);
  }
  writeFileSync(
    path,
    `${JSON.stringify({ schemaVersion: TRUST_STORE_SCHEMA_VERSION, records: [...byKey.values()] }, null, 2)}\n`,
    "utf8",
  );
}

/** 把快照条目转成信任记录（形状 = contracts 的 workspaceHookTrustRecord，字段一个不少）。 */
function buildTrustRecords(snapshot: {
  workspaceIdentity: string;
  bundleDigest: string;
  sourceFiles: Array<{ canonicalPath: string; discoveryOrder: number }>;
  hooks: Array<{
    reviewItemId: string;
    hookDeclarationDigest: string;
    event: string;
    type: string;
    command: string;
    args?: string[];
    sourceRelativePath: string;
    sourceFileIndex: number;
    matcher?: string | null;
    matcherIndex: number;
    hookIndex: number;
  }>;
}, digests: readonly string[]): Array<Record<string, unknown>> {
  const wanted = new Set(digests);
  const out: Array<Record<string, unknown>> = [];
  for (const entry of snapshot.hooks) {
    if (!wanted.has(entry.hookDeclarationDigest)) continue;
    const source = snapshot.sourceFiles[entry.sourceFileIndex];
    if (!source) continue;
    out.push({
      workspaceIdentity: snapshot.workspaceIdentity,
      hookDeclarationDigest: entry.hookDeclarationDigest,
      digestAlgorithm: "sha256",
      decision: "trusted",
      grantedAt: new Date().toISOString(),
      bundleDigestAtGrant: snapshot.bundleDigest,
      eventAtGrant: entry.event,
      displayCommandAtGrant:
        entry.type === "process" ? [entry.command, ...(entry.args ?? [])].join(" ") : entry.command,
      sourcePathAtGrant: entry.sourceRelativePath,
      sourceDiscoveryOrderAtGrant: source.discoveryOrder,
      matcherAtGrant: entry.matcher ?? null,
      matcherIndexAtGrant: entry.matcherIndex,
      hookIndexAtGrant: entry.hookIndex,
      appVersionAtGrant: "azcode-mobile",
    });
  }
  return out;
}

/**
 * 装配一台"这一轮用"的钩子运行时。没有配置/没有命令桥/装配失败都回 null——
 * 调用方零分支跳过，绝不让"钩子层坏了"变成"对话发不出去"。
 */
export async function createMobileHookRuntime(options: {
  workspacePath: string;
  workspaceIdentity?: string;
  onLifecycleEvent?: (event: MobileHookLifecycleEvent) => void;
  onDiagnostic?: (message: string) => void;
  /** 端侧 home（默认 node:os 的 homedir：真机上是垫片的 "/root"）。
   *  只有自检需要换它——不能拿开发机的真实 home 去读写信任存储。 */
  homeDir?: string;
  /** core bundle 的装载口（默认按出货路径 ../mobile/dist/... 动态 import）。自检注入用。 */
  loadCore?: () => Promise<CoreHooksLike | null>;
}): Promise<MobileHookRuntime | null> {
  const say = options.onDiagnostic ?? (() => {});
  const workspacePath = options.workspacePath;
  const workspaceIdentity = options.workspaceIdentity?.trim() || workspacePath;
  const homeDir = options.homeDir;
  const loadCoreImpl = options.loadCore ?? loadCore;
  const diagnostics: string[] = [];

  // ── 发现：项目级（工作区树）+ 用户级（端侧 home=/root 下的 .zcode/cli/config.json）──
  let projectSources: Awaited<ReturnType<typeof readWorkspaceHookProjectSources>>["sources"] = [];
  try {
    const read = await readWorkspaceHookProjectSources({ workingDirectory: workspacePath });
    projectSources = read.sources;
    for (const error of read.errors) {
      diagnostics.push(`工作区 hook 配置读不动（${error.path}）：${String((error as { error?: unknown }).error ?? "")}`);
    }
  } catch (e) {
    diagnostics.push(`工作区 hook 配置发现失败：${String((e as Error)?.message ?? e)}`);
  }

  const userHooksRead = readUserHooksConfig(homeDir);
  if (userHooksRead.diagnostic) diagnostics.push(userHooksRead.diagnostic);
  const userHooks = userHooksRead.hooks;

  const runtimeRoot = resolveWorkspaceHookRuntimeRoot([userHooks, ...projectSources.map((s) => s.hooks)]);
  const snapshot = buildWorkspaceHookBundleSnapshot({
    workspaceIdentity,
    workspacePath,
    sources: projectSources,
    runtimeRoot,
  });

  // 用户级（config 级）hook：不经过信任审核——它们是用户自己在这台设备的设置里写的。
  // 形状映射到 core 的 HookConfig（timeout 秒 / timeoutMs 两种写法都认）。
  const events: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>> = {};
  if (runtimeRoot.enabled) {
    for (const event of HOOK_EVENT_NAMES) {
      const entries = userHooks?.events?.[event];
      if (!entries || entries.length === 0) continue;
      events[event] = entries.map((matcherConfig) => ({
        ...(matcherConfig.matcher ? { matcher: matcherConfig.matcher } : {}),
        hooks: matcherConfig.hooks
          .filter((hook) => hook.enabled !== false)
          .map((hook) => {
            // 判别联合按 type 收窄（"args" in hook 这种存在性收窄在 passthrough schema 上不给力）。
            const base: Record<string, unknown> = {
              type: hook.type,
              command: hook.command,
              timeoutMs: resolveWorkspaceHookTimeoutMs(hook, runtimeRoot.timeoutMs),
              source: { kind: "user" },
            };
            if (hook.type === "process") {
              if (hook.args) base.args = [...hook.args];
            } else {
              if (hook.async !== undefined) base.async = hook.async;
              if (hook.shell !== undefined) base.shell = hook.shell;
            }
            return base;
          }),
      })).filter((matcherConfig) => matcherConfig.hooks.length > 0);
    }
  }

  const trustedDigests = readTrustedDigests(workspaceIdentity, homeDir);
  const core = await loadCoreImpl();
  if (!core?.createConfiguredHookRunner) {
    say("钩子：core bundle 没暴露 createConfiguredHookRunner，本轮不跑钩子");
    return null;
  }
  const execBridge = core.createNativeExecBridge ? core.createNativeExecBridge() : null;
  if (!execBridge || !core.createMobileExecutionPort) {
    // 没有命令执行桥 = 命令型 hook 跑不了。桌面 harness 里正是这条形状，如实跳过。
    return null;
  }
  const executionPort = core.createMobileExecutionPort({ bridge: execBridge });

  const admission = {
    activate: async () => {},
    evaluateDispatch: (input: { hookDeclarationDigest?: string; reviewItemId?: string }) => {
      const entry = snapshot?.hooks.find((candidate) => candidate.reviewItemId === input.reviewItemId);
      if (!entry || entry.hookDeclarationDigest !== input.hookDeclarationDigest) {
        return { allowed: false as const, reasonCode: "workspace_hooks_snapshot_mismatch" };
      }
      if (trustedDigests.has(entry.hookDeclarationDigest)) return { allowed: true as const };
      return {
        allowed: false as const,
        reasonCode: "workspace_hooks_blocked_untrusted",
        ...(entry.configuredEnabled ? {} : { skipLifecycle: true }),
      };
    },
    getCurrentSnapshot: () => snapshot,
    replaceSnapshot: () => {},
    invalidate: () => {},
  };

  const runner = core.createConfiguredHookRunner({
    config: {
      enabled: runtimeRoot.enabled,
      events,
      timeoutMs: runtimeRoot.timeoutMs,
      maxOutputBytes: runtimeRoot.maxOutputBytes,
    },
    ...(options.onLifecycleEvent
      ? { emitEvent: async (event: MobileHookLifecycleEvent) => options.onLifecycleEvent!(event) }
      : {}),
    executionPort,
    getWorkingDirectory: () => workspacePath,
    ...(snapshot ? { workspaceHookSnapshot: snapshot } : {}),
    workspaceHookAdmission: admission,
  });
  if (!runner) return null;

  return {
    enabled: true,
    diagnostics,
    snapshot,
    run: (event, input, runOptions) =>
      runner.run(
        {
          hookEventName: event,
          sessionId: input.sessionId,
          turnId: input.turnId,
          cwd: input.cwd || workspacePath,
          agentName: "zcode",
          ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
          ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
          ...(input.toolInput !== undefined ? { toolInput: input.toolInput } : {}),
          ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
          ...(input.toolResponse !== undefined ? { toolResponse: input.toolResponse } : {}),
          ...(input.error ? { error: input.error } : {}),
          ...(input.isInterrupt !== undefined ? { isInterrupt: input.isInterrupt } : {}),
          ...(input.responseText !== undefined ? { responseText: input.responseText } : {}),
          ...(input.responsePreview !== undefined ? { responsePreview: input.responsePreview } : {}),
          ...(input.stopHookActive !== undefined ? { stopHookActive: input.stopHookActive } : {}),
          ...(input.permissionSuggestions !== undefined
            ? { permissionSuggestions: input.permissionSuggestions }
            : {}),
          ...(input.mode !== undefined ? { mode: input.mode } : {}),
        },
        runOptions,
      ) as Promise<MobileHookRunResult>,
  };
}

/**
 * 预信任（settings 页「信任」按钮的落点；`grantWorkspaceHookTrust` 端侧实现的后半段）。
 * 语义与桌面一致：重新发现快照 → 校验 digest → 落信任记录；
 * digest 对不上时报 bundle_changed（配置在审核与点击之间变过，不能替用户相信新内容）。
 */
export async function grantWorkspaceHookTrust(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  bundleDigest: string;
  hookDeclarationDigest: string;
  /** 端侧 home 覆盖（自检用；真机走 node:os 垫片的 "/root"）。 */
  homeDir?: string;
}): Promise<{ accepted: boolean; reasonCode?: string }> {
  const workspaceIdentity = params.workspaceIdentity?.trim() || params.workspacePath;
  let sources: Awaited<ReturnType<typeof readWorkspaceHookProjectSources>>["sources"] = [];
  try {
    const read = await readWorkspaceHookProjectSources({ workingDirectory: params.workspacePath });
    sources = read.sources;
  } catch {
    return { accepted: false, reasonCode: "workspace_hooks_config_unreadable" };
  }
  const userHooks = readUserHooksConfig(params.homeDir).hooks;
  const runtimeRoot = resolveWorkspaceHookRuntimeRoot([userHooks, ...sources.map((s) => s.hooks)]);
  const snapshot = buildWorkspaceHookBundleSnapshot({
    workspaceIdentity,
    workspacePath: params.workspacePath,
    sources,
    runtimeRoot,
  });
  if (!snapshot) return { accepted: false, reasonCode: "workspace_hooks_snapshot_mismatch" };
  if (snapshot.bundleDigest !== params.bundleDigest) {
    return { accepted: false, reasonCode: "workspace_hooks_bundle_changed" };
  }
  const records = buildTrustRecords(snapshot, [params.hookDeclarationDigest]);
  if (records.length === 0) return { accepted: false, reasonCode: "workspace_hooks_snapshot_mismatch" };
  try {
    writeTrustedRecords(records, params.homeDir);
  } catch {
    return { accepted: false, reasonCode: "workspace_hooks_config_write_failed" as never };
  }
  return { accepted: true };
}
