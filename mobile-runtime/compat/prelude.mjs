// esbuild inject 前置：浏览器里没有全局 Buffer，而 Glob/二进制路径直接用裸 `Buffer`。
// 复用仓库里已有的 buffer polyfill，而不是自己写一个半成品。
import { Buffer as PolyfillBuffer } from "../../zcode/node_modules/buffer/index.js";

globalThis.Buffer = globalThis.Buffer ?? PolyfillBuffer;

// 桌面 migration-runner 用 Atomics.wait(waitBuffer, …) 当同步 sleep 来等 SQLITE_BUSY
// （adapters/src/storage/session-store/migration-runner.ts:18）。WebView 主线程上
// SharedArrayBuffer 要 crossOriginIsolated 才存在、Atomics.wait 还被直接禁用，
// 光是模块顶层那一句就让整包加载失败（实测报 "SharedArrayBuffer is not defined"）。
// 端侧引擎是 sql.js：单进程内存库，没有第二个进程抢锁，BUSY 不会发生，
// 所以这里退化成 no-op 是安全的。将来若换成多进程共享的 native SQLite（Android 桥），
// 这条必须改回真正的等待，否则迁移会变成空转热重试。
if (typeof globalThis.SharedArrayBuffer === "undefined") {
  globalThis.SharedArrayBuffer = globalThis.ArrayBuffer;
}
const nativeWait = Atomics.wait?.bind(Atomics);
Atomics.wait = function waitAsNoop(typedArray, index, value, timeoutMs) {
  try {
    return nativeWait(typedArray, index, value, timeoutMs);
  } catch {
    return "ok";
  }
};
