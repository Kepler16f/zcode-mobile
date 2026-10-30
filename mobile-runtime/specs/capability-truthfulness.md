# 移动端能力与设置页

移动 Agent 与工具引擎拥有可执行能力；配置扫描结果不是执行能力。组合根必须按实际运行时注册服务，不能因为上游工厂能被打包就把其全部设置作为可用能力暴露。

- Skills、Subagents 已有设置服务与移动运行时消费链，具体范围见 skills-subagents.md。后台子代理、续接、独立 MCP 配置等未实现部分仍明确拒绝，不得保存后假称已执行。
- MCP 已接入 HTTP 连接、工具注册、配置读写和导入导出，见 mcp-runtime.md。stdio、旧 SSE 和 OAuth 等缺口必须明确显示，不得用空状态掩盖失败。
- 内置 Browser 是工具引擎真实消费的能力。开关的事实源是持久化值；写入失败必须报错，不发成功事件。没有 Browser 原生桥时列表显示禁用，开启请求明确报错。市场和插件操作明确不可用。
- Hook 继续使用已有移动执行器及其 trust authority。设置页的 trust 请求必须接入真实 Agent，不能交给占位服务。移动执行器只支持 .zcode 来源，legacy .agents/.claude 配置不能在设置页伪装成可执行项目；保存也拒绝这些来源。缺少原生命令桥时 Hook 服务明确不可用。

```text
设置页 → 组合根能力边界 → 移动 Agent / 工具引擎 → 同一配置或 trust store
                └→ 尚未接入：EUNSUPPORTED → 页面错误和启动诊断
```

验收：Skills/Subagents/MCP 已接入部分读写及运行时一致，未支持配置报错且原因可见；Hook trust 调用真实 authority、仅保留 .zcode 来源；Browser 开关写入失败不报告成功，无桥不能开启，有桥时与引擎读取一致。
