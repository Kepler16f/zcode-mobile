// 端侧运行时能力探针：同一份文件在桌面 Node、Android libnode、ArkWeb node-wasm 三处执行，
// 输出可对比的 JSON 报告。所有宿主相关访问都走特性探测，不做平台判断。

const results = {
  meta: {
    probeVersion: "1.0.0",
    startedAt: new Date().toISOString(),
    host: detectHost(),
    ua: typeof navigator !== "undefined" ? navigator.userAgent : null,
    esVersion: detectEsVersion(),
  },
  capabilities: {},
  benchmarks: [],
  limits: {},
};

function detectHost() {
  const isNode = typeof process !== "undefined" && !!process.versions?.node;
  const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
  if (isNode && isBrowser) return "node-in-web-view";
  if (isNode) return `node-${process.versions.node}-${process.platform}-${process.arch}`;
  if (isBrowser) return "browser";
  return "unknown";
}

function detectEsVersion() {
  try {
    new Function("class A {}");
    new Function("const a = { ...b };");
    new Function("const a = b?.c ?? d;");
    new Function("const v = 1_000n;");
    new Function("using x = null;");
    return "es2026";
  } catch {
    try {
      new Function("const a = b?.c ?? d;");
      return "es2020+";
    } catch {
      return "older";
    }
  }
}

async function probeCapability(name, fn) {
  try {
    const detail = await fn();
    results.capabilities[name] = { ok: true, detail: detail ?? null };
  } catch (error) {
    results.capabilities[name] = { ok: false, error: shortError(error) };
  }
}

function shortError(error) {
  const code = error?.code;
  const message = String(error?.message ?? error);
  return code ? `${code}: ${message.slice(0, 120)}` : message.slice(0, 120);
}

async function importBuiltin(specifier) {
  return import(specifier);
}

async function bench(name, fn) {
  const started = now();
  try {
    const detail = await fn();
    results.benchmarks.push({ name, ok: true, ms: round(now() - started), detail: detail ?? null });
  } catch (error) {
    results.benchmarks.push({ name, ok: false, ms: round(now() - started), error: shortError(error) });
  }
}

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function round(value) {
  return Math.round(value * 100) / 100;
}

// ---------- Node 侧 ----------

async function probeNode() {
  const builtins = [
    "node:fs",
    "node:fs/promises",
    "node:path",
    "node:crypto",
    "node:vm",
    "node:zlib",
    "node:net",
    "node:worker_threads",
    "node:child_process",
    "node:sqlite",
    "node:sea",
    "node:util",
    "node:os",
  ];
  for (const specifier of builtins) {
    await probeCapability(`import:${specifier}`, async () => {
      const mod = await importBuiltin(specifier);
      return Object.keys(mod).length;
    });
  }

  await probeCapability("fs:roundtrip", async () => {
    const { readFile, writeFile, rm } = await importBuiltin("node:fs/promises");
    const os = await importBuiltin("node:os");
    const path = await importBuiltin("node:path");
    const target = path.join(os.tmpdir?.() ?? ".", "zcode-probe-roundtrip.bin");
    const payload = Buffer.alloc(1024, 7);
    await writeFile(target, payload);
    const back = await readFile(target);
    await rm(target, { force: true });
    if (back.length !== payload.length) throw new Error("length mismatch");
    return back.length;
  });

  await probeCapability("fs:chmod", async () => {
    const { chmod, stat, writeFile, rm } = await importBuiltin("node:fs/promises");
    const os = await importBuiltin("node:os");
    const path = await importBuiltin("node:path");
    const target = path.join(os.tmpdir?.() ?? ".", "zcode-probe-exec.bin");
    await writeFile(target, "#!/bin/sh\n");
    await chmod(target, 0o755);
    const info = await stat(target);
    await rm(target, { force: true });
    return (info.mode & 0o777).toString(8);
  });

  await probeCapability("sqlite:DatabaseSync", async () => {
    const { DatabaseSync } = await importBuiltin("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)");
    db.prepare("INSERT INTO t VALUES (?, ?)").run("a", "b");
    const row = db.prepare("SELECT v FROM t WHERE id = ?").get("a");
    db.close();
    return row.v;
  });

  await probeCapability("vm:runInNewContext", async () => {
    const vm = await importBuiltin("node:vm");
    return vm.runInNewContext("1 + 1");
  });

  await probeCapability("net:listen", async () => {
    const net = await importBuiltin("node:net");
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        server.close(() => resolve(port));
      });
    });
  });

  await probeCapability("worker:available", async () => {
    const { Worker } = await importBuiltin("node:worker_threads");
    return new Promise((resolve, reject) => {
      const worker = new Worker(
        "const {parentPort}=require('node:worker_threads');parentPort.postMessage(42);",
        { eval: true },
      );
      worker.once("message", (value) => {
        worker.terminate();
        resolve(value);
      });
      worker.once("error", reject);
      setTimeout(() => {
        worker.terminate();
        reject(new Error("timeout"));
      }, 3000);
    });
  });

  await probeCapability("child_process:spawn", async () => {
    const { spawnSync } = await importBuiltin("node:child_process");
    const os = await importBuiltin("node:os");
    const executable = os.platform() === "win32" ? "cmd.exe" : "/bin/echo";
    const args = os.platform() === "win32" ? ["/c", "echo hi"] : ["hi"];
    const result = spawnSync(executable, args, { timeout: 3000, encoding: "utf8" });
    if (result.error) throw result.error;
    return `status=${result.status} out=${(result.stdout ?? "").trim()}`;
  });

  await probeCapability("crypto:createHash", async () => {
    const crypto = await importBuiltin("node:crypto");
    return crypto.createHash("sha256").update("abc").digest("hex").slice(0, 12);
  });
}

// ---------- 浏览器 / WebView 侧 ----------

async function probeWeb() {
  await probeCapability("WebAssembly", () => {
    if (typeof WebAssembly !== "object") throw new Error("absent");
    return typeof WebAssembly.instantiateStreaming === "function" ? "streaming" : "basic";
  });

  await probeCapability("SharedArrayBuffer", () => {
    if (typeof SharedArrayBuffer === "undefined") throw new Error("absent (需 cross-origin isolation)");
    return "present";
  });

  await probeCapability("Atomics", () => (typeof Atomics === "object" ? "present" : Promise.reject(new Error("absent"))));

  await probeCapability("fetch:https", async () => {
    if (typeof fetch !== "function") throw new Error("absent");
    const response = await fetch("data:text/plain,ok");
    return (await response.text()).length;
  });

  await probeCapability("WebSocket", () => (typeof WebSocket === "function" ? "present" : Promise.reject(new Error("absent"))));

  await probeCapability("indexedDB", () => (typeof indexedDB !== "undefined" ? "present" : Promise.reject(new Error("absent"))));

  await probeCapability("opfs", async () => {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) throw new Error("absent");
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle("zcode-probe.txt", { create: true });
    const writable = await handle.createWritable();
    await writable.write("ok");
    await writable.close();
    return (await handle.getFile()).size;
  });

  await probeCapability("storageQuota", async () => {
    if (typeof navigator === "undefined" || !navigator.storage?.estimate) throw new Error("absent");
    const estimate = await navigator.storage.estimate();
    return { quotaMB: round((estimate.quota ?? 0) / 1048576), usageMB: round((estimate.usage ?? 0) / 1048576) };
  });

  await probeCapability("postMessage:channel", () => {
    if (typeof MessageChannel !== "function") throw new Error("absent");
    return "present";
  });

  await probeCapability("TextDecoder:gb18030", () => decodeWith("gb18030", [0xd6, 0xd0], "中"));
  await probeCapability("TextDecoder:gbk", () => decodeWith("gbk", [0xd6, 0xd0], "中"));
  await probeCapability("TextDecoder:big5", () => decodeWith("big5", [0xa4, 0xa4], "中"));
  await probeCapability("TextDecoder:utf-8", () => decodeWith("utf-8", [0xe4, 0xb8, 0xad], "中"));
}

function decodeWith(label, bytes, expected) {
  if (typeof TextDecoder === "undefined") throw new Error("no TextDecoder");
  const decoded = new TextDecoder(label, { fatal: false }).decode(new Uint8Array(bytes));
  if (decoded !== expected) throw new Error(`got ${JSON.stringify(decoded)}`);
  return decoded;
}

// ---------- 微基准 ----------

async function runBenchmarks() {
  const text = buildCorpus(2_000_000);

  await bench("scan-regex-2MB", () => {
    let hits = 0;
    for (const match of text.matchAll(/function\s+\w+\s*\(/g)) hits += match[0].length;
    return { hits, matches: text.split("function").length - 1 };
  });

  await bench("json-parse-2MB", () => {
    const json = JSON.stringify({ rows: Array.from({ length: 20000 }, (_, i) => ({ i, name: `row-${i}`, tags: ["a", "b"] })) });
    const parsed = JSON.parse(json);
    return parsed.rows.length;
  });

  await bench("string-concat-1e5", () => {
    const parts = [];
    for (let i = 0; i < 100000; i++) parts.push(i.toString(36));
    return parts.join("-").length;
  });

  await bench("wasm-instantiate", async () => {
    // (module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add))
    const bytes = Uint8Array.from([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f, 0x03, 0x02,
      0x01, 0x00, 0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00, 0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20,
      0x01, 0x6a, 0x0b,
    ]);
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const add = instance.exports.add;
    if (add(1, 2) !== 3) throw new Error("unexpected result");
    return "add(1,2)=3";
  });

  const hasFs = results.capabilities["fs:roundtrip"]?.ok;
  if (hasFs) {
    await bench("fs-write-read-8MB", async () => {
      const { readFile, writeFile, rm } = await import("node:fs/promises");
      const os = await import("node:os");
      const path = await import("node:path");
      const target = path.join(os.tmpdir(), "zcode-probe-8mb.bin");
      const payload = Buffer.alloc(8_388_608, 0x61);
      await writeFile(target, payload);
      const back = await readFile(target);
      await rm(target, { force: true });
      return back.length;
    });

    await bench("crypto-sha256-8MB", async () => {
      const crypto = await import("node:crypto");
      const payload = Buffer.alloc(8_388_608, 0x61);
      return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 8);
    });
  }

  if (typeof performance !== "undefined" && performance.memory) {
    results.limits.jsHeapLimitMB = round(performance.memory.jsHeapSizeLimit / 1048576);
  }
  if (typeof process !== "undefined" && process.memoryUsage) {
    const { rss, heapUsed, heapTotal } = process.memoryUsage();
    results.limits.memoryMB = {
      rss: round(rss / 1048576),
      heapUsed: round(heapUsed / 1048576),
      heapTotal: round(heapTotal / 1048576),
    };
  }
  try {
    const probe = new Uint8Array(256 * 1048576);
    results.limits.allocation256MB = probe.length > 0;
  } catch (error) {
    results.limits.allocation256MB = false;
    results.limits.allocation256MBError = shortError(error);
  }
}

function buildCorpus(targetChars) {
  const unit = `export function sampleFn(index) {\n  const value = "some longer literal string value ${"x".repeat(40)}";\n  return index > 0 ? value : null;\n}\n`;
  const repeat = Math.max(1, Math.ceil(targetChars / unit.length));
  return unit.repeat(repeat).slice(0, targetChars);
}

export async function runProbe() {
  await probeNode();
  await probeWeb();
  await runBenchmarks();
  results.meta.finishedAt = new Date().toISOString();
  results.summary = summarize();
  return results;
}

function summarize() {
  const caps = Object.entries(results.capabilities);
  const ok = caps.filter(([, v]) => v.ok).map(([k]) => k);
  const missing = caps.filter(([, v]) => !v.ok).map(([k]) => k);
  const slow = results.benchmarks.filter((b) => b.ok && b.ms > 2000).map((b) => `${b.name}=${b.ms}ms`);
  const failed = results.benchmarks.filter((b) => !b.ok).map((b) => b.name);
  return { okCount: ok.length, missingCount: missing.length, missing, slow, failed };
}

const entry = typeof process !== "undefined" ? process.argv?.[1] : undefined;
if (entry && (import.meta.url === `file://${entry}` || entry.endsWith("probe.mjs"))) {
  const report = await runProbe();
  const out = JSON.stringify(report, null, 2);
  const target = process.env.ZCODE_PROBE_OUT;
  if (target) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(target, out);
  }
  console.log(out);
}
