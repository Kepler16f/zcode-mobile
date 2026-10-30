// 端侧的窗口 Controller 面 = 侧栏那一片行的读取口 + 那条口变化时的实时帧。
//
// 为什么必须是这一条：桌面把侧栏的"行集合"整体迁到了窗口 Controller（useGlobalTaskList.ts:45
// 只认 windowControllerService，注释写明"缺失代表 Host/Renderer 版本不一致"），
// 所以手机上"列表里有这一条"这句话最终只可能落在这个方法上。0.3.1 的端到端账本给了直接证据：
// `mobile:windowControllerService.listTaskList` 被调用过 2 次，而那时会话已经能聊、
// sessions-index 那一路也已经能把行写进 task-index —— 行在库里，屏幕上没有，缺的就是这一个读取口。
//
// 但只补读取口还不够（0.3.2 的端到端把这一点测出来了）：行确实写进了 sqlite，侧栏仍然写
// "还没有任务"。原因是重查的触发不在 zcodeTaskService 那条广播上，而在 Controller 自己的
// topic 帧上——windowControllerTaskListRegistry.ts:124 订阅 `onDynamicControllerFrame()`，
// 收到 tasks-index 帧才 +1 revision（:185 notifyOnce），useGlobalTaskList 的 load 只跟
// revision / taskListVersionSignature 走（:193-202）。端侧以前不推帧，所以那一行永远等不到重拉。
//
// 明确没做的两件事，都留着让账本说出来，不在这里装作有：
//   - mutateTask（置顶 / 归档 / 删除）：列表组织操作属于 P1。
//   - row.activity（侧栏那一行的运行中细节）：端侧的活状态直接来自库里 status，见下面 liveStatus。
import { Emitter, type Event } from "@zcode/rpc";
import { ZCODE_AGENT_PROVIDER, type ZCodeTaskMeta, type ZCodeWorkspaceEvent } from "@zcode/shared";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
// 侧栏诊断（0.3.9）：say() 的读数只活在 UI 页内存里，切去自检页复制报告时就丢了——
// 连续三版"侧栏空"每次都靠猜，根因是没有跨页的证人。这一格把链上关键读数落进
// localStorage（与自检页同源），下一次报告直接按读数定位。见 sidebar-diagnostics.ts。
import {
  sidebarDelta,
  sidebarFrameReject,
  sidebarReadout,
  sidebarSnapshot,
  sidebarWatched,
} from "./sidebar-diagnostics.js";
import {
  CONTROLLER_TASKS_INDEX_TOPIC,
  CONTROLLER_WORKSPACES_TOPIC,
  windowHostControllerTaskFrameSchema,
  windowHostControllerWorkspaceFrameSchema,
  type ControllerSubscribeParams,
  type ControllerSubscribeResult,
  type WindowHostControllerTaskDelta,
  type WindowHostControllerTaskFrame,
  type WindowHostControllerTaskRow,
  type WindowHostControllerTopic,
  type WindowHostControllerWorkspaceDelta,
  type WindowHostControllerWorkspaceFact,
  type WindowHostControllerWorkspaceFrame,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  WindowHostControllerFrame,
  WindowHostControllerTaskListItem,
  WindowHostControllerTaskListResult,
  ZCodeTaskListQuery,
} from "@zcode/services";

/** TaskIndexRepo 在这一条里被用到的那一面。写成窄接口而不是引类型：端侧的深路径类型导入对打包器是噪声。 */
interface TaskListReader {
  queryTaskList(params: ZCodeTaskListQuery & { provider?: string }): Promise<{
    items: ZCodeTaskMeta[];
    total: number;
    hasMore: boolean;
  }>;
}

/** 同步器被用到的那一面：task-index 写完之后的那一声广播。 */
interface TaskIndexBroadcaster {
  onDynamicWorkspaceEvent(workspace: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Event<ZCodeWorkspaceEvent>;
}

/**
 * 与桌面同一个取法（windowHostControllerService.ts:127-131），但多认一个 "running"：
 * 桌面那里 running 来自 Controller 的实时投影、meta.status 里只有终态，所以它不需要映射；
 * 端侧没有那条投影，能拿到的就是回源 snapshot 写进库里的 status —— 不映出来的话，
 * 正在跑的会话在侧栏上会显示成"空闲"，那是把一个已知的事实读成了另一个。
 */
function liveStatusFromMeta(meta: ZCodeTaskMeta): WindowHostControllerTaskListItem["liveStatus"] {
  if (meta.status === "running") return "running";
  if (meta.status === "completed") return "completed";
  if (meta.status === "error") return "error";
  return "idle";
}

interface ControllerScope {
  workspacePath: string;
  workspaceIdentity?: string;
}

interface DisposableLike {
  dispose(): void;
}

function scopeKey(scope: ControllerScope): string {
  return scope.workspaceIdentity?.trim() || scope.workspacePath;
}

/** 与 ui/agent.ts 同一个形状：logEpoch 与 subscriptionId 只要够唯一，不需要真随机源。 */
function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function addressOf(scope: ControllerScope, taskId: string) {
  return {
    workspacePath: scope.workspacePath,
    ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
    taskId,
  };
}

/**
 * membership 从**事件 reason**派生（0.4.11，A1：归档/置顶写链打通后的投影半边）。
 *
 * 写链（zcodeTaskService.archiveTask/setTaskPinned/renameTask）0.4.5 起就通到
 * taskIndexRepo.updateTaskState——库里的 pinned/archived 列是真的会翻。但投影这边
 * rowOf 把 membership 写死成"未置顶、未归档、活跃"，归档落库后 Controller 帧仍告诉
 * UI"这行还在 timeline"——装机"点归档没反应"的投影半边正是这条（另一半是 0.4.10
 * 修的"点归档钮抽屉缩回"）。
 *
 * 为什么从 reason 派生而不是回查库：事件里带着 reason（task_archived/task_pinned/
 * task_unarchived/task_unpinned），它就是**刚发生的那个状态翻转**——比回查更可靠
 * （回查要 async，事件处理器是 sync 的；且 reason 就是写库那一拍的事实）。
 * 快照（sendSnapshot）仍走 rowsOf 的 kind=active 查询，初始列表由 listTaskList
 * 的 kind 过滤保证——两条路各管各的，membership 只在 delta 帧里需要修正。
 */
function membershipOf(reason: string | undefined): {
  pinned: boolean;
  archived: boolean;
  active: boolean;
} {
  switch (reason) {
    case "task_archived":
      return { pinned: false, archived: true, active: false };
    case "task_unarchived":
      return { pinned: false, archived: false, active: true };
    case "task_pinned":
      return { pinned: true, archived: false, active: true };
    case "task_unpinned":
      return { pinned: false, archived: false, active: true };
    default:
      // 创建/状态变更/元数据变更那类事件不改 membership，维持活跃默认。
      return { pinned: false, archived: false, active: true };
  }
}

function rowOf(
  meta: ZCodeTaskMeta,
  membership?: { pinned: boolean; archived: boolean; active: boolean },
  summary?: SessionSummary,
): WindowHostControllerTaskRow {
  const row = {
    address: addressOf(
      { workspacePath: meta.workspacePath, workspaceIdentity: meta.workspaceIdentity },
      meta.taskId,
    ),
    meta,
    membership: membership ?? { pinned: false, archived: false, active: true },
    // 端侧只有一个数据源，就是这台设备本身，所以"在线"不是乐观默认而是恒真。
    sourceAvailability: "online",
    liveStatus: liveStatusFromMeta(meta),
  } as WindowHostControllerTaskRow;
  // 实时投影（桌面同款，windowHostControllerService.ts:82-120）：把会话摘要里的待确认与
  // 运行态投到这一行。少了它，端侧侧栏的「等待确认」只能等另一条 lane 兜底，那条 lane
  // 一旦丢帧，旧标识就永远留在侧栏（用户报的就是这个）。
  if (summary) {
    row.liveStatus = liveStatusFromSummary(summary);
    row.activity = {
      phase: summary.phase,
      lastActivityAt: summary.lastActivityAt,
      hasBackgroundWork: summary.hasBackgroundWork,
      ...(summary.pendingInteractionSummary
        ? { pendingInteractions: summary.pendingInteractionSummary }
        : {}),
    };
  }
  return row;
}

/** 桌面 sessionOverlay 的同一套判据：有待确认就是 waiting，其次看 phase。 */
function liveStatusFromSummary(summary: SessionSummary): WindowHostControllerTaskRow["liveStatus"] {
  if (summary.pendingInteraction ||
    (summary.pendingInteractionSummary &&
      summary.pendingInteractionSummary.permissionCount + summary.pendingInteractionSummary.userInputCount > 0)) {
    return "waiting";
  }
  if (summary.phase === "prewarming" || summary.phase === "running") return "running";
  if (summary.phase === "error") return "error";
  if (summary.phase === "completedSuccess" || summary.phase === "completedInterrupted") return "completed";
  return "idle";
}

export function createMobileWindowControllerService(options: {
  taskIndexRepo: TaskListReader;
  taskIndexSyncer: TaskIndexBroadcaster;
  onDiagnostic?: (message: string) => void;
  isSessionRunning?: (sessionId: string) => boolean;
  /** 实时会话摘要（由 Agent 服务提供）：侧栏的待确认/运行态投影来源，桌面同款。 */
  sessionSummaries?: (workspacePath: string) => SessionSummary[];
}) {
  const say = (message: string) => options.onDiagnostic?.(message);
  const visibleTask = (meta: ZCodeTaskMeta) => !meta.taskId.startsWith("mobile-subagent-");
  // 数据库running只代表退出前的一拍，当前运行权威是本进程中的任务。
  const currentMeta = (meta: ZCodeTaskMeta): ZCodeTaskMeta => meta.status === "running" &&
    options.isSessionRunning && !options.isSessionRunning(meta.taskId) ? {...meta,status:undefined} : meta;
  const frameEmitter = new Emitter<WindowHostControllerFrame>();
  // 订阅 id → 它订的那个 topic。值类型写成协议联合（与下面 topicStates 同一个理由）：
  // resyncControllerV4 拿到的 topic 要直接投给 sendSnapshot / topicStates，
  // 退化成 string 就等于把"这一条订阅订的是哪个 topic"这件事在类型里丢掉了。
  const subscriptions = new Map<string, WindowHostControllerTopic>();
  // topic 级的 logEpoch + seq，水位纪律照抄桌面投影
  // （windowHostControllerProjection.ts:199-202、222-282）：snapshot 是"当前这一拍的整张照片"，
  // 不推进水位，toSeq 用发帧那一刻的 seq；delta 一帧只走一格。注册表按游标判断档
  // （windowControllerTaskListRegistry.ts:127-142），水位错了就会退订重订，列表整片闪空。
  //
  // 键写成 WindowHostControllerTopic 这个联合、不写成 string：协议里 Controller 只有这两个 topic
  // （controller.ts:11-14 的 z.enum），而 `Record<string, …>` 在 noUncheckedIndexedAccess 下
  // 每次取值都要" Possibly undefined" 处理一遍——那不是检查，那是把类型没能说清的事转嫁给运行时。
  const topicStates: Record<WindowHostControllerTopic, { logEpoch: string; seq: number }> = {
    [CONTROLLER_TASKS_INDEX_TOPIC]: { logEpoch: newId("ctrl-epoch"), seq: 0 },
    [CONTROLLER_WORKSPACES_TOPIC]: { logEpoch: newId("ctrl-epoch"), seq: 0 },
  };
  // 已见过的 workspace：读取口每次被问到的 scope 都记下来，快照才知道该投影谁。
  const scopes = new Map<string, ControllerScope>();

  async function rowsOf(scope: ControllerScope): Promise<WindowHostControllerTaskRow[]> {
    const result = await options.taskIndexRepo.queryTaskList({
      // "active" = 只排除 archived；端侧没有归档，等价于该 workspace 的全部行。
      kind: "active",
      excludeTaskIdPrefix: "mobile-subagent-",
      workspaceScopes: [scope],
      sortBy: "updated",
      provider: ZCODE_AGENT_PROVIDER,
    });
    const summaries = new Map(
      (options.sessionSummaries?.(scope.workspacePath) ?? []).map((summary) => [summary.sessionId, summary]),
    );
    return result.items.filter(visibleTask).map((m) => rowOf(currentMeta(m), undefined, summaries.get(m.taskId)));
  }

  function publishDeltas(
    topic: WindowHostControllerTopic,
    deltas: WindowHostControllerTaskDelta[] | WindowHostControllerWorkspaceDelta[],
  ): void {
    if (deltas.length === 0) return;
    const state = topicStates[topic];
    const fromSeq = state.seq;
    state.seq += 1;
    for (const [subscriptionId, topicOfSub] of subscriptions) {
      if (topicOfSub !== topic) continue;
      const frame = {
        topic,
        subscriptionId,
        logEpoch: state.logEpoch,
        fromSeq,
        toSeq: state.seq,
        sentAt: Date.now(),
        payload: { kind: "deltas", deltas },
      } as const;
      const parsed =
        topic === CONTROLLER_TASKS_INDEX_TOPIC
          ? windowHostControllerTaskFrameSchema.safeParse(frame)
          : windowHostControllerWorkspaceFrameSchema.safeParse(frame);
      if (!parsed.success) {
        // 帧不合法就不发：注册表把对不上的水位当断档，会退订重订，屏幕上是一次整片闪空，
        // 而这里丢的那一行本来还会被下一次重拉补回来。
        sidebarFrameReject(`${topic} delta 帧不合法：${parsed.error.issues[0]?.message ?? "未知"}`);
        say(
          `${topic} delta 帧不合法：${parsed.error.issues[0]?.message ?? "未知"}（已丢弃，不推水位）`,
        );
        continue;
      }
      frameEmitter.fire(parsed.data as WindowHostControllerFrame);
    }
  }

  /**
   * 快照是异步发的。桌面在 subscribe 里同步发（它的行全在内存），端侧的行在 sqlite、读是异步。
   * 这不破坏断档判定：注册表只在**已经有游标**时才对水位（:127），首帧之前没有游标。
   * 代价是"订阅之后、快照到达之前"那一段变更只能等快照本身覆盖 —— 快照读的是发帧那一刻的库，
   * 那些行已经在里面了。
   */
  async function sendSnapshot(subscriptionId: string, topic: WindowHostControllerTopic): Promise<void> {
    const state = topicStates[topic];
    const watched = Array.from(scopes.values());
    const frame =
      topic === CONTROLLER_TASKS_INDEX_TOPIC
        ? {
            topic,
            subscriptionId,
            logEpoch: state.logEpoch,
            fromSeq: 0,
            toSeq: state.seq,
            sentAt: Date.now(),
            payload: {
              kind: "snapshot",
              snapshot: {
                protocolVersion: 1,
                logEpoch: state.logEpoch,
                tasks: (await Promise.all(watched.map((scope) => rowsOf(scope)))).flat(),
              },
            },
          }
        : {
            topic,
            subscriptionId,
            logEpoch: state.logEpoch,
            fromSeq: 0,
            toSeq: state.seq,
            sentAt: Date.now(),
            payload: {
              kind: "snapshot",
              snapshot: {
                protocolVersion: 1,
                logEpoch: state.logEpoch,
                workspaces: watched.map(
                  (scope): WindowHostControllerWorkspaceFact => ({
                    workspacePath: scope.workspacePath,
                    ...(scope.workspaceIdentity
                      ? { workspaceIdentity: scope.workspaceIdentity }
                      : {}),
                    sourceAvailability: "online",
                    connectionState: "online",
                  }),
                ),
              },
            },
          };
    const parsed =
      topic === CONTROLLER_TASKS_INDEX_TOPIC
        ? windowHostControllerTaskFrameSchema.safeParse(frame)
        : windowHostControllerWorkspaceFrameSchema.safeParse(frame);
    if (!parsed.success) {
      sidebarFrameReject(`${topic} 快照帧不合法：${parsed.error.issues[0]?.message ?? "未知"}`);
      say(
        `${topic} 快照帧不合法：${parsed.error.issues[0]?.message ?? "未知"}（侧栏只会读到空列表，不会崩）`,
      );
      return;
    }
    // 快照发出去了才算数：tasks 数是投影链的终读数——库里有没有、rowsOf 有没有滤掉，全看这一个数。
    if (topic === CONTROLLER_TASKS_INDEX_TOPIC) {
      const snapshot = (frame as { payload: { snapshot: { tasks: unknown[] } } }).payload.snapshot;
      sidebarSnapshot(snapshot.tasks.length);
    }
    frameEmitter.fire(parsed.data as WindowHostControllerFrame);
  }

  // task-index → Controller 帧。同步器写完一行会广播 workspace_task_list_changed，
  // 那一声带着刚落库的 taskMeta，正好是一格 task.upserted；不用再回源读一次库。
  const watchedDisposables = new Map<string, DisposableLike>();
  function watchScope(scope: ControllerScope): void {
    const key = scopeKey(scope);
    if (scopes.has(key)) return;
    scopes.set(key, scope);
    sidebarWatched(key);
    watchedDisposables.set(
      key,
      options.taskIndexSyncer.onDynamicWorkspaceEvent(scope)((event) => {
        if (event.type !== "workspace_task_list_changed") return;
        if (event.taskMeta) {
          if (!visibleTask(event.taskMeta)) return;
          publishDeltas(CONTROLLER_TASKS_INDEX_TOPIC, [
            { op: "task.upserted", task: rowOf(currentMeta(event.taskMeta), membershipOf(event.reason)) },
          ]);
          sidebarDelta("upserted");
          say(
            `tasks-index 帧 task.upserted reason=${event.reason} taskId=${event.taskMeta.taskId}`,
          );
          return;
        }
        if (event.reason === "task_deleted" && event.taskId) {
          publishDeltas(CONTROLLER_TASKS_INDEX_TOPIC, [
            { op: "task.removed", address: addressOf(scope, event.taskId) },
          ]);
          sidebarDelta("removed");
          say(`tasks-index 帧 task.removed taskId=${event.taskId}`);
          return;
        }
        // 其余"没有 meta 的广播"（归档/置顶那类）在端侧还不存在；真出现时会在这里留下计数，
        // 而不是默默当成没变化——那正是"库里改了、屏上没动"最难查的形状。
        say(`tasks-index 忽略广播 reason=${event.reason}（事件里没有行内容）`);
      }),
    );
    say(`watch workspace=${key}（task-index 广播开始投成 Controller 帧）`);
  }

  return {
    /**
     * provider 过滤与 zcodeTaskService 那条读取口保持同一个值
     * （zcodeTaskServiceAdapter.ts:209 + :2376），否则同一个 workspace 会在两个读取口上
     * 给出不一致的行集合 —— 那种不一致在屏幕上表现为"列表每隔一次重拉跳一下"，最难查。
     */
    async listTaskList(
      params: ZCodeTaskListQuery,
    ): Promise<WindowHostControllerTaskListResult> {
      for (const scope of params.workspaceScopes) watchScope(scope);
      const result = await options.taskIndexRepo.queryTaskList({
        ...params,
        excludeTaskIdPrefix: "mobile-subagent-",
        provider: ZCODE_AGENT_PROVIDER,
      });
      const summaries = new Map<string, SessionSummary>();
      for (const scope of params.workspaceScopes) {
        for (const summary of options.sessionSummaries?.(scope.workspacePath) ?? []) {
          summaries.set(summary.sessionId, summary);
        }
      }
      const items = result.items.filter(visibleTask).map(currentMeta).map((item) => {
        const summary = summaries.get(item.taskId);
        const row = rowOf(item, undefined, summary);
        const pending = summary?.pendingInteraction;
        return {
          ...item,
          sourceAvailability: "online" as const,
          liveStatus: row.liveStatus,
          // 实时摘要投影（桌面同款）：待确认与运行态随这一行一起给出。
          ...(pending
            ? {
                pendingInteraction: {
                  interactionId: pending.interactionId,
                  kind: pending.kind,
                  ...(pending.toolName ? { toolName: pending.toolName } : {}),
                },
              }
            : {}),
          ...(row.activity ? { activity: row.activity } : {}),
        };
      });
      say(
        `listTaskList kind=${params.kind} scopes=${params.workspaceScopes.length} ` +
          `返回 ${items.length}/${result.total} 行`,
      );
      sidebarReadout(
        String(params.kind),
        params.workspaceScopes.map((s) => scopeKey(s)),
        items.length,
        result.total,
      );
      return { items, total: result.total, hasMore: result.hasMore };
    },
    async subscribeControllerV4(
      params: ControllerSubscribeParams,
    ): Promise<ControllerSubscribeResult> {
      const subscriptionId = newId("ctrl-sub");
      subscriptions.set(subscriptionId, params.topic);
      void sendSnapshot(subscriptionId, params.topic);
      return {
        ack: {
          subscriptionId,
          mode: "snapshot",
          logEpoch: topicStates[params.topic].logEpoch,
        },
      };
    },
    async resyncControllerV4(params: { subscriptionId: string }) {
      const topic = subscriptions.get(params.subscriptionId);
      if (!topic) throw new Error(`端侧没有这个 Controller 订阅：${params.subscriptionId}`);
      void sendSnapshot(params.subscriptionId, topic);
      return {
        ack: {
          subscriptionId: params.subscriptionId,
          mode: "snapshot",
          logEpoch: topicStates[topic].logEpoch,
        },
      };
    },
    async unsubscribeControllerV4(params: { subscriptionId: string }) {
      subscriptions.delete(params.subscriptionId);
    },
    onDynamicControllerFrame(): Event<WindowHostControllerFrame> {
      return frameEmitter.event;
    },
    dispose(): void {
      for (const disposable of watchedDisposables.values()) disposable.dispose();
      watchedDisposables.clear();
      subscriptions.clear();
      frameEmitter.dispose();
    },
  };
}
