/* Contextual sidebar tabs, following Magpie's indented rows and single moving selection. */
(() => {
  'use strict';
  const definitions = {
    settings: [
      ['general','常规','#settings-appearance'],
      ['quick','快捷收集','#settings-quick'],
      ['reminders','桌面提醒','#settings-reminders'],
      ['startup','启动与更新','#settings-launcher'],
      ['model','模型连接','#model-settings'],
      ['account','我的','#account-panel'],
      ['admin','站点管理','#admin-panel'],
    ],
    sources: [
      ['overview','概览','.source-overview'],['history','触发历史','.trigger-history-panel'],['qq','QQ 触发器','[data-source-card="qq"]'],
      ['wechat','微信触发器','[data-source-card="wechat"]'],['adapters','插件触发器','.trigger-adapters'],
      ['advanced','高级与调试','.advanced-source'],
    ],
    stats: [
      ['overview','概览','*'],['tokens','Token 消耗','#chart-tokens'],
      ['response','响应情况','#chart-latency,#chart-status'],['recent','最近调用','#statistics-recent'],
    ],
  };
  const chosen = new Map();
  const descriptions={general:'选择适合当前设备的颜色、文字和信息密度。',quick:'设置快捷收集的启用方式和窗口内容。',reminders:'设置本机 Windows 通知与测试提醒。',startup:'管理开机启动与客户端更新。',model:'选择服务器提供的 AI，或连接自己的模型接口。',account:'管理个人资料与工作区数据。',admin:'管理站点注册、邀请码、邮件与账号。'};
  const sourceDescriptions={
    overview:'查看 QQ、微信与插件触发器的连接状态。',
    history:'按来源查看每次触发，并在同一会话里继续处理。',
    qq:'选择 QQ 实例和需要采集的聊天。',
    wechat:'选择需要采集的微信聊天，并检查数据库连接。',
    adapters:'查看插件注册的触发器与运行状态。',
    advanced:'连接详情、读取检查与运行记录。',
  };
  let signature='', currentBox, queued=false, selectionAnimation;
  const sidebarQuery=matchMedia('(max-width:820px)');
  const sidebarKey='jjb-sidebar-mode';
  const readSidebarMode=()=>{
    const current=document.documentElement.dataset.sidebar;
    if(['icons','labels'].includes(current))return current;
    const stored=localStorage.getItem(sidebarKey);
    return ['icons','labels'].includes(stored)?stored:sidebarQuery.matches?'icons':'labels';
  };
  const sidebarButton=document.getElementById('sidebar-toggle');
  function applySidebarMode(mode,animate=true){
    const previous=document.documentElement.dataset.sidebar;
    document.documentElement.dataset.sidebar=mode;
    document.querySelectorAll('[data-nav]').forEach(button=>{
      if(button.title&&!button.dataset.navTitle)button.dataset.navTitle=button.title;
      const label=button.dataset.navTitle||'';
      if(mode==='icons')button.title=label;
      else button.removeAttribute('title');
    });
    const expanded=mode==='labels';
    sidebarButton?.setAttribute('aria-pressed',String(expanded));
    if(sidebarButton){
      sidebarButton.title=expanded?'切换为图标模式':'切换为图标 + 文字';
      sidebarButton.setAttribute('aria-label',expanded?'切换为图标模式':'切换为图标 + 文字');
    }
    if(previous&&previous!==mode&&animate)uiMotion.transitionPage(view,true);
    sync();
  }
  sidebarButton?.addEventListener('click',()=>{
    const mode=readSidebarMode()==='icons'?'labels':'icons';
    try{localStorage.setItem(sidebarKey,mode);}catch{}
    applySidebarMode(mode);
  });
  sidebarQuery.addEventListener('change',()=>{
    if(['icons','labels'].includes(localStorage.getItem(sidebarKey)))return;
    applySidebarMode(sidebarQuery.matches?'icons':'labels');
  });
  const view = document.querySelector('#view');
  const breadcrumb=document.createElement('span');breadcrumb.className='breadcrumb-sub';breadcrumb.hidden=true;breadcrumb.innerHTML='<span class="breadcrumb-separator" aria-hidden="true">/</span><span class="breadcrumb-sub-label" aria-current="page"></span>';document.querySelector('.breadcrumb').append(breadcrumb);
  const breadcrumbLabel=breadcrumb.querySelector('.breadcrumb-sub-label');
  const mobileTabs=document.createElement('div');mobileTabs.className='page-tabs';mobileTabs.setAttribute('role','tablist');mobileTabs.setAttribute('aria-label','栏目内页面');view.before(mobileTabs);
  mobileTabs.addEventListener('click',e=>{const b=e.target.closest('[data-subnav]');if(b)select(b.dataset.subnav);});
  mobileTabs.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();e.stopPropagation();const rows=[...mobileTabs.querySelectorAll('button')],i=rows.indexOf(document.activeElement),target=rows[e.key==='Home'?0:e.key==='End'?rows.length-1:(i+(e.key==='ArrowLeft'?-1:1)+rows.length)%rows.length];select(target.dataset.subnav);target.focus({preventScroll:true});});
  const node = selector => view.querySelector(selector);
  function pageItems(page) {
    if(page.startsWith('plugin:'))return window.pluginUI?.children(page)||[];
    return definitions[page]||[];
  }
  function navParent(page) {
    return document.querySelector(`[data-nav="${CSS.escape(page)}"]`)||document.querySelector('[data-nav=plugins]');
  }
  function visibleGroups(page,key) {
    const show=(el,yes)=>{if(el)el.hidden=!yes;};
    if(page.startsWith('plugin:'))window.pluginUI?.showChild(page,key);
    if(page==='settings'){
      for(const [id,,selector] of definitions.settings)show(node(selector),id===key);
      show(node('#appearance-panel-marker'),['general','quick','reminders','startup'].includes(key));
    }
    if(page==='sources'){
      show(node('.source-save-bar'),!['history','adapters'].includes(key));
      show(node('.source-overview'),key==='overview');
      show(node('.trigger-history-panel'),key==='history');
      show(node('.trigger-adapters'),key==='adapters');
      show(node('.source-grid'),['qq','wechat'].includes(key));
      show(node('[data-source-card="qq"]'),key==='qq');
      show(node('[data-source-card="wechat"]'),key==='wechat');
      show(node('.advanced-source'),key==='advanced');
      const advanced=node('.advanced-source');if(advanced&&key==='advanced')advanced.open=true;
      node('.source-grid')?.classList.toggle('single-source',true);
    }
    if(page==='stats'){
      for(const chart of ['chart-tokens','chart-latency','chart-status']){
        const yes=key==='overview'||key==='tokens'&&chart==='chart-tokens'||key==='response'&&chart!=='chart-tokens';
        show(node('#'+chart)?.closest('section'),yes);
      }
      show(node('.statistics-grid'),key!=='recent');
      show(node('#statistics-summary'),key==='overview');
      show(node('#statistics-credit'),key==='overview'&&view.dataset.statisticsSource==='managed');
      show(node('#statistics-models'),['overview','tokens'].includes(key));
      show(node('#statistics-recent')?.closest('section'),['overview','recent'].includes(key));
    }
  }
  function glide(selected,animate) {
    if(!selected)return;
    const thumb=currentBox.querySelector('.subnav-highlight');
    const before=getComputedStyle(thumb).transform,previousTarget=thumb.style.transform,previousHeight=thumb.style.height;
    const to=`translateY(${selected.offsetTop}px)`,height=selected.offsetHeight+'px';
    if(previousTarget===to&&previousHeight===height)return;
    selectionAnimation?.cancel();thumb.style.transform=to;thumb.style.height=height;
    if(animate&&document.documentElement.dataset.inputMethod==='pointer'&&!matchMedia('(prefers-reduced-motion:reduce)').matches&&previousTarget){
      selectionAnimation=thumb.animate([{transform:before,height:previousHeight},{transform:to,height}],{duration:240,easing:'cubic-bezier(.23,1,.32,1)'});
    }
  }
  function select(key,animate=true) {
    const page=state.page;
    const rows=[...currentBox.querySelectorAll('[data-subnav]')];
    if(!rows.some(row=>row.dataset.subnav===key))return;
    chosen.set(page,key);
    mobileTabs.querySelectorAll('button').forEach(b=>{const active=b.dataset.subnav===key;b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;});
    rows.forEach(row=>{const active=row.dataset.subnav===key;row.classList.toggle('active',active);row.setAttribute('aria-selected',String(active));row.tabIndex=active?0:-1;});
    const selected=rows.find(row=>row.dataset.subnav===key);
    glide(selected,true);uiMotion.syncSegments();
    const apply=()=>{
      visibleGroups(page,key);
      if(breadcrumbLabel.textContent!==selected.textContent)breadcrumbLabel.textContent=selected.textContent;breadcrumb.hidden=false;
      document.getElementById('breadcrumb').removeAttribute('aria-current');
      view.setAttribute('role','tabpanel');view.setAttribute('aria-label',selected.textContent);
      const title=node('.page-heading h1');
      const description=node('.page-heading p');
      if(page==='settings'&&description&&description.textContent!==descriptions[key])description.textContent=descriptions[key]||'';
      if(page==='sources'){
        if(title)title.textContent=key==='history'?'触发历史':'触发器';
        if(description&&description.textContent!==sourceDescriptions[key])description.textContent=sourceDescriptions[key]||'';
        const actions=node('.page-heading .actions');if(actions)actions.hidden=key==='history';
      }
      uiMotion.syncSegments();
    };
    if(animate)uiMotion.swapPage(view,apply,{subsection:true});
    // The render-driven sync path must never move the viewport.
    else apply();
  }
  function sync() {
    const page=state.page;
    const items=pageItems(page).filter(([, , selector])=>page.startsWith('plugin:')||selector==='*'||node(selector));
    // Message ingestion is desktop-only; trigger conversations remain available everywhere.
    if(page==='sources'&&!window.desktop){const index=items.findIndex(item=>item[0]==='history');items.splice(0,items.length);if(index>=0)items.push(['history','触发历史','.trigger-history-panel']);}
    const next=page+':'+items.map(item=>item[0]).join(',');
    const fresh=next!==signature;
    if(fresh){
      signature=next;selectionAnimation?.cancel();document.querySelectorAll('.nav-sub.leaving').forEach(box=>box.remove());if(currentBox)uiMotion.hideSubnavigation(currentBox);currentBox=null;mobileTabs.replaceChildren();mobileTabs.hidden=!items.length;breadcrumb.hidden=!items.length;
      if(!items.length){document.getElementById('breadcrumb').setAttribute('aria-current','page');view.removeAttribute('role');view.removeAttribute('aria-label');}
      document.querySelectorAll('[data-nav]').forEach(b=>{b.removeAttribute('aria-expanded');b.removeAttribute('aria-controls');});
      if(items.length){
        currentBox=document.createElement('div');currentBox.className='nav-sub';currentBox.id='page-subnav';
        currentBox.setAttribute('role','tablist');currentBox.setAttribute('aria-orientation','vertical');currentBox.setAttribute('aria-label','栏目内页面');
        currentBox.innerHTML='<span class="subnav-highlight" aria-hidden="true"></span>';
        for(const [key,label] of items){const b=document.createElement('button');b.type='button';b.dataset.subnav=key;b.textContent=label;b.setAttribute('role','tab');b.setAttribute('aria-controls','view');currentBox.append(b);mobileTabs.append(b.cloneNode(true));}
        const parent=navParent(page);parent.after(currentBox);parent.setAttribute('aria-expanded','true');parent.setAttribute('aria-controls','page-subnav');
        currentBox.addEventListener('click',e=>{const b=e.target.closest('[data-subnav]');if(b&&chosen.get(state.page)!==b.dataset.subnav)select(b.dataset.subnav);});
        currentBox.addEventListener('pointerdown',e=>{if(e.button===0)glide(e.target.closest('[data-subnav]'),true);});
        currentBox.addEventListener('pointercancel',()=>glide(currentBox.querySelector('[aria-selected=true]'),true));
        currentBox.addEventListener('pointerleave',e=>{if(e.buttons&1)glide(currentBox.querySelector('[aria-selected=true]'),true);});
        currentBox.addEventListener('keydown',e=>{
          if(!['ArrowUp','ArrowDown','Home','End'].includes(e.key))return;e.preventDefault();e.stopPropagation();
          const rows=[...currentBox.querySelectorAll('button')],index=rows.indexOf(document.activeElement);
          const target=rows[e.key==='Home'?0:e.key==='End'?rows.length-1:(index+(e.key==='ArrowUp'?-1:1)+rows.length)%rows.length];
          select(target.dataset.subnav);target.focus({preventScroll:true});
        });
        uiMotion.revealSubnavigation(currentBox);
      }
    }
    if(currentBox){const key=chosen.get(page);select(items.some(item=>item[0]===key)?key:items[0][0],false);}
    uiMotion.syncNavigation();
  }
  new MutationObserver(()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;sync();});}).observe(view,{childList:true,subtree:true});
  window.addEventListener('appearance-changed',sync);
  window.addEventListener('resize',sync);
  matchMedia('(prefers-reduced-motion:reduce)').addEventListener('change',()=>{selectionAnimation?.cancel();sync();});
  window.pageNavigation={sync,select};
  applySidebarMode(readSidebarMode(),false);
  sync();
})();
