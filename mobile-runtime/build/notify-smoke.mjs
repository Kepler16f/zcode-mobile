// 端侧通知面自检（通知保活 + 出错提醒）。只在 Node 里跑，不进 APK。
//
// 为什么单独一个文件：通知这条线要连着真 agent 跑（"一轮失败到底会不会发通知"），
// 而 chat-smoke.ts 正在被别人并行改——两份自检各改各的，才不会互相踩。
//
// 判据（每一条都是手机上的具体形态，不是内部指标）：
//   1. 没有原生桥（桌面 harness / Node 自检 / 还没装原生代理）时，通知与保活全部静默
//      返回 false，一个字节都不抛——通知是锦上添花，绝不能把对话搞挂。
//   2. 有桥且用户已授权：notify 真的发出去；保活跟着轮次走（起跑开、收口关）。
//   3. 有桥但用户没授权：不弹权限框（权限只由设置页显式触发），不发通知、不起保活。
//   4. 桥自己抛异常：通知面整体不抛，返回 false。
//   5. 一轮失败 → 发出且只发出一条 error 通知（摘要能读出失败原因）；一轮成功 → 不发。
//   6. 保活开关缺省=关；开关=1 且已授权才起常驻通知；开关切关立刻把常驻通知收掉。
//
// 为什么不直接 node 跑 .ts：同 chat-smoke.mjs —— 端侧代码是 TS 源码，`@/` 别名要按
// packages/ui 的 tsconfig 解析（bundle-ui.mjs 同一套配法），所以先用 esbuild 打成一份
// 临时 ESM 再执行。产物只在本机存在、跑完就删，绝不进 dist-ui。
import http from "node:http";
import path from "node:path";
import { rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const zcodeRoot = path.join(root, "zcode");
const esbuild = createRequire(path.join(zcodeRoot, "apps/zcode-cli/package.json"))("esbuild");
const out = path.join(here, ".tmp-notify-smoke.mjs");

/** 虚拟入口：把要用的东西从真源码里导出（源码一行不改）。 */
const ENTRY = `
export * as notify from "../ui/app-notify.js";
export { createMobileAgentService } from "../ui/agent.js";
export { withUnsupportedFallback } from "../ui/stand-in.js";
export { createCommandEnvelope } from "@/v4/commandFactory.js";
export { createAgentConversationTransport } from "@/v4/agentConversationTransport.js";
export { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
export { conversationTopic } from "@zcode/shared/zcode-protocol-v4";
export { ChannelClient, ChannelServer, ProxyChannel, createQueuePair } from "@zcode/rpc";
`;

await esbuild.build({
  stdin: { contents: ENTRY, resolveDir: here, sourcefile: "notify-smoke-entry.ts", loader: "ts" },
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: "inline",
  logLevel: "warning",
  alias: { "@": path.join(zcodeRoot, "packages/ui/src") },
  nodePaths: [
    path.join(zcodeRoot, "packages/web/node_modules"),
    path.join(zcodeRoot, "packages/ui/node_modules"),
    path.join(zcodeRoot, "packages/client/node_modules"),
    path.join(zcodeRoot, "packages/services/node_modules"),
    path.join(zcodeRoot, "packages/shared/node_modules"),
    path.join(zcodeRoot, "node_modules"),
  ],
  define: { "process.env.NODE_ENV": '"development"' },
});

// ── 宿主环境：window 事件面 + localStorage 的最小替身 ─────────────────────────
// app-notify.ts 依赖两样浏览器东西：事件面（开关变化广播）与 localStorage（开关旗子）。
// Node 里两样都没有，先架上替身再 import —— 模块加载时它要自己挂监听。
const listeners = new Map();
globalThis.addEventListener = (type, fn) => {
  const list = listeners.get(type) ?? [];
  list.push(fn);
  listeners.set(type, list);
};
globalThis.removeEventListener = (type, fn) => {
  const list = listeners.get(type) ?? [];
  const at = list.indexOf(fn);
  if (at >= 0) list.splice(at, 1);
};
globalThis.dispatchEvent = (event) => {
  for (const fn of listeners.get(event?.type) ?? []) {
    try {
      fn(event);
    } catch {
      // 监听器自己坏了不算派发失败（与浏览器的 dispatchEvent 语义一致）。
    }
  }
  return true;
};
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => {
    storage.set(k, String(v));
  },
  removeItem: (k) => {
    storage.delete(k);
  },
  clear: () => storage.clear(),
  key: (i) => [...storage.keys()][i] ?? null,
  get length() {
    return storage.size;
  },
};

const mod = await import(pathToFileURL(out).href);
const notify = mod.notify;

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok, detail });

/** 假桥：把原生代理的四个方法记下来（并能模拟"桥自己炸了"）。 */
function makeBridge({ granted = true, throwOn = null } = {}) {
  const calls = { notify: [], setKeepAlive: [], requestPermission: [] };
  const boom = (which) => throwOn === "all" || throwOn === which;
  const bridge = {
    requestPermission() {
      calls.requestPermission.push(1);
      if (boom("requestPermission")) throw new Error("桥炸了：requestPermission");
      return JSON.stringify({ ok: true, granted });
    },
    hasPermission() {
      if (boom("hasPermission")) throw new Error("桥炸了：hasPermission");
      return granted;
    },
    notify(id, title, text, ongoing) {
      calls.notify.push({ id, title, text, ongoing });
      if (boom("notify")) throw new Error("桥炸了：notify");
      return JSON.stringify({ ok: true });
    },
    setKeepAlive(enabled) {
      calls.setKeepAlive.push(enabled);
      if (boom("setKeepAlive")) throw new Error("桥炸了：setKeepAlive");
      return JSON.stringify({ ok: true });
    },
  };
  return { bridge, calls };
}

/** 装桥 / 拆桥。 */
function installBridge(bridge) {
  globalThis.zcodeNotify = bridge;
}
function removeBridge() {
  globalThis.zcodeNotify = undefined;
}
function setSwitch(value) {
  if (value === null) storage.delete(notify.KEEP_ALIVE_STORAGE_KEY);
  else storage.set(notify.KEEP_ALIVE_STORAGE_KEY, value);
}
/** 派发一次开关变化（B 线切开关时就是这么广播的）。 */
function fireSwitch(enabled) {
  globalThis.dispatchEvent(
    new CustomEvent(notify.KEEP_ALIVE_EVENT, { detail: { enabled } }),
  );
}
/**
 * 把上一段留下的"常驻通知还开着"的记忆清掉（模块内部状态），
 * 免得这一段的断言受上一段影响——每一段都从"干净"状态开始。
 */
function resetKeepAliveState(fake) {
  installBridge(fake.bridge);
  notify.setKeepAliveIfPermitted(false);
  fake.calls.setKeepAlive.length = 0;
}

// ── 一：没有桥（桌面 harness / Node 自检的常态）────────────────────────────
{
  removeBridge();
  setSwitch(null);
  let threw = null;
  let notifyResult = null;
  let keepAliveResult = null;
  let permissionResult = null;
  try {
    notifyResult = notify.notifyIfPermitted("x", "t", "b");
    keepAliveResult = notify.setKeepAliveIfPermitted(true);
    permissionResult = notify.requestNotifyPermission();
  } catch (e) {
    threw = e;
  }
  check(
    "没有原生桥时通知面完全静默：三个出口都返回 false 且不抛",
    threw === null && notifyResult === false && keepAliveResult === false && permissionResult === false,
    `threw=${String(threw)} notify=${notifyResult} keepAlive=${keepAliveResult} permission=${permissionResult}`,
  );
}

// ── 二：有桥 + 已授权 ─────────────────────────────────────────────────────
{
  const fake = makeBridge({ granted: true });
  const { calls } = fake;
  resetKeepAliveState(fake);
  setSwitch(null);

  const sent = notify.notifyIfPermitted("zcode-turn-error", "ZCode", "网关 500");
  check(
    "已授权时通知真的发出去（id/标题/正文/ongoing 都按契约传过去）",
    sent === true &&
      calls.notify.length === 1 &&
      calls.notify[0].id === "zcode-turn-error" &&
      calls.notify[0].title === "ZCode" &&
      calls.notify[0].text === "网关 500" &&
      calls.notify[0].ongoing === false,
    JSON.stringify(calls.notify),
  );

  // 保活开关缺省 = 关：这时起常驻通知就是越过用户的选择，必须不调用。
  const keepResult = notify.setKeepAliveIfPermitted(true);
  check(
    "保活开关缺省=关：setKeepAlive 一次都不该被调用（返回 false）",
    keepResult === false && calls.setKeepAlive.length === 0,
    `result=${keepResult} calls=${JSON.stringify(calls.setKeepAlive)}`,
  );

  // 开关打开 + 已授权：起常驻通知；收口（enabled=false）时收掉。
  setSwitch("1");
  const onResult = notify.setKeepAliveIfPermitted(true);
  const offResult = notify.setKeepAliveIfPermitted(false);
  check(
    "开关=1 且已授权：常驻通知开→关（true 然后 false）",
    onResult === true &&
      offResult === false &&
      JSON.stringify(calls.setKeepAlive) === JSON.stringify([true, false]),
    `on=${onResult} off=${offResult} calls=${JSON.stringify(calls.setKeepAlive)}`,
  );
}

// ── 三：开关事件（设置页切开关 → B 线广播）───────────────────────────────
{
  const fake = makeBridge({ granted: true });
  const { calls } = fake;
  resetKeepAliveState(fake);
  setSwitch("1");
  notify.setKeepAliveIfPermitted(true); // 先把常驻通知拉起来
  const before = calls.setKeepAlive.length;

  fireSwitch(false);
  check(
    "开关切到关：立刻收到 setKeepAlive(false)，常驻通知被收掉",
    calls.setKeepAlive.length === before + 1 && calls.setKeepAlive.at(-1) === false,
    JSON.stringify(calls.setKeepAlive),
  );

  fireSwitch(true);
  check(
    "开关切到开且已授权：立刻收到 setKeepAlive(true)",
    calls.setKeepAlive.at(-1) === true,
    JSON.stringify(calls.setKeepAlive),
  );

  // 没授权时开关切到开：静默（等权限申请完再由权限流程触发），不弹框、不起常驻。
  const denied = makeBridge({ granted: false });
  installBridge(denied.bridge);
  fireSwitch(true);
  check(
    "没授权时开关切到开：静默跳过（不弹权限框、不起常驻通知）",
    denied.calls.setKeepAlive.length === 0 && denied.calls.requestPermission.length === 0,
    JSON.stringify(denied.calls),
  );
}

// ── 四：有桥但没授权 ─────────────────────────────────────────────────────
{
  const fake = makeBridge({ granted: false });
  const { calls } = fake;
  resetKeepAliveState(fake);
  setSwitch("1");

  const sent = notify.notifyIfPermitted("zcode-turn-error", "ZCode", "网关 500");
  const kept = notify.setKeepAliveIfPermitted(true);
  check(
    "没授权：不发通知、不起保活，而且绝不主动弹权限框",
    sent === false &&
      kept === false &&
      calls.notify.length === 0 &&
      calls.setKeepAlive.length === 0 &&
      calls.requestPermission.length === 0,
    JSON.stringify(calls),
  );
}

// ── 五：桥自己抛异常 ─────────────────────────────────────────────────────
{
  const warm = makeBridge({ granted: true });
  resetKeepAliveState(warm);
  const { bridge } = makeBridge({ granted: true, throwOn: "all" });
  installBridge(bridge);
  setSwitch("1");
  let threw = null;
  let sent = null;
  let kept = null;
  try {
    sent = notify.notifyIfPermitted("zcode-turn-error", "ZCode", "网关 500");
    kept = notify.setKeepAliveIfPermitted(true);
  } catch (e) {
    threw = e;
  }
  check(
    "桥抛异常：通知面不抛，返回 false（通知坏了不影响对话）",
    threw === null && sent === false && kept === false,
    `threw=${String(threw)} sent=${sent} kept=${kept}`,
  );

  const broken = makeBridge({ granted: true, throwOn: "requestPermission" });
  installBridge(broken.bridge);
  let permThrew = null;
  let permResult = null;
  try {
    permResult = notify.requestNotifyPermission();
  } catch (e) {
    permThrew = e;
  }
  check(
    "桥在请求权限时抛异常：同样不抛，返回 false",
    permThrew === null && permResult === false,
    `threw=${String(permThrew)} result=${permResult}`,
  );
}

// ── 六：显式请求权限（设置页那条路）──────────────────────────────────────
{
  const fake = makeBridge({ granted: true });
  const { calls } = fake;
  resetKeepAliveState(fake);
  setSwitch("1");
  const granted = notify.requestNotifyPermission();
  check(
    "显式请求权限：granted=true 时返回 true，并顺手把常驻通知拉起来",
    granted === true &&
      calls.requestPermission.length === 1 &&
      calls.setKeepAlive.includes(true),
    JSON.stringify(calls),
  );
  check(
    "本会话已问过权限这件事被记住了（不用每轮再问）",
    notify.notifyPermissionRequestedThisSession() === true,
    String(notify.notifyPermissionRequestedThisSession()),
  );
}

// ── 七：错误摘要的收拾 ───────────────────────────────────────────────────
{
  const summary = notify.summarizeForNotification(
    "网关 500：\u001b[31m模型服务不可用\u001b[0m\n请稍后再试\t",
  );
  check(
    "错误摘要：控制字符（含 ANSI 颜色码）被去掉、压成一行、截到 200 字",
    summary === "网关 500：模型服务不可用 请稍后再试" &&
      notify.summarizeForNotification("x".repeat(500)).length === 200,
    JSON.stringify(summary),
  );
}

// ── 八：真 agent —— 一轮失败发一条错误通知，一轮成功不发 ──────────────────
/** 一个足够真的 OpenAI Chat Completions SSE 端点（和 chat-smoke 同一套形状）。 */
let mockMode = "stream";
function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        if (mockMode === "businessError") {
          send({ success: false, providerCode: 50001, message: "套餐额度不足，请换一个模型" });
          send("[DONE]");
          res.end();
          return;
        }
        send({
          id: "chatcmpl-notify",
          object: "chat.completion.chunk",
          created: 1,
          model: "mock-model",
          choices: [{ index: 0, delta: { content: "通知自检：好" }, finish_reason: null }],
        });
        send({
          id: "chatcmpl-notify",
          object: "chat.completion.chunk",
          created: 1,
          model: "mock-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        });
        send("[DONE]");
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ url: `http://127.0.0.1:${port}/v1`, close: () => server.close() });
    });
  });
}

function makeRig(baseUrl) {
  const diagnostics = [];
  const agent = mod.withUnsupportedFallback(
    mod.createMobileAgentService({
      onDiagnostic: (m) => diagnostics.push(m),
      modelTargets: {
        view: async () => ({
          providers: [
            {
              providerId: "mock-provider",
              executable: true,
              models: [{ modelId: "mock-model" }],
              config: {
                api: { type: "openai-chat-completions", baseUrl },
                access: { type: "personal-api-key", apiKey: "sk-mock" },
              },
            },
          ],
          preferredSelection: { providerId: "mock-provider", modelId: "mock-model" },
        }),
      },
      deviceId: "notify-smoke-device",
    }),
    "mobile:zcodeAgentService",
  );
  const [serverSide, clientSide] = mod.createQueuePair();
  const server = new mod.ChannelServer(serverSide, "notify-smoke-host", 5000, true);
  server.registerChannel("zcodeAgentService", mod.ProxyChannel.fromService(agent));
  server.ready();
  const client = new mod.ChannelClient(clientSide);
  const service = mod.ProxyChannel.toService(client.getChannel("zcodeAgentService"));
  const transport = mod.createAgentConversationTransport(service, {
    workspacePath: "/work/notify-smoke",
  });
  return { transport, diagnostics, dispose: () => agent.disposeAll() };
}

async function waitFor(predicate, message, budgetMs = 8000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > budgetMs) throw new Error(`超时：${message}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const settle = (store) => {
  const phase = store.getState().snapshot?.control.phase;
  return phase !== undefined && phase !== "running" && phase !== "draft" && phase !== "prewarming";
};

async function openSession(rig) {
  const envelope = mod.createCommandEnvelope({
    type: "createSession",
    sessionId: null,
    payload: { workspaceId: "ws-notify-smoke" },
  });
  const ack = await rig.transport.sendCommand(envelope);
  if (ack?.status !== "accepted" || !ack?.result?.sessionId) {
    throw new Error(`createSession 没有 accepted：${JSON.stringify(ack)}`);
  }
  const sessionId = ack.result.sessionId;
  const store = new mod.ConversationProjectionStore(mod.conversationTopic(sessionId), rig.transport);
  rig.transport.onFrame((frame, context) => {
    if (frame.topic === store.topic) store.handleFrame(frame, context);
  });
  await store.connect();
  await waitFor(() => store.getState().snapshot !== null, "订阅后没有收到初始 snapshot");
  return { store, sessionId };
}

function sendTurn(rig, store, sessionId, text) {
  const envelope = mod.createCommandEnvelope({ type: "sendText", sessionId, payload: { text } });
  store.markCommandPending({ commandId: envelope.commandId, type: "sendText", issuedAt: Date.now() });
  return rig.transport.sendCommand(envelope);
}

const mock = await startMock();
try {
  // 失败一轮：必须有且只有一条 error 通知，摘要里能读出失败原因。
  {
    mockMode = "businessError";
    const fake = makeBridge({ granted: true });
    const { calls } = fake;
    resetKeepAliveState(fake);
    setSwitch("1");
    const rig = makeRig(mock.url);
    const { store, sessionId } = await openSession(rig);
    await sendTurn(rig, store, sessionId, "会失败的一句");
    await waitFor(() => settle(store), "失败这一轮没有落到终态");
    const errors = calls.notify.filter((n) => n.id === "zcode-turn-error");
    check(
      "一轮失败：发出且只发出一条 error 通知",
      errors.length === 1,
      `notifications=${JSON.stringify(calls.notify)}`,
    );
    check(
      "失败通知的标题是 ZCode，摘要里能读出失败原因",
      errors.length === 1 &&
        errors[0].title === "ZCode" &&
        String(errors[0].text).includes("套餐额度不足"),
      JSON.stringify(errors),
    );
    check(
      "保活跟着轮次走：起跑开、收口关（true 然后 false）",
      JSON.stringify(calls.setKeepAlive) === JSON.stringify([true, false]),
      JSON.stringify(calls.setKeepAlive),
    );
    rig.dispose();
  }

  // 成功一轮：绝不能发 error 通知。
  {
    mockMode = "stream";
    const fake = makeBridge({ granted: true });
    const { calls } = fake;
    resetKeepAliveState(fake);
    setSwitch("1");
    const rig = makeRig(mock.url);
    const { store, sessionId } = await openSession(rig);
    await sendTurn(rig, store, sessionId, "会成功的一句");
    await waitFor(() => settle(store), "成功这一轮没有落到终态");
    check(
      "一轮成功：不发 error 通知（只有保活的开关调用）",
      calls.notify.filter((n) => n.id === "zcode-turn-error").length === 0 &&
        store.getState().snapshot?.control.phase === "completedSuccess",
      `phase=${store.getState().snapshot?.control.phase} notifications=${JSON.stringify(calls.notify)}`,
    );
    check(
      "成功一轮的保活同样开→关",
      JSON.stringify(calls.setKeepAlive) === JSON.stringify([true, false]),
      JSON.stringify(calls.setKeepAlive),
    );
    rig.dispose();
  }

  // 没有桥时跑一轮：主流程照常收口（通知坏不了对话）。
  {
    mockMode = "businessError";
    removeBridge();
    const rig = makeRig(mock.url);
    const { store, sessionId } = await openSession(rig);
    let threw = null;
    try {
      await sendTurn(rig, store, sessionId, "没有桥的一句");
      await waitFor(() => settle(store), "没有桥这一轮没有落到终态");
    } catch (e) {
      threw = e;
    }
    check(
      "没有原生桥时整轮照常收口（通知面不参与、不抛）",
      threw === null && store.getState().snapshot?.control.phase === "error",
      `threw=${String(threw)} phase=${store.getState().snapshot?.control.phase}`,
    );
    rig.dispose();
  }

  // 桥自己炸了时跑一轮：主流程照常收口。
  {
    mockMode = "businessError";
    const { bridge } = makeBridge({ granted: true, throwOn: "notify" });
    installBridge(bridge);
    const rig = makeRig(mock.url);
    const { store, sessionId } = await openSession(rig);
    let threw = null;
    try {
      await sendTurn(rig, store, sessionId, "桥炸了的一句");
      await waitFor(() => settle(store), "桥炸了这一轮没有落到终态");
    } catch (e) {
      threw = e;
    }
    check(
      "桥抛异常时整轮照常收口（通知炸了不影响对话）",
      threw === null && store.getState().snapshot?.control.phase === "error",
      `threw=${String(threw)} phase=${store.getState().snapshot?.control.phase}`,
    );
    rig.dispose();
  }
} catch (e) {
  results.push({ name: "通知自检本身跑完了", ok: false, detail: String(e?.stack ?? e) });
} finally {
  mock.close();
}

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  process.stdout.write(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  → ${r.detail}`}\n`);
}
process.stdout.write(`\n端侧通知自检：${results.length - failed.length}/${results.length} PASS\n`);
rmSync(out, { force: true });
process.exit(failed.length > 0 ? 1 : 0);
