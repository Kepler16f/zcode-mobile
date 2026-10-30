// 侧栏「等待确认」标识的界面回归（真实产物 + 真实 mock 网关 + 真实审批弹窗）。
// 判据：审批挂起时侧栏出现「等待确认」；用户点「允许这一次」之后，这个标识必须消失。
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startChatdev } from "./chatdev.mjs";

const require = createRequire(new URL("../../zcode/apps/zcode-cli/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const port = 8994;
const host = await startChatdev(port);
const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
const page = await browser.newPage({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  → ${detail}`}`); };
try {
  await page.goto(`http://127.0.0.1:${port}/?devCredentials=1`, { timeout: 60000 });
  for (let i = 0; i < 80; i++) {
    if (await page.locator(`[data-testid="v4-composer-send"]`).isVisible().catch(() => false)) break;
    for (const label of ["跳过", "使用 API key"]) {
      const b = page.getByText(label, { exact: false }).first();
      if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
    }
    await page.waitForTimeout(250);
  }
  // 供应商配置：走真机同一串步骤，但落点换成会发工具调用的 mock 档。
  const probe = readFileSync(new URL("./mode-probe.mjs", import.meta.url), "utf8");
  // 换成会发工具调用（Write）的 mock 档：只有它会触发审批弹窗。
  const configure = probe.slice(probe.indexOf("// 先按真机路径"), probe.indexOf("// 打开模式菜单")).replace("/mock/stream/v1", "/mock/tool/v1");
  await new (Object.getPrototypeOf(async () => {}).constructor)("page", "port", "check", configure)(page, port, (name, ok) => { assert.ok(ok, name); console.log("PASS", name); });
  await page.locator(`[data-testid="v4-composer-input"]`).fill("触发一次需要确认的写入");
  await page.locator(`[data-testid="v4-composer-send"]`).click();
  const allowButton = page.getByText("允许这一次", { exact: false }).first();
  await allowButton.waitFor({ state: "visible", timeout: 30000 });
  console.log("PASS 审批弹窗出现");
  await page.waitForTimeout(800);
  // 侧栏在竖屏是抽屉：打开它才能看到任务行上的标识，看完要收起（否则遮罩会挡住弹窗按钮）。
  const readSidebar = async () => {
    await page.locator(`[data-testid="web-sidebar-toggle"]`).click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(700);
    const text = await page.locator("body").innerText();
    await page.mouse.click(360, 640);
    await page.waitForTimeout(500);
    return text;
  };
  const sidebarText = await readSidebar();
  check("审批挂起时侧栏出现「等待确认」", sidebarText.includes("等待确认"), sidebarText.slice(0, 200));
  await allowButton.click();
  await page.waitForTimeout(2500);
  const afterText = await readSidebar();
  check("确认后侧栏的「等待确认」消失", !afterText.includes("等待确认"), afterText.slice(0, 300));
  check("无页面脚本错误", errors.length === 0, errors.slice(0, 2).join(" | "));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n待确认标识界面回归：${results.length - failed.length}/${results.length} PASS`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await browser.close();
  await host.close();
}
