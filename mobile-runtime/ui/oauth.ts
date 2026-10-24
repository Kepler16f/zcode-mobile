// 登录（§8 M6 的功能面）：把上游 OAuthService 原样接进端侧，不写第二套登录逻辑。
//
// 为什么能原样搬：services/src/oauth/oauthService.js 的闭包实测 294 模块 / 1.29 MB / **0 个缺失垫片**
// （probe-ui-closure.mjs "svc:oauth/oauthService.js"）。它要的三样都能给真的：
//   1. ICredentialService —— Keystore 桥（credentials.ts）。
//   2. apiClient —— 一个 fetch 版实现。桌面那份 NodeApiClient 要 undici + 代理 + 自定义 CA，
//      端侧没有也不需要，而且 zcode.z.ai 的 CORS 实测 `access-control-allow-origin: *`
//      （OPTIONS 204 与 POST 200 都带），WebView 直接 fetch 就通，不需要原生 HTTP 桥。
//   3. env —— 给空对象：端点默认落 https://zcode.z.ai（shared/src/zcodeEndpoint.ts:3），
//      不读任何继承来的环境变量，免得把开发机的 ZCODE_ENV=test 带进出厂包。
//
// 登录为什么在手机上成立：UI 走的是 startOAuthWithPolling —— 先 POST /api/v1/oauth/cli/init
// 拿 flow_id + authorize_url，**再由浏览器把 `zcode://oauth/callback?code=…` 交回 App，由 App 兑换**
// （oauthService.handleCallback）。轮询 (`/oauth/cli/poll/{flowId}`) 是这条的兜底：桌面 Chrome 在
// 把自定义 scheme 交出去之后标签页还活着，网站那页能自己收尾，所以桌面上轮询够用；手机上那个标签页
// 在交接那一刻就被冻结/回收了，收尾没跑完，轮询会永远 pending —— 0.2.0 装机的"一直转圈圈"就是它。
// 两条路都在，上游本来就是这么设计的（useRootOAuthEffects 里 owner 是 "polling" 还是 "deep-link"）。
import type { ICredentialService } from "@zcode/services";
import { createOAuthService } from "@zcode/services/deep/oauth/oauthService.js";
import { traceOAuthEvent } from "./oauth-trace.js";
import { rewritePlatformForServer } from "./server-compat.js";

/** 与 shared/src/api.ts:5 的 ApiClient 同形：request(input, init) -> Response。 */
export interface MobileApiClient {
  request(input: string | URL, init?: RequestInit & { timeoutMs?: number }): Promise<Response>;
}

/**
 * fetch 版 ApiClient。只做上游真正用到的部分：JSON/表单请求、超时、AbortSignal 透传。
 * 不实现代理与自定义 CA —— 那是桌面宿主的网络栈，端侧交给系统与 Keystore 之外的那套信任链。
 *
 * 出网前过一道 rewritePlatformForServer：服务端对 `platform=android-*` 直接拒 3001，
 * 体验套餐/套餐列表（client/configs）在真机上因此永远查不到（server-compat.ts 头注有实测记录）。
 * OAuth 那几个请求本来就不带 platform 参数，改写对它们是原样放行。
 */
export function createFetchApiClient(): MobileApiClient {
  return {
    request(input, init = {}) {
      const { timeoutMs, ...rest } = init;
      const signal = timeoutMs
        ? rest.signal
          ? AbortSignal.any([rest.signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs)
        : rest.signal;
      return fetch(rewritePlatformForServer(input), { ...rest, signal });
    },
  };
}

export function createMobileOAuthService(credentialService: ICredentialService) {
  return createOAuthService(credentialService, {
    apiClient: createFetchApiClient() as never,
    env: {},
  });
}

/**
 * 给登录服务套一层取证（§1.5.15：端上没有 devtools，"转圈圈"必须能事后回收）。
 *
 * 用 Proxy 而不是子类/新对象：IOAuthService 有 20 多个方法，抄一遍就是第二份接口事实；
 * 而 `Object.create(service)` 那种写法会坏得更隐蔽 —— 实例字段挂在对象自己身上，
 * 克隆出来的壳拿不到 `pendingState`，登录会解成一条看不懂的 undefined。
 * 这里 `Reflect.get(target, prop, target)` 把 receiver 固定成原实例，方法里的 `this` 不会漂。
 */
const TRACED = new Set(["startOAuthWithPolling", "pollPendingOAuth", "handleCallback"]);
let pollCount = 0;

export function createTracedOAuthService<T extends object>(service: T): T {
  return new Proxy(service, {
    get(target, prop, _receiver) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function" || typeof prop !== "string" || !TRACED.has(prop)) {
        return value;
      }
      const method = value as (...args: unknown[]) => Promise<unknown>;
      return async (...args: unknown[]) => {
        try {
          const result = await method.apply(target, args);
          if (prop === "startOAuthWithPolling") {
            const r = result as { authorizeUrl?: string; provider?: string };
            let host = "?";
            try {
              host = new URL(String(r?.authorizeUrl)).host;
            } catch {
              // authorizeUrl 形状不对时也不该把取证打死
            }
            traceOAuthEvent("flow-started", { provider: r?.provider ?? "?", authorizeHost: host });
          } else if (prop === "pollPendingOAuth") {
            pollCount += 1;
            const kind = (result as { kind?: string } | null)?.kind ?? "null";
            // 每秒一次轮询，全写会把文件刷满；只记第一次、以及每 15 次（≈15 秒）一次心跳。
            if (pollCount === 1 || pollCount % 15 === 0 || kind !== "null") {
              traceOAuthEvent("poll", { n: pollCount, kind });
            }
          } else if (prop === "handleCallback") {
            traceOAuthEvent("handle-callback", { kind: (result as { kind?: string } | null)?.kind ?? "null" });
          }
          return result;
        } catch (error) {
          traceOAuthEvent(`${prop}-error`, { error: String((error as Error)?.message ?? error) });
          throw error;
        }
      };
    },
  });
}
