(() => {
  'use strict';
  const code = new URLSearchParams(location.search).get('code') || '';
  const origin = location.origin;
  const elements = Object.fromEntries([
    'authorize-signin-tab','authorize-signup-tab','authorize-form-title','authorize-username-caption','authorize-invitation-label','authorize-invitation','authorize-mail-note',
    'authorize-login', 'authorize-consent', 'authorize-complete', 'authorize-login-submit',
    'authorize-username', 'authorize-password', 'authorize-code', 'authorize-account',
    'authorize-approve', 'authorize-deny', 'authorize-status', 'authorize-error', 'authorize-complete-text',
  ].map(id => [id, document.getElementById(id)]));

  let authMode='login',policy={mode:'closed'};
  function setAuthMode(mode){
    if(mode==='register'&&policy.mode==='closed')return;
    const apply=()=>{
      authMode=mode;const register=mode==='register';
      elements['authorize-signin-tab'].classList.toggle('active',!register);elements['authorize-signup-tab'].classList.toggle('active',register);
      elements['authorize-signin-tab'].setAttribute('aria-selected',String(!register));elements['authorize-signup-tab'].setAttribute('aria-selected',String(register));
      elements['authorize-signin-tab'].tabIndex=register?-1:0;elements['authorize-signup-tab'].tabIndex=register?0:-1;
      elements['authorize-form-title'].textContent=register?'注册网页账号':'登录网页账号';
      elements['authorize-username-caption'].textContent=register?'邮箱':'邮箱 / 原有用户名';
      elements['authorize-username'].type=register?'email':'text';elements['authorize-username'].maxLength=254;
      elements['authorize-password'].autocomplete=register?'new-password':'current-password';
      elements['authorize-invitation-label'].hidden=!register||policy.mode!=='invite';elements['authorize-invitation'].required=register&&policy.mode==='invite';
      elements['authorize-login-submit'].textContent=register?'注册并继续':'登录并继续';elements['authorize-mail-note'].hidden=true;
      showError('');uiMotion.syncSegments();
    };
    uiMotion.relayout(elements['authorize-login'],apply);
  }
  elements['authorize-signin-tab'].addEventListener('click',()=>setAuthMode('login'));
  elements['authorize-signup-tab'].addEventListener('click',()=>setAuthMode('register'));
  fetch('/api/auth/registration',{signal:AbortSignal.timeout(15000)}).then(r=>{if(!r.ok)throw Error();return r.json();}).then(value=>{policy=value;elements['authorize-signup-tab'].hidden=value.mode==='closed';uiMotion.syncSegments();}).catch(()=>{});

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
      const credentials={username:elements['authorize-username'].value.trim(),password:elements['authorize-password'].value};
      const publicPost=async(route,body)=>{
        const r=await fetch(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
        const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(typeof data.detail==='string'?data.detail:'请求失败');return data;
      };
      if(authMode==='register'){
        const registration=await publicPost('/api/auth/register',{...credentials,email:credentials.username,invitation_code:elements['authorize-invitation'].value.trim(),authorization_code:code});
        if(registration.verification_required){
          elements['authorize-password'].value='';elements['authorize-mail-note'].hidden=false;
          elements['authorize-mail-note'].textContent='验证邮件已发送。完成邮箱验证后会自动登录，并回到这次客户端授权。';
          showStatus('请在邮箱中打开验证链接。');return;
        }
      }
      const data=await publicPost('/api/auth/login',credentials);
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
  window.addEventListener('storage',event=>{if(event.key==='jjb-session'&&readSession())start();});
  start();
})();
