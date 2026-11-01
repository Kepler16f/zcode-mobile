// 合成命令层（0.10.x：端侧 Bash 的 jq/curl/wget/unzip）的单元冒烟。
//
// 钉四组判据：
//   ① jq 子集纯函数：字段/下标/迭代/管道/-r/length/keys/select/非法 JSON 报错/-e 退出码/
//      不支持旗标退出码 2；
//   ② 管道解析（保守退回）：整条全是合成命令才解析成功；echo、重定向、; && ||、$()、
//      反引号、变量、glob、未闭合引号……任何一个混进来都整条退回 sh——这条是"不弄坏
//      现有 Bash"的核心，`echo … | jq …` 必须原样交给 sh 而不是本地半执行；
//   ③ 引擎级拦截（真 tool-engine + 假 core executor 计数假 sh）：echo 管道必须计到 sh；
//      `curl | jq` 型必须本地执行且假桥收到正确的 method/headers；-o/-O/wget 落盘进 vfs；
//      不支持旗标不出网；unzip 走假桥形状 + 越界路径被端口授权闸拒（permission_denied）；
//   ④ Bash 工具描述带出合成命令边界（模型按描述用）。
//
// 复用真 core bundle（build/dist/zcode-core.mobile.js）装配引擎——与 tool-boundary-smoke
// 同一套路：instanceof/授权闸都来自同一份模块图，不是重写的替身。
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const esbuild = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"))("esbuild");
const output = path.join(root, "mobile-runtime/build", `.tmp-synthetic-${process.pid}.mjs`);

const ui = (p) => path.join(root, "mobile-runtime/ui", p).replaceAll("\\", "/");
await esbuild.build({
  stdin: {
    contents: [
      `export {createToolEngineFactory} from "${ui("tool-engine.ts")}";`,
      `export {SYNTHETIC_COMMANDS, resolveSyntheticPipeline, runSyntheticPipeline, syntheticCommandsNote} from "${ui("synthetic-commands.ts")}";`,
      `export * as core from "${path.join(root, "mobile-runtime/build/dist/zcode-core.mobile.js").replaceAll("\\", "/")}";`,
    ].join("\n"),
    resolveDir: root,
  },
  alias: { typescript: path.join(root, "mobile-runtime/build/dist/shims/typescript-stub.js") },
  outfile: output,
  bundle: true, format: "esm", platform: "node", target: "node24", logLevel: "warning",
});

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push([name, true, ""]); })
    .catch((e) => { results.push([name, false, String((e && e.message) || e)]); });
}

try {
  const { createToolEngineFactory, SYNTHETIC_COMMANDS, resolveSyntheticPipeline, syntheticCommandsNote, core } =
    await import(pathToFileURL(output).href);

  const stubHost = {
    workspacePath: "/work/a",
    writeFile: async () => { throw new Error("冒烟里 jq 不应落盘"); },
    checkPathAccess: () => {},
  };
  const jq = (args, stdin) => SYNTHETIC_COMMANDS.jq.run(args, stdin, stubHost);

  // ── ① jq 子集纯函数 ──
  await check("jq . 恒等回原（紧凑单行）", async () => {
    const r = await jq(["."], '{"a":1,"b":[2]}');
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, '{"a":1,"b":[2]}');
  });
  await check("jq .a / .a.b 字段链，缺字段给 null", async () => {
    assert.deepEqual(await jq([".a"], '{"a":1}'), { stdout: "1", exitCode: 0 });
    const r = await jq([".a.b"], '{"a":{"b":"x"}}');
    assert.equal(r.stdout, '"x"');
    const miss = await jq([".zz"], '{"a":1}');
    assert.equal(miss.stdout, "null");
    assert.equal(miss.exitCode, 0);
  });
  await check("jq .[0] 与负下标 .[-1]", async () => {
    assert.equal((await jq([".[0]"], "[10,20]")).stdout, "10");
    assert.equal((await jq([".[-1]"], "[10,20]")).stdout, "20");
    assert.equal((await jq([".[5]"], "[10,20]")).stdout, "null");
  });
  await check("jq .[] 迭代数组（逐行）", async () => {
    const r = await jq([".[]"], "[1,2,3]");
    assert.equal(r.stdout, "1\n2\n3");
    assert.equal(r.exitCode, 0);
  });
  await check("jq 管道 .[] | .name", async () => {
    const r = await jq([".[] | .name"], '[{"name":"a"},{"name":"b"}]');
    assert.equal(r.stdout, '"a"\n"b"');
  });
  await check("jq -r 原样输出字符串", async () => {
    assert.equal((await jq(["-r", ".name"], '{"name":"hi"}')).stdout, "hi");
    assert.equal((await jq(["-r", "."], '{"name":"hi"}')).stdout, '{"name":"hi"}');
  });
  await check("jq length / keys", async () => {
    assert.equal((await jq(["length"], "[1,2]")).stdout, "2");
    assert.equal((await jq(["length"], '"abcd"')).stdout, "4");
    assert.equal((await jq(["length"], '{"a":1,"b":2}')).stdout, "2");
    assert.equal((await jq(["length"], "null")).stdout, "0");
    assert.equal((await jq(["keys"], '{"b":1,"a":2}')).stdout, '["a","b"]');
  });
  await check("jq select == / != / 字符串字面量", async () => {
    assert.equal((await jq(["select(.a == 1)"], '{"a":1,"v":9}')).stdout, '{"a":1,"v":9}');
    const miss = await jq(["select(.a != 1)"], '{"a":1}');
    assert.equal(miss.stdout, "");
    assert.equal(miss.exitCode, 0);
    assert.equal((await jq(["select(.name == \"b\")"], '{"name":"b"}')).stdout, '{"name":"b"}');
    const piped = await jq([".[] | select(.on == true)"], '[{"on":true},{"on":false}]');
    assert.equal(piped.stdout, '{"on":true}');
  });
  await check("jq 非法 JSON：报错带「前 80 字符」且退出码非零", async () => {
    const long = `${"x".repeat(100)}!!!`;
    const r = await jq(["."], `{${long}`);
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.stdout.includes("输入不是合法 JSON"), r.stdout);
    assert.ok(r.stdout.includes("前 80 字符"), r.stdout);
    assert.ok(r.stdout.length < 160, `报错不应回灌整个输入：${r.stdout.length}`);
  });
  await check("jq -e：空结果/null/false 退出码 1", async () => {
    assert.equal((await jq(["-e", ".missing"], '{"a":1}')).exitCode, 1);
    assert.equal((await jq(["-e", "select(.a == 2)"], '{"a":1}')).exitCode, 1);
    assert.equal((await jq(["-e", ".a"], '{"a":1}')).exitCode, 0);
    assert.equal((await jq(["-e", "."], "null")).exitCode, 1);
  });
  await check("jq 不支持旗标/文件参数 → 退出码 2 + 指路", async () => {
    const flag = await jq(["-x", "."], "{}");
    assert.equal(flag.exitCode, 2);
    assert.ok(flag.stdout.includes("不支持旗标 -x"), flag.stdout);
    const file = await jq([".a", "data.json"], "{}");
    assert.equal(file.exitCode, 2);
    assert.ok(file.stdout.includes("不支持文件参数"), file.stdout);
  });

  // ── ② 管道解析：保守退回 ──
  await check("解析：纯合成管道逐段切词（引号里的 | 不是管道）", async () => {
    assert.deepEqual(resolveSyntheticPipeline("jq .a"), [{ name: "jq", args: [".a"] }]);
    const two = resolveSyntheticPipeline("curl -s https://x.test/api | jq .x");
    assert.deepEqual(two, [
      { name: "curl", args: ["-s", "https://x.test/api"] },
      { name: "jq", args: [".x"] },
    ]);
    assert.deepEqual(resolveSyntheticPipeline("jq '.a | .b'"), [{ name: "jq", args: [".a | .b"] }]);
    assert.deepEqual(resolveSyntheticPipeline('unzip p.zip -d "my dir"'), [
      { name: "unzip", args: ["p.zip", "-d", "my dir"] },
    ]);
  });
  await check("退回：echo 混排 / 重定向 / ; && || / $ 与反引号 / glob / 未闭合引号", async () => {
    const cases = [
      "echo '{\"a\":1}' | jq .a",
      "echo hi > f.txt",
      "jq .a > out.json",
      "jq .a >> log",
      "jq .a; jq .b",
      "jq .a && jq .b",
      "jq . || curl -s https://x.test",
      'jq "$HOME"',
      "jq `x`",
      "jq .a *",
      "jq 'unterminated",
      "cd /tmp && jq .a",
      "FOO=1 jq .a",
      "jq .a\njq .b",
      "cat data.json | jq .a",
      "",
    ];
    for (const command of cases) {
      assert.equal(resolveSyntheticPipeline(command), null, `应退回 sh：${JSON.stringify(command)}`);
    }
  });

  // ── ③ 引擎级拦截（假 sh 计数） ──
  core.vfs.setFsEngine("memory");
  core.vfs.mkdir("/work/a", { recursive: true });
  const shCalls = [];
  const fakeCore = {
    ...core,
    createNativeExecBridge: () => ({}),
    createMobileExecutionPort: () => ({}),
    createToolExecutor: () => ({
      execute: async (call) => {
        shCalls.push(String(call.input.command));
        return { content: `SH<${String(call.input.command)}>`, isError: false };
      },
    }),
  };
  const engine = await createToolEngineFactory({ loadCore: async () => fakeCore })("/work/a");
  assert.ok(engine, "工具引擎应装配成功");
  const bash = (command) => engine.execute({ id: `syn-${shCalls.length}-${Math.random()}`, name: "Bash", arguments: JSON.stringify({ command }) });

  const httpCalls = [];
  const bodyOf = (url) => (url.endsWith("/raw") ? "not-json" : '{"x":42,"n":[1,2]}');
  const statusOf = (url) => (url.endsWith("/err") ? 404 : 200);
  globalThis.zcodeGitHttp = {
    call(request) {
      const payload = JSON.parse(request);
      httpCalls.push(payload);
      return JSON.stringify({
        statusCode: statusOf(payload.url),
        statusMessage: "OK",
        headers: { "content-type": "application/json" },
        bodyBase64: Buffer.from(bodyOf(payload.url)).toString("base64"),
      });
    },
  };
  const unzipRequests = [];
  globalThis.zcodeExec = {
    exec() { return "{}"; },
    unzip(request) {
      const req = JSON.parse(request);
      unzipRequests.push(req);
      return JSON.stringify({ ok: true, files: 3 });
    },
  };

  await check("钉死保守退回：echo 管道整条交给 sh，绝不本地半执行", async () => {
    const before = shCalls.length;
    const r = await bash(`echo '{"a":1}' | jq .a`);
    assert.equal(shCalls.length, before + 1, "echo 混排必须退回 sh");
    assert.equal(r.isError, false);
    assert.equal(r.content, `SH<echo '{"a":1}' | jq .a>`);
  });
  await check("curl | jq 型本地执行：假 sh 零调用，结果直出", async () => {
    const before = shCalls.length;
    const r = await bash("curl -s https://example.test/api | jq .x");
    assert.equal(shCalls.length, before, "合成管道不得进 sh");
    assert.equal(r.isError, false);
    assert.equal(r.content, "42");
  });
  await check("curl -H 多次透传 + -X 换方法到桥", async () => {
    const before = httpCalls.length;
    const r = await bash('curl -s -H "Accept: application/json" -H "X-Token: abc" -X PUT https://example.test/api');
    assert.equal(r.isError, false);
    const sent = httpCalls[httpCalls.length - 1];
    assert.equal(sent.method, "PUT");
    assert.equal(sent.headers["Accept"], "application/json");
    assert.equal(sent.headers["X-Token"], "abc");
    assert.ok(httpCalls.length === before + 1);
  });
  await check("curl -d 转 POST，body 原样到桥", async () => {
    const r = await bash("curl -s -d 'k=1&j=2' https://example.test/api");
    assert.equal(r.isError, false);
    const sent = httpCalls[httpCalls.length - 1];
    assert.equal(sent.method, "POST");
    assert.equal(Buffer.from(sent.bodyBase64, "base64").toString("utf8"), "k=1&j=2");
  });
  await check("curl -o 落盘工作区文件（vfs 里真有内容）", async () => {
    const r = await bash("curl -s https://example.test/api -o out/data.json");
    assert.equal(r.isError, false);
    assert.ok(r.content.includes("已保存") && r.content.includes("/work/a/out/data.json"), r.content);
    assert.equal(core.vfs.readFileSync("/work/a/out/data.json", "utf8"), '{"x":42,"n":[1,2]}');
  });
  await check("curl 不支持旗标：退出码 2、不出网、内容指路 Fetch", async () => {
    const before = httpCalls.length;
    const r = await bash("curl -v https://example.test/api");
    assert.equal(r.isError, true);
    assert.ok(r.content.includes("不支持旗标 -v"), r.content);
    assert.equal(httpCalls.length, before, "不支持旗标不得出网");
  });
  await check("curl -O（含合并短旗标 -sO）按 URL 文件名落盘", async () => {
    const r = await bash("curl -sO https://example.test/api");
    assert.equal(r.isError, false);
    assert.ok(r.content.includes("/work/a/api"), r.content);
    assert.equal(core.vfs.readFileSync("/work/a/api", "utf8"), '{"x":42,"n":[1,2]}');
  });
  await check("curl 管道接非法 JSON：退出码非零如实回模型", async () => {
    const r = await bash("curl -s https://example.test/raw | jq .x");
    assert.equal(r.isError, true);
    assert.ok(r.content.includes("输入不是合法 JSON"), r.content);
  });
  await check("wget -O 落盘 + 缺省按 URL 文件名落盘", async () => {
    const r = await bash("wget -q https://example.test/api -O saved.json");
    assert.equal(r.isError, false);
    assert.ok(r.content.includes("/work/a/saved.json"), r.content);
    assert.equal(core.vfs.readFileSync("/work/a/saved.json", "utf8"), '{"x":42,"n":[1,2]}');
    const r2 = await bash("wget https://example.test/api");
    assert.equal(r2.isError, false);
    assert.equal(core.vfs.readFileSync("/work/a/api", "utf8"), '{"x":42,"n":[1,2]}');
  });
  await check("wget HTTP≥400：退出码 8、不写文件", async () => {
    const r = await bash("wget https://example.test/err");
    assert.equal(r.isError, true);
    assert.ok(r.content.includes("HTTP 404"), r.content);
    let exists = true;
    try { core.vfs.readFileSync("/work/a/err", "utf8"); } catch { exists = false; }
    assert.equal(exists, false, "失败不得落盘");
  });
  await check("wget -O - 回显 stdout 不落盘", async () => {
    const r = await bash("wget -q https://example.test/api -O -");
    assert.equal(r.isError, false);
    assert.equal(r.content, '{"x":42,"n":[1,2]}');
  });
  await check("unzip 走原生桥：请求形状（zip/dest 解析到工作区绝对路径）", async () => {
    const r = await bash("unzip pkg.zip");
    assert.equal(r.isError, false);
    assert.deepEqual(unzipRequests[unzipRequests.length - 1], { zip: "/work/a/pkg.zip", dest: "/work/a" });
    assert.ok(r.content.includes("3 个文件"), r.content);
    const r2 = await bash("unzip pkg.zip -d sub/dir");
    assert.deepEqual(unzipRequests[unzipRequests.length - 1], { zip: "/work/a/pkg.zip", dest: "/work/a/sub/dir" });
    assert.equal(r2.isError, false);
  });
  await check("unzip 越界路径：端口授权闸拒（permission_denied，交 agent 弹窗流程）", async () => {
    const r = await bash("unzip ../evil.zip");
    assert.equal(r.isError, true);
    assert.equal(r.errorCode, "permission_denied");
    assert.ok(r.content.includes("路径越出授权工作区"), r.content);
    const r2 = await bash("unzip pkg.zip -d ../out");
    assert.equal(r2.errorCode, "permission_denied");
  });
  await check("unzip 桥不在（桌面 harness）：如实报需要原生桥", async () => {
    delete globalThis.zcodeExec;
    const r = await bash("unzip pkg.zip");
    assert.equal(r.isError, true);
    assert.ok(r.content.includes("需要原生桥"), r.content);
    globalThis.zcodeExec = {
      exec() { return "{}"; },
      unzip() { return JSON.stringify({ ok: true, files: 3 }); },
    };
  });
  await check("unzip 假桥报错形状透传给模型", async () => {
    globalThis.zcodeExec.unzip = () => JSON.stringify({ error: "zip 文件不存在：/work/a/nope.zip" });
    const r = await bash("unzip nope.zip");
    assert.equal(r.isError, true);
    assert.ok(r.content.includes("zip 文件不存在"), r.content);
    globalThis.zcodeExec.unzip = () => JSON.stringify({ ok: true, files: 3 });
  });
  await check("Bash 工具描述带出合成命令边界（含触发条件与指路）", async () => {
    const note = syntheticCommandsNote();
    for (const word of ["jq", "curl", "wget", "unzip", "整条", "不支持旗标", "Fetch 工具"]) {
      assert.ok(note.includes(word), `描述缺 "${word}"`);
    }
    const bashSpec = engine.tools.find((t) => t.name === "Bash");
    assert.ok(bashSpec, "Bash 工具应已声明");
    for (const word of ["jq", "curl", "wget", "unzip"]) {
      assert.ok(bashSpec.description.includes(word), `Bash 描述缺 "${word}"`);
    }
  });

  const pass = results.filter(([, ok]) => ok).length;
  for (const [name, ok, err] of results) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      ${err}`}`);
  }
  console.log(`合成命令冒烟：${pass}/${results.length} PASS`);
  if (pass !== results.length) process.exit(1);
} finally {
  delete globalThis.zcodeGitHttp;
  delete globalThis.zcodeExec;
  unlinkSync(output);
}
