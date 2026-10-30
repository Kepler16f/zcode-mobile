---
doc_id: azcode-flutter-assessment-2026-10-30
type: assessment-report
status: superseded-by-owner-decision-2026-10-30
date: 2026-10-30
revision: 3
tree: D:\Zcode @ de979a9 ("fix(mobile): themed dialogs, clearing pending badge and background survival")
scope: aZCode 手机端（android-app + mobile-runtime）+ 桌面端（zcode/packages/desktop）
method: 六路并行只读调研 + 主代理实测复核
related:
  - docs/development-roadmap.md
  - PORTING-ANDROID-HARMONY.md
  - mobile-runtime/specs/*.md
---

# aZCode Flutter 重构可行性评估（agent 可读版）

> **读法**：每条发现都有 ID（`F-xx`）、证据指针（`file:line` 或可复跑命令）、置信度标签。
> `已实测` = 主代理或子代理在**本工作树**上跑过命令核对；`推断` = 由已实测事实推导；`待核实` = 需联网/实构建确认。
> 本文档**只记录事实与判断，不含执行授权**——决策状态是「待业主拍板」。
>
> ⚠️ **本工作树在评估期间被并发推进过**（见 §6）。所有数字已对 `de979a9` 重新校准，但**引用前请确认 HEAD 未再变动**。

---

## ⚖️ 业主决策记录（2026-10-30）

本评估的**事实部分（F-01…F-15）全部有效**，作为重构的约束输入；但 §0 的"不建议全面 Flutter 重构"结论**已被业主推翻**。业主拍板记录：

1. **决定**：启动 Flutter 全面重构（UI + 端侧运行时）。范围＝评估 §5 否决的"全面 Flutter 化"，由业主明确推翻否决。
2. **分叉态度**：接受与上游永久分叉，**但要求保留可跟随上游更新的办法**。→ 落法见 `docs/flutter-rewrite-plan.md`：上游耦合收敛为两个"替换件"（内核 JS bundle + 协议 zod schema），协议类型走**代码生成**而非手写双实现，上游同步流程机械化。
3. **动机**：T-3（桌面+手机+鸿蒙三端收敛一套代码）＋ 业主个人偏好。评估 §5 中"Flutter 化桌面"的 F-12 代价已告知，业主接受并在执行计划中排为后期阶段。
4. **决策门状态**：roadmap §6 Workstream D 的 D-01 两问已答清（UI 换、接受分叉），D-02/D-03 的"最小原型"阶段被跳过——业主直接授权全面重构，不先做原型验证。
5. **roadmap A/B/C 工作流的地位**：不删除。过渡期（Flutter UI 未完成前）现有 WebView 应用继续迭代，A/B/C 继续有效；A-03/A-04（shiki 语言集/Office 预览裁剪）随 Flutter UI 完成而自然失效，届时标记 `已否决（被 Flutter 重构取代）`。

执行计划（里程碑/验收判据/同步流程）：**`docs/flutter-rewrite-plan.md`**。

---

## 0. 决策摘要（AT A GLANCE）

| 项 | 内容 |
|---|---|
| **评估问题** | 本应用能否/是否应该用 Flutter 重构 |
| **结论** | **不建议做全面 Flutter 重构。** 六路独立评估全部收敛到同一判断。 |
| **决策状态** | `待业主拍板`。本文档是评估结论，不是既成决策。 |
| **推荐替代路径** | `docs/development-roadmap.md` 的 Workstream A/B/C（交付体积与正确性 + 桥层成本 + 验收体系加固），三条都不需要 Flutter |
| **唯一保留 Flutter 的条件** | 产品要求「全原生」是商店/合规卖点，或鸿蒙 ArkWeb 性能实测不达标 → 触发 Workstream D 决策门 |
| **本次评估最贵的错误** | §6 记录了**三处**已作废的数字，其中两处是"读了过期/被并行改写的产物" |

---

## 1. 决定性事实（F-01 … F-05）

这五条是所有后续判断的地基。**任何讨论 Flutter 的会话都应先读这一节，不要重新推导。**

### F-01 手机端渲染的是上游 React 组件库的原样，一行没改 `已实测`

- `zcode/packages/ui/src` = **1494 文件 / 327,798 行** TSX（§7-A）
- `mobile-runtime/ui/entry.tsx:268` 渲染 `zcode/packages/ui/src/Root.tsx` 的 `Root`，**原样复用**
  - `entry.tsx:23` 从 `@zcode/ui` 导入 `Root`；`entry.tsx:243` 拿的是上游原样的 `RemoteServiceAccess`
- 手机端**没有独立的移动 UI**。移动形态由 `mobile-runtime/ui/web-mobile-shell.ts` 注入 CSS + DOM 投影生成：
  - `:277` 把 `#sidebar` 从桌面 inline 布局投影成 `position:fixed` 抽屉
  - `:38` `NARROW_QUERY = "(max-width: 639px)"`；`:307 armNarrowFlag()` 用 `pointer:coarse` + localStorage 开关替代断点（`:302` 记录了 0.4.8 的根因：装机 M11 一加平板 CSS 视口 ~808px，纯 max-width 永不命中）
- **含义**：Flutter 化 UI ＝ 重写 32.8 万行 React，而不是"换一套组件"。

### F-02 手机端 = WebView(JS) + Kotlin 桥，UI 与后端同处一个 JS 上下文 `已实测`

- 桥注册：`android-app/app/src/main/kotlin/cn/zcode/mobile/MainActivity.kt:239-270`，**12 个 `@JavascriptInterface` 全局名**、14 处注册点
  （`zcodeSqlite` `zcodeDevice` `zcodeExec` `zcodeFs` `zcodeTree` `zcodeWorkspace` `zcodeCredentials` `zcodeOAuthLink` `zcodeUi` `zcodeBrowser` `zcodeGitHttp` `zcodeModelHttp`；
  第 14 处是 `:291` 给自检页单独再注册一个 `zcodeModelHttp`——`:278` 注释说明 `addJavascriptInterface` 是**全页面**注入的，自检页需要隔离）
- UI 与后端之间是**同上下文内存 RPC**：`mobile-runtime/ui/services.ts:607 createQueuePair()` + `ChannelServer`，UI 侧 `entry.tsx:242` 的 `ChannelClient` 连的正是它
- **无 socket、无子进程。** 桌面端靠 `ZCodeAgentProcessManager` 走 stdio 的机制在手机上不存在，故端侧另写了一份 v4 协议实现（`mobile-runtime/ui/agent.ts`，**5,105 行**，`:496 createMobileAgentService` / `:2593 runTurn` / `:4732 sendConversationCommandV4`）
- **含义**：换 Flutter 只换掉这 43 MB 的一半；另一半（Agent 内核、模型流、工具引擎、会话存储）要么塞回隐藏 WebView，要么整体翻 Dart。

### F-03 原生层占代码量的 0.9% `已实测`

| 产物 | 规模 | 测量命令 |
|---|---|---|
| Kotlin 原生层 | **17 文件 / 3,717 行** | §7-B |
| React UI bundle（`dist-ui`） | 5,163 文件 / **31.89 MiB** | §7-C |
| Agent core bundle | `zcode-core.mobile.js` 3.46 MB | §7-D |
| 最新 APK（debug 0.10.0） | **12,888,672 B（12.29 MiB）** | §7-E |

- **17 个 Kotlin 文件**：`AsyncBridgeJobs` `Browser` `Credential` `DeviceProbe` `Exec` `FileChooser` `Fs` `GitHttp` `MainActivity` `ModelHttp` `NativeBridges` `OAuthLink` `Sqlite` `Tree` `UIChrome` `Workspace` `ZcodePaths`
- ⚠️ **口径**：任务简报里写的「14 个 Kotlin 文件 / 3064 行」是**更早的入库版本**。其中 `ModelHttpBridge.kt`（485 行）是**模型请求的唯一通道**——`mobile-runtime/ui/model-transport.ts` 明说"桥缺失 = 原生模型桥不可用"；`AsyncBridgeJobs.kt`（72 行）是 `start → poll* → result` 自造异步任务表；两者**仍未入库**（`git ls-files 'android-app/**/*.kt'` 只有 15 个）。任何"只迁 14 个文件"的方案会当场打断模型链路。
- **含义**：Kotlin 那 3,717 行不是应用，是**给一个 31.9 MiB WebView 应用当 syscall 层的桥**。迁移它不改变产品能力。

### F-04 上游仍在演进，重写＝永久分叉 `已实测`

- 上游 `zai-org/ZCode` v3.14.3，协议 v4 仍在变（`PORTING-ANDROID-HARMONY.md` §7 R8）
- 仓库**自己已有一条同构裁决**：`PORTING-AND-ANDROID-HARMONY.md` §3.1 候选矩阵 —
  「**E. ArkTS/Kotlin 重写内核** → ❌ 与上游永久分叉，成本 5–8 倍」
- v4 协议接缝 = `zcode-protocol-v4`，**10,868 行 zod 定义**
- **含义**：Dart 重写面对的是同一批事实，裁决不会因换语言而变轻。跨语言双实现的漂移风险**已有实证**：`PORTING` §7 R20 记录 Kotlin/JS 两侧各写一遍键名、改了一侧另一侧不报错，0.0.2 的 `rename` 就是这么炸的（`JSONException` 被兜成 `EIO`、再被 `NotFound` 印成 "permission denied"，三层各换一次措辞）。

### F-05 事故面分布：73% 落在"接缝"，27% 在协议层 `已实测`

对 22 条带证据位置的历史事故（取证见 `PORTING-ANDROID-HARMONY.md`、`mobile-runtime/specs/` 25 份、`mobile-runtime/build/` 50+ smoke）按「修法落在哪一层」分类：

| 层 | 条数 | 占比 | 典型 |
|---|---|---|---|
| 原生层（Kotlin/Android 宿主） | 8 | 36% | 缓存顶包、PRAGMA 大小写、边缘手势、IME、渲染进程被杀 |
| JS 垫片层（`mobile-runtime/compat` + `ui` 宿主适配） | 8 | 36% | 命名参数、null 绑参、SAF 同步往返、DOM 观察器、pointer-events 残留 |
| 协议层（上游契约 / v4 / 模型供应商） | 6 | 27% | schema 契约位置、v4 reducer 语义、供应商方言、token 预算 |
| 状态机层 | 1 | 5% | 续写次数 |

- 症状高度同质：**全是「两边形状必须一致」的契约对不上**，没有一条是"WebView 渲染像素不对"
- **含义**：问题出在**层数**，不在语言。但反过来也推不出"该换 Flutter"——见 F-06。

---

## 2. Flutter 收益判据（F-06 … F-08）

### F-06 Flutter 能覆盖 36% 的事故、变轻 27%、**36% 一条不消失** `已实测`

**直接消除（8 条）**：WebView 资源缓存顶包 · `prefers-color-scheme` 被钉死 · `env(safe-area-inset)` 恒 0 · 输入法不顶起页面 · 渲染进程被杀白屏 · SQLite 命名参数/null 绑参垫片 · DOM 观察器看不见属性翻转 · 遗留 `pointer-events:none`

**变轻但根因仍在（6 条）**：PRAGMA 大小写 · 大写 INSERT 误判 · SAF 桥往返成本 · 平板断点阈值 · 隐形字符净化 · 边缘手势优先级

**原样，换语言一条不消失（8 条）**：工具 schema 嵌 metadata（根因＝**上游契约位置** `toContracts` 只认顶层 `inputSchema`）· 思考串正文 · token 预算吃掉正文 · 隐形字符污染入参 · 流中断续写 · v4 `row.upserted` no-op · jank 计时壳包死通道 · 诊断壳语义

- **关键观察**：Flutter 消除的那 36% 里，一半其实是 WebView/React 这两个**具体选型**的代价，换成任何非 Web 技术都一样消失——不是 Flutter 特有优势
- **含义**：那 36% 换不掉的协议层/状态机事故，在 Flutter 重写里一条都不会少，只是换个语言再实现一遍

### F-07 Flutter 真正能消除的，是"已经用约 300 行垫片换来的东西" `推断`

| 痛点 | 现状垫片 | 行数 |
|---|---|---|
| 暗色模式跟随系统 | `mobile-runtime/ui/system-theme-media.ts`（85 行）+ `MainActivity.kt` 关算法反色 | |
| 安全区 | `mobile-runtime/ui/system-insets.ts`（72 行）+ `MainActivity.kt` 原生 `setPadding` | |
| 输入法顶起 | `mobile-runtime/ui/ime-lift.ts`（79 行，三路信号合并） | |
| 输入框双击才出输入法 | `mobile-runtime/ui/composer-touch-focus.ts`（74 行，代按 focus） | |
| 缓存顶包 | `MainActivity.kt` `LOAD_NO_CACHE` | |
| 返回键三级 | `MainActivity.kt` + `zcodeUi.setDrawerOpen` 桥 | |
| **合计** | | **约 300 行 TS/Kotlin** |

- 换掉它要 12–18 人月（见 F-08）
- **含义**：投入产出不成立。现状真正的痛点是**这些垫片每版都在返工**（`PORTING` 里 0.3.8→0.4.11 一连串"顶栏调大下移没效果"），修垫片比换语言便宜两个数量级。

### F-08 三个最硬的 Flutter 难点，在 Flutter 里同样没有现成等价物 `推断`

| 难点 | 现状 | Flutter 侧 | 判据 |
|---|---|---|---|
| KaTeX/Markdown 混合流式渲染 | `packages/ui/src/components/ai-elements/message.tsx` 用 `streamdown` + `@streamdown/math`；流式半截公式要 `parseIncompleteMarkdown` | `flutter_math_fork` 走 MathJax + WebView ＝ 把 WebView 引回 Flutter 界面；**无纯 Dart KaTeX 等价物** | 高 |
| diff 逐词 + Shadow DOM 虚拟渲染 | `packages/ui/src/components/ui/diff-viewer.tsx` 用 `@pierre/diffs` 的 `PatchDiff`/`MultiFileDiff`（Shadow DOM）+ `lib/diffsHighlighterEngine.ts` 的 `shiki-wasm` 引擎 + worker 池 | **无等价物**，需自研；且必须保住"手机主线程不被 diff 拖死"的预算纪律 | 高 |
| 触屏语义替代 | `packages/ui/src/styles.css:1301` 的 `@media (hover: hover)` 块在手机上**永不生效**（`hover` 在该文件出现 82 次）；`message.tsx` 用 Radix ContextMenu，在触屏**根本触发不了**；`ToolCallBlocks/renderers/` 63 个渲染器各带右键菜单 | 需整体重设计为"点按/长按展开" | 高 |

**规模**：UI 层完全做平需重写/重建模 **≈29 万 LOC**（327,798 − 移动端不可达 ≈23,345 − i18n 数据 13,334），产出 **26–34 万行 Dart**，**12–18 人月**（按 100–150 LOC/人天 + 40% 缓冲推导）。
移动端不可达部分的依据：`entry.tsx` 传 `supportsEmbeddedBrowser={false}` / `allowRemoteWorkspace={false}`；`mobile-runtime/ui/services.ts` 的 `stubbed` 名单（21 项，含 `terminalService` `botsService` `feedbackService` `offPeakTaskService` `fileWatcherService` `cuaPermissionService` 等）。

---

## 3. 其余四路评估的结论摘要（F-09 … F-12）

### F-09 原生桥迁移：SAF / Keystore / exec-cancel 必须保留 Kotlin `已实测`

| 域 | Flutter 侧现实 | 判据 |
|---|---|---|
| SAF `DocumentFile` 读写 | Dart **无等价物**；`saf` 包（v2.1.2）是否支持 `ACTION_OPEN_DOCUMENT_TREE` + 持久化 URI 权限 **待核实** | 必须保留 Kotlin |
| `MANAGE_EXTERNAL_STORAGE` | `permission_handler` 支持 `Permission.manageExternalStorage`（v13.0.2，**已核实存在**），但 Play 上架要声明用途 | 可 Dart 化（跳系统页仍需小段 MethodChannel） |
| AndroidKeyStore | `nonExportable` + **AAD 绑密钥名**（`CredentialBridge.kt`：把 access_token 密文挪到 refresh_token 名下会直接解不开） | 保留 Kotlin（`flutter_secure_storage` 语义**待核实**） |
| exec 取消 | Dart 的 `Process.start` **不能 cancel**（无 `destroyForcibly` 等价）；`ExecBridge.kt` 靠 `destroyForcibly` + `ProcessBuilder` + 三流并发 | 必须保留 Kotlin |
| SQLite | `node:sqlite` 的 `DatabaseSync` 是**同步契约**（`SqliteBridge.kt` 明写这是选同步 `@JavascriptInterface` 的唯一理由），`session-store.ts` 有 12 处同步调用 | `sqlite3` FFI（v3.8.0，**已核实支持 Android 且同步**）是唯一保住契约的方案；否则保留 Kotlin |
| 网络 | Dart 无浏览器 CORS → `GitHttpBridge` 可删 | **但** `GitHttpBridge.kt` 的手动重定向/拒绝 HTTPS 降级/跨源跳剥凭据头，和 `ModelHttpBridge.kt` 的 **SSRF 防护**（禁 127/8、0/8、169.254/16 含云元数据、fe80::/10；**保留** 10/8、172.16/12、192.168/16 因为 Ollama/LM Studio 是正当用法；DNS rebinding 解析后再判）必须逐条移植（≈200 行 Dart） |

**同步→异步改造面**：Flutter 无同步 Platform Channel。谁在假设同步——
`compat/vfs-native.mjs`（16 个 Sync 导出）· `compat/vfs-tree.mjs`（16 个）· `compat/shims/fs.mjs`（**复刻 `node:fs` Sync API**，是上游共享代码的既有形状）· `compat/shims/sqlite-native.mjs`（`DatabaseSync` 契约本身是同步的）· `ports/file-system.mjs` 的 `resolveLinks` 同步 while 循环。
**有利条件**：`ports/file-system.mjs` 端口层**已经是 async**，同步只是 vfs 实现的属性。但 `node:fs` Sync 面撞上游共享代码（`packages/services` 里 fs 98 处 / path 81 处），要么给上游提 PR，要么保留 JS runtime。

**最佳路线**：保留 Kotlin + MethodChannel 转发（**+600~900 行 Kotlin**、**+400~600 行 Dart**、Flutter 外壳 1500~2500 行，≈25–40 人日，风险低中）。净收益只是删掉 `AsyncBridgeJobs.kt`(72) + `UIChromeBridge.kt`(146) = 218 行 Kotlin，其余 3,400 行一行不该动。

### F-10 运行时 Dart 化：≈7.4 万行重写，且撞 v4 协议双实现 `已实测`

| 范围 | LOC | 来源 |
|---|---|---|
| `mobile-runtime/` 自有（ui **16,319** + ports 910 + compat 3,260） | ≈20,489 | §7-F |
| core 实际执行切片（tool handlers + executor + permission + hooks） | ≈21,013 | `tool-engine.ts` 声明的 core API 面 |
| `@zcode/services` 直接 import（40 个 deep import） | ≈23,144 | 最大三项 `zcodeTaskServiceAdapter` 5,775 / `taskIndexRepo` 2,567 / `settingsSyncService` 2,402 |
| v4 协议（若 Dart 侧拥有） | 10,868 | `@zcode/shared/zcode-protocol-v4` |

**生态缺口恰好落在最难回退的两点**：
- **isomorphic-git 无等价物**。`mobile-runtime/package.json` 唯一直接依赖就是它（^1.43.3）。pub.dev 的 `git` 2.3.2 是 **git CLI 包装**（Android 无 git 二进制，只有 `/system/bin/sh` + toybox）；`libgit2dart` 1.2.2 要随包 libgit2 `.so` + GPL-2.0 带链接例外分发 + 16 KB page 对齐（`PORTING` §7 R13 记为"上周还能编译，这周 Bash 全挂"级静默破功）
- **zod 无等价组合子**。`json_schema` 5.2.2 只做校验不做组合子/类型推导；`json_serializable` 是编译期生成、给不出运行时 schema

**"保留 JS + 引入 JS engine"路线的坑**：`flutter_js` 0.8.7（Android 用 QuickJS，iOS 用 JavaScriptCore）——
同步 API 断裂（最致命，现有运行时地基就是同步）· `instanceof` 断裂（`tool-engine.ts` 记录的真实事故：执行器用 `isFileSystemPortError()` 认端口错误，跨引擎后三方对象不可能共享 instanceof）· QuickJS 无 inspector（现有真机自检 + Playwright e2e + 50+ smoke 回归体系要重建）· ABI 与 16 KB page · ESM 适配（core bundle 是 `format:"esm"`）。

**Dart 侧确有的正收益**（但都能在现有架构里增量拿到）：原生桥改异步 MethodChannel 消掉 30–40ms/次同步阻塞 · `dart:io HttpClient` 直接流式可删 `ModelHttpBridge` 的 base64+50ms 轮询链 · `sqflite`/`drift` 直连 framework SQLite（`sqlite-native.mjs` 头注：桌面 db 已 36 MB + 4 MB WAL，sql.js 整库进内存）· `dart:isolate` 补上今天缺失的 diff worker（`PORTING` §1.5.18 记为已知缺口）。

### F-11 构建链：esbuild 不能删；Flutter 只做壳会让 APK 涨约 2.5 倍 `已实测 + 推断`

- **esbuild 链不能删**：core bundle（3.46 MB）必须由 `mobile-runtime/build/bundle.mjs` 打，UI 在运行时动态 import 它（`tool-engine.ts`）
- **构建链现状**（`android-app/app/build.gradle.kts`）：
  - AGP 8.13.2 · Kotlin 2.2.0 · Gradle 8.13 · compileSdk/minSdk/targetSdk = 34/26/34 · JDK 17
  - `versionCode = major*1_000_000 + minor*1_000 + patch`，且必须 > 73（`:26`）
  - **无 NDK / CMake / abiFilters / splits / jniLibs**（`DeviceProbe.kt` 自述"本机没有 NDK"）
  - 依赖仅 `androidx.webkit:webkit:1.12.1` + `androidx.documentfile:documentfile:1.0.1`
  - 签名：debug 用 `~/.android/debug.keystore`；release 用 `android-app/keystore/azcode-release.keystore`（alias `azcode`，v1+v2+v3 全开）；缺材料直接 `throw GradleException` 不出包
  - 产物名固定 `aZCode-$versionName.apk`（不随 buildType 变）
  - `preBuild` 依赖 5 个任务：`copyMobileRuntime` / `copyMobileUi` / `copyWebDist`(仅 `-PincludeWebUi`) / `checkNativeLibExtraction` / `checkMobileBundleFingerprint`
  - `:99` `assets.setSrcDirs(listOf(file("build/generated/assets")))` **整体替换** assets 源目录
- **Flutter 引入后的构建链**（方案 A：Flutter 只做壳）
  - `:app` 保持唯一 application 模块，**现有配置一行不改**
  - Flutter 作为 `:flutter_shell` library 模块，`flutter_assets` 需**追加**进 `:app` 的 assets 源目录——⚠️ 当前是 `setSrcDirs(...)` **整体替换**，不改会静默丢资源
  - ⚠️ manifest 合并风险：Flutter 模板会写 `android:extractNativeLibs`，而 `checkNativeLibExtraction`（`:171`）断言它必须是 `"true"`（`PORTING` §7 R13：随包 ELF 要能 execve）
  - 版本号：`:flutter_shell` 是 library 模块不带版本号 → **没有第二个版本事实源**（最干净的接法）；若走 Flutter 主导则 `-PappVersion` 契约必须包一层脚本翻译成 `--build-name/--build-number`
  - 签名：方案 A 下 `signingConfigs` 原样生效，**零改动**
- **体积**（本机实测 `C:/flutter` 3.47.2 / Dart 3.13.2 / engine `a804b26164`，channel `[user-branch]`）：
  - arm64 engine `.so` 原始 157.51 MiB 含 **120.75 MiB DWARF**（未 strip，不可直接引用）；**PT_LOAD 11.20 MiB**、deflate 后 **5.21 MiB** 才是可比值
  - Flutter 只做壳 + 通用 APK（3 ABI）≈ **30–31 MiB**（相对当前 12.29 MiB 的 debug APK 涨约 2.5 倍）；`--split-per-abi` ≈ 21 MiB
  - `libapp.so`（Dart AOT）体积 **待核实**

### F-12 桌面 Electron 端：更不建议 `已实测`

- 渲染进程直接吃共享 `packages/ui`（1552 文件 / 13.04 MiB React 源码）——**Flutter 化桌面 = 同时废掉桌面和移动两条线的共享底座**
- Node 运行时是架构的一部分：`node-pty`（+ `spawn-helper`/`winpty-agent` 预编译 + `@electron/rebuild` + `afterPack` 断言）· `node:sqlite` `DatabaseSync`（会话库 + Chrome cookie 库）· `ssh2` · `ws`/`undici` · `node-forge` · 注入式 Playwright 脚本（Browser 工具的 DOM 快照/locator/截图）
- Flutter Desktop 没有的三件东西：**内置 Chromium**（Browser 工具整个产品面）· electron-builder 26.8.1 的 dmg/zip/nsis/AppImage/deb/rpm/pacman + hardenedRuntime + entitlements + 独立公证段 + `signIgnore` + 定制 `zcode://` 协议 · 插件系统读磁盘 `.zcode-plugin/plugin.json`（还兼容 Claude/Codex 插件）
- 唯一说得通的 Flutter 桌面形态是「Flutter 只做窗口/托盘/更新 UI，Electron 主进程降级成被托管的 headless 后端」——保留两套运行时，收益远小于成本

---

## 4. 真正值得花钱的地方（F-13 … F-15）

> 这一节与 Flutter 无关，是本次评估最有生产力的副产品。

### F-13 bundle 体积构成：重复只有 0.66 MiB；真正的杠杆是产品决策 `已实测`

`mobile-runtime/build/dist-ui` 实测（**当前产物**，5,163 文件 / 33,438,434 B = 31.89 MiB）：

| 桶 | 文件 | 字节 | 备注 |
|---|---|---|---|
| `.js` 合计 | 3,917 | 30,211,389（28.81 MiB） | |
| ├ 具名模块（非 `chunk-*`） | 2,085 | 21,396,136（20.40 MiB） | |
| │ ├ **shiki 语言语法** | **244** | **5,588,609（5.33 MiB）** | 命中 `@shikijs/langs` 文件名 |
| │ └ **真实重复**（同名 ×2） | 12 | **693,483（0.66 MiB）** | 仅 6 组：`wasm` 634,427 / `coffee` 27,623 / `move` 17,706 / `fish` 13,239 / `diff` 244 / `turtle` 244 |
| └ 匿名共享块 `chunk-*.js` | 1,832 | 8,815,253（8.41 MiB） | 内容是应用代码（i18n locale、provider 配置等），**不是重复** |
| 非 `.js` | 1,246 | 3,228,045（3.08 MiB） | KaTeX 字体 59 个、material-icons 1,146 个、pdf-viewer、css、sql-wasm.wasm |

- **KaTeX 字体打包是正确的**：CSS 引用 51 个、产物里 59 个，**命中 51/51，缺失 0**（多出的 8 个共 130.7 KiB 属多余拷贝）
  - 机制：不是手工拷贝——`bundle-ui.mjs` 的 esbuild `loader: {".woff2": "file", ...}` 把被 import 的字体作为资源落到 `dist-ui/assets/`，`relocateCssAssets`（`bundle-ui.mjs:218` 调用，实现见 `mobile-ui-assets.mjs:169`）再按 CSS 的 `url()` 引用把上游 `packages/web/dist/assets/` 的对应文件搬进来
- **shiki 重复问题早已解决并被守门**：`mobile-runtime/build/mobile-ui-assets.mjs:64-66` 的 `mobileShikiDependency` 把 `@shikijs/langs` 解析到单一根，`bundle-ui.mjs:165-166` 在第二个实例重新进入模块图时**直接构建失败**，`:170 assertShikiConsistency` 逐包核对版本混搭。实测重复仅 0.66 MiB，与守门生效一致
- **真正的杠杆是产品决策不是 bug**：
  1. 244 个语言语法 / **5.33 MiB** —— 手机端是否需要全部 244 种语言？
  2. `Office` 预览 4.11 MiB（`previewPaneOfficeXlsxContent` 2.05 MB + `pptxRendererPreviewEngine` 1.01 MB + legacy-doc 0.90 MB）—— 手机端是否需要？
  3. `pdf-viewer` 0.46 MiB —— 手机端是否需要？

### F-14 `wasm` 疑似双份：base64 内联 + 独立文件 `待核实`

- `dist-ui/wasm-H3KT2BUB.js`（622,378 B）内容是 `Uint8Array.from(atob("AGFzbQEAAAABo..."))` —— **一个 WASM 二进制被 base64 内联进 JS chunk**（base64 本身有 33% 膨胀惩罚，且不能独立缓存/流式加载）
- 同时存在独立的 `dist-ui/sql-wasm.wasm`（659,806 B）
- **两者是否同一二进制尚未确认**（U-09）。若同一，则有 ~620 KB 可回收
- 另：`wasm-ZWNZMWOR.js`（12,049 B）是 shiki 的 "WebAssembly" 语言元数据，与前两者无关（同名不同物）

### F-15 SAF 同步桥的成本是 Android 平台成本，不是语言成本 `已实测`

- SAF 树桥每条 readdir/stat **30–40ms 同步往返**（真机 M8：writeMs=30.6 / readMs=40.5）
- 实测 3000 文件 grep：内存盘 **56.1 ms** vs 真盘 **1231.8 ms** = **22×**
- 单价：`bulk200x512B` 1.2 ms/文件写 · `readdir` 0.05 ms/项 · `grep` 0.41 ms/文件读 · 手机 0.38 ms/次 · WSA 2.49 ms/次
- 已在做的对的方向：`readMany` 批量（256 文件/批，grep 过桥 3063 → 75 次）+ 把遍历下推到 native（toybox 的 `grep`/`find`/`sed`/`xargs`）
- **含义**：换成 Dart 桥一次往返都不会更快（还要多一次序列化）。**重写运行时解决不了它**

---

## 5. 明确否决的备选方案

| 方案 | 否决理由 |
|---|---|
| **全面 Flutter 化（UI + 运行时）** | F-01/F-02/F-04/F-08：32.8 万行 React + 7.4 万行运行时重写，12–18 人月，协议层事故一条不消失，上游永久分叉 |
| **Flutter 只做壳（导航/设置/文件树），聊天界面仍 WebView** | **不划算**：设置页恰是跨端一致性需求最强的（桌面 Web 同一份 `SettingsPage.tsx`），挪走反而制造第三份实现；最难的聊天主界面一点没动；WebView 痛点全存；净增 Flutter engine 体积 |
| **Flutter 全量替换 UI，但核心 JS 用 `webview_flutter` 嵌** | **明确不建议**：UI 仍是 WebView 渲染，所有 WebView 痛点原样保留；只多了 engine 体积 + 一层跨语言 RPC + 同步契约破裂（`node:fs` Sync 面撞上游共享代码） |
| **引入 `flutter_js` 跑现有 core bundle** | 同步 API 断裂（最致命）· `instanceof` 断裂 · QuickJS 无 inspector（50+ smoke + 25 份 specs 的回归体系要重建）· ABI/16 KB page · ESM 适配 |
| **Flutter 化桌面 Electron 端** | F-12：丢内置 Chromium + 分发签名链 + node-pty 跨平台预编译，且废掉桌面/移动共享底座 |
| **现在做 Flutter 原型验证** | 除非触发 Workstream D 的决策门，否则是分叉 |

---

## 6. 已作废的数字（**重要**）

本次评估产出过**三处错误结论**，现予作废。**前两处的成因相同：读了会变的东西。**

### 6.1 ❌「`dist-ui` 有 23.9 MiB 重复 chunk」——错，虚高约 36 倍

- **错因**：esbuild 的匿名共享块都叫 `chunk-XXXXXXXX.js`。按"剥掉末尾 8 位哈希"聚类时，1,832 个**互不相同**的匿名块塌成"一组"，虚增出约 24.3 MiB 假重复
- **正确值**：真实重复（同名具名模块 ×2）**只有 6 组 12 文件 693,483 B = 0.66 MiB**，且已被 `bundle-ui.mjs:165` 的守门断言覆盖
- **教训**：判定"重复资源"必须**按内容哈希**去重，不能按文件名去哈希后聚类——匿名块的名字空间是共享的

### 6.2 ❌「KaTeX 字体 59 个一个没进包」——错，打包完全正确

- **错因**：`find . -iname 'KaTeX_*' | wc -l` 返回 0。该次测量读到的 `dist-ui` 是**旧产物**（目录 mtime 早于随后的重建），当时的产物里确实还没有 `assets/`
- **事实**（当前产物重测）：CSS 引用 51 个、`dist-ui/assets/` 有 59 个、**命中 51/51、缺失 0**
- **机制**：字体不是手工拷贝的——esbuild `loader: {".woff2": "file"}` 把被 import 的字体作为资源落到 `assets/`，`relocateCssAssets`（`bundle-ui.mjs:219`）按 CSS 的 `url()` 引用把上游 `packages/web/dist/assets/` 的对应文件搬进来
- **教训**：`dist-ui/` 是 **gitignore 的纯产物**（`.gitignore:8`），**不随代码提交**。任何基于它的体积/内容结论都只在"产物不动的那个时刻"成立

### 6.3 ❌「`dist-ui` 39.9 MiB / 5,447 文件」——错，是过期读数

- **错因**：同一次评估期间，工作树被**并发推进**（HEAD 从 0.8.0 时代到 `de979a9`，新增 `NativeBridges.kt` / `file-watcher.ts` / `memory-context.ts`，并有 0.10.0 APK 出包），`dist-ui` 也在 12:33 被重建
- **正确值**（当前产物）：**5,163 文件 / 33,438,434 B = 31.89 MiB**；`.js` 部分两次测量完全一致（3,917 / 28.81 MiB），差异全在非 JS 资源（11.1 → 3.08 MiB）
- **同时作废的还有**「`assets/www` 46.9 MiB 是手机端产物」——它**不进任何 APK**：`build.gradle.kts:99` 把 assets 源目录整体替换，`copyWebDist`（`:158-166`）只在 `-PincludeWebUi=true` 时执行；那份是 `zcode/packages/web/dist` 的拷贝
- **教训**：**评估期间工作树可能被并发改动**。引用本报告数字前先确认 `git log -1` 未变；引用体积数字前先看 `stat -c %y mobile-runtime/build/dist-ui`

### 6.4 ⚠️「shiki 装三份 node_modules 导致 8 MiB 重复」——错，重复早已解决

- **错因**：只看了 `node_modules` 里 `@shikijs/langs` 确实存在三份（各 ~7.8 MB / 347 文件，版本 3.23.0 / 4.0.2 / 4.1.0，其中 3.23.0 由 `@pierre/diffs@1.1.22` 硬依赖），**没检查构建链是否已做单根解析**
- **事实**：`mobile-runtime/build/mobile-ui-assets.mjs:64-66` 的 `mobileShikiDependency` 已把语言资源解析到单一根，`bundle-ui.mjs:165-166` 在第二实例重入时**构建失败**，`assertShikiConsistency`（`:170`）逐包核对版本
- **教训**：仓库里的构建脚本**本身是守门员**——评估"某依赖重复"前，先 grep 构建脚本里有没有对应断言

---

## 7. 证据复现命令

```bash
# A. 上游 UI 规模（必须排除 xargs 的 "total" 行）
cd zcode/packages/ui/src && find . -type f \( -name '*.tsx' -o -name '*.ts' \) -print0 \
  | xargs -0 wc -l | awk '$2!="total"{s+=$1;n++}END{print "files="n" loc="s}'
# → files=1494 loc=327798

# B. Kotlin 原生层
ls android-app/app/src/main/kotlin/cn/zcode/mobile/*.kt | wc -l                    # 17
wc -l android-app/app/src/main/kotlin/cn/zcode/mobile/*.kt | tail -1             # 3717 total
git ls-files 'android-app/**/*.kt' | wc -l                                      # 入库数少于磁盘数

# C. 手机端 UI bundle（先确认产物时间！）
stat -c '%y' mobile-runtime/build/dist-ui
find mobile-runtime/build/dist-ui -type f -printf '%s\n' | awk '{s+=$1;n++}END{print n, s}'
# → 5163 33438434

# D. 真实重复（必须排除 chunk-* 并按内容哈希复核）
cd mobile-runtime/build/dist-ui
find . -type f -name '*.js' -printf '%f %s\n' | grep -v '^chunk-' \
  | sed -E 's/^([A-Za-z0-9_.@/-]+)-[A-Za-z0-9_]{8}\.js /\1 /' | LC_ALL=C sort \
  | awk '{c[$1]++;s[$1]+=$2}END{for(k in c)if(c[k]>1)printf "%s x%d %dB\n",k,c[k],s[k]}'
# → wasm x2 634427 / coffee x2 27623 / move x2 17706 / fish x2 13239 / diff x2 244 / turtle x2 244

# E. APK 产物
ls -l --time-style=+%m-%d\ %H:%M android-app/app/build/outputs/apk/*/*.apk

# F. 端侧自有代码
wc -l mobile-runtime/ui/*.ts mobile-runtime/ui/*.tsx | tail -1                              # 16319
wc -l mobile-runtime/compat/*.mjs mobile-runtime/compat/*/*.mjs mobile-runtime/ports/*.mjs | tail -1  # 4226

# G. KaTeX 覆盖（注意 comm 必须 LC_ALL=C + 去 \r，否则会给出矛盾结果）
cd mobile-runtime/build/dist-ui
grep -oE 'KaTeX_[A-Za-z0-9-]+\.(woff2|woff|ttf)' zcode-ui.css | tr -d '\r' | LC_ALL=C sort -u > /tmp/need.txt
ls assets/ | grep '^KaTeX_' | tr -d '\r' | LC_ALL=C sort -u > /tmp/have.txt
comm -12 /tmp/need.txt /tmp/have.txt | wc -l    # 51
comm -23 /tmp/need.txt /tmp/have.txt | wc -l    # 0

# H. 构建守门断言（评估依赖重复前必查）
grep -n 'shikiDependency\|assertShikiConsistency\|languageRoot\|clearOutdir' \
  mobile-runtime/build/bundle-ui.mjs mobile-runtime/build/mobile-ui-assets.mjs
```

---

## 8. 待核实清单（不得当作已知）

| # | 事项 | 为什么重要 | 怎么核实 |
|---|---|---|---|
| U-01 | `flutter_math_fork` / `gpt_markdown` / `flutter_highlight` / `fl_chart` / `mcp_dart` 的实际可用性与 API 面 | 决定 F-08 的难度是否可降级 | 联网查 pub.dev + 最小示例编译 |
| U-02 | 官方 stable Flutter engine 的 PT_LOAD / deflate 体积 | F-11 的体积估算基于 `[user-branch]` 未 strip 的 `.so` | 官方 SDK 重跑体积统计，或打空壳 APK 量 diff |
| U-03 | `libapp.so`（Dart AOT）体积 | F-11 未定 | 空壳 `flutter build apk --release` |
| U-04 | Flutter 与 minSdk 26 / compileSdk 34 / AGP 8.13.2 的兼容矩阵 | F-11 可行性 | 建最小 `:flutter_shell` 跑 `assembleDebug` |
| U-05 | Flutter 模板 manifest 的 `extractNativeLibs` 与 R13 断言的合并结果 | F-11 会推迟到装机才暴露 | 合并后跑 `checkNativeLibExtraction` |
| U-06 | `saf`（v2.1.2）是否支持 `ACTION_OPEN_DOCUMENT_TREE` + 持久化 URI 权限 | F-09 的 SAF 判定 | 读包源码 |
| U-07 | `flutter_secure_storage` 是否等价于 Keystore 的 `nonExportable` + AAD 绑名 | F-09 的凭据判定 | 读 Android 实现源码 |
| U-08 | `flutter_inappwebview` v6.1.5 的 JS 注入 API / 双向桥 / `onShowFileChooser` | F-09 的浏览器判定 | 读包文档 |
| U-09 | `dist-ui/wasm-H3KT2BUB.js` 内联的 622 KB WASM 与独立的 `sql-wasm.wasm`(660 KB) 是否同一二进制 | 若是，则有 ~620 KB 可回收（F-14） | 两者解出二进制后逐字节比对 |
| U-10 | 鸿蒙 NEXT 的 Flutter 运行时可用性 | 决定 Workstream D 决策门是否打开 | 查 `ohos-flutter` 生态现状 |
| U-11 | 手机端实际需要哪些语言语法（244 个 / 5.33 MiB） | F-13 的最大杠杆是产品决策 | 看真实会话里的高亮语言分布 |
| U-12 | 手机端是否需要 Office 预览（4.11 MiB）与 pdf-viewer（0.46 MiB） | 同上 | 同上 |

---

## 9. 给下一个接手 agent 的指令

1. **先读 §1**（F-01…F-05）。任何"要不要上 Flutter"的讨论都从这五条开始，不要重新推导。
2. **引用数字前确认工作树未变**：`git log -1` + `stat -c %y mobile-runtime/build/dist-ui`。本次评估期间树被并发推进过（§6.3）。
3. **不要重跑 §7 的实测**，除非上面两项变了。
4. **评估依赖重复前先 grep 构建脚本的断言**（§6.4 的教训）。`mobile-runtime/build/` 里的脚本本身是守门员。
5. **判定重复资源必须按内容哈希**，不能按文件名（§6.1 的教训）。
6. **用 `comm` 比对文件清单前必须 `LC_ALL=C sort` + 去 `\r`**，否则会得到"同一文件同时在两侧"的荒谬结果（§7-G）。
7. **若被要求"做个 Flutter 原型"**，先看 `docs/development-roadmap.md` 的 Workstream D 决策门，确认触发条件成立再动手；否则应回推 Workstream A/B/C。
8. **写文件一律用 Write/Edit 工具**，禁止 heredoc / 重定向 / 内联 node-sed 改写（保持可审查 diff）。
9. **构建 Android 包前必须先问版本号**（`AGENTS.md`），并用 `'-PappVersion=<ver>'` 传参。
