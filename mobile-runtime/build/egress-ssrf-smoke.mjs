// 出网地址拦截冒烟：egress=public 必须拦住回环/链路本地/私网/ULA 的各种等价写法。
// 起因是 isPrivateLiteral 原来用 startsWith("fc")/startsWith("fe80") 判前缀，
// 漏掉 0:0:0:0:0:0:0:1、::ffff:7f00:1 这类展开写法，还把 fcs.example.com 误判成内网。
import { createMobileHttpClientPort } from "../ports/http-client.mjs";

class HttpClientPortError extends Error {
  constructor(options) {
    super(options.message);
    this.code = options.code;
    this.url = options.url;
    this.status = options.status;
  }
}

const port = createMobileHttpClientPort({ HttpClientPortError });
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

// 必须被拦：回环、0/8、私网、链路本地、以及它们的各种 IPv6 等价写法。
const blocked = [
  "http://127.0.0.1/x",
  "http://127.1.2.3/x",
  "http://0.0.0.0/",
  "http://10.0.0.5/",
  "http://172.16.5.4/",
  "http://192.168.1.1/",
  "http://169.254.169.254/latest/meta-data/",
  "http://localhost/",
  "http://api.localhost/",
  "http://[::1]/",
  "http://[::]/",
  "http://[0:0:0:0:0:0:0:1]/",
  "http://[::ffff:127.0.0.1]/",
  "http://[::ffff:7f00:1]/",
  "http://[::ffff:169.254.169.254]/",
  "http://[fe80::1]/",
  "http://[febf::1]/",
  "http://[fc00::1]/",
  "http://[fd12:3456::1]/",
];

// 不能被误伤：公网域名、公网 IP、公网 IPv6。
const allowed = [
  "http://example.com/",
  "http://8.8.8.8/",
  "http://[2001:4860:4860::8888]/",
  "http://[2606:4700::1111]/",
  "http://fcs.example.com/",
];

const problems = [];
const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls++;
  return new Response("ok", { status: 200 });
};
try {
for (const url of blocked) {
  try {
    await port.request({ url, egressPolicy: "public" });
    problems.push(`未拦: ${url}`);
  } catch (error) {
    if (error.code !== "egress_blocked") problems.push(`${url} -> ${error.code}`);
  }
}
for (const url of allowed) {
  try {
    await port.request({ url, egressPolicy: "public" });
  } catch (error) {
    problems.push(`公网请求失败: ${url} -> ${error.code}`);
  }
}

check(fetchCalls === allowed.length, `实际出网调用数错误: ${fetchCalls}`);
check(problems.length === 0, problems.join(" | "));
console.log(`egress-ssrf-smoke: PASS（拦 ${blocked.length} 个内网写法，放行 ${allowed.length} 个公网写法）`);
} finally {
  globalThis.fetch = originalFetch;
}
