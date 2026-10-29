// 端侧插件面（0.7.1，装机"浏览器控制还是显示'端侧 agent 运行时未接入'"）。
//
// 症状的根：services.ts 里 pluginManagementService 拿的是 **替身** agent（notSupportedDeferred），
// 于是设置页一进「浏览器控制」/「钩子」就打印
//   EUNSUPPORTED(zcodeAgentService): listPlugins —— 端侧 Agent 运行时尚未接入
// （桌面的事实源是 CLI 进程扫插件目录；端侧没有那个进程，但"端侧到底有没有浏览器控制"
// 这个问题该由端侧自己如实回答，而不是把替身错误顶到屏幕上）。
//
// 端侧的事实：内置浏览器（BrowserActivity + Browser 工具）是**内建**能力，不来自插件市场；
// 「浏览器控制」开关的真实语义 = 模型能不能用 Browser 工具（tool-engine 读同一个旗子）。
// 所以这里如实投影一个内建条目：
//   - id 用官方 browser-use 同款 id（设置页按这个 id 找条目）；
//   - enabled = 旗子（默认开——0.6.0 起 Browser 工具本来就在，把已开的说成关的是假话）；
//   - 组件清单不编：端侧没有从该插件物化出来的 skill/command 目录（skillRootCount=0）；
//   - 市场/安装/卸载这些真的没有的面，抛具体原因，不返空数组装"没有插件"（见 stand-in 头注）。
//
// 旗子的消费方：tool-engine 的 Browser 工具注册 + 缓存失效（浏览器采样同一旗子）。

const BROWSER_CONTROL_KEY = "zcode-mobile.browserControl";
export function browserControlAvailable(): boolean {
  return typeof (globalThis as { zcodeBrowser?: { open?: unknown } }).zcodeBrowser?.open === "function";
}
/** 旗子变化广播：tool-engine 的引擎缓存按它失效，开/关在下一轮对话生效。 */
export const BROWSER_CONTROL_EVENT = "zcode-mobile:browser-control-changed";

export const BUILTIN_BROWSER_PLUGIN_ID = "browser-use@zcode-plugins-official";

/** 内置浏览器控制是否开（默认开；只有显式存过 "0" 才算关）。 */
export function browserControlEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(BROWSER_CONTROL_KEY) !== "0";
  } catch {
    // 隐私模式 localStorage 会抛：读不到旗子按默认开——与没存过同一条路径。
    return true;
  }
}

export function setBrowserControlEnabled(enabled: boolean): void {
  if (enabled && !browserControlAvailable()) throw new Error("此宿主没有 Browser 原生桥，无法开启浏览器控制。");
  try {
    if (!globalThis.localStorage) throw new Error("localStorage 不可用");
    globalThis.localStorage.setItem(BROWSER_CONTROL_KEY, enabled ? "1" : "0");
    if (globalThis.localStorage.getItem(BROWSER_CONTROL_KEY) !== (enabled ? "1" : "0")) throw new Error("写入后读取不一致");
  } catch {
    // 引擎只读持久化值；写入失败继续报告成功会让设置页与真实工具注册状态分裂。
    throw new Error("浏览器控制设置保存失败，开关未生效。");
  }
  try {
    globalThis.dispatchEvent?.(new CustomEvent(BROWSER_CONTROL_EVENT, { detail: { enabled } }));
  } catch {
    // 事件面失败不影响返回值：调用方拿到的是"已按请求写入"的结果对象。
  }
}

/** 内建浏览器控制条目的投影（形状 = @zcode/shared 的 ZCodePluginInfo，字段一个不多一个不少）。 */
export function builtinBrowserPluginInfo(enabled = browserControlEnabled() && browserControlAvailable()) {
  return {
    id: BUILTIN_BROWSER_PLUGIN_ID,
    name: "browser-use",
    description: browserControlAvailable() ? "端侧内置浏览器控制：让模型通过内置浏览器（Browser 工具）访问和操作网页。" : "此宿主没有 Browser 原生桥，浏览器控制不可用。",
    version: "builtin",
    enabled,
    source: "builtin",
    marketplace: "zcode-plugins-official",
    skillCount: 0,
    skillRootCount: 0,
    commandRootCount: 0,
    mcpServerNames: [] as string[],
    // 不是文件系统里的插件目录，给一个可读的伪路径，别让 UI 把它当成可打开的真实路径。
    rootPath: "builtin://browser-use",
  };
}

/**
 * 端侧 zcodeAgentService 的插件面三件套。返回对象直接并进 agent 服务：
 * pluginManagementService 是薄代理，方法签名与 ZCodeAgentService 的插件子集一致。
 */
export function createMobilePluginFace() {
  return {
    listPlugins: async (_params: unknown) => ({
      plugins: [builtinBrowserPluginInfo()],
      diagnostics: [],
    }),
    getPluginsOverview: async (_params: unknown) => ({
      // 端侧没有插件市场、没有可安装/可恢复的来源——"没有来源"是事实，capability 说明为什么。
      marketplaces: [],
      availablePlugins: [],
      installedPlugins: [],
      restorableBuiltins: [],
      diagnostics: [],
      capability: {
        supported: false,
        reason: "端侧只有内建浏览器控制（Browser 工具），没有插件市场与安装/更新链路。",
      },
    }),
    setPluginEnabled: async (params: { pluginId?: unknown; enabled?: unknown }) => {
      const pluginId = String(params?.pluginId ?? "");
      if (pluginId !== BUILTIN_BROWSER_PLUGIN_ID) {
        throw new Error(
          `端侧没有可启停的插件「${pluginId}」：只有内建的 ${BUILTIN_BROWSER_PLUGIN_ID}（浏览器控制）。`,
        );
      }
      const enabled = params?.enabled === true;
      setBrowserControlEnabled(enabled);
      return { plugin: builtinBrowserPluginInfo(enabled), enabled };
    },
  };
}
