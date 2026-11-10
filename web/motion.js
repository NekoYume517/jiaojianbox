/* Canonical contract: docs/ui-motion-standard.md.  Behavior follows Magpie's continuity principles (MIT; see THIRD_PARTY_NOTICES).
   Main workspace only: quick.html deliberately does not load this module. */
(() => {
  'use strict';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const ease = 'cubic-bezier(.23,1,.32,1)';
  const spring = CSS.supports('animation-timing-function', 'linear(0,1)')
    ? 'linear(0,.0203,.0723,.1448,.2292,.3188,.4086,.4951,.576,.6498,.7157,.7735,.8232,.8654,.9005,.9293,.9525,.9708,.9849,.9956,1.0033,1.0087,1.0122,1.0142,1.015,1.0151,1.0146,1.0136,1.0124,1.0111,1.0097,1.0084,1.0071,1.0059,1.0049,1.0039,1.0031,1.0024,1.0018,1.0013,1)'
    : 'cubic-bezier(.2,.9,.25,1.02)';
  let keyboard = true, pressed = null;
  const dialogs = new WeakMap(), segments = new WeakMap();
  const play = (el, frames, options) => {
    try { return el.animate(frames, options); } catch { return null; }
  };
  const stop = entry => { for (const a of entry?.animations || []) a?.cancel(); };
  document.addEventListener('pointerdown', event => {
    keyboard = false;
    document.documentElement.dataset.inputMethod = 'pointer';
    const el = event.target.closest('[role=menuitem]') ? document.getElementById('quick-actions') : event.target.closest('button,[data-task],[data-message]');
    pressed = el ? { el, time: performance.now(), rect: el.getBoundingClientRect() } : null;
  }, true);
  document.addEventListener('keydown', () => { keyboard = true; pressed = null; document.documentElement.dataset.inputMethod = 'keyboard'; }, true);

  // One background, retaining velocity when the user changes direction.
  let nav, highlight, frame = 0, last = 0, positioned = false;
  const position = { x: 0, y: 0, w: 0, h: 0 }, velocity = { x: 0, y: 0, w: 0, h: 0 };
  const targetRect = () => {
    const active = nav?.querySelector('[data-nav].active');
    if (!active?.getClientRects().length) return null;
    return { x: active.offsetLeft, y: active.offsetTop, w: active.offsetWidth, h: active.offsetHeight };
  };
  const draw = () => {
    highlight.style.transform = `translate(${position.x}px,${position.y}px)`;
    highlight.style.width = position.w + 'px'; highlight.style.height = position.h + 'px';
  };
  function snapNav(to) {
    cancelAnimationFrame(frame); frame = 0;
    if (!to) { if (highlight) highlight.hidden = true; positioned = false; return; }
    Object.assign(position, to); for (const k in velocity) velocity[k] = 0;
    highlight.hidden = false; positioned = true; draw();
  }
  function step(now) {
    const to = targetRect();
    if (!to || document.hidden || reduced.matches) return snapNav(to);
    const dt = Math.min(1 / 30, Math.max(0, (now - last) / 1000)); last = now;
    const stiffness = (2 * Math.PI / .42) ** 2, damping = 4 * Math.PI * .84 / .42;
    let settled = true;
    for (const k in position) {
      for (let i = 0; i < 4; i++) {
        velocity[k] += (stiffness * (to[k] - position[k]) - damping * velocity[k]) * dt / 4;
        position[k] += velocity[k] * dt / 4;
      }
      if (Math.abs(to[k] - position[k]) >= .25 || Math.abs(velocity[k]) >= 4) settled = false;
    }
    if (settled) return snapNav(to);
    draw(); frame = requestAnimationFrame(step);
  }
  function syncNavigation(instant = false) {
    if (!nav) {
      nav = document.querySelector('.sidebar nav'); if (!nav) return;
      highlight = document.createElement('span'); highlight.className = 'nav-highlight';
      highlight.setAttribute('aria-hidden', 'true'); highlight.hidden = true; nav.prepend(highlight);
      nav.classList.add('motion-nav');
      new ResizeObserver(() => { if(!frame)snapNav(targetRect()); }).observe(nav);
    }
    const to = targetRect();
    nav.querySelectorAll('[data-nav]').forEach(b => {
      if (b.classList.contains('active')) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    if (!to || instant || !positioned || keyboard || reduced.matches || document.hidden) return snapNav(to);
    if (!frame && Object.keys(to).some(k => Math.abs(to[k] - position[k]) > .25)) {
      last = performance.now(); frame = requestAnimationFrame(step);
    }
  }

  function syncSegments() {
    document.querySelectorAll('.theme-picker,.page-tabs,.chart-mode').forEach(box => {
      const selected = box.querySelector('button.active,button[aria-selected=true]');
      if (!selected?.offsetWidth || !box.getClientRects().length) return;
      let entry = segments.get(box);
      if (!entry) {
        const thumb = document.createElement('span'); thumb.className = 'segment-highlight'; thumb.setAttribute('aria-hidden', 'true');
        box.prepend(thumb); entry = { thumb, selected: null, animations: [] }; segments.set(box, entry); box.classList.add('motion-segment');
      }
      const before = entry.thumb.style.width ? getComputedStyle(entry.thumb) : null;
      const from = before && { transform: before.transform, width: before.width, height: before.height };
      const to = { transform: `translate(${selected.offsetLeft}px,${selected.offsetTop}px)`, width: selected.offsetWidth + 'px', height: selected.offsetHeight + 'px' };
      if(entry.selected===selected && Object.entries(to).every(([key,value])=>entry.thumb.style[key]===value)){if(keyboard||reduced.matches||document.hidden)stop(entry);return;}
      stop(entry);entry.animations=[];
      Object.assign(entry.thumb.style, to);
      if (from && entry.selected !== selected && !keyboard && !reduced.matches) entry.animations = [play(entry.thumb, [from, to], { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' })];
      entry.selected = selected;
      if (entry.animations.length) entry.animations[0]?.finished.catch(() => {});
    });
  }

  function adoptSegment(box, from) {
    syncSegments();const entry=segments.get(box);
    if(!entry||keyboard||reduced.matches||document.hidden)return;
    const selected=entry.selected,rect=entry.thumb.getBoundingClientRect();
    stop(entry);
    const to={transform:entry.thumb.style.transform,width:entry.thumb.style.width,height:entry.thumb.style.height};
    const start={transform:`translate(${selected.offsetLeft+from.left-rect.left}px,${selected.offsetTop+from.top-rect.top}px)`,width:from.width+'px',height:from.height+'px'};
    entry.animations=[play(entry.thumb,[start,to],{duration:280,easing:'cubic-bezier(.2,.8,.2,1)'})];
    entry.animations[0]?.finished.catch(()=>{});
  }

  document.addEventListener('keydown',event=>{
    const box=event.target.closest('.chart-mode[role=tablist]');
    if(!box||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const buttons=[...box.querySelectorAll('button:not(:disabled)')];
    const index=buttons.indexOf(event.target);if(index<0)return;
    event.preventDefault();event.stopPropagation();
    const next=buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowLeft'?-1:1)+buttons.length)%buttons.length];
    next.focus({preventScroll:true});next.click();
  });
  function sourceRect(entry) {
    if (!entry?.source?.isConnected) return null;
    const r = entry.source.getBoundingClientRect();
    return r.width && r.height && r.bottom > 0 && r.top < innerHeight ? r : null;
  }
  function folded(from, to) {
    const scale = Math.max(.3, Math.min(1, from.width / to.width));
    const height = Math.min(to.height, from.height / scale);
    return { transform: `translate(${from.left + from.width / 2 - to.left - to.width / 2}px,${from.top + from.height / 2 - to.top - to.height / 2}px) scale(${scale})`,
      clipPath: `inset(${(to.height - height) / 2}px 0 round ${Math.min(10, from.height / 2) / scale}px)` };
  }
  const rest = { transform: 'none', clipPath: 'inset(-80px round 14px)', opacity: 1 };
  function openDialog(dialog) {
    const previous = dialogs.get(dialog);
    if (dialog.open && previous?.phase !== 'closing') return;
    const current = dialog.open ? { transform: getComputedStyle(dialog).transform, clipPath: getComputedStyle(dialog).clipPath, opacity: getComputedStyle(dialog).opacity } : null;
    const entry = { phase: 'opening', animations: [], source: !keyboard && pressed && performance.now() - pressed.time < 1000 ? pressed.el : null };
    stop(previous); dialogs.set(dialog, entry);
    dialog.classList.remove('closing'); dialog.classList.add('motion-dialog');
    // Show immediately: browser top-layer focus and inertness remain native.
    if (!dialog.open) dialog.showModal();
    if (keyboard || reduced.matches) { entry.phase = 'open'; return; }
    const to = dialog.getBoundingClientRect(), from = sourceRect(entry);
    entry.animations = [
      play(dialog, [current || { ...(from ? folded(from, to) : { transform: 'translateY(16px) scale(.95)' }), opacity: 0 }, rest], { duration: 440, easing: spring }),
      play(dialog, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out', pseudoElement: '::backdrop' }),
    ];
    Promise.all(entry.animations.map(a => a?.finished.catch(() => {}))).then(() => {
      if (dialogs.get(dialog) === entry) entry.phase = 'open';
    });
  }
  function closeDialog(dialog, value) {
    if (!dialog.open) return Promise.resolve();
    const previous = dialogs.get(dialog);
    if (previous?.phase === 'closing') return previous.done;
    const current = { transform: getComputedStyle(dialog).transform, clipPath: getComputedStyle(dialog).clipPath, opacity: getComputedStyle(dialog).opacity };
    stop(previous);
    const entry = { phase: 'closing', animations: [], source: previous?.source };
    dialogs.set(dialog, entry);
    const finish = () => {
      if (dialogs.get(dialog) !== entry) return;
      stop(entry); dialogs.delete(dialog); dialog.close(value);
    };
    if (keyboard || reduced.matches) { finish(); return Promise.resolve(); }
    const to = dialog.getBoundingClientRect(), from = sourceRect(entry);
    entry.animations = [
      play(dialog, [current, { ...(from ? folded(from, to) : { transform: 'translateY(10px) scale(.97)' }), opacity: 0 }], { duration: 220, easing: ease, fill: 'forwards' }),
      play(dialog, [{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease-out', fill: 'forwards', pseudoElement: '::backdrop' }),
    ];
    // Animation completion, cancellation and a safety deadline all converge here.
    let timer;
    entry.done = Promise.race([
      Promise.all(entry.animations.map(a => a?.finished.catch(() => {}))),
      new Promise(resolve => { timer = setTimeout(resolve, 450); }),
    ]).then(() => { clearTimeout(timer); finish(); });
    return entry.done;
  }
  document.addEventListener('cancel', event => {
    if (event.target.matches('dialog')) { event.preventDefault(); closeDialog(event.target); }
  }, true);
  document.addEventListener('close', event => {
    if (event.target.matches('dialog') && !event.target.open) { stop(dialogs.get(event.target)); dialogs.delete(event.target); }
  }, true);

  // Small anchored menu. The exit copy never receives focus or file drops.
  let menu, trigger, menuAnimation, menuReturnFocus;
  function hideMenu(returnFocus = false) {
    if (!menu || menu.hidden) return;
    const drawn = getComputedStyle(menu), start = { opacity: drawn.opacity, transform: drawn.transform };
    menuAnimation?.cancel();
    if (!keyboard && !reduced.matches) {
      const rect = menu.getBoundingClientRect(), ghost = menu.cloneNode(true);
      ghost.removeAttribute('id'); ghost.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
      ghost.classList.add('menu-ghost'); ghost.inert = true; ghost.setAttribute('aria-hidden', 'true');
      Object.assign(ghost.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px' }); document.body.append(ghost);
      const a = play(ghost, [start, { opacity: 0, transform: 'translateY(-4px) scale(.96)' }], { duration: 150, easing: ease, fill: 'forwards' });
      const timer = setTimeout(() => ghost.remove(), 300); a?.finished.catch(() => {}).then(() => { clearTimeout(timer); ghost.remove(); });
    }
    menu.hidden = true; trigger?.setAttribute('aria-expanded', 'false');
    if (returnFocus) menuReturnFocus?.focus({ preventScroll: true });
  }
  function showMenu(button) {
    if (!menu) menu = document.getElementById('quick-actions-menu');
    if (!menu) return;
    if (!menu.hidden) { hideMenu(true); return; }
    trigger = button; menuReturnFocus = button; menu.hidden = false; trigger.setAttribute('aria-expanded', 'true');
    const r = button.getBoundingClientRect(), w = menu.offsetWidth, h = menu.offsetHeight;
    const x = Math.max(8, Math.min(innerWidth - w - 8, r.right - w));
    const below = r.bottom + 6 + h <= innerHeight - 8;
    const y = below ? r.bottom + 6 : Math.max(8, r.top - h - 6);
    Object.assign(menu.style, { left: x + 'px', top: y + 'px', transformOrigin: `${Math.max(0, Math.min(w, r.left + r.width / 2 - x))}px ${below ? 'top' : 'bottom'}` });
    if (!keyboard && !reduced.matches) menuAnimation = play(menu, [{ opacity: 0, transform: `translateY(${below ? -6 : 6}px) scale(.94)` }, { opacity: 1, transform: 'none' }], { duration: 240, easing: ease });
    menu.querySelector('button')?.focus({ preventScroll: true });
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('#quick-actions');
    if (button) { showMenu(button); return; }
    if (!menu || menu.hidden) return;
    const item = event.target.closest('[data-menu-action]');
    if (item) {
      hideMenu(true);
      if (item.dataset.menuAction === 'shelf') window.shelf?.show();
      else if (item.dataset.menuAction === 'commands') window.cmdkShow?.();
    } else if (!menu.contains(event.target) || event.target.closest('[role=menuitem]')) hideMenu(!!menu.contains(event.target));
  });
  document.addEventListener('keydown', event => {
    if (event.target.closest('#quick-actions') && event.key === 'ArrowDown' && (!menu || menu.hidden)) {
      event.preventDefault(); showMenu(event.target.closest('#quick-actions')); return;
    }
    if (!menu || menu.hidden) return;
    const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
    if (event.key === 'Escape' || event.key === 'Tab') { hideMenu(event.key === 'Escape'); if (event.key === 'Escape') event.preventDefault(); }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const i = buttons.indexOf(document.activeElement), d = event.key === 'ArrowUp' ? -1 : 1;
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (i + d + buttons.length) % buttons.length]?.focus();
    }
  });
  window.addEventListener('resize', () => { hideMenu(); syncNavigation(true); syncSegments(); });
  document.addEventListener('scroll', () => hideMenu(), { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => { hideMenu(); syncNavigation(true); });
  reduced.addEventListener('change', () => {
    document.querySelectorAll('[data-motion-key]').forEach(el=>layoutAnimations.get(el)?.cancel());
    document.querySelectorAll('#view,.nav-sub,.nav-sub button,.subnav-highlight').forEach(el=>el.getAnimations().forEach(a=>a.cancel()));
    if(reduced.matches){document.documentElement.classList.remove('theming');document.querySelectorAll('.nav-sub.leaving').forEach(el=>el.remove());}
    syncNavigation(true); syncSegments(); hideMenu();
    document.querySelectorAll('dialog[open]').forEach(d => {
      const entry = dialogs.get(d); if (entry?.phase === 'closing') closeImmediately(d); else stop(entry);
    });
  });
  function closeImmediately(d) { const entry = dialogs.get(d); stop(entry); dialogs.delete(d); d.close(); }
  const pageAnimations = new WeakMap();
  let pageSwapToken = 0;
  function transitionPage(element, subsection = false) {
    pageAnimations.get(element)?.cancel();
    if (keyboard || reduced.matches || document.hidden) return;
    // Magpie side-nav pages fade; inner content swaps enter from 2px below.
    const animation=play(element,subsection?[{opacity:.5,transform:'translateY(2px)'},{opacity:1,transform:'none'}]:[{opacity:0},{opacity:1}],{duration:subsection?220:240,easing:'cubic-bezier(.2,.8,.2,1)'});
    if(animation)pageAnimations.set(element,animation);
  }
  async function swapPage(element, renderPage, { subsection = false } = {}) {
    const token = ++pageSwapToken;
    pageAnimations.get(element)?.cancel();
    if (keyboard || reduced.matches || document.hidden || !element.getClientRects().length) {
      renderPage();
      // Only main page switches restart from the top; subsection swaps keep the reading position.
      if (!subsection) { element.scrollTop = 0; document.scrollingElement.scrollTop = 0; }
      return;
    }
    const drawn = getComputedStyle(element);
    const exit = play(element, [
      { opacity: drawn.opacity, transform: drawn.transform === 'none' ? 'none' : drawn.transform },
      { opacity: subsection ? .5 : 0, transform: subsection ? 'none' : 'translateY(-4px)' },
    ], { duration: subsection ? 120 : 140, easing: ease, fill: 'forwards' });
    if (exit) pageAnimations.set(element, exit);
    try { await Promise.race([exit?.finished, new Promise(resolve => setTimeout(resolve, subsection ? 160 : 180))]); }
    catch { /* A newer swap can cancel this exit. */ }
    if (token !== pageSwapToken) return;
    exit?.cancel();
    renderPage();
    if (!subsection) { element.scrollTop = 0; document.scrollingElement.scrollTop = 0; }
    const entry = play(element, [
      { opacity: subsection ? .5 : 0, transform: subsection ? 'translateY(2px)' : 'translateY(6px)' },
      { opacity: 1, transform: 'none' },
    ], { duration: subsection ? 220 : 240, easing: 'cubic-bezier(.2,.8,.2,1)' });
    if (entry) pageAnimations.set(element, entry);
  }
  // Shared controls keep their screen-space position across a synchronous layout change.
  const layoutAnimations = new WeakMap();
  function relayout(container, change) {
    if(!container){change();return;}
    const rects=new Map();
    container.querySelectorAll('[data-motion-key]').forEach(el=>{
      if(el.getClientRects().length)rects.set(el.dataset.motionKey,el.getBoundingClientRect());
    });
    container.querySelectorAll('[data-motion-key]').forEach(el=>layoutAnimations.get(el)?.cancel());
    change();
    if(keyboard||reduced.matches||document.hidden)return;
    container.querySelectorAll('[data-motion-key]').forEach(el=>{
      if(!el.getClientRects().length)return;
      const from=rects.get(el.dataset.motionKey),to=el.getBoundingClientRect();
      const frames=from?[{transform:`translate(${from.left-to.left}px,${from.top-to.top}px)`},{transform:'none'}]:[{opacity:0,transform:'translateY(2px)'},{opacity:1,transform:'none'}];
      const animation=play(el,frames,{duration:280,easing:'cubic-bezier(.2,.8,.2,1)'});
      if(animation)layoutAnimations.set(el,animation);
    });
  }
  function revealSubnavigation(element) {
    if (keyboard || reduced.matches || document.hidden) return;
    const css=getComputedStyle(element),navEase='cubic-bezier(.32,.72,0,1)';
    element.classList.add('moving');
    const animation=play(element,[{height:'0px',marginTop:'0px',marginBottom:'0px',opacity:0},{height:element.offsetHeight+'px',marginTop:css.marginTop,marginBottom:css.marginBottom,opacity:1}],{duration:300,easing:navEase});
    animation?.finished.catch(()=>{}).finally(()=>element.classList.remove('moving'));
    element.querySelectorAll('button').forEach((row,i)=>play(row,[{opacity:0,transform:'translateY(-6px)'},{opacity:1,transform:'none'}],{duration:260,delay:40+Math.min(i,12)*20,easing:navEase,fill:'backwards'}));
    play(element.querySelector('.subnav-highlight'),[{opacity:0},{opacity:1}],{duration:200,delay:80,fill:'backwards'});
  }
  function hideSubnavigation(element) {
    element.inert=true;element.classList.add('leaving');element.removeAttribute('id');
    element.querySelectorAll('[role=tab]').forEach(row=>{row.removeAttribute('data-subnav');row.tabIndex=-1;});
    if(keyboard||reduced.matches||document.hidden){element.remove();return;}
    const css=getComputedStyle(element);element.classList.add('moving');
    const animation=play(element,[{height:element.offsetHeight+'px',marginTop:css.marginTop,marginBottom:css.marginBottom,opacity:1},{height:'0px',marginTop:'0px',marginBottom:'0px',opacity:0}],{duration:240,easing:'cubic-bezier(.32,.72,0,1)',fill:'forwards'});
    if(!animation){element.remove();return;}
    const deadline=setTimeout(()=>element.remove(),320);
    animation.finished.catch(()=>{}).finally(()=>{clearTimeout(deadline);element.remove();});
  }
  window.uiMotion = { adoptSegment, relayout, openDialog, closeDialog, syncNavigation, syncSegments, hideMenu, transitionPage, swapPage, revealSubnavigation, hideSubnavigation };
  syncSegments();
})();
