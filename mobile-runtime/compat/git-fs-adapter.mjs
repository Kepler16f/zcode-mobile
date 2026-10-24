// isomorphic-git 的 fs 适配器（0.6.1，用户点名"能不能内置 git"）：把 compat/vfs 的同步形状
// 包成 isomorphic-git 要求的异步 fs。git 只被允许跑在私有盘工作区（/work）——SAF 树（/mnt）
// 每次桥往返 30-40ms，isomorphic-git 的 statusMatrix 会对全仓库逐文件 stat，一棵大树上要
// 数分钟且全是主线程同步往返，那里如实拒绝（见 ui/git-tool.ts 的注册条件）。
//
// 形状契约（isomorphic-git 1.x）：命令收到 `fs` 后直接按 Promise 语义调方法，部分内部路径
// 会先看 fs.promises——两份都给，同一组实现。stat 形状只需 isFile/isDirectory/isSymbolicLink/
// size/mtimeMs，vfs 的 statSync 天然满足；symlink 在 Android 沙箱里不存在，如实 EINVAL。

function normalizeOpts(opts) {
  if (opts === undefined || opts === null) return {};
  return typeof opts === "string" ? { encoding: opts } : opts;
}

// isomorphic-git 的 normalizeStats 直接读 ctimeSeconds/ctimeMs/ctime、dev 等字段，
// vfs 的 stat 没有 ctime/dev——这里补齐（ctime 取 mtime，dev 给 0），不让它在 valueOf 上炸。
function enrichStat(st) {
  const ms = Number(st.mtimeMs ?? 0);
  return {
    ...st,
    ctimeMs: ms,
    ctime: st.ctime ?? new Date(ms),
    dev: st.dev ?? 0,
    blksize: 4096,
    blocks: Math.ceil(Number(st.size ?? 0) / 512),
  };
}

export function createGitFs(vfsImpl) {
  const api = {
    async readFile(path, opts) {
      const o = normalizeOpts(opts);
      // isomorphic-git 读二进制时不传 encoding（拿字节），读文本传 "utf8"/"utf-8"。
      const enc = o.encoding === "utf8" || o.encoding === "utf-8" ? "utf8" : undefined;
      return vfsImpl.readFileSync(path, enc);
    },
    async writeFile(path, data, opts) {
      const o = normalizeOpts(opts);
      // git 对象文件写的是字节/字符串都可能出现；vfs.toBytes 两种都吃。
      await Promise.resolve();
      vfsImpl.writeFile(path, data, o.flag ? { flag: o.flag } : {});
    },
    async unlink(path) {
      vfsImpl.unlinkSync(path);
    },
    async readdir(path) {
      // isomorphic-git 只要名字列表（自己会对每项 lstat）；withFileTypes 形态也接，仍回名字。
      return vfsImpl.readdirSync(path);
    },
    async mkdir(path, opts) {
      // isomorphic-git 建 .git 内部结构时不保证逐级创建；vfs 的 recursive mkdir 幂等，恒走它。
      void opts;
      vfsImpl.mkdir(path, { recursive: true });
    },
    async rmdir(path, opts) {
      const o = normalizeOpts(opts);
      if (o.recursive) vfsImpl.rmSync(path, { recursive: true, force: false });
      else vfsImpl.rmdir(path);
    },
    async stat(path) {
      return enrichStat(vfsImpl.statSync(path));
    },
    async lstat(path) {
      return enrichStat(vfsImpl.lstatSync(path));
    },
    async readlink(path) {
      const err = new Error(`readlink 不被支持（Android 沙箱没有符号链接）: ${path}`);
      err.code = "EINVAL";
      err.errno = -22;
      throw err;
    },
    // bindFs 要求十个方法都在（symlink 缺席会在 .bind 处炸）；沙箱里真用即如实 EINVAL。
    async symlink(target, path) {
      const err = new Error(`symlink 不被支持（Android 沙箱没有符号链接）: ${path} → ${target}`);
      err.code = "EINVAL";
      err.errno = -22;
      throw err;
    },
    async realpath(path) {
      return vfsImpl.realpathSync(path);
    },
  };
  return { ...api, promises: api };
}
