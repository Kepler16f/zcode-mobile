// 一次性取证（0.4.10）：装机两报的桌面证据。
//  A. 顶栏右侧图标被裁：workspace-header 动作组（terminal/help/more）在 800px 竖屏下是否
//     横向溢出容器——rect.right 超屏 / scrollWidth>clientWidth，并把 header 内所有直接子元素
//     的矩形打出来，钉死"被裁"到底是哪个元素、被谁挡住。
//  B. tap 输入框焦点链路：hasTouch 上下文里 tap v4-composer-input，读 activeElement——
//     如果 tap 后焦点不在输入区，装机"点输入框没反应"就是触摸→焦点链断了（桌面鼠标逻辑的锅）。
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startChatdev } from "./chatdev.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"));
const { chromium } = require("playwright-core");

const port = Number(process.argv[2] ?? 9151);
const dev = await startChatdev(port);
const browser = await chromium.launch({
  executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  args: ["--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"],
});
const context = await browser.newContext({
  viewport: { width: 800, height: 1100 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
await page.goto(`http://127.0.0.1:${port}/?devCredentials=1&mode=stream&override=1`, {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
for (let i = 0; i < 60; i++) {
  if (await page.locator('[data-testid="v4-composer-send"]').isVisible().catch(() => false)) break;
  for (const label of ["跳过", "使用 API key"]) {
    const b = page.getByText(label, { exact: false }).first();
    if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); break; }
  }
  await page.waitForTimeout(300);
}
if (!(await page.locator('[data-testid="v4-composer-send"]').isVisible().catch(() => false))) {
  throw new Error("没走到主界面");
}

const overflow = await page.evaluate(() => {
  const header = document.querySelector('[data-testid="workspace-header"]');
  const hr = header?.getBoundingClientRect();
  const kids = header
    ? [...header.querySelectorAll("[data-testid]")].map((el) => {
        const r = el.getBoundingClientRect();
        return `${el.getAttribute("data-testid")}:${Math.round(r.left)}-${Math.round(r.right)}(${Math.round(r.width)}x${Math.round(r.height)})`;
      })
    : [];
  // 浮层里的钮（☰/新建/返回）——截图里 ☰ 很大，pill 也在上方，一并量
  const overlayKids = [...document.querySelectorAll('[class*="topoverlayer"] [data-testid]')].map((el) => {
    const r = el.getBoundingClientRect();
    return `${el.getAttribute("data-testid")}:${Math.round(r.left)}-${Math.round(r.right)}(${Math.round(r.width)}x${Math.round(r.height)})`;
  });
  const cs = header ? getComputedStyle(header) : null;
  return {
    vw: innerWidth,
    header: hr ? `left=${Math.round(hr.left)} right=${Math.round(hr.right)} w=${Math.round(hr.width)}` : "(无)",
    headerScrollVsClient: header ? `scroll=${header.scrollWidth} client=${header.clientWidth}` : "(无)",
    headerOverflowClip: header ? `${cs.overflow}/${cs.overflowX}` : "(无)",
    kids,
    overlayKids,
  };
});
console.log("A.顶栏测量 " + JSON.stringify(overflow, null, 1));

const inputSel = '[data-testid="v4-composer-input"]';
await page.tap(inputSel);
await page.waitForTimeout(300);
const tapFocus = await page.evaluate((sel) => {
  const a = document.activeElement;
  const target = document.querySelector(sel);
  return {
    active: `${a?.tagName}${a?.isContentEditable ? "(ce)" : ""}`,
    activeTestid: a?.getAttribute?.("data-testid") ?? null,
    isTargetOrInside: Boolean(a && target && (a === target || target.contains(a) || a.contains(target))),
  };
}, inputSel);
console.log("B.tap后焦点 " + JSON.stringify(tapFocus));

await browser.close();
await dev.close();
process.exit(0);
