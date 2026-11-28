import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {unlinkSync} from 'node:fs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const esbuild=createRequire(path.join(root,'zcode/apps/zcode-cli/package.json'))('esbuild');
const out=path.join(root,`mobile-runtime/build/.tmp-model-native-${process.pid}.mjs`);
await esbuild.build({stdin:{contents:'export {streamModelCompletion} from "./model-stream.ts"; export {mobileModelFetch, setUltraZCodeJwtLoader} from "./model-transport.ts"; export {createMobileAgentService} from "./agent.ts"; export {createCommandEnvelope,getV4ClientId} from "../../zcode/packages/ui/src/v4/commandFactory.ts";',resolveDir:path.join(root,'mobile-runtime/ui')},outfile:out,bundle:true,format:'esm',platform:'node',target:'node24',logLevel:'warning',nodePaths:['web','ui','client','services','shared'].map(p=>path.join(root,'zcode/packages',p,'node_modules')).concat(path.join(root,'zcode/node_modules')),alias:{'@':path.join(root,'zcode/packages/ui/src')}});
const originalFetch=globalThis.fetch;
const jobs=new Map(); let serial=0,cancelled=0,mode='stream',requestRecord,ended=false;
const server=http.createServer(async(req,res)=>{
 let data='';for await(const chunk of req)data+=chunk;
 requestRecord={headers:req.headers,body:JSON.parse(data)};
 if(mode==='error'){res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'invalid api key'}}));return;}
 if(mode==='hold'){res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();return;}
 res.writeHead(200,{'content-type':'text/event-stream'});
 const frame=Buffer.from('event: content_block_delta\ndata: '+JSON.stringify({type:'content_block_delta',delta:{type:'text_delta',text:'你好'}})+'\n\n');
 // 刻意在中文 UTF-8 字节中间拆块。
 const split=frame.indexOf(Buffer.from('你好'))+1;
 res.write(frame.subarray(0,split));
 setTimeout(()=>res.write(frame.subarray(split)),15);
 setTimeout(()=>{ended=true;res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');},180);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let lastDispatchedUrl='';
const nativeBridge={start(raw){const id=String(++serial),request=JSON.parse(raw),job={queue:[],done:false,controller:new AbortController()};jobs.set(id,job);
 lastDispatchedUrl=request.url;
 assert.match(request.url,/^(https:\/\/api\.minimaxi\.com\/anthropic\/v1\/messages|https:\/\/zcode\.z\.ai\/api\/v1\/(zcode-plan|ultra)\/anthropic\/v1\/messages)$/,'模型请求只该打第三方 anthropic 网关或官方 zcode-plan/ultra 网关');
 (async()=>{try{const res=await originalFetch(`http://127.0.0.1:${server.address().port}`,{method:'POST',headers:request.headers,body:request.body,signal:job.controller.signal});job.status=res.status;job.headers=Object.fromEntries(res.headers);for await(const bytes of res.body)job.queue.push(Buffer.from(bytes).toString('base64'));}catch{job.error='native connection failed';}finally{job.done=true;}})();return JSON.stringify({id});},
 poll(id){const job=jobs.get(id);if(!job)return JSON.stringify({error:'missing'});const bodyBase64=job.queue.shift();const done=job.done&&!job.queue.length;const packet={status:job.status,headers:job.headers,bodyBase64,done,...(done&&job.error?{error:job.error}:{})};if(done)jobs.delete(id);return JSON.stringify(packet);},
 cancel(id){const job=jobs.get(id);if(job){cancelled++;job.controller.abort();jobs.delete(id);}return true;}};
try{
 const {streamModelCompletion,mobileModelFetch,setUltraZCodeJwtLoader,createMobileAgentService,createCommandEnvelope,getV4ClientId}=await import(pathToFileURL(out).href);
 globalThis.zcodeModelHttp=nativeBridge;
 globalThis.fetch=async()=>{throw new TypeError('Failed to fetch (CORS)');};
 const target={apiFormat:'anthropic-messages',baseUrl:'https://api.minimaxi.com/anthropic',apiKey:'test-only-key',model:'MiniMax-M2.7'};
 let incremental=false;
 const result=await streamModelCompletion({target,messages:[{role:'user',content:'ping'}],onDelta:text=>{assert.equal(ended,false,'必须在服务端断开前输出增量');incremental=true;}});
 assert.equal(result.text,'你好');assert.ok(incremental);assert.equal(result.truncated,false);
 assert.equal(requestRecord.body.model,'MiniMax-M2.7');assert.equal(requestRecord.headers['x-api-key'],'test-only-key');
 assert.ok(!String(requestRecord.headers['user-agent']??'').includes('ai-sdk/anthropic'),'第三方网关不得被注入 SDK UA 后缀');

 // 0.12.6 官方域 UA 双层拼接（官方 ai-sdk/anthropic UO() 把上下文 UA 与 SDK UA 空格 join）：
 // `ZCode/<ver> ai-sdk/anthropic/<sdkVer>`。第三方网关不读 UA，零影响。diag 记录实际头名清单。
 {
  const midStore=new Map();
  globalThis.localStorage={getItem:(k)=>midStore.has(k)?midStore.get(k):null,setItem:(k,v)=>midStore.set(k,String(v))};
  const officialResponse=await mobileModelFetch('https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages',{headers:{'content-type':'application/json'},body:'{}'});
  await officialResponse.text().catch(()=>{});
  assert.match(String(requestRecord.headers['user-agent']??''),/^ZCode\/\d+\.\d+\.\d+ ai-sdk\/provider-utils\/\d+\.\d+\.\d+ runtime\/node\.js\/\d+$/,'官方域模型请求 UA 必须是官方 4.0.0 三段形状（无 ai-sdk/anthropic 段，dump req-001 实测）');
  assert.equal(requestRecord.headers['anthropic-beta'],'mid-conversation-system-2026-04-07','官方域对话请求必须带 anthropic-beta 标记');
  assert.ok(requestRecord.headers['x-platform'],'官方域模型请求必须带身份头');
  const diag=JSON.parse(midStore.get('zcode-mobile.model.diag')??'[]');
  const last=diag[diag.length-1];
  assert.ok(last&&Array.isArray(last.headerNames)&&last.headerNames.includes('x-platform'),'model.diag 必须记录实际头名清单（含归一层注入的身份头）');
  assert.ok(!last.headerNames.includes('anthropic-dangerous-direct-browser-access'),'原生路径必须剥掉浏览器自报头');
  delete globalThis.localStorage;
 }

 // Start Plan 直发 zcode-plan（带 ZCode JWT 时也不重写到 ultra，也不打 c1f3a7e2 签名）。
 {
  const midStore=new Map();
  globalThis.localStorage={getItem:(k)=>midStore.has(k)?midStore.get(k):null,setItem:(k,v)=>midStore.set(k,String(v))};
  const jwt=['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCIsInNpZ25fdHlwZSI6IlNJR04ifQ',Buffer.from(JSON.stringify({token_use:'project_access',api_key:'ak-start'})).toString('base64url'),'x'].join('.');
  const startResponse=await mobileModelFetch('https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages',{headers:{'content-type':'application/json','authorization':`Bearer ${jwt}`,'anthropic-dangerous-direct-browser-access':'true','x-session-id':'sess-start-plan'},body:'{"model":"GLM-5.3-Flash"}'});
  await startResponse.text().catch(()=>{});
  assert.equal(lastDispatchedUrl,'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages','Start Plan 必须直发 zcode-plan 端点，严禁重定向到 ultra');
  assert.equal(requestRecord.headers['x-client-sig'],undefined,'Start Plan 不带 ultra 客户端签名');
  assert.equal(requestRecord.headers['x-platform'],'linux-arm64');
  const diag=JSON.parse(midStore.get('zcode-mobile.model.diag')??'[]');
  const last=diag[diag.length-1];
  assert.equal(last.dangerousBrowserHeader,false,'model.diag 应按剥头后的真实线头记录 dangerousBrowserHeader=false');
  assert.equal(last.hasZcodeAgent,true,'model.diag 应按归一后的真实线头记录 hasZcodeAgent=true');
  delete globalThis.localStorage;
 }

 // Coding Plan（open.bigmodel.cn）经 agent/configs 路由到 ultra，并按需附带 ZCode OAuth JWT；handshake fail-open。
 {
  const midStore=new Map();
  globalThis.localStorage={getItem:(k)=>midStore.has(k)?midStore.get(k):null,setItem:(k,v)=>midStore.set(k,String(v))};
  setUltraZCodeJwtLoader(async()=>'zcode-oauth-jwt-token');
  const ultraResponse=await mobileModelFetch('https://open.bigmodel.cn/api/anthropic/v1/messages',{headers:{'content-type':'application/json','authorization':'Bearer coding-plan-id.secret','x-session-id':'sess-smoke-session'},body:'{"model":"GLM-5.3-Flash"}'});
  await ultraResponse.text().catch(()=>{});
  assert.equal(lastDispatchedUrl,'https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages','Coding Plan 必须路由到 ultra');
  assert.equal(requestRecord.headers['x-zcode-authorization'],'Bearer zcode-oauth-jwt-token','ultra 附带的 X-ZCode-Authorization 必须是 ZCode JWT');
  assert.equal(requestRecord.headers['x-platform'],'linux-arm64','zcode.z.ai ultra 保持 linux-arm64 白名单值');
  const ultraDiag=JSON.parse(midStore.get('zcode-mobile.model.diag')??'[]');
  const ultraLast=ultraDiag[ultraDiag.length-1];
  assert.ok(ultraLast&&ultraLast.status!==undefined,'ultra 请求必须落 model.diag');
  setUltraZCodeJwtLoader(null);
  delete globalThis.localStorage;
 }

 // 0.12.9 官方对话请求的 system 三段形状（3012 根因修复）：网关按请求体判客户端，
 // 官方是 cli_prefix/identity/dynamic 三个 text block、每块带 cache_control ephemeral；
 // metadata.user_id 形状 {"device_id","account_uuid","session_id"}。
 {
  const officialTarget={apiFormat:'anthropic-messages',baseUrl:'https://zcode.z.ai/api/v1/zcode-plan/anthropic',apiKey:'jwt-token',model:'GLM-5.3-Flash'};
  const segments=['You are ZCode, an interactive agent','IDENTITY BODY','\n\nDYNAMIC BODY'];
  await streamModelCompletion({target:officialTarget,messages:[{role:'system',content:segments.join('\n\n'),systemSegments:segments},{role:'user',content:'hi'}],maxOutputTokens:64,onDelta(){}});
  const sentBody=requestRecord.body;
  assert.ok(Array.isArray(sentBody.system)&&sentBody.system.length===3,'官方域对话请求 system 必须是三段 text block');
  assert.equal(sentBody.system[0].text,'You are ZCode, an interactive agent','system[0] 必须是官方 4.0.0 cli_prefix 逐字（无 coding 一词，dump 实测）');
  assert.equal(sentBody.system[0].cache_control?.type,undefined,'system[0] 不带 cache_control（官方实测 block0 无）');
  assert.equal(sentBody.system[2].cache_control?.type,'ephemeral','system[2] 必须带 cache_control ephemeral');
  assert.ok(typeof sentBody.metadata?.user_id==='string'&&sentBody.metadata.user_id.includes('"device_id"'),'官方域对话请求必须带官方形状 metadata.user_id');
 }

 // 正式会话通过同一原生桥发请求，不能只证明设置页的测试可用。
 ended=false;
 const agent=createMobileAgentService({modelTargets:{view:async()=>({providers:[{providerId:'minimax',models:[{modelId:'MiniMax-M2.7'}],config:{api:{type:'anthropic-messages',baseUrl:'https://api.minimaxi.com/anthropic'},access:{type:'personal-api-key',apiKey:'test-only-key'}}}],preferredSelection:{providerId:'minimax',modelId:'MiniMax-M2.7'}})}});
 try {
  const hello=await agent.helloConversationV4();
  await agent.initializeConversationV4({kind:'clientHello',protocolVersion:hello.protocolVersion,clientId:getV4ClientId(),clientKind:'mobileApp',appVersion:'test'});
  const envelope=(type,sessionId,payload)=>createCommandEnvelope({type,sessionId,payload});
  const created=await agent.sendConversationCommandV4({workspacePath:'/work/native-test',envelope:envelope('createSession',null,{workspaceId:'native-test'})});
  assert.equal(created.status,'accepted');
  const sessionId=created.result.sessionId;
  const sent=await agent.sendConversationCommandV4({workspacePath:'/work/native-test',envelope:envelope('sendText',sessionId,{text:'ping'})});
  assert.equal(sent.status,'accepted');
  let snapshot; const deadline=Date.now()+5000;
  do {await new Promise(r=>setTimeout(r,20));snapshot=await agent.readSession({workspacePath:'/work/native-test',sessionId});}while(snapshot.session.status==='running'&&Date.now()<deadline);
  assert.match(JSON.stringify(snapshot.messages),/你好/,'正式对话必须通过原生桥收到模型正文');
 } finally {agent.disposeAll();}
 mode='error';await assert.rejects(streamModelCompletion({target,messages:[{role:'user',content:'ping'}],onDelta(){}}),e=>e.statusCode===401&&/invalid api key/.test(e.message));
 mode='hold';const controller=new AbortController();const pending=streamModelCompletion({target,messages:[{role:'user',content:'ping'}],signal:controller.signal,onDelta(){}});setTimeout(()=>controller.abort(),60);await assert.rejects(pending);assert.ok(cancelled>0);
 const before=serial;const aborted=new AbortController();aborted.abort();await assert.rejects(mobileModelFetch('https://api.minimaxi.com/anthropic/v1/messages',{headers:{},body:'{}',signal:aborted.signal}),e=>e.name==='AbortError');assert.equal(serial,before);
 assert.equal(jobs.size,0,'成功、错误和取消后都不能遗留原生任务');
 delete globalThis.zcodeModelHttp;let browserCalls=0;globalThis.fetch=async()=>{browserCalls++;return new Response('ok');};assert.equal(await(await mobileModelFetch('https://example.invalid',{headers:{},body:'{}'})).text(),'ok');assert.equal(browserCalls,1);
 // 壳里缺桥不许悄悄退回 fetch：那正是用户看到的 `Failed to fetch`（跨源预检被拦，
 // 报错却完全指不到真因）。Android 壳（其它原生桥在场）必须立刻报「原生模型桥不可用」。
 globalThis.zcodeFs={};
 await assert.rejects(mobileModelFetch('https://example.invalid',{headers:{},body:'{}'}),e=>/原生模型桥不可用/.test(e.message));
 assert.equal(browserCalls,1,'壳里缺桥时不能再走浏览器 fetch');
 delete globalThis.zcodeFs;
 // 持续有数据的原生桥也要给计时器/触摸事件运行机会，不能只靠等网络时让出。
 let burstIndex=0, timerRan=false;
 globalThis.zcodeModelHttp={start(){return JSON.stringify({id:'burst'});},poll(){
   const until=performance.now()+2;while(performance.now()<until){}
   burstIndex++;
   return JSON.stringify({status:200,bodyBase64:Buffer.from('x').toString('base64'),done:burstIndex>=24});
 },cancel(){return true;}};
 const burst=await mobileModelFetch('https://example.invalid',{headers:{},body:'{}'});
 const uiTimer=setTimeout(()=>{timerRan=true;},0);
 assert.equal((await burst.text()).length,24);
 clearTimeout(uiTimer);
 assert.ok(timerRan,'连续桥数据消费期间 UI 宏任务必须获得运行机会');
 console.log('model-native-transport-smoke: PASS (MiniMax streaming, CORS bypass, UTF-8, HTTP errors, cancellation, browser fallback, Android bridge checks, UI fairness)');
}finally{globalThis.fetch=originalFetch;delete globalThis.zcodeModelHttp;delete globalThis.zcodeFs;for(const job of jobs.values())job.controller.abort();server.closeAllConnections();await new Promise(r=>server.close(r));unlinkSync(out);}
