// 一次性验证（0.4.8）：平板形态（800px 宽视口，模拟装机 OPD2511 的 ~808px CSS 视口）
// + 触屏 —— 0.4.2-0.4.7 五版"顶栏调大下移没效果"的真根因就是这个宽度下窄屏旗子永不挂。
// 验证三件事：① pointer:coarse 缺省下旗子挂上；② 开关 pin "0"/"1" 恒定生效；
// ③ 事件广播翻旗子。桌面 393px 路径由 swipe-verify 覆盖。
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startChatdev } from "./chatdev.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"));
const { chromium } = require("playwright-core");

const port = Number(process.argv[2] ?? 8997);
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
const bootToMain = async () => {
  await page.goto(`http://127.0.0.1:${port}/?devCredentials=1&mode=stream&override=1`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  for (let i = 0; i < 60; i++) {
    if (await page.locator('[data-testid="v4-composer-send"]').isVisible().catch(() => false)) return true;
    for (const label of ["跳过", "使用 API key"]) {
      const b = page.getByText(label, { exact: false }).first();
      if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); break; }
    }
    await page.waitForTimeout(300);
  }
  return false;
};
if (!(await bootToMain())) {
  throw new Error("没走到主界面");
}

let pass = 0, fail = 0;
const check = (name, cond, evidence = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${name}${evidence ? ` ← ${evidence}` : ""}`);
  cond ? pass++ : fail++;
};

const state = () =>
  page.evaluate(() => ({
    narrow: document.documentElement.classList.contains("zcode-narrow"),
    coarse: matchMedia("(pointer: coarse)").matches,
    vw: innerWidth,
    toggle: Boolean(document.querySelector('[data-testid="web-sidebar-toggle"]')),
  }));

console.log("── 平板形态（800px + 触屏）：0.4.8 开关语义 ──");
const s0 = await state();
check("pointer:coarse 缺省 → 旗子挂上（0.4.7 前这里恒 false）", s0.narrow === true, JSON.stringify(s0));

// pin "0"（bootToMain 会重新导航，冷启动读存储）
await page.evaluate(() => localStorage.setItem("zcode-mobile.touchOptimized", "0"));
if (!(await bootToMain())) {
  throw new Error("pin0 重载后没走到主界面");
}
const s1 = await state();
check("pin \"0\" → 旗子摘掉（手动关闭恒定）", s1.narrow === false, JSON.stringify(s1));

// 事件广播（设置页开关走的同一条道）
await page.evaluate(() => {
  localStorage.setItem("zcode-mobile.touchOptimized", "1");
  window.dispatchEvent(new CustomEvent("zcode-mobile:touch-opt-changed"));
});
const s2 = await state();
check("pin \"1\" + 事件 → 旗子挂回（开了就是开了）", s2.narrow === true, JSON.stringify(s2));

// 旋转不变：改视口宽度（模拟转屏），旗子保持
await page.setViewportSize({ width: 1100, height: 800 });
await page.waitForTimeout(400);
const s3 = await state();
check("视口改宽（模拟转横屏）→ 旗子不变（恒定语义）", s3.narrow === true, JSON.stringify(s3));

// pin "1" 后冷重载：React 侧形态（useAppPanels 开局收起 + 上游切换按钮存在）也要跟上——
// 只翻旗子不翻 React 形态，抽屉就是"投影跟着开关走、布局不跟"的半拉子。
// reload 后首装闸门会重挂（override=1 不跳首装），照旧用 bootToMain 走回主界面。
if (!(await bootToMain())) {
  throw new Error("重载后没走到主界面");
}
const s4 = await page.evaluate(() => {
  const shell = document.querySelector("[data-workspace-shell]");
  return {
    narrow: document.documentElement.classList.contains("zcode-narrow"),
    toggle: Boolean(document.querySelector('[data-testid="web-sidebar-toggle"]')),
    reactVisible: shell
      ? (parseFloat(getComputedStyle(shell).getPropertyValue("--workspace-sidebar-panel-width")) || 0) > 1
      : null,
  };
});
check("pin \"1\" 冷重载 → 旗子+React 移动形态（开局收起、按钮存在）",
  s4.narrow === true && s4.toggle === true && s4.reactVisible === false, JSON.stringify(s4));

await browser.close();
await dev.close();
console.log(`\n合计：${pass} PASS / ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
