---
doc_id: azcode-flutter-rewrite-plan-2026-10-30
type: execution-plan
status: active
date: 2026-10-30
revision: 1
basis: 业主决策 2026-10-30（见 docs/flutter-refactor-assessment.md「业主决策记录」）
scope: aZCode Flutter 全面重构（UI + 端侧运行时），Android 先行，桌面/鸿蒙后续
related:
  - docs/flutter-refactor-assessment.md
  - docs/development-roadmap.md
  - AGENTS.md
---

# aZCode Flutter 重构执行计划

> **总原则**：UI 与端侧运行时 100% Dart/Flutter；上游 Agent 内核**原样**跑在隐藏 WebView 里；协议类型**生成**而非手写。
> 这三条合起来就是业主要求的"保留可跟随上游更新的办法"——上游同步收敛为"换两个替换件 + 重新生成 + 编译器指错"的机械流程。

---

## 1. 架构总则（回答"如何跟随上游"）

评估 F-04 的结论是"重写＝永久分叉"，其成立前提是**手写双实现**。本架构把上游耦合压缩到两个边界，其余全部自有：

```
┌─────────────────────────────────────────────────────┐
│  Flutter UI（自有 Dart，≈29 万行 React 面的 Flutter 重写）      │
│  聊天/文件树/Git 面板/设置/审批 —— 三端共享一套                  │
├─────────────────────────────────────────────────────┤
│  Dart 端侧运行时（自有，翻自 mobile-runtime/ui 约 2 万行）       │
│  v4 客户端（agent.ts 5,105 行 → Dart）、会话管理、权限流          │
├──────────────────────┬──────────────────────────────┤
│  协议类型（生成件 B）    │  内核宿主 CoreHost（隐藏 WebView）          │
│  zod schema → Dart 类  │  跑上游内核 bundle 原样（替换件 A）            │
│  每次 upstream sync    │  zcode-core.mobile.js，无 UI 渲染，           │
│  重新生成，编译期暴露漂移 │  WebView 痛点（输入法/安全区/主题）对它不适用    │
├──────────────────────┴──────────────────────────────┤
│  Kotlin 桥（17 文件原样保留，挂 CoreHost；后期可挪到 Flutter 壳）  │
│  SAF/Keystore/exec-cancel/SQLite/网络 SSRF 防护（评估 F-09）     │
└─────────────────────────────────────────────────────┘
```

### 替换件 A：内核 bundle（原样复用，不翻译）

- 来源：`mobile-runtime/build/bundle.mjs` 从上游 checkout 打出 `zcode-core.mobile.js`（当前 3.46 MB，含工具引擎/执行器/权限/hooks）。
- Flutter 侧只负责**加载与供电**（asset 注入 + JS console/桥转发），不解析其内容。
- 跟随上游＝重新跑 bundle.mjs 换文件。内核行为与上游 100% 一致，不存在漂移。
- 隐藏 WebView 不渲染任何像素，评估 F-06 列出的 WebView 痛点（主题/输入法/安全区/白屏）只影响可见 UI，对内核宿主不成立。唯一要保的是"进程被杀后恢复"（已有 background-survival 规格，移植到 Flutter 宿主）。

### 替换件 B：协议 schema（生成，不手写）

- 唯一真相源：`zcode/packages/shared/src/zcode-protocol-v4/`（25 文件 / 10,868 行 zod，zod v4.6.5）。
- 管线：Node 生成器（`flutter-app/tool/zod2dart/`）读 zod schema 内省 → 发射 Dart 数据类（手写 fromJson/toJson，零外部依赖，产出**提交入库**，正常构建不需要 Node）。
- 跟随上游＝重跑生成器 → `dart analyze` 红在哪、v4 改了什么一目了然 → 按编译错误逐点修。**协议漂移从"人肉 diff 一万行"变成"编译器报错清单"**——这是本机制能成立的核心。
- 评估 F-04 的教训（R20：Kotlin/JS 双写键名漂移）在此被消灭：键名只存在于 schema 一处，Dart 代码是派生物。

### 自有层（跟随本仓，不跟随上游）

Flutter UI、Dart 运行时、CoreHost、桥调度——上游改这些的对应物时，重构方案自行决定是否跟（这正是"分叉"的真实含义：分叉的是**产品面**，不是**协议面**）。

---

## 2. 上游同步 SOP（每次跟上游执行的固定流程）

```bash
# 1. 更新上游 checkout
cd zcode && git fetch --tags && git checkout <tag> && cd ..
# 2. 重打内核 bundle（替换件 A）
node mobile-runtime/build/bundle.mjs
# 3. 重生成协议 Dart（替换件 B）
node flutter-app/tool/zod2dart/generate.mjs --check   # 先报告 diff
node flutter-app/tool/zod2dart/generate.mjs           # 落盘
# 4. 编译期暴露漂移
flutter analyze && flutter test
# 5. 按 analyze/test 报错修 Dart 侧适配点，跑冒烟
```

验收判据（每条都机械可查）：

1. 生成器对 `zcode-protocol-v4` 全部 25 文件的导出 schema 内省覆盖 ≥ 95%（`--check` 报告覆盖率），未覆盖项有白名单和理由。
2. 生成产物**幂等**：连跑两次 `generate.mjs`，git diff 为空。
3. 上游模拟漂移测试：给 schema 加一个字段 → 生成器产出新字段 → `dart analyze` 通过且 fromJson 有默认值；**删/改**一个字段 → 使用点编译报错（钉死"漂移必须可见"）。

---

## 3. 里程碑

| 阶段 | 内容 | 出口判据 | 状态 |
|---|---|---|---|
| **P0 骨架**（本次交付） | flutter-app 工程、zod→Dart 生成器 PoC、CoreHost 抽象 + Fake、analyze/test 全绿 | `flutter analyze` 0 issue；`flutter test` 全绿；生成器幂等；debug 包可出 | 进行中 |
| **P1 内核通电** | 真实 CoreHost：隐藏 WebView 加载现有 bundle，12 桥经 JS↔Dart 转发，会话建立、一条消息端到端 | 真机：发消息→流式回复上屏（用 Flutter 最小 UI）；App 杀进程恢复会话 | 未开始 |
| **P2 聊天主面** | 会话列表、对话流、Composer、流式 Markdown/KaTeX、工具调用块、审批卡片 | 触屏语义替代（评估 F-08 第 3 条：长按替代右键）；输入延迟不劣于现状；主线程 diff 预算用 `dart:isolate` 补齐（F-10 的已知缺口） | 未开始 |
| **P3 产品面补全** | 文件树、Git 面板、设置、OAuth、模型供应商管理 | 桌面 Web 现有 SettingsPage 能力对等清单逐项勾稽 | 未开始 |
| **P4 切换** | 构建链收编（`android-app` 与 flutter-app 合并为单一构建；assets `setSrcDirs` 整体替换陷阱见评估 F-11；`extractNativeLibs` 断言适配）；dist-ui 退役；正式签名出包 | 新架构 APK ≤ 现状 12.29 MiB × 2；旧 WebView UI 代码删除；roadmap A-03/A-04 标记失效 | 未开始 |
| **P5 三端收敛**（T-3） | 桌面（Flutter Desktop，内核宿主改 Node sidecar 或继续 headless Electron——届时另做评估，F-12 代价已知）；鸿蒙（先核实 U-10 Flutter 运行时可用性） | 三端同一份 Dart UI 代码跑通核心场景 | 未开始 |

### P0 已定的技术决定

- **SDK**：本机主力 `C:\dev\flutter-arm64`（3.47.2，ARM64 宿主）；通用版 `C:\dev\flutter`（3.47.7 stable，x64）。CI 用 stable。版本钉在 3.47.x，升级走单独 PR。
- **工程位置**：`D:\Zcode\flutter-app`（与 android-app/mobile-runtime 并列；P4 才决定是否收编为 Gradle 子模块，P0 阶段独立构建）。
- **包名**：`cn.zcode.flutter`（最终包名 P4 定，避免与现有 `cn.zcode.mobile` 冲突导致双装）。
- **minSdk 26 / targetSdk 34**：与 android-app 对齐（评估 F-11）。
- **零外部 Dart 依赖起步**：生成物手写 fromJson/toJson，不引 json_serializable/freezed，消除 build_runner 链；需要时再议。
- **写文件纪律**：AGENTS.md 照旧——Write/Edit 工具、可审查 diff；**APK 交付前必须问业主版本号**。

---

## 4. 风险登记（新增项；评估既有 R-01…R-07 继续有效）

| ID | 风险 | 触发信号 | 缓解 |
|---|---|---|---|
| RF-01 | 生成器对 zod v4 高级组合子（递归 lazy / 大 union / transform）支持不全 | `--check` 覆盖率 < 95% | 白名单 + 逐个补；fallback 映射为 `Map<String, Object?>` 并在生成物标注 TODO |
| RF-02 | 隐藏 WebView 内核宿主在 Flutter 里出现新的生命周期坑（切后台/内存回收） | 真机杀进程后恢复失败 | P1 出口判据已含；移植 background-survival 规格到 Flutter 宿主 |
| RF-03 | 12 桥经 JS↔Dart 双跳引入新延迟 | P1 实测桥往返 > 现状 +20% | 桥转发层做成可旁路：高频桥（ModelHttp/Fs）P4 起直连 Dart（评估 F-10 列的正收益清单） |
| RF-04 | 29 万行 UI 重写中期失去可用版本 | 主干长期不可用 | P0–P4 期间现有 WebView 线继续发布（roadmap 横幅已声明）；flutter-app 独立目录不污染现线 |
| RF-05 | 三端目标（P5）在 Android 未完成前提前分心 | P2/P3 未完就开始桌面 | 里程碑硬顺序；桌面/鸿蒙只在 P4 切换后启动 |

---

## 5. 治理

- 本计划取代 roadmap §6 Workstream D 的"原型验证"路径（D-02/D-03 不再执行）；roadmap A/B/C 照常。
- 每阶段完成：在本文件 §3 表格更新状态 + 追加完成记录（验收命令实际输出），做法与 roadmap §11 相同。
- 评估文档 F-01…F-15 是本计划的常量输入：引用时先核对 `git log -1`（R-01）。
