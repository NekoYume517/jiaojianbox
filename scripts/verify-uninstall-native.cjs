const {chromium}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');const assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'..'),scratch=await fs.mkdtemp(path.join(root,'work/uninstall-native-'));
 const target=path.join(scratch,'app');await fs.mkdir(target);
 await fs.writeFile(path.join(target,'owned.txt'),'program');await fs.writeFile(path.join(target,'local-data.txt'),'preserve');
 await fs.writeFile(path.join(target,'.jiaojianbox-install.json'),JSON.stringify({version:'test',files:{'owned.txt':'test','Uninstall.exe':'test'}}));
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const exe=path.join(root,'artifacts/installer-refresh/app/Uninstall.exe');
 await fs.copyFile(exe,path.join(target,'Uninstall.exe'));
 const child=spawn(path.join(target,'Uninstall.exe'),[],{windowsHide:true,env:{...process.env,JJB_DEBUG_PORT:String(port)},stdio:'ignore'});
 let browser;
 try{
  const deadline=Date.now()+20000;let endpoint;
  while(Date.now()<deadline){try{const r=await fetch(`http://127.0.0.1:${port}/json/version`);endpoint=(await r.json()).webSocketDebuggerUrl;if(endpoint)break}catch{}await new Promise(r=>setTimeout(r,150));}
  assert(endpoint,'native webview did not start');browser=await chromium.connectOverCDP(endpoint);
  const context=browser.contexts()[0],page=context.pages()[0]||await context.waitForEvent('page');
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.locator('#welcome-heading').filter({hasText:'卸载交件箱'}).waitFor();
  await page.locator('#install').click();await page.locator('#options-view').waitFor({state:'visible'});
  await page.screenshot({path:path.join(scratch,'confirm.png')});
  assert.equal(await page.locator('#directory').inputValue(),target);
  await page.locator('#install').click();await page.locator('#complete-view').waitFor({state:'visible'});
  assert.equal(await fs.readFile(path.join(target,'local-data.txt'),'utf8'),'preserve');
  await assert.rejects(fs.stat(path.join(target,'owned.txt')));
  await page.waitForFunction(()=>document.querySelector('#complete-view').getAnimations().every(a=>a.playState!=='running'));
  await page.screenshot({path:path.join(scratch,'complete.png')});assert.deepEqual(errors,[]);
  await page.locator('#install').click();
  console.log(JSON.stringify({nativeUninstallUI:true,dataPreserved:true,pageErrors:errors.length,evidence:scratch}));
 }finally{try{await browser?.close()}catch{}child.kill();}
})().catch(e=>{console.error(e);process.exitCode=1});
