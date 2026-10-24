// 上游只有 nodeApiNetwork.ts:2 读 `rootCertificates`，用途是"自定义企业 CA 要追加到 Node 默认根证书"
// （nodeApiNetwork.ts:24）。端侧没有 Node 的 TLS 栈——HTTPS 由 WebView/系统信任库负责，
// 而组合根给的是 fetch 版 ApiClient，这条路径不会被调用。
// 所以这里给空数组而不是假装有一份系统根证书：值只会被拼进 CA 列表，多一个都不会有，
// 真要用 Node TLS 的那条路（代理 + 自定义 CA）在端侧是明确不支持，调用即抛。
export const rootCertificates = [];

export function connect() {
  throw new Error("mobile-compat: 端侧没有 node:tls。代理与自定义 CA 属于桌面宿主能力，见 PORTING §1.5 未接入清单。");
}

export function checkServerIdentity() {
  throw new Error("mobile-compat: 端侧没有 node:tls 证书校验，校验在系统信任库里完成。");
}

export default { rootCertificates, connect, checkServerIdentity };
