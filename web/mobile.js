/* Android shell connector. This module is inert in the regular web/desktop app. */
(() => {
  'use strict';
  const root = document.documentElement;
  function syncViewport() {
    const viewport = window.visualViewport;
    const height = Math.round(viewport?.height || window.innerHeight || 0);
    const offsetTop = Math.round(viewport?.offsetTop || 0);
    if (height > 0) root.style.setProperty('--jjb-viewport-height', height + 'px');
    root.style.setProperty('--jjb-viewport-offset-top', offsetTop + 'px');
    syncChromeMetrics();
  }
  function syncChromeMetrics() {
    const topbar = document.querySelector('.main .topbar');
    const nav = document.querySelector('.workspace > .sidebar');
    if (topbar) root.style.setProperty('--jjb-mobile-topbar-bottom', Math.ceil(topbar.getBoundingClientRect().bottom) + 'px');
    if (nav) root.style.setProperty('--jjb-mobile-nav-offset', Math.ceil(window.innerHeight - nav.getBoundingClientRect().top) + 'px');
  }
  syncViewport();
  window.visualViewport?.addEventListener('resize', syncViewport);
  window.visualViewport?.addEventListener('scroll', syncViewport);
  window.addEventListener('resize', syncViewport);
  document.addEventListener('DOMContentLoaded', () => {
    syncChromeMetrics();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(syncChromeMetrics);
    for (const element of [document.querySelector('.main .topbar'), document.querySelector('.workspace > .sidebar')]) {
      if (element) observer.observe(element);
    }
  }, { once: true });
  if (!window.__JJB_ANDROID__ || window.top !== window) return;
  let sequence = 0;
  const pending = new Map();
  let port;
  const ready = new Promise(resolve => {
    window.addEventListener('message', event => {
      if (event.data !== 'jjb-bridge' || !event.ports?.length || (event.source && event.source !== window)) return;
      port = event.ports[0];
      port.onmessage = message => {
        try { const result=JSON.parse(message.data); window.mobile?._complete(result.id,result.value,result.error); } catch { /* Ignore malformed transport responses. */ }
      };
      port.start(); resolve();
    });
  });
  const session = window.__JJB_SESSION__;
  if (!session) return;
  root.dataset.platform='android';
  localStorage.setItem('jjb-session', JSON.stringify(session));
  window.mobile = {
    platform: 'android',
    invoke(method, payload = {}) {
      return new Promise((resolve, reject) => {
        const id = String(++sequence);
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('手机连接器响应超时，请重试')); }, method === 'download' ? 900000 : 180000);
        pending.set(id, { resolve, reject, timer });
        ready.then(() => { if (pending.has(id)) port.postMessage(JSON.stringify({id,method,payload})); }).catch(error => { clearTimeout(timer);pending.delete(id);reject(error); });
      });
    },
    _complete(id, value, error) {
      const request = pending.get(id); if (!request) return;
      pending.delete(id); clearTimeout(request.timer);
      if (error) request.reject(new Error(error)); else request.resolve(value);
    },
    download: (route, name) => window.mobile.invoke('download', { route, name }),
    logout: () => window.mobile.invoke('logout'),
  };
  const mobileQuery=matchMedia('(max-width:620px)');
  let originalSettingsParent;
  function mobileNavigation(){
    const button=document.querySelector('[data-nav="settings"]'),nav=document.querySelector('.sidebar nav');
    if(!button||!nav)return;
    originalSettingsParent ||= button.parentElement;
    if(mobileQuery.matches&&button.parentElement!==nav)nav.append(button);
    else if(!mobileQuery.matches&&button.parentElement!==originalSettingsParent)originalSettingsParent.prepend(button);
    for(const node of button.childNodes)if(node.nodeType===Node.TEXT_NODE)node.textContent='我的';
    button.dataset.short='我的';button.dataset.navTitle='我的';button.setAttribute('aria-label','我的');
    const iconNode=button.querySelector('[data-icon]');
    if(mobileQuery.matches&&iconNode){iconNode.dataset.icon='user';iconNode.innerHTML=icon('user');}
    if(!button.dataset.mobileAccount){
      button.dataset.mobileAccount='true';
      button.addEventListener('click',async event=>{
        event.preventDefault();event.stopPropagation();
        try{await navigate('settings');pageNavigation.sync();pageNavigation.select('account');}
        catch(error){window.toast?.(error.message);}
      });
    }
    window.uiMotion?.syncNavigation(true);
  }
  function syncAppearance(){
    const css=getComputedStyle(document.documentElement);
    mobile.invoke('appearance',{canvas:css.getPropertyValue('--canvas').trim(),panel:css.getPropertyValue('--panel').trim(),dark:document.documentElement.dataset.theme==='dark'}).catch(()=>{});
  }
  mobileQuery.addEventListener('change',mobileNavigation);
  window.addEventListener('appearance-changed',syncAppearance);
  let scheduled = 0;
  function decorate() {
    mobileNavigation();
    const sources = document.querySelector('[data-nav="sources"]');
    if (sources) sources.hidden = true;
    const menu = document.getElementById('quick-actions-menu');
    if (menu && !menu.querySelector('[data-mobile-connectors]')) {
      const button = document.createElement('button'); button.type = 'button'; button.role = 'menuitem';
      button.dataset.mobileConnectors = ''; button.textContent = '手机连接器'; menu.append(button);
    }
    const side = document.querySelector('.task-side');
    if (side && !side.querySelector('[data-mobile-calendar]')) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary';
      button.dataset.mobileCalendar = ''; button.textContent = '添加到系统日历';
      const actions = document.createElement('div'); actions.className = 'detail-actions'; actions.style.marginTop = 'var(--section-space)'; actions.append(button); side.append(actions);
    }
    clearTimeout(scheduled);
    scheduled = setTimeout(() => mobile.invoke('calendarRefresh').catch(() => {}), 1200);
    syncAppearance();
  }
  window.addEventListener('workspace-render', decorate);
  document.addEventListener('DOMContentLoaded', decorate);
  document.addEventListener('click', event => {
    if (event.target.closest('[data-mobile-connectors]')) { mobile.invoke('connectors').catch(error => window.toast?.(error.message)); }
    if (event.target.closest('[data-mobile-calendar]')) {
      mobile.invoke('calendarTask', { taskId: typeof state !== 'undefined' ? state.taskId : null }).catch(error => window.toast?.(error.message));
    }
  });
  window.addEventListener('mobile-files-imported', () => {
    if (typeof refresh === 'function') refresh();
    window.toast?.('文件已导入，可在文件页中整理');
  });
})();
