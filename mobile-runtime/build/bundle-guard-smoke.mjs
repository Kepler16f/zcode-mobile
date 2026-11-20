/**
 * A-01..A-05 构建守门与包体优化验收测试：
 *   1. 验证 dist-ui 通过全套守门检查（无 >100KB 内联 base64、59/59 字体对齐、无未允许 Shiki 语言、无重复模块、总大小 <= 上限）；
 *   2. 构造反向夹具验证守门逻辑会在“重复产物 / 缺字体 / 孤立多余字体 / >100KB base64 / 超白名单语言 / 超体积”时可靠阻断。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertMobileUiBundleIntegrity } from "./bundle-guards.mjs";
import { MOBILE_SHIKI_LANG_WHITELIST } from "./mobile-ui-assets.mjs";

const distUi = fileURLToPath(new URL("./dist-ui/", import.meta.url));
const cssText = readFileSync(path.join(distUi, "zcode-ui.css"), "utf8");
const actual = assertMobileUiBundleIntegrity({
  outdir: distUi,
  cssText,
  languageWhitelist: MOBILE_SHIKI_LANG_WHITELIST,
  maxTotalBytes: 25 * 1024 * 1024,
});
assert.ok(actual.cssAssetCount >= 59, "正式 CSS 本地资源应包含全部 KaTeX 字体");

const shikiOnigBytes = readFileSync(path.join(distUi, "assets/shiki-onig.wasm")).byteLength;
assert.ok(shikiOnigBytes > 400_000, "oniguruma WASM 应已抽出为独立 .wasm 资产");

// 负向夹具：证明每一条守门都能在违规时立刻报错。
const tmp = mkdtempSync(path.join(os.tmpdir(), "azcode-guard-"));
try {
  const dir = path.join(tmp, "dist");
  mkdirSync(path.join(dir, "assets"), { recursive: true });
  writeFileSync(path.join(dir, "assets/KaTeX_A.woff2"), "font-a");
  writeFileSync(path.join(dir, "entry.js"), "console.log(1);");

  // 正向通过基线
  const okCss = "@font-face{src:url(./assets/KaTeX_A.woff2)}";
  assertMobileUiBundleIntegrity({ outdir: dir, cssText: okCss, maxTotalBytes: 10_000 });

  // ① 多余孤立字体失败
  writeFileSync(path.join(dir, "assets/KaTeX_Extra.woff2"), "font-extra");
  assert.throws(
    () => assertMobileUiBundleIntegrity({ outdir: dir, cssText: okCss }),
    /多余字体.*KaTeX_Extra\.woff2/,
  );
  rmSync(path.join(dir, "assets/KaTeX_Extra.woff2"));

  // ② 缺 CSS 引用资源失败
  assert.throws(
    () =>
      assertMobileUiBundleIntegrity({
        outdir: dir,
        cssText: "@font-face{src:url(./assets/KaTeX_Missing.woff2)}",
      }),
    /缺失.*KaTeX_Missing\.woff2/,
  );

  // ③ 同名多份同哈希副本失败
  writeFileSync(path.join(dir, "chunk-AAAAAAAA.js"), "export const x = 1;");
  writeFileSync(path.join(dir, "chunk-BBBBBBBB.js"), "export const x = 1;");
  assert.throws(
    () => assertMobileUiBundleIntegrity({ outdir: dir, cssText: okCss }),
    /重复产物/,
  );
  rmSync(path.join(dir, "chunk-AAAAAAAA.js"));
  rmSync(path.join(dir, "chunk-BBBBBBBB.js"));

  // ④ >100KB 内联 base64 JS 失败
  writeFileSync(path.join(dir, "big.js"), `const b = atob("${"A".repeat(145_000)}");`);
  assert.throws(
    () => assertMobileUiBundleIntegrity({ outdir: dir, cssText: okCss }),
    />100KB 内联 base64/,
  );
  rmSync(path.join(dir, "big.js"));

  // ⑤ 超出 Shiki 语言白名单失败
  assert.throws(
    () =>
      assertMobileUiBundleIntegrity({
        outdir: dir,
        cssText: okCss,
        languageWhitelist: MOBILE_SHIKI_LANG_WHITELIST,
        metafile: { inputs: { "node_modules/@shikijs/langs/dist/wolfram.mjs": {} } },
      }),
    /超出移动端白名单.*wolfram/,
  );

  // ⑥ 超总体积上限失败
  assert.throws(
    () => assertMobileUiBundleIntegrity({ outdir: dir, cssText: okCss, maxTotalBytes: 5 }),
    /体积超上限/,
  );

  console.log("bundle-guard-smoke: 6/6 负向拦截 + 真实产物校验 PASS");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
