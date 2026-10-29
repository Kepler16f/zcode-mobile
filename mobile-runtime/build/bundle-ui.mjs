// 把真 UI 打成端侧能跑的产物：mobile-runtime/ui/entry.tsx → dist-ui/。
// 与 bundle.mjs（runtime 那一份）分开，是为了先不动已经出货 0.0.4 的那条链路；
// 代价是 vfs/sqlite 会在两个 bundle 里各有一份，合并成一次 split 构建是后话（见 PORTING §1.5.14）。
import path from "node:path";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { compatPlugin } from "../compat/build-plugin.mjs";
import { buildToyboxRegistry } from "./gen-toybox-registry.mjs";
import {mobileShikiDependency,mobileDiffsWorker,relocateCssAssets,assertShikiConsistency} from "./mobile-ui-assets.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const zcodeRoot = path.join(root, "zcode");
const cliRoot = path.join(zcodeRoot, "apps/zcode-cli");
const esbuild = createRequire(path.join(cliRoot, "package.json"))("esbuild");
// postcss 与 esbuild 同一个来源：mobile-runtime 没有自己的 node_modules，借上游那份。
const postcss = createRequire(path.join(cliRoot, "package.json"))("postcss");
const { rebindDarkToClass } = await import(new URL("./rebind-dark.mjs", import.meta.url).href);
const uiSrc = path.join(zcodeRoot, "packages/ui/src");
const servicesSrc = path.join(zcodeRoot, "packages/services/src");

const dev = process.argv.includes("--dev");
// 单独重打界面也必须与完整构建采用同一环境，避免上游loader缺省为test。
const buildEnvironment = process.env.ZCODE_ENV?.trim().toLowerCase() || "production";
if (buildEnvironment !== "production" && buildEnvironment !== "test") throw new Error("ZCODE_ENV 只能是 production 或 test");
process.env.ZCODE_ENV = buildEnvironment;
const outdir = path.join(here, "dist-ui");

// services/src/index.ts:88 写明根入口故意不导工厂，所以上游自己也是按实现文件路径深引的
// （desktop host、node.ts、测试都是）。`@zcode/services/deep/<相对 src>` 是同一个惯例，
// 只是包 exports 白名单不允许，所以在这里映射到真实文件。
const DEEP_PREFIX = "@zcode/services/deep/";
const EXTS = [".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx", "/index.js"];

function resolveDeep(rel) {
  const noExt = path.join(servicesSrc, rel).replace(/\.js$/, "");
  const candidates = [...EXTS.map((e) => noExt + e), path.join(servicesSrc, rel)];
  return candidates.find((c) => existsSync(c)) ?? null;
}

const deepImport = {
  name: "zcode-services-deep",
  setup(b) {
    b.onResolve({ filter: /^@zcode\/services\/deep\// }, (a) => {
      const resolved = resolveDeep(a.path.slice(DEEP_PREFIX.length));
      if (!resolved) {
        return { errors: [{ text: `deep-import: 找不到 ${a.path}（services/src 下没有这个文件）` }] };
      }
      return { path: resolved };
    });
  },
};

// 上游是 Vite 项目：`?url` 的语义是"给我一个该资源的 URL"，不是"把这个资源 import 进来"。
// pdf.js 的 worker/wasm 就是这么引的，不拦的话 esbuild 会把它当模块解析并失败。
const assetUrl = {
  name: "vite-url-suffix",
  setup(b) {
    b.onResolve({ filter: /\?url$/ }, (a) => ({ path: a.path.replace(/\?url$/, ""), namespace: "asset-url" }));
    b.onLoad({ filter: /.*/, namespace: "asset-url" }, (a) => ({
      contents: `export default ${JSON.stringify("./assets/" + path.basename(a.path))};`,
      loader: "js",
    }));
  },
};

const trimmedRegistry = buildToyboxRegistry();
const shikiDependency=mobileShikiDependency(zcodeRoot);
const diffsWorker=mobileDiffsWorker(zcodeRoot);

// 随包模型清单：直接调上游构建脚本，不在这里重新实现"读哪个 env、校验哪套 schema"。
// 它失败就让构建失败——宁可构建报错，也不要装到手机上才发现模型列表是空的。
const { loadBuiltinProviderConfig } = await import(
  new URL("../../zcode/scripts/builtin-provider-config.mjs", import.meta.url).href
);
const zcodeBuiltin = await loadBuiltinProviderConfig({ root: zcodeRoot });
console.log(`内置 Provider 配置：env=${zcodeBuiltin.environment} revision 内容 ${zcodeBuiltin.content.length} B`);

// 每次先清空产物目录：splitting 的输出名带内容哈希，--dev 与正式构建混在同一个目录里时，
// 上一轮的 chunk 会一直留在磁盘上被复制进 APK。0.0.3 的教训正是"包内内容与源码不一致"（§9），
// 而那种不一致一旦安静发生，只有装机才能发现。
//
// 为什么逐个子项删而不是 rmSync(dir)：调试时浏览器（或任何把 dist-ui 当 CWD 的 shell）会让
// **目录本身**变成 EPERM，而里面的文件照样能删。整目录删失败时崩在这里，等于把"改一行等三分钟"
// 变成"改一行先手动收尾"。删不掉的只剩目录句柄本身，下一轮 mkdir 会原样复用。
clearOutdir(outdir);
mkdirSync(outdir, { recursive: true });

function clearOutdir(dir) {
  // 目录可能压根不存在（干净检出、或上一轮被人工删掉）。这不是异常，直接让下面的 mkdir 建它。
  if (!existsSync(dir)) return;
  const failures = [];
  for (const name of readdirSync(dir)) {
    try {
      rmSync(path.join(dir, name), { recursive: true, force: true, maxRetries: 2 });
    } catch (e) {
      failures.push(`${name}: ${e.code ?? e.message}`);
    }
  }
  // 旧哈希文件删不掉时不能继续：否则新旧资源会同时进入 APK，体积随构建增长。
  if (failures.length) throw new Error(`dist-ui 里有 ${failures.length} 项删不掉（宿主占用）：${failures.slice(0, 3).join(", ")}`);
}

const result = await esbuild.build({
  entryPoints: {entry:path.join(root,"mobile-runtime/ui/entry.tsx"),"workers/diffs.worker":diffsWorker.entry},
  outdir,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  minify: !dev,
  sourcemap: dev ? "inline" : false,
  metafile: true,
  logLevel: "warning",
  external: ["typescript"],
  inject: [path.join(root, "mobile-runtime/compat/prelude.mjs")],
  // packages/ui 的源码内部用 @/ 自引用（tsconfig paths + 上游 Vite 的 resolve.alias 都是这么配的），
  // 这里按同样的方式补上，不改上游一个文件。
  // （isomorphic-git 的浏览器产物改由 git-tool.ts 相对路径直引 UMD——alias 前缀匹配会连
  // "isomorphic-git/http/web" 子路径一起改写，反而打不开。）
  alias: { "@": uiSrc },
  // 组合根的源文件在 mobile-runtime/ 下，而 workspace 包名只在各包自己的 node_modules 里有软链
  // （仓库根没有 hoisted @zcode/*）。pnpm 的链接是"谁依赖谁才有"，所以要把真的依赖方都列进来：
  // web 有 ui/client/shared，client 有 rpc/services，缺一个就是"Cached package not found on disk"那种假错误。
  nodePaths: [
    path.join(zcodeRoot, "packages/web/node_modules"),
    path.join(zcodeRoot, "packages/client/node_modules"),
    path.join(zcodeRoot, "packages/services/node_modules"),
    path.join(zcodeRoot, "node_modules"),
  ],
  define: {
    "import.meta.env.DEV": String(dev),
    "import.meta.env.PROD": String(!dev),
    "import.meta.env.BASE_URL": '"./"',
    "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production"),
    // 随包的 ZCode Built-in Provider Config：和上游 server 用同一个 loader、同一个符号
    // （packages/server/tsup.config.ts:23），loader 会在构建期跑一遍 Release schema 校验，
    // 所以"打包成功但模型清单是坏的"这种问题在构建这一步就炸，不会等到装机才发现。
    __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: JSON.stringify(zcodeBuiltin.content),
  },
  loader: {
    ".svg": "file", ".png": "file", ".jpg": "file", ".jpeg": "file", ".gif": "file",
    ".webp": "file", ".mp3": "file", ".woff": "file", ".woff2": "file", ".ttf": "file",
    ".wasm": "file", ".css": "css",
  },
  plugins: [deepImport, assetUrl, shikiDependency.plugin, diffsWorker.plugin, compatPlugin({ external: ["typescript"], bashRegistryOverride: trimmedRegistry.file })],
});

// 和 bundle.mjs 同一条断言：registry 裁剪要是被别的路径又引进来，bundle 会安静地涨回 5 MB。
const upstreamRegistry = Object.keys(result.metafile.inputs).filter((k) =>
  /generated[\\/]bash-command-registry\.js$/.test(k),
);
// 把模块图落盘：版本混搭这类问题只有在「每个包实际解析到哪个绝对路径」这层才看得见，
// 光看产物文件看不出 shiki/@shikijs 到底进了哪个实例。
if (process.env.ZCODE_UI_METAFILE) {
  const fspMeta = await import("node:fs/promises");
  await fspMeta.mkdir(path.dirname(process.env.ZCODE_UI_METAFILE), { recursive: true });
  await fspMeta.writeFile(process.env.ZCODE_UI_METAFILE, JSON.stringify(result.metafile, null, 2));
  console.log(`模块图：${process.env.ZCODE_UI_METAFILE}`);
}
const languageInputs=Object.keys(result.metafile.inputs).filter(k=>/[/\\]@shikijs[/\\]langs[/\\]/.test(k));
if(languageInputs.some(k=>!path.resolve(k).startsWith(shikiDependency.languageRoot+path.sep))) {
  throw new Error("Shiki语言资源重复实例重新进入移动模块图");
}
// 全量核对：只查 langs 是不够的——core/transformers/themes 混进来同样会让
// 高亮器在运行时才炸。这里按包名逐个核对版本，混搭直接让构建失败。
const shikiVersions=assertShikiConsistency(zcodeRoot,Object.keys(result.metafile.inputs));
console.log(`移动Shiki依赖：${shikiDependency.version}，语言模块 ${languageInputs.length} 个，单一依赖根`);
console.log(`移动Shiki版本集：${shikiVersions.join(", ")}`);
if(!Object.values(result.metafile.outputs).some(output=>Object.entries(output.inputs??{}).some(([name,info])=>
  /@pierre[/\\]diffs[/\\]dist[/\\]worker[/\\]worker\.js$/.test(name)&&info.bytesInOutput>0))) {
  throw new Error("高亮Worker消息处理器被tree-shaking移除，不能发布空Worker");
}
if (upstreamRegistry.length > 0) {
  throw new Error(`bash-command-registry 的裁剪没生效：${upstreamRegistry.join(", ")}`);
}

const outputs = Object.entries(result.metafile.outputs)
  .map(([k, v]) => ({ k, bytes: v.bytesInBundle ?? v.bytes, kind: v.kind }))
  .sort((a, b) => b.bytes - a.bytes);
const totalJs = outputs.filter((o) => o.kind !== "asset" && !/\.css$/.test(o.k)).reduce((a, o) => a + o.bytes, 0);

const fsp = await import("node:fs/promises");
for (const f of ["sql-wasm.js", "sql-wasm.wasm"]) {
  await fsp.copyFile(path.join(root, "mobile-runtime/vendor", f), path.join(outdir, f));
}
// typescript 是 external（动态工作流编译器按需异步加载），importmap 指向的那份 stub 要跟着产物走。
await fsp.mkdir(path.join(outdir, "shims"), { recursive: true });
await fsp.copyFile(path.join(here, "dist/shims/typescript-stub.js"), path.join(outdir, "shims/typescript-stub.js"));
await fsp.copyFile(path.join(root, "mobile-runtime/ui/ui.html"), path.join(outdir, "ui.html"));
// 文件图标（material-icons）：fileDisplay.tsx 按 BASE_URL 解析到 ./material-icons/<name>.svg，
// 上游这份资源在 packages/web/public，Vite 会拷进 dist，但我们的 dist-ui 是自己组的——不拷
// 就是每个文件行/工具卡都 404 一张图（0.4.3 的工具卡 e2e 第一次把它拍到：document.svg ×3）。
// 整目录复制（~2.6 MB，SVG 压缩后 APK 增量很小）而不是按名字挑：挑列表会在上游加新图标映射时
// 悄悄退化成 404，而这份东西和上游 web 端出货的本来就是同一目录。
const materialIcons = path.join(zcodeRoot, "packages/web/dist/material-icons");
if (existsSync(materialIcons)) {
  await fsp.cp(materialIcons, path.join(outdir, "material-icons"), { recursive: true });
} else {
  throw new Error("packages/web/dist/material-icons 不存在：先构建上游 Web，不能打出缺失图标的包");
}
// Tailwind 产物：上游 Vite 生成的那一份 css，按名字找（哈希在文件名里）。
const webDistAssets = path.join(zcodeRoot, "packages/web/dist/assets");
if (existsSync(webDistAssets)) {
  const names = await fsp.readdir(webDistAssets);
  const css = names.find((n) => /^index-.*\.css$/.test(n));
  if (css) {
    const raw = await fsp.readFile(path.join(webDistAssets, css), "utf8");
    // 深色模式重绑：Tailwind 的 dark: 工具类绑死 prefers-color-scheme，端侧主题走 .dark class，
    // 两边对不上（见 rebind-dark.mjs 头注）。这一步之后，App 里的主题选择才是屏幕的唯一真相。
    const rebound = await rebindDarkToClass(raw, {
      postcss,
      onDiagnostic: (d) => process.stderr.write(`[dark-rebind] ${d}\n`),
    });
    const assets=await relocateCssAssets({css:rebound,sourceCssFile:path.join(webDistAssets,css),
      sourceRoot:path.dirname(webDistAssets),outdir});
    await fsp.writeFile(path.join(outdir, "zcode-ui.css"), assets.css);
    console.log(`CSS本地资源完整复制：${assets.copied.length} 个`);
  } else throw new Error("packages/web/dist 里没有 Tailwind CSS：先构建上游 Web");
} else {
  throw new Error("packages/web/dist 不存在：先构建上游 Web");
}

process.stdout.write(
  `dist-ui: ${outputs.length} 个产物，JS 合计 ${(totalJs / 1024 / 1024).toFixed(2)} MB\n` +
    outputs.slice(0, 10).map((o) => `  ${(o.bytes / 1024).toFixed(0).padStart(7)} KB  ${path.basename(o.k)}`).join("\n") +
    "\n",
);
