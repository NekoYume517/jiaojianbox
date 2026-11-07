'use strict';
(() => {
  let instances=[],detecting=null,resumeTimer,authorizationGeneration=0,authorizeUrl='',lastSessionGeneration=-1;
  const authorizationCode=()=>new URLSearchParams(location.search).get('code')||'';
  const appearancePanel=()=>`<section class="panel appearance-panel"><div class="appearance-heading"><div><h3>外观</h3><p class="helper">选择适合当前设备的颜色、文字和信息密度。</p></div><div data-theme-picker></div></div><div class="theme-options">${[['light','浅色'],['dark','深色'],['system','跟随系统']].map(([mode,label])=>`<button type="button" class="theme-option" data-theme-mode="${mode}"><div class="theme-preview ${mode}"></div><span>${appearance.icon(mode)}${label}</span></button>`).join('')}</div><div class="appearance-fields"><label>信息密度<select id="appearance-density"><option value="comfortable">舒适</option><option value="compact">紧凑</option></select></label><label>文字大小<select id="appearance-text-size"><option value="normal">标准</option><option value="large">较大</option></select></label></div></section>`;
  function decorate(page){
    if(page==='settings'&&!$('#appearance-panel-marker')){
      const marker=document.createElement('div');marker.id='appearance-panel-marker';marker.innerHTML=appearancePanel();$('#view .page-heading').after(marker);appearance.refresh();
    }
    if(state.session)$('#shelf-handle').hidden=false;
  }
  function chatList(type){
    const list=(state.sources.conversations||[]).filter(c=>c.source===type);
    return `<div class="chat-toolbar"><input data-chat-search="${type}" placeholder="搜索联系人或群聊" aria-label="搜索${type==='qq'?'QQ':'微信'}会话"><span class="helper" data-chat-count="${type}" aria-live="polite">已选 ${(state.sources[type+'_chats']||[]).length} 个</span></div><div class="conversation-list">${list.length?list.map(c=>`<label class="conversation-row" data-chat-label="${type}" data-search="${esc(c.name+' '+c.id)}"><input type="checkbox" data-subscribe="${type}" value="${esc(c.id)}" ${(state.sources[type+'_chats']||[]).includes(c.id)?'checked':''}><span><strong>${esc(c.name)}</strong><small>${c.id.startsWith('group:')||c.id.endsWith('@chatroom')?'群聊':'联系人'}</small></span></label>`).join(''):`<div class="empty"><strong>${type==='qq'?'选择一个 QQ 实例':'正在等待微信登录'}</strong><div>连接后，在这里勾选需要关注的聊天。</div></div>`}</div>`;
  }
  function sourcesView(){
    if(!window.desktop)return heading('消息来源','电脑自动读取，网页管理自己的内容。')+`<section class="panel">${empty('在桌面客户端选择聊天','连接后，通知、待办和材料会同步到这里。')}</section>`;
    const c=state.sources;
    return heading('消息来源','第一次选好聊天，以后打开就会自动读取。',`<button class="secondary" data-experience="detect">重新检测</button>`)+
    `<section class="panel auto-source-panel"><label class="switch-line"><input id="sources-auto" type="checkbox" ${c.auto_start!==false?'checked':''}><span><strong>打开应用后自动读取</strong><small>自动恢复上次选择的 QQ／微信和聊天，不需要再次启动。</small></span></label><span id="collector-status" class="collector-status" role="status">正在准备连接</span></section>`+
    `<div class="source-grid"><section class="panel source-card"><div class="source-title"><span class="source-mark qq">QQ</span><div><h3>QQ 消息</h3><small>选择已登录实例，再勾选聊天。</small></div><input id="qq-enabled" aria-label="启用 QQ 读取" type="checkbox" ${c.qq_enabled!==false?'checked':''}></div><div id="qq-instances" class="instance-list">${instances.length?instances.map(p=>`<div class="instance-row"><span class="instance-avatar">Q</span><div><strong>${esc(p.nickname||p.uin||(p.accounts?.[0]?.nickname)||'QQ 客户端')}</strong><small>${esc(p.uin||'实例 '+p.pid)} · ${c.qq_pid===p.pid?'已选择':'已检测'}</small></div><button class="${c.qq_pid===p.pid?'plain-button':'secondary'}" data-connect-qq="${p.pid}">${c.qq_pid===p.pid?'刷新聊天':'连接'}</button></div>`).join(''):'<p class="helper">正在检测本机 QQ，保持 QQ 登录即可。</p>'}</div>${chatList('qq')}</section><section class="panel source-card"><div class="source-title"><span class="source-mark">微</span><div><h3>微信消息</h3><small>自动识别已登录微信，勾选后即可读取。</small></div><input id="wechat-enabled" aria-label="启用微信读取" type="checkbox" ${c.wechat_enabled!==false?'checked':''}></div><button class="plain-button" data-experience="refresh-wechat">刷新微信聊天</button>${chatList('wechat')}</section></div>`+
    `<details class="panel advanced-source"><summary>高级与调试 <span class="helper">连接详情、读取检查、运行记录</span></summary><div class="advanced-body"><div class="form-grid"><label>SnowLuma 安装目录<input id="snowluma-home" value="${esc(c.snowluma_home||'')}" placeholder="自动检测"><button type="button" class="link" data-experience="select-runtime">选择目录</button></label><label>Python 解释器<input id="python-path" value="${esc(c.python_path||'')}" placeholder="自动使用本机 Python"></label></div><div class="form-grid"><label>仅采集含关键词的消息<input id="capture-keywords" value="${esc(c.capture_keywords||'')}" placeholder="留空处理勾选聊天的全部消息"></label><label>QQ 连接方式<select id="qq-transport"><option value="managed">应用内免配置接入</option><option value="external">外部 OneBot（兼容调试）</option></select></label></div><details><summary class="helper">兼容连接参数</summary><div class="form-grid"><label>HTTP 地址<input id="qq-http" value="${esc(c.qq_http_url||'http://127.0.0.1:3000')}"></label><label>WebSocket 地址<input id="qq-ws" value="${esc(c.qq_ws_url||'ws://127.0.0.1:3001')}"></label></div><label>Access Token<input id="qq-token" type="password" value="${esc(c.qq_token||'')}" autocomplete="new-password"></label><div class="form-grid"><label>微信账号目录<input id="wechat-account" value="${esc(c.wechat_account||'')}" placeholder="自动检测"></label><label>微信数据库目录<input id="wechat-db-dir" value="${esc(c.wechat_db_dir||'')}" placeholder="自动检测"></label></div></details><div class="source-actions"><button class="secondary" data-experience="save">保存并恢复连接</button><button class="secondary" data-experience="diagnostics">检查读取状态</button><button class="plain-button" data-experience="stop">暂停本次读取</button></div><div class="form-grid debug-controls"><label>读取动作<select id="debug-action"><option value="get_login_info">账号状态</option><option value="get_group_list">群聊列表</option><option value="get_friend_list">联系人列表</option><option value="get_status">运行状态</option><option value="get_group_msg_history">群消息历史</option></select></label><label>参数<textarea id="debug-params" rows="2" placeholder='例如：{"group_id":123}'>{}</textarea></label></div><button class="secondary" data-experience="debug">执行读取检查</button><pre id="source-debug" class="debug-output" hidden></pre></div></details>`;
  }
  function configFromForm(){
    const c=readSourcesForm();
    if($('#sources-auto')){
      c.auto_start=$('#sources-auto').checked;c.qq_enabled=$('#qq-enabled').checked;c.wechat_enabled=$('#wechat-enabled').checked;
      c.snowluma_home=$('#snowluma-home').value.trim();c.qq_transport=$('#qq-transport').value;
    }
    return c;
  }
  async function persist(){await storeSet('sources-'+state.profile,state.sources);}
  async function resume(){
    if(!window.desktop||!state.session)return;
    const c=state.sources;
    if(c.auto_start===false)return;
    const config={...c,qq_chats:c.qq_enabled===false?[]:c.qq_chats||[],wechat_chats:c.wechat_enabled===false?[]:c.wechat_chats||[]};
    if(!config.qq_chats.length&&!config.wechat_chats.length)return;
    try{await desktop.startCollector({...config,server_url:state.session.server,server_token:state.session.token,user_id:state.session.user_id,conversation_names:Object.fromEntries((c.conversations||[]).map(x=>[x.id,x.name]))});}
    catch(error){showCollectorState({state:'error',message:error.message});}
  }
  async function wechatContacts(){
    if(!window.desktop||state.sources.wechat_enabled===false)return;
    const result=await desktop.listConversations('wechat',state.sources);
    state.sources.wechat_account=result.account;
    state.sources.conversations=[...(state.sources.conversations||[]).filter(x=>x.source!=='wechat'),...result.conversations];
    await persist();if(state.page==='sources')render();
  }
  async function detect(startup=false){
    if(!window.desktop||!state.session)return;
    if(detecting)return detecting;
    detecting=(async()=>{
      try{const result=await desktop.discoverQQ(state.sources.snowluma_home);instances=result.instances;if(state.page==='sources'){render();$('#qq-transport').value=state.sources.qq_transport||'managed';}}
      catch(error){if(state.page==='sources')showCollectorState({state:'error',message:error.message});}
      if(!(state.sources.conversations||[]).some(x=>x.source==='wechat'))try{await wechatContacts();}catch(error){if(state.page==='sources')showCollectorState({state:'error',message:error.message});}
      if(startup)await resume();
    })().finally(()=>{detecting=null;});return detecting;
  }
  function prepareLogin(){
    if(!window.desktop)return;
    document.body.classList.add('desktop-auth-mode');
    for(const id of ['username','password']){$('#'+id).required=false;$('#'+id).closest('label').hidden=true;}
    $('#auth-switch').hidden=true;$('#auth-title').textContent='登录交件箱';$('#auth-submit').textContent='在浏览器中登录';
    $('#auth-form>.muted').textContent='在浏览器确认账号，完成后会自动回到这里。';
    if(!$('#device-status')){$('#auth-submit').insertAdjacentHTML('afterend','<div id="device-status" class="device-status" hidden><p class="helper">在浏览器中确认以下授权码</p><div id="device-code" class="device-code"></div><div class="detail-actions"><button type="button" class="link" data-experience="reopen-auth">重新打开浏览器</button><button type="button" class="plain-button" data-experience="cancel-auth">取消</button></div></div>');}
  }
  async function browserLogin(){
    $('#auth-error').textContent='';
    let base;
    try{const value=new URL($('#server-url').value.trim());if(!['http:','https:'].includes(value.protocol)||value.username||value.password||value.search||value.hash)throw new Error();base=value.href.replace(/\/$/,'');}catch{return $('#auth-error').textContent='请填写有效的服务端地址';}
    const generation=++authorizationGeneration;$('#auth-submit').disabled=true;
    try{
      const start=await fetch(base+'/api/auth/device/start',{method:'POST',signal:AbortSignal.timeout(15000)});
      const data=await start.json();if(!start.ok)throw new Error(data.detail||'无法创建授权请求');
      const url=new URL(data.verification_path,base);if(url.origin!==new URL(base).origin||url.pathname!=='/authorize')throw new Error('授权地址无效');
      authorizeUrl=url.href;$('#device-status').hidden=false;$('#device-code').textContent=data.user_code;
      await desktop.external(authorizeUrl);
      const deadline=Date.now()+data.expires_in*1000;
      while(generation===authorizationGeneration&&Date.now()<deadline){
        await new Promise(resolve=>setTimeout(resolve,2000));if(generation!==authorizationGeneration)return;
        let response;try{response=await fetch(base+'/api/auth/device/poll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({device_code:data.device_code}),signal:AbortSignal.timeout(15000)});}catch{continue;}
        const result=await response.json();if(!response.ok)throw new Error(result.detail||'授权未完成');
        if(result.status==='approved'){
          const session={token:result.token,user_id:result.user_id,username:result.username,server:base};
          await storeSet('session',session);$('#device-status').hidden=true;await enter(session);return;
        }
      }
      if(generation===authorizationGeneration)throw new Error('授权已过期，请重新登录');
    }catch(error){$('#auth-error').textContent=error.message||'无法连接服务端';}
    finally{if(generation===authorizationGeneration)$('#auth-submit').disabled=false;}
  }
  async function showConsent(){
    $('#workspace').hidden=true;$('#auth').hidden=true;$('#shelf-handle').hidden=true;$('#browser-consent').hidden=false;
    const code=authorizationCode();$('#consent-code').textContent=code.length===8?code.slice(0,4)+'-'+code.slice(4):code;
    $('#consent-account').textContent='当前账号：'+state.session.username;
    try{const result=await api('/api/auth/device/request?code='+encodeURIComponent(code));if(result.state!=='pending'){$('#consent-status').textContent='该请求已处理，可以返回客户端。';$('#approve-device').disabled=true;$('#deny-device').disabled=true;}}
    catch(error){$('#consent-status').textContent=error.message;$('#approve-device').disabled=true;$('#deny-device').disabled=true;}
  }
  async function onSession(){
    if(lastSessionGeneration===state.generation)return;lastSessionGeneration=state.generation;
    if(location.pathname==='/authorize')return showConsent();
    $('#browser-consent').hidden=true;$('#shelf-handle').hidden=false;
    if(window.desktop)detect(true);
  }
  document.addEventListener('click',async event=>{
    const connect=event.target.closest('[data-connect-qq]');const action=event.target.closest('[data-experience]');
    if(!connect&&!action)return;
    try{
      if(connect){
        connect.disabled=true;const c=configFromForm();const result=await desktop.connectQQ({pid:Number(connect.dataset.connectQq),home:c.snowluma_home});
        c.qq_account=result.account||result.uin;c.qq_pid=Number(connect.dataset.connectQq);c.qq_transport='managed';c.conversations=[...(c.conversations||[]).filter(x=>x.source!=='qq'),...result.conversations];
        await persist();render();await resume();toast('已连接 QQ，勾选聊天后自动读取');return;
      }
      switch(action.dataset.experience){
        case 'detect':await detect(false);break;
        case 'refresh-wechat':action.disabled=true;await wechatContacts();break;
        case 'save':configFromForm();await persist();await resume();toast('已保存，后续自动恢复读取');break;
        case 'stop':await desktop.stopCollector();break;
        case 'select-runtime':{const home=await desktop.selectRuntime();if(home){$('#snowluma-home').value=home;state.sources.snowluma_home=home;await persist();await detect(false);}break;}
        case 'diagnostics':{$('#source-debug').hidden=false;$('#source-debug').textContent=JSON.stringify(await desktop.sourceDiagnostics(),null,2);break;}
        case 'debug':{let params;try{params=JSON.parse($('#debug-params').value);}catch{throw new Error('参数需要是有效 JSON');}const result=await desktop.debugQQ({uin:state.sources.qq_account,action:$('#debug-action').value,params});$('#source-debug').hidden=false;$('#source-debug').textContent=JSON.stringify(result,null,2);break;}
        case 'reopen-auth':if(authorizeUrl)await desktop.external(authorizeUrl);break;
        case 'cancel-auth':authorizationGeneration++;$('#auth-submit').disabled=false;$('#device-status').hidden=true;break;
      }
    }catch(error){toast(error.message);}finally{if(connect?.isConnected)connect.disabled=false;if(action?.isConnected)action.disabled=false;}
  });
  document.addEventListener('change',event=>{
    if(event.target.matches('[data-subscribe],#sources-auto,#qq-enabled,#wechat-enabled')){
      configFromForm();for(const type of ['qq','wechat']){const count=document.querySelector('[data-chat-count="'+type+'"]');if(count)count.textContent='已选 '+(state.sources[type+'_chats']||[]).length+' 个';}clearTimeout(resumeTimer);resumeTimer=setTimeout(async()=>{try{await persist();if(state.sources.auto_start===false)await desktop.stopCollector();else await resume();}catch(error){toast(error.message);}},800);
    }
  });
  document.addEventListener('input',event=>{if(event.target.dataset.chatSearch){const type=event.target.dataset.chatSearch;const query=event.target.value.toLowerCase();$$(`[data-chat-label="${type}"]`).forEach(row=>{row.hidden=!row.dataset.search.toLowerCase().includes(query);});}});
  $('#approve-device').addEventListener('click',()=>approve(true));$('#deny-device').addEventListener('click',()=>approve(false));
  async function approve(allowed){
    $('#approve-device').disabled=true;$('#deny-device').disabled=true;
    try{await api('/api/auth/device/approve','POST',{user_code:authorizationCode(),approve:allowed});$('#consent-status').textContent=allowed?'授权完成，可以返回桌面客户端。':'已取消此次授权。';}
    catch(error){$('#consent-status').textContent=error.message;$('#approve-device').disabled=false;$('#deny-device').disabled=false;}
  }
  $('#consent-workspace').addEventListener('click',()=>{history.replaceState(null,'','/');$('#browser-consent').hidden=true;$('#workspace').hidden=false;$('#shelf-handle').hidden=false;render();});
  window.addEventListener('appearance-error',()=>toast('外观已应用，但本机偏好未能保存'));
  window.experience={sourcesView,decorate,detect,onSession,prepareLogin,browserLogin};
  if(window.desktop){prepareLogin();desktop.onAppearance(value=>appearance.restore(value));}
  if(state.session)onSession();
})();
