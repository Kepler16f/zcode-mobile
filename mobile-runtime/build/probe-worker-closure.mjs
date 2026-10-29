// 量一下 dist-ui 里 workers/diffs.worker.js 的传递 import 闭包体积：
// 每个 worker 起来都要把这整条链解析一遍，链有多大直接决定启动成本。
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";

const d = "D:/Zcode/mobile-runtime/build/dist-ui";

function closure(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (!existsSync(f)) continue;
    const src = readFileSync(f, "utf8");
    // 排除 import(...)：静态图里不能有动态 import，否则会把按需加载的语言包算进来。
    const re = /(?:^|[;}\s])(?:import|export)\s*(?:[^("'\n;]*?from\s*)?["'](\.[^"']+)["']/g;
    let m;
    while ((m = re.exec(src))) {
      stack.push(path.resolve(path.dirname(f), m[1]));
    }
  }
  return seen;
}

for (const entry of ["workers/diffs.worker.js", "entry.js"]) {
  let seen;
  try {
    seen = closure(path.join(d, entry));
  } catch (e) {
    console.log(`\n### ${entry}: closure failed: ${e.message}`);
    continue;
  }
  let total = 0;
  for (const f of seen) if (existsSync(f)) total += statSync(f).size;
  console.log(`\n### ${entry}: ${seen.size} files, ${(total / 1024 / 1024).toFixed(2)} MB`);
  const arr = [...seen]
    .filter((f) => existsSync(f))
    .map((f) => ({ n: path.basename(f), s: statSync(f).size }))
    .sort((a, b) => b.s - a.s);
  console.log(arr.slice(0, 12).map((a) => `   ${(a.s / 1024).toFixed(0).padStart(7)} KB  ${a.n}`).join("\n"));
}

// 动态 import：静态图之外的按需加载（shiki 语言包/主题都是这种）
for (const entry of ["workers/diffs.worker.js", "entry.js"]) {
  const seen = closure(path.join(d, entry));
  const dyn = new Set();
  for (const f of seen) {
    if (!existsSync(f)) continue;
    const src = readFileSync(f, "utf8");
    const re = /import\(\s*["'](\.[^"']+)["']\s*\)/g;
    let m;
    while ((m = re.exec(src))) dyn.add(path.resolve(path.dirname(f), m[1]));
  }
  const langs = [...dyn].filter((p) => /langs|themes|engine|wasm/i.test(p));
  let dynTotal = 0;
  for (const f of dyn) if (existsSync(f)) dynTotal += statSync(f).size;
  console.log(
    `\n### ${entry}: 动态 import ${dyn.size} 个（其中 lang/theme/engine/wasm ${langs.length} 个），` +
      `合计 ${(dynTotal / 1024 / 1024).toFixed(2)} MB`,
  );
  const arr = [...dyn]
    .filter((f) => existsSync(f))
    .map((f) => ({ n: path.basename(f), s: statSync(f).size }))
    .sort((a, b) => b.s - a.s);
  console.log(arr.slice(0, 12).map((a) => `   ${(a.s / 1024).toFixed(0).padStart(7)} KB  ${a.n}`).join("\n"));
}

// worker 入口的直接依赖
const w = path.join(d, "workers/diffs.worker.js");
const src = readFileSync(w, "utf8");
  const re = /(?:^|[;}\s])(?:import|export)\s*(?:[^("'\n;]*?from\s*)?["'](\.[^"']+)["']/g;
let m;
const direct = [];
while ((m = re.exec(src))) direct.push(m[1]);
console.log("\n=== worker 直接依赖 ===");
for (const dep of direct) {
  const p = path.resolve(path.dirname(w), dep);
  console.log(`   ${existsSync(p) ? (statSync(p).size / 1024).toFixed(0) + " KB" : "MISSING"}  ${dep}`);
}
