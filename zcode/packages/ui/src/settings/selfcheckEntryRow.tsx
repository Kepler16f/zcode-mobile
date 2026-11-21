import { useCallback, useState } from "react";
import { Switch } from "@/components/ui/switch.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getUiChromeBridge } from "@/settings/mobileAppBridge.js";

/**
 * 设置 → 常规里的"诊断入口"开关（0.12.5）：控制主界面贴角的自检小牌可见性。
 *
 * 背景：0.9.1 把自检入口默认藏了（当时只有 adb `--ez showSelfcheck true` 一条恢复路，
 * 用户不可达）；排查 Start Plan 405 需要装机上直接看自检报告（plan.diag/model.diag），
 * 所以把开关搬进设置页——默认关（保留隐藏决定），用户排查时自己打开。
 *
 * 状态的唯一真相在原生（zcode-ui-chrome prefs 的 selfcheck-entry 键）：切开关调
 * setSelfcheckEntry，原生即时生效并落盘；Activity 重建后用 isSelfcheckEntryEnabled
 * 恢复。JS 侧不缓存、不广播——开合只由这一处驱动，避免两边各存一份打架。
 *
 * 桥不在（桌面/网页宿主没有 zcodeUi）→ 整行不渲染。
 */

export function SelfcheckEntryRow() {
  const { intl } = useZCodeIntl();
  const bridge = getUiChromeBridge();
  const [enabled, setEnabled] = useState(() => {
    try {
      return bridge?.isSelfcheckEntryEnabled?.() === true;
    } catch {
      return false;
    }
  });

  const toggle = useCallback(
    (next: boolean) => {
      setEnabled(next);
      try {
        bridge?.setSelfcheckEntry?.(next);
      } catch {
        /* 原生侧失败也维持开关位置；下次重建会以 prefs 为准 */
      }
    },
    [bridge],
  );

  if (!bridge) return null;

  return (
    <SettingsRow
      label={intl.formatMessage({ id: "settings.selfcheckEntry" })}
      description={intl.formatMessage({ id: "settings.selfcheckEntryDescription" })}
      control={
        <Switch
          aria-label={intl.formatMessage({ id: "settings.selfcheckEntry" })}
          checked={enabled}
          data-testid="settings-selfcheck-entry-switch"
          onCheckedChange={toggle}
        />
      }
    />
  );
}
