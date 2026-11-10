const assert=require('node:assert/strict');
const path=require('node:path');
module.exports=async(page,scratch)=>{
  const saved=await page.evaluate(()=>appearance.get());
  const selectTab=async key=>page.locator(`.nav-sub [data-subnav="${key}"]`).click();
  const sizes=()=>page.evaluate(()=>{
    const rect=el=>el.getBoundingClientRect();
    const nav=document.querySelector('[data-nav="settings"]'),field=document.querySelector('#appearance-density');
    return {nav:rect(nav).height,font:parseFloat(getComputedStyle(nav).fontSize),field:rect(field).height,panel:parseFloat(getComputedStyle(document.querySelector('#settings-appearance')).paddingTop)};
  });
  try{
    await page.setViewportSize({width:1280,height:860});
    await page.locator('[data-nav="settings"]').click();await selectTab('general');
    assert(await page.evaluate(()=>!document.querySelector('.sidebar-note')),'sidebar helper note must stay removed');
    assert(await page.evaluate(()=>{
      const settings=document.querySelector('[data-nav="settings"]').getBoundingClientRect();
      const account=document.querySelector('.account').getBoundingClientRect();
      return settings.bottom<=account.top&&account.bottom<=document.querySelector('.sidebar').getBoundingClientRect().bottom+1;
    }),'settings must sit directly above the account footer');
    await page.locator('#appearance-text-size').selectOption('normal');
    await page.locator('#appearance-density').selectOption('comfortable');const comfortable=await sizes();
    await page.screenshot({path:path.join(scratch,'density-comfortable.png')});
    await page.locator('#appearance-density').selectOption('compact');const compact=await sizes();
    await page.waitForFunction(()=>{const active=document.querySelector('.sidebar nav [data-nav].active');if(!active)return document.querySelector('.nav-highlight').hidden;const a=active.getBoundingClientRect(),b=document.querySelector('.nav-highlight').getBoundingClientRect();return Math.abs(a.y-b.y)<.5&&Math.abs(a.height-b.height)<.5;});
    await page.screenshot({path:path.join(scratch,'density-compact.png')});
    assert(comfortable.nav>=compact.nav+6,'navigation density must change the actual click area');
    assert(comfortable.field>compact.field&&comfortable.panel>compact.panel,'fields and panels must share density');
    await page.locator('#appearance-text-size').selectOption('large');const large=await sizes();
    assert(large.font>compact.font*1.1,'navigation text must respond to text size');
    await selectTab('model');
    const breadcrumbSpacing=await page.evaluate(()=>{
      const root=document.querySelector('.breadcrumb-root').getBoundingClientRect(),separator=document.querySelector('.breadcrumb-root-separator').getBoundingClientRect(),main=document.querySelector('#breadcrumb').getBoundingClientRect(),subSeparator=document.querySelector('.breadcrumb-sub .breadcrumb-separator').getBoundingClientRect(),sub=document.querySelector('.breadcrumb-sub-label').getBoundingClientRect();
      return [separator.left-root.right,main.left-separator.right,subSeparator.left-main.right,sub.left-subSeparator.right];
    });
    assert(breadcrumbSpacing.every(gap=>Math.abs(gap-12)<.5),'breadcrumb separators must have equal spacing at every level');
    assert.equal(await page.locator('.breadcrumb [aria-current=page]').count(),1);
    await page.locator('#llm-model').fill('保留未保存草稿');
    await selectTab('general');await selectTab('model');assert.equal(await page.locator('#llm-model').inputValue(),'保留未保存草稿');
    const previous=await page.locator('.nav-sub [data-subnav="model"]').evaluate(el=>el.previousElementSibling.dataset.subnav);
    await page.keyboard.press('ArrowUp');assert.equal(await page.locator('.nav-sub:not(.leaving) [aria-selected="true"]').getAttribute('data-subnav'),previous);
    // A content transition must cancel on another click and leave its contents visible.
    await selectTab('general');await selectTab('model');await page.waitForTimeout(450);
    assert.equal(await page.locator('#view').evaluate(el=>getComputedStyle(el).opacity),'1');
    await page.screenshot({path:path.join(scratch,'secondary-tabs.png')});
    const first=page.locator('.nav-sub [data-subnav="model"]');await first.focus();
    await page.keyboard.press('Control+k');await page.keyboard.press('Tab');
    assert(await page.locator('#cmdk-input').evaluate(el=>document.activeElement===el));
    await page.keyboard.press('Escape');assert(await first.evaluate(el=>document.activeElement===el));
    await selectTab('general');
    await page.locator('[data-nav="stats"]').click();await selectTab('recent');
    assert(await page.locator('#statistics-recent').isVisible());assert(await page.locator('#chart-tokens').isHidden());
    await selectTab('overview');
    for(const pageName of ['settings','stats','sources','settings'])await page.locator(`[data-nav="${pageName}"]`).click();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.nav-sub.leaving,.nav-sub.moving').count(),0,'interrupted submenus must finish folding');
    assert.equal(await page.locator('#page-subnav').count(),1);
    await page.locator('[data-nav="settings"]').click();await selectTab('general');
    for(const density of ['comfortable','compact']){
      await page.evaluate(density=>appearance.update({density}),density);
      for(const width of [1280,1100,850,820,700,621,620,390,360]){
        await page.setViewportSize({width,height:860});
        if(width>620)await page.waitForFunction(()=>{const sidebar=document.querySelector('.sidebar').getBoundingClientRect(),main=document.querySelector('.main').getBoundingClientRect();return Math.abs(sidebar.right-main.left)<=1.5;});
        const layout=await page.evaluate(()=>{
          const sidebar=document.querySelector('.sidebar').getBoundingClientRect(),main=document.querySelector('.main').getBoundingClientRect();
          return {right:sidebar.right,main:main.left,navFont:parseFloat(getComputedStyle(document.querySelector('[data-nav="settings"]')).fontSize),label:getComputedStyle(document.querySelector('.brand>span')).display,field:document.querySelector('#appearance-density').getBoundingClientRect().height};
        });
        if(width>820){assert(Math.abs(layout.right-layout.main)<=1.5,`sidebar gutter mismatch at ${width}`);assert.notEqual(layout.label,'none');assert(layout.navFont>10);}
        else if(width>620){assert(Math.abs(layout.right-layout.main)<=1.5,`sidebar gutter mismatch at ${width}`);assert.equal(layout.label,'none');assert(await page.locator('.page-tabs').isVisible());}
        else{assert(layout.field>=44);assert(await page.locator('.page-tabs').isVisible());}
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      }
    }
    await page.setViewportSize({width:1280,height:860});
    const initialSidebar=await page.evaluate(()=>document.documentElement.dataset.sidebar);
    await page.locator('#sidebar-toggle').click();
    await page.waitForFunction(mode=>document.documentElement.dataset.sidebar!==mode,initialSidebar);
    await page.waitForFunction(()=>document.querySelector('.sidebar').getBoundingClientRect().width<100);
    await page.waitForFunction(()=>Math.abs(document.querySelector('.sidebar').getBoundingClientRect().width-52)<1);
    assert(await page.evaluate(()=>document.querySelector('#sidebar-toggle').getBoundingClientRect().left<48),'sidebar toggle belongs in the top left corner');
    assert(await page.evaluate(()=>{
      const sidebar=document.querySelector('.sidebar').getBoundingClientRect(),account=document.querySelector('.account').getBoundingClientRect();
      return account.bottom>sidebar.bottom-100&&account.bottom<=sidebar.bottom+1;
    }),'collapsed account actions belong at the bottom');
    assert(await page.evaluate(()=>{
      const settings=document.querySelector('[data-nav="settings"]').getBoundingClientRect();
      const account=document.querySelector('.account').getBoundingClientRect();
      return settings.bottom<=account.top+1;
    }),'collapsed settings still belongs above the account footer');
    assert(await page.evaluate(()=>getComputedStyle(document.querySelector('[data-nav=stats]'),':after').content==='none'),'collapsed nav must not show an external active label');
    await page.locator('#sidebar-toggle').click();
    await page.waitForFunction(mode=>document.documentElement.dataset.sidebar===mode,initialSidebar);
    await page.waitForFunction(()=>document.querySelector('.sidebar').getBoundingClientRect().width>180);
    await page.setViewportSize({width:360,height:860});
    assert(await page.evaluate(()=>{
      const button=document.querySelector('[data-nav="inbox"]');
      const style=getComputedStyle(button);
      return parseFloat(style.fontSize)>10&&style.flexDirection==='column'&&button.getBoundingClientRect().height>=54;
    }),'mobile bottom navigation must keep its labels');
    await page.locator('.page-tabs [data-subnav="model"]').click();assert(await page.locator('#llm-url').isVisible());
    await page.setViewportSize({width:1280,height:860});await selectTab('general');
    await page.evaluate(()=>scrollTo(0,300));await page.locator('[data-nav="tasks"]').click();
    assert.equal(await page.evaluate(()=>scrollY),0,'new page must start at the top');
    await page.emulateMedia({reducedMotion:'reduce'});await page.locator('[data-nav="settings"]').click();await selectTab('model');
    assert.equal(await page.locator('#view').evaluate(el=>el.getAnimations().filter(a=>a.playState==='running').length),0);
    console.log('Experience: density, text size, responsive sidebar, secondary tabs, draft preservation, command focus, page scroll and reduced motion passed.');
  }catch(error){console.error('Experience failure:',error);throw error;}finally{
    await page.evaluate(()=>cmdkHide());
    await page.emulateMedia({reducedMotion:'no-preference'});await page.setViewportSize({width:1280,height:860});
    await page.evaluate(saved=>appearance.update(saved),saved);await page.locator('[data-nav="settings"]').click();await selectTab('general');await page.locator('[data-nav="tasks"]').click();
  }
};
