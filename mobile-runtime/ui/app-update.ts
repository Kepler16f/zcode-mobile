// 端侧胶水：应用内更新桥（window.zcodeUpdate）的唯一读法。纯函数 + 类型，
// **桌面/网页宿主没有这些桥时一律安全返回**（null/false），不抛异常、不假设桥存在。
//
// 为什么这一份存在、而 UI 侧还有一份（packages/ui/src/settings/mobileAppBridge.ts）：
// 上游 packages/ui 是端侧与桌面共用的那一半，它 import 不到仓外的 mobile-runtime/
// （桌面构建里根本没有那条路径），所以 UI 侧必须自带一个最薄的读口。两边读的是同一批
// 桥、同一套 JSON 回包形状，行为一致。
//
// 保活契约（状态键 / 广播事件名）**只有一份**，就在同目录的 app-notify.ts（端侧 C 线那
// 份）：`zcode-mobile.keepAlive` + `zcode-mobile:keep-alive-changed`。这里只转出它，
// 不另抄一份——抄一份就是两份契约迟早会漂。

import {
  KEEP_ALIVE_EVENT,
  KEEP_ALIVE_STORAGE_KEY,
  isKeepAliveEnabled,
  setKeepAliveEnabled,
} from "./app-notify.js";

export { KEEP_ALIVE_EVENT, KEEP_ALIVE_STORAGE_KEY };

/** 应用内更新桥（window.zcodeUpdate）。 */
export type AppUpdateBridge = {
  checkForUpdate?(): string;
  startDownload?(url: string, background: boolean): string;
  getDownloadProgress?(jobId: string): string;
  cancelDownload?(jobId: string): string;
  installApk?(filePath: string): string;
  openInstallPermission?(): string;
};

/** 通知与后台保活桥（window.zcodeNotify）。 */
export type NotifyBridge = {
  requestPermission?(): string;
  hasPermission?(): boolean;
  notify?(id: string, title: string, text: string, ongoing: boolean): string;
  setKeepAlive?(enabled: boolean): string;
};

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

export type DownloadStartResult = {
  ok?: boolean;
  jobId?: string;
  error?: string;
};

export type DownloadProgressResult = {
  ok?: boolean;
  state?: "running" | "done" | "failed";
  downloaded?: number;
  total?: number;
  filePath?: string;
  error?: string;
};

export type InstallResult = {
  ok?: boolean;
  error?: string;
  canRequest?: boolean;
};

export type NotifyPermissionResult = {
  ok?: boolean;
  granted?: boolean;
};

function hostGlobal(): typeof globalThis {
  return globalThis;
}

/** 解析桥回包（桥回的是 JSON 字符串）。解析失败当"没有回包"。 */
export function parseBridgeJson<T>(raw: unknown): T | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as T) : null;
  } catch {
    return null;
  }
}

function callBridgeJson<T>(call: () => string | undefined | null): T | null {
  try {
    return parseBridgeJson<T>(call());
  } catch {
    return null;
  }
}

/** 应用内更新桥。桥不在（桌面/网页宿主）→ undefined。 */
export function getAppUpdateBridge(): AppUpdateBridge | undefined {
  const bridge = (hostGlobal() as { zcodeUpdate?: AppUpdateBridge }).zcodeUpdate;
  return bridge && typeof bridge.checkForUpdate === "function" ? bridge : undefined;
}

/** 通知/保活桥。桥不在 → undefined。 */
export function getNotifyBridge(): NotifyBridge | undefined {
  const bridge = (hostGlobal() as { zcodeNotify?: NotifyBridge }).zcodeNotify;
  return bridge && typeof bridge.requestPermission === "function" ? bridge : undefined;
}

/** 检查更新。桥不在或回包不可解析 → null（调用方据此说"更新检查不可用"）。 */
export function checkForUpdate(): UpdateCheckResult | null {
  const bridge = getAppUpdateBridge();
  if (!bridge) return null;
  return callBridgeJson<UpdateCheckResult>(() => bridge.checkForUpdate?.());
}

/** 起一次下载。background=true 走系统通知（后台下载）。拿不到 jobId → null。 */
export function startDownload(url: string, background: boolean): string | null {
  const bridge = getAppUpdateBridge();
  if (!bridge || !url) return null;
  const res = callBridgeJson<DownloadStartResult>(() => bridge.startDownload?.(url, background));
  if (!res || res.ok === false || !res.jobId) return null;
  return res.jobId;
}

/** 下载进度。 */
export function getDownloadProgress(jobId: string): DownloadProgressResult | null {
  const bridge = getAppUpdateBridge();
  if (!bridge || !jobId) return null;
  return callBridgeJson<DownloadProgressResult>(() => bridge.getDownloadProgress?.(jobId));
}

/** 取消下载。 */
export function cancelDownload(jobId: string): boolean {
  const bridge = getAppUpdateBridge();
  if (!bridge || !jobId) return false;
  const res = callBridgeJson<{ ok?: boolean }>(() => bridge.cancelDownload?.(jobId));
  return res?.ok === true;
}

/** 安装已下载的 APK。 */
export function installApk(filePath: string): InstallResult | null {
  const bridge = getAppUpdateBridge();
  if (!bridge || !filePath) return null;
  return callBridgeJson<InstallResult>(() => bridge.installApk?.(filePath));
}

/** 拉起"安装未知应用"的系统授权页。 */
export function openInstallPermission(): boolean {
  const bridge = getAppUpdateBridge();
  if (!bridge) return false;
  const res = callBridgeJson<{ ok?: boolean }>(() => bridge.openInstallPermission?.());
  return res?.ok === true;
}

/** 申请通知权限（后台下载与后台保活都要它）。桥不在 → false。 */
export function requestNotificationPermission(): boolean {
  const bridge = getNotifyBridge();
  if (!bridge) return false;
  const res = callBridgeJson<NotifyPermissionResult>(() => bridge.requestPermission?.());
  return res?.ok === true && res.granted === true;
}

/** 当前是否已有通知权限。 */
export function hasNotificationPermission(): boolean {
  const bridge = getNotifyBridge();
  if (!bridge || typeof bridge.hasPermission !== "function") return false;
  try {
    return bridge.hasPermission() === true;
  } catch {
    return false;
  }
}

/** 后台保活开关的当前状态（缺省=关）。契约在 app-notify.ts，这里只是转出。 */
export { isKeepAliveEnabled, setKeepAliveEnabled };
