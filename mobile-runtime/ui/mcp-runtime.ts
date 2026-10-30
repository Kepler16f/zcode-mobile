import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { NativeMcpServerRecord, ZCodeAgentMcpServer, ZCodeMcpListResult } from "@zcode/shared";
import type { ModelToolCall, ModelToolSpec } from "./model-stream.js";
import type { ToolEngine, ToolRunResult } from "./tool-engine.js";
import { bridgeHttpRaw, bytesFromBase64 } from "./git-tool.js";

type Loader = (request: { workspacePath: string }) => Promise<{ servers: NativeMcpServerRecord[] }>;
type Status = ZCodeMcpListResult["statuses"][string];
type Session = { client: Client; fingerprint: string; tools: ModelToolSpec[]; names: Map<string, string>; timeout: number };
type Workspace = { path: string; abort: AbortController; retired: boolean; sessions: Map<string, Session>; statuses: Record<string, Status>; generation: number; pending: Promise<void> };
const timeoutDefault = 15_000;
const safeName = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_") || "unknown";
const status = (transport: Status["transport"], kind: Status["status"], count = 0, error?: string): Status => ({
  transport, status: kind, toolCount: count, updatedAt: new Date().toISOString(),
  ...(error ? { error, failureKind: "runtime_unavailable" as const } : {}),
});

function bytesToBase64(bytes: Uint8Array): string {
  let value = "";
  for (let i = 0; i < bytes.length; i += 0x8000) value += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(value);
}

/** 原生桥仅支持完整响应；禁止常驻 GET，避免把后台任务永久占住。 */
export async function mobileMcpFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const bridge = (globalThis as { zcodeGitHttp?: { start?: unknown; poll?: unknown; cancel?: unknown } }).zcodeGitHttp;
  // 自定义认证头不会像 Authorization 一样被浏览器自动剥离，必须拒绝跳转到另一服务。
  if (!bridge) return fetch(input, { ...init, redirect: "error" });
  if (typeof bridge.start !== "function" || typeof bridge.poll !== "function" || typeof bridge.cancel !== "function") {
    throw new Error("移动 MCP 需要可取消的原生 HTTP 后台任务桥");
  }
  const request = new Request(input, init);
  if (request.method === "GET" && request.headers.get("accept")?.includes("text/event-stream")) return new Response(null, { status: 405 });
  const body = request.body ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array();
  const response = await bridgeHttpRaw({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers.entries()), bodyBase64: bytesToBase64(body), signal: request.signal });
  const bytes = bytesFromBase64(response.bodyBase64 ?? "");
  if (bytes.byteLength > 4 * 1024 * 1024) throw new Error("MCP 响应过大");
  const code = response.statusCode ?? 500;
  return new Response(code === 204 || code === 205 || code === 304 ? null : bytes.buffer as ArrayBuffer, { status: code, headers: response.headers });
}

function effectiveRecords(records: NativeMcpServerRecord[]): NativeMcpServerRecord[] {
  const selected = new Map<string, NativeMcpServerRecord>();
  for (const record of records) {
    const previous = selected.get(record.name);
    if (!previous || (record.scope === "workspace" && previous.scope !== "workspace")) selected.set(record.name, record);
  }
  return [...selected.values()];
}

function configFingerprint(record: NativeMcpServerRecord): string {
  return JSON.stringify([record.name, record.scope, record.enabled, record.config]);
}

function configuredTransport(record: NativeMcpServerRecord): Status["transport"] {
  return record.config.command ? "stdio" : record.config.type === "sse" ? "sse" : "http";
}

function headersFor(record: NativeMcpServerRecord): Record<string, string> {
  const headers = { ...(record.config.http_headers ?? {}), ...(record.config.headers ?? {}) };
  for (const key of Object.keys(headers)) {
    if (["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "host", "content-length"].includes(key.toLowerCase())) throw new Error("配置覆盖了 MCP 协议保留请求头");
  }
  return headers;
}

function recordsFromRequested(servers: ZCodeAgentMcpServer[]): NativeMcpServerRecord[] {
  return servers.map(server => ({
    name: server.name,
    source: "zcodeagentmcp",
    scope: "workspace",
    enabled: true,
    config: "command" in server
      ? { command: server.command, args: server.args, env: Object.fromEntries(server.env.map(item => [item.name, item.value])), timeoutMs: server.timeoutMs, protocolVersion: server.protocolVersion }
      : { type: server.type, url: server.url, headers: Object.fromEntries(server.headers.map(item => [item.name, item.value])), oauth: server.oauth, timeoutMs: server.timeoutMs, protocolVersion: server.protocolVersion },
  }));
}

export function createMobileMcpRuntime(options: { loadServers: Loader; fetch?: typeof fetch }) {
  const workspaces = new Map<string, Workspace>();
  function workspace(path: string, identity?: string, probe = false): Workspace {
    // 身份和路径同时纳入 key，防止身份偶然复用时跨工作区共享连接。
    const key = JSON.stringify([identity?.trim() || path, path, probe ? "probe" : "agent"]);
    let found = workspaces.get(key);
    if (!found) { found = { path, abort: new AbortController(), retired: false, sessions: new Map(), statuses: {}, generation: 0, pending: Promise.resolve() }; workspaces.set(key, found); }
    return found;
  }
  function releaseWorkspace(path?: string) {
    for (const [key, ws] of workspaces) {
      if (path !== undefined && ws.path !== path) continue;
      // 先退休并移除所有者，再关闭连接；配置加载/握手中的迟到结果不得重新挂回旧工作区。
      ws.retired = true;
      ws.abort.abort();
      ws.generation++;
      for (const session of ws.sessions.values()) void session.client.close().catch(() => {});
      ws.sessions.clear(); ws.statuses = {};
      workspaces.delete(key);
    }
  }
  function invalidate() { releaseWorkspace(); }
  async function connect(record: NativeMcpServerRecord, signal?: AbortSignal): Promise<Session> {
    const transport = configuredTransport(record);
    if (transport !== "http" || record.config.oauth) throw new Error(transport === "stdio" ? "移动端尚不支持 MCP stdio 持续进程" : transport === "sse" ? "移动端尚不支持旧版 MCP SSE 传输" : "移动端尚不支持 MCP OAuth 授权");
    const url = new URL(String(record.config.url ?? ""));
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("MCP 地址必须是无内嵌凭据的 HTTP(S) URL");
    const timeout = Math.min(120_000, Math.max(1000, Number(record.config.timeoutMs) || timeoutDefault));
    const version = record.config.protocolVersion;
    const mode = version === "auto" || version === "legacy" ? version : version === "2026-07-28" ? { pin: version } : "legacy";
    const client = new Client({ name: "aZCode-mobile", version: "0.8.0" }, { capabilities: {}, versionNegotiation: { mode } });
    const stream = new StreamableHTTPClientTransport(url, { requestInit: { headers: headersFor(record) }, fetch: options.fetch ?? mobileMcpFetch });
    try {
      await client.connect(stream, { timeout, signal });
      const names = new Map<string, string>();
      const tools: ModelToolSpec[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, { timeout, signal });
        for (const tool of page.tools) {
          const name = `mcp__${safeName(record.name)}__${safeName(tool.name)}`;
          if (name.length > 64 || names.has(name)) throw new Error("MCP 工具名称冲突或超过模型名称长度限制");
          names.set(name, tool.name);
          tools.push({ name, description: tool.description ?? `MCP ${record.name}: ${tool.name}`, parameters: tool.inputSchema as Record<string, unknown> });
        }
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error("MCP 工具分页游标重复");
        if (cursor) cursors.add(cursor);
        if (tools.length > 1000) throw new Error("MCP 工具数量超过上限");
      } while (cursor);
      return { client, fingerprint: configFingerprint(record), tools, names, timeout };
    } catch (error) { void client.close().catch(() => {}); throw error; }
  }
  async function refresh(path: string, identity?: string, signal?: AbortSignal, explicit?: NativeMcpServerRecord[]) {
    const ws = workspace(path, identity, explicit !== undefined);
    const running = ws.pending.then(() => refreshWorkspace(ws, path, signal, explicit));
    ws.pending = running.then(() => {}, () => {});
    return running;
  }
  async function refreshWorkspace(ws: Workspace, path: string, signal?: AbortSignal, explicit?: NativeMcpServerRecord[]) {
    if (ws.retired) return ws;
    signal = signal ? AbortSignal.any([signal, ws.abort.signal]) : ws.abort.signal;
    const generation = ws.generation;
    const records = effectiveRecords(explicit ?? (await options.loadServers({ workspacePath: path })).servers);
    if (ws.retired) return ws;
    const active = new Set(records.map(r => r.name));
    for (const [name, old] of ws.sessions) if (!active.has(name)) { ws.sessions.delete(name); void old.client.close().catch(() => {}); }
    for (const record of records) {
      if (signal?.aborted || ws.retired) break;
      const type = configuredTransport(record);
      const current = ws.sessions.get(record.name);
      if (current && (current.fingerprint !== configFingerprint(record) || record.enabled === false || record.config.enabled === false)) {
        ws.sessions.delete(record.name); void current.client.close().catch(() => {});
      }
      if (record.enabled === false || record.config.enabled === false) { ws.statuses[record.name] = status(type, "disabled"); continue; }
      if (!ws.sessions.has(record.name)) {
        try {
          const session = await connect(record, signal);
          if (ws.generation !== generation) { void session.client.close().catch(() => {}); continue; }
          ws.sessions.set(record.name, session);
        } catch (error) {
          if (signal?.aborted || ws.retired) break;
          const message = error instanceof Error && /尚不支持|覆盖了 MCP|名称冲突|分页游标|数量超过|无内嵌凭据/.test(error.message) ? error.message : "MCP 连接或工具发现失败，请检查地址、网络和认证配置";
          ws.statuses[record.name] = status(type, "failed", 0, message); continue;
        }
      }
      ws.statuses[record.name] = status(type, "connected", ws.sessions.get(record.name)?.tools.length ?? 0);
    }
    for (const name of Object.keys(ws.statuses)) if (!active.has(name)) delete ws.statuses[name];
    return ws;
  }
  async function wrap(engine: ToolEngine, path: string, identity?: string, signal?: AbortSignal): Promise<ToolEngine> {
    const ws = await refresh(path, identity, signal);
    const byName = new Map<string, { server: string; session: Session }>();
    const owners = new Map<string, string>();
    const collisions = new Set<string>(engine.tools.map(t => t.name));
    for (const [server, session] of ws.sessions) for (const tool of session.tools) {
      if (collisions.has(tool.name)) {
        byName.delete(tool.name);
        const conflicting = owners.get(tool.name);
        const message = "MCP 工具名称冲突，已禁用冲突工具";
        ws.statuses[server] = status("http", "failed", 0, message);
        if (conflicting) ws.statuses[conflicting] = status("http", "failed", 0, message);
        continue;
      }
      collisions.add(tool.name); owners.set(tool.name, server); byName.set(tool.name, { server, session });
    }
    const tools = [...engine.tools, ...[...byName.entries()].map(([name, entry]) => entry.session.tools.find(t => t.name === name)!)];
    return { ...engine, tools, approvalRequired: name => byName.has(name) || engine.approvalRequired(name), async execute(call: ModelToolCall, signal?: AbortSignal): Promise<ToolRunResult> {
      const item = byName.get(call.name);
      if (!item) return engine.execute(call, signal);
      try {
        if (signal?.aborted) throw new Error("MCP 调用已取消");
        const records = effectiveRecords((await options.loadServers({ workspacePath: path })).servers);
        const record = records.find(r => r.name === item.server);
        if (!record || record.enabled === false || record.config.enabled === false || configFingerprint(record) !== item.session.fingerprint || ws.sessions.get(item.server) !== item.session) throw new Error("MCP 配置已变更，请重新发起调用");
        const args: unknown = JSON.parse(call.arguments || "{}");
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("MCP 工具参数必须是 JSON 对象");
        const result = await item.session.client.callTool({ name: item.session.names.get(call.name)!, arguments: args as Record<string, unknown> }, { signal, timeout: item.session.timeout });
        const content = result.content.map(block => block.type === "text" ? block.text : `[不支持显示 MCP ${block.type} 内容]`).join("\n");
        const structured = result.structuredContent === undefined ? "" : JSON.stringify(result.structuredContent);
        const text = [content, structured].filter(Boolean).join("\n").slice(0, 20_000);
        return { content: text, isError: !!result.isError, ...(result.isError ? { errorCode: "mobile.mcpToolFailed" } : {}) };
      } catch (error) {
        const known = error instanceof Error && /已取消|配置已变更|参数必须/.test(error.message) ? error.message : "MCP 工具调用失败或超时";
        return { content: known, isError: true, errorCode: "mobile.mcpToolFailed", errorMessage: known };
      }
    } };
  }
  async function listStatuses(params: { workspacePath: string; workspaceIdentity?: string; mcpServers?: ZCodeAgentMcpServer[]; mode?: "status" | "connect" }): Promise<ZCodeMcpListResult> {
    const explicit = params.mcpServers === undefined ? undefined : recordsFromRequested(params.mcpServers);
    const ws = params.mode === "status"
      ? workspace(params.workspacePath, params.workspaceIdentity, explicit !== undefined)
      : await refresh(params.workspacePath, params.workspaceIdentity, undefined, explicit);
    const statuses = { ...ws.statuses };
    if (params.mode === "status" && explicit) {
      const names = new Set(explicit.map(record => record.name));
      for (const name of Object.keys(statuses)) if (!names.has(name)) delete statuses[name];
    }
    return { statuses };
  }
  return { wrap, listStatuses, invalidate, releaseWorkspace };
}
