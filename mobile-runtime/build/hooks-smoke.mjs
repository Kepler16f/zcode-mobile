// 跑端侧钩子链路自检（hooks-smoke.ts）。与 chat-smoke.mjs 同一套 esbuild 配法。
import path from "node:path";
import { rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const zcodeRoot = path.join(root, "zcode");
const esbuild = createRequire(path.join(zcodeRoot, "apps/zcode-cli/package.json"))("esbuild");
const out = path.join(here, ".tmp-hooks-smoke.mjs");

await esbuild.build({
  entryPoints: [path.join(here, "hooks-smoke.ts")],
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
    path.join(zcodeRoot, "apps/zcode-cli/packages/core/node_modules"),
    path.join(zcodeRoot, "apps/zcode-cli/packages/contracts/node_modules"),
    path.join(zcodeRoot, "apps/zcode-cli/node_modules"),
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
