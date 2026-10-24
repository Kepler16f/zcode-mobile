// `createRequire(import.meta.url)("node:sqlite")` 是上游 Repo 拿 SQLite 的唯一入口
// （services/src/session/taskIndexRepo.ts:42、automationRepo.ts:33、offPeakTaskRepo.ts:26、
// tasksDatabase/startup.ts:6 —— 它们故意用 require 而不是 import，免得构建器把 node:sqlite
// 改写成不存在的 npm sqlite 包）。这四句都在**模块顶层**求值，所以这里必须是同步的：
// 做成 async 的话 require 返回一个 Promise，解构当场 "require is not a function"（实机验过）。
//
// id 是字符串、不是 import，esbuild 不会替我们解析，所以只能在这里按名字给真垫片。
// 表里只放实测会被 require 的：多一个都不要，宁可对没准备的 id 明确抛错，
// 也不要返回一个"看起来能用、实际半残"的模块面。
import * as sqlite from "./sqlite.mjs";

const registry = new Map([
  ["node:sqlite", sqlite],
]);

export function createRequire(_filename) {
  return (id) => {
    const mod = registry.get(String(id).startsWith("node:") ? String(id) : "");
    if (!mod) throw new Error(`mobile-compat: require('${id}') 需要真实模块解析，端侧未准备这个垫片`);
    return mod;
  };
}
