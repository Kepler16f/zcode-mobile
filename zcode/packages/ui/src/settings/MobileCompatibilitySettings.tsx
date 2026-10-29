import { useEffect, useState } from "react";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "./SettingsPageParts.js";
import { Input } from "@/components/ui/input.js";
import { Button } from "@/components/ui/button.js";

export function MobileCompatibilitySettings() {
  const platform = useOptionalPlatform();
  const { intl } = useZCodeIntl();
  const [version, setVersion] = useState("");
  const [defaultVersion, setDefaultVersion] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let active = true;
    void platform
      ?.getMobileClientCompatibility?.()
      .then((info) => {
        if (active) {
          setVersion(info.desktopVersion);
          setDefaultVersion(info.defaultVersion);
        }
      })
      .catch((error) => {
        if (active) setMessage(String(error));
      });
    return () => {
      active = false;
    };
  }, [platform]);
  if (!platform?.getMobileClientCompatibility || !platform.setMobileDesktopVersion) return null;
  return (
    <SettingsGroupCard>
      <SettingsRow
        controlLayout="wide"
        label={intl.formatMessage({ id: "settings.mobile.desktopVersion" })}
        description={intl.formatMessage({ id: "settings.mobile.desktopVersionDescription" })}
        detail={
          <Input
            data-testid="mobile-desktop-version"
            value={version}
            placeholder={defaultVersion}
            onChange={(e) => setVersion(e.currentTarget.value)}
            className="min-h-11 w-full"
          />
        }
        control={
          <Button
            disabled={pending}
            className="min-h-11"
            onClick={() => {
              setPending(true);
              void platform.setMobileDesktopVersion!(version)
                .then(() => setMessage(intl.formatMessage({ id: "settings.mobile.saved" })))
                .catch((error) => setMessage(String(error)))
                .finally(() => setPending(false));
            }}
          >
            {intl.formatMessage({ id: "common.save" })}
          </Button>
        }
      />
      <SettingsRow
        controlLayout="wide"
        label={intl.formatMessage({ id: "settings.mobile.localWorkspaces" })}
        description={intl.formatMessage({ id: "settings.mobile.localWorkspacesDescription" })}
        control={
          <Button
            className="min-h-11"
            onClick={() => {
              void platform
                .upgradeLegacyLocalWorkspaces?.()
                .then((result) =>
                  setMessage(
                    intl.formatMessage(
                      {
                        id: result.needsStoragePermission
                          ? "settings.mobile.storagePermission"
                          : "settings.mobile.migrated",
                      },
                      { count: result.migrated },
                    ),
                  ),
                )
                .catch((error) => setMessage(String(error)));
            }}
          >
            {intl.formatMessage({ id: "settings.mobile.checkMigration" })}
          </Button>
        }
      />
      {message ? (
        <p role="status" className="px-4 py-2 text-ui-base">
          {message}
        </p>
      ) : null}
    </SettingsGroupCard>
  );
}
