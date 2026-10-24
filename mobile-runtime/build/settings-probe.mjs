// 一次性取证脚本（不进交付链）：窄屏 + 抽屉开 → 进设置，抓"画面发暗"的现场。
// 判据：
//   A. 抽屉开着点设置后，#zcode-narrow-scrim 的 computed display/opacity 是不是还亮着
//      （0.45 黑遮罩 z-25 压在设置层 z-10 上 = 用户看到的"特别暗"）
//   B. 设置层是否真的在 DOM 里（排掉"其实是设置页没渲染"）
//   C. 浏览器控制 / 钩子两屏的实际文案（截图 + 文本），确认"未接入"提示的来源
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { startChatdev } from "./chatdev.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"));
const { chromium } = require("playwright-core");

const port = Number(process.argv[2] ?? 8996);
const dev = await startChatdev(port);
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
const shots = path.join(here, "probe-shots");
fs.mkdirSync(shots, { recursive: true });
page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 300)));

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

// 打开抽屉（点 ☰，比合成手势稳）。
const toggle = page.locator('[data-testid="web-sidebar-toggle"]').first();
if (await toggle.isVisible().catch(() => false)) await toggle.click();
await page.waitForTimeout(600);
const scrimAfterOpen = await page.evaluate(() => {
  const el = document.getElementById("zcode-narrow-scrim");
  if (!el) return null;
  const cs = getComputedStyle(el);
  return { display: cs.display, opacity: cs.opacity, pointerEvents: cs.pointerEvents, z: cs.zIndex };
});
console.log("抽屉开 · scrim:", JSON.stringify(scrimAfterOpen));

// 找到侧栏里的「设置」入口并点它（testid 取自 shared/test-ids.ts 的 task-settings-button）。
const settingsEntry = page.locator('[data-testid="task-settings-button"]').first();
if (await settingsEntry.count()) {
  await settingsEntry.scrollIntoViewIfNeeded().catch(() => {});
  await settingsEntry.click({ timeout: 5000 }).catch(async (e) => {
    console.log("  设置按钮点击失败:", String(e).slice(0, 160));
  });
} else {
  console.log("  没有 task-settings-button（侧栏 footer 没渲染）");
  console.log(await page.locator("#sidebar").innerText().catch(() => "(无侧栏)"));
}
await page.waitForTimeout(900);
await page.screenshot({ path: path.join(shots, "settings-after-open.png") });

const after = await page.evaluate(() => {
  const el = document.getElementById("zcode-narrow-scrim");
  const settingsLayer = document.querySelector('[data-root-workspace-surface="inert"]');
  const cs = el ? getComputedStyle(el) : null;
  return {
    scrim: el ? { display: cs.display, opacity: cs.opacity, pointerEvents: cs.pointerEvents, z: cs.zIndex } : null,
    settingsOpen: Boolean(settingsLayer),
    headerText: (() => {
      const h = document.querySelector("main") ?? document.body;
      return (h.innerText || "").split("\n").slice(0, 12).join(" | ");
    })(),
  };
});
console.log("进设置后 · scrim:", JSON.stringify(after.scrim), "· 设置层在:", after.settingsOpen);
console.log("屏幕前 12 行:", after.headerText);

// 点一下屏幕中央（模拟用户"点一下恢复"）：看是不是遮罩代点了收起。
await page.mouse.click(196, 500).catch(() => {});
await page.waitForTimeout(700);
const afterTap = await page.evaluate(() => {
  const el = document.getElementById("zcode-narrow-scrim");
  const cs = el ? getComputedStyle(el) : null;
  return el ? { display: cs.display, opacity: cs.opacity } : null;
});
console.log("点一下之后 · scrim:", JSON.stringify(afterTap));
await page.screenshot({ path: path.join(shots, "settings-after-tap.png") });

// 浏览器控制屏（settingsPageConfig.ts: id=browser）。
const browserNav = page.locator('[data-testid="settings-section-nav-browser"]').first();
if (await browserNav.count()) {
  await browserNav.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(shots, "settings-browser.png") });
  const bodyText = await page.locator("main").innerText().catch(() => "");
  const lines = bodyText.split("\n").filter((l) => l.includes("未接入") || l.includes("运行时") || l.includes("EUNSUPPORTED") || l.includes("桌面端"));
  console.log("浏览器控制屏 · 命中行:", JSON.stringify(lines.slice(0, 6)));
  console.log("浏览器控制屏 · 前 200 字:", bodyText.replace(/\n/g, " | ").slice(0, 200));
} else {
  console.log("  设置左栏没找到 browser 入口");
}

// 钩子屏（id=hooks）+ 建一条钩子的完整往返（0.7.1："钩子未接入"的验收）。
const hooksNav = page.locator('[data-testid="settings-section-nav-hooks"]').first();
if (await hooksNav.count()) {
  await hooksNav.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(shots, "settings-hooks.png") });
  const section = page.locator('[data-testid="hooks-settings-section"]');
  const sectionText = (await section.innerText().catch(() => "")) || "";
  console.log("钩子屏 · EUNSUPPORTED 行:", JSON.stringify(sectionText.split("\n").filter((l) => l.includes("EUNSUPPORTED") || l.includes("未接入"))));

  // 新建一条钩子：命令必须真的能存进去（hooksService → 端侧 fs → 再读回来）。
  const createBtn = page.getByRole("button", { name: /新建钩子|新建/ }).first();
  if (await createBtn.count()) {
    await createBtn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);
    const form = page.locator('[data-testid="hooks-form"]');
    if (await form.count()) {
      await page.locator("#command").fill("echo 'probe hook'");
      await page.getByRole("button", { name: "保存" }).first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1200);
      await page.screenshot({ path: path.join(shots, "settings-hooks-created.png") });
      const after = (await section.innerText().catch(() => "")) || "";
      const countLine = after.split("\n").find((l) => l.includes("钩子")) ?? "";
      console.log("保存后 · 列表读数:", countLine.replace(/\n/g, " "));
      console.log("保存后 · 有错误行:", JSON.stringify(after.split("\n").filter((l) => l.includes("失败") || l.includes("EUNSUPPORTED") || l.includes("无法"))));
    } else {
      console.log("  没打开新建表单（hooks-form 不存在）");
    }
  } else {
    console.log("  没找到新建钩子按钮");
  }
} else {
  console.log("  设置左栏没找到 hooks 入口");
}

await browser.close();
await dev.close();
console.log("截图目录:", shots);
