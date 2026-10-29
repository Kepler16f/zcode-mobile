import assert from "node:assert/strict";
import path from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {createRequire} from "node:module";
import {rmSync} from "node:fs";
import {compatPlugin} from "../compat/build-plugin.mjs";
import {makeFakeFsBridge} from "./selfcheck.mjs";
const root=fileURLToPath(new URL("../../",import.meta.url));
const require=createRequire(path.join(root,"zcode/apps/zcode-cli/package.json"));
const out=path.join(root,"tmp/memory-mobile-test.mjs");
globalThis.zcodeFs=makeFakeFsBridge();
try{
  await require("esbuild").build({stdin:{contents:`
    export {createMemoryService} from './zcode/packages/services/src/memory/memoryService.ts';
    export {setDataBaseDir,getZCodeDataRootDir} from './zcode/packages/services/src/paths.ts';
    export {resolveProjectMemoryRoot} from './zcode/apps/zcode-cli/packages/core/src/memory/project-root.ts';
    export * as vfs from './mobile-runtime/compat/vfs.mjs';`,resolveDir:root},
    outfile:out,bundle:true,format:"esm",platform:"neutral",plugins:[compatPlugin()],logLevel:"warning",
    nodePaths:["services","shared"].map(n=>path.join(root,`zcode/packages/${n}/node_modules`))});
  const {vfs,createMemoryService,setDataBaseDir,getZCodeDataRootDir,resolveProjectMemoryRoot}=await import(pathToFileURL(out).href);
  vfs.setFsEngine("native");await vfs.ensureReady();setDataBaseDir("/work/memory-profile");
  const memory=resolveProjectMemoryRoot({cliStorageRoot:getZCodeDataRootDir()+"/cli",workspacePath:"/sdcard/project"});
  vfs.mkdir(memory,{recursive:true});vfs.writeFile(memory+"/MEMORY.md","# 项目记忆\n保持测试约定。");
  const service=createMemoryService();
  const list=await service.listProjectMemories();assert.equal(list.length,1);
  const read=await service.readProjectMemoryFile({workspaceId:list[0].id,fileName:"MEMORY.md"});
  assert.equal(read.content,"# 项目记忆\n保持测试约定。");assert.equal(typeof read.updatedAt,"number");
  await assert.rejects(service.readProjectMemoryFile({workspaceId:"../escape",fileName:"MEMORY.md"}));
  console.log("PASS 桌面原版Memory目录解析 → 移动VFS写入 → 设置服务列出/稳定句柄预览/越界拒绝");
}finally{rmSync(out,{force:true});}
