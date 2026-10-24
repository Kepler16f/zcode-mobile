// M1 关卡脚本：在真实浏览器/WebView 里，用垫片驱动 core 的工具层跑一轮不含模型的会话。
// 这就是 §3.4 里"bundle 能干活"那条判据的可复现执行体。
import * as rt from "./dist/zcode-core.mobile.js";
import { errorText } from "./selfcheck.mjs";

const results = [];
async function step(name, fn) {
  const t0 = performance.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: +(performance.now() - t0).toFixed(1), detail });
  } catch (e) {
    // 原先取 e.code || e.message，CoreError 带 code 时把诊断信息吞掉了。
    results.push({ name, ok: false, ms: +(performance.now() - t0).toFixed(1), error: errorText(e) });
  }
}

const MOBILE_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"];

async function run() {
  // 同 selfcheck：重跑是在同一页面会话里再进一次这个函数，results 不清就把两轮拼成一份报告。
  results.length = 0;
  const {
    vfs,
    createToolRegistry,
    registerBuiltInTools,
    createToolExecutor,
    PermissionService,
    createMobileFileSystemPort,
  } = rt;

  await step("bundle 导出可用", () => {
    const missing = MOBILE_TOOLS.length && [createToolRegistry, registerBuiltInTools, createToolExecutor, PermissionService].filter((x) => !x);
    if (missing.length) throw new Error("缺少导出: " + missing.length);
    return { exports: 4 };
  });

  await step("垫片 fs 读写（VFS）", () => {
    // 真盘上不清理就会串台：Write 工具对"已存在但本轮没读过"的文件故意报错（core 的
    // write_file_not_read 守卫），上一轮装机留下的 out.txt / cfg.json 会让它把新建当覆盖。
    // 0.0.3 装机 18/18、0.0.4 升级装机同两条 FAIL，差的就是这层残留 —— 内存盘每次刷新，
    // 所以桌面永远复现不了。leftover 报进结果，是为了下次一眼看出是"残留"而不是"运行时坏了"。
    const demoFiles = ["/work/demo/src/out.txt", "/work/demo/src/cfg.json"];
    const leftover = demoFiles.filter((p) => vfs.existsSync(p));
    vfs.rmSync("/work/demo", { recursive: true, force: true });
    vfs.mkdir("/work/demo/src/util", { recursive: true });
    vfs.writeFile("/work/demo/src/util/path.ts", "export const join = (...p: string[]) => p.join('/');\n");
    vfs.writeFile("/work/demo/src/index.ts", "import { join } from './util/path';\nconsole.log(join('a','b'));\nexport const x = 1;\n");
    vfs.writeFile("/work/demo/README.md", "# demo\n一个用于 M1 关卡的小仓库。\nconsole.log 出现 3 次\nconsole.log(a)\nconsole.log(b)\n");
    const back = vfs.readFileSync("/work/demo/src/index.ts", "utf8");
    if (!back.includes("join")) throw new Error("roundtrip 失败");
    return { files: vfs.dump().length, leftoverFromPreviousRun: leftover };
  });

  const registry = createToolRegistry();
  await step("registry 裁剪（只注册移动端 5 个工具）", () => {
    registerBuiltInTools(registry, { allowedTools: MOBILE_TOOLS, silentDuplicateWarnings: true });
    const listed = registry.list ? registry.list() : [];
    const names = listed.map((t) => t.metadata?.name ?? t.name ?? JSON.stringify(Object.keys(t)));
    const leaked = names.filter((n) => ["Bash", "NodeRepl", "WebFetch", "Task"].includes(n));
    if (leaked.length) throw new Error("不该注册的进来了: " + leaked.join(","));
    return { registered: names };
  });

  const events = [];
  const fileSystemPort = createMobileFileSystemPort(vfs, {
    workspaceRoot: "/work",
    FileSystemPortError: rt.FileSystemPortError,
  });
  // 端侧没有桌面那种审批 UI，关卡里先全 allow；真机上要换成通知/弹窗审批（见 §3.3、M5）。
  const allowAll = {
    requestPermission: async (request) => ({
      decision: "allow",
      resolvedAt: new Date(),
      updatedInput: request.input,
    }),
  };
  const executor = createToolExecutor({
    registry,
    permissionService: new PermissionService(),
    permissionBroker: allowAll,
    emitEvent: async (e) => events.push(e),
    sessionId: "m1-session",
    fileSystemPort,
    workingDirectory: "/work",
    workspaceRoot: "/work",
    getWorkingDirectory: () => "/work",
    readFileState: new Map(),
    clientMode: "desktop-continuous",
    embeddedSearchBackend: "internal-cli",
  });

  const call = async (name, input) => {
    let r;
    try {
      r = await executor.execute({ id: `t-${name}`, name, input }, { traceContext: { traceId: "m1", spanId: "s0" } });
    } catch (e) {
      const bag = {};
      for (const k of Object.getOwnPropertyNames(e ?? {})) {
        if (k === "stack") continue;
        try { bag[k] = JSON.parse(JSON.stringify(e[k])); } catch { bag[k] = String(e[k]); }
      }
      throw new Error(`${name}: ${e?.message ?? e} :: ` + JSON.stringify(bag).slice(0, 700));
    }
    if (r?.error) {
      const detail = JSON.stringify(r.error.context ?? r.error.details ?? r.error);
      throw new Error(`${name}: ${typeof r.error === "string" ? r.error : (r.error.message ?? JSON.stringify(r.error).slice(0, 200))}${detail === '""' ? "" : " :: " + detail.slice(0, 900)}`);
    }
    const content = r?.content ?? r?.output ?? r;
    const text = typeof content === "string" ? content : JSON.stringify(content);
    if (!text || text === "{}") throw new Error(name + " 没有输出: " + JSON.stringify(r).slice(0, 300));
    return text;
  };

  await step("Read 工具", async () => {
    const out = await call("Read", { file_path: "/work/demo/src/index.ts" });
    return { bytes: out.length, snippet: out.slice(0, 80) };
  });
  await step("Read 分段读取（offset/limit）", async () => {
    const out = await call("Read", { file_path: "/work/demo/src/index.ts", offset: 2, limit: 1 });
    const parsed = out.trimStart().startsWith("{") ? JSON.parse(out) : null;
    if (!parsed) throw new Error("Read 分段输出不是对象: " + out.slice(0, 160));
    if (parsed.startLine !== 2 || parsed.numLines !== 1) {
      throw new Error("分段结果不对: " + JSON.stringify(parsed).slice(0, 160));
    }
    return { startLine: parsed.startLine, numLines: parsed.numLines, totalLines: parsed.totalLines };
  });
  await step("Grep 上下文与 -o（端口不能忽略的入参）", async () => {
    const withCtx = JSON.parse(await call("Grep", {
      pattern: "console\\.log\\(a\\)", path: "/work/demo/README.md", output_mode: "content", "-B": 1, "-A": 1,
    })).content;
    if (!withCtx.includes("出现 3 次") || !withCtx.includes("console.log(b)")) {
      throw new Error("-B/-A 没生效: " + withCtx.slice(0, 200));
    }
    const only = JSON.parse(await call("Grep", {
      pattern: "console\\.log", path: "/work/demo/README.md", output_mode: "content", "-o": true,
    })).content;
    const onlyLines = only.split("\n").filter((l) => l.trim().length > 0);
    if (onlyLines.length < 3 || onlyLines.some((l) => l.includes("出现"))) {
      throw new Error("-o 没生效: " + only.slice(0, 200));
    }
    return { contextLines: onlyLines.length, onlyMatching: onlyLines.length };
  });
  await step("Grep multiline（-U 跨行）", async () => {
    const out = JSON.parse(await call("Grep", {
      pattern: "demo[\\s\\S]*?仓库", path: "/work/demo/README.md", output_mode: "content", multiline: true,
    })).content;
    if (!out.includes("仓库")) throw new Error("跨行没匹配到: " + out.slice(0, 200));
    return { bytes: out.length };
  });
  await step("Glob 工具", async () => {
    const out = await call("Glob", { pattern: "**/*.ts", path: "/work/demo" });
    if (!out.includes("index.ts")) throw new Error("Glob 没找到文件: " + out.slice(0, 120));
    return { hits: out.split(/\s+/).filter(Boolean).length };
  });
  await step("Grep 工具（internal-cli 搜索后端）", async () => {
    const out = await call("Grep", { pattern: "console\\.log", path: "/work/demo", output_mode: "content" });
    if (!out.includes("console.log")) throw new Error("Grep 无命中: " + out.slice(0, 160));
    return { matched: (out.match(/console\.log/g) || []).length };
  });
  await step("Write 工具", async () => {
    const out = await call("Write", { file_path: "/work/demo/src/out.txt", content: "written by on-device core\n" });
    const onDisk = vfs.readFileSync("/work/demo/src/out.txt", "utf8");
    if (!onDisk.includes("on-device")) throw new Error("写到了内存之外？" + out.slice(0, 80));
    return { bytes: onDisk.length };
  });
  await step("Edit 工具", async () => {
    await call("Write", { file_path: "/work/demo/src/cfg.json", content: '{"level":"low"}' });
    const out = await call("Edit", { file_path: "/work/demo/src/cfg.json", old_string: '"low"', new_string: '"high"' });
    const now = vfs.readFileSync("/work/demo/src/cfg.json", "utf8");
    if (!now.includes("high")) throw new Error("编辑没生效: " + out.slice(0, 120));
    return { now };
  });

  await step("HttpClientPort：GET 取回自身", async () => {
    const httpPort = rt.createMobileHttpClientPort({ HttpClientPortError: rt.HttpClientPortError });
    const res = await httpPort.request({ url: location.href, method: "GET", timeoutMs: 5000 });
    if (res.status !== 200 || !res.bytes) throw new Error("响应异常: " + JSON.stringify(res).slice(0, 160));
    return { status: res.status, bytes: res.bytes, ms: res.durationMs };
  });
  await step("HttpClientPort：egress=public 拦内网字面量", async () => {
    const httpPort = rt.createMobileHttpClientPort({ HttpClientPortError: rt.HttpClientPortError });
    const problems = [];
    for (const url of ["http://127.0.0.1:8792/x", "http://192.168.1.1/", "http://10.0.0.5/", "http://169.254.169.254/latest/meta-data/", "http://localhost:80/"]) {
      try {
        await httpPort.request({ url, egressPolicy: "public" });
        problems.push("未拦: " + url);
      } catch (e) {
        if (e.code !== "egress_blocked") problems.push(url + " -> " + e.code);
      }
    }
    if (problems.length) throw new Error(problems.join(" | "));
    let proto = "";
    try {
      await httpPort.request({ url: "file:///etc/passwd" });
    } catch (e) {
      proto = e.code;
    }
    if (proto !== "unsupported_protocol") throw new Error("file: 协议没拦住: " + proto);
    return { blocked: 5, proto };
  });
  await step("HttpClientPort：maxResponseBytes 触发 too_large", async () => {
    const httpPort = rt.createMobileHttpClientPort({ HttpClientPortError: rt.HttpClientPortError });
    let code = "not_blocked";
    try {
      await httpPort.request({ url: new URL("dist/zcode-core.mobile.js", location.href).href, maxResponseBytes: 4096 });
    } catch (e) {
      code = e.code ?? String(e.message ?? e);
    }
    if (code !== "too_large") throw new Error("上限没生效: " + code);
    return { code };
  });
  await step("ExecutionPort：没有原生桥时诚实失败", async () => {
    const execPort = rt.createMobileExecutionPort();
    const r = await execPort.run({ command: { mode: "shell", command: "echo hi" }, cwd: "/work" });
    if (r.status !== "spawn_error" || r.error?.type !== "spawn_error") {
      throw new Error("不该静默成功: " + JSON.stringify(r).slice(0, 160));
    }
    if (!/原生执行桥/.test(r.error.message)) throw new Error("失败原因没说清: " + r.error.message);
    return { status: r.status, message: r.error.message.slice(0, 40) };
  });
  await step("ExecutionPort：桥接层 argv/shell 两条路径", async () => {
    const calls = [];
    const fakeBridge = {
      exec: async (req) => {
        calls.push(req);
        return req.shell
          ? { exitCode: 0, stdout: "hi\n", stderr: "", pid: 4242 }
          : { exitCode: 3, stdout: "", stderr: "boom", pid: 7 };
      },
    };
    const execPort = rt.createMobileExecutionPort({ bridge: fakeBridge });
    const ok = await execPort.run({ command: { mode: "shell", command: "echo hi" }, cwd: "/work" });
    if (ok.status !== "completed" || ok.stdout.text !== "hi\n" || ok.pid !== 4242) {
      throw new Error("shell 路径不对: " + JSON.stringify(ok).slice(0, 200));
    }
    const bad = await execPort.run({ command: { mode: "argv", file: "/system/bin/false", args: [] } });
    if (bad.status !== "failed" || bad.exitCode !== 3 || bad.stderr.text !== "boom") {
      throw new Error("argv 路径不对: " + JSON.stringify(bad).slice(0, 200));
    }
    // 端口层的注入回归：argv 请求里绝不能出现 command 字段，否则 Kotlin 侧 useShell 判定
    // 一旦被改坏，参数就会被拼进 sh -c。
    const argvCall = calls.find((c) => !c.shell);
    if (!argvCall || argvCall.command !== undefined || !Array.isArray(argvCall.args)) {
      throw new Error("argv 请求形态不对: " + JSON.stringify(argvCall).slice(0, 200));
    }
    const shellCall = calls.find((c) => c.shell);
    if (!shellCall || shellCall.args !== undefined) {
      throw new Error("shell 请求不该带 argv: " + JSON.stringify(shellCall).slice(0, 200));
    }
    return { routes: calls.map((c) => (c.shell ? "shell" : "argv")), signalNotForwarded: calls.every((c) => c.signal === undefined) };
  });

  let store = null;
  await step("SessionStore：完整迁移（引擎由宿主能力决定）", async () => {
    if (!window.initSqlJs) throw new Error("sql-wasm.js 没载入");
    const files = new Map();
    await rt.configureSqlite({
      sqlJsFactory: window.initSqlJs,
      locateFile: () => "./dist/sql-wasm.wasm",
      byteStore: { read: (p) => files.get(p), write: (p, b) => files.set(p, b) },
    });
    // 端侧统一走异步启动：同步迁移的等锁用 Atomics.wait，而它在 WebView 主线程上是 no-op。
    store = await rt.SqliteSessionStore.openStartup({ dbPath: "/work/.zcode/db.sqlite" });
    // engine 必须报出来：configureSqlite 只是"允许"用 WASM，派发器在有原生桥时仍走原生桥
    // （sqlite.mjs:92）。WSA 那份报告里这一条写的是 WASM，实际跑的却是 native-android-sqlite，
    // 于是"0019 在 WASM 上也炸"看起来成立，其实 WASM 一次都没被执行过。
    return { ready: rt.isSqliteReady(), engine: rt.sqliteEngine() };
  });
  await step("SessionStore：会话/消息/part/todo 往返", async () => {
    const created = await store.createSession({
      id: "ses_m2_1",
      projectID: "prj_m2",
      slug: "m2",
      directory: "/work/demo",
      title: "端侧第一轮",
      version: "3.14.3",
      taskType: "agent",
    });
    if (created?.id !== "ses_m2_1") throw new Error("createSession 没回: " + JSON.stringify(created).slice(0, 160));
    await store.saveMessage({
      id: "msg_u1", sessionID: "ses_m2_1", role: "user", agent: "zcode",
      time: { created: Date.now() },
    });
    await store.savePart({
      id: "prt_t1", sessionID: "ses_m2_1", messageID: "msg_u1", type: "text", text: "把 level 改成 high",
    });
    const listed = await store.listSessions();
    if (!listed.some((s) => s.id === "ses_m2_1")) throw new Error("listSessions 丢了会话");
    const loaded = await store.messages({ sessionID: "ses_m2_1" });
    if (loaded.length !== 1) throw new Error("messages 数量不对: " + loaded.length);
    const part = loaded[0].parts?.[0];
    if (part?.text !== "把 level 改成 high") throw new Error("part 文本没回: " + JSON.stringify(loaded).slice(0, 220));
    const got = await store.getSession("ses_m2_1");
    if (got?.title !== "端侧第一轮") throw new Error("getSession 不对: " + JSON.stringify(got).slice(0, 160));
    await store.updateTodos({ sessionID: "ses_m2_1", todos: [{ content: "装机", status: "pending", priority: "high" }] });
    const todos = await store.readTodos({ sessionID: "ses_m2_1" });
    if (todos.length !== 1 || todos[0].priority !== "high") throw new Error("todos 往返失败: " + JSON.stringify(todos).slice(0, 160));
    // 关掉再按同一 byteStore 重开：证明 sql.js 的 export→落盘→再载入这条链路是真的，
    // 不是只在内存里自说自话。
    store.close();
    const reopened = await rt.SqliteSessionStore.openStartup({ dbPath: "/work/.zcode/db.sqlite" });
    const after = await reopened.messages({ sessionID: "ses_m2_1" });
    if (after.length !== 1) throw new Error("重开后消息丢了: " + after.length);
    store = reopened;
    return { sessions: listed.length, messages: after.length, partText: after[0].parts?.[0]?.text, todos: todos.length };
  });

  return {
    tools: MOBILE_TOOLS,
    events: events.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).map((r) => ({ step: r.name, error: r.error })),
    results,
  };
}

export { run };
export async function runAndRender(targetId) {
  const report = await run();
  const el = document.getElementById(targetId);
  if (el) {
    el.textContent = report.results
      .map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}  (${r.ms} ms)  ${r.ok ? JSON.stringify(r.detail).slice(0, 120) : r.error}`)
      .join("\n");
  }
  window.__zcodeM1Report = report;
  return report;
}
