'use strict';
/* 分享与收集：待办可生成公开链接或收集表单，权限与外观都在这里管理。 */
(() => {
  const audiences = { public: '公开', registered: '已登录', users: '指定用户名', self: '仅自己' };
  const accesses = { view: '仅可查看', download: '可下载文件', edit: '可修改' };
  const purposes = { view: '查看分享', collect: '收集表单' };
  const purposeNotes = {
    view: '查看分享：别人按权限浏览或下载这项待办的材料。',
    collect: '收集表单：别人按你设定的字段提交材料和说明，提交记录会自动汇总。',
  };
  const formFields = {
    'share-show-description': 'show_description',
    'share-show-due': 'show_due_at',
    'share-show-requirements': 'show_requirements',
    'share-show-naming': 'show_naming_hint',
    'share-show-files': 'show_files',
    'share-allow-material': 'allow_material',
    'share-allow-receipt': 'allow_receipt',
    'share-allow-note': 'allow_note',
  };
  const defaultForm = {
    show_description: true, show_due_at: true, show_requirements: true, show_naming_hint: true,
    show_files: false, allow_material: true, allow_receipt: false, allow_note: true, submit_message: '',
  };
  let draft = null;
  const shares = () => state.snapshot.shares || [];
  const offline = () => !state.session || state.session.mode === 'offline';

  function taskTitle(id) {
    return state.snapshot.tasks.find(t => t.id === id)?.title || '已删除的待办';
  }
  function remainText(share) {
    if (!share.expires_at) return '永久有效';
    const left = new Date(share.expires_at) - Date.now();
    if (left <= 0) return '已过期';
    const days = Math.ceil(left / 86400000);
    return days > 1 ? `${days} 天后到期` : '24 小时内到期';
  }
  function shareCard(share) {
    const collect = share.purpose === 'collect';
    const password = share.has_password ? tag('需要密码', 'orange') : '';
    const paused = share.revoked ? tag('已关闭', '') : '';
    const expired = share.expires_at && new Date(share.expires_at) < new Date() ? tag('已过期', 'red') : '';
    const url = share.url || '';
    const count = Number(share.submission_count || 0);
    return `<article class="share-card" data-share-card="${esc(share.id)}">
      <div class="share-card-head">
        <div class="share-card-title">
          <strong>${esc(share.task_title || taskTitle(share.task_id))}</strong>
          <div class="pill-row">${collect ? tag('收集表单', 'green') : tag('查看分享', 'blue')}${tag(audiences[share.audience] || '公开')}${share.purpose === 'view' ? tag(accesses[share.access] || '仅可查看') : ''}${password}${expired}${paused}</div>
        </div>
        <div class="share-card-actions">
          <button class="secondary" data-share-copy="${esc(share.id)}">复制链接</button>
          <button class="plain-button" data-share-open="${esc(share.id)}">打开</button>
          <button class="plain-button" data-share-edit="${esc(share.id)}">权限设置</button>
          <button class="plain-button danger-button" data-share-delete="${esc(share.id)}">删除</button>
        </div>
      </div>
      <div class="share-url" data-share-url="${esc(url)}" tabindex="0" role="textbox" aria-readonly="true" aria-label="分享链接">${esc(url)}</div>
      <div class="share-card-meta">
        <span>${collect ? `已收到 ${count} 份提交` : '查看分享'}</span>
        <span>${remainText(share)}</span>
        <span>创建于 ${formatDate(share.created_at)}</span>
      </div>
      ${collect ? `<details class="share-submissions" data-share-subs="${esc(share.id)}"><summary>提交记录（${count}）</summary><div class="share-submissions-body"><p class="helper">展开后加载提交内容。</p></div></details>` : ''}
    </article>`;
  }
  function listMarkup() {
    const rows = shares();
    if (!rows.length) {
      return `<section class="panel">${empty('还没有分享', '在待办里点“分享待办”生成链接，或把待办设置为收集表单。', '<button class="primary" data-share-new>新建分享</button>')}</section>`;
    }
    return `<div class="share-list">${rows.map(shareCard).join('')}</div>`;
  }
  function page() {
    if (offline()) {
      return heading('分享', '分享与收集需要连接服务器。') + `<section class="panel">${empty('当前离线', '离线工作区不生成分享链接。连接服务器后即可把待办分享给其他人。')}</section>`;
    }
    return heading('分享', '把待办分享出去，或生成收集表单汇总提交。', '<button class="primary" data-share-new>新建分享</button>') +
      `<div id="share-list">${listMarkup()}</div>`;
  }
  function renderList() {
    const host = document.querySelector('#share-list');
    if (host) {
      const markup = listMarkup();
      // 内容没变就不要替换节点，避免轮询刷新打断展开的提交记录和焦点。
      if (host.dataset.markup !== markup) {
        const opened = new Set([...host.querySelectorAll('[data-share-subs][open]')].map(item => item.dataset.shareSubs));
        host.dataset.markup = markup;
        host.innerHTML = markup;
        for (const details of host.querySelectorAll('[data-share-subs]')) {
          if (opened.has(details.dataset.shareSubs)) { details.open = true; loadSubmissions(details); }
        }
      }
    }
    const count = document.querySelector('#share-count');
    if (count) count.textContent = shares().length || '';
  }
  async function mount() {
    if (offline()) return;
    const generation = state.generation;
    try {
      const out = await api('/api/shares');
      if (generation !== state.generation) return;
      const changed=JSON.stringify(state.snapshot.shares)!==JSON.stringify(out.shares||[]);
      state.snapshot.shares = out.shares || [];
      cacheSoon();
      renderList();
      if(changed&&state.page==='tasks'&&state.taskId&&!$('#share-dialog').open)render();
    } catch { /* 保持上一次的内容 */ }
  }

  /* ---------- 对话框 ---------- */
  function syncDialog() {
    const form = draft.form;
    $$('#share-purpose [data-share-purpose]').forEach(b => {
      const active = b.dataset.sharePurpose === draft.purpose;
      b.classList.toggle('active', active); b.setAttribute('aria-selected', String(active)); b.tabIndex = active ? 0 : -1;
      b.disabled = !!draft.editing;
    });
    $$('#share-audience [data-share-audience]').forEach(b => {
      const active = b.dataset.shareAudience === draft.audience;
      b.classList.toggle('active', active); b.setAttribute('aria-selected', String(active)); b.tabIndex = active ? 0 : -1;
    });
    $$('#share-access [data-share-access]').forEach(b => {
      const active = b.dataset.shareAccess === draft.access;
      b.classList.toggle('active', active); b.setAttribute('aria-selected', String(active)); b.tabIndex = active ? 0 : -1;
    });
    $('#share-viewers-field').hidden = draft.audience !== 'users';
    $('#share-access-field').hidden = draft.purpose === 'collect';
    $('#share-purpose-note').textContent = purposeNotes[draft.purpose];
    $('#share-form-options').hidden = draft.purpose !== 'collect';
    for (const [id, key] of Object.entries(formFields)) $('#' + id).checked = !!form[key];
    $('#share-submit-message').value = form.submit_message || '';
    $('#share-dialog-title').textContent = draft.editing ? '分享设置' : '新建分享';
    $('#share-save').textContent = draft.editing ? '保存设置' : '生成分享链接';
    $('#share-task-field').hidden = !!draft.editing;
    $('#share-preview').hidden = draft.purpose !== 'collect';
    $('#share-task').disabled = !!draft.editing;
    $('#share-password').placeholder = draft.editing?.has_password ? '已设置，留空保留密码' : '留空表示不需要密码';
    $('#share-clear-password').hidden = !draft.editing?.has_password;
    const line = $('#share-url-line');
    line.hidden = !draft.editing;
    if (draft.editing) line.textContent = draft.editing.url || '';
    uiMotion.syncSegments();
  }
  function taskOptions(selected) {
    return state.snapshot.tasks
      .filter(t => t.status !== 'archived' || t.id === selected)
      .map(t => `<option value="${esc(t.id)}" ${t.id === selected ? 'selected' : ''}>${esc(t.title)}</option>`).join('');
  }
  function openNew(taskId = '') {
    if (offline()) { toast('连接服务器后才能生成分享'); return; }
    const tasks = state.snapshot.tasks.filter(t => t.status !== 'archived');
    if (!tasks.length) { toast('先创建一项待办，再生成分享'); return; }
    draft = {
      purpose: 'view', audience: 'public', access: 'view', viewers: '', password: '', expires_at: null,
      form: { ...defaultForm }, editing: null, taskId: taskId || tasks[0].id,
    };
    $('#share-task').innerHTML = taskOptions(draft.taskId);
    $('#share-task').value = draft.taskId;
    $('#share-viewers').value = ''; $('#share-password').value = ''; $('#share-expires').value = '';
    $('#share-error').textContent = '';
    syncDialog();
    uiMotion.openDialog($('#share-dialog'));
    $('#share-task').focus();
  }
  function openEdit(share) {
    draft = {
      purpose: share.purpose || 'view',
      audience: share.audience || 'public',
      access: share.access || 'view',
      viewers: (share.viewers || []).join(','),
      password: '',
      expires_at: share.expires_at || null,
      form: { ...defaultForm, ...(share.form || {}) },
      editing: share,
      taskId: share.task_id,
    };
    $('#share-viewers').value = draft.viewers;
    $('#share-password').value = '';
    $('#share-expires').value = draft.expires_at ? dateInput(draft.expires_at) : '';
    $('#share-error').textContent = '';
    syncDialog();
    uiMotion.openDialog($('#share-dialog'));
  }
  function collectForm() {
    const form = {};
    for (const [id, key] of Object.entries(formFields)) form[key] = $('#' + id).checked;
    form.submit_message = $('#share-submit-message').value.trim();
    return form;
  }
  function payload() {
    const body = {
      audience: draft.audience,
      access: draft.purpose === 'collect' ? 'submit' : draft.access,
      viewers: $('#share-viewers').value.split(/[,，]/).map(x => x.trim()).filter(Boolean),
      password: $('#share-password').value,
      expires_at: $('#share-expires').value ? new Date($('#share-expires').value).toISOString() : null,
      form: collectForm(),
    };
    if(draft.editing && !body.password && !draft.clearPassword)delete body.password;
    if (!draft.editing) { body.task_id = $('#share-task').value; body.purpose = draft.purpose; }
    else if (draft.purpose === 'collect') delete body.access;
    return body;
  }
  async function save(event) {
    event.preventDefault();
    if (!draft) return;
    const button = $('#share-save');
    button.disabled = true; $('#share-error').textContent = '';
    try {
      const body = payload();
      const saved = draft.editing
        ? await api('/api/shares/' + draft.editing.id, 'PUT', body)
        : await api('/api/shares', 'POST', body);
      state.snapshot.shares = [saved, ...shares().filter(s => s.id !== saved.id)];
      const created = !draft.editing;
      draft = null;
      closableDialog($('#share-dialog'));
      cacheSoon(); renderList(); updateShareCount();
      await refresh({renderPage:false});
      if (state.page !== 'shares') render();
      await copyLink(saved);
      if (created) toast('分享链接已生成并复制');
      else toast('分享设置已更新');
    } catch (error) {
      $('#share-error').textContent = error.message || '保存失败，请重试';
    } finally { if (button.isConnected) button.disabled = false; }
  }
  function updateShareCount() {
    const count = document.querySelector('#share-count');
    if (count) count.textContent = shares().length || '';
  }
  async function copyLink(share) {
    const url = share?.url;
    if (!url) return;
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(url); return; }
    } catch { /* 回落到手动选择 */ }
    const field = document.createElement('textarea');
    field.value = url; field.setAttribute('readonly', '');
    field.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.append(field); field.select();
    try { document.execCommand('copy'); } catch { /* 由用户手动复制 */ }
    field.remove();
  }

  /* ---------- 待办详情里的入口 ---------- */
  function taskActions(task) {
    if (offline()) return '';
    const linked = shares().find(s => s.task_id === task.id && s.purpose === 'collect' && !s.revoked);
    const collect = !!linked || !!task.collection;
    const viewing = shares().some(s => s.task_id === task.id && s.purpose === 'view');
    return `<div class="section-heading"><h3>分享与收集</h3><small class="helper">${linked ? (collect ? '已开启收集表单' : '已生成查看链接') : '未分享'}</small></div>
      <p class="helper">把这项待办分享给别人查看或下载；开启收集表单后，其他人可以按你设定的权限提交材料。</p>
      <div class="share-task-actions">
        <button class="secondary" data-share-task="${esc(task.id)}">${viewing ? '管理分享' : '分享待办'}</button>
        <button class="secondary" data-collect-toggle="${esc(task.id)}" data-enabled="${collect ? 'true' : 'false'}">${collect ? '关闭收集表单' : '开启收集表单'}</button>
        ${collect && linked ? `<button class="plain-button" data-collect-preview="${esc(linked.id)}">预览表单</button><button class="plain-button" data-collection-studio="${esc(linked.id)}">收集工作台</button>` : ''}
      </div>`;
  }

  async function toggleCollect(taskId, enabled, button) {
    button.disabled = true;
    try {
      const out = await api('/api/tasks/' + taskId + '/collection', 'POST', { enabled });
      const index = state.snapshot.tasks.findIndex(t => t.id === taskId);
      if (index >= 0 && out.task) state.snapshot.tasks[index] = { ...state.snapshot.tasks[index], ...out.task };
      const rest = shares().filter(s => !(s.purpose === 'collect' && s.task_id === taskId));
      await mount();
      cacheSoon(); updateShareCount();
      if (state.page === 'shares') renderList();
      render();
      if (enabled && out.share) { await copyLink(out.share); toast('收集表单已开启，链接已复制'); }
      else toast('已关闭收集表单');
    } catch (error) {
      toast(error.message || '操作未完成');
    } finally { if (button.isConnected) button.disabled = false; }
  }

  async function loadSubmissions(details) {
    const body = details.querySelector('.share-submissions-body');
    if (!body || details.dataset.loaded) return;
    details.dataset.loaded = '1';
    body.innerHTML = '<p class="helper">正在读取提交记录…</p>';
    const generation = state.generation;
    try {
      const out = await api('/api/shares/' + details.dataset.shareSubs + '/submissions');
      if (generation !== state.generation) return;
      const rows = out.submissions || [];
      body.innerHTML = rows.length ? rows.map(item => `<div class="share-submission">
        <div class="share-submission-head"><strong>${esc(item.name || '匿名提交')}</strong><time>${formatDate(item.created_at)}</time></div>
        ${item.contact ? `<p class="helper">联系方式：${esc(item.contact)}</p>` : ''}
        ${item.note ? `<p>${esc(item.note)}</p>` : ''}
        ${(item.files || []).length ? `<div class="share-submission-files">${item.files.map(f => `<button class="plain-button" data-share-file="${esc(f.id)}" data-name="${esc(f.name)}">${esc(f.name)} · ${bytes(f.size)}</button>`).join('')}</div>` : ''}
      </div>`).join('') : '<p class="helper">还没有人提交。</p>';
    } catch (error) {
      delete details.dataset.loaded;body.innerHTML = `<p class="error">${esc(error.message || '读取失败')}</p>`;
    }
  }

  function showPreview(){
    const task=state.snapshot.tasks.find(t=>t.id===(draft.editing?.task_id||$('#share-task').value));if(!task)return;
    const f=collectForm();let dialog=$('#share-form-preview');if(!dialog){dialog=document.createElement('dialog');dialog.id='share-form-preview';document.body.append(dialog);dialog.addEventListener('cancel',e=>{e.preventDefault();uiMotion.closeDialog(dialog);});}
    dialog.innerHTML=`<div class="dialog-heading"><h2>收集表单预览</h2><button type="button" class="icon-button" data-close-preview aria-label="关闭预览">×</button></div><div class="dialog-body share-surface"><p class="helper">预览当前设置，提交按钮不可用。</p><h2>${esc(task.title)}</h2>${f.show_description?`<p class="share-text">${esc(task.description)}</p>`:''}${f.show_due_at?`<p>截止时间：${formatDate(task.due_at)}</p>`:''}${f.show_naming_hint?`<p>命名要求：${esc(task.naming_hint||'未设置')}</p>`:''}${f.show_requirements?`<ul>${(task.requirements||[]).map(r=>`<li>${esc(r.label)} · 至少 ${r.min_count} 份</li>`).join('')}</ul>`:''}${f.show_files?`<div>${task.attachments.map(f=>`<p>${esc(f.name)} · ${bytes(f.size)}</p>`).join('')}</div>`:''}${f.allow_note?'<label>你的名字<input disabled placeholder="方便收集者核对"></label><label>联系方式<input disabled></label><label>说明<textarea disabled></textarea></label>':''}${f.allow_material?'<label class="share-drop">上传材料<input type="file" disabled></label>':''}${f.allow_receipt?'<label class="share-drop">上传回执<input type="file" disabled></label>':''}<button class="primary" disabled>提交</button><p class="helper">${esc(f.submit_message||'提交成功，收集者已收到')}</p></div>`;
    dialog.querySelector('[data-close-preview]').onclick=()=>uiMotion.closeDialog(dialog);uiMotion.openDialog(dialog);
  }
  $('#share-dialog').addEventListener('cancel',event=>{event.preventDefault();uiMotion.closeDialog($('#share-dialog'));});
  $('#share-form')?.addEventListener('submit', save);
  document.addEventListener('click', async event => {
    if(event.target.closest('[data-action=close-share]')) {closableDialog($('#share-dialog'));return;}
    if(event.target.closest('#share-clear-password')) {draft.clearPassword=true;$('#share-password').value='';$('#share-password').placeholder='保存后移除密码';return;}
    if(event.target.closest('[data-collect-preview]')) {const share=shares().find(s=>s.id===event.target.closest('[data-collect-preview]').dataset.collectPreview);if(share){openEdit(share);showPreview();}return;}
    const purposeTab = event.target.closest('#share-purpose [data-share-purpose]');
    if (purposeTab && draft) { draft.form=collectForm(); if (!draft?.editing) { uiMotion.relayout($('#share-dialog'),()=>{draft.purpose = purposeTab.dataset.sharePurpose; syncDialog();}); } return; }
    const audienceTab = event.target.closest('#share-audience [data-share-audience]');
    if (audienceTab && draft) { draft.form=collectForm();uiMotion.relayout($('#share-dialog'),()=>{draft.audience = audienceTab.dataset.shareAudience; syncDialog();}); return; }
    const accessTab = event.target.closest('#share-access [data-share-access]');
    if (accessTab && draft) { draft.form=collectForm();draft.access = accessTab.dataset.shareAccess; syncDialog(); return; }
    const preview = event.target.closest('#share-preview');
    if (preview) {showPreview();return;}
    const button = event.target.closest('[data-share-new],[data-share-task],[data-collect-toggle],[data-share-copy],[data-share-open],[data-share-edit],[data-share-delete]');
    if (!button) return;
    if (button.hasAttribute('data-share-new')) return openNew();
    if (button.dataset.shareTask) {
      await mount();
      const linked = shares().find(s => s.task_id === button.dataset.shareTask && s.purpose === 'view');
      return linked ? openEdit(linked) : openNew(button.dataset.shareTask);
    }
    if (button.dataset.collectToggle) return toggleCollect(button.dataset.collectToggle, button.dataset.enabled !== 'true', button);
    const share = shares().find(s => s.id === (button.dataset.shareCopy || button.dataset.shareOpen || button.dataset.shareEdit || button.dataset.shareDelete));
    if (!share) return;
    if (button.dataset.shareCopy) { await copyLink(share); toast('链接已复制'); return; }
    if (button.dataset.shareOpen) { if (share.url) {if(window.desktop)await desktop.external(share.url);else window.open(share.url, '_blank', 'noopener,noreferrer');} return; }
    if (button.dataset.shareEdit) return openEdit(share);
    if (button.dataset.shareDelete) {
      if (!window.confirm('删除后这个链接立即失效，已收到的提交记录也会一并删除。')) return;
      try {
        await api('/api/shares/' + share.id, 'DELETE');
        state.snapshot.shares = shares().filter(s => s.id !== share.id);
        if (share.purpose === 'collect' && share.task_id) {
          const index = state.snapshot.tasks.findIndex(t => t.id === share.task_id);
          if (index >= 0) state.snapshot.tasks[index] = { ...state.snapshot.tasks[index], collection: shares().some(s=>s.task_id===share.task_id&&s.purpose==='collect'&&!s.revoked) };
        }
        cacheSoon(); renderList(); updateShareCount();
        if (state.page === 'shares') render();
        toast('分享已删除');
      } catch (error) { toast(error.message || '删除失败'); }
    }
  });
  document.addEventListener('toggle', event => {
    const details = event.target.closest?.('[data-share-subs]');
    if (details && details.open) loadSubmissions(details);
  }, true);
  document.addEventListener('click', event => {
    const file = event.target.closest('[data-share-file]');
    if (!file) return;
    saveDownload('/api/files/'+encodeURIComponent(file.dataset.shareFile),file.dataset.name||'file');
  });
  let refreshing=false;
  window.addEventListener('snapshot-updated', async () => {if(refreshing||offline())return;refreshing=true;try{await mount();}finally{refreshing=false;}});

  document.addEventListener('keydown',event=>{
    const group=event.target.closest('#share-dialog [role=tablist]');if(!group||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();const buttons=[...group.querySelectorAll('button:not(:disabled)')];if(!buttons.length)return;
    const i=buttons.indexOf(document.activeElement),target=buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(i+(event.key==='ArrowLeft'?-1:1)+buttons.length)%buttons.length];target.click();target.focus({preventScroll:true});
  });
  window.shares = { page, mount, taskActions, refresh: mount, purposes, audiences, accesses };
})();
