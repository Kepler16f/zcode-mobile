// 生成器的打包入口（由 generate.mjs 用 esbuild 打成自包含 ESM 后 import）。
// zod 与协议 TS 源码打进同一个 bundle，保证生成器内省用的是同一份 zod 实例。
// 真相源是 TS 源码而非 dist：esbuild 会按 TS 语义解析 ".js" 相对导入。
export { z } from "zod";
export * from "../../../zcode/packages/shared/src/zcode-protocol-v4/index.ts";
