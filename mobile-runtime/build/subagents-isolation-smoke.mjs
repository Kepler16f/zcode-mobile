import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const esbuild = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"))("esbuild");
const temp = fs.mkdtempSync(path.join(root, "mobile-runtime/build/.tmp-subagent-isolation-"));
const bundle = path.join(temp, "service.mjs");
try {
  await esbuild.build({ entryPoints: [path.join(root, "zcode/packages/services/src/subagents/subagentsService.ts")],
    outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "warning",
    banner: { js: 'import { createRequire as _createRequire } from "node:module"; const require = _createRequire(import.meta.url);' },
    nodePaths: ["services", "shared"].map(name => path.join(root, "zcode/packages", name, "node_modules")).concat(path.join(root, "zcode/node_modules")) });
  const { createSubagentsService } = await import(pathToFileURL(bundle).href);
  const home = path.join(temp, "home"), a = path.join(temp, "a"), b = path.join(temp, "b");
  fs.mkdirSync(home); fs.mkdirSync(a); fs.mkdirSync(b);
  const service = createSubagentsService({ homeDir: home, isDesktopRuntime: true });
  const config = { name: "reviewer", description: "Review", systemPrompt: "Review changes" };
  const first = (await service.createAgent({ config, provider: "glm", scope: "workspace", workspacePath: a })).agent;
  const second = (await service.createAgent({ config, provider: "glm", scope: "workspace", workspacePath: b })).agent;
  assert.notEqual(first.id, second.id);
  await service.setEnabled({ agentId: first.id, enabled: false });
  assert.equal((await service.list({ workspacePath: a })).agents.find(agent => agent.id === first.id).enabled, false);
  assert.equal((await service.list({ workspacePath: b })).agents.find(agent => agent.id === second.id).enabled, true);
  const victim = path.join(temp, "victim.txt"); fs.writeFileSync(victim, "preserve");
  await assert.rejects(service.deleteAgent({ agentId: first.id, filePath: victim }), /identity or path/i);
  await assert.rejects(service.updateAgent({ agentId: first.id, oldFilePath: victim, config: { ...config, name: "newname" }, provider: "glm", scope: "workspace", workspacePath: a }), /identity or original path/i);
  assert.equal(fs.readFileSync(victim, "utf8"), "preserve");
  const renamed = (await service.updateAgent({ agentId: first.id, oldFilePath: first.path, config: { ...config, name: "renamed" }, provider: "glm", scope: "workspace", workspacePath: a })).agent;
  assert.equal((await service.list({ workspacePath: a })).agents.find(agent => agent.id === renamed.id).enabled, false);
  await service.deleteAgent({ agentId: renamed.id, filePath: renamed.path });
  assert.equal(fs.existsSync(renamed.path), false);
  assert.equal(fs.existsSync(second.path), true);
  console.log("subagents-isolation-smoke: PASS");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
