const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const path=require('node:path'),fs=require('node:fs/promises'),net=require('node:net'),assert=require('node:assert/strict');
(async()=>{
  const root=path.resolve(__dirname,'..'),scratch=await fs.mkdtemp(path.join(root,'work/browser-experience-'));
  const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const base='http://127.0.0.1:'+port,server=spawn(process.env.JJB_VERIFY_SERVER||path.join(root,'work/JiaojianBox-UISmoke.exe'),['-data',scratch,'-listen','127.0.0.1:'+port],{windowsHide:true,stdio:'ignore',env:{...process.env,JJB_REQUIRE_EMAIL:'false',JJB_ALLOW_REGISTRATION:'true',JJB_ALLOW_PRIVATE_UPSTREAMS:'true'}});
  let browser;
  try{
    const deadline=Date.now()+15000;while(true){try{if((await fetch(base+'/health')).ok)break;}catch{}if(Date.now()>deadline)throw Error('Server did not start');await new Promise(resolve=>setTimeout(resolve,100));}
    const call=async(route,body)=>{const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert(response.ok);return response.json();};
    await call('/api/auth/register',{username:'ui_student',password:'strong-test-password'});
    browser=await chromium.launch({headless:true,executablePath:process.env.JJB_CHROMIUM||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    const page=await browser.newPage({viewport:{width:1280,height:860},colorScheme:'dark'}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));await page.goto(base);
    await page.locator('#username').fill('ui_student');await page.locator('#password').fill('strong-test-password');await page.locator('#auth-submit').click();await page.locator('#workspace').waitFor({state:'visible'});
    await page.evaluate(async()=>{await api('/api/tasks','POST',{title:'网页界面验收待办'});await refresh();await navigate('tasks');});
    await require('./verify-inbox-actions.cjs')(page);
    await require('./verify-productivity-layout.cjs')(page);
    await require('./verify-motion.cjs')(page,scratch);await require('./verify-auth-browser.cjs')(browser,base,scratch);
    await require('./verify-shares.cjs')(page,browser,base,scratch);
    await require('./verify-collection-studio.cjs')(page,browser,scratch);
    await require('./verify-trigger-history.cjs')(page,base);
    await require('./verify-agent-rendering.cjs')(page,base);
    await require('./verify-desktop-permission.cjs')(page,base);
    await require('./verify-trigger-live.cjs')(page,base);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({browserExperience:true,serverIsolated:true,pageErrors:errors.length,evidence:scratch}));
  }finally{await browser?.close();server.kill();}
})().catch(error=>{console.error(error);process.exitCode=1});
