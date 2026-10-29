// 移动端 UI 的组合根：真 @zcode/ui 界面 + 端侧 runtime，中间用上游自己的 RPC 接缝连起来。
//
// 为什么不直接 new 一个 accessor 交给 Root：`IServiceAccessor` 有 36 个必填成员，手写等于把上游
// 每个服务面重新发明一遍，而且迟早和真实现漂移。上游 desktop 已经证明了另一条路可行——
// packages/desktop/src/host/index.ts:1986 的 exposeServicesOnMessagePort 就是"无 socket、纯端口的整套 RPC"。
// 端侧比那还简单：服务端和 UI 在同一个 JS 上下文里，用 @zcode/rpc 的 createQueuePair() 就够了。
// 好处是 UI 拿到的是上游原样的 RemoteServiceAccess，服务端以后换成原生进程也不动这里。
// 必须排在所有 import 的第一位：UI 与服务层里有模块在**顶层**就读 `process.platform`
// （浏览器里那是 ReferenceError，整包直接不执行）。这份垫片会把 globalThis.process 建起来，
// 而 ESM 保证入口的 import 按书写顺序先于入口体与其它子树求值。
import "../compat/shims/process.mjs";
// 必须排在 @zcode/ui 之前：上游 store 在模块初始化时就读 matchMedia 判"跟随系统"，
// 真机 WebView 的这条 media query 被外壳关掉算法反色后永远读到 light——
// 这个垫片把它重定向到原生桥的真值（见 system-theme-media.ts 头注）。
import "./system-theme-media.js";
import { installInsetsChannel } from "./system-insets.js";
import { installImeLift } from "./ime-lift.js";
import { installComposerTouchFocus } from "./composer-touch-focus.js";
import { installJankWitness } from "./jank-witness.js";
import { installInputRecovery } from "./input-recovery.js";
import { installNarrowSidebarDrawer } from "./web-mobile-shell.js";
import { createRoot } from "react-dom/client";
import { AppErrorBoundary, Root, ZCodeIntlProvider, generateMobileDeviceFingerprint, setStreamClientId } from "@zcode/ui";
import { ChannelClient } from "@zcode/rpc";
import { RemoteServiceAccess } from "@zcode/client";
import type { IServiceAccessor } from "@zcode/services";

import { createMobileServices } from "./services.js";
import type { ModelTargetResolver } from "./provider-target.js";
import { installMemoryCredentialBridge } from "./credentials.js";
import { createMobilePlatform } from "./platform.js";
import { notSupportedDeferred } from "./stand-in.js";

type Theme = "zai-dark" | "zai-light" | "dark" | "light" | "system";

function normalizeTheme(theme: Theme): Theme {
  // 与上游 useTheme.normalizeThemePreference 同一张表：暗/亮统一收敛到 zai-* 两套配色。
  if (theme === "dark") return "zai-dark";
  if (theme === "light") return "zai-light";
  return theme;
}

/**
 * 首帧之后的主题落地，逻辑逐字对齐上游 useTheme.applyTheme + store 初始化（同一份 class 语义）：
 * `.dark` 管亮/暗轴（重绑后的 dark: 工具类就认它），theme-zai-dark/light 管具体配色。
 * system 偏好变化时的重新应用也在这里挂上（上游靠 useTheme 的 matchMedia 监听，端侧没有那个 hook 实例）。
 */
function applyTheme() {
  const saved = (globalThis.localStorage?.getItem("zcode-theme") ?? "zai-dark") as Theme;
  const resolved = normalizeTheme(saved === "system" ? (systemDarkPref() ? "dark" : "light") : saved);
  const dark = resolved === "zai-dark";
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.classList.toggle("theme-zai-light", resolved === "zai-light");
  document.documentElement.classList.toggle("theme-zai-dark", resolved === "zai-dark");
  void themeFollowSystemWatcher();
}

/**
 * "跟随系统"的进程内刷新。真机上夜间模式切换通常重建 Activity（首帧脚本会重跑），
 * 但 ColorOS 不少场景不重建、只是前后台来回——media query 在这里又永远是 light，
 * 所以每次页面回到前台都按原生桥重读一遍。只挂一次，按 saved 判断（设置页改回
 * 显式主题后它自然不再起作用）。
 */
let systemWatcherArmed = false;
function themeFollowSystemWatcher(): void {
  if (systemWatcherArmed) return;
  systemWatcherArmed = true;
  document.addEventListener?.("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const saved = (globalThis.localStorage?.getItem("zcode-theme") ?? "zai-dark") as Theme;
    if (saved === "system") applyTheme();
  });
  // 上游 store 的 setTheme 只写 localStorage + 自己 applyTheme，不过我们这份；
  // 换肤后这条也要重算 system，挂 storage 事件（同文档内不触发，跨标签才有）之外，
  // MutationObserver 那条系统栏链路已经保证了 class 与原生条一致，这里不再补监听。
}

/**
 * 原生系统栏跟随页面主题。为什么挂在 MutationObserver 而不是 applyTheme 里：
 * 设置页的换肤走的是上游 store 的 setTheme → useTheme.applyTheme，根本不过 entry 这个函数；
 * 监听 documentElement 的 class 变化，不管哪条路径把 .dark 翻了，原生条都能收到。
 * 桥不在（桌面开发宿主）直接返回，页面 CSS 本来就自洽。
 */
function syncNativeChromeFromDom(): void {
  const zcodeUi = (globalThis as { zcodeUi?: { setThemeDark(dark: boolean): void } }).zcodeUi;
  if (!zcodeUi) return;
  let last: boolean | null = null;
  const push = () => {
    const dark = document.documentElement.classList.contains("dark");
    if (dark === last) return;
    last = dark;
    try {
      zcodeUi.setThemeDark(dark);
    } catch {
      // 系统栏上色失败不打死主题切换：页面内容已经切好了，状态栏顶多是旧色。
    }
  };
  push();
  new MutationObserver(push).observe(document.documentElement, { attributeFilter: ["class"] });
}

/**
 * 系统深浅色的读数口。真机上 media query 不可信：外壳关掉了算法反色，WebView 的
 * prefers-color-scheme 被钉在"应用的明暗"上、永远读到 light（0.3.5 装机反馈"跟随系统
 * 无效"即此）——系统的真实夜间模式要问原生桥 zcodeUi.systemDark()。桥不在（桌面浏览器
 * 里跑验证）才退回 media query。与 ui.html 首帧脚本同一份取法。
 */
function systemDarkPref(): boolean {
  const zcodeUi = (globalThis as { zcodeUi?: { systemDark?(): boolean } }).zcodeUi;
  if (zcodeUi && typeof zcodeUi.systemDark === "function") {
    try {
      return Boolean(zcodeUi.systemDark());
    } catch {
      // 桥方法异常时退回 media query，和没有桥走同一条兜底。
    }
  }
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

function FailureScreen({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="h-dvh min-h-dvh w-screen bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-lg items-center px-4">
        <section className="w-full rounded-xl border border-card-border bg-card p-5">
          <div className="flex items-center gap-3">
            <span className="size-2 rounded-full bg-destructive" />
            <h1 className="text-ui-xs font-medium">{title}</h1>
          </div>
          {/* 端侧首屏失败必须把原因写在屏幕上：只有 console 的话，装到手机上什么也回收不到。 */}
          <p className="mt-2 break-all text-ui-xs/relaxed text-foreground-subtle">{detail}</p>
          <button
            type="button"
            className="mt-4 rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs text-foreground-subtle"
            onClick={() => window.location.reload()}
          >
            重试
          </button>
        </section>
      </div>
    </div>
  );
}

function fingerprint(): string {
  const key = "zcode:device-fingerprint";
  const stored = globalThis.localStorage?.getItem(key);
  if (stored) return stored;
  const fresh = generateMobileDeviceFingerprint();
  try {
    globalThis.localStorage?.setItem(key, fresh);
  } catch {
    // 隐私模式下 localStorage 会抛；没有持久指纹就用一次性的，但绝不能因此让首屏起不来。
  }
  return fresh;
}

function hideBooting() {
  // ui.html 里的启动态是首屏前的兜底；渲染出一屏之后必须撤掉，不然它会一直盖在上面。
  // 先淡出再移除：直接 remove 会让最后一段是硬切，视觉上像闪屏。
  const el = document.getElementById("booting");
  if (!el) return;
  el.classList.add("leaving");
  setTimeout(() => el.remove(), 240);
}

/**
 * 把启动走到哪一步写在屏幕上。
 * 端上出问题时唯一能回收到的就是这块文字（没有 devtools），而"白屏"本身不说明死在哪一行。
 */
function say(step: string) {
  const el = document.getElementById("boot-step") ?? document.getElementById("booting");
  if (el) el.textContent = step;
  // 启动阶段留痕：真机上只有装机报告能回收，"卡在哪一步"要能事后读出来。
  const trace = ((globalThis as { __zcodeBootTrace?: Array<{ at: number; step: string }> }).__zcodeBootTrace ??= []);
  trace.push({ at: Date.now(), step });
}

/**
 * 首屏启动。出货路径由文件末尾那句自动调用；本机的浏览器验证（build/chatdev-entry.ts）
 * 会先关掉自动调用、自己带一个 mock 模型落点再进来，这样走的是**同一份**启动代码。
 * 复制一份 boot 出来单独维护的话，验证过的东西和装到手机上的东西就不是同一个东西了。
 */
export async function bootMobileUi(overrides: { agentModelTargets?: ModelTargetResolver } = {}) {
  const host = document.getElementById("root");
  if (!host) throw new Error("ui.html 里没有 #root");
  // insets 读数通道（0.3.8：留边改由原生给 WebView setPadding，这里只维护 CSS 变量与自检读数，
  // 见 system-insets.ts 头注）。必须在首帧前挂：读数晚一帧，自检页就可能读到全零的旧值。
  installInsetsChannel();
  // 键盘抬高输入条（0.4.9，装机"输入框没随输入法抬高"）：消费 insets 推送垫 sticky dock。
  installImeLift();
  // 输入区触摸聚焦垫片（0.4.10，装机"点输入框要双击才出输入法"）：挂在 document 捕获上，
  // 先于 React 挂载也无妨——事件监听器不碰 DOM 结构。
  installComposerTouchFocus();
  // 主线程冻结证人（0.4.10，装机"整个应用卡死"）：200ms 心跳量 gap，≥800ms 记进
  // zcode-mobile.jank.diag，自检 M13 回读。开销=一个定时器，可忽略。
  installJankWitness();
  installInputRecovery();
  // 竖屏侧栏抽屉（0.3.8）：窄屏把 #sidebar 投影成覆盖层抽屉 + 接管上游切换按钮。
  // 观察器在 React 挂载后才找得到 #sidebar，所以这条可以在 root.render 之前挂（内部是 rAF 轮询）。
  installNarrowSidebarDrawer();
  const root = createRoot(host);
  applyTheme();
  // 首帧上色之后挂 class 监听：设置页换肤走的是上游 store 的 applyTheme，不过这个函数，
  // 只有监听 DOM 才能把每一条换肤路径都接到原生系统栏上。
  syncNativeChromeFromDom();
  document.title = "aZCode";
  // 同一个指纹既做流式 clientId，也做模型请求里的 metadata.user_id：桌面上这两个也是同源，
  // 分成两个值就没法把"这一轮请求"和"这个设备的流"对到一起。
  const deviceId = fingerprint();
  setStreamClientId(deviceId);

  let services: IServiceAccessor;
  let meta: {
    fsEngine: string;
    sqliteEngine: string;
    /** null = 会话持久化没起来（对话重启即失忆）。失败屏上如实写出来。 */
    sessionStoreEngine: string | null;
    stubbed: string[];
    degraded: Array<{ name: string; error: string }>;
    agentLog: string[];
    taskRows: () => Promise<Array<{ taskId: string; title: string; status?: string; updatedAt: number }>>;
  };
  // 桌面开发宿主没有 Keystore。只有显式带 ?devCredentials=1 才装内存凭据桥：
  // 它一刷页面就什么都不剩，只能证明登录链路的形状对，绝不能当成端侧凭据存储的替代。
  // 条件里必须带上"原生桥不在"：真机上有人拼这个参数（或用调试器改 URL）就会把 Keystore 桥
  // 顶掉，登录后 token 只活在内存里，重启即失联——那是要静默掉一整台设备的登录态的。
  if (
    (globalThis as { zcodeCredentials?: unknown }).zcodeCredentials === undefined &&
    new URLSearchParams(globalThis.location?.search ?? "").get("devCredentials") === "1"
  ) {
    installMemoryCredentialBridge();
  }
  try {
    say("装配端侧服务");
    const runtime = await createMobileServices({
      initSqlJs: (globalThis as { initSqlJs?: unknown }).initSqlJs as never,
      wasmFile: "./sql-wasm.wasm",
      deviceId,
      ...(overrides.agentModelTargets ? { agentModelTargets: overrides.agentModelTargets } : {}),
      onStep: say,
    });
    const client = new ChannelClient(runtime.protocolPair[1]);
    const access = new RemoteServiceAccess(client);
    // 服务端没注册的 channel 换成"订阅是空、真调用抛 EUNSUPPORTED"的面。
    // 为什么订阅要放过：首屏挂载时 UI 会对几乎每个服务面都 onDid… 一次，用会抛错的面
    // 就等于让第一个副作用把整屏打死（实测 modelSelectionService.onDidChange 触发错误边界）。
    // 放过订阅不等于装成能用——真调用照样抛，而"端侧缺哪几面"仍然写在启动屏和自检报告里。
    for (const name of runtime.stubbed) {
      Object.defineProperty(access, name, {
        value: notSupportedDeferred(`mobile:${name}`, "端侧还没接这个服务面"),
        enumerable: true,
      });
    }
    services = access;
    meta = runtime;
    // 端上没有 devtools，"哪些面真的接上了、哪些降级了"必须能被读回来。
    // 只暴露这份清单，不暴露 services 本身。
    (globalThis as { __zcodeMobileMeta?: typeof meta }).__zcodeMobileMeta = meta;
  } catch (e) {
    root.render(<FailureScreen title="端侧运行时启动失败" detail={String((e as Error)?.stack ?? e)} />);
    hideBooting();
    return;
  }

  root.render(
    <AppErrorBoundary>
      <ZCodeIntlProvider settingService={services.settingService} broadcastService={services.broadcastService}>
        <Root
          services={services}
          platform={createMobilePlatform()}
          restoreSession
          allowOpenWorkspace
          // 0.3.7：不再传 preferDirectoryBrowser —— 打开工作区走 platform.selectDirectory()
          // （系统文件管理器 OPEN_DOCUMENT_TREE，见 platform.ts）。之前它为 true 时 UI 进端内
          // 目录浏览器，而那棵树只有应用私有的 /work，装机反馈"选择工作区没用系统文件管理器"即此。
          supportsEmbeddedBrowser={false}
          allowRemoteWorkspace={false}
          initialWorkspaceLoadingFallback={
            <FailureScreen
              title="端侧运行时"
              detail={[
                `fs=${meta.fsEngine} · sqlite=${meta.sqliteEngine} · 会话持久化=${meta.sessionStoreEngine ?? "未启用"}`,
                `未接入 ${meta.stubbed.length} 个服务面：${meta.stubbed.join("、")}`,
                ...(meta.degraded.length ? [`服务不可用：${meta.degraded.map((d) => `${d.name} —— ${d.error}`).join("；")}`] : []),
                // 对话真正跑起来以后，这块只在它出错时多出几行；没事的时候不多占屏幕。
                ...(meta.agentLog.length ? [`对话记录：${meta.agentLog.slice(-3).join(" / ")}`] : []),
              ].join("\n")}
            />
          }
        />
      </ZCodeIntlProvider>
    </AppErrorBoundary>,
  );
  hideBooting();
}

// 出货包：加载即启动。本机的浏览器验证会把这句旗子立起来，自己带一个 mock 模型落点再进来——
// 用的是**同一份 bundle**，不是给验证另打一套产物（另打一份就等于验的手机上跑的东西）。
// 旗子没立时不装这个全局钩子：出货面上不该留一个"能把模型请求改到别的 URL"的入口。
const bootHost = globalThis as {
  __zcodeMobileSkipAutoBoot?: boolean;
  __zcodeMobileBoot?: (overrides: { agentModelTargets?: ModelTargetResolver }) => Promise<void>;
};
if (bootHost.__zcodeMobileSkipAutoBoot) {
  bootHost.__zcodeMobileBoot = bootMobileUi;
} else {
  void bootMobileUi().catch((e) => {
    const host = document.getElementById("root");
    if (host) createRoot(host).render(<FailureScreen title="启动失败" detail={String((e as Error)?.stack ?? e)} />);
    hideBooting();
  });
}
