# 子代理会话预览

- Agent 工具通过同轮 parentToolCallId 关联一条成功/失败/取消收口的 subagent 行，其中 childSessionId 指向同工作区的真实子会话。
- 子会话由移动端 Agent 服务拥有，回复和工具结果经标准 conversation 订阅及 SQLite 持久化提供给共享的右侧面板。
- 子会话自身的 conversation rows 包含 Agent 提示、assistant 回答和子工具调用/结果；父行只承载子会话链接与状态，不重复展示子工具行。
- 子代理执行工具仍经过父会话的 Hook、权限模式和审批链；预览不能成为绕过授权的新入口。
- 结束、失败、取消更新父子状态。进程重启后，未结束的子代理标为取消，不保留虚假的运行动画；结束的子会话应从持久化恢复。
- 验收：Agent 结果产生成功状态的父 subagent 行与 childSessionId；按 childSessionId 的 conversation 订阅可读取提示、回答和成功工具记录；关闭后重订阅以及进程重启后仍可读取；跨工作区订阅应被拒绝。

事件顺序：

```text
父模型 Agent tool call
  → 创建并持久化 child session + 父 subagent link
  → 子模型与子工具循环（工具行写入 child timeline）
  → 收口 child turn + 父 link 状态
  → conversation/<childSessionId> snapshot/resume 供预览订阅
```

集成冒烟由 `mobile-runtime/build/chat-smoke.mjs` 执行，沿用真实 RPC transport、ConversationProjectionStore 和共享 session store，验证父行链接、子 timeline、workspace 边界、重订阅和重启恢复。
