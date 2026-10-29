# 移动端 OAuth 待完成事务恢复

OAuthService 是待完成事务的唯一所有者。移动宿主仅持有可序列化快照，并通过凭据服务加密保存；桌面和 Web 未传持久化适配器时保持现有语义。

```text
授权开始 → OAuthService 建立 state/期限/可选轮询事务 → 移动宿主加密快照 → 打开浏览器
进程重建 → 读取快照 → OAuthService 验证并恢复 → 接收回调 → 原有 state 校验及兑换 → 清除快照
```

- 快照不包含计时器、Promise、令牌交换结果或 OAuth 访问凭据。轮询令牌属于短期秘密，必须由 `ICredentialService` 加密保存，不得写入日志。
- 还原只允许当前启用的 provider、有效 state 和不超过原会话有效期的事务；轮询地址由服务端点与 flow ID 重建，不信任快照中的任意 URL。
- 新授权、取消、退出和成功回调均清理或覆盖旧快照；过期或损坏快照不得恢复。回调仍由 OAuthService 比对 state 并保证单事务 completion。
- 以有效授权流程启动后的进程回收为范围；退出、错误 state、超时、重复回调、连续启动不同 provider 必须有回归。
