import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { compatPlugin } from "../compat/build-plugin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const esbuild = createRequire(path.join(root, "zcode/apps/zcode-cli/package.json"))("esbuild");
const source = `
import * as vfs from "./mobile-runtime/compat/vfs.mjs";
import { createSkillsService } from "./zcode/packages/services/src/skills/skillsService.ts";
import { createSubagentsService } from "./zcode/packages/services/src/subagents/subagentsService.ts";
export async function run() {
  vfs.setFsEngine("memory");
  vfs.mkdir("/work/project/.agents/skills/check", { recursive:true });
  vfs.writeFile("/work/project/.agents/skills/check/SKILL.md", "---\\nname: check\\ndescription: Check changes\\n---\\nCHECK INSTRUCTIONS", {}, "writeFile");
  vfs.mkdir("/work/project/.agents/skills/check/docs", { recursive:true });
  vfs.writeFile("/work/project/.agents/skills/check/docs/ref.md", "reference", {}, "writeFile");
  const skills = createSkillsService({ isDesktopRuntime:true });
  const initial = await skills.list({ workspacePath:"/work/project" });
  const skill = initial.skills.find(s => s.name === "check");
  if (!skill) throw new Error("workspace skill not discovered: " + JSON.stringify(initial));
  await skills.setEnabled({ workspacePath:"/work/project", skillId:skill.id, enabled:false });
  const updated = await skills.list({ workspacePath:"/work/project" });
  if (updated.skills.find(s => s.id === skill.id)?.enabled !== false) throw new Error("skill enable state not persisted");
  const copy = await skills.copyToCommon({ workspacePath:"/work/project", skillId:skill.id });
  if (vfs.readFileSync("/work/project/.zcode/skills/check/docs/ref.md", "utf8") !== "reference") throw new Error("nested skill file not copied");
  const agents = createSubagentsService({ isDesktopRuntime:true, homeDir:"/root" });
  const saved = await agents.createAgent({ config:{ name:"reviewer", description:"Review", systemPrompt:"Inspect" }, provider:"glm", scope:"workspace", workspacePath:"/work/project" });
  const listed = await agents.list({ workspacePath:"/work/project" });
  if (!listed.agents.some(a => a.id === saved.agent.id)) throw new Error("saved agent not found");
  await agents.setEnabled({ agentId:saved.agent.id, enabled:false });
  if ((await agents.list({ workspacePath:"/work/project" })).agents.find(a => a.id === saved.agent.id)?.enabled !== false) throw new Error("agent enable state not persisted");
  return { copy, agent:saved.agent };
}`;
const result = await esbuild.build({ stdin:{ contents:source, resolveDir:root, loader:"ts" }, bundle:true, write:false,
  platform:"browser", format:"esm", target:"es2022", plugins:[compatPlugin()], inject:[path.join(root,"mobile-runtime/compat/prelude.mjs")],
  define:{ "process.env.HOME":'"/root"', "process.env.USERPROFILE":'"/root"', "process.env.NODE_ENV":'"production"' },
  nodePaths:["services", "shared"].map(name => path.join(root,"zcode/packages",name,"node_modules")).concat(path.join(root,"zcode/node_modules")), logLevel:"warning" });
const api = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);
const value = await api.run();
assert.ok(value.copy.newPath.endsWith("/SKILL.md"));
console.log("mobile-capabilities-vfs-smoke: PASS");
