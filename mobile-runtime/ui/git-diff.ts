import type { GitDiffResult } from "@zcode/shared";

type Op = { kind: " " | "+" | "-"; line: string };
export type MobileGitVersion = { oid: string; mode: number; type: string; bytes?: Uint8Array };
const MAX_BYTES = 1024 * 1024;
class DiffBudgetExceeded extends Error {}

// 行 token 带末尾换行；否则仅增删 EOF 换行时会被误判为相同文本。
function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function compare(before: string[], after: string[]): Op[] {
  if (before.length + after.length > 50_000) throw new DiffBudgetExceeded();
  let start = 0, end = 0;
  while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;
  while (end < Math.min(before.length, after.length) - start && before[before.length - end - 1] === after[after.length - end - 1]) end++;
  const a = before.slice(start, before.length - end), b = after.slice(start, after.length - end);
  const prefix: Op[] = before.slice(0, start).map(line => ({ kind: " ", line }));
  const suffix: Op[] = before.slice(before.length - end).map(line => ({ kind: " ", line }));
  if (!a.length || !b.length) return [...prefix, ...a.map(line => ({ kind: "-" as const, line })), ...b.map(line => ({ kind: "+" as const, line })), ...suffix];
  const trace: Map<number, number>[] = [];
  const frontier = new Map<number, number>([[1, 0]]);
  let cells = 0, work = 0;
  // Myers 的回溯空间随编辑距离平方增长；预算耗尽明确降级，避免手机主线程失去响应。
  for (let d = 0; d <= a.length + b.length; d++) {
    cells += frontier.size;
    if (cells > 250_000) throw new DiffBudgetExceeded();
    trace.push(new Map(frontier));
    for (let k = -d; k <= d; k += 2) {
      if (++work > 2_000_000) throw new DiffBudgetExceeded();
      const left = frontier.get(k - 1) ?? -Infinity, right = frontier.get(k + 1) ?? -Infinity;
      let x = k === -d || (k !== d && left < right) ? right : left + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) {
        x++; y++;
        if (++work > 2_000_000) throw new DiffBudgetExceeded();
      }
      frontier.set(k, x);
      if (x < a.length || y < b.length) continue;
      const reversed: Op[] = [];
      for (let depth = d; depth >= 0; depth--) {
        const previous = trace[depth]!;
        const diagonal = x - y;
        const previousK = diagonal === -depth || (diagonal !== depth && (previous.get(diagonal - 1) ?? -Infinity) < (previous.get(diagonal + 1) ?? -Infinity)) ? diagonal + 1 : diagonal - 1;
        const previousX = previous.get(previousK) ?? 0, previousY = previousX - previousK;
        while (x > previousX && y > previousY) {
          reversed.push({ kind: " ", line: a[--x]! });
          y--;
        }
        if (depth === 0) break;
        if (x === previousX) reversed.push({ kind: "+", line: b[--y]! });
        else reversed.push({ kind: "-", line: a[--x]! });
      }
      return [...prefix, ...reversed.reverse(), ...suffix];
    }
  }
  throw new DiffBudgetExceeded();
}

function patchFor(filepath: string, before: MobileGitVersion | null, after: MobileGitVersion | null, ops: Op[]): string {
  // Git 的特殊路径使用 C 风格引号，避免路径中的换行/制表符伪造 patch 头。
  const header = (side: string) => /[\t\r\n"\\]/.test(filepath) ? JSON.stringify(`${side}/${filepath}`) : `${side}/${filepath}`;
  const metadata: string[] = [];
  if (!before && after) metadata.push(`new file mode ${after.mode.toString(8)}`);
  else if (before && !after) metadata.push(`deleted file mode ${before.mode.toString(8)}`);
  else if (before && after && before.mode !== after.mode) metadata.push(`old mode ${before.mode.toString(8)}`, `new mode ${after.mode.toString(8)}`);
  // 空文件的增删和 mode-only 需要 Git 元信息；仅有 ---/+++ 无法表达这些变更。
  const output = metadata.length ? [`diff --git ${header("a")} ${header("b")}`, ...metadata] : [];
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.kind === " ") continue;
    const first = Math.max(0, i - 3), last = Math.min(ops.length, i + 4);
    const previous = ranges.at(-1);
    if (previous && first <= previous[1]) previous[1] = last;
    else ranges.push([first, last]);
  }
  let cursor = 0, oldLine = 1, newLine = 1;
  if (ranges.length || !metadata.length) output.push(`--- ${before ? header("a") : "/dev/null"}`, `+++ ${after ? header("b") : "/dev/null"}`);
  for (const [first, last] of ranges) {
    while (cursor < first) {
      const kind = ops[cursor++]!.kind;
      if (kind !== "+") oldLine++;
      if (kind !== "-") newLine++;
    }
    const body = ops.slice(first, last);
    const oldCount = body.filter(op => op.kind !== "+").length, newCount = body.filter(op => op.kind !== "-").length;
    output.push(`@@ -${oldCount ? oldLine : oldLine - 1},${oldCount} +${newCount ? newLine : newLine - 1},${newCount} @@`);
    for (const op of body) {
      output.push(`${op.kind}${op.line.endsWith("\n") ? op.line.slice(0, -1) : op.line}`);
      if (!op.line.endsWith("\n")) output.push("\\ No newline at end of file");
      if (op.kind !== "+") oldLine++;
      if (op.kind !== "-") newLine++;
    }
    cursor = last;
  }
  return output.join("\n") + "\n";
}

export async function mobileGitDiff(path: string, filepath: string, before: MobileGitVersion | null, after: MobileGitVersion | null,
  read: (version: MobileGitVersion) => Promise<Uint8Array>): Promise<{ diff: GitDiffResult; added: number; removed: number }> {
  const fallback = (availability: GitDiffResult["availability"], summary: string) => ({
    diff: { path, availability, patch: null, beforeContent: null, afterContent: null, summary }, added: 0, removed: 0,
  });
  if ([before, after].some(v => v && v.type !== "blob")) return fallback("unavailable", "此对象不是可预览的文件 blob。");
  const oldBytes = before ? await read(before) : null, newBytes = after ? await read(after) : null;
  if ((oldBytes?.length ?? 0) > MAX_BYTES || (newBytes?.length ?? 0) > MAX_BYTES) return fallback("truncated", "文件超过 1 MiB，未展开差异。");
  let oldText: string | null, newText: string | null;
  try {
    const decode = (bytes: Uint8Array | null) => {
      if (bytes === null) return null;
      if (bytes.includes(0)) throw new Error("binary");
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes).replace(/\r\n/g, "\n");
    };
    oldText = decode(oldBytes); newText = decode(newBytes);
  } catch { return fallback("binary", "二进制文件无法预览文本差异。"); }
  try {
    const ops = compare(lines(oldText ?? ""), lines(newText ?? ""));
    return { diff: { path, availability: "patch", patch: patchFor(filepath, before, after, ops), beforeContent: oldText, afterContent: newText },
      added: ops.filter(op => op.kind === "+").length, removed: ops.filter(op => op.kind === "-").length };
  } catch (error) {
    if (error instanceof DiffBudgetExceeded) return fallback("truncated", "差异计算超过移动端预算，未展开差异。");
    throw error;
  }
}
