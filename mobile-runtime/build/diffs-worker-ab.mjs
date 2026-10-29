// 同一份产物上做 A/B：
//   A：拦截 entry.js，把移动端平台能力 supportsBackgroundHighlighting 从 false 改成 true，
//      等价于 0.9.0 修复前的样子——DiffsWorkerPoolProvider 真的建池（最多 4 个 Worker）。
//   B：不拦截，走当前产物（能力=false → 不建池，高亮走主线程惰性路径）。
// 这样两条曲线只差“建不建池”，不受产物差异干扰。
import { createRequire } from "node:module";
import { appendFileSync, writeFileSync } from "node:fs";
import { startChatdev } from "./chatdev.mjs";

const require = createRequire(new URL("../../zcode/apps/zcode-cli/package.json", import.meta.url));
const { chromium } = require("playwright-core");

const PORT = Number(process.env.PROBE_PORT ?? 9010);
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const OUT = "D:/Zcode/tmp/diffs-ab.json";
const PROGRESS = "D:/Zcode/tmp/diffs-ab-progress.log";
const log = (...a) => {
  const line = `[ab] ${a.join(" ")}\n`;
  process.stderr.write(line);
  try { appendFileSync(PROGRESS, line); } catch {}
};

function initProbe() {
  globalThis.__longTasks = [];
  globalThis.__composerAt = null;
  globalThis.__t0 = performance.now();
  try {
    new PerformanceObserver((l) => {
      globalThis.__longTasks.push(...l.getEntries().map((e) => e.duration));
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  const mark = () => {
    if (globalThis.__composerAt != null) return;
    const el = document.querySelector('[data-testid="v4-composer-send"]');
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    globalThis.__composerAt = Math.round(performance.now() - globalThis.__t0);
  };
  const obs = new MutationObserver(mark);
  const start = () => {
    mark();
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  };
  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start);
}

async function run(browser, name, enablePool) {
  log(`scenario ${name} start`);
  const page = await browser.newPage({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true });
  const workers = [];
  page.on("worker", (w) => workers.push(w.url().split("/").pop()));
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
  if (enablePool) {
    // 只改一处：把移动端平台能力翻成 true，让 DiffsWorkerPoolProvider 真的建池。
    await page.route("**/entry.js", async (route) => {
      const res = await route.fetch();
      const body = (await res.text()).replace(
        "supportsBackgroundHighlighting:!1",
        "supportsBackgroundHighlighting:!0",
      );
      await route.fulfill({ response: res, body });
    });
  }
  await page.addInitScript(initProbe);
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${PORT}/?devCredentials=1`, { timeout: 60000 });
  let interactive = null;
  for (let i = 0; i < 80; i++) {
    if (await page.locator('[data-testid="v4-composer-send"]').isVisible().catch(() => false)) {
      interactive = Date.now() - t0;
      break;
    }
    for (const l of ["跳过", "使用 API key"]) {
      const b = page.getByText(l, { exact: false }).first();
      if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
    }
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(4000);
  const d = await page.evaluate(() => {
    const lt = globalThis.__longTasks ?? [];
    const m = performance.memory;
    const js = performance.getEntriesByType("resource").filter((r) => r.name.endsWith(".js"));
    return {
      composerAt: globalThis.__composerAt ?? null,
      longTaskCount: lt.length,
      longest: lt.length ? Math.max(...lt) : 0,
      totalLt: lt.reduce((a, b) => a + b, 0),
      longTasks: lt.map((x) => Math.round(x)),
      heapMB: m?.usedJSHeapSize ? +(m.usedJSHeapSize / 1048576).toFixed(1) : null,
      jsCount: js.length,
      jsKB: Math.round(js.reduce((a, r) => a + r.transferSize, 0) / 1024),
    };
  });
  await page.close();
  log(`scenario ${name}: interactive=${interactive}ms workers=${workers.length} ${JSON.stringify(workers)}`);
  return { name, interactive, workerCount: workers.length, workers, ...d, pageErrors: errs.slice(0, 4) };
}

const host = await startChatdev(PORT);
const browser = await chromium.launch({ executablePath: EDGE });
const out = [];
try {
  for (const s of [
    { name: "A 建池 (poolSize=min(4,hw/2))", enablePool: true },
    { name: "B 不建池 (当前产物/主线程惰性高亮)", enablePool: false },
  ]) {
    try {
      out.push(await run(browser, s.name, s.enablePool));
    } catch (e) {
      out.push({ name: s.name, error: String(e).slice(0, 300) });
    }
    try { writeFileSync(OUT, JSON.stringify(out, null, 2)); } catch {}
  }
} finally {
  await browser.close();
  await host.close();
}
let rep = "\n=== A/B 汇总 ===\n";
for (const r of out) rep += `${r.name}\n  ${JSON.stringify(r, null, 1)}\n`;
try { appendFileSync(PROGRESS, rep); } catch {}
console.log(rep);
