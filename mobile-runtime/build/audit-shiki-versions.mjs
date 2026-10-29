// 审计移动模块图里的 shiki / @shikijs 版本组合：从 esbuild metafile 出发，
// 把每个输入文件归到它所属的包，打印「包名@版本 -> 绝对根目录」，并标出版本混搭。
// 用法：node mobile-runtime/build/audit-shiki-versions.mjs [metafile 路径]
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const zcodeRoot = path.join(root, "zcode");
const metafile = process.argv[2] ?? path.join(root, "tmp/shiki-metafile-090.json");

const mf = JSON.parse(readFileSync(metafile, "utf8"));
const inputs = Object.keys(mf.inputs);

const pkgCache = new Map();
function pkgOf(file) {
  let dir = path.dirname(file);
  for (let i = 0; i < 12; i++) {
    const p = path.join(dir, "package.json");
    if (pkgCache.has(p)) return pkgCache.get(p);
    try {
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (j.name) {
        const info = { name: j.name, version: j.version, dir };
        pkgCache.set(p, info);
        return info;
      }
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const groups = new Map();
for (const input of inputs) {
  if (!/shiki/i.test(input)) continue;
  const abs = path.resolve(zcodeRoot, "..", input);
  const pkg = pkgOf(abs);
  if (!pkg) continue;
  const key = `${pkg.name}@${pkg.version}`;
  if (!groups.has(key)) groups.set(key, { pkg, files: [] });
  groups.get(key).files.push(abs);
}

console.log(`metafile: ${metafile}`);
console.log(`总输入 ${inputs.length} 个，其中 shiki 相关 ${[...groups.values()].reduce((n, g) => n + g.files.length, 0)} 个\n`);
console.log("== 包名@版本 -> 绝对根目录（文件数） ==");
for (const [key, g] of [...groups].sort()) {
  console.log(`  ${key.padEnd(34)} ${String(g.files.length).padStart(4)} 个   ${g.pkg.dir}`);
}

const byName = new Map();
for (const [, g] of groups) {
  if (!byName.has(g.pkg.name)) byName.set(g.pkg.name, new Map());
  byName.get(g.pkg.name).set(g.pkg.version, g.pkg.dir);
}

console.log("\n== 版本混搭判定 ==");
let mixed = 0;
for (const [name, versions] of byName) {
  if (versions.size > 1) {
    mixed++;
    console.log(`  混搭 ${name}: ${[...versions].map(([v, d]) => `${v} (${d})`).join(" | ")}`);
  }
}
if (mixed === 0) console.log("  无混搭：每个包名在模块图里只有一个版本");

// 与 shiki@3.23.0 自身声明的依赖集合比对：任何 4.x 都是混搭。
const shikiPkg = JSON.parse(readFileSync(path.join(zcodeRoot, "node_modules/shiki/package.json"), "utf8"));
const expected = new Set([`shiki@${shikiPkg.version}`]);
for (const [name, range] of Object.entries(shikiPkg.dependencies ?? {})) {
  if (!name.startsWith("@shikijs/")) continue;
  const exact = /^\d+\.\d+\.\d+$/.test(range) ? range : null;
  if (exact) expected.add(`${name}@${exact}`);
}
console.log(`\n== shiki@${shikiPkg.version} 声明的自洽集合 ==`);
console.log("  " + [...expected].sort().join(", "));
const unexpected = [...groups.keys()].filter((k) => !expected.has(k));
console.log(unexpected.length ? `  集合外：${unexpected.join(", ")}` : "  集合外：无");

// packages/ui 自己的 shiki@4.0.2 有没有混进来？
const uiShiki = path.join(zcodeRoot, "packages/ui/node_modules/shiki");
const uiLeak = [...groups.values()].filter((g) => g.pkg.dir.startsWith(path.join(zcodeRoot, "packages/ui")));
console.log(`\npackages/ui 私有 shiki 实例是否进入模块图：${uiLeak.length ? uiLeak.map((g) => g.pkg.dir).join(", ") : "否"}`);
console.log(`(packages/ui 私有 shiki 位于 ${uiShiki}，版本 ${JSON.parse(readFileSync(path.join(uiShiki, "package.json"), "utf8")).version})`);

// 全图扫描：整个移动模块图里有没有「同一个包名出现多个版本」（不管是不是 shiki 系）。
const all = new Map();
for (const input of inputs) {
  const abs = path.resolve(zcodeRoot, "..", input);
  const pkg = pkgOf(abs);
  if (!pkg) continue;
  if (!all.has(pkg.name)) all.set(pkg.name, new Map());
  all.get(pkg.name).set(pkg.version, pkg.dir);
}
const dupNames = [...all].filter(([, v]) => v.size > 1);
console.log(`\n== 全图多版本包名（${dupNames.length} 个） ==`);
for (const [name, versions] of dupNames) {
  console.log(`  ${name}: ${[...versions].map(([v, d]) => `${v} @ ${d}`).join(" | ")}`);
}
