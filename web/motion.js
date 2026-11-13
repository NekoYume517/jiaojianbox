/* Canonical contract: docs/ui-motion-standard.md.  Behavior follows Magpie's continuity principles (MIT; see THIRD_PARTY_NOTICES).
   Main workspace only: quick.html deliberately does not load this module. */
(() => {
  'use strict';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const ease = 'cubic-bezier(.23,1,.32,1)';
  const spring = CSS.supports('animation-timing-function', 'linear(0,1)')
    ? 'linear(0,.0203,.0723,.1448,.2292,.3188,.4086,.4951,.576,.6498,.7157,.7735,.8232,.8654,.9005,.9293,.9525,.9708,.9849,.9956,1.0033,1.0087,1.0122,1.0142,1.015,1.0151,1.0146,1.0136,1.0124,1.0111,1.0097,1.0084,1.0071,1.0059,1.0049,1.0039,1.0031,1.0024,1.0018,1.0013,1)'
    : 'cubic-bezier(.2,.9,.25,1.02)';
  const modalMotion = {
    open: { from: { opacity: 0, transform: 'translateY(16px) scale(.95)' }, duration: 440, easing: spring },
    close: { to: { opacity: 0, transform: 'translateY(10px) scale(.97)' }, duration: 220, easing: ease },
    backdrop: { openDuration: 220, closeDuration: 180 },
  };
  let keyboard = true, pressed = null;
  const dialogs = new WeakMap(), surfaces = new WeakMap(), segments = new WeakMap();
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

  // Segment boxes are rebuilt by page renders and dialog repaints; the moving
  // highlight survives by remembering the last resting rect per logical tab
  // group and flying from it, the way Magpie's selection never teleports.
  const segmentMemory = new Map();
  const segmentKey = box => box.dataset.selectFor || box.id
    || (box.getAttribute('aria-label') ? 'label:' + box.getAttribute('aria-label') : [...box.classList].join('.'));
  function rememberSegment(box, entry) {
    if (entry.animations.length) return;
    const rect = entry.thumb.getBoundingClientRect();
    if (!rect.width || !box.getClientRects().length) return;
    if (segmentMemory.size > 60) {
      let oldest = null;
      for (const [key, value] of segmentMemory) if (!oldest || value.at < oldest[1].at) oldest = [key, value];
      if (oldest) segmentMemory.delete(oldest[0]);
    }
    segmentMemory.set(segmentKey(box), { rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, at: performance.now() });
  }
  function syncSegments() {
    document.querySelectorAll('.theme-picker,.page-tabs,.chart-mode,.trigger-origin-list').forEach(box => {
      const selected = box.querySelector('button.active,button[aria-selected=true]');
      if (!selected?.offsetWidth || !box.getClientRects().length) return;
      let entry = segments.get(box);
      const fresh = !entry;
      if (!entry || !entry.thumb.isConnected) {
        // Page-level tab strips keep the same container while replacing their
        // buttons. Reinsert the shared highlight when its old node was cleared;
        // otherwise the segment map points at a detached thumb and every later
        // tab change loses both the highlight and its transition.
        const thumb = entry?.thumb || document.createElement('span');
        if (!thumb.className) thumb.className = 'segment-highlight';
        if (!thumb.hasAttribute('aria-hidden')) thumb.setAttribute('aria-hidden', 'true');
        if (entry) {
          stop(entry);
          entry.animations = [];
          entry.selected = null;
          entry.to = null;
        } else {
          entry = { thumb, selected: null, animations: [], to: null };
          segments.set(box, entry);
        }
        box.prepend(thumb);
        box.classList.add('motion-segment');
      }
      const before = entry.thumb.style.width ? getComputedStyle(entry.thumb) : null;
      const from = before && { transform: before.transform, width: before.width, height: before.height };
      const boxRect = box.getBoundingClientRect(), selectedRect = selected.getBoundingClientRect();
      const x = box.matches('.trigger-origin-list') ? selectedRect.left - boxRect.left + box.scrollLeft : selected.offsetLeft;
      const y = box.matches('.trigger-origin-list') ? selectedRect.top - boxRect.top + box.scrollTop : selected.offsetTop;
      const to = { transform: `translate(${x}px,${y}px)`, width: selected.offsetWidth + 'px', height: selected.offsetHeight + 'px' };
      if(entry.selected===selected && entry.to && Object.entries(to).every(([key,value])=>entry.to[key]===value)){if(keyboard||reduced.matches||document.hidden)stop(entry);rememberSegment(box,entry);return;}
      stop(entry);entry.animations=[];
      Object.assign(entry.thumb.style, to);
      entry.to = to;
      if (from && entry.selected !== selected && !keyboard && !reduced.matches) entry.animations = [play(entry.thumb, [from, to], { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' })];
      else if (fresh && !keyboard && !reduced.matches && !document.hidden) {
        const memory = segmentMemory.get(segmentKey(box));
        if (memory && performance.now() - memory.at < 1200) {
          const rect = entry.thumb.getBoundingClientRect();
          if (Math.abs(memory.rect.left - rect.left) + Math.abs(memory.rect.top - rect.top) > 2) {
            entry.animations = [play(entry.thumb, [
              { transform: `translate(${selected.offsetLeft + memory.rect.left - rect.left}px,${selected.offsetTop + memory.rect.top - rect.top}px)`, width: memory.rect.width + 'px', height: memory.rect.height + 'px' },
              to,
            ], { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' })];
          }
        }
      }
      entry.selected = selected;
      if (entry.animations.length) entry.animations[0]?.finished.catch(() => {}).then(() => rememberSegment(box, entry));
      else rememberSegment(box, entry);
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
    // Some Android WebViews leave top-layer dialogs clipped to the trigger.
    // Keep native dialog semantics, but only animate opacity/translation there.
    if(window.mobile){
      dialog.style.clipPath='none';
      entry.animations=[play(dialog,[{opacity:0,transform:'translateY(8px)'},{opacity:1,transform:'none'}],{duration:240,easing:ease})];
      Promise.all(entry.animations.map(a=>a?.finished.catch(()=>{}))).then(()=>{if(dialogs.get(dialog)===entry){entry.phase='open';dialog.style.removeProperty('clip-path');}});
      return;
    }
    const to = dialog.getBoundingClientRect(), from = sourceRect(entry);
    entry.animations = [
      play(dialog, [current || (from ? { ...folded(from, to), opacity: 0 } : modalMotion.open.from), rest], { duration: modalMotion.open.duration, easing: modalMotion.open.easing }),
      play(dialog, [{ opacity: 0 }, { opacity: 1 }], { duration: modalMotion.backdrop.openDuration, easing: 'ease-out', pseudoElement: '::backdrop' }),
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
    if(window.mobile){
      entry.animations=[play(dialog,[{opacity:current.opacity,transform:'none'},{opacity:0,transform:'translateY(6px)'}],{duration:180,easing:ease})];
      let timer;
      entry.done=Promise.race([Promise.all(entry.animations.map(a=>a?.finished.catch(()=>{}))),new Promise(resolve=>{timer=setTimeout(resolve,450);})]).then(()=>{clearTimeout(timer);finish();});
      return entry.done;
    }
    const to = dialog.getBoundingClientRect(), from = sourceRect(entry);
    entry.animations = [
      play(dialog, [current, from ? { ...folded(from, to), opacity: 0 } : modalMotion.close.to], { duration: modalMotion.close.duration, easing: modalMotion.close.easing, fill: 'forwards' }),
      play(dialog, [{ opacity: 1 }, { opacity: 0 }], { duration: modalMotion.backdrop.closeDuration, easing: 'ease-out', fill: 'forwards', pseudoElement: '::backdrop' }),
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

  // Non-native modal surfaces use the same entry/exit choreography as dialogs.
  // The caller owns `hidden`; this only animates and resolves after cleanup.
  function openSurface(surface, backdrop) {
    const previous = surfaces.get(surface);
    stop(previous);
    const entry = { phase: 'opening', animations: [] };
    surfaces.set(surface, entry);
    backdrop.hidden = false;
    backdrop.classList.add('show');
    if (reduced.matches) {
      entry.phase = 'open';
      return Promise.resolve();
    }
    entry.animations = [
      play(surface, [modalMotion.open.from, { opacity: 1, transform: 'none' }], { duration: modalMotion.open.duration, easing: modalMotion.open.easing }),
      play(backdrop, [{ opacity: 0 }, { opacity: 1 }], { duration: modalMotion.backdrop.openDuration, easing: 'ease-out' }),
    ];
    entry.done = Promise.all(entry.animations.map(animation => animation?.finished.catch(() => {}))).then(() => {
      if (surfaces.get(surface) === entry) entry.phase = 'open';
    });
    return entry.done;
  }

  function closeSurface(surface, backdrop) {
    if (backdrop.hidden) return Promise.resolve();
    const previous = surfaces.get(surface);
    if (previous?.phase === 'closing') return previous.done;
    stop(previous);
    const current = getComputedStyle(surface);
    const currentBackdrop = getComputedStyle(backdrop);
    const entry = { phase: 'closing', animations: [] };
    surfaces.set(surface, entry);
    backdrop.classList.remove('show');
    if (reduced.matches) {
      surfaces.delete(surface);
      backdrop.hidden = true;
      return Promise.resolve();
    }
    entry.animations = [
      play(surface, [
        { opacity: current.opacity, transform: current.transform === 'none' ? 'none' : current.transform },
        modalMotion.close.to,
      ], { duration: modalMotion.close.duration, easing: modalMotion.close.easing, fill: 'forwards' }),
      play(backdrop, [
        { opacity: currentBackdrop.opacity },
        { opacity: 0 },
      ], { duration: modalMotion.backdrop.closeDuration, easing: 'ease-out', fill: 'forwards' }),
    ];
    let timer;
    entry.done = Promise.race([
      Promise.all(entry.animations.map(animation => animation?.finished.catch(() => {}))),
      new Promise(resolve => { timer = setTimeout(resolve, 450); }),
    ]).then(() => {
      clearTimeout(timer);
      if (surfaces.get(surface) !== entry) return;
      stop(entry);
      surfaces.delete(surface);
      backdrop.hidden = true;
    });
    return entry.done;
  }

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
  window.uiMotion = { adoptSegment, relayout, openDialog, closeDialog, openSurface, closeSurface, syncNavigation, syncSegments, hideMenu, transitionPage, swapPage, revealSubnavigation, hideSubnavigation };
  syncSegments();
})();
