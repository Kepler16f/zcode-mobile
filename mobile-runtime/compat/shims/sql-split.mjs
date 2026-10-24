// Android 的 SQLiteDatabase 一次只能执行一条语句：nativePrepareStatement 发现分号后还有
// 非空白内容就抛 "cannot execute ... because it contains multiple statements"。
// 桌面 migration-runner 是把整段 SQL 直接 db.exec()（一条迁移里最多二十张表），
// 所以原生桥这边必须先按语句切开。node:sqlite 和 sql.js 都不需要这步。
//
// 不能按 ';' 裸切，实测这库的 SQL 里四种情况都会踩雷：
//   1. 字符串/标识符引号里有分号（0020 那批 json_extract 字面量）；
//   2. `--` 行注释和 `/* */` 块注释；
//   3. create trigger ... begin ... end;（migrations.ts:656/669 体内还有内层分号）；
//   4. 同一段里 case ... end 与 trigger 的 end 混用，所以两者要分开计数。
// 这里是扫描器不是解析器：只保证"引号/注释里的分号不算分号、复合体里的分号不算分号"。
export function splitSqlStatements(source) {
  const statements = [];
  let current = "";
  let firstWord = "";
  let compoundDepth = 0;
  let caseDepth = 0;
  let index = 0;
  const length = source.length;

  const push = () => {
    const trimmed = current.trim();
    if (trimmed) statements.push(trimmed);
    current = "";
    firstWord = "";
    compoundDepth = 0;
    caseDepth = 0;
  };

  while (index < length) {
    const char = source[index];

    if (char === "-" && source[index + 1] === "-") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? length : end;
      current += source.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? length : end + 2;
      current += source.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      current += char;
      index += 1;
      while (index < length) {
        if (source[index] === char) {
          if (source[index + 1] === char) {
            current += char + char;
            index += 2;
            continue;
          }
          current += char;
          index += 1;
          break;
        }
        current += source[index];
        index += 1;
      }
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      let end = index;
      while (end < length && /[A-Za-z0-9_]/.test(source[end])) end += 1;
      const word = source.slice(index, end).toLowerCase();
      current += source.slice(index, end);
      index = end;
      if (!firstWord) firstWord = word;
      // begin immediate / begin transaction 是事务语句，不是 CREATE TRIGGER 的复合体开头。
      if (word === "begin" && firstWord !== "begin") compoundDepth += 1;
      else if (word === "case") caseDepth += 1;
      else if (word === "end") {
        if (caseDepth > 0) caseDepth -= 1;
        else if (compoundDepth > 0) compoundDepth -= 1;
      }
      continue;
    }

    if (char === ";" && compoundDepth === 0) {
      push();
      index += 1;
      continue;
    }

    current += char;
    index += 1;
  }
  push();
  return statements;
}

// 事务状态的原生近似：node:sqlite 的 DatabaseSync.isTransaction 由 C++ 层维护，sql.js 和
// 桥都没有等价物，而 migration-runner 靠它决定要不要补 rollback。桥这一侧 begin/commit 只会
// 从 exec() 进来（store 没有别的入口），所以按首关键字计数就是准确的。
export function transactionKeyword(source) {
  const word = source.trimStart().match(/^([A-Za-z_]+)/)?.[1]?.toLowerCase() ?? "";
  if (word === "begin" || word === "savepoint") return "open";
  if (word === "commit" || word === "rollback" || word === "end" || word === "release") return "close";
  return null;
}
