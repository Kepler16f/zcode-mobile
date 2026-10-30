---
doc_id: azcode-development-roadmap-2026-10-30
type: roadmap
status: draft-pending-owner-decision
date: 2026-10-30
revision: 1
tree: D:\Zcode @ de979a9
basis: docs/flutter-refactor-assessment.md（评估结论：不建议全面 Flutter 重构）
scope: aZCode 手机端交付质量与端侧成本
related:
  - docs/flutter-refactor-assessment.md
  - AGENTS.md
  - PORTING-ANDROID-HARMONY.md
  - mobile-runtime/specs/*.md
---

# aZCode 手机端开发路线图（agent 可执行版）

> **⚖️ 状态变更（2026-10-30）**：业主已拍板启动 **Flutter 全面重构**，执行计划见 `docs/flutter-rewrite-plan.md`。本路线图 A/B/C 工作流**降级为过渡期质量加固项**——Flutter UI 完成前，现有 WebView 应用仍是交付线，A/B/C 继续有效并照常认领；Workstream D 决策门已按业主授权开启（跳过 D-02 原型，直接全面重构）。评估事实 F-01…F-15 对新架构仍然有效。

> **这份路线图是评估结论的落地部分。** 评估（`docs/flutter-refactor-assessment.md`）的结论是"不建议全面 Flutter 重构"，所以本路线图的主线是**不换语言、把现有架构做扎实**；Flutter 作为一个**条件触发的决策门**挂在 Workstream D 上，不在主线上。
>
> **使用方式**：每个 item 有唯一 ID、明确改动点（`file:line`）、**可执行的验收判据**、风险与预估。认领一个 item 时：
> 1. 先读 `docs/flutter-refactor-assessment.md` §1（F-01…F-05）与本 item 引用的 F-xx；
> 2. 按"改动点"定位；**改动前用 `git log -1` 确认工作树状态**（本树在评估期间被并发推进过）；
> 3. 跑"验收判据"里的命令，**把输出贴在交付说明里**；
> 4. 涉及写文件一律用 Write/Edit 工具（`AGENTS.md` / 记忆里的规矩：保持可审查 diff）。

---

## 0. 状态词汇与规模

| 词汇 | 含义 |
|---|---|
| `未开始` | 无人认领 |
| `进行中` | 已认领，有 owner |
| `已完成` | 验收判据全部通过且已合入 |
| `已阻塞` | 有明确外部依赖（写在这里） |
| `已否决` | 评估后不做，**保留记录以免重复讨论** |

规模单位为**人日**（1 人日 = 8 小时）。所有估算含自测，不含真机回归排期。

---

## 1. 目标与非目标

### 目标

1. **交付物正确**：装到手机上的包，跑的就是这次改的代码；数学公式、图标、预览不缺失。
2. **包体可控**：把可回收的体积收掉，并让体积**不再无声漂移**。
3. **端侧主线程不再被桥往返吃掉**：SAF/真盘的文件操作不再一次冻结几百毫秒。
4. **验收体系显式**：桥契约、规格与验证手段三者可互相追溯。

### 非目标（本期明确不做）

- ❌ **不做 Flutter 化**（含"先做个原型看看"）——除非触发 Workstream D 的决策门
- ❌ **不重写 Agent 运行时**——协议层事故（36%）换语言一条不消失，见评估 F-06
- ❌ **不删 `mobile-runtime/compat/shims/`**——那是上游共享代码的 Node API 形状，删了要改上游
- ❌ **不改 `packages/ui` 的 React 组件**——桌面/Web/手机三端共享，动一处影响三端
- ❌ **不砍掉手机端的核心能力**（Git 面板、文件树、审批、OAuth）——本路线图只动**构建期**和**桥的传输方式**，不动产品面

---

## 2. 里程碑总览

```
M0 ──基线冻结──► M1 ──交付正确性──► M2 ──包体与守门──► M3 ──桥层成本──► M4 ──契约固化──► (M5 条件门)
 │                 │                  │                  │                  │
 A-01/A-02         A-01               A-03/A-04           B-01               C-01
 (wasm/字体核实)   (wasm 双份消除)    (语言集/预览)       (真异步)          (桥契约 YAML)
                                                            B-02/B-03         C-02/C-03
```

| 里程碑 | 出口判据 |
|---|---|
| **M0 基线冻结** | 记录当前 `dist-ui` 体积/文件数/APK 体积/语言模块数，作为所有后续 item 的对比基准 |
| **M1 交付正确性** | 无 base64 内联大 wasm；CSS 引用的字体 100% 命中；这两条进 CI |
| **M2 包体与守门** | 语言集/预览裁剪决策落地；包体有上限断言，超了构建失败 |
| **M3 桥层成本** | 桥不再靠轮询；私有盘 3000 文件 grep < 200 ms |
| **M4 契约固化** | 12 个桥的契约有单一真相源；改签名不改契约 → CI 失败 |
| **M5 条件门** | 仅当 Workstream D 触发条件成立才开启 |

**依赖规则**：A-05（守门）必须**最后**做——它要断言前面各项的结果，否则会误报。
**并行规则**：A 系列（构建期）与 B 系列（桥传输）互不依赖，可并行。C 系列依赖 A/B 的终态。

---

## 3. Workstream A — 交付体积与正确性

### A-01 核实并消除 base64 内联的大 WASM `未开始` · 1.5 人日

- **目标**：`dist-ui/wasm-H3KT2BUB.js`（622,378 B）里用 `Uint8Array.from(atob(...))` 内联了一个 WASM 二进制，而 `dist-ui/sql-wasm.wasm`（659,806 B）同时存在。**先确认二者是否同一二进制**；若是，消除内联的那份。
- **依据**：评估 F-14、U-09
- **前置**：无
- **改动点**：
  - 定位来源：先在 `mobile-runtime/build/dist-ui` 里找出哪个模块 import 了这段 base64（`grep -rl 'Uint8Array.from(atob' dist-ui/*.js`），再回溯到 `zcode/packages/ui` 或 `zcode/packages/services` 的具体 import 点
  - 消除内联：`mobile-runtime/build/bundle-ui.mjs` 的 `loader` 表（`:143-148`）已有 `".wasm": "file"`；说明内联的 wasm **不是以 `.wasm` 扩展名被 import 的**，而是以 `.js` 形式携带 base64 —— 要么改来源，要么在构建期把这段 base64 提取成独立 `.wasm` 文件并改写引用
  - 若来源在 `zcode/`（上游仓），改动会跨上游边界 → **先只在本仓加构建期处理，不改上游源码**，并在交付说明里记录上游问题
- **验收判据**：
  ```bash
  # ① 产物里不再有 >100 KB 的 base64 内联 wasm
  cd mobile-runtime/build/dist-ui
  grep -l 'Uint8Array.from(atob' *.js | xargs -r stat -c '%s %n' | awk '$1>102400'   # 期望：无输出
  # ② 若①判定二者同源，dist-ui 体积应下降约 620 KB
  find . -type f -printf '%s\n' | awk '{s+=$1}END{print s}'    # 期望 ≤ 基线 - 600000
  # ③ 真机：打开一个需要 sql.js 的功能（自检页 §3.4 关卡）跑通
  ```
  - 基线数字见 A-05 落库的值
- **风险**：低—中。若 base64 来源是上游且改动会外溢，退化为"只记录不修"，收益归零但无损失。
- **交付说明必须写**：二者是否同源（二进制比对结果）、处置方式、产物体积变化。

### A-02 清掉多拷的 KaTeX 字体 `未开始` · 0.5 人日

- **目标**：`dist-ui/assets/` 有 59 个 KaTeX 字体，但 CSS 只引用 51 个，多出的 8 个共 **130.7 KiB** 白占包体。
- **依据**：评估 F-13（KaTeX 打包本身**是正确的**，命中 51/51；这条只处理多余的 8 个）
- **前置**：无
- **改动点**：`mobile-runtime/build/bundle-ui.mjs:218` 的 `relocateCssAssets` 调用（实现见 `mobile-runtime/build/mobile-ui-assets.mjs:169`，参数 `sourceRoot`/`outdir`）——让它**只搬 CSS 实际 `url()` 引用的文件**，而不是搬上游整份字体集
- **验收判据**：
  ```bash
  cd mobile-runtime/build/dist-ui
  grep -oE 'KaTeX_[A-Za-z0-9-]+\.(woff2|woff|ttf)' zcode-ui.css | tr -d '\r' | LC_ALL=C sort -u > /tmp/need.txt
  ls assets/ | grep '^KaTeX_' | tr -d '\r' | LC_ALL=C sort -u > /tmp/have.txt
  echo "缺失(必须为0): $(comm -23 /tmp/need.txt /tmp/have.txt | wc -l)"
  echo "多余(目标0):   $(comm -13 /tmp/need.txt /tmp/have.txt | wc -l)"
  ```
  - ⚠️ **`comm` 必须 `LC_ALL=C sort` + 去 `\r`**，否则会得到"同一文件同时在两侧"的荒谬结果（评估 §9 第 6 条）
- **风险**：低。但**必须与 A-05 的字体覆盖断言一起做**，否则容易在裁剪时误删被引用的字体

### A-03 手机端语言集裁剪 `未开始` · 决策 0.5 人日 ＋ 实现 1.5 人日

- **目标**：当前打进包的是 **244 个 shiki 语言语法模块 / 5.33 MiB**。手机端是否需要全部 244 种语言是**产品决策**；若只需常用集，收益直接。
- **依据**：评估 F-13、U-11
- **前置**：**产品先定白名单**（见下）
- **决策输入**（需要产品/业主回答）：
  1. 手机端是否需要全部 244 种语言？还是要一份常用集（建议：代码高亮常见的 30–50 种）？
  2. 非白名单语言在手机端**怎么降级**——显示"该语言高亮不支持"？还是静默不高亮？
  3. 桌面/Web 端**不受影响**（白名单只作用于移动端 bundle）
- **改动点**：`mobile-runtime/build/mobile-ui-assets.mjs:64-66` 的 `mobileShikiDependency` 插件——加 `onResolve` 过滤，把非白名单语言解析到一个**空 stub**（导出空语言数组），使 shiki 的动态 import 返回空数组而不是模块找不到
  - ⚠️ 实施前必须先读清该插件现有实现与 shiki 的 `bundledLanguages` 映射形状，**stub 的导出形状必须与真模块一致**，否则运行时会炸在"高亮器初始化"而不是"该语言不支持"
- **验收判据**：
  ```bash
  # ① bundle 内语言模块数 == 白名单数
  cd mobile-runtime/build/dist-ui
  find . -type f -name '*.js' -printf '%f\n' | sed -E 's/-[A-Za-z0-9_]{8}\.js$//' | LC_ALL=C sort -u \
    | comm -12 - <(printf '%s\n' $(cat mobile-runtime/…/lang-whitelist.txt) | LC_ALL=C sort -u) | wc -l
  # ② 真机抽查白名单内 5 种语言（ts / py / rs / go / sql）高亮正确
  # ③ 真机用白名单外语言（如 wolfram）→ 明确降级提示，不崩溃、不空白无提示
  ```
- **风险**：中。若 stub 形状不对会引发运行期崩溃——**必须先做最小验证再全量**
- **回滚**：白名单文件留空即可退回全量

### A-04 手机端 Office / PDF 预览按需 `未开始` · 决策 0.5 人日 ＋ 实现 1 人日

- **目标**：`previewPaneOfficeXlsxContent`(2.05 MB) + `pptxRendererPreviewEngine`(1.01 MB) + `previewPaneOfficeLegacyDocContent`(0.90 MB) + `pdf-viewer`(0.46 MB) 合计约 **4.42 MiB**。手机端是否需要完整的 Office 预览是产品决策。
- **依据**：评估 F-13、U-12
- **决策输入**：① 手机端是否需要 xlsx/pptx/docx 预览？② 若需要，是否需要全部渲染能力（公式/图表/排版）还是只要"能打开看个大概"？③ PDF 预览在手机端是否必需？
- **改动点**：`mobile-runtime/build/bundle-ui.mjs` —— 这些是**动态 import**（按需加载），要在移动端入口侧**显式禁用**并给出降级提示，而不是删包（删包会让动态 import 变成 404）
- **验收判据**：
  - ① 真机打开 xlsx/pptx/docx 附件 → 明确提示"手机端暂不支持预览"，且**不出现 JS 报错**
  - ② `dist-ui` 体积下降 ≥ 3 MiB（若决定全裁）
- **风险**：中。动态 import 被禁用后必须处理失败态，否则会退化成静默失败——这正是 0.8.0「未知 action：未收到」那类问题的同构形态
- **依赖**：需要先确认 `packages/ui` 的预览面板在 `supportsEmbeddedBrowser={false}` 之外的降级路径是否已存在

### A-05 构建期体积与内容守门 `未开始` · 1.5 人日

- **目标**：让"包体悄悄涨了 8 MiB"和"字体漏了"这两类事故**在构建期就失败**，不再靠人肉比对。本 item 是本路线图**防回潮**的核心。
- **依据**：评估 §6.2 / §6.3（本次评估两次踩到"产物漂移"）
- **前置**：A-01、A-02 完成（否则断言基准不对）
- **改动点**：`mobile-runtime/build/bundle-ui.mjs`（已有断言风格见 `:165-166` 的 languageInputs 检查、`:170 assertShikiConsistency`；**沿用同样的写法与报错风格**）
- **要加的断言**：
  1. **重复模块检测**：按**内容哈希**（不是文件名）找出同名模块的多份拷贝，数量 > 0 即失败并列出
  2. **字体覆盖检测**：CSS 里所有 `url()` 引用 → `dist-ui/assets/` 必须 100% 命中，缺失即失败
  3. **base64 内联二进制检测**：产物里不得有 > 100 KB 的 `atob(` 内联
  4. **体积上限**：`dist-ui` 总字节 ≤ 阈值（阈值取 A-03/A-04 落地后的实测值 + 5% 余量）
  5. **语言模块数**：命中白名单的必须全在，超出白名单的即失败
- **验收判据**：
  ```bash
  # ① 故意制造一个重复文件 → 构建必须失败
  cp mobile-runtime/build/dist-ui/entry.js /tmp/dup.js && cp /tmp/dup.js mobile-runtime/build/dist-ui/entry-DUPAAAA.js
  node mobile-runtime/build/bundle-ui.mjs     # 期望：非 0 退出 + 明确报错
  # ② 正常构建必须通过
  node mobile-runtime/build/build-mobile.mjs  # 期望：0 退出
  ```
  - 另需加一个 smoke：`mobile-runtime/build/bundle-guard-smoke.mjs`，钉住"断言在坏输入下确实失败"
- **风险**：低。但阈值一旦定死，**任何合法的包体增长都会卡住构建**——阈值要给余量，且报错信息要写清"超了多少、哪部分涨了"
- **交付说明必须写**：每个阈值、当前值、余量

---

## 4. Workstream B — 桥层成本与主线程

### B-01 把自造异步协议换成真异步 `未开始` · 4 人日

- **目标**：`AsyncBridgeJobs.kt`(72 行) 实现了 `start → poll*(50ms) → result` 的自造任务表，JS 侧 `mobile-runtime/ports/native-async.mjs`(51 行) 用 50ms 轮询消费。目标：一次调用 + 回调，去掉轮询。
- **依据**：评估 F-09（Flutter 化的**唯一真实正收益**就是"同步桥改异步"——在现有架构里也能拿到，不用换语言）
- **前置**：无（与 A 系列并行）
- **受影响桥（4 个）**：`zcodeExec` / `zcodeGitHttp` / `zcodeModelHttp` / `zcodeBrowser`
- **改动点**：
  - `android-app/app/src/main/kotlin/cn/zcode/mobile/AsyncBridgeJobs.kt` —— 改为"注册回调 id → 完成时回调 JS"
  - `MainActivity.kt:239-270` 的注册表 —— 这 4 个桥的 `start/poll/cancel` 换成带回调的形状
  - `mobile-runtime/ports/native-async.mjs` —— 轮询客户端换成 Promise
  - `mobile-runtime/ports/execution-bridge-android.mjs`（`native-async.mjs:34-36` 有旧同步接口的回退路径）—— 一并改
- **硬约束**：`@JavascriptInterface` 是**同步返回**的，异步必须走"传 callback id + Kotlin 侧持有回调引用"的形状。这条路已经被 `browser-use` 桥验证过（`BrowserBridge.kt` 的 `CountDownLatch` + `evaluateJavascript`），**先读它**再动手
- **验收判据**：
  ```bash
  # ① JS 侧不再有轮询
  grep -rn 'poll(' mobile-runtime/ports/native-async.mjs mobile-runtime/ui/*.ts | wc -l   # 期望：0
  # ② 新增 smoke 钉住：bridge promise 形状 + 取消后不再回调
  node mobile-runtime/build/bridge-async-smoke.mjs     # 期望：0 退出
  # ③ 真机：执行一条 Bash、看模型流是否正常、取消一个长任务后确认不再有回调打进来
  ```
- **风险**：中—高。取消语义、异常传播、超时三条路径都要重测。**旧同步接口必须保留一个版本的兼容期**，否则旧 JS 缓存会打出"未知方法"
- **回滚**：`native-async.mjs` 保留旧路径开关

### B-02 把文件遍历下推到 native `未开始` · 3 人日

- **目标**：私有盘（`/work`）上的 grep/find 不再由 JS 逐文件 stat + 逐个读，改由 native 一次性执行（toybox 的 `grep`/`find`/`sed`/`xargs`）。
- **依据**：评估 F-15（实测 3000 文件 grep：内存盘 56.1 ms vs 真盘 **1231.8 ms** = 22×；单价 0.41 ms/文件读）
- **前置**：B-01（先有异步通道，下推才好做）
- **改动点**：
  - `mobile-runtime/ports/file-system.mjs` 的 `searchText`（当前逐文件读 + 匹配）
  - `mobile-runtime/compat/vfs-native.mjs` 的真盘后端
  - `android-app/app/src/main/kotlin/cn/zcode/mobile/ExecBridge.kt`（已有 `/system/bin/sh` + toybox 通道，复用它）
- **⚠️ 边界必须分清**：**SAF 树（`/mnt/<名>`）没有 native grep**——`DocumentFile` 只能逐个访问，那边的成本**换语言也降不了**（评估 F-15）。因此：
  - 私有盘：目标 **3000 文件 grep < 200 ms**
  - SAF 树：只承诺"不更差"，并单独记录实测值
- **验收判据**：
  ```bash
  # ① 私有盘 3000 文件 grep 耗时
  #    （用现有 bench/probe 或新增一条 smoke，须在同一台设备同一数据集上与基线 1231.8ms 对比）
  node mobile-runtime/build/file-bench.mjs --workspace=/work --files=3000 --op=grep
  # 期望：< 200 ms
  # ② 结果与旧实现逐字节一致（抽样 20 个文件）
  ```
- **风险**：中。要处理"文件在遍历过程中被改"、二进制文件、超大文件、权限拒绝等边界

### B-03 重调 `readMany` 分块参数 `未开始` · 1 人日

- **目标**：`ports/file-system.mjs` 的分块大小（SAF 树 64 / 私有盘 256）是按"一次同步桥调用 = 8–10 秒主线程死区"量出来的。B-01 之后同步死区消失，块大小应重新调优（可放大）。
- **前置**：B-01
- **改动点**：`mobile-runtime/ports/file-system.mjs` 的 CHUNK 常量与其旁边的注释（**注释要同步更新**，否则下一个人会照着过期理由调回去）
- **⚠️ 顺序陷阱**：`vfs.mjs` 的 `readMany` 派发把路径**按 `/mnt/` 前缀分组**再拼回原顺序，且 JS 侧**按 path 认项、不认下标**（源码注释明说"按下标对齐会把后面每一项的内容错配给前一个路径 —— 那是静默的数据错位，比读不到更糟"）。改分块/改异步时**顺序错位就是静默数据错误**，必须保留这条不变量并加断言
- **验收判据**：
  ```bash
  # ① 顺序不变量：构造混合挂载点（私有盘 + SAF 树）的批量读，逐项校验内容对应路径
  node mobile-runtime/build/readmany-order-smoke.mjs     # 期望：0 退出
  # ② 批量读的过桥次数下降（grep 过桥 3063 → 75 是现有基线）
  ```

---

## 5. Workstream C — 验收体系加固

### C-01 桥契约显式化 `未开始` · 3 人日

- **目标**：Kotlin 桥与 JS 侧的契约目前是**隐式**的——只靠"假桥和桥一样笨"这条纪律维持（`jank-witness-smoke.mjs` 专门造了 JavaObject 形状的假桥）。0.7.7 的"数据全空"事故正是这个隐式契约破掉的产物。目标：契约有单一真相源。
- **前置**：B-01（若 B-01 改了桥签名，先改契约再改实现）
- **改动点**：
  - 新增 `mobile-runtime/bridge-contract.yaml`：12 个桥（`zcodeSqlite` `zcodeDevice` `zcodeExec` `zcodeFs` `zcodeTree` `zcodeWorkspace` `zcodeCredentials` `zcodeOAuthLink` `zcodeUi` `zcodeBrowser` `zcodeGitHttp` `zcodeModelHttp`）× 方法名 / 入参 / 返回 / 错误码
  - 新增校验脚本 `mobile-runtime/build/bridge-contract-check.mjs`：
    - 从 Kotlin 侧抽取实际 `@JavascriptInterface` 方法名与签名 → 与 YAML 比对
    - 从 JS 侧抽取 `zcode*.<method>(` 调用点 → 与 YAML 比对
    - **任一侧新增/改名而 YAML 未改 → 失败**
- **验收判据**：
  ```bash
  # ① 契约覆盖全部 12 个桥
  node mobile-runtime/build/bridge-contract-check.mjs --print-coverage    # 期望：12/12
  # ② 故意在 Kotlin 加一个方法而不改 YAML → 校验必须失败
  node mobile-runtime/build/bridge-contract-check.mjs                     # 期望：非 0 退出
  ```
- **风险**：低—中。抽取 Kotlin 签名需要一个稳定的抽取方式（注解 + 正则即可，不要上重型解析）

### C-02 规格 ↔ 验证方式映射 `未开始` · 1.5 人日

- **目标**：`mobile-runtime/specs/` 现有 25 份行为规格，但每份"用哪条脚本验"是隐性的（写在人脑里）。目标：显式映射。
- **改动点**：`mobile-runtime/specs/*.md` 每份加一节「验证方式」，列出具体脚本名与层级（Node smoke / Chromium e2e / 真机人工）
- **验收判据**：
  - ① 25/25 份 specs 都有「验证方式」小节
  - ② 映射里引用的脚本**都真实存在**（加一条 CI 检查：spec 里提到的脚本名在 `mobile-runtime/build/` 下能找到）
  - ③ 新增 spec 若无「验证方式」，CI 提示（软失败即可）
- **风险**：低

### C-03 把守门接进 CI `未开始` · 1 人日

- **目标**：A-05 的断言与 C-01/C-02 的检查进 `.github/workflows/mobile-checks.yml`，让漂移在 CI 就红。
- **改动点**：`.github/workflows/mobile-checks.yml`（现为：typecheck + lint + `tsc -p mobile-runtime/tsconfig.json` + `build-mobile.mjs` + 9 条 runtime smoke + `assembleDebug -PappVersion=0.8.1`）
- **⚠️ CI 版本号**：CI 用**固定测试版本**构建，且**不得清理运行机器的下载文件夹**（`AGENTS.md`）——加新步骤时不要破坏这条
- **验收判据**：
  ```bash
  # ① 本地跑 CI 的同一串命令必须全绿
  # ② 故意让一个守门失败 → CI 红
  ```
- **风险**：低

---

## 6. Workstream D — Flutter 决策门（**条件触发，默认不启动**）

### D-00 触发条件

**三选一成立才开启**，否则本工作流保持关闭：

| # | 条件 | 证据要求 |
|---|---|---|
| T-1 | 产品要求「全原生」是**商店上架 / 合规 / 品牌**卖点 | 书面确认（非口头） |
| T-2 | 鸿蒙 ArkWeb 实测性能不达标 | 先做 U-10 核实（鸿蒙 NEXT 有无可用 Flutter 运行时），再实测 ArkWeb 的渲染/滚动/输入延迟，给出对比数字 |
| T-3 | 桌面 + 手机 + 鸿蒙三端要收敛到一套代码，**且桌面 Electron 也一并换** | 书面确认，并接受评估 F-12 的全部代价 |

### D-01 门内两个必答问题（**不答清楚不许写代码**）

1. **UI 是否也换？**
   - 不换 → v4 协议必然分裂成 TS/Dart 两套（10,868 行 zod 双实现）→ 评估 F-10 判定为阻塞
   - 换 → 范围从 7.4 万行变成 40 万行+，本评估的全部结论需要重估
2. **是否接受上游永久分叉？**
   - 不接受 → **直接否决**，无需技术评估（评估 F-04 已给出同构裁决："E. ArkTS/Kotlin 重写内核 → 与上游永久分叉，成本 5–8 倍"）

### D-02 最小原型（仅在 D-01 两问都答清后）

- **范围严格限定**：Composer 输入区（`packages/ui/src/v4/ConversationComposer.tsx` 约 2,387 行 + `LexicalChatInput.tsx` 约 1,531 行）＋ 用量图表（`packages/ui/src/settings/usage-stats/` 约 3,202 行）
- **不动**：KaTeX/Markdown、diff 视图、React Flow、Office 预览、Agent 运行时、任何 Kotlin 桥
- **原型形态**：Flutter 壳 + 保留 WebView + 保留 Kotlin 桥 + MethodChannel 转发

### D-03 原型验收判据（**达不到就终止**）

| 指标 | 门槛 |
|---|---|
| 输入延迟 | 端到端比现状**改善 ≥ 30%** |
| 包体 | **不增**（相对同版本现状 APK） |
| 崩溃/白屏 | 0（覆盖切后台、授权弹窗往返、旋转、输入法切换） |
| 维护成本 | 新增代码 ≤ 5,000 行（超出即说明边界没控住） |

### D-04 终止条件（**预先写死，避免沉没成本绑架**）

任一条成立即**终止 Flutter 路线**，把精力放回 Workstream A/B/C：
- 原型未达 D-03 任一门槛
- 需要碰 KaTeX / diff / 运行时才能让原型"看起来像个完整应用"
- 出现「为了让 Flutter 版本能用，必须给上游提 PR」的需求
- D-01 的两个问题在原型中途出现"答案变了"

---

## 7. 已否决项（记录在此以免重复讨论）

| 提案 | 否决理由 | 何时可重开 |
|---|---|---|
| 全面 Flutter 化（UI + 运行时） | 评估 F-01/F-02/F-04/F-06/F-08 | D-00 的 T-1/T-3 成立且 D-01 两问答清 |
| Flutter 只做壳（聊天界面仍 WebView） | 设置页恰是跨端一致性最强的，挪走反而制造第三份实现 | 同上 |
| Flutter 嵌现有 JS bundle | WebView 痛点原样保留 + 同步契约破裂 + 跨语言协议双实现 | 同上 |
| 引入 `flutter_js` 跑 core bundle | 同步 API 断裂 · `instanceof` 断裂 · 无 inspector（回归体系要重建） | 同上 |
| Flutter 化桌面 Electron 端 | 丢内置 Chromium + 分发签名链 + node-pty 跨平台预编译 | T-3 成立 |
| 纯 Dart 重写 Agent 运行时 | 协议层事故一条不消失；isomorphic-git / zod 无等价物 | 不重开 |
| 直接改上游 `zai-org/ZCode` 消除 Sync API | 跨仓库改动，`packages/services` 里 fs 98 处 / path 81 处 | 不重开 |

---

## 8. 风险登记

| ID | 风险 | 触发信号 | 缓解 |
|---|---|---|---|
| R-01 | **工作树被并发推进**，导致基线数字漂移（本评估已踩两次，见评估 §6） | `git log -1` 与开工时不一致 | 每个 item 开工前记录 `git log -1`；验收输出里附上基线与当前 HEAD |
| R-02 | 构建产物（`dist-ui/`）是 gitignore 的**纯产物**，不随代码提交 | 别人 checkout 后体积与本地不同 | A-05 的阈值断言基于**内容**而非绝对字节数，或在 CI 里重新取基线 |
| R-03 | A-05 阈值把构建卡死，阻塞他人 | 有人提 PR 后 CI 红在体积断言 | 阈值留余量；报错写清"超了多少、哪部分涨了"；提供显式豁免开关 |
| R-04 | B-01 改桥签名，旧 JS 缓存打出"未知方法" | 装机后报未知方法 | 保留旧同步接口一个版本；A-05 的缓存相关守门同步生效 |
| R-05 | A-03 的 stub 形状不对，运行期炸在高亮器初始化 | 白名单外语言导致崩溃 | 先做最小验证；stub 形状照抄真模块；白名单文件留空可秒回退 |
| R-06 | A-04 禁用动态 import 后退化成静默失败 | 预览打不开且无提示 | 显式降级提示；对应 e2e 钉住 |
| R-07 | 路线图与实际优先级脱节 | 业主认为某项比 A/B/C 更重要 | 改路线图，不要绕过它 |

---

## 9. 验证矩阵（汇总）

| Item | 静态检查 | 单测/冒烟 | 真机 | 指标 |
|---|---|---|---|---|
| A-01 | ✅ | ✅（新增 smoke） | ✅ | dist-ui 体积 −620 KB |
| A-02 | ✅ | — | ✅ | 多余字体 8 → 0 |
| A-03 | ✅ | ✅ | ✅ | 语言模块 244 → 白名单数 |
| A-04 | ✅ | ✅ | ✅ | dist-ui 体积 −3 MiB |
| A-05 | ✅ | ✅（bundle-guard-smoke） | — | 坏输入必须构建失败 |
| B-01 | ✅ | ✅（bridge-async-smoke） | ✅ | 无轮询 |
| B-02 | ✅ | ✅（file-bench） | ✅ | 私有盘 grep < 200 ms |
| B-03 | ✅ | ✅（readmany-order-smoke） | — | 顺序不变量成立 |
| C-01 | ✅ | ✅ | — | 契约覆盖 12/12 |
| C-02 | ✅ | ✅ | — | 25/25 有映射 |
| C-03 | ✅ | — | — | CI 红/绿可控 |

---

## 10. 变更管理约定

1. **版本号**：构建任何 APK 前**必须先问业主本次版本号**（`AGENTS.md`），不得沿用上一次。Gradle 传 `'-PappVersion=<x.y.z>'`（PowerShell 整体加引号）。
2. **构建环境**：必须 Temurin 21（JBR 25 会挂）；**先 `bundle-ui` 再 `assembleRelease`**；release 走正式 keystore（`android-app/keystore/`，不入库）。
3. **产物命名**：沿用 `aZCode-<版本号>.apk`；构建成功后复制到用户下载文件夹、验证复制成功、再清理该文件夹中本应用的旧版本 APK，**不得清理其他应用或用户文件**。
4. **CI**：用固定测试版本构建，**不得清理运行机器的下载文件夹**。
5. **写文件**：只用 Write/Edit 工具，保证 diff 可审查。
6. **WebView 缓存**：出货用 `LOAD_NO_CACHE`（已配置）；任何"装机改动没生效"先查 assets 缓存，再查别处。
7. **本路线图每完成一个 item**：在本文件里把该 item 的状态改为 `已完成`，并把验收命令的**实际输出**贴在下方「完成记录」小节里。

---

## 11. 完成记录（执行时追加）

> 格式：`### <item ID> · <日期> · <owner>` → 验收命令 + **实际输出** + 备注。

（暂无）
