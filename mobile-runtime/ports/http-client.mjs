// HttpClientPort 的端侧实现：浏览器/WebView 的 fetch 就是唯一的出网点。
// 契约见 contracts/src/interfaces/http-client.port.ts。
// egressPolicy="public" 在桌面端是防 SSRF 的；手机上设备就处在用户局域网里，
// 被提示注入的 URL 打内网风险更高，所以这里同样拦字面量的私有/回环地址。
const SUPPORTED_METHODS = new Set(["GET", "HEAD", "POST"]);
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

function ipToV4Int(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

/**
 * IPv6 字面量展开成 8 段 16 进制；不是 IPv6 字面量则返回 null。
 * 必须先展开再判，否则 0:0:0:0:0:0:0:1 这类写法能绕过前缀检查。
 */
function expandIpv6(host) {
  if (!host.includes(":")) return null;
  let h = host;
  const zone = h.indexOf("%");
  if (zone >= 0) h = h.slice(0, zone);
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 1 ? [] : halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (head.length + tail.length > 8) return null;
  const out = [];
  const push = (part) => {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return false;
    out.push(parseInt(part, 16));
    return true;
  };
  for (const part of head) if (!push(part)) return null;
  for (let i = head.length + tail.length; i < 8; i++) out.push(0);
  for (const part of tail) if (!push(part)) return null;
  return out.length === 8 ? out : null;
}

function isPrivateIpv4Value(u) {
  // JS 的位运算返回有符号 32 位，192.168/169.254 这类高位地址会翻成负数，
  // 不 >>> 0 归正的话掩码比较永远不成立（实测漏掉了这两个网段）。
  const v = u >>> 0;
  const m8 = (v & 0xff000000) >>> 0;
  const m16 = (v & 0xffff0000) >>> 0;
  if (m8 === 0x0a000000) return true; // 10/8
  if (m16 >= 0xac100000 && m16 <= 0xac1f0000) return true; // 172.16/12
  if (m16 === 0xa9fe0000) return true; // 169.254/16，含云元数据地址
  if (m8 === 0x7f000000) return true; // 127/8
  if (m8 === 0x00000000) return true; // 0/8
  if (m16 === 0xc0a80000) return true; // 192.168/16
  return false;
}

function isPrivateIpv6(hextets) {
  if (hextets.every((x) => x === 0)) return true; // ::
  if (hextets.slice(0, 7).every((x) => x === 0) && hextets[7] === 1) return true; // ::1
  if ((hextets[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  if ((hextets[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  // ::ffff:a.b.c.d 与 ::ffff:7f00:1 两种写法都要认：WHATWG URL 会把前者
  // 归一化成后者（[::ffff:127.0.0.1] → [::ffff:7f00:1]），只认点分写法会漏。
  if (hextets.slice(0, 5).every((x) => x === 0) && hextets[5] === 0xffff) {
    const v4 = (((hextets[6] & 0xffff) << 16) | (hextets[7] & 0xffff)) >>> 0;
    if (isPrivateIpv4Value(v4)) return true;
  }
  return false;
}

function isPrivateLiteral(host) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0") return true;
  const v4 = ipToV4Int(h);
  if (v4 !== null) {
    return isPrivateIpv4Value(v4);
  }
  // IPv6：::、::1、fe80::/10 链路本地、fc00::/7 ULA、::ffff:v4 映射。
  // 这里必须走「先展开再判」，不能用 startsWith 前缀：那既漏掉
  // 0:0:0:0:0:0:0:1 这类展开写法，又会把 fcs.example.com 这种正常域名误判成内网。
  const hextets = expandIpv6(h);
  if (hextets === null) return false;
  return isPrivateIpv6(hextets);
}

export function createMobileHttpClientPort(deps) {
  const { HttpClientPortError } = deps;
  const err = (code, message, extra = {}) =>
    new HttpClientPortError({ code, message, cause: extra.cause, url: extra.url, status: extra.status });

  return {
    async request(request, options = {}) {
      const startedAt = performance.now();
      let url;
      try {
        url = new URL(request.url);
      } catch {
        throw err("invalid_url", `URL 非法: ${request.url}`);
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw err("unsupported_protocol", `不支持的协议: ${url.protocol}`, { url: request.url });
      }
      if (request.egressPolicy === "public" && isPrivateLiteral(url.hostname)) {
        throw err("egress_blocked", `内网地址被 egress 策略拒绝: ${url.hostname}`, { url: request.url });
      }
      const method = request.method ?? "GET";
      if (!SUPPORTED_METHODS.has(method)) {
        throw err("invalid_url", `不支持的方法: ${method}`, { url: request.url });
      }

      const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const maxBytes = request.maxResponseBytes ?? DEFAULT_MAX_BYTES;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
      const onOuterAbort = () => controller.abort(new Error("cancelled"));
      options.signal?.addEventListener("abort", onOuterAbort);

      let res;
      try {
        res = await fetch(url.href, {
          method,
          headers: request.headers,
          body: method === "GET" || method === "HEAD" ? undefined : request.body,
          redirect: request.redirect === "manual" ? "manual" : "follow",
          signal: controller.signal,
        });
      } catch (e) {
        const reason = String(controller.signal.reason?.message ?? e?.message ?? e);
        if (reason.includes("timeout")) throw err("timeout", `请求超时(${timeoutMs}ms): ${url.href}`, { cause: e, url: request.url });
        if (reason.includes("cancelled")) throw err("cancelled", `请求被取消: ${url.href}`, { cause: e, url: request.url });
        throw err("network_error", `网络失败: ${reason}`, { cause: e, url: request.url });
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onOuterAbort);
      }

      // 不能先 arrayBuffer() 再比大小：手机上一个 500 MB 的响应会在判断之前就把进程打死（§7 R6）。
      const declared = Number(res.headers.get("content-length") ?? NaN);
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw err("too_large", `响应超过上限: ${declared} > ${maxBytes} 字节`, { url: request.url, status: res.status });
      }
      let buffer;
      if (res.body && typeof res.body.getReader === "function") {
        const reader = res.body.getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > maxBytes) {
            await reader.cancel();
            throw err("too_large", `响应超过上限: > ${maxBytes} 字节`, { url: request.url, status: res.status });
          }
          chunks.push(value);
        }
        buffer = new Uint8Array(total);
        let at = 0;
        for (const c of chunks) {
          buffer.set(c, at);
          at += c.length;
        }
      } else {
        buffer = new Uint8Array(await res.arrayBuffer());
        if (buffer.length > maxBytes) {
          throw err("too_large", `响应超过上限: ${buffer.length} > ${maxBytes} 字节`, { url: request.url, status: res.status });
        }
      }
      const headers = {};
      res.headers.forEach((value, key) => {
        headers[key] = value;
      });

      return {
        url: res.url || url.href,
        status: res.status,
        statusText: res.statusText,
        headers,
        body: buffer,
        bytes: buffer.length,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        egress: { proxied: false, customCa: false },
      };
    },
  };
}
