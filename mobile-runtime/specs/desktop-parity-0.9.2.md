# 0.9.2 桌面对齐复查

以当前检出的桌面端服务契约和移动执行链为准，不将工厂可打包等同于功能可执行。

基线：本地桌面源码 package.json 为 3.14.3，上游 origin/main 为 3.16.2，落后 3 个提交；freshness 检查因此失败，不能计为通过。本轮未合并上游。上游 diff 总计 13,512 个文件（包含大量第三方材料），需要单独的版本迁移及协议/依赖回归；本表比较当前检出版本，不宣称对齐最新桌面版。

## 本轮确认的问题与验收

1. 长会话恢复仍直接 SELECT 整段 state，Android CursorWindow 可能容纳不了多 MB 的单行。会话 store 是持久化唯一所有者；恢复按版本分块读取，保留完整正文与摘要，不裁剪。测试模拟单行大小限制，验证多 MB 往返。
2. Git refresh 先为 summary 扫工作树，再为 changes 扫第二次；扫描 Promise 链不能保证浏览器获得绘制机会。一次 refresh 共用一个扫描快照，遍历按时间预算让出事件循环。测试断言只扫描一次及长目录扫描期间心跳能运行。
3. MCP 工作区连接随会话/设置增长而保留，disposeWorkspace/disposeAll 未释放；过期的异步连接可能在释放后重新挂回。运行时拥有连接，Agent 生命周期只调用其释放接口；释放令 workspace 状态失效并移除，迟到结果必须关闭。测试在配置加载与连接过程释放后无旧工具、旧状态和可调用连接。
4. 旧能力文档与实际 Skills/MCP/Subagents 接入不一致。按实际入口更新缺口表；不把未实现能力表述为已对齐。
5. MCP 的 Web fetch 分支没有落实已有的禁止重定向契约，可能将自定义认证头发送到跳转目标。原生桥保留同源限制，Web fallback 明确使用 redirect:error；用两个本地测试端点验证目标收不到请求。

```text
Agent workspace dispose → MCP owner retire generation → abort/close connections
                                                └→ late connect result → close, never publish
Git refresh → one scan snapshot → summary + staged/unstaged views
Session store → metadata/version → bounded chunks → complete persisted state
```

## 能力矩阵（源码核查）

| 能力 | 移动端现状 | 桌面对齐缺口 |
| --- | --- | --- |
| 对话与多供应商 | 流式、工具、取消、排队、恢复、手动/自动摘要压缩已接入 | fork、goal 暂停/恢复等仍明确禁用 |
| Skills / Subagents | 配置发现与编辑、技能注入、前台子代理、侧栏预览已接入 | 后台子代理、resume、独立 MCP server、部分工具条件模式尚不支持 |
| MCP | HTTP Streamable、认证头、工具发现/执行、设置导入导出 | stdio、旧 SSE、OAuth、资源/提示词及非文本结果未全面接通 |
| 文件与工作区 | 本地文件、路径边界、旧 SAF 主卷别名、文件附件 | 云盘 SAF 的 Git/Bash 被禁用；文件监视服务尚未接通 |
| Git | 状态、差异、分支切换、暂存/撤销暂存/丢弃改动、提交、分支比较、推送、本地提交信息、指定起点建分支、Agent HTTP 远端工具 | 面板 push 缺凭据输入（只能用远端地址内嵌凭据）；提交信息只做本地摘要式生成；worktree/submodule/SSH/符号链接未对齐 |
| 授权与 Hook | 模式切换、审批交互、原生命令、.zcode Hook trust | legacy Hook 配置、桌面 CUA 权限未接通 |
| 账号与用量 | 本地 token 聚合、官方套餐/活动服务与原生网络传输 | 真实 Start Plan 领取、资格判定及消费尚无账号端验证 |
| 文件监视 | 已接通（轮询签名，页面不可见时停摆） | SAF 子文件内容改动检测不到；递归监视有上限 |
| 其他桌面宿主能力 | 移动文件选择、浏览器工具、原生存储 | 交互终端（依赖 PTY）、远程 workspace、Docker/WSL/SSH 宿主、插件市场/同步、分享、Bots、闲时任务等尚未接通；按用户要求，依赖桌面宿主的能力（Docker/WSL 等）本阶段不做 |

不支持项保留明确的能力边界；本轮不宣称实现全部桌面宿主能力。

## 已执行的验证

- session-store：25/25，含模拟 CursorWindow 大小限制、多 MB 中文/emoji 完整恢复，以及分块读取/收轮并发。
- Git：真实 isomorphic-git 文件系统回归通过；一次 refresh 的 walk 调用计数为 1，扫描期间事件循环心跳可运行。
- MCP：本地真实 HTTP 握手/分页/认证/工具调用/取消通过；释放后迟到配置不会建连，旧工具不可再用；双端点重定向测试确认目标请求数为 0。
- runtime-reliability、Skills/Subagents、能力真实性、工作区隔离、用量回归通过；Agent 的 workspace/global disposal 已验证转发到连接所有者。
- mobile-090-e2e：真实 0.9.2 前端产物的抽屉/长子会话/公式/高亮/设置回归通过，脚本错误 0，本机桌面 Edge 观测最长主线程任务 262 ms。该数据不等于 Android 真机帧率。
- 仓库与移动类型检查通过；Lint 70 warnings / 0 errors；架构检查 0 violations。freshness 如上所述未通过。

## 尚需后续验证或实现

- Android 真机长时间运行、低内存机型和系统前后台切换仍需设备数据。
- Start Plan 真实领取/消耗与服务端活动资格没有可用于验证的已登录官方账号，不伪造成功。
- 长会话恢复已避免 CursorWindow 超限，但最终 JSON 解析和时间线水合仍在主线程，大历史仍有优化空间。
- 连接生命周期修复不补齐 MCP stdio/OAuth，也不改变单层前台子代理限制。

## 0.9.2 安装包交付

用户确认版本 0.9.2；assembleDebug 成功，versionCode 9002。下载副本与构建产物 SHA256 一致：
`179cc37b1444e54334d4241f280b6062606a865ead71dbcd94895c8d490ac646`，APK 14,652,462 B。
签名证书 SHA256 `3780e70fcf38bd759a502463dbdbd6b91140d0d43904ded2e9c7b65bf01e5dfe`（与前版一致）。
复制校验后清理旧版 aZCode 包 1 个；包内 UI/core/CSS 与已测产物一致，59 个 KaTeX 字体齐全，未包含 assets/www。

## 0.10.0 补齐（用户确认版本 0.10.0）

本轮补齐的是 Android 上**能真正落地**的能力。依赖桌面宿主的能力（Docker/WSL/SSH 宿主、远程
workspace、交互终端 PTY）按用户要求本阶段不做，也不假装已实现。

| 能力 | 状态 | 语义与边界 |
| --- | --- | --- |
| 会话分叉 forkAssistant | 已接通 | 只允许已完成助手回复作为分叉点；子会话继承历史并独立编号、可续聊、可还原；父会话不变。压缩进行中/非助手行/非本轮最后一段按协议 guard 拒绝 |
| 子代理后台执行 | 已接通 | 父轮不等子代理，工具调用立即返回；后台子代理仍走父轮模式与审批；父轮停止/工作区释放/全局释放都会收掉它；结果回填父会话 |
| 子代理续接 resume | 进程内已接通 | 沿用同一子会话与 transcript（含上次结论）；**进程重启后不可续接**（端侧未把子代理 transcript 落盘），此时明确报错而不是新开一个假装续接的子代理 |
| Git 面板丢弃改动 | 已接通 | 未暂存回到索引；暂存与工作树一起回到 HEAD；未跟踪文件无可恢复基准时明确报错且不删用户文件 |
| Git 分支比较 | 已接通 | 三点语义（共同祖先到 HEAD）；无上游或无共同祖先时不编造基准 |
| Git 提交信息生成 | 已接通（本地） | 端侧无模型生成器，按真实 diff 本地生成摘要式提交信息，不联网、不编造；providerId 如实标为 mobile-local-git |
| Git 推送 | 已接通 | 复用原生 HTTP 桥与工具的同一套凭据/远端解析；无上游时建立上游；游离 HEAD/无远端/非 HTTP(S) 远端明确报错；凭据不写回配置 |
| 指定起点建分支 | 已接通 | 起点可为分支名/标签/提交号；找不到时报错；切换失败回滚刚建的分支 |
| 文件监视 | 已接通（轮询） | 桌面用 fs.watch，Android 无 inotify，改用有上限的轮询签名；本地盘一次 readdir + 一次批量 statMany；SAF 只报增删改名；页面不可见时停摆 |

### 仍然未对齐（下一批候选）

- 子代理自带独立 MCP server（需给工具引擎加按 profile 追加连接的接口）。
- 子代理工具条件模式（如 Bash(git status)）：桌面判据在 CLI 侧，需单独对齐。
- 子代理 transcript 落盘：跨进程续接的前置。
- Git：仅 HTTP(S) 远端；面板无凭据输入框；worktree/submodule/符号链接未支持。
- 端侧命令通路整体不做 revision CAS（分叉稳定性由 guard 承担，属命令通路的统一改造）。
- 服务器侧能力（分享、Bots、闲时任务、插件/技能云同步、反馈工单）与认证凭据强相关，
  端侧尚未接通真实账号链路。

### 本轮验证

- 新增：文件监视 12/12、会话分叉 19/19、子代理后台 16/16、Git 面板（含真实本地 HTTP 推送）。
- 回归：对话 137/137、会话存储 25/25、运行时可靠性、任务写链、用量统计、工作区隔离、
  工具边界、Git 工具、移动端 090、SAF 写回、Start Plan、配额传输、启动路径、真实路径、
  原生异步桥、APK 交付、输入恢复、MCP、Skills/Subagents、能力真实性，全部通过。
- 界面回归（真实产物 + 真实 mock 网关）：mobile-090-e2e 通过（脚本错误 0，最长主线程任务 249 ms）；
  fork-ui-e2e 通过（分叉按钮出现、点击后切到子会话并渲染派生来源标记）。
- 仓库与移动类型检查通过；Lint 70 warnings / 0 errors；架构检查 0 violations。
