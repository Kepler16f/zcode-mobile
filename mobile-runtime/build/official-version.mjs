import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * 官方版本号的构建期单一来源（0.12.6，用户点名"ZCode/3.18.2 这种不要写死，很可能要
 * 跟随上游更新"）：
 *
 * 官方自己的形状就是"壳带版本"——桌面主进程（app.asar）把 CLI 版本写死在自己的模块里
 * （`nodeBundleEntryFile:"zcode.cjs"` 同段 `var I4="3.18.2"`），spawn agent 时经 env 传给
 * CLI（CLI bundle 里 `typeof __ZCODE_VERSION__<"u"?__ZCODE_VERSION__:"0.0.0-dev"`）。
 * 所以"跟随上游"的正确实现是**构建期从本机官方安装包实挖**，挖不到才降级到
 * server-compat.ts 的兜底常量（CI/无官方安装的机器）。
 *
 * 同时挖 ai-sdk/anthropic 的 UA 版本（官方模型请求 UA 是上下文层与 SDK 层空格拼接：
 * `ZCode/<ver> ai-sdk/anthropic/<sdkVer>`，UO() 把两层 join）——SDK 版本在 zcode.cjs 里
 * 以"变量赋值 + 模板引用"的 minified 形状存在，直接按名字匹配会碎，用引用反查赋值。
 */

const VERSION_LITERAL = /"(\d+\.\d+\.\d+)"/g;

function readServerCompatFallback(root) {
  const source = readFileSync(path.join(root, "mobile-runtime/ui/server-compat.ts"), "utf8");
  const compat = source.match(/export\s+const\s+OFFICIAL_COMPAT_VERSION\s*=\s*"([^"]+)"/);
  const aiSdk = source.match(/export\s+const\s+OFFICIAL_AI_SDK_ANTHROPIC_VERSION\s*=\s*"([^"]+)"/);
  const providerUtils = source.match(
    /export\s+const\s+OFFICIAL_AI_SDK_PROVIDER_UTILS_VERSION\s*=\s*"([^"]+)"/,
  );
  return {
    compat: compat?.[1],
    aiSdkAnthropic: aiSdk?.[1],
    aiSdkProviderUtils: providerUtils?.[1],
  };
}

/**
 * 官方桌面主进程（app.asar）里 CLI 版本的锚点：`nodeBundleEntryFile:"zcode.cjs"` 所在
 * 模块作用域内的第一个 "3.x.y" 字面量就是版本（实测 I4="3.18.2" 紧跟其后）。
 * asar 是打包二进制（~400MB），只用 Buffer.indexOf 找锚点再取局部窗口，不全文正则。
 */
function probeCompatVersionFromShell(asarPath) {
  const fd = readFileSync(asarPath);
  const anchor = Buffer.from('nodeBundleEntryFile:"zcode.cjs"');
  let at = fd.indexOf(anchor);
  while (at >= 0) {
    const window = fd.subarray(at, Math.min(fd.length, at + 4096)).toString("utf8");
    VERSION_LITERAL.lastIndex = 0;
    const hit = VERSION_LITERAL.exec(window);
    if (hit?.[1]) return hit[1];
    at = fd.indexOf(anchor, at + anchor.length);
  }
  return null;
}

/**
 * zcode.cjs 里 ai-sdk/anthropic 的 UA 版本：模板引用 `ai-sdk/anthropic/${V}` 反查
 * `V="x.y.z"` 赋值（赋值与引用分处两处，minified 变量名随构建变，按名字对得上才算）。
 */
function probeAiSdkAnthropicVersionFromCli(cliPath) {
  const source = readFileSync(cliPath, "utf8");
  const reference = source.match(/ai-sdk\/anthropic\/\$\{([A-Za-z_$][\w$]*)\}/);
  if (!reference?.[1]) return null;
  const assignment = new RegExp(
    `${variablePattern(reference[1])}="((?:\\d+\\.){2}\\d+)"`,
  ).exec(source);
  return assignment?.[1] ?? null;
}

function probeAiSdkProviderUtilsVersionFromCli(cliPath) {
  const source = readFileSync(cliPath, "utf8");
  const reference = source.match(/ai-sdk\/provider-utils\/\$\{([A-Za-z_$][\w$]*)\}/);
  if (!reference?.[1]) return null;
  const assignment = new RegExp(
    `${variablePattern(reference[1])}="((?:\\d+\\.){2}\\d+)"`,
  ).exec(source);
  return assignment?.[1] ?? null;
}

function variablePattern(name) {
  return name.replace(/[$]/g, "\\$");
}

function probeInstallDirs() {
  if (process.platform === "win32") {
    return [
      "C:/Program Files (x86)/ZCode/resources",
      "C:/Program Files/ZCode/resources",
    ];
  }
  if (process.platform === "darwin") {
    return ["/Applications/ZCode.app/Contents/Resources"];
  }
  // Linux CI/WSL：没有官方安装包，走兜底。
  return [];
}

/**
 * 返回 { version, aiSdkAnthropic, source }。source ∈
 *   "official-shell"（本机官方壳实挖，跟随上游）
 *   "fallback"（server-compat.ts 兜底常量，CI/无官方安装）
 * 兜底常量本身也从 server-compat.ts 读出（仍是单一事实源），不在本文件再写一份。
 */
export function readOfficialVersions(root) {
  const fallback = readServerCompatFallback(root);
  for (const dir of probeInstallDirs()) {
    const cliPath = path.join(dir, "glm/zcode.cjs");
    if (!existsSync(cliPath)) continue;
    const compat =
      probeCompatVersionFromShell(path.join(dir, "app.asar")) ?? fallback.compat;
    const aiSdkAnthropic =
      probeAiSdkAnthropicVersionFromCli(cliPath) ?? fallback.aiSdkAnthropic;
    const aiSdkProviderUtils =
      probeAiSdkProviderUtilsVersionFromCli(cliPath) ?? fallback.aiSdkProviderUtils;
    if (compat && aiSdkAnthropic && aiSdkProviderUtils) {
      return {
        version: compat,
        aiSdkAnthropic,
        aiSdkProviderUtils,
        source: "official-shell",
      };
    }
  }
  if (!fallback.compat || !fallback.aiSdkAnthropic || !fallback.aiSdkProviderUtils) {
    throw new Error("官方版本实挖失败且 server-compat.ts 兜底常量缺失");
  }
  return {
    version: fallback.compat,
    aiSdkAnthropic: fallback.aiSdkAnthropic,
    aiSdkProviderUtils: fallback.aiSdkProviderUtils,
    source: "fallback",
  };
}

/** 兼容旧调用（bundle.mjs/bundle-ui.mjs 一直用这一个）。 */
export function readOfficialCompatVersion(root) {
  return readOfficialVersions(root).version;
}
