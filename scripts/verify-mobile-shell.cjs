// Browser-side contract verification with an emulated native transport and real local API.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const server = process.env.JJB_MOBILE_TEST_SERVER || 'http://127.0.0.1:8776';
  const credentials = {username: 'mobile-' + Date.now(), password: 'FixtureMobile2026!'};
  let response = await fetch(server + '/api/auth/register', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials)});
  assert.equal(response.status,201);
  response = await fetch(server + '/api/auth/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials)});
  const session = {...await response.json(),server}; assert(session.token);
  const browser = await chromium.launch({headless:true,channel:'msedge'});
  const out=path.resolve('work/mobile-shell-browser');await fs.mkdir(out,{recursive:true});
  try {
    const page = await browser.newPage({viewport:{width:390,height:844}}), errors=[];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(session => {
      window.__JJB_ANDROID__ = true;
      window.__JJB_SESSION__ = session;
      window.nativeCalls=[];
      window.addEventListener('DOMContentLoaded',()=>{
        const channel=new MessageChannel();
        channel.port1.onmessage=event=>{
          try {
            const request=JSON.parse(event.data);
            nativeCalls.push({method:request.method,payload:request.payload});
            queueMicrotask(()=>mobile._complete(request.id,true,null));
          } catch {}
        };
        channel.port1.start();
        window.postMessage('jjb-bridge',location.origin,[channel.port2]);
      });
    },session);
    for(const name of ['mobile.js','navigation.js','motion.js','workspace.css']){
      await page.route(`**/${name}*`,route=>route.fulfill({
        contentType:name.endsWith('.css')?'text/css':'application/javascript',
        path:path.resolve('web',name),
      }));
    }
    await page.goto(server);await page.locator('#workspace').waitFor();
    await page.locator('[data-onboard="skip"]').click().catch(()=>{});
    assert(await page.evaluate(()=>!!mobile&&state.session.username.startsWith('mobile-')));
    await page.waitForFunction(()=>document.querySelector('[data-nav="sources"]').hidden);
    const mobileNav=page.locator('.sidebar nav [data-nav="settings"]');
    await mobileNav.waitFor();
    assert.equal((await mobileNav.innerText()).trim(),'我的');
    assert.equal(await mobileNav.locator('[data-icon]').getAttribute('data-icon'),'user');
    assert(await mobileNav.isVisible());
    await mobileNav.click();
    await page.locator('#account-panel').waitFor();
    await page.emulateMedia({colorScheme:'dark'});
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    for (const width of [320, 360, 390, 412]) {
      await page.setViewportSize({width, height:480});
      await page.evaluate(() => cmdkShow());
      await page.locator('#cmdk-input').waitFor({state:'visible'});
      const geometry = await page.evaluate(() => {
        const box = element => { const rect=element.getBoundingClientRect(); return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,bottom:rect.bottom}; };
        const palette=document.querySelector('.cmdk'), topbar=document.querySelector('.topbar'), nav=document.querySelector('.sidebar');
        const input=document.querySelector('#cmdk-input'), list=document.querySelector('#cmdk-list');
        return {
          palette:box(palette),topbar:box(topbar),nav:box(nav),input:box(input),
          list:{...box(list),scrollHeight:list.scrollHeight,clientHeight:list.clientHeight},
          viewport:{width:innerWidth,height:innerHeight},scrollWidth:document.documentElement.scrollWidth,
        };
      });
      assert(geometry.scrollWidth <= geometry.viewport.width, `command palette overflows horizontally at ${width}px`);
      assert(geometry.palette.x >= 0 && geometry.palette.x + geometry.palette.width <= geometry.viewport.width, `command palette exceeds the ${width}px viewport`);
      assert(geometry.palette.y >= geometry.topbar.bottom + 4, `command palette overlaps the top bar at ${width}px: ${JSON.stringify(geometry)}`);
      assert(geometry.palette.bottom <= geometry.nav.y - 4, `command palette overlaps bottom navigation at ${width}px: ${JSON.stringify(geometry)}`);
      assert(geometry.input.height > 0 && geometry.input.y >= geometry.palette.y, `command search is hidden at ${width}px`);
      assert(geometry.list.clientHeight > 0 && geometry.list.scrollHeight > geometry.list.clientHeight, `command results do not scroll internally at ${width}px`);
      assert(Math.abs(geometry.list.y - (geometry.input.y + geometry.input.height)) < 1, `command search is not fixed above results at ${width}px`);
      if (width === 390) await page.screenshot({path:path.join(out,'command-palette.png')});
      await page.evaluate(() => cmdkHide());
    }
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>state.page='inbox');
    await page.evaluate(()=>render());
    await page.locator('#view [data-action="new-task"]').filter({visible:true}).first().click();
    const taskDialog=page.locator('#task-dialog');
    await taskDialog.waitFor({state:'visible'});
    const dialogBox=await taskDialog.boundingBox();
    assert(dialogBox.height>300,`Android dialog height unexpectedly ${dialogBox.height}`);
    assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--jjb-viewport-height').trim()), '844px');
    assert(await page.locator('#task-title').isVisible());
    assert.equal(await taskDialog.evaluate(el=>getComputedStyle(el).clipPath),'none');
    await page.screenshot({path:path.join(out,'task-dialog.png')});
    await page.locator('#task-dialog [data-action="close-task"]').first().click();
    await taskDialog.waitFor({state:'hidden'});
    await page.locator('[data-nav="files"]').click();
    await page.locator('#shelf-file-input').setInputFiles({name:'手机连接验收.txt',mimeType:'text/plain',buffer:Buffer.from('mobile shell upload fixture')});
    await page.waitForFunction(()=>state.snapshot.shelf?.some(f=>f.name==='手机连接验收.txt'));
    const id=await page.evaluate(async()=>{const task=await api('/api/tasks','POST',{title:'连接器待办',due_at:new Date(Date.now()+86400000).toISOString()});await refresh();return task.id;});
    await page.evaluate(async id=>{await navigate('tasks');state.taskId=id;render();},id);
    await page.locator('[data-mobile-calendar]').click();
    assert(await page.evaluate(id=>nativeCalls.some(c=>c.method==='calendarTask'&&c.payload.taskId===id),id));
    await page.evaluate(()=>saveDownload('/api/workspace/export','手机工作区.zip'));
    assert(await page.evaluate(()=>nativeCalls.some(c=>c.method==='download'&&c.payload.route==='/api/workspace/export')));
    await page.locator('#quick-actions').click();await page.locator('[data-mobile-connectors]').click();
    assert(await page.evaluate(()=>nativeCalls.some(c=>c.method==='connectors')));
    await page.screenshot({path:path.join(out,'workspace.png')});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({nativeTransport:'message-port mock',api:'local real server',nativeSessionToWeb:true,fileUpload:true,exportBridge:true,calendarTaskBridge:true,connectorsMenu:true,mobileNavigation:true,dialogLayout:true,pageErrors:errors.length,out}));
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
