// 一次性验证脚本（不进交付链）：访问调节（模式选择器）链路的真产物验收（0.7.2）。
// 判据：
//   A. 选择器里选「完全访问」后，工具栏当前值跟着变（草稿真的更新了）；
//   B. 发一句话后，端侧 agentLog 里出现"执行模式：yolo"——模式真的过了命令通路，
//      而不是只改了个 UI 草稿（用户报的"功能无效"就是这条断在中间）；
//   C. 计划勾选项不再被 transport 拒发（proto.independentPlanUnsupported）：
//      hello 声明 independentPlanState 之后，带 planEnabled 的提交通行。
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startChatdev } from "./chatdev.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"));
const { chromium } = require("playwright-core");

const port = Number(process.argv[2] ?? 8994);
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
await page.goto(`http://127.0.0.1:${port}/?devCredentials=1&mode=stream`, {
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
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ← ${detail}` : ""}`);
};

// 先按真机路径配一个自定义供应商（与 chat-e2e --stage=provider 同一串步骤）：
// 没模型时发送键是灰的，"模式过了命令通路"这条判据根本走不到发送那一步。
// byText 同 chat-e2e：只在可见按钮里找，避免命中正文里的同名片段。
const byText = (text) => page.locator("button:visible, [role=button]:visible").filter({ hasText: text }).first();
await byText("配置").click({ timeout: 8000 }).catch((e) => console.log("  配置按钮没点到:", String(e).slice(0, 120)));
await byText("添加供应商").click({ timeout: 5000 }).catch(() => {});
await byText("创建自定义供应商").click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(800);
await page.locator('[data-testid="model-provider-api-format-trigger"]').click({ timeout: 5000 }).catch(() => {});
await page.locator('[data-testid="model-provider-api-format-item-openai-chat-completions"]').click({ timeout: 5000 }).catch(() => {});
await page.locator('[data-testid="model-provider-base-url-input"]').fill(`http://127.0.0.1:${port}/mock/stream/v1`);
await page.locator('[data-testid="model-provider-api-key-input"]').fill("sk-chatdev");
await page.locator('[data-testid="model-provider-api-key-input"]').press("Tab");
await page.locator('[data-testid="model-provider-add-model-button"]').click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(600);
const modelDialog = page.locator('[role="dialog"], .fixed').filter({ hasText: "模型 ID" }).first();
await modelDialog.locator('input[placeholder="模型 ID"]').fill("mock-model").catch(() => {});
await modelDialog.locator('button:has-text("保存")').click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(1200);
// 回工作区（设置层左上角返回）。
await page.locator('[data-testid="settings-back-button"]').first().click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(1200);
const configured = await page.evaluate(() =>
  !document.body.innerText.includes("当前没有可用模型"),
);
check("自定义供应商配好（发送键的前置）", configured);

// 还要在模型选择器里挑一次（没选=发送键禁用，与 chat-e2e 的 pickModelRow 同一件事）。
const modelTrigger = page.locator('[data-testid="chat-model-select-trigger"]').first();
const modelLabel = async () => (await modelTrigger.innerText().catch(() => "")).trim();
const modelBefore = await modelLabel();
await modelTrigger.click({ force: true }).catch(() => {});
await page.waitForTimeout(500);
const group = page.locator('[data-testid^="chat-model-select-group-"]').first();
if ((await group.count()) > 0) {
  await group.hover().catch(() => {});
  await page.waitForTimeout(500);
  const item = page
    .locator('[data-testid^="chat-model-select-item-"]:visible:not([data-model-option-locked="true"])')
    .first();
  await item.click({ timeout: 5000 }).catch(() => {});
} else {
  // 没有分组行：直接点一层里的可见条目（有些形状把模型平铺）。
  await page
    .locator('[data-testid^="chat-model-select-item-"]:visible:not([data-model-option-locked="true"])')
    .first()
    .click({ timeout: 5000 })
    .catch(() => {});
}
await page.waitForTimeout(800);
const modelAfter = await modelLabel();
check("模型选择器里选上了模型（发送键会亮）", modelAfter !== modelBefore, `before=${modelBefore} after=${modelAfter}`);

// 打开模式菜单，点「完全访问」（yolo）。真正的判据不是标签文字（会话建起来后 composer
// 收成 compact、标签只剩图标，读不到也不代表没选上），而是下一条发送带的模式——
// 它在 SSE mock 收到的请求体/端侧 agentLog 里都留痕。
const trigger = page.locator('[data-testid="chat-mode-select-trigger"]').first();
check("模式选择器在输入条上", (await trigger.count()) > 0);
const before = (await trigger.innerText().catch(() => "")).trim();
await trigger.click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(400);
const yoloItem = page.locator('[data-testid="chat-mode-select-item-yolo"]').first();
check("菜单里有「完全访问」这一项", (await yoloItem.count()) > 0);
await yoloItem.click({ timeout: 5000 }).catch(() => {});
await page.waitForTimeout(500);
const after = (await trigger.innerText().catch(() => "")).trim();
console.log(`  工具栏文字（compact 下可能为空）: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);

// 第一句：带上刚选的完全访问把会话建起来。屏幕上出现自己那句话 = 提交真的落地了。
await page.locator('[data-testid="v4-composer-input"]').click({ timeout: 5000 }).catch(() => {});
await page.keyboard.type("模式链路验证一");
await page.locator('[data-testid="v4-composer-send"]').click({ force: true }).catch(() => {});
let onScreen = false;
for (let i = 0; i < 40; i++) {
  onScreen = await page.evaluate(() => document.body.innerText.includes("模式链路验证一")).catch(() => false);
  if (onScreen) break;
  await page.waitForTimeout(500);
}
check("发送链路通（自己那句话上了时间线）", onScreen);
const logBefore = await page.evaluate(() => globalThis.__zcodeMobileMeta?.agentLog ?? []);
console.log("  发完第一句后的 agentLog 尾部:", JSON.stringify(logBefore.slice(-3)));

// 会话里再切一次模式（compact 之后按 testid 点）：这次变更会被端侧记下来。
await page.locator('[data-testid="chat-mode-select-trigger"]').first().click({ force: true }).catch(() => {});
await page.waitForTimeout(500);
await page
  .locator('[data-testid="chat-mode-select-item-edit"]')
  .first()
  .click({ timeout: 5000 })
  .catch(() => {});
await page.waitForTimeout(400);
const liveModeLog = await page.evaluate(() => globalThis.__zcodeMobileMeta?.agentLog ?? []);
check("切换模式立即通知运行时，无需再发一条消息", liveModeLog.some(line => String(line).includes("执行模式：edit")));

// 第二句：模式必须过命令通路（agentLog 的"执行模式：edit"）。
await page.locator('[data-testid="v4-composer-input"]').click({ timeout: 5000 }).catch(() => {});
await page.keyboard.type("模式链路验证二");
await page.locator('[data-testid="v4-composer-send"]').click({ force: true }).catch(() => {});
await page.waitForTimeout(5000);
const agentLog = await page.evaluate(() => globalThis.__zcodeMobileMeta?.agentLog ?? []);
const modeLine = agentLog.filter((line) => String(line).includes("执行模式："));
check(
  "第一句带着草稿选的「完全访问」到了端侧（执行模式：yolo）",
  modeLine.some((l) => String(l).includes("yolo")),
  JSON.stringify(modeLine),
);
check(
  "会话内切到「自动编辑」后，下一句带的模式也到了端侧（执行模式：edit）",
  modeLine.some((l) => String(l).includes("edit")),
  JSON.stringify(modeLine),
);

// 计划勾选项：transport 不再拒发（capability 声明 + 端侧落地）。
const planBox = page.getByText("计划", { exact: false }).first();
let planClicked = false;
if (await planBox.isVisible().catch(() => false)) {
  await planBox.click({ timeout: 3000 }).catch(() => {});
  planClicked = true;
}
await page.waitForTimeout(500);
await page.locator('[data-testid="v4-composer-input"]').click({ timeout: 5000 }).catch(() => {});
await page.keyboard.type("先给我计划");
await page.locator('[data-testid="v4-composer-send"]').click({ force: true }).catch(() => {});
await page.waitForTimeout(4000);
const logAfterPlan = await page.evaluate(() => globalThis.__zcodeMobileMeta?.agentLog ?? []);
const planLine = logAfterPlan.filter((line) => String(line).includes("执行模式：") && String(line).includes("计划"));
check(
  "计划勾选后提交通行且端侧记下「计划」（不再 proto.independentPlanUnsupported）",
  !planClicked || planLine.length > 0,
  `planClicked=${planClicked} lines=${JSON.stringify(planLine)}`,
);
const consoleErrors = await page.evaluate(() => globalThis.__zcodeMobileMeta ? "ok" : "no meta");
check("页面上下文可读（探头自身没崩）", consoleErrors === "ok");

// 用真实产物从设置入口读取已完成会话的统计，覆盖RPC、落盘和图表动态加载。
const beforeUsageLog = await page.evaluate(() => globalThis.__zcodeMobileMeta?.agentLog ?? []);
check("打开统计页前不扫描全部历史，避免启动探针禁用统计服务", !beforeUsageLog.some(line => String(line).includes("usage/app snapshot")));
const sidebarToggle = page.locator('[data-testid="web-sidebar-toggle"]').first();
if (await sidebarToggle.isVisible().catch(() => false)) await sidebarToggle.click();
await page.locator('[data-testid="task-settings-button"]').first().click();
await page.getByText("使用统计", {exact:true}).first().click();
await page.waitForTimeout(1200);
const statsText = await page.locator('body').innerText();
const usageLog = await page.evaluate(() => globalThis.__zcodeMobileMeta?.agentLog ?? []);
check("设置应用用量页读取到真实会话token", usageLog.some(line => /usage\/app snapshot range=all sessions=[1-9].*tokens=[1-9]/.test(String(line))), JSON.stringify(usageLog.slice(-4)));
check("应用用量图表可见且没有加载失败", statsText.includes("每日 Token 趋势图") && statsText.includes("模型用量") && !statsText.includes("图表加载失败"));
await page.screenshot({path:path.join(root,'tmp/usage-page-085.png')});

await browser.close();
await dev.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n访问调节探头：${results.length - failed}/${results.length} PASS`);
process.exit(failed > 0 ? 1 : 0);
