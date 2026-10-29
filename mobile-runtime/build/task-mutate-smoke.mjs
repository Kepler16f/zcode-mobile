// A1 归档/置顶/重命名写链的单元冒烟（0.4.11）。
//
// 写链本身（zcodeTaskServiceAdapter.archiveTask/setTaskPinned/renameTask →
// taskIndexRepo.updateTaskState）0.4.5 起就通到真库——这条冒烟钉的是**投影半边**：
// window-controller 的 watchScope 收到 workspace_task_list_changed 事件后，
// Controller 帧的 membership 是否从 reason 正确派生（0.4.11 修的 rowOf 写死 bug）。
//
// 四格：
//  ① archiveTask 落库（archived=1）+ 事件 reason=task_archived → 帧 membership.archived=true；
//  ② setTaskPinned 落库（pinned=1）+ reason=task_pinned → 帧 membership.pinned=true；
//  ③ renameTask 落库（title 变）+ reason=task_meta_changed → 帧 membership 维持活跃；
//  ④ deleteArchivedTask 落库（deleted=1）+ reason=task_deleted → 帧 task.removed。
//  ⑤ unarchive 回到活跃。
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const zcodeRoot = path.join(root, "../zcode");
const require = createRequire(path.join(zcodeRoot, "apps/zcode-cli/package.json"));
const esbuild = require("esbuild");

// 打 window-controller（含上游 shared/services 的 membership 判定链）
const tmp = path.join(os.tmpdir(), `azcode-taskmut-${Date.now()}.mjs`);
await esbuild.build({
  entryPoints: [path.join(root, "ui/window-controller.ts")],
  outfile: tmp,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  write: true,
  logLevel: "warning",
  external: ["node:*"],
  // window-controller 依赖 @zcode/rpc 与 @zcode/shared——这些是 pnpm workspace 包，
  // 它们的链接挂在各包的 node_modules/@zcode 下（zcode-cli 自己那份没有）。
  // esbuild 不读 pnpm-workspace.yaml，必须像 chat-smoke 那样把 nodePaths 指过去，
  // 否则报 "Could not resolve @zcode/rpc"。
  nodePaths: [
    path.join(zcodeRoot, "packages/web/node_modules"),
    path.join(zcodeRoot, "packages/ui/node_modules"),
    path.join(zcodeRoot, "packages/client/node_modules"),
    path.join(zcodeRoot, "packages/services/node_modules"),
    path.join(zcodeRoot, "packages/shared/node_modules"),
    path.join(zcodeRoot, "node_modules"),
  ],
});
const mod = await import(pathToFileURL(tmp).href);
fs.rmSync(tmp, { force: true });
const { createMobileWindowControllerService } = mod;

let pass = 0, fail = 0;
function check(name, cond, evidence = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  → ${evidence}`}`);
  cond ? pass++ : fail++;
}

// ── 假 taskIndexRepo：记录写调用、按 kind 过滤 ──
const rows = new Map(); // taskId → { meta, pinned, archived, deleted }
const writes = [];
const fakeRepo = {
  async queryTaskList(params) {
    const items = [...rows.values()]
      .filter((r) => !r.deleted)
      .filter((r) => !params.excludeTaskIdPrefix || !r.meta.taskId.startsWith(params.excludeTaskIdPrefix))
      .filter((r) => {
        if (params.kind === "pinned") return r.pinned && !r.archived;
        if (params.kind === "archived") return r.archived;
        // timeline/active
        return !r.pinned && !r.archived;
      })
      .map((r) => r.meta);
    return { items, total: items.length, hasMore: false };
  },
  async updateTaskState(params) {
    writes.push({ op: "updateTaskState", ...params });
    const r = rows.get(params.taskId);
    if (!r) throw new Error(`task ${params.taskId} 不存在`);
    Object.assign(r, params.patch);
    if (params.patch.title !== undefined) r.meta.title = params.patch.title;
    return r.meta;
  },
  async deleteArchivedTask(params) {
    writes.push({ op: "deleteArchivedTask", ...params });
    const r = rows.get(params.taskId);
    if (r) r.deleted = true;
    return r ? r.meta : null;
  },
};

// ── 假 syncer：暴露 emitter，写链完成后手动 fire 事件（模拟 adapter 的 emitWorkspaceTaskListChanged）──
const { Emitter } = await import(pathToFileURL(path.join(zcodeRoot, "packages/rpc/src/emitter.ts")).href).catch(() => ({})) || {};
// Emitter 从上游 rpc 包拿不到就直接用简单实现
class SimpleEmitter {
  constructor() { this.listeners = new Set(); }
  get event() { return (l) => { this.listeners.add(l); return { dispose: () => this.listeners.delete(l) }; }; }
  fire(e) { for (const l of this.listeners) l(e); }
}

const workspaceEmitters = new Map();
const fakeSyncer = {
  onDynamicWorkspaceEvent(scope) {
    const key = scope.workspacePath;
    if (!workspaceEmitters.has(key)) workspaceEmitters.set(key, new SimpleEmitter());
    return workspaceEmitters.get(key).event;
  },
  emitWorkspaceTaskListChanged(target, taskMeta, reason) {
    const key = target.workspacePath;
    if (!workspaceEmitters.has(key)) workspaceEmitters.set(key, new SimpleEmitter());
    workspaceEmitters.get(key).fire({
      type: "workspace_task_list_changed",
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      taskId: target.taskId,
      reason,
      ...(taskMeta ? { taskMeta } : {}),
    });
  },
};

const diagLines = [];
const runningSessions = new Set();
const controller = createMobileWindowControllerService({
  taskIndexRepo: fakeRepo,
  taskIndexSyncer: fakeSyncer,
  onDiagnostic: (m) => diagLines.push(m),
  isSessionRunning: id => runningSessions.has(id),
});

// 订阅 Controller 帧（收 delta）——必须先 subscribeControllerV4，publishDeltas 只投给已订阅的 topic
const frames = [];
await controller.subscribeControllerV4({ topic: "controller/tasks-index" });
controller.onDynamicControllerFrame()((frame) => {
  if (frame.payload?.kind === "deltas") frames.push(...frame.payload.deltas);
  return Promise.resolve();
});

// 建一条任务
const WS = "/work/.zcode/workspace/default";
const TASK_ID = "task-001";
const metaBase = {
  taskId: TASK_ID, traceId: "zcode-" + TASK_ID, title: "测试任务",
  workspacePath: WS, createdAt: 1, updatedAt: 1, mode: "auto",
};
rows.set(TASK_ID, { meta: { ...metaBase }, pinned: false, archived: false, deleted: false });

// 让 controller watch 这个 workspace（触发订阅）
await controller.listTaskList({ kind: "timeline", workspaceScopes: [{ workspacePath: WS }] });

// ① 归档：写库 + fire 事件 → 帧 membership.archived=true
frames.length = 0;
fakeRepo.updateTaskState({ taskId: TASK_ID, workspacePath: WS, patch: { archived: true } });
const meta = rows.get(TASK_ID).meta;
fakeSyncer.emitWorkspaceTaskListChanged({ workspacePath: WS, taskId: TASK_ID }, meta, "task_archived");
await new Promise((r) => setTimeout(r, 50));
const archDelta = frames.find((d) => d.op === "task.upserted" && d.task?.meta?.taskId === TASK_ID);
check("①归档事件→帧 membership.archived=true", archDelta?.task?.membership?.archived === true,
  "frames=" + JSON.stringify(frames.map((d) => d.op)) + " diag=" + JSON.stringify(diagLines.slice(-3)));
check("①归档写库 archived=1", rows.get(TASK_ID).archived === true);

// ② 置顶（先取消归档）
frames.length = 0;
fakeRepo.updateTaskState({ taskId: TASK_ID, workspacePath: WS, patch: { archived: false, pinned: true } });
fakeSyncer.emitWorkspaceTaskListChanged({ workspacePath: WS, taskId: TASK_ID }, rows.get(TASK_ID).meta, "task_pinned");
await new Promise((r) => setTimeout(r, 50));
const pinDelta = frames.find((d) => d.op === "task.upserted" && d.task?.meta?.taskId === TASK_ID);
check("②置顶事件→帧 membership.pinned=true", pinDelta?.task?.membership?.pinned === true,
  JSON.stringify(pinDelta?.task?.membership));

// ③ 重命名
frames.length = 0;
fakeRepo.updateTaskState({ taskId: TASK_ID, workspacePath: WS, patch: { title: "新名字" } });
rows.get(TASK_ID).meta.title = "新名字";
fakeSyncer.emitWorkspaceTaskListChanged({ workspacePath: WS, taskId: TASK_ID }, rows.get(TASK_ID).meta, "task_meta_changed");
await new Promise((r) => setTimeout(r, 50));
const renameDelta = frames.find((d) => d.op === "task.upserted" && d.task?.meta?.taskId === TASK_ID);
check("③重命名事件→帧 membership 维持活跃", renameDelta?.task?.membership?.active === true,
  JSON.stringify(renameDelta?.task?.membership));
check("③重命名写库 title=新名字", rows.get(TASK_ID).meta.title === "新名字");

// ④ 删除
frames.length = 0;
fakeRepo.deleteArchivedTask({ taskId: TASK_ID, workspacePath: WS });
fakeSyncer.emitWorkspaceTaskListChanged({ workspacePath: WS, taskId: TASK_ID }, undefined, "task_deleted");
await new Promise((r) => setTimeout(r, 50));
const removeDelta = frames.find((d) => d.op === "task.removed" && d.address?.taskId === TASK_ID);
check("④删除事件→帧 task.removed", removeDelta !== undefined, JSON.stringify(frames.map((d) => d.op)));

// ⑤ 取消归档（重建任务后）
rows.set(TASK_ID, {
  meta: { ...metaBase, title: "再测", updatedAt: 2 },
  pinned: false, archived: true, deleted: false,
});
frames.length = 0;
fakeRepo.updateTaskState({ taskId: TASK_ID, workspacePath: WS, patch: { archived: false } });
fakeSyncer.emitWorkspaceTaskListChanged({ workspacePath: WS, taskId: TASK_ID }, rows.get(TASK_ID).meta, "task_unarchived");
await new Promise((r) => setTimeout(r, 50));
const unarchDelta = frames.find((d) => d.op === "task.upserted" && d.task?.meta?.taskId === TASK_ID);
check("⑤取消归档→帧 membership.active=true", unarchDelta?.task?.membership?.active === true,
  JSON.stringify(unarchDelta?.task?.membership));

// ⑥ listTaskList 按 kind 过滤（读口）
const timeline = await controller.listTaskList({ kind: "timeline", workspaceScopes: [{ workspacePath: WS }] });
check("⑥timeline 不含已归档行", timeline.items.every((i) => i.taskId !== TASK_ID || !rows.get(TASK_ID).archived));

rows.get(TASK_ID).meta.status = "running";
const stale = await controller.listTaskList({kind:"timeline",workspaceScopes:[{workspacePath:WS}],sortBy:"updated"});
check("⑦重启无运行owner：持久化running不会继续显示转圈",stale.items.find(i=>i.taskId===TASK_ID)?.liveStatus==="idle");
runningSessions.add(TASK_ID);
const live = await controller.listTaskList({kind:"timeline",workspaceScopes:[{workspacePath:WS}],sortBy:"updated"});
check("⑧真实owner正在运行：侧栏显示running",live.items.find(i=>i.taskId===TASK_ID)?.liveStatus==="running");
rows.set("mobile-subagent-legacy",{meta:{...metaBase,taskId:"mobile-subagent-legacy"},pinned:false,archived:false,deleted:false});
const filtered=await controller.listTaskList({kind:"timeline",workspaceScopes:[{workspacePath:WS}],sortBy:"updated"});
check("⑨旧子会话不进入任务行或分页总数",!filtered.items.some(i=>i.taskId.startsWith("mobile-subagent-"))&&filtered.total===filtered.items.length);
console.log(`\n任务写链冒烟：${pass}/${pass + fail} PASS`);
process.exit(fail > 0 ? 1 : 0);
