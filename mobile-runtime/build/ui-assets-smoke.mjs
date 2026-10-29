import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {fileURLToPath} from "node:url";
import {relocateCssAssets} from "./mobile-ui-assets.mjs";
const temp=await mkdtemp(path.join(os.tmpdir(),"azcode-css-"));
try{
  const sourceRoot=path.join(temp,"web"),outdir=path.join(temp,"ui");
  await mkdir(path.join(sourceRoot,"assets"),{recursive:true});
  await writeFile(path.join(sourceRoot,"assets/KaTeX_Main.woff2"),"font fixture");
  const css="@font-face{src:url(/assets/KaTeX_Main.woff2)}.a{background:url(data:image/svg+xml,test)}";
  const result=await relocateCssAssets({css,sourceRoot,outdir,sourceCssFile:path.join(sourceRoot,"assets/index.css")});
  assert.ok(result.css.includes('./assets/KaTeX_Main.woff2'));
  assert.ok(result.css.includes('url(data:image/svg+xml,test)'));
  assert.equal(await readFile(path.join(outdir,"assets/KaTeX_Main.woff2"),"utf8"),"font fixture");
  await assert.rejects(relocateCssAssets({css:"a{src:url(/assets/missing.woff2)}",sourceRoot,outdir,sourceCssFile:path.join(sourceRoot,"assets/index.css")}));
  console.log("PASS CSS绝对URL相对化、对应复制、外链不变、缺资源拒绝构建");
  const dist=fileURLToPath(new URL("./dist-ui/",import.meta.url));
  const actual=await readFile(path.join(dist,"zcode-ui.css"),"utf8");
  assert.ok((await stat(path.join(dist,"workers/diffs.worker.js"))).size>0,"真实Worker入口随包存在");
  const local=[...actual.matchAll(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/g)].map(m=>m[1]).filter(s=>!/^([a-z][\w+.-]*:|\/\/|#)/i.test(s));
  for(const href of local){assert.ok(!href.startsWith("/"),`CSS残留绝对资源URL: ${href}`);assert.ok((await stat(path.join(dist,href.split(/[?#]/)[0]))).size>0);}
  assert.equal(local.filter(s=>s.includes("KaTeX_")).length,59);
  console.log(`PASS 正式CSS引用的${local.length}个本地资源全存在，含59个KaTeX字体`);
}finally{await rm(temp,{recursive:true,force:true});}
