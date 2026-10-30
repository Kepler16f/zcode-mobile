# 移动端 Git 面板与桌面对齐

面板与 Agent 的 Git 工具共用同一份 core VFS 与同一套 isomorphic-git 依赖。面板只补齐
面板自己的入口语义，不新建第二套 Git 引擎；网络动作仍由 `git-tool.ts` 拥有的传输层执行。

## 所有者

- **仓库状态所有者**：`git-state.ts` 的 `scanGitStates`（工作树/索引/HEAD 三棵树）与新增的
  `compareTrees`（两棵树之间的差异）。面板与工具都只读它的结果。
- **网络传输所有者**：`git-tool.ts` 的 `loadGitHttp`（原生 HTTP 桥 / 浏览器 fetch）与
  `pushGitBranch`。面板的推送与工具的 `action=push` 共用这一个实现，凭据处理也共用
  `parseRemoteUrl` / `authFrom`，不各自实现一套。
- **面板服务所有者**：`git-service.ts` 把上面两者组合成 `IGitService` 的各个方法。

## 行为

### 丢弃改动 `discardPaths`

- `staged=false`（丢弃未暂存改动）：工作树恢复为**索引**内容。索引里没有该文件
  （未跟踪文件、或已暂存删除）时报错并点名文件，不静默删除用户文件。
- `staged=true`（丢弃暂存改动）：索引恢复为 HEAD，工作树同时恢复为 HEAD；HEAD 里
  没有该文件（本次新加的文件）时删除工作树里的该文件，与桌面
  `git restore --source=HEAD --staged --worktree` 同义。
- 路径先经 `gitRelativePath` 归一到仓库内，越界与 `.git` 路径一律拒绝。

### 分支比较 `getBranchComparison`

- 基准是当前分支的上游（`trackingBranchName`）；没有上游时 `baseRef=null`、
  `changes=[]`、`comparisonLabel=null`，不编造比较对象。
- 比较范围是**共同祖先到 HEAD**（桌面 `git diff --numstat upstream...HEAD` 的三点语义）：
  先在两条提交历史里找最近的共同提交，找不到共同祖先时报错并说明原因。
- 差异按文件给出，`added`/`removed` 是行级增删计数，复用 `mobileGitDiff` 的行 diff，
  不另写一套行数统计。

### 提交信息生成 `generateCommitMessage`

- 端侧没有桌面的模型生成器，因此**本地生成**：只依据真实的暂存/未暂存改动（文件名与
  行级增删）拼出一条说明。不联网、不调用模型、不编造改动内容。
- 没有可提交的改动时报错，与桌面一致地拒绝生成空信息。
- 返回的 `providerId`/`model` 如实标注为本地生成，不冒充某个模型。

### 推送 `push`

- HEAD 处于游离状态（detached）时报错，不推一个匿名提交。
- 远端选择：已有上游时用上游所属远端；否则用唯一已配置远端；都没有时用 `origin`
  并在它不存在时报错列出可用远端。
- 只支持 HTTP(S) 远端（端侧没有 SSH 传输）。远端地址里的内嵌凭据只在本次使用，
  不写回配置；没有凭据且远端要求鉴权时如实报错，提示用 Git 工具传 username/password。
- 推送成功后：原先没有上游时写 `branch.<name>.remote` 与 `branch.<name>.merge` 建立
  上游关系（等价于桌面的 `--set-upstream`），并在返回里如实标注 `setUpstream`。

### 指定起点建分支 `createBranchAndSwitch`

- `startPoint` 可以是分支名、标签名或完整提交号；解析不到时报错并说明试过的引用。
- 解析成功时以该提交为起点建分支并切换；切换失败时删掉刚建的分支（不留半成品）。

## 失败语义

- 任何一步做不到都抛具体原因，绝不假装成功：非仓库、工作区不是本地目录（SAF 树）、
  远端不是 HTTP(S)、缺少凭据、没有共同祖先、目标引用不存在。
- 推送失败保留原始远端错误，但不得把凭据写进错误文案。

## 验收

`mobile-runtime/build/git-panel-smoke.mjs` 用真实 isomorphic-git 临时仓库覆盖：
丢弃未暂存改动、丢弃暂存改动（含新加文件被删除）、分支比较（共同祖先语义）、
本地提交信息生成、推送（含建立上游）与指定起点建分支；并断言失败路径给出具体原因。

```text
面板动作 → git-service（组合） → git-state（状态事实）/ git-tool（网络传输） → 仓库
```

## 已执行的验证

`mobile-runtime/build/git-panel-smoke.mjs`（真实 isomorphic-git 临时仓库）覆盖并通过：

- 丢弃未暂存改动：工作树回到索引内容；未跟踪文件明确报错且文件仍在（不被静默删除）。
- 丢弃暂存改动：索引与工作树一起回到 HEAD，本次新加的文件从工作树消失，暂存列表清空。
- 分支比较：没有上游时 `baseRef=null`；有上游时按**共同祖先**比较——远端独有的提交
  不出现在本地改动里，只有共同祖先之后的本地文件被列出（`section="branch"`、行级增删）。
- 本地提交信息：包含真实改动文件、标注本地来源；`currentSessionFilePaths` 生效（只描述
  本次会话碰过的文件）；没有改动时报错而不是生成空信息。
- 推送：对**真实本地 HTTP 服务**完成一次 git smart-HTTP 推送（广告 + side-band 响应），
  服务端确实收到请求体；原先没有上游时推送后建立上游（`branch.main.remote`/`.merge`），
  已有上游时不再声称建立；没有远端时报错并列出可用远端。
- 指定起点建分支：新分支落在指定提交上；不存在的起点返回 `ok=false` 并写明「找不到起点」。

同时通过：`git-smoke`、`tool-boundary-smoke`、`workspace-isolation-smoke`、`chat-smoke`（137/137）、
`capability-truthfulness-smoke`；移动端 tsc 通过；`oxlint` 对本次改动文件 0 warnings / 0 errors
（`git-tool.ts` 里 `createGitFs` 的未使用导入是本轮之前就存在的告警，未在本次改动范围内处理）。

## 仍未对齐的 Git 缺口

- 只支持 HTTP(S) 远端：端侧没有 SSH 传输，SSH 远端在面板与工具里都明确报错。
- 面板推送没有凭据输入框：只能用远端地址里已有的内嵌凭据；需要令牌时要用 Git 工具传
  username/password（面板按钮会如实报出鉴权失败）。
- 面板没有「生成提交信息」用的模型，端侧只做本地摘要式生成，质量低于桌面的模型生成。
- 分支比较的合并基取「两条历史里第一个公共提交」，极端拓扑下可能与 git 的 merge-base 有出入。
- worktree、submodule、符号链接仍未支持（Android 文件系统与 isomorphic-git 的限制）。
