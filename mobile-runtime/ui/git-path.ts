// Git 自己会从工作树、仓库配置和远端树生成路径，单独检查工具参数不能限制这些间接 I/O。
const marker = Symbol.for("zcode.mobile.git.scoped-fs");

function normalize(path: string): string {
  const value = path.replace(/\\/g, "/");
  const drive = /^[A-Za-z]:/.exec(value)?.[0] ?? "";
  const absolute = value.startsWith("/") || Boolean(drive && value[2] === "/");
  if (!absolute) throw new Error("Git 文件系统需要绝对工作区路径");
  const parts: string[] = [];
  for (const part of value.slice(drive.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${drive}/${parts.join("/")}`;
}

function inRoot(root: string, candidate: string): boolean {
  const left = /^[A-Za-z]:/.test(root) ? root.toLowerCase() : root;
  const right = /^[A-Za-z]:/.test(root) ? candidate.toLowerCase() : candidate;
  return right === left || right.startsWith(left.endsWith("/") ? left : `${left}/`);
}

export function gitRelativePath(dir: string, input: string, allowRoot = false): string {
  if (typeof input !== "string" || input.includes("\0")) throw new Error("Git 路径无效");
  let value = input.replace(/\\/g, "/");
  const root = normalize(dir);
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    const absolute = normalize(value);
    if (!inRoot(root, absolute) || absolute === root) {
      if (allowRoot && absolute === root) return ".";
      throw new Error("Git 路径越出当前工作区");
    }
    value = absolute.slice(root.endsWith("/") ? root.length : root.length + 1);
  }
  const parts = value.split("/").filter(part => part && part !== ".");
  if (parts.some(part => part === ".." || part.toLowerCase() === ".git" || part.includes(":"))) throw new Error("Git 路径无效或越出当前工作区");
  if (!parts.length) {
    if (allowRoot) return ".";
    throw new Error("Git 路径无效或越出当前工作区");
  }
  return parts.join("/");
}

/** 限定 isomorphic-git 的真实 fs 调用，包括读取到的 Git 目录和 checkout 路径。 */
export function scopedGitFs(fs: any, dir: string): any {
  const root = normalize(dir);
  if (fs?.[marker] === root) return fs;
  const source = fs?.promises ?? fs;
  if (!source || typeof source.lstat !== "function") throw new Error("Git 文件系统不能验证路径边界");
  const check = async (input: unknown, followLeaf: boolean): Promise<string> => {
    if (typeof input !== "string" || input.includes("\0")) throw new Error("Git 文件路径无效");
    const value = input.replace(/\\/g, "/");
    const absolute = normalize(value.startsWith("/") || /^[A-Za-z]:\//.test(value) ? value : `${root}/${value}`);
    if (!inRoot(root, absolute)) throw new Error("Git 文件操作越出当前工作区");
    const suffix = absolute.slice(root.endsWith("/") ? root.length : root.length + 1);
    const parts = suffix.split("/").filter(Boolean);
    let prefix = root.replace(/\/$/, "") || "/";
    for (let i = 0; i < parts.length - (followLeaf ? 0 : 1); i++) {
      prefix = `${prefix === "/" ? "" : prefix}/${parts[i]}`;
      try {
        const stat = await source.lstat(prefix);
        // 不能让已有链接把 index、checkout 或 clone 重定向到其它工作区。
        if (stat.isSymbolicLink()) throw new Error(`Git 路径包含符号链接：${prefix}`);
      } catch (error) {
        if ((error as { code?: string })?.code === "ENOENT") break;
        throw error;
      }
    }
    return absolute;
  };
  const output: Record<string | symbol, any> = {};
  for (const name of ["readFile", "writeFile", "unlink", "readdir", "mkdir", "rmdir", "stat", "lstat", "readlink", "realpath", "rename", "chmod"]) {
    if (typeof source[name] !== "function") continue;
    output[name] = async (path: unknown, ...args: unknown[]) => {
      const safe = await check(path, !["lstat", "readlink", "unlink", "rename"].includes(name));
      if (name === "rename") {
        const destination = await check(args[0], true);
        return source[name](safe, destination, ...args.slice(1));
      }
      return source[name](safe, ...args);
    };
  }
  // Android 的 Git FS 暂不支持创建链接；让 checkout 明确报错，而不是创建跨工作区链接。
  output.symlink = async () => { throw new Error("移动端 Git 暂不支持创建符号链接"); };
  output.promises = output;
  output[marker] = root;
  return output;
}
