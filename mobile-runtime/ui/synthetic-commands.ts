// 合成命令层（装机 0.10.x，用户点名"给终端加 jq/unzip/curl/wget，但体积几乎不许涨"）：
// 一组由端侧 TS 直接实现的命令，命中时**整条管道本地执行、绝不碰 sh**；没命中就原样退回 sh。
//
// 为什么整条管道全中才本地跑：混合执行（echo 出来的喂 jq）要求在本层重造 shell 的语义
// （变量、重定向、退出码短路……），造一半就是行为漂移——那是"弄坏现有 Bash"的最短路。
// 所以这里的纪律是纯函数 + 全有或全无：resolveSyntheticPipeline 认不出来的东西一个字符
// 都不改地交还给 sh，jq: not found 与旧行为逐字一致。
//
// 体积账：本文件只有一个 jq 递归下降小解释器和三组旗标解析，gzip 后 ~8KB，离 30KB 红线远。
// 依赖：bridgeHttpRaw / bytesFromBase64 来自 git-tool（HTTP 桥，0.6.7 已在装机的桥面），
// resolveDownloadPath 来自 fetch-tool（落盘路径判据单一事实源）。零新增 npm 依赖。
import { bridgeHttpRaw, bytesFromBase64 } from "./git-tool.js";
import { resolveDownloadPath } from "./fetch-tool.js";

/** 一条合成命令的执行结果：stdout 是管道的下一段 stdin（也是最终回给模型的 content），exitCode 非零断管。 */
export interface SyntheticRunResult {
  stdout: string;
  exitCode: number;
}

/** 宿主注入的 IO 面：合成命令本体保持纯函数（可测、可拼），落盘/桥调用全部由 tool-engine 递进来。 */
export interface SyntheticHost {
  /** 当前工作区根（相对落盘路径按它解析，与 Fetch 工具同一判据）。 */
  workspacePath: string;
  /** 写工作区文件（工具引擎注入 fileSystemPort.writeBinaryFile，越界由端口的授权闸拒）。 */
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
  /** 出网之前先问授权闸（fetch-tool 同款顺序：先 checkAccess 再发请求）。 */
  checkPathAccess: (path: string) => void;
  /** 原生 ExecBridge 的 unzip（Kotlin 侧 java.util.zip）；桌面 harness 没有 → unzip 报"需要原生桥"。 */
  unzipBridge?: (request: { zip: string; dest: string }) => Promise<{ ok?: boolean; files?: number; error?: string }>;
}

export interface SyntheticCommand {
  /** 工具描述里给模型看的一行语法边界。 */
  description: string;
  run(args: string[], stdin: string, host: SyntheticHost): Promise<SyntheticRunResult> | SyntheticRunResult;
}

// ─────────────────────────── shell 词法（引号感知、只认不拆） ───────────────────────────

/**
 * 引号感知地把一段命令切成词。返回 null = 段内出现了本层不实现的 shell 语义
 * （变量/命令替换/重定向/控制符号/glob/未闭合引号），调用方必须整条退回 sh——
 * 这不是"尽力解析"，是安全阀：猜错的代价比"少帮一次忙"大得多。
 */
function tokenizeShellWords(segment: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let hasWord = false;
  let i = 0;
  const push = () => {
    if (hasWord) words.push(word);
    word = "";
    hasWord = false;
  };
  while (i < segment.length) {
    const c = segment[i];
    if (c === "'") {
      hasWord = true;
      const end = segment.indexOf("'", i + 1);
      if (end < 0) return null; // 未闭合单引号
      word += segment.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      hasWord = true;
      i++;
      let closed = false;
      while (i < segment.length) {
        const d = segment[i];
        if (d === '"') { closed = true; i++; break; }
        if (d === "\\") {
          const next = segment[i + 1];
          // 双引号内 shell 只认 \$ \` \" \\ 与 \<换行>；其它 \x 原样保留。$ 和 ` 我们不展开 → 退回。
          if (next === "$" || next === "`") return null;
          if (next === '"' || next === "\\" || next === "\n") {
            if (next !== "\n") word += next;
            i += 2;
            continue;
          }
          word += d;
          i++;
          continue;
        }
        if (d === "$" || d === "`") return null; // 双引号内变量/命令替换 = shell 语义
        word += d;
        i++;
      }
      if (!closed) return null; // 未闭合双引号
      continue;
    }
    if (c === "\\") {
      const next = segment[i + 1];
      if (next === undefined || next === "\n") return null; // 行继续符 → 多行语义，退回
      hasWord = true;
      word += next;
      i += 2;
      continue;
    }
    if (c === "$" || c === "`") return null; // 变量展开 / 命令替换（引号外同样不实现）
    if (c === ";" || c === "&" || c === "(" || c === ")" || c === "<" || c === ">") return null;
    if (c === "#" && !hasWord) return null; // 行注释（词首 # 在 shell 里是注释起点）
    if (c === "*" || c === "?" || c === "[" || c === "~") return null; // glob / 波浪号：不实现就不许静默吞
    if (/\s/.test(c)) { push(); i++; continue; }
    hasWord = true;
    word += c;
    i++;
  }
  push();
  return words;
}

/** 按不成对的竖线切段。`||`、`|&`、引号里的 |、反斜杠转义的 | 都不算管道；拿不准返回 null。 */
function splitPipelineSegments(command: string): string[] | null {
  const segments: string[] = [];
  let current = "";
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      current += command.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < command.length) {
        if (command[j] === "\\") { j += 2; continue; }
        if (command[j] === '"') break;
        j++;
      }
      if (j >= command.length) return null;
      current += command.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "\\") {
      if (command[i + 1] === undefined || command[i + 1] === "\n") return null;
      current += command.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === "|") {
      const next = command[i + 1];
      if (next === "|" || next === "&") return null; // || 短路 / |& 合流是控制流，不是管道
      segments.push(current);
      current = "";
      i++;
      continue;
    }
    if (c === "\n" || c === "\r" || c === ";" || c === "&") return null; // 命令分隔/后台：超纲
    current += c;
    i++;
  }
  segments.push(current);
  return segments;
}

/** 一条已解析的管道段：首词是合成命令名，args 是引号还原后的参数。 */
export interface SyntheticSegment {
  name: string;
  args: string[];
}

/**
 * 整条命令是不是"纯合成管道"。是 → 返回逐段解析结果（按序执行）；否 → 返回 null，
 * 调用方把原文一个字不改地交给 sh。本函数绝不抛异常（内部全兜住），null 是唯一否定形状。
 */
export function resolveSyntheticPipeline(command: string): SyntheticSegment[] | null {
  try {
    const raw = command.trim();
    if (raw === "" || /[\r\n]/.test(raw)) return null;
    const segments = splitPipelineSegments(raw);
    if (!segments) return null;
    const resolved: SyntheticSegment[] = [];
    for (const segment of segments) {
      const words = tokenizeShellWords(segment);
      if (!words || words.length === 0) return null;
      const name = words[0];
      if (!Object.prototype.hasOwnProperty.call(SYNTHETIC_COMMANDS, name)) return null;
      resolved.push({ name, args: words.slice(1) });
    }
    return resolved;
  } catch {
    return null;
  }
}

/** 按序执行已解析的管道：段间 stdout→stdin 字符串衔接，exitCode 非零即断（后续段不跑）。 */
export async function runSyntheticPipeline(
  segments: SyntheticSegment[],
  stdin: string,
  host: SyntheticHost,
): Promise<SyntheticRunResult> {
  let data = stdin;
  let last: SyntheticRunResult = { stdout: "", exitCode: 0 };
  for (const segment of segments) {
    // resolve 已验过首词，这里直接取；防御式兜底仍然退回（不猜）。
    const cmd = SYNTHETIC_COMMANDS[segment.name];
    if (!cmd) return { stdout: "", exitCode: 127 };
    const r = await cmd.run(segment.args, data, host);
    if (r.exitCode !== 0) return { stdout: r.stdout, exitCode: r.exitCode };
    last = r;
    data = r.stdout;
  }
  return last;
}

// ─────────────────────────── jq 子集（自写递归下降，零依赖） ───────────────────────────

type JqValue = null | boolean | number | string | JqValue[] | { [key: string]: JqValue };

class JqError extends Error {}

/** jq 程序记号：punct（.[]|()==!= 等）、ident、string（已解转义）、number。 */
interface JqToken {
  t: "punct" | "ident" | "string" | "number";
  v: string;
  n?: number;
}

function jqTokenize(src: string): JqToken[] {
  const tokens: JqToken[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "|" || c === "." || c === "[" || c === "]" || c === "(" || c === ")") {
      tokens.push({ t: "punct", v: c });
      i++;
      continue;
    }
    if ((c === "=" || c === "!") && src[i + 1] === "=") {
      tokens.push({ t: "punct", v: `${c}=` });
      i += 2;
      continue;
    }
    if (c === '"') {
      let s = "";
      i++;
      let closed = false;
      while (i < src.length) {
        const d = src[i];
        if (d === '"') { closed = true; i++; break; }
        if (d === "\\") {
          const e = src[i + 1];
          if (e === undefined) throw new JqError("字符串未闭合");
          const map: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };
          if (e === "u") {
            const hex = src.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new JqError(`非法 \\u 转义：${hex}`);
            s += String.fromCharCode(parseInt(hex, 16));
            i += 6;
            continue;
          }
          if (!(e in map)) throw new JqError(`不支持的转义 \\${e}`);
          s += map[e];
          i += 2;
          continue;
        }
        s += d;
        i++;
      }
      if (!closed) throw new JqError("字符串未闭合");
      tokens.push({ t: "string", v: s });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(src.slice(i));
      if (!m) throw new JqError(`非法数字（位置 ${i}）`);
      tokens.push({ t: "number", v: m[0], n: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      tokens.push({ t: "ident", v: m[0] });
      i += m[0].length;
      continue;
    }
    throw new JqError(`jq 程序含本子集不支持的字符 "${c}"（位置 ${i}）`);
  }
  return tokens;
}

// AST：source 链表达后缀（.foo.bar = field(field(identity,"foo"),"bar")）；pipe 表达 | 管道。
type JqNode =
  | { kind: "identity" }
  | { kind: "pipe"; left: JqNode; right: JqNode }
  | { kind: "field"; source: JqNode; name: string }
  | { kind: "index"; source: JqNode; key: string | number }
  | { kind: "iterate"; source: JqNode }
  | { kind: "length" }
  | { kind: "keys" }
  | { kind: "literal"; value: JqValue }
  | { kind: "select"; source: JqNode; cond: JqNode }
  | { kind: "compare"; left: JqNode; op: "==" | "!="; right: JqNode };

function jqParse(program: string): JqNode {
  const tokens = jqTokenize(program);
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (v: string) => {
    const t = tokens[pos];
    if (!t || t.t !== "punct" || t.v !== v) throw new JqError(`期望 "${v}"，收到 ${t ? tokenText(t) : "结尾"}`);
    pos++;
  };
  const tokenText = (t: JqToken): string => (t.t === "punct" ? `"${t.v}"` : t.t === "number" ? String(t.n) : t.t === "string" ? `"${t.v}"` : t.v);

  // operand：比较两侧 = 路径/字面量（select 的比较不支持嵌套 select/管道——子集就这么大）。
  const parseOperand = (): JqNode => {
    const t = peek();
    if (!t) throw new JqError("比较式意外结束");
    if (t.t === "string") { pos++; return { kind: "literal", value: t.v }; }
    if (t.t === "number") { pos++; return { kind: "literal", value: t.n! }; }
    if (t.t === "ident" && (t.v === "true" || t.v === "false" || t.v === "null")) {
      pos++;
      return { kind: "literal", value: t.v === "true" ? true : t.v === "false" ? false : null };
    }
    return parsePostfix();
  };

  const parsePostfix = (): JqNode => {
    let node = parsePrimary();
    while (true) {
      const t = peek();
      if (t && t.t === "punct" && t.v === "." && tokens[pos + 1]?.t === "ident") {
        pos += 2;
        node = { kind: "field", source: node, name: (tokens[pos - 1] as { v: string }).v };
        continue;
      }
      if (t && t.t === "punct" && t.v === "[") {
        pos++;
        if (peek() && peek().t === "punct" && peek().v === "]") {
          pos++;
          node = { kind: "iterate", source: node };
          continue;
        }
        const k = peek();
        if (k && (k.t === "number" || k.t === "string")) {
          pos++;
          eat("]");
          node = { kind: "index", source: node, key: k.t === "number" ? k.n! : k.v };
          continue;
        }
        throw new JqError("jq 子集的 [] 下标只支持数字或字符串字面量");
      }
      break;
    }
    return node;
  };

  const parsePrimary = (): JqNode => {
    const t = peek();
    if (!t) throw new JqError("jq 程序意外结束");
    if (t.t === "punct" && t.v === ".") {
      pos++;
      const next = peek();
      if (next && next.t === "ident") {
        pos++;
        return { kind: "field", source: { kind: "identity" }, name: next.v };
      }
      return { kind: "identity" };
    }
    if (t.t === "ident") {
      if (t.v === "length") { pos++; return { kind: "length" }; }
      if (t.v === "keys") { pos++; return { kind: "keys" }; }
      if (t.v === "true" || t.v === "false" || t.v === "null") {
        pos++;
        return { kind: "literal", value: t.v === "true" ? true : t.v === "false" ? false : null };
      }
      if (t.v === "select") {
        pos++;
        eat("(");
        const left = parseOperand();
        let cond: JqNode = left;
        const op = peek();
        if (op && op.t === "punct" && (op.v === "==" || op.v === "!=")) {
          pos++;
          const right = parseOperand();
          cond = { kind: "compare", left, op: op.v as "==" | "!=" , right };
        }
        eat(")");
        return { kind: "select", source: { kind: "identity" }, cond };
      }
      throw new JqError(`jq 子集不支持函数 "${t.v}"（支持：length/keys/select）`);
    }
    throw new JqError(`jq 程序此处应为路径或函数，收到 ${tokenText(t)}`);
  };

  const parsePipe = (): JqNode => {
    let node = parsePostfix();
    while (peek() && peek().t === "punct" && peek().v === "|") {
      pos++;
      const right = parsePostfix();
      node = { kind: "pipe", left: node, right };
    }
    return node;
  };

  const ast = parsePipe();
  if (pos !== tokens.length) throw new JqError(`jq 程序末尾有多余内容：${tokenText(tokens[pos])}`);
  return ast;
}

function typeName(v: JqValue): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function deepEqual(a: JqValue, b: JqValue): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x as JqValue, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => deepEqual((a as Record<string, JqValue>)[k], (b as Record<string, JqValue>)[k]));
  }
  return false;
}

const truthy = (v: JqValue): boolean => v !== false && v !== null;

function evalJq(node: JqNode, input: JqValue): JqValue[] {
  switch (node.kind) {
    case "identity":
      return [input];
    case "pipe": {
      const out: JqValue[] = [];
      for (const v of evalJq(node.left, input)) out.push(...evalJq(node.right, v));
      return out;
    }
    case "field": {
      return evalJq(node.source, input).map((v) => {
        if (v === null) return null;
        if (typeof v === "object" && !Array.isArray(v)) return (v as Record<string, JqValue>)[node.name] ?? null;
        throw new JqError(`无法对 ${typeName(v)} 取字段 "${node.name}"`);
      });
    }
    case "index": {
      return evalJq(node.source, input).map((v) => {
        if (v === null) return null;
        if (typeof node.key === "number") {
          if (!Array.isArray(v)) throw new JqError(`无法对 ${typeName(v)} 按数字下标取值`);
          const i = node.key < 0 ? v.length + node.key : node.key;
          return (v[i] ?? null) as JqValue;
        }
        if (typeof v === "object" && !Array.isArray(v)) return (v as Record<string, JqValue>)[node.key] ?? null;
        throw new JqError(`无法对 ${typeName(v)} 用字符串下标 "${node.key}" 取值`);
      });
    }
    case "iterate": {
      const out: JqValue[] = [];
      for (const v of evalJq(node.source, input)) {
        if (Array.isArray(v)) out.push(...(v as JqValue[]));
        else if (typeof v === "object" && v !== null) out.push(...Object.values(v));
        else throw new JqError(`无法迭代 ${typeName(v)}（只有 array/object 可以 .[]）`);
      }
      return out;
    }
    case "length": {
      let n: number;
      if (input === null) n = 0;
      else if (typeof input === "string") n = input.length;
      else if (Array.isArray(input)) n = input.length;
      else if (typeof input === "number") n = Math.abs(input);
      else if (typeof input === "object") n = Object.keys(input).length;
      else throw new JqError(`${typeName(input)} 没有 length`);
      return [n];
    }
    case "keys": {
      if (input !== null && typeof input === "object" && !Array.isArray(input)) {
        return [Object.keys(input).sort()];
      }
      if (Array.isArray(input)) return [input.map((_, i) => i)];
      throw new JqError(`${typeName(input)} 没有 keys（只有 object/array 有）`);
    }
    case "literal":
      return [node.value];
    case "compare": {
      const l = evalJq(node.left, input);
      const r = evalJq(node.right, input);
      // 子集里两侧都是单值路径/字面量；取首值比较（空流当 null——比 jq 的笛卡尔积简单且够用）。
      const lv = (l[0] ?? null) as JqValue;
      const rv = (r[0] ?? null) as JqValue;
      const eq = deepEqual(lv, rv);
      return [node.op === "==" ? eq : !eq];
    }
    case "select": {
      const out: JqValue[] = [];
      for (const v of evalJq(node.source, input)) {
        for (const c of evalJq(node.cond, v)) if (truthy(c)) out.push(v);
      }
      return out;
    }
  }
}

/** 紧凑 JSON 序列化（jq 的 --compact-output 形状；管道下一段和最终回包都吃这个）。 */
function jqStringify(v: JqValue): string {
  return JSON.stringify(v) ?? "null";
}

function formatJqOutput(outputs: JqValue[], raw: boolean): string {
  return outputs.map((v) => (raw && typeof v === "string" ? v : jqStringify(v))).join("\n");
}

/** 解析 -r/-e 这类旗标（支持合并短旗标 -re）。返回 {raw, exitStatus, rest}。 */
function parseJqFlags(args: string[]): { raw: boolean; exitStatus: boolean; rest: string[] } {
  let raw = false;
  let exitStatus = false;
  const rest: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--")) {
      if (arg === "--raw-output") { raw = true; continue; }
      if (arg === "--exit-status") { exitStatus = true; continue; }
      if (arg === "--compact-output") continue; // 我们本来就输出紧凑格式
      throw new JqUsageError(`jq 子集不支持旗标 ${arg}`);
    }
    if (arg.startsWith("-") && arg.length > 1 && arg !== "-") {
      for (const ch of arg.slice(1)) {
        if (ch === "r") raw = true;
        else if (ch === "e") exitStatus = true;
        else if (ch === "c") continue; // 同上，紧凑是默认
        else throw new JqUsageError(`jq 子集不支持旗标 -${ch}`);
      }
      continue;
    }
    rest.push(arg);
  }
  return { raw, exitStatus, rest };
}

class JqUsageError extends Error {}

function runJq(args: string[], stdin: string): SyntheticRunResult {
  const fail = (message: string, exitCode: number): SyntheticRunResult => ({ stdout: message, exitCode });
  let flags: ReturnType<typeof parseJqFlags>;
  try {
    flags = parseJqFlags(args);
  } catch (e) {
    return fail(`${(e as Error).message}（可用：-r 原样输出字符串 / -e 空或 null/false 结果退出码 1 / --raw-output / --exit-status）`, 2);
  }
  const [program, ...extra] = flags.rest;
  if (!program) return fail("jq 子集用法：jq [-re] '<jq 程序>'（程序必须加引号；只读 stdin，不支持文件参数）", 2);
  if (extra.length > 0) return fail("jq 子集只读 stdin，不支持文件参数", 2);
  let node: JqNode;
  try {
    node = jqParse(program);
  } catch (e) {
    return fail(`jq: 程序解析失败：${(e as Error).message}`, 3);
  }
  if (stdin.trim() === "") return fail("jq: 输入是空的，没有 JSON 可解析（上一段命令没产出？）", 2);
  let input: JqValue;
  try {
    input = JSON.parse(stdin) as JqValue;
  } catch {
    const prefix = stdin.length > 80 ? `${stdin.slice(0, 80)}…` : stdin;
    return fail(`jq: 输入不是合法 JSON（前 80 字符）：${prefix.replace(/[\r\n]+/g, "\\n")}`, 2);
  }
  try {
    const outputs = evalJq(node, input);
    if (flags.exitStatus) {
      if (outputs.length === 0) return { stdout: "", exitCode: 1 };
      const lastValue = outputs[outputs.length - 1]!;
      return { stdout: formatJqOutput(outputs, flags.raw), exitCode: truthy(lastValue) ? 0 : 1 };
    }
    return { stdout: formatJqOutput(outputs, flags.raw), exitCode: 0 };
  } catch (e) {
    if (e instanceof JqError) return fail(`jq: ${(e as Error).message}`, 5);
    throw e; // 实现自身 bug：抛给上层走"退回 sh"的安全阀，绝不把内部错误当命令结果
  }
}

// ─────────────────────────── curl / wget（映射原生 HTTP 桥） ───────────────────────────

class FlagError extends Error {} // “子集不支持旗标” → 退出码 2

/** 文本 → base64（HTTP 桥的 body 通道；git-tool 的 base64FromBytes 未导出，这里本地一份等价实现）。 */
function base64OfText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** URL 里抠文件名（-O / wget 缺省落盘名）：去 query/hash 后取最后一段。 */
function urlBasename(url: string): string | null {
  let path = url.split("#")[0]!;
  path = path.split("?")[0]!;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name === "" ? null : name;
}

interface HttpLikeResponse {
  statusCode?: number;
  headers?: Record<string, string>;
  bodyBase64?: string;
}

async function dispatchHttp(opts: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}): Promise<HttpLikeResponse> {
  return bridgeHttpRaw({
    url: opts.url,
    method: opts.method,
    headers: opts.headers,
    bodyBase64: opts.body !== undefined ? base64OfText(opts.body) : undefined,
    signal: opts.signal,
  });
}

/** curl 响应体回显上限：超过就拒绝回显让模型改用 -o 落盘（防一次抓取把端侧内存顶爆）。 */
const CURL_STDOUT_MAX_BYTES = 8 * 1024 * 1024;

function runCurl(args: string[], stdin: string, host: SyntheticHost): Promise<SyntheticRunResult> {
  return runHttpClient(args, stdin, host, "curl");
}

function runWget(args: string[], stdin: string, host: SyntheticHost): Promise<SyntheticRunResult> {
  return runHttpClient(args, stdin, host, "wget");
}

/** curl 与 wget 共用一台引擎：旗标面不同、HTTP≥400 的退出语义不同（curl 默认 0，wget 8）。 */
async function runHttpClient(
  args: string[],
  _stdin: string,
  host: SyntheticHost,
  flavor: "curl" | "wget",
): Promise<SyntheticRunResult> {
  const fail = (message: string, exitCode: number): SyntheticRunResult => ({ stdout: message, exitCode });
  const booleanFlags = flavor === "curl" ? new Set(["s", "S", "L", "O"]) : new Set(["q"]);
  const valueFlags = flavor === "curl" ? new Set(["H", "X", "d", "o"]) : new Set(["O"]);
  const longFlags: Record<string, string> =
    flavor === "curl"
      ? { "--silent": "s", "--show-error": "S", "--location": "L", "--remote-name": "O", "--header": "H", "--request": "X", "--data": "d", "--data-raw": "d", "--output": "o" }
      : { "--quiet": "q", "--output-document": "O" };
  const headers: Record<string, string> = {};
  const dataParts: string[] = [];
  let method: string | null = null;
  let outputPath: string | null = null;
  let remoteName = false;
  let url: string | null = null;
  let noMoreFlags = false;
  let stdinBody: string | null = null;

  const takeValue = (flag: string, rest: string[]): string => {
    if (rest.length === 0) throw new FlagError(`${flavor}: 旗标 ${flag} 缺少参数`);
    return rest.shift()!;
  };

  try {
    const rest = [...args];
    while (rest.length > 0) {
      const arg = rest.shift()!;
      if (noMoreFlags || !arg.startsWith("-") || arg === "-") {
        if (url !== null) throw new FlagError(`${flavor} 子集一次只支持一个 URL（收到第二个：${arg}）`);
        url = arg;
        continue;
      }
      if (arg === "--") { noMoreFlags = true; continue; }
      if (arg.startsWith("--")) {
        const mapped = longFlags[arg];
        if (!mapped) throw new FlagError(`${flavor} 子集不支持旗标 ${arg}`);
        if (mapped === "q" || mapped === "s" || mapped === "S" || mapped === "L") continue;
        if (mapped === "O") { remoteName = true; continue; }
        const value = takeValue(arg, rest);
        if (mapped === "H") {
          const idx = value.indexOf(":");
          if (idx <= 0) throw new FlagError(`${flavor}: -H 的值必须是 "名字: 值"（收到：${value}）`);
          headers[value.slice(0, idx).trim()] = value.slice(idx + 1).trim();
        } else if (mapped === "X") method = value.toUpperCase();
        else if (mapped === "d") dataParts.push(value);
        else if (mapped === "o") outputPath = value;
        continue;
      }
      // 短旗标（可合并，如 curl 的 -sS）；带值旗标后面的字符当参数值（-XGET ≡ -X GET）。
      const chars = arg.slice(1);
      for (let k = 0; k < chars.length; k++) {
        const ch = chars[k]!;
        if (valueFlags.has(ch)) {
          const inline = chars.slice(k + 1);
          const value = inline !== "" ? inline : takeValue(`-${ch}`, rest);
          if (ch === "O") {
            if (flavor === "wget") { outputPath = value; break; }
            remoteName = true;
            break;
          }
          if (ch === "H") {
            const idx = value.indexOf(":");
            if (idx <= 0) throw new FlagError(`${flavor}: -H 的值必须是 "名字: 值"（收到：${value}）`);
            headers[value.slice(0, idx).trim()] = value.slice(idx + 1).trim();
          } else if (ch === "X") method = value.toUpperCase();
          else if (ch === "d") dataParts.push(value);
          else if (ch === "o") outputPath = value;
          break;
        }
        if (booleanFlags.has(ch)) {
          if (ch === "O") remoteName = true; // curl -O / -sO：按 URL 文件名落盘
          continue;
        }
        throw new FlagError(`${flavor} 子集不支持旗标 -${ch}`);
      }
    }
  } catch (e) {
    if (e instanceof FlagError) return fail((e as Error).message, 2);
    throw e;
  }

  // wget 专属：-O - 表示回显到 stdout（此时绝不落盘，包括 wget 缺省的按名落盘也不生效）。
  const outputToStdout = outputPath === "-";
  if (outputPath === "-") outputPath = null;

  if (url === null) return fail(`${flavor}: 缺少 URL（http/https 完整地址）`, 2);
  if (!/^https?:\/\//i.test(url)) return fail(`${flavor} 子集只支持 http/https（其它协议一律拒绝）`, 2);

  // 落盘路径先解析、先过授权闸（fetch-tool 同款顺序：授权在出网之前）。
  let resolvedOutput: string | null = null;
  if (outputPath !== null) {
    resolvedOutput = resolveDownloadPath(host.workspacePath, outputPath);
  } else if (outputToStdout) {
    // 显式 -O -：响应体走 stdout，不落盘。
  } else if (remoteName || flavor === "wget") {
    // curl -O / wget 缺省：按 URL 文件名落到当前工作区根。
    const name = urlBasename(url);
    if (!name) return fail(`${flavor}: URL 没有文件名，无法按名落盘，请用 ${flavor === "curl" ? "-o" : "-O"} 指定路径`, 2);
    resolvedOutput = resolveDownloadPath(host.workspacePath, name);
  }
  if (resolvedOutput !== null) {
    try {
      host.checkPathAccess(resolvedOutput);
    } catch (e) {
      if ((e as { code?: string } | null)?.code === "permission_denied") throw e; // 交引擎层走授权弹窗
      return fail(`${flavor}: ${(e as Error).message}`, 1);
    }
  }

  const effectiveMethod = method ?? (dataParts.length > 0 ? "POST" : "GET");
  // curl 的多个 -d 按 & 连接（真 curl 语义）；-d @- 读 stdin 也支持（管道里 curl 收上一段的输出）。
  let body: string | undefined;
  if (dataParts.length > 0) {
    const parts: string[] = [];
    for (const part of dataParts) {
      if (part === "@-") {
        if (stdinBody === null) stdinBody = _stdin;
        parts.push(stdinBody);
      } else if (part.startsWith("@")) {
        throw new FlagError(`${flavor} 子集不支持 @文件 读取（只支持 @- 读管道输入）`);
      } else parts.push(part);
    }
    body = parts.join("&");
  }

  let res: HttpLikeResponse;
  try {
    res = await dispatchHttp({ url, method: effectiveMethod, headers, body });
  } catch (e) {
    return fail(`${flavor}: 网络失败：${String((e as Error)?.message ?? e)}`, 1);
  }
  const status = res.statusCode ?? 0;
  const bytes = res.bodyBase64 ? bytesFromBase64(res.bodyBase64) : new Uint8Array(0);
  const contentType = String(res.headers?.["content-type"] ?? res.headers?.["Content-Type"] ?? "");

  if (flavor === "wget" && status >= 400) {
    return fail(`wget: HTTP ${status}（${url}），未写任何文件`, 8);
  }

  if (resolvedOutput !== null) {
    if (bytes.length === 0 && status >= 400) {
      return fail(`${flavor}: HTTP ${status}，响应为空，未写文件`, 1);
    }
    try {
      await host.writeFile(resolvedOutput, bytes);
    } catch (e) {
      if ((e as { code?: string } | null)?.code === "permission_denied") throw e;
      return fail(`${flavor}: 落盘失败：${String((e as Error)?.message ?? e)}`, 1);
    }
    return { stdout: `已保存 ${bytes.length} 字节 → ${resolvedOutput}（HTTP ${status}${contentType ? `，${contentType}` : ""}）`, exitCode: 0 };
  }
  if (bytes.length > CURL_STDOUT_MAX_BYTES) {
    return fail(`${flavor}: 响应体 ${bytes.length} 字节超过回显上限 ${CURL_STDOUT_MAX_BYTES}，请加 -o 落盘后再处理`, 1);
  }
  const text = new TextDecoder().decode(bytes);
  return { stdout: text, exitCode: 0 };
}

// ─────────────────────────── unzip（走 ExecBridge 的原生 java.util.zip） ───────────────────────────

async function runUnzip(args: string[], _stdin: string, host: SyntheticHost): Promise<SyntheticRunResult> {
  const fail = (message: string, exitCode: number): SyntheticRunResult => ({ stdout: message, exitCode });
  let archive: string | null = null;
  let dest: string | null = null;
  const rest = [...args];
  try {
    while (rest.length > 0) {
      const arg = rest.shift()!;
      if (arg === "-d") {
        if (rest.length === 0) return fail("unzip: -d 缺少目标目录参数", 2);
        dest = rest.shift()!;
        continue;
      }
      if (arg.startsWith("-")) return fail(`unzip 子集不支持旗标 ${arg}（支持：unzip <包> [-d 目标目录]；解包总是覆盖同名文件）`, 2);
      if (archive !== null) return fail("unzip 一次只支持一个压缩包", 2);
      archive = arg;
    }
  } catch (e) {
    return fail(`unzip: ${(e as Error).message}`, 2);
  }
  if (!archive) return fail("unzip 子集用法：unzip <包.zip> [-d 目标目录]（目标缺省为当前工作区根）", 2);
  if (!host.unzipBridge) return fail("unzip 需要原生桥（zcodeExec.unzip）：桌面端/无桥宿主不可用。改用 Fetch 工具下载或让用户手动解压", 1);
  const resolvedZip = resolveDownloadPath(host.workspacePath, archive);
  // dest 缺省（或显式 "."）就是当前工作区根本身，不拼成 "/work/a/." 这种拼写。
  const resolvedDest = dest && dest !== "." && dest !== "./"
    ? resolveDownloadPath(host.workspacePath, dest)
    : host.workspacePath;
  try {
    host.checkPathAccess(resolvedZip);
    host.checkPathAccess(resolvedDest);
  } catch (e) {
    if ((e as { code?: string } | null)?.code === "permission_denied") throw e;
    return fail(`unzip: ${(e as Error).message}`, 1);
  }
  let reply: { ok?: boolean; files?: number; error?: string };
  try {
    reply = await host.unzipBridge({ zip: resolvedZip, dest: resolvedDest });
  } catch (e) {
    return fail(`unzip: 桥调用失败：${String((e as Error)?.message ?? e)}`, 1);
  }
  if (!reply || reply.error || reply.ok !== true) {
    return fail(`unzip: ${reply?.error ?? "桥返回异常"}`, 1);
  }
  return { stdout: `已解压 ${reply.files ?? 0} 个文件 → ${resolvedDest}`, exitCode: 0 };
}

// ─────────────────────────── 注册表与描述 ───────────────────────────

/** 命令注册表：Bash 管道拦截与工具描述的唯一事实源（新增命令只改这里）。 */
export const SYNTHETIC_COMMANDS: Record<string, SyntheticCommand> = {
  jq: {
    description:
      "JSON 处理（端侧子集）。语法：jq [-re] '<程序>'；程序支持 . 、.foo.bar、.[0]（负数从尾数）、.[]（迭代）、" +
      ".foo[0].bar 组合、| 管道、length、keys、select(路径 ==/!= 字面量或另一路径)；-r 原样输出字符串，" +
      "-e 空结果或 null/false 退出码 1。输出是紧凑单行 JSON（非真 jq 的缩进格式）；只读 stdin，不接受文件参数。",
    run: runJq,
  },
  curl: {
    description:
      "HTTP 请求（端侧子集，走原生桥无 CORS）。支持：-s/-S（接受，静默）、-L（跟随重定向）、-H \"名: 值\"（可多次）、" +
      "-X 方法、-d 数据（转 POST，多个 -d 按 & 连接，@- 读管道输入）、-o 工作区文件、-O（按 URL 文件名落盘）。" +
      "响应默认回显 stdout；HTTP 4xx/5xx 默认照常回包退出码 0（真 curl 默认行为，本子集不支持 -f）。",
    run: runCurl,
  },
  wget: {
    description:
      "HTTP 下载（端侧子集，走原生桥无 CORS）。语法：wget <URL> [-O 工作区文件|-] [-q]；缺省按 URL 文件名落到当前工作区根；" +
      "-O - 回显到 stdout。HTTP≥400 退出码 8 且不写文件（真 wget 语义）。",
    run: runWget,
  },
  unzip: {
    description:
      "解压 zip（端侧子集，走原生桥 java.util.zip）。语法：unzip <包.zip> [-d 目标目录]；目标缺省为当前工作区根；" +
      "总是覆盖同名文件；条目名含 .. 或绝对路径会被拒绝（zip-slip 防护）。仅原生桥宿主可用。",
    run: runUnzip,
  },
};

/** 给 Bash 工具描述追加的合成命令说明（模型按这段决定什么时候用合成命令、什么时候绕开）。 */
export function syntheticCommandsNote(): string {
  const lines = Object.entries(SYNTHETIC_COMMANDS).map(([name, cmd]) => `- ${name}：${cmd.description}`);
  return [
    "【合成命令层】以下命令由端侧直接实现（不经 sh、不依赖 toybox），语法为**子集**：",
    ...lines,
    "触发条件（保守）：**整条命令的每一段都是上述合成命令**才本地执行；只要混入任何 shell 语法" +
      "（echo/cat/变量 $VAR/重定向 >/>>/管道外的 ; && || $() 反引号/glob 等），整条会原样退回 sh 执行，" +
      "而 sh 里没有这些命令，会报 not found——所以不要写 `echo … | jq …` 这种混排；需要混排时把数据先用文件工具落盘，" +
      "或改用 Fetch 工具。报\"不支持旗标\"时改用 Fetch 工具或原始 sh 等价物。",
  ].join("\n");
}
