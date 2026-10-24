// 命名参数改写器的 Node 侧契约测试（不进安装包）。
//
// 为什么拿 node:sqlite 当参照实现：改写器的判据不是"我觉着对"，而是
// "同一份 SQL、同一个绑定字典，改写前后取回的行一模一样"。node:sqlite 就是上游 taskIndexRepo
// 实际面对的那个语义（它支持 {name: value}，也支持带 @/:/$ 前缀的键），拿它当oracle，
// 比拿另一个 JS 实现当 oracle 强 —— 后者只会把同一个错抄两遍。
//
// 端侧两个后端各自怎么被验到：sql.js 走 build/chat-e2e.mjs 里那个 taskRows() 读数口
// （它就是被这条改写救回来的），原生桥走 build/selfcheck.mjs 的 namedBindingProbe（假桥 = 真 SQLite）。
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { normalizeBindValues, rewriteNamedParameters } from "../compat/shims/sqlite-named.mjs";

let passed = 0;
let failed = 0;
const run = (label, fn) => {
  try {
    fn();
    passed++;
    console.log("PASS", label);
  } catch (e) {
    failed++;
    console.log("FAIL", label, String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 300));
  }
};

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE t (k TEXT, n TEXT, deleted INTEGER DEFAULT 0, updated_at INTEGER)");
for (const [k, n, at] of [["ws/a", "one", 100], ["ws/b", "two", 200], ["ws/c", "three", 300]]) {
  db.prepare("INSERT INTO t (k, n, deleted, updated_at) VALUES (?, ?, 0, ?)").run(k, n, at);
}
/** 用 node:sqlite 的原生命名绑定取答案，再用改写器跑同一份 SQL，两边必须逐字一致。 */
const againstOracle = (sql, named) => {
  // 两边的行都得是"值一样"，所以两边都先摊成普通对象再比。
  // 为什么：node:sqlite 交回来的是无原型对象（Object.create(null)），而 deepStrictEqual
  // 会把原型也算进去 —— 那不是这条判据要管的事，管的是取回的值一不一样。
  const plain = (rows) => rows.map((row) => ({ ...row }));
  const oracle = plain(db.prepare(sql).all(named));
  const rewritten = normalizeBindValues(sql, [named]);
  const mine = plain(db.prepare(rewritten.sql).all(...rewritten.positional));
  assert.deepEqual(mine, oracle, `改写后结果不同\n  原生=${JSON.stringify(oracle)}\n  改写=${JSON.stringify(mine)}`);
  // 占位符个数必须正好等于绑定值个数（再算上原样本就有的 ?）。
  // 为什么不是"SQL 里不许再出现 @name"：字面量里的 '@k' 本来就该原样留着，
  // 那一串不是参数，把它数进来反而会把唯一能证明"字面量被正确跳过"的判据弄成假红。
  const bare = (sql.match(/\?/g) ?? []).length;
  assert.equal(
    (rewritten.sql.match(/\?/g) ?? []).length,
    bare + rewritten.positional.length,
    `占位符数对不上：${rewritten.sql}`,
  );
  return mine;
};

// 与 taskIndexRepo.listTaskMetas 同一形状：同名参数出现两次，NULL 表示"这一支整条让开"。
run("同名参数出现两次 + NULL 的不过滤语义", () => {
  const sql =
    "SELECT n FROM t WHERE (@k IS NULL OR k = @k) AND (@provider IS NULL OR 1 = 1) AND deleted = 0 ORDER BY updated_at DESC";
  assert.equal(againstOracle(sql, { k: null, provider: null }).length, 3);
  assert.deepEqual(againstOracle(sql, { k: "ws/b", provider: null }), [{ n: "two" }]);
});

run("键带不带前缀都认（node:sqlite 两种都收）", () => {
  const sql = "SELECT n FROM t WHERE k = @k";
  assert.deepEqual(againstOracle(sql, { k: "ws/c" }), [{ n: "three" }]);
  assert.deepEqual(againstOracle(sql, { "@k": "ws/c" }), [{ n: "three" }]);
});

run("字符串字面量和注释里的 @name 不是参数", () => {
  // 这两处要是被改写器当成参数，node:sqlite 会直接报"no such parameter"，结果也就不等价了；
  // 更坏的情况是它被当成真参数、把那句字面量换成 ? —— SQL 语义当场变掉，所以单独一条。
  const sql =
    "SELECT n FROM t WHERE k = @k AND '-- @inline' <> '' AND /* @block */ 1 = 1 AND n NOT LIKE '%@nope%'";
  assert.deepEqual(againstOracle(sql, { k: "ws/a" }), [{ n: "one" }]);
  const rewritten = rewriteNamedParameters(sql, { k: "ws/a" });
  // 字面量/注释要真被跳过了，这几串原文会一个字不差地留在改写后的 SQL 里，且只有一个 ?。
  assert.ok(rewritten.sql.includes("'-- @inline'"), "行注释字面量被改写了");
  assert.ok(rewritten.sql.includes("/* @block */"), "块注释被改写了");
  assert.ok(rewritten.sql.includes("'%@nope%'"), "LIKE 里的 @ 被当成了参数");
  assert.equal(rewritten.positional.length, 1);
});

run("引号里的重复引号（'' 表示一个 '）不提前结束字面量", () => {
  // SQL 里 'it''s @k' 的 @k 在字符串内部。朴素地"遇到下一个引号就结束"会把字面量在
  // 'it'' 处截断，于是 s @k' 露出来变成真参数 —— 这条就是照那个写法反着钉的。
  const sql = "SELECT n FROM t WHERE k = @k AND 'it''s @k' <> ''";
  assert.deepEqual(againstOracle(sql, { k: "ws/a" }), [{ n: "one" }]);
});

run("$name 与 :name 两种前缀", () => {
  assert.deepEqual(againstOracle("SELECT n FROM t WHERE k = $k", { k: "ws/b" }), [{ n: "two" }]);
  assert.deepEqual(againstOracle("SELECT n FROM t WHERE k = :k", { k: "ws/b" }), [{ n: "two" }]);
});

run("负对照：SQL 要的参数名不在对象里 → 当场抛", () => {
  assert.throws(() => normalizeBindValues("SELECT n FROM t WHERE k = @nope", [{ k: "ws/a" }]), /不存在/);
});

run("负对照：对象里多余的键 → 当场抛（参数名拼错不能静默查错）", () => {
  assert.throws(() => normalizeBindValues("SELECT n FROM t WHERE k = @k", [{ k: "ws/a", kk: "x" }]), /用不到/);
});

run("负对照：? 与命名参数混用 → 拒绝，而不是猜顺序", () => {
  // 位置参数列表原样通过（args.length 不是 1，或那一个不是字典），这是上面那条测过的。
  assert.deepEqual(
    normalizeBindValues("SELECT n FROM t WHERE k = ?", ["ws/a"]).positional,
    ["ws/a"],
  );
  assert.throws(
    () => normalizeBindValues("SELECT n FROM t WHERE k = @k OR n = ?", [{ k: "a" }]),
    /混用/,
  );
});

run("位置参数原样通过（不碰 args）", () => {
  const { sql, positional } = normalizeBindValues("SELECT n FROM t WHERE k = ? AND deleted = ?", ["ws/a", 0]);
  assert.equal(sql, "SELECT n FROM t WHERE k = ? AND deleted = ?");
  assert.deepEqual(positional, ["ws/a", 0]);
});

db.close();
console.log(`\n命名参数改写器：${passed}/${passed + failed} PASS`);
if (failed) process.exitCode = 1;
