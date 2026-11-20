import type {
  ManualClaimPlanPreview,
  RequestVerificationConfig,
  RequestVerificationProof,
  UsageEntitlementSubscriptionDetail,
  UsageQuotaLimit,
} from "@zcode/shared";
import { CheckCircle2Icon, GiftIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodingPlanProviderId } from "./constants.js";

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

function resolveClaimErrorText(
  code: number,
  serverMessage: string,
  failureEndsAt: number | undefined,
  isZh: boolean,
): string {
  switch (code) {
    case 1001:
      return isZh ? "活动已结束或未找到可领取的活动计划。" : "Campaign not found or ended.";
    case 1002:
      return isZh ? "当前活动暂不可领取，请稍后再试。" : "Offer is currently unavailable.";
    case 1003:
      return isZh ? "你已领取过该活动额度，正在刷新最新余额。" : "Already claimed. Refreshing quota.";
    case 1004:
      return isZh ? "当前账号暂不满足该赠送活动的领取条件。" : "Account is not eligible for this promo.";
    case 1005: {
      if (typeof failureEndsAt === "number" && Number.isFinite(failureEndsAt)) {
        const endDate = new Date(failureEndsAt * 1_000).toLocaleDateString(
          isZh ? "zh-CN" : "en-US",
        );
        return isZh
          ? `活动今日名额已发完，请于下一周期再试（至 ${endDate}）。`
          : `Daily grant pool exhausted; try again next window (until ${endDate}).`;
      }
      return isZh ? "活动今日名额已发完，请稍后再试。" : "Grant quota exhausted. Try again later.";
    }
    case 3001:
      return isZh ? "请求参数或客户端版本校验未通过。" : "Invalid request or client version check failed.";
    case 3007:
      return isZh
        ? "需要完成阿里云安全验证后才可领取，请重试或前往活动页领取。"
        : "Security verification required before claiming. Please retry.";
    case 401:
      return isZh ? "登录状态已失效，请重新连接账号后再领取。" : "Authentication required. Please reconnect.";
    default:
      return (
        serverMessage.trim() ||
        (isZh ? `领取未完成（错误码 ${code}），可尝试在活动页领取。` : `Claim failed (code ${code}).`)
      );
  }
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
    async (syncQuota = false) => {
      if (isDisconnected || !subscriptionService?.getManualClaimPlanPreviews) {
        setPlans([]);
        return;
      }
      setLoading(true);
      setLoadError(null);
      try {
        const [snapshot] = await Promise.all([
          subscriptionService.getManualClaimPlanPreviews(),
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
        let result = await subscriptionService.claimManualPlan({
          planId: plan.planId,
          ...(plan.campaignId ? { campaignId: plan.campaignId } : {}),
        });
        if (!result.success && result.code === 3007) {
          const verifyHook = (
            globalThis as { __zcodeRequestClaimVerification?: GlobalClaimVerificationHook }
          ).__zcodeRequestClaimVerification;
          const captchaConfig = await subscriptionService.getRequestVerificationConfig?.().catch(() => null);
          if (verifyHook && captchaConfig) {
            const proof = await verifyHook(captchaConfig);
            if (!proof?.captchaVerifyParam) {
              setFeedback({
                kind: "info",
                text: isZh
                  ? "安全验证未完成，请重新点击「立即领取」完成验证。"
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
          await loadOffers(false);
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

  return (
    <div
      data-testid="start-plan-manual-claim-card"
      className="rounded-xl border border-border bg-surface/60 p-4 text-left"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <GiftIcon className="size-4 text-primary" aria-hidden="true" />
          <span className="text-ui-sm font-medium text-foreground">
            {isZh ? "Start Plan 活动赠送领取" : "Start Plan Promotional Grants"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {onOpenOfficialPage ? (
            <Button type="button" size="xs" variant="ghost" onClick={onOpenOfficialPage}>
              {isZh ? "官网活动页" : "Claim Page"}
            </Button>
          ) : null}
          {!isDisconnected ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={loading}
              onClick={() => void loadOffers(true)}
            >
              {loading ? (
                <Loader2Icon className="mr-1 size-3 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCwIcon className="mr-1 size-3" aria-hidden="true" />
              )}
              {isZh ? "检查可领活动" : "Check Offers"}
            </Button>
          ) : null}
        </div>
      </div>

      {isDisconnected ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-ui-xs text-muted-foreground">
          <span>
            {isZh
              ? "连接 ZCode 账号后，可自动检测并领取官方 Start Plan / 周末活动赠送 Token。"
              : "Connect your ZCode account to check and claim promotional Start Plan token grants."}
          </span>
          {onLogin ? (
            <Button type="button" size="xs" variant="secondary" onClick={onLogin}>
              {isZh ? "立即连接" : "Connect"}
            </Button>
          ) : null}
        </div>
      ) : null}

      {!isDisconnected && loadError ? (
        <p className="mt-2 text-ui-xs text-destructive">{loadError}</p>
      ) : null}

      {!isDisconnected && !loading && !loadError && plans.length === 0 ? (
        <p className="mt-2 text-ui-xs text-muted-foreground">
          {isZh
            ? "暂无新的待领取活动；若你在其他活动页面有赠额，也可点击右上角「官网活动页」查看或点「检查可领活动」同步。"
            : "No new claimable promotional grants found right now. Refresh anytime or check the official claim page."}
        </p>
      ) : null}

      {plans.length > 0 ? (
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
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/80 bg-background/60 p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-ui-sm font-medium text-foreground">{plan.name}</span>
                    {isClaimed ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-ui-2xs font-medium text-success">
                        <CheckCircle2Icon className="size-3" aria-hidden="true" />
                        {isZh ? "已领取" : "Claimed"}
                      </span>
                    ) : null}
                  </div>
                  {plan.description ? (
                    <div className="mt-0.5 text-ui-xs text-muted-foreground">{plan.description}</div>
                  ) : null}
                  {matchedLimits.length > 0 ? (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {matchedLimits.map((limit, idx) => {
                        const remaining = limit.remaining ?? 0;
                        const formatted = new Intl.NumberFormat(isZh ? "zh-CN" : "en-US").format(
                          remaining,
                        );
                        return (
                          <span
                            key={`${plan.planId}-balance-${idx}`}
                            className="rounded bg-surface px-1.5 py-0.5 text-ui-2xs text-foreground"
                          >
                            {isZh ? `当前剩余 ${formatted}` : `Remaining ${formatted}`}
                          </span>
                        );
                      })}
                    </div>
                  ) : plan.entitlements.length > 0 ? (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {plan.entitlements.map((entitlement) => (
                        <span
                          key={entitlement.entitlementId}
                          className="rounded bg-surface px-1.5 py-0.5 text-ui-2xs text-foreground"
                        >
                          {formatClaimEntitlement(entitlement, isZh)}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
                {isClaimed ? (
                  <Button type="button" size="sm" variant="secondary" disabled>
                    <CheckCircle2Icon className="mr-1.5 size-3.5" aria-hidden="true" />
                    {isZh ? "已领取" : "Claimed"}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    disabled={Boolean(claimingPlanId)}
                    onClick={() => void handleClaim(plan)}
                  >
                    {busy ? <Loader2Icon className="mr-1.5 size-3.5 animate-spin" /> : null}
                    {isZh ? (busy ? "领取中..." : "立即领取") : busy ? "Claiming..." : "Claim"}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      ) : null}

      {feedback ? (
        <p
          className={`mt-2 text-ui-xs ${
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
