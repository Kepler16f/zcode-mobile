// 0.9.0 竖屏抽屉（AnimatedSidePanePanel + usePortraitSideDrawer）首屏 A/B。
//
// 做法：**不改源码、不重打包**，在浏览器里把已构建的 dist-ui/entry.js 响应体里那一处
// `e?.supportsPortraitSideDrawer&&typeof document<"u"` 改成恒假 —— 于是
// usePortraitSideDrawer 永远返回 false，竖屏右侧抽屉（createPortal 到 document.body 的那棵
// 树）整条不生效，其余一切完全相同。然后两份各量一次首屏。
//
// 量什么：到输入框可交互的耗时、long task（主线程长任务 = 布局重排/大计算）、
// 首屏 DOM 节点数、抽屉 portal 在不在。
import { createRequire } from "node:module";
import { startChatdev } from "./chatdev.mjs";

const require = createRequire(new URL("../../zcode/apps/zcode-cli/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const port = Number(process.argv.find((a) => /^\d{4,5}$/.test(a)) ?? 8996);
const ROUNDS = Number(process.argv.find((a) => /^--rounds=\d+$/.test(a))?.slice(9) ?? 3);
const host = await startChatdev(port);
const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });

const PATCH_FROM = 'e?.supportsPortraitSideDrawer&&typeof document<"u"';
const PATCH_TO = 'e?.supportsPortraitSideDrawer&&!1&&typeof document<"u"';

async function measure(variant) {
  const context = await browser.newContext({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 240)));
  let patched = 0;
  if (variant === "no-drawer") {
    await page.route("**/entry.js", async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      const hit = body.split(PATCH_FROM).length - 1;
      patched = hit;
      await route.fulfill({ response, body: body.split(PATCH_FROM).join(PATCH_TO) });
    });
  }
  await page.addInitScript(() => {
    globalThis.__longTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) globalThis.__longTasks.push({ d: Math.round(e.duration), n: e.name });
      }).observe({ type: "longtask", buffered: true });
    } catch {}
  });
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${port}/?devCredentials=1`, { timeout: 90000 });
  let composerMs = null;
  for (let i = 0; i < 300; i++) {
    if (await page.locator('[data-testid="v4-composer-send"]').isVisible().catch(() => false)) {
      composerMs = Date.now() - t0;
      break;
    }
    for (const label of ["跳过", "使用 API key"]) {
      const b = page.getByText(label, { exact: false }).first();
      if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
    }
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(2500);
  const metrics = await page.evaluate(() => ({
    longTasks: globalThis.__longTasks.map((t) => t.d).sort((a, b) => b - a).slice(0, 8),
    longTaskCount: globalThis.__longTasks.length,
    longTaskTotal: globalThis.__longTasks.reduce((s, t) => s + t.d, 0),
    domNodes: document.getElementsByTagName("*").length,
    hasDrawerPortal: !!document.querySelector('[data-mobile-side-drawer="true"]'),
    hasDrawerTestId: !!document.querySelector('[data-testid="mobile-side-pane-drawer"]'),
    hasSidePaneResizable: !!document.querySelector('[data-workspace-side-pane-resize-handle="true"]'),
    narrow: document.documentElement.classList.contains("zcode-narrow"),
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
  }));
  await context.close();
  return { variant, composerMs, patched, errors: errors.slice(0, 5), ...metrics };
}

// 交错跑（ABABAB），取中位数：单次测量在这台机器上抖动很大（同一份 bundle 的
// 冷/热缓存能差 5 倍），单次对比没有意义。
const runs = { "with-drawer": [], "no-drawer": [] };
for (let i = 0; i < ROUNDS; i++) {
  const order = i % 2 === 0 ? ["with-drawer", "no-drawer"] : ["no-drawer", "with-drawer"];
  for (const variant of order) {
    const r = await measure(variant);
    runs[variant].push(r);
    console.log(`# round ${i + 1} ${variant}: composerMs=${r.composerMs} longTaskTotal=${r.longTaskTotal} domNodes=${r.domNodes} portal=${r.hasDrawerPortal}`);
  }
}
await browser.close();
await host.close();

const median = (xs) => { const s = xs.filter((n) => typeof n === "number").sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const summarize = (variant) => {
  const rs = runs[variant];
  return {
    composerMs: rs.map((r) => r.composerMs),
    composerMsMedian: median(rs.map((r) => r.composerMs)),
    longTaskTotal: rs.map((r) => r.longTaskTotal),
    longTaskTotalMedian: median(rs.map((r) => r.longTaskTotal)),
    domNodes: rs.map((r) => r.domNodes),
    portalSeen: rs.map((r) => r.hasDrawerPortal),
    errors: rs.flatMap((r) => r.errors),
  };
};
const A = summarize("with-drawer");
const B = summarize("no-drawer");
console.log(JSON.stringify({ rounds: ROUNDS, withDrawer: A, noDrawer: B, delta: {
  composerMsMedian: (B.composerMsMedian ?? 0) - (A.composerMsMedian ?? 0),
  longTaskTotalMedian: (B.longTaskTotalMedian ?? 0) - (A.longTaskTotalMedian ?? 0),
} }, null, 2));
