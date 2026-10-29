// 上下文压缩的纯逻辑（0.8.4）：摘要提示词、分段规划、失败分类。
//
// 为什么单独一个文件：这几步要能脱离 agent.ts 自检（分段边界、预算算式、错误分类
// 都是纯函数），也让 agent.ts 里那段压缩逻辑保持可读。
//
// 与桌面端的对齐关系（参考 zcode/apps/zcode-cli/packages/core/src/compact/）：
//   - 桌面按"助手起头的完整轮次"切段、按轮次生成摘要（rounds.ts / compact-selection.ts）；
//     端侧按 turnId 切，语义一致：摘要边界永远落在完整轮次之间。
//   - 桌面在摘要请求本身装不下时，会把更早的轮次**丢掉**再重试
//     （compact-selection.ts 的 selectCompactEntriesAfterPromptTooLong）。
//     端侧不这么做——丢掉更早的轮次等于悄悄丢历史。端侧改成**分段摘要**：
//     装不下就分几次摘要，前一次的摘要带进后一次，每段都装得下，历史一条不丢。

/**
 * 摘要系统提示（桌面 BASE_COMPACT_PROMPT 的端侧精简版）：
 * 同样的结构化要求（请求与约束 / 决策与事实 / 已完成 / 报错与修复 / 待办 / 当前工作 / 下一步），
 * 加上桌面端同款的"只输出文本、不要调工具"约束——端侧拿到工具调用会判摘要不完整。
 */
export const COMPACT_SUMMARY_SYSTEM_PROMPT = [
  "You are a context-compaction engine. Write a detailed handoff so another assistant can continue this work without the original transcript.",
  "",
  "Rules:",
  "- TEXT ONLY. Do not call any tool, do not ask questions, do not continue the task itself.",
  "- Keep the user's own language when quoting their requests and constraints.",
  "- Preserve exactly: the user's explicit goals and constraints, their corrections and your decisions, file paths / symbols / commands, important tool findings, completed and pending work, promises, and any security-relevant instruction (verbatim).",
  "- Never invent facts. If a detail is not in the conversation, say that it is missing.",
  "",
  "Output these sections in order:",
  "1. User's requests and constraints (every user message that is not a tool result)",
  "2. Key decisions and technical facts (paths, symbols, commands, interfaces)",
  "3. Work completed so far (file names and short code excerpts)",
  "4. Errors hit and how they were fixed",
  "5. Open problems and pending tasks",
  "6. Work in progress at the moment of summarization",
  "7. Next step, only when the latest request implies it",
].join("\n");

/** 摘要请求的最后一条：告诉模型"把上面这些压成摘要"。 */
export const COMPACT_SUMMARY_USER_INSTRUCTION = "Compress everything above into the summary notes now.";

/** 摘要进上下文时的前缀说明：让模型知道更早的原文已被压缩，别编造细节。 */
export function compactSummaryPrefix(summary: string): string {
  return (
    "[上下文压缩摘要] 此前的对话已按下述摘要压缩（早期原文不再逐字提供）。" +
    "把摘要当作既定事实的背景，不要向用户复述这条说明本身：\n" +
    summary
  );
}

/** 一次压缩最多分几段摘要。再多就说明单段就装不下，如实失败，不无限切。 */
export const MAX_COMPACT_PASSES = 8;

/**
 * 把"要压掉的早期段"按整轮切块，每块估出来的 token 不超 budget。
 * 返回每块覆盖的轮次下标区间 [start, end)。
 *
 * 单轮就超预算时它自己成一块（start === end - 1）——轮次不可再分，交给调用方按
 * 明确失败处理，不在这里悄悄丢掉这一轮。
 */
export function planCompactPasses(turnCosts: number[], budgetTokens: number): Array<{ start: number; end: number }> {
  const passes: Array<{ start: number; end: number }> = [];
  let start = 0;
  while (start < turnCosts.length) {
    const count = Math.max(1, planCompactPass(turnCosts.slice(start), budgetTokens));
    passes.push({ start, end: start + count });
    start += count;
  }
  return passes;
}

/**
 * 一段摘要能装下多少轮：返回这段覆盖的轮次数（至少 1）。
 * 调用方按"当前前缀摘要的实际体积"逐段推进——前缀会变长，预算也跟着变。
 */
export function planCompactPass(turnCosts: number[], budgetTokens: number): number {
  const budget = Math.max(1, budgetTokens);
  let used = 0;
  let count = 0;
  for (const cost of turnCosts) {
    const value = Math.max(0, cost);
    if (count > 0 && used + value > budget) break;
    used += value;
    count += 1;
    if (used >= budget) break;
  }
  return count;
}

/** 摘要请求失败时：是不是"装不下"（上下文超限 / 附件太大）。 */
export function isCompactTooLargeError(error: unknown): boolean {
  const code = readErrorCode(error);
  const message = readErrorMessage(error);
  if (code === "model.attachmentTooLarge") return true;
  if (code !== "model.http.400" && code !== "model.http.413" && code !== "model.http.422") return false;
  return /context|上下文|token|too large|payload|长度|超出|上限|窗口/i.test(message);
}

function readErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const code = (error as { reasonCode?: unknown }).reasonCode;
  return typeof code === "string" ? code : "";
}

function readErrorMessage(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error ?? "");
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : String(error ?? "");
}
