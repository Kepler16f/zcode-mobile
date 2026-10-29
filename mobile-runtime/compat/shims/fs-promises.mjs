import * as vfs from "../vfs.mjs";

// Node 的 promises API 全部走同一份内存后端；异常沿用 ENOENT 等 code，
// 因为 core 的错误分支是按 code 判定的（见 contracts/src/interfaces/file-system.port.ts）。
const wrap = (fn) => async (...args) => fn(...args);

export const readFile = wrap((p, o) => vfs.readFileSync(p, o));
export const writeFile = wrap((p, d, o) => vfs.writeFile(p, d, o, "writeFile"));
export const appendFile = wrap((p, d, o) => vfs.writeFile(p, d, { ...(typeof o === "string" ? { encoding: o } : o), flag: "a" }, "appendFile"));
export const mkdir = wrap((p, o) => vfs.mkdir(p, o, "mkdir"));
export const readdir = wrap((p, o) => vfs.readdirSync(p, o));
function statShape(value, options) {
  if (!options?.bigint) return value;
  return {...value, size:BigInt(value.size), dev:BigInt(value.dev??0), ino:BigInt(value.ino??0),
    mtimeNs:BigInt(Math.round((value.mtimeMs??0)*1e6)),ctimeNs:BigInt(Math.round((value.ctimeMs??value.mtimeMs??0)*1e6))};
}
export const stat = wrap((p,o) => statShape(vfs.statSync(p),o));
export const lstat = wrap((p,o) => statShape(vfs.lstatSync(p),o));
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

// 技能复制需要目录树；预先扫描并拒绝符号链接，避免越界或先复制一半才发现无法支持。
export const cp = wrap(async (a, b, options = {}) => {
  const entries = [];
  const join = (base, name) => `${String(base).replace(/\/+$/, "")}/${name}`;
  function scan(source, destination) {
    const stat = vfs.lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error(`cp: 不支持复制包含符号链接的技能目录: ${source}`);
    if (stat.isDirectory()) {
      if (!options.recursive) throw new Error(`cp: ${source} 是目录，必须指定 recursive`);
      entries.push({ source, destination, directory: true });
      for (const entry of vfs.readdirSync(source, { withFileTypes: true })) scan(join(source, entry.name), join(destination, entry.name));
    } else if (stat.isFile()) entries.push({ source, destination, directory: false });
    else throw new Error(`cp: 不支持的文件类型: ${source}`);
  }
  scan(a, b);
  for (const entry of entries) {
    if (vfs.existsSync(entry.destination)) {
      const stat = vfs.lstatSync(entry.destination);
      if (stat.isSymbolicLink()) throw new Error(`cp: 目标不能是符号链接: ${entry.destination}`);
      if (!entry.directory && options.force === false) {
        if (options.errorOnExist) throw Object.assign(new Error(`EEXIST: ${entry.destination}`), { code: "EEXIST" });
        continue;
      }
    }
    if (entry.directory) vfs.mkdir(entry.destination, { recursive: true }, "mkdir");
    else vfs.writeFile(entry.destination, vfs.readFileSync(entry.source), {}, "copyFile");
  }
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
  if (typeof flag === 'number') {
    if ((flag & 131072) && vfs.lstatSync(p).isSymbolicLink()) throw Object.assign(new Error('不允许跟随符号链接'),{code:'ELOOP'});
    flag = (flag & 3) === 0 ? 'r' : (flag & 0o2000) ? 'a' : 'w';
  }
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
  // 只读句柄固定字节快照，后续rename/替换路径不会把记忆预览换成另一份内容。
  const snapshot = flag === 'r' ? Buffer.from(vfs.readFileSync(p)) : null;
  const snapshotStat = snapshot ? vfs.statSync(p) : null;
  let closed = false;
  return {
    async readFile(opts) {
      if (append) throw new Error("append handle read not supported");
      if (closed) throw new Error('FileHandle已关闭');
      if (snapshot) {const enc=typeof opts==='string'?opts:opts?.encoding;return enc?snapshot.toString(enc):Buffer.from(snapshot);}
      return vfs.readFileSync(p, opts);
    },
    async read(buffer, offset=0, length=buffer.length-offset, position=0) {
      if (closed || !snapshot) throw new Error('只支持已打开的只读句柄');
      const bytesRead=Math.max(0,Math.min(length,snapshot.length-position));
      buffer.set(snapshot.subarray(position,position+bytesRead),offset);
      return {bytesRead,buffer};
    },
    async writeFile(data, opts) {
      vfs.writeFile(p, data, { ...(typeof opts === "string" ? { encoding: opts } : opts), flag: append ? "a" : "w" }, "writeFile");
    },
    async stat(options) { return statShape(snapshotStat ?? vfs.statSync(p),options); },
    async truncate() { vfs.writeFile(p, new Uint8Array(0), {}, "truncate"); },
    // fsync：端侧没有可 fsync 的对象（写入已经是同步桥的一发一收，桥返回即落盘），
    // 做成空操作而不是报错——0.7.1 之前这里缺方法，装机的表现是保存钩子时
    // "i.sync is not a function"（settings → 钩子 → 新建 → 保存 全链路失败）。
    async sync() {},
    async close() {closed=true;},
    get fd() { return -1; },
  };
}
