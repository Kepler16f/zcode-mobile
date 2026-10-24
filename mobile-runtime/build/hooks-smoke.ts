// 端侧钩子链路自检（0.7.1，用户点名"钩子未接入，请接入"）。只在 Node 里跑，不进 APK。
//
// 判据（每条都是"钩子真的跑起来了"的一个具体形态，不是内部指标）：
//   1. 未信任的项目级 hook 不执行（fail-closed，与桌面同判据）——命令会被 touch 一个标记文件，
//      标记不存在 = 那条命令没有被执行过。
//   2. grantWorkspaceHookTrust 把声明摘要写进 trust store；新装配的 runtime 读到信任后执行。
//   3. matcher 真的按工具名过滤（PreToolUse matcher=Bash 在 Read 的调用上不跑）。
//   4. permissionDecision=deny 透传（additionalContext / 阻断原因都能读出来）。
//   5. 退出码 2 = 阻断（Stop 事件上表现为"拦住继续"），且第二次不再拦（stopHookActive 语义的
//      最小样本：钩子自己用标记文件记住"我已经叫过一次了"）。
//   6. 生命周期事件齐（hook_run_started/completed + hookInvocationId/hookEventName），
//      时间线的 hookInvocation 行就是拿它投影的。
//
// 执行面：真命令、真 shell（Git Bash 的 bash 起 `/bin/sh -c`），桥是 Node 版的假 zcodeExec——
// 形状与 Android 的 ExecBridge 契约逐字一致（见 ports/execution-bridge-android.mjs 的 payload）。
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMobileHookRuntime, grantWorkspaceHookTrust } from "../ui/hooks-mobile.js";
import { createConfiguredHookRunner } from "../../zcode/apps/zcode-cli/packages/core/src/hooks/configured-runner.js";
import { createMobileExecutionPort } from "../ports/execution.mjs";
import { createNativeExecBridge } from "../ports/execution-bridge-android.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = path.join(here, ".tmp-hooks-ws");
const ws = path.join(base, "ws");
const home = path.join(base, "home");

const M_UP = path.join(base, "mark-userprompt");
const M_TOOL = path.join(base, "mark-pretool");
const M_READ = path.join(base, "mark-pretool-read");
const M_STOP = path.join(base, "mark-stop");

function reset() {
  rmSync(base, { recursive: true, force: true });
  mkdirSync(path.join(ws, ".zcode"), { recursive: true });
  mkdirSync(path.join(home, ".zcode", "cli"), { recursive: true });

  // 项目级（工作区）：UserPromptSubmit 注入上下文；PreToolUse 只挂 Bash（验证 matcher 过滤）。
  // 全部先写 enabled:true —— 与设置页保存的形状一致。
  writeFileSync(
    path.join(ws, ".zcode", "config.json"),
    JSON.stringify(
      {
        hooks: {
          enabled: true,
          events: {
            UserPromptSubmit: [
              { hooks: [{ type: "command", command: `touch "${M_UP}" ; echo '{"additionalContext":"来自项目级 UserPromptSubmit 的上下文"}'` }] },
            ],
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [
                  {
                    type: "command",
                    command: `touch "${M_TOOL}" ; echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"项目级钩子拦下了这条命令"}}'`,
                  },
                ],
              },
            ],
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  // 用户级（端侧 home）：不经信任审核。Stop 钩子第一次拦、第二次放（标记文件当记忆）。
  writeFileSync(
    path.join(home, ".zcode", "cli", "config.json"),
    JSON.stringify(
      {
        hooks: {
          enabled: true,
          events: {
            Stop: [
              {
                hooks: [
                  {
                    type: "command",
                    command: `if [ -f "${M_STOP}" ]; then echo '{}'; else touch "${M_STOP}" ; echo '{"decision":"block","reason":"活儿还没干完"}'; fi`,
                  },
                ],
              },
            ],
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

/** Node 版假执行桥：契约 = zcodeExec.exec(JSON) → JSON（与 Android ExecBridge 同形状）。 */
function installFakeExecBridge() {
  const bash = process.env.ZCODE_SMOKE_BASH ?? "C:/Program Files/Git/bin/bash.exe";
  (globalThis as { zcodeExec?: unknown }).zcodeExec = {
    exec(payloadJson: string): string {
      const req = JSON.parse(payloadJson) as {
        useShell?: boolean;
        command?: string;
        file?: string;
        args?: string[];
        cwd?: string;
        env?: { set?: Record<string, string> } | Record<string, string>;
        stdin?: string;
        timeoutMs?: number;
      };
      const envSet = (req.env as { set?: Record<string, string> })?.set ?? (req.env as Record<string, string>) ?? {};
      const startedAt = Date.now();
      try {
        const out = req.useShell
          ? execFileSync(bash, ["-c", req.command ?? ""], {
              cwd: req.cwd,
              env: { ...process.env, ...envSet },
              input: req.stdin ?? "",
              timeout: req.timeoutMs,
              encoding: "utf8",
              stdio: ["pipe", "pipe", "pipe"],
            })
          : execFileSync(req.file ?? "", req.args ?? [], {
              cwd: req.cwd,
              env: { ...process.env, ...envSet },
              input: req.stdin ?? "",
              timeout: req.timeoutMs,
              encoding: "utf8",
              stdio: ["pipe", "pipe", "pipe"],
            });
        return JSON.stringify({
          stdout: String(out ?? ""),
          stderr: "",
          exitCode: 0,
          durationMs: Date.now() - startedAt,
        });
      } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string; message?: string };
        return JSON.stringify({
          stdout: typeof err.stdout === "string" ? err.stdout : "",
          stderr: typeof err.stderr === "string" ? err.stderr : String(err.message ?? e),
          exitCode: typeof err.status === "number" ? err.status : 1,
          durationMs: Date.now() - startedAt,
        });
      }
    },
  };
}

async function main() {
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });
  reset();
  installFakeExecBridge();

  const loadCore = async () => ({
    createConfiguredHookRunner,
    createMobileExecutionPort,
    createNativeExecBridge,
  });
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

  try {
    // ── 判据 1：未信任的项目级 hook 不执行 ──
    const untrusted = await createMobileHookRuntime({
      workspacePath: ws,
      homeDir: home,
      loadCore,
      onLifecycleEvent: (e) => events.push(e as never),
    });
    check("没有配置时 runtime 也装得起来（有 hook 才会有 runner）", untrusted !== null, String(untrusted));
    const upUntrusted = await untrusted!.run("UserPromptSubmit", {
      sessionId: "s1",
      turnId: "t1",
      cwd: ws,
      prompt: "你好",
    });
    check(
      "未信任：项目级 UserPromptSubmit 没执行（标记文件不存在）",
      !existsSync(M_UP),
      `marker=${existsSync(M_UP)}`,
    );
    check(
      "未信任：也没有上下文注入（不装成跑过）",
      (upUntrusted.additionalContexts ?? []).length === 0,
      JSON.stringify(upUntrusted),
    );
    const blockedEvents = events.filter((e) => e.type === "hook_run_blocked");
    check(
      "未信任被如实投影成 hook_run_blocked（生命周期里有这条）",
      blockedEvents.length >= 1 &&
        String(blockedEvents[0]?.payload?.blockReason ?? "").includes("blocked_untrusted"),
      JSON.stringify(blockedEvents.slice(0, 2)),
    );

    // ── 判据 2：预信任 → 新 runtime 读到信任 → 执行 ──
    const snapshot = untrusted!.snapshot as {
      bundleDigest: string;
      hooks: Array<{ hookDeclarationDigest: string; event: string }>;
    };
    const upEntry = snapshot.hooks.find((h) => h.event === "UserPromptSubmit");
    const preEntry = snapshot.hooks.find((h) => h.event === "PreToolUse");
    check(
      "快照里有 UserPromptSubmit / PreToolUse 两条（信任的目标）",
      Boolean(upEntry) && Boolean(preEntry),
      JSON.stringify(snapshot.hooks.map((h) => h.event)),
    );
    const granted = await grantWorkspaceHookTrust({
      workspacePath: ws,
      bundleDigest: snapshot.bundleDigest,
      hookDeclarationDigest: upEntry!.hookDeclarationDigest,
      homeDir: home,
    });
    check("grantWorkspaceHookTrust 接受（写进端侧 trust store）", granted.accepted === true, JSON.stringify(granted));
    check(
      "trust store 文件落在端侧 home（与 hooksService 读的同一份）",
      existsSync(path.join(home, ".zcode", "security", "workspace-hook-trust-v1.json")),
      path.join(home, ".zcode", "security", "workspace-hook-trust-v1.json"),
    );
    // 只信任了 UserPromptSubmit 一条：PreToolUse 仍是未信任 —— 先跑一遍，标记必须不存在。
    const preStillBlocked = await createMobileHookRuntime({
      workspacePath: ws,
      homeDir: home,
      loadCore,
    });
    await preStillBlocked!.run(
      "PreToolUse",
      { sessionId: "s1", turnId: "t1", cwd: ws, toolName: "Bash", toolInput: { command: "ls" }, toolCallId: "tc-0" },
      { matchValues: ["Bash"] },
    );
    check(
      "逐条信任：没被信任的 PreToolUse 依然不执行（声明级 fail-closed）",
      !existsSync(M_TOOL),
      `marker=${existsSync(M_TOOL)}`,
    );
    const preGranted = await grantWorkspaceHookTrust({
      workspacePath: ws,
      bundleDigest: snapshot.bundleDigest,
      hookDeclarationDigest: preEntry!.hookDeclarationDigest,
      homeDir: home,
    });
    check("第二条（PreToolUse）也信任成功", preGranted.accepted === true, JSON.stringify(preGranted));

    events.length = 0;
    const trusted = await createMobileHookRuntime({
      workspacePath: ws,
      homeDir: home,
      loadCore,
      onLifecycleEvent: (e) => events.push(e as never),
    });
    const upTrusted = await trusted!.run("UserPromptSubmit", {
      sessionId: "s1",
      turnId: "t1",
      cwd: ws,
      prompt: "你好",
    });
    check("信任后：命令真的执行了（标记文件存在）", existsSync(M_UP), `marker=${existsSync(M_UP)}`);
    check(
      "信任后：additionalContext 透传回来（进系统提示的那段）",
      (upTrusted.additionalContexts ?? []).some((c) => c.includes("项目级 UserPromptSubmit")),
      JSON.stringify(upTrusted.additionalContexts),
    );

    // ── 判据 3：matcher 过滤（PreToolUse matcher=Bash，Read 的调用不跑）──
    const preRead = await trusted!.run(
      "PreToolUse",
      { sessionId: "s1", turnId: "t1", cwd: ws, toolName: "Read", toolInput: { path: "/x" }, toolCallId: "tc-read" },
      { matchValues: ["Read"] },
    );
    check(
      "matcher=Bash 的钩子在 Read 调用上不执行（没 deny，也没执行过命令）",
      !existsSync(M_TOOL) && preResultIsClean(preRead),
      `marker=${existsSync(M_TOOL)} result=${JSON.stringify(preRead)}`,
    );

    // ── 判据 4：permissionDecision=deny 透传 ──
    const preBash = await trusted!.run(
      "PreToolUse",
      { sessionId: "s1", turnId: "t1", cwd: ws, toolName: "Bash", toolInput: { command: "rm -rf /" }, toolCallId: "tc-bash" },
      { matchValues: ["Bash"] },
    );
    check("matcher=Bash 时执行了（标记存在）", existsSync(M_TOOL), `marker=${existsSync(M_TOOL)}`);
    check(
      "deny 决策与原因原样透传（agent 拿它拦工具调用）",
      preBash.permissionBehavior === "deny" &&
        String(preBash.hookPermissionDecisionReason ?? "").includes("拦下了这条命令"),
      JSON.stringify(preBash),
    );

    // ── 判据 5：用户级 Stop 钩子退出码 2 → 拦住继续；第二次放行 ──
    const stopFirst = await trusted!.run("Stop", {
      sessionId: "s1",
      turnId: "t1",
      cwd: ws,
      responseText: "答完了",
      responsePreview: "答完了",
      stopHookActive: false,
    });
    check(
      "Stop 钩子（exit 2）第一次拦住继续：stopShouldContinue + 原因",
      stopFirst.stopShouldContinue === true && String(stopFirst.stopReason ?? "").includes("活儿还没干完"),
      JSON.stringify(stopFirst),
    );
    const stopSecond = await trusted!.run("Stop", {
      sessionId: "s1",
      turnId: "t1",
      cwd: ws,
      responseText: "又答完了",
      responsePreview: "又答完了",
      stopHookActive: true,
    });
    check(
      "第二次不再拦（钩子自己的标记生效，stopHookActive=true）",
      !stopSecond.stopShouldContinue,
      JSON.stringify(stopSecond),
    );

    // ── 判据 6：生命周期事件齐（时间线 hookInvocation 行的原料）──
    const started = events.filter((e) => e.type === "hook_run_started");
    const completed = events.filter((e) => e.type === "hook_run_completed" || e.type === "hook_run_failed");
    check(
      "生命周期事件成对（started ≥1，completed/failed ≥1）",
      started.length >= 1 && completed.length >= 1,
      `started=${started.length} completed=${completed.length} types=${JSON.stringify(events.map((e) => e.type))}`,
    );
    const firstPayload = (started[0]?.payload ?? {}) as Record<string, unknown>;
    check(
      "事件带 hookInvocationId / hookEventName / hookCount / descriptor",
      Boolean(firstPayload.hookInvocationId) &&
        Boolean(firstPayload.hookEventName) &&
        Number(firstPayload.hookCount ?? 0) >= 1 &&
        Boolean((firstPayload.descriptor as Record<string, unknown> | undefined)?.commandDisplay),
      JSON.stringify(firstPayload).slice(0, 300),
    );
  } catch (e) {
    results.push({ name: "自检本身跑完了", ok: false, detail: String((e as Error)?.stack ?? e) });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    process.stdout.write(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  → ${r.detail}`}\n`);
  }
  process.stdout.write(`\n端侧钩子自检：${results.length - failed.length}/${results.length} PASS\n`);
  process.exit(failed.length > 0 ? 1 : 0);
}

function preResultIsClean(result: { permissionBehavior?: string; additionalContexts?: string[] }): boolean {
  return result.permissionBehavior !== "deny" && (result.additionalContexts ?? []).length === 0;
}

void main();
