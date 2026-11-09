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
    $('#auth-switch').hidden = closed || !!window.desktop;
    $('#auth-switch').textContent = state.isRegister ? '已有账号？返回登录' : registration === 'invite' ? '使用邀请码创建账号' : '第一次使用？创建账号';
    $('#invitation-label').hidden = !state.isRegister || registration !== 'invite';
    $('#invitation-code').required = state.isRegister && registration === 'invite';
    $('#username').type = state.isRegister ? 'email' : 'text';
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
      host.insertAdjacentHTML('beforeend', `<section id="admin-panel" class="panel settings-panel admin-panel"><h3>站点管理</h3><p class="helper">超级管理员 · 注册方式、邀请码、存储配额和 AI 服务对整个服务端生效。其他账号的聊天、待办和模型密钥保持独立。</p><form id="registration-form"><label>注册方式<select id="registration-mode"><option value="closed">关闭注册</option><option value="public">公开注册</option><option value="invite">仅邀请码注册</option></select></label><button class="primary" type="submit">保存注册方式</button><p id="registration-status" class="helper" role="status"></p></form><div class="divider"></div><h3>邀请码</h3><form id="invitation-form"><label>备注<input id="invitation-note" maxlength="100" placeholder="例如：内测同学"></label><div class="form-grid"><label>使用次数<input id="invitation-uses" type="number" min="1" max="1000" value="1" required></label><label>有效天数<input id="invitation-days" type="number" min="1" max="365" value="7" required></label></div><button class="secondary" type="submit">生成邀请码</button><p class="helper">邀请码只在生成时显示，请及时复制保存。关闭注册时，已有邀请码也无法注册。</p><label id="new-invitation-label" hidden>新邀请码<input id="new-invitation" readonly aria-label="新邀请码，点击全选"></label><p id="invitation-status" class="helper" role="status"></p></form><div id="invitation-list"></div><div class="divider"></div><h3>AI 服务</h3><p class="helper">启用免配置 AI 后，未配置自有接口的账号会通过服务器上游运行分析，按积分扣费。1 积分可兑换的 tokens 数由管理员设定。</p><form id="ai-service-form"><label class="switch-line"><input id="ai-enabled" type="checkbox"><span><strong>启用免配置 AI 服务</strong><small>账号未配置自有 API 时，自动使用服务器上游并消耗积分。</small></span></label><div class="form-grid"><label>新用户默认积分<input id="ai-default-credits" type="number" min="1" step="1" value="10"></label><label>1 积分等于 tokens<input id="ai-tokens-per-credit" type="number" min="1" step="1" value="1000000"></label></div><label class="switch-line"><input id="ai-checkin" type="checkbox"><span><strong>开启每日签到</strong><small>未签到时，客户端会在右下角提示签到领取积分。</small></span></label><div class="form-grid"><label>每次签到奖励积分<input id="ai-checkin-credits" type="number" min="1" step="1" value="1"></label></div><div class="form-grid"><label>上游 API 地址<input id="ai-upstream-url" type="url" placeholder="https://api.example.com/v1"></label><label>上游模型<input id="ai-upstream-model" placeholder="填写模型名称"></label></div><label>上游 API Key<input id="ai-upstream-key" type="password" autocomplete="new-password" placeholder="留空保留已保存的 Key"><span id="ai-key-note" class="helper"></span></label><button class="primary" type="submit">保存 AI 服务设置</button><p id="ai-service-status" class="helper" role="status"></p></form><div class="divider"></div><h3>账号列表</h3><div id="admin-users" class="helper"></div></section>`);
      const policy = await api('/api/admin/registration');
      if (!$('#registration-mode') || generation !== state.generation) return;
      $('#registration-mode').value = policy.mode;
      $('#registration-form').addEventListener('submit', async e => {
        e.preventDefault(); const button = e.submitter, status = $('#registration-status'); button.disabled = true;
        try { await api('/api/admin/registration', 'PUT', {mode: $('#registration-mode').value}); status.textContent = '已保存，立即生效'; }
        catch (error) { status.textContent = error.message; }
        finally { button.disabled = false; }
      });
      $('#invitation-form').addEventListener('submit', async e => {
        e.preventDefault(); const button = e.submitter; button.disabled = true;
        try {
          const item = await api('/api/admin/invitations', 'POST', {label: $('#invitation-note').value, max_uses: Number($('#invitation-uses').value), expires_days: Number($('#invitation-days').value)});
          if (generation !== state.generation || !$('#new-invitation')) return;
          $('#new-invitation-label').hidden = false; $('#new-invitation').value = item.code;
          $('#invitation-status').textContent = '已生成，请复制保存'; await invitations();
        } catch (error) { if ($('#invitation-status')) $('#invitation-status').textContent = error.message; }
        finally { button.disabled = false; }
      });
      $('#new-invitation').addEventListener('click', e => e.target.select());
      await invitations();
      const aiService = await api('/api/admin/ai-service');
      if ($('#ai-service-form') && generation === state.generation) {
        $('#ai-enabled').checked = !!aiService.enabled;
        $('#ai-default-credits').value = aiService.default_credits;
        $('#ai-tokens-per-credit').value = aiService.tokens_per_credit;
        $('#ai-checkin').checked = !!aiService.checkin_enabled;
        $('#ai-checkin-credits').value = aiService.checkin_credits;
        $('#ai-upstream-url').value = aiService.upstream_url || '';
        $('#ai-upstream-model').value = aiService.upstream_model || '';
        $('#ai-key-note').textContent = aiService.has_key ? '已保存 Key，留空即可沿用。' : '尚未保存 Key，未配置 Key 时账号会继续使用自有接口。';
        $('#ai-service-form').addEventListener('submit', async e => {
          e.preventDefault(); const button = e.submitter, status = $('#ai-service-status'); button.disabled = true;
          try {
            const body = { enabled: $('#ai-enabled').checked, default_credits: Number($('#ai-default-credits').value), tokens_per_credit: Number($('#ai-tokens-per-credit').value), checkin_enabled: $('#ai-checkin').checked, checkin_credits: Number($('#ai-checkin-credits').value), upstream_url: $('#ai-upstream-url').value.trim(), upstream_model: $('#ai-upstream-model').value.trim() };
            if ($('#ai-upstream-key').value) body.upstream_key = $('#ai-upstream-key').value;
            const saved = await api('/api/admin/ai-service', 'PUT', body);
            $('#ai-upstream-key').value = '';
            $('#ai-key-note').textContent = saved.has_key ? '已保存 Key，留空即可沿用。' : '尚未保存 Key，未配置 Key 时账号会继续使用自有接口。';
            status.textContent = 'AI 服务设置已保存，立即生效';
          } catch (error) { status.textContent = error.message; }
          finally { button.disabled = false; }
        });
      }
      const users = await api('/api/admin/users');
      if ($('#admin-users') && generation === state.generation) {
        const gb = value => `${(value / 1073741824).toFixed(value % 1073741824 === 0 ? 0 : 1).replace(/\.0$/, '')} GB`;
        $('#admin-users').innerHTML = users.map(u => {
          const unlimited = Number(u.quota_bytes) < 0;
          const custom = Number(u.quota_bytes) > 0;
          const effective = unlimited ? null : custom ? Number(u.quota_bytes) : 10737418240;
          const usage = unlimited ? `${gb(Number(u.used_bytes))} · 不限量` : `${gb(Number(u.used_bytes))} / ${gb(effective)}`;
          const current = custom ? (Number(u.quota_bytes) / 1073741824).toFixed(0) : '';
          return `<div class="quota-row" data-user="${esc(u.id)}" data-quota="${Number(u.quota_bytes)}" data-used="${Number(u.used_bytes)}" data-role="${u.role === 'superadmin' ? '超级管理员' : '普通用户'}"><div class="quota-user"><strong>${esc(u.username)}</strong><small></small></div><div class="quota-controls"><input type="number" min="1" max="1024" step="1" placeholder="默认 10" value="${current}" aria-label="${esc(u.username)}的存储配额（GB）"><button class="secondary" type="button" data-quota-save>保存</button><button class="plain-button" type="button" data-quota-default>默认 10GB</button><button class="plain-button" type="button" data-quota-unlimited>不限量</button></div><p class="helper quota-status" role="status"></p></div>`;
        }).join('');
        $$('[data-quota-save]').forEach(button => button.addEventListener('click', () => saveQuota(button, button.parentElement.querySelector('input').value ? Number(button.parentElement.querySelector('input').value) * 1073741824 : 0)));
        $$('[data-quota-default]').forEach(button => button.addEventListener('click', () => saveQuota(button, 0)));
        $$('[data-quota-unlimited]').forEach(button => button.addEventListener('click', () => saveQuota(button, -1)));
        $$('.quota-row').forEach(renderQuotaRow);
      }
    } catch (error) { if ($('#admin-panel')) $('#admin-panel').insertAdjacentHTML('beforeend', `<p class="error">${esc(error.message)}</p>`); }
  }
  function renderQuotaRow(row) {
    const gb = value => `${(value / 1073741824).toFixed(value % 1073741824 === 0 ? 0 : 1).replace(/\.0$/, '')} GB`;
    const quota = Number(row.dataset.quota || 0), used = Number(row.dataset.used || 0);
    const unlimited = quota < 0;
    const effective = unlimited ? null : quota > 0 ? quota : 10737418240;
    row.querySelector('small').textContent = `${row.dataset.role} · 已用 ${unlimited ? `${gb(used)} · 不限量` : `${gb(used)} / ${gb(effective)}`}`;
    row.querySelector('input').value = quota > 0 ? String(Math.round(quota / 1073741824)) : '';
  }
  async function saveQuota(button, bytes) {
    const row = button.closest('.quota-row');
    const status = row.querySelector('.quota-status');
    button.disabled = true;
    try {
      const result = await api('/api/admin/users/' + row.dataset.user + '/quota', 'PUT', { quota_bytes: bytes });
      row.dataset.quota = String(result.quota_bytes);
      renderQuotaRow(row);
      status.textContent = bytes === 0 ? '已恢复默认配额 10GB' : bytes < 0 ? '已设为不限量' : '配额已更新';
    } catch (error) { status.textContent = error.message; }
    button.disabled = false;
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
