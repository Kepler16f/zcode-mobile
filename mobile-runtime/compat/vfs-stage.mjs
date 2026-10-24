// 终端可见性 `staging 物化`（0.5.0，用户点名"SAF 挂载目录对终端子进程不可见导致 bash 工具无法启动"）。
//
// 问题的形状：SAF 工作区（/mnt/<名>）只存在于 vfs 层——文件住在授权 URI 后面，真实盘上没有
// 对应的 POSIX 路径。ExecBridge 给 Bash 的 cwd 是 workspaceRoot()/mnt/<名>（ExecBridge.kt
// workspaceFile 的映射），那是 app 私有目录下的一个普通路径，**只要盘上有这棵树**，bash 就能
// 起来；SAF 侧的东西 bash 一个字节都看不到，于是"工作目录不存在"或"文件找不到"。
//
// 解法：会话内**物化**——第一次在这棵树上跑 Bash 前，把 SAF 树按原路径镜像到私有盘
// （/mnt/<名>/… 的虚拟路径在 native 后端里正好落在 ExecBridge 拼的那个位置，两边天然对齐），
// 之后靠两条腿保持一致：
//   1. 写入透传（write-through）：app 侧（文件工具）对树的每次写/删/改名，在 vfs 派发层
//      同步镜像到 staging（见 vfs.mjs 的 mirror* 调用）——不然"Edit 改完再跑 bash"看到的是旧内容；
//   2. 回写（write-back）：每条 Bash 命令跑完，对 staging 拍一遍 diff（mtime+size 比对），
//      新增/修改/删除如实落回 SAF——不然"bash 改了文件、模型用 Read 一看没变"。
//
// 已知窄化（如实记录，不假装没有）：
//  - 首次物化是全树遍历（SAF 桥每项一次同步往返），大树会慢；分块 + 让出主线程，不冻 UI。
//  - 超过 MAX_STAGE_BYTES 的单个文件不镜像（base64 过桥会把 WebView 堆撑爆），物化结果里计数，
//    上报给 Bash 结果——终端看不见它们的真话在结果里，不在文档里。
//  - 别的 App 通过 SAF 直接改文件（绕过本 App）不会反映进 staging：agent 的文件工具读的始终是
//    SAF 真身，bash 读的是镜像；跨端一致性不在本期范围（与 TreeBridge 的窄化清单同级记录）。
//  - staging 目录（workspaceRoot/mnt/<名>）是会话级镜像，每次物化前先清空重建：它绝不当真身。
import * as tree from "./vfs-tree.mjs";
import * as native from "./vfs-native.mjs";

const YIELD_EVERY = 24;
const READ_CHUNK = 48;
/** 单文件镜像上限：8MB。base64 过桥后的峰值约为 2.7 倍，再大就不是"慢"而是 OOM 了。 */
const MAX_STAGE_BYTES = 8 * 1024 * 1024;

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** path → 所属挂载点（/mnt/<名的第一段）；非树路径返回 null。 */
export function mountOf(path) {
  const s = String(path ?? "");
  if (!s.startsWith("/mnt/")) return null;
  const name = s.slice(5).split("/")[0];
  return name ? "/mnt/" + name : null;
}

/** mount → { ready, skipped }。ready=false 时 ensureStaging 会清空重建（含镜像写失败后的降级）。 */
const mounts = new Map();

function stateOf(mount) {
  let st = mounts.get(mount);
  if (!st) {
    st = { ready: false, skipped: 0 };
    mounts.set(mount, st);
  }
  return st;
}

export function isStagingReady(path) {
  const m = mountOf(path);
  return Boolean(m && mounts.get(m)?.ready);
}

/** 镜像写失败（权限/桥抖动）：把 staging 标脏，下次 Bash 前整树重建，不带着错误状态跑。 */
function invalidate(mount) {
  const st = mounts.get(mount);
  if (st) st.ready = false;
}

/**
 * 写入透传：app 侧对树（SAF）的变更镜像到 staging。
 * 只由 vfs.mjs 派发层在 tree 分支成功后调用；staging 没就绪时 no-op（没物化就没什么可维护的）。
 * op: write | unlink | rmdir | rm | rename | mkdir
 */
export function mirror(op, path, extra = {}) {
  const mount = mountOf(path);
  if (!mount || !mounts.get(mount)?.ready) return;
  try {
    switch (op) {
      case "write":
        native.writeFile(path, extra.data, extra.opts ?? {});
        break;
      case "unlink":
        native.unlinkSync(path);
        break;
      case "rmdir":
        native.rmdir(path);
        break;
      case "rm":
        native.rmSync(path, { recursive: !!extra.recursive, force: !!extra.force });
        break;
      case "rename":
        native.renameSync(path, extra.to);
        break;
      case "mkdir":
        native.mkdir(path, { recursive: true });
        break;
      default:
        invalidate(mount);
    }
  } catch {
    // 镜像保不住真，就别装：下次 Bash 前整树重建（比"悄悄错半边"便宜）。
    invalidate(mount);
  }
}

/** 递归走 SAF 树：分块让出主线程（树桥是同步往返，不让出就是装机"整个应用卡死"那个形状）。 */
async function walkTree(root) {
  const files = [];
  const dirs = [];
  const stack = [root];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = tree.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 单目录读不到（权限/被拔盘）不整体失败：能镜像多少是多少
    }
    for (const ent of entries) {
      const p = dir + "/" + ent.name;
      if (typeof ent.isDirectory === "function" ? ent.isDirectory() : false) {
        dirs.push(p);
        stack.push(p);
      } else {
        files.push(p);
      }
      if (++seen % YIELD_EVERY === 0) await nextTick();
    }
  }
  return { files, dirs };
}

/**
 * 物化（幂等）：staging 已就绪直接返回 null。首次 / 降级后：清空重建。
 * 返回 null（无需/不可用）或 { files, dirs, skipped }。
 */
export async function ensureStaging(mountPath) {
  const mount = mountOf(mountPath);
  if (!mount || !native.isNativeFsAvailable()) return null;
  const st = stateOf(mount);
  if (st.ready) return null;
  // 清空重建：staging 是镜像不是真身，上一次会话的残渣必须清掉（否则 SAF 里已删的文件
  // 会留在盘上被 bash 看见、再被回写diff当成"新文件"复活）。
  try {
    native.rmSync(mount, { recursive: true, force: true });
  } catch {
    /* 清不掉就往下走：mkdir recursive 会尽量收敛，最坏是个别残渣被下面的 diff 规则兜住 */
  }
  const { files, dirs } = await walkTree(mount);
  native.mkdir(mount, { recursive: true });
  // 每个目录一次**同步** mkdir 过桥（FsBridge 私有盘一次往返 ≈0.4ms，树侧更深时更贵）：
  // 原来这里整串连发没有让出点，几百个目录就是几百次往返连成的死区——装机"物化阶段卡死"
  // 的形状之一。walkTree 有 YIELD_EVERY、readMany 批间有 await，唯独这条漏了，补上同一条纪律。
  for (let i = 0; i < dirs.length; i++) {
    native.mkdir(dirs[i], { recursive: true });
    if ((i + 1) % YIELD_EVERY === 0) await nextTick();
  }
  let skipped = 0;
  for (let i = 0; i < files.length; i += READ_CHUNK) {
    const chunk = files.slice(i, i + READ_CHUNK);
    const items = tree.readMany(chunk);
    for (const item of items) {
      if (!item.ok) continue; // 读不到的单项（竞态删除/大文件被 provider 拒）：跳过不炸整批
      const bytes = item.bytes ?? new Uint8Array(0);
      if (bytes.length > MAX_STAGE_BYTES) {
        skipped += 1;
        continue;
      }
      try {
        native.writeFile(item.path, bytes, {});
      } catch {
        /* 单个文件写不进（非法名/空间）：跳过，写入透传与下次重建会再收敛 */
      }
    }
    await nextTick();
  }
  st.ready = true;
  st.skipped = skipped;
  return { files: files.length, dirs: dirs.length, skipped };
}

/** staging 落盘快照（native 直读真盘，快路径）：rel(含挂载前缀) → { kind, mtimeMs, size }。 */
export function snapshotStaging(mountPath) {
  const mount = mountOf(mountPath);
  if (!mount || !isStagingReady(mount)) return null;
  const out = new Map();
  const stack = [mount];
  while (stack.length) {
    const dir = stack.pop();
    let names;
    try {
      names = native.readdirSync(dir, { withFileTypes: true });
    } catch {
      out.set(dir, { kind: "dir", mtimeMs: 0, size: 0 });
      continue;
    }
    out.set(dir, { kind: "dir", mtimeMs: 0, size: 0 });
    for (const ent of names) {
      const p = dir + "/" + ent.name;
      const isDir = typeof ent.isDirectory === "function" ? ent.isDirectory() : false;
      if (isDir) {
        stack.push(p);
        out.set(p, { kind: "dir", mtimeMs: 0, size: 0 });
      } else {
        let mtimeMs = 0;
        let size = 0;
        try {
          const stt = native.statSync(p);
          mtimeMs = Number(stt.mtimeMs ?? 0);
          size = Number(stt.size ?? 0);
        } catch {
          /* stat 失败仍记 0：回写 diff 会把它当"可能改过"（size/mtime 不等）如实回写 */
        }
        out.set(p, { kind: "file", mtimeMs, size });
      }
    }
  }
  return out;
}

/**
 * 回写：staging（命令跑完后）对快照取 diff，新增/修改/删除落回 SAF。
 * 返回 { written, deleted, failed, errors[] }；调用方（tool-engine）把 failed>0 的事实
 * 附进 Bash 结果——"命令改了但没落回工作区"绝不能静默。
 */
export async function writeBackStaging(mountPath, snapshot) {
  const mount = mountOf(mountPath);
  if (!mount || !snapshot || !isStagingReady(mount)) return null;
  const after = snapshotStaging(mount);
  if (!after) return null;
  let written = 0;
  let deleted = 0;
  let failed = 0;
  const errors = [];
  const fail = (p, e) => {
    failed += 1;
    if (errors.length < 3) errors.push(`${p}: ${String(e?.message ?? e)}`);
  };

  // 1) 新增与修改（含 file↔dir 类型翻转：先删再建）
  for (const [p, meta] of after) {
    const before = snapshot.get(p);
    if (before && before.kind === meta.kind) {
      if (meta.kind === "dir") continue;
      if (before.mtimeMs === meta.mtimeMs && before.size === meta.size) continue; // 没动
    }
    if (before && before.kind !== meta.kind) {
      try {
        tree.rmSync(p, { recursive: true, force: true });
      } catch (e) {
        fail(p, e);
        continue;
      }
    }
    try {
      if (meta.kind === "dir") {
        tree.mkdir(p, { recursive: true });
      } else {
        const bytes = native.readFileSync(p);
        tree.writeFile(p, bytes, {});
        written += 1;
      }
    } catch (e) {
      fail(p, e);
    }
    await nextTick();
  }

  // 2) 删除（快照里有、staging 里没了 → 命令删了它 → 如实落回 SAF）。
  // 目录用 recursive+force 一把删（子项在快照里的条目随后也会各自尝试，force 吞 ENOENT）。
  for (const [p, meta] of snapshot) {
    if (after.has(p)) continue;
    if (p === mount) continue; // 挂载根不动
    try {
      tree.rmSync(p, { recursive: meta.kind === "dir", force: true });
      deleted += 1;
    } catch (e) {
      fail(p, e);
    }
    await nextTick();
  }
  return { written, deleted, failed, errors };
}

/** 测试/自检用：把 staging 状态清零（不动物理盘——盘上残渣由下次物化的清空逻辑处理）。 */
export function resetStaging() {
  mounts.clear();
}
