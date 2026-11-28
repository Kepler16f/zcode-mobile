// 官方 CLI 对话请求的 system 三段结构（0.13.0，对齐官方 4.0.0 实测请求）。
//
// 地面真相（2026-11-28，官方 4.0.0 CLI 经 fetch-hook 抓包 D:/Zcode/tmp/official-dump2）：
// 官方对话请求走 /api/v1/ultra[/ultra-zai]/anthropic/v1/messages（agent/configs 下发
// proxyEndpoint.mapping），system 是三个 text block：
//   block[0] cli_prefix = "You are ZCode, an interactive agent"（4.0.0 无 "coding"！
//             仓库旧版源码是 3.x 的 "interactive coding agent"——抄旧版就是 3012）
//   block[1] identity   = "\n" + 4.0.0 intro（"You are an agent working with the user
//             toward their goals, using your own judgment along the way."）+ SECURITY_NOTICE
//             + "# Harness"（行首是 " - " 带前导空格）+ cache ephemeral
//   block[2] dynamic    = "\n\n" + 4.0.0 dynamic（"Write code that reads like..." 开头，
//             pronouns 段、For actions 段、# Context management）+ cache ephemeral
// 网关校验锚点必然是稳定段（block[0] 精确 + block[1] 稳定），block[2] 里官方自己就带
// 会话特有的 Memory 路径（每次不同）——端侧的安卓附加说明拼在这里是安全的。
//
// 官方 ultra 请求头（对齐目标）：anthropic-beta: mid-conversation-system-2026-04-07、
// 双腿 auth、三段 UA（ZCode/<ver> ai-sdk/provider-utils/<utils> runtime/node.js/<node>——
// **无 ai-sdk/anthropic 段**）、x-platform 真实值。签名防伪（x-client-sig/pow）另见
// ultra 签名链路实现。

/** 官方 4.0.0 bundle 的 cli_prefix（boc），逐字。 */
export const OFFICIAL_CLI_PREFIX_TEXT = "You are ZCode, an interactive agent";

/** 官方 4.0.0 SECURITY_NOTICE（MKo），逐字。 */
const OFFICIAL_SECURITY_NOTICE =
  "IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.";

/**
 * 官方 4.0.0 identity 段（koc 无 outputStyle 分支）：["", Soc intro, "", MKo].join("\n")
 * + "\n\n" + T3n Harness（" - " 前导空格行）。逐字。
 */
const OFFICIAL_IDENTITY_BODY = [
  "",
  "You are an agent working with the user toward their goals, using your own judgment along the way.",
  "",
  OFFICIAL_SECURITY_NOTICE,
  "",
  "# Harness",
  " - Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.",
  " - Tools run behind a user-selected permission mode; a denied call means the user declined it \u2014 adjust, don't retry verbatim.",
  " - The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.",
  " - Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.",
  " - Reference code as `file_path:line_number` \u2014 it's clickable.",
].join("\n");

/**
 * 官方 4.0.0 dynamic 段基线（实测 dump 抽取，逐字）："Write code that reads like..."
 * 开头（旧版 COMMUNICATION_PROMPTS.default 升格为段首）+ pronouns 段 + For actions 段
 * + # Context management。官方在此之后还会注入会话特有段（# Session-specific guidance /
 * # Memory / # Finishing work / # Memory, notes and feedback）——端侧的安卓附加说明
 * 占同一位置（会话特有注入点），不进基线。
 */
const OFFICIAL_DYNAMIC_BASE = [
  "Write code that reads like the surrounding code: match its comment density, naming, and idiom.",
  "",
  "When you use a pronoun for someone \u2014 the user or anyone else you mention \u2014 and their pronouns haven't been stated, use they/them. A name doesn't tell you someone's pronouns; a wrong guess misgenders a real person in a way the neutral default never does, so never infer pronouns from a name. This applies to all user-visible text, including visible thinking.",
  "",
  "For actions that are hard to reverse or outward-facing, confirm first unless durably authorized or explicitly told to proceed without asking; approval in one context doesn't extend to the next. Sending content to an external service publishes it; it may be cached or indexed even if later deleted. Before deleting or overwriting, look at the target. Report outcomes faithfully: if tests fail, say so with the output; if a step was skipped, say that; when something is done and verified, state it plainly without hedging.",
  "",
  "# Context management",
  "When the conversation grows long, some or all of the current context is summarized; the summary, along with any remaining unsummarized context, is provided in the next context window so work can continue \u2014 you don't need to wrap up early or hand off mid-task.",
].join("\n");

/** 端侧环境事实（EnvInfo 形状对齐官方 4.0.0 labels，git 段不伪造）。 */
export interface OfficialEnvFacts {
  cwd: string;
  platform: string;
  shell: string;
  osVersion: string;
  model?: string;
}

/** 官方 4.0.0 环境段（labels 与 env-info.ts 4.0.0 同源），git 段省略。 */
export function buildOfficialEnvInfo(env: OfficialEnvFacts): string {
  const lines = [
    "# Environment",
    "You have been invoked in the following environment:",
    `- Primary working directory: ${env.cwd}`,
    "- Is a git repository: no",
    `- Platform: ${env.platform}`,
    `- Shell: ${env.shell}`,
    `- OS Version: ${env.osVersion}`,
    ...(env.model ? [`- You are powered by the model named ${env.model}.`] : []),
  ];
  return lines.join("\n");
}

/**
 * 官方对话请求的 system 三段。mobileNotes 是端侧的会话附加说明（workspace 真路径、
 * 全文件访问、执行模式——agent.ts systemPrompt 的输出），拼在 dynamic 块尾部（官方
 * 会话特有段同一位置）；官方身份段在前过网关校验，端侧功能语义在后。
 */
export function buildOfficialConversationSystemSegments(input: {
  env: OfficialEnvFacts;
  mobileNotes: string;
}): readonly string[] {
  const notes = input.mobileNotes.trim();
  return [
    OFFICIAL_CLI_PREFIX_TEXT,
    OFFICIAL_IDENTITY_BODY,
    `\n\n${OFFICIAL_DYNAMIC_BASE}\n\n${buildOfficialEnvInfo(input.env)}${notes ? `\n\n${notes}` : ""}`,
  ];
}
