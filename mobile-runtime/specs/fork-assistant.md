# 移动端会话分叉（forkAssistant）

桌面端已有 `forkAssistant` 命令（协议：`zcode/packages/shared/src/zcode-protocol-v4/command.ts`，
稳定边界裁决规则：`zcode/packages/shared/src/zcode-protocol-v4/fork.ts`）。移动端此前把
`availability.fork` 恒置为不可用，命令通路里也没有 `forkAssistant` 分支，UI 的分叉入口
（由 `row.actions.canFork` 驱动）永远不出现。

## 产品规则

- 分叉点只能是**已完成的助手回复**：目标行必须是 `assistantText`、状态 `complete`、
  带 `actions.canFork === true`，且是它所属轮次的**最后一段助手回复**。
- 分叉产出**独立子会话**：继承父会话的工作区、模型配置、压缩摘要与截至边界行的全部历史，
  行号在新会话里重新编号；父会话的状态与历史**完全不变**。
- 子会话可继续对话、可持久化、重启后可还原，并出现在侧栏会话索引里。
- 子会话首部插一条 `forkNotice` 标记行（指向父会话与父行号），父会话插一条 `forkCreated`
  标记行（指向子会话），两端都能看出分叉关系。
- 分叉是**会话内复制**：不停止父轮、不回滚工作区文件、不动父会话的队列。

## 状态所有者与事件顺序

`agent.ts` 的会话表是唯一所有者；子会话与普通会话走同一套注册、持久化、索引与订阅路径，
不另建一套存储。

```text
命令 forkAssistant(target)
  → 目标行定位（rowId + entityId 必须同时匹配）
  → 稳定边界裁决（compact 锁 → assistant-only → 目标稳定 → 边界唯一）
  → 复制 [1..边界行] 并重新编号 → 头部插 forkNotice
  → 注册子会话 → 落盘子会话 → 投进 sessions-index
  → 父会话插 forkCreated
  → ack accepted {type:"forkAssistant", sessionId:子会话 id}
```

## 幂等边界

同一 `commandId` 的重复 `forkAssistant` 必须返回**同一个**子会话（与桌面
`v4_command_fact:child:<parent>:<commandId>` 的语义一致），不得复制出第二条历史。
端侧以命令回执缓存（`commandResults`，键为 `sessionId\0commandId`）作为幂等事实。

## 失败语义

不满足条件时返回 `rejected`，reasonCode 取协议里的 guard 值，不静默、不半途创建子会话：

| 条件 | reasonCode |
| --- | --- |
| 上下文压缩进行中 | `guard.compactOperationLock` |
| 目标不是助手回复行 | `guard.forkAssistantOnly` |
| 目标未完成 / 不是本轮最后一段 / 缺少 `canFork` | `guard.forkTargetNotStable` |
| 目标行的边界标识缺失 | `guard.forkTargetAmbiguous` |

## 验收

- 合法分叉：子会话 id 与回执一致，子会话含父会话截至边界行的历史与 `forkNotice`，
  父会话行数与内容不变并多出一条 `forkCreated`。
- 拒绝路径：非助手行、未完成行、非本轮最后一段、压缩进行中，各自返回对应 guard。
- 子会话可继续发消息并落盘；重复同一 `commandId` 不产生第二个子会话。

## 与桌面的已知差异

- **revision CAS**：桌面 CLI 在命令准入处比对信封的 `baseRevision`，不一致即 stale。
  端侧命令通路整体不做 revision CAS（`switchModelConfig` 等同样如此），
  分叉的稳定性由上面那组 guard 承担；把 CAS 补到端侧属于命令通路的统一改造，不在本次范围。
- **稳定锚点**：桌面的锚点是 session store 里权威的 provider messageId 顺序；
  端侧没有那一层，边界用协议行自身的 `entityId` 表达，行号在复制时重新编号。

## UI 接线

分叉入口由 `row.actions.canFork` 驱动（`ConversationTurnGroup` 只在该格为 true 时
渲染入口，并把该轮的**最后一段**助手回复作为目标）。因此端侧在轮次收口时
给该轮最后一段已完成且有正文的助手回复盖上 `canFork`，其余助手行不带这格——
UI 不会把分叉按钮挂到中间段落上。
