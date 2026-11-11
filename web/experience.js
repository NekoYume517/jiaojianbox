'use strict';
(() => {
  let instances=[],detecting=null,resumeTimer,authorizationGeneration=0,authorizeUrl='',lastSessionGeneration=-1;
  const appearancePanel=()=>`<section id="settings-appearance" class="panel appearance-panel"><div class="appearance-heading"><div><h3>外观</h3><p class="helper">选择适合当前设备的颜色、文字和信息密度。</p></div><div data-theme-picker></div></div><div class="theme-options">${[['light','浅色'],['dark','深色'],['system','跟随系统']].map(([mode,label])=>`<button type="button" class="theme-option" data-theme-mode="${mode}"><div class="theme-preview ${mode}"></div><span>${appearance.icon(mode)}${label}</span></button>`).join('')}</div><div class="appearance-fields"><label>配色主题<select id="appearance-palette"><option value="magpie">默认</option><option value="tokyo-night">Tokyo Night</option><option value="nord">Nord</option><option value="graphite">Graphite</option></select></label><label>信息密度<select id="appearance-density"><option value="comfortable">舒适</option><option value="compact">紧凑</option></select></label><label>文字大小<select id="appearance-text-size"><option value="normal">标准</option><option value="large">较大</option></select></label></div></section>`;
  function decorate(page){
    if(page==='settings'&&!$('#appearance-panel-marker')){
      const marker=document.createElement('div');marker.id='appearance-panel-marker';marker.innerHTML=appearancePanel();$('#view .page-heading').after(marker);appearance.refresh();
      if(window.desktop){
        const panel=document.createElement('section');panel.id='settings-quick';panel.className='panel appearance-panel';panel.innerHTML='<h3>桌面快捷收集</h3><p class="helper">拖动标题栏调整位置，下次打开会记住。文件拖入后保持打开，可按 Esc 或 × 关闭。</p>'+[['enabled','启用快捷收集（拖拽、快捷键和托盘）'],['drop','显示文件拖拽框'],['note','显示随手记'],['files','显示文件列表']].map(([key,label])=>`<label class="switch-line"><input type="checkbox" data-quick-option="${key}"><span>${label}</span></label>`).join('')+'<p class="helper" data-quick-status role="status"></p>';marker.append(panel);let prefs;desktop.quickGet().then(value=>{prefs=value;panel.querySelectorAll('[data-quick-option]').forEach(input=>input.checked=prefs[input.dataset.quickOption]!==false);}).catch(e=>panel.querySelector('[data-quick-status]').textContent=e.message);panel.addEventListener('change',async e=>{if(!e.target.matches('[data-quick-option]'))return;const inputs=[...panel.querySelectorAll('[data-quick-option]')];inputs.forEach(i=>i.disabled=true);try{prefs=await desktop.quickSet(Object.fromEntries(inputs.map(i=>[i.dataset.quickOption,i.checked])));panel.querySelector('[data-quick-status]').textContent='已保存，仅作用于本机';}catch(error){panel.querySelector('[data-quick-status]').textContent=error.message;inputs.forEach(i=>i.checked=prefs?.[i.dataset.quickOption]!==false);}finally{inputs.forEach(i=>i.disabled=false);}});
        const launcher=buildLauncher();marker.append(launcher);
      }
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
    `<details class="panel advanced-source"><summary>高级与调试 <span class="helper">连接详情、读取检查、运行记录</span></summary><div class="advanced-body"><div class="form-grid"><label>SnowLuma 安装目录<input id="snowluma-home" value="${esc(c.snowluma_home||'')}" placeholder="自动检测"><button type="button" class="link" data-experience="select-runtime">选择目录</button></label><label>Python 解释器<input id="python-path" value="${esc(c.python_path||'')}" placeholder="留空使用内置采集程序"></label></div><div class="form-grid"><label>仅采集含关键词的消息<input id="capture-keywords" value="${esc(c.capture_keywords||'')}" placeholder="留空处理勾选聊天的全部消息"></label><label>QQ 连接方式<select id="qq-transport"><option value="managed">应用内免配置接入</option><option value="external">外部 OneBot（兼容调试）</option></select></label></div><details><summary class="helper">兼容连接参数</summary><div class="form-grid"><label>HTTP 地址<input id="qq-http" value="${esc(c.qq_http_url||'http://127.0.0.1:3000')}"></label><label>WebSocket 地址<input id="qq-ws" value="${esc(c.qq_ws_url||'ws://127.0.0.1:3001')}"></label></div><label>Access Token<input id="qq-token" type="password" value="${esc(c.qq_token||'')}" autocomplete="new-password"></label><div class="form-grid"><label>微信账号目录<input id="wechat-account" value="${esc(c.wechat_account||'')}" placeholder="自动检测"></label><label>微信数据库目录<input id="wechat-db-dir" value="${esc(c.wechat_db_dir||'')}" placeholder="自动检测"></label></div></details><div class="source-actions"><button class="secondary" data-experience="save">保存并恢复连接</button><button class="secondary" data-experience="diagnostics">检查读取状态</button><button class="plain-button" data-experience="stop">暂停本次读取</button></div><div class="form-grid debug-controls"><label>读取动作<select id="debug-action"><option value="get_login_info">账号状态</option><option value="get_group_list">群聊列表</option><option value="get_friend_list">联系人列表</option><option value="get_status">运行状态</option><option value="get_group_msg_history">群消息历史</option></select></label><label>参数<textarea id="debug-params" rows="2" placeholder='例如：{"group_id":123}'>{}</textarea></label></div><button class="secondary" data-experience="debug">执行读取检查</button><pre id="source-debug" class="debug-output" hidden></pre></div></details>`;
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
  window.experience={sourcesView,decorate,detect,onSession,prepareLogin,browserLogin};
  if(window.desktop){prepareLogin();desktop.onAppearance(value=>appearance.restore(value));}
  if(state.session)onSession();
})();
