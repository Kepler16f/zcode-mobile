// 把 node:*（以及上游混用的裸名 'fs'/'path'/…）解析到 compat/shims 下的真实垫片文件。
// 映射表来自 surface-probe.mjs 的实测清单，多一个都不要。
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const SHIMS = {
  path: "shims/path.mjs",
  fs: "shims/fs.mjs",
  "fs/promises": "shims/fs-promises.mjs",
  crypto: "shims/crypto.mjs",
  util: "shims/util.mjs",
  "util/types": "shims/util-types.mjs",
  os: "shims/os.mjs",
  process: "shims/process.mjs",
  async_hooks: "shims/async-hooks.mjs",
  net: "shims/net.mjs",
  // nodeApiNetwork.ts:2 只读 rootCertificates；端侧 HTTPS 走系统信任库，见垫片里的说明。
  tls: "shims/tls.mjs",
  vm: "shims/vm.mjs",
  module: "shims/module.mjs",
  sea: "shims/sea.mjs",
  http: "shims/http.mjs",
  perf_hooks: "shims/perf-hooks.mjs",
  // 上游服务层用它做退避和切片让出主线程（svc_setting/svc_file 两轮探测实测）。
  "timers/promises": "shims/timers-promises.mjs",
  // sessionHistoryJsonl 逐行读 JSONL 历史；端侧只需要 for-await 那一面。
  readline: "shims/readline.mjs",
  // oauth 的 base64url 解码从 node:buffer 取 Buffer，而不是用全局（浏览器里没有）。
  buffer: "shims/buffer.mjs",
  // 不属于 core 的 14 个：只有复用桌面 sqlite-session-store 时才需要（§1.5.3 的 1052 KB 实测）。
  sqlite: "shims/sqlite.mjs",
};

/**
 * 非 Node 内置、但端侧同样不该进包的第三方库。和 SHIMS 分开写，是因为"垫片"补的是语义，
 * 这里给的是**明确不可用**的替身：调用即抛，别让它安静地走出一条没有代理/CA 语义的网络路径。
 */
export const PACKAGE_STUBS = {
  undici: "shims/undici.mjs",
};

export function compatPlugin(opts = {}) {
  const external = new Set(opts.external ?? []);
  const registryOverride = opts.bashRegistryOverride ?? null;
  return {
    name: "zcode-mobile-compat",
    setup(b) {
      b.onResolve({ filter: /^node:/ }, (args) => resolve(args.path.slice(5), external));
      b.onResolve({ filter: /^[a-z_]+(\/[a-z_]+)?$/ }, (args) =>
        SHIMS[args.path] ? resolve(args.path, external) : undefined,
      );
      // 第三方 Node-only 库（undici）按裸名匹配，和内置模块同一套写法。
      b.onResolve({ filter: /^[a-z_][a-z0-9_-]*$/ }, (args) =>
        PACKAGE_STUBS[args.path] ? { path: path.join(here, PACKAGE_STUBS[args.path]) } : undefined,
      );
      // 端侧设备上只有 toybox 那一套命令，上游那份 1.9 MB 的 spec 树绝大部分永远命中不了。
      // 只在这次移动端打包里换成按真机清单裁出来的副本；上游文件不动，桌面构建不受影响。
      if (registryOverride) {
        b.onResolve({ filter: /bash-command-registry(\.js)?$/ }, () => ({ path: registryOverride }));
      }
    },
  };
}

function resolve(name, external) {
  const file = SHIMS[name];
  if (!file) {
    return {
      errors: [
        {
          text: `mobile-compat: 没有 node:${name} 的垫片（如果确实需要，先跑 compat/surface-probe.mjs 更新清单）`,
        },
      ],
    };
  }
  if (external.has(name)) return { path: `node:${name}`, external: true };
  return { path: path.join(here, file) };
}
