// 使用真实VFS和文件端口验证旧工作区升级及Memory文件句柄，桥仅替代Android IO。
import assert from "node:assert/strict";
import {makeFakeFsBridge,makeFakeTreeBridge} from "./selfcheck.mjs";
globalThis.zcodeFs=makeFakeFsBridge();
globalThis.zcodeTree=makeFakeTreeBridge();
globalThis.zcodeWorkspace={localTreeAliases:()=>JSON.stringify({"/mnt/old":"/sdcard/Download/project"})};
const aliases=await import("../compat/workspace-aliases.mjs");
const vfs=await import("../compat/vfs.mjs");
const fs=await import("../compat/shims/fs-promises.mjs");
const {createMobileFileSystemPort}=await import("../ports/file-system.mjs");
await vfs.ensureReady();vfs.setFsEngine("native");
const checks=[];
async function check(name,fn){try{await fn();checks.push({name,ok:true});}catch(e){checks.push({name,ok:false,error:String(e.stack)});}}
await check("旧SAF身份读写到同一本地目录，未映射的云盘仍走SAF",async()=>{
  vfs.mkdir("/sdcard/Download/project",{recursive:true});
  vfs.writeFile("/mnt/old/note.md","local");
  assert.equal(vfs.readFileSync("/sdcard/Download/project/note.md","utf8"),"local");
  assert.equal(vfs.readFileSync("/mnt/old/note.md","utf8"),"local");
  assert.equal(aliases.localWorkspacePath("/mnt/fake/a"),"/mnt/fake/a");
  assert.equal(aliases.localWorkspacePath("/mnt/older/a"),"/mnt/older/a");
  assert.equal(aliases.localWorkspacePath("/mnt/old/../escape"),"/mnt/old/../escape");
});
await check("旧路径与本地根共同通过文件边界，越界继续拒绝",async()=>{
  class PortError extends Error{constructor(p){super(p.message);this.code=p.code;}}
  const port=createMobileFileSystemPort(vfs,{workspaceRoot:"/sdcard/Download/project",FileSystemPortError:PortError});
  assert.equal((await port.readTextFile({path:"/mnt/old/note.md",maxBytes:100})).content,"local");
  await assert.rejects(port.readTextFile({path:"/mnt/old/../escape",maxBytes:100}),e=>e.code==="permission_denied");
});
await check("Memory数值只读标志、bigint stat、分片读取和固定快照",async()=>{
  const p="/sdcard/Download/project/MEMORY.md";
  vfs.writeFile(p,"记忆 alpha");
  const handle=await fs.open(p,0);
  assert.equal(typeof (await handle.stat({bigint:true})).size,"bigint");
  const buf=Buffer.alloc(100);
  const {bytesRead}=await handle.read(buf,0,100,0);
  assert.equal(buf.subarray(0,bytesRead).toString(),"记忆 alpha");
  vfs.writeFile(p,"replacement");
  assert.equal(await handle.readFile("utf8"),"记忆 alpha");
  await handle.close();await assert.rejects(handle.readFile("utf8"));
});
for(const c of checks)console.log(`${c.ok?"PASS":"FAIL"} ${c.name}${c.error?"\n"+c.error:""}`);
console.log(`${checks.filter(c=>c.ok).length}/${checks.length} PASS`);
process.exitCode=checks.some(c=>!c.ok)?1:0;
