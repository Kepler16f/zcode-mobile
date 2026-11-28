// 手机端的"领取/购买页"承载：替换上游 CodingPlanEmbeddedWebviewDialog。
//
// 上游用 Electron 的 `<webview>` 打开 zcode.z.ai/coding-plan（Start Plan 赠送额度的领取入口也在这页）
// 并往里注入登录凭据；Android WebView 没有 `<webview>` 标签，页面渲染为空，于是"领取不了"。
// 这里改用原生 BrowserActivity（zcodeBrowser.openClaimPage）承载同一个官网页：
//   - URL 构造、凭据键、注入脚本全部复用上游同一批函数，不另造一份口径；
//   - 凭据只会被原生侧注入到 https://zcode.z.ai；页面关闭即清存储；
//   - 用户回到 App 时按"可能已领取/已购买"处理：关闭弹窗并刷新权益。
import { useCallback, useEffect, useRef, useState } from "react";
import { ZCODE_VERSION } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { RENDERER_ZCODE_ENDPOINT_URLS } from "@/lib/rendererZCodeEndpoint.js";
import { logger } from "@/logger.js";
import type { CodingPlanProviderId } from "@/settings/model-provider-section/constants.js";
import type { CodingPlanFunnelContext } from "@/lib/codingPlanFunnelTelemetry.js";
import {
  buildCodingPlanEmbeddedReportContext,
  buildCodingPlanEmbeddedWebviewUrl,
  createCodingPlanAuthInjectionScript,
  getCodingPlanCredentialKeys,
  resolveCodingPlanEmbeddedOrigin,
  resolveCodingPlanWebsiteProvider,
  CODING_PLAN_WEBVIEW_OVERRIDE_ENV_KEY,
  type CodingPlanEmbeddedCredentials,
  type CodingPlanPurchaseAudience,
} from "@/settings/model-provider-section/codingPlanEmbeddedWebview.js";
import { decodeJwtUserId, getOrCreateDeviceMid } from "./quota-transport.js";
import { officialCompatibilityVersion } from "./server-compat.js";

interface Props {
  credentialService: { load(key: string): Promise<string | null> };
  onOpenChange: (open: boolean) => void;
  open: boolean;
  onOpenResult?: (opened: boolean) => void;
  providerId: CodingPlanProviderId;
  funnelContext?: CodingPlanFunnelContext | null;
  audience?: CodingPlanPurchaseAudience;
  teamPlanKey?: string | null;
  onPurchaseComplete?: () => void;
}

type BrowserBridge = { openClaimPage?(request: string): string };

export function CodingPlanEmbeddedWebviewDialog({
  credentialService,
  onOpenChange,
  open,
  providerId,
  funnelContext,
  audience,
  teamPlanKey,
  onPurchaseComplete,
  onOpenResult,
}: Props) {
  const { locale } = useZCodeIntl();
  const platform = usePlatform();
  const [error, setError] = useState<string | null>(null);
  const leftRef = useRef(false);
  const urlRef = useRef<string | null>(null);
  const completeRef = useRef(onPurchaseComplete);
  completeRef.current = onPurchaseComplete;
  const openResultRef = useRef(onOpenResult);
  openResultRef.current = onOpenResult;

  const launch = useCallback(async () => {
    setError(null);
    try {
      const provider = resolveCodingPlanWebsiteProvider(providerId);
      const origin = resolveCodingPlanEmbeddedOrigin({
        endpointOrigin: RENDERER_ZCODE_ENDPOINT_URLS.origin,
      });
      const dark = document.documentElement.classList.contains("dark");
      const theme = dark ? "zai-dark" : "zai-light";
      const url = buildCodingPlanEmbeddedWebviewUrl({
        origin,
        provider,
        locale,
        theme,
        audience,
        teamPlanKey,
      });
      urlRef.current = url;
      const keys = getCodingPlanCredentialKeys(provider);
      const values = await Promise.all(keys.map((key) => credentialService.load(key)));
      const loginProvider = provider === "zai" ? values[2] : values[3];
      const credentials: CodingPlanEmbeddedCredentials =
        provider === "zai"
          ? { zaiAccessToken: values[0], zcodeJwtToken: values[1] }
          : {
              bigmodelAccessToken: values[0],
              zcodeJwtToken: values[1],
              zaiCnAccessToken: values[2],
            };
      const script = createCodingPlanAuthInjectionScript({
        provider,
        credentials,
        loginProvider,
        theme,
        locale,
        reportContext: buildCodingPlanEmbeddedReportContext({
          funnelContext,
          deviceMid: getOrCreateDeviceMid(),
          userId: decodeJwtUserId(values[1] ?? values[0]),
          appVersion: officialCompatibilityVersion() || ZCODE_VERSION,
        }),
      });
      const bridge = (globalThis as { zcodeBrowser?: BrowserBridge }).zcodeBrowser;
      if (typeof bridge?.openClaimPage !== "function") {
        // 旧壳没有这条桥：退回系统浏览器（登录态不会带过去，但至少页面能看）。
        platform.openExternal(url);
        openResultRef.current?.(true);
        return;
      }
      const reply = JSON.parse(String(bridge.openClaimPage(JSON.stringify({ url, script })))) as {
        ok?: boolean;
        error?: string;
      };
      if (!reply.ok) throw new Error(reply.error ?? "领取页打开失败");
      leftRef.current = false;
      openResultRef.current?.(true);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.warn("[ClaimDialog] 打开领取页失败", { message });
      setError(message);
      openResultRef.current?.(false);
    }
  }, [audience, credentialService, funnelContext, locale, platform, providerId, teamPlanKey]);

  useEffect(() => {
    if (open) void launch();
  }, [open, launch]);

  // 用户从领取页回到 App：可能已经领取/购买，关闭弹窗并刷新权益（失败不影响关闭）。
  useEffect(() => {
    if (!open) return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        leftRef.current = true;
        return;
      }
      if (leftRef.current && !error) {
        leftRef.current = false;
        completeRef.current?.();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [open, error]);

  if (!open) return null;
  return (
    <section
      data-testid="coding-plan-upgrade-surface"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-background p-6 text-foreground"
    >
      <p className="text-center text-ui-base">
        {error ? `领取页打开失败：${error}` : "已在内置浏览器中打开领取页，完成后返回应用即可自动刷新。"}
      </p>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => void launch()}>
          重新打开
        </Button>
        <Button onClick={() => completeRef.current?.()}>我已完成，刷新</Button>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          关闭
        </Button>
      </div>
    </section>
  );
}

export { CODING_PLAN_WEBVIEW_OVERRIDE_ENV_KEY };
