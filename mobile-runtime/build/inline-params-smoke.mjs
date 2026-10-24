// inlinePositionalParameters 的契约冒烟。内联值只来自调用方绑定参数、不来自用户拼 SQL，
// 判据全部围绕"字面量拼错 = 一条看起来对、结果全错"这一族静默故障。
// 侧栏根因的正面判据在最后几条：@k IS NULL 的 null 不再进 Kotlin 的 rawQuery(String[])。
import { inlinePositionalParameters as inlineP } from "../compat/shims/sqlite-named.mjs";

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, why: String(e?.message ?? e) });
  }
};
const eq = (a, b) => {
  if (a !== b) throw new Error(`得到 ${JSON.stringify(a)}\n期望 ${JSON.stringify(b)}`);
};

check("null → NULL（侧栏 listTaskMetas 的 @workspace_key 查全部时就是它）", () =>
  eq(inlineP("SELECT 1 WHERE (@k IS NULL OR k = ?)", [null]), "SELECT 1 WHERE (@k IS NULL OR k = NULL)"));

check("多个参数按出现顺序内联", () => eq(inlineP("SELECT ?, ?", ["a", 42]), "SELECT 'a', 42"));
check("布尔折叠成 1/0（SQLite 没有布尔字面量）", () => eq(inlineP("SELECT ?, ?", [true, false]), "SELECT 1, 0"));
check("浮点保留小数", () => eq(inlineP("SELECT ?", [1.5]), "SELECT 1.5"));
check("字符串里的单引号翻倍转义", () => eq(inlineP("SELECT ?", ["it's"]), "SELECT 'it''s'"));
check("字符串里的 ? 不占参数位", () => eq(inlineP("SELECT '?' , ?", ["x"]), "SELECT '?' , 'x'"));
check("JSON path '$.a' 整段跳过", () =>
  eq(inlineP("SELECT json_extract(t,'$.a') WHERE k=?", ["v"]), "SELECT json_extract(t,'$.a') WHERE k='v'"));
check("行注释里的 ? 不算参数位", () => eq(inlineP("SELECT 1 -- ?\nWHERE k=?", ["v"]), "SELECT 1 -- ?\nWHERE k='v'"));
check("块注释里的引号与 ? 都照抄", () =>
  eq(inlineP("SELECT 1 /* it's ? here */ WHERE k=?", ["v"]), "SELECT 1 /* it's ? here */ WHERE k='v'"));
check("BLOB → x'hex'（原生桥读路径此前直接拒 BLOB 等值查询）", () =>
  eq(inlineP("SELECT ? WHERE b=?", [new Uint8Array([0, 15, 255]), "s"]), "SELECT x'000fff' WHERE b='s'"));
check("Date → epoch ms", () => eq(inlineP("SELECT ?", [new Date(1700000000000)]), "SELECT 1700000000000"));
check("含 NUL 的字符串走 CAST(x'…' AS TEXT) 而不是静默截断", () =>
  eq(inlineP("SELECT ?", ["a\u0000b"]), "SELECT CAST(x'610062' AS TEXT)"));

// 错误一律抛，静默补 NULL 会让"参数名拼错/数量不符"这条查询看起来对、结果全错。
check("SQL 里的 ? 多于绑定值 → 抛", () => {
  let threw = false;
  try { inlineP("SELECT ?", []); } catch { threw = true; }
  if (!threw) throw new Error("少参数没抛");
});
check("绑定值多于 SQL 的 ? → 抛", () => {
  let threw = false;
  try { inlineP("SELECT 1", ["x"]); } catch { threw = true; }
  if (!threw) throw new Error("多余的绑定值没抛");
});
check("没有参数时原样返回（空 positional 不改 SQL）", () => eq(inlineP("SELECT 1", []), "SELECT 1"));
check("NaN/Infinity 拒绝内联", () => {
  let threw = false;
  try { inlineP("SELECT ?", [Number.NaN]); } catch { threw = true; }
  if (!threw) throw new Error("NaN 被当成合法值");
});
check("裸对象拒绝内联（不能静默 stringify 成 [object Object]）", () => {
  let threw = false;
  try { inlineP("SELECT ?", [{ a: 1 }]); } catch { threw = true; }
  if (!threw) throw new Error("对象参数没抛");
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  process.stdout.write(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n      → ${r.why}`}\n`);
}
process.stdout.write(`\n参数内联冒烟：${results.length - failed.length}/${results.length} PASS\n`);
process.exitCode = failed.length > 0 ? 1 : 0;
