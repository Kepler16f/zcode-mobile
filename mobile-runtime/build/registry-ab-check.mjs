// 里程碑3 的 A/B：同一份 core，只差 bash-command-registry 那一个模块，
// 把上游 registry 的 707 个命令各造两条 argv，逐条比对权限策略给出的建议规则。
//
// 要回答的问题只有两个：
//  1. 设备上还在的命令（kept）——裁剪前后必须**一模一样**。不一样就说明
//     gen-toybox-registry.mjs 的 JSON 往返把某个 spec 改坏了。
//  2. 设备上已经不存在的命令（dropped）——允许变，但只允许朝"不再折叠前缀"这个方向变，
//     也就是退回 exactUpdate（整条命令原文）。要是它折叠得**更深**了，就是放开权限。
// 用法：node mobile-runtime/build/registry-ab-check.mjs
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compatPlugin } from "../compat/build-plugin.mjs";
import { buildToyboxRegistry } from "./gen-toybox-registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const cliRoot = path.join(root, "zcode/apps/zcode-cli");
const esbuild = createRequire(path.join(cliRoot, "package.json"))("esbuild");
const distDir = path.join(here, "dist");
const policyModule =
  "../../zcode/apps/zcode-cli/packages/core/dist/tool/handlers/bash-command-permission-policy.js";

const entryFile = path.join(distDir, "ab-entry.mjs");
// 绝对路径：这个临时入口写在 build/dist 里，相对层数一算错就是"Could not resolve"。
fs.writeFileSync(
  entryFile,
  `export { resolveBashPermissionRulePolicy } from ${JSON.stringify(
    path.join(root, "zcode/apps/zcode-cli/packages/core/dist/tool/handlers/bash-command-permission-policy.js"),
  )};\n`,
);

async function build(which, plugins) {
  const outfile = path.join(distDir, `ab-policy.${which}.mjs`);
  await esbuild.build({
    entryPoints: [entryFile],
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
    external: ["typescript"],
    inject: [path.join(root, "mobile-runtime/compat/prelude.mjs")],
    plugins,
  });
  return import(pathToFileURL(outfile).href);
}

const trimmed = buildToyboxRegistry();
const full = await build("full", [compatPlugin({ external: ["typescript"] })]);
const cut = await build("cut", [compatPlugin({ external: ["typescript"], bashRegistryOverride: trimmed.file })]);

// argv 从 registry 的 spec 树里取：每个命令取它第一个 action token，凑出"真实会被折叠"的形状。
const upstreamSource = fs.readFileSync(
  path.join(root, "zcode/apps/zcode-cli/packages/core/dist/tool/handlers/generated/bash-command-registry.js"),
  "utf8",
);
const marker = "BASH_COMMAND_REGISTRY = ";
const open = upstreamSource.indexOf("{", upstreamSource.indexOf(marker) + marker.length);
let depth = 0;
let close = -1;
for (let i = open; i < upstreamSource.length; i++) {
  const ch = upstreamSource[i];
  if (ch === "{") depth++;
  else if (ch === "}") {
    depth--;
    if (depth === 0) {
      close = i;
      break;
    }
  }
}
const registry = JSON.parse(upstreamSource.slice(open, close + 1));
const kept = new Set(trimmed.kept);

function corpus(name) {
  const node = registry[name];
  const action = node?.[3]?.[0]?.[0]?.[0];
  const shapes = [[name]];
  if (typeof action === "string" && action.length > 0) shapes.push([name, action]);
  return shapes.map((argv) => argv.join(" "));
}

const ruleOf = (mod, command) => {
  try {
    const policy = mod.resolveBashPermissionRulePolicy({ command }, {});
    return JSON.stringify(policy?.suggestedPermissionUpdates ?? null);
  } catch (e) {
    return "throw:" + String(e?.message ?? e).slice(0, 80);
  }
};

const results = { keptSame: 0, keptChanged: [], droppedSame: 0, droppedUnfolded: 0, droppedOther: [] };
for (const name of Object.keys(registry)) {
  for (const command of corpus(name)) {
    const before = ruleOf(full, command);
    const after = ruleOf(cut, command);
    if (kept.has(name)) {
      if (before === after) results.keptSame++;
      else results.keptChanged.push({ command, before, after });
      continue;
    }
    if (before === after) {
      results.droppedSame++;
      continue;
    }
    // 折叠没了 → 建议规则变成整条命令原文，这是"更窄"，不是"更宽"。
    const exact = JSON.stringify([
      { behavior: "allow", rules: [{ ruleContent: command, toolName: "Bash" }], type: "addRules" },
    ]);
    if (after === exact) results.droppedUnfolded++;
    else results.droppedOther.push({ command, before, after });
  }
}

process.stdout.write(
  JSON.stringify(
    {
      applets: trimmed.applets,
      upstreamKeys: trimmed.upstreamKeys,
      keptKeys: trimmed.keptKeys,
      cases: results.keptSame + results.keptChanged.length + results.droppedSame + results.droppedUnfolded + results.droppedOther.length,
      keptSame: results.keptSame,
      keptChanged: results.keptChanged.slice(0, 5),
      droppedSame: results.droppedSame,
      droppedUnfolded: results.droppedUnfolded,
      droppedOther: results.droppedOther.slice(0, 5),
      verdict:
        results.keptChanged.length === 0 && results.droppedOther.length === 0
          ? "通过：设备上有的命令行为逐条一致；设备上没了的命令只从'折叠前缀'退回'整条原文'，没有任何一条变宽"
          : "**不通过**：见 keptChanged / droppedOther",
    },
    null,
    1,
  ) + "\n",
);
fs.rmSync(entryFile, { force: true });
fs.rmSync(path.join(distDir, "ab-policy.full.mjs"), { force: true });
fs.rmSync(path.join(distDir, "ab-policy.cut.mjs"), { force: true });
