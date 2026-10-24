// 一次性取证（0.4.10）：钉死"顶栏右侧图标被裁"的机制。
// 上一版探针发现 [data-testid="workspace-header"] 在移动布局里根本不存在（我 0.4.9 的
// header padding CSS 全空放），且 overlayKids 只量到 ☰/返回。这一版：把屏幕顶部 160px
// 带内的**所有** button/带 testid 的元素矩形、它们各自的最近可滚动祖先的 overflow/scrollWidth
// 一次量全——谁把谁挤出屏幕，读数直接给。
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startChatdev } from "./chatdev.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"));
const { chromium } = require("playwright-core");

const port = Number(process.argv[2] ?? 9155);
const dev = await startChatdev(port);
const browser = await chromium.launch({
  executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  args: ["--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"],
});
const context = await browser.newContext({
  viewport: { width: 800, height: 1100 },
  deviceScaleFactor: 2, isMobile: true, hasTouch: true,
});
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${port}/?devCredentials=1&mode=stream&override=1`, {
  waitUntil: "domcontentloaded", timeout: 60000,
});
for (let i = 0; i < 60; i++) {
  if (await page.locator('[data-testid="v4-composer-send"]').isVisible().catch(() => false)) break;
  for (const label of ["跳过", "使用 API key"]) {
    const b = page.getByText(label, { exact: false }).first();
    if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); break; }
  }
  await page.waitForTimeout(300);
}

const probe = await page.evaluate(() => {
  const clipRight = innerWidth;
  const inTopBand = (r) => r.top < 160 && r.width > 0;
  const els = [...document.querySelectorAll("[data-testid], button")];
  const items = [];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (!inTopBand(r)) continue;
    const tid = el.getAttribute("data-testid");
    const overflows = r.right > clipRight - 2; // 被右边缘切
    // 最近的可滚动/裁剪祖先
    let anc = el.parentElement, clippedBy = null;
    while (anc) {
      const cs = getComputedStyle(anc);
      if (/(hidden|clip|auto|scroll)/.test(cs.overflowX) && anc.scrollWidth > anc.clientWidth + 2) {
        clippedBy = `${anc.getAttribute("data-testid") || anc.className.slice(0, 40)}:sw=${anc.scrollWidth}/cw=${anc.clientWidth}:ovx=${cs.overflowX}`;
        break;
      }
      anc = anc.parentElement;
    }
    items.push({
      tid: tid || el.tagName + ":" + (el.textContent || "").trim().slice(0, 14),
      rect: `${Math.round(r.left)}-${Math.round(r.right)} @y=${Math.round(r.top)} (${Math.round(r.width)}x${Math.round(r.height)})`,
      offscreen: overflows ? "RIGHT_CLIP" : "",
      clippedBy: clippedBy || "",
    });
  }
  // 按 left 排序，右侧溢出的排最后最显眼
  items.sort((a, b) => parseInt(a.rect) - parseInt(b.rect));
  return { vw: innerWidth, count: items.length, items };
});
console.log("顶栏带 " + JSON.stringify(probe, null, 1));

await page.screenshot({ path: path.join(here, "e2e-shots", "topbar-clip-probe.png") });
await browser.close();
await dev.close();
process.exit(0);
