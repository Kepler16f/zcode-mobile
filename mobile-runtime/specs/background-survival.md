# 移动端：锁屏与切后台不掐断工作流

## 症状

锁屏或切后台回来，正在跑的那一轮模型请求被当成"网关卡死"而中止，用户看到的是"一锁屏工作流就没了"。

## 三条独立的切断路径与各自修法

### 1. 模型流空闲看门狗误杀（主因，纯 JS）

看门狗用 `setTimeout` 给"等首字节"与"帧间"各设一个上限；超时就 abort 掉请求。
Android WebView 在后台被冻结，`setTimeout` 不触发；回前台时积压的 timer **立刻**触发。

旧判据是"迟到要超过 3 倍窗口才赦免"，于是锁屏 30–120 秒回来（迟到 1–2 倍窗口）就被当成网关卡死 → abort。

改成**只看有没有迟到**：timer 晚点触发就说明页面被冻结或主线程被长时间阻塞，重新给满一窗；
真网关卡死发生在页面响应正常时，timer 准点响，照旧 abort。窗口 120s/90s 不变。
回归见 `mobile-runtime/build/idle-watchdog-smoke.mjs`（含"冻结 1.5 倍窗口仍不断"一条）。

### 2. 渲染进程被系统回收（原生）

后台/锁屏时系统可能回收 WebView 的渲染进程，正在跑的那一轮随之消失。
MainActivity 现在设置 `setRendererPriorityPolicy(RENDERER_PRIORITY_IMPORTANT, false)`：
告诉系统这个 WebView 很重要，不随可见性降级，尽量保住渲染进程。
渲染进程真死了仍有自愈路径（`onRenderProcessGone` → 原地重建 WebView），那一轮按"被打断"如实收口。

### 3. Activity 重建时原生任务被取消（原生）

命令与模型请求跑在原生侧，原先挂在 Activity 上；Activity 被重建时 `onDestroy` 会 cancelAll，
正在跑的任务被腰斩。现在这三个桥挂在**进程级**单例（`NativeBridges.kt`），
Activity 重建后拿到的是同一个桥，同一批任务继续跑完；`onDestroy` 不再取消它们。
渲染进程自愈重建（rebuildWebView）仍会取消那批已无人接收的任务——避免后台继续改文件。

## 仍然存在的边界

进程真被系统杀掉（低内存）时，JS 状态随之消失：会话从库里还原，该轮标记为"被打断"。
要跨进程续跑需要把这一轮的执行意图完整落盘并重放，属于独立特性，本次不做。
