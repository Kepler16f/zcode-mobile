export { createHash, randomUUID } from "../impl/crypto.mjs";

// Node 的 randomBytes 返回 Buffer；端侧 prelude 已经补了全局 Buffer，这里给出同样的类型，
// 否则调用方 `.toString("hex")` 会在真机上炸，而桌面浏览器里 Uint8Array 看着是好的。
export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return globalThis.Buffer.from(b);
}

// createCipheriv / createDecipheriv 刻意不补：上游用它做 aes-256-gcm 的同步加解密
// （credential/providers/credentialCipherProvider.ts），而 WebCrypto 只有异步接口。
// 在 JS 里手写 AES-GCM 属于"错了不会立刻看出来"的那类代码，端侧的凭证加密应当走
// Keystore/HUKS 同步桥（M6），而不是由垫片假装同等强度。缺它时构建会在这里失败。
