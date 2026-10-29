import {readdirSync,readFileSync,statSync} from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
const dir=fileURLToPath(new URL("./dist-ui/",import.meta.url));
const files=[];
function walk(p){for(const name of readdirSync(p)){const f=path.join(p,name);statSync(f).isDirectory()?walk(f):files.push(f);}}walk(dir);
const hashes=new Map(),groups=new Map();let bytes=0;
for(const file of files){const data=readFileSync(file);bytes+=data.length;
 const key=createHash("sha256").update(data).digest("hex");const list=hashes.get(key)??[];list.push({file,bytes:data.length});hashes.set(key,list);
 const name=path.basename(file).replace(/-[A-Z0-9_-]{8}(?=\.[^.]+$)/,"");const group=groups.get(name)??[];group.push({file,bytes:data.length});groups.set(name,group);}
const duplicates=[...hashes.values()].filter(g=>g.length>1);
const css=readFileSync(path.join(dir,"zcode-ui.css"),"utf8");
const fontUrls=[...css.matchAll(/url\(["']?([^"')]*KaTeX[^"')]+)["']?\)/g)].map(m=>m[1]);
console.log(JSON.stringify({files:files.length,bytes,duplicateFiles:duplicates.reduce((n,g)=>n+g.length-1,0),
 redundantBytes:duplicates.reduce((n,g)=>n+(g.length-1)*g[0].bytes,0),
 groupedNames:[...groups.values()].filter(g=>g.length>1).length,
 fontUrls:fontUrls.length,fontsPresent:files.filter(f=>/KaTeX.*\.(woff2?|ttf)$/.test(f)).length},null,2));
