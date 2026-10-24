// contracts/src/network/public-egress-ip.ts 只用 isIP + BlockList 做 SSRF 判定，
// 不需要真 socket。这里按 CIDR 精确匹配，语义对齐 Node。
export function isIP(v) {
  return isIPv4(v) ? 4 : isIPv6(v) ? 6 : 0;
}

export function isIPv4(v) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(v));
  return !!m && m.slice(1).every((x) => Number(x) <= 255);
}

export function isIPv6(v) {
  const s = String(v);
  if (!/^[0-9a-fA-F:.]+$/.test(s) || (!s.includes(":") && !s.startsWith("::"))) return false;
  const parts = s.split(":");
  if (parts.length > 8) return false;
  return parts.every((p) => p === "" || /^[0-9a-fA-F]{1,4}$/.test(p) || isIPv4(p));
}

function toU32(v4) {
  return v4.split(".").reduce((acc, x) => (acc << 8) + Number(x), 0) >>> 0;
}

function normalize(v) {
  const s = String(v).replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:([\d.]+)$/i.exec(s) || /^::ffff:([0-9a-f:]{1,4})$/i.exec(s);
  if (mapped && isIPv4(mapped[1])) return mapped[1];
  return s;
}

export class BlockList {
  constructor() {
    this.v4 = [];
    this.v6 = [];
  }
  addAddress(addr, kind = "ipv4") {
    if (kind === "ipv6") this.v6.push(normalize(addr) + "/128");
    else this.v4.push([toU32(normalize(addr)), 32]);
  }
  addSubnet(addr, prefix, kind = "ipv4") {
    if (kind === "ipv6") this.v6.push(`${normalize(addr)}/${prefix}`);
    else this.v4.push([toU32(normalize(addr)) >>> (32 - prefix) << (32 - prefix), prefix]);
  }
  check(addr, kind = "ipv4") {
    const n = normalize(addr);
    if (kind === "ipv6") {
      const v4mapped = /^::ffff:([\d.]+)$/i.exec(n);
      if (v4mapped && isIPv4(v4mapped[1])) return this.check(v4mapped[1], "ipv4");
      return this.v6.some((c) => v6InCidr(n, c));
    }
    const v = toU32(n);
    return this.v4.some(([base, p]) => (v >>> (32 - p)) === (base >>> (32 - p)));
  }
  toArray() {
    return { ipv4: this.v4.map(([b, p]) => `${u32ToIp(b)}/${p}`), ipv6: this.v6 };
  }
}

function u32ToIp(x) {
  return [(x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255].join(".");
}

function v6InCidr(addr, cidr) {
  const [net, p] = cidr.split("/");
  const a = expand6(addr);
  const b = expand6(net);
  if (a === null || b === null) return false;
  const bits = Number(p);
  for (let i = 0; i < 8; i++) {
    const mask = bits >= (i + 1) * 16 ? 0xffff : bits <= i * 16 ? 0 : (0xffff << (16 - (bits - i * 16))) & 0xffff;
    if ((a[i] & mask) !== (b[i] & mask)) return false;
  }
  return true;
}

function expand6(s) {
  const str = String(s);
  if (!str.includes(":")) return null;
  const sides = str.split("::");
  if (sides.length > 2) return null;
  const head = sides[0] ? sides[0].split(":").map(hex) : [];
  const tail = sides[1] ? sides[1].split(":").map(hex) : [];
  if (sides.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    return [...head, ...Array(fill).fill(0), ...tail];
  }
  return head.length + tail.length === 8 ? [...head, ...tail] : null;
}

function hex(x) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(x)) {
    const [a, b, c, d] = x.split(".").map(Number);
    return (a << 8) | b;
  }
  return parseInt(x, 16) || 0;
}
