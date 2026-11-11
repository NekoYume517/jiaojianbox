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
    $('#view').insertAdjacentHTML('beforeend',`<section id="account-panel" class="panel settings-panel admin-panel"><div class="profile-card"><span class="profile-avatar" aria-hidden="true"></span><div class="profile-meta"><strong id="profile-name"></strong><small id="profile-email" class="helper"></small><small id="profile-connection" class="helper"></small></div><button type="button" class="secondary" id="profile-edit">编辑资料</button></div><div class="divider"></div><h3>数据与连接</h3><p id="workspace-note" class="helper"></p><div id="workspace-rows" class="settings-rows"></div><p id="workspace-status" class="helper" role="status"></p></section>`);
    const panel=$('#account-panel');
    const status=panel.querySelector('#workspace-status');
    let me=null;
    try{
      me=await api('/api/auth/me');if(generation!==state.generation||panel!==$('#account-panel'))return;
      paintProfile(session,me);
    }catch(error){status.textContent=error.message;}
    $('#profile-edit').onclick=()=>{if(me)openProfileEditor(session,me,updated=>{me=updated;paintProfile(session,updated);});};
    buildWorkspaceRows(session,status);
  }
  function paintProfile(session,me){
    const name=me.nickname||me.username;
    $('#profile-name').textContent=name;
    $('#account-name').textContent=session.mode==='offline'&&me.nickname==='offline'?'本机工作区':name;
    $('.profile-avatar').textContent=(name[0]||'交').toUpperCase();
    $('#profile-email').textContent=me.email?me.email+(me.verified?' · 已验证':' · 尚未验证'):(session.mode==='offline'?'离线工作区不使用邮箱':'尚未绑定邮箱，绑定后可以找回密码');
    $('#profile-connection').textContent=session.mode==='offline'?'数据保存在这台电脑上':session.server+(me.is_admin?' · 超级管理员':'');
  }
  function openProfileEditor(session,me,onChange){
    const offline=session.mode==='offline';
    const editor=document.createElement('dialog');
    editor.innerHTML=`<div class="dialog-heading"><div><div class="eyebrow">我的</div><h2>编辑资料</h2></div><button type="button" class="icon-button" data-editor-close aria-label="关闭">×</button></div><div class="dialog-body settings-panel"><form id="editor-nickname-form"><label>昵称<input id="editor-nickname" maxlength="64" required value="${esc(me.nickname||me.username)}"></label><button class="primary" type="submit">保存昵称</button></form>${offline?'':`<div class="divider"></div><form id="editor-email-form"><label>绑定邮箱<input id="editor-email" type="email" required autocomplete="email" value="${esc(me.email||'')}"></label><button class="secondary" type="submit">发送绑定验证邮件</button><p class="helper">绑定后可用邮箱找回密码，需要点击邮件里的确认链接完成验证。</p></form><div class="divider"></div><form id="editor-password-form"><label>当前密码<input id="editor-current" type="password" autocomplete="current-password" required></label><label>新密码<input id="editor-new" type="password" autocomplete="new-password" minlength="10" required></label><button class="secondary" type="submit">修改密码并退出其他设备</button></form>`}<p id="editor-status" class="helper" role="status"></p></div>`;
    document.body.append(editor);
    const box=editor.querySelector('#editor-status');
    editor.querySelector('#editor-nickname-form').onsubmit=async e=>{e.preventDefault();await submit(e,box,async()=>{const updated=await api('/api/account/profile','PUT',{nickname:editor.querySelector('#editor-nickname').value});state.session.nickname=updated.nickname;await storeSet('session',state.session);onChange(updated);},'昵称已保存');};
    const emailForm=editor.querySelector('#editor-email-form');if(emailForm)emailForm.onsubmit=async e=>{e.preventDefault();await submit(e,box,()=>api('/api/account/email','POST',{email:editor.querySelector('#editor-email').value}),'绑定邮件已发送，请检查收件箱');};
    const passwordForm=editor.querySelector('#editor-password-form');if(passwordForm)passwordForm.onsubmit=async e=>{e.preventDefault();await submit(e,box,async()=>{await api('/api/account/password','POST',{current_password:editor.querySelector('#editor-current').value,new_password:editor.querySelector('#editor-new').value});uiMotion.closeDialog(editor);$('#logout').click();},'密码已修改，请重新登录');};
    editor.querySelector('[data-editor-close]').onclick=()=>uiMotion.closeDialog(editor);
    editor.addEventListener('close',()=>editor.remove());
    uiMotion.openDialog(editor);
  }
  function buildWorkspaceRows(session,wsStatus){
    $('#workspace-note').textContent=session.mode==='offline'?'当前为本机离线工作区，附件、通知和待办保存在这台设备上。':'当前连接：'+session.server+'。复制导入不会删除来源数据，重复导入会跳过已有内容；模型配置会复制，API Key 需要在目标工作区重新填写。';
    const rows=[];
    if(window.desktop)rows.push({id:'workspace-copy',action:session.mode==='offline'?'登录云端':'复制到本机',label:session.mode==='offline'?'登录云端并上传本地数据':'复制到本机并离线使用',desc:session.mode==='offline'?'登录云端后，把本机数据包上传合并到云端工作区。':'把云端数据复制到这台电脑，断网时也能继续使用。'});
    if(window.desktop&&session.mode!=='offline')rows.push({id:'workspace-cache',action:'转离线',label:'仅将本机缓存转为离线',desc:'不含附件，只把浏览过的通知与待办转为本机离线数据。'});
    if(window.desktop)rows.push({id:'workspace-switch',action:session.mode==='offline'?'连接云端':'切换离线',label:session.mode==='offline'?'仅连接云端或自建服务器':'仅切换到离线工作区',desc:'不复制数据，直接切换当前使用的工作区。'});
    $('#workspace-rows').innerHTML=rows.map(row=>`<div class="settings-row"><div><strong>${esc(row.label)}</strong><small>${esc(row.desc)}</small></div><button type="button" class="secondary" id="${row.id}">${esc(row.action)}</button></div>`).join('')
      +'<div class="settings-row"><div><strong>导出与导入数据包</strong><small>导出包含个人文件的完整数据包，或用备份文件恢复到当前工作区。</small></div><div class="settings-row-buttons"><button type="button" class="secondary" id="workspace-export">导出</button><label class="secondary">导入<input id="workspace-import" type="file" accept=".zip" hidden></label></div></div>';
    const copy=$('#workspace-copy');if(copy)copy.onclick=async e=>{e.target.disabled=true;wsStatus.textContent='正在复制，请勿关闭应用…';try{if(session.mode==='offline')connectCloud();else await useOffline(true);}catch(error){wsStatus.textContent=error.message;}finally{e.target.disabled=false;}};
    const cache=$('#workspace-cache');if(cache)cache.onclick=async()=>{cache.disabled=true;try{await useOffline(true,true);}catch(error){wsStatus.textContent=error.message;}finally{cache.disabled=false;}};
    const workspaceSwitch=$('#workspace-switch');if(workspaceSwitch)workspaceSwitch.onclick=async()=>{try{if(session.mode==='offline'){importAfterLogin=false;connectCloud();importAfterLogin=false;}else await useOffline();}catch(error){wsStatus.textContent=error.message;}};
    $('#workspace-export').onclick=async e=>{e.target.disabled=true;try{await saveDownload('/api/workspace/export','交件箱工作区.zip');wsStatus.textContent='已导出，请妥善保管包含个人文件的数据包';}catch(error){wsStatus.textContent=error.message;}finally{e.target.disabled=false;}};
    $('#workspace-import').onchange=async e=>{const file=e.target.files[0];if(!file)return;wsStatus.textContent='正在复制导入…';e.target.disabled=true;try{const form=new FormData();form.append('file',file);const r=await fetch(session.server+'/api/workspace/import',{method:'POST',headers:headers(session),body:form,signal:AbortSignal.timeout(300000)});const data=await r.json();if(!r.ok)throw Error(data.detail||'导入失败');wsStatus.textContent=data.message;await refresh();}catch(error){wsStatus.textContent=error.message;}finally{e.target.disabled=false;e.target.value='';}};
  }
  async function submit(event,status,action,message){const button=event.submitter;button.disabled=true;try{await action();status.textContent=message;}catch(error){status.textContent=error.message;}finally{button.disabled=false;}}
  function dialog(title,html){const d=document.createElement('dialog');d.innerHTML=`<form method="dialog" class="settings-panel"><h2>${title}</h2>${html}<p class="helper" role="status"></p><div class="detail-actions"><button class="primary" type="button" data-confirm>确认</button><button class="secondary" type="button" value="cancel">关闭</button></div></form>`;document.body.append(d);d.querySelector('[value=cancel]').onclick=()=>uiMotion.closeDialog(d);d.querySelector('form').onsubmit=e=>{e.preventDefault();d.querySelector('[data-confirm]').click();};d.addEventListener('close',()=>d.remove());uiMotion.openDialog(d);return d;}
  $('#other-server').hidden=!window.desktop;
  $('#other-server').onclick=()=>{const label=$('#server-url').closest('label');label.hidden=!label.hidden;if(label.hidden)$('#server-url').value=window.desktop?CLOUD:location.origin;$('#other-server').textContent=label.hidden?'连接其他自建服务器':'使用默认服务器';$('#server-url').dispatchEvent(new Event('change'));};
  $('#offline-login').hidden=!window.desktop;
  $('#offline-login').onclick=async e=>{e.target.disabled=true;try{await useOffline();}catch(error){$('#auth-error').textContent=error.message;}finally{e.target.disabled=false;}};
  $('#forgot-password').onclick=()=>{const d=dialog('找回密码','<label>已绑定邮箱<input type="email" name="email" required autocomplete="email"></label>');d.querySelector('[data-confirm]').onclick=async e=>{if(!d.querySelector('form').reportValidity())return;e.target.disabled=true;try{const r=await fetch($('#server-url').value.replace(/\/$/,'')+'/api/auth/forgot-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:d.querySelector('input').value}),signal:AbortSignal.timeout(25000)});const data=await r.json();if(!r.ok)throw Error(data.detail||'请求失败');d.querySelector('[role=status]').textContent=data.message;}catch(error){d.querySelector('[role=status]').textContent=error.message;}finally{e.target.disabled=false;}};};
  const query=new URLSearchParams(location.search),action=query.get('mail_action'),token=query.get('token');
  if(query.has('forgot')){$('#forgot-password').click();history.replaceState(null,'',location.pathname);}
  if(action&&token){history.replaceState(null,'',location.pathname);const d=dialog(action==='reset'?'设置新密码':'确认邮箱',action==='reset'?'<label>新密码<input type="password" minlength="10" maxlength="256" autocomplete="new-password" required></label>':'<p>确认完成本次邮箱验证。链接仅可使用一次。</p>');d.querySelector('[data-confirm]').onclick=async e=>{if(!d.querySelector('form').reportValidity())return;e.target.disabled=true;try{const r=await fetch(location.origin+'/api/auth/mail/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,password:d.querySelector('input')?.value||''})});const data=await r.json();if(!r.ok)throw Error(data.detail||'确认失败');d.querySelector('[role=status]').textContent=data.message;d.querySelector('input')?.remove();if(data.session){const session={...data.session,server:location.origin};localStorage.setItem('jjb-session',JSON.stringify(session));if(typeof data.continue_path==='string'&&/^\/authorize\?code=[0-9A-F]{8}$/.test(data.continue_path)){location.assign(data.continue_path);return;}await uiMotion.closeDialog(d);d.remove();await enter(session);}}catch(error){d.querySelector('[role=status]').textContent=error.message;e.target.disabled=false;}};}
  setTimeout(()=>mount(),0);
  return {mount,afterLogin,useOffline};
})();
