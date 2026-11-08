const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const http=require('node:http');
const fs=require('node:fs/promises'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'..'),scratch=await fs.mkdtemp(path.join(root,'work','native-smoke-'));
 const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
 const child=spawn(process.env.JJB_VERIFY_APP||path.join(root,'work','JiaojianBox-Go.exe'),[],{cwd:root,windowsHide:true,env:{...process.env,JJB_USER_DATA:path.join(scratch,'profile'),JJB_DEBUG_PORT:String(port),...(process.env.JJB_VERIFY_APP?{}:{JJB_RUNTIME_ROOT:root}),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port},stdio:['ignore','pipe','pipe']});
 let analysisRequests=0;
 const model=http.createServer((req,res)=>{analysisRequests++;req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({category:'reference',task_id:null,confidence:.9,reason:'参考资料'})}}],usage:{total_tokens:25}}));});});
 await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
 const dropFile=path.join(scratch,'验收材料.txt');await fs.writeFile(dropFile,'用于验证指定待办拖入和空白区域归类。');
 let browser,output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 try{
  const deadline=Date.now()+40000;while(Date.now()<deadline){try{browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:2000});break;}catch{await new Promise(r=>setTimeout(r,500));}}
  if(!browser)throw Error('WebView2 CDP未启动：'+output.slice(-1500));
  const context=browser.contexts()[0];let page=context.pages()[0];if(!page){page=await context.waitForEvent('page');}console.log('WebView initial URL:',page.url());
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{await page.locator('#auth').waitFor({state:'visible',timeout:30000});}catch(e){console.log('Native diagnostics:',await page.evaluate(()=>({url:location.href,wailsKeys:Object.keys(window.wails||{}),internal:Object.keys(window._wails||{}),toast:document.querySelector('#toast')?.textContent,state:typeof state,body:document.body.innerText.slice(0,600)})));console.log('Page errors:',errors);console.log('Native output:',output.slice(-3000));throw e;}
  assert.equal(await page.locator('#server-url').isVisible(),false);
  await page.evaluate(()=>appearance.update({theme:'dark',palette:'tokyo-night'}));await page.screenshot({path:path.join(scratch,'login-dark.png')});
  await page.locator('#offline-login').click();await page.locator('#workspace').waitFor({state:'visible',timeout:30000});
  assert.equal(await page.evaluate(()=>state.session.mode),'offline');
  await page.evaluate(async()=>{await api('/api/tasks','POST',{title:'Go 原生版验收待办',description:'通知、材料和提交记录集中管理。'});await refresh();});
  await page.evaluate(async url=>api('/api/settings/llm','PUT',{base_url:url,model:'fixture'}),'http://127.0.0.1:'+model.address().port);
  await page.locator('[data-nav="tasks"]').click();await page.screenshot({path:path.join(scratch,'tasks-dark.png')});
  const target=await page.locator('.task-card[data-task]').first().boundingBox();
  console.log('Drop target:',await page.evaluate(([x,y])=>({flags:_wails.flags,target:document.elementFromPoint(x,y)?.closest('[data-file-drop-target]')?.outerHTML.slice(0,350)}),[target.x+50,target.y+70]));
  await page.evaluate(([file,x,y])=>_wails.handlePlatformFileDrop([file],Math.round(x),Math.round(y)),[dropFile,target.x+50,target.y+70]);
  try{await page.waitForFunction(()=>state.snapshot.tasks.some(t=>t.attachments?.length===1));}catch(e){console.log('Drop diagnostic:',await page.evaluate(()=>({toast:document.querySelector('#toast')?.textContent,snapshot:state.snapshot})));console.log('Wails output:',output.slice(-2500));throw e;}assert.equal(analysisRequests,0);
  assert.equal((await page.evaluate(()=>wails.Call.ByName('github.com/NekoYume517/jiaojianbox/internal/gui.Desktop.Invoke','quickInfo',[]))).visible,false);
  await page.locator('[data-nav="files"]').click();await page.locator('#files-page-list').waitFor();
  await page.evaluate(file=>_wails.handlePlatformFileDrop([file],500,180),dropFile);
  await page.waitForFunction(()=>state.snapshot.shelf?.some(f=>f.suggestion?.category==='reference'));assert.equal(analysisRequests,1);
  await page.locator('[data-nav="settings"]').click();await page.locator('#appearance-palette').waitFor();
  await page.locator('#appearance-palette').selectOption('nord');assert.equal(await page.evaluate(()=>appearance.get().palette),'nord');
  await page.evaluate(()=>appearance.update({theme:'light'}));await page.screenshot({path:path.join(scratch,'settings-light.png')});
  assert.equal(await page.locator('[data-theme-mode="light"]').first().getAttribute('aria-pressed'),'true');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(scratch,'phone-light.png')});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.setViewportSize({width:1280,height:860});
  await page.evaluate(()=>appearance.update({theme:'dark',palette:'tokyo-night'}));
  const quickCall=(method,args=[])=>page.evaluate(([method,args])=>wails.Call.ByName('github.com/NekoYume517/jiaojianbox/internal/gui.Desktop.Invoke',method,args),[method,args]);
  await quickCall('quickShow');await new Promise(r=>setTimeout(r,800));
  const info=await quickCall('quickInfo');assert.equal(info.width,360);assert.equal(info.height,460);assert(info.visible);
  const quick=context.pages().find(p=>p.url().includes('quick.html'));assert(quick);
  await quick.locator('#quick-text').fill('原生快捷收集验收记录');await quick.locator('button[value="note"]').click();await quick.screenshot({path:path.join(scratch,'quick.png')});
  await quick.evaluate(file=>_wails.handlePlatformFileDrop([file],100,90),dropFile);
  await page.waitForFunction(()=>state.snapshot.shelf?.filter(f=>f.task_id==null).length>=2);await quickCall('window',['show']);
  for(let i=0;i<8;i++){const current=await quickCall('quickInfo');assert.equal(current.width,360);assert.equal(current.height,460);assert(current.visible&&current.pinned);await new Promise(r=>setTimeout(r,100));}
  await quick.evaluate(()=>wails.Window.SetPosition(130,150));await new Promise(r=>setTimeout(r,350));const moved=await quickCall('quickInfo');assert.equal(moved.x,130);assert.equal(moved.y,150);
  await quickCall('quickHide');assert.equal((await quickCall('quickInfo')).visible,false);
  await page.locator('[data-nav="inbox"]').click();await page.waitForFunction(()=>state.snapshot.messages.length>0);
  await page.locator('#logout').click();await page.locator('#auth').waitFor({state:'visible'});await page.locator('#offline-login').click();await page.locator('#workspace').waitFor({state:'visible'});assert.equal(await page.evaluate(()=>state.snapshot.tasks.length),1);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({nativeWails:true,goOfflineCore:true,filesPage:true,palettes:true,narrowLayout:true,targetedDropBypassesAI:true,blankDropUsesAI:true,quickPinned:true,quickFixedSize:true,quickPosition:true,quickNote:true,offlineRelogin:true,screenshots:scratch}));
 }finally{
  if(browser){try{await browser.contexts()[0].pages()[0]?.evaluate(()=>desktop.window('quit'));}catch{}await browser.close().catch(()=>{});}
  child.kill();
  await new Promise(resolve=>model.close(resolve));
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
