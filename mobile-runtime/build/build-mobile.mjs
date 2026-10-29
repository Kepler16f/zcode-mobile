// 完整构建顺序：上游 core 与 Web → 两份移动 bundle → 构建指纹。
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const buildEnvironment = process.env.ZCODE_ENV?.trim().toLowerCase() || "production";
if (buildEnvironment !== "production" && buildEnvironment !== "test") throw new Error("ZCODE_ENV 只能是 production 或 test");
const buildEnv = { ...process.env, ZCODE_ENV: buildEnvironment };
console.log(`移动端构建环境：${buildEnvironment}`);
function run(command, args, cwd) {
  console.log(`> ${command} ${args.join(" ")}`);
  // Windows 的 pnpm 是 .cmd；参数均为此脚本中的固定常量，不把用户输入拼入 shell。
  const windowsPnpm = process.platform === "win32" && command === "pnpm";
  const executable = windowsPnpm ? (process.env.ComSpec || "cmd.exe") : command;
  const commandArgs = windowsPnpm ? ["/d", "/s", "/c", [command, ...args].join(" ")] : args;
  const result = spawnSync(executable, commandArgs, { cwd, stdio: "inherit", env: buildEnv });
  if (result.error || result.status !== 0) throw new Error(`构建步骤失败：${command}（${result.error?.message ?? result.status}）`);
}
run("pnpm", ["--filter", "@zcode/core...", "-r", "build"], path.join(root, "zcode/apps/zcode-cli"));
run("pnpm", ["--filter", "@zcode/web", "build"], path.join(root, "zcode"));
run(process.execPath, [path.join(root, "mobile-runtime/build/bundle.mjs")], root);
run(process.execPath, [path.join(root, "mobile-runtime/build/bundle-ui.mjs")], root);
run(process.execPath, [path.join(root, "mobile-runtime/build/bundle-fingerprint.mjs"), "write"], root);
