import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { rm } from "node:fs/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"));
const esbuild = require("esbuild");
const outfile = path.join(root, "tmp/mcp-runtime-smoke-bundle.mjs");
await esbuild.build({ entryPoints: [path.join(root, "mobile-runtime/ui/mcp-runtime.ts")], outfile, bundle: true, platform: "node", format: "esm", nodePaths: [path.join(root, "zcode/node_modules")], logLevel: "silent" });
const { createMobileMcpRuntime, mobileMcpFetch } = await import(pathToFileURL(outfile).href);
let calls = 0;
let authSeen = false;
let listCalls = 0;
const server = http.createServer(async (req, res) => {
  authSeen ||= req.headers.authorization === "Bearer test-secret";
  if (req.method === "GET" || req.method === "DELETE") { res.writeHead(405).end(); return; }
  let body = "";
  for await (const chunk of req) body += chunk;
  const msg = JSON.parse(body);
  if (msg.id === undefined) { res.writeHead(202).end(); return; }
  let result;
  if (msg.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "smoke", version: "1" } };
  else if (msg.method === "tools/list") { listCalls++; result = msg.params?.cursor ? { tools: [{ name: "fail", inputSchema: { type: "object", properties: {} } }, { name: "slow", inputSchema: { type: "object", properties: {} } }] } : { tools: [{ name: "echo", inputSchema: { type: "object", properties: { message: { type: "string" } } } }], nextCursor: "second" }; }
  else if (msg.method === "tools/call") {
    calls++;
    if (msg.params.name === "slow") await new Promise(resolve => setTimeout(resolve, 3000));
    result = msg.params.name === "fail" ? { content: [{ type: "text", text: "server error" }], isError: true } : { content: [{ type: "text", text: msg.params.arguments.message }] };
  } else { res.writeHead(400).end(); return; }
  res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "smoke-session" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
try {
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  let records = [{ name: "sample", source: "zcodeagentmcp", scope: "workspace", enabled: true, config: { type: "http", url, headers: { Authorization: "Bearer test-secret" } } }];
  const runtime = createMobileMcpRuntime({ loadServers: async () => ({ servers: records }) });
  const base = { tools: [], approvalRequired: () => false, execute: async () => ({ content: "unknown", isError: true }), grantRoot() {}, revokeRoot() {} };
  const engine = await runtime.wrap(base, "/workspace", "workspace-1");
  assert.deepEqual(engine.tools.map(t => t.name), ["mcp__sample__echo", "mcp__sample__fail", "mcp__sample__slow"]);
  assert.equal(engine.approvalRequired("mcp__sample__echo"), true);
  assert.equal(calls, 0);
  assert.deepEqual(await engine.execute({ id: "1", name: "mcp__sample__echo", arguments: '{"message":"hello"}' }), { content: "hello", isError: false });
  assert.equal((await engine.execute({ id: "2", name: "mcp__sample__fail", arguments: "{}" })).isError, true);
  assert.equal(authSeen, true);
  const abort = new AbortController();
  const slow = engine.execute({ id: "slow", name: "mcp__sample__slow", arguments: "{}" }, abort.signal);
  setTimeout(() => abort.abort(), 100);
  assert.equal((await slow).isError, true);
  assert.equal((await runtime.listStatuses({ workspacePath: "/workspace", workspaceIdentity: "workspace-1", mode: "status" })).statuses.sample.status, "connected");
  assert.deepEqual((await runtime.listStatuses({ workspacePath: "/other", workspaceIdentity: "workspace-1", mode: "status" })).statuses, {});
  records = [{ ...records[0], enabled: false }];
  assert.equal((await engine.execute({ id: "3", name: "mcp__sample__echo", arguments: "{}" })).isError, true);
  assert.equal(calls, 3);
  const refreshed = await runtime.wrap(base, "/workspace", "workspace-1");
  assert.equal(refreshed.tools.length, 0);
  assert.equal((await runtime.listStatuses({ workspacePath: "/workspace", workspaceIdentity: "workspace-1", mode: "status" })).statuses.sample.status, "disabled");
  const requested = [{ name: "unsaved", type: "http", url, headers: [{ name: "Authorization", value: "Bearer test-secret" }] }];
  const probe = await runtime.listStatuses({ workspacePath: "/workspace", workspaceIdentity: "workspace-1", mcpServers: requested });
  assert.equal(probe.statuses.unsaved.status, "connected");
  assert.equal(probe.statuses.unsaved.toolCount, 3);
  assert.equal((await runtime.listStatuses({ workspacePath: "/workspace", workspaceIdentity: "workspace-1", mode: "status" })).statuses.sample.status, "disabled");
  const beforeStatusOnly = listCalls;
  assert.equal((await runtime.listStatuses({ workspacePath: "/workspace", workspaceIdentity: "workspace-1", mcpServers: requested, mode: "status" })).statuses.unsaved.status, "connected");
  assert.equal(listCalls, beforeStatusOnly);
  assert.deepEqual((await runtime.wrap(base, "/workspace", "workspace-1")).tools, []);
  assert.deepEqual((await runtime.listStatuses({ workspacePath: "/workspace", workspaceIdentity: "workspace-1", mcpServers: [] })).statuses, {});
  const badProbe = await runtime.listStatuses({ workspacePath: "/workspace", workspaceIdentity: "workspace-1", mcpServers: [{ ...requested[0], url: "https://test-secret@invalid.test" }] });
  assert.equal(badProbe.statuses.unsaved.status, "failed");
  assert.doesNotMatch(JSON.stringify(badProbe), /test-secret/);
  runtime.invalidate();
  records = ["a.b", "a!b"].map(name => ({ name, source: "zcodeagentmcp", scope: "workspace", enabled: true, config: { type: "http", url } }));
  const conflict = await runtime.wrap(base, "/conflict", "conflict");
  assert.deepEqual(conflict.tools, []);
  const conflicts = (await runtime.listStatuses({ workspacePath: "/conflict", workspaceIdentity: "conflict", mode: "status" })).statuses;
  assert.equal(conflicts["a.b"].status, "failed");
  assert.equal(conflicts["a!b"].status, "failed");
  runtime.invalidate();
  records = [{ name: "local", source: "zcodeagentmcp", scope: "workspace", config: { command: "node", args: ["example"] } }];
  await runtime.wrap(base, "/unsupported");
  const unsupported = (await runtime.listStatuses({ workspacePath: "/unsupported", mode: "status" })).statuses.local;
  assert.equal(unsupported.status, "failed");
  assert.match(unsupported.error, /stdio/);
  runtime.invalidate();
  let cancelled = false;
  globalThis.zcodeGitHttp = {
    call() { throw new Error("同步桥不应被调用"); },
    start(raw) { const request = JSON.parse(raw); assert.equal(request.headers.authorization, "Bearer bridge-secret"); return '{"id":"job-1"}'; },
    poll() { return JSON.stringify({ done: cancelled, ...(cancelled ? { result: {} } : {}) }); },
    cancel() { cancelled = true; return true; },
  };
  const nativeAbort = new AbortController();
  const waiting = mobileMcpFetch(url, { method: "POST", headers: { Authorization: "Bearer bridge-secret" }, body: "{}", signal: nativeAbort.signal });
  setTimeout(() => nativeAbort.abort(), 50);
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(cancelled, true);
  delete globalThis.zcodeGitHttp;
  console.log("MCP smoke: real HTTP initialization, pagination, auth, calls, errors, cancellation, native bridge cancellation, approval, workspace and config isolation passed");
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(outfile, { force: true });
}
