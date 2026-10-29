// 0.9.0 web-mobile-shell 的 MutationObserver 回环判据（runtime_regression_audit）。
//
// 0.9.0 给壳的 body 观察器加了 attributeFilter: ["aria-hidden"]，同时 pushDrawerOpen()
// 新增了对右侧抽屉 [data-testid="mobile-side-pane-drawer"][aria-hidden="false"] 的查询。
// 这两条凑在一起可能形成「观察 → 写 → 触发观察 → 再写」的回环——本脚本用**真壳代码**
// （esbuild 打包 ui/web-mobile-shell.ts 注入页面）把它逼出来。
//
// 判据：
//   1. sync() 自己写的属性（style / inert / data-zcode-drawer）不得落在观察器的
//      attributeFilter 里 —— 否则每写一次就叫醒自己一次。
//   2. 抽屉 aria-hidden 翻一次 → 恰好一次 sync，不许级联。
//   3. 静置一段时间后 sync 计数必须停住（没有自持的回环）。
//   4. 流式期每次 DOM 抖动的 sync 成本（0.9.0 每次要多做两次全文档 querySelector）。
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const root = path.resolve(here, "..");
const require = createRequire(path.join(root, "../zcode/apps/zcode-cli/package.json"));
const esbuild = require("esbuild");
const { chromium } = require("playwright-core");

// ── 打包真壳代码 ──────────────────────────────────────────────────────────
const bundleOut = path.join(here, ".tmp-web-mobile-shell.js");
await esbuild.build({
  entryPoints: [path.join(root, "ui/web-mobile-shell.ts")],
  outfile: bundleOut,
  bundle: true,
  format: "iife",
  globalName: "ZShell",
  platform: "browser",
  target: "es2022",
  write: true,
  logLevel: "warning",
});
const shellSource = fs.readFileSync(bundleOut, "utf8");
fs.rmSync(bundleOut, { force: true });

// ── 一个只服务空白页的小宿主（给 localStorage 一个真 origin）────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
const page = await browser.newPage({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
await page.addScriptTag({ content: shellSource });

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: Boolean(ok), detail });
const out = { startedAt: new Date().toISOString() };

// 装一个「同步计数」探针：sync() 每次都会问这两个选择器，所以计数 = sync 次数。
await page.evaluate(() => {
  window.__probe = { syncCount: 0, drawerQueryCount: 0, settingsQueryCount: 0, setDrawerOpen: 0, lastOpen: null, records: [] };
  const orig = document.querySelector.bind(document);
  document.querySelector = function patched(sel) {
    if (typeof sel === "string") {
      if (sel.includes("mobile-side-pane-drawer")) window.__probe.drawerQueryCount++;
      else if (sel.includes("data-root-workspace-surface")) window.__probe.settingsQueryCount++;
    }
    return orig(sel);
  };
  globalThis.zcodeUi = {
    setDrawerOpen(v) { window.__probe.setDrawerOpen++; window.__probe.lastOpen = v; },
  };
  // 与壳里 navMo 完全同配置的「独立观察器」：它看到的就是壳会看到的那些变更。
  window.__mo = new MutationObserver((rs) => {
    for (const r of rs) {
      window.__probe.records.push({
        type: r.type,
        attr: r.attributeName ?? null,
        target: r.target?.nodeName ?? null,
        value: r.type === "attributes" ? r.target?.getAttribute?.(r.attributeName) : null,
      });
    }
  });
  window.__mo.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-root-workspace-surface", "aria-hidden"],
  });
});

// 造出与真机竖屏一致的 DOM：#sidebar + 带宽度变量的 shell + 右侧抽屉占位。
await page.evaluate(() => {
  document.body.innerHTML = `
    <div id="sidebar" class="flex h-full">
      <div class="flex-1"><button data-task-item-key="t1">会话 1</button></div>
      <div class="footer"><button data-testid="task-settings-button">设置</button></div>
    </div>
    <div data-workspace-shell style="--workspace-sidebar-panel-width: 264px"></div>
    <div data-testid="mobile-side-pane-drawer" aria-hidden="true" style="position:fixed;right:0;top:0;width:300px;height:100%"></div>
  `;
  // 触屏优化开关：0.9.0 的窄屏旗子真相源（armNarrowFlag 读它）。
  localStorage.setItem("zcode-mobile.touchOptimized", "1");
});

await page.evaluate(() => window.ZShell.installNarrowSidebarDrawer());
// 等观察器挂上（settle 需要 #sidebar 已在 DOM 里）+ 几帧 rAF。
await page.waitForTimeout(300);

const afterInstall = await page.evaluate(() => ({ ...window.__probe, records: window.__probe.records.length }));
out.afterInstall = {
  syncCount: afterInstall.drawerQueryCount + afterInstall.settingsQueryCount,
  drawerQueries: afterInstall.drawerQueryCount,
  settingsQueries: afterInstall.settingsQueryCount,
  observerRecords: afterInstall.records,
};

// 判据 1：装完之后，观察器**不应该**还在被壳自己的写叫醒（没有自持回环）。
const idleBefore = await page.evaluate(() => {
  window.__probe.records.length = 0;
  return window.__probe.drawerQueryCount + window.__probe.settingsQueryCount;
});
await page.waitForTimeout(600);
const idleAfter = await page.evaluate(() => ({
  sync: window.__probe.drawerQueryCount + window.__probe.settingsQueryCount,
  records: window.__probe.records.length,
}));
out.idle = { syncBefore: idleBefore, syncAfter: idleAfter.sync, observerRecordsWhileIdle: idleAfter.records };
check(
  "B1 静置期没有自持回环（壳不反复写 DOM 叫醒自己的观察器）",
  idleAfter.sync === idleBefore,
  `静置 600ms 内 sync 次数 ${idleBefore} → ${idleAfter.sync}，观察器记录 ${idleAfter.records} 条`,
);

// 判据 2：抽屉 aria-hidden 翻一次 → 恰好一次 sync（不许级联）。
const flip = await page.evaluate(async () => {
  const drawer = document.querySelector('[data-testid="mobile-side-pane-drawer"]');
  const before = window.__probe.drawerQueryCount + window.__probe.settingsQueryCount;
  drawer.setAttribute("aria-hidden", "false");
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const after = window.__probe.drawerQueryCount + window.__probe.settingsQueryCount;
  return { delta: after - before, lastOpen: window.__probe.lastOpen, setDrawerOpen: window.__probe.setDrawerOpen };
});
out.ariaFlip = flip;
check(
  "B2 抽屉 aria-hidden 翻转只触发一次 sync（无级联）",
  flip.delta >= 1 && flip.delta <= 3,
  `sync 增量=${flip.delta}，原生收到 drawerOpen=${flip.lastOpen}`,
);
check(
  "B3 抽屉开着时原生收到的抽屉态为 true（返回键拦截有依据）",
  flip.lastOpen === true,
  `lastOpen=${flip.lastOpen}`,
);

// 判据 4：流式期每次 DOM 抖动的 sync 成本。0.9.0 的 sync 每次多两次全文档 querySelector。
const stream = await page.evaluate(async () => {
  // 先把文档撑大：真实首屏有几千个节点，querySelector 的代价随文档规模走。
  const filler = document.createElement("div");
  filler.id = "filler";
  for (let i = 0; i < 6000; i++) {
    const d = document.createElement("div");
    d.textContent = "行 " + i;
    filler.appendChild(d);
  }
  document.body.appendChild(filler);
  await new Promise((r) => setTimeout(r, 200));
  const before = window.__probe.drawerQueryCount + window.__probe.settingsQueryCount;
  const recordsBefore = window.__probe.records.length;
  const t0 = performance.now();
  const stream = document.createElement("div");
  filler.appendChild(stream); // 必须挂进文档，否则观察器看不见这些变动
  for (let i = 0; i < 120; i++) {
    const s = document.createElement("span");
    s.textContent = "token " + i;
    stream.appendChild(s);
    await new Promise((r) => requestAnimationFrame(r));
  }
  const elapsed = performance.now() - t0;
  const after = window.__probe.drawerQueryCount + window.__probe.settingsQueryCount;
  const recordsAfter = window.__probe.records.length;
  filler.remove();
  return { syncDelta: after - before, elapsedMs: Math.round(elapsed), observerRecords: recordsAfter - recordsBefore };
});
out.stream = stream;
check(
  "B4 流式期 sync 次数被 rAF 合帧（120 次 DOM 抖动不该变成 120 次 sync）",
  stream.observerRecords > 100 && stream.syncDelta < 120,
  `120 次流式 DOM 抖动 → 观察器记录 ${stream.observerRecords} 条、sync ${stream.syncDelta} 次（${stream.elapsedMs}ms）`,
);

// 判据 6：**左侧抽屉收起时**（手机上最常见的状态）每次 sync 的额外代价。
// pushDrawerOpen 是 `open || (...)`：左侧开着时短路，右边那两次 querySelector 根本不跑；
// 左侧收起时才跑 —— 也就是首屏默认状态。
const closedCost = await page.evaluate(async () => {
  const shell = document.querySelector("[data-workspace-shell]");
  shell.style.setProperty("--workspace-sidebar-panel-width", "0px"); // React 说侧栏收起
  await new Promise((r) => setTimeout(r, 200));
  const before = { drawer: window.__probe.drawerQueryCount, settings: window.__probe.settingsQueryCount };
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) {
    const d = document.createElement("div");
    d.textContent = "x" + i;
    document.body.appendChild(d);
    await new Promise((r) => requestAnimationFrame(r));
  }
  const elapsed = performance.now() - t0;
  const after = { drawer: window.__probe.drawerQueryCount, settings: window.__probe.settingsQueryCount };
  for (let i = 0; i < 50; i++) document.body.lastElementChild?.remove();
  return {
    drawerQueries: after.drawer - before.drawer,
    settingsQueries: after.settings - before.settings,
    elapsedMs: Math.round(elapsed),
  };
});
out.closedDrawerCost = closedCost;
check(
  "B6 左侧抽屉收起时，每次 sync 都要做全文档 querySelector（0.9.0 新增 1 次）",
  closedCost.drawerQueries > 0 && closedCost.settingsQueries > closedCost.drawerQueries,
  `50 次 DOM 抖动 → 抽屉查询 ${closedCost.drawerQueries} 次、设置层查询 ${closedCost.settingsQueries} 次（${closedCost.elapsedMs}ms）`,
);

// 判据 5：壳自己写的属性不得落在 navMo 的 attributeFilter 里。
const writtenAttrs = await page.evaluate(() => {
  const seen = new Set();
  const panel = document.querySelector("#sidebar");
  const obs = new MutationObserver((rs) => {
    for (const r of rs) if (r.type === "attributes") seen.add(r.attributeName);
  });
  obs.observe(panel, { attributes: true });
  // 逼壳再写一轮：改一下 React 意图变量宽度 → 触发 resize 不现实，这里直接改 class 让
  // 面板的 observer 醒一次（面板 observer 的 filter 含 class/style/aria-hidden/inert）。
  panel.classList.add("probe-touch");
  return new Promise((resolve) => setTimeout(() => { obs.disconnect(); resolve([...seen]); }, 100));
});
out.panelWrittenAttrs = writtenAttrs;
check(
  "B5 壳写入面板的属性里没有 aria-hidden（不会从面板观察器回灌到 body 观察器）",
  !writtenAttrs.includes("aria-hidden"),
  `面板上被观察到的属性变化：${JSON.stringify(writtenAttrs)}`,
);

out.pageErrors = pageErrors;
check("B7 壳安装与上述操作期间没有页面异常", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();
server.close();

out.results = results;
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.detail ? `\n     ${r.detail}` : ""}`);
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} PASS`);
console.log("JSON " + JSON.stringify(out));
process.exitCode = results.some((r) => !r.ok) ? 1 : 0;
