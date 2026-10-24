// 工具入参净化（0.6.8，装机"Bash 命令碎成一列竖排字符"）：GLM 系模型偶发把零宽/双向
// 控制字符吐进 tool_calls 的 arguments——夹在 JSON 结构字符之间会把 parse 炸成
// toolInputInvalid，落在 command 字符串值里则让 shell 收到一串夹带隐形字符的乱码
// （装机截图：一条 find 命令被拆成十几行竖排）。这些字符在 shell 命令与 JSON 语法里
// 都没有合法用途，执行前统一剥掉只会恢复意图。所有工具的入参 JSON 原文过一刀。
//
// 字符集用码点数组写（源码保持纯 ASCII——把字面零宽字符写进正则不可见、不可审，
// 正是我们要修的那类雷）：
//   200B-200F ZWSP/ZWNJ/ZWJ/LRM/RLM；202A-202E LRE/RLE/PDF/LRO/RLO；
//   2060 WORD JOINER；2066-2069 方向隔离 LRI/RLI/FSI/PDI；FEFF BOM；
//   00AD SOFT HYPHEN；180E Mongolian Vowel Separator。
const INVISIBLE_CODEPOINTS = [
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2060, 0x2066, 0x2067, 0x2068, 0x2069,
  0xfeff, 0x00ad, 0x180e,
];
const INVISIBLE = new Set(INVISIBLE_CODEPOINTS.map((c) => String.fromCodePoint(c)));

/**
 * 单字符串剥隐形字符（与 JSON 原文净化同一张码点表，别处别再抄一份正则）。
 * sanitizeToolArguments 守的是 tool-engine.execute 那一个入口的 JSON 原文；
 * 不经 execute 的调用路径（冒烟/自检直连 handler）或表外隐形字符漏网的值，
 * 消费方可以按需用它再补一刀（Git 的 action 入口即 ui/git-tool.ts 就这么做）。
 */
export function stripInvisibleChars(text: string): string {
  let out = "";
  for (const ch of text) {
    if (!INVISIBLE.has(ch)) out += ch;
  }
  return out;
}

/**
 * JSON.parse 前净化：命中隐形字符才重建字符串（常见路径 = 一次 Set 查找/字符，
 * 对几百字符的工具入参可忽略）。命中时把条数报回来——装机报告能看出
 * "这一轮模型吐了几枚隐形字符"，下次同类问题不再靠猜。
 */
export function sanitizeToolArguments(raw: string): { clean: string; stripped: number } {
  let found = 0;
  for (const ch of raw) {
    if (INVISIBLE.has(ch)) found += 1;
  }
  if (found === 0) return { clean: raw, stripped: 0 };
  return { clean: stripInvisibleChars(raw), stripped: found };
}
