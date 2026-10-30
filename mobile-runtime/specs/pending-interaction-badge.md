# 侧栏「等待确认」标识

侧栏任务行的「等待确认」来自会话摘要里的待确认投影（`pendingInteraction` 与
`pendingInteractionSummary`），不是任务索引里的持久字段。

## 两条数据来源

1. **sessions-index 摘要**（实时）：端侧 Agent 每次待确认状态变化都投一帧摘要。
2. **Controller 行投影**（桌面同款）：桌面 windowHostControllerService 把摘要投影成每行的
   `activity` 与 `pendingInteraction`（windowHostControllerService.ts:82-120）。端侧此前没有这一层，
   侧栏的实时态只能靠第一条兜底。

## 修法

- 端侧 Controller 补上同样的投影（mobile-runtime/ui/window-controller.ts），侧栏多一个实时来源。
- 待确认状态变化时，sessions-index **改投快照**而不是增量帧：快照不校验水位，
  中间丢一帧或水位漂移都不会让侧栏留着旧标识（用户报的就是"确认以后标识不消失"）。
  其余状态仍走增量帧，避免每次都投全量。
- 模式切到「完全访问」时兑现已经挂起的权限请求（原有行为，保留）。

## 验收

- `mobile-runtime/build/pending-badge-smoke.mjs`：挂起时摘要带待确认；确认后摘要不再带、计数归零。
- `mobile-runtime/build/pending-badge-e2e.mjs`：真实产物 + 真实审批弹窗，挂起时侧栏出现「等待确认」，
  点「允许这一次」后消失。
