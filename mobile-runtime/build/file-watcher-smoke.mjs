// 移动端文件监视服务（轮询形态）的回归。
// 用内存盘当工作区：真盘的 stat 由原生桥提供，SAF 由树桥提供；这里验的是
// 「快照 → 比对 → 事件」这条链本身，以及失效 watcher 不炸订阅链路。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require = createRequire(path.join(root, "../zcode/apps/zcode-cli/package.json"));
const esbuild = require("esbuild");
const out = path.join(here, `.tmp-file-watcher-${process.pid}.mjs`);
await esbuild.build({
  entryPoints: [path.join(root, "ui/file-watcher.ts")],
  outfile: out, bundle: true, format: "esm", platform: "node", target: "node24",
  external: ["../compat/vfs.mjs"], logLevel: "warning",
  nodePaths: ["rpc", "ui", "client", "services", "shared"].map((n) => path.join(root, "../zcode/packages", n, "node_modules")).concat(path.join(root, "../zcode/node_modules")),
});
const { createMobileFileWatcherService } = await import(pathToFileURL(out).href);
const vfs = await import(pathToFileURL(path.join(root, "compat/vfs.mjs")).href);
const { rmSync } = await import("node:fs");

vfs.setFsEngine("memory");
vfs.memory.reset();
vfs.mkdir("/work/watched", { recursive: true });

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: Boolean(ok), detail });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const service = createMobileFileWatcherService({ pollIntervalMs: 60_000 });
const events = [];
const { id } = await service.watch({ path: "/work/watched" });
service.onDynamicChange(id)((event) => events.push(event));

vfs.writeFile("/work/watched/a.txt", "one", {});
service.tick();
await wait(220);
check("新增文件触发事件", events.length === 1, JSON.stringify(events));
check("事件带被监视目录", events[0]?.dirPath === "/work/watched");
check("单一变化带 changedPath", typeof events[0]?.changedPath === "string", JSON.stringify(events[0]));

vfs.writeFile("/work/watched/a.txt", "two-longer", {});
service.tick();
await wait(220);
check("内容变化触发事件", events.length === 2, String(events.length));

vfs.unlinkSync("/work/watched/a.txt");
service.tick();
await wait(220);
check("删除触发事件", events.length === 3, String(events.length));

vfs.writeFile("/work/watched/b.txt", "x", {});
vfs.writeFile("/work/watched/c.txt", "y", {});
service.tick();
await wait(220);
check("多个变化合并为一次保守事件", events.length === 4, String(events.length));
check("多变化事件不带 changedPath", events[3]?.changedPath === undefined, JSON.stringify(events[3]));

const before = events.length;
service.tick();
await wait(220);
check("无变化不发事件", events.length === before, String(events.length));

await service.unwatch({ id });
vfs.writeFile("/work/watched/d.txt", "z", {});
service.tick();
await wait(220);
check("unwatch 后不再发事件", events.length === before, String(events.length));

let staleThrew = false;
try { service.onDynamicChange("no-such-id"); } catch { staleThrew = true; }
check("失效 watcher id 不抛错", !staleThrew);

let watchError = null;
try { await service.watch({ path: "/work/missing-dir" }); } catch (e) { watchError = String(e?.message ?? e); }
check("监视不存在的目录如实报错", /无法监视目录/.test(String(watchError)), String(watchError));

let relativeError = null;
try { await service.watch({ path: "relative/path" }); } catch (e) { relativeError = String(e?.message ?? e); }
check("相对路径被拒绝", /绝对路径/.test(String(relativeError)), String(relativeError));

service.disposeAll();
rmSync(out, { force: true });
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : `  → ${r.detail}`}`);
console.log(`\n文件监视冒烟：${results.length - failed.length}/${results.length} PASS`);
process.exitCode = failed.length ? 1 : 0;
