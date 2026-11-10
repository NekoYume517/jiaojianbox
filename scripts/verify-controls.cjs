const assert=require('node:assert/strict');
const path=require('node:path');
module.exports=async(page,scratch)=>{
  await page.evaluate(()=>{
    const dialog=document.createElement('dialog');dialog.id='control-contract';
    dialog.innerHTML='<form style="padding:24px"><label>控件验收<select id="contract-choice"><option value="a">今天</option><option value="b">7 天</option><option value="c">30 天</option></select></label></form>';
    document.body.append(dialog);uiMotion.openDialog(dialog);formControls.sync();
  });
  const box=page.locator('[data-select-for=contract-choice]');
  await box.locator('button').nth(2).click();
  assert.equal(await page.locator('#contract-choice').inputValue(),'c');
  await page.waitForTimeout(320);
  assert(await box.evaluate(el=>{const a=el.querySelector('.active').getBoundingClientRect(),b=el.querySelector('.segment-highlight').getBoundingClientRect();return Math.abs(a.x-b.x)<.5&&Math.abs(a.width-b.width)<.5;}));
  await box.locator('button').nth(2).focus();await page.keyboard.press('Home');
  assert.equal(await page.locator('#contract-choice').inputValue(),'a');
  await page.evaluate(()=>{document.querySelector('#contract-choice').options[1].text='最近 7 天';formControls.sync();});
  assert.equal(await box.locator('.segment-highlight').count(),1);
  assert.equal(await box.locator('button').nth(1).innerText(),'最近 7 天');
  await page.keyboard.press('Escape');await page.locator('#control-contract').waitFor({state:'hidden'});
  await page.evaluate(()=>document.querySelector('#control-contract').remove());
  await page.locator('[data-nav=inbox]').click();
  await page.locator('[data-select-for=source-filter] button').nth(1).click();
  await page.waitForFunction(()=>document.querySelector('#source-filter')?.value==='qq'&&document.querySelector('[data-select-for=source-filter] .segment-highlight'));
  await page.waitForTimeout(320);
  assert(await page.locator('[data-select-for=source-filter]').evaluate(el=>{const a=el.querySelector('.active').getBoundingClientRect(),b=el.querySelector('.segment-highlight').getBoundingClientRect();return Math.abs(a.x-b.x)<.5&&Math.abs(a.width-b.width)<.5;}));
  assert(await page.evaluate(()=>!liveAnalysis.performance({performance:{elapsed_ms:1000}}).includes('undefined')));
  assert.equal(await page.evaluate(()=>liveAnalysis.performance({performance:{elapsed_ms:null,input_chars:null}})),'');
  await page.locator('[data-nav=settings]').click();
  const mocked=await page.evaluate(()=>{
    if(window.desktop)return false;
    window.desktop={quickGet:async()=>({}),launcherGet:async()=>({openAtLogin:false}),updateGet:async()=>({status:'idle',current:'test'}),updateSet:async()=>({}),launcherSet:async()=>({})};
    document.querySelector('#appearance-panel-marker')?.remove();experience.decorate('settings');pageNavigation.sync();return true;
  });
  try{
    await page.locator('.nav-sub [data-subnav=startup]').click();
    await page.evaluate(()=>updateUI({status:'downloading',received:10485760,total:104857600,bytesPerSecond:2097152,etaSeconds:45,progress:.1}));
    const progress=page.locator('[data-update-progress]');
    assert(await progress.isVisible());
    assert.equal(await progress.locator('[role=progressbar]').getAttribute('aria-valuenow'),'10');
    assert((await progress.innerText()).includes('10.0 MB / 100.0 MB'));
    const cancel=page.locator('[data-update-actions] button').first();await cancel.focus();
    await page.evaluate(()=>updateUI({received:20971520,total:104857600,bytesPerSecond:1048576,etaSeconds:80,progress:.2},true));
    assert(await cancel.evaluate(el=>el===document.activeElement),'progress ticks must preserve focused controls');
    assert.equal(await progress.locator('[role=progressbar]').getAttribute('aria-valuenow'),'20');
    await page.evaluate(()=>updateUI({received:25000000,total:-1,bytesPerSecond:1000000},true));
    assert.equal(await progress.locator('[role=progressbar]').getAttribute('aria-valuenow'),null);
    assert(!(await progress.locator('[data-update-percent]').innerText()).includes('%'));
    await page.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await progress.locator('[data-update-fill]').evaluate(el=>getComputedStyle(el).animationName),'none');
    await page.evaluate(()=>updateUI({status:'downloaded',path:'fixture.exe',latest:'test',received:104857600,total:104857600,progress:1}));
    assert.equal(await progress.locator('[data-update-percent]').innerText(),'100%');
    assert(await page.evaluate(()=>{const check=document.querySelector('[data-action-check-update]').getBoundingClientRect(),install=document.querySelector('[data-update-actions] .primary').getBoundingClientRect();return install.top-check.bottom>=11.5;}),'check and install actions need a clear gap');
    await page.screenshot({path:path.join(scratch,'update-progress.png')});
    await page.setViewportSize({width:390,height:844});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }finally{
    if(mocked)await page.evaluate(()=>{delete window.desktop;document.querySelector('#appearance-panel-marker')?.remove();experience.decorate('settings');pageNavigation.sync();});
    await page.emulateMedia({reducedMotion:'no-preference'});await page.setViewportSize({width:1280,height:860});
    await page.locator('[data-nav=tasks]').click();
  }
  console.log('Controls: uniform segments, real selection, dynamic options, shared highlight, keyboard, download bytes/speed, unknown size, stable focus and reduced motion passed.');
};
