import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const specsDir = resolve(repoRoot, "mobile-runtime/specs");
const buildDir = resolve(repoRoot, "mobile-runtime/build");

const specs = readdirSync(specsDir).filter(x => x.endsWith(".md")).sort();
assert.ok(specs.length > 0, "mobile-runtime/specs 不能为空");

let totalRefs = 0;
for (const file of specs) {
  const full = resolve(specsDir, file);
  const content = readFileSync(full, "utf8");
  const lines = content.split(/\r?\n/);

  const hasVerifyHeading = lines.some(line => /^#{1,3}\s+.*(验证方式|验收|verify|verification)/i.test(line));
  assert.ok(hasVerifyHeading, `spec 缺少“验证方式/验收”小节: mobile-runtime/specs/${file}`);

  const scriptRefs = new Set();
  for (const m of content.matchAll(/(?:mobile-runtime\/)?build\/([\w.-]+\.(?:mjs|ts|js))\b|\b([\w-]+-(?:smoke|check|audit|probe|e2e|evidence)\.(?:mjs|ts))\b/g)) {
    const name = m[1] || m[2];
    if (name) scriptRefs.add(name);
  }
  assert.ok(scriptRefs.size >= 1, `spec 未关联任何具体验证脚本: mobile-runtime/specs/${file}`);

  for (const name of scriptRefs) {
    assert.ok(
      existsSync(resolve(buildDir, name)),
      `spec ${file} 引用了不存在的验证脚本: mobile-runtime/build/${name}`,
    );
    totalRefs++;
  }
}

console.log(`specs-verify-check: PASS (${specs.length} 份规格全部具备验证映射，共校验 ${totalRefs} 条脚本引用)`);
