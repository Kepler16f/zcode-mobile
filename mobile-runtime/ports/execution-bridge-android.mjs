// ExecutionPort 的 Android L1 桥：把 core 的执行请求转给 Kotlin 侧的 ExecBridge。
// 真机实测这条能力是成立的（OPD2511 / Android 16：/system/bin/sh 起得来，105 ms，toybox 可用），
// 所以这里不是"预留接口"，是把已经证明能用的东西接上。
//
// 只走一条窄通道：zcodeExec.exec(JSON 字符串) → JSON 字符串。参数不经过 shell 拼接
// （argv 形态在 Kotlin 侧直接 ProcessBuilder(list)），所以模型写什么参数都变不成另一条命令。
import { callNativeJob, hasNativeJobs } from "./native-async.mjs";

export function isNativeExecAvailable() {
  return hasNativeJobs(globalThis.zcodeExec) || typeof globalThis.zcodeExec?.exec === "function";
}

const DEFAULT_TIMEOUT_MS = 60_000;

export function createNativeExecBridge() {
  const raw = globalThis.zcodeExec;
  if (!isNativeExecAvailable()) return null;

  return {
    async exec(request) {
      const payload = {
        useShell: Boolean(request.shell),
        file: request.file,
        args: request.args ?? [],
        timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      };
      // shell 形态只把整串交给 `sh -c`，argv 形态只给 file+args，两边不会互相污染。
      if (request.shell) payload.command = request.command;
      if (request.cwd) payload.cwd = request.cwd;
      if (request.env) payload.env = request.env;
      if (request.stdin) payload.stdin = request.stdin;

      // 新版桥在原生后台线程执行；旧版宿主保留同步调用，避免升级 JS 后旧壳立即失效。
      const result = hasNativeJobs(raw)
        ? await callNativeJob(raw, payload, request.signal)
        : JSON.parse(raw.exec(JSON.stringify(payload)));
      if (result.error) throw new Error(result.error);
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode,
        timedOut: Boolean(result.timedOut),
        cancelled: Boolean(result.cancelled),
        // 契约（contracts ExecutionResult.signal 与 BashOutputSchema.signal）都是 string **可选**，
        // 没有信号=键缺省；Kotlin 桥不报 signal，曾经这里硬编码 `signal: null`——core 的 toBashOutput
        // 把它原样搬进 Bash output，strict 的 BashOutputSchema.safeParse 就炸在 signal: null
        //（"Expected string, received null"），Bash 每条输出以 schema 拒载失败（0.4.5 误记为 perf 遥测
        // 不合 schema；node_repl 直喂真 schema 复现：perf parse=true，signal 是唯一 issue）。
        // null 一律折叠成"没有这个字段"。
        signal: typeof result.signal === "string" ? result.signal : undefined,
        pid: result.pid,
        resolvedCwd: result.resolvedCwd,
        durationMs: result.durationMs,
      };
    },
  };
}
