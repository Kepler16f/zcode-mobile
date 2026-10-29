import assert from "node:assert/strict";
import path from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath,pathToFileURL} from "node:url";
import {rmSync} from "node:fs";
const root=fileURLToPath(new URL("../../",import.meta.url));
const require=createRequire(path.join(root,"zcode/apps/zcode-cli/package.json"));
const out=path.join(root,"tmp/start-plan-test.mjs");
try{
 await require("esbuild").build({stdin:{contents:`export {createMobileAccountSource} from './mobile-runtime/ui/account.ts';export {ZAI_PROVIDER_ID,BIGMODEL_PROVIDER_ID} from '@zcode/shared';`,resolveDir:root},
  outfile:out,bundle:true,format:"esm",platform:"node",logLevel:"warning",
  banner:{js:'import {createRequire as _createRequire} from "node:module";const require=_createRequire(import.meta.url);'},
  nodePaths:["ui","services","shared","provider"].map(n=>path.join(root,`zcode/packages/${n}/node_modules`)).concat(path.join(root,"zcode/node_modules")),
  plugins:[{name:"services-deep",setup(b){b.onResolve({filter:/^@zcode\/services\/deep\//},a=>({path:path.join(root,"zcode/packages/services/src",a.path.slice("@zcode/services/deep/".length).replace(/\.js$/,".ts"))}));}}]});
 const {createMobileAccountSource,ZAI_PROVIDER_ID,BIGMODEL_PROVIDER_ID}=await import(pathToFileURL(out).href);
 const data=new Map([[`oauth:${ZAI_PROVIDER_ID}:access_token`,"fixture-access"],[`oauth:${BIGMODEL_PROVIDER_ID}:access_token`,"fixture-access"],["zcodejwttoken","fixture-jwt"]]);
 let network=0;
 const source=createMobileAccountSource({credentialService:{load:async k=>data.get(k)??null,save:async(k,v)=>data.set(k,v),delete:async k=>data.delete(k)},
  settingService:{get:async()=>({})},configSource:{},apiClient:{request:async()=>{network++;throw new Error("不应走套餐Key签发接口");}}});
 for(const family of ["zai","bigmodel"]){assert.equal(await source.resolveCodingPlanApiKey({providerId:`account:${family}-start-plan`,family,forceRefresh:false}),"fixture-jwt");}
 data.delete("zcodejwttoken");
 assert.equal(await source.resolveCodingPlanApiKey({providerId:"account:bigmodel-start-plan",family:"bigmodel",forceRefresh:false}),null,"缺少JWT不能冒用OAuth access token");
 assert.equal(network,0);console.log("PASS 两个账号域的Start Plan均使用ZCode JWT；缺失时拒绝、不误走付费Key签发");
}finally{rmSync(out,{force:true});}
