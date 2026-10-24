// 竖屏（窄窗口）的侧栏适配（0.3.8，装机反馈"这个 ui 界面不适配竖屏，侧边栏也不能切换收起展开"）。
//
// 上游的侧栏是**桌面形态**：264px 常驻在 flex 布局第一列（宽度是 React 写在 shell 上的
// `--workspace-sidebar-panel-width`），切换按钮只给带窗口标题区的桌面壳渲染
// （DesktopTopOverlay 的 usesCustomCaptionArea / isMacDesktop 两个分支）。手机竖屏上 264 + 对话列
// 放不进 393px，而收起/展开入口整个不存在——这不是"样式没写好"，是上游没做移动形态。
// 按移植规矩（§5.1：其余全部落在 mobile-runtime/），这里用 DOM 垫片把侧栏变成覆盖层抽屉：
//
//   - 只在 `documentElement.zcode-narrow`（本模块自己的 matchMedia 旗子，< 640px）为真时生效；
//     宽屏一离开就把接管的行内样式全部擦掉，零残留。
//   - `#sidebar` 变 fixed 抽屉（宽屏布局里它本就不占位）：translateX 收 / 0 出，带遮罩从左边滑入。
//   - 展开/收起**不另造按钮**：点的是上游那个 `[data-testid="web-sidebar-toggle"]`
//     （DesktopTopOverlay 的非桌面分支，本轮上游改动加的就是它）——React 的 isSidebarVisible
//     仍是唯一状态源，端侧只投影，不写第二份状态。判"开着"读的是 shell 上那个 CSS 变量的值
//     （>1px 就是 React 说侧栏该可见），不是我写在面板上的 style——读自己写的东西会自锁。
//   - 抽屉里点任务行 / 项目行（`[data-task-item-key]`、`[data-testid^="workspace-item-"]`）之后
//     自动收起：手机上开抽屉就是为了选一条会话，选完还盖着内容就是挡路。只在冒泡阶段补一次
//     代点，不 preventDefault、不改事件——行本身照旧由 React 处理。
//
// z 轴：主列的 composer dock 是 z-20 的全宽层（ConversationTimeline.tsx:1911 那条注释就是它的
// 事故记录），浮层工具组也是 z-20 —— 抽屉 30 / 遮罩 25 都压在它们上面，展开时内容整体让位，
// 这是移动端抽屉的标准形态。收起态入口（☰，浮层里）本来就可见；展开态靠点遮罩或选行收起，
// 不需要 ☰ 活着。
//
// 桥/旗子不在（桌面 harness、宽屏）时这条整体 no-op —— 桌面跑的是同一份 bundle，不能互相影响。

/** 上游 `#sidebar` 面板与它在 shell 上的可见性变量（WorkspaceShellLayout.tsx:106/1534）。 */
const SIDEBAR_SELECTOR = "#sidebar";
const SHELL_SELECTOR = "[data-workspace-shell]";
const PANEL_WIDTH_VAR = "--workspace-sidebar-panel-width";
const SIDEBAR_TOGGLE_SELECTOR = '[data-testid="web-sidebar-toggle"]';
/** 抽屉里点一下就自动收起的两类行：任务行（TaskListItem.tsx 的 data-task-item-key）与项目 tab。 */
const DRAWER_DISMISS_SELECTOR = "[data-task-item-key], [data-testid^='workspace-item-']";
/** 抽屉宽度：上游默认 264（WORKSPACE_SIDEBAR_DEFAULT_WIDTH_PX）封顶屏宽 82%，小屏不贴满。 */
const DRAWER_WIDTH_CSS = "min(264px, 82vw)";
/** 缺省判据的窄窗阈值（0.4.8 起旗子真相源是设置开关，见 armNarrowFlag；这条只在
 *  localStorage 无值时参与缺省判定，供桌面 harness 的 393px 视口命中）。 */
const NARROW_QUERY = "(max-width: 639px)";
/** 边缘滑动的起点带（px）与触发位移阈值（px）。见 installNarrowSidebarDrawer 的三条克制。
 *  0.4.7：28→40 —— 装机"侧滑呼出没实现"，起点带是指尖第一触的命中窗，28 CSS px 在
 *  高缩放的屏上实际不足一个指腹；40px 配 dx>|dy|*1.5 的横向支配判据，正常纵向滚动不会误触。
 *  这条带由原生 setSystemGestureExclusionRects（MainActivity.installGestureExclusionBand）把
 *  系统边缘手势让出来，两端各一条。 */
const EDGE_BAND_PX = 40;
const SWIPE_OPEN_THRESHOLD_PX = 60;

let scrim: HTMLDivElement | null = null;
let installed = false;

function doc(): Document | null {
  return globalThis.document ?? null;
}

function isNarrow(): boolean {
  return doc()?.documentElement.classList.contains("zcode-narrow") === true;
}

/** 侧栏形态闸门（0.4.9，用户点名"竖屏放成覆盖、横屏并排""侧栏该和对话同层、别叠上去卡住
 *  回不去"）：**竖屏（含方形）覆盖成抽屉 + 遮罩，横屏并排走 React 原生 inline 布局**。
 *  横屏时侧栏与主列同层并排、谁也不盖谁——☰ 收起/展开都正常，没有遮罩挡"回去"的路，
 *  这正是装机"卡住没法回去"的结构根因解法。竖屏放不下并排（侧栏 264+对话≥360 逼近屏宽），
 *  才叠成 fixed 抽屉，配边缘滑动收起手势（见下 installNarrowSidebarDrawer）。
 *  前提仍是触屏旗子挂着（armNarrowFlag，用户设的"触屏优化开关"）——键鼠宽屏一律 inline。 */
function isDrawerMode(): boolean {
  if (!isNarrow()) return false;
  const w = globalThis.innerWidth || 0;
  const h = globalThis.innerHeight || 0;
  return h >= w; // 竖屏/方形 → 覆盖；横屏 → 并排
}

function sidebar(): HTMLElement | null {
  return doc()?.querySelector(SIDEBAR_SELECTOR) ?? null;
}

/** 打开态从 shell 上的 React 变量读：这是我从不写的字段，读它才是读"React 的意图"。 */
function reactSaysVisible(): boolean {
  const shell = doc()?.querySelector(SHELL_SELECTOR);
  if (!shell) return false;
  const raw = getComputedStyle(shell).getPropertyValue(PANEL_WIDTH_VAR).trim();
  return (Number.parseFloat(raw) || 0) > 1;
}

function ensureScrim(): HTMLDivElement | null {
  const d = doc();
  if (!d?.body) return null;
  if (scrim?.isConnected) return scrim;
  const el = d.createElement("div");
  el.id = "zcode-narrow-scrim";
  // 遮罩 25、抽屉 30：都压过主列的 z-20 dock 与浮层（见文件头的 z 轴说明）。
  el.style.cssText =
    "position:fixed;inset:0;z-index:25;background:rgba(0,0,0,0.45);opacity:0;pointer-events:none;transition:opacity 200ms ease";
  d.body.appendChild(el);
  scrim = el;
  return el;
}

/** 把行内样式全部擦掉：#sidebar 的 React 样式只有 class（宽度走 shell 变量），不会误伤。 */
function clearPanel(panel: HTMLElement): void {
  panel.removeAttribute("style");
  panel.removeAttribute("inert");
  delete panel.dataset.zcodeDrawer;
}

/** 投影幂等守卫：记录最后一次真正写过的目标，同值不重写（重写会叫醒观察器自己，空转成环）。 */
let lastPanel: HTMLElement | null = null;
let lastKey = "";

/**
 * 抽屉开合状态推给原生（0.4.9，用户点名"从边缘滑动触发返回键也是收起"）：
 * MainActivity.onBackPressed 拦截返回手势——抽屉开着时返回=收起而不是退出应用。
 * JS 是唯一知道抽屉真实状态的一方（投影+React 意图都在这层），原生只消费这个布尔。
 * 桥不在（桌面 harness）时静默 no-op；状态只在变化时推（幂等，避免每帧空转）。
 */
let lastPushedDrawerOpen: boolean | null = null;
function pushDrawerOpen(open: boolean): void {
  if (lastPushedDrawerOpen === open) return;
  lastPushedDrawerOpen = open;
  try {
    (globalThis as { zcodeUi?: { setDrawerOpen?(open: boolean): void } }).zcodeUi?.setDrawerOpen?.(open);
  } catch {
    // 桥调用失败不致命：返回键拦截退化成默认行为（退出），抽屉本身不受影响。
  }
}

function hideScrim(): void {
  if (!scrim) return;
  // 用 CSSOM 逐条写而不是 cssText +=：append 会在行内样式里堆出重复声明，
  // 而且旧写法只在"面板消失"这一个出口上做，设置层覆盖（见下）漏掉了。
  scrim.style.display = "none";
  scrim.style.opacity = "0";
  scrim.style.pointerEvents = "none";
}

/**
 * 设置层覆盖判定（0.7.1，装机"设置点进去特别暗，要点一下才恢复正常"）。
 * 设置 tab 不是整页导航：RootWorkspaceContent 把工作区壳层留在 DOM 里、只挂
 * `data-root-workspace-surface="inert"` 表示"被设置层覆盖"。于是"从抽屉点设置"
 * 这条路径上 #sidebar 既没卸载、React 也仍说抽屉开着 —— 0.6.0 那条"面板没了就收遮罩"
 * 的守卫根本不触发，黑遮罩（z-25）继续压在设置层（z-10）上：整屏发暗，点一下又被
 * 遮罩代点收起（sync 这才把遮罩撤掉）＝用户看到的"点一下才恢复"。
 * 覆盖期间抽屉与遮罩都该离场；投影状态复位，返回工作区时由观察器重新投影。
 */
function coveredBySettingsLayer(): boolean {
  return doc()?.querySelector('[data-root-workspace-surface="inert"]') != null;
}

/**
 * 版本号落地（0.7.3，用户点名"应用内增加能看版本号的地方"）。
 * 原生 DeviceProbe.deviceInfo() 早就回 appVersion/appVersionCode（装机报告靠它区分版本），
 * 但屏幕上没有任何一处显示它——用户想确认自己装的是哪一版只能翻报告。这里把同一份读数
 * 钉在侧栏设置钮上方的一行小字上（宽屏并排/竖屏抽屉两种形态都在 #sidebar 内可见）。
 * 幂等 + 挂 body 子树观察里重建：设置页/插件市场这类整页导航会把侧栏连根换掉，chip 跟着没了，
 * 下一次 settle/sync 再补。桌面开发宿主没有 zcodeDevice 桥 → 不显示（不编一个假版本号）。
 */
const VERSION_CHIP_ID = "zcode-version-chip";
function readAppVersion(): string | null {
  const bridge = (globalThis as { zcodeDevice?: { deviceInfo?(): string } }).zcodeDevice;
  if (!bridge || typeof bridge.deviceInfo !== "function") return null;
  try {
    const info = JSON.parse(String(bridge.deviceInfo())) as {
      appVersion?: unknown;
      appVersionCode?: unknown;
    };
    const v = typeof info.appVersion === "string" ? info.appVersion.trim() : "";
    if (!v) return null;
    const code = typeof info.appVersionCode === "number" ? info.appVersionCode : null;
    return code ? `aZCode ${v} (${code})` : `aZCode ${v}`;
  } catch {
    return null;
  }
}
function ensureVersionChip(): void {
  const d = doc();
  const panel = sidebar();
  if (!d || !panel) return;
  const version = readAppVersion();
  const existing = d.getElementById(VERSION_CHIP_ID);
  if (!version) {
    existing?.remove();
    return;
  }
  // 钉在设置按钮所在的 footer 里（TaskList.tsx 的 footer div）；找不到 footer 就退到 panel 末尾。
  const settingsBtn = panel.querySelector<HTMLElement>('[data-testid="task-settings-button"]');
  const host = settingsBtn?.parentElement ?? panel;
  if (existing && existing.parentElement === host && existing.textContent === version) return;
  existing?.remove();
  const chip = d.createElement("div");
  chip.id = VERSION_CHIP_ID;
  chip.textContent = version;
  chip.setAttribute("role", "note");
  chip.style.cssText = [
    "padding:2px 8px 6px",
    "font-size:11px",
    "line-height:1.4",
    "opacity:.55",
    "text-align:center",
    "pointer-events:none",
    "user-select:none",
  ].join(";");
  if (settingsBtn?.parentElement && host.contains(settingsBtn)) {
    host.insertBefore(chip, settingsBtn);
  } else {
    host.appendChild(chip);
  }
}

function sync(): void {
  const panel = sidebar();
  // 版本号 chip（0.7.3）：sync 是唯一被抽屉投影、旗子切换、整页导航返回都走到的入口，
  // 挂这里最稳（幂等：文本没变就早退）。放在 panel 判空之后，没侧栏谈不上 chip。
  if (panel) ensureVersionChip();
  if (!panel) {
    // 0.6.0（用户报"侧边栏进设置整个画面变暗，点一下才恢复"）：进设置页这类整页导航会把
    // #sidebar 连根卸掉——旧代码在这里直接 return，遮罩还挂在屏上（opacity 1、吃点击），
    // 用户看到的"变暗"就是它；再点一下遮罩代点了 toggle 才"恢复"。面板没了 = 抽屉态
    // 不存在，遮罩必须跟着走。lastPanel/lastKey 一并复位，回来时能重新投影。
    hideScrim();
    lastPanel = null;
    lastKey = "";
    pushDrawerOpen(false);
    return;
  }
  // 覆盖态走与"面板没了"同一套收场：遮罩离场 + 投影复位（返回时重建）。
  if (coveredBySettingsLayer()) {
    hideScrim();
    lastPanel = null;
    lastKey = "";
    pushDrawerOpen(false);
    return;
  }
  // 0.4.9 形态闸门（用户点名"竖屏覆盖、横屏并排""侧栏该和对话同层、别叠上去卡住回不去"）：
  // 只有竖屏（isDrawerMode）才把 #sidebar 投影成 fixed 抽屉 + 遮罩；横屏**不投影**，走 React
  // 原生 inline 布局——侧栏与主列同层并排、谁也不盖谁，☰ 收起/展开都正常、没有遮罩挡回不去的路。
  // 旋转会触发 resize → sync 重跑，形态随方向切换；触屏旗子（大按钮等）仍恒定不随旋转。
  const drawerActive = isDrawerMode();
  if (!drawerActive) {
    if (panel.dataset.zcodeDrawer === "1") clearPanel(panel);
    hideScrim();
    lastPanel = null;
    lastKey = "";
    pushDrawerOpen(false);
    return;
  }
  const opened = reactSaysVisible();
  pushDrawerOpen(opened);
  const key = `${opened ? "open" : "closed"}`;
  if (panel === lastPanel && key === lastKey) return;
  lastPanel = panel;
  lastKey = key;
  panel.dataset.zcodeDrawer = "1";
  // 上游的过渡只认 width/opacity；fixed 之后 width 不再变（宽度恒为抽屉宽），动画归 transform。
  // 行内 background：#sidebar 本身透明（桌面时由外层供底），fixed 之后必须自己有不透明底，
  // 否则遮罩会从内容底下透出来。--color-background 随 .dark 翻转，深浅色都对。
  panel.style.cssText = [
    "position:fixed",
    "top:0",
    "bottom:0",
    "left:0",
    "z-index:30",
    "width:" + DRAWER_WIDTH_CSS,
    "max-width:" + DRAWER_WIDTH_CSS,
    "background:var(--color-background)",
    "pointer-events:auto",
    "opacity:1",
    "transform:translateX(" + (opened ? "0" : "-102%") + ")",
    "transition:transform 200ms ease",
    "box-shadow:" + (opened ? "2px 0 16px rgba(0,0,0,0.35)" : "none"),
  ].join(";");
  // 收起的抽屉对无障碍与焦点都该"不在场"：inert 比 pointer-events 更彻底，
  // hidden/display:none 会打断 React 对面板的测量。
  if (opened) panel.removeAttribute("inert");
  else panel.setAttribute("inert", "");
  const el = ensureScrim();
  if (el) {
    el.style.display = opened ? "block" : "none";
    el.style.opacity = opened ? "1" : "0";
    el.style.pointerEvents = opened ? "auto" : "none";
  }
}

/** 窄屏旗子（0.4.8 重做）：设置页"触屏设备显示优化"开关（键 zcode-mobile.touchOptimized）
 *  是唯一真相源——"1"恒开、"0"恒关；无值时按设备形态缺省（触屏 pointer:coarse 开、
 *  键鼠关，另兼容窄窗 max-width 供桌面 harness）。**不再挂 matchMedia change**：
 *  用户明确要求"开了就是开了，不因横竖屏旋转而改变"——旗子一旦定下，旋转/改窗宽都不动，
 *  只有设置页开关（zcode-mobile:touch-opt-changed 事件）能翻它。
 *  0.4.8 的根因背景：装机 M11 抓到一加平板 CSS 视口 ~808px，纯 max-width 阈值永不命中，
 *  0.4.2 起五版"顶栏调大下移没效果"其实是整个移动形态分支从未在这台设备上跑过。 */
const TOUCH_OPT_KEY = "zcode-mobile.touchOptimized";
const TOUCH_OPT_EVENT = "zcode-mobile:touch-opt-changed";

function armNarrowFlag(): void {
  const d = doc();
  if (!d) return;
  const resolve = (): boolean => {
    const pinned = globalThis.localStorage?.getItem(TOUCH_OPT_KEY);
    if (pinned === "1") return true;
    if (pinned === "0") return false;
    const coarse = globalThis.matchMedia?.("(pointer: coarse)")?.matches === true;
    const narrowWindow = globalThis.matchMedia?.(NARROW_QUERY)?.matches === true;
    return coarse || narrowWindow;
  };
  const apply = () => {
    d.documentElement.classList.toggle("zcode-narrow", resolve());
    sync();
  };
  apply();
  // 设置页开关广播（TouchOptimizedSwitchRow）：翻旗子并重投影抽屉。
  globalThis.addEventListener?.(TOUCH_OPT_EVENT, apply);
}

/**
 * React 首帧之后才挂载出 #sidebar：0.3.8 首版用"400 帧 rAF 预算"等它，装机 e2e 证明这条错了——
 * 端侧 boot 要等 wasm/sqlite/首装引导走完才渲染 shell，6.6 秒的预算在它挂载前就烧完了，
 * 之后没有任何东西再叫醒投影（旗子和按钮都对，唯独抽屉没出来）。改成挂载敏感的搜索：
 * 一个 body 子树观察器，每来一次变更试找一次，找到即断开自己、换成两个窄观察器
 * （#sidebar 的 class/style 与 shell 的 style——React 的可见性只写在这两处）。
 * 计数上限只是极端宿主的兜底（永远没挂载时别留一个无限订阅）。
 */
function attachObservers(): void {
  const d = doc();
  if (!d?.body) return;
  let searchTries = 0;
  const settle = () => {
    search.disconnect();
    const panel = sidebar();
    if (!panel) return;
    const mo = new MutationObserver(() => sync());
    mo.observe(panel, { attributes: true, attributeFilter: ["class", "style", "aria-hidden", "inert"] });
    const shell = d.querySelector(SHELL_SELECTOR);
    if (shell) mo.observe(shell, { attributes: true, attributeFilter: ["style"] });
    // 整页导航观察（0.6.0，用户报"侧边栏进设置画面变暗"）：settle 之后 body 子树的增删
    // （进设置/插件市场这类整页替换，把 #sidebar 连根卸掉）只有这里看得见——面板自己的
    // observer 随节点离场失效。sync 幂等且有 lastKey 短路，流式期间的 DOM 抖动只做
    // querySelector + 早退；rAF 合帧防高频重排。
    // 0.7.7 补（用户报"进设置变暗没完全解决"）：RootWorkspaceContent 把覆盖标记做成
    // **同一元素上的属性翻转**（data-root-workspace-surface="inert"⇄"interactive"），设置层
    // 一旦挂载过就常驻——第二次进设置零 childList 变化，childList-only 的本观察器永不触发，
    // sync() 里 coveredBySettingsLayer() 判对了也没有人叫醒它，遮罩继续压在设置层上＝偶发变暗。
    // 属性必须进同一批观察：attributeFilter 收窄到这一个键，开销可忽略。
    let navScheduled = false;
    const navMo = new MutationObserver(() => {
      if (navScheduled) return;
      navScheduled = true;
      requestAnimationFrame(() => {
        navScheduled = false;
        sync();
      });
    });
    navMo.observe(d.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-root-workspace-surface"],
    });
    // 顶栏证人（0.4.7）：#sidebar 与浮层按钮同一棵 React 树挂载，settle 时两者都在 DOM 里了。
    // 拍三枪（0/1.5s/4s）覆盖"按钮晚于侧栏挂载"的宿主差异；旋转/缩放由 resize 那条补记。
    recordTopbarDiag();
    globalThis.setTimeout?.(recordTopbarDiag, 1500);
    globalThis.setTimeout?.(recordTopbarDiag, 4000);
    sync();
  };
  const search = new MutationObserver(() => {
    if (sidebar()) settle();
    else if (++searchTries > 4000) search.disconnect();
  });
  search.observe(d.body, { childList: true, subtree: true });
  if (sidebar()) settle(); // 已经挂载（热重载/桌面 harness 二次 boot）就直接收工
}

/**
 * 窄屏 CSS（0.3.9，装机反馈"顶栏按钮太小不好点"＋"任务栏和顶栏冲突"）。
 * 全部限定在 `html.zcode-narrow` 下（本模块的 matchMedia 旗子），宽屏一条都不生效。
 * 上游是桌面形态的密度：按钮 size-7（28px）、标题贴左上角。手机手指按不准 28px，
 * 而顶部浮层（☰/新建/返回）是 absolute 悬在标题栏同一行、窄屏就和标题挤在一起。
 * 这里只做三件事，不改上游任何 TSX 逻辑：
 *  1. 触控目标放大到 ≥44px（Apple HIG / Material 的最小可点尺寸），只碰"顶部浮层按钮 + 输入条
 *     工具钮 + 会话行本体"这三类；不碰 #sidebar 里所有 button —— 那会把页签药丸（h-6）撑变形。
 *  2. 窄屏把主列标题行整体下移一行浮层的高度（浮层 h-14），☰/返回/新建那一排不再压在标题上；
 *     同时撤掉上游为桌面窗控留的左偏移（pl-38）——垂直让位之后它只会白白吃掉 152px 标题宽度。
 *  3. 抽屉展开时 ☰ 会被遮罩盖住（标准移动抽屉形态）：点遮罩 = 收起，见下面的点击代理。
 */
const NARROW_CSS = `
/* 顶栏那一排浮层按钮（☰/返回/前进/新建）：装机逐版反馈"继续下移并调大"，每一版都在上一版
   基础上再抬一档（0.3.9 44px → 0.3.10 48px → 0.4.0 56px → 本版 68px；下移 0.5→1.25→2rem）。
   冲突的真相：0.3.8 起原生已给 WebView setPadding(状态栏高度)（M9 top=94 证明通道在），
   内容本来就画在状态栏以下；这里**不叠状态栏高度**（会双重下移），只做用户要的下移+调大。
   env(safe-area-inset-top) 在 Android WebView 恒 0（§1.5.19），--zcs-inset-top 又和原生
   padding 重复计数 —— 两个都不能用，固定 rem 偏移最稳。输入条那排不在状态栏下，保持 44px。 */
/* 顶栏浮层（☰/返回/新建）。0.4.9 重做（装机截图：开触屏后 ☰ 大得离谱、右侧小钮与它
   尺寸失衡，"任务 1"标题与浮层错位）：
   - **72px/2rem 是过头**——那是"旗子没挂、从没生效"时代按截图盲加的档（每版再抬一档
     都没人看见；0.4.8 开关一生效立刻全暴露）。统一收到 44px 目标（触控底线）+
     1.25rem 图标：上游桌面本来就是 16px 图标（size-4，桌面用户看着没问题），该放大的是
     按钮本体不是图标。
   - top 3rem→1rem：原生 setPadding 之后视口从状态栏以下开始，1rem 只是手指留空；
     上游浮层自带 h-14（56px）容器，44px 按钮居中。容器 class 含 "@container/topoverlayer"
     （Tailwind 容器查询名）——属性子串匹配照常有效，top 覆盖 .top-0/.top-1 靠特异度压制。
   - 前进钮（forward）上游没挂 testid，靠容器内 button 全覆盖。 */
html.zcode-narrow [class*="topoverlayer"] {
  top: 1rem;
}
/* 0.4.10 裁切修复：桌面探针（topbar-clip-probe.mjs）抓到 inline-flex overflow-hidden
   sw=44/cw=28 这个容器——上游把新建钮包进固定 w-7(28px)+overflow-hidden 的显隐动画包装
   （DesktopTopOverlay.tsx 的 isNewTaskButtonVisible div），按钮撑到 44px 后右半边被
   包装裁掉（装机截图"最右边的图标被裁一块"）。放行：包装宽度交还给内容，动画从 w-7
   变宽（触屏端新建钮本就常驻，动画价值为零）。 */
html.zcode-narrow [class*="topoverlayer"] [class*="overflow-hidden"] {
  width: auto;
  overflow: visible;
}
html.zcode-narrow [class*="topoverlayer"] button,
html.zcode-narrow [data-testid="web-sidebar-toggle"],
html.zcode-narrow [data-testid="desktop-top-nav-back"],
html.zcode-narrow [data-testid="conversation-new-task"],
html.zcode-narrow [data-testid="task-new-button"] {
  min-width: 44px;
  min-height: 44px;
}
html.zcode-narrow [class*="topoverlayer"] button svg {
  width: 1.25rem;
  height: 1.25rem;
}
/* 输入条那排：44px 触控目标（不在状态栏下，不下移）。 */
html.zcode-narrow [data-testid="v4-composer-send"],
html.zcode-narrow [data-testid="chat-attachment-button"],
html.zcode-narrow [data-testid="chat-mode-select-trigger"],
html.zcode-narrow [data-testid="chat-model-select-trigger"],
html.zcode-narrow [data-testid="chat-thought-level-select-trigger"],
html.zcode-narrow [data-testid="composer-workspace-trigger"] {
  min-width: 44px;
  min-height: 44px;
}
/* 会话行本体（时间线/分组/项目三种视图共用 data-task-item-key）：32px 的行高手指按不准。 */
html.zcode-narrow [data-task-item-key] {
  min-height: 44px;
}
/* 主列头部的图标钮（侧栏/终端/帮助/更多，上游全 size-4 + icon-md≈28px）。
   0.4.10：装机截图这排贴着屏幕右缘，44px×4 在窄屏放不进、最右被裁——收档 40px/1.25rem：
   仍远大于桌面 28px（触控够按），又给标题行让出宽度。浮层那排（☰/返回/新建）保持 44px
   （有专属 overflow 放行，且靠左不贴边）。
   0.4.11 A4：终端按钮隐藏——端侧没有 PTY（ITerminalService 未注册），点开只会得到
   一个报错面板。隐藏比"死按钮"诚实，也比注册一个空壳终端（create 就 throw）干净。 */
html.zcode-narrow [data-testid="terminal-toggle"] {
  display: none;
}
html.zcode-narrow [data-testid="side-pane-toggle"],
html.zcode-narrow [data-testid="workspace-more-button"],
html.zcode-narrow [data-testid="workspace-help-menu-trigger"] {
  min-width: 40px;
  min-height: 40px;
}
html.zcode-narrow [data-testid="side-pane-toggle"] svg,
html.zcode-narrow [data-testid="terminal-toggle"] svg,
html.zcode-narrow [data-testid="workspace-more-button"] svg,
html.zcode-narrow [data-testid="workspace-help-menu-trigger"] svg {
  width: 1.25rem;
  height: 1.25rem;
}
/* 标题行到浮层下面：顶部留白 = 浮层的 1rem + 一排 44px（2.75rem）+ 半行呼吸（0.75rem）= 4.5rem
   （正好接住浮层底沿：top 1rem + h 3.5rem）。标题与主列头部动作组（侧栏/终端/帮助/更多）
   在第二行同线——装机截图"错位"的真相是浮层（top:3rem）和头部动作（padding-top 120px）
   两行脱节 + 尺寸悬殊（72 vs 28），统一 44px/1.25rem 后这就是标准的移动双行头部。 */
html.zcode-narrow [data-testid="workspace-header"] {
  padding-top: 4.5rem;
  padding-left: 0.5rem;
  height: calc(4.5rem + 3rem);
}
/* 0.5.0：桌面窗控让位的左偏移在触屏上必须连**内层 div**一起钉死（用户点名"任务标题的
   左右移动和侧边栏的弹出收起匹配反了"＋"顶栏放大后部分区域遮挡错位"）。
   机制（WorkspaceHeader.tsx）：shouldOffsetHeaderForWindowControls = !isSidebarVisible，
   侧栏**收起**时给标题行加 pl-38（152px）——那是给桌面左上角窗控钮留的位。抽屉形态里
   这个判定整个是反的：关抽屉 → isSidebarVisible=false → 标题猛地右移 152px（用户看到
   "收起时标题往右弹"＝和开合方向拧着）；开抽屉 → 标题左移。右移还把标题可用宽度吃掉
   152px，放大后的头部动作组（右缘）就撞上了标题——"遮挡错位"也是这同一条。
   端上没有窗控钮可让位：把内层（带 p-2 + pl-38 的那个 flex div，h-12 是它的独有类）
   钉成恒定 0.5rem，标题从此不随侧栏开合位移。特异度 0-2-1 > Tailwind 的 pl-38（0-1-0），
   顺序无关地压制。 */
html.zcode-narrow [data-testid="workspace-header"] > div.h-12 {
  padding-left: 0.5rem;
}
/* 整页视图的正文让出浮层行（0.6.0，装机截图"插件市场标题被浮层压住"）：插件市场/自动化
   这类整页 main 没有 workspace-header 那层 4.5rem 位移，标题直接从视口顶部开始，
   ☰/返回/新建 浮层（top 1rem + 44px）正好压在标题上。用 :has() 钉住"正文列里有这页
   标题"的容器，整列一起下移——标题、副标题、动作行同进退。 */
html.zcode-narrow main div.mx-auto:has(> [data-testid="plugin-store-title"]) {
  padding-top: 4.5rem;
}
`;

let cssInjected = false;
function ensureNarrowCss(): void {
  if (cssInjected || !doc()) return;
  const style = doc()!.createElement("style");
  style.id = "zcode-narrow-css";
  style.textContent = NARROW_CSS;
  doc()!.head?.appendChild(style);
  cssInjected = true;
}

// 顶栏证人链（0.4.7，装机反馈"顶栏按钮调大下移没效果"）。
// 桌面 playwright 实测（topbar-measure.mjs）证明规则命中、rect 72x72@y=40 —— 同一份
// 数字到装机后"没效果"，中间那层是黑的。侧栏三版的教训（每次靠猜根因）不再犯：
// 这里把**页面里量到的真值**持续写进 localStorage（与自检页同源），装机的自检报告
// M11 直接回答三件事：CSS 旗子挂没挂（zcode-narrow）、按钮实际多大（rect）、
// 浮层实际多高（overlay top）+ 原生 insets 读数（哪条带被垫了）。
// 读数为空 = shell 从没 boot 过（旧缓存/启动崩了）；读数小而装机仍说小 = 设备缩放。
const TOPBAR_DIAG_KEY = "zcode-mobile.topbar.diag";
function recordTopbarDiag(): void {
  const d = doc();
  if (!d) return;
  const toggle = d.querySelector<HTMLElement>(SIDEBAR_TOGGLE_SELECTOR);
  const overlay = d.querySelector<HTMLElement>('[class*="topoverlayer"]');
  if (!toggle || !overlay) return;
  try {
    globalThis.localStorage?.setItem(
      TOPBAR_DIAG_KEY,
      JSON.stringify({
        at: Date.now(),
        narrow: isNarrow(),
        // 浮层的 top 与 toggle 的 rect 都是 CSS px（装机判"有没有下移/调大"就靠这两个）。
        overlayTopPx: Math.round(parseFloat(getComputedStyle(overlay).top) || 0),
        toggleRect: (() => {
          const r = toggle.getBoundingClientRect();
          return `${Math.round(r.width)}x${Math.round(r.height)}@y=${Math.round(r.top)}`;
        })(),
        toggleSvgPx: (() => {
          const s = toggle.querySelector("svg");
          return s ? Math.round(s.getBoundingClientRect().width) : null;
        })(),
        dpr: globalThis.devicePixelRatio || 1,
        // 原生垫边读数（设备像素）：装机"底部黑条/贴手势线"类反馈靠它判通道值。
        insets:
          (globalThis as { __zcodeInsetsDebug?: { current(): Record<string, number> } })
            .__zcodeInsetsDebug?.current?.() ?? null,
      }),
    );
  } catch {
    // 证人不值当抛穿启动：写不进 localStorage 的宿主（隐私模式）本来就装不了机。
  }
}

export function installNarrowSidebarDrawer(): void {
  if (installed) return;
  const d = doc();
  if (!d) return;
  installed = true;
  ensureNarrowCss();

  armNarrowFlag();
  attachObservers();
  // 上游按钮可能随 React 重挂载换 DOM 节点，所以事件挂在 document 上而不是按钮上。
  // 必须是**捕获阶段**（capture:true）：React 的合成事件挂在 #root 容器上，任务行的 onSelectTask
  // 会 stopPropagation()，把原生事件挡在 #root 之下 —— 挂在冒泡阶段的这个监听器压根收不到那一声，
  // 0.3.8 e2e 里"点任务行抽屉没收起"就是踩在这条上。捕获阶段在事件到达 #root 之前就触发，
  // 谁也拦不住这里。不 preventDefault：选择会话仍由 React 正常处理，这里只补一次"选完收起"。
  d.addEventListener(
    "click",
    (event) => {
      // 0.4.9：点行收起/点遮罩收起都是**抽屉态**的行为——横屏并排时侧栏常驻，
      // 点任务行选会话不该把侧栏收走（那是桌面行为）。
      if (!isDrawerMode()) return;
      const target = event.target as Element | null;
      if (!target || typeof target.closest !== "function") return;
      const toggle = d.querySelector<HTMLElement>(SIDEBAR_TOGGLE_SELECTOR);
      // 点遮罩 = 收起：代点那个切换按钮，让 React 保持唯一状态源。
      if (scrim && (target === scrim || scrim.contains(target))) {
        toggle?.click();
        return;
      }
      // 抽屉里选完任务/项目就收起：只在命中行且抽屉**开着**时补一次代点，不改事件本身。
      // 判"开着"用 reactSaysVisible()（React 的可见意图），不用 inert 属性 —— open 态是我们主动
      // removeAttribute("inert")，getAttribute 恰好回 null，拿它当"开着"会把这条判反。
      if (!target.closest(DRAWER_DISMISS_SELECTOR)) return;
      // 0.4.10（装机"竖屏点归档，侧边栏就缩回去，没法归档"）：任务行右侧的归档/置顶/文件树
      // 都是嵌在 [data-task-item-key] 行内的 <button>（TaskListItem.tsx:432/446/499），
      // 点它们本该就地操作，却被"点行=选会话"的收起逻辑连坐。判据：命中**行内按钮**就不收起
      // （让按钮的 React onClick 正常跑）；点行的非按钮区（标题文字）才收起。项目 tab 不受影响。
      if (target.closest("[data-task-item-key] button, [data-task-item-key] [role='button']")) return;
      if (!reactSaysVisible()) return;
      toggle?.click();
    },
    { capture: true },
  );
  globalThis.addEventListener?.("resize", () => {
    sync();
    // 顶栏证人补记（0.4.7）：旋转/分屏后 rect 会变，装机的判据要读得到最后一帧。
    recordTopbarDiag();
  });
  globalThis.addEventListener?.("orientationchange", () => {
    // 旋转后 innerWidth 要下一帧才稳定，与上游那条 resize idle 的动机同一条。
    globalThis.setTimeout?.(sync, 120);
  });

  // 边缘滑动开合抽屉（0.4.4 初版只做"开"；0.4.7 补双向；0.4.9 修"收起后划不出"）。
  // 判态用**抽屉的实际几何**（panel 的 rect），不再读 React 意图（reactSaysVisible）：
  // 装机"收起了就没法呼出"的机制——React 的 shell 变量与用户看到的像素任何一次脱节
  // （订阅晚一拍、过渡中间帧、状态复位），touchstart 就会把开/关判反：说"还开着"就把
  // 右滑登记成"收"候选，而收需要划满向左 60px——用户向左划了也不开、向右划更不开，
  // 抽屉关死了却再也划不出来。像素不会说谎：rect.right>1 才算开着。
  // 两条克制保留：开=起点在左缘带内且水平向右显著支配纵向；收=向左同样支配。
  // 兜底（同一次问题的另一半）：抽屉开着时上游 ☰ 被遮罩盖住（z 30>20），短横划（够不上
  // 阈值但方向明确的水平滑动）在 touchend 按一次"切换"——没有它，用户划不开遮罩里的按钮
  // 又够不上手势阈值时，就真的只剩"点遮罩收起"一条路了。
  let swipe: { x: number; y: number } | null = null;
  const drawerVisible = (): boolean => {
    const panel = sidebar();
    if (!panel) return false;
    // 读 sync **同步写入的目标值**（inline transform），不是 getBoundingClientRect 的动画瞬时值：
    // 开合有 200ms transform 过渡，动画途中读 rect 会把"正在打开"误判成"关着"，再点一次
    // ☰ 就是"开了又关"的抖动。style.transform 在 sync 那一拍就落定（0 或 -102%），不受动画摆布。
    const tf = panel.style.transform || "";
    if (tf === "") return false; // 没被投影成抽屉（不该在窄屏出现，保守当关）
    return !/translateX\(\s*-/.test(tf); // 含负位移 = 移出左缘 = 关；translateX(0) = 开
  };
  d.addEventListener(
    "touchstart",
    (event) => {
      const t = event.touches?.[0];
      if (!isDrawerMode() || !t) {
        swipe = null;
        return;
      }
      // 开着 → 登记滑动（起点不限：scrim 罩屏，横滑哪都算划走）。
      // 关着 → 只有左缘带内的起点才算"呼出"候选。
      swipe =
        drawerVisible() || t.clientX <= EDGE_BAND_PX ? { x: t.clientX, y: t.clientY } : null;
    },
    { passive: true },
  );
  d.addEventListener(
    "touchmove",
    (event) => {
      if (!swipe) return;
      const t = event.touches?.[0];
      if (!t) return;
      const dx = t.clientX - swipe.x;
      const dy = t.clientY - swipe.y;
      if (Math.abs(dx) <= Math.abs(dy) * 1.5) return; // 纵向主导：不是边缘手势
      const opened = drawerVisible();
      const fired = opened ? dx <= -SWIPE_OPEN_THRESHOLD_PX : dx >= SWIPE_OPEN_THRESHOLD_PX;
      if (fired) {
        // 判定成立即清空，避免同一次滑动重复触发（touchend 前还会连续回调 touchmove）。
        swipe = null;
        doc()?.querySelector<HTMLElement>(SIDEBAR_TOGGLE_SELECTOR)?.click();
      }
    },
    { passive: true },
  );
  d.addEventListener(
    "touchend",
    (event) => {
      if (!swipe) return;
      const t = event.changedTouches?.[0];
      const dx = t ? t.clientX - swipe.x : 0;
      const dy = t ? t.clientY - swipe.y : 0;
      swipe = null;
      // 短横划兜底：够不上阈值（24px~阈值之间）但方向明确、基本纯水平的滑动，
      // 视为"想开/想收"的一次拨动。纵向分量 ≤20px 排除列表滚动收尾的斜划。
      const horizontalFlick = Math.abs(dx) >= 24 && Math.abs(dx) > Math.abs(dy) * 1.5 && Math.abs(dy) <= 20;
      if (!horizontalFlick) return;
      const opened = drawerVisible();
      const wants = opened ? dx < 0 : dx > 0;
      if (wants) doc()?.querySelector<HTMLElement>(SIDEBAR_TOGGLE_SELECTOR)?.click();
    },
    { passive: true },
  );
  d.addEventListener("touchcancel", () => {
    swipe = null;
  }, { passive: true });
  sync();
}
