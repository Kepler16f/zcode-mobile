// 端侧 vfs 的 Node 侧契约测试：两个后端 + 假桥协议 + JS/Kotlin 两侧的请求形状。
// 最后一项是 0.0.2 真机炸出来加的：Kotlin 的 rename 读 `from`、JS 只发 `path`，
// 而假桥是按 JS 的形状写的，所以桌面 28 条全绿、装机当场 EIO。形状必须由两侧源码对撞，不能靠一边想象另一边。
import { readFileSync } from "node:fs";
import { probeFsSemantics, makeFakeFsBridge } from "./selfcheck.mjs";
import { createMobileFileSystemPort } from "../ports/file-system.mjs";
import * as vfs from "../compat/vfs.mjs";
import * as native from "../compat/vfs-native.mjs";

const run = (label, fn) => {
  try {
    const detail = fn();
    console.log("PASS", label, JSON.stringify(detail));
  } catch (e) {
    console.log("FAIL", label, String(e?.message ?? e));
    process.exitCode = 1;
  }
};

run("内存盘（dispatcher→memory）", () => {
  vfs.setFsEngine("memory");
  if (vfs.engine() !== "memory") throw new Error("引擎没切到 memory");
  return probeFsSemantics(vfs, "/work/smoke-mem");
});

run("假桥（dispatcher→native→zcodeFs）", () => {
  globalThis.zcodeFs = makeFakeFsBridge();
  vfs.setFsEngine("native");
  if (vfs.engine() !== "native") throw new Error("引擎没切到 native");
  const detail = probeFsSemantics(vfs, "/work/smoke-native");
  vfs.rmSync("/work/smoke-native", { recursive: true, force: true });
  if (vfs.existsSync("/work/smoke-native")) throw new Error("假桥递归删除没生效");
  return { ...detail, ops: globalThis.zcodeFs.ops };
});

run("两个后端在同样输入下返回同样的形状", () => {
  delete globalThis.zcodeFs;
  const body = "中文 ✓\r\nend\n";
  const bin = new Uint8Array([0, 253, 255]);
  const shapes = {};
  for (const e of ["memory", "native"]) {
    globalThis.zcodeFs = e === "native" ? makeFakeFsBridge() : undefined;
    vfs.setFsEngine(e);
    vfs.mkdir("/work/shape", { recursive: true });
    vfs.writeFile("/work/shape/a.txt", body, {});
    vfs.writeFile("/work/shape/b.bin", bin, {});
    const st = vfs.statSync("/work/shape/a.txt");
    const listSt = vfs.statSync("/work/shape");
    shapes[e] = {
      text: vfs.readFileSync("/work/shape/a.txt", "utf8"),
      binLen: vfs.readFileSync("/work/shape/b.bin").length,
      hex: vfs.readFileSync("/work/shape/b.bin", "hex"),
      base64: vfs.readFileSync("/work/shape/b.bin", "base64"),
      latin1: vfs.readFileSync("/work/shape/b.bin", "latin1"),
      isFile: st.isFile(),
      isDir: listSt.isDirectory(),
      size: st.size,
      mtimeMsType: typeof st.mtimeMs,
      modeType: typeof st.mode,
      readdir: vfs.readdirSync("/work/shape", { withFileTypes: true }).map((x) => [x.name, x.isFile(), x.isDirectory()]),
      // 批量读里混一个不存在的路径：两项都得按同一形状失败，不能让一个坏路径把整批打抛。
      readMany: vfs
        .readMany(["/work/shape/a.txt", "/work/shape/missing.txt", "/work/shape"])
        .map((r) => [r.path, r.ok, r.ok ? r.bytes.length : r.code]),
    };
  }
  const a = JSON.stringify(shapes.memory);
  const b = JSON.stringify(shapes.native);
  if (a !== b) throw new Error("形状不一致：\nmemory=" + a + "\nnative=" + b);
  vfs.rmSync("/work/shape", { recursive: true, force: true });
  return { identical: true, sample: JSON.parse(a).text.slice(0, 8) };
});

run("桥缺席时显式回 memory，不假装真盘", () => {
  delete globalThis.zcodeFs;
  vfs.setFsEngine(null);
  const e = vfs.engine();
  if (e !== "memory") throw new Error("没桥却报告了 " + e);
  return { engine: e };
});

run("强制 native 但桥不存在 → 退回 memory 而不是崩", () => {
  vfs.setFsEngine("native");
  const e = vfs.engine();
  if (e !== "memory") throw new Error("引擎判定不对：" + e);
  vfs.setFsEngine(null);
  return { engine: e };
});

// 端口层的 Grep 才是批量读真正影响到的地方：readMany 只换"怎么读"，不该换"读出什么"。
// 这里同一棵树在两个后端上各建一次（路径相同，存储各自独立），跑五种模式逐字段对撞。
const runAsync = async (label, fn) => {
  try {
    const detail = await fn();
    console.log("PASS", label, JSON.stringify(detail));
  } catch (e) {
    console.log("FAIL", label, String(e?.message ?? e));
    process.exitCode = 1;
  }
};

class FileSystemPortError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
  }
}

const GREP_CASES = [
  ["唯一命中", { pattern: "marker-7$", outputMode: "files_with_matches" }],
  ["内容+上下文", { pattern: "v3 ", outputMode: "content", beforeContext: 1, afterContext: 1 }],
  ["计数", { pattern: "填充", outputMode: "count" }],
  ["跨行 multiline", { pattern: "v0[\\s\\S]*?marker", multiline: true, outputMode: "content", onlyMatching: true }],
  ["-o 只给命中片段", { pattern: "marker-\\d+", outputMode: "content", onlyMatching: true }],
  ["glob 过滤", { pattern: "marker-7$", glob: "**/odd*.ts", outputMode: "files_with_matches" }],
];

await runAsync("端口层 Grep 在两个后端上结果逐字一致（批量读没改语义）", async () => {
  const results = {};
  for (const e of ["memory", "native"]) {
    if (e === "native") globalThis.zcodeFs = makeFakeFsBridge();
    else delete globalThis.zcodeFs;
    vfs.setFsEngine(e);
    const base = "/work/grep";
    vfs.rmSync(base, { recursive: true, force: true });
    for (let i = 0; i < 600; i++) {
      const dir = `${base}/d${i % 20}`;
      vfs.mkdir(dir, { recursive: true });
      const body = Array.from({ length: 20 }, (_, n) => `v${n} 填充 ${i * n}`).join("\n") + `\nmarker-${i}\n`;
      vfs.writeFile(`${dir}/${i % 2 ? "even" : "odd"}${i}.ts`, body, {});
    }
    const port = createMobileFileSystemPort(vfs, { workspaceRoot: base, FileSystemPortError });
    results[e] = {};
    for (const [label, request] of GREP_CASES) {
      const out = await port.searchText({ path: base, ...request });
      // durationMs 每次不同，比较前去掉；文件顺序两个后端都按 readdir 排序，应当一致。
      results[e][label] = { numMatches: out.numMatches, files: out.files, entries: out.entries };
    }
    vfs.rmSync(base, { recursive: true, force: true });
  }
  const a = JSON.stringify(results.memory);
  const b = JSON.stringify(results.native);
  if (a !== b) {
    const diff = Object.keys(results.memory).find((k) => JSON.stringify(results.memory[k]) !== JSON.stringify(results.native[k]));
    throw new Error(`用例「${diff}」两个后端结果不同：\nmemory=${JSON.stringify(results.memory[diff]).slice(0, 300)}\nnative=${JSON.stringify(results.native[diff]).slice(0, 300)}`);
  }
  const cases = Object.keys(results.memory).length;
  if (results.memory["唯一命中"].files.length !== 1) throw new Error("唯一命中应当恰好报 1 个文件，拿到 " + JSON.stringify(results.memory["唯一命中"].files));
  return { cases, files: results.memory["唯一命中"].files, countMatches: results.memory["计数"].numMatches };
});

// —— JS ↔ Kotlin 的请求形状对撞 ——
// Kotlin 里 req.getString("k") / req.getJSONArray("k") 在缺键时直接抛 JSONException，所以这些键是硬契约；
// optString/optBoolean 有默认值，不算。假桥永远按 JS 的形状写，靠它自己发现不了两侧不一致。
function collectReqKeys(lines, headerRe) {
  const sets = new Map();
  let target = null;
  for (const line of lines) {
    const head = line.match(headerRe);
    if (head) {
      target = new Map();
      sets.set(head[1], target);
    } else if (/^\s*(private|internal)\s+fun\s/.test(line)) {
      // 走到 call() 之外的辅助函数就收手：when 之后的行不该再算给最后一个分支（touchRoot 会把全文件吃掉）。
      // 先看 head，第二趟的表头本身就是 `private fun xxx(req: JSONObject)`，不能被这里截掉。
      target = null;
      continue;
    }
    if (!target) continue;
    // 分支写在同一行时（`"stat" -> ok(statOf(resolve(req.getString("path"))))`）也要收到键：
    // 早先这里在表头行 `continue`，单行分支的硬契约等于没查，报坏键时也就说不出是哪一个 getter。
    for (const m of line.matchAll(/req\.(getString|getJSONArray)\("([A-Za-z]+)"\)/g)) target.set(m[2], m[1]);
  }
  return sets;
}

run("桥协议：Kotlin 每个 op 硬要的键，JS 都真的发了", () => {
  // ZCODE_FS_BRIDGE_KT 只为负对照留的口子：拿一份改坏的 FsBridge.kt 跑这里，确认检查不是空过。
  const ktPath = process.env.ZCODE_FS_BRIDGE_KT
    ? new URL(`file://${process.env.ZCODE_FS_BRIDGE_KT}`)
    : new URL("../../android-app/app/src/main/kotlin/cn/zcode/mobile/FsBridge.kt", import.meta.url);
  const kt = readFileSync(ktPath, "utf8");
  const lines = kt.split(/\r?\n/);
  // 第一趟收 helper（write(req)/rm(req) 这类把整包递给函数体的分支），第二趟才能把它们的键并进分支。
  const helpers = collectReqKeys(lines, /^\s*private fun ([A-Za-z]+)\(req: JSONObject\)/);
  const byOp = collectReqKeys(lines, /^\s*"([A-Za-z]+)"\s*->/);
  for (const [op, keys] of byOp) {
    const delegated = (lines.find((l) => l.includes(`"${op}" ->`)) ?? "").match(/\b([a-z]+)\(req\)/);
    if (delegated && helpers.has(delegated[1])) for (const [k, getter] of helpers.get(delegated[1])) keys.set(k, getter);
  }

  const sent = new Map();
  const inner = makeFakeFsBridge();
  globalThis.zcodeFs = {
    name: () => "zcodeFs",
    ops: inner.ops,
    call(request) {
      const req = JSON.parse(request);
      if (!sent.has(req.op)) sent.set(req.op, new Set());
      for (const key of Object.keys(req)) sent.get(req.op).add(key);
      return inner.call(request);
    },
  };
  vfs.setFsEngine("native");
  const dir = "/work/contract";
  try {
    native.mkdir(`${dir}/sub`, { recursive: true });
    native.writeFile(`${dir}/a.txt`, "A", {});
    native.writeFile(`${dir}/b.txt`, "B", { flag: "a" });
    native.statSync(`${dir}/a.txt`);
    native.lstatSync(`${dir}/a.txt`);
    native.existsSync(`${dir}/a.txt`);
    native.accessSync(`${dir}/a.txt`);
    native.readFileSync(`${dir}/a.txt`, "utf8");
    // 批量读的请求体没有 `path`（主体在 `paths` 数组里），这是唯一一支不走 {op,path,...} 形状的 op，
    // 必须在这里发一次，否则 Kotlin 加了 getJSONArray("paths") 而 JS 忘了发，桌面照样全绿。
    native.readMany([`${dir}/a.txt`, `${dir}/b.txt`]);
    native.readdirSync(dir, { withFileTypes: true });
    native.realpathSync(`${dir}/a.txt`);
    native.symlinkSync(`${dir}/a.txt`, `${dir}/link`);
    native.readlinkSync(`${dir}/link`);
    native.renameSync(`${dir}/a.txt`, `${dir}/renamed.txt`);
    native.unlinkSync(`${dir}/renamed.txt`);
    native.mkdir(`${dir}/empty`, { recursive: true });
    native.rmdir(`${dir}/empty`);
    native.rmSync(dir, { recursive: true });
  } finally {
    vfs.setFsEngine(null);
    delete globalThis.zcodeFs;
  }

  const problems = [];
  for (const op of sent.keys()) {
    if (!byOp.has(op)) problems.push(`JS 发了 op "${op}"，Kotlin 的 when 里没有这一支（会回 EINVAL 未知操作）`);
  }
  for (const [op, ktKeys] of byOp) {
    const jsKeys = sent.get(op);
    if (!jsKeys) continue; // exists/copy/touchRoot 这类 JS 暂时没用到，不算错
    for (const [key, getter] of ktKeys) if (!jsKeys.has(key)) problems.push(`op "${op}"：Kotlin 要 ${getter}("${key}")，JS 只发了 [${[...jsKeys].join(", ")}]`);
  }
  if (problems.length) throw new Error(problems.join("；"));
  return { opsChecked: [...sent.keys()].sort(), kotlinOps: [...byOp.keys()].sort() };
});
