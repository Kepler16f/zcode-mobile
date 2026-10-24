// undici 是 Node 的 HTTP 客户端，端侧没有它，也**不该**把它打进包：
// 它自己还要拉 assert/stream/events/zlib/worker_threads/http2/dns… 一整套 Node 内置模块
// （实测 accountProviderConnectionResolver 的闭包因此从 0 个缺失垫片变成 11 类 53 次）。
//
// 引到它的是 services/src/providers/api/nodeApiNetwork.ts:3 —— Node 版 ApiClient 的网络栈，
// 用途是代理 + 自定义 CA（桌面宿主能力）。端侧组合根一律给 fetch 版 ApiClient（见 ui/oauth.ts），
// 所以这个文件在包里只会被 import、不会被调用。构造即抛，是为了万一有人改了装配顺序时
// 当场炸出"端侧没有 undici"，而不是安静地走出一条没有代理语义的网络路径。
export class Agent {
  constructor() {
    throw new Error("mobile-compat: 端侧没有 undici。ApiClient 由组合根注入 fetch 版，见 PORTING §1.5.15。");
  }
}

export class ProxyAgent extends Agent {}
export class EnvHttpProxyAgent extends Agent {}
export class Dispatcher extends Agent {}

export function fetch() {
  throw new Error("mobile-compat: 端侧不用 undici 的 fetch，请用 WebView 的 globalThis.fetch。");
}

export function setGlobalDispatcher() {
  throw new Error("mobile-compat: 端侧没有 undici 的全局 dispatcher。");
}

export function getGlobalDispatcher() {
  throw new Error("mobile-compat: 端侧没有 undici 的全局 dispatcher。");
}

export default { Agent, ProxyAgent, EnvHttpProxyAgent, Dispatcher, fetch, setGlobalDispatcher, getGlobalDispatcher };
