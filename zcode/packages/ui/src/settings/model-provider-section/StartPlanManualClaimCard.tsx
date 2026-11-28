import type {
  ManualClaimPlanPreview,
  RequestVerificationConfig,
  RequestVerificationProof,
  UsageEntitlementSubscriptionDetail,
  UsageQuotaLimit,
} from "@zcode/shared";
import { CheckCircle2Icon, ExternalLinkIcon, GiftIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodingPlanProviderId } from "./constants.js";
import { resolveClaimErrorText } from "./startPlanClaimMessages.js";

type GlobalClaimVerificationHook = (
  config: RequestVerificationConfig,
) => Promise<RequestVerificationProof | null>;

export interface StartPlanManualClaimCardProps {
  providerId: CodingPlanProviderId;
  isDisconnected: boolean;
  subscriptionDetails?: UsageEntitlementSubscriptionDetail[];
  quotaLimits?: UsageQuotaLimit[];
  onClaimCompleted?: () => void | Promise<void>;
  onOpenOfficialPage?: () => void;
  onLogin?: () => void;
}

function formatClaimEntitlement(
  entitlement: ManualClaimPlanPreview["entitlements"][number],
  isZh: boolean,
): string {
  const amount = new Intl.NumberFormat(isZh ? "zh-CN" : "en-US").format(entitlement.grantUnits);
  const title = entitlement.showName || entitlement.entitlementId;
  const details = [amount, entitlement.unitType, entitlement.period].filter(Boolean).join(" ");
  return details ? `${title}: ${details}` : title;
}

export function StartPlanManualClaimCard({
  providerId,
  isDisconnected,
  subscriptionDetails,
  quotaLimits,
  onClaimCompleted,
  onOpenOfficialPage,
  onLogin,
}: StartPlanManualClaimCardProps) {
  const services = useOptionalServices();
  const subscriptionService = services?.codingPlanSubscriptionService;
  const providerSettingsService = services?.providerSettingsService;
  const { locale } = useZCodeIntl();
  const isZh = locale.toLowerCase().startsWith("zh");

  const [loading, setLoading] = useState(false);
  const [plans, setPlans] = useState<ManualClaimPlanPreview[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [claimingPlanId, setClaimingPlanId] = useState<string | null>(null);
  const [locallyClaimedIds, setLocallyClaimedIds] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<{ kind: "success" | "info" | "error"; text: string } | null>(
    null,
  );
  // 保持回调与服务引用稳定，避免父组件重渲染导致 useEffect 反复拉取 billing/preview 触发 HTTP 429。
  const onClaimCompletedRef = useRef(onClaimCompleted);
  onClaimCompletedRef.current = onClaimCompleted;
  const providerSettingsServiceRef = useRef(providerSettingsService);
  providerSettingsServiceRef.current = providerSettingsService;
  const isZhRef = useRef(isZh);
  isZhRef.current = isZh;

  const claimedPlanIds = useMemo(() => {
    const ids = new Set<string>(locallyClaimedIds);
    for (const detail of subscriptionDetails ?? []) {
      const id = detail.productId?.trim().toLowerCase();
      if (id) ids.add(id);
    }
    for (const limit of quotaLimits ?? []) {
      const id = limit.planId?.trim().toLowerCase();
      if (id) ids.add(id);
    }
    return ids;
  }, [locallyClaimedIds, quotaLimits, subscriptionDetails]);

  const loadOffers = useCallback(
    async (syncQuota = false, forceRefresh = false) => {
      if (isDisconnected || !subscriptionService?.getManualClaimPlanPreviews) {
        setPlans([]);
        return;
      }
      setLoading(true);
      setLoadError(null);
      try {
        const [snapshot] = await Promise.all([
          subscriptionService.getManualClaimPlanPreviews(
            forceRefresh ? { forceRefresh: true } : undefined,
          ),
          ...(syncQuota
            ? [
                Promise.resolve(onClaimCompletedRef.current?.()).catch(() => {}),
                providerSettingsServiceRef.current?.refresh("manual-plan-claim").catch(() => {}),
              ]
            : []),
        ]);
        setPlans(snapshot.plans ?? []);
      } catch (error) {
        const rawMsg = error instanceof Error ? error.message.trim() : "";
        const zh = isZhRef.current;
        if (
          rawMsg === "manual_claim_preview_rate_limited" ||
          /\b429\b|too many requests|rate limit/i.test(rawMsg)
        ) {
          setLoadError(
            zh
              ? "检查过于频繁（HTTP 429），请稍等半分钟后再点「检查可领活动」。"
              : "Too many requests (HTTP 429). Please wait 30 seconds before checking again.",
          );
        } else {
          setLoadError(
            rawMsg ||
              (zh
                ? "暂未能读取可领取的活动赠送，请稍后刷新。"
                : "Failed to load promotional grants."),
          );
        }
      } finally {
        setLoading(false);
      }
    },
    [isDisconnected, subscriptionService],
  );

  useEffect(() => {
    void loadOffers(false);
  }, [loadOffers, providerId]);

  const handleClaim = useCallback(
    async (plan: ManualClaimPlanPreview) => {
      if (!subscriptionService?.claimManualPlan) return;
      setClaimingPlanId(plan.planId);
      setFeedback(null);
      try {
        const verifyHook = (
          globalThis as { __zcodeRequestClaimVerification?: GlobalClaimVerificationHook }
        ).__zcodeRequestClaimVerification;
        // 同步官方客户端 prepareRequestVerificationClaim：当服务端 client/configs 开启 captcha 时，
        // 在请求 POST /billing/claim 前先获取阿里云 V3 captchaVerifyParam，避免无凭证首请求被拒或消耗限流预算。
        let captchaConfig = await subscriptionService
          .getRequestVerificationConfig?.()
          .catch(() => null);
        let initialProof: RequestVerificationProof | null = null;
        if (captchaConfig?.enabled && verifyHook) {
          initialProof = await verifyHook(captchaConfig);
          if (!initialProof?.captchaVerifyParam) {
            setFeedback({
              kind: "info",
              text: isZh
                ? "安全验证未完成，请重新点击「领取」完成验证。"
                : "Security verification was cancelled. Tap Claim to try again.",
            });
            return;
          }
        }
        let result = await subscriptionService.claimManualPlan({
          planId: plan.planId,
          ...(plan.campaignId ? { campaignId: plan.campaignId } : {}),
          ...(initialProof ?? {}),
        });
        if (!result.success && result.code === 3007 && !initialProof?.captchaVerifyParam) {
          if (!captchaConfig) {
            captchaConfig = await subscriptionService
              .getRequestVerificationConfig?.()
              .catch(() => null);
          }
          if (verifyHook && captchaConfig) {
            const proof = await verifyHook(captchaConfig);
            if (!proof?.captchaVerifyParam) {
              setFeedback({
                kind: "info",
                text: isZh
                  ? "安全验证未完成，请重新点击「领取」完成验证。"
                  : "Security verification was cancelled. Tap Claim to try again.",
              });
              return;
            }
            result = await subscriptionService.claimManualPlan({
              planId: plan.planId,
              ...(plan.campaignId ? { campaignId: plan.campaignId } : {}),
              ...proof,
            });
          }
        }
        if (result.success) {
          const normalizedId = plan.planId.trim().toLowerCase();
          setLocallyClaimedIds((prev) =>
            prev.includes(normalizedId) ? prev : [...prev, normalizedId],
          );
          setFeedback({
            kind: "success",
            text: isZh
              ? `已领取「${plan.name}」，正在刷新活动额度与模型权限…`
              : `Claimed "${plan.name}". Refreshing quota and model availability...`,
          });
          await Promise.allSettled([
            Promise.resolve(onClaimCompleted?.()),
            providerSettingsService?.refresh("manual-plan-claim"),
          ]);
          await loadOffers(false, true);
          return;
        }
        if (result.code === 1003) {
          const normalizedId = plan.planId.trim().toLowerCase();
          setLocallyClaimedIds((prev) =>
            prev.includes(normalizedId) ? prev : [...prev, normalizedId],
          );
          await Promise.allSettled([
            Promise.resolve(onClaimCompleted?.()),
            providerSettingsService?.refresh("manual-plan-claim"),
          ]);
        }
        setFeedback({
          kind: result.code === 1003 ? "info" : "error",
          text: resolveClaimErrorText(result.code, result.message, result.failureEndsAt, isZh),
        });
      } catch (error) {
        setFeedback({
          kind: "error",
          text:
            error instanceof Error && error.message.trim()
              ? error.message
              : isZh
                ? "领取请求失败，请稍后重试。"
                : "Claim request failed.",
        });
      } finally {
        setClaimingPlanId(null);
      }
    },
    [isZh, loadOffers, onClaimCompleted, providerSettingsService, subscriptionService],
  );

  if (!subscriptionService) return null;

  // 视觉口径（0.12.6，用户点名"查找活动的 ui 不好看……不用这么多文字，按钮为主"）：
  // 参照官方上游 StartPlanCard 的渐变赠卡与 zcode-pool 的 claim-strip（图标 + 活动名 +
  // 一行信息 + 领取按钮），把说明性长文案全部压成一行；CTA 是「领取」/「检查」，其余动作
  // 收成图标按钮。类只用产物里已存在的 token（新 JIT 任意值类真机不生效，见 apk-web-css）。
  return (
    <div
      data-testid="start-plan-manual-claim-card"
      className="rounded-xl border border-border bg-surface/60 p-4 text-left"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <GiftIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate text-ui-sm font-medium text-foreground">
            {isZh ? "活动赠送" : "Promo grants"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onOpenOfficialPage ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={isZh ? "官网活动页" : "Official claim page"}
              onClick={onOpenOfficialPage}
            >
              <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
            </Button>
          ) : null}
          {!isDisconnected ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={isZh ? "检查可领活动" : "Check offers"}
              disabled={loading}
              onClick={() => void loadOffers(true, true)}
            >
              {loading ? (
                <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCwIcon className="size-3.5" aria-hidden="true" />
              )}
            </Button>
          ) : null}
        </div>
      </div>

      {isDisconnected ? (
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-ui-xs text-muted-foreground">
            {isZh ? "连接账号后可领取活动赠送" : "Connect to claim promo grants"}
          </span>
          {onLogin ? (
            <Button type="button" size="sm" variant="secondary" className="shrink-0" onClick={onLogin}>
              {isZh ? "连接" : "Connect"}
            </Button>
          ) : null}
        </div>
      ) : plans.length > 0 ? (
        <div className="mt-3 space-y-2">
          {plans.map((plan) => {
            const busy = claimingPlanId === plan.planId;
            const normalizedPlanId = plan.planId.trim().toLowerCase();
            const isClaimed = claimedPlanIds.has(normalizedPlanId);
            const matchedLimits = (quotaLimits ?? []).filter(
              (limit) => limit.planId?.trim().toLowerCase() === normalizedPlanId,
            );
            return (
              <div
                key={plan.planId}
                className="flex items-center justify-between gap-2 rounded-lg border border-border/80 bg-background/60 p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-ui-sm font-medium text-foreground">{plan.name}</span>
                    {isClaimed ? (
                      <span
                        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/15 px-1.5 py-0.5 text-ui-2xs font-medium text-success"
                      >
                        <CheckCircle2Icon className="size-3" aria-hidden="true" />
                        {isZh ? "已领" : "Claimed"}
                      </span>
                    ) : null}
                  </div>
                  {!isClaimed && plan.entitlements[0] ? (
                    <div className="mt-1 truncate text-ui-xs text-muted-foreground">
                      {formatClaimEntitlement(plan.entitlements[0], isZh)}
                    </div>
                  ) : matchedLimits.length > 0 && matchedLimits[0] ? (
                    <div className="mt-1 truncate text-ui-xs text-muted-foreground">
                      {isZh
                        ? `剩余 ${new Intl.NumberFormat(isZh ? "zh-CN" : "en-US").format(matchedLimits[0].remaining ?? 0)}`
                        : `Remaining ${new Intl.NumberFormat(isZh ? "zh-CN" : "en-US").format(matchedLimits[0].remaining ?? 0)}`}
                    </div>
                  ) : null}
                </div>
                {isClaimed ? (
                  <Button type="button" size="sm" variant="secondary" disabled className="shrink-0">
                    <CheckCircle2Icon className="mr-1.5 size-3.5" aria-hidden="true" />
                    {isZh ? "已领" : "Claimed"}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    className="shrink-0"
                    disabled={Boolean(claimingPlanId)}
                    onClick={() => void handleClaim(plan)}
                  >
                    {busy ? <Loader2Icon className="mr-1.5 size-3.5 animate-spin" aria-hidden="true" /> : null}
                    {isZh ? (busy ? "领取中" : "领取") : busy ? "Claiming" : "Claim"}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-ui-xs text-muted-foreground">
            {loadError
              ? loadError
              : isZh
                ? "暂无可领活动"
                : "No claimable offers"}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0"
            disabled={loading}
            onClick={() => void loadOffers(true, true)}
          >
            {loading ? (
              <Loader2Icon className="mr-1.5 size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCwIcon className="mr-1.5 size-3.5" aria-hidden="true" />
            )}
            {isZh ? "检查" : "Check"}
          </Button>
        </div>
      )}

      {feedback ? (
        <p
          className={`mt-2 truncate text-ui-xs ${
            feedback.kind === "error"
              ? "text-destructive"
              : feedback.kind === "success"
                ? "text-success"
                : "text-muted-foreground"
          }`}
        >
          {feedback.text}
        </p>
      ) : null}
    </div>
  );
}
