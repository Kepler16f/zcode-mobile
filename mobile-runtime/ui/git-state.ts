import type { MobileGitVersion } from "./git-diff.js";
import { gitRelativePath } from "./git-path.js";

type GitScanApi = Record<"readObject" | "getConfig" | "walk" | "TREE" | "STAGE" | "WORKDIR" | "hashBlob" | "isIgnored", (...args: any[]) => any>;
export type GitScanContext = { git: GitScanApi; fs: any; dir: string };
type Entry = { type(): Promise<string>; mode(): Promise<number>; oid(): Promise<string>; content(): Promise<Uint8Array | undefined> };
export type GitFileState = { file: string; head: MobileGitVersion | null; index: MobileGitVersion | null; work: MobileGitVersion | null; conflicted: boolean };

export function sameGitVersion(a: MobileGitVersion | null, b: MobileGitVersion | null): boolean {
  return a === b || Boolean(a && b && a.oid === b.oid && a.mode === b.mode && a.type === b.type);
}

export async function readGitVersion(ctx: GitScanContext, version: MobileGitVersion): Promise<Uint8Array> {
  // STAGE walker 没有 content()，必须用索引里的 blob OID 读取对象。
  if (version.bytes !== undefined) return version.bytes;
  const object = await ctx.git.readObject({ fs: ctx.fs, dir: ctx.dir, oid: version.oid, format: "content" });
  if (object.type !== "blob") throw new Error("Git 对象不是文件 blob");
  return new Uint8Array(object.object);
}

async function unmergedPaths(ctx: GitScanContext): Promise<Set<string>> {
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await ctx.fs.promises.readFile(`${ctx.dir}/.git/index`)); }
  catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") return new Set();
    throw error;
  }
  // isomorphic-git 当前只支持 index v2；先校验长度，绝不把损坏索引当作干净仓库。
  if (bytes.length < 32 || new TextDecoder().decode(bytes.subarray(0, 4)) !== "DIRC") throw new Error("Git 索引格式无效");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4) !== 2) throw new Error("移动端 Git 暂不支持此索引版本");
  const count = view.getUint32(8), end = bytes.length - 20, paths = new Set<string>();
  let offset = 12;
  for (let i = 0; i < count; i++) {
    if (offset + 62 >= end) throw new Error("Git 索引条目不完整");
    const flags = view.getUint16(offset + 60);
    const zero = bytes.indexOf(0, offset + 62);
    if (zero < 0 || zero >= end) throw new Error("Git 索引路径不完整");
    if (flags & 0x3000) paths.add(new TextDecoder().decode(bytes.subarray(offset + 62, zero)));
    offset += Math.ceil((zero - offset + 1) / 8) * 8;
    if (offset > end) throw new Error("Git 索引条目越界");
  }
  return paths;
}

export async function scanGitStates(ctx: GitScanContext, target?: string): Promise<GitFileState[]> {
  const rows: GitFileState[] = [];
  const filemode = await ctx.git.getConfig({ fs: ctx.fs, dir: ctx.dir, path: "core.filemode" });
  const conflicts = await unmergedPaths(ctx);
  await ctx.git.walk({
    fs: ctx.fs, dir: ctx.dir, trees: [ctx.git.TREE({ ref: "HEAD" }), ctx.git.STAGE(), ctx.git.WORKDIR({ refresh: false })],
    // 默认 walker 会并发展开所有文件，逐项读取避免整仓库同时分配内存。
    iterate: async (walk: (child: unknown) => Promise<unknown>, children: Iterable<unknown>) => {
      const results: unknown[] = [];
      for (const child of children) results.push(await walk(child));
      return results;
    },
    map: async (name: string, entries: Array<Entry | null>) => {
      if (name.split("/").some(part => part.toLowerCase() === ".git")) return null;
      if (target && name !== "." && name !== target && !target.startsWith(name + "/")) return null;
      if (name === ".") return undefined;
      const [h, s, w] = entries;
      const types = await Promise.all(entries.map(entry => entry?.type() ?? null));
      if (!types.some(type => type && type !== "tree")) return undefined;
      // 仅过滤未跟踪文件；已跟踪文件即使命中 ignore 仍要报告。
      if (!h && !s && await ctx.git.isIgnored({ fs: ctx.fs, dir: ctx.dir, filepath: name })) return null;
      const version = async (entry: Entry | null | undefined, type: string | null | undefined): Promise<MobileGitVersion | null> =>
        entry && type && type !== "tree" ? { oid: await entry.oid(), mode: await entry.mode(), type } : null;
      const head = await version(h, types[0]), index = await version(s, types[1]);
      let work: MobileGitVersion | null = null;
      if (w && types[2] && types[2] !== "tree") {
        if (types[2] !== "blob") throw new Error(`Git 无法读取特殊文件：${name}`);
        const bytes = await w.content();
        if (!bytes) throw new Error(`Git 无法读取工作树文件：${name}`);
        // WORKDIR.oid() 可复用过时的 stat 缓存，同秒同尺寸改动必须重新 hash。
        const { oid } = await ctx.git.hashBlob({ object: bytes });
        let mode = await w.mode();
        if ((filemode === false || filemode === "false") && index && (mode & 0o170000) === (index.mode & 0o170000)) mode = index.mode;
        work = { oid, mode, type: types[2], bytes };
      }
      const conflicted = conflicts.has(name);
      if (target || conflicted || !sameGitVersion(head, index) || !sameGitVersion(index, work)) rows.push({ file: name, head, index, work: sameGitVersion(index, work) ? index : work, conflicted });
      return undefined;
    },
  });
  return rows.sort((a, b) => a.file.localeCompare(b.file));
}

/** 先验证全部路径，再把目录中的已删除跟踪文件与现存文件一同暂存。 */
export async function stageGitPaths(ctx: GitScanContext & { git: GitScanApi & { add: (...args: any[]) => any; remove: (...args: any[]) => any } }, inputs: string[]): Promise<void> {
  if (!inputs.length) throw new Error("没有指定需要暂存的路径");
  const paths = [...new Set(inputs.map(path => gitRelativePath(ctx.dir, path, true)))];
  const states = await scanGitStates(ctx);
  const removed = new Set<string>();
  const existing: string[] = [];
  for (const path of paths) {
    const matching = states.filter(state => state.index && !state.work && (path === "." || state.file === path || state.file.startsWith(`${path}/`)));
    for (const state of matching) removed.add(state.file);
    try {
      await ctx.fs.promises.lstat(`${ctx.dir}/${path}`);
      existing.push(path);
    } catch (error) {
      if ((error as { code?: string })?.code !== "ENOENT" || !matching.length) throw error;
    }
  }
  for (const filepath of existing) await ctx.git.add({ fs: ctx.fs, dir: ctx.dir, filepath });
  for (const filepath of removed) await ctx.git.remove({ fs: ctx.fs, dir: ctx.dir, filepath });
}
