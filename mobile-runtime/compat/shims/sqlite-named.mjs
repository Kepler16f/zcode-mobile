// 命名参数 → 位置参数。node:sqlite 允许 `stmt.all({ workspace_key: null })`，
// 上游 taskIndexRepo 就是这么写的（listTaskMetas / listDeletedTaskIds 等，SQL 里是 @name）。
//
// 为什么必须在 JS 侧改写、而不是让两个后端各自支持：
//   - sql.js 的 bind 是按 SQL 里声明的那个名字（带 @）去查的，给它不带前缀的键会当场
//     抛 "Wrong API use : tried to bind a value of an unknown type"；
//   - Android 的 SQLiteDatabase 更直接，只有位置绑定，Kotlin 侧根本没有能查参数名的口子
//     （除非再加一次 prepare 走 SQLiteStatement —— 那对每条查询都多一次 JNI + 编译）。
// 所以一处改写、两个后端都只认 `?`，桥协议也不用改。
//
// 判据错了比绑不上更糟：字符串字面量里的 '$.a'（JSON 路径）、注释里的 @name 都不是参数，
// 把它们换成 ? 会把一条本来正确的 SQL 变成一条静默错误的 SQL。所以这里是一个跳过
// 字符串/引用标识符/注释的扫描器，不是一个正则。
const QUOTES = { "'": "'", '"': '"', "`": "`", "[": "]" };
const PARAM_PREFIXES = ["@", ":", "$"];

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof ArrayBuffer)
  );
}

/** 取一个参数名（SQL 里写成 @name/:name/$name）在调用方对象里的值；找不到就报，绝不静默补 null。 */
function valueOf(named, sql, bareName, prefixedName) {
  for (const key of [bareName, ...PARAM_PREFIXES.map((p) => `${p}${bareName}`)]) {
    if (Object.prototype.hasOwnProperty.call(named, key)) return named[key];
  }
  const at = sql.indexOf(prefixedName);
  throw new Error(
    `命名参数 ${prefixedName} 在绑定对象里不存在（SQL 片段：${sql.slice(Math.max(0, at - 40), at + 20)}）：` +
      "静默补 NULL 会让这条查询看起来对、结果全错，所以这里宁可抛。",
  );
}

/**
 * 把一条 SQL 里的命名参数换成 `?`，并返回按出现顺序排好的位置绑定值。
 * 没有命名参数时原样返回 null（调用方继续走它原来的 args）。
 */
export function rewriteNamedParameters(sql, named) {
  const out = [];
  const positional = [];
  const consumed = new Set();
  let bareQuestion = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const close = QUOTES[ch];
    if (close) {
      // 字符串/引用标识符：整段照抄，内部的重复引号（'' 表示一个 '）也要一起跳过。
      out.push(ch);
      i++;
      while (i < sql.length) {
        if (sql[i] === close) {
          if (sql[i + 1] === close) {
            out.push(close, close);
            i += 2;
            continue;
          }
          out.push(close);
          i++;
          break;
        }
        out.push(sql[i]);
        i++;
      }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      out.push(sql.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out.push(sql.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === "?") {
      bareQuestion++;
      out.push(ch);
      i++;
      continue;
    }
    if (PARAM_PREFIXES.includes(ch)) {
      const matched = /^[@:$]([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i));
      if (matched) {
        const prefixedName = matched[0];
        consumed.add(matched[1]);
        consumed.add(prefixedName);
        positional.push(valueOf(named, sql, matched[1], prefixedName));
        out.push("?");
        i += prefixedName.length;
        continue;
      }
    }
    out.push(ch);
    i++;
  }
  const leftover = Object.keys(named).filter((key) => !consumed.has(key));
  if (leftover.length) {
    throw new Error(
      `绑定对象里的 ${leftover.join(", ")} 在这条 SQL 里用不到：` +
        "多半是参数名拼错，或者 SQL 和调用点已经不同步了。",
    );
  }
  if (bareQuestion && positional.length) {
    throw new Error(
      `这条 SQL 同时用了 ?（${bareQuestion} 个）和命名参数（${positional.length} 个），位置对不上：端侧垫片不支持混用。`,
    );
  }
  return { sql: out.join(""), positional };
}

/**
 * node:sqlite 的 `run|get|all(...args)` 有两种写法：位置参数列表，或单个命名参数字典。
 * 这里把后者折叠成前者，让两个后端只需要实现位置绑定。
 */
export function normalizeBindValues(sql, args) {
  if (args.length !== 1 || !isPlainObject(args[0])) return { sql, positional: args };
  const rewritten = rewriteNamedParameters(sql, args[0]);
  return { sql: rewritten.sql, positional: rewritten.positional };
}

/**
 * 把位置参数**内联成 SQL 字面量**（读路径专用，见 sqlite-native.mjs 的 readWire）。
 *
 * 为什么读路径要内联而不是继续传 String[] 给 rawQuery：Android 的 rawQuery 对每个绑定值
 * 调 bindString，**null 元素直接抛 Java 异常**——而侧栏列表查询 listTaskMetas 的
 * `@workspace_key IS NULL OR workspace_key = @workspace_key` 在"查全部任务"时绑的正是 null，
 * 于是真机上每一次读列表都死、同步器把异常吞成空列表（装机自检报告 2026-10-07 里那条
 * "命名参数绑定 FAIL / Java exception was raised during method invocation" 就是它）。
 * sql.js 会静默把 null 绑成 NULL，所以桌面全绿、只有真机炸——假桥照 Kotlin 语义也复现不了，
 * 这条必须靠原生侧修，改不动上游一行 SQL。
 *
 * 内联是安全的，因为值只来自调用方的绑定参数、不来自用户输入拼 SQL：数字原样、字符串
 * 转义单引号、Uint8Array 转 x'hex'、null/undefined 转 NULL。跳过规则与 rewriteNamedParameters
 * 同一套（字符串/引用标识符/注释里的 `?` 不是参数位）。
 */
export function inlinePositionalParameters(sql, positional) {
  // 不写"参数为空就原样返回"的快路径：那会跳过下面"SQL 里的 ? 比绑定值多"的检查，
  // 漏一个 ? 的 SQL 会带着裸 ? 进 rawQuery，静默返回空结果——正是内联这条通道最不能犯的错。
  const literal = (value) => {
    if (value === null || value === undefined) return "NULL";
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error(`参数里的 ${value} 不是合法 SQLite 值`);
      return String(value);
    }
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "boolean") return value ? "1" : "0";
    if (value instanceof Uint8Array) return `x'${[...value].map((b) => b.toString(16).padStart(2, "0")).join("")}'`;
    if (value instanceof Date) return String(value.getTime());
    if (typeof value === "string") {
      // SQL 文本按 NUL 截断：带 \u0000 的字符串没法用 '…' 表达，只能走 x'…' 再 CAST 回 TEXT。
      if (value.includes("\u0000")) {
        const hex = [...new TextEncoder().encode(value)].map((b) => b.toString(16).padStart(2, "0")).join("");
        return `CAST(x'${hex}' AS TEXT)`;
      }
      return `'${value.replaceAll("'", "''")}'`;
    }
    // 对象进不了字面量：静默 stringify 会让一条本该报错的查询安静地查错，宁可抛。
    throw new Error(`读路径参数无法内联（${typeof value}）：${String(value).slice(0, 60)}`);
  };
  let out = "";
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const close = QUOTES[ch];
    if (close) {
      // 字符串/引用标识符：整段照抄（与 rewriteNamedParameters 同一条规则：内部的 '' 也要跳过）。
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === close) {
          if (sql[i + 1] === close) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      out += sql.slice(start, i);
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "?") {
      if (n >= positional.length) throw new Error(`SQL 里第 ${n + 1} 个 ? 没有对应的绑定值`);
      out += literal(positional[n++]);
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  if (n !== positional.length) {
    throw new Error(`绑定了 ${positional.length} 个参数，但 SQL 里只有 ${n} 个 ?：静默多绑会让结果错位，宁可抛。`);
  }
  return out;
}
