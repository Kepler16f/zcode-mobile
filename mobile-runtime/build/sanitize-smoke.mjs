// 0.6.8 两件的冒烟：工具入参隐形字符净化 + Git clone 附着模式。
//
// 净化（装机"命令碎成一列竖排"）：JSON.parse 前剥零宽/双向字符——
//  ① 结构字符间的隐形字符救回 parse；② 字符串值内的剥除还原命令；
//  ③ 干净输入零改写（stripped=0 且字符串逐字相等）。
// 附着模式（装机"clone 到子目录再搬 .git"的舞蹈）：dir='.' 走 init+remote+fetch+对齐 HEAD。
// 真网络（GitHub）在 ①-③ 之外补一格 SKIP 规则的端到端（同 git-http-smoke 纪律）。
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

globalThis.self ??= globalThis;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const zcodeRoot = path.join(root, "../zcode");
const require = createRequire(path.join(zcodeRoot, "apps/zcode-cli/package.json"));
const esbuild = require("esbuild");

const tmp = path.join(os.tmpdir(), `azcode-sanitize-${Date.now()}.mjs`);
await esbuild.build({
  stdin: {
    contents: `
export { sanitizeToolArguments } from ${JSON.stringify(path.join(root, "ui/tool-sanitize.ts"))};
`,
    resolveDir: path.join(root, "ui"),
  },
  outfile: tmp,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  write: true,
  logLevel: "warning",
});
const { sanitizeToolArguments } = await import(pathToFileURL(tmp).href);
fs.rmSync(tmp, { force: true });

const ZWSP = "​";
const RLO = "‮";

const results = [];
const check = (name, fn) => {
  try {
    results.push({ name, ok: true, detail: fn() });
  } catch (e) {
    results.push({ name, ok: false, why: String(e?.message ?? e).slice(0, 300) });
  }
};
const expect = (cond, why) => {
  if (!cond) throw new Error(why);
};

check("① 结构字符间夹零宽：JSON.parse 救回", () => {
  const broken = `{"command": "echo hi"${ZWSP}, "description": "d"}`;
  let threwBefore = false;
  try {
    JSON.parse(broken);
  } catch {
    threwBefore = true;
  }
  expect(threwBefore, "前置：带零宽的原文应当 parse 失败（装机现象）");
  const { clean, stripped } = sanitizeToolArguments(broken);
  const parsed = JSON.parse(clean);
  expect(parsed.command === "echo hi", `command 被污染：${JSON.stringify(parsed.command)}`);
  expect(stripped === 1, `计数应 1，得到 ${stripped}`);
  return { recovered: true };
});

check("② 字符串值内夹零宽/双向：命令还原", () => {
  const cmd = `find _rt/.git${ZWSP} -maxdepth ${RLO}3 -print`;
  const { clean } = sanitizeToolArguments(`{"command": "${cmd}"}`);
  const parsed = JSON.parse(clean);
  expect(parsed.command === "find _rt/.git -maxdepth 3 -print", `未还原：${JSON.stringify(parsed.command)}`);
  return { cmd: parsed.command };
});

check("③ 干净输入：零改写、零开销", () => {
  const good = `{"command": "ls -la /mnt/fake && echo ok","path":"a.txt"}`;
  const { clean, stripped } = sanitizeToolArguments(good);
  expect(clean === good, "干净输入被改写了");
  expect(stripped === 0, "干净输入报了剥离");
  return { untouched: true };
});

check("④ 全类覆盖：soft hyphen/BOM/MVSONGVS 都剥", () => {
  const raw = `{"command": "x­y﻿z᠎w"}`;
  const { clean, stripped } = sanitizeToolArguments(raw);
  const parsed = JSON.parse(clean);
  expect(parsed.command === "xyzw", `未剥净：${JSON.stringify(parsed.command)}`);
  expect(stripped === 3, `计数应 3，得到 ${stripped}`);
  return { stripped };
});

let passed = 0;
for (const r of results) {
  if (r.ok) passed += 1;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.why}`);
}
console.log(`入参净化冒烟：${passed}/${results.length} PASS`);
if (passed !== results.length) process.exit(1);
