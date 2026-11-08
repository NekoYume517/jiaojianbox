const {_electron,chromium}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const http=require('node:http');
(async()=>{
 const root=path.resolve(__dirname,'..'),scratch=await fs.mkdtemp(path.join(root,'work','release-smoke-'));
 const version=require('../package.json').version;
 const executablePath=process.env.JJB_VERIFY_APP||path.join(root,'artifacts-'+version,'win-unpacked','交件箱.exe');
 const env={...process.env,JJB_USER_DATA:path.join(scratch,'profile'),JJB_TEST_OFFSCREEN:'1'};delete env.ELECTRON_RUN_AS_NODE;
 let client,fixture,finishAnalysis;
 async function launch(){
  client=await _electron.launch({executablePath,env});
  await client.evaluate(({shell})=>{global.__opened=[];shell.openExternal=async url=>{global.__opened.push(url);};});
  const page=await client.firstWindow();await page.locator('#auth').waitFor({state:'visible',timeout:45000});return page;
 }
 try{
  let page=await launch();
  assert.equal(await page.locator('#server-url').inputValue(),'https://jiaojianbox.bansonic.top');
  assert.equal(await page.locator('#server-url').isVisible(),false);
  const json=data=>({status:200,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify(data)});
  await page.route('**/api/auth/device/start',r=>r.fulfill(json({device_code:'fixture-code',user_code:'ABCD-EFGH',expires_in:120,verification_path:'/authorize?code=ABCDEFGH'})));
  await page.route('**/api/auth/device/poll',r=>r.fulfill(json({status:'pending'})));
  await page.locator('#auth-submit').click();await page.locator('#device-status').waitFor({state:'visible'});
  assert((await client.evaluate(()=>global.__opened)).at(-1).startsWith('https://jiaojianbox.bansonic.top/authorize'));
  await page.locator('[data-experience="cancel-auth"]').click();
  await page.locator('#other-server').click();await page.locator('#server-url').fill('https://self.example.test');
  await page.locator('#auth-submit').click();await page.locator('#device-status').waitFor({state:'visible'});
  assert((await client.evaluate(()=>global.__opened)).at(-1).startsWith('https://self.example.test/authorize'));
  await page.locator('[data-experience="cancel-auth"]').click();
  await page.locator('#other-server').click();
  await page.screenshot({path:path.join(scratch,'login.png')});
  await page.locator('#offline-login').click();await page.locator('#workspace').waitFor({state:'visible',timeout:45000});
  assert.equal(await page.evaluate(()=>state.session.mode),'offline');
  // 真实安装包内的 local-server 启动后台队列，受控模型响应验证即时状态与容错。
  fixture=http.createServer((req,res)=>{
    req.resume();req.on('end',()=>{finishAnalysis=()=>{if(res.writableEnded)return;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({result:{classification:'CHAT',confidence:'95%',reason:'测试聊天'}})}}]}));};});
  });
  await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
  await page.evaluate(async port=>{
    await api('/api/settings/llm','PUT',{base_url:'http://127.0.0.1:'+port+'/v1',model:'fixture',auto_analyze:true});
    const message=await api('/api/messages','POST',{source:'manual',account_id:'fixture',conversation_id:'fixture',external_id:'fixture',text:'打包版自动分析验收',sent_at:new Date().toISOString()});
    if(!message.analysis_pending)throw Error('新消息没有立即排队');
    state.snapshot=(await api('/api/snapshot'));state.selected=message.id;render();
  },fixture.address().port);
  await page.locator('.analysis-top .tag').filter({hasText:'分析中'}).waitFor();
  assert.equal(await page.locator('[data-action="analyze"]').isDisabled(),true);
  await page.waitForFunction(()=>state.snapshot.messages[0]?.analysis_state==='running');
  assert(finishAnalysis,'模型请求未发出');finishAnalysis();
  await page.waitForFunction(()=>state.snapshot.messages.some(m=>m.analysis?.classification==='chatting'));
  assert.equal(await page.locator('[data-action="analyze"]').isDisabled(),false);
  assert.equal(await page.evaluate(()=>state.snapshot.messages[0].analysis.confidence),.95);
  await page.evaluate(()=>api('/api/settings/llm','PUT',{auto_analyze:false}));
  const local=await page.evaluate(()=>({server:state.session.server}));
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const web=await browser.newPage({viewport:{width:390,height:844}});
    await web.goto(local.server);await web.locator('#auth').waitFor({state:'visible'});
    assert.equal(await web.locator('#server-url').isVisible(),false);
    assert.equal(await web.locator('#other-server').isVisible(),false);
    await web.locator('#forgot-password').click();await web.locator('dialog[open]').waitFor();
    await web.locator('dialog[open] [value="cancel"]').click();
    assert.equal(await web.locator('dialog[open]').count(),0);
    await web.screenshot({path:path.join(scratch,'web-login-mobile.png')});
  } finally {await browser.close();}
  await page.evaluate(()=>api('/api/tasks','POST',{title:'安装包离线验收任务',description:'仅存本机'}));
  await page.locator('[data-nav="settings"]').click();await page.locator('#account-panel').waitFor();
  await page.screenshot({path:path.join(scratch,'offline-settings.png')});
  const saved=await page.evaluate(()=>state.session.user_id);await client.close();
  client=await _electron.launch({executablePath,env});page=await client.firstWindow();await page.locator('#workspace').waitFor({state:'visible',timeout:45000});
  assert.equal(await page.evaluate(()=>state.session.user_id),saved);
  assert((await page.evaluate(()=>api('/api/snapshot'))).tasks.some(t=>t.title==='安装包离线验收任务'));
  console.log(JSON.stringify({packagedDesktop:true,defaultAddressHidden:true,customBrowserAuthorization:true,offlinePersists:true,automaticAnalysisStatus:true,lenientModelOutput:true,screenshots:scratch}));
 }finally{finishAnalysis?.();fixture?.closeAllConnections();fixture?.close();await client?.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
