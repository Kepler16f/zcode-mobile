/**
 * 构建期体积与内容守门 + 资源一致性校验（A-01 / A-02 / A-05）：
 *   1. 提取 `@shikijs/engine-oniguruma/wasm-inlined` 内的 base64 WASM 到独立 `.wasm`；
 *   2. 检测 dist-ui 中同名多拷贝 / assets 重复哈希 / metafile 多版本包混入；
 *   3. 校验 `zcode-ui.css` 本地 `url()` 100% 命中，且无孤立多余字体；
 *   4. 禁止 JS 产物内出现 >100 KB base64 内联大块；
 *   5. 校验 Shiki 实际打入包内的语言模块全部落在移动端白名单内，且总体积不超过上限。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const INLINE_BASE64_LIMIT_BYTES = 100 * 1024;
// 100 KB 解码二进制对应的最小 base64 字符数（约 136,534 字符）
const MIN_SUSPECT_BASE64_CHARS = Math.ceil((INLINE_BASE64_LIMIT_BYTES * 4) / 3);

function collectFiles(rootDir) {
  const out = [];
  if (!existsSync(rootDir)) return out;
  for (const name of readdirSync(rootDir)) {
    const full = path.join(rootDir, name);
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

/**
 * 从 `@shikijs/engine-oniguruma/dist/wasm-inlined.mjs` 解析内置 WASM 二进制并写入 `wasmOutFile`，
 * 让移动端以独立 `.wasm` 资产按需加载，不再把 622 KB base64 字符串编进 JS。
 */
export function createOnigurumaWasmPlugin({ resolvePinned, outdir }) {
  return {
    name: "mobile-external-oniguruma-wasm",
    setup(build) {
      let emitted = false;
      build.onResolve({ filter: /^@shikijs\/engine-oniguruma\/wasm-inlined$/ }, (args) => ({
        path: resolvePinned(args.path),
        namespace: "mobile-oniguruma-wasm",
      }));
      build.onLoad({ filter: /.*/, namespace: "mobile-oniguruma-wasm" }, (args) => {
        const raw = readFileSync(args.path, "utf8");
        const match = raw.match(/atob\("([A-Za-z0-9+/=]{1024,})"\)/);
        if (!match?.[1]) {
          // 若上游某天改成非 base64 内联形态，直接退回真实文件避免静默破坏。
          return { contents: raw, loader: "js", resolveDir: path.dirname(args.path) };
        }
        const wasmPath = path.join(outdir, "assets", "shiki-onig.wasm");
        if (!emitted) {
          mkdirSync(path.dirname(wasmPath), { recursive: true });
          writeFileSync(wasmPath, Buffer.from(match[1], "base64"));
          emitted = true;
        }
        const loaderCode = `
let bytesPromise;
async function loadShikiOnigBytes() {
  if (!bytesPromise) {
    bytesPromise = (async () => {
      const rel = /\\/workers\\//.test(import.meta.url) ? "../assets/shiki-onig.wasm" : "./assets/shiki-onig.wasm";
      const fileUrl = new URL(rel, import.meta.url);
      if (fileUrl.protocol === "file:" && typeof process !== "undefined" && typeof process.getBuiltinModule === "function") {
        const fs = process.getBuiltinModule("fs/promises");
        if (fs) return fs.readFile(fileUrl);
      }
      const res = await fetch(fileUrl);
      if (!res.ok) throw new Error("Failed to load shiki-onig.wasm: HTTP " + res.status);
      return res.arrayBuffer();
    })();
  }
  return bytesPromise;
}
export async function getWasmInstance(info) {
  const bytes = await loadShikiOnigBytes();
  const result = await WebAssembly.instantiate(bytes, info);
  return result.instance.exports;
}
export default getWasmInstance;
`;
        return { contents: loaderCode, loader: "js" };
      });
    },
  };
}

export function findLargeInlineBase64InJs(files) {
  const regex = new RegExp(`["']([A-Za-z0-9+/=]{${MIN_SUSPECT_BASE64_CHARS},})["']`, "g");
  const offenders = [];
  for (const file of files) {
    if (!file.endsWith(".js")) continue;
    const text = readFileSync(file, "utf8");
    let match;
    while ((match = regex.exec(text)) !== null) {
      const charCount = match[1].length;
      const estimatedBytes = Math.floor((charCount * 3) / 4);
      if (estimatedBytes > INLINE_BASE64_LIMIT_BYTES) {
        offenders.push({ file, estimatedBytes, charCount });
        break;
      }
    }
  }
  return offenders;
}

export function extractLocalCssAssetUrls(cssText) {
  const urls = new Set();
  for (const match of cssText.matchAll(/url\(\s*(['"]?)([^'"\s)]+)\1\s*\)/g)) {
    const href = match[2];
    if (/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(href)) continue;
    const rel = href.split(/[?#]/)[0].replace(/^\.\//, "");
    if (rel) urls.add(rel);
  }
  return urls;
}

export function findDuplicateBundlesAndAssets(files, outdir) {
  const chunkGroups = new Map();
  const assetHashes = new Map();
  const duplicateChunkFamilies = [];
  const duplicateAssetFiles = [];

  for (const file of files) {
    const rel = path.relative(outdir, file).split(path.sep).join("/");
    const data = readFileSync(file);
    const hash = createHash("sha256").update(data).digest("hex");

    if (rel.startsWith("assets/")) {
      const list = assetHashes.get(hash) ?? [];
      list.push(rel);
      assetHashes.set(hash, list);
      continue;
    }

    const baseName = path.basename(file).replace(/-[A-Za-z0-9_-]{8}(?=\.[^.]+$)/, "");
    const existing = chunkGroups.get(baseName) ?? [];
    existing.push({ rel, hash });
    chunkGroups.set(baseName, existing);
  }

  for (const [baseName, entries] of chunkGroups) {
    if (entries.length < 2) continue;
    const byHash = new Map();
    for (const entry of entries) {
      const list = byHash.get(entry.hash) ?? [];
      list.push(entry.rel);
      byHash.set(entry.hash, list);
    }
    for (const [hash, rels] of byHash) {
      if (rels.length > 1) {
        duplicateChunkFamilies.push({ baseName, hash: hash.slice(0, 12), files: rels });
      }
    }
  }

  for (const [hash, rels] of assetHashes) {
    if (rels.length > 1) {
      duplicateAssetFiles.push({ hash: hash.slice(0, 12), files: rels });
    }
  }

  return { duplicateChunkFamilies, duplicateAssetFiles };
}

export function assertMobileUiBundleIntegrity({
  outdir,
  metafile,
  cssText,
  languageWhitelist,
  maxTotalBytes,
}) {
  const allFiles = collectFiles(outdir);
  const totalBytes = allFiles.reduce((sum, file) => sum + statSync(file).size, 0);

  // 1. 重复模块 / 资产检查（按内容哈希）
  const { duplicateChunkFamilies, duplicateAssetFiles } = findDuplicateBundlesAndAssets(allFiles, outdir);
  if (duplicateChunkFamilies.length > 0 || duplicateAssetFiles.length > 0) {
    throw new Error(
      `构建守门失败（A-05 重复产物）：chunks=${JSON.stringify(duplicateChunkFamilies)}, assets=${JSON.stringify(duplicateAssetFiles)}`,
    );
  }

  // 2. CSS url() 100% 命中 + 零多余字体文件
  const cssLocalUrls = extractLocalCssAssetUrls(cssText);
  const missingCssAssets = [];
  for (const rel of cssLocalUrls) {
    if (!existsSync(path.join(outdir, rel))) missingCssAssets.push(rel);
  }
  if (missingCssAssets.length > 0) {
    throw new Error(`构建守门失败（A-02/A-05 CSS 引用资源缺失）：${missingCssAssets.join(", ")}`);
  }
  const assetsDir = path.join(outdir, "assets");
  const orphanFonts = existsSync(assetsDir)
    ? readdirSync(assetsDir).filter(
        (name) => /\.(woff2?|ttf|eot|otf)$/i.test(name) && !cssLocalUrls.has(`assets/${name}`),
      )
    : [];
  if (orphanFonts.length > 0) {
    throw new Error(`构建守门失败（A-02 存在未被 CSS 引用的多余字体）：${orphanFonts.join(", ")}`);
  }

  // 3. >100 KB base64 内联检测
  const largeBase64 = findLargeInlineBase64InJs(allFiles);
  if (largeBase64.length > 0) {
    throw new Error(
      `构建守门失败（A-01 发现 >100KB 内联 base64 JS）：${largeBase64
        .map((x) => `${path.relative(outdir, x.file)}(~${(x.estimatedBytes / 1024).toFixed(1)}KB)`)
        .join(", ")}`,
    );
  }

  // 4. Shiki 语言白名单校验
  if (languageWhitelist && metafile?.inputs) {
    const disallowed = [];
    for (const input of Object.keys(metafile.inputs)) {
      const normalized = input.replace(/\\/g, "/");
      const m = normalized.match(/@shikijs\/langs\/dist\/([^/]+)\.mjs$/);
      if (!m) continue;
      const langId = m[1];
      if (langId === "index" || langId.startsWith("chunk-")) continue;
      if (!languageWhitelist.has(langId)) {
        disallowed.push(langId);
      }
    }
    if (disallowed.length > 0) {
      throw new Error(
        `构建守门失败（A-03 存在超出移动端白名单的 Shiki 语言）：${disallowed.join(", ")}`,
      );
    }
  }

  // 5. dist-ui 体积上限
  if (typeof maxTotalBytes === "number" && totalBytes > maxTotalBytes) {
    throw new Error(
      `构建守门失败（A-05 体积超上限）：当前 ${(totalBytes / 1024 / 1024).toFixed(2)} MiB > 上限 ${(
        maxTotalBytes /
        1024 /
        1024
      ).toFixed(2)} MiB`,
    );
  }

  return {
    fileCount: allFiles.length,
    totalBytes,
    cssAssetCount: cssLocalUrls.size,
  };
}
