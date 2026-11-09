(() => {
  'use strict';
  const code = new URLSearchParams(location.search).get('code') || '';
  const origin = location.origin;
  const elements = Object.fromEntries([
    'authorize-login', 'authorize-consent', 'authorize-complete', 'authorize-login-submit',
    'authorize-username', 'authorize-password', 'authorize-code', 'authorize-account',
    'authorize-approve', 'authorize-deny', 'authorize-status', 'authorize-error', 'authorize-complete-text',
  ].map(id => [id, document.getElementById(id)]));

  const showStatus = message => { elements['authorize-status'].textContent = message || ''; };
  const showError = message => {
    elements['authorize-error'].textContent = message || '';
    elements['authorize-error'].hidden = !message;
  };
  const readSession = () => {
    try {
      const session = JSON.parse(localStorage.getItem('jjb-session') || 'null');
      return session?.token && new URL(session.server || origin).origin === origin ? session : null;
    } catch { return null; }
  };
  const saveSession = session => localStorage.setItem('jjb-session', JSON.stringify(session));
  const api = async (route, method = 'GET', body) => {
    const session = readSession();
    if (!session) throw Object.assign(new Error('请先登录'), { unauthorized: true });
    const response = await fetch(route, {
      method,
      headers: { Authorization: `Bearer ${session.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(typeof data.detail === 'string' ? data.detail : '请求失败'), { unauthorized: response.status === 401 });
    return data;
  };

  function show(section) {
    for (const name of ['authorize-login', 'authorize-consent', 'authorize-complete']) {
      elements[name].hidden = name !== section;
    }
  }

  async function loadRequest() {
    if (code.length !== 8) throw new Error('授权链接无效，请回到电脑客户端重新登录。');
    const request = await api(`/api/auth/device/request?code=${encodeURIComponent(code)}`);
    if (request.state !== 'pending') {
      show('authorize-complete');
      elements['authorize-complete-text'].textContent = '这次授权请求已经处理过，可以返回电脑客户端。';
      elements['authorize-approve'].disabled = true;
      elements['authorize-deny'].disabled = true;
      showStatus('');
      return false;
    }
    const session = readSession();
    elements['authorize-code'].textContent = `${code.slice(0, 4)}-${code.slice(4)}`;
    elements['authorize-account'].textContent = `当前账号：${session.username}`;
    show('authorize-consent');
    showStatus('请确认电脑客户端上显示的授权码一致。');
    return true;
  }

  async function start() {
    elements['authorize-approve'].disabled = false;
    elements['authorize-deny'].disabled = false;
    showError('');
    try {
      const session = readSession();
      if (!session) { show('authorize-login'); showStatus('登录后继续确认这次桌面授权。'); return; }
      showStatus('正在读取授权请求…');
      await loadRequest();
    } catch (error) {
      if (error.unauthorized) {
        localStorage.removeItem('jjb-session');
        show('authorize-login');
        showStatus('登录后继续确认这次桌面授权。');
      } else {
        showError(error.message);
      }
    }
  }

  elements['authorize-login'].addEventListener('submit', async event => {
    event.preventDefault();
    const button = elements['authorize-login-submit'];
    button.disabled = true;
    showError('');
    showStatus('正在登录…');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: elements['authorize-username'].value.trim(),
          password: elements['authorize-password'].value,
        }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '请检查用户名与密码');
      saveSession({ ...data, server: origin });
      elements['authorize-password'].value = '';
      showStatus('正在读取授权请求…');
      await loadRequest();
    } catch (error) {
      showStatus('');
      showError(error instanceof TypeError ? '无法连接服务端，请检查网络。' : error.message);
    } finally {
      button.disabled = false;
    }
  });

  async function approve(allowed) {
    elements['authorize-approve'].disabled = true;
    elements['authorize-deny'].disabled = true;
    showError('');
    try {
      await api('/api/auth/device/approve', 'POST', { user_code: code, approve: allowed });
      show('authorize-complete');
      elements['authorize-complete-text'].textContent = allowed ? '授权完成，可以返回电脑客户端继续。' : '已取消这次授权，可以返回电脑客户端重新登录。';
      showStatus('');
    } catch (error) {
      showError(error.message);
      if (!error.unauthorized) {
        elements['authorize-approve'].disabled = false;
        elements['authorize-deny'].disabled = false;
      }
    }
  }

  elements['authorize-approve'].addEventListener('click', () => approve(true));
  elements['authorize-deny'].addEventListener('click', () => approve(false));
  start();
})();
