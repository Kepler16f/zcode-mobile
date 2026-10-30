import type { AgentSummary, SkillSummary } from "@zcode/shared";
import type { ISkillsService, ISubagentsService } from "@zcode/services";
import type { ModelTarget, ModelToolCall, ModelToolSpec, ModelTurnMessage } from "./model-stream.js";
import { streamModelCompletionWithRetry } from "./model-stream.js";
import { resolveModelTarget, type ModelTargetResolver } from "./provider-target.js";
import type { ToolRunResult } from "./tool-engine.js";

type ExecutionMode = "build" | "edit" | "plan" | "yolo";
type DiscoverArgs = { workspacePath: string; workspaceIdentity?: string };
type Services = { skillsService: ISkillsService; subagentsService: ISubagentsService };
type Completion = typeof streamModelCompletionWithRetry;

/** 父 Agent 是 Hook、审批和工作区访问的唯一执行入口，子代理不能直接调用底层工具引擎。 */
export type ExecuteSubagentTool = (call: ModelToolCall, context: {
  mode: ExecutionMode;
  allowedToolNames: readonly string[];
  signal?: AbortSignal;
  agentId: string;
}) => Promise<ToolRunResult>;

export const SKILL_TOOL: ModelToolSpec = {
  name: "Skill",
  description: "Load the instructions of an available enabled skill into this conversation. Use its exact name from the skill catalog.",
  parameters: { type: "object", properties: { skill: { type: "string" }, args: { type: "string" } }, required: ["skill"], additionalProperties: false },
};

export const AGENT_TOOL: ModelToolSpec = {
  name: "Agent",
  description: "Run an enabled subagent and receive its result. Give it a self-contained prompt; its tool calls use the same permission and workspace controls. With run_in_background=true the subagent keeps running after this call returns and its outcome is reported back into the conversation. Set resume to the agentId of an earlier subagent run to continue that subagent instead of starting a new one.",
  parameters: { type: "object", properties: {
    prompt: { type: "string" }, description: { type: "string" }, subagent_type: { type: "string" },
    run_in_background: { type: "boolean" }, resume: { type: "string" },
  }, required: ["prompt"], additionalProperties: false },
};

/**
 * 后台子代理的运行句柄。调用方（Agent 服务）用它取消后台任务，并在任务结束时收口子会话。
 * 句柄由本次 Agent 调用生成，唯一所有者是 Agent 服务；技能/子代理设置服务不持有运行状态。
 */
export interface MobileSubagentBackgroundHandle {
  /** 子会话 id（同时是这次子代理 transcript 的标识）。 */
  id: string;
  agentType: string;
  prompt: string;
  /** 后台子代理的取消闸：父轮停止、用户停止、工作区释放都会 abort 它。 */
  controller: AbortController;
  /** 实际生效的取消信号（父轮信号与上面的闸合成）；用它判「被取消」而不是「失败」。 */
  signal: AbortSignal;
  /** 实际运行结果；完成/失败/取消都会 resolve（不 reject），由调用方统一收口。 */
  done: Promise<ToolRunResult>;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function canonicalSkillName(skill: SkillSummary): string {
  return skill.scope === "plugin" && skill.pluginName ? `${skill.pluginName}:${skill.name}` : skill.name;
}

function matchSkill(skills: readonly SkillSummary[], name: string): SkillSummary {
  const matches = skills.filter(skill => skill.enabled && canonicalSkillName(skill).toLowerCase() === name.toLowerCase());
  if (matches.length === 0) throw new Error(`技能「${name}」未找到或未启用。`);
  if (matches.length > 1) throw new Error(`技能「${name}」存在多个来源，无法安全确定要加载哪一个。`);
  return matches[0]!;
}

function skillContent(skill: SkillSummary, args = ""): string {
  // 目录只从发现服务返回，模型不能传入路径；预留工具回包预算，避免父循环再次截断掉提示。
  const base = skill.path.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
  const content = skill.body.replace(/\$\{(?:CLAUDE_SKILL_DIR|ZCODE_SKILL_DIR)\}/g, base);
  const maxChars = 18_000;
  const truncated = content.length > maxChars;
  return [
    `<skill_content name="${xml(canonicalSkillName(skill))}">`,
    content.slice(0, maxChars),
    ...(args ? [`Arguments: ${args}`] : []),
    `Base directory for this skill: ${base}`,
    "Relative paths in this skill are relative to this base directory.",
    ...(truncated ? ["[Skill content truncated]"] : []),
    "</skill_content>",
  ].join("\n");
}

function parseObject(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("工具参数必须是 JSON 对象。");
  return parsed as Record<string, unknown>;
}

export async function discoverMobileCapabilities(services: Services, context: DiscoverArgs, prompt: string) {
  // 上游列表同时供设置页与 Agent 使用，避免设置关闭了但另一份缓存仍能执行。
  const [skillResult, agentResult] = await Promise.all([
    services.skillsService.list(context),
    services.subagentsService.list({ ...context, mode: "allRuntimeScopes" }),
  ]);
  const skills = skillResult.skills.filter(skill => skill.enabled);
  const agents = agentResult.agents.filter(agent => agent.enabled);
  const mentioned = new Set<string>();
  for (const match of prompt.matchAll(/\$([a-z0-9][a-z0-9_:-]*)/gi)) {
    if (match[1]) mentioned.add(match[1].toLowerCase());
  }
  const activated = [...mentioned].flatMap(name => {
    const matches = skills.filter(skill => canonicalSkillName(skill).toLowerCase() === name);
    if (matches.length > 1) throw new Error(`技能「${name}」存在多个来源，无法安全确定引用。`);
    return matches;
  });
  const catalog = [
    "<available_skills>",
    ...skills.map(skill => `<skill name="${xml(canonicalSkillName(skill))}" description="${xml(skill.description)}" path="${xml(skill.path)}" />`),
    "</available_skills>",
    "Use Skill to load the full instructions before applying a listed skill.",
    "<available_subagents>",
    ...agents.map(agent => `<agent name="${xml(agent.name)}" description="${xml(agent.description)}" />`),
    "</available_subagents>",
    ...activated.map(skill => skillContent(skill)),
  ].join("\n");
  return { skills, agents, catalog, activatedSkillNames: activated.map(canonicalSkillName), diagnostics: [...skillResult.diagnostics, ...(agentResult.diagnostics ?? [])] };
}

export function executeMobileSkill(skills: readonly SkillSummary[], rawArguments: string): ToolRunResult {
  try {
    const input = parseObject(rawArguments);
    const name = typeof input.skill === "string" ? input.skill.trim() : "";
    if (!name) throw new Error("Skill 需要 skill 名称。");
    const args = typeof input.args === "string" ? input.args.slice(0, 1000) : "";
    return { content: skillContent(matchSkill(skills, name), args), isError: false };
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    return { content: message, isError: true, errorCode: "mobile.skillUnavailable", errorMessage: message };
  }
}

function allowedByProfile(tool: string, profile: AgentSummary): boolean {
  function matches(patterns: readonly string[] | undefined): boolean {
    return Boolean(patterns?.some(pattern => pattern === "*" || pattern.toLowerCase() === tool.toLowerCase()));
  }
  // 模式带条件时不能简单当成完整工具名放行，否则 Bash(git status) 会变成任意 Bash。
  for (const pattern of [...(profile.tools ?? []), ...(profile.disallowedTools ?? [])]) {
    if (pattern !== "*" && !/^[a-z0-9_.:-]+$/i.test(pattern)) throw new Error(`移动子代理暂不支持工具条件模式「${pattern}」。`);
  }
  if (matches(profile.disallowedTools)) return false;
  return !profile.tools?.length || matches(profile.tools);
}

function modeAllows(call: ModelToolCall, mode: ExecutionMode): boolean {
  if (mode !== "plan") return true;
  if (["Read", "Glob", "Grep", "Skill"].includes(call.name)) return true;
  // 计划模式不能由子代理调用未知或可能写入的工具绕过父轮的闸门。
  if (call.name !== "Fetch" && call.name !== "Git") return false;
  try {
    const input = parseObject(call.arguments);
    if (call.name === "Fetch") return input.action === "fetch";
    if (input.action === "status" || input.action === "log") return true;
    if (input.action === "branch") return typeof input.ref !== "string" || !input.ref.trim();
    if (input.action === "remote") return typeof input.url !== "string" || !input.url.trim();
  } catch { /* 无法解析时不能确认只读。 */ }
  return false;
}

/**
 * 可续接的子代理运行记录。持有上一次子代理的 transcript（同一份数组，继续跑时原地增长）。
 * 所有者是 Agent 服务；进程结束即失效——端侧没有把这份 transcript 落盘的形状，
 * 所以「重启后继续上次的子代理」在本轮明确不支持（续接失败会如实报错）。
 */
export interface MobileSubagentResume {
  /** 子会话 id（= agentId）。 */
  agentId: string;
  /** 上一次用的 profile 名。 */
  agentType: string;
  /** 上一次的 transcript（system + user + assistant/tool 往返）。 */
  messages: ModelTurnMessage[];
}

export async function runMobileSubagent(options: {
  rawArguments: string;
  agents: readonly AgentSummary[];
  skills: readonly SkillSummary[];
  workspacePath: string;
  mode: ExecutionMode;
  parentTarget: ModelTarget;
  modelTargets: ModelTargetResolver;
  availableTools: readonly ModelToolSpec[];
  executeTool: ExecuteSubagentTool;
  signal?: AbortSignal;
  loadAgentsMd?: (workspacePath: string) => Promise<string>;
  complete?: Completion;
  onProgress?: (message: string) => void;
  onStarted?: (info: { id: string; agentType: string; prompt: string; target: ModelTarget; resumed?: boolean }) => void;
  onAssistant?: (text: string) => void;
  onTextDelta?: (text: string) => void;
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  /**
   * 后台执行：把运行句柄交给调用方。父轮不等它跑完，调用方负责取消与收口。
   * 前台路径不触发这个回调。
   */
  onBackground?: (handle: MobileSubagentBackgroundHandle) => void;
  /**
   * 续接：调用方已经找到上一次子代理的运行记录。给了就沿用它的 transcript 与子会话 id，
   * 把这次 prompt 接在后面继续；没给而模型又要续接，如实报错而不是新开一个假装是续接。
   */
  resume?: MobileSubagentResume;
  /** 把本次使用的 transcript 交回调用方保存（续接要靠它）。 */
  onTranscript?: (resume: MobileSubagentResume) => void;
}): Promise<ToolRunResult> {
  // 失败结果只有一份形状：前台直接返回，后台由 promise resolve 出同一形状，
  // 调用方不必区分「抛错」与「返回 isError」两条收口路径。
  const failure = (error: unknown, signal?: AbortSignal): ToolRunResult => {
    const message = String((error as Error)?.message ?? error);
    return {
      content: message,
      isError: true,
      errorCode: signal?.aborted ? "mobile.subagentCancelled" : "mobile.subagentFailed",
      errorMessage: message,
    };
  };
  try {
    const input = parseObject(options.rawArguments);
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    const requestedType = typeof input.subagent_type === "string" && input.subagent_type.trim() ? input.subagent_type.trim() : "";
    // 续接：模型给的是上一次子代理的 agentId。记录不在了就如实报错——端侧没有把子代理
    // transcript 落盘的形状，进程重启后无法续接，不能新开一个假装是续接。
    const resumeId = typeof input.resume === "string" ? input.resume.trim() : "";
    if (input.resume !== undefined && !resumeId) throw new Error("Agent 的 resume 需要上一次子代理的 agentId。");
    const resume = options.resume;
    if (resumeId && !resume) {
      throw new Error(`无法续接子代理会话「${resumeId}」：该子代理已不在本次运行中（进程重启后不可续接），请新建一次子代理任务。`);
    }
    if (resume && requestedType && requestedType.toLowerCase() !== resume.agentType.toLowerCase()) {
      throw new Error(`要续接的是子代理「${resume.agentType}」，与本次指定的「${requestedType}」不一致。`);
    }
    const agentType = resume ? resume.agentType : (requestedType || "general-purpose");
    if (!prompt) throw new Error("Agent 需要非空 prompt。");
    const profiles = options.agents.filter(agent => agent.enabled && agent.name.toLowerCase() === agentType.toLowerCase());
    if (profiles.length !== 1) throw new Error(profiles.length ? `子代理「${agentType}」名称有歧义。` : `子代理「${agentType}」未找到或未启用。`);
    const profile = profiles[0]!;
    if (profile.mcpServers?.length) throw new Error("此子代理配置了独立 MCP server，移动端暂不支持该配置。");
    // 后台：调用方显式要求，或该 profile 本身声明为后台代理（显式 false 可覆盖）。
    const background = input.run_in_background === true || (profile.background === true && input.run_in_background !== false);
    // 内置 Explore 的描述承诺只读；其上游工具清单含 Bash，不能沿用父轮的写入权限。
    const readOnlyExplore = profile.scope === "built-in" && profile.name.toLowerCase() === "explore";
    const mode = options.mode === "plan" || profile.permissionMode === "plan" || readOnlyExplore ? "plan" : options.mode;
    const target = profile.modelSelection ? await resolveModelTarget(options.modelTargets, profile.modelSelection) : options.parentTarget;
    allowedByProfile("__validate__", profile);
    const tools = options.availableTools.filter(tool => tool.name !== "Agent" && allowedByProfile(tool.name, profile) &&
      (mode !== "plan" || ["Read", "Glob", "Grep", "Skill", "Fetch", "Git"].includes(tool.name)));
    const allowedToolNames = tools.map(tool => tool.name);
    let instructions = profile.systemPrompt;
    if (profile.injectAgentsMd) {
      if (!options.loadAgentsMd) throw new Error("此子代理要求加载 AGENTS.md，但当前运行时没有工作区指令读取器。");
      instructions += `

${await options.loadAgentsMd(options.workspacePath)}`;
    }
    for (const name of profile.skills ?? []) instructions += `

${skillContent(matchSkill(options.skills, name))}`;
    const systemMessage: ModelTurnMessage = {
      role: "system",
      content: `${instructions}
Workspace: ${options.workspacePath}
Execution mode: ${mode}. Follow workspace and user permissions. You are a subagent; report the actual result.`,
    };
    // 续接沿用上一次的 transcript（同一个数组，继续跑时原地增长）：只换掉系统提示，
    // 再把这次的输入接在后面——子代理因此记得上一次做到哪一步。
    const messages: ModelTurnMessage[] = resume ? resume.messages : [systemMessage, { role: "user", content: prompt }];
    if (resume) {
      messages[0] = systemMessage;
      messages.push({ role: "user", content: prompt });
    }
    const id = resume
      ? resume.agentId
      : `mobile-subagent-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
    const started = Date.now();
    options.onStarted?.({ id, agentType: profile.name, prompt, target, resumed: Boolean(resume) });
    // transcript 交回调用方保存：下一次续接要靠它。
    options.onTranscript?.({ agentId: id, agentType: profile.name, messages });
    let uses = 0, inputTokens = 0, outputTokens = 0, repeatedError = "", repeatedCount = 0;
    const complete = options.complete ?? streamModelCompletionWithRetry;

    /**
     * 子代理的模型循环。前台与后台跑的是同一份循环——后台只是把它的取消闸换成
     * 「父轮信号 + 后台自己的闸」，因此模式约束、工具白名单、审批入口逐字一致。
     */
    const runLoop = async (signal: AbortSignal | undefined): Promise<ToolRunResult> => {
      for (let turn = 0; ; turn++) {
        if (signal?.aborted) throw new DOMException("子代理已取消", "AbortError");
        if (profile.maxTurns && turn >= profile.maxTurns) throw new Error(`子代理达到 profile 的 ${profile.maxTurns} 轮上限。`);
        const result = await complete({ target, messages, signal, ...(tools.length ? { tools } : {}), onDelta: text => options.onTextDelta?.(text),
          maxOutputTokens: Math.min(16_384, target.maxOutputTokensCap ?? 16_384, target.contextWindow ? Math.max(1, Math.floor(target.contextWindow / 4)) : 16_384) });
        if (signal?.aborted) throw new DOMException("子代理已取消", "AbortError");
        inputTokens += result.usage?.inputTokens ?? 0;
        outputTokens += result.usage?.outputTokens ?? 0;
        options.onUsage?.({ inputTokens, outputTokens });
        if (result.text) options.onAssistant?.(result.text);
        if (!result.toolCalls.length) {
          if (result.truncated || result.finishReason === "length" || result.finishReason === "max_tokens") throw new Error("子代理的回答被截断，不能当作完整结果。");
          if (!result.text.trim()) throw new Error("子代理没有返回正文。");
          // 结论也要进 transcript：续接时子代理得记得上一次自己说了什么，
          // 否则它只会看到「上次让我做什么」，看不到「上次我做到了哪」。
          messages.push({ role: "assistant", content: result.text });
          return { content: JSON.stringify({ status: "completed", agentId: id, agentType: profile.name, prompt,
            content: [{ type: "text", text: result.text }], totalToolUseCount: uses, totalDurationMs: Date.now() - started,
            usage: { inputTokens, outputTokens } }), isError: false };
        }
        // 部分兼容网关省略工具调用 ID；补齐后必须同时写入 assistant 调用和 tool 结果。
        const calls = result.toolCalls.map((call, index) => ({
          ...call,
          id: call.id || `${id}-tool-${uses + index + 1}`,
        }));
        messages.push({ role: "assistant", content: result.text, toolCalls: calls });
        for (const call of calls) {
          if (signal?.aborted) throw new DOMException("子代理已取消", "AbortError");
          uses++;
          let outcome: ToolRunResult;
          if (!allowedToolNames.includes(call.name) || !modeAllows(call, mode)) {
            outcome = { isError: true, content: `子代理未获准使用 ${call.name}（profile 或执行模式限制）。` };
          } else {
            // 调用者必须接回父会话的 Hook/审批/授权链，不能以直接 engine.execute 替代。
            outcome = await options.executeTool(call, { mode, allowedToolNames, signal, agentId: id });
          }
          const rawContent = outcome.isError ? `工具执行失败：${outcome.content}` : outcome.content;
          const content = rawContent.length > 20_000 ? `${rawContent.slice(0, 20_000)}
[工具结果已截断]` : rawContent;
          messages.push({ role: "tool", toolCallId: call.id, content });
          options.onProgress?.(`${profile.name}: ${call.name} ${outcome.isError ? "失败" : "完成"}`);
          const signature = outcome.isError ? `${call.name}:${call.arguments}:${content.slice(0, 160)}` : "";
          if (signature && signature === repeatedError) repeatedCount++;
          else { repeatedError = signature; repeatedCount = signature ? 1 : 0; }
          if (repeatedCount >= 4) throw new Error("子代理重复执行同一失败工具，已停止。 ");
        }
      }
    };

    if (background) {
      // 后台子代理的取消闸 = 父轮信号（父轮被停止时子代理跟着停）+ 它自己的闸
      //（父轮已经收口后，用户点「停止」或工作区释放时用后者）。
      const controller = new AbortController();
      const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
      const done = runLoop(signal).catch(error => failure(error, signal));
      options.onBackground?.({ id, agentType: profile.name, prompt, controller, signal, done });
      return { content: JSON.stringify({ status: "running", agentId: id, agentType: profile.name, prompt,
        message: "子代理已在后台启动；它完成或失败后会回填到这条对话。" }), isError: false };
    }
    return await runLoop(options.signal);
  } catch (error) {
    return failure(error, options.signal);
  }
}
