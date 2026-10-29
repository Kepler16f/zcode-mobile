// ExecutionPort 的端侧实现。
// 桌面版这里对应 child_process；移动端只有一个窄得多的现实：
//   - 纯 WebView（鸿蒙一期 / Android 未接原生桥）：没有 shell，必须返回结构化失败，不能假装成功。
//   - Android 接了原生桥（§2.1 的 L1/L2）：把 argv/shell 请求转给 Kotlin 侧的 execve。
// 契约见 contracts/src/interfaces/execution.port.ts。
const NO_BRIDGE_MESSAGE =
  "当前宿主没有执行能力：端侧 shell 需要原生执行桥（Android: nativeLibraryDir execve + /system/bin/sh）。" +
  "这不可以通过 JS 绕过，请改用只依赖文件系统的工具。";

function stream(text, maxBytes) {
  const bytes = new TextEncoder().encode(text);
  const truncated = bytes.length > maxBytes;
  return {
    text: truncated ? new TextDecoder().decode(bytes.subarray(0, maxBytes)) : text,
    bytes: bytes.length,
    truncated,
  };
}

export function createMobileExecutionPort(deps = {}) {
  const bridge = deps.bridge ?? null;

  function fail(error, startedAt) {
    const now = new Date();
    return {
      status: error.type === "cancelled" ? "cancelled" : error.type === "timeout" ? "timed_out" : "spawn_error",
      stdout: stream("", deps.maxInlineBytes ?? 64 * 1024),
      stderr: stream("", deps.maxInlineBytes ?? 64 * 1024),
      durationMs: Math.max(0, Math.round(now.getTime() - startedAt.getTime())),
      timedOut: error.type === "timeout",
      cancelled: error.type === "cancelled",
      startedAt,
      completedAt: now,
      error,
    };
  }

  return {
    async run(request, options = {}) {
      const startedAt = new Date();
      if (options.signal?.aborted) {
        return fail({ type: "cancelled", message: "执行前已被取消" }, startedAt);
      }
      if (!bridge) return fail({ type: "spawn_error", message: NO_BRIDGE_MESSAGE }, startedAt);

      const command = request.command ?? {};
      const spec =
        command.mode === "argv"
          ? { shell: false, file: command.file, args: command.args ?? [] }
          : command.mode === "shell"
            ? { shell: true, file: command.shell ?? "/system/bin/sh", command: command.command }
            : null;
      if (!spec) {
        return fail({ type: "spawn_error", message: `未知的命令形态: ${command.mode}` }, startedAt);
      }

      let raw;
      try {
        raw = await bridge.exec({
          ...spec,
          cwd: request.cwd,
          env: request.env,
          stdin: request.stdin,
          timeoutMs: request.timeoutMs,
          // 把运行期间的取消传到原生任务；旧桥仅保留启动前取消语义。
          signal: options.signal,
        });
      } catch (e) {
        const message = String(e?.message ?? e);
        const type = options.signal?.aborted ? "cancelled" : /timeout/i.test(message) ? "timeout" : "spawn_error";
        return fail({ type, message, cause: e }, startedAt);
      }

      const now = new Date();
      const maxInline = deps.maxInlineBytes ?? 64 * 1024;
      options.onEvent?.({ type: "started", pid: raw.pid, timestamp: startedAt });
      if (raw.stdout) options.onEvent?.({ type: "stdout", chunk: new Uint8Array(0), text: raw.stdout, timestamp: now });
      // durationMs 是端口契约（ExecutionResult）的必填字段，先按契约算好。
      const durationMs = Math.max(0, Math.round(now.getTime() - startedAt.getTime()));
      const result = {
        status: raw.timedOut ? "timed_out" : raw.cancelled ? "cancelled" : raw.exitCode === 0 ? "completed" : "failed",
        exitCode: raw.exitCode,
        // ExecutionResult.signal 契约是 string 可选：桥没信号就缺省。这里兜一层，
        // 任何桥回 signal:null 都不许把空值带进 core（0.4.5 的 BashOutputSchema strict
        // 拒载就是 null 一路从 Android 桥透传到 toBashOutput 的输出对象上）。
        signal: typeof raw.signal === "string" ? raw.signal : undefined,
        stdout: stream(raw.stdout ?? "", maxInline),
        stderr: stream(raw.stderr ?? "", maxInline),
        durationMs,
        timedOut: Boolean(raw.timedOut),
        cancelled: Boolean(raw.cancelled),
        startedAt,
        completedAt: now,
        pid: raw.pid,
        resolvedCwd: raw.resolvedCwd,
      };
      options.onEvent?.({ type: "completed", result, timestamp: now });
      // 端口回包严格照 ExecutionResult 契约（含 pid/durationMs/resolvedCwd，m1-run 的端口断言查的就是它们）。
      // 0.4.5 曾在回包剥字段想让 Bash 过 core 的 strict BashOutputSchema，实测无效且违约，已回退；
      // 当时把真凶记成 toBashOutput 挂的 perf 遥测——node_repl 直喂真 schema 复现证明 perf parse 通过，
      // 唯一拒载是 signal:null（桥的空值透传）。见 execution-bridge-android.mjs 与 tool-engine.ts。
      return result;
    },
  };
}
