const {chromium}=require('playwright'),{spawn}=require('node:child_process'),fs=require('node:fs/promises'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'..'),version=require('../package.json').version,scratch=await fs.mkdtemp(path.join(root,'work','setup-ui-'));
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const child=spawn(path.join(root,'artifacts-'+version,`JiaojianBox-Setup-${version}-x64.exe`),[],{env:{...process.env,JJB_DEBUG_PORT:String(port)},windowsHide:true,stdio:['ignore','pipe','pipe']});let logs='',browser;child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
 try{
  for(let i=0;i<80;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:1000});break;}catch{await new Promise(r=>setTimeout(r,300));}}
  if(!browser)throw Error('安装界面未启动：'+logs.slice(-1200));
  const context=browser.contexts()[0],page=context.pages()[0]||await context.waitForEvent('page');const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>document.getElementById('directory')?.value.length>2);const directory=await page.locator('#directory').inputValue();
  await page.screenshot({path:path.join(scratch,'installer.png')});await page.locator('#install').click();await page.waitForFunction(()=>document.getElementById('heading')?.textContent==='交件箱已安装',{},{timeout:120000});
  assert.equal(await page.locator('#error').textContent(),'');assert.deepEqual(errors,[]);const manifest=JSON.parse(await fs.readFile(path.join(directory,'.jiaojianbox-install.json'),'utf8'));assert.equal(manifest.version,version);assert(manifest.desktop&&manifest.startMenu);
  await page.screenshot({path:path.join(scratch,'installed.png')});console.log(JSON.stringify({customInstallerUI:true,installed:true,directory,version,screenshots:scratch}));await page.locator('#close').click();
 }catch(e){console.log(logs.slice(-2000));throw e;}finally{if(browser)await browser.close().catch(()=>{});child.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
