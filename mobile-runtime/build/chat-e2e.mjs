// 端侧对话的浏览器端到端（本机跑，不进安装包）。见 PORTING §1.5.18。
//
// 为什么用 Edge + playwright-core，而不用手边的开发页：手机上跑的就是 Chromium 系内核，
// 端到端要判的是"真 UI 能不能把端侧 agent 的帧画成一段流式回答"。开发工具里那个标签页
// 一旦切到后台，Chromium 会把它当隐藏页降速（实测同一批 chunk 从 6 ms 变成 4.8 s），
// 于是"超时"到底是链路坏了还是页面被节流，根本分不开。这里自己起一个 headless 实例，
// 页面永远是活动状态，超时才有意义。
//
// 三种模式：
//   --stage=recon   走到主界面后把可见控件清单打出来（表单结构变了先看见，别靠猜）
//   --stage=provider 配置一个自定义供应商（Base URL 指向本机 mock）→ 发消息 → 截图
//   --stage=send     跳过配置，直接用 ?override=1 的注入落点发消息
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startChatdev } from "./chatdev.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"));
const { chromium } = require("playwright-core");

const stage = (process.argv.find((a) => a.startsWith("--stage=")) ?? "--stage=recon").slice(8);
const port = Number(process.argv.find((a) => /^\d{4,5}$/.test(a)) ?? 8977);
const mode = process.argv.find((a) => a.startsWith("--mode="))?.slice(7) ?? "stream";
// --reload：配好供应商之后重开一次页面。判的是"配置能不能落盘"，
// 而本机宿主能不能落盘和手机上能不能落盘是两件事，所以这条默认关掉，只在查持久化时打开。
const WITH_RELOAD = process.argv.includes("--reload");
// --exec：给页面装假 zcodeExec 桥（chatdev PRELUDE 里按 ?exec=1 注入）。Bash 审批判据专用：
// 桥在 → 引擎注册 Bash → mock 第一步发 Bash 调用 → 弹窗出现。没这个旗子的 tool 模式走
// 老 Write→Read 路径，两条判据各验各的。
const WITH_EXEC = process.argv.includes("--exec");
const shots = path.join(here, "e2e-shots");
mkdirSync(shots, { recursive: true });
// 表单里填的是网关根（用户在真机上填 `https://api.openai.com/v1` 这一串），
// 结尾不要带斜杠；`chat/completions` 由 model-stream.ts:107 按协议种类接上去。
// 上一版这条 URL 被拼成了 origin 根的 `/chat/completions`，说明配置里存下来的
// baseUrl 和填进去的不是同一个东西——所以现在把"浏览器实际请求了哪个 URL"记下来（见 mockReqs），
// 判据落在证据上，不靠猜表单。
const MOCK_BASE = `http://127.0.0.1:${port}/mock/${mode}/v1`;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  → ${detail}`}\n`);
};

// 宿主和浏览器放在同一个进程里（chatdev 导出的工厂），端口被占用就当"已经有人起了宿主"复用。
let host = null;
try {
  host = await startChatdev(port);
} catch (e) {
  if (e?.code !== "EADDRINUSE") throw e;
}
const browser = await chromium.launch({
  executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  args: ["--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"],
});
const context = await browser.newContext({
  viewport: { width: 393, height: 851 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (Linux; Android 13; PHU610) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36",
});
const page = await context.newPage();
const consoleErrors = [];
const consoleLines = [];
page.on("console", (m) => {
  consoleLines.push(`${m.type()}: ${m.text().slice(0, 300)}`);
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
});
page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 300)));
// 404 单独收一条：控制台里那句 "Failed to load resource" 不带 URL，而"哪个资源取不到"
// 正是要判的东西（`?url` 资源的落盘位置如果和 bundle 里的引用对不上，手机上同样会缺）。
const http4xx = [];
// 网关自己回的非 2xx 状态码。控制台里那句 "Failed to load resource: … status of 500" 不带 URL，
// 只能靠这个集合认出"这条就是被测网关故意回的那一次"，而不是又一个 bundle 里缺的资源。
const mockStatuses = new Set();
page.on("response", (r) => {
  // /mock/ 那条是**被测对象本身**：businessError、http500 两种模式就是故意回非 2xx 的。
  // 这里判的是"bundle 里引用的静态资源能不能取到"，把网关算进去就变成永远红的一条噪声。
  if (r.status() < 400) return;
  if (r.url().includes("/mock/")) mockStatuses.add(r.status());
  else http4xx.push(`${r.status()} ${r.url().split("/").pop()}`);
});
// 已经登记在案、且**不影响对话链路**的一个缺口：diff 高亮 worker。
// 上游那行 `new Worker(new URL("../workers/diffs.worker.ts", import.meta.url))`
// （packages/ui/src/root/DiffsWorkerPoolProvider.tsx:13）在 Vite 下会被编译成真实的 worker 资源，
// 而我们的 esbuild 配置只处理了 `?url` 后缀、没有处理 `new URL(..., import.meta.url)` 这种写法，
// 于是产物里没有这个文件：装到手机上同样会缺。它红的是"看 diff"，不是"发消息"。
// 把它从判据里单独摘出来、而不是让整条"控制台干净"判据一直红，是为了让剩下的错误仍然拦得住。
const WORKER_GAP_URL = /diffs\.worker/;
function isWorkerGap(line) {
  return (
    WORKER_GAP_URL.test(line) ||
    /^Worker error: Event \{worker: Worker, request_id: req_\d+, initialized: false/.test(line)
  );
}
function partitionGaps(lines) {
  const known = [];
  const unexpected = [];
  for (const line of lines) {
    if (isWorkerGap(line)) known.push(line);
    else unexpected.push(line);
  }
  return { known, unexpected };
}
// 客户端到底往哪个 URL 发了这一轮，是判"路径拼错"还是"根本没发"的唯一凭据
// （报错只给一串 %20 编码的短语，看不出它请求的是不是 /mock/<mode>/v1/chat/completions）。
const mockReqs = [];
page.on("request", (r) => {
  if (r.url().includes("/mock/")) mockReqs.push(`${r.method()} ${r.url()}`);
});
page.on("requestfailed", (r) => {
  if (r.url().includes("/mock/")) {
    mockReqs.push(`FAILED ${r.method()} ${r.url()} ← ${String(r.failure()?.errorText)}`);
  }
});

const inventory = () =>
  page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
    };
    return {
      text: document.body.innerText.slice(0, 700),
      // 草稿横幅是"为什么发不出去"最直接的证据（缺模型/缺凭据都写在这一行），
      // 而它常常在 innerText 前 700 字之外——侧栏和空状态把它挤后面去了。
      composer: (() => {
        const el = document.querySelector('[data-testid="v4-composer"]');
        return el ? el.innerText.replace(/\s+/g, " ").slice(0, 300) : null;
      })(),
      buttons: [...document.querySelectorAll("button")].filter(vis).map((b) => b.textContent.trim() || b.getAttribute("data-testid") || "(空)"),
      testIds: [...document.querySelectorAll("[data-testid]")]
        .filter(vis)
        .map((e) => `${e.tagName.toLowerCase()}:${e.getAttribute("data-testid")}`),
      inputs: [...document.querySelectorAll("input,textarea")].filter(vis).map((i) => `${i.type}|${i.placeholder}`),
    };
  });

const readout = async () => {
  const inv = await inventory();
  return JSON.stringify({
    url: page.url(),
    meta: await page.evaluate(() => {
      const m = globalThis.__zcodeMobileMeta;
      return m
        ? {
            stubbed: m.stubbed,
            degraded: m.degraded.map((d) => d.name),
            fsEngine: m.fsEngine,
            agentLog: m.agentLog.slice(-5),
            // 界面把 .catch 掉的失败全吞了；这份账才是"到底缺哪个面"的证据。
            unsupported: m.unsupportedCalls ? m.unsupportedCalls().slice(0, 8) : null,
          }
        : null;
    }),
    ...inv,
    http4xx: http4xx.slice(-8),
    consoleErrors: consoleErrors.slice(-6),
  });
};

/** 超时不是"等不到就算了"，而是把屏幕上此刻有什么一起打出来。 */
async function expect(label, action, budgetMs = 20000) {
  const startedAt = Date.now();
  for (;;) {
    try {
      const done = await action();
      if (done) return;
    } catch {
      // 选择器还没出现就是"还没到那一步"，交给下面的超时读数
    }
    if (Date.now() - startedAt > budgetMs) {
      check(label, false, await readout());
      throw new Error(`stage 中断：${label}`);
    }
    await page.waitForTimeout(200);
  }
}

const byText = (text) => page.locator(`button:visible, [role=button]:visible`).filter({ hasText: text }).first();

/**
 * 抓一句 toast 上的原文。为什么要自己轮询而不是等 expect：
 * 那条判定是 8 秒自动消失的（ProviderFormControls.tsx 的 durationMs: 8_000），
 * 等到"屏幕出现过这句话"再回读，读到的可能已经是消失后的空屏了。
 * 这里命中即取整行文本，判据落在屏幕上真写过的那串字上。
 */
async function waitForToastLine(pattern, budgetMs = 10000) {
  const startedAt = Date.now();
  for (;;) {
    const hit = await page.evaluate((source) => {
      // 抓整行，不抓命中的那几个字：判据要落在"屏幕上写的原因"上，
      // 只回一个"连接失败"等于把 reason 丢了，而这正是这次要看的字段。
      const m = document.body.innerText.match(new RegExp(`[^\\n]*(?:${source})[^\\n]*`));
      return m ? m[0].replace(/\s+/g, " ").trim() : null;
    }, pattern.source);
    if (hit) return hit;
    if (Date.now() - startedAt > budgetMs) return null;
    await page.waitForTimeout(120);
  }
}

/** 弹层此刻的真实形状：谁在 DOM 里、可不可见、带哪些 Radix 状态位。 */
const dumpModelMenu = () =>
  page.evaluate(() =>
    JSON.stringify(
      [...document.querySelectorAll('[data-testid^="chat-model-select"]')].map((e) => {
        const r = e.getBoundingClientRect();
        return {
          id: e.getAttribute("data-testid"),
          role: e.getAttribute("role"),
          text: (e.textContent ?? "").trim().slice(0, 24),
          box: `${Math.round(r.width)}x${Math.round(r.height)}`,
          state: e.getAttribute("data-state"),
          checked: e.getAttribute("aria-checked") ?? e.getAttribute("data-checked"),
          locked: e.getAttribute("data-model-option-locked"),
          disabled: e.getAttribute("aria-disabled") ?? String(e.closest("[aria-disabled=true]") !== null),
          inMenu: e.closest('[role="menu"], [role="group"]') !== null,
        };
      }),
    ),
  );

/**
 * 打开供应商分组（Radix SubTrigger）并选中里面第一个没被锁住的模型行。
 * 关键的一条：Radix 的子菜单是在 **pointermove** 上展开的（@radix-ui/react-menu 的
 * Sub 用 pointermove/pointerleave 做 hover 展开，click 只负责选中）。
 * 而 Playwright 的 hover({force:true}) 为了绕过 actionability 检查，会把整段移动合成掉，
 * 只补一个 pointermove 到目标点之外的事件——于是上一版"点了、也 focus 了、按了方向键"，
 * SubContent 一直是 hidden，点它等于没点，发送键照样禁用。这里用不带 force 的 hover，
 * 让浏览器真的一次鼠标移动。
 * 选中与否不看 item 存不存在（收起时它也在 DOM 里、带 hidden），只看 trigger 的文案换没换。
 */
async function pickModelRow(group) {
  const trigger = page.locator('[data-testid="chat-model-select-trigger"]');
  const label = async () => (await trigger.innerText()).trim();
  const before = await label();
  const items = () =>
    page.locator('[data-testid^="chat-model-select-item-"]:visible:not([data-model-option-locked="true"])');
  const attempts = [
    async () => {
      await group.hover();
      await page.waitForTimeout(400);
      process.stdout.write(`  展开后的行：${await dumpModelMenu()}\n`);
      await items().first().click({ timeout: 5000 });
    },
    async () => {
      await group.hover();
      await page.waitForTimeout(400);
      await items().first().press("Enter");
    },
    async () => {
      await group.focus();
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(400);
      await items().first().press("Enter");
    },
  ];
  for (const attempt of attempts) {
    // 每一发都从"弹层是开着的"起步：上一次失败可能已经把它收掉了。
    if ((await trigger.getAttribute("aria-expanded").catch(() => null)) !== "true") {
      await trigger.click({ force: true }).catch(() => {});
      await page.waitForTimeout(400);
    }
    await attempt().catch((e) => process.stdout.write(`  开法失败：${String(e.message ?? e).slice(0, 160)}\n`));
    for (let i = 0; i < 10; i++) {
      const now = await label().catch(() => "");
      if (now !== before) return `trigger 现在是「${now}」`;
      await page.waitForTimeout(150);
    }
    process.stdout.write(`  没换成模型：弹层=${await dumpModelMenu()}\n`);
    // 选了却不生效，多半是写回被拒（端侧某个面没接上）。上游这些失败一律走 logger，
    // 所以把带 model/select 的日志原样吐出来，别在这里猜。
    const noisy = consoleLines.slice(-12);
    if (noisy.length) process.stdout.write(`  相关日志：${JSON.stringify(noisy)}\n`);
    process.stdout.write(
      `  被调用的未实现面：${JSON.stringify(
        await page.evaluate(() => globalThis.__zcodeMobileMeta?.unsupportedCalls?.() ?? null),
      )}\n`,
    );
  }
  return null;
}


try {
  const url = `http://127.0.0.1:${port}/?devCredentials=1&mode=${mode}${stage === "send" ? "&override=1" : ""}${WITH_EXEC ? "&exec=1" : ""}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await expect("首屏组合根起来了（__zcodeMobileMeta 可读）", () =>
    page.evaluate(() => Boolean(globalThis.__zcodeMobileMeta)),
  45000);
  check(
    "端侧注册了对话面（zcodeAgentService 不在未接入名单里）",
    !(await page.evaluate(() => globalThis.__zcodeMobileMeta.stubbed.includes("zcodeAgentService"))),
    await readout(),
  );

  // 首装路径：欢迎页 →（"使用 API key"那一步里有"暂时跳过"）→ 三步引导问卷 → 主界面。
  // 为什么绕开登录按钮：真机上账号是登录好的，这一腿要判的是对话链路；
  // 而点"连接 Z.ai"会把授权页开进浏览器，那是绝对不允许碰的一条路。
  //
  // 为什么是"轮询 + 每拍最多点一次"而不是照着界面顺序点一遍：欢迎页的提供方列表是 RPC 异步回来的，
  // 它回来时这一屏会重挂、`loginMode` 从 apiKey 退回 providers，手点的那一下会被抹掉
  // （第一轮就栽在这里：点完"使用 API key"等 400 ms，"暂时跳过"还没出现，屏幕已经回到提供方列表）。
  // 闸门类界面只能按"当前屏幕上有什么"决定下一步，不能按"我以为走到哪一步"。
  const passFirstRunGate = async () => {
    const clickedAway = [];
    // 每拍都按"屏幕上现在有什么"重新决策（理由见上面那段）。
    // 顺序不能改：跳过问卷的"跳过"永远优先于欢迎页的"暂时跳过"，
    // 而问卷一旦答完，那一屏再没有这些按钮，循环靠"看到发送按钮"收口。
    for (let i = 0; i < 60; i++) {
      if (await page.locator('[data-testid="v4-composer-send"]').isVisible().catch(() => false)) break;
      const targets = ["跳过", "使用 API key"];
      let hit = null;
      for (const label of targets) {
        const b = byText(label);
        if (await b.isVisible().catch(() => false)) {
          await b.click().catch(() => {});
          hit = label;
          break;
        }
      }
      if (hit && (!clickedAway.length || clickedAway.at(-1) !== hit)) clickedAway.push(hit);
      await page.waitForTimeout(300);
    }
    return clickedAway;
  };
  process.stdout.write(`越过首装闸门依次点了：${(await passFirstRunGate()).join(" → ") || "(没点到任何东西)"}\n`);
  await expect("走到主界面（输入框与发送按钮出现）", () =>
    page.locator('[data-testid="v4-composer-send"]').isVisible().catch(() => false),
  15000);

  if (stage === "recon") {
    process.stdout.write(`\n${JSON.stringify(await readout(), null, 2)}\n`);
  }

  if (stage === "provider") {
    // 自定义供应商 = 手机上"我有自己的 Key，没开通套餐"那条真路径。
    await byText("配置").first().click();
    await expect("进到了模型设置", () => page.getByText("管理自定义模型供应商").isVisible().catch(() => false));
    await byText("添加供应商").first().click();
    await byText("创建自定义供应商").first().click();
    await expect("自定义供应商表单出现", () =>
      page.locator('[data-testid="model-provider-base-url-input"]').isVisible().catch(() => false));
    await page.locator('[data-testid="model-provider-api-format-trigger"]').click();
    await page.locator('[data-testid="model-provider-api-format-item-openai-chat-completions"]').click();
    await page.locator('[data-testid="model-provider-base-url-input"]').fill(MOCK_BASE);
    await page.locator('[data-testid="model-provider-api-key-input"]').fill("sk-chatdev");
    // Key 是"离开输入框才写回"的（ApiKeyInput 走 blur），不 Tab 一下就等于没填。
    await page.locator('[data-testid="model-provider-api-key-input"]').press("Tab");
    await page.locator('[data-testid="model-provider-add-model-button"]').click();
    // "添加模型"弹的是一个小对话框（模型 ID / 上下文窗口 / 最大输出 Token），不是卡片里的行内输入。
    const dialog = page.locator('[role="dialog"], .fixed').filter({ hasText: "模型 ID" }).first();
    await dialog.locator('input[placeholder="模型 ID"]').fill("mock-model");
    await dialog.locator('button:has-text("保存")').click();
    await expect("模型加进了这张供应商卡片", () =>
      page.evaluate(() => document.body.innerText.includes("mock-model")),
    10000);
    // 供应商卡片没有"保存"按钮：草稿是改动即写回端侧配置的（ProviderDraftSave），
    // 所以这里判的是"配置真的落下去了"——回到工作区后那条"没有可用模型"要消失。
    await expect("模型设置认为这个供应商可执行", () =>
      page.evaluate(() => !document.body.innerText.includes("当前没有配置模型")),
    10000);
    await page.screenshot({ path: path.join(shots, "provider-form.png") });
    process.stdout.write(
      `保存后 Base URL 输入框里剩下：${JSON.stringify(
        await page.locator('[data-testid="model-provider-base-url-input"]').inputValue().catch(() => "(已离开表单)"),
      )}\n`,
    );
    // 模型连通性检查：卡片上那个 icon-only 的「测试模型」（ProviderFormControls.tsx:277-288）。
    // 这条腿同时判两件事：
    //   1) 端侧把上游 testConnectivity 缝接上之后，按钮点下去到底有没有回话（还是被
    //      SettingsPage 那道"要有本地工作区"的门提前拦掉——手机上没开工作区，这正是隐患）；
    //   2) 失败时屏幕写的是"打到哪个地址"，还是又一句没头没尾的 not found。
    const testBtn = page.locator('[title="测试模型"]');
    process.stdout.write(
      `「测试模型」按钮：${await testBtn
        .evaluate((b) =>
          JSON.stringify({
            disabled: b.disabled,
            ariaDisabled: b.getAttribute("aria-disabled"),
            box: `${Math.round(b.getBoundingClientRect().width)}x${Math.round(b.getBoundingClientRect().height)}`,
          }),
        )
        .catch(() => "(表单里找不到这个按钮)")}\n`,
    );
    await testBtn.click({ force: true });
    const verdict = await waitForToastLine(/连接成功|连接失败|本地工作区|不可用/);
    process.stdout.write(`连通性判定的屏幕原文：${JSON.stringify(verdict ?? "(8 秒内没有出现判定文案)")}\n`);
    process.stdout.write(
      `  端侧这一拍的日志=${JSON.stringify(await page.evaluate(() => globalThis.__zcodeMobileMeta?.agentLog ?? []))}\n`,
    );
    await page.screenshot({ path: path.join(shots, `connectivity-${mode}.png`) });
    if (mode === "stream" || mode === "tool") {
      // tool 模式的连通性测试也走正常补全（mock 只在多轮工具往返时才发 tool_calls），
      // 所以它和 stream 一样期望"连接成功"，不该被归进失败分支。
      check("点「测试模型」报回连接成功", (verdict ?? "").includes("连接成功"), verdict ?? await readout());
    } else {
      check("点「测试模型」如实报回失败", (verdict ?? "").includes("连接失败"), verdict ?? await readout());
      // 只有"网关在 HTTP 层面就不对"这一类失败才要求带上请求地址：
      // businessError 是 HTTP 200 里夹一条业务错误（额度不足），那种情况下地址不是原因，
      // 硬要它带地址等于把判据写成"屏幕上必须出现一串 URL"。
      if (mode === "notFound" || mode === "http500") {
        check(
          `失败原因里带着真实请求地址（/mock/${mode}/v1/chat/completions）`,
          (verdict ?? "").includes(`/mock/${mode}/v1/chat/completions`),
          verdict ?? "",
        );
      }
    }
    await page.locator('[data-testid="settings-back-button"]').click();
  }

  if (stage === "send" || stage === "provider") {
    // 配好供应商之后先按真机的用法走一遍：退出设置、重开一次，看这份配置会不会自己变成默认模型。
    // 手机上没人每次都去弹层里点模型；这一条既是产品路径，也把"弹层点不动"和"配置没落地"分开。
    // 重开一次看配置会不会自己变成默认模型（--reload 才跑：这一腿判的是持久化，
    // 而本机宿主目前落不到盘，先别把"没落盘"和"没选上"混在一条结论里）。
    if (stage === "provider" && WITH_RELOAD) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
      await expect("重开后组合根又起来了", () =>
        page.evaluate(() => Boolean(globalThis.__zcodeMobileMeta)),
      45000);
      // 重开之后又见到首装闸门，本身就是条结论：端侧没把"引导已完成"这条记录存下来
      // （onboardingRecordService 在端侧组合根里没注册，见 ui/services.ts 的 stubbed 边）。
      const again = await passFirstRunGate();
      if (again.length) {
        check("重开后不再要求过首装闸门（引导完成记录有落地）", false, `又点了一遍：${again.join(" → ")}`);
      }
      await expect("重开后走到主界面", () =>
        page.locator('[data-testid="v4-composer-send"]').isVisible().catch(() => false),
      30000);
    }
    const modelTrigger = page.locator('[data-testid="chat-model-select-trigger"]');
    process.stdout.write(`重开之后模型按钮写着：${JSON.stringify(await modelTrigger.innerText().catch(() => "(读不到)"))}\n`);
    // 屏幕上还差两个选择：用哪个模型、在哪个工作区说。发送键的 aria-label 就是"为什么还不能发"，
    // 先把它读出来，而不是靠猜哪个闸门没开。
    const send = page.locator('[data-testid="v4-composer-send"]');
    // disabled 属性、aria-disabled、以及包着它的那段 DOM 到底哪一种在拦，得先看读数再决定点不点。
    const sendState = () =>
      send.evaluate((b) =>
        JSON.stringify({
          disabled: b.disabled,
          ariaDisabled: b.getAttribute("aria-disabled"),
          title: b.getAttribute("title"),
          parentText: (b.closest("div")?.innerText ?? "").replace(/\s+/g, " ").slice(0, 120),
        }),
      );
    process.stdout.write(`发送键状态：${await sendState()}\n`);
    // 模型行是 SubTrigger 下面的二级菜单（ModelConfigSelect.tsx:610-631），
    // 一层弹层里只有分组标题和"管理模型"那条 footer——上一版照着文本找 mock-model
    // 永远找不到，等到的只是 Radix popper 那句 "subtree intercepts pointer events"。
    await page.locator('[data-testid="chat-model-select-trigger"]').click();
    await page.waitForTimeout(500);
    process.stdout.write(
      `模型弹层里的一级条目：${JSON.stringify(await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid^="chat-model-select-group-"]')].map((e) => e.getAttribute("data-testid")),
      ))}\n`,
    );
    // 分组标题就是那个自定义供应商的行；有几组点第一组（真机上"我有自己的 Key"通常只有这一条）。
    const group = page.locator('[data-testid^="chat-model-select-group-"]').first();
    const picked = await pickModelRow(group);
    check("在模型选择器里选中了刚配的模型", picked !== null, picked === null ? await readout() : picked);
    await page.locator('[data-testid="v4-composer-input"]').click();
    await page.keyboard.type("用一句话说说你是谁");
    await page.screenshot({ path: path.join(shots, `before-send-${stage}.png`) });
    process.stdout.write(`填完草稿后的发送键提示：${await send.getAttribute("aria-label")} / disabled=${await send.evaluate((b) => b.disabled)}\n`);
    check("配好模型后发送按钮不再是禁用的", await send.isEnabled(), "还是禁用：可用位没亮");
    // 禁用的按钮点不动，而这条 run 判的是"配好模型之后能不能真发出去"——
    // 用 force 跳过 Playwright 的 actionability 检查，把事件直接打到元素上。
    await send.click({ force: true });
    await page.waitForTimeout(1500);
    const agentDiag = await page.evaluate(() => globalThis.__zcodeMobileMeta?.agentLog ?? []);
    process.stdout.write(
      `点发送之后：\n  屏幕=${JSON.stringify((await page.evaluate(() => document.body.innerText)).slice(-260))}\n  端侧对话记录=${JSON.stringify(agentDiag)}\n  客户端请求=${JSON.stringify(mockReqs)}\n`,
    );
    // 三种 mock 模式判的不是同一件事，判据必须跟着模式走：
    //   stream        —— 回答逐字出现、并且收尾
    //   businessError —— 那一轮失败后被如实画成一条错误，而不是安静地留个空气泡
    //   http500       —— 同上，且屏幕上不该出现整串网关 JSON
    // 上一版无论哪种模式都等 stream 的那句回答，所以失败模式永远 FAIL —— 那是判据写错，不是产品错。
    const OUTCOME =
      {
        stream: {
          label: "回答逐字出现在时间线上（流式）",
          text: "本地 mock 网关",
          tail: "没有出过这台机器",
          tailLabel: "回答完整落地（结尾那句话也在）",
          stop: true,
        },
        businessError: {
          label: "业务错误被如实画成一条失败轮次",
          text: "套餐额度不足，请换一个模型",
        },
        http500: {
          label: "HTTP 500 被如实画成一条失败轮次",
          text: "网关 500：模型服务不可用",
          // 网关原文是一整串 JSON；把它原样搬到屏幕上，读到的用户会以为是端上坏了。
          not: '{"error"',
        },
        notFound: {
          // 0.3.0 装机回报的就是这一形："发送之后提示 not found"。纯文本 404 没有任何可解析的
          // 错误信息，所以能定位问题的只有"请求打到了哪个地址"——横幅必须把它写出来。
          label: "网关 404 被如实画成一条失败轮次",
          text: "404 page not found",
          contains: "/mock/notFound/v1/chat/completions",
          containsLabel: "失败横幅里带着真实请求地址（能看出 URL 拼成了什么）",
        },
        tool: {
          // 工具循环的端到端证明（Phase 1 第 5 项）：mock 按请求历史走 Write→Read→收口三步。
          // "端上读回命中=true" 只有真链路走得通才成立：Write 经 core 执行器落进 vfs、
          // Read 从同一棵 vfs 读出、工具结果按协议喂回模型。core 加载失败时引擎=null、
          // 请求体不带 tools，mock 退回普通流，这条必然 FAIL——不存在假通过。
          label: "工具循环收口（模型看到端上真实的读回结果）",
          text: "工具自检完成",
          tail: "hit=true",
          tailLabel: "Write 落盘 + Read 读回 + 结果回传模型（vfs 真往返）",
          stop: false,
        },
      }[mode] ?? {
        label: `未知的 mock 模式：${mode}`,
        text: "",
      };
    // 判据是屏幕上真的有那段文字，不是内部状态位。
    // --exec 模式：此刻回合正停在"等审批"，收口文本要等点了允许才出现——这两段通用判据
    // 在 exec 下跳过，由下面的审批块负责完整证明（弹窗→允许→bash 真跑→收口文本）。
    if (!WITH_EXEC) {
      await expect(
        OUTCOME.label,
        () => page.evaluate((t) => document.body.innerText.includes(t), OUTCOME.text),
        30000,
      );
      if (OUTCOME.tail) {
      // 结尾那句要等它真的到齐再判：mock 是逐字符 45ms 推流，截图那一瞬流还在进行中。
      // 这里等的是"屏幕出现了完成态"这个事实，不是给流式硬加一段睡眠 —— 加睡眠等于把
      // "到底收没收尾"这个判据换成"我猜 1.5 秒够了"。
      await expect(
        OUTCOME.tailLabel,
        () => page.evaluate((t) => document.body.innerText.includes(t), OUTCOME.tail),
        30000,
      );
      }
    }
    // ── Bash 审批往返（--第一次能"跑命令"，而跑之前必须有人点头）──
    // 判据三段：①弹窗真出现（上游 PermissionDialog 的选项按钮在 DOM 里）；②点"允许这一次"
    // 两段式：第一次点击选中、再点才 respond（PermissionDialog 的 onClick 语义）；
    // ③收口文本里 bash=true —— mock 只有真收到 Bash 的 tool 结果（含 marker）才写 bash=true，
    // 而那条结果只有审批通过、假桥真被 core 的 ExecutionPort 调到才会存在。没弹窗/点了不跑/
    // 跑了没回传，任何一环断，这条都 FAIL。
    // ── Bash/Delete 审批往返（--exec 模式，0.4.8 起含"始终允许"）──
    // mock 步序 Bash→Write→Delete→Write→Delete→收口；Bash 与 Delete 都过审批闸，Delete 同路径两次。
    // PermissionDialog 是两段式（点选中、再点 respond），且**每个弹窗都同时挂着 allowOnce/
    // allowAlways/deny**——所以不能照着选择器盲点（上一版就这么把②③扫过去了，delete=true 却是
    // 连点 allowOnce 蒙对的，始终允许压根没被测到）。改成弹窗状态机：等一个弹窗 → 对那一个点
    // select+respond → 等它关 → 再看下一个。
    //   证人的核心是"弹窗数"：Bash(allowOnce) + Delete①(allowAlways) 共两个；
    //   Delete② 与 Delete① 同路径，命中"始终允许"记忆后**不该再弹窗**。
    //   出现第三个弹窗 = 记忆没生效；没有第三个、直接走到收口 = 记忆生效。
    if (WITH_EXEC) {
      const optionSel = '[data-permission-option-kind]';
      const kindSel = (kind) => `[data-permission-option-kind="${kind}"]`;
      const anyDialog = () => page.locator(optionSel).count().then((n) => n > 0).catch(() => false);
      // 等弹窗出现（80ms 轮询：respond→关→下一个开之间有 Bash 执行+Write 的往返，够跨过 0）。
      const waitPresent = async (ms) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
          if (await anyDialog()) return true;
          await page.waitForTimeout(80);
        }
        return false;
      };
      // 等当前弹窗消失（同一个 respond 之后，下一个还没开的窗口里抓到 0 即收拍）。
      const waitGone = async (ms) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
          if (!(await anyDialog())) return true;
          await page.waitForTimeout(80);
        }
        return false;
      };
      // 对**这一个**弹窗的某个选项点两下（选中→respond），中间不重新找弹窗（执行只在 respond 后恢复）。
      const clickOptionTwice = async (kind) => {
        const sel = kindSel(kind);
        await page.locator(sel).first().click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(220);
        if ((await page.locator(sel).count()) > 0) {
          await page.locator(sel).first().click({ timeout: 5000 }).catch(() => {});
        }
      };

      // 弹窗①：Bash。allowOnce（不记忆这条命令）。
      check("审批①：Bash 弹窗出现", await waitPresent(25000) === true);
      await clickOptionTwice("allowOnce");
      await waitGone(15000);

      // 弹窗②：Delete 第一次。带『始终允许』——记忆就是点它写下的。
      const d2 = await waitPresent(25000);
      const hasAlways = d2 ? await page.locator(kindSel("allowAlways")).count().then((n) => n > 0) : false;
      check("审批②：Delete 弹窗出现且带『始终允许』选项", d2 && hasAlways);
      await page.screenshot({ path: path.join(shots, "approval-dialog.png") });
      await clickOptionTwice("allowAlways");
      await waitGone(15000);

      // 弹窗③证人：第二次 Delete 同路径 —— 命中记忆就不该再问。轮询同一拍看两个结局：
      //   收口文本先到（正常，一路跑到收口没再弹）→ 记忆生效；选项再现 → 记忆没生效。
      let thirdDialog = false;
      let settled = false;
      const t0 = Date.now();
      while (Date.now() - t0 < 40000) {
        if (await anyDialog()) {
          thirdDialog = true;
          break;
        }
        if (await page.evaluate(() => document.body.innerText.includes("工具自检完成"))) {
          await page.waitForTimeout(400); // 竞态判窗：文本到了但弹窗恰好也挂上的那一拍
          if (await anyDialog()) thirdDialog = true;
          settled = true;
          break;
        }
        await page.waitForTimeout(200);
      }
      check("审批③：第二次 Delete 无新弹窗（始终允许记忆生效）", thirdDialog === false && settled);

      await expect(
        "回合收敛且 bash=true delete=true（真执行+真删除+记忆放行）",
        () => page.evaluate(() => {
          const t = document.body.innerText;
          return t.includes("bash=true") && t.includes("delete=true") && t.includes("hit=true");
        }),
        30000,
      );
      const execBody = await page.evaluate(() => document.body.innerText);
      check("审批④：Bash 过 schema + Delete 真删 + 始终允许闭环", true, execBody.slice(-400));
    }
    await page.screenshot({ path: path.join(shots, `answered-${mode}.png`) });
    const body = await page.evaluate(() => document.body.innerText);
    if (OUTCOME.not) check("屏幕上没有裸的网关原文", !body.includes(OUTCOME.not), body.slice(-300));
    if (OUTCOME.contains) {
      check(OUTCOME.containsLabel, body.includes(OUTCOME.contains), body.slice(-300));
    }
    check("这一轮结束后输入框还能用", await page.locator('[data-testid="v4-composer-input"]').isVisible());
    if (OUTCOME.stop) {
      // 停一次正在进行的流：这是"手机上话说到一半想收手"的那个按钮，判的是它真的掐断了请求，
      // 而不是只把按钮换掉。第二轮单独发，是为了不动上面那条"完整落地"的判据。
      await page.locator('[data-testid="v4-composer-input"]').click();
      await page.keyboard.type("再说一遍");
      await page.locator('[data-testid="v4-composer-send"]').click({ force: true });
      const stop = page.getByRole("button", { name: "停止生成" });
      await expect("第二轮进行中出现了「停止生成」", () => stop.isVisible(), 15000);
      await stop.click();
      await expect(
        "按下之后输入区回到「发送」",
        () => page.locator('[data-testid="v4-composer-send"]').isVisible(),
        15000,
      );
      const atStop = await page.evaluate(() => document.body.innerText.length);
      // mock 每 45ms 推一个字，800ms 足够它再吐十几个字 —— 真掐断了这里才不会长。
      await page.waitForTimeout(800);
      const afterStop = await page.evaluate(() => document.body.innerText.length);
      check(
        "停止之后时间线没有继续变长",
        afterStop <= atStop,
        `还在长：${atStop} → ${afterStop}`,
      );
      await page.screenshot({ path: path.join(shots, "stopped-stream.png") });
    }
    // worker 没加载成功时，浏览器**一定**会留下这三样：404 的那条资源、四条 Worker error、
    // 以及 worker 初始化响应是空串导致的那句 SyntaxError。只在"这一轮除了 diffs.worker 之外
    // 没有任何其他 4xx"的时候，才把那条 404/JSON 报错算作 worker 缺口的后果；
    // 换句话说：如果将来多出一个新的 404，这条判据会立刻变红，而不是跟着一起被豁免。
    const http4 = partitionGaps(http4xx);
    const onlyWorkerGap404 = http4.unexpected.length === 0 && http4.known.length > 0;
    const consoleSplit = partitionGaps(consoleErrors);
    const consoleLeftover = consoleSplit.unexpected.filter((line) => {
      // 网关故意回的那个状态码（businessError/http500 模式），不是资源缺失
      const status = /status of (\d{3})/.exec(line);
      if (status && mockStatuses.has(Number(status[1]))) return false;
      // worker 缺口带出来的那条 404，以及它空响应导致的那句 JSON 解析错
      return !(
        onlyWorkerGap404 &&
        (/^Failed to load resource: .*404/.test(line) ||
          line === "SyntaxError: Unexpected end of JSON input")
      );
    });
    if (consoleSplit.known.length + http4.known.length > 0) {
      process.stdout.write(
        `已知缺口（不门禁）：diffs.worker 没打进端侧产物，` +
          `它带出了 ${consoleSplit.known.length + http4.known.length + (onlyWorkerGap404 ? 2 : 0)} 条浏览器报错；` +
          `影响的是 diff 语法高亮，不是对话链路\n`,
      );
    }
    check("控制台没有报错", consoleLeftover.length === 0, consoleLeftover.join(" | "));
    check(
      "没有 4xx 资源（bundle 里的资源引用都对得上）",
      http4.unexpected.length === 0,
      http4.unexpected.join(" | "),
    );

    // ── 侧栏的那一行 ──
    // 用户报的是两件事："发出去提示 not found" 和 "右侧也没有真的出现这个会话"。
    // 上面那些判据只管前者，这一条只管后者。
    // 分两层读是有原因的：taskRows() 查的是端侧 SQLite（库里到底有没有这一行），
    // 屏幕文本是画出来的样子（有没有画）。两层分开，下次再空手而归时至少知道断在哪一层：
    // 库里有、屏上没有 → listTaskList 或重查触发没接上；库里没有 → sessions-index 帧 → readSession 那条链断了。
    // 这里用不抛错的 soft 版而不是 expect：这两条 FAIL 不该把后面的未实现面账本一起吞掉。
    const SENTENCE = "用一句话说说你是谁";
    const softExpect = async (label, action, budgetMs) => {
      const startedAt = Date.now();
      for (;;) {
        let done = false;
        try {
          done = await action();
        } catch {
          /* 页面正在换代，下一拍重读 */
        }
        if (done) return check(label, true);
        if (Date.now() - startedAt > budgetMs) return check(label, false, await readout());
        await page.waitForTimeout(250);
      }
    };
    // 上一版这条判据是"整屏文本里有没有这句话"，而用户自己那句话就画在时间线上 —— 侧栏明明还写着
    // "还没有任务"，它照样 PASS。所以读屏只读侧栏那一段（data-testid="sidebar"）。
    const sidebarText = () =>
      page.evaluate(() => document.querySelector('[data-testid="sidebar"]')?.innerText ?? "(没有侧栏节点)");
    process.stdout.write(
      `端侧 task-index 里现在的行：${JSON.stringify(
        // 读数口自己也要能报出它为什么读不出来：上一版这里是一个光秃秃的 null，
        // 而 "taskRows 不存在" 和 "查库抛错" 是两条完全不同的结论。
        await page
          .evaluate(async () => {
            const rows = globalThis.__zcodeMobileMeta?.taskRows;
            if (typeof rows !== "function") return "meta 上没有 taskRows 这个读数口";
            try {
              return await rows();
            } catch (e) {
              return `读 taskRows 抛错：${String(e?.stack ?? e).slice(0, 400)}`;
            }
          })
          .catch((e) => `求值 taskRows 失败：${String(e?.message ?? e).slice(0, 400)}`),
      )}\n`,
    );
    await softExpect(
      "会话写进了端侧 task-index（库里有这一行）",
      () =>
        page.evaluate(
          (s) =>
            (async () => {
              // 查错在页面里就地吞掉、只回 false：这条判据要的是"出现了没有"，
              // 而"为什么查不到"由上面那行读数负责报出来，两件事不要混在同一条 FAIL 里。
              try {
                const rows = await globalThis.__zcodeMobileMeta?.taskRows?.();
                return (rows ?? []).some((r) => (r.title ?? "").startsWith(s));
              } catch {
                return false;
              }
            })(),
          SENTENCE,
        ),
      20000,
    );
    await softExpect(
      "侧栏显示出这条会话的标题",
      async () => (await sidebarText()).includes(SENTENCE),
      15000,
    );
    process.stdout.write(`侧栏此刻的文本：${JSON.stringify(await sidebarText())}\n`);
    // ── 竖屏侧栏抽屉（0.3.8，装机反馈"不适配竖屏、侧边栏不能切换收起展开"）──
    // 393×851 视口 < 640，正好走 web-mobile-shell.ts 的窄屏分支：侧栏该被投影成 fixed 抽屉、
    // 上游那个非桌面切换按钮（web-sidebar-toggle）该存在且能把抽屉点开/收起。
    // 这组只在竖屏 provider 阶段跑（recon 没进主界面、send 没有会话行可点），所以收在 stage 判断里。
    if (stage === "provider") {
      const drawerState = () =>
        page.evaluate(() => {
          const panel = document.querySelector("#sidebar");
          const shell = document.querySelector("[data-workspace-shell]");
          const toggle = document.querySelector('[data-testid="web-sidebar-toggle"]');
          const scrim = document.querySelector("#zcode-narrow-scrim");
          const box = panel?.getBoundingClientRect();
          return {
            narrow: document.documentElement.classList.contains("zcode-narrow"),
            // 抽屉形态的判据：#sidebar 被接管成 fixed（垫片写在行内 style 上）。
            fixed: panel ? getComputedStyle(panel).position === "fixed" : false,
            toggleExists: Boolean(toggle),
            // React 的可见意图读 shell 上那个变量；屏上的真实位移读 panel 的左边界。
            reactVisible: shell
              ? (parseFloat(getComputedStyle(shell).getPropertyValue("--workspace-sidebar-panel-width")) || 0) > 1
              : null,
            panelOnscreenX: box ? Math.round(box.x) : null,
            panelWidth: box ? Math.round(box.width) : null,
            scrimVisible: Boolean(scrim) && getComputedStyle(scrim).pointerEvents === "auto",
          };
        });
      process.stdout.write(`竖屏抽屉读数：${JSON.stringify(await drawerState())}\n`);
      await softExpect(
        "竖屏窄屏旗子挂上（zcode-narrow + 侧栏投影成 fixed 抽屉）",
        async () => {
          const s = await drawerState();
          return s.narrow && s.fixed;
        },
        8000,
      );
      await softExpect(
        "竖屏收起态：侧栏初始移出屏外，切换按钮存在",
        async () => {
          const s = await drawerState();
          return s.toggleExists && s.reactVisible === false && (s.panelOnscreenX ?? 0) <= -10;
        },
        8000,
      );
      await page.click('[data-testid="web-sidebar-toggle"]');
      await softExpect(
        "点切换按钮 → 抽屉滑入屏内、遮罩可点",
        async () => {
          const s = await drawerState();
          return s.reactVisible === true && (s.panelOnscreenX ?? -1) >= -1 && s.scrimVisible;
        },
        8000,
      );
      await page.screenshot({ path: path.join(shots, "drawer-open.png") });
      // 抽屉里点那条会话行 → 应自动收起（选完即让位）。
      const taskRow = '[data-testid="sidebar"] [data-task-item-key]';
      const rowCount = await page.locator(taskRow).count().catch(() => 0);
      if (rowCount > 0) {
        await page.locator(taskRow).first().click();
        await softExpect(
          "点任务行 → 抽屉自动收起（回到移出屏外）",
          async () => {
            const s = await drawerState();
            return s.reactVisible === false && (s.panelOnscreenX ?? 0) <= -10;
          },
          8000,
        );
      } else {
        check("点任务行 → 抽屉自动收起", false, "抽屉里没有可点的任务行（前面侧栏判据已过，这里没行为可点）");
      }
      // ── 边缘滑动开合抽屉（0.4.7，装机"侧滑呼出/收起没有实现"的 JS 层回归网）──
      // 合成的 TouchEvent 走 DOM 派发，验的是 web-mobile-shell.ts 那段监听逻辑本身
      // （起点带/横向支配/开合两个方向）；"系统手势抢触摸"那一层是原生
      // setGestureExclusionRects 的事，桌面测不到、装机判。touchmove 必须分多帧：
      // 监听判的是"同一次滑动内"的累计位移，一帧到位也能过，但多帧更像手指。
      const edgeSwipe = async (fromX, toX) => {
        await page.evaluate(
          async ([fx, tx]) => {
            const mk = (type, x) => {
              const touch = new Touch({ identifier: 1, target: document.body, clientX: x, clientY: 300 });
              return new TouchEvent(type, {
                bubbles: true,
                touches: type === "touchend" || type === "touchcancel" ? [] : [touch],
                changedTouches: [touch],
              });
            };
            document.dispatchEvent(mk("touchstart", fx));
            for (let i = 1; i <= 6; i++) {
              await new Promise((r) => setTimeout(r, 16));
              document.dispatchEvent(mk("touchmove", fx + ((tx - fx) * i) / 6));
            }
            document.dispatchEvent(mk("touchend", tx));
          },
          [fromX, toX],
        );
      };
      await edgeSwipe(10, 100); // 左缘 10px 起、向右 90px：open 档（带 40px、阈 60px）
      await softExpect(
        "左缘右滑 → 抽屉呼出（edge-swipe open）",
        async () => (await drawerState()).reactVisible === true,
        8000,
      );
      await edgeSwipe(320, 220); // 开着时向左 100px：close 档（起点不限）
      await softExpect(
        "开着时左滑 → 抽屉收起（edge-swipe close）",
        async () => (await drawerState()).reactVisible === false,
        8000,
      );
      await edgeSwipe(120, 220); // 关着时从 120px 起右滑 100px：起点在带外，不该开
      await page.waitForTimeout(400);
      check(
        "起点不在左缘带内 → 右滑不误开抽屉",
        (await drawerState()).reactVisible === false,
      );
    }
    // ── 侧栏诊断链路（0.3.9：三版"装机侧栏空"都靠猜根因，这一格先把证人做活）──
    // UI 页把 listTaskList/watchScope/快照帧读数落到 localStorage（ui/sidebar-diagnostics.ts），
    // 自检页 M10 读同一个键、再开真库对账。桌面上这条只判"写没写进去"：
    // watched 非空 = 读取口至少被问过且 scope 记下了；readLast 有数字 = 谓词结果被如实抄回。
    const diagReadback = await page.evaluate(() => {
      try {
        return JSON.parse(localStorage.getItem("zcode-mobile.sidebar.diag") ?? "null");
      } catch {
        return null;
      }
    });
    process.stdout.write(`侧栏诊断读数：${JSON.stringify(diagReadback).slice(0, 400)}\n`);
    check(
      "侧栏诊断链路写进 localStorage（装机 M10 的证人活着）",
      Boolean(
        diagReadback &&
          Array.isArray(diagReadback.watched) &&
          diagReadback.watched.length > 0 &&
          diagReadback.readLast &&
          typeof diagReadback.readLast.items === "number",
      ),
      JSON.stringify(diagReadback).slice(0, 300),
    );
    // 顶栏证人链（0.4.7 装机"按钮调大下移没效果"；0.4.9 统一尺寸：72→44）。
    // 装机读数与桌面基准不符 ⇒ 差异出在运行时而非包内。M11 读同一个键。
    const topbarDiag = await page.evaluate(() => {
      try {
        return JSON.parse(localStorage.getItem("zcode-mobile.topbar.diag") ?? "null");
      } catch {
        return null;
      }
    });
    process.stdout.write(`顶栏证人读数：${JSON.stringify(topbarDiag)}\n`);
    check(
      "顶栏证人写进 localStorage 且实测 rect=44x44（M11 的基准帧，0.4.9 统一尺寸）",
      Boolean(topbarDiag && topbarDiag.narrow === true && topbarDiag.toggleRect?.startsWith("44x44")),
      JSON.stringify(topbarDiag),
    );
    // 完整端侧日志（readout 里那份只留最后 5 条，而这里要判的正是"发完话之后有没有再查过一次列表"）。
    process.stdout.write(
      `端侧完整日志（${
        (await page.evaluate(() => globalThis.__zcodeMobileMeta?.agentLog ?? [])).length
      } 条）：${JSON.stringify(
        await page.evaluate(() => globalThis.__zcodeMobileMeta?.agentLog ?? []),
      )}\n`,
    );
    await page.screenshot({ path: path.join(shots, `sidebar-${mode}.png`) });
  }
  // 每跑一遍都要看见"这一轮又请了哪些没实现的面"：接下面哪个面不是按猜，是按这份读数。
  // 上一版这条只在弹层点不动的分支里打，结果对话跑通的那几次根本没读到它，
  // "会话列表为什么是空的"就只能靠读上游源码反推。
  const ledger = await page
    .evaluate(() => globalThis.__zcodeMobileMeta?.unsupportedCalls?.() ?? null)
    .catch(() => null);
  process.stdout.write(`\n被调用过的未实现面：${JSON.stringify(ledger)}\n`);

  check(`跑到 ${stage} 阶段没崩`, true);
} catch (e) {
  if (!/stage 中断/.test(String(e.message ?? e))) {
    check(`跑到 ${stage} 阶段没崩`, false, `${String(e.message ?? e)}\n${await readout().catch(() => "")}`);
  }
} finally {
  await browser.close();
  if (host) await host.close();
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n浏览器端到端（${stage}）：${results.length - failed.length}/${results.length} PASS\n`);
process.exit(failed.length ? 1 : 0);
