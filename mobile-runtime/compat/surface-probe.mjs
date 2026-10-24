// 输出一份「垫片 API 清单」：core 及其依赖到底 import 了哪些 node 内置模块的哪些具名符号。
// 这是 compat/ 的实现规格，不是靠 grep 猜出来的。
import path from "node:path";
import { builtinModules, createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(here, "../../zcode/apps/zcode-cli");
const esbuild = createRequire(path.join(cliRoot, "package.json"))("esbuild");
const bare = new Set(builtinModules);

// 空 ESM 垫片：每个具名 import 都会报错，报错文本里正好带着"模块 → 符号"。
const collect = {
  name: "surface-probe",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => {
      const name = a.path.replace(/^node:/, "");
      if (!bare.has(name) && !a.path.startsWith("node:")) return undefined;
      return { path: "node:" + name, namespace: "probe" };
    });
    b.onLoad({ filter: /.*/, namespace: "probe" }, () => ({
      contents: "export const __zcodeShimProbe = 1;",
      loader: "js",
    }));
  },
};

let errors;
try {
  await esbuild.build({
    entryPoints: [path.join(cliRoot, "packages/core/dist/index.js")],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    outfile: path.join(here, "surface-probe.js"),
    write: false,
    plugins: [collect],
    logLevel: "silent",
  });
  process.exit(0);
} catch (e) {
  errors = e.errors ?? [];
}

const need = new Map();
const re =
  /No matching export in "probe:(.*?)" for import "(.*?)"|Import "(.*?)" will always be undefined because there is no matching export in "probe:(.*?)"/;
for (const err of errors) {
  const m = re.exec(err.text ?? "");
  if (!m) continue;
  const mod = m[1] ?? m[5];
  const name = m[2] ?? m[3];
  if (!need.has(mod)) need.set(mod, new Set());
  need.get(mod).add(name);
}

const out = {};
for (const [mod, names] of [...need].sort()) out[mod] = [...names].sort();
process.stdout.write(
  JSON.stringify({ total: errors.length, modules: out }, null, 1) + "\n",
);
