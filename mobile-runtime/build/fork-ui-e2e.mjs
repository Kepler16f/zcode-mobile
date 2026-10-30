// 会话分叉的界面回归（真实产物 + 真实 mock 网关）。
// 判据：助手回复完成后出现分叉按钮（说明 row.actions.canFork 投影通到 UI），
// 点击后切到子会话并渲染出分叉来源标记（与桌面同一交互）。
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startChatdev } from "./chatdev.mjs";

const require = createRequire(new URL("../../zcode/apps/zcode-cli/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const port = 8997;
const host = await startChatdev(port);
const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
const page = await browser.newPage({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
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
  // 按真机路径配自定义供应商并选模型（与 mode-probe / mobile-090-e2e 同一串步骤）。
  const probe = readFileSync(new URL("./mode-probe.mjs", import.meta.url), "utf8");
  const configure = probe.slice(probe.indexOf("// 先按真机路径"), probe.indexOf("// 打开模式菜单"));
  await new (Object.getPrototypeOf(async () => {}).constructor)("page", "port", "check", configure)(page, port, (name, ok) => {
    assert.ok(ok, name);
    console.log("PASS", name);
  });
  await page.locator(`[data-testid="v4-composer-input"]`).fill("分叉验证");
  await page.locator(`[data-testid="v4-composer-send"]`).click();
  const forkButton = page.locator(`[data-testid^="v4-fork-"]`).first();
  await forkButton.waitFor({ state: "visible", timeout: 30000 });
  console.log("PASS 助手回复后出现分叉按钮", await forkButton.getAttribute("data-testid"));
  const before = await page.evaluate(() => globalThis.__zcodeMobileMeta.taskRows().then((rows) => rows.length));
  await forkButton.click();
  await page.getByText("从对话中派生", { exact: false }).first().waitFor({ state: "visible", timeout: 20000 });
  console.log("PASS 分叉后渲染出派生来源标记");
  const after = await page.evaluate(() => globalThis.__zcodeMobileMeta.taskRows().then((rows) => rows.length));
  assert.ok(after >= before, `子会话未进入任务索引：${before} -> ${after}`);
  console.log("PASS 分叉子会话进入会话索引", before, "->", after);
  assert.deepEqual(errors, []);
  console.log("PASS 无页面脚本错误");
} finally {
  await browser.close();
  await host.close();
}
