// DSML 兜底解析的单元冒烟（0.4.8）。判据钉四格：
//  ① 用户贴屏的原样（全角竖线被输入法转过的）能解析出调用与参数；
//  ② 半角原样 + 多 invoke 并列；
//  ③ 非 string 参数走 JSON 值（数字保类型）；
//  ④ 残块/无块/闲聊提到 <|DSML|> 字样 → null（宁可当正文，不喂半个调用给执行器）。
import { parseDsmlCalls } from "../ui/dsml.ts";

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  → got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
}

// ① 用户贴屏原样（全角 ｜，含 ｜｜ 双写）
const full = `我来列出文件。\n<｜｜DSML｜｜ calls> <｜｜DSML｜｜ invoke name="list_files"> <｜｜DSML｜｜ parameter name="path" string="true">/mnt/tree</｜｜DSML｜｜ parameter> </｜｜DSML｜｜ invoke> </｜｜DSML｜｜ calls>`;
const r1 = parseDsmlCalls(full);
eq("①全角贴屏样例：解析出 1 个调用", r1?.calls.map((c) => [c.name, JSON.parse(c.arguments)]), [["list_files", { path: "/mnt/tree" }]]);
eq("①rest 去块", r1?.rest, "我来列出文件。");

// ② 半角 + 多 invoke
const half = `<|DSML|>calls
<|DSML|>invoke name="Read"
<|DSML|>parameter name="file_path" string="true"
/work/a.ts
<|DSML|>/parameter>
<|DSML|>/invoke>
<|DSML|>invoke name="Grep"
<|DSML|>parameter name="pattern" string="true"
foo
<|DSML|>/parameter>
<|DSML|>/invoke>
<|DSML|>/calls>`;
const r2 = parseDsmlCalls(half);
eq("②半角多 invoke：两个调用", r2?.calls.map((c) => c.name), ["Read", "Grep"]);
eq("②参数各自正确", r2?.calls.map((c) => JSON.parse(c.arguments)), [{ file_path: "/work/a.ts" }, { pattern: "foo" }]);

// ③ 非 string 参数保 JSON 类型
const num = `<|DSML|>calls
<|DSML|>invoke name="Glob"
<|DSML|>parameter name="limit"
5
<|DSML|>/parameter>
<|DSML|>/invoke>
<|DSML|>/calls>`;
eq("③数字参数保类型", parseDsmlCalls(num)?.calls.map((c) => JSON.parse(c.arguments)), [{ limit: 5 }]);

// ④ 残块/无块/闲聊
eq("④残块（invoke 未闭合）→ null", parseDsmlCalls(`<|DSML|>calls <|DSML|>invoke name="x"`), null);
eq("④无块 → null", parseDsmlCalls("普通回答，没有调用"), null);
eq("④闲聊提到标记 → null", parseDsmlCalls("这个格式叫 <|DSML|>，别乱用"), null);

console.log(`\nDSML 冒烟：${pass}/${pass + fail} PASS`);
process.exit(fail > 0 ? 1 : 0);
