import path from "node:path";
import {createRequire} from "node:module";
import {readFileSync,existsSync} from "node:fs";
import {copyFile,mkdir} from "node:fs/promises";

// Streamdown和diff都声明Shiki 3；统一移动模块图到它们的同一个实例。
// UI用到的createHighlighter/bundledLanguages等公共API在此版本也存在，桌面依赖保持原样。
//
// 关键在于「按声明方解析」而不是「按目录顺序解析」：pnpm 的 hoisted 布局把
// @shikijs/* 平铺在仓库根，而根上的版本本身是混的（@shikijs/langs 是 4.1.0，
// @shikijs/core 却是 3.23.0）。shiki@3.23.0 只把 langs/themes/types/engine-*
// 嵌进自己的 node_modules，core 和 transformers 不在其中——这两个包会落到根上，
// 今天根上恰好是 3.23.0，一旦上游动布局或平铺版本，就会变成「3.23.0 的 core
// 配 4.x 的 langs」的真混搭，而且构建期毫无征兆。所以每个 @shikijs/* 都从
// 声明它的那一方解析（shiki 声明的走 shiki 的基准，transformers 走 diffs 的
// 基准），再由 assertShikiConsistency 在构建期核对实际版本。
export function mobileShikiDependency(zcodeRoot) {
  const resolver=createRequire(path.join(zcodeRoot,"package.json"));
  const packageFile=resolver.resolve("shiki/package.json");
  const canonical=createRequire(packageFile);
  const shikiPackage=JSON.parse(readFileSync(packageFile,"utf8"));
  const version=shikiPackage.version;
  const diffsPackage=JSON.parse(readFileSync(path.join(zcodeRoot,"node_modules/@pierre/diffs/package.json"),"utf8"));

  // 每个 @shikijs/* 需要哪个版本：shiki 自己精确声明的直接取；
  // @pierre/diffs 声明的 transformers 是 ^3.0.0，取同主版本。
  const required=new Map();
  for(const [name,range] of Object.entries(shikiPackage.dependencies??{})){
    if(!name.startsWith("@shikijs/"))continue;
    const major=/\^(\d+)/.exec(range);
    required.set(name,major?{major:major[1]}:{exact:range});
  }
  for(const [name,range] of Object.entries(diffsPackage.dependencies??{})){
    if(!name.startsWith("@shikijs/")||required.has(name))continue;
    const major=/\^(\d+)/.exec(range);
    required.set(name,major?{major:major[1]}:{exact:range});
  }

  // 版本自洽集合在磁盘上是横跨两个目录的：shiki 只把 langs/themes/types/engine-*
  // 嵌在自己的 node_modules 下，core/transformers 落在仓库根（那里 langs/themes
  // 又是 4.1.0）。所以不能靠「从某个基准 resolve」碰运气——那样哪天 pnpm 把根上
  // 的 core 换成 4.x，就会变成 3.23.0 的 core 配 4.x 的 langs。
  // 这里按「哪个目录里的这份包版本符合要求」来挑，挑不到就让构建失败。
  const searchRoots=[
    path.join(zcodeRoot,"node_modules/shiki/node_modules/@shikijs"),
    path.join(zcodeRoot,"node_modules/@shikijs"),
    path.join(zcodeRoot,"packages/ui/node_modules/@shikijs"),
  ];
  const pins=new Map();
  for(const [name,rule] of required){
    let found=null;
    for(const root of searchRoots){
      // name 自带 @shikijs/ 前缀，searchRoots 已经是 @shikijs 目录本身。
      const dir=path.join(root,name.slice(name.indexOf("/")+1));
      const pj=path.join(dir,"package.json");
      if(!existsSync(pj))continue;
      const candidate=JSON.parse(readFileSync(pj,"utf8"));
      const ok=rule.exact?candidate.version===rule.exact:String(candidate.version).startsWith(rule.major+".");
      if(ok){found={dir,version:candidate.version};break;}
    }
    if(!found)throw new Error(`移动端Shiki依赖统一：找不到满足 ${name}@${rule.exact??rule.major+".x"} 的副本`);
    pins.set(name,found);
  }
  const languageRoot=path.dirname(canonical.resolve("@shikijs/langs"));

  return {version,languageRoot,plugin:{name:"mobile-single-shiki-dependency",setup(build){
    build.onResolve({filter:/^(?:shiki(?:\/|$)|@shikijs\/)/},args=>{
      if(args.path==="shiki"||args.path.startsWith("shiki/"))return {path:canonical.resolve(args.path)};
      // 作用域包名要取到第二个斜杠：@shikijs/langs/typescript 的包名是 @shikijs/langs。
      const segments=args.path.split("/");
      const name=args.path.startsWith("@")?segments.slice(0,2).join("/"):segments[0];
      const pin=pins.get(name);
      if(!pin)throw new Error(`移动端Shiki依赖统一：${name} 没有已知版本要求，拒绝解析`);
      // 以被钉住的那份包自身为基准解析子路径：
      // @shikijs/langs/typescript 必须落在 3.23.0 的 langs 里，不能落到根上的 4.1.0。
      const scoped=createRequire(path.join(pin.dir,"package.json"));
      return {path:scoped.resolve(args.path)};
    });
  }}};
}

// 构建期核对：移动模块图里的 shiki / @shikijs/* 必须是同一个自洽集合，
// 且 packages/ui 私有的另一份 shiki 不能混进来。混搭在这里就炸，
// 而不是等到装机后高亮器初始化时才暴露。
export function assertShikiConsistency(zcodeRoot,inputs) {
  const shikiPackage=JSON.parse(readFileSync(path.join(zcodeRoot,"node_modules/shiki/package.json"),"utf8"));
  const diffsPackage=JSON.parse(readFileSync(path.join(zcodeRoot,"node_modules/@pierre/diffs/package.json"),"utf8"));
  // 期望版本：shiki 精确声明的直接用；范围声明的（^X.Y.Z）要求同主版本。
  const expected=new Map();
  const add=(name,range)=>{
    if(/^\d+\.\d+\.\d+$/.test(range))expected.set(name,{exact:range});
    else{const major=/\^(\d+)/.exec(range);if(major)expected.set(name,{major:major[1]});}
  };
  for(const [name,range] of Object.entries(shikiPackage.dependencies??{}))if(name.startsWith("@shikijs/"))add(name,range);
  for(const [name,range] of Object.entries(diffsPackage.dependencies??{}))if(name.startsWith("@shikijs/")&&!expected.has(name))add(name,range);

  const ownerCache=new Map();
  const ownerOf=file=>{
    let dir=path.dirname(file);
    for(let i=0;i<12;i++){
      const p=path.join(dir,"package.json");
      if(ownerCache.has(p))return ownerCache.get(p);
      if(existsSync(p)){
        try{
          const j=JSON.parse(readFileSync(p,"utf8"));
          if(j.name){const info={name:j.name,version:j.version,dir};ownerCache.set(p,info);return info;}
        }catch{}
      }
      const parent=path.dirname(dir);if(parent===dir)break;dir=parent;
    }
    return null;
  };

  const seen=new Map();
  const uiPrivate=path.join(zcodeRoot,"packages/ui/node_modules");
  for(const input of inputs){
    const abs=path.resolve(zcodeRoot,"..",input);
    // 只盯 shiki 系的私有副本：packages/ui 自己那份 shiki@4.0.2 / @shikijs@4.0.2
    // 一旦进图，就和移动侧钉住的 3.23.0 集合混搭了。
    if(abs.startsWith(uiPrivate+path.sep)&&/(^|[/\\])(shiki|@shikijs)([/\\]|$)/.test(abs)){
      throw new Error(`Shiki依赖统一：packages/ui 私有副本混进移动模块图：${input}`);
    }
    if(!/shiki/i.test(input))continue;
    const owner=ownerOf(abs);
    if(!owner)continue;
    if(owner.name!=="shiki"&&!owner.name.startsWith("@shikijs/"))continue;
    if(!seen.has(owner.name))seen.set(owner.name,new Map());
    seen.get(owner.name).set(owner.version,(seen.get(owner.name).get(owner.version)??0)+1);
  }

  const problems=[];
  for(const [name,versions] of seen){
    if(versions.size>1)problems.push(`${name} 出现多个版本：${[...versions.keys()].join(" / ")}`);
    const rule=expected.get(name);
    for(const v of versions.keys()){
      if(rule?.exact&&v!==rule.exact)problems.push(`${name}@${v} 与期望 ${rule.exact} 不符`);
      if(rule?.major&&!v.startsWith(rule.major+"."))problems.push(`${name}@${v} 与期望 ^${rule.major}.x 不符`);
    }
  }
  if(problems.length)throw new Error(`Shiki依赖混搭：${problems.join("；")}`);

  const summary=[...seen].map(([name,versions])=>`${name}@${[...versions.keys()].join("/")}`).sort();
  return summary;
}

export function mobileDiffsWorker(zcodeRoot) {
  const ui=path.join(zcodeRoot,"packages/ui/src");
  return {entry:path.join(ui,"workers/diffs.worker.ts"),plugin:{name:"mobile-diffs-worker-url",setup(build){
    // 该包只把web-components列为sideEffects；Worker的消息监听器必须显式保留。
    build.onResolve({filter:/^@pierre\/diffs\/worker\/worker\.js$/},async args=>{
      if(args.pluginData?.mobileWorkerResolved)return;
      // 入口只在browser条件下公开，必须沿用esbuild的条件解析而非Node的require条件。
      const resolved=await build.resolve(args.path,{kind:args.kind,resolveDir:args.resolveDir,pluginData:{mobileWorkerResolved:true}});
      if(resolved.errors.length)return {errors:resolved.errors};
      return {path:resolved.path,namespace:resolved.namespace,sideEffects:true};
    });
    build.onLoad({filter:/[/\\]root[/\\]DiffsWorkerPoolProvider\.tsx$/},args=>{
      const source=readFileSync(args.path,"utf8");
      const before='new URL("../workers/diffs.worker.ts", import.meta.url)';
      if(!source.includes(before))throw new Error("桌面高亮Worker入口已变化，请更新移动构建适配");
      return {contents:source.replace(before,'new URL("./workers/diffs.worker.js", import.meta.url)'),
        loader:"tsx",resolveDir:path.dirname(args.path)};
    });
  }}};
}

// Vite CSS的/assets绝对路径在Android里指向错误的AssetLoader目录。
// 保留引用图的相对结构并复制所有本地依赖，不能只拷CSS或按文件名猜字体。
export async function relocateCssAssets({css,sourceCssFile,sourceRoot,outdir}) {
  const root=path.resolve(sourceRoot);
  const sourceRelative=path.relative(root,sourceCssFile).split(path.sep).join("/");
  const base=new URL(sourceRelative,"https://build.local/");
  const copied=new Set();
  const rewritten=css.replace(/url\(\s*(['"]?)([^'"\s)]+)\1\s*\)/g,(original,quote,href)=>{
    if (/^(?:data:|https?:|\/\/|#)/i.test(href))return original;
    const url=new URL(href,base);
    const relative=decodeURIComponent(url.pathname).replace(/^\/+/,"");
    const source=path.resolve(root,relative);
    if(!source.startsWith(root+path.sep))throw new Error(`CSS资源越过Web产物根：${href}`);
    copied.add(relative);
    return `url("./${relative.split(path.sep).join("/")}${url.search}${url.hash}")`;
  });
  for(const relative of copied){
    const target=path.join(outdir,relative);
    await mkdir(path.dirname(target),{recursive:true});
    await copyFile(path.join(root,relative),target);
  }
  return {css:rewritten,copied:[...copied]};
}
