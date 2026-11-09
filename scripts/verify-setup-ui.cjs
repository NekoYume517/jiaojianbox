const {chromium}=require('playwright');
const path=require('node:path'),fs=require('node:fs/promises'),assert=require('node:assert/strict'),http=require('node:http');
const root=path.resolve(__dirname,'..'),ui=path.join(root,'internal/setup/ui');
let browser,server;
(async()=>{
  const [html,icon,source]=await Promise.all([fs.readFile(path.join(ui,'index.html')),fs.readFile(path.join(ui,'icon.png')),fs.readFile(path.join(ui,'setup.js'),'utf8')]);
  browser=await chromium.launch({headless:true,executablePath:process.env.JJB_CHROMIUM||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  server=http.createServer((req,res)=>{res.writeHead(404);res.end()});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`,errors=[];
  let page;
  const open=async mode=>{
    await page?.close();page=await browser.newPage({viewport:{width:700,height:580},colorScheme:'dark'});
    page.on('pageerror',e=>errors.push(e.message));
    const runtime=`
      const state=globalThis.__setup={mode:${JSON.stringify(mode)},calls:[],pending:null};
      export const Call={ByName:async(name,...args)=>{
        const method=name.split('.').pop();state.calls.push(method);
        if(method==='Info')return {version:'0.6.4',directory:'C:/Install/jiaojianbox',installedVersion:'0.6.3',update:state.mode==='update',uninstall:state.mode==='uninstall',desktop:true,startMenu:true};
        if(method==='ChooseDirectory')return 'C:/filled/jiaojianbox';
        if(method==='ResolveDirectory'){
          if(args[0].endsWith('blocked'))throw Error('目录不可用');
          return {directory:args[0].replace(/filled$/, 'filled/jiaojianbox')};
        }
        if(method==='Install'||method==='Uninstall'){
          state.progress?.({data:{percent:35,message:'正在处理程序文件'}});
          return new Promise((resolve,reject)=>{state.pending={resolve,reject}});
        }
        if(method==='Finish')state.launch=args[0];
      }};
      export const Events={On:(name,callback)=>{state.progress=callback}};
    `;
    await page.route('**/setup/index.html',r=>r.fulfill({contentType:'text/html',body:html}));
    await page.route('**/wails/runtime.js',r=>r.fulfill({contentType:'text/javascript',body:runtime}));
    await page.route('**/setup/setup.js',r=>r.fulfill({contentType:'text/javascript',body:source}));
    await page.route('**/setup/icon.png',r=>r.fulfill({contentType:'image/png',body:icon}));
    await page.goto(base+'/setup/index.html');await page.waitForFunction(()=>globalThis.__setup?.calls.includes('Info'));
  };
  const advance=()=>page.locator('#install').click();
  const active=()=>page.locator('.stepper [aria-current=step] .step-label').textContent();
  const pending=()=>page.waitForFunction(()=>!!globalThis.__setup.pending);
  const finish=async()=>{await page.evaluate(()=>__setup.pending.resolve({directory:'C:/Install/jiaojianbox'}));await page.locator('#complete-view').waitFor({state:'visible'});};
  await open('install');
  assert.equal(await active(),'欢迎');assert.equal(await page.locator('.stepper button,.stepper [tabindex]').count(),0);
  await page.locator('.step-label').last().click();assert.equal(await active(),'欢迎');
  await advance();await page.locator('#options-view').waitFor({state:'visible'});assert.equal(await active(),'安装位置');
  await page.locator('#directory').fill('C:/filled');await page.locator('#choose').click();
  assert.equal(await page.locator('#directory').inputValue(),'C:/filled/jiaojianbox');
  for(let i=0;i<3;i++){await page.locator('#previous').click();await advance();}
  await page.locator('#options-view').waitFor({state:'visible'});
  assert.equal(await page.locator('#directory').inputValue(),'C:/filled/jiaojianbox');
  await page.screenshot({path:path.join(root,'work/setup-install-dark.png')});
  await advance();await pending();assert.equal(await active(),'安装');assert(await page.locator('#close').isDisabled());assert(await page.locator('#previous').isHidden());
  await page.evaluate(()=>__setup.pending.reject(Error('请退出交件箱后重试')));
  await page.locator('#options-view').waitFor({state:'visible'});assert((await page.locator('#error').textContent()).includes('退出'));
  await advance();await pending();await page.emulateMedia({reducedMotion:'reduce'});
  await page.waitForFunction(()=>document.querySelector('#status-view').getAnimations().every(a=>a.playState!=='running'));
  await finish();assert.equal(await active(),'完成');
  assert(await page.locator('#launch-app').isChecked());assert.equal(await page.locator('#install').textContent(),'完成');
  await advance();assert.equal(await page.evaluate(()=>__setup.launch),true);
  await open('update');await page.locator('#options-view').waitFor({state:'visible'});
  assert.equal(await page.locator('#install').textContent(),'确认更新');
  assert.equal(await page.locator('#version-badge').textContent(),'0.6.3 → 0.6.4');
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(()=>__setup.calls.includes('Install')),false,'opening an update must never start installation');
  await page.locator('#previous').click();await advance();
  assert.equal(await page.evaluate(()=>__setup.calls.includes('Install')),false,'step navigation must not start an update');
  await page.screenshot({path:path.join(root,'work/setup-update-confirm.png')});
  await advance();await pending();assert.equal(await active(),'安装');
  assert.equal(await page.evaluate(()=>__setup.calls.filter(x=>x==='Install').length),1);
  await finish();await page.screenshot({path:path.join(root,'work/setup-update-dark.png')});
  await page.locator('#launch-app').uncheck();await advance();assert.equal(await page.evaluate(()=>__setup.launch),false);
  await open('uninstall');assert.equal(await page.evaluate(()=>__setup.calls.includes('Uninstall')),false);
  await advance();await page.locator('#options-view').waitFor({state:'visible'});assert(await page.locator('#directory').evaluate(e=>e.readOnly));assert(await page.locator('#choose').isHidden());
  await advance();await pending();assert.equal(await active(),'卸载');await finish();
  assert.equal(await page.locator('#complete-heading').textContent(),'交件箱已卸载');
  assert(await page.locator('#launch-option').isHidden());
  await page.waitForFunction(()=>{const a=document.querySelector('.stepper [aria-current=step]').getBoundingClientRect(),b=document.querySelector('.step-highlight').getBoundingClientRect();return Math.abs(a.left-b.left)<.5});
  await page.screenshot({path:path.join(root,'work/uninstall-complete-dark.png')});
  await page.emulateMedia({colorScheme:'light'});await page.screenshot({path:path.join(root,'work/uninstall-complete-light.png')});
  await advance();assert.equal(await page.evaluate(()=>__setup.launch),false);
  assert.deepEqual(errors,[]);
  console.log('Setup UI: readonly steps, back/next interruption, path, explicit update confirmation, retry, uninstall, reduced motion and light/dark passed.');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await browser?.close();server?.close()});
