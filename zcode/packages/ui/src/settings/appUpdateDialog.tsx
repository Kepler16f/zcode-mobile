import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Progress } from "@/components/ui/progress.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatUpdateSize } from "@/settings/mobileAppBridge.js";
import type { AppUpdateFlow } from "@/settings/appUpdateFlow.js";

/**
 * 更新浮窗本体（流程在 appUpdateFlow.ts）。
 *
 * 宽度按手机屏算（w-[calc(100vw-32px)] max-w-sm），按钮竖排、每个可点区域 ≥44px
 * （手指够得着；上游桌面习惯的 h-8 按钮在手机上按不准）。
 */
export function AppUpdateDialog({
  flow,
  notifyAvailable,
}: {
  flow: AppUpdateFlow;
  notifyAvailable: boolean;
}) {
  const { intl } = useZCodeIntl();
  const { info, phase } = flow;
  const currentVersion = info?.current ?? flow.currentVersion;
  const sizeLabel = formatUpdateSize(info?.size);
  const isDownloading = phase === "downloading";
  const titleId =
    phase === "available" || phase === "downloading" || phase === "downloaded"
      ? "settings.appVersionUpdateFound"
      : "settings.updateDialogTitle";

  return (
    <Dialog open={flow.open} onOpenChange={flow.handleOpenChange}>
      {/* 宽度用**内联样式**而不是 Tailwind 任意值类：端侧 APK 携带的是 checked-in 的
          上游 web CSS（构建产物，class 只在被 Tailwind 扫到时才生成），w-[calc(100vw-32px)]
          这类 JIT 任意值类在旧产物里不存在→真机上浮窗退化成内容宽。内联样式与 CSS 产物无关。 */}
      <DialogContent
        className="max-w-sm gap-4 p-5"
        style={{ width: "calc(100vw - 32px)", maxWidth: "calc(100vw - 32px)" }}
      >
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: titleId })}</DialogTitle>
          <DialogDescription>
            {info?.latest
              ? intl.formatMessage(
                  { id: "settings.updateVersionLine" },
                  { current: info.current ?? currentVersion, latest: info.latest },
                )
              : intl.formatMessage(
                  { id: "settings.updateCurrentVersion" },
                  { version: info?.current ?? currentVersion },
                )}
          </DialogDescription>
        </DialogHeader>
        {phase === "checking" ? (
          <div className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.appVersionChecking" })}
          </div>
        ) : null}
        {phase === "up-to-date" ? (
          <div className="text-ui-base text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.appVersionUpToDate" },
              { version: info?.current ?? currentVersion },
            )}
          </div>
        ) : null}
        {phase === "unavailable" ? (
          <div className="text-ui-base text-destructive">
            {intl.formatMessage({ id: "settings.appVersionUnavailable" })}
          </div>
        ) : null}
        {info?.notes ? (
          <div className="max-h-40 overflow-y-auto rounded-lg bg-surface p-3 text-ui-base leading-6 whitespace-pre-wrap text-foreground-subtle">
            {info.notes}
          </div>
        ) : null}
        {sizeLabel ? (
          <div className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.updateSize" }, { size: sizeLabel })}
          </div>
        ) : null}
        {isDownloading ? (
          <div className="space-y-2" aria-live="polite">
            <div className="text-ui-base text-foreground">
              {intl.formatMessage({ id: "settings.updateDownloading" }, { percent: flow.percent })}
            </div>
            <Progress value={flow.percent} className="h-2" indicatorClassName="bg-primary" />
          </div>
        ) : null}
        {phase === "downloaded" ? (
          <div className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.updateDownloaded" })}
          </div>
        ) : null}
        {phase === "background" ? (
          <div className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.updateBackgroundStarted" })}
          </div>
        ) : null}
        {flow.needsNotifyPermission ? (
          <div className="space-y-2 text-ui-base text-destructive">
            <div>{intl.formatMessage({ id: "settings.updateNeedsNotificationPermission" })}</div>
            {notifyAvailable ? (
              <Button
                type="button"
                size="lg"
                variant="outline"
                className="min-h-11 w-full"
                onClick={flow.handleRequestNotifyPermission}
              >
                {intl.formatMessage({ id: "settings.updateRequestPermission" })}
              </Button>
            ) : null}
          </div>
        ) : null}
        {flow.needsInstallPermission ? (
          <div className="space-y-2 text-ui-base text-destructive">
            <div>{intl.formatMessage({ id: "settings.updateNeedsInstallPermission" })}</div>
            <Button
              type="button"
              size="lg"
              variant="outline"
              className="min-h-11 w-full"
              onClick={flow.handleOpenInstallPermission}
            >
              {intl.formatMessage({ id: "settings.updateRequestPermission" })}
            </Button>
          </div>
        ) : null}
        {flow.error ? (
          <div className="text-ui-base text-destructive">
            {intl.formatMessage({ id: "settings.updateFailed" }, { error: flow.error })}
          </div>
        ) : null}
        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
          {phase === "available" || phase === "failed" ? (
            <>
              <Button
                type="button"
                size="lg"
                className="min-h-11 w-full sm:w-auto"
                onClick={flow.handleDownload}
              >
                {intl.formatMessage({ id: "settings.updateDownload" })}
              </Button>
              <Button
                type="button"
                size="lg"
                variant="outline"
                className="min-h-11 w-full sm:w-auto"
                onClick={flow.handleBackgroundDownload}
              >
                {intl.formatMessage({ id: "settings.updateDownloadInBackground" })}
              </Button>
            </>
          ) : null}
          {isDownloading ? (
            <Button
              type="button"
              size="lg"
              variant="outline"
              className="min-h-11 w-full sm:w-auto"
              onClick={flow.handleCancelDownload}
            >
              {intl.formatMessage({ id: "settings.updateCancel" })}
            </Button>
          ) : null}
          {phase !== "checking" && phase !== "up-to-date" && phase !== "unavailable" ? (
            <Button
              type="button"
              size="lg"
              variant="secondary"
              className="min-h-11 w-full sm:w-auto"
              disabled={!flow.canInstall}
              onClick={flow.handleInstall}
            >
              {intl.formatMessage({ id: "settings.updateInstall" })}
            </Button>
          ) : null}
          <Button
            type="button"
            size="lg"
            variant="ghost"
            className="min-h-11 w-full sm:w-auto"
            onClick={() => flow.handleOpenChange(false)}
          >
            {intl.formatMessage({ id: "settings.updateClose" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
