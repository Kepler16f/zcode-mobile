// 跑端侧对话协议自检（chat-smoke.ts）。见该文件头部的五条判据与 PORTING §1.5.18。
//
// 为什么不直接 node 跑 .ts：上游那些包只出 TS 源码，`@/` 别名要按 packages/ui 的 tsconfig
// 解析（bundle-ui.mjs 同一套配法），所以这里先用 esbuild 打成一份临时 ESM 再执行。
// 产物只在本机存在、跑完就删，绝不进 dist-ui（那份才是装进 APK 的东西）。
import path from "node:path";
import { rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const zcodeRoot = path.join(root, "zcode");
const esbuild = createRequire(path.join(zcodeRoot, "apps/zcode-cli/package.json"))("esbuild");
const out = path.join(here, ".tmp-chat-smoke.mjs");

await esbuild.build({
  entryPoints: [path.join(here, "chat-smoke.ts")],
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  jsx: "automatic",
  sourcemap: "inline",
  logLevel: "warning",
  alias: { "@": path.join(zcodeRoot, "packages/ui/src") },
  nodePaths: [
    path.join(zcodeRoot, "packages/web/node_modules"),
    path.join(zcodeRoot, "packages/ui/node_modules"),
    path.join(zcodeRoot, "packages/client/node_modules"),
    path.join(zcodeRoot, "packages/services/node_modules"),
    path.join(zcodeRoot, "packages/shared/node_modules"),
    path.join(zcodeRoot, "node_modules"),
  ],
  define: { "process.env.NODE_ENV": '"development"' },
});

try {
  await import(pathToFileURL(out).href);
} finally {
  rmSync(out, { force: true });
}
