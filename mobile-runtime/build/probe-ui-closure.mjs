// 探测"把真 UI + services 层拉进端侧 bundle"到底要付多少债：
// 不为出货，只为把未知的闭包变成数字。node:* 缺失一律记进清单而不是中断，因为清单本身就是结论。
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { compatPlugin, SHIMS } from "../compat/build-plugin.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const zcodeRoot = path.join(root, "zcode");
const esbuild = createRequire(path.join(zcodeRoot, "apps/zcode-cli/package.json"))("esbuild");

// 从哪个入口探，就量哪一层。三层分开量，才知道债务集中在哪。
const LAYERS = {
  // resolveDir 必须是"真的依赖它的那个包"：workspace 包名没有根级 node_modules 链接，
  // 只有各包自己的 node_modules/@zcode/* 软链，从仓库根解析一律 404。
  ui: { code: `import "@zcode/ui";`, dir: "packages/web" },
  client: { code: `import "@zcode/client";`, dir: "packages/web" },
  services: { code: `import "@zcode/services/node";`, dir: "packages/services" },
  // 组合根要的是 descriptor / 接口标识这些"名字"，不是 node.ts 那套 Node 装配。
  // 根 index 若自带 Node-only 依赖，深引 descriptors 就得另找入口。
  services_root: { code: `import "@zcode/services";`, dir: "packages/services" },
  server: { code: `import "@zcode/server";`, dir: "packages/server" },
  // 单个服务能不能"原样搬"，看的是它自己的闭包里有几个 Node-only 依赖，不是它属于哪个包。
  svc_setting: { code: `import { createSettingService } from "./src/setting/settingService.js"; console.log(createSettingService);`, dir: "packages/services" },
  svc_file: { code: `import { createFileService } from "./src/file/fileService.js"; console.log(createFileService);`, dir: "packages/services" },
};

const entry = process.argv[2] ?? "ui";
// `svc:setting/settingService.js` —— 逐个服务探，而不是只探那个装配好的整体：
// 根 index 故意只导标识符和类型（上游在 services/src/index.ts:88 写了原因），
// 工厂实现得按文件路径深引，能不能原样搬要看它自己的闭包里有几个 Node-only 依赖。
if (entry.startsWith("svc:")) {
  const rel = entry.slice(4);
  LAYERS[entry] = {
    code: `import * as m from "./src/${rel}"; console.log(Object.keys(m));`,
    dir: "packages/services",
  };
}
const layer = LAYERS[entry];
if (!layer) {
  console.log("layer 选项: " + [...Object.keys(LAYERS), "svc:<相对 services/src 的路径>"].join(" / "));
  process.exit(1);
}
const missing = new Map();
// 已有垫片的内置模块要让 compatPlugin 正常解析，探针只兜"没有垫片的"，
// 否则量出来的债全是假的（第一版就栽在这里：连 node:fs/promises 都被自己 stub 掉了）。
const SHIMMED = new Set(Object.keys(SHIMS));

const probe = {
  name: "zcode-mobile-closure-probe",
  setup(b) {
    b.onResolve({ filter: /^node:/ }, (a) => {
      const name = a.path.slice(5);
      if (SHIMMED.has(name)) return undefined;
      missing.set(name, (missing.get(name) ?? 0) + 1);
      return { path: a.path, namespace: "node-stub" };
    });
    b.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
      contents: "export default {}; export const __stub = 1;",
      loader: "js",
    }));
  },
};

// 上游 UI 里两处用 Vite 的 `?url` 后缀引 worker/wasm —— 语义是"给我一个 URL 字符串"，
// 不是"把这个模块 import 进来"。探测阶段先按字符串落地，别把 worker 打进主包。
const qurl = {
  name: "vite-url-suffix",
  setup(b) {
    b.onResolve({ filter: /\?url$/ }, (a) => ({ path: a.path.replace(/\?url$/, ""), namespace: "asset-url" }));
    b.onLoad({ filter: /.*/, namespace: "asset-url" }, (a) => ({
      contents: `export default ${JSON.stringify("/assets/" + path.basename(a.path))};`,
      loader: "js",
    }));
  },
};

let result;try {
  result = await esbuild.build({
    stdin: { contents: layer.code, resolveDir: path.join(zcodeRoot, layer.dir), loader: "ts", sourcefile: `probe-${entry}.ts` },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    metafile: true,
    logLevel: "silent",
    // 端侧要自带真 UI，静态资源就得有归宿：这些 loader 与上游 Vite 的处理等价，
    // 先按最省事的内联/落盘方式量出闭包，别在探测阶段纠结产物形态。
    // 上游源码按 Node ESM 惯例写 ".js"、实际文件是 .ts/.tsx：esbuild 在 .ts 文件里发起的
    // import 上原生就做这个重映射（与 tsc 的行为一致），所以不需要 extensionAlias
    // （这个 esbuild 版本的 build() 白名单里根本没有这个键，写上去只会 Invalid option）。
    outdir: path.join(here, "probe-out"),
    loader: {
      ".svg": "file", ".png": "file", ".jpg": "file", ".jpeg": "file", ".gif": "file",
      ".webp": "file", ".mp3": "file", ".woff": "file", ".woff2": "file", ".ttf": "file",
      ".css": "css", ".wasm": "file",
    },
    plugins: [probe, qurl, compatPlugin()],
  });
} catch (e) {
  const errs = (e.errors ?? []).slice(0, 25).map((x) => `  [${x.text}] ${x.location?.file ?? "?"}:${x.location?.line ?? "?"}`);
  console.log(`layer=${entry} BUILD-FAILED errors=${(e.errors ?? []).length} :: ${String(e?.message ?? e).slice(0, 200)}`);
  console.log(errs.join("\n"));
  process.exit(0);
}

const inputs = Object.entries(result.metafile.inputs);
const bytes = (v) => v.bytesInBundle ?? v.bytes;
const byPkg = new Map();
for (const [k, v] of inputs) {
  const pkg = k.replace(/^.*?(node_modules\/)?/, "").split("/").slice(0, k.startsWith("node_modules") ? 2 : 2).join("/");
  byPkg.set(pkg, (byPkg.get(pkg) ?? 0) + bytes(v));
}
const outBytes = result.outputFiles.reduce((a, f) => a + f.contents.length, 0);
console.log(`layer=${entry}  modules=${inputs.length}  outputs=${result.outputFiles.length}  bundle=${(outBytes / 1024 / 1024).toFixed(2)} MB`);
console.log("  缺失的 node 垫片（次数）: " + [...missing.entries()].sort((a, b2) => b2[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(", ") || "  无");
console.log("  top 12 目录:");
for (const [k, v] of [...byPkg.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 12)) {
  console.log(`   ${(v / 1024).toFixed(0).padStart(7)} KB  ${k}`);
}
