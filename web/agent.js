/* Single persistent AI conversation. The server owns tools and context
   compression; this module only streams state and keeps one composer alive. */
(() => {
  'use strict';
  let loadedKey = '', loading = false, messages = [], context = null, permission = 'restricted';
  let streamController = null, activePage = false;
  const permissionKey = () => `jjb-agent-permission:${state.profile || 'pending'}`;
  const tokenText = value => {
    const n = Number(value) || 0;
    return n >= 1000000 ? `${(n / 1000000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
  };
  const identity = () => state.session ? `${state.session.server}|${state.session.user_id}` : '';
  const savedPermission = () => {
    try {
      const value = localStorage.getItem(permissionKey());
      return value === 'full' ? 'full' : 'restricted';
    } catch { return 'restricted'; }
  };
  const setPermission = value => {
    permission = value === 'full' ? 'full' : 'restricted';
    try { localStorage.setItem(permissionKey(), permission); } catch {}
    const panel = document.querySelector('.agent-permission');
    if (panel) {
      panel.querySelectorAll('[data-agent-permission]').forEach(button => {
        const active = button.dataset.agentPermission === permission;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
      });
      const note = document.querySelector('[data-agent-permission-note]');
      if (note) note.textContent = permission === 'full'
        ? '完全访问：AI 可以按你的要求创建、修改、归档、移入回收站或恢复待办。每次删除都会先查看目标，并明确告知结果。'
        : '受限模式：AI 只能读取项目信息，不能创建、修改或删除任何内容。';
      uiMotion.syncSegments();
    }
  };
  const toolLabel = tool => ({
    list_tasks: '查看待办',
    get_task: '读取待办',
    check_task_progress: '检查材料进度',
    search_messages: '搜索通知',
    list_files: '查看文件',
    create_task: '创建待办',
    update_task: '修改待办',
    set_task_status: '更新待办进度',
    trash_task: '移入回收站',
    restore_task: '恢复待办',
  }[tool?.name] || tool?.name || '调用工具');
  function messageMarkup(message) {
    const role = message.role === 'user' ? 'user' : 'assistant';
    const tools = Array.isArray(message.tools) ? message.tools : [];
    return `<article class="agent-message agent-message-${role}" data-agent-message="${esc(message.id || '')}">
      <div class="agent-message-role">${role === 'user' ? '你' : '交件箱 AI'}</div>
      <div class="agent-message-copy">${esc(message.content || '')}</div>
      ${tools.length ? `<div class="agent-tool-events">${tools.map(tool => `<span class="${tool.ok ? '' : 'error'}">${icon(tool.ok ? 'check' : 'connect')}${esc(toolLabel(tool))}</span>`).join('')}</div>` : ''}
      ${message.summarized ? '<div class="agent-message-note">已计入上方动态摘要</div>' : ''}
    </article>`;
  }
  function contextMarkup() {
    const value = context || { limit: 1000000, used: 0, percent: 0, compressed_count: 0, active_count: 0 };
    const percent = Math.max(0, Math.min(100, Number(value.percent) || 0));
    return `<div class="agent-context-heading"><strong>上下文用量</strong><span>${tokenText(value.used)} / ${tokenText(value.limit)} · ${percent.toFixed(percent < 10 ? 1 : 0)}%</span></div>
      <div class="agent-context-track" role="progressbar" aria-label="AI 上下文用量" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percent)}"><i style="transform:scaleX(${percent / 100})"></i></div>
      <p class="agent-context-note">${value.compressed_count ? `${value.compressed_count} 条较早消息已压缩为摘要` : Number(value.percent) >= 80 ? '即将压缩较早消息' : '达到 80% 时，将把前 50% 消息压缩为顶部摘要'} · 保留 ${value.active_count || 0} 条原文</p>`;
  }
  function updateContext(value) {
    context = value && typeof value === 'object' ? value : context;
    const node = document.querySelector('[data-agent-context]');
    if (node) node.innerHTML = contextMarkup();
  }
  function emptyMarkup() {
    return `<div class="agent-empty" data-agent-empty>
      <span class="agent-empty-mark">${icon('agent')}</span>
      <strong>从一个具体目标开始</strong>
      <p>可以让 AI 查看某项待办的进度、整理下一步，或在完全访问模式下直接修改内容。</p>
      <div class="agent-suggestions">
        <button type="button" data-agent-suggestion="查看我最近 7 天内到期的待办，按紧急程度整理下一步">整理近期待办</button>
        <button type="button" data-agent-suggestion="检查所有准备材料中的待办，哪些还没有满足材料要求？">检查材料进度</button>
        <button type="button" data-agent-suggestion="帮我总结最近通知里新增的任务，并指出仍然缺少的信息">总结最近通知</button>
      </div>
    </div>`;
  }
  function threadMarkup() {
    return messages.length ? messages.map(messageMarkup).join('') : emptyMarkup();
  }
  function page() {
    if (!state.session) return '';
    return heading('AI', '一个持续对话，能查看进度，也能在允许时直接修改交件箱。', '<button type="button" class="plain-button danger-hover" data-agent-clear>清除上下文</button>') +
      `<section class="panel agent-shell">
        <header class="agent-toolbar">
          <div class="agent-permission-block">
            <span class="agent-toolbar-label">操作权限</span>
            <div class="chart-mode agent-permission" role="tablist" aria-label="AI 操作权限">
              <button type="button" role="tab" data-agent-permission="restricted" class="${permission === 'restricted' ? 'active' : ''}" aria-selected="${permission === 'restricted'}" tabindex="${permission === 'restricted' ? 0 : -1}">受限模式</button>
              <button type="button" role="tab" data-agent-permission="full" class="${permission === 'full' ? 'active' : ''}" aria-selected="${permission === 'full'}" tabindex="${permission === 'full' ? 0 : -1}">完全访问</button>
            </div>
            <p data-agent-permission-note>${permission === 'full' ? '完全访问：AI 可以按你的要求创建、修改、归档、移入回收站或恢复待办。' : '受限模式：AI 只能读取项目信息，不能创建、修改或删除任何内容。'}</p>
          </div>
          <div class="agent-context" data-agent-context>${contextMarkup()}</div>
        </header>
        ${context?.summary ? `<details class="agent-summary"><summary>查看已压缩的对话摘要</summary><p>${esc(context.summary)}</p></details>` : ''}
        <div class="agent-thread" data-agent-thread role="log" aria-live="polite">${threadMarkup()}</div>
        <form class="agent-composer" data-agent-form>
          <label class="agent-input-wrap">
            <span class="sr-only">发送给交件箱 AI</span>
            <textarea data-agent-input rows="3" maxlength="50000" placeholder="描述你希望 AI 查看或完成的事情…"></textarea>
          </label>
          <div class="agent-composer-footer">
            <p data-agent-status role="status">${permission === 'restricted' ? '仅读取项目信息' : '可以修改项目内容'} · Enter 发送，Shift + Enter 换行</p>
            <button type="submit" class="primary" data-agent-send>${icon('arrow')}发送</button>
          </div>
        </form>
      </section>`;
  }
  async function load(force = false) {
    const current = identity();
    if (!current || (!force && loadedKey === current && !loading)) return;
    loading = true;
    const generation = state.generation;
    try {
      const value = await api('/api/agent/thread');
      if (generation !== state.generation) return;
      loadedKey = current;
      messages = Array.isArray(value.messages) ? value.messages : [];
      context = value.context || value.state || {};
      permission = savedPermission();
      if (activePage) {
        const thread = document.querySelector('[data-agent-thread]');
        if (thread) thread.innerHTML = threadMarkup();
        updateContext(context);
        setPermission(permission);
        scrollBottom(true);
      }
    } catch (error) {
      if (activePage) {
        const thread = document.querySelector('[data-agent-thread]');
        if (thread) thread.innerHTML = `<div class="agent-empty agent-error"><strong>无法读取 AI 对话</strong><p>${esc(error.message)}</p><button type="button" class="secondary" data-agent-retry>重试</button></div>`;
      }
    } finally { loading = false; }
  }
  function mount() {
    activePage = true;
    permission = savedPermission();
    uiMotion.syncSegments();
    load();
  }
  function unmount() {
    activePage = false;
    streamController?.abort();
    streamController = null;
  }
  function scrollBottom(force = false) {
    const thread = document.querySelector('[data-agent-thread]');
    if (!thread) return;
    const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
    if (force || nearBottom) thread.scrollTop = thread.scrollHeight;
  }
  function appendLocal(role, content, extra = {}) {
    const message = { id: `local-${Date.now()}-${messages.length}`, role, content, ...extra };
    messages.push(message);
    const thread = document.querySelector('[data-agent-thread]');
    if (!thread) return message;
    thread.querySelector('[data-agent-empty]')?.remove();
    thread.insertAdjacentHTML('beforeend', messageMarkup(message));
    hydrateIcons();
    scrollBottom();
    return message;
  }
  async function streamChat(content) {
    const button = document.querySelector('[data-agent-send]');
    const input = document.querySelector('[data-agent-input]');
    const status = document.querySelector('[data-agent-status]');
    appendLocal('user', content);
    const live = appendLocal('assistant', '', { live: true });
    const liveNode = document.querySelector(`[data-agent-message="${CSS.escape(live.id)}"]`);
    const copy = liveNode?.querySelector('.agent-message-copy');
    const toolHolder = liveNode?.querySelector('.agent-tool-events') || document.createElement('div');
    if (!toolHolder.isConnected) { toolHolder.className = 'agent-tool-events'; liveNode?.append(toolHolder); }
    button.disabled = true; input.disabled = true;
    status.textContent = 'AI 正在读取项目并规划操作…';
    streamController = new AbortController();
    let request = { route: '/api/agent/chat?stream=true', method: 'POST', body: { message: content, permission } };
    if (window.pluginUI) request = await window.pluginUI.beforeRequest(request);
    let received = '', result = null;
    try {
      const response = await fetch(apiUrl(request.route), {
        method: request.method,
        headers: { Authorization: 'Bearer ' + state.session.token, 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
        signal: streamController.signal,
      });
      if (!response.ok) {
        let detail = 'AI 请求失败';
        try { const value = await response.json(); detail = value.detail?.message || value.detail || detail; } catch {}
        throw new Error(detail);
      }
      if (!response.headers.get('content-type')?.includes('text/event-stream')) {
        result = await response.json();
        received = result.message?.content || '';
        if (copy) copy.textContent = received;
      } else {
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let buffer = '';
        const consume = packet => {
          const type = packet.event || 'message';
          const value = packet.data || {};
          if (type === 'progress') {
            if (value.stage === 'receiving' && value.delta) {
              received += value.delta;
              if (copy) copy.textContent = received;
              scrollBottom();
            } else if (value.stage === 'tool') {
              const item = document.createElement('span');
              item.className = value.tool?.ok ? '' : 'error';
              item.innerHTML = `${icon(value.tool?.ok ? 'check' : 'connect')}${esc(toolLabel(value.tool))}`;
              toolHolder.append(item);
              hydrateIcons();
              status.textContent = `${toolLabel(value.tool)}…`;
              scrollBottom();
            } else if (value.stage === 'compressing') {
              status.textContent = `上下文接近上限，正在压缩较早的 50% 消息…`;
            } else if (value.stage === 'compressed') {
              updateContext(value.context);
              status.textContent = '上下文已压缩，继续处理当前消息…';
            } else if (value.context) updateContext(value.context);
          } else if (type === 'error') {
            throw new Error(value.message || 'AI 未完成本次操作');
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
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
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
      if (!result || !result.message) throw new Error('AI 没有返回最终答复');
      messages = messages.filter(message => message !== live).concat(result.message);
      const finalNode = document.querySelector(`[data-agent-message="${CSS.escape(live.id)}"]`);
      if (finalNode) {
        finalNode.outerHTML = messageMarkup(result.message);
        hydrateIcons();
      }
      updateContext(result.context);
      const thread = document.querySelector('[data-agent-thread]');
      const summary = document.querySelector('.agent-summary');
      if (summary) summary.remove();
      if (result.context?.summary) {
        document.querySelector('.agent-toolbar')?.insertAdjacentHTML('afterend', `<details class="agent-summary" open><summary>查看已压缩的对话摘要</summary><p>${esc(result.context.summary)}</p></details>`);
      }
      status.textContent = result.context?.compressed_count ? `已完成 · ${result.context.compressed_count} 条较早消息已压缩` : '已完成';
      await refresh({ renderPage: false });
      scrollBottom(true);
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (copy) copy.textContent = error.message;
      if (liveNode) liveNode.classList.add('agent-message-error');
      status.textContent = '本次未完成，可以调整权限或要求后重试';
    } finally {
      button.disabled = false; input.disabled = false; input.focus({ preventScroll: true });
      streamController = null;
    }
  }
  async function clearThread(button) {
    if (messages.length && !confirm('清除这段 AI 对话和已压缩摘要？待办与文件不会被删除。')) return;
    button.disabled = true;
    try {
      const value = await api('/api/agent/thread', 'DELETE');
      messages = [];
      context = value.context || {};
      document.querySelector('[data-agent-thread]').innerHTML = emptyMarkup();
      const summary = document.querySelector('.agent-summary'); if (summary) summary.remove();
      updateContext(context);
      hydrateIcons();
      toast('AI 上下文已清除');
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  }
  document.addEventListener('click', event => {
    if (!activePage) return;
    const permissionButton = event.target.closest('[data-agent-permission]');
    if (permissionButton) {
      const next = permissionButton.dataset.agentPermission;
      if (next === 'full' && permission !== 'full') toast('已切换到完全访问：AI 现在可以修改项目');
      setPermission(next);
      return;
    }
    const suggestion = event.target.closest('[data-agent-suggestion]');
    if (suggestion) {
      const input = document.querySelector('[data-agent-input]');
      input.value = suggestion.dataset.agentSuggestion;
      input.focus();
      return;
    }
    const retry = event.target.closest('[data-agent-retry]');
    if (retry) return load(true);
    const clear = event.target.closest('[data-agent-clear]');
    if (clear) return clearThread(clear);
  });
  document.addEventListener('submit', event => {
    if (!event.target.matches('[data-agent-form]')) return;
    event.preventDefault();
    const input = event.target.querySelector('[data-agent-input]');
    const content = input.value.trim();
    if (!content || loading) return;
    input.value = '';
    streamChat(content);
  });
  document.addEventListener('keydown', event => {
    if (!activePage || event.target.matches('[data-agent-input]') !== true) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.target.closest('form')?.requestSubmit();
    }
  });
  window.agentUI = { page, mount, unmount, reload: load, synced: () => { if (activePage && !streamController) load(true); } };
})();
