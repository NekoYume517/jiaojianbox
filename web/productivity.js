'use strict';
/* Search, recycle, templates and safe local file preview. */
(() => {
  const typeLabels = { message: '通知', task: '待办', file: '文件', collection: '收集记录', 'collection-file': '收集附件' };
  const typeIcons = { message: 'inbox', task: 'check', file: 'file', collection: 'share', 'collection-file': 'file' };
  let searchTimer = 0;
  let searchKind = 'all';
  let searchGeneration = 0;
  let recycleKind = 'all';
  let previewURL = '';
  let templateTasks = [];

  function ensureDialog(id, className = 'product-dialog') {
    let dialog = document.getElementById(id);
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = id;
    dialog.className = className;
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      uiMotion.closeDialog(dialog);
    });
    dialog.addEventListener('close', () => {
      if (id === 'file-preview-dialog') releasePreviewURL();
    });
    document.body.append(dialog);
    return dialog;
  }

  function close(dialog) {
    return uiMotion.closeDialog(dialog);
  }

  function openThen(dialog, callback) {
    return Promise.resolve(uiMotion.openDialog(dialog)).then(callback);
  }

  function resultRow(item) {
    return `<button class="product-row" data-search-result="${esc(item.type)}" data-id="${esc(item.id)}" data-share-id="${esc(item.share_id || '')}" data-file-name="${esc(item.title || '')}">
      <span class="product-row-icon" data-kind="${esc(item.type)}">${icon(typeIcons[item.type] || 'file')}</span>
      <span class="product-row-copy"><span class="pill-row">${tag(typeLabels[item.type] || item.type, item.type === 'task' ? 'blue' : item.type === 'collection' ? 'green' : '')}${item.status ? tag(states[item.status]?.[0] || item.status) : ''}</span><strong>${esc(item.title || '未命名')}</strong><small>${esc(item.snippet || '')}</small></span>
      <time>${esc(item.created_at ? formatDate(item.created_at) : '')}</time>
    </button>`;
  }

  function searchShell(dialog) {
    dialog.innerHTML = `<div class="dialog-heading"><div><div class="eyebrow">全局搜索</div><h2>在工作空间里查找</h2></div><button type="button" class="icon-button" data-product-close aria-label="关闭">×</button></div>
      <div class="product-filterbar">
        <div class="chart-mode" id="global-search-types" role="tablist" aria-label="搜索内容类型">
          ${[['all', '全部'], ['message', '通知'], ['task', '待办'], ['file', '文件'], ['collection', '收集记录']].map(([id, label]) => `<button type="button" role="tab" data-search-kind="${id}" aria-selected="${searchKind === id}" tabindex="${searchKind === id ? 0 : -1}" class="${searchKind === id ? 'active' : ''}">${label}</button>`).join('')}
        </div>
        <label class="search product-search"><span>${icon('search')}</span><input id="global-search-input" type="search" autocomplete="off" placeholder="搜索通知原文、待办、文件名或提交内容" aria-label="搜索全部内容"></label>
        <div class="product-search-meta"><label>消息来源<select id="global-search-source"><option value="all">全部</option><option value="qq">QQ</option><option value="wechat">微信</option><option value="manual">手动</option></select></label><label>开始日期<input id="global-search-from" type="date"></label><label>结束日期<input id="global-search-to" type="date"></label></div>
      </div>
      <div class="dialog-body product-results" id="global-search-results"><div class="product-empty">输入关键词后搜索整个工作空间。快捷键 Ctrl Shift F。</div></div>`;
  }

  async function runSearch(dialog) {
    const input = dialog.querySelector('#global-search-input');
    const results = dialog.querySelector('#global-search-results');
    const q = input?.value.trim() || '';
    if (!q || !state.session) {
      results.innerHTML = '<div class="product-empty">输入关键词后搜索通知、待办、文件、收集记录和收集附件。</div>';
      return;
    }
    const generation = ++searchGeneration;
    results.setAttribute('aria-busy', 'true');
    results.innerHTML = '<div class="product-loading"><i></i>正在搜索整个工作空间…</div>';
    const params = new URLSearchParams({ q, type: searchKind, source: dialog.querySelector('#global-search-source').value, limit: '100' });
    const from = dialog.querySelector('#global-search-from').value;
    const to = dialog.querySelector('#global-search-to').value;
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    try {
      const out = await api('/api/search?' + params.toString());
      if (generation !== searchGeneration || !dialog.open) return;
      results.innerHTML = out.items?.length
        ? `<div class="product-result-head"><strong>${out.items.length} 项结果</strong><span>${esc(q)}</span></div><div class="product-list">${out.items.map(resultRow).join('')}</div>`
        : `<div class="product-empty">${icon('search')}<strong>没有找到匹配内容</strong><span>可以换一个关键词，或放宽类型与日期筛选。</span></div>`;
    } catch (error) {
      if (generation === searchGeneration) results.innerHTML = `<div class="product-empty"><strong>搜索未完成</strong><span>${esc(error.message)}</span></div>`;
    } finally {
      results.removeAttribute('aria-busy');
    }
  }

  function openSearch() {
    const dialog = ensureDialog('global-search-dialog');
    searchKind = 'all';
    searchShell(dialog);
    openThen(dialog, () => {
      dialog.querySelector('#global-search-input')?.focus();
      uiMotion.syncSegments(dialog);
    });
  }

  function recycleRow(item) {
    return `<article class="product-row recycle-row" data-recycle-kind="${esc(item.kind)}" data-id="${esc(item.id)}">
      <span class="product-row-icon" data-kind="${esc(item.kind)}">${icon(item.kind === 'task' ? 'check' : item.kind === 'message' ? 'inbox' : 'file')}</span>
      <span class="product-row-copy"><span class="pill-row">${tag(item.kind === 'task' ? '待办' : item.kind === 'message' ? '通知' : '文件', item.kind === 'task' ? 'blue' : '')}</span><strong>${esc(item.title)}</strong><small>${esc(item.snippet || '')}</small></span>
      <span class="recycle-expiry">${esc(formatDate(item.expires_at))} 前可恢复</span>
      <span class="product-row-actions"><button class="secondary" data-recycle-restore>恢复</button><button class="plain-button danger-button" data-recycle-delete>永久删除</button></span>
    </article>`;
  }

  async function loadRecycle(dialog) {
    const host = dialog.querySelector('#recycle-list');
    if (!host) return;
    host.innerHTML = '<div class="product-loading"><i></i>正在读取回收站…</div>';
    try {
      const out = await api('/api/recycle');
      const rows = (out.items || []).filter(item => recycleKind === 'all' || item.kind === recycleKind);
      host.innerHTML = rows.length ? `<div class="product-list">${rows.map(recycleRow).join('')}</div>` : `<div class="product-empty">${icon('file')}<strong>回收站是空的</strong><span>删除的通知、待办和独立附件会在这里保留 ${out.retention_days} 天。</span></div>`;
      dialog.querySelectorAll('[data-recycle-kind-filter]').forEach(button => {
        const active = button.dataset.recycleKindFilter === recycleKind;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
      });
      uiMotion.syncSegments(dialog);
    } catch (error) {
      host.innerHTML = `<div class="product-empty"><strong>无法读取回收站</strong><span>${esc(error.message)}</span></div>`;
    }
  }

  function openRecycle() {
    if (!state.session) return;
    const dialog = ensureDialog('recycle-dialog');
    recycleKind = 'all';
    dialog.innerHTML = `<div class="dialog-heading"><div><div class="eyebrow">回收站</div><h2>删除内容保留 30 天</h2></div><button type="button" class="icon-button" data-product-close aria-label="关闭">×</button></div>
      <div class="product-filterbar"><div class="chart-mode" role="tablist" aria-label="回收站类型">${[['all', '全部'], ['task', '待办'], ['message', '通知'], ['file', '文件']].map(([id, label]) => `<button type="button" role="tab" data-recycle-kind-filter="${id}" aria-selected="${id === 'all'}" tabindex="${id === 'all' ? 0 : -1}" class="${id === 'all' ? 'active' : ''}">${label}</button>`).join('')}</div><p class="helper">恢复会保留原有待办、附件、通知和关联记录。永久删除无法撤销。</p></div>
      <div class="dialog-body product-results" id="recycle-list"><div class="product-loading"><i></i>正在读取回收站…</div></div>`;
    openThen(dialog, () => loadRecycle(dialog));
  }

  function templateRow(item) {
    return `<article class="product-row template-row" data-template-id="${esc(item.id)}">
      <span class="product-row-icon" data-kind="task">${icon('check')}</span>
      <span class="product-row-copy"><span class="pill-row">${tag('模板', 'blue')}${item.repeat_rule?.enabled ? tag('自动重复', 'green') : ''}</span><strong>${esc(item.name)}</strong><small>${esc(item.description || '按模板创建待办，可继续调整内容和日期。')}</small></span>
      <span class="product-row-actions"><button class="secondary" data-template-use>使用</button><button class="plain-button danger-button" data-template-delete>删除</button></span>
    </article>`;
  }

  async function loadTemplates(dialog) {
    const host = dialog.querySelector('#template-list');
    if (!host) return;
    host.innerHTML = '<div class="product-loading"><i></i>正在读取模板…</div>';
    try {
      const [templates, refresh] = await Promise.all([api('/api/templates'), api('/api/snapshot')]);
      templateTasks = (refresh.tasks || []).filter(task => !task.id.startsWith('local:'));
      host.innerHTML = templates.templates?.length ? `<div class="product-list">${templates.templates.map(templateRow).join('')}</div>` : `<div class="product-empty">${icon('check')}<strong>还没有待办模板</strong><span>把常用作业、周报或表单保存为模板，下次直接生成。</span></div>`;
      const select = dialog.querySelector('#template-task');
      if (select) select.innerHTML = templateTasks.length ? templateTasks.map(task => `<option value="${esc(task.id)}">${esc(task.title)}</option>`).join('') : '<option value="">暂无可保存的待办</option>';
      if (dialog.dataset.preselect && templateTasks.some(task => task.id === dialog.dataset.preselect)) select.value = dialog.dataset.preselect;
    } catch (error) {
      host.innerHTML = `<div class="product-empty"><strong>无法读取模板</strong><span>${esc(error.message)}</span></div>`;
    }
  }

  function openTemplates(preselect = '') {
    if (!state.session) return;
    const dialog = ensureDialog('template-dialog');
    dialog.dataset.preselect = preselect;
    dialog.innerHTML = `<div class="dialog-heading"><div><div class="eyebrow">待办模板</div><h2>重复的事，一次设置</h2></div><button type="button" class="icon-button" data-product-close aria-label="关闭">×</button></div>
      <div class="dialog-body template-surface">
        <section class="template-create"><div><h3>从现有待办创建</h3><p class="helper">保存材料清单、命名规则、提交入口和重复周期，不影响原待办。</p></div><div class="form-grid"><label>模板名称<input id="template-name" maxlength="100" placeholder="例如：每周课程作业"></label><label>来源待办<select id="template-task"></select></label></div><button class="primary" data-template-create>保存为模板</button></section>
        <div class="section-heading"><h3>已保存模板</h3><small class="helper">使用后可继续修改</small></div><div id="template-list"><div class="product-loading"><i></i>正在读取模板…</div></div>
      </div>`;
    openThen(dialog, async () => {
      await loadTemplates(dialog);
      dialog.querySelector('#template-name')?.focus({ preventScroll: true });
    });
  }

  function releasePreviewURL() {
    if (previewURL) URL.revokeObjectURL(previewURL);
    previewURL = '';
  }

  async function openPreview(fileId, name = '') {
    if (!fileId || !state.session) return;
    const dialog = ensureDialog('file-preview-dialog', 'product-dialog preview-dialog');
    releasePreviewURL();
    dialog.innerHTML = `<div class="dialog-heading"><div><div class="eyebrow">文件预览</div><h2>${esc(name || '正在读取文件')}</h2></div><div class="preview-heading-actions"><button class="secondary" data-preview-download>下载原文件</button><button type="button" class="icon-button" data-product-close aria-label="关闭">×</button></div></div><div class="dialog-body preview-surface" id="preview-content"><div class="product-loading"><i></i>正在安全加载预览…</div></div>`;
    dialog.querySelector('[data-preview-download]').onclick = () => saveDownload('/api/files/' + encodeURIComponent(fileId), name || 'file');
    await uiMotion.openDialog(dialog);
    try {
      const response = await fetch(apiUrl('/api/files/' + encodeURIComponent(fileId) + '/preview'), { headers: { Authorization: 'Bearer ' + state.session.token } });
      if (!response.ok) {
        let detail = '无法预览此文件';
        try { const body = await response.json(); detail = typeof body.detail === 'string' ? body.detail : body.detail?.message || detail; } catch {}
        throw new Error(detail);
      }
      const type = response.headers.get('content-type') || '';
      const host = dialog.querySelector('#preview-content');
      if (!host || !dialog.open) return;
      if (type.includes('application/json')) {
        const value = await response.json();
        host.innerHTML = `<pre class="office-preview">${esc(value.text || '')}</pre>`;
        return;
      }
      const blob = await response.blob();
      previewURL = URL.createObjectURL(blob);
      if (type.startsWith('image/')) host.innerHTML = `<img class="image-preview" src="${previewURL}" alt="${esc(name)}">`;
      else if (type.startsWith('video/')) host.innerHTML = `<video class="media-preview" src="${previewURL}" controls playsinline></video>`;
      else if (type.startsWith('audio/')) host.innerHTML = `<div class="audio-preview">${icon('file')}<audio src="${previewURL}" controls></audio></div>`;
      else if (type === 'application/pdf') host.innerHTML = `<iframe class="pdf-preview" src="${previewURL}" title="${esc(name)}"></iframe>`;
      else {
        const text = await blob.text();
        host.innerHTML = `<pre class="text-preview">${esc(text)}</pre>`;
      }
    } catch (error) {
      const host = dialog.querySelector('#preview-content');
      if (host) host.innerHTML = `<div class="product-empty"><strong>不能预览此文件</strong><span>${esc(error.message)}</span><button class="secondary" data-preview-download-fallback>下载原文件</button></div>`;
      dialog.querySelector('[data-preview-download-fallback]')?.addEventListener('click', () => saveDownload('/api/files/' + encodeURIComponent(fileId), name || 'file'));
    }
  }

  async function openCollectionResult(shareId) {
    if (!shareId) return;
    await navigate('shares');
    await window.shares?.mount();
    const share = (state.snapshot.shares || []).find(item => item.id === shareId);
    if (share) window.collectionStudio?.open(share);
  }

  async function openResult(button) {
    const type = button.dataset.searchResult;
    const id = button.dataset.id;
    if (type === 'task') {
      await close(button.closest('dialog'));
      return window.jjbOpenTask(id);
    }
    if (type === 'message') {
      await close(button.closest('dialog'));
      state.page = 'inbox';
      state.selected = id;
      return render();
    }
    if (type === 'file' || type === 'collection-file') {
      return openPreview(id, button.dataset.fileName);
    }
    if (type === 'collection') {
      await close(button.closest('dialog'));
      return openCollectionResult(button.dataset.shareId);
    }
  }

  function decorate() {
    const actions = document.querySelector('.task-detail-grid .small-actions');
    if (actions && !actions.querySelector('[data-productivity-action="save-template"]')) {
      const taskId = state.taskId;
      actions.querySelector('[data-action="delete-task"]')?.replaceChildren(document.createTextNode('移入回收站'));
      actions.insertAdjacentHTML('afterbegin', `<button class="plain-button" data-productivity-action="save-template" data-task-id="${esc(taskId || '')}">保存为模板</button>`);
    }
    const side = document.querySelector('.task-side');
    if (side && state.taskId && !side.querySelector('[data-repeat-summary]')) {
      const task = state.snapshot.tasks.find(item => item.id === state.taskId);
      if (task?.repeat_rule?.enabled) {
        const label = { daily: '天', weekly: '周', monthly: '月' }[task.repeat_rule.frequency] || '周';
        side.querySelector('.info-label')?.insertAdjacentHTML('beforebegin', `<div class="repeat-summary" data-repeat-summary><span class="info-label">自动重复</span><div class="info-value">每 ${task.repeat_rule.interval || 1} ${label} · 提交后生成下一次</div></div>`);
      }
    }
  }

  document.addEventListener('click', async event => {
    const closeButton = event.target.closest('[data-product-close]');
    if (closeButton) return close(closeButton.closest('dialog'));
    const action = event.target.closest('[data-productivity-action]');
    if (action) {
      event.preventDefault();
      if (action.dataset.productivityAction === 'search') return openSearch();
      if (action.dataset.productivityAction === 'recycle') return openRecycle();
      if (action.dataset.productivityAction === 'templates') return openTemplates();
      if (action.dataset.productivityAction === 'save-template') return openTemplates(action.dataset.taskId);
    }
    const preview = event.target.closest('[data-preview-file],[data-shelf-preview]');
    if (preview) return openPreview(preview.dataset.previewFile || preview.dataset.shelfPreview, preview.dataset.name || '');
    const kind = event.target.closest('[data-search-kind]');
    if (kind) {
      searchKind = kind.dataset.searchKind;
      const dialog = kind.closest('dialog');
      dialog.querySelectorAll('[data-search-kind]').forEach(button => {
        const active = button === kind;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
      });
      uiMotion.syncSegments(dialog);
      return runSearch(dialog);
    }
    const result = event.target.closest('[data-search-result]');
    if (result) return openResult(result);
    const recycleFilter = event.target.closest('[data-recycle-kind-filter]');
    if (recycleFilter) {
      recycleKind = recycleFilter.dataset.recycleKindFilter;
      return loadRecycle(recycleFilter.closest('dialog'));
    }
    const row = event.target.closest('.recycle-row');
    if (row && (event.target.closest('[data-recycle-restore]') || event.target.closest('[data-recycle-delete]'))) {
      const restore = !!event.target.closest('[data-recycle-restore]');
      if (!restore && !confirm('永久删除后将无法恢复，确定继续吗？')) return;
      const button = event.target.closest('button');
      button.disabled = true;
      try {
        const route = `/api/recycle/${encodeURIComponent(row.dataset.recycleKind)}/${encodeURIComponent(row.dataset.id)}` + (restore ? '/restore' : '');
        await api(route, restore ? 'POST' : 'DELETE', restore ? {} : undefined);
        toast(restore ? '内容已恢复' : '内容已永久删除');
        await refresh({ renderPage: false });
        await loadRecycle(row.closest('dialog'));
      } catch (error) {
        toast(error.message);
        button.disabled = false;
      }
      return;
    }
    const create = event.target.closest('[data-template-create]');
    if (create) {
      const dialog = create.closest('dialog');
      const name = dialog.querySelector('#template-name').value.trim();
      const taskId = dialog.querySelector('#template-task').value;
      if (!name || !taskId) return toast('请选择待办并填写模板名称');
      create.disabled = true;
      try {
        await api('/api/templates', 'POST', { name, task_id: taskId });
        dialog.querySelector('#template-name').value = '';
        toast('模板已保存');
        await loadTemplates(dialog);
      } catch (error) { toast(error.message); }
      finally { create.disabled = false; }
      return;
    }
    const templateRow = event.target.closest('.template-row');
    if (templateRow && event.target.closest('[data-template-use],[data-template-delete]')) {
      const id = templateRow.dataset.templateId;
      const use = !!event.target.closest('[data-template-use]');
      if (!use && !confirm('删除这个模板？已创建的待办不会受影响。')) return;
      try {
        if (use) {
          const task = await api(`/api/templates/${encodeURIComponent(id)}/instantiate`, 'POST', {});
          const dialog = templateRow.closest('dialog');
          await close(dialog);
          await refresh({ renderPage: false });
          state.page = 'tasks'; state.taskId = task.id; render();
          toast('已从模板创建待办');
        } else {
          await api(`/api/templates/${encodeURIComponent(id)}`, 'DELETE');
          await loadTemplates(templateRow.closest('dialog'));
          toast('模板已删除');
        }
      } catch (error) { toast(error.message); }
    }
  });

  document.addEventListener('input', event => {
    if (event.target.id === 'global-search-input') {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch(event.target.closest('dialog')), 260);
    }
    if (event.target.id === 'task-repeat') {
      const options = document.querySelector('#task-repeat-options');
      if (options) options.hidden = !event.target.checked;
    }
  });
  document.addEventListener('change', event => {
    if (['global-search-source', 'global-search-from', 'global-search-to'].includes(event.target.id)) runSearch(event.target.closest('dialog'));
  });
  document.addEventListener('click', event => {
    const repeat = event.target.closest('[data-repeat-frequency]');
    if (!repeat) return;
    const group = repeat.closest('#task-repeat-frequency');
    group.querySelectorAll('[data-repeat-frequency]').forEach(button => {
      const active = button === repeat;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    uiMotion.syncSegments(group);
  });

  addEventListener('workspace-render', () => requestAnimationFrame(decorate));
  addEventListener('beforeunload', releasePreviewURL);
  document.getElementById('global-search')?.addEventListener('click', openSearch);
  window.productivity = { open: kind => kind === 'search' ? openSearch() : kind === 'templates' ? openTemplates() : kind === 'recycle' ? openRecycle() : openPreview(kind), preview: openPreview, search: openSearch, recycle: openRecycle, templates: openTemplates };
})();
