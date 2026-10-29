import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const esbuild = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"))("esbuild");
const out = path.join(root, "mobile-runtime/build", `.tmp-capabilities-${process.pid}.mjs`);
await esbuild.build({ stdin: { contents: 'export * from "./capability-services.ts"; export * from "./plugins-mobile.ts";', resolveDir: path.join(root, "mobile-runtime/ui") }, outfile: out, bundle: true, platform: "node", format: "esm", target: "node24" });
try {
  const api = await import(pathToFileURL(out).href);
  const grants = [], saves = [];
  const hooks = api.createMobileHooksService({
    loadHooks: async () => ({ hooks: [
      { id: "supported", enabled: false, location: { source: "zcode" } },
      { id: "legacy", enabled: true, location: { source: "claude" } },
    ], hooksEnabled: true }),
    saveHooks: async p => saves.push(p),
    grantWorkspaceHookTrust: async p => { grants.push(p); return { accepted: true }; },
  }, () => true);
  const loaded = await hooks.loadHooks({ workspacePath: "/work" });
  assert.deepEqual(loaded.hooks.map(x => x.id), ["supported"]);
  assert.equal(loaded.hooksEnabled, false);
  const request = { workspacePath: "/work", workspaceIdentity: "id", bundleDigest: "bundle", hookDeclarationDigest: "hook" };
  assert.deepEqual(await hooks.grantWorkspaceHookTrust(request), { accepted: true });
  assert.deepEqual(grants, [request]);
  await assert.rejects(hooks.saveHooks({ workspacePath: "/work", hooks: [{ location: { source: "agents" } }] }), /legacy/);
  assert.equal(saves.length, 0);
  const noBridge = api.createMobileHooksService({}, () => false);
  await assert.rejects(noBridge.loadHooks({ workspacePath: "/work" }), /原生命令执行桥/);
  await assert.rejects(noBridge.grantWorkspaceHookTrust(request), /原生命令执行桥/);
  const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const browser = Object.getOwnPropertyDescriptor(globalThis, "zcodeBrowser");
  try {
    const values = new Map();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } });
    delete globalThis.zcodeBrowser;
    assert.equal(api.builtinBrowserPluginInfo().enabled, false);
    const plugins = api.createMobilePluginFace();
    await assert.rejects(plugins.setPluginEnabled({ pluginId: api.BUILTIN_BROWSER_PLUGIN_ID, enabled: true }), /原生桥/);
    globalThis.zcodeBrowser = { open() {} };
    await plugins.setPluginEnabled({ pluginId: api.BUILTIN_BROWSER_PLUGIN_ID, enabled: false });
    assert.equal(api.browserControlEnabled(), false);
    await plugins.setPluginEnabled({ pluginId: api.BUILTIN_BROWSER_PLUGIN_ID, enabled: true });
    assert.equal((await plugins.listPlugins({})).plugins[0].enabled, true);
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => "1", setItem: () => { throw new Error("full"); } } });
    await assert.rejects(plugins.setPluginEnabled({ pluginId: api.BUILTIN_BROWSER_PLUGIN_ID, enabled: false }), /保存失败/);
    assert.equal(api.browserControlEnabled(), true);
  } finally {
    if (storage) Object.defineProperty(globalThis, "localStorage", storage); else delete globalThis.localStorage;
    if (browser) Object.defineProperty(globalThis, "zcodeBrowser", browser); else delete globalThis.zcodeBrowser;
  }
  console.log("capability-truthfulness-smoke: PASS");
} finally { fs.unlinkSync(out); }
