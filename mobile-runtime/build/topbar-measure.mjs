// 一次性取证脚本（不进交付链）：窄屏下顶栏浮层按钮的实测 rect。
// 装机"顶栏按钮调大下移没效果"——桌面先用同一个 Chromium 内核量一遍：
// CSS 规则在不在、选择器命没命中、rect 是多少。
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startChatdev } from "./chatdev.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"));
const { chromium } = require("playwright-core");

const port = 8991;
const dev = await startChatdev(port);
const browser = await chromium.launch({
  executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  args: ["--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"],
});
const context = await browser.newContext({ viewport: { width: 393, height: 800 } });
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${port}/?devCredentials=1&mode=stream&override=1`, {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
// 越首装闸门（照 chat-e2e 的轮询法）
for (let i = 0; i < 60; i++) {
  if (await page.locator('[data-testid="v4-composer-send"]').isVisible().catch(() => false)) break;
  for (const label of ["跳过", "使用 API key"]) {
    const b = page.getByText(label, { exact: false }).first();
    if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); break; }
  }
  await page.waitForTimeout(300);
}

const out = await page.evaluate(() => {
  const narrow = document.documentElement.classList.contains("zcode-narrow");
  const sheet = [...document.styleSheets].find((s) => s.ownerNode?.id === "zcode-narrow-css");
  const rules = sheet ? [...sheet.cssRules].map((r) => r.cssText.slice(0, 120)) : null;
  const probe = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      found: true,
      rect: `${Math.round(r.width)}x${Math.round(r.height)} @y=${Math.round(r.top)}`,
      cssWidth: cs.width, cssHeight: cs.height,
      minWidth: cs.minWidth, minHeight: cs.minHeight,
      svg: (() => {
        const s = el.querySelector("svg");
        return s ? `${Math.round(s.getBoundingClientRect().width)}px` : "(无svg)";
      })(),
    };
  };
  const overlay = document.querySelector('[class*="topoverlayer"]');
  const header = document.querySelector('[data-testid="workspace-header"]');
  return {
    narrow,
    ruleCount: rules?.length ?? 0,
    rules: rules?.slice(0, 4),
    overlayTop: overlay ? getComputedStyle(overlay).top : "(浮层不存在)",
    headerPadTop: header ? getComputedStyle(header).paddingTop : "(header不存在)",
    toggle: probe('[data-testid="web-sidebar-toggle"]'),
    back: probe('[data-testid="desktop-top-nav-back"]'),
    newTask: probe('[data-testid="conversation-new-task"]'),
    testidTaskNew: probe('[data-testid="task-new-button"]'),
  };
});
console.log(JSON.stringify(out, null, 2));
await page.screenshot({ path: path.join(here, "e2e-shots", "topbar-measure.png") });
await browser.close();
await dev.close();
