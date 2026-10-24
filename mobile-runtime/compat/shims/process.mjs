// 浏览器/ArkWeb 里若已有 window.process（nodejs-mobile、部分 polyfill）就沿用，否则建一个最小替身。
const g = globalThis;

g.process = g.process ?? {
  platform: "android",
  arch: "arm64",
  version: "v24.0.0",
  versions: { mobile: "1.0.0" },
  env: {},
  argv: [],
  pid: 1,
  ppid: 0,
  cwd: () => "/work",
  chdir: () => {},
  exit: (code) => { throw new Error("process.exit(" + code + ") 在端侧不允许"); },
  nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
  hrtime: Object.assign((prev) => {
    const t = BigInt(Math.round(performance.now() * 1e6));
    if (!prev) return [Number(t / 1000000000n), Number(t % 1000000000n)];
    const d = t - (BigInt(prev[0]) * 1000000000n + BigInt(prev[1]));
    return [Number(d / 1000000000n), Number(d % 1000000000n)];
  }, { bigint: () => BigInt(Math.round(performance.now() * 1e6)) }),
  on: () => g.process,
  off: () => g.process,
  stdout: { write: () => true, isTTY: false },
  stderr: { write: () => true, isTTY: false },
  stdin: null,
};

export default g.process;
export const platform = g.process.platform;
export const env = g.process.env;
export const argv = g.process.argv;
export const nextTick = g.process.nextTick;
export const hrtime = g.process.hrtime;
export const version = g.process.version;
export const cwd = g.process.cwd;
