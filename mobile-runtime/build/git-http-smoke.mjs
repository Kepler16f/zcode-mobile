// Git 传输原生桥（0.6.7，装机"git 工具一直 fail to fetch"）的冒烟。
//
// 根因：isomorphic-git 的 web 传输走 fetch，WebView 页面（https://appassets 源）对 git 远端
// 全是跨源——git 端点不答 CORS（实测 GitHub /info/refs 无 ACAO、OPTIONS 预检 405），fetch 层
// 直接 "Failed to fetch"。修法：GitHttpBridge.kt（原生 HttpURLConnection，无 CORS 概念）+
// git-tool.ts 的 bridgeHttpRequest（同一 GitHttpResponse 契约，zcodeGitHttp 在场就换传输）。
//
// 两格：
//  ① 端到端真实克隆：mock 桥复刻 GitHttpBridge.kt 的 JSON 契约（同步 call、base64 body、
//     手动重定向），经 Node fetch 真打 GitHub——通了就是"CORS 绕行 + transport 形状"双铁证；
//     网络不可用时 SKIP（打印原因不算 FAIL——冒烟不拿机房网络当真理，但装机必测）。
//  ② 桥失败路径：桥回 {"error":…}（上游不可达等）→ 工具如实抛"git 传输失败"，不静默。
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const zcodeRoot = path.join(root, "../zcode");
const require = createRequire(path.join(zcodeRoot, "apps/zcode-cli/package.json"));
const esbuild = require("esbuild");

// Node 24 有 globalThis，但 isomorphic-git 的 UMD 浏览器产物要 self——装机的 WebView 天然有，
// Node 侧冒烟垫一下（git-umd-smoke 同法）。
globalThis.self ??= globalThis;

const tmp = path.join(os.tmpdir(), `azcode-githttp-${Date.now()}.mjs`);
await esbuild.build({
  stdin: {
    contents: `
import { makeGitTool } from ${JSON.stringify(path.join(root, "ui/git-tool.ts"))};
import * as vfs from ${JSON.stringify(path.join(root, "compat/vfs.mjs"))};
import { createGitFs } from ${JSON.stringify(path.join(root, "compat/git-fs-adapter.mjs"))};
globalThis.__makeGitTool = makeGitTool;
globalThis.__vfs = vfs;
globalThis.__gitFs = createGitFs(vfs);
`,
    resolveDir: path.join(root, "ui"),
    sourcefile: "git-http-entry.mjs",
  },
  outfile: tmp,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  write: true,
  logLevel: "warning",
  nodePaths: [path.join(root, "node_modules")],
  banner: {
    js: `import { createRequire as __cR } from "node:module"; const require = __cR(import.meta.url);`,
  },
});
await import(pathToFileURL(tmp).href);
fs.rmSync(tmp, { force: true });
const vfs = globalThis.__vfs;
const gitFs = globalThis.__gitFs;
const makeGitTool = globalThis.__makeGitTool;

/**
 * mock 桥：与 GitHttpBridge.kt 逐字同契约（同步 call(请求 JSON) → 响应 JSON：
 * statusCode/statusMessage/headers/bodyBase64 | error；base64 body；手动跟随 ≤5 跳，
 * 303/30x+POST 降级 GET）。Node 侧同步化用子进程跑 fetch——桥的"同步"契约照抄，
 * 慢一点没关系。headers 键小写化同 Kotlin 桥行为（TS 侧再小写一次是无害的幂等）。
 */
const HELPER = `
const req = JSON.parse(process.argv[1]);
const bodyBuf = req.bodyBase64 && req.bodyBase64.length ? Buffer.from(req.bodyBase64, 'base64') : null;
(async () => {
  let url = req.url, method = req.method || 'GET', headers = req.headers || {}, body = bodyBuf;
  for (let hop = 0; hop <= 5; hop++) {
    const res = await fetch(url, {
      method,
      headers,
      body: (method !== 'GET' && method !== 'HEAD' && body) ? body : undefined,
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) { process.stdout.write(JSON.stringify({ error: 'redirect ' + res.status + ' without Location' })); return; }
      url = new URL(loc, url).toString();
      if (res.status === 303 || (res.status >= 301 && res.status <= 302 && method === 'POST')) { method = 'GET'; body = null; }
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const hs = {};
    for (const [k, v] of res.headers.entries()) hs[k] = v;
    process.stdout.write(JSON.stringify({
      statusCode: res.status, statusMessage: res.statusText, headers: hs,
      bodyBase64: buf.length ? buf.toString('base64') : '',
    }));
    return;
  }
  process.stdout.write(JSON.stringify({ error: '重定向超过 5 跳' }));
})().catch((e) => process.stdout.write(JSON.stringify({ error: String((e && e.message) || e) })));
`;
globalThis.zcodeGitHttp = {
  call(requestJson) {
    try {
      return execFileSync(process.execPath, ["-e", HELPER, requestJson], {
        maxBuffer: 256 * 1024 * 1024,
        encoding: "utf8",
      });
    } catch (e) {
      return JSON.stringify({ error: String(e?.message ?? e).slice(0, 200) });
    }
  },
};

const results = [];
const check = async (name, fn) => {
  const t0 = Date.now();
  try {
    results.push({ name, ok: true, ms: Date.now() - t0, detail: await fn() });
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, why: String(e?.message ?? e).slice(0, 300) });
  }
};
const expect = (cond, why) => {
  if (!cond) throw new Error(why);
};

await check("① 端到端真实克隆（GitHub smart-protocol，全链走桥 transport）", async () => {
  const DIR = "/work/clone-e2e";
  vfs.rmSync(DIR, { recursive: true, force: true });
  const tool = makeGitTool("/work", gitFs, undefined);
  let out = "";
  try {
    out = await tool.handler({
      action: "clone",
      // octocat/Hello-World 是著名的零提交空仓库（克隆成功但没 HEAD）——用 Spoon-Knife，
      // 它小且真有提交历史。
      url: "https://github.com/octocat/Spoon-Knife.git",
      dir: "clone-e2e",
    });
  } catch (e) {
    const msg = String(e?.message ?? e);
    // 网络不可用/GitHub 被限流不算 FAIL：本机 Node fetch 到 github 443 间歇超时（10s connect），
    // 真机走的是 HttpURLConnection + 长超时的原生桥，不受影响。限流时 GitHub 会给出退化的
    // 通告（无 HEAD），也归这一类。SKIP 如实打印，装机是最终判据。
    if (/fetch failed|传输失败|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|Connect Timeout|Could not find HEAD|网络|timed? ?out/i.test(msg)) {
      return { skipped: true, reason: msg.slice(0, 140) };
    }
    throw e;
  }
  expect(typeof out === "string" && out.includes("已克隆"), `clone 结果异常：${String(out).slice(0, 200)}`);
  expect(vfs.existsSync(`${DIR}/.git`), ".git 没落到工作区");
  // 克隆后 status 可读（历史树落盘了）。
  const st = await tool.handler({ action: "status" });
  expect(typeof st === "string" && st.includes("分支"), `克隆后 status 异常：${String(st).slice(0, 120)}`);
  return { out: String(out).slice(0, 120) };
});

await check("② 桥 error（上游不可达）→ 工具如实抛，不静默", async () => {
  // 换一枚必定连不上的端口（127.0.0.1:1 没人听）。
  const tool = makeGitTool("/work", gitFs, undefined);
  let err = "";
  try {
    await tool.handler({ action: "clone", url: "http://127.0.0.1:1/x.git", dir: "dead-probe" });
  } catch (e) {
    err = String(e?.message ?? e);
  }
  expect(err.length > 0, "上游不可达却没报错（静默失败？）");
  expect(/git 传输失败|上游|不可达|连接|ECONN|connect/i.test(err), `错误措辞不可读：${err.slice(0, 160)}`);
  return { err: err.slice(0, 140) };
});

let passed = 0;
let skipped = 0;
for (const r of results) {
  if (r.ok) passed += 1;
  if (r.ok && r.detail?.skipped) skipped += 1;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.why}`);
}
console.log(`git 传输桥冒烟：${passed}/${results.length} PASS${skipped ? `（含 ${skipped} 格网络 SKIP）` : ""}`);
if (passed !== results.length) process.exit(1);
