// 移动端外壳提供给 UI 的"平台能力"。
// 为什么是重写而不是复用：上游的 `createWebPlatform()` 是 packages/web/src/main.tsx:190 的**局部函数**，
// 没有导出，而移动端必须有自己的入口（Web 入口把 connectViaWebSocket 写死在组合根里）。
// 这里以它为底本，把"Web 做不到"的几项换成端侧真做得到的：外链交给原生桥、通知走原生、
// 工作区选择用服务端目录浏览器（本来就是端侧 vfs）。其余保持同样的显式"不支持"措辞。
import type { IPlatformService, RemoteTarget } from "@zcode/shared";
import { traceOAuthEvent } from "./oauth-trace.js";

type DeviceBridge = { openExternal?(url: string): string } | undefined;

/** OAuthLinkBridge.kt 注册的名字：take() 取走一条待处理的深链，stats() 只给计数。 */
type OAuthLinkBridge = { take?(): string; stats?(): string } | undefined;

/** WorkspaceBridge.kt：pickDirectory() 同步回"已发出"，路径晚一步经 __zcodeWorkspacePicked 推回来。 */
type WorkspaceBridge = { pickDirectory?(): string } | undefined;

function workspaceBridge(): WorkspaceBridge {
  const b = (globalThis as { zcodeWorkspace?: { pickDirectory?(): string } }).zcodeWorkspace;
  return b && typeof b.pickDirectory === "function" ? b : undefined;
}

/**
 * 系统文件夹选择器（0.3.7，装机反馈"新建项目工作区还是没用系统文件管理器"）。
 * 发起与收结果分两条道：@JavascriptInterface 是同步阻塞的，等不到 Activity 结果，
 * 所以发起只拿"started"，真正的挂载点路径由原生 evaluateJavascript 回调 __zcodeWorkspacePicked。
 * 回调有丢失的可能（用户在系统选择器开着时切去自检页/进程被杀）——那条 Promise 绝不能悬着，
 * "打开工作区"按钮会永久转圈：超时 5 分钟如实当取消，与 FileChooser 的 ValueCallback 同一条纪律。
 */
function pickDirectoryViaBridge(): Promise<string | null> {
  const b = workspaceBridge();
  if (!b) return Promise.resolve(null);
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const host = globalThis as { __zcodeWorkspacePicked?: (v: string | null) => void };
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      if (host.__zcodeWorkspacePicked === finish) delete host.__zcodeWorkspacePicked;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), PICKER_TIMEOUT_MS);
    host.__zcodeWorkspacePicked = finish;
    try {
      const res = JSON.parse(String(b.pickDirectory?.() ?? "{}"));
      if (res.started !== true) finish(null);
    } catch {
      finish(null);
    }
  });
}

const PICKER_TIMEOUT_MS = 5 * 60_000;

function oauthLinkBridge(): OAuthLinkBridge {
  const b = (globalThis as { zcodeOAuthLink?: { take?(): string; stats?(): string } }).zcodeOAuthLink;
  return b && typeof b.take === "function" ? b : undefined;
}

function deviceBridge(): DeviceBridge {
  const b = (globalThis as { zcodeDevice?: { openExternal?(url: string): string } }).zcodeDevice;
  return b && typeof b.openExternal === "function" ? b : undefined;
}

/** 原生侧上报"这次调用没做成"时给出的显式原因，别让 UI 看到 undefined。 */
function bridgeUnavailable(what: string) {
  return Promise.resolve({ success: false, error: `端侧外壳未提供 ${what}（原生桥缺失，不是权限问题）` });
}

/**
 * 往工作区写一个文本文件，返回 vfs 的虚拟绝对路径。
 *
 * 为什么落 `/work/.zcode/` 而不是桌面临时目录：桌面把长粘贴写到 OS temp（`homedir` 之外），
 * 端侧唯一被 Agent 看得见、且重启还在的树就是 vfs 根，`/work` 之外一律 permission_denied。
 * 写在这里的附件和会话库同一棵树，Agent 用 `Read` 就能读到 —— 不需要再走一遍上传。
 */
function writeWorkspaceText(virtualPath: string, text: string): { path: string; sizeBytes: number } {
  const b = (globalThis as { zcodeFs?: { call(request: string): string } }).zcodeFs;
  if (!b || typeof b.call !== "function") {
    throw new Error("端侧没有文件桥（zcodeFs），写不了工作区文件");
  }
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  // 分片转 binary：单片 String.fromCharCode(...bytes) 在几 MB 时会把参数栈撑爆。
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const res = JSON.parse(
    b.call(JSON.stringify({ op: "write", path: virtualPath, base64: btoa(binary), createParents: true })),
  ) as { ok?: boolean; path?: string; code?: string; message?: string };
  if (!res.ok) throw new Error(res.message ?? res.code ?? "写入失败");
  return { path: res.path ?? virtualPath, sizeBytes: bytes.length };
}

/** 附件文件名要能在同一目录里共存，但不能带用户粘贴内容里的路径分隔符。 */
function safeAttachmentName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  return base.replace(/[^\w.@-]/g, "_").slice(0, 80) || `pasted-${Date.now()}.txt`;
}

export function createMobilePlatform(): IPlatformService {
  const noopUnsubscribe = () => () => {};

  // 深链 → JS 的投递（§1.5.15）。三个现场都要能取到，缺一个就会退化成"转圈圈"：
  // ① 原生推送（App 活着、页面也活着）；② 回到前台（浏览器交接时页面被冻结过，错过那一下推送）；
  // ③ 注册时立即取一次（冷启动被深链拉起来，URL 早于 Root 挂载就到了）。
  // 外壳只"存一条、给一次"，state 校验与 token 交换都在服务层，所以这里不解析 code。
  const oauthListeners = new Set<(url: string) => void>();
  let oauthHooksInstalled = false;

  const drainOAuthLink = () => {
    const bridge = oauthLinkBridge();
    if (!bridge) return;
    let res: { ok?: boolean; url?: string | null } = {};
    try {
      res = JSON.parse(String(bridge.take!()));
    } catch {
      traceOAuthEvent("deep-link-parse-failed", {});
      return;
    }
    const url = typeof res.url === "string" ? res.url : "";
    if (!res.ok || !url) return;
    let keys: string[] = [];
    try {
      keys = [...new URL(url).searchParams.keys()];
    } catch {
      keys = ["<unparsable>"];
    }
    // 只记参数名不记参数值：这里头是 code 与 state。
    traceOAuthEvent("deep-link-delivered", { queryKeys: keys });
    for (const listener of [...oauthListeners]) {
      try {
        listener(url);
      } catch {
        // 单个订阅者抛错不能把投递链打断；Root 自己有错误边界
      }
    }
  };

  const installOAuthHooks = () => {
    if (oauthHooksInstalled) return;
    oauthHooksInstalled = true;
    (globalThis as { __zcodeOAuthLink?: () => void }).__zcodeOAuthLink = drainOAuthLink;
    globalThis.document?.addEventListener?.("visibilitychange", () => {
      if (globalThis.document?.visibilityState === "visible") drainOAuthLink();
    });
    globalThis.addEventListener?.("focus", drainOAuthLink);
  };

  return {
    canSelectFilePath: false,
    // 工作区选择（0.3.7）：系统文件管理器（DocumentsUI 的 OPEN_DOCUMENT_TREE）。返回的是
    // SAF 树在 vfs 里的挂载点（`/mnt/<文件夹名>`），读写经 zcodeTree（TreeBridge.kt）派发。
    // 0.3.6 之前这里恒 null + entry.tsx 传 preferDirectoryBrowser，用户只能用端内目录浏览器
    // 在应用私有的 /work 里转圈 —— 装机反馈"新建项目工作区还是没使用系统文件管理器"即此。
    // 桥不在（桌面 harness）返回 null：调用方（openWorkspaceFolderEntry）拿到 null 什么都不做，
    // 不会进假路径那条支。
    selectDirectory: () => pickDirectoryViaBridge(),
    // `false` 让附件按钮走隐藏 `<input type="file">`（useComposerAttachments.ts:711），由外壳的
    // FileChooser.kt 接住；而 selectFile() 在上游只有一个调用方——远程连接的 SSH 私钥选择器
    // （RemoteConnectionFields.tsx:454），拿到的路径是交给**那一端**去读的。端侧要"实现"它只能把
    // 私钥拷进工作区，那等于把用户的密钥写进 Agent 可读、可能被提交的文件里，所以这里返回 null：
    // 宁可按钮点不出东西，也不给出一个会走错文件的假路径。selectFiles() 上游暂无调用方。
    selectFile: () => Promise.resolve(null),
    selectFiles: () => Promise.resolve([]),
    // SAF 回来的 content:// 没有文件系统路径可给；返回 null 就是让 UI 走 Web 字节上传那条支。
    getPathForFile: () => null,
    // 长粘贴（≥15k 字符）落成真文件再按路径发，桌面走 OS temp；端侧写进工作区，
    // 于是粘贴进来的日志在手机上重启后还在、Agent 也能直接 Read 到。
    createTempTextAttachment: (payload) => {
      try {
        const name = safeAttachmentName(payload.filename ?? `pasted-${Date.now()}.txt`);
        const written = writeWorkspaceText(`/work/.zcode/attachments/${name}`, payload.text);
        return Promise.resolve({
          filename: name,
          localPath: written.path,
          mimeType: "text/plain",
          sizeBytes: written.sizeBytes,
        });
      } catch (e) {
        // 显式抛出去：UI 的粘贴分支会退回"整段文本内联"，而不是悄悄丢掉用户粘贴的内容。
        return Promise.reject(new Error(`端侧长粘贴临时文件写失败：${String((e as Error)?.message ?? e)}`));
      }
    },
    onRemoteConnectionLog: noopUnsubscribe,
    onRemoteSessionClosed: noopUnsubscribe,
    onBotRemoteWorkspaceReconnected: noopUnsubscribe,
    activateOrSetWorkspace: () => Promise.resolve({ activated: false }),
    connectRemote(options: RemoteTarget) {
      return Promise.resolve({
        success: false,
        error: `端侧 Agent 不做远程工作区宿主：${options.kind}`,
      });
    },
    cancelPendingRemoteConnection: () => Promise.resolve(),
    disposeRemoteSession: () => Promise.resolve(),
    isDockerAvailable: () => Promise.resolve(false),
    listWSLDistros: () => Promise.resolve([]),
    listDockerContainers: () => Promise.resolve([]),
    listSSHConfigAliases: () => Promise.resolve([]),
    // MCP 配置的落点由 mcpSyncService 决定（端侧 vfs），外壳不再另存一份用户目录副本。
    loadMcpFromUserDirectory: () => Promise.resolve({ servers: [] }),
    saveMcpToUserDirectory: () =>
      Promise.resolve({ success: false, error: "端侧 MCP 配置由 mcpSyncService 拥有" }),
    migrateLegacyCommonMcp: () =>
      Promise.resolve({ servers: {}, totalCount: 0, importedCount: 0, skippedCount: 0 }),
    openExternal: (url) => {
      const bridge = deviceBridge();
      if (bridge) {
        // 原生侧回 {"ok":false,...} 时抛出去：useOAuth 的 try 里就是这一句，抛出后登录态会显示
        // "登录失败"，而不是转圈等着一个永远不会来的回调（手机上没装浏览器就是这条路径）。
        const raw = bridge.openExternal!(url);
        let res: { ok?: boolean; error?: string } = {};
        try {
          res = JSON.parse(String(raw));
        } catch {
          throw new Error(`端侧 openExternal 返回无法解析的响应: ${String(raw).slice(0, 120)}`);
        }
        if (!res.ok) throw new Error(res.error ?? "端侧无法打开外部链接");
        return;
      }
      // 没有原生桥（桌面浏览器里跑开发自检）才退回 window.open。
      window.open(url, "_blank", "noopener,noreferrer");
    },
    openFeedback: () => Promise.resolve(),
    openCommunity: () => Promise.resolve(),
    canOpenCommunity: async () => false,
    openInFileManager: () => bridgeUnavailable("系统文件管理器"),
    openExternalFile: () => bridgeUnavailable("外部应用打开文件"),
    // 桌面 main 拿 state 决定 deep link 归哪个 provider；端侧外壳只做"存一条、给一次"，
    // state 的校验在 oauthService 里，所以这里只留取证：手机上"点了连接没反应"时，
    // 报告里要能看出授权请求究竟发起过没有。state 本身是 CSRF 令牌，不写进 trace。
    registerOAuthState: (payload) => {
      traceOAuthEvent("state-registered", { provider: payload?.provider ?? "?" });
    },
    // 深链回跳是端侧登录的**主路径**：手机浏览器在 scheme 交接那一步就把标签页冻结/回收，
    // 官网那侧的最终化不会跑完，轮询永远停在 pending —— 0.2.0 的"转圈圈"就是这么来的。
    // 注册时立刻取一次，覆盖"冷启动被深链拉起来、URL 早于 Root 挂载"这一种。
    onOAuthCallback: (callback) => {
      installOAuthHooks();
      oauthListeners.add(callback);
      drainOAuthLink();
      return () => {
        oauthListeners.delete(callback);
      };
    },
    onPaymentCallback: noopUnsubscribe,
    onShareImport: noopUnsubscribe,
    notifyRendererReady: () => {},
    // 端侧默认不报任何遥测：这是隐私默认，不是漏实现（见 PORTING §R11/R13）。
    reportTelemetryEvent: async () => {},
    reportArmsCustomEvent: () => Promise.resolve(),
    showTaskNotification: (payload) => {
      // 原生通知桥还没接（DeviceProbe 上只有 openExternal），先走 Web Notification；
      // 两端都没有时静默忽略，不假装通知已发出。
      if (typeof window.Notification === "undefined" || window.Notification.permission !== "granted") {
        return;
      }
      try {
        new window.Notification(payload.title, { body: payload.body, silent: true });
      } catch {
        // 通知不可用时静默忽略，不打断主流程
      }
    },
    syncWindowTabs: () => {},
    syncWindowUnreadCount: () => {},
    syncActiveTaskSession: () => {},
    onFocusTab: noopUnsubscribe,
    onNewTab: noopUnsubscribe,
    onCloseActiveContextRequest: noopUnsubscribe,
    onOpenBrowserUrl: noopUnsubscribe,
    onNewTask: noopUnsubscribe,
    onOpenWorkspace: noopUnsubscribe,
    onWindowFullscreenChanged: noopUnsubscribe,
    onTaskNotificationClick: noopUnsubscribe,
    exportLogs: () => bridgeUnavailable("日志导出"),
    captureWindowScreenshot: () => Promise.resolve(null),
    importChromeBrowserData: () =>
      Promise.resolve({
        success: false,
        cookies: { imported: 0, skipped: 0, failed: 0 },
        localStorage: { originsImported: 0, entriesImported: 0, originsSkipped: 0, originsFailed: 0 },
        error: "chrome_import_not_supported" as const,
      }),
    clearEmbeddedBrowserData: () => bridgeUnavailable("内嵌浏览器数据清理"),
    onUpdateReady: noopUnsubscribe,
    onUpdateCheckResult: noopUnsubscribe,
    onUpdateStateChanged: noopUnsubscribe,
    getUpdateState: () => Promise.resolve({ kind: "idle", enabled: false }),
    downloadUpdate: () => Promise.resolve(),
    cancelUpdateDownload: () => Promise.resolve(),
    getDesktopSessionActivity: () => Promise.resolve({ runningAgentSessionCount: 0 }),
    getDesktopZoomLevel: () => Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: noopUnsubscribe,
    onPostUpdateReleaseNotes: noopUnsubscribe,
    acknowledgePostUpdateReleaseNotes: () => Promise.resolve(),
    skipUpdateVersion: () => Promise.resolve(),
    quitAndInstallUpdate: () => Promise.resolve(),
    getInstalledEditors: () => Promise.resolve([]),
    openInEditor: () => bridgeUnavailable("外部编辑器"),
    executeDesktopCommand: () => Promise.resolve(),
    setApplicationLocale: () => Promise.resolve(),
    setTitleBarTheme: () => Promise.resolve(),
    // 桌面版这个函数用 screen 尺寸拼 deviceId；手机上屏幕尺寸会变（旋转、分屏），
    // 拿它当设备标识会让每次旋转都变成新设备。端侧改用 UI 的持久指纹。
    getDeviceId: () => globalThis.localStorage?.getItem("zcode:device-fingerprint") ?? "mobile-unknown",
  };
}
