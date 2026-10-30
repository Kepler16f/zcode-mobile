// 最小 ZIP 读写：只处理 AGP 与 Android 构建产物用到的形态（deflate / store，无加密、无 zip64）。
// 为什么自己写：仓库里没有可用的 zip 写库（yazl/jszip 只在 zcode/node_modules 里，且要整包读进内存）；
// 而资源重压与 APK 重打包都只需要「读条目 → 重新 deflate → 写条目」这一件事。
import { deflateRawSync, inflateRawSync } from "node:zlib";

export function findEndOfCentralDirectory(buffer) {
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error("不是合法的 zip：找不到中央目录结尾");
}

export function parseEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < total; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("中央目录项损坏");
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.push({
      name,
      method,
      crc,
      compressedSize,
      size,
      dosTime: buffer.readUInt16LE(localOffset + 10),
      dosDate: buffer.readUInt16LE(localOffset + 12),
      data: buffer.subarray(dataStart, dataStart + compressedSize),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { entries, eocd };
}

export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(entry.dosTime, 10);
    local.writeUInt16LE(entry.dosDate, 12);
    local.writeUInt32LE(entry.crc, 14);
    local.writeUInt32LE(entry.compressedSize, 18);
    local.writeUInt32LE(entry.size, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    locals.push(local, nameBuffer, entry.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt16LE(entry.dosTime, 12);
    central.writeUInt16LE(entry.dosDate, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.compressedSize, 20);
    central.writeUInt32LE(entry.size, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuffer);
    offset += 30 + nameBuffer.length + entry.data.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, eocd]);
}

/** 把 deflate 条目按指定等级重压；STORED 条目原样保留。返回是否真的变小。 */
export function recompressEntry(entry, level = 9) {
  if (entry.method !== 8) return { entry, changed: false };
  const raw = inflateRawSync(entry.data);
  const packed = deflateRawSync(raw, { level });
  if (packed.length >= entry.compressedSize) return { entry, changed: false };
  return { entry: { ...entry, compressedSize: packed.length, data: packed }, changed: true };
}
