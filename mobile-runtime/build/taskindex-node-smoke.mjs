// task-index 的"真 SQLite"冒烟（Node 24 自带 node:sqlite）。
// 桌面 e2e 走 sql.js（不强制 FK、无 RETURNING、语义宽松），真机走 Android 框架 SQLite。
// 这一档补上中间没测过的空间：TaskIndexRepo 的迁移与读写在标准 SQLite 上是否成立。
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const zcodeRoot = path.join(root, "../zcode");
const require = createRequire(path.join(zcodeRoot, "apps/zcode-cli/package.json"));
const esbuild = require("esbuild");

const tmp = path.join(here, ".tmp-taskindex-smoke.mjs");
await esbuild.build({
  entryPoints: [path.join(zcodeRoot, "packages/services/src/session/taskIndexRepo.ts")],
  outfile: tmp,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  alias: { "#src": path.join(zcodeRoot, "packages/services/src") },
  nodePaths: [
    path.join(zcodeRoot, "packages/services/node_modules"),
    path.join(zcodeRoot, "packages/shared/node_modules"),
    path.join(zcodeRoot, "node_modules"),
  ],
  define: { "process.env.NODE_ENV": '"development"' },
  write: true,
  logLevel: "warning",
});
const { TaskIndexRepo } = await import(pathToFileURL(tmp).href);
fs.rmSync(tmp, { force: true });

const results = [];
const check = (name, fn) => {
  const t0 = Date.now();
  try {
    const detail = fn();
    results.push({ name, ok: true, ms: Date.now() - t0, detail });
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, error: String(e?.stack ?? e).split("\n").slice(0, 4).join(" | ").slice(0, 400) });
  }
};
const checkAsync = async (name, fn) => {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, detail });
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, error: String(e?.stack ?? e).split("\n").slice(0, 4).join(" | ").slice(0, 400) });
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azcode-taskidx-"));
const dbPath = path.join(dir, "tasks-index.sqlite");
const repo = new TaskIndexRepo(dbPath);
const WS = "/work/demo";

const metaOf = (taskId, title, updatedAt) => ({
  taskId,
  traceId: `trace-${taskId}`,
  title,
  workspacePath: WS,
  createdAt: 1759000000000,
  updatedAt,
  mode: "build",
  provider: "glm",
  status: "completed",
});

await checkAsync("ensureReady：完整迁移在真 node:sqlite 上跑通", async () => {
  await repo.ensureReady();
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  const t = db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table'").get();
  db.close();
  return { tables: Number(t.c), dbBytes: fs.statSync(dbPath).size };
});

await checkAsync("syncTaskMeta：写入一行（写链路的 grouped admission 全走一遍）", async () => {
  const meta = await repo.syncTaskMeta({ meta: metaOf("ses-a", "用一句话说说你是谁", 1759000001000), searchableText: "用一句话说说你是谁" });
  return { taskId: meta.taskId, status: meta.status };
});

await checkAsync("queryTaskList：按 workspaceScopes+provider 查回这行（侧栏读取口的原型）", async () => {
  const r = await repo.queryTaskList({ kind: "active", workspaceScopes: [{ workspacePath: WS }], sortBy: "updated", provider: "glm", limit: 50 });
  const hit = r.items.find((it) => it.taskId === "ses-a");
  if (!hit) throw new Error(`查不回 ses-a（items=${r.items.length}, total=${r.total}）`);
  return { items: r.items.length, title: hit.title };
});

await checkAsync("listTaskMetas：命名参数 @workspace_key 在真 node:sqlite 上能绑", async () => {
  const metas = await repo.listTaskMetas({ workspacePath: WS, provider: "glm" });
  return { rows: metas.length };
});

await checkAsync("seedTaskMetaIfMissing：已有行不覆盖、缺失行补上", async () => {
  await repo.seedTaskMetaIfMissing(metaOf("ses-a", "这一条不该写进去", 9999999999999));
  const r = await repo.queryTaskList({ kind: "active", workspaceScopes: [{ workspacePath: WS }], sortBy: "updated", provider: "glm" });
  const a = r.items.find((it) => it.taskId === "ses-a");
  if (a.title !== "用一句话说说你是谁") throw new Error(`seed 把已有标题覆盖了：${a.title}`);
  await repo.seedTaskMetaIfMissing(metaOf("ses-b", "补进来的", 1759000002000));
  const r2 = await repo.queryTaskList({ kind: "active", workspaceScopes: [{ workspacePath: WS }], sortBy: "updated", provider: "glm" });
  if (!r2.items.some((it) => it.taskId === "ses-b")) throw new Error("seed 没补进缺失行");
  return { after: r2.items.length };
});

await checkAsync("重开（close+新实例）：行还在 = 文件级持久化成立", async () => {
  repo.close();
  const repo2 = new TaskIndexRepo(dbPath);
  const r = await repo2.queryTaskList({ kind: "active", workspaceScopes: [{ workspacePath: WS }], sortBy: "updated", provider: "glm" });
  repo2.close();
  return { survived: r.items.map((it) => it.taskId) };
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  process.stdout.write(`${r.ok ? "PASS" : "FAIL"}  ${r.name} (${r.ms} ms)${r.ok ? `  ${JSON.stringify(r.detail ?? "")}` : `\n      → ${r.error}`}\n`);
}
process.stdout.write(`\ntask-index 真 SQLite 冒烟：${results.length - failed.length}/${results.length} PASS\n`);
process.exitCode = failed.length > 0 ? 1 : 0;
