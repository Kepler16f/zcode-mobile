export const EOL = "\n";
export const homedir = () => "/root";
export const tmpdir = () => "/tmp";
export const hostname = () => "zcode-mobile";
export const platform = () => "android";
export const arch = () => "arm64";
export const cpus = () => [{ model: "mobile" }];
// Node 22+ 的 availableParallelism；上游拿它定并发度，用 navigator 的真实核数而不是写死 1。
export const availableParallelism = () => globalThis.navigator?.hardwareConcurrency ?? 1;
export const totalmem = () => 4 * 1024 * 1024 * 1024;
export const freemem = () => 2 * 1024 * 1024 * 1024;
export const userInfo = () => ({ uid: 0, gid: 0, username: "zcode", homedir: "/root" });
export const networkInterfaces = () => ({});
export const release = () => "0";
// 上游拿 os.version() 只做遥测/诊断字符串（offPeakTaskService → providers/sourceHeaders.ts），
// 不参与任何判定分支，所以给"宿主能给到的那一段"而不是编一个内核版本号。
export const version = () => {
  const ua = globalThis.navigator?.userAgent ?? "";
  const android = ua.match(/Android\s+([\d.]+)/);
  if (android) return `Android ${android[1]}`;
  return navigator.userAgent ? "unknown-webview" : "unknown";
};
