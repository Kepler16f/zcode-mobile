// 决定 SessionStore 走哪条路的探针：把桌面那套 sqlite-session-store 塞进浏览器打包管线，
// 量它到底拖了多少 node 依赖、多大一团。结论写进 §3.3「存储」。
import path from "node:path";
import { builtinModules, createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(here, "../../zcode/apps/zcode-cli");
const { build } = createRequire(path.join(cliRoot, "package.json"))("esbuild");
const bare = new Set(builtinModules);
const used = new Set();

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
      contents:
        "module.exports = new Proxy({}, { get: () => function shimmed(){ throw new Error('node builtin not implemented'); } });",
      loader: "js",
    }));
  },
};

const target = path.join(
  cliRoot,
  "packages/adapters/src/storage/session-store/sqlite-session-store.ts",
);

try {
  const result = await build({
    entryPoints: [target],
    bundle: true,
    write: false,
    minify: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    logLevel: "silent",
    metafile: true,
    plugins: [nodeShim],
    absWorkingDir: cliRoot,
  });
  const inputs = Object.entries(result.metafile.inputs);
  const bytes = result.outputFiles[0].contents.byteLength;
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        bundleKB: Math.round(bytes / 1024),
        modules: inputs.length,
        nodeBuiltins: [...used].sort(),
        topContributorsKB: inputs
          .map(([k, v]) => [k.replace(/^.*packages\//, ""), v.bytesInBundle ?? v.bytes])
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([k, b]) => [Math.round(b / 1024), k.slice(0, 64)]),
      },
      null,
      1,
    ) + "\n",
  );
} catch (e) {
  process.stdout.write(
    JSON.stringify(
      {
        ok: false,
        errorCount: (e?.errors ?? []).length,
        firstErrors: (e?.errors ?? []).slice(0, 20).map((x) =>
          x.text + (x.location?.file ? ` @ ${x.location.file.replace(/^.*packages\//, "")}:${x.location.line}` : "")),
        nodeBuiltins: [...used].sort(),
      },
      null,
      1,
    ) + "\n",
  );
}
