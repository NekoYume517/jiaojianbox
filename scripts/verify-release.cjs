const {_electron,chromium}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'..'),scratch=await fs.mkdtemp(path.join(root,'work','release-smoke-'));
 const executablePath=path.join(root,'artifacts-0.5.0','JiaojianBox-win32-x64','JiaojianBox.exe');
 const env={...process.env,JJB_USER_DATA:path.join(scratch,'profile'),JJB_TEST_OFFSCREEN:'1'};delete env.ELECTRON_RUN_AS_NODE;
 let client;
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
  console.log(JSON.stringify({packagedDesktop:true,defaultAddressHidden:true,customBrowserAuthorization:true,offlinePersists:true,screenshots:scratch}));
 }finally{await client?.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
