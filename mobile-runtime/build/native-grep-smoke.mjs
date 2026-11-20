import assert from "node:assert/strict";
import * as vfs from "../compat/vfs.mjs";
import { createMobileFileSystemPort } from "../ports/file-system.mjs";

const results = [];
const test = async (name, fn) => {
  await fn();
  results.push(name);
};

function setupTree() {
  vfs.setFsEngine("memory");
  vfs.reset();
  vfs.mkdir("/work/src/deep", { recursive: true });
  vfs.mkdir("/outside", { recursive: true });
  vfs.writeFile("/outside/secret.txt", "TOKEN_HIT secret inside outside\n");

  for (let i = 0; i < 600; i++) {
    const ext = i % 3 === 0 ? "ts" : "txt";
    const body = i === 17
      ? "alpha\nTOKEN_HIT alpha-marker\nomega\n"
      : i === 243
        ? "first line\ntoken_hit lower-case\n-dash-flag hit\nlast 2026\n"
        : `line ${i} regular content without target\n`;
    vfs.writeFile(`/work/src/file-${String(i).padStart(4, "0")}.${ext}`, body);
  }
  vfs.writeFile("/work/src/deep/sub.ts", "nested\nTOKEN_HIT deep-entry\nend\n");
  try {
    vfs.symlinkSync("/outside/secret.txt", "/work/src/leak.txt");
  } catch { /* 某些环境无 symlink 时跳过越界用例构建 */ }
}

function collectMemFiles(dir, out = []) {
  for (const e of vfs.readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${e.name}`;
    if (e.isDirectory()) collectMemFiles(full, out);
    else out.push(full);
  }
  return out;
}

function makeEmulatedExec({ failExit = false } = {}) {
  const calls = [];
  let grepHitsReadCount = 0;
  return {
    calls,
    getReadCount: () => grepHitsReadCount,
    runner: {
      async exec(req) {
        calls.push(req);
        if (failExit) return { exitCode: 2, stdout: "", stderr: "simulated grep/find failure" };
        const base = req.cwd || "/work";
        const all = collectMemFiles(base);
        if (req.file === "find") {
          const rels = all.map(p => "./" + p.slice(base.length + 1));
          return { exitCode: 0, stdout: rels.join("\n") + "\n", stderr: "" };
        }
        if (req.file === "grep") {
          const dashDash = req.args.indexOf("--");
          assert.ok(dashDash >= 0, "grep 参数必须包含 -- 防负号注入");
          const flags = req.args.slice(0, dashDash).join("");
          const ignoreCase = flags.includes("i");
          const pattern = req.args[dashDash + 1];
          const re = new RegExp(pattern, ignoreCase ? "i" : "");
          const hits = [];
          for (const abs of all) {
            // 对越界链接直接按真实路径可读模拟原生扫描返回，检验 checkAccess 是否拦截！
            let txt = "";
            try {
              const target = abs.endsWith("leak.txt") ? "/outside/secret.txt" : abs;
              txt = vfs.readFileSync(target, "utf8");
            } catch { continue; }
            if (txt.split("\n").some(l => re.test(l))) {
              hits.push("./" + abs.slice(base.length + 1));
            }
          }
          if (hits.length === 0) return { exitCode: 1, stdout: "", stderr: "" };
          return { exitCode: 0, stdout: hits.join("\n") + "\n", stderr: "" };
        }
        return { exitCode: 2, stdout: "", stderr: "unsupported tool" };
      },
    },
    wrapReadMany() {
      const origReadMany = vfs.readMany;
      return {
        ...vfs,
        readMany(paths) {
          grepHitsReadCount += paths.length;
          return origReadMany(paths);
        },
      };
    },
  };
}

function normalizeSearchResult(r) {
  return {
    mode: r.mode,
    files: [...r.files].sort(),
    numMatches: r.numMatches,
    entries: [...r.entries].sort((a, b) => a.path.localeCompare(b.path) || (a.lineNumber ?? 0) - (b.lineNumber ?? 0)),
  };
}

setupTree();
const jsPort = createMobileFileSystemPort(vfs, { workspaceRoot: "/work" });

await test("B-02 find 下沉与 JS walk 结果一致且拦截越界 symlink", async () => {
  const emu = makeEmulatedExec();
  const nativePort = createMobileFileSystemPort(vfs, { workspaceRoot: "/work", exec: emu.runner });
  const a = await jsPort.searchFiles({ path: "/work", pattern: "**/*.ts" });
  const b = await nativePort.searchFiles({ path: "/work", pattern: "**/*.ts" });
  assert.deepEqual([...b.files].sort(), [...a.files].sort());
  assert.equal(emu.calls.filter(c => c.file === "find").length, 1);
  assert.ok(!b.files.some(f => f.includes("leak.txt")), "越界符号链接不能出现在搜索结果");
});

await test("B-02 grep 下沉仅 readMany 命中文件且 ERE/context/onlyMatching/count/glob/负号安全 全一致", async () => {
  const emu = makeEmulatedExec();
  const wrappedVfs = emu.wrapReadMany();
  const nativePort = createMobileFileSystemPort(wrappedVfs, { workspaceRoot: "/work", exec: emu.runner });

  const cases = [
    { path: "/work", pattern: "TOKEN_HIT", outputMode: "content", beforeContext: 1, afterContext: 1 },
    { path: "/work", pattern: "TOKEN_HIT", ignoreCase: true, outputMode: "count" },
    { path: "/work", pattern: "token_hit|TOKEN_HIT", glob: "*.ts", outputMode: "content", onlyMatching: true },
    { path: "/work", pattern: "-dash-flag", outputMode: "content" },
    { path: "/work", pattern: "NEVER_MATCH_ANY_FILE_XYZ", outputMode: "files_with_matches" },
  ];

  for (const query of cases) {
    const baseline = await jsPort.searchText(query);
    const accelerated = await nativePort.searchText(query);
    assert.deepEqual(normalizeSearchResult(accelerated), normalizeSearchResult(baseline), `不一致: ${JSON.stringify(query)}`);
  }

  // 总共 5 条查询，全走原生 grep 时绝不能把 600 个文件全 readMany 进来（总共命中 < 20 个文件）
  assert.ok(emu.getReadCount() < 25, `期望仅 readMany 少量命中文件，实际读取了 ${emu.getReadCount()} 次`);
  assert.ok(emu.calls.filter(c => c.file === "grep").length === cases.length);
});

await test("B-02 JS 专有正则(\\d+ / (?=) / multiline / 非法正则) 安全回退", async () => {
  const emu = makeEmulatedExec();
  const nativePort = createMobileFileSystemPort(vfs, { workspaceRoot: "/work", exec: emu.runner });
  const jsOnlyQueries = [
    { path: "/work", pattern: "last \\d{4}", outputMode: "content" },
    { path: "/work", pattern: "(?=token_hit)token_hit", outputMode: "files_with_matches" },
    { path: "/work", pattern: "first line\\ntoken_hit", multiline: true, outputMode: "content" },
  ];
  for (const q of jsOnlyQueries) {
    const a = await jsPort.searchText(q);
    const b = await nativePort.searchText(q);
    assert.deepEqual(normalizeSearchResult(b), normalizeSearchResult(a));
  }
  assert.equal(emu.calls.length, 0, "JS 专有正则或 multiline 不得错误下沉到 POSIX grep");
  await assert.rejects(() => nativePort.searchText({ path: "/work", pattern: "[unclosed" }), e => e.code === "invalid_pattern");
});

await test("B-02 原生命令退出码 >= 2 时无缝回退 JS 扫描不报错", async () => {
  const emu = makeEmulatedExec({ failExit: true });
  const fallbackPort = createMobileFileSystemPort(vfs, { workspaceRoot: "/work", exec: emu.runner });
  const aFiles = await jsPort.searchFiles({ path: "/work", pattern: "**/sub.ts" });
  const bFiles = await fallbackPort.searchFiles({ path: "/work", pattern: "**/sub.ts" });
  assert.deepEqual(bFiles.files, aFiles.files);

  const aText = await jsPort.searchText({ path: "/work", pattern: "deep-entry", outputMode: "content" });
  const bText = await fallbackPort.searchText({ path: "/work", pattern: "deep-entry", outputMode: "content" });
  assert.deepEqual(normalizeSearchResult(bText), normalizeSearchResult(aText));
});

console.log(`native-grep-smoke: ${results.length}/${results.length} PASS`);
for (const name of results) console.log(`  ✓ ${name}`);
