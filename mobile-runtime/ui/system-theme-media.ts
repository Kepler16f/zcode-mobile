// 真机上系统深浅色的垫片：把 `matchMedia("(prefers-color-scheme: dark)")` 的读数
// 重定向到原生桥的真值（UI_MODE_NIGHT），而不是 WebView 的 media query。
//
// 为什么必须有这一层：设置页选"跟随系统"后，生效路径是上游 store 的
// setTheme → useTheme.applyTheme("system") → resolveTheme → getSystemTheme()，
// 而 getSystemTheme 读的就是这个 media query。外壳为了防 ColorOS 的二次反色把
// algorithmic darkening 关了，代价是 WebView 的 prefers-color-scheme 不再跟系统夜间模式走
// ——真机反馈"深色模式跟随系统开启后无效"（0.3.5，OPD2511）就是它。与其指望浏览器实现，
// 不如把唯一可信的来源（Resources.configuration.uiMode）经 zcodeUi.systemDark() 喂进来。
//
// 只接管这一条 query，其余（hover、reduced-motion…）原样透传给真 matchMedia。
// 桥不在（桌面浏览器跑验证）时整个垫片不装，media query 照常可信。
//
// 装载时机：必须是 entry.tsx 第一批 import 之一、且排在 `@zcode/ui` 之前（ESM 保证入口的
// import 按书写顺序先于后续子树求值）——上游 store 在模块初始化时就调 applyTheme，
// 晚装就等于它第一帧仍然读那个不可信的 media query（会闪一下浅再回深）。
// 与 process.mjs 同一个"import 即生效"的形状。

const DARK_QUERY = /(?:^|[\s,(])\(\s*prefers-color-scheme\s*:\s*dark\s*\)/i;

interface FakeMediaList {
  media: string;
  matches: boolean;
  addEventListener(type: string, cb: (ev: unknown) => void): void;
  removeEventListener(type: string, cb: (ev: unknown) => void): void;
  addListener(cb: (ev: { matches: boolean }) => void): void;
  removeListener(cb: (ev: { matches: boolean }) => void): void;
}

export function installSystemThemeMediaShim(): void {
  const g = globalThis as {
    zcodeUi?: { systemDark?(): boolean };
    matchMedia?: (query: string) => MediaQueryList;
    addEventListener?: typeof globalThis.addEventListener;
  };
  if (!g.zcodeUi || typeof g.zcodeUi.systemDark !== "function" || typeof g.matchMedia !== "function") return;

  const nativeDark = () => {
    try {
      return Boolean(g.zcodeUi?.systemDark?.());
    } catch {
      // 桥偶发抛（页面回收）时按上一次的读数继续用，不让它打死主题判断。
      return lastKnown;
    }
  };

  let lastKnown = nativeDark();
  const listeners = new Set<(ev: unknown) => void>();
  const fake: FakeMediaList = {
    media: "(prefers-color-scheme: dark)",
    get matches() {
      return lastKnown;
    },
    addEventListener: (_type: string, cb: (ev: unknown) => void) => {
      listeners.add(cb);
    },
    removeEventListener: (_type: string, cb: (ev: unknown) => void) => {
      listeners.delete(cb);
    },
    addListener: (cb: (ev: { matches: boolean }) => void) => {
      listeners.add(cb as (ev: unknown) => void);
    },
    removeListener: (cb: (ev: { matches: boolean }) => void) => {
      listeners.delete(cb as (ev: unknown) => void);
    },
  };
  // 夜间切换多数场景重建 Activity（重装本垫片 + 首帧脚本自然跟上），少数不重建的 ROM
  // 靠前后台切换时重读并通知订阅者——media query 自己永远不会变，事件只能从这里发。
  g.addEventListener?.("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const next = nativeDark();
    if (next === lastKnown) return;
    lastKnown = next;
    for (const cb of listeners) cb({ matches: next, media: fake.media });
  });

  const original = g.matchMedia.bind(g);
  g.matchMedia = (query: string): MediaQueryList => (DARK_QUERY.test(query) ? (fake as unknown as MediaQueryList) : original(query));
}

// import 即生效（见头注的装载时机）。export 留着给自检单独调用/判据。
installSystemThemeMediaShim();
export {};
