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
