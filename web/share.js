'use strict';
/* 独立的分享页面：不加载主工作台脚本，只处理后端 /api/shared/* 契约。 */
(() => {
  const root = document.querySelector('#share-root');
  const token = decodeURIComponent((location.pathname.replace(/^\/s\//, '').split('/')[0] || '').trim());
  const api = '/api/shared/' + encodeURIComponent(token);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const bytes = size => size >= 1024 ** 2 ? (size / 1024 ** 2).toFixed(1) + ' MB' : size >= 1024 ? (size / 1024).toFixed(1) + ' KB' : size + ' B';
  const formatDate = value => value ? new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '未设置';
  function toast(message) {
    const host = document.querySelector('#share-toast');
    document.querySelector('#share-toast-text').textContent = message;
    host.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { host.hidden = true; }, 3200);
  }
  function sessionToken() {
    try {
      const session = JSON.parse(localStorage.getItem('jjb-session') || 'null');
      if (session?.token && new URL(session.server).origin === location.origin) return session.token;
    } catch { /* 未登录或跨域会话 */ }
    return '';
  }
  async function call(route, options = {}) {
    const headers = {};
    const bearer = sessionToken();
    if (bearer) headers.Authorization = 'Bearer ' + bearer;
    let body = options.body;
    if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    try {
      const response = await fetch(route, { method: options.method || 'GET', headers, body, credentials: 'same-origin' });
      let data = null;
      try { data = await response.json(); } catch { /* 文件流或空响应 */ }
      return { ok: response.ok, status: response.status, data: data || {} };
    } catch {
      return { ok: false, status: 0, data: { detail: { code: 'network', message: '无法连接服务器，请检查网络后重试。' } } };
    }
  }
  const failure = result => {
    const detail = result.data?.detail;
    if (detail && typeof detail === 'object') return detail;
    return { code: 'unknown', message: typeof detail === 'string' ? detail : '链接无效或已失效。' };
  };
  let current = null;

  function statusCard(title, note, extra = '') {
    root.innerHTML = `<div class="share-state">${state_icon(title)}<h1>${esc(title)}</h1><p class="helper">${esc(note)}</p>${extra}</div>`;
  }
  function state_icon(title) {
    const glyph = {
      '需要访问密码': '<rect x="5" y="10" width="14" height="10" rx="2.5"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/>',
      '请先登录': '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
      '链接已失效': '<path d="M10 14a4 4 0 0 1 0-5.6l2-2a4 4 0 0 1 5.6 5.6"/><path d="M14 10a4 4 0 0 1 0 5.6l-2 2A4 4 0 0 1 6.4 12"/><path d="M4 4l16 16"/>',
    }[title] || '<path d="M4 12h6l2.5 3H15l2-3h3"/><path d="M4 12V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6"/><path d="M4 12v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/>';
    return `<span class="share-state-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${glyph}</svg></span>`;
  }
  function unlockCard(message) {
    root.innerHTML = `<div class="share-state">
      ${state_icon('需要访问密码')}
      <h1>需要访问密码</h1>
      <p class="helper">${esc(message || '分享者为此链接设置了访问密码。')}</p>
      <form id="share-unlock" class="share-form-inline">
        <label>访问密码<input id="share-unlock-input" type="password" minlength="6" required autocomplete="off" placeholder="请输入分享者提供的密码"></label>
        <button class="primary" type="submit">进入查看</button>
      </form>
      <p id="share-unlock-error" class="error" role="alert"></p>
    </div>`;
  }
  function loginCard(message) {
    statusCard('请先登录',message||'此链接需要登录后访问。',`<form id="share-login" class="share-form-inline"><label>邮箱 / 用户名<input name="username" autocomplete="username" required></label><label>密码<input name="password" type="password" autocomplete="current-password" required></label><button class="primary" type="submit">登录并继续</button><p id="share-login-error" class="error" role="alert"></p></form><a class="link" href="/" target="_blank" rel="noopener">注册账号</a>`);
  }

  function taskMeta(task) {
    const rows = [];
    if (task.due_at) rows.push(`<div class="share-meta-row"><span>截止时间</span><strong>${esc(formatDate(task.due_at))}</strong></div>`);
    if (task.naming_hint) rows.push(`<div class="share-meta-row"><span>命名要求</span><strong>${esc(task.naming_hint)}</strong></div>`);
    if (/^https?:\/\//i.test(task.submit_url||'')) rows.push(`<div class="share-meta-row"><span>提交入口</span><a class="link" href="${esc(task.submit_url)}" target="_blank" rel="noopener noreferrer">打开原提交页面</a></div>`);
    return rows.join('');
  }
  function requirementList(task) {
    const list = task.requirements || [];
    if (!list.length) return '';
    return `<section class="share-block"><h2>需要的材料</h2><ul class="share-requirements">${list.map(item => `<li><strong>${esc(item.label)}</strong><small>${esc((item.extensions || []).join(' / ') || '任意格式')} · 至少 ${esc(item.min_count ?? 1)} 份</small></li>`).join('')}</ul></section>`;
  }
  function attachmentList(task, canDownload) {
    const files = task.attachments || [];
    if (!files.length) return '';
    return `<section class="share-block"><h2>已有文件</h2><div class="share-files">${files.map(file => `<div class="share-file-row"><span class="file-icon">${esc((file.name.split('.').pop() || '').slice(0, 4).toUpperCase())}</span><span class="share-file-name">${esc(file.name)}<small>${bytes(file.size)} · ${file.kind === 'receipt' ? '提交回执' : '待办材料'}</small></span>${current.permissions.edit ? `<button class="plain-button danger-button" data-remove-file="${esc(file.id)}">移除</button>` : ''}${canDownload ? `<button class="plain-button" data-download="${esc(file.id)}" data-name="${esc(file.name)}">下载</button>` : ''}</div>`).join('')}</div></section>`;
  }
  function collectForm(data) {
    const form = data.share.form || {};
    const fields = [];
    if (form.allow_note) {
      fields.push(`<label>你的名字<input id="submit-name" maxlength="80" placeholder="方便收集者核对"></label>
        <label>联系方式<input id="submit-contact" maxlength="160" placeholder="手机号、邮箱或学号"></label>
        <label>说明<textarea id="submit-note" rows="3" maxlength="2000" placeholder="补充你想让收集者知道的信息"></textarea></label>`);
    }
    if (form.allow_material) fields.push(`<label class="share-drop">上传材料<input id="submit-material" type="file" multiple></label>`);
    if (form.allow_receipt) fields.push(`<label class="share-drop">上传提交回执<input id="submit-receipt" type="file" multiple></label>`);
    return `<section class="share-block"><h2>提交内容</h2><form id="share-submit" class="share-form">${fields.join('')}<div class="share-progress" id="share-progress" hidden><div class="update-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i id="share-progress-fill"></i></div><span class="helper" id="share-progress-text">正在提交…</span></div><div class="detail-actions"><button class="primary" type="submit">提交</button><button class="secondary" type="reset">清空</button></div><p id="share-submit-error" class="error" role="alert"></p></form></section>`;
  }
  function editForm(task) {
    const statuses = { collecting: '准备材料', ready: '待提交', submitted: '已提交', archived: '已归档' };
    return `<section class="share-block"><h2>修改这项待办</h2><form id="share-edit" class="share-form">
      <label>标题<input id="edit-title" required maxlength="200" value="${esc(task.title || '')}"></label>
      <label>说明<textarea id="edit-description" rows="4" maxlength="30000">${esc(task.description || '')}</textarea></label>
      <div class="form-grid"><label>截止时间<input id="edit-due" type="datetime-local" value="${task.due_at ? esc(localInput(task.due_at)) : ''}"></label><label>进度<select id="edit-status">${Object.entries(statuses).map(([value, label]) => `<option value="${value}" ${(task.status || 'collecting') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div>
      <label class="share-drop">添加待办材料<input type="file" id="shared-material-upload" multiple></label><div class="detail-actions"><button class="primary" type="submit">保存修改</button></div><p id="share-edit-error" class="error" role="alert"></p></form></section>`;
  }
  function localInput(value) {
    const date = new Date(value);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }

  function render() {
    const data = current;
    const task = data.task || {};
    const share = data.share || {};
    const permissions = data.permissions || {};
    const collect = share.purpose === 'collect';
    const ownerName = data.owner?.nickname || data.owner?.username || '分享者';
    const banner = collect
      ? `<div class="share-banner"><strong>${esc(task.title || '收集表单')}</strong><span>由 ${esc(ownerName)} 发起收集</span></div>`
      : `<div class="share-banner"><strong>${esc(task.title || '分享内容')}</strong><span>由 ${esc(ownerName)} 分享${permissions.download ? ' · 可下载文件' : ''}${permissions.edit ? ' · 可修改' : ''}</span></div>`;
    uiMotion.relayout(root,()=>{root.innerHTML = banner +
      (share.expires_at ? `<p class="helper">该链接将于 ${esc(formatDate(share.expires_at))} 失效。</p>` : '') +
      (task.description ? `<section class="share-block"><h2>说明</h2><p class="share-text">${esc(task.description)}</p></section>` : '') +
      (taskMeta(task) ? `<section class="share-block"><h2>关键信息</h2>${taskMeta(task)}</section>` : '') +
      requirementList(task) +
      attachmentList(task, !!permissions.download) +
      (collect ? collectForm(data) : '') +
      (permissions.edit ? editForm(task) : '');});
  }

  async function load() {
    const result = await call(api);
    if (result.ok) { current = result.data; render(); return; }
    const detail = failure(result);
    if (detail.code === 'password_required') return unlockCard(detail.message);
    if (detail.code === 'login_required') return loginCard(detail.message);
    if (detail.code === 'expired') return statusCard('链接已失效', detail.message || '分享已过期。');
    if (detail.code === 'not_found') return statusCard('链接已失效', detail.message || '分享已取消或不存在。');
    if (detail.code === 'forbidden') return statusCard('没有访问权限', detail.message || '此分享未向你开放。');
    statusCard('暂时无法打开', detail.message || '请稍后重试。');
  }

  async function downloadFile(id, name) {
    const headers = {};
    const bearer = sessionToken();
    if (bearer) headers.Authorization = 'Bearer ' + bearer;
    try {
      const response = await fetch(api + '/files/' + encodeURIComponent(id), { headers, credentials: 'same-origin' });
      if (!response.ok) { const data = await response.json().catch(() => ({})); toast(failure({ data }).message); return; }
      const blob = await response.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob); link.download = name || 'file';
      document.body.append(link); link.click();
      setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
    } catch { toast('下载失败，请重试。'); }
  }

  function submitForm(form) {
    const body = new FormData();
    const name = form.querySelector('#submit-name');
    const contact = form.querySelector('#submit-contact');
    const note = form.querySelector('#submit-note');
    if (name) body.append('name', name.value.trim());
    if (contact) body.append('contact', contact.value.trim());
    if (note) body.append('note', note.value.trim());
    const material = form.querySelector('#submit-material');
    const receipt = form.querySelector('#submit-receipt');
    for (const file of material?.files || []) body.append('material_files', file);
    for (const file of receipt?.files || []) body.append('receipt_files', file);
    return body;
  }
  function progress(value) {
    const box = document.querySelector('#share-progress');
    if (!box) return;
    box.hidden = false;
    const track = box.querySelector('[role=progressbar]');
    track.setAttribute('aria-valuenow', String(value));
    box.querySelector('#share-progress-fill').style.width = value + '%';
    box.querySelector('#share-progress-text').textContent = value >= 100 ? '正在等待服务器确认…' : `正在提交 ${value}%`;
  }
  function upload(body) {
    return new Promise(resolve => {
      const request = new XMLHttpRequest();
      request.open('POST', api + '/submit');
      request.withCredentials = true;
      const bearer = sessionToken();
      if (bearer) request.setRequestHeader('Authorization', 'Bearer ' + bearer);
      const started=performance.now();
      request.upload.addEventListener('progress', event => {if(!event.lengthComputable)return;progress(Math.min(100,Math.round(event.loaded/event.total*100)));const speed=event.loaded/Math.max(.1,(performance.now()-started)/1000);const label=document.querySelector('#share-progress-text');if(label&&event.loaded<event.total)label.textContent=`${bytes(event.loaded)} / ${bytes(event.total)} · ${bytes(speed)}/s`;});
      request.addEventListener('load', () => {
        let data = {}; try { data = JSON.parse(request.responseText); } catch { /* 空响应 */ }
        resolve({ ok: request.status >= 200 && request.status < 300, status: request.status, data });
      });
      request.addEventListener('error', () => resolve({ ok: false, status: 0, data: { detail: { message: '网络中断，提交未完成。' } } }));
      request.send(body);
    });
  }

  document.addEventListener('submit', async event => {
    const login=event.target.closest('#share-login');
    if(login){event.preventDefault();const button=login.querySelector('button');button.disabled=true;
      try{const response=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:login.elements.username.value.trim(),password:login.elements.password.value})});const data=await response.json();if(!response.ok)throw Error(typeof data.detail==='string'?data.detail:'登录失败');localStorage.setItem('jjb-session',JSON.stringify({...data,server:location.origin}));await load();}
      catch(e){login.querySelector('#share-login-error').textContent=e.message;}finally{button.disabled=false;}return;
    }
    const unlock = event.target.closest('#share-unlock');
    if (unlock) {
      event.preventDefault();
      const button = unlock.querySelector('button');
      button.disabled = true;
      const result = await call(api + '/unlock', { method: 'POST', body: { password: document.querySelector('#share-unlock-input').value } });
      button.disabled = false;
      if (result.ok) { await load(); return; }
      document.querySelector('#share-unlock-error').textContent = failure(result).message || '密码不正确。';
      return;
    }
    const form = event.target.closest('#share-submit');
    if (form) {
      event.preventDefault();
      const button = form.querySelector('[type=submit]');
      button.disabled = true;
      document.querySelector('#share-submit-error').textContent = '';
      progress(2);
      const result = await upload(submitForm(form));
      button.disabled = false;
      const box = document.querySelector('#share-progress');
      if (result.ok) {
        if (box) box.hidden = true;
        statusCard('提交成功', result.data.message || '收集者已收到你的提交。');
        return;
      }
      if (box) box.hidden = true;
      document.querySelector('#share-submit-error').textContent = failure(result).message || '提交未完成，请重试。';
      return;
    }
    const edit = event.target.closest('#share-edit');
    if (edit) {
      event.preventDefault();
      const button = edit.querySelector('[type=submit]');
      button.disabled = true;
      const task = current.task;
      const due = document.querySelector('#edit-due').value;
      const result = await call(api + '/task', { method: 'PUT', body: {
        title: document.querySelector('#edit-title').value.trim(),
        description: document.querySelector('#edit-description').value,
        due_at: due ? new Date(due).toISOString() : null,
        status: document.querySelector('#edit-status').value,
        requirements: task.requirements || [],
        reminders: task.reminders || [],
        max_total_bytes: task.max_total_bytes ?? null,
        naming_hint: task.naming_hint || '',
        filename_pattern: task.filename_pattern || '',
        submit_url: task.submit_url || '',
        source_message_id: task.source_message_id ?? null,
        client_id: task.client_id ?? null,
        version: task.version,
      } });
      button.disabled = false;
      if (result.ok) { current = result.data; render(); toast('修改已保存'); return; }
      document.querySelector('#share-edit-error').textContent = failure(result).message || '保存失败，请重试。';
    }
  });
  document.addEventListener('click', event => {
    const remove=event.target.closest('[data-remove-file]');
    if(remove){if(!confirm('移除这份文件？'))return;remove.disabled=true;call(api+'/files/'+encodeURIComponent(remove.dataset.removeFile)+'?version='+current.task.version,{method:'DELETE'}).then(async r=>{if(r.ok)await load();else toast(failure(r).message);}).finally(()=>remove.disabled=false);return;}
    const button = event.target.closest('[data-download]');
    if (button) downloadFile(button.dataset.download, button.dataset.name);
  });

  document.addEventListener('change',async event=>{
    if(event.target.id!=='shared-material-upload')return;
    const files=[...event.target.files];event.target.disabled=true;
    try{for(const file of files){const body=new FormData();body.append('file',file);const result=await call(api+'/files?kind=material&version='+current.task.version,{method:'POST',body});if(!result.ok)throw Error(failure(result).message);current=result.data;}render();toast('文件已添加');}catch(e){toast(e.message);}finally{event.target.disabled=false;}
  });
  window.addEventListener('storage',event=>{if(event.key==='jjb-session')load();});
  if (!token) statusCard('链接已失效', '地址里没有分享标识。');
  else load();
})();
