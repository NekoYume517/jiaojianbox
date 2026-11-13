/* Trigger conversations: one durable session per notification or manual task.
   The server owns tools, permissions and context compression. */
(() => {
  'use strict';
  let sessions = [], snapshot = null, activeOrigin = '', activeSessionID = '';
  let activePage = false, loadingSessions = false, loadingSession = false, streaming = false;
  let sessionGeneration = 0, streamController = null, originQuery = '', syncTimer = 0, layoutObserver = null;

  const drafts = new Map();
  let renderedSessionID = '';
  let activityTimer=0, activityBusy=false, localRunID='', localStreamSession='', stopRequested=false;

  const tokenText = value => {
    const n = Number(value) || 0;
    return n >= 1000000 ? `${(n / 1000000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
  };
  const identity = () => state.session ? `${state.session.server}|${state.session.user_id}` : '';
  const selectedSession = () => sessions.find(item => item.id === activeSessionID) || null;
  const currentOriginSessions = () => sessions.filter(item => item.origin_key === activeOrigin);
  const sourceLabel = value => value === 'qq' ? 'QQ' : value === 'wechat' ? '微信' : value === 'plugin' ? '插件' : '手动';
  const sourceClass = value => value === 'qq' ? 'qq' : value === 'wechat' ? 'wechat' : 'manual';

  const toolLabel = tool => ({
    list_tasks: '查看待办',
    list_recent_tasks:'查看最近待办',get_task_detail:'读取待办详情',get_recent_messages:'读取近期消息',append_to_task:'补充待办',
    get_task: '读取待办',
    check_task_progress: '检查材料进度',
    search_messages: '搜索通知',
    list_files: '查看文件',
    list_trigger_sessions: '列出触发会话',
    get_trigger_session: '读取触发会话',
    create_task: '创建待办',
    update_task: '修改待办',
    set_task_status: '更新待办进度',
    trash_task: '移入回收站',
    restore_task: '恢复待办',
    invoke_trigger_session: '调用其他触发会话',
  }[tool?.name] || tool?.name || '调用工具');

  function groupSessions() {
    const groups = new Map();
    for (const session of sessions) {
      const key = session.origin_key || 'manual';
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          label: session.origin_label || '手动触发',
          source: session.trigger_source || session.kind,
          sessions: [],
          latest: session.updated_at || session.created_at || '',
        });
      }
      const group = groups.get(key);
      group.sessions.push(session);
      if (String(session.updated_at || '') > String(group.latest || '')) group.latest = session.updated_at;
    }
    return [...groups.values()]
      .filter(group => !originQuery || `${group.label} ${group.source} ${group.sessions.map(item => item.title).join(' ')}`.toLowerCase().includes(originQuery))
      .sort((left, right) => String(right.latest).localeCompare(String(left.latest)));
  }

  function historyPanel() {
    return `<section class="panel trigger-history-panel" data-trigger-history>
      <header class="trigger-history-head">
        <div class="trigger-history-meta"><span class="trigger-history-status" aria-hidden="true"></span><strong data-trigger-summary>正在读取会话</strong><span>按来源分组，保留每轮上下文</span></div>
        <button type="button" class="secondary" data-agent-new>${icon('plus')}新建会话</button>
      </header>
      <div class="trigger-history-layout">
        <aside class="trigger-origin-pane" aria-label="触发来源">
          <label class="trigger-origin-search"><span data-icon="search"></span><input data-agent-origin-search placeholder="搜索来源或会话" aria-label="搜索触发来源或会话"></label>
          <div class="trigger-origin-list" data-agent-origins></div>
        </aside>
        <div class="trigger-session-pane">
          <div class="trigger-session-content" data-agent-session-content></div>
        </div>
      </div>
    </section>`;
  }

  function originMarkup(groups) {
    if (!groups.length) return `<div class="trigger-history-empty"><strong>还没有触发历史</strong><p>收到可执行通知后会在这里生成受限会话，也可以先新建一个手动会话。</p></div>`;
    return groups.map(group => {
      const active = group.key === activeOrigin;
      return `<section class="trigger-origin-group ${active ? 'is-active' : ''}">
        <button type="button" class="trigger-origin-row" data-agent-origin="${esc(group.key)}" aria-pressed="${active}">
          <span class="trigger-source-mark ${sourceClass(group.source)}">${esc(sourceLabel(group.source).slice(0, 1))}</span>
          <span class="trigger-origin-copy"><strong>${esc(group.label)}</strong><small>${group.sessions.length} 个会话</small></span>
          <span class="trigger-origin-count">${group.sessions.length}</span>
        </button>
        <div class="trigger-session-list">
          ${group.sessions.map(session => `<button type="button" class="trigger-session-row ${session.id === activeSessionID ? 'active' : ''}" data-agent-session="${esc(session.id)}" aria-current="${session.id === activeSessionID ? 'true' : 'false'}" title="${esc(session.title)}">
            <span>${esc(session.title)}</span><em class="trigger-session-state" data-session-state>${session.run_state==='running'?'分析中':session.run_state==='queued'?'排队中':''}</em>
            <small>${session.trigger_account ? esc(session.trigger_account) + ' · ' : ''}${session.message_count || 0} 条 · ${esc(formatDate(session.updated_at || session.created_at || group.latest || ''))}</small>
          </button>`).join('')}
        </div>
      </section>`;
    }).join('');
  }

  function contextMarkup(value) {
    const context = value || { limit: 262144, used: 0, percent: 0, compressed_count: 0, active_count: 0 };
    const percent = Math.max(0, Math.min(100, Number(context.percent) || 0));
    return `<details class="agent-context-peek" data-agent-context>
      <summary aria-label="上下文用量 ${percent.toFixed(1)}%"><svg class="agent-context-ring" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="7" pathLength="100" stroke-dasharray="${percent} 100"/></svg><span>${percent.toFixed(percent < 10 ? 1 : 0)}%</span></summary>
      <div class="agent-context-popup"><strong>上下文窗口</strong><span>${percent.toFixed(1)}% 已用 · 剩余 ${(100 - percent).toFixed(1)}%</span><span>已用 ${tokenText(context.used)} / 共 ${tokenText(context.limit)} tokens</span><small>${context.compressed_count ? `${context.compressed_count} 条较早消息已压缩` : '达到 80% 时压缩前 50% 消息'} · 保留 ${context.active_count || 0} 条原文</small></div>
    </details>`;
  }

  const markdown = (text,id) => {
    window.loadJjbMarkdown?.().catch(() => {});
    return window.jjbMarkdown?.render(text,`msg-${String(id||'live').replace(/[^a-zA-Z0-9_-]/g,'')}`) || esc(text);
  };
  const toolState = tool => tool.state || (tool.ok ? 'done' : 'error');
  const toolJSON = value => typeof value === 'string' ? value : JSON.stringify(value ?? {},null,2);
  function toolRow(tool,index=0) {
    const status=toolState(tool), label=status==='running'?'正在执行':status==='error'?'执行失败':status==='cancelled'?'已停止':'已完成';
    return `<details class="agent-tool-row ${status}" data-tool-id="${esc(tool.id || `tool-${index}`)}"><summary><span class="agent-tool-chevron">›</span><span class="agent-tool-symbol">${icon(status==='done'?'check':'connect')}</span><span class="agent-tool-title">${esc(toolLabel(tool))}</span><small class="agent-tool-status">${label}${tool.duration_ms!=null?' · '+(tool.duration_ms/1000).toFixed(2)+'s':''}</small></summary><div class="agent-tool-detail"><div class="agent-tool-name">${esc(tool.name)}</div><h4>参数</h4><pre>${esc(toolJSON(tool.arguments))}</pre><h4>结果</h4><pre data-tool-result>${esc(tool.result_preview || (status==='running'?'等待执行结果…':tool.ok?'工具已完成（旧记录未保存详情）':'工具执行失败'))}</pre></div></details>`;
  }
  function toolsMarkup(tools) {
    return `<details class="agent-tool-events" ${tools.length?'':'hidden'}><summary><span class="agent-tool-chevron">›</span><span data-tool-group-label>${tools.some(tool=>toolState(tool)==='running')?'正在执行工具':'已执行 '+tools.length+' 项操作'}</span></summary><div class="agent-tool-list">${tools.map(toolRow).join('')}</div></details>`;
  }
  function updateTool(holder,tool) {
    holder.hidden=false;
    if(toolState(tool)==='running')holder.open=true;
    const id=tool.id||`tool-${holder.querySelectorAll('.agent-tool-row').length}`;
    let row=holder.querySelector(`[data-tool-id="${CSS.escape(id)}"]`);
    if(!row){holder.querySelector('.agent-tool-list').insertAdjacentHTML('beforeend',toolRow({...tool,id}));}
    else {
      const template=document.createElement('template');template.innerHTML=toolRow({...tool,id});
      const next=template.content.firstElementChild;
      row.className=next.className;
      row.querySelector('summary').innerHTML=next.querySelector('summary').innerHTML;
      row.querySelector('.agent-tool-detail').innerHTML=next.querySelector('.agent-tool-detail').innerHTML;
    }
    const pending=holder.querySelector('.agent-tool-row.running');
    holder.querySelector('[data-tool-group-label]').textContent=pending?'正在执行工具':'已执行 '+holder.querySelectorAll('.agent-tool-row').length+' 项操作';
  }
  const stageLabel = run => ({queued:'排队中',starting:'正在准备分析',context:'正在读取会话上下文',request:'等待模型响应',receiving:'正在接收模型输出',tool:'正在执行工具',compressing:'正在压缩上下文',compressed:'上下文已压缩',validating:'正在整理分析结果',waiting:'等待模型继续输出'}[run.stage] || '正在分析');
  const runLabel = run => run.state==='skipped'?'已跳过':run.state==='cancelled'?'已停止':run.state==='failed'?'本轮未完成':run.state==='interrupted'?'上次处理已中断':run.state==='queued'?(run.stage==='retrying'?'等待重试':'排队中'):stageLabel(run);
  const runActive = run => ['queued','running'].includes(run.state);
  function runMarkup(run) {
    return `<article class="agent-message agent-message-assistant agent-live-run" data-agent-run="${esc(run.id)}"><div class="agent-message-role">${run.source_message_id?'触发器分析':'交件箱 Agent'}</div><div class="agent-message-bubble"><div class="agent-run-heading"><span class="agent-run-status" data-run-status>${esc(runLabel(run))}</span><button type="button" class="plain-button agent-run-stop" data-agent-stop data-run-id="${esc(run.id)}" ${runActive(run)?'':'hidden'}>停止</button></div>${toolsMarkup(Array.isArray(run.tools)?run.tools:[])}<div class="agent-message-copy markdown-body" data-run-text>${markdown(run.text||'',run.id)}</div><p class="agent-run-note" data-run-note>${run.received_chars?'已接收 '+run.received_chars+' 字':''}</p></div></article>`;
  }
  function syncRunNodes() {
    const holder=document.querySelector('[data-agent-runs]');if(!holder)return;
    const runs=(snapshot?.runs||[]).filter(run=>!(streaming && localStreamSession===activeSessionID && (run.id===localRunID || (!run.source_message_id && !localRunID)))).slice().reverse();
    const ids=new Set(runs.map(run=>run.id));
    holder.querySelectorAll('[data-agent-run]').forEach(node=>{if(!ids.has(node.dataset.agentRun))node.remove();});
    if(runs.length)document.querySelector('[data-agent-empty]')?.remove();
    const thread=document.querySelector('[data-agent-thread]');const near=thread && thread.scrollHeight-thread.scrollTop-thread.clientHeight<100;
    for(const run of runs){
      let node=holder.querySelector(`[data-agent-run="${CSS.escape(run.id)}"]`);
      if(!node){holder.insertAdjacentHTML('beforeend',runMarkup(run));node=holder.lastElementChild;}
      else {
        node.querySelector('[data-run-status]').textContent=runLabel(run);
        node.querySelector('[data-agent-stop]').hidden=!runActive(run);
        const copy=node.querySelector('[data-run-text]');
        if(copy.dataset.text!==(run.text||'')){copy.innerHTML=markdown(run.text||'',run.id);copy.dataset.text=run.text||'';}
        const note=node.querySelector('[data-run-note]');note.textContent=run.received_chars?'已接收 '+run.received_chars+' 字':'';
        const tools=node.querySelector('.agent-tool-events');for(const tool of run.tools||[])updateTool(tools,tool);
      }
      node.dataset.runState=run.state;
    }
    if(near && thread)thread.scrollTop=thread.scrollHeight;
  }
  async function syncActivity() {
    if(activityBusy || !activePage || !activeSessionID || !document.querySelector('[data-trigger-history]')?.getClientRects().length)return;
    activityBusy=true;const id=activeSessionID;
    try {
      const value=await api(`/api/agent/sessions/${encodeURIComponent(id)}/activity`);
      if(id!==activeSessionID || !snapshot)return;
      const before=snapshot.runs||[];snapshot.runs=value.runs||[];
      const index=sessions.findIndex(session=>session.id===id);if(index>=0 && value.session)sessions[index]={...sessions[index],...value.session};
      document.querySelectorAll('[data-agent-session]').forEach(button=>{const session=sessions.find(item=>item.id===button.dataset.agentSession);const status=button.querySelector('[data-session-state]');if(status)status.textContent=session?.run_state==='running'?'分析中':session?.run_state==='queued'?'排队中':'';});
      if(!streaming && before.some(run=>runActive(run) && !(value.runs||[]).some(next=>next.id===run.id && runActive(next))))await loadSessions(false,id);
      syncRunNodes();
    }catch{}finally{activityBusy=false;}
  }
  async function stopRun(runID='') {
    const sessionID=activeSessionID;if(!sessionID)return;
    if(localStreamSession===sessionID && (!runID || runID===localRunID))stopRequested=true;
    try {await api(`/api/agent/sessions/${encodeURIComponent(sessionID)}/stop`,'POST',{run_id:runID || localRunID || ''});await syncActivity();}
    catch(error){toast(error.message,undefined,true);}
  }
  function messageMarkup(message) {
    const role = message.role === 'user' ? 'user' : 'assistant';
    const tools = Array.isArray(message.tools) ? message.tools : [];
    const trigger = role === 'user' && message.trigger;
    const content = trigger ? String(message.content || '').replace(/^[^\n]*\n/, '') : String(message.content || '');
    const roleLabel = trigger ? '触发原文' : role === 'user' ? '你' : message.trigger ? '通知分析' : '交件箱 Agent';
    return `<article class="agent-message agent-message-${role}${trigger ? ' agent-message-trigger' : ''}" data-agent-message="${esc(message.id || '')}">
      <div class="agent-message-role">${roleLabel}</div>
      <div class="agent-message-bubble">${toolsMarkup(tools)}<div class="agent-message-copy markdown-body">${markdown(content,message.id)}</div></div>
      ${message.summarized ? '<div class="agent-message-note">已计入动态摘要</div>' : ''}
    </article>`;
  }

  function emptyMarkup() {
    return `<div class="agent-empty" data-agent-empty><span class="agent-empty-mark">${icon('agent')}</span>
      <strong>从一个触发结果开始</strong>
      <p>可继续检查材料、调整待办，也可以新建一个手动会话或跨会话调用。</p>
      <div class="agent-suggestions">
        <button type="button" data-agent-suggestion="检查这个任务的进度，并告诉我现在缺什么">检查当前任务</button>
        <button type="button" data-agent-suggestion="根据通知上下文，列出接下来最合理的执行步骤">整理下一步</button>
      </div></div>`;
  }

  function chatMarkup() {
    if (!selectedSession()) return `<div class="trigger-history-empty trigger-history-empty-large"><strong>选择或新建一个会话</strong><p>左侧按触发来源分组，右侧会话可以连续运行多轮。</p><button type="button" class="primary" data-agent-new>新建会话</button></div>`;
    if (loadingSession && !snapshot) return `<div class="trigger-history-empty trigger-history-empty-large"><strong>正在读取会话</strong><p>同步触发来源、消息和上下文用量。</p></div>`;
    if (!snapshot) return `<div class="trigger-history-empty trigger-history-empty-large"><strong>无法读取会话</strong><p>请稍后重试。</p><button type="button" class="secondary" data-agent-retry>重试</button></div>`;
    const session = snapshot.session || selectedSession(), sessionState = snapshot.state || {}, context = snapshot.context || sessionState;
    const permission = sessionState.permission === 'restricted' ? 'restricted' : 'full';
    const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    return `<div class="trigger-session-toolbar" aria-label="会话操作">
      <div class="trigger-session-actions"><button type="button" class="plain-button" data-agent-cross>${icon('share')}跨会话调用</button><button type="button" class="plain-button danger-hover" data-agent-delete>删除会话</button></div>
    </div>
    <div class="agent-thread" data-agent-thread role="log" aria-live="polite" tabindex="0" aria-label="会话消息">
      ${context.summary ? `<details class="agent-summary"><summary>查看已压缩的对话摘要</summary><p>${esc(context.summary)}</p></details>` : ''}
      ${messages.length ? messages.map(messageMarkup).join('') : (snapshot.runs?.length ? '' : emptyMarkup())}<div data-agent-runs></div>
    </div>
    <form class="agent-composer" data-agent-form>
      <div class="agent-compose-surface">
        <label class="agent-input-wrap"><span class="sr-only">继续这个触发会话</span><textarea data-agent-input rows="2" maxlength="50000" placeholder="继续问，或描述要让 Agent 完成的事情…"></textarea></label>
        <div class="agent-composer-footer">
          <div class="agent-permission-inline"><div class="chart-mode agent-permission" role="tablist" aria-label="AI 操作权限">
              <button type="button" role="tab" data-agent-permission="restricted" class="${permission === 'restricted' ? 'active' : ''}" aria-selected="${permission === 'restricted'}" tabindex="${permission === 'restricted' ? 0 : -1}">受限模式</button>
              <button type="button" role="tab" data-agent-permission="full" class="${permission === 'full' ? 'active' : ''}" aria-selected="${permission === 'full'}" tabindex="${permission === 'full' ? 0 : -1}">完全访问</button>
            </div></div>
          <div class="agent-compose-actions">${contextMarkup(context)}<button type="button" class="secondary agent-local-stop" data-agent-stop-local hidden>停止</button><button type="submit" class="primary agent-send" data-agent-send aria-label="发送消息" title="发送 · Enter（Shift + Enter 换行）">${icon('arrow')}</button></div>
        </div>
      </div>
      <p class="agent-compose-status" data-agent-status role="status"></p>
    </form>`;
  }

  function render() {
    const panel = document.querySelector('[data-trigger-history]');
    if (!panel) return;
    const openedTools = [...panel.querySelectorAll('.agent-tool-row[open]')].map(row=>row.dataset.toolId);
    const openGroups = [...panel.querySelectorAll('[data-agent-message]')].filter(row=>row.querySelector('.agent-tool-events[open]')).map(row=>row.dataset.agentMessage);
    const groups = groupSessions();
    if (!groups.some(group => group.key === activeOrigin)) activeOrigin = groups[0]?.key || '';
    const originBox = panel.querySelector('[data-agent-origins]');
    if (originBox) {
      const signature = JSON.stringify(groups);
      if (originBox.dataset.signature !== signature) {
        originBox.innerHTML = originMarkup(groups);
        originBox.dataset.signature = signature;
      }
      originBox.querySelectorAll('[data-agent-origin]').forEach(button => {
        const active = button.dataset.agentOrigin === activeOrigin;
        button.setAttribute('aria-pressed', String(active));
        button.closest('.trigger-origin-group').classList.toggle('is-active', active);
      });
      originBox.querySelectorAll('[data-agent-session]').forEach(button => {
        const active = button.dataset.agentSession === activeSessionID;
        button.classList.toggle('active', active);
        button.setAttribute('aria-current', String(active));
      });
    }
    const summary = panel.querySelector('[data-trigger-summary]');
    if (summary) summary.textContent = sessions.length ? `${groups.length} 个来源 · ${sessions.length} 个会话` : '还没有会话';
    const items = currentOriginSessions();
    if (!items.some(item => item.id === activeSessionID)) activeSessionID = items[0]?.id || '';
    const content = panel.querySelector('[data-agent-session-content]');
    if (content) {
      const form = content.querySelector('[data-agent-form]');
      const input = form?.querySelector('[data-agent-input]');
      const sameSession = renderedSessionID === activeSessionID;
      if (input && renderedSessionID) drafts.set(renderedSessionID, input.value);
      const previousThread = content.querySelector('[data-agent-thread]');
      const previousRuns = sameSession ? content.querySelector('[data-agent-runs]') : null;
      const scroll = sameSession ? previousThread?.scrollTop || 0 : 0;
      const signature=JSON.stringify({session:activeSessionID,ready:!!snapshot,messages:snapshot?.messages,summary:snapshot?.context?.summary});
      if(content.dataset.transcript===signature){syncRunNodes();hydrateIcons();uiMotion.syncSegments();return;}
      content.innerHTML = chatMarkup();
      content.dataset.transcript=signature;
      const nextRuns = content.querySelector('[data-agent-runs]');
      if (previousRuns && nextRuns) nextRuns.replaceWith(previousRuns);
      const nextForm = content.querySelector('[data-agent-form]');
      if (sameSession && form && nextForm) {
        const context = nextForm.querySelector('[data-agent-context]');
        if (context) form.querySelector('[data-agent-context]')?.replaceWith(context);
        nextForm.replaceWith(form);
      } else {
        const field = content.querySelector('[data-agent-input]');
        if (field) field.value = drafts.get(activeSessionID) || '';
      }
      renderedSessionID = activeSessionID;
      const thread = content.querySelector('[data-agent-thread]');
      if (thread) thread.scrollTop = scroll;
    }
    openedTools.forEach(id=>{const row=panel.querySelector(`[data-tool-id="${CSS.escape(id)}"]`);if(row)row.open=true;});
    openGroups.forEach(id=>{const row=panel.querySelector(`[data-agent-message="${CSS.escape(id)}"] .agent-tool-events`);if(row)row.open=true;});
    hydrateIcons();
    uiMotion.syncSegments();
    syncRunNodes();
    window.jjbMarkdown?.enhance(panel);
  }

  async function loadSessions(force = false, preferredID = '') {
    if (!state.session || loadingSessions) return;
    loadingSessions = true;
    const generation = ++sessionGeneration;
    try {
      const value = await api('/api/agent/sessions');
      if (generation !== sessionGeneration) return;
      sessions = Array.isArray(value.sessions) ? value.sessions : [];
      const preferred = preferredID || activeSessionID;
      const selected = sessions.find(item => item.id === preferred) || sessions[0];
      activeOrigin = selected?.origin_key || '';
      activeSessionID = selected?.id || '';
      render();
      if (activeSessionID) await loadSession(activeSessionID, true);
      else snapshot = null;
    } catch (error) {
      if (activePage) toast(error.message, undefined, true);
    } finally {
      loadingSessions = false;
    }
  }

  async function loadSession(sessionID, force = false) {
    if (!sessionID || (loadingSession && !force)) return;
    const opening = !snapshot || snapshot.session?.id !== sessionID;
    const previousThread=document.querySelector('[data-agent-thread]');
    const follow=previousThread && previousThread.scrollHeight-previousThread.scrollTop-previousThread.clientHeight<100;
    loadingSession = true;
    const generation = ++sessionGeneration;
    try {
      const value = await api(`/api/agent/sessions/${encodeURIComponent(sessionID)}`);
      if (generation !== sessionGeneration || sessionID !== activeSessionID) return;
      snapshot = value;
      const index = sessions.findIndex(item => item.id === sessionID);
      if (index >= 0 && value.session) sessions[index] = { ...sessions[index], ...value.session };
      render();
      const thread = document.querySelector('[data-agent-thread]');
      if (thread && opening) {if((snapshot.runs||[]).some(runActive))scrollBottom(true);else thread.scrollTop = 0;}
      else if(follow)scrollBottom(true);
    } catch (error) {
      if (activePage) {
        snapshot = null;
        render();
        toast(error.message, undefined, true);
      }
    } finally {
      loadingSession = false;
    }
  }

  function fitHistory() {
    const panel = document.querySelector('[data-trigger-history]');
    if (!panel || !panel.getClientRects().length) return;
    const viewport = window.visualViewport;
    let bottom = (viewport?.height || innerHeight) + (viewport?.offsetTop || 0) - 16;
    const nav = document.querySelector('.sidebar');
    if (innerWidth <= 620 && nav) bottom = Math.min(bottom, nav.getBoundingClientRect().top - 12);
    const height = Math.max(240, bottom - panel.getBoundingClientRect().top);
    panel.style.setProperty('--trigger-panel-height', `${height}px`);
  }
  window.addEventListener('resize', fitHistory);
  window.visualViewport?.addEventListener('resize', fitHistory);

  function mount() {
    activePage = true;
    clearInterval(activityTimer);activityTimer=setInterval(syncActivity,300);
    layoutObserver?.disconnect();
    const panel = document.querySelector('[data-trigger-history]');
    if (panel) { layoutObserver = new ResizeObserver(fitHistory); layoutObserver.observe(panel); requestAnimationFrame(fitHistory); }
    if (!document.querySelector('[data-trigger-history]') || loadingSessions) return;
    if (!sessions.length) loadSessions(true);
    else render();
  }

  function unmount() {
    const input = document.querySelector('[data-agent-input]');
    if (input && renderedSessionID) drafts.set(renderedSessionID, input.value);
    renderedSessionID = '';
    activePage = false;
    clearInterval(activityTimer);
    layoutObserver?.disconnect();
    // Navigation only detaches the local view. The server-side run keeps going
    // and explicit stop remains available from activity when the page returns.
  }

  function scrollBottom(force = false) {
    const thread = document.querySelector('[data-agent-thread]');
    if (!thread) return;
    const near = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
    if (force || near) thread.scrollTop = thread.scrollHeight;
  }

  function appendLocal(role, content, extra = {}) {
    if (!snapshot) snapshot = { messages: [], context: {}, state: {}, session: selectedSession() };
    const message = { id: `local-${Date.now()}-${snapshot.messages.length}`, role, content, ...extra };
    snapshot.messages.push(message);
    const thread = document.querySelector('[data-agent-thread]');
    if (!thread) return message;
    thread.querySelector('[data-agent-empty]')?.remove();
    thread.insertAdjacentHTML('beforeend', messageMarkup(message));
    hydrateIcons();
    scrollBottom();
    return message;
  }

  async function streamChat(content, route = '', bodyExtra = {}) {
    if (!activeSessionID || streaming) return;
    const targetSessionID=activeSessionID;
    localStreamSession=activeSessionID;localRunID='';stopRequested=false;
    const button = document.querySelector('[data-agent-send]'), input = document.querySelector('[data-agent-input]'), status = document.querySelector('[data-agent-status]');
    appendLocal('user', content);
    const live = appendLocal('assistant', '', { live: true });
    const liveNode = document.querySelector(`[data-agent-message="${CSS.escape(live.id)}"]`);
    const copy = liveNode?.querySelector('.agent-message-copy');
    const toolHolder = liveNode?.querySelector('.agent-tool-events');
    let paint = 0;
    const renderReceived = () => {
      if (paint) return;
      paint = requestAnimationFrame(() => {paint=0; if(copy?.isConnected){copy.innerHTML=markdown(received,live.id);scrollBottom();}});
    };
    streaming = true; const stopButton=document.querySelector('[data-agent-stop-local]');if(stopButton)stopButton.hidden=false;button.disabled = true; input.disabled = true; status.textContent = 'Agent 正在读取触发上下文并规划操作…';
    streamController = new AbortController();
    let request = { route: route || `/api/agent/sessions/${encodeURIComponent(activeSessionID)}/chat?stream=true`, method: 'POST', body: { message: content, permission: snapshot?.state?.permission || 'full', ...bodyExtra } };
    if (window.pluginUI) request = await window.pluginUI.beforeRequest(request);
    let received = '', result = null;
    try {
      const response = await fetch(apiUrl(request.route), { method: request.method, headers: { Authorization: 'Bearer ' + state.session.token, 'Content-Type': 'application/json' }, body: JSON.stringify(request.body), signal: streamController.signal });
      if (!response.ok) {
        let detail = 'Agent 请求失败';
        try { const value = await response.json(); detail = value.detail?.message || value.detail || detail; } catch {}
        throw new Error(detail);
      }
      if (!response.headers.get('content-type')?.includes('text/event-stream')) {
        result = await response.json();
        received = result.message?.content || '';
        renderReceived();
      } else {
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let buffer = '';
        const consume = packet => {
          const type = packet.event || 'message', value = packet.data || {};
          if (type === 'progress') {
            if(value.run_id)localRunID=value.run_id;
            if (value.stage === 'receiving' && value.delta) {
              received += value.delta; renderReceived();
            } else if (value.stage === 'tool') {
              if(toolHolder)updateTool(toolHolder,value.tool||{});
              status.textContent = `${toolLabel(value.tool)}${toolState(value.tool||{})==='running'?'…':' · 已返回'}`; scrollBottom();
            } else if (value.stage === 'compressing') {
              status.textContent = '上下文接近上限，正在压缩较早的 50% 消息…';
            } else if (value.stage === 'compressed') {
              updateContext(value.context); status.textContent = '上下文已压缩，继续处理当前消息…';
            } else if (value.context) updateContext(value.context);
          } else if (type === 'error') {
            throw new Error(value.message || 'Agent 未完成本次操作');
          } else if (type === 'result') {
            result = value;
          }
        };
        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
          buffer = buffer.replace(/\r\n/g, '\n');
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            let event = 'message', data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (data) consume({ event, data: JSON.parse(data) });
          }
          if (done) break;
        }
      }
      if (!result?.message) throw new Error('Agent 没有返回最终答复');
      if(!activePage || activeSessionID!==targetSessionID){if(activePage)await loadSessions(false,activeSessionID);return;}
      snapshot.messages = snapshot.messages.filter(message => message !== live).concat(result.message);
      snapshot.context = result.context || snapshot.context;
      snapshot.state = result.state || snapshot.state;
      snapshot.session = result.session || snapshot.session;
      const index = sessions.findIndex(item => item.id === activeSessionID);
      if (index >= 0 && result.session) sessions[index] = { ...sessions[index], ...result.session };
      const toolGroupOpen = toolHolder?.open;
      status.textContent = result.context?.compressed_count ? `已完成 · ${result.context.compressed_count} 条消息已压缩` : '已完成';
      render();
      const finalGroup = document.querySelector(`[data-agent-message="${CSS.escape(result.message.id)}"] .agent-tool-events`);
      if(finalGroup && toolGroupOpen)finalGroup.open=true;
      scrollBottom(true);
      await refresh({ renderPage: false });
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (copy) copy.textContent = stopRequested?'已停止本轮处理':error.message;
      if (liveNode && !stopRequested) liveNode.classList.add('agent-message-error');
      if (status) status.textContent = stopRequested?'已停止，已完成的操作和记录会保留':'本次未完成，可以调整权限或要求后重试';
    } finally {
      cancelAnimationFrame(paint);
      streaming = false; streamController = null;
      if(stopButton)stopButton.hidden=true;
      localRunID='';localStreamSession='';
      syncActivity();
      const send = document.querySelector('[data-agent-send]'), field = document.querySelector('[data-agent-input]');
      if (send) send.disabled = false; if (field) { field.disabled = false; field.focus({ preventScroll: true }); }
    }
  }

  function updateContext(value) {
    if (!snapshot) return;
    snapshot.context = value || snapshot.context;
    const node = document.querySelector('[data-agent-context]');
    if (node) node.outerHTML = contextMarkup(snapshot.context);
  }

  async function setPermission(permission) {
    if (!activeSessionID) return;
    const value = permission === 'full' ? 'full' : 'restricted';
    const result = await api(`/api/agent/sessions/${encodeURIComponent(activeSessionID)}`, 'PATCH', { permission: value });
    if (snapshot) snapshot.state = result.state || snapshot.state;
    document.querySelectorAll('[data-agent-permission]').forEach(button => {
      const active = button.dataset.agentPermission === value;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    uiMotion.syncSegments();
    if (value === 'full') toast('已切换为完全访问：Agent 可以修改待办和项目内容');
  }

  async function createSession() {
    const now = new Date();
    const title = `手动会话 · ${now.getMonth() + 1}月${now.getDate()}日 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    try {
      const value = await api('/api/agent/sessions', 'POST', { title, permission: 'full' });
      await loadSessions(true, value.session?.id);
    } catch (error) { toast(error.message, undefined, true); }
  }

  async function deleteSession() {
    if (!activeSessionID || !confirm(`删除“${selectedSession()?.title || '这个会话'}”及其对话记录？待办和文件不会被删除。`)) return;
    try {
      await api(`/api/agent/sessions/${encodeURIComponent(activeSessionID)}`, 'DELETE');
      activeSessionID = ''; snapshot = null; await loadSessions(true);
      toast('触发会话已删除');
    } catch (error) { toast(error.message, undefined, true); }
  }

  async function openCrossDialog() {
    if (!activeSessionID) return;
    const candidates = sessions.filter(item => item.id !== activeSessionID);
    if (!candidates.length) return toast('先新建另一个会话，再跨会话调用');
    const dialog = document.createElement('dialog');
    dialog.className = 'motion-dialog trigger-cross-dialog';
    dialog.innerHTML = `<form><div class="dialog-heading"><div><div class="eyebrow">跨会话调用</div><h2>把上下文带到另一个触发会话</h2></div><button type="button" class="icon-button" data-cross-close aria-label="关闭">×</button></div>
      <div class="dialog-body"><p class="helper">当前会话的摘要和最近消息会作为事实上下文发送，目标会话继续处理；自动调用使用受限只读权限。</p><label>目标会话<select data-cross-target>${candidates.map(item => `<option value="${esc(item.id)}">${esc(item.origin_label || '会话')} · ${esc(item.title)}</option>`).join('')}</select></label><label>要继续处理什么<textarea data-cross-message rows="4" maxlength="50000" required placeholder="例如：接着检查材料和待办，给出下一步"></textarea></label><p class="error" data-cross-status role="alert"></p></div>
      <div class="dialog-footer"><button type="button" class="secondary" data-cross-close>取消</button><button type="submit" class="primary">调用目标会话</button></div></form>`;
    document.body.append(dialog);
    dialog.querySelectorAll('[data-cross-close]').forEach(button => button.addEventListener('click', () => uiMotion.closeDialog(dialog).then(() => dialog.remove())));
    dialog.addEventListener('cancel', event => { event.preventDefault(); uiMotion.closeDialog(dialog).then(() => dialog.remove()); });
    dialog.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault();
      const button = event.submitter, target = dialog.querySelector('[data-cross-target]').value;
      const message = dialog.querySelector('[data-cross-message]').value.trim();
      const status = dialog.querySelector('[data-cross-status]');
      if (!message) return;
      button.disabled = true; status.textContent = '正在调用目标会话…';
      try {
        const value = await api(`/api/agent/sessions/${encodeURIComponent(target)}/cross-chat`, 'POST', { source_session_id: activeSessionID, message, permission: 'restricted' });
        await uiMotion.closeDialog(dialog); dialog.remove();
        await loadSessions(true, value.session?.id || target);
        toast('已在目标触发会话中继续处理');
      } catch (error) { status.textContent = error.message; button.disabled = false; }
    });
    await uiMotion.openDialog(dialog);
    dialog.querySelector('[data-cross-message]')?.focus();
  }

  document.addEventListener('click', event => {
    if (!activePage || !document.querySelector('[data-trigger-history]')) return;
    document.querySelectorAll('.agent-permission-picker[open],.agent-context-peek[open]').forEach(picker => {
      if (!picker.contains(event.target)) picker.open = false;
    });
    const origin = event.target.closest('[data-agent-origin]');
    if (origin) {
      if (origin.dataset.agentOrigin === activeOrigin) return;
      activeOrigin = origin.dataset.agentOrigin;
      activeSessionID = currentOriginSessions()[0]?.id || '';
      snapshot = null; render(); if (activeSessionID) loadSession(activeSessionID, true);
      return;
    }
    const tab = event.target.closest('[data-agent-session]');
    if (tab) {
      if (tab.dataset.agentSession === activeSessionID) return;
      const session = sessions.find(item => item.id === tab.dataset.agentSession);
      activeOrigin = session?.origin_key || activeOrigin;
      activeSessionID = tab.dataset.agentSession;
      snapshot = null; render(); loadSession(activeSessionID, true); return;
    }
    const stop=event.target.closest('[data-agent-stop]');if(stop){stopRun(stop.dataset.runId);return;}
    if(event.target.closest('[data-agent-stop-local]')){stopRun(localRunID);return;}
    if (event.target.closest('[data-agent-new]')) { createSession(); return; }
    const permission = event.target.closest('[data-agent-permission]');
    if (permission) { setPermission(permission.dataset.agentPermission).catch(error => toast(error.message, undefined, true)); return; }
    if (event.target.closest('[data-agent-cross]')) { openCrossDialog(); return; }
    if (event.target.closest('[data-agent-delete]')) { deleteSession(); return; }
    if (event.target.closest('[data-agent-retry]')) { loadSession(activeSessionID, true); return; }
    const suggestion = event.target.closest('[data-agent-suggestion]');
    if (suggestion) {
      const input = document.querySelector('[data-agent-input]');
      if (input) { input.value = suggestion.dataset.agentSuggestion; input.focus(); }
    }
  });

  document.addEventListener('input', event => {
    if (event.target.matches('[data-agent-input]')) {
      if (activeSessionID) drafts.set(activeSessionID, event.target.value);
      event.target.style.height = 'auto';
      event.target.style.height = `${Math.min(152, event.target.scrollHeight)}px`;
      return;
    }
    if (!event.target.matches('[data-agent-origin-search]')) return;
    originQuery = event.target.value.trim().toLowerCase();
    render();
  });

  document.addEventListener('pointerover', event => {
    const peek = event.target.closest('.agent-context-peek');
    if (peek && event.pointerType === 'mouse') peek.open = true;
  });
  document.addEventListener('pointerout', event => {
    const peek = event.target.closest('.agent-context-peek');
    if (peek && event.pointerType === 'mouse' && !peek.contains(event.relatedTarget)) peek.open = false;
  });

  document.addEventListener('submit', event => {
    if (!event.target.matches('[data-agent-form]')) return;
    event.preventDefault();
    const input = event.target.querySelector('[data-agent-input]');
    const content = input?.value.trim();
    if (!content || streaming) return;
    drafts.delete(activeSessionID);
    input.value = '';
    streamChat(content);
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') document.querySelectorAll('.agent-permission-picker[open],.agent-context-peek[open]').forEach(picker => { picker.open = false; });
    if (!activePage || !event.target.matches('[data-agent-input]')) return;
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.target.closest('form')?.requestSubmit(); }
  });

  document.addEventListener('jjb:markdown-ready', () => {
    if (!activePage || streaming || !snapshot) return;
    renderedSessionID = '';
    render();
  });

  window.agentUI = {
    historyPanel,
    mount,
    unmount,
    reload: loadSessions,
    synced() {
      if (!activePage || (streaming && localStreamSession===activeSessionID) || !document.querySelector('[data-trigger-history]')) return;
      if(syncTimer)return;
      syncTimer = setTimeout(() => {syncTimer=0;loadSessions(false, activeSessionID);}, 250);
    },
  };
})();
