import { useCallback, useEffect, useRef, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  callBridgeJson,
  getAppUpdateBridge,
  getNotifyBridge,
  type DownloadProgressResult,
  type DownloadStartResult,
  type InstallResult,
  type NotifyPermissionResult,
  type UpdateCheckResult,
} from "@/settings/mobileAppBridge.js";

/**
 * 应用内更新的流程（设置 → 常规第一项那个"版本号"点开就是它）。
 *
 * 用户原话："点击版本号名称可以检查更新，若检查到更新会弹出悬浮窗，有下载/后台下载/
 * 安装更新三个按钮，下载完可以安装更新，点击后台下载在后台通知里下载。"
 *
 * 流程与桥契约（原生侧 window.zcodeUpdate / window.zcodeNotify）：
 *   检查：checkForUpdate() → {ok,hasUpdate,current,latest,tag,url,notes,size}
 *   下载：startDownload(url, background) → {ok,jobId}；前台下载每 800ms 问一次
 *         getDownloadProgress(jobId) → {ok,state,downloaded,total,filePath}
 *   安装：installApk(filePath) → {ok} 或 {ok:false,error:"need_install_permission"}
 *   授权：openInstallPermission() 拉起"允许此来源安装应用"；通知权限走
 *         zcodeNotify.requestPermission() / hasPermission()
 *
 * 桥不在（桌面/网页宿主）→ 整行不渲染（见 appVersionUpdateRow.tsx）。
 * 浮窗本体在 appUpdateDialog.tsx。
 */

export type UpdatePhase =
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "background"
  | "failed"
  | "unavailable";

const DOWNLOAD_POLL_INTERVAL_MS = 800;
/** 等系统通知授权框的节奏与上限（原生 requestPermission 在 13+ 是异步的）。 */
const PERMISSION_POLL_INTERVAL_MS = 800;
const PERMISSION_POLL_MAX_TRIES = 15;

export type AppUpdateFlow = {
  canInstall: boolean;
  currentVersion: string;
  downloaded: number;
  error: string | null;
  info: UpdateCheckResult | null;
  needsInstallPermission: boolean;
  needsNotifyPermission: boolean;
  open: boolean;
  percent: number;
  phase: UpdatePhase;
  total: number;
  handleBackgroundDownload: () => void;
  handleCancelDownload: () => void;
  handleDownload: () => void;
  handleInstall: () => void;
  handleOpenChange: (open: boolean) => void;
  handleOpenInstallPermission: () => void;
  handleRequestNotifyPermission: () => void;
  runCheck: () => void;
};

/** 更新浮窗的全部状态与动作。抽成 hook 是为了让行组件只剩"一行设置"。 */
export function useAppUpdateFlow(): AppUpdateFlow {
  const { intl } = useZCodeIntl();
  const bridge = getAppUpdateBridge();
  const notify = getNotifyBridge();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<UpdatePhase>("checking");
  const [info, setInfo] = useState<UpdateCheckResult | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [needsNotifyPermission, setNeedsNotifyPermission] = useState(false);
  const [needsInstallPermission, setNeedsInstallPermission] = useState(false);
  const [awaitingNotifyPermission, setAwaitingNotifyPermission] = useState(false);
  const [retryInstallOnResume, setRetryInstallOnResume] = useState(false);
  /** 检查令牌：关掉浮窗后迟到的回包不能再把浮窗重新拉起来。 */
  const checkTokenRef = useRef(0);

  const runCheck = useCallback(() => {
    if (!bridge) return;
    setOpen(true);
    setPhase("checking");
    setInfo(null);
    setError(null);
    setJobId(null);
    setFilePath(null);
    setDownloaded(0);
    setTotal(0);
    setNeedsNotifyPermission(false);
    setNeedsInstallPermission(false);
    setAwaitingNotifyPermission(false);
    const token = ++checkTokenRef.current;
    // 推到下一拍再问原生：让"正在检查更新…"这一帧真的画出来（桥是同步的，
    // 直接问的话这一态根本来不及渲染）。
    window.setTimeout(() => {
      if (token !== checkTokenRef.current) return;
      const res = callBridgeJson<UpdateCheckResult>(() => bridge.checkForUpdate?.());
      if (!res || res.ok === false) {
        setPhase("unavailable");
        return;
      }
      setInfo(res);
      setPhase(res.hasUpdate === true ? "available" : "up-to-date");
    }, 0);
  }, [bridge]);

  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) checkTokenRef.current += 1;
    setOpen(next);
  }, []);

  // 前台下载进度：每 800ms 问一次原生，拿到 done 就转成"可安装"。
  useEffect(() => {
    if (!bridge || !jobId || phase !== "downloading") return;
    const timer = window.setInterval(() => {
      const res = callBridgeJson<DownloadProgressResult>(() => bridge.getDownloadProgress?.(jobId));
      if (!res || res.ok === false) {
        setPhase("failed");
        setError(res?.error ?? intl.formatMessage({ id: "settings.updateFailedUnknown" }));
        return;
      }
      setDownloaded(typeof res.downloaded === "number" ? res.downloaded : 0);
      setTotal(typeof res.total === "number" ? res.total : 0);
      if (res.state === "done") {
        setFilePath(typeof res.filePath === "string" ? res.filePath : null);
        setPhase("downloaded");
      } else if (res.state === "failed") {
        setPhase("failed");
        setError(res.error ?? intl.formatMessage({ id: "settings.updateFailedUnknown" }));
      }
    }, DOWNLOAD_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [bridge, jobId, phase, intl]);

  const startBackgroundDownload = useCallback(() => {
    const url = info?.url;
    if (!bridge || !url) return;
    const res = callBridgeJson<DownloadStartResult>(() => bridge.startDownload?.(url, true));
    if (!res || res.ok === false || !res.jobId) {
      setPhase("failed");
      setError(res?.error ?? intl.formatMessage({ id: "settings.updateFailedUnknown" }));
      return;
    }
    setJobId(res.jobId);
    setNeedsNotifyPermission(false);
    setPhase("background");
  }, [bridge, info, intl]);

  const handleDownload = useCallback(() => {
    const url = info?.url;
    if (!bridge || !url) return;
    const res = callBridgeJson<DownloadStartResult>(() => bridge.startDownload?.(url, false));
    if (!res || res.ok === false || !res.jobId) {
      setPhase("failed");
      setError(res?.error ?? intl.formatMessage({ id: "settings.updateFailedUnknown" }));
      return;
    }
    setJobId(res.jobId);
    setDownloaded(0);
    setTotal(0);
    setPhase("downloading");
  }, [bridge, info, intl]);

  const handleBackgroundDownload = useCallback(() => {
    if (!bridge) return;
    // 后台下载靠系统通知报进度，没有通知权限就是哑的下载：先要权限。
    if (!notify) {
      setNeedsNotifyPermission(true);
      return;
    }
    const permission = callBridgeJson<NotifyPermissionResult>(() => notify.requestPermission?.());
    if (permission?.ok === true && permission.granted === true) {
      startBackgroundDownload();
      return;
    }
    // 原生这次只是弹了系统授权框（13+ 的 requestPermission 是异步的，回包 granted:false，
    // 真正结果稍后才到）：先说清缺权限，同时隔一会儿重读一次——用户点"允许"后自己接上。
    setNeedsNotifyPermission(true);
    setAwaitingNotifyPermission(true);
  }, [bridge, notify, startBackgroundDownload]);

  const handleRequestNotifyPermission = useCallback(() => {
    if (!notify) return;
    const permission = callBridgeJson<NotifyPermissionResult>(() => notify.requestPermission?.());
    if (permission?.ok === true && permission.granted === true) {
      setNeedsNotifyPermission(false);
      setAwaitingNotifyPermission(false);
      startBackgroundDownload();
      return;
    }
    // 还是只弹了系统框：继续等它（下面的轮询会接上）。
    setAwaitingNotifyPermission(true);
  }, [notify, startBackgroundDownload]);

  // 等系统授权框的结果：拿到通知权限就把后台下载接上（没拿到就一直等不到）。
  useEffect(() => {
    if (!awaitingNotifyPermission || !notify) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      let granted = false;
      try {
        granted = notify.hasPermission?.() === true;
      } catch {
        granted = false;
      }
      if (granted) {
        setAwaitingNotifyPermission(false);
        startBackgroundDownload();
        return;
      }
      if (tries >= PERMISSION_POLL_MAX_TRIES) setAwaitingNotifyPermission(false);
    }, PERMISSION_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [awaitingNotifyPermission, notify, startBackgroundDownload]);

  const handleInstall = useCallback(() => {
    if (!bridge || !filePath) return;
    const res = callBridgeJson<InstallResult>(() => bridge.installApk?.(filePath));
    if (!res || res.ok === false) {
      if (res?.error === "need_install_permission") {
        setNeedsInstallPermission(true);
        return;
      }
      setPhase("failed");
      setError(res?.error ?? intl.formatMessage({ id: "settings.updateFailedUnknown" }));
    }
  }, [bridge, filePath, intl]);

  const handleOpenInstallPermission = useCallback(() => {
    if (!bridge) return;
    const res = callBridgeJson<{ ok?: boolean }>(() => bridge.openInstallPermission?.());
    if (!res || res.ok === false) {
      setError(intl.formatMessage({ id: "settings.updateInstallPermissionFailed" }));
      return;
    }
    setNeedsInstallPermission(false);
    // 系统授权页是另一个 Activity：从它回到本应用时自动重试一次安装
    // （用户在那边点完"允许"就回来了，不必再点一次"安装更新"）。
    setRetryInstallOnResume(true);
  }, [bridge, intl]);

  // 回到前台时重试安装（授权页是另一个 Activity，回来的那一刻就是"授权好了"的信号）。
  useEffect(() => {
    if (!retryInstallOnResume) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      setRetryInstallOnResume(false);
      setNeedsInstallPermission(false);
      const target = filePath;
      if (!bridge || !target) return;
      const res = callBridgeJson<InstallResult>(() => bridge.installApk?.(target));
      if (!res || res.ok === false) {
        if (res?.error === "need_install_permission") {
          setNeedsInstallPermission(true);
          return;
        }
        setPhase("failed");
        setError(res?.error ?? intl.formatMessage({ id: "settings.updateFailedUnknown" }));
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [retryInstallOnResume, bridge, filePath, intl]);

  const handleCancelDownload = useCallback(() => {
    if (!bridge || !jobId) return;
    callBridgeJson(() => bridge.cancelDownload?.(jobId));
    setJobId(null);
    setPhase("available");
  }, [bridge, jobId]);

  const currentVersion = info?.current ?? "";
  const percent = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;

  return {
    canInstall: phase === "downloaded" && Boolean(filePath),
    currentVersion,
    downloaded,
    error,
    handleBackgroundDownload,
    handleCancelDownload,
    handleDownload,
    handleInstall,
    handleOpenChange,
    handleOpenInstallPermission,
    handleRequestNotifyPermission,
    info,
    needsInstallPermission,
    needsNotifyPermission,
    open,
    percent,
    phase,
    runCheck,
    total,
  };
}
