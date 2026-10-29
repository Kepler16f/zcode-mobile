import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../../zcode/apps/zcode-cli/package.json',import.meta.url));
const esbuild = require('esbuild');
const { chromium } = require('playwright-core');
const {outputFiles} = await esbuild.build({entryPoints:[fileURLToPath(new URL('../ui/input-recovery.ts',import.meta.url))],bundle:true,format:'iife',globalName:'inputRecovery',write:false});
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
try {
  const page=await browser.newPage({viewport:{width:393,height:851}});
  await page.setContent('<button id="action" onclick="this.dataset.clicks=Number(this.dataset.clicks||0)+1">执行</button>');
  await page.addScriptTag({content:outputFiles[0].text});
  await page.evaluate(()=>inputRecovery.installInputRecovery());
  // 心跳仍跑但触摸完全失效的现场：没有任何弹层，body遗留了锁。
  await page.evaluate(()=>{document.body.style.pointerEvents='none';});
  await page.waitForFunction(()=>document.body.style.pointerEvents==='');
  await page.locator('#action').click({timeout:1000});
  assert.equal(await page.locator('#action').getAttribute('data-clicks'),'1');
  // 真正的审批框仍持有锁，绝不能绕过模态。
  await page.evaluate(()=>{
    const modal=document.createElement('div');modal.id='approval';modal.role='dialog';modal.textContent='等待审批';
    modal.style.cssText='position:fixed;inset:20px;pointer-events:auto';document.body.append(modal);
    document.body.style.pointerEvents='none';
  });
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(()=>document.body.style.pointerEvents),'none');
  await page.evaluate(()=>document.getElementById('approval').remove());
  await page.waitForFunction(()=>document.body.style.pointerEvents==='');
  // 关闭但尚未被动画卸载的菜单不应永久持有触摸锁。
  await page.evaluate(()=>{
    const menu=document.createElement('div');menu.role='menu';menu.dataset.state='closed';menu.textContent='closed';
    document.body.append(menu);document.body.style.pointerEvents='none';
  });
  await page.waitForFunction(()=>document.body.style.pointerEvents==='');
  await page.locator('#action').click({timeout:1000});
  assert.equal(await page.locator('#action').getAttribute('data-clicks'),'2');
  console.log('input-recovery-smoke: 4/4 PASS（遗留锁恢复、按钮可触摸、真实审批保留、关闭菜单释放）');
} finally {await browser.close();}
