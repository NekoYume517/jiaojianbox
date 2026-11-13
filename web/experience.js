'use strict';
(() => {
  let instances=[],detecting=null,authorizationGeneration=0,authorizeUrl='',lastSessionGeneration=-1,sourceDraft=null,sourceDraftProfile='';
  function resetSourceDraft(){
    const c=state.sources||{};
    sourceDraftProfile=state.profile||'';
    sourceDraft={
      profile:sourceDraftProfile,
      qq:new Set(Array.isArray(c.qq_chats)?c.qq_chats:[]),
      wechat:new Set(Array.isArray(c.wechat_chats)?c.wechat_chats:[]),
      auto_start:c.auto_start!==false,
      qq_enabled:c.qq_enabled!==false,
      wechat_enabled:c.wechat_enabled!==false,
    };
    return sourceDraft;
  }
  function ensureSourceDraft(){
    if(!sourceDraft||sourceDraft.profile!==(state.profile||''))return resetSourceDraft();
    return sourceDraft;
  }
  function sameSet(left,right){
    const items=Array.isArray(right)?right:[];
    return left.size===items.length&&items.every(item=>left.has(item));
  }
  function sourceDraftDirty(){
    const draft=ensureSourceDraft(),c=state.sources||{};
    return !sameSet(draft.qq,c.qq_chats)||!sameSet(draft.wechat,c.wechat_chats)||
      draft.auto_start!==(c.auto_start!==false)||draft.qq_enabled!==(c.qq_enabled!==false)||
      draft.wechat_enabled!==(c.wechat_enabled!==false);
  }
  function updateSourceDraftUI(){
    if(state.page!=='sources')return;
    const draft=ensureSourceDraft(),dirty=sourceDraftDirty();
    const button=document.querySelector('[data-source-save]');
    if(button)button.disabled=!dirty;
    const title=document.querySelector('[data-source-save-title]');
    if(title)title.textContent=dirty?'有未保存的会话变更':'采集设置已保存';
    const copy=document.querySelector('[data-source-save-copy]');
    if(copy)copy.textContent=`QQ ${draft.qq.size} 个 · 微信 ${draft.wechat.size} 个${dirty?' · 保存后按新选择恢复读取':' · 已勾选会话显示在最前'}`;
    for(const type of ['qq','wechat']){
      const count=document.querySelector(`[data-chat-count="${type}"]`);
      if(count)count.textContent=`本次选择 ${draft[type].size} 个`;
    }
  }
  const appearancePanel=()=>`<section id="settings-appearance" class="panel appearance-panel"><div class="appearance-heading"><div><h3>外观</h3><p class="helper">选择适合当前设备的颜色、文字和信息密度。</p></div><div data-theme-picker></div></div><div class="theme-options">${[['light','浅色'],['dark','深色'],['system','跟随系统']].map(([mode,label])=>`<button type="button" class="theme-option" data-theme-mode="${mode}"><div class="theme-preview ${mode}"></div><span>${appearance.icon(mode)}${label}</span></button>`).join('')}</div><div class="appearance-fields"><label>配色主题<select id="appearance-palette"><option value="magpie">默认</option><option value="tokyo-night">Tokyo Night</option><option value="nord">Nord</option><option value="graphite">Graphite</option></select></label><label>信息密度<select id="appearance-density"><option value="comfortable">舒适</option><option value="compact">紧凑</option></select></label><label>文字大小<select id="appearance-text-size"><option value="normal">标准</option><option value="large">较大</option></select></label></div></section>`;
  function reminderPanel(){
    const section=document.createElement('section');
    section.id='settings-reminders';
    section.className='panel appearance-panel reminder-panel';
    section.innerHTML=`<div class="reminder-heading"><div><h3>桌面提醒</h3><p class="helper">待办到达提醒时间后，通过 Windows 10/11 本机通知中心显示，点击通知会打开对应待办。</p></div><span class="reminder-native-badge" data-reminder-native>正在检查系统通知</span></div><label class="switch-line"><input type="checkbox" data-reminder-option="enabled"><span><strong>启用待办提醒</strong><small data-reminder-copy>提交或归档的待办会自动停止提醒。</small></span></label><div class="detail-actions reminder-test-actions"><button type="button" class="secondary" data-reminder-test>发送测试通知</button></div>`;
    const toggle=section.querySelector('[data-reminder-option="enabled"]');
    const test=section.querySelector('[data-reminder-test]');
    const badge=section.querySelector('[data-reminder-native]');
    const copy=section.querySelector('[data-reminder-copy]');
    const render=(value={})=>{
      const supported=value.native_supported!==false;
      const available=value.native_available===true;
      toggle.checked=!!value.enabled;
      toggle.disabled=!supported||!available;
      test.disabled=!supported||!available;
      badge.dataset.state=!supported?'unsupported':available?'ready':'waiting';
      badge.textContent=!supported?'当前系统不支持':available?'Windows 10/11 原生通知':'原生通知正在初始化';
      copy.textContent=!supported?'此功能仅支持 Windows 10 及以上版本。':available?'提交或归档的待办会自动停止提醒。':value.native_error||'系统通知服务尚未就绪，暂时不能启用。';
      if(!supported||!available)return;
      copy.textContent=value.enabled?'提交或归档的待办会自动停止提醒'+(value.next_at?' · 下次提醒 '+formatDate(value.next_at):' · 暂无待发送提醒')+'。':'提醒已关闭；提交或归档的待办不会发送通知。';
    };
    let refreshAttempt=0;
    const refresh=async()=>{
      try{
        const value=await desktop.reminderGet();
        render(value);
        if(value.native_supported&&!value.native_available&&!value.native_error&&refreshAttempt++<6)setTimeout(refresh,500);
      }catch(error){
        if(refreshAttempt++<2)setTimeout(refresh,500);
        else render({native_supported:false,native_error:error.message});
      }
    };
    refresh();
    section.addEventListener('change',async event=>{
      if(!event.target.matches('[data-reminder-option="enabled"]'))return;
      const input=event.target;
      input.disabled=true;
      try{render(await desktop.reminderSet({enabled:input.checked}));}
      catch(error){toast(error.message,undefined,true);input.checked=!input.checked;input.disabled=false;}
    });
    section.addEventListener('click',async event=>{
      const button=event.target.closest('[data-reminder-test]');
      if(!button)return;
      button.disabled=true;
      try{
        const value=await desktop.reminderTest();
        toast(value.ok?'测试通知已发送到本机通知中心':value.message,undefined,true);
      }catch(error){toast(error.message,undefined,true);}
      finally{button.disabled=false;}
    });
    return section;
  }
  function decorate(page){
    if(page==='settings'&&!$('#appearance-panel-marker')){
      const marker=document.createElement('div');marker.id='appearance-panel-marker';marker.innerHTML=appearancePanel();$('#view .page-heading').after(marker);appearance.refresh();
      if(window.desktop){
        const panel=document.createElement('section');panel.id='settings-quick';panel.className='panel appearance-panel';panel.innerHTML='<h3>桌面快捷收集</h3><p class="helper">拖动标题栏调整位置，下次打开会记住。文件拖入后保持打开，可按 Esc 或 × 关闭。</p>'+[['enabled','启用快捷收集（拖拽、快捷键和托盘）'],['drop','显示文件拖拽框'],['note','显示随手记'],['files','显示文件列表']].map(([key,label])=>`<label class="switch-line"><input type="checkbox" data-quick-option="${key}"><span>${label}</span></label>`).join('')+'<p class="helper" data-quick-status role="status"></p>';marker.append(panel);let prefs;desktop.quickGet().then(value=>{prefs=value;panel.querySelectorAll('[data-quick-option]').forEach(input=>input.checked=prefs[input.dataset.quickOption]!==false);}).catch(e=>panel.querySelector('[data-quick-status]').textContent=e.message);panel.addEventListener('change',async e=>{if(!e.target.matches('[data-quick-option]'))return;const inputs=[...panel.querySelectorAll('[data-quick-option]')];inputs.forEach(i=>i.disabled=true);try{prefs=await desktop.quickSet(Object.fromEntries(inputs.map(i=>[i.dataset.quickOption,i.checked])));panel.querySelector('[data-quick-status]').textContent='已保存，仅作用于本机';}catch(error){panel.querySelector('[data-quick-status]').textContent=error.message;inputs.forEach(i=>i.checked=prefs?.[i.dataset.quickOption]!==false);}finally{inputs.forEach(i=>i.disabled=false);}});
        const reminders=reminderPanel();
        marker.append(reminders);
        const launcher=buildLauncher();marker.append(launcher);
      }
    }
    if(state.session)$('#shelf-handle').hidden=false;
  }
  function chatList(type){
    const draft=ensureSourceDraft(),saved=new Set(state.sources[type+'_chats']||[]);
    const list=(state.sources.conversations||[]).filter(c=>c.source===type).sort((left,right)=>Number(saved.has(right.id))-Number(saved.has(left.id)));
    return `<div class="chat-toolbar"><input data-chat-search="${type}" placeholder="搜索联系人或群聊" aria-label="搜索${type==='qq'?'QQ':'微信'}会话"><span class="helper" data-chat-count="${type}" aria-live="polite">本次选择 ${draft[type].size} 个</span></div><div class="conversation-list">${list.length?list.map(c=>`<label class="conversation-row${saved.has(c.id)?' is-saved':''}" data-chat-label="${type}" data-search="${esc(c.name+' '+c.id)}"><input type="checkbox" data-subscribe="${type}" value="${esc(c.id)}" ${draft[type].has(c.id)?'checked':''}><span><strong>${esc(c.name)}</strong><small>${c.id.startsWith('group:')||c.id.endsWith('@chatroom')?'群聊':'联系人'}${saved.has(c.id)?' · 已保存':''}</small></span></label>`).join(''):`<div class="empty"><strong>${type==='qq'?'选择一个 QQ 实例':'正在等待微信登录'}</strong><div>连接后，在这里勾选需要关注的聊天。</div></div>`}</div>`;
  }
  function triggerAdaptersContent(){
    const adapters=window.pluginUI?.triggerAdapters?.()||[];
    return `<div class="panel-head"><h3>触发器适配器</h3><small>${adapters.length?`${adapters.length} 个插件触发器正在运行`:'QQ、微信与通知事件已内置'}</small></div>
      <div class="trigger-adapter-list">
        <div class="trigger-adapter-row"><span class="trigger-adapter-mark">Q</span><div><strong>QQ 消息</strong><small>SnowLuma · 收到新消息时触发</small></div><span class="tag green">内置</span></div>
        <div class="trigger-adapter-row"><span class="trigger-adapter-mark">微</span><div><strong>微信消息</strong><small>本地数据库 · 收到新消息时触发</small></div><span class="tag green">内置</span></div>
        <div class="trigger-adapter-row"><span class="trigger-adapter-mark">+</span><div><strong>项目事件</strong><small>待办创建、修改、删除和 AI 操作完成</small></div><span class="tag green">内置</span></div>
        ${adapters.map(adapter=>`<div class="trigger-adapter-row" data-trigger-adapter="${esc(adapter.id)}"><span class="trigger-adapter-mark">${esc((adapter.title||'触').slice(0,1))}</span><div><strong>${esc(adapter.title)}</strong><small>${esc(adapter.pluginName)} · ${esc(adapter.description||adapter.event)}</small>${adapter.lastError?`<small class="error">${esc(adapter.lastError)}</small>`:''}</div><span class="tag ${adapter.state==='error'?'red':'blue'}">${adapter.state==='error'?'异常':adapter.state==='starting'?'启动中':'插件'}</span><button type="button" class="plain-button" data-test-plugin-trigger="${esc(adapter.id)}">测试</button></div>`).join('')}
      </div>`;
  }
  function triggerAdaptersPanel(){
    return `<section class="panel trigger-adapters">${triggerAdaptersContent()}</section>`;
  }
  function sourceSaveBar(){
    const dirty=sourceDraftDirty();
    return `<section class="panel source-save-bar" aria-live="polite"><div><strong data-source-save-title>${dirty?'有未保存的会话变更':'采集设置已保存'}</strong><small data-source-save-copy></small></div><button type="button" class="primary" data-source-save data-experience="save" ${dirty?'':'disabled'}>保存变更</button></section>`;
  }
  function sourceOverview(){
    const c=state.sources,adapters=window.pluginUI?.triggerAdapters?.()||[];
    const sourceRow=(type,mark,title,subtitle,account)=>{
      const enabled=c[type+'_enabled']!==false,count=(c[type+'_chats']||[]).length;
      return `<article class="source-overview-row" data-source-summary="${type}">
        <span class="source-mark ${type==='qq'?'qq':''}">${mark}</span>
        <div class="source-overview-copy"><strong>${title}</strong><small>${esc(subtitle)}</small><span>${esc(account||'等待连接')}</span></div>
        <div class="source-overview-metrics"><strong>${count}</strong><small>个已保存会话</small></div>
        <span class="tag ${enabled?'green':''}">${enabled?'已启用':'已停用'}</span>
        <button type="button" class="plain-button" data-open-source="${type}">管理</button>
      </article>`;
    };
    return `<section class="panel source-overview">
      <div class="source-overview-head"><div><span class="eyebrow">触发器概览</span><h2>消息统一进入工作台</h2><p>QQ、微信和插件事件在电脑上运行，通知与待办同步到所有设备。</p></div><span id="collector-status" class="collector-status" role="status">正在准备连接</span></div>
      <div class="source-overview-list">
        ${sourceRow('qq','Q','QQ 消息','SnowLuma · 选择实例后读取群聊与联系人',c.qq_account)}
        ${sourceRow('wechat','微','微信消息','本地数据库 · 自动识别当前登录账号',c.wechat_account)}
        <article class="source-overview-row" data-source-summary="plugins"><span class="source-mark">+</span><div class="source-overview-copy"><strong>插件事件</strong><small>待办、通知与第三方服务可通过插件接入</small><span>${adapters.length?`${adapters.length} 个插件触发器`:'等待安装插件触发器'}</span></div><div class="source-overview-metrics"><strong>${adapters.length}</strong><small>个插件触发器</small></div><span class="tag ${adapters.some(x=>x.state==='error')?'red':'blue'}">${adapters.some(x=>x.state==='error')?'需检查':adapters.length?'运行中':'按需启用'}</span><button type="button" class="plain-button" data-open-source="adapters">查看</button></article>
      </div>
      <div class="source-overview-footer"><label class="switch-line"><input id="sources-auto" type="checkbox" ${ensureSourceDraft().auto_start?'checked':''}><span><strong>打开应用后自动恢复读取</strong><small>使用最后一次保存的 QQ／微信会话，不读取未保存的勾选。</small></span></label><button type="button" class="secondary" data-experience="detect">重新检测</button></div>
    </section>`;
  }
  function sourcesView(){
    if(!window.desktop)return heading('触发器','电脑运行触发器，网页和手机可以继续处理触发会话。')+`<div class="trigger-history-slot">${window.agentUI?.historyPanel?.()||''}</div>`;
    const c=state.sources,draft=ensureSourceDraft();
    requestAnimationFrame(updateSourceDraftUI);
    return heading('触发器','QQ、微信和插件事件统一进入同一套触发器。勾选会话后保存，离开时不会丢失草稿。',`<button class="secondary" data-experience="detect">重新检测</button>`)+
    sourceSaveBar()+sourceOverview()+`<div class="trigger-history-slot">${window.agentUI?.historyPanel?.()||''}</div>`+triggerAdaptersPanel()+
    `<div class="source-grid"><section class="panel source-card" data-source-card="qq"><div class="source-title"><span class="source-mark qq">QQ</span><div><h3>QQ 消息</h3><small>选择已登录实例，勾选要关注的聊天。</small></div><label class="source-enable"><input id="qq-enabled" aria-label="启用 QQ 读取" type="checkbox" ${draft.qq_enabled?'checked':''}><span>${draft.qq_enabled?'启用':'停用'}</span></label></div><div id="qq-instances" class="instance-list">${instances.length?instances.map(p=>`<div class="instance-row"><span class="instance-avatar">Q</span><div><strong>${esc(p.nickname||p.uin||(p.accounts?.[0]?.nickname)||'QQ 客户端')}</strong><small>${esc(p.uin||'实例 '+p.pid)} · ${c.qq_pid===p.pid?'已选择':'已检测'}</small></div><button type="button" class="${c.qq_pid===p.pid?'plain-button':'secondary'}" data-connect-qq="${p.pid}">${c.qq_pid===p.pid?'刷新聊天':'连接'}</button></div>`).join(''):'<p class="helper">正在检测本机 QQ，保持 QQ 登录即可。</p>'}</div>${chatList('qq')}</section><section class="panel source-card" data-source-card="wechat"><div class="source-title"><span class="source-mark">微</span><div><h3>微信消息</h3><small>自动识别已登录微信，勾选要关注的聊天。</small></div><label class="source-enable"><input id="wechat-enabled" aria-label="启用微信读取" type="checkbox" ${draft.wechat_enabled?'checked':''}><span>${draft.wechat_enabled?'启用':'停用'}</span></label></div><div class="source-card-toolbar"><span class="helper">${c.wechat_account?`当前账号 · ${esc(c.wechat_account)}`:'等待自动识别微信账号'}</span><button type="button" class="plain-button" data-experience="refresh-wechat">刷新聊天</button></div>${chatList('wechat')}</section></div>`+
    `<details class="panel advanced-source"><summary>高级与调试 <span class="helper">连接详情、读取检查、运行记录</span></summary><div class="advanced-body"><div class="form-grid"><label>SnowLuma 安装目录<input id="snowluma-home" value="${esc(c.snowluma_home||'')}" placeholder="自动检测"><button type="button" class="link" data-experience="select-runtime">选择目录</button></label><label>Python 解释器<input id="python-path" value="${esc(c.python_path||'')}" placeholder="留空使用内置采集程序"></label></div><div class="form-grid"><label>仅采集含关键词的消息<input id="capture-keywords" value="${esc(c.capture_keywords||'')}" placeholder="留空处理勾选聊天的全部消息"></label><label>QQ 连接方式<select id="qq-transport"><option value="managed">应用内免配置接入</option><option value="external">外部 OneBot（兼容调试）</option></select></label></div><details><summary class="helper">兼容连接参数</summary><div class="form-grid"><label>HTTP 地址<input id="qq-http" value="${esc(c.qq_http_url||'http://127.0.0.1:3000')}"></label><label>WebSocket 地址<input id="qq-ws" value="${esc(c.qq_ws_url||'ws://127.0.0.1:3001')}"></label></div><label>Access Token<input id="qq-token" type="password" value="${esc(c.qq_token||'')}" autocomplete="new-password"></label><div class="form-grid"><label>微信账号目录<input id="wechat-account" value="${esc(c.wechat_account||'')}" placeholder="自动检测"></label><label>微信数据库目录<input id="wechat-db-dir" value="${esc(c.wechat_db_dir||'')}" placeholder="自动检测"></label></div></details><div class="source-actions"><button class="secondary" data-experience="diagnostics">检查读取状态</button><button class="plain-button" data-experience="stop">暂停本次读取</button></div><div class="form-grid debug-controls"><label>读取动作<select id="debug-action"><option value="get_login_info">账号状态</option><option value="get_group_list">群聊列表</option><option value="get_friend_list">联系人列表</option><option value="get_status">运行状态</option><option value="get_group_msg_history">群消息历史</option></select></label><label>参数<textarea id="debug-params" rows="2" placeholder='例如：{"group_id":123}'>{}</textarea></label></div><button class="secondary" data-experience="debug">执行读取检查</button><pre id="source-debug" class="debug-output" hidden></pre></div></details>`;
  }
  function configFromForm(){
    const c=readSourcesForm();
    if($('#sources-auto')){
      const draft=ensureSourceDraft();
      c.auto_start=draft.auto_start;c.qq_enabled=draft.qq_enabled;c.wechat_enabled=draft.wechat_enabled;
      c.qq_chats=[...draft.qq];c.wechat_chats=[...draft.wechat];
      c.snowluma_home=$('#snowluma-home').value.trim();c.qq_transport=$('#qq-transport').value;
    }
    return c;
  }
  async function persist(){await storeSet('sources-'+state.profile,state.sources);}
  async function saveSourceDraft(){
    const c=configFromForm();
    Object.assign(state.sources,c);
    await persist();
    resetSourceDraft();
    if(state.page==='sources')render();
    const selected=(c.qq_enabled!==false?c.qq_chats.length:0)+(c.wechat_enabled!==false?c.wechat_chats.length:0);
    if(c.auto_start===false||selected===0)await desktop.stopCollector();
    else await resume();
  }
  function confirmLeaveSources(){
    if(state.page!=='sources'||!sourceDraftDirty())return true;
    if(!window.confirm('QQ／微信会话选择还没有保存，确定离开并放弃本次修改吗？'))return false;
    resetSourceDraft();
    return true;
  }
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
      try{const result=await desktop.discoverQQ(state.sources.snowluma_home,startup);instances=result.instances;if(state.page==='sources'){render();$('#qq-transport').value=state.sources.qq_transport||'managed';}}
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
  async function onSession(){
    if(lastSessionGeneration===state.generation)return;lastSessionGeneration=state.generation;
    $('#shelf-handle').hidden=false;
    if(window.desktop)detect(true);
  }
  document.addEventListener('click',async event=>{
    const triggerTest=event.target.closest('[data-test-plugin-trigger]');
    if(triggerTest){
      const adapter=window.pluginUI?.triggerAdapters?.().find(item=>item.id===triggerTest.dataset.testPluginTrigger);
      if(!adapter)return toast('触发器已停止');
      triggerTest.disabled=true;
      try{await window.pluginUI.invokeTrigger(adapter.event,{test:true,at:new Date().toISOString()});toast(`已触发「${adapter.title}」`);}
      catch(error){toast(error.message||'触发器运行失败');}
      finally{triggerTest.disabled=false;}
      return;
    }
    const sourceShortcut=event.target.closest('[data-open-source]');
    if(sourceShortcut){window.pageNavigation?.select(sourceShortcut.dataset.openSource);return;}
    const connect=event.target.closest('[data-connect-qq]');const action=event.target.closest('[data-experience]');
    if(!connect&&!action)return;
    try{
      if(connect){
        connect.disabled=true;const c=readSourcesForm();const result=await desktop.connectQQ({pid:Number(connect.dataset.connectQq),home:c.snowluma_home});
        state.sources.qq_account=result.account||result.uin;state.sources.qq_pid=Number(connect.dataset.connectQq);state.sources.qq_transport='managed';
        state.sources.conversations=[...(state.sources.conversations||[]).filter(x=>x.source!=='qq'),...result.conversations];
        await persist();render();await resume();toast('已连接 QQ，保存聊天选择后开始读取');return;
      }
      switch(action.dataset.experience){
        case 'detect':await detect(false);break;
        case 'refresh-wechat':action.disabled=true;await wechatContacts();break;
        case 'save':action.disabled=true;await saveSourceDraft();toast('会话选择已保存');break;
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
      const draft=ensureSourceDraft();
      if(event.target.dataset.subscribe){
        const type=event.target.dataset.subscribe;
        if(event.target.checked)draft[type].add(event.target.value);else draft[type].delete(event.target.value);
      }
      if(event.target.id==='sources-auto')draft.auto_start=event.target.checked;
      if(event.target.id==='qq-enabled'){draft.qq_enabled=event.target.checked;event.target.closest('.source-enable')?.querySelector('span')?.replaceChildren(event.target.checked?'启用':'停用');}
      if(event.target.id==='wechat-enabled'){draft.wechat_enabled=event.target.checked;event.target.closest('.source-enable')?.querySelector('span')?.replaceChildren(event.target.checked?'启用':'停用');}
      updateSourceDraftUI();
    }
  });
  window.addEventListener('beforeunload',event=>{
    if(state.page!=='sources'||!sourceDraftDirty())return;
    event.preventDefault();
    event.returnValue='';
  });
  document.addEventListener('input',event=>{if(event.target.dataset.chatSearch){const type=event.target.dataset.chatSearch;const query=event.target.value.toLowerCase();$$(`[data-chat-label="${type}"]`).forEach(row=>{row.hidden=!row.dataset.search.toLowerCase().includes(query);});}});
  let updateValue = null;

  function updateText(value) {
    if (!value) return '';
    const status = value.status || 'idle';
    if (status === 'downloading') return value.progress ? `正在下载更新 ${Math.round(value.progress * 100)}%` : '正在下载更新…';
    if (status === 'downloaded') return `安装包已就绪（v${value.latest}），可以立即安装。`;
    if (status === 'cancelled') return '下载已取消，可以重新下载。';
    if (status === 'error') return value.error || '更新下载失败。';
    if (status === 'available') return `发现新版本 v${value.latest}（当前 v${value.current || ''}）。`;
    if (status === 'current') return `已是最新版本 v${value.current || ''}`;
    if (value.current) return `当前版本 v${value.current}`;
    return '';
  }

  function renderUpdate(value, keepStatus) {
    if (value && value.received !== undefined && !value.status) value = { ...(updateValue || {}), ...value, status: 'downloading' };
    if (value) updateValue = value;
    const current = updateValue || {};
    const launcher=document.querySelector('#settings-launcher');
    if (!launcher) return;
    launcher.querySelectorAll('[data-update-option]').forEach(input => {
      const key = input.dataset.updateOption;
      input.checked = current[key] === undefined ? key !== 'autoDownload' : !!current[key];
    });
    const interval = launcher.querySelector('[data-update-interval]');
    if (interval) interval.value = String(Math.max(30, Math.min(1440, Number(current.intervalMinutes) || 360)));
    const status = launcher.querySelector('[data-launch-status]');
    const actions = launcher.querySelector('[data-update-actions]');
    if (status) status.textContent = updateText(current);
    renderDownloadProgress(launcher,current);
    const checkButton=launcher.querySelector('[data-action-check-update]');if(checkButton)checkButton.disabled=current.status==='downloading';
    window.formControls?.schedule();
    if (updateDialogBox) syncUpdateDialog();
    if (!keepStatus && current.status === 'available' && !current.skipped) {
      const checkedAt = Date.parse(current.at);
      if (Number.isFinite(checkedAt) && Date.now() - checkedAt < 90000 && lastUpdatePrompt !== current.at) { lastUpdatePrompt = current.at; openUpdateDialog(); }
    }
    if (keepStatus) return;
    if (actions) {
      actions.replaceChildren();
      const state = current.status || 'idle';
      if (['available','cancelled','error'].includes(state) && current.assetUrl) {
        const download = document.createElement('button');
        download.className = 'secondary';
        download.textContent = state==='available'?'下载更新':'重新下载';
        download.addEventListener('click', async () => { try { await desktop.updateDownload(); } catch (error) { status.textContent = error.message; } });
        actions.append(download);
      }
      if (state === 'downloaded' && current.path) {
        const install = document.createElement('button');
        install.className = 'primary';
        install.textContent = '运行安装程序';
        install.addEventListener('click', async () => { try { await desktop.updateInstall(); status.textContent = '安装程序已启动，请按提示完成安装。'; } catch (error) { status.textContent = error.message; } });
        actions.append(install);
      }
      if (state === 'downloading') {
        const cancel = document.createElement('button');
        cancel.className = 'plain-button';
        cancel.textContent = '取消下载';
        cancel.addEventListener('click', async () => { await desktop.updateCancel(); });
        actions.append(cancel);
      }
      const page = document.createElement('button');
      page.className = 'link';
      page.textContent = '打开发布页 ↗';
      page.addEventListener('click', async () => { try { await desktop.external(current.url || 'https://github.com/NekoYume517/jiaojianbox/releases/latest'); } catch (error) { status.textContent = error.message; } });
      actions.append(page);
    }
  }

  function renderDownloadProgress(launcher,current) {
    const box=launcher.querySelector('[data-update-progress]');if(!box)return;
    const running=current.status==='downloading',done=current.status==='downloaded';
    box.hidden=!running&&!done;if(box.hidden)return;
    const received=Number(current.received)||0,total=Number(current.total)||0;
    const progress=done?1:total>0?Math.max(0,Math.min(1,received/total)):0;
    const size=n=>n>=1048576?(n/1048576).toFixed(1)+' MB':Math.round(n/1024)+' KB';
    const bar=box.querySelector('[role=progressbar]');
    box.classList.toggle('indeterminate',running&&total<=0);
    box.querySelector('[data-update-progress-title]').textContent=done?'下载完成':'正在下载安装包';
    box.querySelector('[data-update-percent]').textContent=done?'100%':total>0?Math.floor(progress*100)+'%':'已下载 '+size(received);
    box.querySelector('[data-update-fill]').style.transform='scaleX('+(running&&total<=0?.3:progress)+')';
    if(total>0||done)bar.setAttribute('aria-valuenow',String(Math.round(progress*100)));else bar.removeAttribute('aria-valuenow');
    bar.setAttribute('aria-valuetext',done?'下载完成':size(received)+(total>0?' / '+size(total):''));
    box.querySelector('[data-update-bytes]').textContent=done?'安装包已就绪':size(received)+(total>0?' / '+size(total):' · 正在接收');
    const speed=Number(current.bytesPerSecond)||0,eta=Number(current.etaSeconds)||0;
    box.querySelector('[data-update-speed]').textContent=done?'确认后开始安装':speed>0?size(speed)+'/s'+(eta>0?' · 约剩 '+(eta>=60?Math.ceil(eta/60)+' 分钟':Math.ceil(eta)+' 秒'):''):'正在连接下载服务器…';
  }

  function renderMarkdown(text) {
    if (!text) return '';
    const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const inline = value => escape(value)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
    let html = '', list = null, inFence = false;
    const buffer = [];
    const flush = () => {
      if (list) html += `<${list}>` + buffer.map(item => `<li>${item}</li>`).join('') + `</${list}>`;
      else if (buffer.length) html += `<p>${buffer.join('<br>')}</p>`;
      list = null; buffer.length = 0;
    };
    for (const raw of String(text).replace(/\r\n?/g, '\n').split('\n')) {
      if (/^```/.test(raw)) { flush(); inFence = !inFence; continue; }
      if (inFence) { buffer.push(escape(raw)); continue; }
      const heading = raw.match(/^(#{1,4})\s+(.*)/);
      if (heading) { flush(); const level = heading[1].length + 2; html += `<h${level}>${inline(heading[2])}</h${level}>`; continue; }
      const bullet = raw.match(/^\s*[-*]\s+(.*)/);
      if (bullet) { if (list && list !== 'ul') flush(); if (!list) list = 'ul'; buffer.push(inline(bullet[1])); continue; }
      const ordered = raw.match(/^\s*\d+\.\s+(.*)/);
      if (ordered) { if (list && list !== 'ol') flush(); if (!list) list = 'ol'; buffer.push(inline(ordered[1])); continue; }
      if (!raw.trim()) { flush(); continue; }
      buffer.push(inline(raw));
    }
    flush();
    return html;
  }

  let updateZoneMode = '';
  function swapUpdateZone(zone, mode) {
    if (updateZoneMode === mode) return;
    const actions = zone.querySelector('[data-update-dialog-actions]');
    const progress = zone.querySelector('[data-update-dialog-progress]');
    if (!actions || !progress) return;
    const apply = () => {
      actions.hidden = mode !== 'actions';
      progress.hidden = mode !== 'progress';
    };
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.inputMethod === 'keyboard' || document.hidden;
    if (updateZoneMode === '' || reduced) { apply(); updateZoneMode = mode; return; }
    const leaving = mode === 'progress' ? actions : progress;
    const entering = mode === 'progress' ? progress : actions;
    const before = zone.offsetHeight;
    const exit = leaving.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(4px)' }], { duration: 150, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
    exit.finished.catch(() => {}).then(() => {
      leaving.getAnimations().forEach(item => item.cancel());
      const after = mode === 'progress' ? progress.offsetHeight : actions.offsetHeight;
      apply();
      const grown = zone.offsetHeight;
      if (grown !== before) {
        zone.style.height = before + 'px'; zone.style.overflow = 'hidden';
        zone.animate([{ height: before + 'px' }, { height: grown + 'px' }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' }).finished.catch(() => {}).then(() => { zone.style.height = ''; zone.style.overflow = ''; });
      }
      entering.animate([{ opacity: 0, transform: 'translateY(2px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
    });
    updateZoneMode = mode;
  }

  let updateDialogBox = null, lastUpdatePrompt = '';
  function buildUpdateDialog() {
    const dialog = document.createElement('dialog');
    dialog.id = 'update-dialog';
    dialog.innerHTML = `<div class="dialog-heading"><div><div class="eyebrow">启动与更新</div><h2>发现新版本 <span data-update-dialog-latest></span></h2></div><button type="button" class="icon-button" data-update-dialog-close aria-label="关闭">×</button></div>`
      + `<div class="dialog-body"><div class="update-notes" data-update-dialog-notes></div><p class="helper" data-update-dialog-status role="status"></p>`
      + `<div class="update-dialog-zone" data-update-dialog-zone>`
      + `<div class="detail-actions" data-update-dialog-actions><button type="button" class="secondary" data-update-dialog-cancel>取消</button><button type="button" class="plain-button" data-update-dialog-skip>忽略此版本</button><button type="button" class="primary" data-update-dialog-download>立刻下载</button></div>`
      + `<div data-update-dialog-progress hidden><div class="update-progress" data-update-progress><div class="update-progress-heading"><strong data-update-progress-title>准备下载</strong><span data-update-percent></span></div><div class="update-progress-track" role="progressbar" aria-label="更新下载进度" aria-valuemin="0" aria-valuemax="100"><i data-update-fill></i></div><div class="update-progress-detail"><span data-update-bytes></span><span data-update-speed></span></div><div class="detail-actions"><button type="button" class="plain-button" data-update-dialog-cancel-download hidden>取消下载</button><button type="button" class="primary" data-update-dialog-install hidden>运行安装程序</button></div></div></div>`
      + `</div></div>`;
    document.body.append(dialog);
    dialog.querySelector('[data-update-dialog-close]').onclick = () => uiMotion.closeDialog(dialog);
    dialog.querySelector('[data-update-dialog-cancel]').onclick = () => uiMotion.closeDialog(dialog);
    dialog.addEventListener('cancel', () => {});
    dialog.querySelector('[data-update-dialog-download]').onclick = async event => {
      const button = event.target; button.disabled = true;
      try { renderUpdate(await desktop.updateDownload()); }
      catch (error) { dialog.querySelector('[data-update-dialog-status]').textContent = error.message; button.disabled = false; }
    };
    dialog.querySelector('[data-update-dialog-cancel-download]').onclick = async () => { try { await desktop.updateCancel(); } catch (error) { toast(error.message); } };
    dialog.querySelector('[data-update-dialog-install]').onclick = async () => { try { await desktop.updateInstall(); } catch (error) { dialog.querySelector('[data-update-dialog-status]').textContent = error.message; } };
    dialog.querySelector('[data-update-dialog-skip]').onclick = async event => {
      const button = event.target; button.disabled = true;
      try {
        const latest = (updateValue || {}).latest;
        updateValue = await desktop.updateSet({ skipVersion: latest });
        renderUpdate(updateValue, true);
        const launcher = document.querySelector('#settings-launcher');
        const status = launcher?.querySelector('[data-launch-status]');
        if (status) status.textContent = `已忽略 v${latest}，之后不会再自动提醒`;
        await uiMotion.closeDialog(dialog);
      } catch (error) { dialog.querySelector('[data-update-dialog-status]').textContent = error.message; }
      finally { button.disabled = false; }
    };
    updateDialogBox = dialog;
    return dialog;
  }
  function openUpdateDialog() {
    if (!window.desktop?.updateCheck) return;
    if (!updateDialogBox) buildUpdateDialog();
    updateZoneMode = '';
    syncUpdateDialog();
    if (updateDialogBox.open) return;
    uiMotion.openDialog(updateDialogBox);
  }
  function syncUpdateDialog() {
    const dialog = updateDialogBox;
    if (!dialog) return;
    const current = updateValue || {};
    dialog.querySelector('[data-update-dialog-latest]').textContent = 'v' + (current.latest || '?');
    const notes = dialog.querySelector('[data-update-dialog-notes]');
    notes.innerHTML = renderMarkdown(current.notes) || '<p class="helper">发布者没有填写更新说明，可直接下载安装包。</p>';
    notes.querySelectorAll('a').forEach(link => { link.addEventListener('click', event => { event.preventDefault(); desktop.external(link.href).catch(() => {}); }); });
    const state = current.status || 'idle';
    const downloading = state === 'downloading', downloaded = state === 'downloaded';
    dialog.querySelector('[data-update-dialog-status]').textContent = current.skipped && state === 'available' ? '此版本已被忽略，之后不会再自动提醒，仍可手动下载。' : updateText(current);
    swapUpdateZone(dialog.querySelector('[data-update-dialog-zone]'), downloading || downloaded ? 'progress' : 'actions');
    renderDownloadProgress(dialog, current);
    dialog.querySelector('[data-update-dialog-download]').disabled = downloading;
    dialog.querySelector('[data-update-dialog-download]').textContent = state === 'cancelled' || state === 'error' ? '重新下载' : '立刻下载';
    dialog.querySelector('[data-update-dialog-skip]').disabled = downloading;
    dialog.querySelector('[data-update-dialog-cancel-download]').hidden = !downloading;
    const install = dialog.querySelector('[data-update-dialog-install]');
    install.hidden = !downloaded;
    if (downloaded) install.animate([{ opacity: 0, transform: 'translateY(2px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }

  function buildLauncher() {
    const launcher=document.createElement('section');launcher.id='settings-launcher';launcher.className='panel appearance-panel';
    launcher.innerHTML='<h3>启动与更新</h3>'
      +'<label class="switch-line"><input type="checkbox" data-launch-option="openAtLogin"><span><strong>开机自动启动</strong><small>登录 Windows 后自动在后台运行，恢复上次的 QQ/微信采集，不需要手动打开。</small></span></label>'
      +'<label class="switch-line"><input type="checkbox" data-update-option="autoCheck"><span><strong>自动检查更新</strong><small>按下面的间隔在后台检查 GitHub 发布版本。</small></span></label>'
      +'<div class="form-grid update-interval-row"><label>检查间隔<select data-update-interval><option value="30">30 分钟</option><option value="60">1 小时</option><option value="360">6 小时</option><option value="1440">24 小时</option></select></label>'
      +'<label class="switch-line"><input type="checkbox" data-update-option="autoDownload"><span><strong>自动下载更新</strong><small>发现新版本时自动下载安装包，安装始终需要你确认。</small></span></label></div>'
      +'<div class="detail-actions"><button type="button" class="secondary" data-action-check-update>检查更新</button></div>'
      +'<div class="detail-actions" data-update-actions></div>'
      +'<div class="update-progress" data-update-progress hidden><div class="update-progress-heading"><strong data-update-progress-title>准备下载</strong><span data-update-percent></span></div><div class="update-progress-track" role="progressbar" aria-label="更新下载进度" aria-valuemin="0" aria-valuemax="100"><i data-update-fill></i></div><div class="update-progress-detail"><span data-update-bytes></span><span data-update-speed></span></div></div>'
      +'<p class="helper" data-launch-status role="status"></p>';
    launcher.querySelector('[data-launch-option]').addEventListener('change',async e=>{const input=e.target;input.disabled=true;try{const value=await desktop.launcherSet({openAtLogin:input.checked});launcher.querySelector('[data-launch-status]').textContent=value.openAtLogin?'已开启开机自启，下次登录 Windows 自动运行':'已关闭开机自启';input.checked=!!value.openAtLogin;}catch(error){launcher.querySelector('[data-launch-status]').textContent=error.message;input.checked=!input.checked;}finally{input.disabled=false;}});
    if (window.desktop?.launcherGet) desktop.launcherGet().then(value => { const box = launcher.querySelector('[data-launch-option]'); if (box) box.checked = !!value.openAtLogin; }).catch(() => {});
    const persistUpdate = async patch => {
      try { updateValue = await desktop.updateSet(patch); renderUpdate(updateValue); launcher.querySelector('[data-launch-status]').textContent = '已保存，仅作用于本机'; }
      catch (error) { launcher.querySelector('[data-launch-status]').textContent = error.message; }
    };
    launcher.querySelectorAll('[data-update-option]').forEach(input => input.addEventListener('change', () => persistUpdate({ [input.dataset.updateOption]: input.checked })));
    launcher.querySelector('[data-update-interval]').addEventListener('change', e => persistUpdate({ intervalMinutes: Number(e.target.value) }));
    launcher.querySelector('[data-action-check-update]').addEventListener('click',async e=>{
      const button=e.target;const status=launcher.querySelector('[data-launch-status]');
      button.disabled=true;status.textContent='正在检查更新…';
      try {
        if (window.desktop?.updateCheck) { const result = await desktop.updateCheck(); renderUpdate(result); if (result.status === 'available') openUpdateDialog(); }
        else {
          const platform=await desktop.platform();
          const result=await window.updater.check(platform.version);
          status.textContent=result.updatable?`发现新版本 v${result.latest}（当前 v${result.current}），点击下载：`:result.reason||`已是最新版本 v${result.current}`;
          if(result.updatable){const link=document.createElement('button');link.className='link';link.textContent='打开下载页面 ↗';link.onclick=()=>desktop.external(result.url);status.append(document.createElement('br'),link);}
        }
      } catch(error){status.textContent=error.message;}
      finally{button.disabled=false;}
    });
    if (window.desktop?.updateGet) {
      desktop.updateGet().then(value => { updateValue = value; renderUpdate(value); }).catch(error => { launcher.querySelector('[data-launch-status]').textContent = error.message; });
    }
    return launcher;
  }

  window.updateUI = renderUpdate;

  window.addEventListener('appearance-error',()=>toast('外观已应用，但本机偏好未能保存'));
  window.experience={sourcesView,decorate,detect,onSession,prepareLogin,browserLogin,confirmLeaveSources};
  window.addEventListener('plugin-triggers-changed',()=>{
    const panel=document.querySelector('.trigger-adapters');
    if(panel&&state.page==='sources')panel.innerHTML=triggerAdaptersContent();
  });
  if(window.desktop){prepareLogin();desktop.onAppearance(value=>appearance.restore(value));}
  if(state.session)onSession();
})();
