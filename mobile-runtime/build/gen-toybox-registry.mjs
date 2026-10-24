// 里程碑3：把 bash-command-registry 裁到设备上真的有的那些命令。
//
// 判据来自**真机报告的并集**（`bench/report-*.json` 里 L1 带回来的 toybox applet 清单），
// 不是 AOSP 文档，也不是"某一台机器"——实测两台宿主的清单不一样：OPD2511 有 209 个 applet、
// WSA 只有 199 个（差 10 个：brctl/dhcp/gpio*/i2ctransfer/logger/memeater）。bundle 是所有宿主
// 共用一份产物，所以只能按"并集"裁：漏掉某台机器上真的有的命令，那台机器就白丢折叠。
//
// 为什么裁它是安全的：`bash-command-permission-policy.js:171` 取 `BASH_COMMAND_REGISTRY[exe]`，
// 取不到 node 就 `return undefined`（172-173 行）。缺席的命令只是**不做前缀折叠**（权限提示回到
// 逐条命令，更保守），不会放开任何权限。行为层面的证明在 `build/registry-ab-check.mjs`。
//
// 另一个读者是 `tool-perf.js:74` 的 `Object.hasOwn(registry, exe)` —— 它拿同一个表给工具调用
// 归因，裁完之后设备上跑的东西仍然归到自己的名字，非设备命令本来也跑不出来。
//
// 上游那份 2 MB 的生成文件一个字都不改（§5.1：上游改动刻意极小）；只在移动端打包时换成这里
// 生成的副本。以后 L2 随包带了 git/python，把名字加进 EXTRA 重新生成即可。
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const REGISTRY_SRC = path.join(root, "zcode/apps/zcode-cli/packages/core/dist/tool/handlers/generated/bash-command-registry.js");
const BENCH_DIR = path.join(here, "../bench");
const OUT = path.join(here, "dist/bash-command-registry.mobile.mjs");

// applet 清单之外、真机上确实存在的命令（/system/bin/sh 不是 toybox applet，但它是 shell 本体）。
const EXTRA = ["sh", "toybox"];

function appletLists() {
  const files = fs
    .readdirSync(BENCH_DIR)
    .filter((f) => /^report-.*\.json$/.test(f))
    .map((f) => path.join(BENCH_DIR, f));
  const byHost = {};
  for (const file of files) {
    let report;
    try {
      report = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue; // 存档里坏掉的一份不该拖垮打包
    }
    const sections = [report.device, report.deviceRaw?.results, report.runtime].filter(Array.isArray);
    // 宿主名与版本号在"宿主与内核"那条用例上，applet 清单在 L1 那条上，两者不同 item ——
    // 标签必须跨 item 取，否则并集来源写成 "?"，事后没人知道这份清单是哪台机器带回来的。
    const probe = sections.flat().find((item) => item?.detail?.device);
    const hostLabel = probe
      ? `${probe.detail.device}/${probe.detail.app ?? "?"}/${probe.detail.sdkInt ?? "?"}`
      : path.basename(file, ".json");
    for (const section of sections) {
      const hit = section.find((item) => typeof item?.detail?.available === "string" && item.detail.available.length > 20);
      if (!hit) continue;
      const list = hit.detail.available.replace(/^\[\s*|\s*\]$/g, "").trim().split(/\s+/).filter(Boolean);
      byHost[hostLabel] ??= list;
      break;
    }
  }
  if (Object.keys(byHost).length === 0) {
    throw new Error("bench/ 里没有任何带 toybox applet 清单（detail.available）的真机报告，先存档再打包");
  }
  return byHost;
}

// 生成文件里那个对象是纯 JSON（数组/字符串/数字），所以平衡括号扫出来直接 JSON.parse 就行。
function readRegistryObject(source) {
  const marker = "BASH_COMMAND_REGISTRY = ";
  const start = source.indexOf(marker);
  if (start < 0) throw new Error("registry 文件里没有 BASH_COMMAND_REGISTRY 赋值");
  const open = source.indexOf("{", start + marker.length);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(source.slice(open, i + 1));
    }
  }
  throw new Error("registry 对象没有闭合");
}

// 导出来是给 bundle.mjs 每次打包前调一次：产物落在 dist/ 里，能过夜就能变旧，而"旧的裁过的
// registry"不会报错，只会安静地少折叠几个命令。
export function buildToyboxRegistry() {
  const source = fs.readFileSync(REGISTRY_SRC, "utf8");
  const registry = readRegistryObject(source);
  const hosts = appletLists();
  const union = new Set(Object.values(hosts).flat());
  const available = new Set([...union, ...EXTRA]);
  const keys = Object.keys(registry);
  const kept = keys.filter((k) => available.has(k));
  const trimmed = Object.fromEntries(kept.map((k) => [k, registry[k]]));
  const version = /BASH_COMMAND_REGISTRY_VERSION = "([^"]+)"/.exec(source)?.[1] ?? "unknown";
  const hash = /BASH_COMMAND_REGISTRY_HASH = "([^"]+)"/.exec(source)?.[1] ?? "unknown";
  const perHost = Object.fromEntries(
    Object.entries(hosts).map(([host, list]) => [host, list.filter((k) => registry[k]).length]),
  );

  const banner =
    `// 本文件由 build/gen-toybox-registry.mjs 生成，请勿手改。\n` +
    `// 上游 registry：${version} / ${hash}（保留常量是为了任何比对都还对得上）。\n` +
    `// 保留判据：已实测宿主 applet 清单的**并集**（${available.size} 项）∩ 上游 spec（${keys.length} 项）= ${kept.length} 项。\n` +
    `// 清单来源：${Object.entries(hosts).map(([h, l]) => `${h}=${l.length}`).join("，")}。\n` +
    `// 缺席的命令不做前缀折叠，这是安全降级不是放开权限（bash-command-permission-policy.js:171）。\n`;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(
    OUT,
    banner +
      `export const BASH_COMMAND_REGISTRY_VERSION = ${JSON.stringify(version)};\n` +
      `export const BASH_COMMAND_REGISTRY_HASH = ${JSON.stringify(hash)};\n` +
      `export const BASH_COMMAND_REGISTRY_AVAILABLE_ON_DEVICE = ${JSON.stringify([...available].sort())};\n` +
      `export const BASH_COMMAND_REGISTRY = ${JSON.stringify(trimmed)};\n`,
  );

  return {
    file: OUT,
    registryVersion: version,
    hosts: perHost,
    applets: available.size,
    upstreamKeys: keys.length,
    keptKeys: kept.length,
    kept,
    upstreamBytes: fs.statSync(REGISTRY_SRC).size,
    trimmedBytes: fs.statSync(OUT).size,
  };
}

const kb = (n) => (n / 1024).toFixed(1) + " KB";

// 直接跑（node build/gen-toybox-registry.mjs）时打一份人看的统计。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = buildToyboxRegistry();
  process.stdout.write(
    JSON.stringify({ ...r, upstream: kb(r.upstreamBytes), trimmed: kb(r.trimmedBytes) }, null, 1) + "\n",
  );
}
