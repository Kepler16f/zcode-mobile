import { useCallback, useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { readSafeLocalStorage, writeSafeLocalStorage } from "@/lib/browserEnvironment.js";
import {
  callBridgeJson,
  getNotifyBridge,
  type NotifyPermissionResult,
} from "@/settings/mobileAppBridge.js";

/**
 * 设置 → 常规里紧挨版本号行的第二项：后台保活通知开关。
 *
 * 用户原话"通知保活也要一个开关"——放在版本号行下面（同分区、同卡片组内），
 * 不另开分区。
 *
 * 状态与广播契约（与端侧 C 线共用，别各写一份）：
 *   - 状态键 localStorage `zcode-mobile.keepAlive`："1"=开、"0"=关、缺省=关
 *     （不主动骚扰用户）。
 *   - 变更时 dispatch 窗口事件 `zcode-mobile:keep-alive-changed`（detail:{enabled:boolean}），
 *     端侧监听后即时生效（它读同一个键 + 监听同一个事件）。
 *   端侧同款常量在 mobile-runtime/ui/app-notify.ts（跨仓不能 import，两份必须同步）。
 *
 * 开"通知保活"必须先有通知权限：没有系统通知，后台保活就是哑的（端侧连进度都报不出来）。
 * 所以切"开"时先问原生要权限：
 *   - 原生已经授权（requestPermission 回 granted:true）→ 落 "1" + 广播。
 *   - 原生这次只是弹了系统授权框（13+ 的 requestPermission 是异步的，回包 granted:false，
 *     真正结果稍后才到）→ 开关先留在关的位置、描述里说清原因，同时隔一会儿重读一次
 *     hasPermission()：用户一旦在系统框里点了"允许"，开关自己亮起来（权限没拿到之前
 *     绝不会落 "1"）。
 *   - 用户拒绝 → 权限一直读不到，开关留在关的位置，描述里写着需要通知权限。
 *
 * 桥不在（桌面/网页宿主没有 zcodeNotify）→ 整行不渲染。
 */

const KEEP_ALIVE_STORAGE_KEY = "zcode-mobile.keepAlive";
const KEEP_ALIVE_CHANGED_EVENT = "zcode-mobile:keep-alive-changed";
/** 权限回读节奏与上限：系统授权框是异步的，等它一会儿。 */
const PERMISSION_POLL_INTERVAL_MS = 800;
const PERMISSION_POLL_MAX_TRIES = 15;

function readKeepAliveEnabled(): boolean {
  return readSafeLocalStorage(KEEP_ALIVE_STORAGE_KEY) === "1";
}

function writeKeepAliveEnabled(enabled: boolean): void {
  writeSafeLocalStorage(KEEP_ALIVE_STORAGE_KEY, enabled ? "1" : "0");
}

function broadcastKeepAlive(enabled: boolean): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(KEEP_ALIVE_CHANGED_EVENT, { detail: { enabled } }));
}

export function KeepAliveNotificationRow() {
  const { intl } = useZCodeIntl();
  const notify = getNotifyBridge();
  const [enabled, setEnabled] = useState(readKeepAliveEnabled);
  const [error, setError] = useState<string | null>(null);
  const [permissionPending, setPermissionPending] = useState(false);

  const enable = useCallback(() => {
    writeKeepAliveEnabled(true);
    setEnabled(true);
    setError(null);
    setPermissionPending(false);
    broadcastKeepAlive(true);
  }, []);

  // 系统授权框的结果是异步回来的：这里隔一会儿重读一次权限，读到了就把开关点亮。
  useEffect(() => {
    if (!permissionPending || !notify) return;
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
        enable();
        return;
      }
      if (tries >= PERMISSION_POLL_MAX_TRIES) setPermissionPending(false);
    }, PERMISSION_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [permissionPending, notify, enable]);

  if (!notify) return null;

  const toggle = (next: boolean) => {
    setError(null);
    if (!next) {
      writeKeepAliveEnabled(false);
      setEnabled(false);
      setPermissionPending(false);
      broadcastKeepAlive(false);
      return;
    }
    const permission = callBridgeJson<NotifyPermissionResult>(() => notify.requestPermission?.());
    if (permission?.ok === true && permission.granted === true) {
      enable();
      return;
    }
    // 还没拿到权限：开关留在关的位置。原因写进描述（错误样式照 AllFilesPermissionRow）。
    setError(intl.formatMessage({ id: "settings.keepAliveNotification.needsPermission" }));
    setPermissionPending(true);
  };

  return (
    <SettingsRow
      label={intl.formatMessage({ id: "settings.keepAliveNotification" })}
      description={
        <>
          {intl.formatMessage({ id: "settings.keepAliveNotificationDescription" })}
          {error ? <span className="mt-1 block text-ui-base text-destructive">{error}</span> : null}
        </>
      }
      control={
        <Switch
          aria-label={intl.formatMessage({ id: "settings.keepAliveNotification" })}
          checked={enabled}
          data-testid="settings-keep-alive-switch"
          onCheckedChange={toggle}
        />
      }
    />
  );
}
