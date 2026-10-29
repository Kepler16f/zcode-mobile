// 构建完成后仅交付并清理 aZCode 的旧 APK；允许测试注入临时下载目录。
import { copyFileSync, constants, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const versionPattern = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;
const versionParts = value => {
  if (!versionPattern.test(value)) throw new Error("版本号必须是三段数字，例如 0.8.1");
  return value.split(".").map(Number);
};
export function downloadDirectory() {
  if (process.platform !== "win32") throw new Error("自动交付到下载目录目前仅支持 Windows");
  // Known Folder API 支持用户把 Downloads 移到其他盘，不依赖硬编码个人目录。
  const script = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ZCodeDownloads { [DllImport("shell32.dll")] public static extern int SHGetKnownFolderPath([MarshalAs(UnmanagedType.LPStruct)] Guid id, uint flags, IntPtr token, out IntPtr path); }'; $p=[IntPtr]::Zero; $r=[ZCodeDownloads]::SHGetKnownFolderPath([Guid]"374DE290-123F-4565-9164-39C4925E467B",0,[IntPtr]::Zero,[ref]$p); if($r -ne 0){throw "Downloads lookup failed: $r"}; try {[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringUni($p))} finally {[Runtime.InteropServices.Marshal]::FreeCoTaskMem($p)}`;
  const result = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim();
  if (!result || !path.isAbsolute(result)) throw new Error("无法确定系统下载文件夹");
  return result;
}
function digest(file) { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
export function publishApk({ apk, version, downloadDir }) {
  const current = versionParts(version);
  const source = path.resolve(apk);
  if (!statSync(source).isFile() || statSync(source).size === 0) throw new Error("构建 APK 不存在或为空");
  const directory = path.resolve(downloadDir ?? downloadDirectory());
  if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new Error("系统下载文件夹不存在");
  const target = path.join(directory, `aZCode-${version}.apk`);
  if (source === target) throw new Error("构建文件和交付目标不能相同");
  const temporary = path.join(directory, `.aZCode-${version}-${randomUUID()}.tmp`);
  try {
    copyFileSync(source, temporary, constants.COPYFILE_EXCL);
    if (digest(source) !== digest(temporary)) throw new Error("APK 复制校验失败，保留旧安装包");
    renameSync(temporary, target);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* 保留原始错误 */ }
    throw error;
  }
  const removed = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const match = /^aZCode-((?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2}))\.apk$/i.exec(entry.name);
    if (!entry.isFile() || !match || entry.name === path.basename(target)) continue;
    const candidate = versionParts(match[1]);
    const older = candidate.some((part, i) => part < current[i] && candidate.slice(0, i).every((v, j) => v === current[j]));
    if (!older) continue;
    rmSync(path.join(directory, entry.name));
    removed.push(entry.name);
  }
  return { target, removed };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--version" || args[2] !== "--apk") throw new Error("用法: node publish-apk.mjs --version 0.8.1 --apk <APK路径>");
  const result = publishApk({ version: args[1], apk: args[3] });
  console.log(`安装包已保存：${result.target}`);
  console.log(`已清理旧版 aZCode 安装包：${result.removed.length} 个`);
}
