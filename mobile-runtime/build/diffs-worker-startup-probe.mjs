// 量「高亮 Worker 池在应用启动阶段到底花了多少」：
//   A 现状（poolSize = min(4, hardwareConcurrency/2)）
//   B 把 navigator.hardwareConcurrency 压到 1 → resolveWorkerPoolSize() 返回 1
//   C 让 Worker 构造直接失败 → 池退化成 0 个 worker，高亮走主线程兜底
// 三种情况都量：goto → 首屏可交互、longtask 数量/最长、usedJSHeapSize、Worker 实际个数。
import { createRequire } from "node:module";
import { appendFileSync, writeFileSync } from "node:fs";
import { startChatdev } from "./chatdev.mjs";

const require = createRequire(new URL("../../zcode/apps/zcode-cli/package.json", import.meta.url));
const { chromium } = require("playwright-core");

const PORT = Number(process.env.PROBE_PORT ?? 8977);
const ONLY = process.env.PROBE_ONLY ?? null;
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const log = (...a) => {
  const line = `[probe] ${a.join(" ")}\n`;
  process.stderr.write(line);
  try {
    appendFileSync("D:/Zcode/tmp/diffs-probe-progress.log", line);
  } catch {}
};

const OUT = "D:/Zcode/tmp/diffs-probe-results.json";
try {
  writeFileSync(OUT, "");
} catch {}

// 三种场景共用的页面内探针：数 Worker、收 longtask、记 Worker 构造时刻。
function initProbe() {
  globalThis.__workerCalls = [];
  globalThis.__longTasks = [];
  globalThis.__t0 = performance.now();
  globalThis.__composerAt = null;
  // 用 MutationObserver 精确记录首屏输入区首次出现/可交互的时刻，
  // 避免轮询本身的往返开销把数字放大。
  const markComposer = () => {
    if (globalThis.__composerAt != null) return;
    const el = document.querySelector('[data-testid="v4-composer-send"]');
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    globalThis.__composerAt = Math.round(performance.now() - globalThis.__t0);
  };
  const obs = new MutationObserver(markComposer);
  const start = () => {
    markComposer();
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  };
  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start);
  try {
    new PerformanceObserver((list) => {
      globalThis.__longTasks.push(
        ...list.getEntries().map((e) => ({ duration: e.duration, start: e.startTime })),
      );
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  // 注意：不要在这里包装 window.Worker —— module worker 在包装后会因为
  // 构造函数的 prototype/继承被破坏而加载失败，Worker 数会假报 0。
  // 真实 Worker 数改由 Playwright 的 page.on("worker") 事件统计。
}

async function runScenario(browser, { name, patch }) {
  log(`scenario start: ${name}`);
  const page = await browser.newPage({
    viewport: { width: 393, height: 851 },
    isMobile: true,
    hasTouch: true,
  });
  const consoleErrors = [];
  const pageErrors = [];
  // 用 Playwright 的 worker 事件数真实 Worker：页面里 patch 的计数器不可靠。
  const realWorkers = [];
  page.on("worker", (w) => realWorkers.push({ url: w.url(), at: Date.now() }));
  const failedRequests = [];
  page.on("requestfailed", (r) => failedRequests.push({ url: r.url(), err: r.failure()?.errorText }));
  page.on("response", (r) => {
    if (r.status() >= 400) failedRequests.push({ url: r.url(), err: `HTTP ${r.status()}` });
  });
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
  });

  await page.addInitScript(initProbe);
  if (patch) await page.addInitScript(patch);

  const gotoStart = Date.now();
  await page.goto(`http://127.0.0.1:${PORT}/?devCredentials=1`, { timeout: 60000 });
  log(`  goto done in ${Date.now() - gotoStart} ms`);

  let interactive = null;
  for (let i = 0; i < 80; i++) {
    if (await page.locator('[data-testid="v4-composer-send"]').isVisible().catch(() => false)) {
      interactive = Date.now() - gotoStart;
      break;
    }
    for (const label of ["跳过", "使用 API key"]) {
      const b = page.getByText(label, { exact: false }).first();
      if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
    }
    await page.waitForTimeout(250);
  }
  // 首屏可交互后再多等一会，让 worker 池的初始化消息往返完成。
  await page.waitForTimeout(3000);

  const data = await page.evaluate(() => {
    const lt = globalThis.__longTasks ?? [];
    const mem = performance.memory;
    return {
      workerCalls: globalThis.__workerCalls ?? [],
      workerCount: (globalThis.__workerCalls ?? []).length,
      composerAt: globalThis.__composerAt ?? null,
      longTaskCount: lt.length,
      longestTask: lt.length ? Math.max(...lt.map((t) => t.duration)) : 0,
      totalLongTask: lt.reduce((a, t) => a + t.duration, 0),
      longTasks: lt.map((t) => Math.round(t.duration)),
      usedJSHeapSize: mem?.usedJSHeapSize ?? null,
      totalJSHeapSize: mem?.totalJSHeapSize ?? null,
      jsHeapSizeLimit: mem?.jsHeapSizeLimit ?? null,
      navigation: (() => {
        const n = performance.getEntriesByType("navigation")[0];
        return n
          ? {
              domContentLoaded: Math.round(n.domContentLoadedEventEnd),
              loadEvent: Math.round(n.loadEventEnd),
              responseEnd: Math.round(n.responseEnd),
              domInteractive: Math.round(n.domInteractive),
            }
          : null;
      })(),
      resources: performance
        .getEntriesByType("resource")
        .filter((r) => /diffs\.worker|chunk-|wasm/i.test(r.name))
        .map((r) => ({ n: r.name.split("/").pop(), kb: Math.round(r.transferSize / 1024) })),
      // 启动期一共拉了多少 JS：这是端上真正要付的下载+解析成本。
      jsFetch: (() => {
        const rs = performance.getEntriesByType("resource").filter((r) => r.name.endsWith(".js"));
        return {
          count: rs.length,
          kb: Math.round(rs.reduce((a, r) => a + r.transferSize, 0) / 1024),
          beforeComposer: rs.filter((r) => (globalThis.__composerAt ?? 1e9) * 1 >= r.responseEnd).length,
        };
      })(),
      allResources: performance.getEntriesByType("resource").length,
    };
  });
  log(`  evaluated: workers=${data.workerCount} longtasks=${data.longTaskCount}`);

  await page.close();
  return {
    name,
    interactiveMs: interactive,
    ...data,
    realWorkerCount: realWorkers.length,
    realWorkerUrls: realWorkers.map((w) => w.url().split("/").pop()),
    failedRequests: failedRequests.slice(0, 8),
    consoleErrors: consoleErrors.slice(0, 5),
    pageErrors: pageErrors.slice(0, 5),
  };
}

const host = await startChatdev(PORT);
log(`chatdev up on ${PORT}`);
const browser = await chromium.launch({ executablePath: EDGE });
log("edge launched");
const results = [];
try {
  const scenarios = [
    { name: "A 现状 (poolSize=min(4,hw/2))" },
    {
      name: "B hardwareConcurrency=1 (poolSize=1)",
      patch: () => {
        Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 1, configurable: true });
      },
    },
    {
      name: "C Worker 构造失败 (poolSize=0/主线程兜底)",
      patch: () => {
        Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 1, configurable: true });
        // 让 Worker 构造直接抛错 → 池初始化失败 → 高亮退回主线程兜底路径。
        // 注意用普通赋值而不是 getter：provider 里要读 typeof Worker，getter 抛错会连带炸掉整棵渲染树。
        const Real = globalThis.Worker;
        globalThis.Worker = function () {
          throw new Error("probe: worker pool disabled");
        };
        globalThis.Worker.prototype = Real.prototype;
      },
    },
  ];
  for (const scenario of scenarios) {
    if (ONLY && !scenario.name.includes(ONLY)) continue;
    log(`running scenario: ${scenario.name}`);
    try {
      const r = await runScenario(browser, scenario);
      results.push(r);
      // 每个场景跑完就落盘：中途被杀也能拿到已完成的那份数据。
      try {
        writeFileSync(OUT, JSON.stringify(results, null, 2));
      } catch {}
    } catch (error) {
      const e = { name: scenario.name, error: String(error).slice(0, 400) };
      results.push(e);
      try {
        writeFileSync(OUT, JSON.stringify(results, null, 2));
      } catch {}
    }
  }
} finally {
  await browser.close();
  await host.close();
  log("closed");
}

let report = "\n================ 高亮 Worker 启动开销 ================\n";
for (const r of results) {
  let block = `\n--- ${r.name} ---\n`;
  if (r.error) {
    block += `  失败: ${r.error}\n`;
  } else {
    block += `  goto→首屏可交互 : ${r.interactiveMs ?? "(超时未出现)"} ms\n`;
    block += `  首屏输入区出现   : ${r.composerAt ?? "n/a"} ms (页面内计时)\n`;
    block += `  navigation      : ${JSON.stringify(r.navigation)}\n`;
    block += `  Worker 构造次数 : ${r.workerCount}  @ ${JSON.stringify(r.workerCalls.map((w) => w.at))} ms\n`;
    block += `  真实 Worker 数    : ${r.realWorkerCount}  ${JSON.stringify(r.realWorkerUrls)}\n`;
    block += `  失败请求        : ${JSON.stringify(r.failedRequests)}\n`;
    block += `  longtask        : ${r.longTaskCount} 条, 最长 ${Math.round(r.longestTask)} ms, 合计 ${Math.round(r.totalLongTask)} ms\n`;
    block += `  longtasks(ms)   : ${JSON.stringify(r.longTasks)}\n`;
    block += `  usedJSHeapSize  : ${r.usedJSHeapSize != null ? (r.usedJSHeapSize / 1048576).toFixed(1) + " MB" : "n/a"}\n`;
    block += `  pageErrors      : ${JSON.stringify(r.pageErrors)}\n`;
    block += `  consoleErrors   : ${JSON.stringify(r.consoleErrors)}\n`;
    block += `  启动期 JS 拉取   : ${JSON.stringify(r.jsFetch)}\n`;
    block += `  资源请求总数     : ${r.allResources}\n`;
  }
  report += block;
}
try {
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  appendFileSync("D:/Zcode/tmp/diffs-probe-progress.log", report);
} catch {}
console.log(report);
