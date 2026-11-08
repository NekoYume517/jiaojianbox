const {chromium}=require('playwright'),{spawn}=require('node:child_process'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
(async()=>{
 if(!process.argv[2])throw Error('Specify the existing verification profile');
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const child=spawn(process.env.JJB_VERIFY_APP||path.join(process.env.LOCALAPPDATA,'Programs','交件箱','交件箱.exe'),[],{windowsHide:true,env:{...process.env,JJB_USER_DATA:path.resolve(process.argv[2]),JJB_DEBUG_PORT:String(port)},stdio:'ignore'});let browser;
 try{
  for(let n=0;n<70;n++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:1000});break}catch{await new Promise(r=>setTimeout(r,200));}}
  assert(browser);const context=browser.contexts()[0],page=context.pages()[0];await page.locator('#workspace').waitFor({state:'visible',timeout:15000});await page.waitForFunction(()=>state.snapshot.tasks.length===1);assert.equal(await page.evaluate(()=>state.snapshot.tasks[0].attachments.length),1);
  const invoke=(name,args=[])=>page.evaluate(([name,args])=>wails.Call.ByName('github.com/NekoYume517/jiaojianbox/internal/gui.Desktop.Invoke',name,args),[name,args]);await invoke('quickShow');const q=await invoke('quickInfo');assert.equal(q.x,130);assert.equal(q.y,150);
  console.log(JSON.stringify({installedBinary:true,restartKeepsOfflineData:true,quickPositionRestored:true}));await invoke('window',['quit']).catch(()=>{});
 }finally{await browser?.close().catch(()=>{});child.kill();}
})().catch(e=>{console.error(e);process.exitCode=1});
