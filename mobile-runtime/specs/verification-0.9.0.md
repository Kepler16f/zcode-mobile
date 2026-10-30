# 0.9.0 验证记录

## 0.9.1 增补（本轮：启动卡死、滑动卡顿、SAF 写回、Start Plan）

| 范围 | 验证 | 结果 |
| --- | --- | --- |
| 启动卡死 | startup-probe（真实 dist-ui，Chromium 393×851） | 建池 40.6s → 不建池 **7.5s**；Worker 数 4 → **0**；无页面脚本错误，最长长任务 596ms |
| 滑动卡顿 | 落盘写放大测量 | 每 5 秒检查点由「主表 + 全量用量投影」双写改为单写；投影只在收轮写一次（实测双写多 60% 耗时与一条 SQL） |
| SAF 本地别名 | saf-writethrough-smoke（同文件双路径夹具） | 修正上一轮错误双写：原生别名指向同一真实文件；追加一次、重命名/删除一次、Git 直写从旧路径可见；不再二次访问 SAF |
| Start Plan | boot-regression-smoke + start-plan/quota 冒烟 | 无凭据桥时公开套餐服务不再被 stubbed 列表覆盖；两账号域凭据链通过；真实领取资格仍待账号验证 |
| 高亮依赖 | assertShikiConsistency（构建期） | 模块图为单一自洽 3.23.0 集合（9 个包），混搭或 packages/ui 私有副本进图即构建失败 |
| 回归 | chat-smoke 137/137、usage-stats 13/13、task-mutate 11/11、runtime-reliability、mobile-090-smoke 3/3 | 全绿 |
| 工程 | typecheck（仓库 + 移动运行时）、oxlint（仓库口径 70 warnings / 0 errors）、架构检查 0 violations | 通过 |

未验证：真机启动耗时与滑动帧率（无真机）；Start Plan 的真实领取与消费（需真实账号）；「活动」条目内容依赖服务端 scenes 返回，本轮未做真机联网核对。

本轮使用用户确认的 Android 版本 0.9.0。Gradle assembleDebug 成功，versionCode 9000；沿用本地 debug 签名链，签名校验通过（v2）。APK 14,651,246 B，已交付到 `C:\Users\胡天泽\Downloads\aZCode-0.9.0.apk`，下载副本 SHA256 与构建产物一致。复制验证后自动清理 1 个旧版 aZCode 安装包。

SHA256：`6979BB8889A0924B9638BD0B51052848C66973038C0A5DF44D56E6869BED0A88`。

APK内entry.js、zcode-ui.css、diffs.worker.js及core bundle均与已测试文件哈希一致；59个KaTeX字体在包内，旧assets/www未进入包。完整记录见 `tmp/apk-090-verification.json`、`tmp/signature-090.log`、`tmp/gradle-090.log`。未执行Android真机安装。

| 范围 | 已执行的验证 | 结果与边界 |
| --- | --- | --- |
| 对话协议与压缩 | chat-smoke | 137/137 通过 |
| 用量归属 | usage-stats-smoke | 13/13；同会话换模型分别归属，缺少模型证据的历史不再用当前配置猜测 |
| 侧栏状态和子会话 | task-mutate-smoke | 11/11；无运行 owner 的旧 running 状态不再转圈，旧子会话不占普通列表与分页计数 |
| 旧 SAF 本地路径 | mobile-090-smoke、workspace-realpath-smoke、git-panel-smoke | 旧身份保持，实际文件/Git 路径映射到已验证的本地目录；越界仍拒绝。不能解析成真实目录的云盘继续使用 SAF |
| 记忆 | memory-mobile-smoke、runtime-reliability-smoke | 复用桌面目录、索引、设置服务；实际文件可列出和预览。开关控制模型上下文注入，工具获得同一记忆根 |
| 恢复 | runtime-reliability-smoke | 主会话及由父轮驱动的子会话均形成流中检查点；重启将未完成运行标记中断 |
| Start Plan | start-plan-mobile-smoke、quota-transport-smoke | 两账号域均使用 ZCode JWT；不误用 OAuth access token 或签发付费套餐 key。配置/场景服务和原生 HTTP 已接入；未使用真实官方账号验证领取资格、赠送结果及消费 |
| 桌面兼容版本 | server-compat-smoke、mobile-090-e2e | 设置真实持久化；只改写官方请求已有版本字段，可清空恢复默认。不会改写 APK 真实版本或生成虚构额度 |
| 触控界面 | 同一份 dist-ui 在 Chromium 中执行 mobile-090-e2e | 393×851 竖屏右抽屉、关闭、8 次长文本开关、851×393 横屏恢复、记忆/统计设置均通过；没有页面脚本错误。会话运行阶段最长主线程任务约 374 ms。没有 Android 真机长时间运行数据，不能据此认定所有机型的卡死已消除 |
| 数学与代码 | ui-assets-smoke、mobile-090-e2e | 59 个字体引用和文件一一对应；KaTeX 字体实际加载，公式渲染。代码高亮 Worker 正常输出语法 token，不再请求不存在的源码或被裁成空 Worker |

## 0.9.1 二次复查验证

- 新增统计读取与收轮并发、同毫秒保存回归：session-store 23/23，通过版本绑定避免新旧 JSON 混拼及旧投影覆盖。
- boot-regression-smoke：无凭据桥注册、正常启动移除动画、早期启动异常移除遮罩并显示失败页，全部通过。
- mobile-090-e2e：真实产物在桌面 Edge 的竖屏/横屏、子代理长文本与连续开关、KaTeX、代码高亮、记忆与应用统计界面全部通过；页面脚本错误 0，观测到最长任务 543 ms，仍不等于真机全程无卡顿。
- 对话 137/137；工作区真实路径、Git 面板、可靠性、用量、Start Plan、配额传输、输入恢复、原生异步桥及 APK 交付回归全部通过。
- 本轮重新执行仓库及移动类型检查通过；Lint 70 warnings / 0 errors；架构 0 violations。

## 资源核查

- 修复前 dist-ui：5,447 个文件，41,846,503 B；字节重复副本 224 个，额外占用 6,002,333 B；KaTeX 字体 0 个。
- 修复后（包含高亮 Worker）：5,163 个文件，33,416,094 B；字节重复副本 2 个，额外占用 2,285 B；KaTeX 字体 59 个。资源目录减少约 20.1%。
- 同名不同 hash 的文件不一定可以互相替代，不能把其总大小全称为冗余。移动构建统一 Shiki 依赖实例后，332 个语言 ID/别名、65 个主题与原 UI 依赖一致；未删被引用的 chunk。
- `src/main/assets/www` 已由 Gradle 的 assets sourceSets 排除，不进入 APK。真正交付的 UI 来自生成目录中的 dist-ui 副本。
- 高亮 Worker 与主界面处于同一个 splitting 构建，共享语言资源；构建检查会拒绝重复语言依赖根、缺失 CSS 资源及被 tree-shaking 裁掉的 Worker 消息处理器。

## 工程检查

- 仓库完整 typecheck、移动运行时 tsc 均通过。
- Lint：0 errors、70 warnings；本轮新增组件未引入新的 lint 错误。
- 架构检查：0 violations，baseline 0，new 0。
- 源码 freshness 检查发现当前 main 落后 origin/main 3 个提交；本轮保留已有移植工作树，没有自动合并上游版本更新。此项未记为通过。
- Android 真机未连接；上述交互验证使用 Chromium 和真实移动构建产物，原生桥由测试夹具替代的场景已单独标明。

## 0.9.1 安装包交付

用户确认版本 0.9.1；assembleDebug 成功，versionCode 9001。下载副本与构建产物 SHA256 一致：`008f362719186683d9f68462872e3e3decb6334a77af591b3122ed0601047dd2`。
APK 14,652,014 B，签名证书 SHA256 `3780e70fcf38bd759a502463dbdbd6b91140d0d43904ded2e9c7b65bf01e5dfe`，与 0.9.0 一致。复制验证后清理旧版 aZCode 包 1 个。包内 UI/core/CSS 与已测产物一致，59 个 KaTeX 字体齐全，未包含 assets/www。
代码提交 `bc8642c` 已推送并核对 origin/main。期间系统长暂停使 Gradle 墙钟耗时包含数小时暂停，不能用作正常构建耗时。

## 0.10.0 安装包交付

用户确认版本 0.10.0。新增能力：会话分叉、子代理后台执行与续接（含跨进程）、Git 面板
（丢弃改动/分支比较/提交信息/推送/指定起点建分支）、文件监视（轮询形态）。

- 构建：assembleDebug 成功，versionCode 9010，文件名 aZCode-0.10.0.apk。
- 交付前重压重签：条目按等级 9 重压 → zipalign → 同一 debug keystore 重新签名。
  重压前后条目数 5236 一致，逐条 CRC/大小/压缩方式一致（verify-repacked-apk）。
- 体积：17,138,665 B → **12,888,672 B**（省 4.25 MB；0.9.2 为 14,652,462 B）。
- 签名：v2 + v3，证书 SHA-256 `3780e70fcf38bd759a502463dbdbd6b91140d0d43904ded2e9c7b65bf01e5dfe`，
  与此前各版一致，可覆盖安装。
- 下载副本 SHA256 与构建产物一致：`11e2a0ff47a6d85d702d86d07a12545a32fea0d3e58b2d4a096afa015068aa01`。
- 包内：assets/ui 5163 个文件与 dist-ui 逐一对应，59 个 KaTeX 字体齐全，无 assets/www，
  entry.js / zcode-ui.css / core bundle 与已测产物哈希一致；zipalign 校验通过。
- 未验证：真机安装与运行（无真机）；Start Plan 真实领取与消费仍需官方账号。

验证：新增文件监视 12/12、会话分叉 19/19、子代理后台与续接 20/20（含跨进程续接）、
Git 面板（真实本地 HTTP 推送）；回归对话 137/137、会话存储 25/25、运行时可靠性、任务写链、
用量统计、工作区隔离、工具边界、Git 工具、移动端 090、SAF 写回、Start Plan、配额传输、
启动路径、真实路径、原生异步桥、APK 交付、输入恢复、MCP、Skills/Subagents、能力真实性全部通过；
界面回归 mobile-090-e2e 与 fork-ui-e2e 通过（分叉按钮 → 切到子会话 → 渲染派生来源标记）；
类型检查通过，Lint 70 warnings / 0 errors，架构 0 violations。

## 0.10.1 增补（弹窗主题、待确认标识、后台存活）

- 文件选择弹窗：新增 Theme.ZcodeMobile.Dialog.Dark/Light（Material 强制深浅），
  WorkspaceBridge 与 MainActivity 的原生弹窗改用 UIChromeBridge.dialogContext（读 zcode-ui-chrome/theme-dark）。
- 待确认标识：sessions-index 在待确认状态变化时改投快照；端侧 Controller 补上桌面同款的实时
  activity/pendingInteraction 投影。新增 pending-badge-smoke（6/6）与 pending-badge-e2e（3/3）。
- 后台存活：看门狗迟到判据改为「有没有迟到」（原为 3 倍窗口）；原生加 setRendererPriorityPolicy(IMPORTANT,false)；
  命令/Git/模型三个桥改为进程级单例（NativeBridges.kt），onDestroy 不再取消正在跑的任务。
  idle-watchdog-smoke 增补「冻结 1.5 倍窗口仍不断」一条（5/5）。
- 回归：对话 137/137、会话存储 25/25、分叉 19/19、子代理后台 20/20、Git 面板、文件监视 12/12、
  MCP、启动路径、用量 13/13、任务写链 11/11、界面回归 mobile-090-e2e 与 pending-badge-e2e 均通过；
  仓库与移动类型检查通过，Lint 70 warnings / 0 errors，架构 0 violations。

## 0.10.1 正式签名包（release）

- 版本名 0.10.1，versionCode 10001，APK 12,629,042 B。
- 签名：v2 + v3，证书 SHA256 `ee396b8368300c6aab74f89d22fb88c0dc739ba98d84499462bc1bc94eb56443`（CN=aZCode，与 0.8.0 release 同一证书）。
  **与此前交付的 debug 签名包（3780e70f…）不是同一张证书**：正式包不能覆盖安装在 debug 签名版上，
  需要先卸载旧版（会清掉应用私有目录里的会话与登录态）。
- SHA256 `827f823a25f8592f9b52b4c381923240c5ad2def2934e8804972bfc8d35e06fe`；下载副本与构建产物一致。
- 包内：assets/ui 与 dist-ui 逐一对应，59 个 KaTeX 字体齐全，无 assets/www；entry.js / zcode-ui.css /
  core bundle 与已测产物哈希一致。
- 交付到下载目录并清理了旧版 aZCode 包 1 个。

## CI（mobile-checks）修复

最近几次工作流**每次都红在同一处**：安装依赖步骤里多跑了一次
`pnpm --dir zcode/apps/zcode-cli install --frozen-lockfile`，而那份嵌套锁文件是旧的
（还带 vitest、缺 @withfig/autocomplete），于是 ERR_PNPM_OUTDATED_LOCKFILE。
根安装本来就覆盖全部 18 个工作区包，这一步纯属多余，已删除。
另外：超时 60 → 90 分钟（上游 core + web + 移动端三份 bundle 再加 APK 打包，本机就要 15–30 分钟）；
新增 11 条回归（会话存储、用量、任务写链、看门狗、文件监视、分叉、子代理后台、待确认标识、SAF 写回、MCP）；
CI 用的固定测试版本号同步到 0.10.1。

APK 重压任务也改成**永不失败**：缺 keystore、缺 build-tools、CI 环境一律跳过并记一行日志
（Exec 任务里 return 不等于跳过，必须放 onlyIf）。
