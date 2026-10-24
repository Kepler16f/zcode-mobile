import * as vfs from "../vfs.mjs";

export const existsSync = vfs.existsSync;
export const readFileSync = vfs.readFileSync;
export const writeFileSync = (p, d, o) => vfs.writeFile(p, d, o, "writeFile");
export const appendFileSync = (p, d, o) => vfs.writeFile(p, d, { ...(typeof o === "string" ? { encoding: o } : o), flag: "a" }, "appendFile");
export const mkdirSync = (p, o) => vfs.mkdir(p, o, "mkdir");
export const readdirSync = vfs.readdirSync;
export const statSync = vfs.statSync;
export const lstatSync = vfs.lstatSync;
export const unlinkSync = vfs.unlinkSync;
export const renameSync = vfs.renameSync;
export const readlinkSync = vfs.readlinkSync;
export const realpathSync = vfs.realpathSync;
export const accessSync = vfs.accessSync;
export const rmSync = vfs.rmSync;
export const mkdtempSync = vfs.mkdtempSync;
export const symlinkSync = vfs.symlinkSync;
export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 0o100, O_TRUNC: 0o1000, O_APPEND: 0o2000 };

export function copyFileSync(from, to) {
  vfs.writeFile(to, vfs.readFileSync(from), {}, "copyFile");
}

// 上游有两类"盯着文件变"的用法：provider-node 的随包 Built-in 配置（跨进程一致性）和
// fileWatcherService（工作区改动）。前者在端侧根本没有第二个写这个文件的进程——组合根明确
// 传 watch:false（见 ui/providers.ts），所以真跑到这一句只可能是装配写错了，宁可当场点名，
// 也不要给一个"注册了但永远不触发"的哑对象：那会把配置不更新说成正常状态。
// 后者是真的功能，等 Android 原生 watcher 桥，所以 fileWatcherService 仍在未接入清单里。
export function watch() {
  throw new Error("mobile-compat: 端侧没有 fs.watch。随包配置走 watch:false（单运行时、无跨进程写入）；工作区监听要等原生桥，见 PORTING §1.5 未接入清单。");
}

// createReadStream 上游只用于"逐行读大 JSONL 时不要把整文件塞进内存"（readJsonLinesFileHead）。
// 端侧的读本来就是一次性过桥，所以这里按 chunk 切片给出同样的异步可迭代形状，
// 而不是另起一套流/EventEmitter——那套东西在这里没有能消费者的语义。
// 必须带 [Symbol.asyncIterator]：readline shim 与 `for await` 都只认这个，
// 只给 EventEmitter 的假流会在端侧表现为"读历史永远不返回"。
export function createReadStream(filePath, options = {}) {
  const encoding = typeof options === "string" ? options : options?.encoding;
  const chunkSize = options?.highWaterMark ?? 64 * 1024;
  const it = (async function* () {
    const data = vfs.readFileSync(filePath, encoding ? { encoding: "utf-8" } : undefined);
    if (typeof data === "string") {
      for (let i = 0; i < data.length; i += chunkSize) yield data.slice(i, i + chunkSize);
      return;
    }
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    for (let i = 0; i < bytes.length; i += chunkSize) yield bytes.subarray(i, i + chunkSize);
  })();
  const emitter = new EventTarget();
  return Object.assign(emitter, {
    [Symbol.asyncIterator]: () => it,
    // Node 的 Readable 用 .on("data")；端侧目前没有这种消费者，留着是为了让"用了没实现的形状"
    // 立刻报错，而不是安静地拿到 undefined。
    on() {
      throw new Error("mobile-compat: createReadStream 只提供异步迭代，请用 for await（没有 EventEmitter 面）");
    },
    destroy() {},
  });
}
