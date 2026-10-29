// 真机自检：把 §3.4 里"必须实测"的关卡 2/3/6/7/9/10 变成装机即出的数字。
// 之前这几列一直是空的（本机没设备），这份脚本让接上手机那一刻就能拿到数据。
const results = [];

async function check(name, fn) {
  const t0 = performance.now();
  // 移动端这条是同步阻塞主线程的（3000 文件基准、256 MB 分配），没有进度就看不出卡在哪。
  console.log("[selfcheck] " + name);
  try {
    results.push({ name, ok: true, ms: +(performance.now() - t0).toFixed(1), detail: await fn() });
  } catch (e) {
    results.push({ name, ok: false, ms: +(performance.now() - t0).toFixed(1), error: errorText(e) });
  }
}

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

// 一次性连接，只量引擎底细：版本号 + JSON1 在不在（0019 的表达式索引要用 json_extract）。
function sqliteCapabilities(rt) {
  const db = new rt.DatabaseSync("/zcode-mobile-selfcheck/.caps.sqlite");
  const out = { sqliteVersion: "?", json1: "?" };
  try {
    out.sqliteVersion = db.prepare("select sqlite_version() as v").get()?.v ?? "?";
    try {
      out.json1 = db.prepare(`select json_extract('{"a":1}','$.a') as v`).get()?.v === 1 ? "ok" : "unexpected";
    } catch (e) {
      out.json1 = "missing: " + String(e?.message ?? e).slice(0, 60);
    }
  } finally {
    db.close();
  }
  return out;
}

// 在"当前被选中的那个引擎"上把 22 条迁移跑一遍，只回事实不回异常。
/**
 * 命名参数绑定的形状探针。
 *
 * 为什么单独立一条（而不是"能跑就行"）：端侧那两层垫片原先都只认位置绑定，
 * 而上游 taskIndexRepo 的读取口（listTaskMetas / listDeletedTaskIds 等）用的是 node:sqlite 的
 * 命名参数字典 —— 整个对象被当成一个位置参数递给 SQLite，报
 * "tried to bind a value of an unknown type"。这条炸的正好是我要拿来回答"侧栏为什么没行"的读数口。
 * 三个判据各管一种静默错误：NULL 的"不过滤"语义、同名参数出现两次、以及字面量/注释里的 @name
 * 不能被误当成参数。缺参数名必须当场抛：静默补 NULL 会让一条查询看起来对、结果全错。
 */
function namedBindingProbe(rt, dbPath) {
  const engine = rt.sqliteEngine();
  const db = new rt.DatabaseSync(dbPath);
  try {
    // 这条在设备上会跑第二次（vfs 是真盘，库文件留着）。不先 drop 的话第二次启动
    // 读到的是上一次留下的两行，判据"恰好两行"就变成了看运气。
    db.exec("DROP TABLE IF EXISTS t");
    db.exec(
      "CREATE TABLE t (k TEXT, n TEXT, deleted INTEGER DEFAULT 0, updated_at INTEGER)",
    );
    db.prepare("INSERT INTO t (k, n, deleted, updated_at) VALUES (?, ?, ?, ?)").run("ws/a", "one", 0, 100);
    db.prepare("INSERT INTO t (k, n, deleted, updated_at) VALUES (?, ?, ?, ?)").run("ws/b", "two", 0, 200);
    // 与 listTaskMetas 同一形状：@k 出现两次，且值为 NULL 时那一支要整条让开（不过滤）。
    // 那句字符串字面量里特意塞了 -- @notaparam：改写器要是不跳字面量，这里就会报"参数不存在"。
    const passthrough = db
      .prepare(
        `SELECT n FROM t WHERE (@k IS NULL OR k = @k) AND deleted = 0 AND '-- @notaparam' <> '' ORDER BY updated_at DESC`,
      )
      .all({ k: null })
      .map((r) => r.n);
    const filtered = db
      .prepare(`SELECT n FROM t WHERE (@k IS NULL OR k = @k) AND deleted = 0`)
      .all({ k: "ws/a" })
      .map((r) => r.n);
    let missingName = "";
    try {
      db.prepare("SELECT n FROM t WHERE k = @nope").all({ k: "ws/a" });
    } catch (e) {
      missingName = String(e?.message ?? e).slice(0, 24);
    }
    let unusedName = "";
    try {
      db.prepare("SELECT n FROM t WHERE k = @k").all({ k: "ws/a", kk: "ws/b" });
    } catch (e) {
      unusedName = String(e?.message ?? e).slice(0, 24);
    }
    expect(passthrough.length === 2, `NULL 的"不过滤"语义没生效：${JSON.stringify(passthrough)}`);
    expect(
      JSON.stringify(filtered) === JSON.stringify(["one"]),
      `按名字过滤绑错了：${JSON.stringify(filtered)}`,
    );
    expect(missingName, "SQL 里有的参数名不在绑定对象里，却静默当 NULL 跑了");
    expect(unusedName, "绑定对象里多余的键没报出来（参数名拼错会静默查错）");
    return { engine, passthrough, filtered, missingName, unusedName };
  } finally {
    db.close();
  }
}

// R21 的对照需要同一个函数在两个引擎上各调一次，且两边都可能失败——失败本身就是数据。
async function migrationProbe(rt, dbPath) {
  const out = { engine: rt.sqliteEngine(), ...sqliteCapabilities(rt) };
  try {
    const store = await rt.SqliteSessionStore.openStartup({ dbPath });
    // 先关掉 store 再数表：同一个人开第二个连接去读一个还挂着写锁的文件，在原生引擎上
    // 是有可能直接吃 SQLITE_BUSY 的（这条用例的 timeout 预算没给那里）。
    store.close();
    const db = new rt.DatabaseSync(dbPath);
    let n = -1;
    try {
      n = Number(db.prepare("select count(*) as n from sqlite_master where type='table'").get()?.n ?? -1);
    } finally {
      db.close();
    }
    // 数表要开第二个连接，而桌面那个假桥只维持 store 自己那一条，二次 open 回来是空的。
    // 0 会被读成"schema 没建起来"，可真正的判据是 openStartup 走到了 ready —— 所以 0 报 null。
    out.tables = n > 0 ? n : null;
    out.ok = true;
  } catch (e) {
    out.ok = false;
    out.error = errorText(e);
  }
  return out;
}

// 失败原因要把 cause 链一起打出来。0019 迁移在设备上炸的那份报告只有一行
// "SQLite migration 0019_dwf_journal failed for …"，真正的 SQL 错误在 e.cause 里，
// 被这一行文案挡掉了——桌面重跑一百次也复现不出来。
export function errorText(e) {
  const parts = [];
  for (let cur = e; cur && parts.length < 4; cur = cur.cause) {
    const text = String(cur?.message ?? cur);
    if (!parts.includes(text)) parts.push(text);
  }
  return parts.join(" ← ");
}

export async function runDeviceChecks(rt) {
  // "重跑"会在同一个页面会话里再调一次，而 results 是模块级的：不清就把两轮都写进同一份报告。
  // 0.0.4 装机报告里每条步骤出现两遍、总数变成 60+，就是这个原因，不是手机真跑了两遍关卡。
  results.length = 0;
  const device = globalThis.zcodeDevice ?? null;

  await check("宿主与内核", async () => {
    const ua = navigator.userAgent;
    const chrome = ua.match(/Chrome\/(\d+)/)?.[1];
    const wv = ua.match(/wv/);
    expect(chrome, "UA 里没有 Chrome 版本，可能不是 WebView/Chromium");
    const info = device ? JSON.parse(device.deviceInfo()) : {};
    return {
      webview: Boolean(wv),
      chromium: Number(chrome),
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      device: info.model ?? "无原生探针（桌面浏览器）",
      // 报告自证版本：装机复测贴回来的 JSON 要能认出是哪一版跑的。
      app: info.appVersion ? `${info.appVersion}(${info.appVersionCode})` : "非 Android 宿主",
      sdkInt: info.sdkInt,
      abis: info.abis,
      javaMaxMemoryMB: info.javaMaxMemoryMB,
      pageSize: info.pageSize,
    };
  });

  await check("关卡10：SharedArrayBuffer 可构造", async () => {
    const sab = globalThis.SharedArrayBuffer;
    expect(typeof sab === "function", "没有 SharedArrayBuffer 构造器");
    const buffer = new sab(8);
    expect(buffer.byteLength === 8, "SAB 长度不对");
    // 主线程上 Atomics.wait 可能被禁；这里只验"能用"，不验"能等"。
    const view = new Int32Array(sab === globalThis.ArrayBuffer ? new ArrayBuffer(4) : buffer);
    return { byteLength: buffer.byteLength, viewLength: view.length, aliasedArrayBuffer: sab === globalThis.ArrayBuffer };
  });

  await check("关卡6：gb18030/gbk/big5 解码（FileSystemPort 编码契约）", async () => {
    // 一段真实的中文 GB18030 字节；解错就说明这个 WebView 裁了 ICU。
    const gb18030 = new Uint8Array([0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4]);
    const out = new TextDecoder("gb18030").decode(gb18030);
    expect(out === "中文测试", `gb18030 解错：${out}`);
    const gbk = new TextDecoder("gbk").decode(gb18030);
    const big5Bytes = new Uint8Array([0xA4, 0xA4, 0xA4, 0xE5]);
    const big5 = new TextDecoder("big5").decode(big5Bytes);
    return { gb18030: out, gbk, big5 };
  });

  await check("关卡7：OPFS / IndexedDB / 配额", async () => {
    const hasIdb = typeof indexedDB?.open === "function";
    let opfs = "unavailable";
    try {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle("zcode-probe.txt", { create: true });
      const writer = await handle.createWritable();
      await writer.write("probe");
      await writer.close();
      const file = await handle.getFile();
      opfs = (await file.text()) === "probe" ? "rw-ok" : "rw-mismatch";
      await root.deleteFileHandle?.("zcode-probe.txt");
      await handle.delete();
    } catch (e) {
      opfs = "blocked: " + String(e?.name ?? e?.message ?? e);
    }
    let quota = null;
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      quota = { usageMB: Math.round((est.usage ?? 0) / 1048576), quotaMB: Math.round((est.quota ?? 0) / 1048576) };
    }
    expect(hasIdb, "没有 IndexedDB，SessionStore 的兜底路径会失效");
    return { indexedDB: hasIdb, opfs, quota };
  });

  await check("关卡2：256 MB TypedArray 分配（低端机内存上限 R6）", async () => {
    const limit = 256 * 1024 * 1024;
    const heap = performance.memory?.jsHeapSizeLimit ?? null;
    const big = new Uint8Array(limit);
    big[0] = 1;
    big[limit - 1] = 1;
    const ok = big[0] === 1 && big[limit - 1] === 1;
    const mb = Math.round(limit / 1048576);
    globalThis.__zcodeMemProbe = big;
    expect(ok, `${mb} MB 分配后读写失败`);
    return { allocatedMB: mb, jsHeapLimitMB: heap ? Math.round(heap / 1048576) : "performance.memory 不可用" };
  });

  await check("关卡2：连续分配不 OOM（释放后回收）", async () => {
    delete globalThis.__zcodeMemProbe;
    const rounds = 8;
    for (let i = 0; i < rounds; i++) {
      const chunk = new Uint8Array(64 * 1024 * 1024);
      chunk[0] = i;
    }
    return { rounds, chunkMB: 64 };
  });

  await check("关卡3：Glob/Grep/Read 在 3000 文件量级的耗时", async () => {
    const { vfs } = rt;
    // 先清再建：真盘上留着上一轮的 3000 个文件，readdir 次数与过桥计数就不再是"这一棵新树"的数，
    // 而且每次自检都在应用私有目录里堆 12 MB 垃圾（0.0.4 装机报告暴露的问题，见 §1.5.12）。
    vfs.rmSync("/bench", { recursive: true, force: true });
    const files = [];
    for (let i = 0; i < 3000; i++) {
      const dir = "/bench/src/mod" + (i % 60);
      const p = `${dir}/file${i}.ts`;
      vfs.mkdir(dir, { recursive: true });
      const body = Array.from({ length: 80 }, (_, n) => `export const v${n} = ${i * 80 + n}; // 填充行`).join("\n");
      vfs.writeFile(p, body + "\nconsole.log('marker-" + i + "');\n");
      files.push(p);
    }
    const glob = rt.createMobileFileSystemPort(vfs, { workspaceRoot: "/bench", FileSystemPortError: rt.FileSystemPortError });
    const t0 = performance.now();
    const found = await glob.searchFiles({ path: "/bench", pattern: "**/*.ts", maxResults: 5000 });
    const globMs = performance.now() - t0;
    // R23 的判定要的数：这一轮 grep 过桥几次、搬了多少字节。
    // 次数掉到几十但 ms 没怎么动 ⇒ 设备的钱花在数据量上，不是往返上，批量这条路就到顶了；
    // ms 跟着次数一起掉 ⇒ 往返才是主成本，下推（toybox grep）才值得再谈。
    // 桌面假桥测不出这个（同进程函数调用没有跨语言成本），只有真机报回来的才算证据。
    const calls = {};
    let payloadChars = 0;
    const realBridge = globalThis.zcodeFs;
    const counting = realBridge && typeof realBridge.call === "function" && !globalThis.__zcodeFakeFs;
    if (counting) {
      globalThis.zcodeFs = {
        name: () => "zcodeFs",
        call(request) {
          const op = JSON.parse(request).op;
          calls[op] = (calls[op] ?? 0) + 1;
          const response = realBridge.call(request);
          payloadChars += response.length;
          return response;
        },
      };
    }
    const t1 = performance.now();
    const grep = await glob.searchText({ path: "/bench", pattern: "marker-2999", outputMode: "files_with_matches" });
    const grepMs = performance.now() - t1;
    if (counting) globalThis.zcodeFs = realBridge;
    const t2 = performance.now();
    await glob.readTextFile({ path: files[1500] });
    const readMs = performance.now() - t2;
    expect(found.numFiles === 3000, `Glob 只找到 ${found.numFiles}/3000`);
    // 批量读把"每文件一次 readFileSync"换成"一批一次 readMany"，所以这条用例必须同时断**结果**：
    // 批量要是漏了一项或把内容错配给别的路径，掉的是匹配数，而毫秒照样好看 —— 只看时间发现不了。
    expect(grep.files.length === 1 && String(grep.files[0]).endsWith("/file2999.ts"), `唯一命中被判成 ${JSON.stringify(grep.files.slice(0, 3))}`);
    const every = await glob.searchText({ path: "/bench", pattern: "console\\.log", outputMode: "files_with_matches" });
    // numMatches 是**行级**命中数，而命中列表按 headLimit（默认 500）截断，
    // 所以判"每个文件都扫到了"要看 numMatches：每个文件正好一行 console.log ⇒ 3000。
    expect(every.numMatches === 3000, `全量命中只报了 ${every.numMatches}/3000（files ${every.files.length}，truncated=${every.truncated}）`);
    // 计时全部结束、断言也过了，才删这棵树：真机每次自检写 3000 个文件 ≈ 12 MB，
    // 不清就等于每跑一次自检就往应用私有目录里堆一份垃圾，而下一次跑又会和这一份混在一起数。
    vfs.rmSync("/bench", { recursive: true, force: true });
    return {
      files: 3000,
      bytesPerFileKB: Math.round((81 * 46) / 1024 + 0.5) || 4,
      globMs: +globMs.toFixed(1),
      grepMs: +grepMs.toFixed(1),
      readMs: +readMs.toFixed(1),
      grepMatchedFile: String(grep.files[0] ?? "").split("/").slice(-2).join("/"),
      grepAllFilesMatched: every.numMatches,
      grepBridgeCalls: counting ? calls : null,
      // 桌面内存盘下这是 null 而不是 0：0 会被读成"批量生效了"，而实际是根本没有桥可数。
      grepBridgeCrossings: counting ? Object.values(calls).reduce((a, b) => a + b, 0) : null,
      grepBridgePayloadMB: counting ? +(payloadChars / 1048576).toFixed(2) : null,
      grepEngine: rt.fsEngine(),
      // 关卡 3 的门槛是单次 Grep ≤ 1.5s，直接在报告里判掉
      grepWithinGate: grepMs <= 1500,
    };
  });

  await check("关卡9 / L1：派生子进程能跑 /system/bin/sh", async () => {
    expect(device, "没有 zcodeDevice 探针（非 Android 宿主），这条无法在桌面判定");
    const echo = JSON.parse(device.execL1("echo zcode-ok", 5000));
    expect(echo.ok, `sh 起不来：${echo.error ?? echo.exitCode}`);
    expect(String(echo.output).includes("zcode-ok"), "sh 输出不对：" + echo.output);
    const toybox = JSON.parse(device.execL1("toybox ls -d . && uname -m", 5000));
    const python = JSON.parse(device.execL1("python3 -V || python -V || echo NO_PYTHON", 5000));
    return {
      shell: true,
      shellMs: echo.durationMs,
      toybox: toybox.ok,
      uname: String(toybox.output).trim(),
      python: String(python.output).trim(),
    };
  });

  await check("关卡9 / L2：随包 ELF 的 execve 前置条件", async () => {
    expect(device, "没有 zcodeDevice 探针（非 Android 宿主）");
    const probe = JSON.parse(device.execL2());
    expect(probe.candidates === 0 && probe.bundledToolchain === false, "本不该有随包工具链");
    return {
      ...probe,
      verdict: "L2 未启用：本机 NDK 是空占位，没有随包 ELF 可 exec。正对照要等 §8 M4b 立项",
    };
  });

  // M6 的判据不是"能存能读"这么宽松：桌面版是密文文件 + 可推导密钥，那条路在手机上等于把钥匙
  // 和锁放同一个抽屉。这里钉的是"桥的协议成立 + 密文不在 Agent 看得见的那棵树下"；
  // **AAD 绑住凭据名那条造不出条件**（桥没有 copy/rename op，JS 也进不了 noBackupFilesDir），
  // 只能靠 adb 改文件名复验，所以下面 wrongName 那条只是"按名字寻址、不会串行"，不是 AAD。
  await check("M6：Keystore 凭据桥（登录态能不能存住）", async () => {
    const bridge = globalThis.zcodeCredentials;
    const fs = globalThis.zcodeFs;
    if (!bridge || typeof bridge.call !== "function") {
      // 只有"文件桥在、凭据桥不在"才是真缺陷（外壳注册漏了）；两个桥都没有 = 桌面浏览器宿主，跳过。
      expect(!fs || typeof fs.call !== "function", "外壳注册了 zcodeFs 却没注册 zcodeCredentials，登录态无处可存");
      return { skipped: true, reason: "非 Android 宿主（没有凭据桥）；带 ?devCredentials=1 可跑内存桥" };
    }
    const send = (req) => JSON.parse(bridge.call(JSON.stringify(req)));
    const engine = typeof bridge.engine === "function" ? bridge.engine() : "?";
    const devOnly = engine !== "android-keystore-aes-gcm";
    // 有文件桥 = Android 外壳，这时引擎就必须是真 Keystore；内存桥冒上来要当场炸，
    // 不能让"登录态只活在内存里"这种包混过自检。
    if (fs && typeof fs.call === "function") {
      expect(!devOnly, "Android 宿主上的凭据引擎不是 Keystore，而是 " + engine);
    }
    const key = "selfcheck:probe:access_token";
    // 真 token 的形状：长串 + 冒号（oauth:zai:access_token 这类名字不能当文件名用，
    // CredentialBridge 里是散列过的，这里就是覆盖它）。
    const value = "probe-" + "x".repeat(300) + "-中文";
    const saved = send({ op: "save", key, value });
    expect(saved.ok === true, "凭据写入失败: " + (saved.error ?? JSON.stringify(saved)));
    const loaded = send({ op: "load", key });
    expect(loaded.ok === true, "凭据读取失败: " + (loaded.error ?? JSON.stringify(loaded)));
    expect(loaded.value === value, "凭据往返内容不一致（前 40: " + String(loaded.value).slice(0, 40) + "）");
    const wrongName = send({ op: "load", key: "selfcheck:probe:refresh_token" });
    expect(wrongName.ok === true && wrongName.value === null, "换一个 key 不该读到内容");
    const removed = send({ op: "remove", key });
    expect(removed.ok === true && removed.removed === true, "凭据删除没落上");
    const afterRemove = send({ op: "load", key });
    expect(afterRemove.ok === true && afterRemove.value === null, "删除后仍读得到");

    // 换名读在 Keystore 上必须是**解不开**（AAD 绑的是凭据名，这是"把 access_token 挪到别的 key
    // 上"这种攻击/写错的防线），内存桥没有这层语义，所以那条只在真桥上验。
    // 密文落在 noBackupFilesDir（工作区之外）：从文件桥探过去，既不能直接看到 credentials 目录，
    // 也不能靠 `..` 越出 vfs 根去看到。FsBridge.resolve 对这两条分别回 ENOENT / ok:false。
    let workspaceHasCredentials = "unknown";
    if (fs && typeof fs.call === "function") {
      const probe = (p) => {
        try {
          return JSON.parse(fs.call(JSON.stringify({ op: "exists", path: p })));
        } catch {
          return { ok: false };
        }
      };
      const inside = probe("/credentials");
      const escaped = probe("/../credentials");
      workspaceHasCredentials =
        (inside.ok === true && inside.exists === true) || (escaped.ok === true && escaped.exists === true)
          ? "YES"
          : "no";
    }
    expect(workspaceHasCredentials !== "YES", "凭据目录出现在 Agent 的工作区里，Bash/Read 能直接读到密文");
    return {
      engine,
      roundtrip: "ok",
      bytes: String(value).length,
      workspaceHasCredentials,
      ...(devOnly ? { note: "内存开发桥：只验协议形状，落盘/加密那两条没验到" } : {}),
    };
  });

  // 登录链路取证。端上没有 devtools，而"点了连接、浏览器里登录完回来一直转圈"这种问题只在真机出现，
  // 所以把 UI 写的 trace（ui/oauth-trace.ts，同一路径常量）打进报告里，用户复制一次就能定位到第几步。
  // 这份文件里**不会有 code/state/token**：写入端就把这些键丢掉了。
  await check("M6b：登录链路取证（oauth-login-trace.jsonl）", async () => {
    const fs = globalThis.zcodeFs;
    const path = "/work/.zcode/oauth-login-trace.jsonl";
    if (!fs || typeof fs.call !== "function") {
      return { skipped: true, reason: "非 Android 宿主（没有文件桥），取不到登录取证" };
    }
    const res = JSON.parse(fs.call(JSON.stringify({ op: "read", path })));
    if (res.ok !== true) {
      return { events: [], note: `还没有登录记录（${res.code ?? "unknown"}）：在界面上点一次"连接 Z.ai"再回到这里` };
    }
    const text = new TextDecoder().decode(Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0)));
    const events = text.split("\n").filter((l) => l.trim()).slice(-30).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { step: "<unparsable>" };
      }
    });
    const linkStats =
      globalThis.zcodeOAuthLink && typeof globalThis.zcodeOAuthLink.stats === "function"
        ? JSON.parse(globalThis.zcodeOAuthLink.stats())
        : null;
    return { events, deepLink: linkStats, bytes: String(res.base64).length };
  });

  await check("命名参数绑定（taskIndexRepo 那些读取口的 SQL 形状）", () =>
    namedBindingProbe(rt, "/zcode-mobile-selfcheck/.named-bindings.sqlite"),
  );

  // M7（0.3.7）：体验套餐链路真机验证。桌面单测只能证明 rewritePlatformForServer 的字符串
  // 替换对；这条打的是**服务端真实行为** —— 白名单到底收不收 android-*（2026-10-07 实测 3001），
  // 以及映射成 linux-arm64 之后能不能真的拿到 startPlanPreview。两个请求并排比，差值就是结论。
  await check("M7：体验套餐链路（client/configs 按平台键的真实响应）", async () => {
    if (!globalThis.zcodeDevice) {
      return { skipped: true, reason: "非 Android 宿主（没有 zcodeDevice），拿不到 appVersion，不打真服务端" };
    }
    let appVersion = "?";
    try {
      appVersion = JSON.parse(globalThis.zcodeDevice.deviceInfo()).appVersion ?? "?";
    } catch {
      /* 读数坏不影响请求：app_version 不是服务端判 platform 的必填项，带上只是让日志可归因 */
    }
    const base = "https://zcode.z.ai/api/v1/client/configs";
    const fetchOne = async (platform) => {
      const url = `${base}?app_version=${encodeURIComponent(appVersion)}&platform=${platform}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        const body = await res.json().catch(() => null);
        const code = body?.code;
        // 体验套餐的落点：data.configs.startPlanPreview —— code 对了但这里空，等于"平台键过了、下发还没配"。
        const preview = body?.data?.configs?.startPlanPreview;
        return { http: res.status, code, hasPreview: preview != null, msg: String(body?.msg ?? "").slice(0, 60) };
      } finally {
        clearTimeout(timer);
      }
    };
    // 对照：真值 android-arm64 预期 3001（白名单没有它），映射值 linux-arm64 预期 code 0。
    // 注意这里**故意不走** server-compat 的改写 —— 这条量的是服务端，改写链路的正确性另有
    // server-compat-smoke 的桌面单测管；两边各测各的，才分得开"服务端改了"和"端侧映射坏了"。
    const [raw, mapped] = await Promise.all([fetchOne("android-arm64"), fetchOne("linux-arm64")]);
    expect(mapped.code === 0, `映射键 linux-arm64 没有拿到 code0（实际 ${JSON.stringify(mapped)}）：服务端行为变了，见 §zcode-server-platform-whitelist`);
    expect(raw.code !== 0, `真值键 android-arm64 反而成功了（${JSON.stringify(raw)}）：服务端加了 android 白名单，端侧改写该退役`);
    return { androidKey: raw, linuxKey: mapped, note: mapped.hasPreview ? "startPlanPreview 有下发" : "平台键过了但体验套餐未下发（服务端配置问题，不是端侧）" };
  });

  await check("R16：SessionStore 用的存储引擎（异步启动迁移 openStartup）", async () => {
    const engine = rt.sqliteEngine();
    expect(engine !== "none", "两个 SQLite 引擎都不可用");
    if (engine !== "native-android-sqlite") {
      await rt.configureSqlite({ sqlJsFactory: globalThis.initSqlJs, locateFile: () => "./dist/sql-wasm.wasm", byteStore: newMemoryByteStore() });
    }
    // 迁移炸之前先把引擎底细量出来。0019_dwf_journal 建的是表达式索引
    // `json_extract(payload_json,'$.artifactId')`，而 Android 框架的 libsqlite3 不保证编译了
    // JSON1：WSA(API 33) 就是在 0019 上炸的，同一份 SQL 在 sql.js 和 Node 的 SQLite 3.53 上都过。
    // 没有这两项，报告里只剩一句 "migration 0019 failed"，谁也猜不到是缺函数。
    const caps = sqliteCapabilities(rt);
    // 端侧一律走 openStartup()：同步迁移路径的等锁是 Atomics.wait，而 WebView 主线程上它被
    // prelude 降级成了 no-op（SAB 需要 crossOriginIsolated，实测为 false）。既然引擎已经是
    // 真文件 SQLite、真的可能有第二个连接抢锁，等待就必须让给事件循环，不能靠 Atomics。
    const phases = [];
    let store;
    try {
      store = await rt.SqliteSessionStore.openStartup(
        { dbPath: "/zcode-mobile-selfcheck/db.sqlite" },
        { onProgress: async (p) => { phases.push(p.phase); return undefined; } },
      );
    } catch (e) {
      throw new Error(
        `${String(e?.message ?? e)} · sqlite=${caps.sqliteVersion} json1=${caps.json1}`,
        { cause: e },
      );
    }
    const created = await store.createSession({
      id: "ses_sc", projectID: "prj_sc", slug: "sc", directory: "/zcode-mobile-selfcheck",
      title: "自检", version: "0.0.1", taskType: "agent",
    });
    const listed = await store.listSessions();
    store.close();
    expect(created?.id === "ses_sc", "createSession 失败");
    expect(listed.length >= 1, "listSessions 空");
    // 关掉再重开：只有真的落到磁盘上，重启后的进程才还能读回这条会话。
    // 原生引擎这一条尤其关键——它是 R16 换掉 sql.js 的全部理由。
    const reopened = await rt.SqliteSessionStore.openStartup({ dbPath: "/zcode-mobile-selfcheck/db.sqlite" });
    const after = await reopened.listSessions();
    reopened.close();
    expect(after.length >= 1, "重开后会话没了：根本没落盘");
    expect(phases.includes("ready"), "迁移没走到 ready 阶段：" + phases.join(","));
    return {
      engine,
      ...caps,
      sessions: listed.length,
      sessionsAfterReopen: after.length,
      migrationPhases: [...new Set(phases)],
      startup: "async(openStartup)",
    };
  });

  // R21 判定实验：0019 到底是"宿主框架 SQLite 没编译 JSON1"，还是别的东西。
  // 只有在原生桥在场时这条才有意义——桌面上本来就只有一个引擎，对照不出任何信息。
  // 为什么值得单开一条：0.0.2 的报告里"WASM SQLite 迁移失败"是假的（派发器见有桥就用桥），
  // 所以 WASM 从没在这台宿主上跑过；光看 R16 那一条永远分不清是引擎问题还是桥的问题。
  await check("R21：同一套迁移在两个引擎上的对照（JSON1 判定实验）", async () => {
    const realBridge = globalThis.zcodeSqlite ?? null;
    // 桌面上没有真桥，就自己装一个假的原生桥把对照跑起来。这条在桌面上验的是**机关**：
    // prefer:"wasm" 真能把派发器从桥上拉开、跑完真能复位。两侧底下都是 sql.js，所以桌面
    // 全过并不说明 JSON1 没问题 —— 那句话只留给真机说。
    const dryRun = !realBridge;
    if (dryRun) {
      globalThis.__zcodeSqlJs ??= globalThis.initSqlJs ? await globalThis.initSqlJs({ locateFile: () => "./dist/sql-wasm.wasm" }) : null;
      if (!globalThis.__zcodeSqlJs) return { skipped: true, reason: "sql.js 未就绪，连假桥都装不上" };
      globalThis.zcodeSqlite = makeFakeNativeBridge(globalThis.__zcodeSqlJs, rt.splitSqlStatements);
    }
    let native, wasm = null;
    try {
      native = await migrationProbe(rt, "/zcode-mobile-selfcheck/r21-native.sqlite");
      try {
        // prefer:"wasm" 让派发器即使看见 zcodeSqlite 也走 sql.js；byteStore 换成内存的，
        // 这一次跑出来的库不落真盘——它只用来证明 SQL 能不能建起来，不参与 R18 的落盘判据。
        await rt.configureSqlite({
          prefer: "wasm",
          sqlJsFactory: globalThis.initSqlJs,
          locateFile: () => "./dist/sql-wasm.wasm",
          byteStore: newMemoryByteStore(),
        });
        expect(rt.sqliteEngine() === "sql.js-wasm", "诊断开关没生效，引擎仍是 " + rt.sqliteEngine());
        wasm = await migrationProbe(rt, "/zcode-mobile-selfcheck/r21-wasm.sqlite");
      } finally {
        // 必须复位：把 prefer:"wasm" 留给后面的用例，R18/L1 就会在内存库里测"真落盘"，
        // 而报告仍然写着 fs=native。
        await rt.configureSqlite({ prefer: null });
      }
    } finally {
      if (realBridge) globalThis.zcodeSqlite = realBridge;
      else delete globalThis.zcodeSqlite;
    }
    expect(rt.sqliteEngine() === (dryRun ? "sql.js-wasm" : "native-android-sqlite"),
      "跑完对照之后引擎没复位，后面的用例会全跑在内存库里");
    const verdict = dryRun
      ? `桌面预演：机关有效（走假桥=${native.ok ? "起得来" : "失败"}，强制 wasm=${wasm ? (wasm.ok ? "起得来" : "失败") : "没跑到"}）；两侧底下都是 sql.js，JSON1 的结论要真机给`
      : native.ok && wasm.ok ? "两个引擎都过：0.0.2 的 0019 失败在这台宿主上不复现，JSON1 嫌疑解除"
      : !native.ok && wasm.ok ? "**原生(框架 SQLite)炸、sql.js 过 → JSON1 缺失坐实**：这台宿主该退回 wasm 兜底，代价是 R16 的整库进内存"
      : native.ok && !wasm.ok ? "反过来：sql.js 炸而框架 SQLite 过 → 问题在 wasm 侧，原生桥仍是主路"
      : "两个引擎都炸 → 不是 JSON1，是迁移 SQL 本身或桥的语义";
    return { dryRun, native, wasm, verdict };
  });

  // L1 落地：真机已经证明 /system/bin/sh 起得来，这条验的是 ExecutionPort 能不能把它接到
  // core 的执行契约上——argv 不经过 shell、stdout/stderr 分流、timeout 生效。
  await check("L1：ExecutionPort 接原生执行桥（argv / shell / timeout）", async () => {
    expect(rt.isNativeExecAvailable(), "没有 zcodeExec 执行桥（非 Android 宿主）");
    const port = rt.createMobileExecutionPort({ bridge: rt.createNativeExecBridge() });

    const argv = await port.run({
      command: { mode: "argv", file: "/system/bin/toybox", args: ["echo", "argv-ok"] },
      timeoutMs: 8000,
    });
    expect(argv.status === "completed", `argv 形态失败：${JSON.stringify(argv).slice(0, 200)}`);
    expect(String(argv.stdout.text).includes("argv-ok"), "argv 输出不对：" + argv.stdout.text);

    // argv 里带空格/分号也不该被二次解释：这条同时是注入回归用例。
    const injection = await port.run({
      command: { mode: "argv", file: "/system/bin/toybox", args: ["echo", "a; echo pwned"] },
      timeoutMs: 8000,
    });
    expect(String(injection.stdout.text).includes("a; echo pwned"), "argv 参数被 shell 解释了：" + injection.stdout.text);
    expect(!String(injection.stdout.text).match(/^\s*pwned/m), "注入成功：参数里写出了第二条命令");

    const shell = await port.run({
      command: { mode: "shell", command: "echo shell-ok && uname -m && pwd" },
      timeoutMs: 8000,
    });
    expect(shell.status === "completed", "shell 形态失败：" + JSON.stringify(shell).slice(0, 200));
    expect(String(shell.stdout.text).includes("shell-ok"), "shell 输出不对：" + shell.stdout.text);

    const timeout = await port.run({
      command: { mode: "shell", command: "sleep 5" },
      timeoutMs: 700,
    });
    expect(timeout.timedOut === true, "timeout 没有生效：" + JSON.stringify(timeout).slice(0, 160));

    const missing = await port.run({
      command: { mode: "argv", file: "/system/bin/definitely-not-here", args: [] },
      timeoutMs: 4000,
    });
    expect(missing.status === "spawn_error", "不存在的程序应当报 spawn_error，拿到的是 " + missing.status);

    return {
      argv: String(argv.stdout.text).trim(),
      argvLiteral: String(injection.stdout.text).trim(),
      shell: String(shell.stdout.text).trim().replace(/\n/g, " | "),
      timeoutMs: timeout.durationMs,
      spawnError: missing.error?.message?.slice(0, 80),
      // 顺带把 L1 的能力面量出来：Bash 工具将来能给什么
      available: JSON.parse(globalThis.zcodeDevice.execL1("toybox | tr '\\n' ' '", 5000)).output,
    };
  });

  // §1.5.4 实测的 OPFS 结论（navigator.storage.getDirectory() 抛 TypeError）逼出来的这条：
  // 端侧文件必须真落盘，而"真落盘"的判据不是 JS 自己能读回来——那内存盘也做得到。
  // 判据是**另一个进程**能 cat 到它：zcodeExec 起的是 sh 子进程，看见同一个文件才算数。
  await check("R18：vfs 落到真盘（zcodeFs 桥 + Bash 子进程看得见同一棵树）", async () => {
    const ready = rt.vfs.ensureReady();
    expect(ready.rootReady !== false, "真盘根目录建不起来：" + (ready.error ?? ""));
    const engine = rt.fsEngine();
    expect(engine === "native", "这次跑的是内存盘，没有 zcodeFs 桥（桌面宿主正常，Android 上要查 addJavascriptInterface）");
    const { vfs } = rt;
    const semantics = probeFsSemantics(vfs, "/work/fs-bridge");

    // 跨桥一致性：子进程 cat 得到 = 文件真在盘上，且和 Bash 工具用的是同一棵树。
    let child = null;
    if (rt.isNativeExecAvailable()) {
      const port = rt.createMobileExecutionPort({ bridge: rt.createNativeExecBridge() });
      const res = await port.run({
        command: { mode: "shell", command: "pwd && ls -l fs-bridge && cat fs-bridge/probe.txt" },
        cwd: "/work",
        timeoutMs: 8000,
      });
      const text = String(res.stdout?.text ?? "") + String(res.stderr?.text ?? "");
      child = { status: res.status, out: text.trim().slice(0, 200) };
      expect(res.status === "completed", "子进程读不到文件工具写的东西：" + JSON.stringify(child));
      expect(text.includes("真盘探针"), "cat 内容不对：" + child.out);
    }

    // 每次调用是一次同步 JS→Java 往返，量出来才能判断 Glob/Grep 要不要下推到原生（§7 R18）。
    vfs.mkdir("/work/fs-perf", { recursive: true });
    const t2 = performance.now();
    for (let i = 0; i < 200; i++) vfs.writeFile(`/work/fs-perf/f${i}.txt`, "x".repeat(512), {});
    const bulkWriteMs = performance.now() - t2;
    const t3 = performance.now();
    const listed = vfs.readdirSync("/work/fs-perf", { withFileTypes: true });
    const readdirMs = performance.now() - t3;
    vfs.rmSync("/work/fs-perf", { recursive: true, force: true });
    expect(listed.length === 200, "批量写只落了 " + listed.length + " 个");
    vfs.rmSync("/work/fs-bridge", { recursive: true, force: true });
    expect(vfs.readdirSync("/work", { withFileTypes: true }).every((e) => e.name !== "fs-bridge"), "递归删除没删干净");

    return {
      engine,
      root: ready.root,
      semantics,
      childProcessSeesFile: child,
      bulk200x512B: { ms: +bulkWriteMs.toFixed(1), perFileMs: +(bulkWriteMs / 200).toFixed(2), readdirMs: +readdirMs.toFixed(1) },
    };
  });

  // 桌面没有 Android 宿主，也要能验桥协议本身：装一个按 FsBridge.kt 语义实现的假 zcodeFs
  // （一次调用一个 op、只能整读整写、错误按 code 回），vfs-native.mjs 的 norm、父目录检查、
  // base64、跟/不跟符号链接这些逻辑从这里过，接上真桥剩下的才只是 Kotlin 的 IO。
  await check("R18：真盘桥协议（假桥按 FsBridge.kt 语义，桌面跑）", async () => {
    if (globalThis.zcodeFs && !globalThis.__zcodeFakeFs) {
      return { skipped: true, reason: "设备已有真桥，假桥用例只在无 Android 宿主的桌面上有意义" };
    }
    const real = globalThis.zcodeFs ?? null;
    const fake = makeFakeFsBridge();
    globalThis.zcodeFs = fake;
    globalThis.__zcodeFakeFs = true;
    rt.setFsEngine("native");
    try {
      expect(rt.fsEngine() === "native", "桥装上了但引擎没切过来");
      const semantics = probeFsSemantics(rt.vfs, "/work/fake-fs");
      rt.vfs.rmSync("/work/fake-fs", { recursive: true, force: true });
      expect(!rt.vfs.existsSync("/work/fake-fs"), "假桥的递归删除没生效");
      return { engine: "native(假桥)", ops: fake.ops, semantics };
    } finally {
      rt.setFsEngine(null);
      if (real) globalThis.zcodeFs = real;
      else delete globalThis.zcodeFs;
      delete globalThis.__zcodeFakeFs;
    }
  });

  await check("M8：SAF 树桥协议（假桥按 TreeBridge.kt 语义，桌面跑）", async () => {
    const real = globalThis.zcodeTree ?? null;
    if (real) {
      // 真机上这条改量挂载点：用户没选过文件夹时列空表是正常状态，不是缺陷。
      const list = typeof globalThis.zcodeWorkspace?.listTrees === "function"
        ? JSON.parse(globalThis.zcodeWorkspace.listTrees())
        : [];
      if (list.length === 0) {
        return { skipped: true, reason: "还没有挂载外部工作区（在界面里点一次\"打开工作区\"选个文件夹，再回来看这条）" };
      }
      const dir = `${list[0].vfs}/.zcode-selfcheck`;
      const probe = probeFsSemantics(rt.vfs, dir);
      rt.vfs.rmSync(dir, { recursive: true, force: true });
      return { engine: "native(真桥)", mount: list[0].name, semantics: probe };
    }
    const fake = makeFakeTreeBridge();
    globalThis.zcodeTree = fake;
    try {
      // 派发层按前缀认后端：/mnt/ 走树桥，别的路径不受影响。两边各建一个文件互不串门，
      // 这条就是"混合批次"的形状验证（readMany 分组那段的直接判据）。
      const semantics = probeFsSemantics(rt.vfs, "/mnt/fake/work");
      rt.vfs.writeFile("/work/outside.txt", "不在树里", {});
      const batch = rt.vfs.readMany(["/mnt/fake/work/probe.txt", "/work/outside.txt"]);
      expect(batch.length === 2, `混合批次没等长：${batch.length}`);
      expect(batch[0].ok === true && batch[1].ok === true, `混合批次里有项失败：${JSON.stringify(batch.map((b) => b.code))}`);
      rt.vfs.rmSync("/mnt/fake/work", { recursive: true, force: true });
      rt.vfs.rmSync("/work/outside.txt", { force: true });
      return { engine: "fake-tree", ops: fake.ops, semantics, mixedBatch: true };
    } finally {
      delete globalThis.zcodeTree;
    }
  });

  // M9（0.3.7）：状态栏沉浸的原生读数。装机报告要能直接回答"insets 通道通没通"——
  // 顶栏读数必须 >0（状态栏高度），全零 = 原生监听没挂上或版本没到 30，就是沉浸没生效的证据。
  // 页面侧的 CSS 落位不在这条里判：__zcodeInsetsDebug 活在 UI 页的文档里，
  // 自检页是另一个文档（切页会销毁 UI 页），在这判它只会造出假 FAIL。页面落位看肉眼：
  // 顶栏不该压进状态栏底下、底部不该贴导航条。
  await check("M9：状态栏沉浸（原生 insets 读数）", async () => {
    const zui = globalThis.zcodeUi;
    if (!zui || typeof zui.safeInsets !== "function") {
      return { skipped: true, reason: "没有 zcodeUi 桥（桌面宿主），沉浸只在 Android 上判定" };
    }
    const raw = JSON.parse(String(zui.safeInsets()));
    const sdk = (() => {
      try {
        return Number(JSON.parse(globalThis.zcodeDevice.deviceInfo()).sdkInt ?? 0);
      } catch {
        return 0;
      }
    })();
    expect(
      Number(raw.top) > 0,
      `状态栏高度读数为 0（${JSON.stringify(raw)}）：原生没开沉浸（要求 API 30+ 且监听挂上）；这台设备 sdk=${sdk || "?"}`,
    );
    return { raw, dpr: globalThis.devicePixelRatio || 1, sdk, note: "页面留边是否生效请看真界面：顶栏不压状态栏、composer 不贴导航条" };
  });

  // M10（0.3.9）：侧栏的装机真值。三版"侧栏空"每次都靠猜根因，这条把三个证人一次带回：
  //   ① task-index 真库：直接开 /work/.zcode/v2/tasks-index.sqlite，分层数行——
  //      库里 0 行 ⇒ 写入链（syncer→repo）断；有行而读取口报 0 ⇒ 谓词/provider/workspaceKey 卡；
  //   ② 读取口最后读数（sidebar-diagnostics 落在 localStorage，自检页与 UI 页同源）：
  //      readLast.items vs 库行数、watched 的键与库里 workspace_key 对不对得上；
  //   ③ 投影帧计数：deltas.upserted/snapshotLast —— 有 upsert 而屏上没有 ⇒ 帧消费断在 UI 侧。
  // 桌面没有 zcodeSqlite 真库时如实 skipped（diag 回读仍然给出）。
  await check("M10：侧栏真值（task-index 库 × 读取口读数 × 投影计数）", () => {
    const diag = (() => {
      try {
        return JSON.parse(globalThis.localStorage?.getItem("zcode-mobile.sidebar.diag") ?? "null");
      } catch {
        return null;
      }
    })();
    const engine = rt.sqliteEngine();
    if (engine !== "native-android-sqlite") {
      return { skipped: true, engine, diag: diag ?? "(还没有 UI 页写过诊断，装机跑过对话后回来看)" };
    }
    // 与 services.ts 同一个落点：setDataBaseDir("/work") → tasks-index.sqlite 在 /work/.zcode/v2/。
    // 这里**只读**，用独立路径副本判断；开不了库（文件不存在 = 从没写过行）本身就是结论。
    const dbPath = "/work/.zcode/v2/tasks-index.sqlite";
    const out = { engine, diag };
    let db;
    try {
      db = new rt.DatabaseSync(dbPath);
    } catch (e) {
      out.db = { open: false, error: errorText(e).slice(0, 200), note: "打不开 task-index 库：对话从没写进过行（写入链断），或路径不对" };
      return out;
    }
    try {
      const q = (sql) => {
        try {
          return Number(db.prepare(sql).get()?.n ?? -1);
        } catch (e) {
          return `ERR:${String(e?.message ?? e).slice(0, 60)}`;
        }
      };
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
      out.db = {
        open: true,
        tables,
        hasTasks: tables.includes("tasks"),
      };
      if (tables.includes("tasks")) {
        out.db.rowsAll = q("SELECT COUNT(1) AS n FROM tasks");
        out.db.rowsAlive = q("SELECT COUNT(1) AS n FROM tasks WHERE deleted = 0");
        out.db.rowsProviderGlm = q("SELECT COUNT(1) AS n FROM tasks WHERE deleted = 0 AND provider = 'glm'");
        out.db.rowsVisible = q("SELECT COUNT(1) AS n FROM tasks WHERE deleted = 0 AND provider = 'glm' AND pinned = 0 AND archived = 0");
        out.db.keys = db
          .prepare("SELECT workspace_key AS k, provider AS p, COUNT(1) AS n FROM tasks GROUP BY workspace_key, provider ORDER BY n DESC LIMIT 10")
          .all();
      }
    } finally {
      db.close();
    }
    // 三份证词合读：这行是给贴报告的人的直接结论，不用再看上面三个数自己推。
    const live = typeof out.db.rowsVisible === "number" ? out.db.rowsVisible : null;
    const read = diag?.readLast?.items ?? null;
    // 0.4.8：readLast 记的是**最后一次**读取口调用——UI 收起态下最后问的常是 pinned
    // （置顶列表，空是正常态，不代表断链）。pinned 0/0 不当"谓词卡"报，只有 timeline
    // 的 0 才是"库里有行而列表读不出"的真断言。
    const readKind = diag?.readLast?.kind ?? null;
    out.verdict =
      live === 0
        ? "库里就没有可见行 ⇒ 写入链断（发完消息后看 deltas.upserted：0=同步器那一跳没发生；>0=repo 写失败）"
        : live > 0 && read === 0 && readKind === "timeline"
          ? "库里有行、timeline 读取口返回 0 ⇒ 谓词卡（比对 diag.readLast.scopes / watched 与 db.keys 的 workspace_key，多半是键不一致）"
          : live > 0 && read === 0
            ? "读取口最后问的是 pinned（空属正常，不是断链）——展开侧栏让 UI 问一次 timeline 再回来看"
            : live > 0 && read > 0
              ? "库和读取口都有行 ⇒ 断在投影/帧消费（看 snapshotLast.tasks 与 deltas.upserted 是否 >0；都正常就是 UI 侧订阅链）"
              : "还没有读取口读数 ⇒ UI 页从没问过列表（tabStore/订阅链没触发 listTaskList）";
    return out;
  });

  // M11（0.4.7）：顶栏与边缘触控的装机真值。装机反馈"按钮调大下移没效果"，桌面
  // （topbar-measure.mjs）实测规则命中、rect=72x72@y=40 —— 中间那层是黑的。0.4.9 开关生效后装机报"图标太大"，按钮统一收到 44px（新基准）。这条不再猜：
  // 直接回读 UI 页（web-mobile-shell.ts recordTopbarDiag）写进 localStorage 的最后一帧真值。
  // 读法：narrow=false ⇒ 窄屏旗子没挂（matchMedia 阈值或 shell 没 boot）；
  // toggleRect 不是 44x44 ⇒ CSS 生效面变了（上游换 DOM/选择器失配，包内 CSS 与
  // 源码逐字节核对仍一致，所以差异只能出现在运行时）；overlayTop 就是浮层离内容顶的距离。
  // insets 是原生通道读数（设备像素）：top>0 证明状态栏带垫过，bottom>0 证明手势条让过位。
  await check("M11：顶栏实测读数（UI 页证人链）", () => {
    let diag = null;
    try {
      diag = JSON.parse(globalThis.localStorage?.getItem("zcode-mobile.topbar.diag") ?? "null");
    } catch {
      return { fail: "证人链读数坏了（JSON 解析失败）", raw: globalThis.localStorage?.getItem("zcode-mobile.topbar.diag") };
    }
    let inputRecoveries = [];
    try { inputRecoveries = JSON.parse(globalThis.localStorage?.getItem("zcode-mobile.input-recovery") ?? "[]"); } catch {}
    if (!diag) {
      if (inputRecoveries.length) return { inputRecoveries, note: "记录到弹层退出后遗留的触摸锁，已自动恢复；这类冻结不会造成心跳间隔增加。" };
      return { skipped: true, reason: "UI 页从没写过顶栏证人（shell 没 boot 或 #sidebar 晚于预算挂载）——先发消息打开对话页再跑这条" };
    }
    expect(
      diag.narrow === true,
      `窄屏旗子没挂（narrow=false）：zcode-narrow class 不在，所有顶栏/抽屉规则都不会生效`,
    );
    expect(
      diag.toggleRect?.startsWith("44x44"),
      `切换按钮实测 ${diag.toggleRect}，不是 44x44：CSS 的 min-width/min-height 没命中或上游换了 DOM（0.4.9 统一 44px）`,
    );
    return diag;
  });

  // M12（0.4.10）：触摸聚焦垫片的装机真值（装机"点输入框要双击才出输入法"）。
  // composer-touch-focus 每次**真的补了一次 focus**（= 上游链在该设备第一次 tap 没走通）
  // 就把计数写进 localStorage（键 zcode-mobile.focus.diag，与自检页同源）。读法：
  // rescueCount > 0 ⇒ WebView 确实在吞第一次 tap、垫片正在顶上（症状与修法对上）；
  // = 0 且用户仍报卡 ⇒ 焦点链之外的层（渲染/事件路由），下一版按 last 现场与计数变化再追。
  await check("M12：触摸聚焦补偿计数（垫片真的在顶上吗）", () => {
    let diag = null;
    try {
      diag = JSON.parse(globalThis.localStorage?.getItem("zcode-mobile.focus.diag") ?? "null");
    } catch {
      return { fail: "读数坏了（JSON 解析失败）", raw: globalThis.localStorage?.getItem("zcode-mobile.focus.diag") };
    }
    if (!diag) {
      return { skipped: true, reason: "UI 页从没写过焦点垫片读数（boot 没跑或本机没点过输入框）——先点一次输入框再跑这条" };
    }
    return diag;
  });

  // M13（0.4.10）：主线程冻结证人（装机"有时候整个应用卡死"，与输入框无关的那一半）。
  // jank-witness 的心跳量相邻回调的实际 gap，≥800ms 记一笔（时间/阻塞毫秒/当时在跑什么 phase）。
  // 读法：total>0 ⇒ 这台设备发生过可感冻结；worst 列表里 gap 最大的那几次带 phase 标（tool:Grep 等）
  // 直接回答"堵在哪一段"。与 M12 同纪律：先交证人，修复按读数来，不盲调。
  // 证人增强轮：同一诊断键里多了 bridges（族×操作的计数/总耗时/最慢单次）与 slowCalls
  // （≥400ms 的单个桥调用采样，worst 12）——gap 说"堵了多久"，这两个说"堵在哪个桥的哪一下"。
  await check("M13：主线程冻结采样（卡死发生过的证据）", () => {
    let diag = null;
    try {
      diag = JSON.parse(globalThis.localStorage?.getItem("zcode-mobile.jank.diag") ?? "null");
    } catch {
      return { fail: "读数坏了（JSON 解析失败）", raw: globalThis.localStorage?.getItem("zcode-mobile.jank.diag") };
    }
    if (!diag) {
      return { skipped: true, reason: "UI 页从没写过冻结采样（boot 没跑，或本机至今没发生过 ≥800ms 的阻塞——好事）" };
    }
    return {
      total: diag.total,
      maxGapMs: diag.maxGapMs,
      lastPhase: diag.lastPhase,
      worst: (diag.worst ?? []).slice(0, 5),
      // 桥族计数：bridges[族][op] = {calls, totalMs, maxMs, maxAt}——"Grep 时 fs.readdir 44 次
      // 共 2100ms、单次最慢 480ms"这类归因直接可读。旧读数没有这两个字段，缺省 null（好事）。
      bridges: diag.bridges ?? null,
      slowCalls: (diag.slowCalls ?? []).slice(0, 8),
      inputRecoveries,
      note:
        diag.total === 0
          ? (diag.slowCalls ?? []).length
            ? "心跳没抓到 ≥800ms 的整段阻塞，但有 ≥400ms 的单个桥调用（看 slowCalls）——症状若出现在工具执行时，多半是多次慢调用连排"
            : "没有 ≥800ms 的主线程阻塞记录，也没有 ≥400ms 的单次桥调用（若用户仍报卡死，症状多半在渲染/焦点层，看 M12）"
          : `记录过 ${diag.total} 次 ≥800ms 阻塞，最长 ${diag.maxGapMs}ms；worst 的 phase 指向归因，slowCalls/bridges 指到具体桥操作`,
    };
  });

  // 没有真机也能验原生桥：装一个按 Kotlin 语义实现的假 zcodeSqlite，底下是同一个 SQLite
  // （sql.js 就是真 sqlite3 编译的），所以列亲和性、多语句、BLOB 这些窄化的行为和装到手机上
  // 一致。桌面那套 store 从这里过，就代表桥的协议对，剩下的只是 Kotlin 的 IO。
  await check("R16：原生桥协议 + 逐语句迁移（假桥 = 真 SQLite）", async () => {
    // 真机上这条没有意义：zcodeSqlite 已经在那儿了，再套一层假桥只会测到自己写的假东西。
    // 协议验证留在桌面上跑，设备上跑的是上面那条真桥的 close→重开→数据还在。
    if (rt.sqliteEngine() === "native-android-sqlite") {
      return { skipped: true, reason: "设备已有原生桥，假桥用例只在无 Android 宿主的桌面上有意义", engine: "native-android-sqlite" };
    }
    globalThis.__zcodeSqlJs ??= globalThis.initSqlJs ? await globalThis.initSqlJs({ locateFile: () => "./dist/sql-wasm.wasm" }) : null;
    const SQL = globalThis.__zcodeSqlJs;
    expect(SQL, "sql.js 未就绪，无法模拟原生桥");
    // 真机上 zcodeSqlite 是原生桥本体，假桥跑完必须原样装回去——直接 delete 会把 App
    // 这一整个进程的存储通道抹掉，后面的步骤和 App 自己都会瞎。
    const realBridge = globalThis.zcodeSqlite ?? null;
    globalThis.zcodeSqlite = makeFakeNativeBridge(SQL, rt.splitSqlStatements);
    // 桥第一次拿到 `begin immediate` 时回一条 Android 形状的锁错（"[5] database is locked"），
    // 逼迁移等一次锁。这条同时验两件事：① 桥错误里的结果码要能还原成 error.errcode，
    // 否则 isSqliteBusyError() 认不出来，瞬时锁冲突会变成启动失败；② 端侧只能走异步等待，
    // 因为同步路径的 Atomics.wait 在 WebView 主线程上是 no-op。
    globalThis.zcodeSqlite.lockNextBegin = true;
    try {
      expect(rt.sqliteEngine() === "native-android-sqlite", "桥装上了但引擎没切过来");
      const phases = [];
      const store = await rt.SqliteSessionStore.openStartup(
        { dbPath: "/fake-bridge/db.sqlite" },
        { onProgress: async (p) => { phases.push(p.phase); return undefined; } },
      );
      const created = await store.createSession({
        id: "ses_bridge", projectID: "prj_bridge", slug: "bridge", directory: "/fake-bridge",
        title: "桥", version: "0.0.1", taskType: "agent",
      });
      await store.saveMessage({ id: "msg_bridge", sessionID: "ses_bridge", role: "user", agent: "zcode", time: { created: Date.now() } });
      await store.savePart({ id: "prt_bridge", sessionID: "ses_bridge", messageID: "msg_bridge", type: "text", text: "hello from bridge" });
      const loaded = await store.messages({ sessionID: "ses_bridge" });
      const schema = JSON.parse(globalThis.zcodeSqlite.query(globalThis.__fakeHandle, "select count(*) as n from sqlite_master where type='table'", "[]", "get"));
      store.close();
      expect(created?.id === "ses_bridge", "createSession 走桥失败");
      expect(loaded.length === 1, `messages 走桥数量不对：${loaded.length}`);
      expect(loaded[0].parts?.[0]?.text === "hello from bridge", "part 文本经桥丢失");
      expect(phases.includes("waiting_for_lock"), "锁错没有被当成可重试，迁移直接失败了：" + phases.join(","));
      expect(phases.includes("ready"), "迁移没走到 ready：" + phases.join(","));
      return {
        engine: "native-android-sqlite",
        tables: schema?.[0]?.n ?? schema?.n,
        // 桥这一侧单独再跑一遍命名参数探针：改写发生在 JS 侧，所以这条验的是
        // "Kotlin 收到的确实只剩 ?"，与上面 sql.js 那条合起来才是两个后端都对。
        namedParamsOnBridge: namedBindingProbe(rt, "/fake-bridge/named.sqlite"),
        bridgeCalls: globalThis.__fakeBridgeCalls,
        pragmaViaQuery: globalThis.__fakeBridgePragmas,
        busyTimeoutPragma: globalThis.__fakeBridgeBusyTimeout,
        blobReadRejects: globalThis.__fakeBridgeBlobRejects,
        migrationPhases: [...new Set(phases)],
      };
    } finally {
      if (realBridge) globalThis.zcodeSqlite = realBridge;
      else delete globalThis.zcodeSqlite;
    }
  });

  return results;
}

// 桥语义的共同判据：真盘（zcodeFs）和假桥都必须过同一批断言，
// 否则"桌面验过协议"就成了自证——两边测的东西不一样就等于没测。
export function probeFsSemantics(vfs, dir) {
  const file = `${dir}/probe.txt`;
  const body = "真盘探针 " + Date.now() + "\n第二行\n";
  const fail = (message) => {
    throw new Error(message);
  };
  vfs.rmSync(dir, { recursive: true, force: true });
  // 两个后端都不替调用方建父目录（这是 Port 层 createParents 的职责），所以探针自己建。
  vfs.mkdir(dir, { recursive: true });
  const t0 = performance.now();
  vfs.writeFile(file, body, {});
  const writeMs = performance.now() - t0;
  const back = vfs.readFileSync(file, "utf8");
  if (back !== body) fail("读回内容不一致：" + JSON.stringify(back.slice(0, 40)));
  const st = vfs.statSync(file);
  const sizeBytes = new TextEncoder().encode(body).length;
  if (!st.isFile() || st.size !== sizeBytes) fail(`stat 不对：size=${st.size} 期望 ${sizeBytes} isFile=${st.isFile()}`);
  if (!vfs.statSync(dir).isDirectory()) fail("目录 stat 不对");
  if (!vfs.readdirSync(dir, { withFileTypes: true }).some((e) => e.name === "probe.txt" && e.isFile())) fail("readdir 看不到新建文件");

  vfs.writeFile(file, "追加行\n", { flag: "a" });
  if (!vfs.readFileSync(file, "utf8").includes("追加行")) fail("append 没生效");
  const moved = `${dir}/probe2.txt`;
  vfs.renameSync(file, moved);
  if (vfs.existsSync(file) || !vfs.existsSync(moved)) fail("rename 没生效");
  vfs.renameSync(moved, file);

  const bin = new Uint8Array([0, 1, 253, 254, 255]);
  vfs.writeFile(`${dir}/bin.dat`, bin, {});
  const binBack = vfs.readFileSync(`${dir}/bin.dat`);
  if (!(binBack instanceof Uint8Array) || binBack.length !== 5 || binBack[0] !== 0 || binBack[4] !== 255) fail("二进制 roundtrip 不对");

  // 批量读（R23）：一次调用拿回一批，成功失败在**每一项**里。这一批必须同时在真盘和内存盘过，
  // 因为 Grep 的正确性靠它：坏项要让调用方跳过该文件，而不是把整批打抛、也不是错位到别的路径上。
  if (vfs.readMany([]).length !== 0) fail("readMany 空请求不该返回项");
  const batchPaths = [file, `${dir}/missing.txt`, dir, `${dir}/bin.dat`];
  const batch = vfs.readMany(batchPaths);
  if (batch.length !== batchPaths.length) fail(`readMany 返回 ${batch.length} 项，请求 ${batchPaths.length} 项`);
  for (let i = 0; i < batch.length; i++) {
    if (batch[i].path !== vfs.toPath(batchPaths[i])) fail(`readMany 第 ${i} 项路径错位：${batch[i].path} 期望 ${vfs.toPath(batchPaths[i])}`);
  }
  const [batchProbe, batchMissing, batchDir, batchBin] = batch;
  if (!batchProbe.ok || new TextDecoder("utf-8").decode(batchProbe.bytes) !== vfs.readFileSync(file, "utf8")) {
    fail("readMany 第一项内容不对：" + JSON.stringify({ ok: batchProbe.ok, code: batchProbe.code }));
  }
  if (batchMissing.ok || batchMissing.code !== "ENOENT") fail("readMany 不存在的路径应当逐项 ENOENT，拿到 " + JSON.stringify({ ok: batchMissing.ok, code: batchMissing.code }));
  if (batchDir.ok || batchDir.code !== "EISDIR") fail("readMany 目录应当逐项 EISDIR，拿到 " + JSON.stringify({ ok: batchDir.ok, code: batchDir.code }));
  if (!batchBin.ok || batchBin.bytes.length !== 5 || batchBin.bytes[4] !== 255) fail("readMany 的二进制项不对");

  // 父目录不存在要 ENOENT，不能静默建出来（桌面的 ensureParents 语义，端侧必须一致）。
  let missingParent = "没抛错";
  try {
    vfs.writeFile(`${dir}/nope/deep.txt`, "x", {});
  } catch (e) {
    missingParent = e.code;
  }
  if (missingParent !== "ENOENT") fail("父目录缺失应当 ENOENT，拿到 " + missingParent);

  let readDir = "没抛错";
  try {
    vfs.readFileSync(dir);
  } catch (e) {
    readDir = e.code;
  }
  if (readDir !== "EISDIR") fail("读目录应当 EISDIR，拿到 " + readDir);

  // 非空目录要挡住 rmdir；递归删要能真的删干净。
  let notEmpty = "没抛错";
  try {
    vfs.rmdir(dir);
  } catch (e) {
    notEmpty = e.code;
  }
  if (notEmpty !== "ENOTEMPTY") fail("非空目录 rmdir 应当 ENOTEMPTY，拿到 " + notEmpty);

  // `..` 不逃出根：归一化后仍在 vfs 命名空间里，结果是 ENOENT 而不是读到宿主系统文件。
  let escape = "没抛错";
  try {
    vfs.readFileSync("/../../etc/hosts");
  } catch (e) {
    escape = e.code;
  }
  if (escape !== "ENOENT") fail(`越界读取没有被拒（拿到 ${escape}）`);

  // 符号链接：内存盘一直支持，真盘要看这个文件系统让不让建（应用私有目录通常让）。
  let symlink = "ok";
  try {
    vfs.symlinkSync("probe.txt", `${dir}/link.txt`);
    if (vfs.lstatSync(`${dir}/link.txt`).isSymbolicLink() !== true) symlink = "lstat 没认出 link";
    else if (vfs.readFileSync(`${dir}/link.txt`, "utf8").includes("真盘探针") !== true) symlink = "跟链读内容不对";
    else if (vfs.readlinkSync(`${dir}/link.txt`) !== "probe.txt") symlink = "readlink 拿到 " + vfs.readlinkSync(`${dir}/link.txt`);
  } catch (e) {
    symlink = "不支持：" + (e.code ?? e.message);
  }

  const t1 = performance.now();
  const readBack = vfs.readFileSync(file, "utf8");
  const readMs = performance.now() - t1;
  if (!readBack.includes("追加行")) fail("重读内容不对");
  return {
    writeMs: +writeMs.toFixed(2),
    readMs: +readMs.toFixed(2),
    sizeBytes,
    errors: { missingParent, readDir, notEmpty, escape },
    symlink,
  };
}

// 与 FsBridge.kt 一一对应：同一个 op 名、同一套 JSON/base64 约定、同一批错误码。
// 故意做得"和桥一样笨"——一次调用一个 op、只能整读整写、不知道调用方是谁，
// 这样 vfs-native.mjs 在这里过不了就是它自己的问题，而不是假桥太宽容。
export function makeFakeFsBridge() {
  const nodes = new Map();
  const ops = {};
  const root = "/";
  const touch = (p, kind) => {
    nodes.set(p, { kind, bytes: kind === "file" ? new Uint8Array(0) : null, mtimeMs: Date.now(), link: null });
  };
  touch("/", "dir");

  const resolve = (p) => {
    const segs = String(p).split("/").filter((s) => s && s !== ".");
    if (segs.some((s) => s === "..")) return { error: ["EINVAL", "路径越出 vfs 根"] };
    return { path: "/" + segs.join("/") };
  };
  const parentOf = (p) => (p.lastIndexOf("/") <= 0 ? "/" : p.slice(0, p.lastIndexOf("/")));
  const ensureDir = (p) => {
    const segs = p.split("/").filter(Boolean);
    let cur = "";
    for (const seg of segs) {
      cur += "/" + seg;
      const n = nodes.get(cur);
      if (!n) touch(cur, "dir");
      else if (n.kind !== "dir") return { error: ["ENOTDIR", cur] };
    }
    return { ok: true };
  };
  const bytes = (req) => {
    const bin = atob(String(req.base64 ?? ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  const text = (b) => {
    let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  };
  // open() 跟符号链接是 POSIX 的行为，桥那边用 File.readBytes() 也是跟的，
  // 所以假桥必须跟着走；stat/readdir 用 NOFOLLOW，两边形状才对得上。
  const deref = (p, hops = 0) => {
    let n = nodes.get(p);
    while (n?.kind === "link" && hops++ < 10) {
      const target = n.link.startsWith("/") ? n.link : parentOf(p) === "/" ? "/" + n.link : parentOf(p) + "/" + n.link;
      p = "/" + String(target).split("/").filter((s) => s && s !== ".").join("/");
      n = nodes.get(p);
    }
    return { path: p, node: n };
  };

  // 单个读取的形状，"read" 和 "readMany" 共用 —— 和 FsBridge.kt 里 readItem 同理，
  // 两处各写一遍就会在"目录算 EISDIR 还是 ENOENT"上漂开。
  const readOne = (p) => {
    const d = deref(p);
    if (!d.node) return { ok: false, path: p, code: "ENOENT", message: "no such file" };
    if (d.node.kind === "dir") return { ok: false, path: p, code: "EISDIR", message: "is a directory" };
    return { ok: true, path: p, base64: text(d.node.bytes), size: d.node.bytes.length, mtimeMs: d.node.mtimeMs };
  };

  return {
    name: () => "zcodeFs",
    ops,
    call(request) {
      const req = JSON.parse(request);
      ops[req.op] = (ops[req.op] ?? 0) + 1;
      const r = resolve(req.path ?? "");
      if (r.error) return JSON.stringify({ ok: false, code: r.error[0], path: req.path, message: r.error[1] });
      const path = r.path;
      const node = nodes.get(path);
      switch (req.op) {
        case "touchRoot":
          return JSON.stringify({ ok: true, root: "(假桥没有真实根)" });
        case "stat":
          return JSON.stringify(node
            ? { ok: true, exists: true, kind: node.kind, size: node.kind === "file" ? node.bytes.length : 0, mtimeMs: node.mtimeMs, mode: node.kind === "dir" ? 493 : 420 }
            : { ok: true, exists: false });
        case "exists":
          return JSON.stringify({ ok: true, exists: !!node });
        case "read":
          return JSON.stringify(readOne(path));
        case "readMany": {
          // 外层永远 ok:true，每个文件的成功/失败在自己的 item 里 —— 一条不存在的路径不能把整批打回逐文件读。
          const list = Array.isArray(req.paths) ? req.paths : [];
          const items = list.map((p) => {
            const one = resolve(String(p ?? ""));
            if (one.error) return { ok: false, path: p, code: one.error[0], message: one.error[1] };
            return readOne(one.path);
          });
          return JSON.stringify({ ok: true, items });
        }
        case "write": {
          const parent = nodes.get(parentOf(path));
          if (req.createParents !== false && !parent) ensureDir(parentOf(path));
          else if (!parent) return JSON.stringify({ ok: false, code: req.append ? "ENOENT" : "ENOENT", path, message: "父目录不存在" });
          const body = bytes(req);
          const prev = nodes.get(path);
          if (prev?.kind === "dir") return JSON.stringify({ ok: false, code: "EISDIR", path, message: "is a directory" });
          nodes.set(path, {
            kind: "file",
            bytes: req.append && prev ? (() => {
              const out = new Uint8Array(prev.bytes.length + body.length);
              out.set(prev.bytes, 0);
              out.set(body, prev.bytes.length);
              return out;
            })() : body,
            mtimeMs: Date.now(),
            link: null,
          });
          return JSON.stringify({ ok: true, bytesWritten: body.length, mtimeMs: Date.now() });
        }
        case "mkdir": {
          if (node) return node.kind === "dir" ? JSON.stringify({ ok: true }) : JSON.stringify({ ok: false, code: "EEXIST", path, message: "已存在但不是目录" });
          if (!req.recursive) {
            const parent = nodes.get(parentOf(path));
            if (!parent) return JSON.stringify({ ok: false, code: "ENOENT", path, message: "父目录不存在" });
            if (parent.kind !== "dir") return JSON.stringify({ ok: false, code: "ENOTDIR", path, message: "父不是目录" });
            nodes.set(path, { kind: "dir", bytes: null, mtimeMs: Date.now(), link: null });
            return JSON.stringify({ ok: true });
          }
          const made = ensureDir(path);
          return made.error ? JSON.stringify({ ok: false, code: made.error[0], path, message: made.error[1] }) : JSON.stringify({ ok: true });
        }
        case "readdir": {
          if (!node) return JSON.stringify({ ok: false, code: "ENOENT", path, message: "no such directory" });
          if (node.kind !== "dir") return JSON.stringify({ ok: false, code: "ENOTDIR", path, message: "不是目录" });
          const prefix = path === "/" ? "/" : path + "/";
          const seen = new Map();
          for (const [key, value] of nodes) {
            if (!key.startsWith(prefix) || key === path) continue;
            const rest = key.slice(prefix.length);
            if (!rest) continue;
            const name = rest.split("/")[0];
            if (!seen.has(name)) seen.set(name, rest.includes("/") ? "dir" : value.kind);
          }
          return JSON.stringify({ ok: true, entries: [...seen].map(([name, kind]) => ({ name, kind })) });
        }
        case "unlink":
          if (!node) return JSON.stringify({ ok: false, code: "ENOENT", path, message: "no such file" });
          if (node.kind === "dir") return JSON.stringify({ ok: false, code: "EISDIR", path, message: "是目录" });
          nodes.delete(path);
          return JSON.stringify({ ok: true });
        case "rmdir": {
          if (!node) return JSON.stringify({ ok: false, code: "ENOENT", path, message: "no such directory" });
          if (node.kind !== "dir") return JSON.stringify({ ok: false, code: "ENOTDIR", path, message: "不是目录" });
          const kids = JSON.parse(this.call(JSON.stringify({ op: "readdir", path })));
          if (kids.entries.length) return JSON.stringify({ ok: false, code: "ENOTEMPTY", path, message: "目录非空" });
          nodes.delete(path);
          return JSON.stringify({ ok: true });
        }
        case "rm": {
          if (!node) return req.force ? JSON.stringify({ ok: true }) : JSON.stringify({ ok: false, code: "ENOENT", path, message: "no such file" });
          const prefix = path === "/" ? "/" : path + "/";
          const kids = [...nodes.keys()].filter((k) => k.startsWith(prefix));
          if (kids.length && !req.recursive && node.kind === "dir") return JSON.stringify({ ok: false, code: "ENOTEMPTY", path, message: "目录非空" });
          nodes.delete(path);
          for (const k of kids) nodes.delete(k);
          return JSON.stringify({ ok: true });
        }
        case "rename": {
          const to = resolve(req.to);
          if (to.error) return JSON.stringify({ ok: false, code: to.error[0], path: req.to, message: to.error[1] });
          if (!node) return JSON.stringify({ ok: false, code: "ENOENT", path, message: "no such file" });
          const fromPrefix = path === "/" ? "/" : path + "/";
          const toPrefix = to.path === "/" ? "/" : to.path + "/";
          for (const [key, value] of [...nodes]) {
            if (!key.startsWith(fromPrefix)) continue;
            nodes.delete(key);
            value.path = toPrefix + key.slice(fromPrefix.length);
            nodes.set(value.path, value);
          }
          node.path = to.path;
          nodes.set(to.path, node);
          nodes.delete(path);
          return JSON.stringify({ ok: true, path: to.path });
        }
        case "symlink": {
          if (node) return JSON.stringify({ ok: false, code: "EEXIST", path, message: "已存在" });
          ensureDir(parentOf(path));
          nodes.set(path, { kind: "link", bytes: null, mtimeMs: Date.now(), link: String(req.target) });
          return JSON.stringify({ ok: true, path });
        }
        case "readlink":
          if (node?.kind !== "link") return JSON.stringify({ ok: false, code: "EINVAL", path, message: "不是符号链接" });
          return JSON.stringify({ ok: true, link: node.link });
        case "realpath":
          if (!node) return JSON.stringify({ ok: false, code: "ENOENT", path, message: "no such file" });
          return JSON.stringify({ ok: true, path });
        default:
          return JSON.stringify({ ok: false, code: "EINVAL", path, message: "未知操作 " + req.op });
      }
    },
  };
}

// 与 TreeBridge.kt 一一对应：op 名、JSON/base64 约定、错误码、以及那几条窄化
// （无符号链接 → symlink/readlink EPERM；rename 只许同级文件；/mnt 之外的形状 ENOENT）。
// 假桥"和桥一样笨"是刻意的：vfs-tree.mjs 在这里过不了就是它自己的问题，不是假桥太宽容。
export function makeFakeTreeBridge() {
  const nodes = new Map();
  const ops = {};
  // 一个挂载点：fake。真实 TreeBridge 的挂载点在 SharedPreferences，语义就是"根已存在、不可创建"。
  nodes.set("/mnt/fake", { kind: "dir", bytes: null, mtimeMs: Date.now() });

  const split = (p) => {
    const cleaned = String(p).replace(/\\/g, "/");
    if (!cleaned.startsWith("/mnt/")) return { error: ["ENOENT", "不是树路径"] };
    const segs = cleaned.split("/").filter((s) => s && s !== ".");
    if (segs[0] !== "mnt" || segs.length < 2 || segs.some((s) => s === "..")) return { error: ["ENOENT", "不是合法树路径"] };
    if (!nodes.has("/mnt/" + segs[1])) return { error: ["ENOENT", "挂载点不存在"] };
    return { segs, path: "/" + segs.join("/") };
  };
  const count = (op) => {
    ops[op] = (ops[op] ?? 0) + 1;
  };
  const statJSON = (p) => {
    const n = nodes.get(p);
    return {
      path: p,
      exists: !!n,
      kind: n ? n.kind : "other",
      size: n?.bytes ? n.bytes.length : 0,
      mtimeMs: n?.mtimeMs ?? 0,
      mode: n?.kind === "dir" ? 0o755 : 0o644,
    };
  };
  const kidsOf = (p) => {
    const prefix = p === "/" ? "/" : p + "/";
    return [...nodes.keys()].filter((k) => k.startsWith(prefix) && k !== p);
  };

  return {
    ops,
    call(request) {
      const req = JSON.parse(request);
      count(req.op);
      // touchRoot/readMany 的请求体没有单 path：TreeBridge.kt 的 `path` 是 optString（缺了就是空串），
      // 派发分支也不 resolve 它。假桥必须一样：这两个 op 在通用 split 之前结掉，否则 readMany
      // 整批会被"不是树路径"挡死 —— 0.3.7 桌面回归里 M8 就是这么炸的。
      if (req.op === "touchRoot") return JSON.stringify({ ok: true, root: "zcodeTree" });
      if (req.op === "readMany") {
        const items = (req.paths ?? []).map((p) => {
          const item = { path: p };
          const rr = split(p);
          const n = rr.error ? null : nodes.get(rr.path);
          if (!n) return Object.assign(item, { ok: false, code: "ENOENT" });
          if (n.kind === "dir") return Object.assign(item, { ok: false, code: "EISDIR" });
          return Object.assign(item, { ok: true, base64: bytesToBase64(n.bytes) });
        });
        return JSON.stringify({ ok: true, items });
      }
      const r = split(req.path);
      if (r.error) return JSON.stringify({ ok: false, code: r.error[0], path: req.path, message: r.error[1] });
      const path = r.path;
      const node = nodes.get(path);
      switch (req.op) {
        case "touchRoot":
          return JSON.stringify({ ok: true, root: "zcodeTree" });
        case "stat":
          return JSON.stringify({ ok: true, ...statJSON(path) });
        case "exists":
          return JSON.stringify({ ok: true, exists: !!node });
        case "read": {
          if (!node) return JSON.stringify({ ok: false, code: "ENOENT", path, message: "no such file" });
          if (node.kind === "dir") return JSON.stringify({ ok: false, code: "EISDIR", path, message: "is a directory" });
          return JSON.stringify({ ok: true, base64: bytesToBase64(node.bytes), size: node.bytes.length });
        }
        case "readMany": {
          const items = req.paths.map((p) => {
            const item = { path: p };
            const rr = split(p);
            const n = rr.error ? null : nodes.get(rr.path);
            if (!n) return Object.assign(item, { ok: false, code: "ENOENT" });
            if (n.kind === "dir") return Object.assign(item, { ok: false, code: "EISDIR" });
            return Object.assign(item, { ok: true, base64: bytesToBase64(n.bytes) });
          });
          return JSON.stringify({ ok: true, items });
        }
        case "write": {
          const body = base64ToBytes(req.base64 ?? "");
          const parentPath = path.slice(0, path.lastIndexOf("/")) || "/";
          if (!nodes.get(parentPath)) return JSON.stringify({ ok: false, code: "ENOENT", path, message: "父目录不存在" });
          const prev = node;
          if (prev && prev.kind === "dir") return JSON.stringify({ ok: false, code: "EISDIR", path, message: "is a directory" });
          nodes.set(path, {
            kind: "file",
            bytes: req.append && prev ? (() => {
              const out = new Uint8Array(prev.bytes.length + body.length);
              out.set(prev.bytes, 0);
              out.set(body, prev.bytes.length);
              return out;
            })() : body,
            mtimeMs: Date.now(),
          });
          return JSON.stringify({ ok: true });
        }
        case "mkdir": {
          if (node) return node.kind === "dir" ? JSON.stringify({ ok: true }) : JSON.stringify({ ok: false, code: "ENOTDIR", path, message: "已存在但不是目录" });
          if (!req.recursive) {
            const parent = nodes.get(path.slice(0, path.lastIndexOf("/")) || "/");
            if (!parent) return JSON.stringify({ ok: false, code: "ENOENT", path, message: "父目录不存在" });
            if (parent.kind !== "dir") return JSON.stringify({ ok: false, code: "ENOTDIR", path, message: "父不是目录" });
            nodes.set(path, { kind: "dir", bytes: null, mtimeMs: Date.now() });
            return JSON.stringify({ ok: true });
          }
          let cur = "";
          for (const seg of r.segs) {
            cur += "/" + seg;
            const n = nodes.get(cur);
            if (!n) nodes.set(cur, { kind: "dir", bytes: null, mtimeMs: Date.now() });
            else if (n.kind !== "dir") return JSON.stringify({ ok: false, code: "ENOTDIR", path, message: "中间段不是目录" });
          }
          return JSON.stringify({ ok: true });
        }
        case "readdir": {
          if (!node) return JSON.stringify({ ok: false, code: "ENOENT", path, message: "no such directory" });
          if (node.kind !== "dir") return JSON.stringify({ ok: false, code: "ENOTDIR", path, message: "不是目录" });
          const seen = new Map();
          const prefix = path + "/";
          for (const key of kidsOf(path)) {
            const rest = key.slice(prefix.length);
            if (!rest) continue;
            const name = rest.split("/")[0];
            if (!seen.has(name)) seen.set(name, rest.includes("/") ? "dir" : nodes.get(key).kind);
          }
          return JSON.stringify({ ok: true, entries: [...seen].map(([name, kind]) => ({ name, kind })) });
        }
        case "unlink":
          if (!node) return JSON.stringify({ ok: false, code: "ENOENT", path, message: "no such file" });
          if (node.kind === "dir") return JSON.stringify({ ok: false, code: "EISDIR", path, message: "是目录" });
          nodes.delete(path);
          return JSON.stringify({ ok: true });
        case "rmdir": {
          if (!node) return JSON.stringify({ ok: false, code: "ENOENT", path, message: "no such directory" });
          if (node.kind !== "dir") return JSON.stringify({ ok: false, code: "ENOTDIR", path, message: "不是目录" });
          if (kidsOf(path).length) return JSON.stringify({ ok: false, code: "ENOTEMPTY", path, message: "目录非空" });
          nodes.delete(path);
          return JSON.stringify({ ok: true });
        }
        case "rm": {
          if (!node) return req.force ? JSON.stringify({ ok: true }) : JSON.stringify({ ok: false, code: "ENOENT", path, message: "no such file" });
          const kids = kidsOf(path);
          if (kids.length && !req.recursive && node.kind === "dir") return JSON.stringify({ ok: false, code: "ENOTEMPTY", path, message: "目录非空" });
          nodes.delete(path);
          for (const k of kids) nodes.delete(k);
          return JSON.stringify({ ok: true });
        }
        case "rename": {
          // 与 TreeBridge 的 rename() 同一张判据表：跨挂载/跨父目录 EXDEV、目录 EISDIR、已存在 EEXIST。
          const to = split(req.to);
          if (to.error) return JSON.stringify({ ok: false, code: to.error[0], path: req.to, message: to.error[1] });
          if (!node) return JSON.stringify({ ok: false, code: "ENOENT", path, message: "no such file" });
          if (r.segs[1] !== to.segs[1] || r.segs.length !== to.segs.length) {
            return JSON.stringify({ ok: false, code: r.segs[1] !== to.segs[1] ? "EXDEV" : "EXDEV", path, message: "同级改名之外不支持" });
          }
          if (node.kind === "dir") return JSON.stringify({ ok: false, code: "EISDIR", path, message: "目录改名不支持" });
          if (nodes.get(to.path)) return JSON.stringify({ ok: false, code: "EEXIST", path: req.to, message: "目标已存在" });
          nodes.delete(path);
          nodes.set(to.path, { ...node, mtimeMs: Date.now() });
          return JSON.stringify({ ok: true, path: to.path });
        }
        case "symlink":
        case "readlink":
          return JSON.stringify({ ok: false, code: "EPERM", path, message: "SAF 树没有符号链接语义" });
        case "realpath":
          if (!node) return JSON.stringify({ ok: false, code: "ENOENT", path, message: "no such file" });
          return JSON.stringify({ ok: true, path });
        default:
          return JSON.stringify({ ok: false, code: "EINVAL", path, message: "未知操作 " + req.op });
      }
    },
  };
}

// 与 SqliteBridge.kt 一一对应：同一个方法名、同一套 JSON/BLOB 约定、同一批窄化。
// 导出给桌面 harness 复用（taskindex-bridge-smoke 跑真 TaskIndexRepo 的迁移+读写），
// 判据改动必须同时过这里和那条 smoke，不许出现两份桥语义。
export function makeFakeNativeBridge(SQL, splitSqlStatements) {
  const dbs = new Map();
  let next = 1;
  globalThis.__fakeBridgeCalls = { open: 0, exec: 0, run: 0, read: 0 };
  globalThis.__fakeBridgeBlobRejects = 0;
  globalThis.__fakeBridgePragmas = 0;
  globalThis.__fakeBridgeBusyTimeout = 0;

  const scalar = (db, sql) => {
    const res = db.exec(sql);
    return res.length && res[0].values.length ? res[0].values[0][0] : 0;
  };
  const fromBridge = (value) =>
    value && typeof value === "object" && typeof value.__b64__ === "string" ? base64ToBytes(value.__b64__) : value;
  const wireValue = (value) => {
    if (value instanceof Uint8Array) return { __b64__: bytesToBase64(value) };
    return value ?? null;
  };

  return {
    open(path) {
      globalThis.__fakeBridgeCalls.open += 1;
      const id = next++;
      dbs.set(id, new SQL.Database());
      globalThis.__fakeHandle = id;
      return id;
    },
    close(handle) {
      dbs.get(handle)?.close();
      dbs.delete(handle);
    },
    exec(handle, sql) {
      const db = dbs.get(handle);
      if (!db) return `no such database ${handle}`;
      globalThis.__fakeBridgeCalls.exec += 1;
      // Kotlin 侧：pragma 走 rawQuery 排空，其余走 execSQL，一次只允许一条。
      // 判据必须大小写不敏感，与 SqliteBridge.kt 修好的 ignoreCase 一致——上一版 Kotlin 按小写
      // startsWith 判、假桥按 /i 判，这个不对称正是"侧栏永远空"三轮装机才抓到的那格：真机的大写
      // `PRAGMA busy_timeout`（TaskIndexRepo.initialize）漏进 execSQL 当场抛。桌面这一档没法复现
      // Kotlin 自己的大小写回归（假桥按正确语义建模，不是镜像 Kotlin 的 bug），设备侧的证人是 M10。
      if (/^\s*pragma/i.test(sql)) globalThis.__fakeBridgePragmas += 1;
      // 桥必须收到 node:sqlite 的 {timeout} 换算出来的 pragma，否则并发启动的等锁语义就丢了。
      if (/busy_timeout/i.test(sql)) globalThis.__fakeBridgeBusyTimeout += 1;
      // 一次性锁错，形状照 Android 的 SQLiteException 文本（结果码在消息里，不在字段上）。
      if (this?.lockNextBegin && /^\s*begin immediate/i.test(sql)) {
        if (this) this.lockNextBegin = false;
        return "[5] database is locked";
      }
      // Android 的 nativePrepareStatement 在第一条完整语句之后还有非空白就抛
      // "cannot execute ... because it contains multiple statements"。触发器体内的分号是合法的，
      // 所以这里用"还能再切出一条"来判，而不是"字符串里有分号"。
      if (splitSqlStatements(sql).length > 1) {
        return `cannot execute "${sql.slice(0, 24)}" because it contains multiple statements`;
      }
      try {
        db.exec(sql);
        return null;
      } catch (e) {
        return String(e?.message ?? e);
      }
    },
    query(handle, sql, params, mode) {
      const db = dbs.get(handle);
      if (!db) throw new Error(`no such database ${handle}`);
      const bound = JSON.parse(params || "[]").map(fromBridge);
      if (mode === "run") {
        globalThis.__fakeBridgeCalls.run += 1;
        const stmt = db.prepare(sql);
        try {
          if (bound.length) stmt.bind(bound);
          stmt.step();
        } finally {
          stmt.free();
        }
        const isInsert = /^\s*(insert|replace)/i.test(sql);
        return JSON.stringify({
          changes: isInsert ? scalar(db, "SELECT changes()") : db.getRowsModified(),
          lastInsertRowid: scalar(db, "SELECT last_insert_rowid()"),
        });
      }
      globalThis.__fakeBridgeCalls.read += 1;
      // 读取侧的 String[] 绑定：**null 元素直接抛**——这才是 Android SQLiteDatabase.rawQuery 的真语义
      // （它对每个绑定值调 bindString，null 当场炸）。上一版这里 `value===null → return null` 原样放过，
      // sql.js 又静默容忍，于是"侧栏 listTaskMetas 查全部绑 @workspace_key=null"这条真机必死的用例
      // 在桌面假桥上全绿（装机报告 2026-10-07：命名参数绑定 FAIL 只有真机抓到，桌面预演漏了）。
      // 修复后读参数在 JS 侧就内联成字面量（sqlite-native.mjs 的 readWire），正常过桥的 params 恒为空；
      // 这里一旦看见 null 绑定，说明有人把 readWire 改回了位置绑定，必须炸出来，而不是复刻那条静默绿。
      if (bound.some((value) => value === null || value === undefined)) {
        throw new Error("模拟 Android rawQuery：绑定数组里有 null（Kotlin 的 String[] 通道绑不了 null，见 readWire）");
      }
      const stringBound = bound.map((value) => {
        if (value instanceof Uint8Array) {
          globalThis.__fakeBridgeBlobRejects += 1;
          throw new Error("原生桥不支持按 BLOB 等值查询");
        }
        return String(value);
      });
      const stmt = db.prepare(sql);
      const rows = [];
      try {
        if (stringBound.length) stmt.bind(stringBound);
        while (stmt.step()) rows.push(Object.fromEntries(Object.entries(stmt.getAsObject()).map(([k, v]) => [k, wireValue(v)])));
      } finally {
        stmt.free();
      }
      return JSON.stringify(rows);
    },
  };
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function newMemoryByteStore() {
  const files = new Map();
  return { read: (p) => files.get(p), write: (p, b) => files.set(p, b) };
}

export function reportText() {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      passed: results.filter((r) => r.ok).length,
      total: results.length,
      results,
    },
    null,
    2,
  );
}
