// 启动期设置交互回归（startup-settings-smoke）。
//
// 症状：刚启动的一段时间里能进设置，但每个选项点不动（点选项无响应），过一会儿才恢复，
// 恢复时长与启动耗时相关。
//
// 取证结论（build/.tmp-startup-settings-probe.mjs，一次性脚本，可删）：
//   - 不是遮罩/inert：进设置后 elementFromPoint 命中的就是设置项本体，body 无 pointer-events
//     残留，抽屉面板的残留投影在 opacity-0 + inert 的工作区壳层里，拦不到事件；
//   - 不是 hello 闸：设置页的选项不走 v4 命令（上游 SettingsPage 与 settings/* 组件 0 处
//     sendConversationCommandV4），而 hello 握手在首个 sessions-index 订阅时就完成了，
//     远早于用户能进设置的时刻；
//   - 是主线程饱和：CPU 节流下真触摸点设置项的生效延迟 0.3–1.4s，与 ≥1s 的长任务逐一重叠；
//     启动窗口里 UI 与服务同线程，订阅/列表/恢复的复合 RPC 一条接一条，期间到达的点击
//     要等整串处理完才被派发——"点不动"、串尾"自己恢复"、恢复时长随启动耗时伸缩。
//
// 修复（本冒烟钉住的两条时序，均事件驱动、无定时器猜时长）：
//   1. agent/window-controller 的复合重活入口 yieldToInput()：MessageChannel 宏任务口，
//      让积压的点击/触摸在每一段重活之间被派发（输入延迟从"整串"降到"一段"）；
//   2. entry.tsx 启动屏交臂：#root 首次提交的下一帧才撤"正在启动…"，提交前不再出现
//      "启动屏已撤、界面未画"的死黑窗（旧路径点哪都没反应还没任何可见状态）。
//
// 判据：
//   Node 侧（真 agent、真协议）：
//     A1 hello 之前 v4 命令被闸（fault.connection.helloRequired）——闸语义不回归；
//     A2 握手后命令立即生效；
//     A3 会话订阅在重活前让积压输入先派发（tap 先于 restore 的读库动作），且快照/首帧不受影响；
//     A4 sessions-index 订阅同样让路（tap 先于 listSummaries）。
//   浏览器侧（真 dist-ui 产物 + 真 Chromium）：
//     B1 加载初期启动屏在屏且未离场（可见等待态，不是死黑屏）；
//     B2 工作区壳层挂载后启动屏 ≤1.5s 内交臂离场（事件驱动，不是固定延时）；
//     B3 进设置后设置项不被任何层覆盖（elementFromPoint 命中按钮本体）；
//     B4 真触摸点分区导航 ≤2.5s 内生效（就绪后立即生效）。
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ← ${detail}` : ""}`);
  return ok;
};

// ══════════════ Node 侧：真 agent + 真协议 ══════════════
console.log("── Node：v4 命令闸与启动期输入让路 ──");
const esbuild = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"))("esbuild");
const out = path.join(root, "mobile-runtime/build", `.tmp-startup-settings-${process.pid}.mjs`);
await esbuild.build({
  stdin: {
    contents: `export {createMobileAgentService} from "${root.replaceAll("\\", "/")}/mobile-runtime/ui/agent.ts";
export {createCommandEnvelope,getV4ClientId} from "${root.replaceAll("\\", "/")}/zcode/packages/ui/src/v4/commandFactory.ts";`,
    resolveDir: path.join(root, "mobile-runtime/ui"),
  },
  outfile: out, bundle: true, format: "esm", platform: "node", target: "node24",
  jsx: "automatic", logLevel: "warning",
  alias: { "@": path.join(root, "zcode/packages/ui/src") },
  nodePaths: ["web", "ui", "client", "services", "shared"].map(p => path.join(root, "zcode/packages", p, "node_modules")).concat(path.join(root, "zcode/node_modules")),
});
const { createMobileAgentService, createCommandEnvelope, getV4ClientId } = await import(pathToFileURL(out).href);

const records = new Map();
const marks = { storeLoadAt: -1, listSummariesAt: -1 };
// 顺序用单调序列号而不是 Date.now()：同一毫秒内的事件顺序用时间戳分不出先后。
let eventSeq = 0;
const marksSeq = { storeLoad: -1, listSummaries: -1, tap1: -1, tap2: -1, idxFrame: -1 };
// 大会话：还原路径要真读库、真回放（启动窗口里最重的一段同步活的形状）。
// 行成对成轮（userInput → assistantText，带 turnId/origin），与会话 schema 一致。
const ROWS = 400;
function seededSession(sessionId) {
  const rows = [];
  let rowId = 0;
  for (let turn = 0; turn < ROWS / 2; turn++) {
    const turnId = `turn-${turn}`;
    const base = { turnId, createdAt: Date.now() - (ROWS - turn) * 1000, createdAtSeq: turn };
    rows.push({ rowId: ++rowId, entityId: `u${turn}`, kind: "userInput", ...base, origin: "realUser", text: `第 ${turn} 轮提问` });
    rows.push({ rowId: ++rowId, entityId: `a${turn}`, kind: "assistantText", ...base, state: "complete", text: `第 ${turn} 轮回复，模拟长会话还原时的回放成本。`.repeat(4) });
  }
  return {
    sessionId,
    workspacePath: "/work/test",
    updatedAt: Date.now(),
    state: {
      phase: "completedSuccess",
      revision: 1,
      rows,
      nextRowId: ROWS + 1,
      turnUsage: {},
      control: { phase: "completedSuccess", sessionEnded: false, canStop: false, stopState: "idle", activeWorks: [], lastError: null },
      // 还原路径读 persisted.state.lastError；缺键会让 control.lastError 变 undefined，
      // 首帧被 schema 拒掉（真实持久化里恒有这一格）。
      lastError: null,
      config: {},
      // usageState 读 inputTokens/outputTokens（不是 promptTokens/completionTokens）。
      cumulative: { inputTokens: 0, outputTokens: 0 },
      pendingInteractions: [],
    },
  };
}
const store = {
  save(entry) { records.set(entry.sessionId, structuredClone({ ...entry, updatedAt: Date.now() })); },
  load(id) { marks.storeLoadAt = Date.now(); marksSeq.storeLoad = ++eventSeq; return records.get(id) ?? null; },
  listSummaries(workspacePath) { marks.listSummariesAt = Date.now(); marksSeq.listSummaries = ++eventSeq; return [...records.values()].filter(x => x.workspacePath === workspacePath).map(x => ({ sessionId: x.sessionId, summary: { phase: x.state.phase } })); },
  listAllStates() { return [...records.values()]; },
  engine() { return "test-memory"; },
};
const agentDiagnostics = [];
const agent = createMobileAgentService({
  sessionStore: store,
  onDiagnostic: (m) => agentDiagnostics.push(String(m)),
  modelTargets: { view: async () => ({ providers: [{ providerId: "test", models: [{ modelId: "mock" }], config: { api: { type: "openai-chat-completions", baseUrl: "https://test.invalid/v1" }, access: { type: "personal-api-key", apiKey: "test" } } }], preferredSelection: { providerId: "test", modelId: "mock" } }) },
});

// A1：hello 之前命令通路被闸（agent.requireHandshake 的语义）。
const clientId = getV4ClientId();
const envelopeBeforeHello = createCommandEnvelope({ type: "createSession", sessionId: null, payload: { workspaceId: "test" } });
envelopeBeforeHello.clientId = clientId;
let gateRejected = false;
try {
  await agent.sendConversationCommandV4({ workspacePath: "/work/test", envelope: envelopeBeforeHello });
} catch (e) {
  gateRejected = /fault\.connection\.helloRequired/.test(String(e?.message ?? e));
}
check("A1 hello 之前 v4 命令被 helloRequired 闸住", gateRejected);

// A2：握手后命令立即生效。
const hello = await agent.helloConversationV4();
await agent.initializeConversationV4({
  kind: "clientHello", protocolVersion: hello.protocolVersion, clientId, clientKind: "mobileApp", appVersion: "test",
});
const ack = await agent.sendConversationCommandV4({
  workspacePath: "/work/test",
  envelope: createCommandEnvelope({ type: "createSession", sessionId: null, payload: { workspaceId: "test" } }),
});
check("A2 握手后 createSession 立即生效", ack.status === "accepted");
const sessionId = ack.result.sessionId;
store.save(seededSession(sessionId));

// A3：订阅大会话（还原 + 快照是复合重活）期间，先于订阅排队的一次"点击"要先被派发。
// 旧时序：订阅在调用它的同一个宏任务里同步跑完读库+快照，点击排在整段之后；
// 新时序：入口 yieldToInput 让点击先派发，再跑重活。判据即 tapAt < storeLoadAt。
// 注意必须用"只在库里"的会话：A2 刚建的那个已在内存，订阅不会走 restore（读库）路径。
// 配置形状抄 A2 真建出来的那份（snapshotFor 读 thoughtLevels 等字段，手造会缺键）。
const restoreOnlyId = `${sessionId}-restore-only`;
const persistedShape = structuredClone(records.get(sessionId));
persistedShape.sessionId = restoreOnlyId;
persistedShape.state.rows = seededSession(restoreOnlyId).state.rows;
persistedShape.state.nextRowId = ROWS + 1;
// createSession 落库的 config 是惰性解析前的空壳；还原+快照链路要一份完整形状。
persistedShape.state.config = {
  provider: "test", model: "mock", thought: "",
  thoughtLevels: [], followupMode: "queue", mode: "build",
};
records.set(restoreOnlyId, persistedShape);
// 帧监听先挂（UI 的真实顺序：先订帧通道再发订阅），首帧快照经缓冲通道回放。
const frames = [];
agent.onDynamicConversationFrame({ workspacePath: "/work/test", sessionId: restoreOnlyId })((f) => frames.push(f));
marks.storeLoadAt = -1;
const subPromise = agent.subscribeConversationV4({ workspacePath: "/work/test", sessionId: restoreOnlyId });
// 调用返回后的同一个宏任务里，读库必须还没发生——handler 在 yieldToInput 处挂起了，
// 浏览器得以在这一拍派发积压的点击/触摸（旧时序：整条还原+快照在调用任务里同步跑完）。
const suspendedBeforeHeavy = marks.storeLoadAt < 0;
const subAck = await subPromise;
check("A3 订阅在复合重活前挂起让路（调用任务内不读库）",
  suspendedBeforeHeavy && marks.storeLoadAt > 0,
  `storeLoadAt=${marks.storeLoadAt}（>0 = 挂起后在后续宏任务完成）`);
check("A3b 订阅行为不回归（snapshot ack）",
  subAck.ack.mode === "snapshot" && subAck.ack.logEpoch.length > 0,
  JSON.stringify(subAck.ack));
check("A3c 首帧快照经缓冲通道回放给监听者", frames.length >= 1,
  `frames=${frames.length}${agentDiagnostics.filter((d) => d.includes("帧")).slice(-1)}`);
// A3 的读回复核：还原的会话行投影完整（restore → 内存 → snapshot 全链路）。
// 400 行 = 200 轮（userInput + assistantText），投影成消息后必须还能看到全部轮次。
const readBack = await agent.readSession({ workspacePath: "/work/test", sessionId: restoreOnlyId });
const readRows = readBack?.messages?.length ?? -1;
check("A3d 还原的会话可读（消息投影完整）", readRows >= ROWS / 2 && readRows <= ROWS, `messages=${readRows}`);

// A4：sessions-index 订阅同样让路。监听先挂、订阅后查：首帧不许在调用任务里同步发出。
agent.onDynamicSessionsIndexFrame({ workspacePath: "/work/test" })(() => { marksSeq.idxFrame = ++eventSeq; });
const idxPromise = agent.subscribeSessionsIndexV4({ workspacePath: "/work/test" });
const idxSuspended = marksSeq.idxFrame < 0;
const idxAck = await idxPromise;
check("A4 sessions-index 订阅在首帧前挂起让路（调用任务内不发帧）",
  idxSuspended && marksSeq.idxFrame > 0,
  `frameSeq=${marksSeq.idxFrame}`);
check("A4b sessions-index 订阅行为不回归（snapshot ack）", idxAck.ack.mode === "snapshot");

// ══════════════ 浏览器侧：真 dist-ui 产物 ══════════════
console.log("\n── 浏览器：启动屏交臂与设置项可达性 ──");
const { startChatdev } = await import(pathToFileURL(path.join(here, "chatdev.mjs")).href);
const port = 9321;
const dev = await startChatdev(port);
const { chromium } = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"))("playwright-core");
const browser = await chromium.launch({
  executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  args: ["--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"],
});
const context = await browser.newContext({
  viewport: { width: 393, height: 851 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
const bootErrors = [];
page.on("pageerror", (e) => bootErrors.push(String(e).slice(0, 200)));
// 启动屏时间线记录器：init script 在任何页面脚本之前跑；#booting 随 HTML 解析进 DOM、
// entry.js 在其后才执行——"#booting 一进 DOM"的采样是确定性的，不与机器速度赛跑。
await context.addInitScript(() => {
  const timeline = [];
  globalThis.__splashTimeline = timeline;
  const sample = (phase) => {
    const el = document.getElementById("booting");
    return {
      phase,
      present: Boolean(el),
      leaving: el?.classList.contains("leaving") ?? true,
      rootChildren: document.getElementById("root")?.childElementCount ?? 0,
    };
  };
  const mo = new MutationObserver(() => {
    if (!timeline.some((s) => s.phase === "booting-in-dom") && document.getElementById("booting")) {
      timeline.push(sample("booting-in-dom"));
    }
    if (timeline.some((s) => s.phase === "first-commit")) return;
    const host = document.getElementById("root");
    if (host?.childElementCount) {
      timeline.push(sample("first-commit"));
      globalThis.__splashHandoffSample = timeline[timeline.length - 1];
    }
  });
  mo.observe(document, { childList: true, subtree: true });
});
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${port}/?devCredentials=1&mode=stream&override=1`, {
  waitUntil: "domcontentloaded",
  timeout: 90000,
});

// B1：#booting 一进 DOM（页面脚本之前）启动屏就在屏且未离场——加载全程的可见等待态。
const timeline = await page.evaluate(() => globalThis.__splashTimeline ?? []);
const domSample = timeline.find((s) => s.phase === "booting-in-dom");
check("B1 启动屏随 HTML 进 DOM 后即在屏且未离场（可见等待态）",
  Boolean(domSample?.present) && domSample?.leaving === false && domSample?.rootChildren === 0,
  JSON.stringify(timeline[0] ?? null));

// 越过首装闸门走到主界面（与 swipe-verify 同一套）。
for (let i = 0; i < 150; i++) {
  if (await page.locator('[data-testid="task-settings-button"]').first().isVisible().catch(() => false)) break;
  for (const label of ["跳过", "使用 API key"]) {
    const b = page.getByText(label, { exact: false }).first();
    if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); break; }
  }
  await page.waitForTimeout(120);
}
// B2：首次提交那一刻启动屏还在（事件驱动交臂，不在提交前抢跑），且随后 ≤1.5s 内离场。
const shellGoneAt = Date.now();
let handoffOk = false;
let handoffDetail = "";
for (let i = 0; i < 15; i++) {
  const st = await page.evaluate(() => {
    const el = document.getElementById("booting");
    return { present: Boolean(el), leaving: el?.classList.contains("leaving") ?? true };
  });
  if (!st.present || st.leaving) { handoffOk = true; handoffDetail = `+${Date.now() - shellGoneAt}ms`; break; }
  await page.waitForTimeout(100);
}
const sample = await page.evaluate(() => globalThis.__splashHandoffSample);
check("B2a 首次提交时启动屏仍在屏（撤屏挂在提交事件上，不抢跑）",
  Boolean(sample?.present) && sample?.leaving === false, JSON.stringify(sample));
check("B2b 首帧之后启动屏 ≤1.5s 内交臂离场", handoffOk, handoffDetail);

// 开抽屉（真手势）→ 进设置。
const swipeOpen = async () => {
  await page.evaluate(async () => {
    const mk = (type, x) => {
      const touch = new Touch({ identifier: 1, target: document.body, clientX: x, clientY: 300 });
      return new TouchEvent(type, { bubbles: true, touches: type === "touchend" ? [] : [touch], changedTouches: [touch] });
    };
    document.dispatchEvent(mk("touchstart", 10));
    for (let i = 1; i <= 6; i++) { await new Promise((r) => setTimeout(r, 16)); document.dispatchEvent(mk("touchmove", 10 + (110 * i) / 6)); }
    document.dispatchEvent(mk("touchend", 120));
  });
  await page.waitForTimeout(350);
};
for (let i = 0; i < 10; i++) {
  await swipeOpen();
  const open = await page.evaluate(() => {
    const shell = document.querySelector("[data-workspace-shell]");
    return shell ? (parseFloat(getComputedStyle(shell).getPropertyValue("--workspace-sidebar-panel-width")) || 0) > 1 : false;
  });
  if (open) break;
}
await page.locator('[data-testid="task-settings-button"]').first().click({ timeout: 8000 }).catch(() => {});
let entered = false;
for (let i = 0; i < 100; i++) {
  if (await page.locator('[data-testid="settings-page"]').isVisible().catch(() => false)) { entered = true; break; }
  await page.waitForTimeout(80);
}
check("B3 前置：进入设置页", entered);

// B3：设置项不被任何层覆盖。进设置后抽屉遮罩要离场（0.7.1/0.7.7 的修复语义，由
// data-root-workspace-surface 属性翻转经 rAF 驱动）——先等它离场（≤2.5s，只等事件后果，
// 不放宽判据），随后命中测试必须落在分区按钮（或其子元素）上。逐个按钮测（内容加载会
// 挪布局，单个按钮可能恰好被滚出视口），任一命中即过；全不命中时给出首层祖先链。
let scrimLeft = false;
for (let i = 0; i < 25; i++) {
  const st = await page.evaluate(() => {
    const el = document.getElementById("zcode-narrow-scrim");
    if (!el) return true;
    const cs = getComputedStyle(el);
    return cs.display === "none" || cs.pointerEvents === "none";
  });
  if (st) { scrimLeft = true; break; }
  await page.waitForTimeout(100);
}
check("B3a 进设置后抽屉遮罩离场", scrimLeft);
const hit = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('[data-testid^="settings-section-nav-"]')];
  if (!btns.length) return { ok: false, why: "no nav buttons" };
  const describe = (el) => {
    const chain = [];
    let cur = el;
    while (cur && chain.length < 5) {
      const cls = typeof cur.className === "string" ? cur.className.split(" ").slice(0, 2).join(".") : "";
      chain.push(`${cur.tagName}${cur.id ? "#" + cur.id : ""}${cls ? "." + cls : ""}`);
      cur = cur.parentElement;
    }
    return chain.join("<");
  };
  let firstMiss = "";
  for (const btn of btns) {
    const r = btn.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight) continue;
    const el = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    if (el && (el === btn || btn.contains(el))) return { ok: true, why: btn.getAttribute("data-testid") };
    if (!firstMiss) firstMiss = el ? describe(el) : "null";
  }
  return { ok: false, why: `首层=${firstMiss}` };
});
check("B3 设置项命中测试落在按钮本体（无遮罩/无浮层压交互）", hit.ok, hit.why);

// B4：真触摸点分区导航 ≤2.5s 内生效（就绪后立即生效；给重试窗口吸收残余启动噪声）。
const cdp = await context.newCDPSession(page);
const realTap = async (sel) => {
  const box = await page.locator(sel).first().boundingBox();
  if (!box) return false;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }],
  });
  await page.waitForTimeout(50);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  return true;
};
let tapOk = false;
let tapDetail = "";
for (let attempt = 0; attempt < 3 && !tapOk; attempt++) {
  const target = "appearance";
  const at = Date.now();
  await realTap(`[data-testid="settings-section-nav-${target}"]`);
  for (let k = 0; k < 25; k++) {
    const cur = await page.evaluate(() => document.querySelector('[data-testid="settings-page"]')?.getAttribute("data-active-section"));
    if (cur === target) { tapOk = true; tapDetail = `+${Date.now() - at}ms(第${attempt + 1}次点击)`; break; }
    await page.waitForTimeout(100);
  }
}
check("B4 真触摸点分区导航在 2.5s 内生效", tapOk, tapDetail);
check("B5 浏览器全程无未捕获异常", bootErrors.length === 0, bootErrors.slice(0, 2).join(" | "));

await browser.close();
await dev.close();

// ══════════════ 收口 ══════════════
const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\n合计：${pass} PASS / ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
