// 校验重压后的 APK：条目集合与内容必须与重压前逐条一致（CRC 相同），只有压缩字节变了。
// 用途：证明「省下来的体积」来自更好的压缩，而不是丢了文件或改了内容。
import { readFileSync } from "node:fs";
import { parseEntries } from "./zip-tools.mjs";

const [originalPath, repackedPath] = process.argv.slice(2);
if (!originalPath || !repackedPath) {
  console.error("用法: node verify-repacked-apk.mjs <原APK> <重压后APK>");
  process.exit(2);
}
const original = new Map(parseEntries(readFileSync(originalPath)).entries.map((e) => [e.name, e]));
const repacked = new Map(parseEntries(readFileSync(repackedPath)).entries.map((e) => [e.name, e]));
const problems = [];
for (const [name, entry] of original) {
  const other = repacked.get(name);
  if (!other) { problems.push("丢失条目 " + name); continue; }
  if (other.crc !== entry.crc) problems.push("内容变了 " + name);
  if (other.size !== entry.size) problems.push("大小变了 " + name);
  if (other.method !== entry.method) problems.push("压缩方式变了 " + name);
}
for (const name of repacked.keys()) if (!original.has(name)) problems.push("多出条目 " + name);
const before = readFileSync(originalPath).length;
const after = readFileSync(repackedPath).length;
console.log("条目数 " + original.size + " -> " + repacked.size + "，体积 " + before + " -> " + after + " B（省 " + (before - after) + " B）");
if (problems.length) {
  for (const p of problems.slice(0, 10)) console.log("FAIL " + p);
  process.exitCode = 1;
} else {
  console.log("PASS 条目集合与内容逐条一致（CRC/大小/压缩方式都相同）");
}
