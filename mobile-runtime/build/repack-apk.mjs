// 重打包 APK：把已压缩的条目按最大压缩率再压一遍，然后重新对齐并用同一证书重新签名。
//
// 为什么：AGP 8.13 的 debug 构建对资源用最快压缩等级（BEST_SPEED）。同一份内容，
// entry.js 7.8 MB 正文在等级 1 下是 2.48 MB、等级 9 是 2.06 MB；全包 5000 多个资源累计差约 1.7 MB。
// AGP 任务上的 compressionLevel 属性在 8.13.2 上不生效（由构建类型内部决定），只能在产物层解决。
//
// 三步：重压条目 → zipalign 恢复对齐 → apksigner 用**同一个 keystore** 重新签名。
// 证书不变，手机上可以直接覆盖安装旧版本；条目集合与内容不变（逐条 CRC 一致）。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildZip, parseEntries, recompressEntry } from "./zip-tools.mjs";

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const apkPath = value("--apk");
if (!apkPath) {
  console.error("用法: node repack-apk.mjs --apk <apk> [--sdk <build-tools>] [--java <java>] [--keystore <ks>] [--level <n>]");
  process.exit(2);
}
const level = Number(value("--level", "9"));
const sdkDir = value("--sdk");
const javaExe = value("--java", process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", "java") : "java");
const keystore = value("--keystore", path.join(process.env.USERPROFILE ?? "", ".android", "debug.keystore"));
// 口令走环境变量而不是命令行：命令行参数在进程列表里是公开的。
const ksPass = value("--ks-pass", process.env.ZCODE_KS_PASS ?? "android");
const keyPass = value("--key-pass", process.env.ZCODE_KEY_PASS ?? "android");
const alias = value("--alias", process.env.ZCODE_KEY_ALIAS ?? "androiddebugkey");

const buffer = readFileSync(apkPath);
const { entries } = parseEntries(buffer);
let changed = 0;
const rebuilt = entries.map((entry) => {
  const result = recompressEntry(entry, level);
  if (result.changed) changed++;
  return result.entry;
});
const output = buildZip(rebuilt);
const workDir = path.join(path.dirname(apkPath), "repack-work");
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
const repacked = path.join(workDir, "repacked.apk");
writeFileSync(repacked, output);
console.log("重压完成：" + changed + " 个条目，" + buffer.length + " B -> " + output.length + " B");

if (!sdkDir) {
  console.log("未提供 build-tools 目录，保留重压结果未签名：" + repacked);
  process.exit(0);
}
const zipalign = path.join(sdkDir, "zipalign.exe");
const apksignerJar = path.join(sdkDir, "lib", "apksigner.jar");
if (!existsSync(zipalign) || !existsSync(apksignerJar)) {
  console.error("build-tools 里缺 zipalign/apksigner：" + sdkDir);
  process.exit(3);
}
const aligned = path.join(workDir, "aligned.apk");
execFileSync(zipalign, ["-p", "-f", "4", repacked, aligned], { stdio: "inherit" });
if (!existsSync(keystore)) {
  console.error("找不到签名用的 keystore：" + keystore);
  process.exit(4);
}
const signed = path.join(workDir, "signed.apk");
execFileSync(javaExe, [
  "-jar", apksignerJar, "sign",
  "--ks", keystore, "--ks-pass", "pass:" + ksPass, "--key-pass", "pass:" + keyPass, "--ks-key-alias", alias,
  "--v1-signing-enabled", "false", "--v2-signing-enabled", "true", "--v3-signing-enabled", "true",
  "--out", signed, aligned,
], { stdio: "inherit" });
renameSync(signed, apkPath);
rmSync(workDir, { recursive: true, force: true });
console.log("已重新对齐并用同一证书签名，覆盖原安装包：" + apkPath);
