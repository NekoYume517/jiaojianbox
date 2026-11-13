const {chromium}=require('playwright'),{spawn}=require('node:child_process');
const path=require('node:path'),fs=require('node:fs/promises'),net=require('node:net'),assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'..'),scratch=await fs.mkdtemp(path.join(root,'work/plugin-native-'));
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const env={...process.env,JJB_USER_DATA:path.join(scratch,'profile'),JJB_RUNTIME_ROOT:root,JJB_DEBUG_PORT:String(port)};
 const exe=process.env.JJB_VERIFY_APP||path.join(root,'work/JiaojianBox-Plugin-Check.exe');const child=spawn(exe,[],{cwd:root,windowsHide:true,env,stdio:['ignore','pipe','pipe']});let browser,output='';child.stderr.on('data',b=>output+=b);
 try{
  for(let i=0;i<100;i++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:1000});break}catch{}await new Promise(r=>setTimeout(r,200))}
  assert(browser,'desktop startup failed: '+output);const context=browser.contexts()[0],page=context.pages()[0]||await context.waitForEvent('page');page.on('console',m=>{if(m.text().includes('Plugin worker'))console.log(m.text())});page.on('pageerror',e=>console.log(e.message));
  await page.waitForFunction(()=>{const login=document.querySelector('#offline-login');const workspace=document.querySelector('#workspace');return [login,workspace].some(node=>node&&getComputedStyle(node).display!=='none'&&node.getBoundingClientRect().width>0)},{timeout:15000});
  if(await page.locator('#offline-login').isVisible())await page.locator('#offline-login').click();await page.locator('#workspace').waitFor({state:'visible'});
  await page.evaluate(()=>desktop.window('hide'));await page.waitForTimeout(200);
  const second=spawn(exe,['--silent'],{cwd:root,windowsHide:true,env,stdio:'ignore'});
  const exited=await Promise.race([new Promise(r=>second.once('exit',code=>r(code))),new Promise(r=>setTimeout(()=>r('timeout'),5000))]);assert.equal(exited,0);
  await page.waitForFunction(async()=>await wails.Window.IsFocused());assert.equal(await page.evaluate(()=>wails.Window.IsFocused()),true);
  const bundle=JSON.parse(await fs.readFile(path.join(root,'examples/plugins/task-agent/task-agent.jjb-plugin.json'),'utf8'));
  await page.evaluate(async ({bundle,command})=>{await desktop.pluginImport(bundle);await desktop.pluginSet('task-agent',{enabled:true,config:{command,args:['-e','process.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({summary:"native-tool-ok"})))']}});await pluginUI.sync(true)},{bundle,command:process.execPath});
  await page.evaluate(()=>api('/api/tasks','POST',{title:'本机插件工具验收'}));
  let summary;for(let i=0;i<60;i++){summary=await page.evaluate(async()=>{const runs=await desktop.pluginRuns('task-agent');return runs.findLast(run=>run.status==='done'&&run.result)?.result?.summary});if(summary==='native-tool-ok')break;await page.waitForTimeout(250)}if(summary!=='native-tool-ok')console.log('job diagnostics',await page.evaluate(()=>desktop.pluginRuns('task-agent')));assert.equal(summary,'native-tool-ok');
  await page.locator('[data-plugin-tab=task-agent]').click();await page.locator('#plugin-child').getByRole('heading',{name:'任务自动化',exact:true}).waitFor();await page.waitForFunction(()=>getComputedStyle(document.querySelector('#view')).opacity==='1');await page.screenshot({path:path.join(scratch,'plugin.png')});
  // A real user starts Uninstall.exe without the private --remove helper flag;
  // the separate native uninstaller regression covers that bootstrap path.
  await page.evaluate(()=>desktop.window('quit')).catch(()=>{});
  console.log(JSON.stringify({nativePluginCommand:true,taskRoundTrip:true,singleInstanceFocus:true,evidence:scratch}));
 }finally{child.kill();try{await Promise.race([browser?.close(),new Promise(r=>setTimeout(r,2000))])}catch{}}
})().catch(e=>{console.error(e);process.exitCode=1});
