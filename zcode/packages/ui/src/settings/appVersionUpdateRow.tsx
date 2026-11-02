import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  getAppUpdateBridge,
  getNotifyBridge,
  readAppVersionInfo,
  type AppVersionInfo,
} from "@/settings/mobileAppBridge.js";
import { AppUpdateDialog } from "@/settings/appUpdateDialog.js";
import { useAppUpdateFlow } from "@/settings/appUpdateFlow.js";

/**
 * 设置 → 常规的第一项：版本号 + 应用内更新浮窗（用户原话"把 azcode 版本号信息换个地方
 * 显示，移动到设置里的第一个选项"、"点击版本号名称可以检查更新，若检查到更新会弹出悬浮窗，
 * 有下载/后台下载/安装更新三个按钮"）。
 *
 * 为什么在 UI 包里、而不是端侧：这一行要出现在上游的设置页里（packages/ui 是端侧与桌面
 * 共用的那一半），而它读的是原生桥 window.zcodeUpdate —— 与 AllFilesPermissionRow 同一
 * 套纪律：自包含、不穿 props 链、不进上游 store，桥不在就整行不渲染（桌面/网页宿主没有
 * 这条链路，不编一个假版本号）。
 *
 * 版本号从 window.zcodeDevice.deviceInfo() 读（版本随构建变，不硬编码）。
 * 浮窗与流程在 appUpdateDialog.tsx（这个文件只负责"一行设置"）。
 */
export function AppVersionUpdateRow() {
  const { intl } = useZCodeIntl();
  const bridge = getAppUpdateBridge();
  const notify = getNotifyBridge();
  const [versionInfo, setVersionInfo] = useState<AppVersionInfo | null>(null);
  const flow = useAppUpdateFlow();

  useEffect(() => {
    setVersionInfo(readAppVersionInfo());
  }, []);

  if (!bridge) return null;

  // 版本号来自原生桥（随构建变，不硬编码）；桥没给数时先占位，别露出"版本 "这种半截话。
  const currentVersion = versionInfo?.version ?? flow.info?.current ?? "—";

  return (
    <>
      <SettingsRow
        label={
          <button
            type="button"
            data-testid="settings-app-version-label"
            className="text-left hover:underline"
            onClick={flow.runCheck}
          >
            {intl.formatMessage({ id: "settings.appVersion" }, { version: currentVersion })}
            {versionInfo?.versionCode != null ? (
              <span className="text-foreground-subtlest">
                {intl.formatMessage(
                  { id: "settings.appVersionCode" },
                  { code: versionInfo.versionCode },
                )}
              </span>
            ) : null}
          </button>
        }
        description={intl.formatMessage({ id: "settings.appVersionDescription" })}
        control={
          <Button type="button" size="lg" variant="outline" onClick={flow.runCheck}>
            {intl.formatMessage({ id: "settings.appVersionCheck" })}
          </Button>
        }
      />
      <AppUpdateDialog flow={flow} notifyAvailable={notify !== undefined} />
    </>
  );
}
