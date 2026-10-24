// 端侧的"模型连通性测试"：把上游那条缝接上，让设置页每一行模型上的"测试"按钮真的发一次请求。
//
// 为什么这不是新功能：UI 早就有这一格（ProviderCardSections.tsx:532 的 onTest →
// InlineEditableProviderCard.tsx:614-627 → useModelProviders.ts:198 → providerSettingsService
// .testModelConnectivity），缺的只是 providerRuntime.ts:107 那个 `dependencies.testConnectivity`
// ——桌面上它由 host 装配，端侧此前没传，于是点下去就是 providerFacadeServices.ts:171 那句
// "当前 Environment 未装配模型连通性测试能力"。
//
// 映射规则**不在这里重写**：直接用上游的 createProviderSettingsConnectivityTester
// （providerSettingsConnectivity.ts:19-43），它规定"成功 = 执行链没抛错；失败 = 抛错的 message"。
// 我们只负责"正式执行链"那一段：解析落点 → 发一次真请求。
//
// 为什么请求要刻意做到最小、而且拿到第一个增量就中断：这一格的用途是"配错了也能立刻看出来"，
// 一次测试就花掉几百 token 的话，用户每次改配置都在烧自己的免费额度。
// 但"没拿到增量"绝不等于失败——有些网关对极小的 max_tokens 直接回空正文，正文空、HTTP 与帧都正常，
// 判成失败就是把连通性测试变成误报源。
import { createProviderSettingsConnectivityTester } from "@zcode/services/deep/model-provider/providerSettingsConnectivity.js";
import { resolveModelTarget, type ModelTargetResolver } from "./provider-target.js";
import { streamModelCompletion, modelRequestUrl, type ModelTarget } from "./model-stream.js";

/** 一次测试最多花多少输出 token：够网关回一个增量，又不至于产生有意义的计费。 */
const TEST_MAX_OUTPUT_TOKENS = 16;
/** 网关挂住不通时的收口。这不是"用超时掩盖同步问题"：这里等的就是一次真的外网往返。 */
const DEFAULT_TIMEOUT_MS = 20_000;

export interface MobileConnectivityOptions {
  resolver: ModelTargetResolver;
  timeoutMs?: number;
  /** 注入点：单测用一个假 target 验"失败消息里带不带 URL 和状态码"，不必真发网络请求。 */
  stream?: typeof streamModelCompletion;
  /**
   * 把这一次测试读到的三个标识写进端侧日志。为什么要写：屏幕上那句
   * "Provider「undefined」不在可执行列表里"，光看文案分不出是 UI 没把 providerId 传下来、
   * 还是端侧解析没读到——而这条链的上一环（providerFacadeServices）恰好又校验过同一个 id。
   * 只写 id 和路径，不写 Key。
   */
  onDiagnostic?: (message: string) => void;
}

function describeTarget(target: ModelTarget): string {
  // 说"打到了哪个地址"，而不是重复一遍 base URL：用户填错时这两个不一样，而不一样的那一处才是原因。
  return `POST ${modelRequestUrl(target)} · model=${target.model}`;
}

export function createMobileConnectivityTester(
  options: MobileConnectivityOptions,
): Awaited<ReturnType<typeof createProviderSettingsConnectivityTester>> {
  const stream = options.stream ?? streamModelCompletion;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const runFormalTurn = async (input: {
    workspacePath: string;
    selection: { providerId: string; modelId: string };
  }): Promise<{ readonly success: true }> => {
    const target = await resolveModelTarget(options.resolver, input.selection);
    const controller = new AbortController();
    let delivered = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      await stream({
        target,
        // 一句没有业务含义的 ping：这一格验的是"能不能通"，不是"答得好不好"。
        messages: [{ role: "user", content: "ping" }],
        maxOutputTokens: TEST_MAX_OUTPUT_TOKENS,
        signal: controller.signal,
        onDelta: (text) => {
          if (!delivered && text) {
            delivered = true;
            // 拿到第一个增量就收口：目的已经达成，剩下的 token 没有意义。
            controller.abort();
          }
        },
      });
    } catch (e) {
      // 我们自己中断的这一次（要么已拿到增量=成功，要么超时=失败），别把中断当成网关报错抛上去。
      if (delivered) return { success: true };
      if (timedOut) {
        throw new Error(
          `连接测试超时（${timeoutMs} ms 内没有响应）：${describeTarget(target)}`,
        );
      }
      // ModelStreamError / ProviderTargetError 的 message 已经带了落点，原样抛：
      // 屏幕上要看见"打到哪儿、返回了什么"，而不是又一层"测试失败"。
      throw e;
    } finally {
      clearTimeout(timer);
    }
    return { success: true };
  };

  return createProviderSettingsConnectivityTester({
    // 参数形状是上游定的，不是我在这儿选的：createProviderSettingsConnectivityTester
    // 把设置页那层的扁平请求（providerId/modelId）**包成** formal 输入
    // `{ workspacePath, selection: { providerId, modelId } }`（providerSettingsConnectivity.ts:27-33）。
    // 上一版在这里读 `input.providerId`，拿到的是 undefined，于是屏幕上出现一句
    // "Provider「undefined」不在可执行列表里"——是端侧自己把 id 弄丢了，不是配置没填全。
    testModelConnectivity: async (input) => {
      options.onDiagnostic?.(
        `connectivity.test selection=${JSON.stringify(input.selection)}`,
      );
      await runFormalTurn(input);
      return { success: true } as const;
    },
  });
}
