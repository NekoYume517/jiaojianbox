/* Canonical Magpie segments. Native selects retain the existing form/change contract. */
(() => {
  'use strict';
  const entries = new WeakMap(), pending = new Map();
  let queued = false, nextId = 0;
  function syncSelect(select) {
    if (select.multiple || select.size > 1 || !select.options.length) return;
    let entry = entries.get(select);
    if (!entry || !entry.box.isConnected) {
      const box = document.createElement('div');
      box.className = 'chart-mode segment-choice';
      if (select.closest('.reminders-block,.statistics-controls') || select.dataset.segmentWrap === 'wrap') box.classList.add('segment-wrap');
      box.setAttribute('role', 'tablist');
      box.dataset.selectFor = select.id || select.dataset.updateInterval !== undefined && 'update-interval' || Object.entries(select.dataset).map(([key,value])=>key+':'+value).join('|') || 'choice-' + (++nextId);
      const label = select.getAttribute('aria-label') || [...(select.labels?.[0]?.childNodes || [])].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim() || '选择选项';
      box.setAttribute('aria-label', label);
      select.classList.add('segment-source');select.tabIndex = -1;select.setAttribute('aria-hidden', 'true');
      select.after(box);entry = { box, signature: '' };entries.set(select, entry);
      box.addEventListener('click', event => {
        const button = event.target.closest('[data-choice-index]');
        if (!button || button.disabled) return;
        event.preventDefault();
        const index = Number(button.dataset.choiceIndex);
        if (select.selectedIndex === index) return;
        const thumb=box.querySelector('.segment-highlight');
        if(thumb)pending.set(box.dataset.selectFor,{box,rect:thumb.getBoundingClientRect(),at:performance.now()});
        select.selectedIndex = index;
        syncSelect(select);window.uiMotion?.syncSegments();
        select.dispatchEvent(new Event('change', { bubbles: true }));
        if(box.isConnected)pending.delete(box.dataset.selectFor);
      });
      select.addEventListener('change', () => {syncSelect(select);window.uiMotion?.syncSegments();});
      select.addEventListener('invalid', event => { event.preventDefault();box.setAttribute('aria-invalid', 'true');box.querySelector('button:not(:disabled)')?.focus({ preventScroll: true }); });
    }
    const options = [...select.options];
    const signature = JSON.stringify(options.map(o => [o.value, o.label, o.disabled]));
    if (entry.signature !== signature) {
      entry.signature = signature;const thumb=entry.box.querySelector('.segment-highlight');entry.box.replaceChildren(...(thumb?[thumb]:[]));
      options.forEach((option, index) => {
        const button = document.createElement('button');button.type = 'button';button.setAttribute('role', 'tab');
        button.dataset.choiceIndex = String(index);button.textContent = option.label;button.title = option.label;
        entry.box.append(button);
      });
    }
    entry.box.querySelectorAll('button').forEach((button, index) => {
      const active = index === select.selectedIndex;
      button.classList.toggle('active', active);button.setAttribute('aria-selected', String(active));button.tabIndex = active ? 0 : -1;
      button.disabled = select.disabled || options[index].disabled;
    });
    if (select.validity.valid) entry.box.removeAttribute('aria-invalid');
    const active = entry.box.querySelector('button.active');
    if (active && entry.box.clientWidth && (active.offsetLeft < entry.box.scrollLeft || active.offsetLeft + active.offsetWidth > entry.box.scrollLeft + entry.box.clientWidth)) {
      entry.box.scrollLeft = Math.max(0, active.offsetLeft - (entry.box.clientWidth - active.offsetWidth) / 2);
    }
  }
  function sync() {
    document.querySelectorAll('#view select,dialog select,.file-shelf select').forEach(syncSelect);
    window.uiMotion?.syncSegments();
    document.querySelectorAll('.segment-choice').forEach(box=>{const previous=pending.get(box.dataset.selectFor);if(!previous)return;if(previous.box!==box&&performance.now()-previous.at<1000)window.uiMotion?.adoptSegment(box,previous.rect);pending.delete(box.dataset.selectFor);});
  }
  function schedule() { if (!queued) { queued = true;requestAnimationFrame(() => { queued = false;sync(); }); } }
  new MutationObserver(records => {
    if (records.some(r => r.target.closest?.('select') || [...r.addedNodes].some(n => n.nodeType === 1 && (n.matches('select') || n.querySelector('select'))))) schedule();
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected'] });
  window.addEventListener('workspace-render', schedule);
  window.addEventListener('appearance-changed', schedule);
  window.addEventListener('resize', schedule);
  window.formControls = { sync, schedule };sync();
})();
