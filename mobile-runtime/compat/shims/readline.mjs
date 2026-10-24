import * as vfs from "../vfs.mjs";

// node:readline 的 createInterface({ input })：上游只用它逐行读 JSONL（sessionHistoryJsonl.ts）。
// Node 的实现是流 + 缓冲，这里按同样的语义做一个异步行迭代器：input 可以是任何
// 产出 Uint8Array/string 分块的异步可迭代对象（我们的 createReadStream 就是）。
// 不假装处理 EventEmitter 那一面——上游只用了 for await。
export function createInterface({ input, crlfDelay }) {
  void crlfDelay;
  const decoder = new TextDecoder("utf-8");
  async function* lines() {
    let rest = "";
    for await (const chunk of input) {
      rest += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      const parts = rest.split(/\r?\n/);
      rest = parts.pop() ?? "";
      for (const line of parts) yield line;
    }
    // 末尾没有换行时 Node 也会给出最后一行；空尾段不算一行。
    if (rest.length > 0) yield rest;
  }
  const it = lines();
  return {
    [Symbol.asyncIterator]: () => it,
    async next() {
      return it.next();
    },
    close() {},
  };
}
