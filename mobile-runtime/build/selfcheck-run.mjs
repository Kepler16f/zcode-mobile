// 桌面回归自检的可复现执行体：起一个本机静态服务，用 Edge 打开 build/selfcheck.html，
// 等它自己跑完 A/B 两段，把读数打印回终端。
//
// 为什么要这么绕一层：装机报告只能在手机上出，而出包前那条"桌面回归 31 PASS / 4 FAIL"
// 是本机 Chromium 判定的（PORTING §1.5.18 每次发版都引这条）。以前它是手点页面读的，
// 手点的结果没法进回归；SQLite 命名参数那条垫片（compat/shims/sqlite-named.mjs）恰恰
// 需要"同一份 SQL 在两个引擎上各跑一遍"，没有执行体就只能靠人记。
//
// 用法：node mobile-runtime/build/selfcheck-run.mjs [端口]
import { createRequire } from "node:module";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"));
const { chromium } = require("playwright-core");

const port = Number(process.argv.find((a) => /^\d{4,5}$/.test(a)) ?? 8988);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "selfcheck.html";
  const file = path.resolve(here, rel);
  // 只允许 build 目录内的路径，越界一律 404（和 chatdev 同一条规矩）。
  if (!file.startsWith(here + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});

const browser = await chromium.launch({
  executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  // fresh profile per run: a running Edge instance would swallow the launch and page.goto would hang
  // (the 30s TimeoutError this file hit on 2026-10-10). A dedicated user-data-dir sidesteps the lock.
  args: ["--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion", "--user-data-dir=" + path.join(os.tmpdir(), "azcode-selfcheck-edge-profile" + Date.now())],
  args: ["--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"],
});
const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
});

// A 段（M1/M2 harness）+ B 段（§3.4 那些"必须实测"的关卡）是串行跑的，
// 里面含 3000 文件基准与 256 MB 分配，慢的那几条本身就是报告内容，不能用短超时打断。
await page.goto(`http://127.0.0.1:${port}/selfcheck.html`, { waitUntil: "load" });
const deadline = Date.now() + 8 * 60 * 1000;
let done = false;
while (Date.now() < deadline) {
  done = await page.evaluate(() => {
    const report = globalThis.__zcodeSelfCheck;
    return Boolean(report?.runtime?.length && report?.device?.length && !document.getElementById("summary").textContent.includes("运行中"));
  });
  if (done) break;
  await page.waitForTimeout(2000);
}
if (!done) {
  console.error("自检在 8 分钟内没有跑完；页面此刻：" + (await page.textContent("#summary")));
}

const summary = await page.textContent("#summary");
const report = await page.evaluate(() => globalThis.__zcodeSelfCheck ?? { runtime: [], device: [] });
const all = [...report.runtime, ...report.device];
for (const r of all.filter((x) => !x.ok)) {
  console.log(`FAIL  ${r.name}  → ${typeof r.error === "string" ? r.error : JSON.stringify(r.error).slice(0, 300)}`);
}
const named = all.find((r) => r.name.startsWith("命名参数绑定"));
console.log(`命名参数绑定读数：${JSON.stringify(named?.detail ?? named?.error)}`);
console.log(`控制台报错 ${consoleErrors.length} 条${consoleErrors.length ? "：" + consoleErrors.slice(0, 3).join(" | ") : ""}`);
console.log(`桌面回归：${summary}`);

await browser.close();
server.close();
