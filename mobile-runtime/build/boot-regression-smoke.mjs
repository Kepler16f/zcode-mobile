import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {startChatdev} from './chatdev.mjs';
const require=createRequire(new URL('../../zcode/apps/zcode-cli/package.json',import.meta.url));
const {chromium}=require('playwright-core');
const host=await startChatdev(8998);
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
try {
 const page=await browser.newPage({viewport:{width:393,height:851}});
 await page.goto('http://127.0.0.1:8998/',{timeout:60000});
 await page.waitForFunction(()=>!!globalThis.__zcodeMobileMeta,{timeout:60000});
 const meta=await page.evaluate(()=>({stubbed:globalThis.__zcodeMobileMeta.stubbed,degraded:globalThis.__zcodeMobileMeta.degraded}));
 assert.ok(!meta.stubbed.includes('codingPlanSubscriptionService'));
 assert.ok(meta.stubbed.includes('credentialService'));
 console.log('PASS 无凭据桥时公开套餐服务不会被占位替换');
 await page.waitForFunction(()=>!document.getElementById('booting'));
 console.log('PASS 正常启动撤下动画');
 const bad=await browser.newPage();
 await bad.route('**/production', route=>route.fulfill({contentType:'text/html',body:readFileSync(new URL('./dist-ui/ui.html',import.meta.url),'utf8')}));
 await bad.addInitScript(()=>{const get=Storage.prototype.getItem;Storage.prototype.getItem=function(key){if(key==='zcode:device-fingerprint')throw new Error('storage blocked fixture');return get.call(this,key);};});
 await bad.goto('http://127.0.0.1:8998/production',{timeout:60000});
 await bad.waitForFunction(()=>!document.getElementById('booting'));
 assert.ok((await bad.locator('body').innerText()).includes('启动失败'));
 console.log('PASS 早期启动异常显示失败页并移除遮罩');
} finally {await browser.close();await host.close();}
