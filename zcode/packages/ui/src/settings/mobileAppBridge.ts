/**
 * 端侧（Android）原生桥的读取口。
 *
 * 设置页里的两行——「版本号 / 检查更新」与「后台保活通知」——都靠这里探桥：
 * 桌面/网页宿主根本没有这些桥，桥不在就整行不渲染（不编一个假版本号出来）。
 * 纪律照抄 AllFilesPermissionRow（settingsCodePreview.tsx）：自包含、不穿 props 链、
 * 不进上游 store，桥的形态由这一层统一翻译。
 *
 * 为什么桥的调用写在 UI 包里、而不是端侧的 mobile-runtime/：
 * packages/ui 是端侧与桌面共用的那一半，它 import 不到仓外的 mobile-runtime/
 * （桌面构建里根本没有那条路径）。所以这一层只做三件事——桥在不在、回包怎么解析、
 * 设备版本怎么读——具体流程留给调用方。
 *
 * 契约副本：端侧同款常量（保活状态键与广播事件名）在 mobile-runtime/ui/app-update.ts。
 * 两份跨仓不能 import，必须同步——改一边就要改另一边。
 */

/** 端侧原生桥：应用内更新（window.zcodeUpdate）。 */
export type AppUpdateBridge = {
  checkForUpdate?(): string;
  startDownload?(url: string, background: boolean): string;
  getDownloadProgress?(jobId: string): string;
  cancelDownload?(jobId: string): string;
  installApk?(filePath: string): string;
  openInstallPermission?(): string;
};

/** 端侧原生桥：通知与后台保活（window.zcodeNotify）。 */
export type NotifyBridge = {
  requestPermission?(): string;
  hasPermission?(): boolean;
  notify?(id: string, title: string, text: string, ongoing: boolean): string;
  setKeepAlive?(enabled: boolean): string;
};

/** 端侧原生桥：设备信息（window.zcodeDevice）。 */
export type DeviceBridge = {
  deviceInfo?(): string;
};

/** checkForUpdate 的回包。 */
export type UpdateCheckResult = {
  ok?: boolean;
  hasUpdate?: boolean;
  current?: string;
  currentCode?: number;
  latest?: string;
  tag?: string;
  url?: string;
  notes?: string;
  size?: number;
};

/** startDownload 的回包。 */
export type DownloadStartResult = {
  ok?: boolean;
  jobId?: string;
  error?: string;
};

/** getDownloadProgress 的回包。 */
export type DownloadProgressResult = {
  ok?: boolean;
  state?: "running" | "done" | "failed";
  downloaded?: number;
  total?: number;
  filePath?: string;
  error?: string;
};

/** installApk 的回包。 */
export type InstallResult = {
  ok?: boolean;
  error?: string;
  canRequest?: boolean;
};

/** requestPermission 的回包。 */
export type NotifyPermissionResult = {
  ok?: boolean;
  granted?: boolean;
};

/** 当前装机版本（来自 window.zcodeDevice.deviceInfo）。 */
export type AppVersionInfo = {
  version: string;
  versionCode: number | null;
};

/** 解析桥回包。桥回的是 JSON 字符串；解析失败一律当"没有回包"，不抛给 UI。 */
export function parseBridgeJson<T>(raw: unknown): T | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as T) : null;
  } catch {
    return null;
  }
}

/** 调一次桥并解析回包。桥抛异常（原生没装好/参数不对）时返回 null，不让 UI 崩。 */
export function callBridgeJson<T>(call: () => string | undefined | null): T | null {
  try {
    return parseBridgeJson<T>(call());
  } catch {
    return null;
  }
}

/**
 * 宿主全局。浏览器里 globalThis === window；用 globalThis 而不是 window 是因为
 * 端侧自检脚本在 Node 里直接注入全局桥做判据（window 不存在）。
 */
function hostGlobal(): typeof globalThis {
  return globalThis;
}

/** 应用内更新桥。桌面/网页宿主没有它 → undefined（调用方据此整行不渲染）。 */
export function getAppUpdateBridge(): AppUpdateBridge | undefined {
  const bridge = (hostGlobal() as { zcodeUpdate?: AppUpdateBridge }).zcodeUpdate;
  return bridge && typeof bridge.checkForUpdate === "function" ? bridge : undefined;
}

/** 通知/保活桥。 */
export function getNotifyBridge(): NotifyBridge | undefined {
  const bridge = (hostGlobal() as { zcodeNotify?: NotifyBridge }).zcodeNotify;
  return bridge && typeof bridge.requestPermission === "function" ? bridge : undefined;
}

/** 设备信息桥（版本号的来源）。 */
export function getDeviceBridge(): DeviceBridge | undefined {
  const bridge = (hostGlobal() as { zcodeDevice?: DeviceBridge }).zcodeDevice;
  return bridge && typeof bridge.deviceInfo === "function" ? bridge : undefined;
}

/**
 * 当前装机版本。版本随构建变，**不许硬编码**——读原生桥给的同一份读数
 * （装机报告靠它区分版本）。
 *
 * 按桥对象身份缓存一次：版本在进程生命周期内不会变，而原生桥被别的操作占住时，
 * 反复读版本会把页面输入一起堵住（端侧装机反馈）。桥换了（热重载/重新注入）就重读。
 */
let cachedAppVersion: { bridge: DeviceBridge; info: AppVersionInfo } | null = null;

export function readAppVersionInfo(): AppVersionInfo | null {
  const bridge = getDeviceBridge();
  if (!bridge) return null;
  if (cachedAppVersion?.bridge === bridge) return cachedAppVersion.info;
  const info = callBridgeJson<{ appVersion?: unknown; appVersionCode?: unknown }>(() =>
    bridge.deviceInfo?.(),
  );
  const version = typeof info?.appVersion === "string" ? info.appVersion.trim() : "";
  if (!version) return null;
  const rawCode = info?.appVersionCode;
  const result: AppVersionInfo = {
    version,
    versionCode: typeof rawCode === "number" ? rawCode : null,
  };
  cachedAppVersion = { bridge, info: result };
  return result;
}

/** 字节数 → 可读体积。原生给的是字节；给不出体积就不显示这一行。 */
export function formatUpdateSize(size: number | undefined): string | null {
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) return null;
  const mb = size / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}
