// vfs 两个后端共用的编码换算：Node 的 fs 用同一组签名（{encoding:"utf8"|"base64"|…} 或字符串），
// 内存盘和真盘桥都必须返回同样的形状，否则调用方要按后端分叉。
// 从 compat/vfs-memory.mjs 抽出，唯一原因是 compat/vfs-native.mjs 需要同一份实现。

export function toBytes(data, opts) {
  if (typeof data === "string") {
    const enc = opts.encoding ?? "utf8";
    return encodeString(data, enc);
  }
  if (data instanceof Uint8Array) return data.slice();
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  return new Uint8Array(0);
}

export function fromBytes(bytes, enc) {
  if (enc === "buffer" || !enc) return bytes.slice();
  if (enc === "hex") {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  if (enc === "base64") return b64(bytes, false);
  if (enc === "latin1" || enc === "binary") {
    return String.fromCharCode(...bytes);
  }
  return new TextDecoder(enc === "utf8" ? "utf-8" : enc).decode(bytes);
}

export function encodeString(s, enc) {
  if (enc === "hex") return new Uint8Array(s.match(/../g)?.map((h) => parseInt(h, 16)) ?? []);
  if (enc === "base64") return b64(s, true);
  return new TextEncoder().encode(s);
}

export function b64(input, decode) {
  const bin = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (decode) {
    const s = String(input).replace(/[^A-Za-z0-9+/]/g, "");
    const out = [];
    for (let i = 0; i < s.length; i += 4) {
      // 缺位的字符贡献 0 而不是 -1：indexOf(undefined) 是 -1，而 -1 << 6 会把 n 的高位全污染
      // （尾组带填充时最后一个字节变 0xFF —— 0.3.7 的 SAF 树桥用例炸出的真形状 bug，
      // 真盘桥用原生 atob 从没走到过这一支）。
      const c0 = bin.indexOf(s[i]);
      const c1 = bin.indexOf(s[i + 1]);
      const c2 = s[i + 2] === undefined ? 0 : bin.indexOf(s[i + 2]);
      const c3 = s[i + 3] === undefined ? 0 : bin.indexOf(s[i + 3]);
      const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
      out.push((n >> 16) & 255);
      if (s[i + 2] !== undefined) out.push((n >> 8) & 255);
      if (s[i + 3] !== undefined) out.push(n & 255);
    }
    return new Uint8Array(out);
  }
  let s = "";
  const bytes = input;
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    s += bin[(n >> 18) & 63] + bin[(n >> 12) & 63];
    s += bytes[i + 1] === undefined ? "=" : bin[(n >> 6) & 63];
    s += bytes[i + 2] === undefined ? "=" : bin[n & 63];
  }
  return s;
}

export function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
