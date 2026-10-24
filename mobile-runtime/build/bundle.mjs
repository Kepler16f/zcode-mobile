// M1/M2 打包入口：@zcode/core → 一个能在浏览器/WebView 里 import 的 ESM bundle。
// 用法：node mobile-runtime/build/bundle.mjs [--dev]
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { compatPlugin } from "../compat/build-plugin.mjs";
import { buildToyboxRegistry } from "./gen-toybox-registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const cliRoot = path.join(root, "zcode/apps/zcode-cli");
const esbuild = createRequire(path.join(cliRoot, "package.json"))("esbuild");

// 每次打包都重新生成：裁过的 registry 要是能留在磁盘上过夜，下一次真机清单变了也不会有人发现。
const trimmedRegistry = buildToyboxRegistry();

const dev = process.argv.includes("--dev");
const outfile = path.join(here, "dist/zcode-core.mobile.js");

const result = await esbuild.build({
  entryPoints: [path.join(here, "entry.mjs")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: !dev,
  sourcemap: dev ? "inline" : false,
  metafile: true,
  logLevel: "warning",
  // typescript 只在动态工作流编译器里用，端侧按需异步加载，不进主 bundle（见 §1.5.1 体积表）。
  external: ["typescript"],
  // 浏览器没有全局 Buffer，Glob/二进制分支直接用裸标识符。
  inject: [path.join(root, "mobile-runtime/compat/prelude.mjs")],
  plugins: [compatPlugin({ external: ["typescript"], bashRegistryOverride: trimmedRegistry.file })],
});

// 裁过的 registry 要是被别的路径又引进来（比如某个 barrel 直接 import 生成文件的绝对路径），
// bundle 会安静地变回 2 MB 而没有任何一条日志说明为什么。所以这里断言，而不是靠人眼比对体积。
const upstreamRegistry = Object.keys(result.metafile.inputs).filter(
  (k) => /generated[\\/]bash-command-registry\.js$/.test(k),
);
if (upstreamRegistry.length > 0) {
  throw new Error(`bash-command-registry 的裁剪没生效，上游整份还在 bundle 里：${upstreamRegistry.join(", ")}`);
}

const out = result.metafile.outputs[path.relative(process.cwd(), outfile).replace(/\\/g, "/")]
  ?? Object.values(result.metafile.outputs)[0];

// sql.js 的 emscripten 胶水不进 bundle：它靠 scriptDirectory 自己定位 .wasm，
// 打包后那段路径探测会指向不存在的位置。当普通 <script> 载入最省事，也让 655 KB 的
// wasm 能独立缓存。
const fsp = await import("node:fs/promises");
for (const f of ["sql-wasm.js", "sql-wasm.wasm"]) {
  await fsp.copyFile(path.join(root, "mobile-runtime/vendor", f), path.join(here, "dist", f));
}
const inputs = Object.entries(result.metafile.inputs)
  .filter(([k]) => !k.includes("compat/"))
  .map(([k, v]) => [k, v.bytesInBundle ?? v.bytes])
  .sort((a, b) => b[1] - a[1])
  .slice(0, 8);

// 图标安全区属于"装到手机上才发现缺角"那类问题：换个字形比例、加个密度目录都可能悄悄越线，
// 所以每次打包都让 check-icons.mjs 把真实像素重新量一遍，不靠人眼比对。
const { execFileSync } = await import("node:child_process");
try {
  execFileSync(process.execPath, [path.join(here, "check-icons.mjs")], { stdio: "pipe" });
} catch (e) {
  throw new Error(
    "图标安全区校验没过，这个包不该带着这套图标出货：\n" +
      (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? ""),
  );
}

process.stdout.write(
  `bundle: ${(out.bytes / 1024 / 1024).toFixed(2)} MB  gzip: ${((out.gzipBytes ?? 0) / 1024 / 1024).toFixed(2)} MB\n` +
    // registry 被换掉了就不会出现在 top-8 里，那正是这条要单独报的原因。
    `bash-registry: ${trimmedRegistry.keptKeys}/${trimmedRegistry.upstreamKeys} 条命令保留 ` +
    `(${(trimmedRegistry.upstreamBytes / 1024 / 1024).toFixed(2)} MB → ${(trimmedRegistry.trimmedBytes / 1024).toFixed(1)} KB)\n` +
    inputs.map(([k, b]) => `  ${(b / 1024).toFixed(0).padStart(6)} KB  ${k.replace(/^.*?(packages|node_modules)\//, "")}`).join("\n") +
    "\n",
);
