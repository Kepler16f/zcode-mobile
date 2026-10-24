import type { Theme } from "@/useTheme.js";
import { useState } from "react";
import { resolveTheme } from "@/useTheme.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import {
  getThemeOptionLabel,
  SettingsRow,
  ThemePreviewCard,
  ThemeSelect,
} from "@/settings/SettingsPageParts.js";
import { getCodePreviewTheme } from "@/lib/codePreviewPreferences.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodePreviewSettings } from "@/store/index.js";
import { THEME_MODES } from "@/settings/settingsPageConfig.js";
import { MAX_UI_FONT_SIZE_PX, MIN_UI_FONT_SIZE_PX } from "@/lib/uiFontSize.js";

/**
 * 触屏设备显示优化（0.4.8，端侧装机反馈：平板上移动形态从未生效 + 用户点名做成开关）。
 * 自包含行：状态只存 localStorage（键 zcode-mobile.touchOptimized，"1"/"0"），不穿 props 链、
 * 不进上游 store —— 消费者是端侧 web-mobile-shell（zcode-narrow 类）与 useAppPanels（开局收起），
 * 改动经 window 事件 zcode-mobile:touch-opt-changed 广播。
 * 只在触屏设备（pointer: coarse）渲染：键鼠设备这个开关没有意义（默认就是桌面形态）。
 * 默认值语义在消费方：localStorage 无值 = 按设备形态（触屏开/键鼠关）；一旦手动设置，
 * "开了就是开了"——不随横竖屏旋转、不随窗口宽度变化（用户明确要求的恒定语义）。
 */
const TOUCH_OPT_KEY = "zcode-mobile.touchOptimized";
const TOUCH_OPT_EVENT = "zcode-mobile:touch-opt-changed";

function TouchOptimizedSwitchRow() {
  const { intl } = useZCodeIntl();
  const [coarse] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches,
  );
  const [pinned, setPinned] = useState<boolean | null>(() => {
    if (typeof window === "undefined") return null;
    const v = window.localStorage.getItem(TOUCH_OPT_KEY);
    return v === "1" ? true : v === "0" ? false : null;
  });
  if (!coarse) return null;
  const on = pinned ?? true;
  const toggle = (next: boolean) => {
    window.localStorage.setItem(TOUCH_OPT_KEY, next ? "1" : "0");
    setPinned(next);
    window.dispatchEvent(new CustomEvent(TOUCH_OPT_EVENT, { detail: { enabled: next } }));
  };
  return (
    <SettingsRow
      label={intl.formatMessage({ id: "settings.touchOptimized" })}
      description={intl.formatMessage({ id: "settings.touchOptimizedDescription" })}
      control={<Switch checked={on} onCheckedChange={toggle} />}
    />
  );
}

/**
 * 全部文件管理权限（0.7.3，用户点名"申请对全部文件的管理权限"）。
 * 只在端侧外壳暴露了该桥时渲染（window.zcodeDevice.openAllFilesPermission）——
 * 桌面/网页宿主拿不到 Android 的 MANAGE_EXTERNAL_STORAGE，这一行在那里没有任何意义。
 * 自包含：不读服务面、不进 store；授予态直接问原生桥（allFilesGranted），点"去系统授权"
 * 拉起系统页；回到 App 时点刷新重读。授予后 Agent 的文件工具可以触到 /ext/<公共目录>
 * （= /sdcard 树，围栏在 FsBridge/系统层，这里只是入口与读数）。
 */
type AllFilesBridge = {
  openAllFilesPermission?(): string;
  allFilesGranted?(): boolean;
};
function allFilesBridge(): AllFilesBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const b = (window as { zcodeDevice?: AllFilesBridge }).zcodeDevice;
  return b && typeof b.openAllFilesPermission === "function" ? b : undefined;
}

function AllFilesPermissionRow() {
  const { intl } = useZCodeIntl();
  const bridge = allFilesBridge();
  const [granted, setGranted] = useState<boolean | null>(() => {
    try {
      return typeof bridge?.allFilesGranted === "function" ? Boolean(bridge.allFilesGranted()) : null;
    } catch {
      return null;
    }
  });
  const [error, setError] = useState<string | null>(null);
  if (!bridge) return null;
  const openPage = () => {
    setError(null);
    try {
      const res = JSON.parse(String(bridge.openAllFilesPermission?.())) as {
        ok?: boolean;
        alreadyGranted?: boolean;
        error?: string;
      };
      if (res?.alreadyGranted) setGranted(true);
      else if (!res?.ok) setError(res?.error ?? "系统授权页打不开");
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  };
  const refresh = () => {
    setError(null);
    try {
      setGranted(typeof bridge.allFilesGranted === "function" ? Boolean(bridge.allFilesGranted()) : null);
    } catch {
      setGranted(null);
    }
  };
  return (
    <SettingsRow
      label={intl.formatMessage({ id: "settings.allFilesAccess" })}
      description={
        <>
          {intl.formatMessage({ id: "settings.allFilesAccessDescription" })}
          {granted === null ? (
            <span className="mt-1 block text-ui-base text-foreground-subtlest">
              {intl.formatMessage({ id: "settings.allFilesAccess.unknown" })}
            </span>
          ) : null}
          {error ? <span className="mt-1 block text-ui-base text-destructive">{error}</span> : null}
        </>
      }
      control={
        <div className="flex items-center justify-end gap-2">
          {granted ? (
            <Switch checked onCheckedChange={() => undefined} disabled />
          ) : (
            <Button size="sm" variant="outline" onClick={openPage}>
              {intl.formatMessage({ id: "settings.allFilesAccess.open" })}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={refresh}>
            {intl.formatMessage({ id: "settings.allFilesAccess.refresh" })}
          </Button>
        </div>
      }
    />
  );
}

function FontSizeInput({
  value,
  min,
  max,
  ariaLabel,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  ariaLabel: string;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  const commit = () => {
    const parsed = draft.trim() === "" ? Number.NaN : Number(draft);
    const nextValue = Number.isFinite(parsed)
      ? Math.min(max, Math.max(min, Math.round(parsed)))
      : value;
    setDraft(String(nextValue));
    if (nextValue !== value) {
      onChange(nextValue);
    }
  };

  return (
    <div className="relative w-28">
      <Input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={draft}
        aria-label={ariaLabel}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(String(value));
          }
        }}
        className="pr-8 text-right tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-ui-lg text-foreground-subtle">
        px
      </span>
    </div>
  );
}

export function AppearanceSectionContent({
  codePreviewSettings,
  setCodePreviewSettings,
  theme,
  setTheme,
  uiFontSizePx,
  setUiFontSizePx,
}: {
  codePreviewSettings: CodePreviewSettings;
  setCodePreviewSettings: (settings: Partial<CodePreviewSettings>) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  uiFontSizePx: number;
  setUiFontSizePx: (fontSizePx: number) => void;
}) {
  const { intl } = useZCodeIntl();
  const activePreviewMode = resolveTheme(theme);

  return (
    <>
      <div className="min-w-0 space-y-3">
        <div>
          <h3 className="text-ui-lg font-semibold text-foreground">
            {intl.formatMessage({ id: "settings.appearance.interfaceTitle" })}
          </h3>
          <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({
              id: "settings.appearance.interfaceDescription",
            })}
          </p>
        </div>
        <Card className="border border-border bg-card py-0 shadow-none">
          <CardContent className="space-y-0 px-0">
            <SettingsRow
              label={intl.formatMessage({ id: "settings.themeMode" })}
              description={intl.formatMessage({
                id: "settings.themeModeDescription",
              })}
              control={
                <Select value={theme} onValueChange={(value) => setTheme(value as Theme)}>
                  <SelectTrigger size="lg" className="w-[260px] min-w-0 justify-between">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {THEME_MODES.map(({ mode, icon: Icon }) => (
                      <SelectItem key={mode} value={mode}>
                        <div className="flex items-center gap-2">
                          <Icon className="size-4" />
                          {intl.formatMessage({
                            id: `settings.themeMode.${mode}`,
                          })}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            />
            <SettingsRow
              label={intl.formatMessage({ id: "settings.uiFontSize" })}
              description={intl.formatMessage({
                id: "settings.uiFontSizeDescription",
              })}
              control={
                <FontSizeInput
                  key={uiFontSizePx}
                  min={MIN_UI_FONT_SIZE_PX}
                  max={MAX_UI_FONT_SIZE_PX}
                  value={uiFontSizePx}
                  onChange={setUiFontSizePx}
                  ariaLabel={intl.formatMessage({ id: "settings.uiFontSize" })}
                />
              }
            />
            <TouchOptimizedSwitchRow />
            <AllFilesPermissionRow />
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6">
        <div className="min-w-0 space-y-3">
          <div>
            <h3 className="text-ui-lg font-semibold text-foreground">
              {intl.formatMessage({ id: "settings.appearance.codeTitle" })}
            </h3>
            <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">
              {intl.formatMessage({
                id: "settings.appearance.codeDescription",
              })}
            </p>
          </div>
          <Card className="border border-border bg-card py-0 shadow-none [&_[data-slot=select-trigger]]:w-full">
            <CardContent className="space-y-0 px-0">
              <SettingsRow
                label={intl.formatMessage({ id: "settings.lightTheme" })}
                description={intl.formatMessage({
                  id: "settings.lightThemeDescription",
                })}
                control={
                  <ThemeSelect
                    value={codePreviewSettings.lightTheme}
                    onValueChange={(value) => setCodePreviewSettings({ lightTheme: value })}
                  />
                }
              />
              <SettingsRow
                label={intl.formatMessage({ id: "settings.darkTheme" })}
                description={intl.formatMessage({
                  id: "settings.darkThemeDescription",
                })}
                control={
                  <ThemeSelect
                    value={codePreviewSettings.darkTheme}
                    onValueChange={(value) => setCodePreviewSettings({ darkTheme: value })}
                  />
                }
              />
              <SettingsRow
                label={intl.formatMessage({ id: "settings.showLineNumbers" })}
                description={intl.formatMessage({
                  id: "settings.showLineNumbersDescription",
                })}
                control={
                  <Switch
                    checked={codePreviewSettings.showLineNumbers}
                    onCheckedChange={(checked) =>
                      setCodePreviewSettings({ showLineNumbers: checked })
                    }
                  />
                }
              />
              <SettingsRow
                label={intl.formatMessage({ id: "settings.wrapLongLines" })}
                description={intl.formatMessage({
                  id: "settings.wrapLongLinesDescription",
                })}
                control={
                  <Switch
                    checked={codePreviewSettings.wrapLongLines}
                    onCheckedChange={(checked) =>
                      setCodePreviewSettings({ wrapLongLines: checked })
                    }
                  />
                }
              />
              <SettingsRow
                label={intl.formatMessage({ id: "settings.fontSize" })}
                description={intl.formatMessage({
                  id: "settings.fontSizeDescription",
                })}
                control={
                  <FontSizeInput
                    key={codePreviewSettings.fontSizePx}
                    min={12}
                    max={20}
                    value={codePreviewSettings.fontSizePx}
                    onChange={(fontSizePx) => setCodePreviewSettings({ fontSizePx })}
                    ariaLabel={intl.formatMessage({ id: "settings.fontSize" })}
                  />
                }
              />
            </CardContent>
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <div>
            <h3 className="text-ui-base font-semibold text-foreground">
              {intl.formatMessage({ id: "settings.previewSectionTitle" })}
            </h3>
            <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">
              {intl.formatMessage({ id: "settings.previewDescription" })}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <ThemePreviewCard
              mode="light"
              title={intl.formatMessage({ id: "settings.previewLight" })}
              themeName={getThemeOptionLabel(codePreviewSettings.lightTheme)}
              theme={getCodePreviewTheme("light", codePreviewSettings)}
              isActive={activePreviewMode === "light"}
              showLineNumbers={codePreviewSettings.showLineNumbers}
              wrapLongLines={codePreviewSettings.wrapLongLines}
              fontSizePx={codePreviewSettings.fontSizePx}
            />
            <ThemePreviewCard
              mode="dark"
              title={intl.formatMessage({ id: "settings.previewDark" })}
              themeName={getThemeOptionLabel(codePreviewSettings.darkTheme)}
              theme={getCodePreviewTheme("dark", codePreviewSettings)}
              isActive={activePreviewMode === "dark"}
              showLineNumbers={codePreviewSettings.showLineNumbers}
              wrapLongLines={codePreviewSettings.wrapLongLines}
              fontSizePx={codePreviewSettings.fontSizePx}
            />
          </div>
        </div>
      </div>
    </>
  );
}
