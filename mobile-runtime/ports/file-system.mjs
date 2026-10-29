// FileSystemPort 的端侧实现（M2 第一个 port）。
// 契约来自 contracts/src/interfaces/file-system.port.ts，逐字段对齐，不自己发明返回形状。
// 现在后端是 compat/vfs（内存）；换成 OPFS/SAF 只改 backend，调用方不动。

// 0.7.9：相对路径归一必须**绑定本端口的 workspaceRoot**。写死 "/work" 是症状 1
// （"工作区指定没有生效"）的直接来源：模型给相对路径（core 的 path-policy 会先按
// workingDirectory 折成绝对，但 Glob 的 path、searchText 的 path 等入口仍可能带相对段进来），
// 一旦落到 "/work/…"，越界闸把它当 /work 工作区成员放行——选了 /mnt/proj 或
// /sdcard/Download 的会话里，文件却写进了私有盘 /work，用户看到的就是"会话没在指定文件夹里干活"。
// 现在相对段一律落在本工作区根；非 /work 工作区里指向 /work 的绝对路径当场 permission_denied。
import { localWorkspacePath } from "../compat/workspace-aliases.mjs";
function normalizePath(p, fallbackRoot = "/work") {
  p = localWorkspacePath(p);
  fallbackRoot = localWorkspacePath(fallbackRoot);
  const s = String(p ?? "").replace(/\\/g, "/");
  const abs = s.startsWith("/") || /^[A-Za-z]:\//.test(s);
  // 相对路径的 .. 必须相对于工作区根消解，不能先在空数组里丢掉再拼根。
  const input = abs ? s : `${fallbackRoot.replace(/\/+$/, "")}/${s}`;
  const out = [];
  for (const seg of input.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  const path = "/" + out.join("/");
  // 主存储的多种拼写必须共用同一边界，不能靠别名绕过工作区检查。
  for (const alias of ["/storage/emulated/0", "/storage/self/primary", "/ext"]) {
    if (path === alias || path.startsWith(alias + "/")) return "/sdcard" + path.slice(alias.length);
  }
  return path;
}

// core 侧用 isFileSystemPortError(e)（instanceof）分支，普通 Error 会被当成意外故障，
// 所以错误类由调用方注入（宿主从 @zcode/contracts 取），避免 port 反向依赖上游。
function makeErr(FSCtor, code, message, path, cause) {
  if (FSCtor) {
    const e = new FSCtor({ code, message, path, ...(cause === undefined ? {} : { cause }) });
    return e;
  }
  const e = new Error(message);
  e.name = "FileSystemPortError";
  e.code = code;
  if (path !== undefined) e.path = path;
  return e;
}

const enc = (e) => (e === "utf-8" ? "utf8" : e ?? "utf8");

function bytesOf(content, encoding) {
  if (encoding === "latin1" || encoding === "binary") {
    return new Uint8Array([...content].map((c) => c.charCodeAt(0) & 0xff));
  }
  return new TextEncoder().encode(content);
}

function decode(bytes, encoding) {
  return new TextDecoder(enc(encoding)).decode(bytes);
}

function detectLineEndings(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? "CRLF" : "LF";
}

function toRevision(node) {
  return { id: `${node.path}@${node.mtimeMs}`, mtimeMs: node.mtimeMs, sizeBytes: node.data.length };
}

function globToRegExp(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        const nxt = pattern[i + 2];
        re += nxt === "/" ? "(?:.*/)?" : ".*";
        i += nxt === "/" ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if ("\\^$.|+()[]{}".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp("(^|/)" + re + "$");
}

// 每过这么多条目让出一次主线程（0.4.10，装机"有时整个应用卡死"）。
// SAF 树桥每条 readdir/stat 是 30-40ms 的**同步**往返（真机 M8 读数 writeMs=30.6/readMs=40.5），
// 整棵树 walk + 256 文件一批的 readMany 串起来是几秒到几十秒的连续阻塞：Chromium 主线程
// 被堵死时触摸事件全部排队——装机表现就是"点什么都没反应，过一阵突然活了"。
// 让出不是加速，是把"一次几秒的死区"切成"每 ~1s 一个可呼吸点"：期间点击/滚动照常分发，
// 扫描总时长不变。32 条目 ≈ 最坏 32×40ms≈1.3s 一段，比 256 一批细得多。
const YIELD_EVERY_ENTRIES = 32;
const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

async function walk(fs, root, out = [], ctx = { n: 0 }, check = p => p) {
  for (const e of fs.readdirSync(check(root), { withFileTypes: true })) {
    const full = (root === "/" ? "" : root) + "/" + e.name;
    if (++ctx.n >= YIELD_EVERY_ENTRIES) {
      ctx.n = 0;
      await yieldToUi();
    }
    // 遍历期间让出了主线程，目录可能被替换；每项使用前重新验证，拒绝的链接直接跳过。
    try {
      check(full);
      if (e.isDirectory()) await walk(fs, full, out, ctx, check);
      else out.push(full);
    } catch (e) {
      if (!["permission_denied", "ENOENT"].includes(e?.code)) throw e;
    }
  }
  return out;
}

export function createMobileFileSystemPort(vfsImpl, opts = {}) {
  const FileSystemPortError = opts.FileSystemPortError;
  const err = (code, message, path, cause) => makeErr(FileSystemPortError, code, message, path, cause);
  const selectedRoot = normalizePath(opts.workspaceRoot ?? "/work");
  let root = selectedRoot;
  const t0 = () => Number(performance.now());
const ms = (from) => Math.max(0, Math.round(Number(performance.now()) - from));

  // 0.5.0：授权扩展根（用户点名"读 sandbox 外的文件被直接禁止不好，应改为询问授权"）。
  // grantRoot(path) 把一个额外根加进白名单——guard 对 root 和 grantedRoots 一视同仁。
  // 调用方（agent.ts 的审批重试）负责"问用户"这一步，这里只管"记下用户批了什么"。
  // 不做通配/前缀模糊匹配：批的是哪个目录就开哪个目录，最小授权面。
  const grantedRoots = [];
  function grantRoot(path) {
    const n = resolveLinks(normalizePath(String(path ?? ""), root), p => p);
    if (!n || n === "/") return; // 根目录不批（等于全盘放开，那不是"询问授权"是"没有沙箱"）
    if (!grantedRoots.includes(n)) grantedRoots.push(n);
  }
  /** 撤销一次授权（"允许这一次"用完即收）：比 grantRoot 多删一项，语义对称。 */
  function revokeRoot(path) {
    const n = resolveLinks(normalizePath(String(path ?? ""), root), p => p);
    const i = grantedRoots.indexOf(n);
    if (i >= 0) grantedRoots.splice(i, 1);
  }
  function isGranted(p) {
    return grantedRoots.some((r) => p === r || p.startsWith(r + "/"));
  }

  const guard = (p) => {
    let n = normalizePath(p, root);
    // 用户选中的目录本身可能是链接：保留用户使用该路径的能力，统一落到已解析的真实根。
    if (selectedRoot !== root && (n === selectedRoot || n.startsWith(selectedRoot + "/"))) {
      n = root + n.slice(selectedRoot.length);
    }
    // 系统的全盘权限仅表示桥有能力访问；会话仍只能访问选中的目录和明确批准的路径。
    const inRoot = n === root || n.startsWith(root + "/");
    if (inRoot || isGranted(n)) return n;
    // 错误里带上路径：上层（agent.ts）拿它去问用户"模型想读这个文件，允许吗"。
    throw err("permission_denied", `路径越出授权工作区: ${n}`, n);
  };

  // 下载可能覆盖已有文件，也可能经目录链接写到其它工作区。仅检查词法路径会漏掉
  // 链接目标；逐段解析并对真实目标再次使用同一授权闸，拒绝时保留目标路径供用户授权。
  // SAF 树自身不支持符号链接；/mnt 是虚拟容器，只有 /mnt/<挂载名> 才能交给树后端。
  function resolveLinks(p, authorize, followFinalLink = true) {
    let path = authorize(normalizePath(p, root));
    if (typeof vfsImpl.lstatSync !== "function" || typeof vfsImpl.readlinkSync !== "function") {
      throw err("unsupported", "当前文件后端不能验证下载路径中的符号链接", path);
    }
    let links = 0;
    while (true) {
      const segments = path.split("/").filter(Boolean);
      let prefix = "";
      let redirected = false;
      for (let i = 0; i < segments.length; i++) {
        const parent = prefix || "/";
        prefix += `/${segments[i]}`;
        // /sdcard 是 Android 的基础设施链接，normalizePath 已将其真实目标统一回此拼写。
        if (prefix === "/mnt" || prefix === "/sdcard") continue;
        if (!followFinalLink && i === segments.length - 1) break;
        let st;
        try {
          st = vfsImpl.lstatSync(prefix);
        } catch (e) {
          // 此处往后的父目录都还不存在，不可能包含已有的符号链接。
          if (e?.code === "ENOENT") break;
          throw e;
        }
        if (!st.isSymbolicLink()) continue;
        if (++links > 40) throw err("invalid_path", `符号链接层数过多: ${path}`, path);
        const target = String(vfsImpl.readlinkSync(prefix));
        const resolved = target.startsWith("/") ? target : `${parent}/${target}`;
        path = authorize(normalizePath(`${resolved}/${segments.slice(i + 1).join("/")}`, root));
        redirected = true;
        break;
      }
      if (!redirected) return path;
    }
  }

  // 用户明确选中的链接目录本身是合法根；后续边界一律按其真实目标比较。
  root = resolveLinks(root, p => p);
  function checkAccess(p, { followFinalLink = true } = {}) {
    return resolveLinks(p, guard, followFinalLink);
  }

  const readNode = (n, syscall) => {
    try {
      const st = vfsImpl.statSync(n);
      if (!st.isFile()) throw err(st.isDirectory() ? "is_directory" : "not_file", `${n} 不是文件`, n);
      return st;
    } catch (e) {
      if (e.code && e.code !== "ENOENT") throw e;
      throw err("not_found", `文件不存在: ${n}`, n, e);
    }
  };

  const readBytes = (n, maxBytes) => {
    const st = readNode(n, "open");
    if (maxBytes !== undefined && st.size > maxBytes) {
      throw err("too_large", `文件超过 ${maxBytes} 字节上限: ${n}`, n);
    }
    return { st, bytes: vfsImpl.readFileSync(n) };
  };

  async function stat(request) {
    const path = checkAccess(request.path);
    if (!vfsImpl.existsSync(path)) return { path, kind: "missing", sizeBytes: 0 };
    const st = vfsImpl.statSync(path);
    return {
      path,
      kind: st.isDirectory() ? "directory" : st.isSymbolicLink() ? "symlink" : "file",
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
      revision: st.isFile() ? { id: `${path}@${st.mtimeMs}`, mtimeMs: st.mtimeMs, sizeBytes: st.size } : undefined,
    };
  }

  async function createDirectory(request) {
    const path = checkAccess(request.path);
    vfsImpl.mkdir(path, { recursive: true });
    return { path };
  }

  async function readTextFile(request) {
    const path = checkAccess(request.path);
    const { st, bytes } = readBytes(path, request.maxBytes);
    const encoding = enc(request.encoding);
    const raw = decode(bytes, encoding);
    const lineEndings = detectLineEndings(raw);
    const content = raw.replace(/\r\n/g, "\n");
    return {
      path,
      content,
      encoding: request.encoding ?? "utf-8",
      lineEndings,
      bytesRead: bytes.length,
      sizeBytes: st.size,
      truncated: false,
      revision: toRevision({ path, mtimeMs: st.mtimeMs, data: bytes }),
    };
  }

  async function readBinaryFile(request) {
    const path = checkAccess(request.path);
    const { st, bytes } = readBytes(path, request.maxBytes);
    return { path, content: bytes, bytesRead: bytes.length, sizeBytes: st.size, revision: toRevision({ path, mtimeMs: st.mtimeMs, data: bytes }) };
  }

  async function readTextFileRange(request) {
    const full = await readTextFile({ ...request, maxBytes: undefined });
    const lines = full.content.split("\n");
    const from = request.offsetLine ?? 0;
    const taken = request.limitLines === undefined ? lines.slice(from) : lines.slice(from, from + request.limitLines);
    const truncated = from + taken.length < lines.length;
    const text = taken.join("\n");
    // 契约里 startLine 是 1-based，且 lineCount/totalLines 是必填：
    // ReadOutputSchema 对这三个字段做了 z.number().int() 且对象是 .strict()，少一个就整块校验失败。
    return {
      ...full,
      content: text,
      bytesRead: bytesOf(text, full.encoding).length,
      truncated,
      startLine: from + 1,
      lineCount: taken.length,
      totalLines: lines.length,
    };
  }

  async function writeTextFile(request) {
    const path = checkAccess(request.path);
    if (request.expectedRevision) {
      const cur = await stat({ path });
      if (cur.revision?.id !== request.expectedRevision.id) {
        throw err("stale_write", `写入基于过期版本: ${path}`, path);
      }
    }
    const text = request.lineEndings === "CRLF" ? request.content.replace(/\n/g, "\r\n") : request.content;
    if (request.createParents !== false) {
      const dir = path.slice(0, path.lastIndexOf("/"));
      if (dir) vfsImpl.mkdir(dir, { recursive: true });
    }
    const bytes = bytesOf(text, enc(request.encoding));
    vfsImpl.writeFile(path, bytes, {});
    return { path, bytesWritten: bytes.length, revision: toRevision({ path, mtimeMs: Date.now(), data: bytes }) };
  }

  async function writeBinaryFile(request) {
    // checkAccess 在真正写入前再次运行，防止下载期间授权被撤销或路径发生变化。
    const path = checkAccess(request.path);
    if (request.createParents !== false) {
      const dir = path.slice(0, path.lastIndexOf("/"));
      if (dir) vfsImpl.mkdir(dir, { recursive: true });
    }
    vfsImpl.writeFile(path, request.content, {});
    return { path, bytesWritten: request.content.length };
  }

  async function removeFile(request) {
    const path = checkAccess(request.path, { followFinalLink: false });
    let exists = true;
    try { vfsImpl.lstatSync(path); } catch (e) { if (e?.code === "ENOENT") exists = false; else throw e; }
    if (!exists) {
      if (request.missingOk) return { path, removed: false };
      throw err("not_found", `文件不存在: ${path}`, path);
    }
    vfsImpl.unlinkSync(path);
    return { path, removed: true };
  }

  async function listDirectory(request) {
    const t = t0();
    const path = checkAccess(request.path);
    const entries = vfsImpl.readdirSync(path, { withFileTypes: true }).map((e) => ({
      kind: e.isDirectory() ? "directory" : e.isSymbolicLink() ? "symlink" : "file",
      name: e.name,
      path: (path === "/" ? "" : path) + "/" + e.name,
    }));
    return { durationMs: ms(t), entries, numEntries: entries.length, path };
  }

  async function searchFiles(request) {
    const t = t0();
    const path = checkAccess(request.path);
    const re = globToRegExp(String(request.pattern ?? "").replace(/\\/g, "/"));
    const all = (await walk(vfsImpl, path, [], { n: 0 }, checkAccess)).filter((p) => re.test(p.slice(path.length + 1)));
    const offset = request.offset ?? 0;
    const limit = request.maxResults ?? 2000;
    const files = all.slice(offset, offset + limit);
    return { path, pattern: request.pattern, durationMs: ms(t), files, numFiles: files.length, truncated: offset + files.length < all.length };
  }

  async function searchText(request) {
    const t = t0();
    const path = checkAccess(request.path);
    const mode = request.outputMode ?? "files_with_matches";
    const baseFlags = request.ignoreCase ? "i" : "";
    let compiled;
    try {
      compiled = new RegExp(request.pattern, baseFlags);
    } catch {
      throw err("invalid_pattern", `非法正则: ${request.pattern}`, path);
    }
    const globRe = request.glob ? globToRegExp(request.glob) : null;
    let walked;
    try {
      const st = vfsImpl.statSync(path);
      walked = st.isDirectory() ? await walk(vfsImpl, path, [], { n: 0 }, checkAccess) : [path];
    } catch (e) {
      // 权限和 IO 故障不能伪装成搜索目录不存在。
      if (e?.code !== "ENOENT") throw e;
      throw err("not_found", `搜索路径不存在: ${path}`, path);
    }
    const files = walked.filter((p) => !globRe || globRe.test(p.slice(path.length + 1)));

    const entries = [];
    const hitFiles = [];
    let numMatches = 0;
    const before = Math.max(0, request.beforeContext ?? 0);
    const after = Math.max(0, request.afterContext ?? 0);
    // -B/-A/-o/multiline 是 Grep 的公开入参，端口不能悄悄忽略：忽略了就是返回错结果。
    const scanFile = (file, text) => {
      const lines = text.split("\n");
      const lineRe = compiled;
      // 行号 -> { texts: 命中片段, end: 命中结束的最后一行 }；跨行命中必须带上整段文本，
      // 否则调用方只看到首行，等于把 multiline 的匹配结果丢了。
      const hits = new Map();
      const scan = new RegExp(request.pattern, baseFlags + "g");
      const partsOf = (s) => {
        const out = [];
        scan.lastIndex = 0;
        for (let m, guard = 0; (m = scan.exec(s)) !== null && guard++ < 10000; ) {
          out.push(m[0]);
          if (m.index === scan.lastIndex) scan.lastIndex++;
        }
        return out;
      };

      if (request.multiline) {
        // rg -U 的跨行依赖 . 能吃换行，这里显式补 s，否则 multiline 与不开 multiline 没有区别。
        const span = new RegExp(request.pattern, baseFlags + "gs");
        span.lastIndex = 0;
        for (let m, guard = 0; (m = span.exec(text)) !== null && guard++ < 100000; ) {
          const idx = (text.slice(0, m.index).match(/\n/g) ?? []).length;
          const end = idx + (m[0].split("\n").length - 1);
          if (!hits.has(idx)) hits.set(idx, { texts: [], end });
          const hit = hits.get(idx);
          hit.texts.push(m[0]);
          hit.end = Math.max(hit.end, end);
          if (m.index === span.lastIndex) span.lastIndex++;
        }
      } else {
        lines.forEach((line, i) => {
          lineRe.lastIndex = 0;
          if (!lineRe.test(line)) return;
          hits.set(i, { texts: request.onlyMatching ? partsOf(line) : [line], end: i });
        });
      }

      const count = hits.size;
      if (!count) return;
      numMatches += count;
      if (mode === "content") {
        if (request.onlyMatching) {
          for (const [i, hit] of hits) {
            for (const piece of hit.texts.length ? hit.texts : [lines[i]]) {
              entries.push({ path: file, lineNumber: i + 1, text: piece, matched: true });
            }
          }
        } else {
          const emit = new Map();
          for (const [i, hit] of hits) {
            for (let k = i - before; k <= hit.end + after; k++) {
              if (k < 0 || k >= lines.length || emit.has(k)) continue;
              emit.set(k, {
                path: file,
                lineNumber: k + 1,
                text: k === i ? hit.texts.join("\n") : lines[k],
                matched: hits.has(k),
              });
            }
          }
          for (const k of [...emit.keys()].sort((a, b) => a - b)) entries.push(emit.get(k));
        }
      }
      if (mode === "count") entries.push({ path: file, count });
      hitFiles.push(file);
    };

    // 一批只过桥一次（R23 / §1.5.9）：真盘上逐文件 readFileSync 是 3063 次同步往返 ≈ 1.2 s，
    // 而扫描本身只要 ~56 ms。256 个文件一批是量出来的折中——再大就把整棵树读进 JS 堆，
    // 等于用 R23 换来 R6；实测 256 个平均文本文件约 0.95 MB/批。
    // 0.4.10：SAF 树上的 readMany 在 Kotlin 侧就是**串行逐文件** openInputStream（TreeBridge.kt
    // 注释"树上退化为逐文件读"），一条 256 的批 = 一次 8-10 秒的同步桥调用，JS 无从在其中
    // 让出——装机"整个应用卡死"的主线程死区正是它。树工作区收小到 64（≈2.5s 一段）+ 批间
    // await yieldToUi()：死区切成可呼吸段，点击/滚动在批间照常分发。私有盘（native）维持 256。
    const treeBacked = path.startsWith("/mnt/");
    const CHUNK = treeBacked ? 64 : 256;
    for (let i = 0; i < files.length; i += CHUNK) {
      if (i > 0) await yieldToUi();
      // 批读也必须逐项检查链接，不能让 readMany 绕过单文件入口的授权闸。
      const chunk = files.slice(i, i + CHUNK).flatMap(file => {
        try { return [checkAccess(file)]; }
        catch (e) { if (["permission_denied", "ENOENT"].includes(e?.code)) return []; throw e; }
      });
      const results = vfsImpl.readMany(chunk);
      for (let j = 0; j < chunk.length; j++) {
        const item = results[j];
        if (!item?.ok) continue; // 读不到（不存在/目录/断链）按 ripgrep 默认行为跳过
        scanFile(chunk[j], new TextDecoder("utf-8", { fatal: false }).decode(item.bytes));
      }
    }
    const offset = request.offset ?? 0;
    const limit = request.headLimit ?? 500;
    const sliced = entries.slice(offset, offset + limit);
    return {
      path,
      pattern: request.pattern,
      mode,
      durationMs: ms(t),
      files: hitFiles.slice(offset, offset + limit),
      entries: sliced,
      numMatches,
      truncated: offset + sliced.length < entries.length,
      appliedLimit: limit,
      appliedOffset: offset,
    };
  }

  return {
    stat,
    createDirectory,
    readTextFile,
    readBinaryFile,
    readTextFileRange,
    writeTextFile,
    writeBinaryFile,
    checkAccess,
    removeFile,
    // 删除链接只删链接本身；父目录仍须通过同一授权检查。
    removePath(request) {
      const path = checkAccess(request.path, { followFinalLink: false });
      vfsImpl.rmSync(path, { recursive: Boolean(request.recursive), force: Boolean(request.force) });
      return { path };
    },
    listDirectory,
    searchFiles,
    searchText,
    __normalizePath: normalizePath,
    // 0.5.0：授权扩展口（见 grantedRoots 注释）。agent.ts 审批通过后调它，
    // 下一次 guard 检查就会放行该根下的路径；"允许这一次"用完由 revokeRoot 收回。
    grantRoot,
    revokeRoot,
  };
}
