'use strict';
window.accountUI = (() => {
  const CLOUD='https://jiaojianbox.bansonic.top';
  let importAfterLogin=false;
  const headers=session=>({Authorization:'Bearer '+session.token});
  async function copyCached(source,target,draftsOnly=false){
    const tasks=state.snapshot.tasks.filter(t=>!draftsOnly||t.pending).map(t=>({...t,title:draftsOnly?(t.title+'（本机草稿）').slice(0,200):t.title}));
    if(!tasks.length&&draftsOnly)return;
    const r=await fetch(target.server+'/api/workspace/import-cache',{method:'POST',headers:{...headers(target),'Content-Type':'application/json'},body:JSON.stringify({origin:source.server+'|'+source.user_id+(draftsOnly?'|drafts':''),tasks,messages:draftsOnly?[]:state.snapshot.messages}),signal:AbortSignal.timeout(300000)});
    if(!r.ok)throw Error('本机草稿复制失败，请保留当前工作区重试');
  }
  async function copyWorkspace(source,target){
    const ownsActive=state.session?.server===source.server&&state.session?.user_id===source.user_id;
    if(ownsActive&&state.pending.length)await flushOutbox();
    const response=await fetch(source.server+'/api/workspace/export',{headers:headers(source),signal:AbortSignal.timeout(300000)});
    if(!response.ok&&response.status!==404)throw Error('无法导出来源工作区，请确认已连接来源服务');
    const archive=response.status===404?await legacyTransfer.archive(source):await response.blob();
    const form=new FormData();form.append('file',archive,'workspace.zip');
    const result=await fetch(target.server+'/api/workspace/import',{method:'POST',headers:headers(target),body:form,signal:AbortSignal.timeout(300000)});
    const data=await result.json();if(!result.ok)throw Error(data.detail||'导入失败，来源数据未改变');if(ownsActive&&state.pending.length)await copyCached(source,target,true);return data;
  }
  async function useOffline(copy=false,cacheOnly=false){
    if(!window.desktop)throw Error('请在桌面客户端或安卓客户端中使用离线工作区');
    const source=state.session;const sources=state.sources;const target=await desktop.offlineStart();
    if(copy&&source&&source.mode!=='offline'){if(cacheOnly)await copyCached(source,target);else await copyWorkspace(source,target);}
    await storeSet('session',target);await desktop.stopCollector();await enter(target);
    if(copy&&sources){state.sources=sources;await storeSet('sources-'+state.profile,sources);}
    toast(copy?'已复制到本机，云端数据保留':'正在使用本机离线工作区');
  }
  async function afterLogin(){
    if(importAfterLogin&&state.session?.mode!=='offline'){
      importAfterLogin=false;
      try{const result=await copyWorkspace(await desktop.offlineStart(),state.session);await refresh();toast(result.message);}
      catch(error){toast('云端登录成功；本地导入未完成：'+error.message);}
    }
  }
  function connectCloud(){
    importAfterLogin=true;
    // Keep the offline workspace and its token in its own vault; the login only changes the active workspace.
    state.generation++;state.socket?.close();clearTimeout(reconnectTimer);state.session=null;
    $('#workspace').hidden=true;$('#auth').hidden=false;$('#server-url').value=CLOUD;
    $('#server-url').closest('label').hidden=true;$('#other-server').textContent='连接其他自建服务器';
    window.experience?.prepareLogin();
  }
  async function mount(){
    if(state.page!=='settings'||!state.session)return;
    const generation=state.generation,session=state.session;
    if($('#account-panel'))return;
    $('#view').insertAdjacentHTML('beforeend',`<section id="account-panel" class="panel settings-panel admin-panel"><h3>个人资料</h3><form id="profile-form"><label>昵称<input id="profile-nickname" maxlength="64" required></label><p id="profile-email" class="helper"></p><button class="primary" type="submit">保存昵称</button></form>${session.mode==='offline'?'':`<form id="bind-email-form"><label>绑定邮箱<input id="bind-email" type="email" required autocomplete="email"></label><button class="secondary" type="submit">发送绑定验证邮件</button></form><form id="password-form"><label>当前密码<input id="current-password" type="password" autocomplete="current-password" required></label><label>新密码<input id="new-password" type="password" autocomplete="new-password" minlength="10" required></label><button class="secondary" type="submit">修改密码并退出其他设备</button></form>`}<p id="account-status" class="helper" role="status"></p><div class="divider"></div><h3>数据与连接</h3><p class="helper">${session.mode==='offline'?'当前为本机离线工作区，附件、通知和待办保存在这台设备上。':'当前连接：'+esc(session.server)}</p><p class="helper">复制导入不会删除来源数据，重复导入会跳过已有内容。模型配置会复制，API Key 需要在目标工作区重新填写。</p><div class="detail-actions">${window.desktop?`<button type="button" class="secondary" id="workspace-copy">${session.mode==='offline'?'登录云端并上传本地数据':'复制到本机并离线使用'}</button>${session.mode==='offline'?'':'<button type="button" class="plain-button" id="workspace-cache">仅将本机缓存转为离线（不含附件）</button>'}<button type="button" class="plain-button" id="workspace-switch">${session.mode==='offline'?'仅连接云端或自建服务器':'仅切换到离线工作区'}</button>`:''}<button type="button" class="secondary" id="workspace-export">导出数据包</button><label class="secondary">导入数据包<input id="workspace-import" type="file" accept=".zip" hidden></label></div><p id="workspace-status" class="helper" role="status"></p></section>`);
    const panel=$('#account-panel');
    const status=panel.querySelector('#account-status');
    try{
      const me=await api('/api/auth/me');if(generation!==state.generation||panel!==$('#account-panel'))return;
      panel.querySelector('#profile-nickname').value=me.nickname||me.username;
      panel.querySelector('#profile-email').textContent=me.email?me.email+(me.verified?' · 已验证':' · 尚未验证'):'尚未绑定邮箱，绑定后可以找回密码';
      $('#account-name').textContent=session.mode==='offline'&&me.nickname==='offline'?'本机工作区':me.nickname||me.username;
      if(me.is_admin&&session.mode!=='offline')await mountMail(panel,generation);
    }catch(error){status.textContent=error.message;}
    panel.querySelector('#profile-form').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{const me=await api('/api/account/profile','PUT',{nickname:panel.querySelector('#profile-nickname').value});if(generation===state.generation){$('#account-name').textContent=me.nickname;state.session.nickname=me.nickname;await storeSet('session',state.session);}status.textContent='昵称已保存';}catch(error){status.textContent=error.message;}finally{button.disabled=false;}};
    const bind=panel.querySelector('#bind-email-form');if(bind)bind.onsubmit=async e=>{e.preventDefault();await submit(e,status,()=>api('/api/account/email','POST',{email:panel.querySelector('#bind-email').value}),'绑定邮件已发送，请检查收件箱');};
    const password=panel.querySelector('#password-form');if(password)password.onsubmit=async e=>{e.preventDefault();await submit(e,status,async()=>{await api('/api/account/password','POST',{current_password:panel.querySelector('#current-password').value,new_password:panel.querySelector('#new-password').value});$('#logout').click();},'密码已修改，请重新登录');};
    const wsStatus=panel.querySelector('#workspace-status');
    if(window.desktop){
      panel.querySelector('#workspace-copy').onclick=async e=>{e.target.disabled=true;wsStatus.textContent='正在复制，请勿关闭应用…';try{if(session.mode==='offline')connectCloud();else await useOffline(true);}catch(error){wsStatus.textContent=error.message;}finally{e.target.disabled=false;}};
      const cache=panel.querySelector('#workspace-cache');if(cache)cache.onclick=async()=>{cache.disabled=true;try{await useOffline(true,true);}catch(error){wsStatus.textContent=error.message;}finally{cache.disabled=false;}};
      panel.querySelector('#workspace-switch').onclick=async()=>{try{if(session.mode==='offline'){importAfterLogin=false;connectCloud();importAfterLogin=false;}else await useOffline();}catch(error){wsStatus.textContent=error.message;}};
    }
    panel.querySelector('#workspace-export').onclick=async e=>{e.target.disabled=true;try{const r=await fetch(session.server+'/api/workspace/export',{headers:headers(session),signal:AbortSignal.timeout(300000)});if(!r.ok)throw Error('导出失败，请重试');const url=URL.createObjectURL(await r.blob());const link=document.createElement('a');link.href=url;link.download='交件箱工作区.zip';link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);wsStatus.textContent='已导出，请妥善保管包含个人文件的数据包';}catch(error){wsStatus.textContent=error.message;}finally{e.target.disabled=false;}};
    panel.querySelector('#workspace-import').onchange=async e=>{const file=e.target.files[0];if(!file)return;wsStatus.textContent='正在复制导入…';e.target.disabled=true;try{const form=new FormData();form.append('file',file);const r=await fetch(session.server+'/api/workspace/import',{method:'POST',headers:headers(session),body:form,signal:AbortSignal.timeout(300000)});const data=await r.json();if(!r.ok)throw Error(data.detail||'导入失败');wsStatus.textContent=data.message;await refresh();}catch(error){wsStatus.textContent=error.message;}finally{e.target.disabled=false;e.target.value='';}};
  }
  async function submit(event,status,action,message){const button=event.submitter;button.disabled=true;try{await action();status.textContent=message;}catch(error){status.textContent=error.message;}finally{button.disabled=false;}}
  async function mountMail(panel,generation){
    const c=await api('/api/admin/mail');if(generation!==state.generation||panel!==$('#account-panel'))return;
    panel.insertAdjacentHTML('beforeend',`<div class="divider"></div><h3>服务器邮件设置</h3><p class="helper">仅超级管理员可修改。验证与找回密码邮件默认使用交件箱样式模板。</p><form id="smtp-form"><div class="form-grid"><label>SMTP 地址<input id="smtp-host" value="${esc(c.host)}" placeholder="smtp.example.com"></label><label>端口<input id="smtp-port" type="number" min="1" max="65535" value="${c.port}" required></label></div><label>加密方式<select id="smtp-security"><option value="ssl">SSL/TLS（通常 465）</option><option value="starttls">STARTTLS（通常 587）</option></select></label><label>SMTP 登录账号<input id="smtp-user" value="${esc(c.username)}" autocomplete="off"></label><label>SMTP 密码 / 授权码<input id="smtp-password" type="password" autocomplete="new-password" placeholder="${c.has_password?'已配置，留空保留':'填写邮箱授权码'}"></label><div class="form-grid"><label>发件邮箱<input id="smtp-sender" type="email" value="${esc(c.sender)}"></label><label>发件人名称<input id="smtp-name" value="${esc(c.sender_name)}" maxlength="80"></label></div><label>邮件链接对应的服务地址<input id="smtp-url" type="url" value="${esc(c.public_url||state.session.server)}" required></label><label class="switch-line"><input id="smtp-verify" type="checkbox" ${c.verification_required?'checked':''}><span>新账号必须验证邮箱后才创建</span></label><button class="primary" type="submit">保存邮件设置</button></form><form id="smtp-test-form"><label>测试收件邮箱<input id="smtp-test" type="email" required></label><button class="secondary" type="submit">发送样式测试邮件</button></form><p id="smtp-status" class="helper" role="status"></p>`);
    panel.querySelector('#smtp-security').value=c.security;
    panel.querySelector('#smtp-form').onsubmit=async e=>{e.preventDefault();const q=id=>panel.querySelector('#'+id);await submit(e,q('smtp-status'),async()=>{await api('/api/admin/mail','PUT',{host:q('smtp-host').value.trim(),port:Number(q('smtp-port').value),security:q('smtp-security').value,username:q('smtp-user').value,password:q('smtp-password').value||null,sender:q('smtp-sender').value,sender_name:q('smtp-name').value,public_url:q('smtp-url').value,verification_required:q('smtp-verify').checked});q('smtp-password').value='';},'邮件设置已保存');};
    panel.querySelector('#smtp-test-form').onsubmit=async e=>{e.preventDefault();await submit(e,panel.querySelector('#smtp-status'),()=>api('/api/admin/mail/test','POST',{email:panel.querySelector('#smtp-test').value}),'测试邮件已发送，请检查收件箱');};
  }
  function dialog(title,html){const d=document.createElement('dialog');d.innerHTML=`<form method="dialog" class="settings-panel"><h2>${title}</h2>${html}<p class="helper" role="status"></p><div class="detail-actions"><button class="primary" type="button" data-confirm>确认</button><button class="secondary" type="button" value="cancel">关闭</button></div></form>`;document.body.append(d);d.querySelector('[value=cancel]').onclick=()=>uiMotion.closeDialog(d);d.querySelector('form').onsubmit=e=>{e.preventDefault();d.querySelector('[data-confirm]').click();};d.addEventListener('close',()=>d.remove());uiMotion.openDialog(d);return d;}
  $('#other-server').hidden=!window.desktop;
  $('#other-server').onclick=()=>{const label=$('#server-url').closest('label');label.hidden=!label.hidden;if(label.hidden)$('#server-url').value=window.desktop?CLOUD:location.origin;$('#other-server').textContent=label.hidden?'连接其他自建服务器':'使用默认服务器';$('#server-url').dispatchEvent(new Event('change'));};
  $('#offline-login').hidden=!window.desktop;
  $('#offline-login').onclick=async e=>{e.target.disabled=true;try{await useOffline();}catch(error){$('#auth-error').textContent=error.message;}finally{e.target.disabled=false;}};
  $('#forgot-password').onclick=()=>{const d=dialog('找回密码','<label>已绑定邮箱<input type="email" name="email" required autocomplete="email"></label>');d.querySelector('[data-confirm]').onclick=async e=>{if(!d.querySelector('form').reportValidity())return;e.target.disabled=true;try{const r=await fetch($('#server-url').value.replace(/\/$/,'')+'/api/auth/forgot-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:d.querySelector('input').value}),signal:AbortSignal.timeout(25000)});const data=await r.json();if(!r.ok)throw Error(data.detail||'请求失败');d.querySelector('[role=status]').textContent=data.message;}catch(error){d.querySelector('[role=status]').textContent=error.message;}finally{e.target.disabled=false;}};};
  const query=new URLSearchParams(location.search),action=query.get('mail_action'),token=query.get('token');
  if(query.has('forgot')){$('#forgot-password').click();history.replaceState(null,'',location.pathname);}
  if(action&&token){history.replaceState(null,'',location.pathname);const d=dialog(action==='reset'?'设置新密码':'确认邮箱',action==='reset'?'<label>新密码<input type="password" minlength="10" maxlength="256" autocomplete="new-password" required></label>':'<p>确认完成本次邮箱验证。链接仅可使用一次。</p>');d.querySelector('[data-confirm]').onclick=async e=>{if(!d.querySelector('form').reportValidity())return;e.target.disabled=true;try{const r=await fetch(location.origin+'/api/auth/mail/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,password:d.querySelector('input')?.value||''})});const data=await r.json();if(!r.ok)throw Error(data.detail||'确认失败');d.querySelector('[role=status]').textContent=data.message;d.querySelector('input')?.remove();}catch(error){d.querySelector('[role=status]').textContent=error.message;e.target.disabled=false;}};}
  setTimeout(()=>mount(),0);
  return {mount,afterLogin,useOffline};
})();
