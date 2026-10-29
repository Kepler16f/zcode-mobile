# 侧栏任务状态与动画

## 规则与所有者

- 当前状态只由对应 workspace 的 sessions-index `SessionSummary.phase` 提供。tasks-index 的 `status=running` 是持久化历史，不足以证明当前仍在运行。
- leading indicator 按 `error > loading > unread > none` 显示。`prewarming` 和 `running` 显示旋转图标；成功或中断停止旋转；失败显示错误点。运行中的未读任务优先显示运行动画。
- workspace 身份键为 `workspaceIdentity?.trim() || workspacePath`。不同 workspace 的同名 session 不共享列表项或 activity。

## 状态顺序

```text
sessions-index snapshot/delta
  → 按 workspace scope 聚合 SessionSummary
  → 映射 phase + activity sidecar
  → 与 tasks-index membership 合并（保留 activity）
  → leading indicator：error > loading > unread > none
```

## 验收

- `prewarming`、`running` 即使带 `unreadAt` 也显示 loading。
- `error` 优先显示错误；`completedSuccess`、`completedInterrupted` 不再旋转，并按未读标记显示 unread 或 none。
- 没有当前 activity 时，持久化 `status=running` 不显示 loading。
- 相同 sessionId 位于不同 workspace 时身份键不同。
- `mobile-runtime/build/chat-smoke.mjs` 覆盖以上纯状态投影场景。
