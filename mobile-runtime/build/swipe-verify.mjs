// 一次性验证脚本（不进交付链）：窄屏 + 边缘滑动开合抽屉 + 顶栏证人读数。
// 用真 dist-ui 产物 + 真 Chromium，在 393x851 窄屏视口跑 web-mobile-shell 的那段手势监听。
// chat-e2e 的 provider 阶段依赖供应商配置那条长链（本脚本要独立判据，直接绕开）。
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startChatdev } from "./chatdev.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"));
const { chromium } = require("playwright-core");

const port = Number(process.argv[2] ?? 8992);
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
await page.goto(`http://127.0.0.1:${port}/?devCredentials=1&mode=stream&override=1`, {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});
// 越过首装闸门走到主界面。
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

const drawerState = () =>
  page.evaluate(() => {
    const panel = document.querySelector("#sidebar");
    const shell = document.querySelector("[data-workspace-shell]");
    const toggle = document.querySelector('[data-testid="web-sidebar-toggle"]');
    return {
      narrow: document.documentElement.classList.contains("zcode-narrow"),
      toggleExists: Boolean(toggle),
      reactVisible: shell
        ? (parseFloat(getComputedStyle(shell).getPropertyValue("--workspace-sidebar-panel-width")) || 0) > 1
        : null,
    };
  });

const edgeSwipe = async (fromX, toX, y = 300) => {
  await page.evaluate(
    async ([fx, tx, yy]) => {
      const mk = (type, x) => {
        const touch = new Touch({ identifier: 1, target: document.body, clientX: x, clientY: yy });
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
    [fromX, toX, y],
  );
};

const results = [];
let passCount = 0, failCount = 0;
const check = (name, cond, evidence = "") => {
  results.push({ name, cond, evidence });
  console.log(`  ${cond ? "PASS" : "FAIL"} ${name}${evidence ? ` ← ${evidence}` : ""}`);
  if (cond) passCount++; else failCount++;
};

console.log("── 竖屏旗子 + 顶栏证人在桌面真产物上生效（0.4.7）──");
const s0 = await drawerState();
check("窄屏旗子挂上", s0.narrow === true && s0.toggleExists === true, JSON.stringify(s0));
check("抽屉初始收起", s0.reactVisible === false);

await edgeSwipe(10, 100); // 左缘带内、右滑 90px → open
await page.waitForTimeout(700);
const sOpen = await drawerState();
check("左缘右滑 → 抽屉呼出", sOpen.reactVisible === true, JSON.stringify(sOpen));

await edgeSwipe(320, 220); // 开着时向左 100px → close
await page.waitForTimeout(700);
const sClose = await drawerState();
check("开着时左滑 → 抽屉收起", sClose.reactVisible === false, JSON.stringify(sClose));

await edgeSwipe(200, 300); // 关着时 200px 起右滑：起点在带外，不该开
await page.waitForTimeout(700);
const sBad = await drawerState();
check("起点在带外 → 右滑不误开", sBad.reactVisible === false);

// 顶栏证人
await page.waitForTimeout(1700); // 等 settle 后的 1500ms 那一枪
const topbarDiag = await page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem("zcode-mobile.topbar.diag") ?? "null"); }
  catch { return null; }
});
check("顶栏证人写进 localStorage", topbarDiag && typeof topbarDiag === "object");
check("narrow=true", topbarDiag?.narrow === true);
// 0.4.9 基准：顶栏按钮统一 44px（历史 72px 过头）。用前缀判断，不钉 y（容器居中随 top 微调）。
check("toggleRect 宽=44（0.4.9 统一尺寸）", topbarDiag?.toggleRect?.startsWith("44x44") === true, `读数=${JSON.stringify(topbarDiag?.toggleRect)}`);

// ── 触摸聚焦垫片（0.4.10，装机"点输入框要双击才出输入法"）──
// 合成一次"上游链把第一次 tap 吞了"的现场：先把焦点抢到非输入元素，再在输入区坐标上
// 派发真 TouchEvent（touchend，changedTouches）——垫片应补一次 focus()，把焦点送回输入区。
const touchShim = await page.evaluate(async () => {
  const input = document.querySelector("[data-testid='v4-composer-input']");
  if (!input) return { ok: false, why: "no input" };
  const r = input.getBoundingClientRect();
  if (r.width < 1) return { ok: false, why: "input not laid out" };
  const before = document.activeElement;
  before?.blur?.();
  // 焦点先放别处（模拟"上游没带进来"）
  const decoy = document.querySelector('[data-testid="v4-composer-send"]') || document.body;
  decoy?.focus?.();
  const x = Math.round(r.left + r.width / 2);
  const y = Math.round(r.top + r.height / 2);
  const mk = (type) => {
    const touch = new Touch({ identifier: 7, target: input, clientX: x, clientY: y });
    return new TouchEvent(type, {
      bubbles: true,
      touches: type === "touchend" ? [] : [touch],
      changedTouches: [touch],
    });
  };
  input.dispatchEvent(mk("touchstart"));
  await new Promise((res) => setTimeout(res, 30));
  input.dispatchEvent(mk("touchend"));
  await new Promise((res) => setTimeout(res, 80));
  const a = document.activeElement;
  // 只认焦点真进了输入区（或其子节点）。不能写 a.contains(input)：焦点落回 body 时
  // body 包含一切，那是"没救回来"却被判成救回来了。
  const hit = a === input || input.contains(a);
  const diag = (() => { try { return JSON.parse(localStorage.getItem("zcode-mobile.focus.diag") ?? "null"); } catch { return null; } })();
  return { ok: true, rescued: hit, rescueCount: diag?.rescueCount ?? 0, active: `${a?.tagName}(${a?.getAttribute?.("data-testid") ?? "-"})` };
});
check("触摸垫片：吞焦点后的 touchend 把焦点补回输入区", touchShim.ok && touchShim.rescued === true, JSON.stringify(touchShim));
check("M12 证人：垫片计数写进 localStorage（≥1）", touchShim.ok && touchShim.rescueCount >= 1, JSON.stringify(touchShim));

// ── 0.7.1 设置层覆盖（用户报"设置点进去特别暗，点一下才恢复正常"）──
// 从抽屉进设置：设置层是覆盖在工作区壳层上的（不是整页导航），#sidebar 还在 DOM 里、
// React 也仍说抽屉开着——旧逻辑只在"面板没了"时收遮罩，于是黑遮罩（z-25）继续压在
// 设置层（z-10）上，整屏发暗。判据：进设置后遮罩必须 display:none/opacity:0，
// 且设置层真的在（别拿"设置页没渲染"当成遮罩收对了）。
await edgeSwipe(10, 100);
await page.waitForTimeout(700);

// ── 0.7.7 纯属性翻转判据（"进设置偶发变暗"的残留路径）──
// 上游 RootWorkspaceContent 在**同一元素**上翻转 data-root-workspace-surface="inert"⇄
// "interactive"；设置层挂载过一次后常驻 DOM——再进设置零节点增删，0.7.1 的收遮罩判定
// （coveredBySettingsLayer）虽然对，但 childList-only 的导航观察器不会为属性变化叫醒
// sync，遮罩压回设置层上＝偶发发暗。这里手动翻属性（零 DOM 增删）钉死观察器接线：
// 置 inert → 遮罩必须自动离场；还原 → 必须按抽屉真实状态重新投影（遮罩回来）。
const attrRace = await page.evaluate(async () => {
  const raf = (ms) => new Promise((res) => setTimeout(res, ms));
  const surface = document.querySelector("[data-root-workspace-surface]");
  const lit = () => {
    const el = document.getElementById("zcode-narrow-scrim");
    if (!el) return false;
    const s = getComputedStyle(el);
    return s.display !== "none" && s.opacity !== "0";
  };
  if (!surface) return { ok: false, why: "无 surface 属性元素（上游结构变了？判据需同步更新）" };
  const wasLit = lit();
  const prev = surface.getAttribute("data-root-workspace-surface");
  surface.setAttribute("data-root-workspace-surface", "inert");
  await raf(300);
  const hiddenAfterInert = !lit();
  surface.setAttribute("data-root-workspace-surface", prev || "interactive");
  await raf(300);
  const relitAfterRestore = lit();
  return { ok: true, wasLit, hiddenAfterInert, relitAfterRestore };
});
check(
  "纯属性覆盖（零 DOM 增删）：遮罩自动离场，不再偶发压暗设置层",
  attrRace.ok === true && attrRace.wasLit === true && attrRace.hiddenAfterInert === true,
  JSON.stringify(attrRace),
);
check(
  "覆盖解除：按抽屉状态重新投影（遮罩该回来就回来）",
  attrRace.ok === true && attrRace.wasLit === true && attrRace.relitAfterRestore === true,
  JSON.stringify(attrRace),
);

const settingsBtn = page.locator('[data-testid="task-settings-button"]').first();
if (await settingsBtn.count()) {
  await settingsBtn.scrollIntoViewIfNeeded().catch(() => {});
  await settingsBtn.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(900);
  const overlay = await page.evaluate(() => {
    const el = document.getElementById("zcode-narrow-scrim");
    const cs = el ? getComputedStyle(el) : null;
    return {
      scrim: el ? { display: cs.display, opacity: cs.opacity, pointerEvents: cs.pointerEvents } : null,
      settingsOpen: Boolean(document.querySelector('[data-root-workspace-surface="inert"]')),
    };
  });
  check(
    "进设置后遮罩离场（不再整屏发暗）",
    overlay.scrim !== null && overlay.scrim.display === "none" && overlay.scrim.opacity === "0",
    JSON.stringify(overlay.scrim),
  );
  check("设置层真的渲染了（不是'没进设置'）", overlay.settingsOpen === true, JSON.stringify(overlay));
} else {
  check("侧栏里有设置入口（settings 覆盖判据的前置）", false, "task-settings-button 不存在");
}

await browser.close();
await dev.close();
console.log(`\n合计：${passCount} PASS / ${failCount} FAIL`);
process.exit(failCount > 0 ? 1 : 0);
