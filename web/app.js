'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const paths = {
  inbox: '<path d="M3 4h14l3 9v7H0v-7L3 4Z" transform="translate(2 0)"/><path d="M3 13h5l2 3h4l2-3h5"/>',
  check: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>',
  connect: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/><path d="M17 3v6h4M3 17h6v4M9 17l8-8"/>',
  settings: '<path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z"/><circle cx="12" cy="12" r="3"/>',
  refresh: '<path d="M20 10a8 8 0 1 0-2 8M20 4v6h-6"/>',
  logout: '<path d="M10 4H4v16h6M12 12h9m-4-4 4 4-4 4"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  file: '<path d="M5 3h9l5 5v13H5V3Z"/><path d="M14 3v6h5M9 13h6M9 17h5"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.file}</svg>`;
const formatDate = (value, short = false) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', ...(short ? {} : { hour: '2-digit', minute: '2-digit' }), hour12: false }) : '未设置';
const bytes = size => size >= 1024 ** 2 ? (size / 1024 ** 2).toFixed(1) + ' MB' : size >= 1024 ? (size / 1024).toFixed(1) + ' KB' : size + ' B';
const states = { collecting: ['准备材料', 'orange'], ready: ['待提交', 'blue'], submitted: ['已提交', 'green'], archived: ['已归档', ''] };
const classifications = { actionable: ['交件通知', 'green'], chatting: ['普通聊天', ''], irrelevant: ['其他信息', ''], unprocessed: ['待分析', 'orange'] };
const state = { session: null, profile: '', page: 'inbox', snapshot: { tasks: [], messages: [], cursor: 0 }, pending: [], selected: null, taskId: null, contexts: new Set(), search: '', source: 'all', category: 'all', taskFilter: 'active', online: false, socket: null, sources: {}, busyAnalysis: new Set(), isRegister: false, generation: 0 };
let flushRunning = false, refreshRunning = false, cacheTimer, toastTimer, reconnectTimer, llmSettings = null, editingVersion = 0, uploading = false;

async function storeGet(key) {
  if (window.desktop) return desktop.get(key);
  try { return JSON.parse(localStorage.getItem('jjb-' + key)); } catch { return null; }
}
async function storeSet(key, value) {
  if (window.desktop) return desktop.set(key, value);
  localStorage.setItem('jjb-' + key, JSON.stringify(value));
}
function toast(message) {
  $('#toast').textContent = message; $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000);
}
function hydrateIcons() { $$('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); }); }
function apiUrl(route) { return state.session.server.replace(/\/$/, '') + route; }
async function api(route, method = 'GET', body) {
  const headers = { Authorization: 'Bearer ' + state.session.token };
  if (body !== undefined && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(apiUrl(route), { method, headers, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(route === '/api/analyze' ? 100000 : 45000) });
  if (!response.ok) {
    let detail;
    try { detail = (await response.json()).detail; } catch { detail = '服务端返回错误'; }
    const error = new Error(typeof detail === 'string' ? detail : detail?.message || (response.status === 422 ? '请检查表单内容是否完整、时间格式是否正确' : '请求失败'));
    error.status = response.status; error.detail = detail;
    throw error;
  }
  return response.json();
}
function online(value) {
  state.online = value;
  const el = $('#sync-state');
  el.classList.toggle('offline', !value);
  el.innerHTML = `<i></i>${value ? '已同步' : '连接中'}${state.pending.length ? ` · ${state.pending.length} 项待同步` : ''}`;
  $('#offline-banner').hidden = value;
}
function cacheSoon() {
  const profile = state.profile;
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => {
    if (profile === state.profile) storeSet('cache-' + profile, { snapshot: state.snapshot, pending: state.pending }).catch(() => toast('本机缓存保存失败，请检查存储空间'));
  }, 250);
}
function applyPending(snapshot) {
  const tasks = [...snapshot.tasks];
  for (const item of state.pending) {
    const id = item.taskId || item.localId;
    const index = tasks.findIndex(t => t.id === id);
    const visible = { ...(index >= 0 ? tasks[index] : {}), ...item.body, id, attachments: index >= 0 ? tasks[index].attachments : [], pending: true, conflict: item.conflict };
    if (index >= 0) tasks[index] = visible; else tasks.unshift(visible);
  }
  return { ...snapshot, tasks };
}
async function refresh({ renderPage = true } = {}) {
  if (!state.session || refreshRunning) return;
  const generation = state.generation;
  refreshRunning = true;
  try {
    const snapshot = await api('/api/snapshot');
    if (generation !== state.generation) return;
    const contentChanged = JSON.stringify(state.snapshot.tasks) !== JSON.stringify(applyPending(snapshot).tasks) || JSON.stringify(state.snapshot.messages.slice(0, 200)) !== JSON.stringify(snapshot.messages);
    const previousMessages = state.snapshot.messages;
    state.snapshot = applyPending(snapshot);
    const latestIds = new Set(snapshot.messages.map(m => m.id));
    state.snapshot.messages.push(...previousMessages.filter(m => !latestIds.has(m.id)));
    online(true); cacheSoon();
    if (renderPage && contentChanged && !uploading && !['settings', 'sources'].includes(state.page)) render();
    window.dispatchEvent(new CustomEvent('snapshot-updated')); 
    updateCounts();
  } catch (error) {
    if (generation !== state.generation) return;
    online(false);
    if (error.status === 401) toast('登录已过期，请退出后重新登录');
  } finally { refreshRunning = false; }
}
function syncSocket() {
  clearTimeout(reconnectTimer);
  const generation = state.generation;
  if (!state.session) return;
  const url = new URL(apiUrl('/api/sync')); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url); state.socket = socket;
  socket.onopen = () => {
    if (generation !== state.generation) return socket.close();
    socket.send(JSON.stringify({ token: state.session.token, after: state.snapshot.cursor || 0 }));
    online(true); flushOutbox();
  };
  socket.onmessage = async event => {
    if (generation !== state.generation) return;
    const packet = JSON.parse(event.data);
    if (packet.type === 'changes') await refresh();
  };
  socket.onerror = () => {};
  socket.onclose = event => {
    if (generation !== state.generation) return;
    online(false);
    if (event.code === 4401) return toast('登录已过期，请重新登录');
    reconnectTimer = setTimeout(syncSocket, 2500);
  };
}
async function flushOutbox() {
  if (flushRunning || !state.session) return;
  const generation = state.generation;
  flushRunning = true;
  try {
    for (const item of [...state.pending]) {
      if (generation !== state.generation) return;
      if (item.conflict) continue;
      try {
        const saved = await api(item.taskId ? '/api/tasks/' + item.taskId : '/api/tasks', item.taskId ? 'PUT' : 'POST', item.body);
        if (generation !== state.generation) return;
        state.pending = state.pending.filter(x => x !== item);
        if (state.taskId === item.localId) state.taskId = saved.id;
        cacheSoon();
      } catch (error) {
        if (error.status === 409) { item.conflict = true; toast('有任务在其他设备被修改，本机草稿已保留，请进入任务处理冲突'); }
        else if (error.status) { item.error = error.message; toast('待同步任务未能保存：' + error.message); }
        else { online(false); break; }
      }
    }
    await refresh();
  } finally { flushRunning = false; cacheSoon(); }
}
async function enter(session) {
  state.generation++; state.session = session;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(session.server.replace(/\/$/, '') + '|' + session.user_id));
  state.profile = [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 24);
  const saved = await storeGet('cache-' + state.profile);
  state.pending = saved?.pending || []; state.snapshot = saved?.snapshot || { tasks: [], messages: [], cursor: 0 };
  state.sources = await storeGet('sources-' + state.profile) || { python_path: '', qq_http_url: 'http://127.0.0.1:3000', qq_ws_url: 'ws://127.0.0.1:3001', qq_token: '', qq_chats: [], wechat_chats: [], conversations: [] };
  $('#auth').hidden = true; $('#workspace').hidden = false;
  $('#account-name').textContent = session.username; $('#avatar').textContent = session.username.slice(0, 1).toUpperCase();
  $('#account-server').textContent = new URL(session.server).host;
  state.page = 'inbox'; render(); await refresh(); syncSocket();
  window.experience?.onSession();
}
function updateCounts() {
  $('#inbox-count').textContent = state.snapshot.messages.filter(m => m.triage !== 'ignored' && (!m.analysis || m.analysis.classification === 'actionable')).length || '';
  $('#task-count').textContent = state.snapshot.tasks.filter(t => ['collecting', 'ready'].includes(t.status)).length || '';
}
function heading(title, subtitle, actions = '') { return `<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div><div class="actions">${actions}</div></div>`; }
function empty(title, subtitle, action = '') { return `<div class="empty">${icon('inbox')}<strong>${title}</strong><div>${subtitle}</div>${action}</div>`; }
function tag(label, color = '') { return `<span class="tag ${color}">${esc(label)}</span>`; }
function sourceTag(source) { return tag({ qq: 'QQ', wechat: '微信', manual: '手动' }[source] || source, source === 'qq' ? 'blue' : source === 'wechat' ? 'green' : ''); }
function messageClass(message) { return message.triage === 'ignored' ? ['已忽略', ''] : classifications[message.analysis?.classification || 'unprocessed']; }
function filteredMessages() {
  return state.snapshot.messages.filter(m => {
    const classification = m.analysis?.classification || 'unprocessed';
    return (state.source === 'all' || m.source === state.source) &&
      (state.category === 'ignored' ? m.triage === 'ignored' : m.triage !== 'ignored' && (state.category === 'all' || classification === state.category)) &&
      (!state.search || `${m.text} ${m.conversation_name} ${m.sender_name}`.toLowerCase().includes(state.search.toLowerCase()));
  });
}
function inboxView() {
  const messages = filteredMessages();
  const selected = state.snapshot.messages.find(m => m.id === state.selected);
  return heading('消息收件箱', '从聊天中找到重要通知，让每件事都有着落。', `<button class="secondary" data-action="paste">粘贴通知</button><button class="primary" data-action="new-task">${icon('plus')}新建任务</button>`) +
    `<div class="toolbar"><div class="search"><span>${icon('search')}</span><input id="inbox-search" placeholder="搜索通知、群聊或联系人" value="${esc(state.search)}" aria-label="搜索消息"></div><select id="source-filter" aria-label="来源"><option value="all">全部来源</option><option value="qq">QQ</option><option value="wechat">微信</option><option value="manual">手动添加</option></select><select id="category-filter" aria-label="分类"><option value="all">全部分类</option><option value="actionable">交件通知</option><option value="unprocessed">待分析</option><option value="chatting">普通聊天</option><option value="irrelevant">其他信息</option><option value="ignored">已忽略</option></select><span class="result-count">${messages.length} 条消息</span></div>` +
    `<div class="inbox-grid ${selected ? 'has-selection' : ''}"><section class="panel messages-panel"><div class="panel-head"><h3>最近通知</h3><small>${state.contexts.size ? '已选 ' + state.contexts.size + ' 条上下文' : '勾选消息可作为上下文'}</small></div><div class="message-list">${messages.length ? messages.map(m => `<article class="message-row ${state.selected === m.id ? 'selected' : ''}" data-message="${esc(m.id)}" tabindex="0" role="button" aria-label="查看 ${esc(m.conversation_name)} 的消息"><input class="select-context" type="checkbox" data-context="${esc(m.id)}" ${state.contexts.has(m.id) ? 'checked' : ''} aria-label="选择为上下文"><div class="message-body"><div class="message-meta">${sourceTag(m.source)}<strong>${esc(m.conversation_name || '手动通知')}</strong><time>${formatDate(m.sent_at)}</time></div><div class="message-excerpt">${esc(m.text)}</div><div class="message-bottom">${tag(...messageClass(m))}${m.analysis ? `<span class="helper">${Math.round(m.analysis.confidence * 100)}%</span>` : ''}<span class="sender">${esc(m.sender_name || '我')}</span></div></div></article>`).join('') : empty('收件箱清清爽爽', state.search ? '换个关键词或筛选条件试试。' : '连接 QQ / 微信，或先粘贴一条通知。', '<button class="primary" data-action="paste">添加第一条通知</button>')}</div><div class="load-more"><button class="plain-button" data-action="more-messages">加载更早的消息</button></div></section><section class="panel detail">${selected ? messageDetail(selected) : empty('先选一条消息', '通知原文、上下文和分析结果会显示在这里。')}</section></div>`;
}
function messageDetail(m) {
  const result = m.analysis;
  const related = state.snapshot.messages.filter(x => x.id !== m.id && x.source === m.source && x.account_id === m.account_id && x.conversation_id === m.conversation_id && new Date(x.sent_at) <= new Date(m.sent_at)).slice(0, 12).reverse();
  const busy = state.busyAnalysis.has(m.id);
  const title = result?.title || (m.text.split('\n')[0] || '消息详情').slice(0, 90);
  return `<div class="panel-head"><h3>通知详情</h3><span class="helper">原文保留</span></div><div class="detail-content"><button class="link mobile-back" data-action="back-inbox">← 返回消息列表</button><div class="detail-meta">${sourceTag(m.source)}<span class="helper">${formatDate(m.sent_at)}</span></div><h2 class="detail-title">${esc(title)}</h2><div class="detail-byline">${esc(m.conversation_name)} · ${esc(m.sender_name || '我')}</div><div class="message-original">${esc(m.text)}${m.metadata?.quote ? '\n\n引用 ' + esc(m.metadata.quote.sender) + '：\n' + esc(m.metadata.quote.text) : ''}</div><div class="analysis-box"><div class="analysis-top"><h3>通知分析</h3>${result ? `<small>${esc(result.model)}</small>` : tag('待分析', 'orange')}</div>${result ? `<div class="pill-row">${tag(...classifications[result.classification])}<span class="helper">可信度 ${Math.round(result.confidence * 100)}%</span></div><p>${esc(result.summary)}</p>${result.due_at ? `<p>截止：${formatDate(result.due_at)}</p>` : ''}${result.requirements.length ? `<p>材料：${result.requirements.map(r => esc(r.label)).join('、')}</p>` : ''}<div class="analysis-reason">${esc(result.reason)}${result.notes?.length ? '<br>' + result.notes.map(esc).join('<br>') : ''}<br>本次使用 ${result.context_ids.length} 条上下文</div>` : `<p>使用你在设置里配置的 LLM，区分通知与闲聊，并提取可确认的任务草稿。</p>`}</div><div class="context-options"><span>自动上下文</span><input id="context-count" type="number" min="0" max="50" value="${state.contextCount ?? 12}" aria-label="上下文条数"><span>条</span>${state.contexts.size ? `<button class="link" data-action="clear-context">清除已选 ${state.contexts.size} 条</button>` : ''}</div><p class="helper">${state.contexts.size ? `分析时将发送当前消息与手动勾选的 ${state.contexts.size} 条上下文。` : '分析时将发送当前消息与同一会话的最近消息。'}</p><div class="detail-actions"><button class="primary" data-action="analyze" ${busy ? 'disabled' : ''}>${busy ? '正在分析…' : result ? '重新分析' : '使用 LLM 分析'}</button><button class="secondary" data-action="message-task">生成任务草稿</button><button class="plain-button" data-action="ignore-message">${m.triage === 'ignored' ? '恢复消息' : '忽略这条'}</button></div>${related.length ? `<details class="context-list"><summary>查看同会话的最近上下文（${related.length}）</summary>${related.map(x => `<div class="context-message"><small>${esc(x.sender_name)} · ${formatDate(x.sent_at)}</small><p>${esc(x.text)}</p></div>`).join('')}</details>` : ''}</div>`;
}
function tasksView() {
  if (state.taskId) {
    const task = state.snapshot.tasks.find(t => t.id === state.taskId);
    if (task) return taskDetail(task);
    state.taskId = null;
  }
  const all = state.snapshot.tasks;
  const list = all.filter(t => (state.taskFilter === 'all' || state.taskFilter === 'active' ? state.taskFilter === 'all' || ['collecting', 'ready'].includes(t.status) : t.status === state.taskFilter) && (!state.search || (t.title + t.description).toLowerCase().includes(state.search.toLowerCase())));
  return heading('交件任务', '要求、材料与提交回执，一处整理。', `<button class="primary" data-action="new-task">${icon('plus')}新建任务</button>`) +
    `<div class="task-summary"><div class="summary-cell"><strong>${all.filter(t => t.status === 'collecting').length}</strong><span>准备材料</span></div><div class="summary-cell"><strong>${all.filter(t => t.status === 'ready').length}</strong><span>待提交</span></div><div class="summary-cell"><strong>${all.filter(t => t.status === 'submitted').length}</strong><span>已提交</span></div></div><div class="toolbar"><div class="search"><span>${icon('search')}</span><input id="task-search" placeholder="搜索任务" value="${esc(state.search)}" aria-label="搜索任务"></div><select id="task-filter" aria-label="任务进度"><option value="active">进行中</option><option value="all">全部任务</option><option value="collecting">准备材料</option><option value="ready">待提交</option><option value="submitted">已提交</option><option value="archived">已归档</option></select></div><div class="task-grid">${list.map(t => `<article class="task-card" tabindex="0" role="button" data-task="${esc(t.id)}"><div class="pill-row">${tag(...states[t.status])}${t.pending ? tag(t.conflict ? '同步冲突' : '待同步', 'orange') : ''}</div><h3>${esc(t.title)}</h3><p>${esc(t.description || '暂无补充说明')}</p><div class="task-card-footer"><span class="${t.due_at && new Date(t.due_at) < new Date() && !['submitted', 'archived'].includes(t.status) ? 'overdue' : ''}">${t.due_at ? formatDate(t.due_at) + ' 截止' : '未设置截止时间'}</span><span>${t.attachments.filter(f => f.kind === 'material').length} 份材料</span></div></article>`).join('')}</div>${list.length ? '' : `<div class="panel">${empty('把下一次交件安排好', '从通知生成任务，或直接创建一项。', '<button class="primary" data-action="new-task">创建任务</button>')}</div>`}`;
}
function fileRow(f, task) { return `<div class="file-row"><span class="file-icon">${esc(f.name.split('.').pop().slice(0, 5))}</span><span class="file-info"><strong>${esc(f.name)}</strong><small>${bytes(f.size)}</small></span><button class="icon-button" data-rename-file="${esc(f.id)}" data-name="${esc(f.name)}" data-version="${task.version}" title="重命名" aria-label="重命名 ${esc(f.name)}">✎</button><button class="icon-button" data-download="${esc(f.id)}" data-name="${esc(f.name)}" title="下载" aria-label="下载 ${esc(f.name)}">↓</button><button class="icon-button" data-delete-file="${esc(f.id)}" data-version="${task.version}" title="移除" aria-label="移除 ${esc(f.name)}">×</button></div>`; }
function taskDetail(t) {
  const origin = state.snapshot.messages.find(m => m.id === t.source_message_id);
  return `<button class="link task-detail-back" data-action="back-tasks">← 返回任务列表</button>` + heading(esc(t.title), t.pending ? t.conflict ? '其他设备已修改此任务。本机草稿仍保留，重新编辑后确认合并。' : '本机修改等待同步。' : '材料准备好以后，再从提交入口完成交件。', `<button class="secondary" data-action="edit-task">编辑任务</button><button class="primary" data-action="package" ${t.pending ? 'disabled' : ''}>下载材料包</button>`) +
    `<div class="task-detail-grid"><section class="panel"><div class="panel-head"><h3>交件内容</h3>${tag(...states[t.status])}</div><div class="task-main-content"><div class="task-description">${esc(t.description || '暂无说明')}</div>${t.conflict ? '<button class="secondary" data-action="discard-conflict">放弃本机草稿，使用云端版本</button>' : ''}<div class="section-heading"><h3>交件材料</h3><small class="helper">${t.attachments.filter(f => f.kind === 'material').length} 个文件</small></div>${t.attachments.filter(f => f.kind === 'material').map(f => fileRow(f, t)).join('')}<label class="drop-zone">点击或拖入文件添加材料<input id="material-upload" type="file" multiple ${t.pending ? 'disabled' : ''} aria-label="上传交件材料"></label><div class="section-heading"><h3>提交回执</h3><small class="helper">成功截图、确认邮件或回执文件</small></div>${t.attachments.filter(f => f.kind === 'receipt').map(f => fileRow(f, t)).join('')}<label class="drop-zone">添加提交凭证<input id="receipt-upload" type="file" multiple ${t.pending ? 'disabled' : ''} aria-label="上传提交回执"></label>${origin ? `<details class="task-origin"><summary class="helper">查看原始通知 · ${esc(origin.conversation_name)}</summary><p>${esc(origin.text)}</p></details>` : ''}<div class="section-heading"><h3>任务管理</h3></div><div class="small-actions"><button class="secondary" data-action="mark-submitted" ${t.status === 'submitted' || t.pending ? 'disabled' : ''}>标记已提交</button><button class="plain-button" data-action="archive-task" ${t.pending ? 'disabled' : ''}>归档任务</button></div></div></section><aside><section class="panel task-side"><div class="info-label">截止时间</div><div class="info-value">${formatDate(t.due_at)}</div><div class="info-label">文件命名</div><div class="info-value">${esc(t.naming_hint || t.filename_pattern || '未设置命名要求')}</div><div class="info-label">提交入口</div><div class="info-value">${t.submit_url ? `<button class="link" data-external="${esc(t.submit_url)}">打开提交页面 ↗</button>` : '未填写'}</div><div class="section-heading"><h3>材料核对</h3><button class="link" data-action="check-task">重新核对</button></div><div id="task-check">${t.requirements.length ? t.requirements.map(r => `<div class="check-row"><span class="check-symbol manual">○</span><div><strong>${esc(r.label)}</strong><small>${esc(r.extensions.join(' / ') || '任意格式')} · 至少 ${r.min_count} 份</small></div></div>`).join('') : '<p class="helper">未设置材料清单，可在编辑任务中添加。</p>'}</div></section></aside></div>`;
}
function settingsView() {
  return heading('设置', '使用自己的模型接口，决定怎样整理通知。') + `<div class="settings-grid"><form id="llm-form" class="panel settings-panel"><h3>LLM 连接</h3><p class="helper">支持兼容 Chat Completions 的接口。配置按账号保存，电脑和手机共用。</p><label>API 地址<input id="llm-url" type="url" placeholder="https://api.example.com/v1" required></label><label>API Key<input id="llm-key" type="password" autocomplete="new-password" placeholder="留空保留已保存的 Key"><span id="llm-key-note" class="helper"></span></label><div class="form-grid"><label>模型<input id="llm-model" list="model-options" required placeholder="填写模型名称"><datalist id="model-options"></datalist></label><label>默认上下文条数<input id="llm-context" type="number" min="0" max="50" value="12" required></label></div><label class="switch-line"><input id="llm-auto" type="checkbox"><span><strong>自动分析新消息</strong><small>仅处理桌面端所选会话同步的新消息。关闭后，可在收件箱手动分析。</small></span></label><div class="form-grid"><label>只自动分析含这些词的消息<input id="llm-include" placeholder="提交,报名,截止（留空处理全部）"></label><label>跳过含这些词的消息<input id="llm-exclude" placeholder="签到成功,红包（英文逗号分隔）"></label></div><label>分类偏好<textarea id="llm-instruction" rows="3" placeholder="例如：重点关注课程作业与比赛报名，日常约饭视为普通聊天。"></textarea></label><div class="detail-actions"><button type="submit" class="primary">保存设置</button><button type="button" class="secondary" data-action="test-llm">保存并读取模型</button><button type="button" class="plain-button" data-action="clear-llm-key">清除 Key</button></div><div id="llm-status" class="settings-status" role="status"></div><div id="models-output" class="models-output" hidden></div></form><aside class="settings-side"><h3>分析如何进行</h3><ol><li>采集端同步你选择的联系人和群聊。</li><li>模型结合上下文，区分交件通知、普通聊天和其他信息。</li><li>你可以查看理由、调整上下文，再确认任务草稿。</li></ol><div class="divider"></div><p>只有目标消息和所选上下文会发送给你配置的模型服务。</p><p>API Key 加密保存在服务端。留空保存会沿用已有 Key。</p></aside></div>`;
}
function conversations(type) {
  const list = (state.sources.conversations || []).filter(c => c.source === type);
  const selected = state.sources[type + '_chats'] || [];
  return list.length ? `<div class="conversation-list">${list.map(c => `<label class="conversation-row"><input type="checkbox" data-subscribe="${type}" value="${esc(c.id)}" ${selected.includes(c.id) ? 'checked' : ''}><span><strong>${esc(c.name)}</strong><small>${esc(c.id)}</small></span></label>`).join('')}</div>` : '<p class="helper">读取会话列表后，勾选需要同步的联系人和群。</p>';
}
function sourcesView() {
  if (!window.desktop) return heading('消息来源', '桌面负责采集，所有设备实时查看。') + `<div class="panel">${empty('在电脑上连接消息来源', '使用 Electron 桌面版连接 SnowLuma 或微信。<br>这里可以继续查看同步的通知、分析并管理交件任务。')}</div>`;
  const c = state.sources;
  return heading('消息来源', '选择需要关注的会话，把通知带进工作台。') + `<div class="source-grid"><section class="panel source-card"><div class="source-title"><span class="source-mark qq">QQ</span><div><h3>QQ · SnowLuma</h3><small>OneBot v11 · Windows / macOS / Linux</small></div></div><label>HTTP 地址<input id="qq-http" type="url" value="${esc(c.qq_http_url)}"></label><label>WebSocket 地址<input id="qq-ws" type="url" value="${esc(c.qq_ws_url)}"></label><label>Access Token<input id="qq-token" type="password" value="${esc(c.qq_token || '')}" autocomplete="new-password"></label><button class="secondary" data-action="list-qq">读取 QQ 联系人和群</button><div id="qq-conversations">${conversations('qq')}</div></section><section class="panel source-card"><div class="source-title"><span class="source-mark">微</span><div><h3>微信 · 本地数据库</h3><small>Windows · 复用 wechatauto-replica</small></div></div><label>微信账号目录名<input id="wechat-account" value="${esc(c.wechat_account || '')}" placeholder="留空自动识别，读取后固定到该账号"></label><label>微信数据库根目录<input id="wechat-db-dir" value="${esc(c.wechat_db_dir || '')}" placeholder="留空自动检测"></label><p class="helper">微信保持登录即可。采用数据库读取，同步文字、引用和文件卡片信息。</p><button class="secondary" data-action="list-wechat">读取微信最近会话</button><div id="wechat-conversations">${conversations('wechat')}</div></section></div><section class="panel source-global"><div class="form-grid"><label>Python 解释器<input id="python-path" value="${esc(c.python_path || '')}" placeholder="python 或完整的 python.exe 路径"></label><label>仅采集含关键词的消息<input id="capture-keywords" value="${esc(c.capture_keywords || '')}" placeholder="英文逗号分隔，留空同步所选会话全部消息"></label></div><p class="helper">解释器需安装项目依赖。微信接入还需你现有的 wechatauto-replica；QQ 需先运行 SnowLuma。微信首次选择会话从当前时刻开始，后续重启会补读积压消息。</p><div class="source-actions"><button class="primary" data-action="start-collector">保存并启动采集</button><button class="secondary" data-action="stop-collector">停止采集</button><button class="plain-button" data-action="save-sources">仅保存</button></div><div id="collector-status" class="collector-status" role="status">尚未启动采集</div></section>`;
}
function render() {
  const active = document.activeElement;
  const focus = active?.id;
  const selection = active?.selectionStart;
  const titles = { inbox: '消息收件箱', tasks: '交件任务', sources: '消息来源', settings: '设置' };
  $('#breadcrumb').textContent = titles[state.page];
  $$('[data-nav]').forEach(button => button.classList.toggle('active', button.dataset.nav === state.page));
  $('#view').innerHTML = state.page === 'sources' && window.experience ? experience.sourcesView() : ({ inbox: inboxView, tasks: tasksView, sources: sourcesView, settings: settingsView })[state.page]();
  hydrateIcons(); updateCounts();
  window.appearance?.refresh(); window.experience?.decorate(state.page);
  if ($('#source-filter')) $('#source-filter').value = state.source;
  if ($('#category-filter')) $('#category-filter').value = state.category;
  if ($('#task-filter')) $('#task-filter').value = state.taskFilter;
  if (focus && document.getElementById(focus)) {
    document.getElementById(focus).focus();
    if (selection != null && ['text', 'search'].includes(document.getElementById(focus).type)) document.getElementById(focus).setSelectionRange(selection, selection);
  }
  if (state.page === 'tasks' && state.taskId && !state.taskId.startsWith('local:')) checkTask().catch(() => {});
  if (state.page === 'sources' && window.desktop) desktop.collectorState().then(showCollectorState);
}
async function navigate(page) {
  state.page = page; state.search = ''; state.taskId = null; render();
  if (page === 'settings') await loadLlm();
  if(page === 'sources')window.experience?.detect(false);
}
function requirementRow(req = {}) {
  const row = document.createElement('div'); row.className = 'requirement-row';
  row.innerHTML = `<input class="req-label" aria-label="材料名称" placeholder="材料名称" maxlength="100" value="${esc(req.label || '')}" required><input class="req-extensions" aria-label="允许格式" placeholder="pdf,docx" value="${esc((req.extensions || []).join(','))}"><input class="req-count" aria-label="最少数量" type="number" min="1" max="50" value="${req.min_count || 1}" required><button type="button" class="icon-button remove-requirement" aria-label="移除要求">×</button>`;
  $('#requirements-editor').append(row);
}
function dateInput(value) { if (!value) return ''; const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
async function openTask(task = {}, source) {
  $('#task-form').reset(); $('#requirements-editor').innerHTML = ''; $('#task-error').textContent = '';
  let version = task.version || 0;
  if (task.conflict && task.id && !task.id.startsWith('local:')) { const latest = await api('/api/tasks/' + task.id); version = latest.version; }
  editingVersion = version;
  $('#edit-task-id').value = task.id || ''; $('#task-source-id').value = source || task.source_message_id || '';
  $('#task-dialog-title').textContent = task.id ? task.conflict ? '确认本机修改并合并' : '编辑任务' : '创建任务';
  $('#task-title').value = task.title || ''; $('#task-description').value = task.description || '';
  $('#task-due').value = dateInput(task.due_at); $('#task-status').value = task.status || 'collecting';
  $('#task-max-size').value = task.max_total_bytes ? task.max_total_bytes / 1024 ** 2 : '';
  $('#task-naming').value = task.naming_hint || ''; $('#task-pattern').value = task.filename_pattern || ''; $('#task-url').value = task.submit_url || '';
  $('#task-notes').textContent = (task.notes || []).join(' ');
  (task.requirements || []).forEach(requirementRow);
  $('#task-dialog').showModal(); $('#task-title').focus();
}
async function saveTask(event) {
  event.preventDefault();
  const id = $('#edit-task-id').value;
  const body = { title: $('#task-title').value.trim(), description: $('#task-description').value,
    due_at: $('#task-due').value ? new Date($('#task-due').value).toISOString() : null, status: $('#task-status').value,
    requirements: $$('#requirements-editor .requirement-row').map(row => ({ label: row.querySelector('.req-label').value.trim(), extensions: row.querySelector('.req-extensions').value.split(/[,，]/).map(x => x.trim().replace(/^\./, '')).filter(Boolean), min_count: Number(row.querySelector('.req-count').value) })),
    max_total_bytes: $('#task-max-size').value ? Math.round(Number($('#task-max-size').value) * 1024 ** 2) : null,
    naming_hint: $('#task-naming').value, filename_pattern: $('#task-pattern').value, submit_url: $('#task-url').value,
    source_message_id: $('#task-source-id').value || null, version: editingVersion,
  };
  const existingPending = state.pending.find(x => (x.taskId || x.localId) === id);
  if (!id || id.startsWith('local:')) body.client_id = existingPending?.body.client_id || crypto.randomUUID();
  $('#task-save').disabled = true; $('#task-error').textContent = '';
  try {
    const saved = await api(id && !id.startsWith('local:') ? '/api/tasks/' + id : '/api/tasks', id && !id.startsWith('local:') ? 'PUT' : 'POST', body);
    state.pending = state.pending.filter(x => x !== existingPending);
    state.snapshot.tasks = state.snapshot.tasks.filter(x => x.id !== id && x.id !== saved.id); state.snapshot.tasks.unshift(saved);
    $('#task-dialog').close(); state.page = 'tasks'; state.taskId = saved.id; cacheSoon(); render(); refresh(); toast('任务已保存');
  } catch (error) {
    if (!error.status && (error instanceof TypeError || error.name === 'TimeoutError')) {
      const localId = id || 'local:' + crypto.randomUUID();
      state.pending = state.pending.filter(x => x !== existingPending);
      state.pending.push({ taskId: id && !id.startsWith('local:') ? id : null, localId, body });
      state.snapshot = applyPending(state.snapshot);
      try { await storeSet('cache-' + state.profile, { snapshot: state.snapshot, pending: state.pending }); }
      catch { $('#task-error').textContent = '本机存储失败，请保留此窗口并检查磁盘空间'; return; }
      $('#task-dialog').close(); state.page = 'tasks'; state.taskId = localId; online(false); cacheSoon(); render(); toast('已保存在本机，恢复连接后自动同步');
    } else $('#task-error').textContent = error.message;
  } finally { $('#task-save').disabled = false; }
}
async function checkTask() {
  const taskId = state.taskId;
  const result = await api('/api/tasks/' + taskId + '/check');
  if (state.taskId !== taskId || !$('#task-check')) return;
  $('#task-check').innerHTML = result.results.map(r => `<div class="check-row"><span class="check-symbol ${r.ok === false ? 'fail' : r.ok === null ? 'manual' : ''}">${r.ok === true ? '✓' : r.ok === false ? '×' : '○'}</span><div><strong>${esc(r.label)}</strong><small>${esc(r.detail)}</small></div></div>`).join('') + `<p class="helper">${result.ready ? '材料检查通过，提交前请再核对内容。' : result.material_count ? '请处理缺失项或人工核对项。' : '添加材料后，会自动核对清单。'}</p>`;
}
async function uploadFiles(input, kind) {
  const files = [...input.files]; input.value = '';
  if (!files.length) return;
  const taskId = state.taskId;
  let task = state.snapshot.tasks.find(t => t.id === taskId);
  uploading = true;
  try { for (const file of files) {
    toast('正在上传 ' + file.name);
    const form = new FormData(); form.append('file', file);
    task = await api(`/api/tasks/${taskId}/files?version=${task.version}&kind=${kind}`, 'POST', form);
    const index = state.snapshot.tasks.findIndex(t => t.id === taskId); if (index >= 0) state.snapshot.tasks[index] = task;
  } } finally { uploading = false; }
  cacheSoon(); render(); toast('文件已添加');
}
async function saveDownload(route, name) {
  if (window.desktop) { const saved=await desktop.download(route,name); if(saved)toast('文件已保存'); return; }
  const response = await fetch(apiUrl(route), { headers: { Authorization: 'Bearer ' + state.session.token } });
  if (!response.ok) throw new Error('下载失败，请刷新后重试');
  const blob = await response.blob();
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function loadLlm() {
  const form = $('#llm-form');
  form?.querySelectorAll('input,textarea,button').forEach(input => { input.disabled = true; });
  if ($('#llm-status')) $('#llm-status').textContent = '正在读取设置…';
  try {
    llmSettings = await api('/api/settings/llm');
    if (!$('#llm-form')) return;
    $('#llm-url').value = llmSettings.base_url; $('#llm-model').value = llmSettings.model;
    $('#llm-context').value = llmSettings.context_count; $('#llm-auto').checked = llmSettings.auto_analyze;
    $('#llm-include').value = llmSettings.include_keywords; $('#llm-exclude').value = llmSettings.exclude_keywords;
    $('#llm-instruction').value = llmSettings.instruction;
    $('#llm-key-note').textContent = llmSettings.has_key ? '已保存 Key，留空即可沿用。' : '尚未保存 Key，本地免鉴权模型可留空。';
    $('#llm-status').textContent = '';
  } catch (error) { toast(error.message); }
  finally { if (form?.isConnected) form.querySelectorAll('input,textarea,button').forEach(input => { input.disabled = false; }); }
}
async function saveLlm() {
  if (!$('#llm-form').reportValidity()) throw new Error('请补全 API 地址与模型');
  const key = $('#llm-key').value;
  const body = { base_url: $('#llm-url').value.trim(), model: $('#llm-model').value.trim(), context_count: Number($('#llm-context').value), auto_analyze: $('#llm-auto').checked, include_keywords: $('#llm-include').value.replaceAll('，', ','), exclude_keywords: $('#llm-exclude').value.replaceAll('，', ','), instruction: $('#llm-instruction').value };
  if (key) body.api_key = key;
  llmSettings = await api('/api/settings/llm', 'PUT', body); $('#llm-key').value = '';
  $('#llm-status').textContent = '设置已保存，其他设备将共用此配置。';
  $('#llm-key-note').textContent = llmSettings.has_key ? '已保存 Key，留空即可沿用。' : '当前未保存 Key。';
}
function readSourcesForm() {
  const c = state.sources;
  if ($('#qq-http')) {
    c.qq_http_url = $('#qq-http').value.trim(); c.qq_ws_url = $('#qq-ws').value.trim(); c.qq_token = $('#qq-token').value;
    c.wechat_account = $('#wechat-account').value.trim(); c.wechat_db_dir = $('#wechat-db-dir').value.trim();
    c.python_path = $('#python-path').value.trim(); c.capture_keywords = $('#capture-keywords').value.replaceAll('，', ',');
    for (const type of ['qq', 'wechat']) c[type + '_chats'] = $$(`[data-subscribe="${type}"]:checked`).map(x => x.value);
  }
  return c;
}
function showCollectorState(value) {
  const el = $('#collector-status');
  const problems = Object.values(value.sources || {}).filter(x => ['error','unauthorized','offline','reconnecting','warning'].includes(x.state));
  if (el) el.textContent = problems.length ? problems.map(x => x.message).join('；') : value.source === 'queue' ? `采集运行中 · ${value.count} 条消息等待上传` : value.message || ({ starting: '正在连接…', connected: '已连接，正在同步所选会话的新消息', stopped: '采集已停止' }[value.state] || value.state);
}
async function runAction(action, button) {
  const task = state.snapshot.tasks.find(t => t.id === state.taskId);
  const message = state.snapshot.messages.find(m => m.id === state.selected);
  switch (action) {
    case 'new-task': return openTask();
    case 'edit-task': return openTask(task);
    case 'close-task': return $('#task-dialog').close();
    case 'add-requirement': return requirementRow();
    case 'paste': $('#paste-content').value = ''; return $('#paste-dialog').showModal();
    case 'close-paste': return $('#paste-dialog').close();
    case 'close-rename': return $('#rename-dialog').close();
    case 'back-inbox': state.selected = null; return render();
    case 'back-tasks': state.taskId = null; return render();
    case 'clear-context': state.contexts.clear(); return render();
    case 'message-task': {
      const draft = message.analysis || message.draft;
      return openTask({ ...draft, description: message.text, title: draft.title || message.draft.title }, message.id);
    }
    case 'analyze': {
      if (state.busyAnalysis.has(message.id)) return;
      const body = { message_id: message.id, context_count: Number($('#context-count').value) };
      if (state.contexts.size) body.context_ids = [...state.contexts].filter(id => id !== message.id);
      state.busyAnalysis.add(message.id); render();
      try { const result = await api('/api/analyze', 'POST', body); message.analysis = result; cacheSoon(); toast('分析完成，确认后可生成任务'); }
      finally { state.busyAnalysis.delete(message.id); if (state.page === 'inbox') render(); }
      return;
    }
    case 'ignore-message': await api('/api/messages/' + message.id + '/triage', 'PUT', { state: message.triage === 'ignored' ? 'unread' : 'ignored' }); await refresh(); return;
    case 'more-messages': {
      const oldest = state.snapshot.messages.at(-1); const rows = await api('/api/messages?limit=100' + (oldest ? '&before=' + oldest.id : ''));
      const ids = new Set(state.snapshot.messages.map(m => m.id)); state.snapshot.messages.push(...rows.filter(m => !ids.has(m.id))); cacheSoon(); render(); if (!rows.length) toast('没有更早的消息了'); return;
    }
    case 'check-task': return checkTask();
    case 'package': return saveDownload('/api/tasks/' + task.id + '/package', task.title.replace(/[<>:"/\\|?*]/g, '_') + '.zip');
    case 'mark-submitted': case 'archive-task': {
      await api('/api/tasks/' + task.id, 'PUT', { ...task, status: action === 'mark-submitted' ? 'submitted' : 'archived' }); await refresh(); toast(action === 'mark-submitted' ? '已标记提交' : '任务已归档'); return;
    }
    case 'discard-conflict': state.pending = state.pending.filter(x => (x.taskId || x.localId) !== task.id); cacheSoon(); await refresh(); return;
    case 'test-llm': {
      await saveLlm(); $('#llm-status').textContent = '正在读取模型列表…';
      const result = await api('/api/settings/llm/test', 'POST');
      $('#model-options').innerHTML = result.models.map(model => `<option value="${esc(model)}"></option>`).join('');
      $('#models-output').hidden = false; $('#models-output').textContent = result.models.length ? result.models.join(' · ') : '接口连通，未返回模型列表，可手动填写模型名。'; $('#llm-status').textContent = '连接成功'; return;
    }
    case 'clear-llm-key': {
      if (!confirm('清除服务端保存的 API Key？')) return;
      await api('/api/settings/llm', 'PUT', { ...llmSettings, api_key: '' }); $('#llm-key').value = ''; await loadLlm(); return toast('Key 已清除');
    }
    case 'list-qq': case 'list-wechat': {
      const type = action.slice(5); const c = readSourcesForm(); button.disabled = true;
      try {
        const result = await desktop.listConversations(type, c);
        c.conversations = [...(c.conversations || []).filter(x => x.source !== type), ...result.conversations];
        if (type === 'wechat') c.wechat_account = result.account; else c.qq_account = result.account;
        await storeSet('sources-' + state.profile, c); render(); toast(`已读取 ${result.conversations.length} 个会话，请勾选需要同步的会话`);
      } finally { if (button.isConnected) button.disabled = false; }
      return;
    }
    case 'save-sources': await storeSet('sources-' + state.profile, readSourcesForm()); return toast('本机采集设置已保存');
    case 'start-collector': {
      const c = readSourcesForm();
      if (!(c.qq_chats.length || c.wechat_chats.length)) throw new Error('请先勾选至少一个要同步的会话');
      await storeSet('sources-' + state.profile, c);
      return desktop.startCollector({ ...c, server_url: state.session.server, server_token: state.session.token, user_id: state.session.user_id, conversation_names: Object.fromEntries((c.conversations || []).map(x => [x.id, x.name])) });
    }
    case 'stop-collector': return desktop.stopCollector();
  }
}

document.addEventListener('click', async event => {
  try {
    const nav = event.target.closest('[data-nav]'); if (nav) return await navigate(nav.dataset.nav);
    const context = event.target.closest('[data-context]'); if (context) return;
    const row = event.target.closest('[data-message]'); if (row) { state.selected = row.dataset.message; return render(); }
    const card = event.target.closest('[data-task]'); if (card) { state.taskId = card.dataset.task; return render(); }
    const action = event.target.closest('[data-action]'); if (action) return await runAction(action.dataset.action, action);
    const remove = event.target.closest('.remove-requirement'); if (remove) return remove.parentElement.remove();
    const file = event.target.closest('[data-download]'); if (file) return await saveDownload('/api/files/' + file.dataset.download, file.dataset.name);
    const renamed = event.target.closest('[data-rename-file]'); if (renamed) {
      $('#rename-form').dataset.fileId = renamed.dataset.renameFile; $('#rename-form').dataset.version = renamed.dataset.version;
      $('#rename-form').dataset.taskId = state.taskId; $('#rename-name').value = renamed.dataset.name; $('#rename-error').textContent = ''; $('#rename-dialog').showModal(); $('#rename-name').focus();
      return;
    }
    const deleted = event.target.closest('[data-delete-file]'); if (deleted && confirm('从此任务移除这个文件？')) { await api(`/api/tasks/${state.taskId}/files/${deleted.dataset.deleteFile}?version=${deleted.dataset.version}`, 'DELETE'); return await refresh(); }
    const external = event.target.closest('[data-external]'); if (external) {
      const url = new URL(external.dataset.external); if (!['http:', 'https:'].includes(url.protocol)) return;
      if (window.desktop) await desktop.external(url.href); else window.open(url.href, '_blank', 'noopener,noreferrer');
    }
  } catch (error) { toast(error.message || '操作失败，请重试'); }
});
document.addEventListener('keydown', event => {
  if (event.target.matches('[data-message],[data-task]') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); event.target.click(); }
});
document.addEventListener('input', event => {
  if (['inbox-search', 'task-search'].includes(event.target.id)) { state.search = event.target.value; render(); }
  if (event.target.id === 'context-count') state.contextCount = Number(event.target.value);
});
document.addEventListener('change', async event => {
  try {
    if (event.target.id === 'source-filter') { state.source = event.target.value; render(); }
    if (event.target.id === 'category-filter') { state.category = event.target.value; render(); }
    if (event.target.id === 'task-filter') { state.taskFilter = event.target.value; render(); }
    if (event.target.dataset.context) { if (event.target.checked) state.contexts.add(event.target.dataset.context); else state.contexts.delete(event.target.dataset.context); render(); }
    if (event.target.id === 'material-upload') await uploadFiles(event.target, 'material');
    if (event.target.id === 'receipt-upload') await uploadFiles(event.target, 'receipt');
  } catch (error) { toast(error.message); }
});
$('#task-form').addEventListener('submit', saveTask);
$('#rename-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.target; const button = form.querySelector('[type=submit]'); button.disabled = true;
  try { await api(`/api/tasks/${form.dataset.taskId}/files/${form.dataset.fileId}`, 'PUT', {name:$('#rename-name').value.trim(),version:Number(form.dataset.version)}); $('#rename-dialog').close(); await refresh(); toast('文件名已保存'); }
  catch(error){ $('#rename-error').textContent=error.message; }
  finally{button.disabled=false;}
});
document.addEventListener('submit', async event => {
  if (event.target.id === 'llm-form') { event.preventDefault(); try { await saveLlm(); } catch (error) { $('#llm-status').textContent = error.message; } }
});
$('#paste-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.target.querySelector('[type=submit]'); button.disabled = true;
  try {
    const result = await api('/api/messages', 'POST', { source: 'manual', account_id: state.session.user_id, conversation_id: 'manual', conversation_name: '手动通知', external_id: crypto.randomUUID(), sender_name: state.session.username, text: $('#paste-content').value, sent_at: new Date().toISOString() });
    state.selected = result.id; $('#paste-dialog').close(); state.page = 'inbox'; await refresh();
  } catch (error) { toast(error.message); } finally { button.disabled = false; }
});
$('#auth-switch').addEventListener('click', () => {
  state.isRegister = !state.isRegister; $('#auth-title').textContent = state.isRegister ? '创建交件箱账号' : '登录交件箱'; $('#auth-submit').textContent = state.isRegister ? '创建账号并登录' : '登录'; $('#auth-switch').textContent = state.isRegister ? '已有账号？返回登录' : '第一次使用？创建账号'; $('#auth-error').textContent = '';
});
$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  if(window.desktop && window.experience)return experience.browserLogin();
  $('#auth-submit').disabled = true; $('#auth-error').textContent = '';
  try {
    const url = new URL($('#server-url').value.trim()); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请填写有效的服务端地址');
    const server = url.href.replace(/\/$/, ''); const credentials = { username: $('#username').value.trim(), password: $('#password').value };
    async function call(route) {
      const response = await fetch(server + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials), signal: AbortSignal.timeout(20000) });
      const data = await response.json(); if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '请检查用户名与密码'); return data;
    }
    if (state.isRegister) await call('/api/auth/register');
    const result = await call('/api/auth/login'); const session = { ...result, server };
    if (window.desktop) await storeSet('session', session); else sessionStorage.setItem('jjb-session', JSON.stringify(session));
    $('#password').value = ''; await enter(session);
  } catch (error) { $('#auth-error').textContent = error instanceof TypeError ? '无法连接服务端，请检查地址与网络。' : error.message; }
  finally { $('#auth-submit').disabled = false; }
});
$('#logout').addEventListener('click', async () => {
  if (state.pending.length && !confirm(`还有 ${state.pending.length} 项修改未同步，本机草稿会保留。仍要退出吗？`)) return;
  try { await api('/api/auth/logout', 'POST'); } catch { /* 离线仍可退出本机。 */ }
  state.generation++; clearTimeout(reconnectTimer); clearTimeout(cacheTimer); state.socket?.close();
  if (window.desktop) { await desktop.stopCollector(); await desktop.remove('session'); } else sessionStorage.removeItem('jjb-session');
  state.session = null; state.selected = null; state.contexts.clear(); state.pending = []; state.snapshot = { tasks: [], messages: [], cursor: 0 };
  $('#workspace').hidden = true; $('#auth').hidden = false;
});
$('#refresh').addEventListener('click', () => { refresh(); flushOutbox(); });
window.addEventListener('online', () => { refresh(); flushOutbox(); if (!state.socket || state.socket.readyState > 1) syncSocket(); });
window.addEventListener('offline', () => online(false));
window.desktop?.onCollector(showCollectorState);
setInterval(() => { if (state.session) { refresh({ renderPage: false }); if (state.pending.length) flushOutbox(); } }, 30000);
(async () => {
  hydrateIcons();
  if(window.desktop){const platform=await desktop.platform();document.body.classList.toggle('native-titlebar',!!platform.nativeTitlebar);$('#desktop-titlebar').hidden=!platform.nativeTitlebar;try{appearance.restore(await desktop.getAppearance());}catch{}}
  $('#server-url').value = location.protocol === 'http:' || location.protocol === 'https:' ? location.origin : 'http://127.0.0.1:8765';
  try {
    const session = window.desktop ? await storeGet('session') : JSON.parse(sessionStorage.getItem('jjb-session') || 'null');
    if (session) return await enter(session);
  } catch (error) { toast(error.message); }
  $('#auth').hidden = false;
  window.experience?.prepareLogin();
})();
