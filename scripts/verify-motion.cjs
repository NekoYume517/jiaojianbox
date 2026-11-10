const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = async function verifyMotion(page, scratch) {
  // The first render must work without a refresh, a timer, or an animation end.
  await page.evaluate(() => { state.firstRenderDone = false; render(); });
  assert.deepEqual(await page.locator('.stagger-item').first().evaluate(el => ({ opacity: getComputedStyle(el).opacity, transform: getComputedStyle(el).transform })), { opacity: '1', transform: 'none' });

  // Re-target a moving highlight several times, then check its actual final bounds.
  for (const name of ['files', 'inbox', 'sources', 'tasks']) await page.locator(`[data-nav="${name}"]`).click();
  await page.waitForFunction(() => {
    const a = document.querySelector('.sidebar [data-nav].active').getBoundingClientRect();
    const b = document.querySelector('.nav-highlight').getBoundingClientRect();
    return Math.abs(a.x-b.x)<.5 && Math.abs(a.y-b.y)<.5 && Math.abs(a.width-b.width)<.5 && Math.abs(a.height-b.height)<.5;
  });
  assert.equal(await page.locator('.nav-highlight').count(), 1);
  const create = page.locator('#view [data-action="new-task"]').filter({ visible: true });
  const box = await create.boundingBox();
  await page.mouse.move(box.x+box.width/2, box.y+box.height/2); await page.mouse.down();
  await page.waitForTimeout(90);
  assert.notEqual(await create.evaluate(el => getComputedStyle(el).transform), 'none');
  await page.mouse.up(); await page.locator('#task-dialog').waitFor({state:'visible'});
  await page.locator('#task-title').fill('动画中断后保留的草稿');
  // Cancel a close with a new open before its completion callback can run.
  await page.evaluate(() => { uiMotion.closeDialog(document.querySelector('#task-dialog')); uiMotion.openDialog(document.querySelector('#task-dialog')); });
  await page.waitForTimeout(500);
  assert(await page.locator('#task-dialog').evaluate(d => d.open));
  assert.equal(await page.locator('#task-title').inputValue(), '动画中断后保留的草稿');
  await page.keyboard.press('Escape'); await page.locator('#task-dialog').waitFor({state:'hidden'});

  const trigger = page.locator('#quick-actions'), menu = page.locator('#quick-actions-menu');
  await trigger.click(); await menu.waitFor({state:'visible'});
  await page.screenshot({path:path.join(scratch,'motion-menu.png')});
  await trigger.click(); await trigger.click(); await menu.waitFor({state:'visible'});
  await page.waitForTimeout(400); assert.equal(await page.locator('.menu-ghost').count(),0);
  await page.keyboard.press('Escape'); assert.equal(await trigger.getAttribute('aria-expanded'),'false');
  await trigger.focus(); await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(()=>document.activeElement.textContent), '新建待办');
  await page.keyboard.press('ArrowUp'); assert((await page.evaluate(()=>document.activeElement.textContent)).startsWith('全部快捷操作'));
  await page.keyboard.press('Escape'); assert(await trigger.evaluate(el=>document.activeElement===el));

  await trigger.click(); await menu.getByRole('menuitem',{name:'新建待办',exact:true}).click();
  await page.locator('#task-dialog').waitFor({state:'visible'}); assert(await menu.isHidden());
  await page.screenshot({path:path.join(scratch,'motion-dialog.png')});
  await page.keyboard.press('Escape');
  await page.emulateMedia({reducedMotion:'reduce'});
  await create.click();
  assert.equal(await page.locator('#task-dialog').evaluate(d=>d.getAnimations().filter(a=>a.playState==='running').length),0);
  await page.locator('#task-dialog [data-action="close-task"]').first().click();
  assert(await page.locator('#task-dialog').isHidden());
  await trigger.click(); assert.equal(await menu.evaluate(el=>el.getAnimations().filter(a=>a.playState==='running').length),0);
  await page.keyboard.press('Escape'); await page.emulateMedia({reducedMotion:'no-preference'});
  await page.setViewportSize({width:390,height:844});
  await trigger.click(); const bounds=await menu.boundingBox(); assert(bounds.x>=0&&bounds.x+bounds.width<=390);
  await page.keyboard.press('Escape'); await page.setViewportSize({width:1280,height:860});
  // The command input stays above its scrolling results without a clipped focus ring.
  await page.keyboard.press('Control+k'); await page.locator('#cmdk-input').waitFor({state:'visible'});
  assert.equal(await page.locator('#cmdk-input').evaluate(el=>getComputedStyle(el).outlineStyle),'none');
  assert.equal(await page.locator('#cmdk-input').evaluate(el=>getComputedStyle(el).boxShadow),'none');
  await page.locator('#cmdk-list').evaluate(el=>el.scrollTop=el.scrollHeight);
  const searchBounds=await page.locator('#cmdk-input').boundingBox(),listBounds=await page.locator('#cmdk-list').boundingBox();
  assert(listBounds.y>=searchBounds.y+searchBounds.height-.5);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#shelf-handle').evaluate(el=>getComputedStyle(el).position),'relative');
  for(const width of [1264,820,390]){
    await page.setViewportSize({width,height:830});await page.locator('[data-nav="sources"]').click();
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'sources must not overflow horizontally');
  }
  await page.setViewportSize({width:390,height:830});await page.locator('[data-nav="stats"]').click();
  await page.locator('.page-tabs button').first().waitFor();
  const tabThumb=page.locator('.page-tabs .segment-highlight');
  const tabBefore=await tabThumb.evaluate(el=>el.style.transform);
  await page.locator('.page-tabs button').nth(1).click();
  await page.waitForFunction(([before])=>{
    const thumb=document.querySelector('.page-tabs .segment-highlight');
    return thumb&&thumb.style.transform!==before&&document.querySelector('.page-tabs button[aria-selected=true]').textContent.trim()!=='概览';
  },[tabBefore]);
  assert.equal(await page.locator('.page-tabs button[aria-selected=true]').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
  await page.setViewportSize({width:1280,height:860});
  const themeThumb=page.locator('.topbar .theme-picker .segment-highlight');
  const themeBefore=await themeThumb.evaluate(el=>el.style.transform);
  const activeMode=await page.locator('.topbar [data-theme-mode].active').getAttribute('data-theme-mode');
  await page.locator(`.topbar [data-theme-mode="${activeMode==='dark'?'light':'dark'}"]`).click();
  await page.waitForFunction(before=>document.querySelector('.topbar .theme-picker .segment-highlight')?.style.transform!==before,[themeBefore]);
  await page.locator(`.topbar [data-theme-mode="${activeMode}"]`).click();
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('#view')).opacity==='1');
  await page.setViewportSize({width:1280,height:860});await page.locator('[data-nav="tasks"]').click();
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('#view')).opacity==='1');
  await require('./verify-experience.cjs')(page,scratch);
  // The service controls share Magpie's moving segment and keyboard behavior.
  await page.evaluate(()=>{
    const box=document.createElement('div');box.id='verify-service-segment';box.className='chart-mode';box.setAttribute('role','tablist');
    box.innerHTML='<button role="tab" class="active" aria-selected="true">默认</button><button role="tab" aria-selected="false">自定义</button>';
    Object.assign(box.style,{position:'fixed',top:'100px',right:'24px',zIndex:'1005'});document.body.append(box);
    box.addEventListener('click',e=>{if(e.target.tagName!=='BUTTON')return;box.querySelectorAll('button').forEach(b=>{const selected=b===e.target;b.classList.toggle('active',selected);b.setAttribute('aria-selected',String(selected));b.tabIndex=selected?0:-1;});uiMotion.syncSegments();});
    uiMotion.syncSegments();
  });
  const segment=page.locator('#verify-service-segment');
  await segment.locator('button').nth(1).click();
  await page.waitForTimeout(320);
  assert.equal(await segment.locator('.segment-highlight').count(),1);
  assert(await segment.evaluate(box=>{const a=box.querySelector('.active').getBoundingClientRect(),b=box.querySelector('.segment-highlight').getBoundingClientRect();return Math.abs(a.x-b.x)<.5&&Math.abs(a.width-b.width)<.5;}));
  await segment.locator('button').nth(1).focus();await page.keyboard.press('ArrowLeft');
  assert.equal(await segment.locator('[aria-selected=true]').innerText(),'默认');
  await page.evaluate(()=>document.querySelector('#verify-service-segment').remove());
  await page.locator('[data-nav=inbox]').focus();await page.keyboard.press('Shift');
  assert.equal(await page.locator('[data-nav=inbox]').evaluate(el=>getComputedStyle(el).outlineStyle),'none');
  await page.evaluate(()=>{
    document.documentElement.dataset.inputMethod='pointer';
    const box=document.createElement('div');box.id='verify-shared-element';box.style.cssText='position:fixed;left:300px;top:120px;z-index:1005';
    box.innerHTML='<div data-motion-key="shared" style="width:50px;height:30px;background:gray"></div>';document.body.append(box);
  });
  await page.mouse.click(700,90);
  const before=await page.locator('#verify-shared-element>div').boundingBox();
  await page.evaluate(()=>uiMotion.relayout(document.querySelector('#verify-shared-element'),()=>{document.querySelector('#verify-shared-element>div').style.marginLeft='100px';}));
  const during=await page.locator('#verify-shared-element>div').boundingBox();
  assert(during.x<before.x+95,'shared element must move from its old position');
  await page.waitForTimeout(320);
  const after=await page.locator('#verify-shared-element>div').boundingBox();assert(Math.abs(after.x-before.x-100)<.5);
  await page.evaluate(()=>document.querySelector('#verify-shared-element').remove());
  console.log('Motion: first render, spring retargeting, press feedback, interrupted dialogs, menu re-entry/keyboard, reduced motion and narrow bounds passed.');
};
