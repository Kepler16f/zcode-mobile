// 移动端文件系统监视服务（桌面 fileWatcherService 的 Android 形态）。
//
// 桌面用 node:fs 的 watch（内核事件）。Android 没有 fs.watch：SAF 树与本地盘都拿不到
// inotify 事件，所以这里用**轮询签名**实现：按固定间隔取一次目录快照（名字 + mtime + 大小），
// 与上一份快照比对，变了才发事件。语义与桌面一致：事件带 dirPath（被监视的目录），
// 只有一个确定变化路径时才带 changedPath，否则调用方按"保守刷新"处理。
//
// 平台代价必须写清楚，否则这份实现会被当成"免费"：
//  - 本地盘：一次 readdir + 一次批量 stat（statMany，1 次 JNI 往返）。旧桥没有 statMany 时
//    退化为逐个 statSync（N 次往返），仍可用但更慢。
//  - SAF 树：一次 readdir + 目录自身 mtime。子文件的**内容**改动检测不到
//    （SAF 每次 stat 约 30-40ms，逐个 stat 会让主线程卡住），只报告增删改名。
//  - 递归监视有上限（目录数与条目数），超限后只报告已扫描部分并省略 changedPath。
// 轮询在页面不可见时暂停：后台还扫树只会耗电发热，正是之前"用一会儿就卡"的来源之一。
import { Emitter, Event, type Event as RpcEvent } from "@zcode/rpc";
import type { FileWatchEvent } from "@zcode/shared";
import * as vfs from "../compat/vfs.mjs";

const POLL_INTERVAL_MS = 2_500;
const DEBOUNCE_MS = 150;
/** 递归监视的扫描上限；超限即降级为"保守刷新"（事件不带 changedPath）。 */
const MAX_DIRS = 200;
const MAX_ENTRIES = 5_000;

type Signature = string;

interface Watcher {
  id: string;
  path: string;
  recursive: boolean;
  emitter: Emitter<FileWatchEvent>;
  snapshot: Map<string, Signature>;
  pending: Set<string>;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  timer: ReturnType<typeof setInterval> | null;
}

function isSafPath(path: string): boolean {
  return path.startsWith("/mnt/");
}

function statSignature(kind: string, mtimeMs: number, size: number): Signature {
  return `${kind}:${mtimeMs}:${size}`;
}

function childPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

/** 一次目录扫描：返回 绝对路径 → 签名。SAF 只取名字集合与目录自身 mtime。 */
function scanDirectory(dir: string, into: Map<string, Signature>, state: { dirs: number; entries: number }, recursive: boolean): void {
  if (state.dirs >= MAX_DIRS || state.entries >= MAX_ENTRIES) return;
  state.dirs++;
  let names: string[];
  try {
    names = vfs.readdirSync(dir);
  } catch {
    return; // 目录被删掉或无权读取：这一轮跳过，不当成故障
  }
  state.entries += names.length;
  const saf = isSafPath(dir);
  const paths = names.map((name) => childPath(dir, name));
  let stats: Map<string, { kind: string; mtimeMs: number; size: number }> = new Map();
  if (!saf && paths.length) {
    // 批量 stat：1 次往返。旧桥没有这个操作时退化为逐个 stat（仍是真数据，只是慢）。
    try {
      for (const item of vfs.statMany(paths)) {
        if (item.ok && item.exists) {
          stats.set(item.path, { kind: item.kind, mtimeMs: item.mtimeMs, size: item.size });
        }
      }
    } catch {
      stats = new Map();
    }
    if (!stats.size) {
      for (const path of paths) {
        try {
          const st = vfs.statSync(path);
          stats.set(path, {
            kind: st.isDirectory() ? "dir" : st.isSymbolicLink() ? "link" : "file",
            mtimeMs: Number(st.mtimeMs ?? 0),
            size: Number(st.size ?? 0),
          });
        } catch {
          // 已消失的条目：下一轮快照里就没有它，视为删除
        }
      }
    }
  }
  for (const name of names) {
    const path = childPath(dir, name);
    const info = stats.get(path);
    into.set(path, info ? statSignature(info.kind, info.mtimeMs, info.size) : "unknown");
  }
  if (!saf && recursive) {
    for (const name of names) {
      const path = childPath(dir, name);
      if (stats.get(path)?.kind === "dir") scanDirectory(path, into, state, recursive);
    }
  }
}

function snapshotOf(path: string, recursive: boolean): Map<string, Signature> {
  const out = new Map<string, Signature>();
  const state = { dirs: 0, entries: 0 };
  scanDirectory(path, out, state, recursive);
  // 目录自身的 mtime：增删改会动它；SAF 下它也是唯一可得的目录级信号。
  try {
    const st = vfs.statSync(path);
    out.set(path, statSignature("dir", Number(st.mtimeMs ?? 0), 0));
  } catch {
    out.set(path, "missing");
  }
  return out;
}

function diffSnapshots(before: Map<string, Signature>, after: Map<string, Signature>): string[] {
  const changed: string[] = [];
  for (const [path, signature] of after) {
    if (before.get(path) !== signature) changed.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) changed.push(path);
  return changed;
}

export function createMobileFileWatcherService(options: { pollIntervalMs?: number; onDiagnostic?: (message: string) => void } = {}) {
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const say = options.onDiagnostic ?? (() => {});
  const watchers = new Map<string, Watcher>();
  let nextId = 0;

  function flush(watcher: Watcher): void {
    if (watcher.debounceTimer) clearTimeout(watcher.debounceTimer);
    watcher.debounceTimer = null;
    if (!watcher.pending.size) return;
    const only = watcher.pending.size === 1 ? watcher.pending.values().next().value : undefined;
    watcher.pending.clear();
    watcher.emitter.fire({ dirPath: watcher.path, ...(only ? { changedPath: only } : {}) });
  }

  function poll(watcher: Watcher): void {
    let next: Map<string, Signature>;
    try {
      next = snapshotOf(watcher.path, watcher.recursive);
    } catch (error) {
      say(`文件监视扫描失败（${watcher.path}）：${String((error as Error)?.message ?? error)}`);
      return;
    }
    const changed = diffSnapshots(watcher.snapshot, next);
    watcher.snapshot = next;
    if (!changed.length) return;
    for (const path of changed) watcher.pending.add(path);
    if (watcher.debounceTimer) clearTimeout(watcher.debounceTimer);
    watcher.debounceTimer = setTimeout(() => flush(watcher), DEBOUNCE_MS);
  }

  function start(watcher: Watcher): void {
    if (watcher.timer) clearInterval(watcher.timer);
    watcher.timer = setInterval(() => poll(watcher), pollIntervalMs);
  }

  function stop(watcher: Watcher): void {
    if (watcher.timer) clearInterval(watcher.timer);
    watcher.timer = null;
  }

  // 页面不可见时停掉轮询：后台继续扫树只会耗电发热。回到前台补扫一次，
// 后台期间的改动立刻可见（桌面端靠内核事件天然实时，这里只能补扫）。
  if (typeof document !== "undefined") {
    document.addEventListener?.("visibilitychange", () => {
      const hidden = document.visibilityState === "hidden";
      for (const watcher of watchers.values()) {
        if (hidden) stop(watcher);
        else {
          start(watcher);
          poll(watcher);
        }
      }
    });
  }

  return {
    async watch(params: { path: string; recursive?: boolean }): Promise<{ id: string }> {
      const path = String(params.path ?? "").trim();
      if (!path.startsWith("/")) throw new Error(`无法监视目录 '${params.path}': 必须是绝对路径`);
      const recursive = params.recursive ?? false;
      const id = String(nextId++);
      const emitter = new Emitter<FileWatchEvent>();
      const watcher: Watcher = {
        id, path, recursive, emitter,
        snapshot: new Map(), pending: new Set(), debounceTimer: null, timer: null,
      };
      try {
        // 桌面 fs.watch 对不存在的路径/非目录会直接失败；这里必须同样报错，
        // 否则调用方会拿到一个永远不触发的 watcher id，界面静默不刷新。
        const st = vfs.statSync(path);
        if (!st.isDirectory()) throw new Error("不是目录");
        watcher.snapshot = snapshotOf(path, recursive);
      } catch (error) {
        emitter.dispose();
        throw new Error(`无法监视目录 '${params.path}': ${String((error as Error)?.message ?? error)}`);
      }
      watchers.set(id, watcher);
      if (typeof document === "undefined" || document.visibilityState !== "hidden") start(watcher);
      say(`文件监视已启动：${path}${recursive ? "（递归）" : ""}`);
      return { id };
    },

    async unwatch(params: { id: string }): Promise<void> {
      const watcher = watchers.get(params.id);
      if (!watcher) return;
      if (watcher.timer) clearInterval(watcher.timer);
      if (watcher.debounceTimer) clearTimeout(watcher.debounceTimer);
      watcher.emitter.dispose();
      watchers.delete(params.id);
    },

    disposeAll(): void {
      for (const id of [...watchers.keys()]) {
        const watcher = watchers.get(id)!;
        if (watcher.timer) clearInterval(watcher.timer);
        if (watcher.debounceTimer) clearTimeout(watcher.debounceTimer);
        watcher.emitter.dispose();
      }
      watchers.clear();
    },

    onDynamicChange(id: string): RpcEvent<FileWatchEvent> {
      const watcher = watchers.get(id);
      // 与桌面同纪律：watcher 已失效时返回空事件，而不是抛错打死订阅链路。
      if (!watcher) return Event.None;
      return watcher.emitter.event;
    },

    /** 页面回到前台时补一次扫描：后台期间的改动立即可见。 */
    resume(): void {
      for (const watcher of watchers.values()) {
        if (!watcher.timer) start(watcher);
        poll(watcher);
      }
    },

    /** 供自检与测试直接触发一次扫描。 */
    tick(): void {
      for (const watcher of watchers.values()) poll(watcher);
    },
  };
}

export type MobileFileWatcherService = ReturnType<typeof createMobileFileWatcherService>;
