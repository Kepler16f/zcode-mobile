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
  description: "Run an enabled subagent in the foreground and receive its result. Give it a self-contained prompt; its tool calls use the same permission and workspace controls. Background and resume are unavailable.",
  parameters: { type: "object", properties: {
    prompt: { type: "string" }, description: { type: "string" }, subagent_type: { type: "string" },
    run_in_background: { type: "boolean", enum: [false] },
  }, required: ["prompt"], additionalProperties: false },
};

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
  onStarted?: (info: { id: string; agentType: string; prompt: string; target: ModelTarget }) => void;
  onAssistant?: (text: string) => void;
  onTextDelta?: (text: string) => void;
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
}): Promise<ToolRunResult> {
  try {
    const input = parseObject(options.rawArguments);
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    const agentType = typeof input.subagent_type === "string" && input.subagent_type.trim() ? input.subagent_type.trim() : "general-purpose";
    if (!prompt) throw new Error("Agent 需要非空 prompt。");
    if (input.run_in_background === true || input.resume !== undefined) throw new Error("移动端暂不支持后台子代理或续接，请使用前台新任务。");
    const profiles = options.agents.filter(agent => agent.enabled && agent.name.toLowerCase() === agentType.toLowerCase());
    if (profiles.length !== 1) throw new Error(profiles.length ? `子代理「${agentType}」名称有歧义。` : `子代理「${agentType}」未找到或未启用。`);
    const profile = profiles[0]!;
    if (profile.mcpServers?.length) throw new Error("此子代理配置了独立 MCP server，移动端暂不支持该配置。");
    if (profile.background) throw new Error("此子代理配置为后台运行，移动端暂不支持后台子代理。");
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
      instructions += `\n\n${await options.loadAgentsMd(options.workspacePath)}`;
    }
    for (const name of profile.skills ?? []) instructions += `\n\n${skillContent(matchSkill(options.skills, name))}`;
    const messages: ModelTurnMessage[] = [
      { role: "system", content: `${instructions}\nWorkspace: ${options.workspacePath}\nExecution mode: ${mode}. Follow workspace and user permissions. You are a subagent; report the actual result.` },
      { role: "user", content: prompt },
    ];
    const id = `mobile-subagent-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
    const started = Date.now();
    options.onStarted?.({ id, agentType: profile.name, prompt, target });
    let uses = 0, inputTokens = 0, outputTokens = 0, repeatedError = "", repeatedCount = 0;
    const complete = options.complete ?? streamModelCompletionWithRetry;
    for (let turn = 0; ; turn++) {
      if (options.signal?.aborted) throw new DOMException("子代理已取消", "AbortError");
      if (profile.maxTurns && turn >= profile.maxTurns) throw new Error(`子代理达到 profile 的 ${profile.maxTurns} 轮上限。`);
      const result = await complete({ target, messages, signal: options.signal, ...(tools.length ? { tools } : {}), onDelta: text => options.onTextDelta?.(text),
        maxOutputTokens: Math.min(16_384, target.maxOutputTokensCap ?? 16_384, target.contextWindow ? Math.max(1, Math.floor(target.contextWindow / 4)) : 16_384) });
      if (options.signal?.aborted) throw new DOMException("子代理已取消", "AbortError");
      inputTokens += result.usage?.inputTokens ?? 0;
      outputTokens += result.usage?.outputTokens ?? 0;
      options.onUsage?.({ inputTokens, outputTokens });
      if (result.text) options.onAssistant?.(result.text);
      if (!result.toolCalls.length) {
        if (result.truncated || result.finishReason === "length" || result.finishReason === "max_tokens") throw new Error("子代理的回答被截断，不能当作完整结果。");
        if (!result.text.trim()) throw new Error("子代理没有返回正文。");
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
        if (options.signal?.aborted) throw new DOMException("子代理已取消", "AbortError");
        uses++;
        let outcome: ToolRunResult;
        if (!allowedToolNames.includes(call.name) || !modeAllows(call, mode)) {
          outcome = { isError: true, content: `子代理未获准使用 ${call.name}（profile 或执行模式限制）。` };
        } else {
          // 调用者必须接回父会话的 Hook/审批/授权链，不能以直接 engine.execute 替代。
          outcome = await options.executeTool(call, { mode, allowedToolNames, signal: options.signal, agentId: id });
        }
        const rawContent = outcome.isError ? `工具执行失败：${outcome.content}` : outcome.content;
        const content = rawContent.length > 20_000 ? `${rawContent.slice(0, 20_000)}\n[工具结果已截断]` : rawContent;
        messages.push({ role: "tool", toolCallId: call.id, content });
        options.onProgress?.(`${profile.name}: ${call.name} ${outcome.isError ? "失败" : "完成"}`);
        const signature = outcome.isError ? `${call.name}:${call.arguments}:${content.slice(0, 160)}` : "";
        if (signature && signature === repeatedError) repeatedCount++;
        else { repeatedError = signature; repeatedCount = signature ? 1 : 0; }
        if (repeatedCount >= 4) throw new Error("子代理重复执行同一失败工具，已停止。 ");
      }
    }
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    return { content: message, isError: true, errorCode: options.signal?.aborted ? "mobile.subagentCancelled" : "mobile.subagentFailed", errorMessage: message };
  }
}
