import * as vfs from "../vfs.mjs";

// Node 的 promises API 全部走同一份内存后端；异常沿用 ENOENT 等 code，
// 因为 core 的错误分支是按 code 判定的（见 contracts/src/interfaces/file-system.port.ts）。
const wrap = (fn) => async (...args) => fn(...args);

export const readFile = wrap((p, o) => vfs.readFileSync(p, o));
export const writeFile = wrap((p, d, o) => vfs.writeFile(p, d, o, "writeFile"));
export const appendFile = wrap((p, d, o) => vfs.writeFile(p, d, { ...(typeof o === "string" ? { encoding: o } : o), flag: "a" }, "appendFile"));
export const mkdir = wrap((p, o) => vfs.mkdir(p, o, "mkdir"));
export const readdir = wrap((p, o) => vfs.readdirSync(p, o));
export const stat = wrap((p) => vfs.statSync(p));
export const lstat = wrap((p) => vfs.lstatSync(p));
export const access = wrap((p, m) => vfs.accessSync(p, m));
export const unlink = wrap((p) => vfs.unlinkSync(p));
export const rename = wrap((a, b) => vfs.renameSync(a, b));
export const rm = wrap((p, o) => vfs.rmSync(p, o));
export const realpath = wrap((p) => vfs.realpathSync(p));
export const mkdtemp = wrap((p) => vfs.mkdtempSync(p));
export const copyFile = wrap((a, b) => vfs.writeFile(b, vfs.readFileSync(a), {}, "copyFile"));
export const rmdir = wrap((p) => vfs.rmdir(p));
// 端侧 vfs 没有权限位，chmod 做成空操作而不是报错：上游拿它做"新建文件后收紧权限"的收尾，
// 在手机上没有可收紧的对象，报错只会让写文件这条主路径失败。
export const chmod = wrap(() => {});

// cp 在 Node 里能递归拷目录，而 callers（services/src/paths.ts）用它做单文件原子复制。
// 这里只做单文件；目录递归目前没需求，遇到了就明确报错，别安静地拷出半棵树。
export const cp = wrap(async (a, b) => {
  if (vfs.statSync(a).isDirectory()) throw new Error(`cp: 端侧垫片只做单文件拷贝，${a} 是目录`);
  vfs.writeFile(b, vfs.readFileSync(a), {}, "copyFile");
});

// 端侧 vfs 没有硬链接，settings-sync 用 link 只是"把一个路径再挂一个名字"。
// 这里按拷贝实现，但保留 link 的 EEXIST 语义：静默覆盖会让配置同步在真机上写出半个文件。
export const link = wrap(async (a, b) => {
  if (vfs.existsSync(b)) {
    throw Object.assign(new Error(`EEXIST: file already exists, link '${a}' -> '${b}'`), { code: "EEXIST", errno: -17, syscall: "link", path: a, dest: b });
  }
  vfs.writeFile(b, vfs.readFileSync(a), {}, "copyFile");
});

export const symlink = wrap((t, p) => vfs.symlinkSync(t, p));

export async function open(p, flag = "r") {
  const append = flag.includes("a");
  // "wx" = 独占创建（真 Node 里已存在就 EEXIST）。上游的原子写（workspace-hook-mutation.ts）
  // 就是靠它保证临时文件不撞名；垫片曾经把这层语义吞掉，撞上就变成静默截断别人写的临时文件。
  if (flag.includes("x") && vfs.existsSync(p)) {
    throw Object.assign(new Error(`EEXIST: file already exists, open '${p}'`), {
      code: "EEXIST",
      errno: -17,
      syscall: "open",
      path: p,
    });
  }
  return {
    async readFile(opts) {
      if (append) throw new Error("append handle read not supported");
      return vfs.readFileSync(p, opts);
    },
    async writeFile(data, opts) {
      vfs.writeFile(p, data, { ...(typeof opts === "string" ? { encoding: opts } : opts), flag: append ? "a" : "w" }, "writeFile");
    },
    async stat() { return vfs.statSync(p); },
    async truncate() { vfs.writeFile(p, new Uint8Array(0), {}, "truncate"); },
    // fsync：端侧没有可 fsync 的对象（写入已经是同步桥的一发一收，桥返回即落盘），
    // 做成空操作而不是报错——0.7.1 之前这里缺方法，装机的表现是保存钩子时
    // "i.sync is not a function"（settings → 钩子 → 新建 → 保存 全链路失败）。
    async sync() {},
    async close() {},
    get fd() { return -1; },
  };
}
