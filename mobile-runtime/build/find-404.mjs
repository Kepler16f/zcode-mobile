// 一次性诊断：抓 selfcheck.html 加载后 15 秒内所有 4xx/5xx 与失败请求的 URL。
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(path.resolve(here, "../.."), "zcode/apps/zcode-cli/package.json"));
const { chromium } = require("playwright-core");

const buildDir = here;
const port = 8994;
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const file = path.normalize(path.join(buildDir, url === "/" ? "selfcheck.html" : url));
  if (!file.startsWith(buildDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "text/javascript" : file.endsWith(".wasm") ? "application/wasm" : "text/plain" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(port, "127.0.0.1", r));
const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
const page = await (await browser.newContext()).newPage();
const bad = [];
page.on("response", (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
page.on("request", (r) => { if (r.url().includes("favicon")) bad.push(`REQ ${r.url()}`); });
page.on("requestfailed", (r) => bad.push(`FAILED ${r.url()} ${r.failure()?.errorText ?? ""}`));
page.on("console", (m) => { if (m.type() === "error") bad.push(`CONSOLE ${m.text().slice(0, 160)}`); });
await page.goto(`http://127.0.0.1:${port}/selfcheck.html`, { waitUntil: "load" });
await page.waitForTimeout(15000);
console.log(bad.length ? bad.slice(0, 10).join("\n") : "(没有坏请求)");
await browser.close();
server.close();
process.exit(0);
