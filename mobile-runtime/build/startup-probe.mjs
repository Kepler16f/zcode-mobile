// 启动期探针：量「打开应用到首屏可交互」的耗时、长任务、Worker 数量与内存。
// 用来区分三种卡顿：主线程长任务、Worker 风暴、资源解析过慢。
import {createRequire} from "node:module";
import {startChatdev} from "./chatdev.mjs";
const require=createRequire(new URL("../../zcode/apps/zcode-cli/package.json",import.meta.url));
const {chromium}=require("playwright-core");
const port=Number(process.argv.find(a=>/^\d{4,5}$/.test(a))??8997);
const mode=process.argv.find(a=>a.startsWith("--mode="))?.slice(7)??"current";
const host=await startChatdev(port);
const browser=await chromium.launch({executablePath:"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"});
const page=await browser.newPage({viewport:{width:393,height:851},isMobile:true,hasTouch:true});
const errors=[];const consoleErrors=[];
page.on("pageerror",e=>errors.push(String(e).slice(0,300)));
page.on("console",m=>{if(m.type()==="error")consoleErrors.push(m.text().slice(0,300));});
await page.addInitScript(()=>{
  globalThis.__longTasks=[];globalThis.__workers=[];
  new PerformanceObserver(list=>{for(const e of list.getEntries())globalThis.__longTasks.push({d:e.duration,s:e.name});}).observe({type:"longtask",buffered:true});
  const Native=globalThis.Worker;
  if(Native){globalThis.Worker=class extends Native{constructor(...args){super(...args);globalThis.__workers.push(String(args[0]?.url??args[0]??"?"));}};}
});
const t0=Date.now();
await page.goto(`http://127.0.0.1:${port}/?devCredentials=1`,{timeout:60000});
let composerMs=null;
for(let i=0;i<200;i++){
  if(await page.locator('[data-testid="v4-composer-send"]').isVisible().catch(()=>false)){composerMs=Date.now()-t0;break;}
  for(const label of ["跳过","使用 API key"]){const b=page.getByText(label,{exact:false}).first();if(await b.isVisible().catch(()=>false))await b.click().catch(()=>{});}
  await page.waitForTimeout(100);
}
await page.waitForTimeout(3000);
const metrics=await page.evaluate(()=>({
  longTasks:globalThis.__longTasks.map(t=>Math.round(t.d)).sort((a,b)=>b-a).slice(0,8),
  longTaskCount:globalThis.__longTasks.length,
  workers:globalThis.__workers,
  heapMB:performance.memory?Math.round(performance.memory.usedJSHeapSize/1048576):null,
  nav:performance.getEntriesByType("navigation").map(n=>({dom:n.domContentLoadedEventEnd,load:n.loadEventEnd})),
  resources:performance.getEntriesByType("resource").length,
  bootTrace:(globalThis.__zcodeBootTrace??[]).map(s=>({step:s.step,at:s.at})),
}));
const trace=metrics.bootTrace??[];
if(trace.length>1){
  const base=trace[0].at;
  console.log("启动阶段耗时：");
  for(let i=0;i<trace.length;i++){
    const next=trace[i+1]?.at??trace[i].at;
    console.log(`  ${String(next-trace[i].at).padStart(6)}ms  ${trace[i].step}`);
  }
  console.log(`  合计 ${trace[trace.length-1].at-base}ms（首条 say 到最后一条）`);
}
console.log(JSON.stringify({mode,composerMs,errors:errors.slice(0,5),consoleErrors:consoleErrors.slice(0,8),...metrics},null,2));
await browser.close();await host.close();
