// 已有SAF项目身份保留，文件与Git入口统一投影到经过原生验证的本地目录。
let cachedBridge;
let cached = {};
export function workspaceAliases(refresh = false) {
  const bridge = globalThis.zcodeWorkspace;
  if (refresh || cachedBridge !== bridge) {
    cachedBridge = bridge;
    try {
      const raw = JSON.parse(bridge?.localTreeAliases?.() ?? "{}");
      cached = Object.fromEntries(Object.entries(raw).filter(([from,to]) => /^\/mnt\/[^/]+$/.test(from) &&
        typeof to === "string" && /^\/sdcard(?:\/|$)/.test(to) && !to.split('/').includes('..')));
    } catch { cached = {}; }
  }
  return cached;
}
export function localWorkspacePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/mnt/') || value.split('/').includes('..')) return value;
  const root = value.split('/').slice(0,3).join('/');
  const target = workspaceAliases()[root];
  return target ? target + value.slice(root.length) : value;
}
export function workspacePathAliases(value) {
  const local = localWorkspacePath(value);
  return [...new Set([local, value, ...Object.entries(workspaceAliases()).flatMap(([from,to]) =>
    local === to || local.startsWith(to+'/') ? [from+local.slice(to.length)] : [])])];
}
