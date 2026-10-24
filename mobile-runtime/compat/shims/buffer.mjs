// node:buffer 的 Buffer 命名导出（oauth/zaiProviderAdapter.ts:1、oauth/repo/oauthCredentialRepo.ts:2 用它做 base64url）。
// 直接引 polyfill 而不是读 globalThis.Buffer：inject 的 prelude 与本模块的求值顺序没有保证，
// 拿到的可能是 undefined，而那种失败要等到某次解码才炸。
import { Buffer as PolyfillBuffer } from "../../../zcode/node_modules/buffer/index.js";

export const Buffer = PolyfillBuffer;
