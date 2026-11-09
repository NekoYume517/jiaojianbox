const {chromium}=require('playwright');
const path=require('node:path'),fs=require('node:fs/promises'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
(async()=>{
 const root=path.resolve(__dirname,'..'),socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const child=spawn(path.join(root,'artifacts/installer-refresh/JiaojianBox-Setup-0.6.4-x64.exe'),[],{windowsHide:true,env:{...process.env,JJB_DEBUG_PORT:String(port)},stdio:'ignore'});
 let browser;
 try{
  let endpoint;const deadline=Date.now()+30000;
  while(Date.now()<deadline){try{const r=await fetch(`http://127.0.0.1:${port}/json/version`);endpoint=(await r.json()).webSocketDebuggerUrl;if(endpoint)break}catch{}await new Promise(r=>setTimeout(r,150));}
  assert(endpoint);browser=await chromium.connectOverCDP(endpoint);const context=browser.contexts()[0],page=context.pages()[0]||await context.waitForEvent('page');
  await page.locator('#install:not(:disabled)').waitFor();
  assert.equal(await page.locator('#install').textContent(),'确认更新');
  assert(await page.locator('#options-view').isVisible());
  const directory=await page.locator('#directory').inputValue(),marker=path.join(directory,'.jiaojianbox-install.json');
  const before=await fs.readFile(marker),beforeStat=await fs.stat(marker);
  await page.waitForTimeout(1500);
  assert(await page.locator('#status-view').isHidden());assert.equal(await page.locator('#state-chip').textContent(),'准备更新');
  assert.deepEqual(await fs.readFile(marker),before);assert.equal((await fs.stat(marker)).mtimeMs,beforeStat.mtimeMs);
  await page.screenshot({path:path.join(root,'work/update-confirm-native.png')});await page.locator('#close').click();
  console.log(JSON.stringify({nativeUpdateConfirmation:true,installationUnchanged:true,cancelled:true}));
 }finally{try{await browser?.close()}catch{}child.kill();}
})().catch(e=>{console.error(e);process.exitCode=1});
