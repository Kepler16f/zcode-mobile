// Tailwind v4 把 `dark:` 工具类编译进 `@media (prefers-color-scheme: dark)`（上游没写
// `@custom-variant dark` 重绑，实测编译产物里只有两个这种块），而端侧的主题是靠 <html> 上的
// `.dark` class 切的（entry.tsx 的 applyTheme / 上游 useTheme 全是 class 路线）。两者对不上：
// 手机系统处于浅色时，即便 app 选深色，`dark:` 类也不生效 → 屏幕半深半浅；系统深色时又切不回浅色。
// 桌面截图"看着是暗的"只是因为测试机 OS 恰好是深色，掩盖了它。
//
// 打包阶段把绑死 prefers-color-scheme 的 dark 块重绑到 `.dark` class：遍历每个
// `@media (prefers-color-scheme:dark)`，把其中每条规则的选择器加 `.dark` 前缀，然后剥掉 media 外壳。
// 嵌套的 @supports / @media(hover) 容器原样保留。CSS 变量层的主题（.dark{…}/.theme-zai-dark{…}）
// 本来就按 class 走，这里不动。postcss 由调用方注入（它住在 zcode 的 node_modules 里，
// 与 bundle-ui 拿 esbuild 同一路数——mobile-runtime 没有自己的依赖目录）。
// postcss 由调用方注入；缺省从 zcode 的 node_modules 解析（mobile-runtime 没有自己的依赖目录，
// 与 bundle-ui 拿 esbuild 同一路数）。
const DARK_MEDIA = /^\(\s*prefers-color-scheme:\s*dark\s*\)$/i;

export async function rebindDarkToClass(css, options = {}) {
  const { onDiagnostic = () => {}, postcss = null } = options;
  const pc =
    postcss ??
    (await import("node:module")).createRequire(
      new URL("../../zcode/package.json", import.meta.url),
    )("postcss");
  const root = pc.parse(css);
  let blocks = 0;
  let rules = 0;
  // 收集要拆壳的顶层/嵌套 media(dark) at-rule，再统一拆（each 中直接 replaceWith 会踩迭代器）。
  // 只认纯 dark 查询；复合（dark and hover 之类）保守跳过并如实报——给它整体加 .dark 前缀会把
  // hover 条件也改掉，那种改动值不回票价。实测本产物里都是纯 dark。
  const doomed = [];
  root.walkAtRules("media", (atRule) => {
    const params = atRule.params.trim();
    if (!DARK_MEDIA.test(params)) return;
    if (/\band\b/i.test(params)) {
      onDiagnostic(`跳过复合 dark 查询：${params}（如真有此类规则，需要单独处理）`);
      return;
    }
    doomed.push(atRule);
  });
  for (const atRule of doomed) {
    blocks += 1;
    const targets = [];
    atRule.walk((inner) => {
      if (inner.type === "rule") targets.push(inner);
    });
    for (const rule of targets) {
      rule.selectors = rule.selectors.map((sel) =>
        // :root/:host 是文档根，.dark 前缀（.dark :root）永远匹配不上，等于把规则删了；
        // 这种选择器原样保留。实测本产物里没有，留着是防上游哪天加。
        /^\s*:root(?![\w-])/.test(sel) || /^\s*:host(?![\w-])/.test(sel) ? sel : `.dark ${sel}`,
      );
      rules += 1;
    }
    if (atRule.nodes && atRule.nodes.length) atRule.replaceWith(atRule.nodes);
    else atRule.remove();
  }
  onDiagnostic(`dark 重绑：${blocks} 个 media(dark) 块 → .dark class（改了 ${rules} 条规则）`);
  return root.toString();
}
