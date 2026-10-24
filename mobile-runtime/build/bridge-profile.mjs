// R23 的取证：真盘那次 grep 1231.8 ms，到底是"多少次过桥"× "每次多少钱"。
// 桌面用假桥（`zcodeFs`，与 FsBridge.kt 同一条源码对撞判据）跑同一份关卡 3 负载，
// 只数调用次数；单次过桥的价格由真机报告反推，不在这里编。
// 用法：node mobile-runtime/build/bridge-profile.mjs
import * as vfs from "../compat/vfs.mjs";
import { createMobileFileSystemPort } from "../ports/file-system.mjs";
import { makeFakeFsBridge } from "./selfcheck.mjs";

// 这里只要"能抛出端口认识的错误类型"来把端口构造起来；直接 import contracts/dist 会顺着
// @zcode/shared 的 .ts 源码走到 Node 解析不了的 .js（那是打包时才由 esbuild 处理的形态）。
class FileSystemPortError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
  }
}

const FILES = 3000;
const DIRS = 60;

// ESM 命名空间的属性是只读的，所以计数靠一层门面对象，不是改 vfs 本身。
function countingFacade() {
  const counts = {};
  const facade = {};
  for (const key of Object.keys(vfs)) {
    const fn = vfs[key];
    if (typeof fn !== "function") {
      facade[key] = fn;
      continue;
    }
    facade[key] = (...args) => {
      counts[key] = (counts[key] ?? 0) + 1;
      return fn(...args);
    };
  }
  return {
    vfs: facade,
    reset() {
      for (const k of Object.keys(counts)) delete counts[k];
    },
    snapshot() {
      return { ...counts };
    },
  };
}

const tree = (base) => {
  for (let i = 0; i < FILES; i++) {
    const dir = `${base}/src/mod${i % DIRS}`;
    vfs.mkdir(dir, { recursive: true });
    const body = Array.from({ length: 80 }, (_, n) => `export const v${n} = ${i * 80 + n}; // 填充行`).join("\n");
    vfs.writeFile(`${dir}/file${i}.ts`, body + "\nconsole.log('marker-" + i + "');\n");
  }
};

const run = async (label, engine, base) => {
  if (engine === "native") {
    globalThis.zcodeFs = makeFakeFsBridge();
    vfs.setFsEngine("native");
  } else {
    delete globalThis.zcodeFs;
    vfs.setFsEngine("memory");
  }
  tree(base);
  const counter = countingFacade();
  const port = createMobileFileSystemPort(counter.vfs, { workspaceRoot: base, FileSystemPortError });
  const time = async (fn) => {
    counter.reset();
    const t0 = performance.now();
    const out = await fn();
    return { ms: performance.now() - t0, ops: counter.snapshot(), out };
  };
  const glob = await time(() => port.searchFiles({ path: base, pattern: "**/*.ts", maxResults: 5000 }));
  const grep = await time(() => port.searchText({ path: base, pattern: "marker-2999", outputMode: "files_with_matches" }));
  const read = await time(() => port.readTextFile({ path: `${base}/src/mod0/file0.ts` }));
  const total = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  return {
    label,
    engine: vfs.engine(),
    glob: { ms: +glob.ms.toFixed(1), calls: total(glob.ops), ops: glob.ops },
    grep: { ms: +grep.ms.toFixed(1), calls: total(grep.ops), ops: grep.ops },
    read: { ms: +read.ms.toFixed(1), calls: total(read.ops), ops: read.ops },
    globFiles: glob.out.numFiles,
  };
};

const results = [];
results.push(await run("内存盘", "memory", "/bench-mem"));
results.push(await run("假桥（= 设备上的 native 代码路径）", "native", "/bench-native"));

const device = { globMs: 101.2, grepMs: 1231.8, readMs: 8.2 };
const native = results[1];
const perCall = (msKey, opKey) => {
  const calls = native[opKey].calls;
  return calls > 0 ? +(device[msKey] / calls).toFixed(3) : null;
};
console.log(
  JSON.stringify(
    {
      results,
      // 桌面假桥没有真跨语言开销，所以 ms 只用来比"调用次数一样"；把真机 ms 除以这里的次数，
      // 就得到设备上单次过桥的均价 —— 这个价才是决定"批量还是下推"的那个数。
      deviceNumbers: device,
      bridgeCallsPerOp: { glob: native.glob.calls, grep: native.grep.calls, read: native.read.calls },
      impliedCostPerCrossingMs: {
        glob: perCall("globMs", "glob"),
        grep: perCall("grepMs", "grep"),
        read: perCall("readMs", "read"),
      },
      memoryVsNativeCalls: {
        glob: [results[0].glob.calls, native.glob.calls],
        grep: [results[0].grep.calls, native.grep.calls],
      },
    },
    null,
    1,
  ) + "\n",
);
vfs.setFsEngine("memory");
