'use strict';
window.jjbAdmin = (() => {
  let identity = '', profile = null, registration = 'public', epoch = 0;
  function authFields() {
    const closed = registration === 'closed';
    if (closed && state.isRegister) {
      state.isRegister = false;
      $('#auth-title').textContent = '登录交件箱';
      $('#auth-submit').textContent = '登录';
    }
    $('#auth-switch').hidden = closed;
    $('#auth-switch').textContent = state.isRegister ? '已有账号？返回登录' : registration === 'invite' ? '使用邀请码创建账号' : '第一次使用？创建账号';
    $('#invitation-label').hidden = !state.isRegister || registration !== 'invite';
    $('#invitation-code').required = state.isRegister && registration === 'invite';
    $('#password').autocomplete = state.isRegister ? 'new-password' : 'current-password';
  }
  async function loadRegistration() {
    const current = ++epoch;
    try {
      const url = new URL($('#server-url').value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
      const result = await fetch(url.href.replace(/\/$/, '') + '/api/auth/registration', {signal: AbortSignal.timeout(10000)});
      if (!result.ok) return;
      const config = await result.json();
      if (current !== epoch) return;
      registration = config.mode; authFields();
    } catch { /* Login still reports connection errors normally. */ }
  }
  async function mount() {
    if (!state.session || state.page !== 'settings') return;
    const key = state.session.server + '|' + state.session.user_id;
    const generation = state.generation;
    if (identity !== key) { profile = null; identity = key; }
    try {
      if (!profile) { const loaded = await api('/api/auth/me'); if (generation !== state.generation || identity !== key) return; profile = loaded; }
      if (generation !== state.generation || state.page !== 'settings' || !profile.is_admin) return;
      const host = $('#view');
      if ($('#admin-panel')) return;
      host.insertAdjacentHTML('beforeend', `<section id="admin-panel" class="panel settings-panel admin-panel"><h3>站点管理</h3><p class="helper">超级管理员 · 注册方式和邀请码对整个服务端生效。其他账号的聊天、任务和模型密钥保持独立。</p><form id="registration-form"><label>注册方式<select id="registration-mode"><option value="closed">关闭注册</option><option value="public">公开注册</option><option value="invite">仅邀请码注册</option></select></label><button class="primary" type="submit">保存注册方式</button><p id="registration-status" class="helper" role="status"></p></form><div class="divider"></div><h3>邀请码</h3><form id="invitation-form"><label>备注<input id="invitation-note" maxlength="100" placeholder="例如：内测同学"></label><div class="form-grid"><label>使用次数<input id="invitation-uses" type="number" min="1" max="1000" value="1" required></label><label>有效天数<input id="invitation-days" type="number" min="1" max="365" value="7" required></label></div><button class="secondary" type="submit">生成邀请码</button><p class="helper">邀请码只在生成时显示，请及时复制保存。关闭注册时，已有邀请码也无法注册。</p><label id="new-invitation-label" hidden>新邀请码<input id="new-invitation" readonly aria-label="新邀请码，点击全选"></label><p id="invitation-status" class="helper" role="status"></p></form><div id="invitation-list"></div><div class="divider"></div><h3>账号列表</h3><div id="admin-users" class="helper"></div></section>`);
      const policy = await api('/api/admin/registration');
      if (!$('#registration-mode') || generation !== state.generation) return;
      $('#registration-mode').value = policy.mode;
      $('#registration-form').addEventListener('submit', async e => {
        e.preventDefault(); const button = e.submitter; button.disabled = true;
        try { await api('/api/admin/registration', 'PUT', {mode: $('#registration-mode').value}); $('#registration-status').textContent = '已保存，立即生效'; }
        catch (error) { $('#registration-status').textContent = error.message; }
        finally { button.disabled = false; }
      });
      $('#invitation-form').addEventListener('submit', async e => {
        e.preventDefault(); const button = e.submitter; button.disabled = true;
        try {
          const item = await api('/api/admin/invitations', 'POST', {label: $('#invitation-note').value, max_uses: Number($('#invitation-uses').value), expires_days: Number($('#invitation-days').value)});
          if (!$('#new-invitation')) return;
          $('#new-invitation-label').hidden = false; $('#new-invitation').value = item.code;
          $('#invitation-status').textContent = '已生成，请复制保存'; await invitations();
        } catch (error) { if ($('#invitation-status')) $('#invitation-status').textContent = error.message; }
        finally { button.disabled = false; }
      });
      $('#new-invitation').addEventListener('click', e => e.target.select());
      await invitations();
      const users = await api('/api/admin/users');
      if ($('#admin-users') && generation === state.generation) $('#admin-users').textContent = users.map(u => u.username + (u.role === 'superadmin' ? '（超级管理员）' : '（普通用户）')).join('、');
    } catch (error) { if ($('#admin-panel')) $('#admin-panel').insertAdjacentHTML('beforeend', `<p class="error">${esc(error.message)}</p>`); }
  }
  async function invitations() {
    const list = await api('/api/admin/invitations');
    if (!$('#invitation-list')) return;
    $('#invitation-list').innerHTML = list.length ? list.map(item => `<div class="detail-actions"><span class="helper">${esc(item.label || item.prefix + '…')} · ${item.uses}/${item.max_uses} 次 · ${formatDate(new Date(item.expires * 1000))} 到期${item.revoked ? ' · 已停用' : ''}</span>${item.revoked ? '' : `<button class="plain-button" type="button" data-revoke-invite="${esc(item.id)}">停用</button>`}</div>`).join('') : '<p class="helper">还没有邀请码</p>';
    $$('[data-revoke-invite]').forEach(button => button.addEventListener('click', async () => {
      button.disabled = true;
      try { await api('/api/admin/invitations/' + button.dataset.revokeInvite, 'DELETE'); await invitations(); }
      catch (error) { toast(error.message); button.disabled = false; }
    }));
  }
  $('#auth-switch').addEventListener('click', authFields);
  $('#server-url').addEventListener('change', loadRegistration);
  loadRegistration();
  return {mount};
})();
