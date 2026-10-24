// 深色模式的桌面取证：把真 bundle（dist-ui）在 Chromium 里跑起来，验三层——
//  (1) CSS 重绑生效：OS 浅色 + App 深色 class 时，**只有 dark: 变体的规则**（.dark\:hidden）
//      按 .dark class 生效。重绑之前它绑 media query，OS 浅色下永远不生效，屏幕"半深半浅"。
//  (2) 未存过主题时默认深色（与 ui.html 首帧脚本一致），且系统浅色不改写它。
//  (3) localStorage=system 时装一个假 zcodeUi 桥（systemDark 真假各跑一遍），class 必须
//      跟着桥报的系统夜间模式走——真机"跟随系统"的生效路径（垫片重定向 matchMedia）在桌面等价复现。
// 说明：真机上报"跟随系统无效"的直接通道（WebView media query 被 algorithmic-darkening=false
// 钉成 light）只有 Android 有，桌面浏览器里 media query 是真值；所以 (3) 用假桥验"代码读的是桥、
// 不是 media"，(1) 验重绑本体，真机那半的读数留给装机自检。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(here, "dist-ui");
const require = createRequire(path.join(here, "../../zcode/apps/zcode-cli/package.json"));
const { chromium } = require("playwright-core");

const MIME = { ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".html": "text/html", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "") || "ui.html";
  const file = path.join(distDir, rel);
  if (!file.startsWith(distDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end("nope");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: Boolean(ok), detail });
const bootUrl = `http://127.0.0.1:${port}/ui.html`;

const browser = await chromium.launch({
  executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
});
async function openPage(initScript) {
  const page = await browser.newPage({ colorScheme: "light" });
  if (initScript) await page.addInitScript(initScript);
  await page.goto(bootUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(
    () => globalThis.__zcodeMobileMeta !== undefined || document.getElementById("booting")?.textContent?.includes("启动失败"),
    null,
    { timeout: 45000 },
  );
  await page.waitForTimeout(900);
  return page;
}

try {
  // —— (2) 默认主题 + 首帧脚本：OS 浅色，App 没存过主题 → 必须深色 class。
  const page = await openPage();
  const bootingText = await page.evaluate(() => document.getElementById("booting")?.textContent?.slice(0, 80) ?? "");
  check("bundle 起得来（无启动失败）", !bootingText.includes("启动失败"), bootingText);
  const cls = await page.evaluate(() => document.documentElement.className);
  check("默认主题：系统浅色下仍是 dark + theme-zai-dark", /(^| )dark( |$)/.test(cls) && cls.includes("theme-zai-dark"), cls);

  // —— (1) CSS 重绑的本体判据：.dark\:hidden 在 .dark 下 display:none；无 .dark 时是 block。
  const probe = await page.evaluate(() => {
    const mk = (cls) => {
      const d = document.createElement("div");
      d.className = cls;
      document.body.appendChild(d);
      const cs = getComputedStyle(d).display;
      d.remove();
      return cs;
    };
    return { hiddenUnderDark: mk("dark:hidden"), visibleWithout: mk("hidden"), };
  });
  check("重绑生效：.dark 在场时 dark:hidden 规则按 class 生效（display:none）",
    probe.hiddenUnderDark === "none", JSON.stringify(probe));
  await page.close();

  // —— (3) system + 桥报非夜间 → 浅色 class。
  const pLight = await openPage(() => {
    localStorage.setItem("zcode-theme", "system");
    globalThis.zcodeUi = { systemDark: () => false, setThemeDark: () => {} };
  });
  const clsLight = await pLight.evaluate(() => document.documentElement.className);
  check("system + 桥说系统浅色 → theme-zai-light（跟随系统走浅色）",
    clsLight.includes("theme-zai-light") && !/(^| )dark( |$)/.test(clsLight), clsLight);
  await pLight.close();

  // —— (3') system + 桥报夜间 → 深色 class。桌面 OS 也是浅色——class 若仍深色，
  //     说明读的是桥而不是 media query（真机那条通道在桌面对应"media 永远等于桥"的构造）。
  const pDark = await openPage(() => {
    localStorage.setItem("zcode-theme", "system");
    globalThis.zcodeUi = { systemDark: () => true, setThemeDark: () => {} };
  });
  const clsDark = await pDark.evaluate(() => document.documentElement.className);
  check("system + 桥说系统夜间 → dark + theme-zai-dark（OS 浅色不改写：垫片读桥生效）",
    clsDark.includes("theme-zai-dark") && /(^| )dark( |$)/.test(clsDark), clsDark);

  // 截图：重绑后的深色默认屏（给交付说明附图用）
  await pDark.screenshot({ path: path.join(here, "e2e-shots", "dark-follow-system.png") });
  await pDark.close();
} catch (e) {
  check("取证脚本跑完", false, String(e?.stack ?? e).split("\n").slice(0, 3).join(" | "));
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  process.stdout.write(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  → ${r.detail}`}\n`);
}
process.stdout.write(`\n深色模式取证：${results.length - failed.length}/${results.length} PASS\n`);
process.exitCode = failed.length > 0 ? 1 : 0;
