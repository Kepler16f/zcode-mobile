// M1 探针：把 @zcode/core 打成浏览器 bundle，并输出「垫片必须覆盖的 node: 模块清单」。
// 清单本身就是 mobile-compat 的工作范围，不靠 grep 猜。
import path from "node:path";
import { builtinModules, createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(here, "../../zcode/apps/zcode-cli");
// esbuild 装在 CLI 工作区里，不在本目录，按那个位置解析。
const { build } = createRequire(path.join(cliRoot, "package.json"))("esbuild");
const used = new Set();

// 上游有两种写法混用：`node:vm` 与裸 `async_hooks`，都得拦。
const bare = new Set(builtinModules);
const nodeShim = {
  name: "node-shim",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      const name = args.path.replace(/^node:/, "");
      if (!bare.has(name) && !args.path.startsWith("node:")) return undefined;
      used.add(args.path);
      return { path: args.path, namespace: "node-shim" };
    });
    b.onLoad({ filter: /.*/, namespace: "node-shim" }, () => ({
      // 用 cjs + Proxy 而不是 ES module：ES module 缺具名导出会直接编译报错，
      // 而 spike 阶段要的是「能不能打成一个包」，不是「垫片写全了没有」。
      contents:
        "module.exports = new Proxy({}, { get: () => function shimmed(){ throw new Error('node builtin not implemented'); } });",
      loader: "js",
    }));
  },
};

const result = await build({
  entryPoints: [path.join(cliRoot, "packages/core/dist/index.js")],
  bundle: true,
  minify: true, // 不压缩的话 typescript 这种单文件会虚高 4–5 倍，测出的体积对端侧没有意义
  platform: "browser",
  format: "esm",
  target: "es2022",
  outfile: path.join(here, "core.browser.js"),
  logLevel: "warning",
  metafile: true,
  plugins: [nodeShim],
});

const modules = Object.keys(result.metafile.inputs).length;
const stats = await import("node:fs/promises").then((fs) =>
  fs.stat(path.join(here, "core.browser.js")),
);

// 17 MB 不是核心本身的体积：按字节找出最大贡献者，决定哪些该 externalize。
const top = Object.entries(result.metafile.inputs)
  .map(([k, v]) => [k, v.bytesInBundle ?? v.bytes])
  .sort((a, b) => b[1] - a[1])
  .slice(0, 12);

process.stdout.write(
  JSON.stringify(
    {
      modules,
      bundleKB: Math.round(stats.size / 1024),
      topContributorsKB: top.map(([k, b]) => [
        Math.round(b / 1024),
        k.replace(/^.*node_modules\//, "").slice(0, 60),
      ]),
      nodeBuiltins: [...used].sort(),
    },
    null,
    1,
  ) + "\n",
);
