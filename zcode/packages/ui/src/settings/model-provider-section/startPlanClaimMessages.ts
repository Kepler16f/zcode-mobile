// Start Plan 领取错误文案表（从 StartPlanManualClaimCard.tsx 抽出——该文件触
// max-lines 上限，文案表是纯映射、零状态，独立成文件最省事）。
// 错误码语义来自 zcode-plan 网关 billing/claim 的业务码（100x 活动面 / 300x 校验面）。

export function resolveClaimErrorText(
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
