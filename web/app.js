'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const easeTokens = { paths: null };
const paths = {
  inbox: '<path d="M3 4h14l3 9v7H0v-7L3 4Z" transform="translate(2 0)"/><path d="M3 13h5l2 3h4l2-3h5"/>',
  check: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>',
  connect: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/><path d="M17 3v6h4M3 17h6v4M9 17l8-8"/>',
  agent: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/><circle cx="12" cy="12" r="4.5"/><path d="m10.7 10.8 2.9 1.2-1.2 2.9-2.9-1.2 1.2-2.9Z"/>',
  chart: '<path d="M4 3v17h17M8 16v-5M13 16V6M18 16V9"/>',
  settings: '<path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z"/><circle cx="12" cy="12" r="3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21c.7-4.1 3.2-6.2 7.5-6.2s6.8 2.1 7.5 6.2"/>',
  refresh: '<path d="M20 10a8 8 0 1 0-2 8M20 4v6h-6"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  logout: '<path d="M10 4H4v16h6M12 12h9m-4-4 4 4-4 4"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  file: '<path d="M5 3h9l5 5v13H5V3Z"/><path d="M14 3v6h5M9 13h6M9 17h5"/>',
  share: '<circle cx="6" cy="12" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="m9 11 6-3.5M9 13l6 3.5"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.file}</svg>`;
const sizeText = size => size >= 1048576 ? (size / 1048576).toFixed(1) + ' MB' : size >= 1024 ? (size / 1024).toFixed(1) + ' KB' : size + ' B';
const formatDate = (value, short = false) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', ...(short ? {} : { hour: '2-digit', minute: '2-digit' }), hour12: false }) : '未设置';
const bytes = size => size >= 1024 ** 2 ? (size / 1024 ** 2).toFixed(1) + ' MB' : size >= 1024 ? (size / 1024).toFixed(1) + ' KB' : size + ' B';
const states = { collecting: ['准备材料', 'orange'], ready: ['待提交', 'blue'], submitted: ['已提交', 'green'], archived: ['已归档', ''] };
const EMOJI={'微笑':'🙂','撇嘴':'😕','色':'😍','发呆':'😮','得意':'😎','流泪':'😭','害羞':'😊','闭嘴':'🤐','睡':'😴','大哭':'😭','尴尬':'😅','发怒':'😡','调皮':'😜','呲牙':'😁','惊讶':'😲','难过':'🙁','酷':'😎','冷汗':'😓','抓狂':'🤯','吐':'🤮','偷笑':'🤭','愉快':'😄','白眼':'🙄','傲慢':'😤','困':'😪','惊恐':'😱','憨笑':'🤣','悠闲':'😌','咒骂':'🤬','疑问':'❓','嘘':'🤫','晕':'😵','衰':'😩','敲打':'🤕','再见':'👋','擦汗':'😅','鼓掌':'👏','坏笑':'😏','鄙视':'😒','委屈':'🥹','快哭了':'😥','阴险':'😈','亲亲':'😘','可怜':'🥺','笑脸':'😄','生病':'🤒','脸红':'😳','破涕为笑':'😂','恐惧':'😨','失望':'😞','无语':'😶','嘿哈':'😐','捂脸':'🤦','奸笑':'😌','机智':'🧐','皱眉':'🙁','耶':'✌️','吃瓜':'🍉','加油':'💪','汗':'😅','天啊':'😱','Emm':'😶','社会社会':'😎','旺柴':'🐶','好的':'👌','打脸':'🤡','哇':'😮','翻白眼':'🙄','666':'👍','让我看看':'👀','叹气':'😮‍💨','苦涩':'😖','裂开':'💥','嘴唇':'👄','爱心':'❤️','心碎':'💔','拥抱':'🤗','强':'👍','弱':'👎','握手':'🤝','胜利':'✌️','抱拳':'🙏','勾引':'💋','拳头':'✊','OK':'👌','合十':'🙏','啤酒':'🍺','咖啡':'☕','蛋糕':'🎂','玫瑰':'🌹','凋谢':'🥀','菜刀':'🔪','炸弹':'💣','便便':'💩','月亮':'🌙','太阳':'☀️','庆祝':'🎉','红包':'🧧','礼物':'🎁','鞭炮':'🧨','烟花':'🎆','猪头':'🐷','闪电':'⚡','旋风':'🌀'};
const EMOJI_RE=new RegExp('\\[(' + Object.keys(EMOJI).sort((a,b)=>b.length-a.length).map(k=>k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|') + ')\\]','g');
const pretty = text => String(text ?? '').replace(/[\x00-\x08\x0b-\x1f]/g,'').replace(EMOJI_RE,(m,name)=>EMOJI[name]);
const classifications = { actionable: ['待办通知', 'green'], chatting: ['普通聊天', ''], irrelevant: ['其他信息', ''], unprocessed: ['待分析', 'orange'] };
const state = { session: null, profile: '', page: 'inbox', snapshot: { tasks: [], messages: [], cursor: 0 }, pending: [], selected: null, taskId: null, contexts: new Set(), search: '', source: 'all', category: 'all', taskFilter: 'active', online: false, socket: null, sources: {}, busyAnalysis: new Set(), isRegister: false, generation: 0, firstRenderDone: false, cmdkIndex: 0 };
let editingUrgency = null, editingReminders = null;
let flushRunning = false, refreshRunning = false, cacheTimer, reconnectTimer, llmSettings = null, llmCredit = null, editingVersion = 0, uploading = false, lastSeenMessageId = null, pendingUndoId = null;

async function storeGet(key) {
  if (window.desktop) return desktop.get(key);
  try { return JSON.parse(localStorage.getItem('jjb-' + key)); } catch { return null; }
}
async function storeSet(key, value) {
  if (window.desktop) return desktop.set(key, value);
  localStorage.setItem('jjb-' + key, JSON.stringify(value));
}
function toastTimerHolder(){}
let toastHideTimer, toastAutoTimer, toastPositionFrame;
function syncToastPosition() {
  cancelAnimationFrame(toastPositionFrame);
  toastPositionFrame = requestAnimationFrame(() => {
    const el = $('#toast');
    const card = $('#status-suggest');
    if (!el || el.hidden || !el.classList.contains('corner') || !card) {
      el?.style.removeProperty('--toast-lift-y');
      return;
    }
    const baseBottom = Number.parseFloat(getComputedStyle(el).bottom) || 0;
    const targetBottom = innerHeight - card.getBoundingClientRect().top + 16;
    el.style.setProperty('--toast-lift-y', Math.min(0, baseBottom - targetBottom) + 'px');
  });
}
function toast(message, action, corner = true) {
  const el = $('#toast'); $('#toast-text').textContent = message;
  el.classList.toggle('corner', !!corner);
  el.style.removeProperty('--toast-lift-y');
  const button = $('#toast-action');
  clearTimeout(toastHideTimer); clearTimeout(toastAutoTimer);
  if (action?.label) {
    button.textContent = action.label; button.hidden = false;
    button.onclick = () => { hideToast(); action.run(); };
  } else { button.hidden = true; button.onclick = null; }
  el.hidden = false; syncToastPosition(); requestAnimationFrame(() => {if(!el.hidden)el.classList.add('show');});
  toastAutoTimer=setTimeout(hideToast,action?.label?8000:3500);
}
$('#toast-close').addEventListener('click',hideToast);
function hideToast(){ clearTimeout(toastAutoTimer); const el = $('#toast'); el.classList.remove('show'); toastHideTimer = setTimeout(() => { el.hidden = true; el.style.removeProperty('--toast-lift-y'); }, 220); }
window.addEventListener('resize', syncToastPosition);
window.visualViewport?.addEventListener('resize', syncToastPosition);
function hydrateIcons() { $$('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); }); }
function apiUrl(route) { return state.session.server.replace(/\/$/, '') + route; }
async function api(route, method = 'GET', body) {
  let request = { route, method, body };
  if (window.pluginUI) request = await window.pluginUI.beforeRequest(request);
  const headers = { Authorization: 'Bearer ' + state.session.token };
  if (request.body !== undefined && !(request.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const timeoutRoute = route === '/api/collection/ai' || route === '/api/analyze' || route.endsWith('/suggest') ? route : request.route;
  const response = await fetch(apiUrl(request.route), { method: request.method, headers, body: request.body instanceof FormData ? request.body : request.body === undefined ? undefined : JSON.stringify(request.body), signal: AbortSignal.timeout((timeoutRoute === '/api/collection/ai'||timeoutRoute === '/api/analyze'||timeoutRoute.endsWith('/suggest')) ? 100000 : 45000) });
  if (!response.ok) {
    let detail;
    try { detail = (await response.json()).detail; } catch { detail = '服务端返回错误'; }
    const error = new Error(typeof detail === 'string' ? detail : detail?.message || (response.status === 422 ? '请检查表单内容是否完整、时间格式是否正确' : '请求失败'));
    error.status = response.status; error.detail = detail;
    throw error;
  }
  const result = await response.json();
  return window.pluginUI ? await window.pluginUI.afterResponse(request, response, result) : result;
}
async function apiUpload(route, body, onProgress) {
  let request = { route, method: 'POST', body };
  if (window.pluginUI) request = await window.pluginUI.beforeRequest(request);
  if (!(request.body instanceof FormData)) throw new Error('上传请求必须是 FormData');
  const result = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(request.method, apiUrl(request.route));
    xhr.responseType = 'text';
    xhr.setRequestHeader('Authorization', 'Bearer ' + state.session.token);
    xhr.upload.onprogress = event => onProgress?.(event);
    xhr.onload = () => {
      let data;
      try { data = JSON.parse(xhr.responseText || '{}'); } catch { data = {}; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else {
        const detail = data.detail;
        const error = new Error(typeof detail === 'string' ? detail : detail?.message || (xhr.status === 413 ? '文件超过大小限制' : '上传失败'));
        error.status = xhr.status; reject(error);
      }
    };
    xhr.onerror = () => reject(new Error('网络连接中断，上传已停止'));
    xhr.onabort = () => reject(new Error('上传已取消'));
    xhr.send(request.body);
  });
  if (!window.pluginUI) return result;
  const response = { ok: true, status: 200, url: apiUrl(request.route), json: async () => result };
  return await window.pluginUI.afterResponse(request, response, result);
}
function showUploadProgress(name, value) {
  const box = $('#upload-progress'); if (!box) return;
  const total = Number(value.total) || 0;
  const received = Number(value.received) || 0;
  const progress = total ? Math.max(0, Math.min(1, received / total)) : 0;
  const speed = Number(value.bytesPerSecond) || 0;
  $('#upload-name').textContent = name;
  $('#upload-percent').textContent = total ? Math.floor(progress * 100) + '%' : Math.floor(received / 1024) + ' KB';
  $('#upload-fill').style.transform = `scaleX(${progress})`;
  const bar = box.querySelector('[role=progressbar]');
  bar.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
  bar.setAttribute('aria-valuetext', `${sizeText(received)} / ${sizeText(total)}`);
  $('#upload-bytes').textContent = `${sizeText(received)} / ${sizeText(total)}`;
  $('#upload-speed').textContent = speed > 0 ? sizeText(speed) + '/s' : '正在连接…';
  box.hidden = false;
}
function hideUploadProgress() { const box = $('#upload-progress'); if (box) box.hidden = true; }
function uploadTracker(name) {
  let at = performance.now(), received = 0;
  return event => {
    const now = performance.now();
    const elapsed = Math.max(0.05, (now - at) / 1000);
    const speed = Math.max(0, (event.loaded - received) / elapsed);
    at = now; received = event.loaded;
    showUploadProgress(name, { received: event.loaded, total: event.total, bytesPerSecond: speed });
  };
}
function online(value) {
  state.online = value;
  const el = $('#sync-state');
  el.classList.toggle('offline', !value);
  el.innerHTML = `<i></i>${state.session?.mode==='offline'?'本机离线':value ? '已同步' : '连接中'}${state.pending.length ? ` · ${state.pending.length} 项待同步` : ''}`;
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
    const contentChanged = JSON.stringify(state.snapshot.tasks) !== JSON.stringify(applyPending(snapshot).tasks) || JSON.stringify(state.snapshot.messages.slice(0, 200)) !== JSON.stringify(snapshot.messages) || JSON.stringify(state.snapshot.shelf) !== JSON.stringify(snapshot.shelf);
    const previousMessages = state.snapshot.messages;
    // 分享列表由 /api/shares 维护，快照刷新必须保留它，否则每次轮询都会清空分享页。
    const previousShares = state.snapshot.shares;
    const knownIds = new Set(previousMessages.map(m => m.id));
    state.snapshot = applyPending(snapshot);
    if (previousShares) state.snapshot.shares = previousShares;
    const latestIds = new Set(snapshot.messages.map(m => m.id));
    state.snapshot.messages.push(...previousMessages.filter(m => !latestIds.has(m.id)));
    for (const m of state.snapshot.messages) if (!knownIds.has(m.id) && state.firstRenderDone) m.isNew = true;
    online(true); cacheSoon();
    if (renderPage && contentChanged && !uploading && !['settings', 'sources','agent','stats','plugins','shares'].includes(state.page) && !state.page.startsWith('plugin:')) render();
    window.dispatchEvent(new CustomEvent('snapshot-updated', { detail: state.snapshot }));
    window.agentUI?.synced?.();
    window.pluginUI?.sync();
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
        if (error.status === 409) { item.conflict = true; toast('有待办在其他设备被修改，本机草稿已保留，请进入待办处理冲突'); }
        else if (error.status) { item.error = error.message; toast('待同步待办未能保存：' + error.message); }
        else { online(false); break; }
      }
    }
    await refresh();
  } finally { flushRunning = false; cacheSoon(); }
}
async function enter(session) {
  state.generation++; state.session = session;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode((session.mode==='offline'?'offline':session.server.replace(/\/$/, '')) + '|' + session.user_id));
  state.profile = [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 24);
  const saved = await storeGet('cache-' + state.profile);
  state.pending = saved?.pending || []; state.snapshot = saved?.snapshot || { tasks: [], messages: [], cursor: 0 };
  state.sources = await storeGet('sources-' + state.profile) || { python_path: '', qq_http_url: 'http://127.0.0.1:3000', qq_ws_url: 'ws://127.0.0.1:3001', qq_token: '', qq_chats: [], wechat_chats: [], conversations: [] };
  $('#auth').hidden = true; $('#workspace').hidden = false;
  $('#account-name').textContent = session.nickname || (session.mode==='offline'?'本机工作区':session.username); $('#avatar').textContent = session.username.slice(0, 1).toUpperCase();
  $('#account-server').textContent = session.mode==='offline'?'离线使用 · 仅本机':new URL(session.server).host;
  state.page = 'inbox'; state.firstRenderDone = false; render(); await refresh(); syncSocket();
  applyHashRoute() || render();
  const settingsGeneration=state.generation;state.contextCount=undefined;api('/api/settings/llm').then(config=>{if(settingsGeneration!==state.generation)return;llmSettings=config;if(state.contextCount===undefined){state.contextCount=config.context_count;const input=$('#context-count');if(input&&document.activeElement!==input)input.value=config.context_count;}}).catch(()=>{});
  maybeOnboard();
  window.experience?.onSession();
  await window.accountUI?.afterLogin();
  promptCheckin();
}
async function promptCheckin() {
  const generation = state.generation;
  try {
    const credit = await api('/api/ai/credit');
    if (generation !== state.generation || !credit.enabled || !credit.checkin_enabled || credit.checked_today) return;
    toast(`今日可签到领取 ${credit.checkin_credits} 积分，当前剩余 ${credit.balance} 积分`, { label: '立即签到', run: async () => {
      try { const result = await api('/api/ai/credit/checkin', 'POST'); toast(`签到成功，剩余 ${result.balance} 积分`); }
      catch (error) { toast(error.message); }
    }}, true);
  } catch { /* Managed service is optional. */ }
}
const ONBOARD_STEPS = [
  { title: '欢迎来到交件箱', body: '把聊天里的通知整理成能交付的事：收通知、建待办、交材料、存回执，都在这里。', hint: '第一步 · 了解工作台' },
  { title: '连接 QQ / 微信', body: '打开「触发器」，保持 QQ 或微信在本机登录，勾选要关注的聊天即可自动同步，之后每次打开应用都会自动续读。', hint: '第二步 · 选择聊天', action: 'sources' },
  { title: '让模型替你读通知', body: '在「设置」填入你自己的模型 API，新通知会自动分类；开启「自动新建待办」后，待办通知会直接进入待办列表。', hint: '第三步 · 配置模型', action: 'settings' },
  { title: '拖入文件，AI 帮你归类', body: '把文件拖进窗口：放到待办卡片直接成为材料，放到空白处交给 AI 按内容归到合适的待办。', hint: '第四步 · 收纳文件' },
];
let onboardStep = 0, onboardActive = false;
async function maybeOnboard() {
  if (onboardActive) return;
  const seen = await storeGet('onboarded-' + state.profile);
  if (seen) return;
  onboardActive = true; onboardStep = 0; renderOnboard();
}
function renderOnboard() {
  $('#onboard')?.remove();
  if (!onboardActive) return;
  const step = ONBOARD_STEPS[onboardStep];
  const card = document.createElement('div'); card.id = 'onboard'; card.className = 'onboard-card'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', '新手引导');
  card.innerHTML = `<div class="eyebrow">${esc(step.hint)}</div><h3>${esc(step.title)}</h3><p>${esc(step.body)}</p><div class="onboard-dots">${ONBOARD_STEPS.map((_, i) => `<i class="${i === onboardStep ? 'on' : i < onboardStep ? 'done' : ''}"></i>`).join('')}</div><div class="detail-actions"><button class="plain-button" data-onboard="skip">跳过</button><span class="flex-spacer"></span>${onboardStep > 0 ? '<button class="secondary" data-onboard="prev">上一步</button>' : ''}<button class="primary" data-onboard="${step.action ? 'goto' : 'next'}">${step.action ? '去' + (step.action === 'sources' ? '触发器' : '设置') : onboardStep === ONBOARD_STEPS.length - 1 ? '开始使用' : '下一步'}</button></div>`;
  document.body.append(card);
}
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-onboard]'); if (!button) return;
  const action = button.dataset.onboard;
  if (action === 'skip') { onboardActive = false; $('#onboard')?.remove(); return storeSet('onboarded-' + state.profile, true); }
  if (action === 'prev') { onboardStep = Math.max(0, onboardStep - 1); return renderOnboard(); }
  if (action === 'goto') { const target = ONBOARD_STEPS[onboardStep].action; onboardStep++; renderOnboard(); return navigate(target); }
  if (action === 'next') {
    if (onboardStep >= ONBOARD_STEPS.length - 1) { onboardActive = false; $('#onboard')?.remove(); await storeSet('onboarded-' + state.profile, true); return; }
    onboardStep++; return renderOnboard();
  }
});
function updateCounts() {
  $('#inbox-count').textContent = state.snapshot.messages.filter(m => m.triage !== 'ignored' && (!m.analysis || m.analysis.classification === 'actionable')).length || '';
  $('#task-count').textContent = state.snapshot.tasks.filter(t => ['collecting', 'ready'].includes(t.status)).length || '';
  const shareCount = $('#share-count');
  if (shareCount) shareCount.textContent = (state.snapshot.shares || []).length || '';
}
function heading(title, subtitle, actions = '') { return `<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div><div class="actions">${actions}</div></div>`; }
function empty(title, subtitle, action = '') { return `<div class="empty">${icon('inbox')}<strong>${title}</strong><div>${subtitle}</div>${action}</div>`; }
function tag(label, color = '') { return `<span class="tag ${color}">${esc(label)}</span>`; }
function sourceTag(source) { return tag({ qq: 'QQ', wechat: '微信', manual: '手动' }[source] || source, source === 'qq' ? 'blue' : source === 'wechat' ? 'green' : ''); }
function messageClass(message) {
  if (message.triage === 'ignored') return ['已忽略', ''];
  if (state.busyAnalysis.has(message.id) || (!message.analysis && message.analysis_pending)) return [message.analysis_state === 'retrying' ? '等待重试' : '分析中', 'orange'];
  if (!message.analysis && message.analysis_error) return ['分析失败', 'red'];
  return classifications[message.analysis?.classification || 'unprocessed'];
}
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
  return heading('通知', '从聊天中找到重要通知，自动分析并提取待办。', `<button class="secondary" data-action="paste">粘贴通知</button><button class="primary" data-action="new-task">${icon('plus')}新建待办</button>`) +
    `<div class="toolbar"><div class="search"><span>${icon('search')}</span><input id="inbox-search" placeholder="搜索通知、群聊或联系人" value="${esc(state.search)}" aria-label="搜索消息"></div><select id="source-filter" aria-label="来源"><option value="all">全部来源</option><option value="qq">QQ</option><option value="wechat">微信</option><option value="manual">手动添加</option></select><select id="category-filter" aria-label="分类"><option value="all">全部分类</option><option value="actionable">待办通知</option><option value="unprocessed">待分析</option><option value="chatting">普通聊天</option><option value="irrelevant">其他信息</option><option value="ignored">已忽略</option></select><span class="result-count">${messages.length} 条消息</span></div>` +
    `<div class="inbox-grid ${selected ? 'has-selection' : ''}"><section class="panel messages-panel"><div class="panel-head"><h3>最近通知</h3><small>${state.contexts.size ? '已选 ' + state.contexts.size + ' 条上下文' : '勾选消息可作为上下文'}</small></div><div class="message-list ${state.firstRenderDone ? '' : 'stagger'}">${messages.length ? messages.map(m => `<article class="message-row ${state.firstRenderDone ? '' : 'stagger-item'} ${state.selected === m.id ? 'selected' : ''} ${m.isNew ? 'flash' : ''}" data-message="${esc(m.id)}" tabindex="0" role="button" aria-label="查看 ${esc(m.conversation_name)} 的消息"><input class="select-context" type="checkbox" data-context="${esc(m.id)}" ${state.contexts.has(m.id) ? 'checked' : ''} aria-label="选择为上下文"><div class="message-body"><div class="message-meta">${sourceTag(m.source)}<strong>${esc(m.conversation_name || '手动通知')}</strong><time>${formatDate(m.sent_at)}</time></div><div class="message-excerpt">${esc(pretty(m.text))}</div><div class="message-bottom">${tag(...messageClass(m))}${m.analysis ? confidenceChip(m.analysis.confidence) : ''}<span class="sender">${esc(m.sender_name || '我')}</span></div></div><div class="row-actions"><button data-row-action="message-task" data-id="${esc(m.id)}">建待办</button><button data-row-action="ignore-message" data-id="${esc(m.id)}" class="danger-hover">忽略</button><button data-row-action="delete-message" data-id="${esc(m.id)}" class="danger-hover">移入回收站</button></div></article>`).join('') : empty('暂无通知', state.search ? '换个关键词或筛选条件试试。' : '连接 QQ / 微信，或先粘贴一条通知。', '<button class="primary" data-action="paste">添加第一条通知</button>')}</div><div class="load-more"><button class="plain-button" data-action="more-messages">加载更早的消息</button></div></section><section class="panel detail">${selected ? messageDetail(selected) : empty('先选一条消息', '通知原文、上下文和分析结果会显示在这里。')}</section></div>`;
}
function evidenceQuote(m) {
  const result = m.analysis; if (!result) return '';
  const quotes = [];
  if (result.due_at) quotes.push(result.due_at);
  const proof = result.evidence || [];
  for (const item of proof.slice(0, 3)) quotes.push(item);
  const text = m.text || '';
  const highlights = quotes.map(q => String(q).trim()).filter(q => q.length > 3 && text.includes(q));
  if (!highlights.length) return '';
  let html = esc(text);
  for (const phrase of highlights.slice(0, 4)) {
    const escaped = esc(phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(escaped, 'g'), match => `<em>${match}</em>`);
  }
  return `<div class="evidence-quote">${html}</div>`;
}
function messageDetail(m) {
  const result = m.analysis;
  const related = state.snapshot.messages.filter(x => x.id !== m.id && x.source === m.source && x.account_id === m.account_id && x.conversation_id === m.conversation_id && new Date(x.sent_at) <= new Date(m.sent_at)).slice(0, 12).reverse();
  const busy = state.busyAnalysis.has(m.id);
  const pending = !result && m.triage !== 'ignored' && !!m.analysis_pending;
  const working = busy || pending;
  const title = result?.title || pretty((m.text.split('\n').find(l=>l.trim()&&!l.trim().endsWith('：')&&!l.trim().endsWith(':')) || m.text.split('\n')[0] || '消息详情')).slice(0, 90);
  return `<div class="panel-head"><h3>通知详情</h3><span class="helper">原文保留</span></div><div class="detail-content"><button class="link mobile-back" data-action="back-inbox">← 返回消息列表</button><div class="detail-meta">${sourceTag(m.source)}<span class="helper">${formatDate(m.sent_at)}</span></div><h2 class="detail-title">${esc(title)}</h2><div class="detail-byline">${esc(m.conversation_name)} · ${esc(m.sender_name || '我')}</div><div class="message-original">${esc(pretty(m.text))}${m.metadata?.quote ? '\n\n引用 ' + esc(m.metadata.quote.sender) + '：\n' + esc(m.metadata.quote.text) : ''}</div><div class="analysis-box"><div class="analysis-top"><h3>通知分析</h3>${working ? tag(pending && m.analysis_state === 'retrying' ? '等待重试' : '分析中', 'orange') : result ? `<small>${esc(result.model)}</small>` : m.analysis_error ? tag('分析失败', 'red') : tag('待分析', 'orange')}</div>${busy ? window.liveAnalysis?.markup('message:'+m.id)||'<p class="helper">正在结合上下文分析…</p>' : pending ? '<p class="helper" role="status">' + (m.analysis_state === 'running' ? '正在结合上下文自动分析，完成后会自动显示结果。' : m.analysis_state === 'retrying' ? '本次分析未完成，已加入自动重试队列。' : '正在自动分析，已加入队列，轮到这条消息后会立即处理。') + '</p>' : result ? `<div class="pill-row">${tag(...classifications[result.classification])}${confidenceChip(result.confidence)}${m.auto_task_id&&state.snapshot.tasks.some(t=>t.id===m.auto_task_id)?tag(result.auto_task_action==='appended'?'已追加到待办':result.auto_task_action==='matched'?'已关联待办':'已自动建待办','blue'):''}</div><p>${esc(result.summary)}</p>${result.due_at ? `<p>截止：${formatDate(result.due_at)}</p>` : ''}${result.requirements.length ? `<p>材料：${result.requirements.map(r => esc(r.label)).join('、')}</p>` : ''}<div class="analysis-reason">${esc(result.reason)}${result.notes?.length ? '<br>' + result.notes.map(esc).join('<br>') : ''}<br>本次使用 ${result.context_ids.length} 条上下文</div>${evidenceQuote(m)}${window.liveAnalysis?.performance(result)||''}` : m.analysis_error ? `<p class="error">${esc(m.analysis_error)}</p><p class="helper">请检查模型连接和配置，然后重试分析。</p>` : `<p>使用你在设置里配置的 AI，区分通知与闲聊，并提取可确认的待办草稿。</p>`}</div><div class="context-options"><span>自动上下文</span><input id="context-count" type="number" min="0" max="50" value="${state.contextCount ?? 12}" aria-label="上下文条数"><span>条</span>${state.contexts.size ? `<button class="link" data-action="clear-context">清除已选 ${state.contexts.size} 条</button>` : ''}</div><p class="helper">${state.contexts.size ? `分析时将发送当前消息与手动勾选的 ${state.contexts.size} 条上下文。` : '分析时将发送当前消息与同一会话的最近消息。'}</p><div class="detail-actions"><button class="primary" data-action="analyze" ${working ? 'disabled' : ''}>${working ? '正在分析…' : m.analysis_error ? '重试分析' : result ? '重新分析' : '使用 AI 分析'}</button>${busy?'<button class="secondary" data-action="cancel-analysis">停止分析</button>':''}<button class="secondary" data-action="message-task">生成待办草稿</button><button class="plain-button" data-action="ignore-message">${m.triage === 'ignored' ? '恢复消息' : '忽略这条'}</button><button class="plain-button danger-button" data-action="delete-message">移入回收站</button></div>${related.length ? `<details class="context-list"><summary>查看同会话的最近上下文（${related.length}）</summary>${related.map(x => `<div class="context-message"><small>${esc(x.sender_name)} · ${formatDate(x.sent_at)}</small><p>${esc(x.text)}</p></div>`).join('')}</details>` : ''}</div>`;
}
const startOfDay = value => { const d = new Date(value); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
function dueBadge(value) {
  if (!value) return '<span class="due-chip far">未设截止</span>';
  const due = new Date(value); const hours = (due - Date.now()) / 3600000;
  const text = formatDate(value, true);
  if (hours < 0) return `<span class="due-chip overdue">逾期 · ${text}</span>`;
  const dayDiff = Math.round((startOfDay(due) - startOfDay(new Date())) / 86400000);
  if (dayDiff === 0) return `<span class="due-chip today">今天 ${text.slice(-5)} 截止</span>`;
  if (dayDiff === 1) return `<span class="due-chip soon">明天 ${text.slice(-5)} 截止</span>`;
  if (hours <= 72) return `<span class="due-chip soon">还剩 ${Math.ceil(hours / 24)} 天</span>`;
  return `<span class="due-chip far">${text} 截止</span>`;
}
function confidenceChip(value) {
  if (value == null) return '';
  const percent = Math.round(value * 100);
  const level = value >= .85 ? 'high' : value >= .7 ? 'medium' : 'low';
  const label = value >= .85 ? '可放心采纳' : value >= .7 ? '建议人工确认' : '仅供参考';
  return `<span class="confidence-chip ${level}"><i></i>${percent}% · ${label}</span>`;
}
function dueUrgency(t) {
  if (!t.due_at || ['submitted', 'archived'].includes(t.status)) return '';
  const due = new Date(t.due_at);
  const hours = (due - Date.now()) / 3600000;
  if (hours < 0) return 'overdue';
  const dayDiff = Math.round((startOfDay(due) - startOfDay(new Date())) / 86400000);
  if (dayDiff <= 0) return 'today';
  if (hours <= 72) return 'soon';
  return '';
}
function tasksView() {
  if (state.taskId) {
    const task = state.snapshot.tasks.find(t => t.id === state.taskId);
    if (task) return taskDetail(task);
    state.taskId = null;
  }
  const all = state.snapshot.tasks;
  const list = all.filter(t => (state.taskFilter === 'all' || state.taskFilter === 'active' ? state.taskFilter === 'all' || ['collecting', 'ready'].includes(t.status) : t.status === state.taskFilter) && (!state.search || (t.title + t.description).toLowerCase().includes(state.search.toLowerCase())));
  return heading('待办', '要求、材料与提交回执，一处整理。', `<button class="plain-button" data-productivity-action="templates">模板</button><button class="plain-button" data-productivity-action="recycle">回收站</button><button class="secondary" data-action="show-archived">已归档（${all.filter(t=>t.status==='archived').length}）</button><button class="primary" data-action="new-task">${icon('plus')}新建待办</button>`) +
    `<div class="task-summary">${[['collecting','准备材料'],['ready','待提交'],['submitted','已提交']].map(([s,label])=>`<div class="summary-cell"><strong>${all.filter(t=>t.status===s).length}</strong><span>${label}</span></div>`).join('')}</div><div class="toolbar"><div class="search"><span>${icon('search')}</span><input id="task-search" placeholder="搜索待办" value="${esc(state.search)}" aria-label="搜索待办"></div><select id="task-filter" aria-label="待办进度"><option value="active">进行中</option><option value="all">全部待办</option><option value="collecting">准备材料</option><option value="ready">待提交</option><option value="submitted">已提交</option><option value="archived">已归档</option></select></div><div class="task-grid ${state.firstRenderDone ? '' : 'stagger'}">${list.map(t => `<article class="task-card ${state.firstRenderDone ? '' : 'stagger-item'} ${dueUrgency(t) === 'overdue' ? 'card-overdue' : ''}" tabindex="0" role="button" data-task="${esc(t.id)}"><div class="pill-row">${tag(...states[t.status])}${t.pending ? tag(t.conflict ? '同步冲突' : '待同步', 'orange') : ''}${dueUrgency(t) ? `<span class="due-chip ${dueUrgency(t)}">${dueUrgency(t) === 'overdue' ? '已逾期' : dueUrgency(t) === 'today' ? '今天截止' : '3 天内截止'}</span>` : ''}</div><h3>${esc(t.title)}</h3><p>${esc(t.description || '暂无补充说明')}</p><div class="task-card-footer"><span class="${t.due_at && new Date(t.due_at) < new Date() && !['submitted', 'archived'].includes(t.status) ? 'overdue' : ''}">${dueBadge(t.due_at)}</span><span>${t.attachments.filter(f => f.kind === 'material').length} 份材料</span></div></article>`).join('')}</div>${list.length ? '' : `<div class="panel">${empty('把下一次交件安排好', '从通知生成待办，或直接创建一项。', '<button class="primary" data-action="new-task">新建待办</button>')}</div>`}`;
}
function fileRow(f, task) { const ext = f.name.split('.').pop().toLowerCase().slice(0, 5); return `<div class="file-row"><span class="file-icon" data-ext="${esc(ext)}">${esc(ext)}</span><span class="file-info"><strong>${esc(f.name)}</strong><small>${bytes(f.size)}</small></span><button class="plain-button file-kind-button" data-change-kind="${esc(f.id)}" data-next-kind="${f.kind==='receipt'?'material':'receipt'}" data-version="${task.version}" ${task.pending?'disabled':''} title="${f.kind==='receipt'?'移动到待办材料，参与材料核对':'移动到提交回执'}">${f.kind==='receipt'?'转为材料':'转为回执'}</button><button class="icon-button" data-preview-file="${esc(f.id)}" data-name="${esc(f.name)}" title="预览" aria-label="预览 ${esc(f.name)}">◫</button><button class="icon-button" data-rename-file="${esc(f.id)}" data-name="${esc(f.name)}" data-version="${task.version}" title="重命名" aria-label="重命名 ${esc(f.name)}">✎</button><button class="icon-button" data-download="${esc(f.id)}" data-name="${esc(f.name)}" title="下载" aria-label="下载 ${esc(f.name)}">↓</button><button class="icon-button" data-delete-file="${esc(f.id)}" data-version="${task.version}" title="移入回收站" aria-label="移入回收站 ${esc(f.name)}">×</button></div>`; }
function urgencySwitch(t) {
  return ['high', 'normal', 'low'].map(u => `<button class="status-step ${((t.urgency || 'normal') === u) ? 'on' : ''} ${u === 'high' ? 'red' : ''}" data-set-urgency="${u}" ${t.pending ? 'disabled' : ''}>${({ high: '紧急', normal: '普通', low: '不急' })[u]}</button>`).join('');
}
function reminderIso(task, preset, custom) {
  if (!task.due_at) return null;
  const due = new Date(task.due_at);
  if (preset === 'custom') {
    if (!custom) return null;
    return new Date(custom).toISOString();
  }
  const map = { '-1d': [1, 9, 0], '-2h': [0, null, 2], '0d': [0, 9, 0] };
  const [days, hour, hoursBefore] = map[preset] || [0, 9, 0];
  if (hoursBefore) return new Date(due.getTime() - hoursBefore * 3600000).toISOString();
  const d = new Date(due); d.setDate(d.getDate() - days); d.setHours(hour ?? 9, 0, 0, 0);
  return d.toISOString();
}
function taskDetail(t) {
  const origin = state.snapshot.messages.find(m => m.id === t.source_message_id);
  const sources = (Array.isArray(t.source_messages) ? t.source_messages : []).slice();
  if (origin && !sources.some(source => source.id === origin.id)) sources.unshift(origin);
  const sourceHistory = sources.length ? `<details class="task-origin"><summary class="helper">${sources.length > 1 ? `查看通知来源与追加（${sources.length}）` : `查看原始通知 · ${esc(sources[0].conversation_name || '手动添加')}`}</summary><div class="task-source-list">${sources.map((source, index) => `<div class="context-message"><small>${index ? `后续通知 ${index}` : '原始通知'} · ${esc(source.sender_name || '未知发送者')} · ${formatDate(source.sent_at)}</small><p>${esc(pretty(source.text || ''))}</p></div>`).join('')}</div></details>` : '';
  const statusSwitch = `<div class="status-switch" role="group" aria-label="待办进度">${['collecting', 'ready', 'submitted'].map(s => `<button class="status-step ${t.status === s ? 'on' : ''} ${states[s][1]}" data-set-status="${s}" ${t.pending ? 'disabled' : ''}><i>${t.status === s ? '●' : ['collecting', 'ready', 'submitted'].indexOf(t.status) > ['collecting', 'ready', 'submitted'].indexOf(s) ? '✓' : ''}</i>${states[s][0]}</button>`).join('')}${t.status === 'archived' ? tag('已归档', '') : ''}</div>`;
  const urgencyChip = { high: tag('紧急', 'red'), normal: '', low: tag('不急', '') }[t.urgency || 'normal'] || '';
  const reminderList = (t.reminders || []).map(r => `<div class="reminder-row"><span>${icon('check')}${formatDate(r)}</span><button class="plain-button" data-remove-reminder="${esc(r)}">移除</button></div>`).join('');
  const reminderAdd = t.due_at ? `<div class="reminder-add"><select id="reminder-preset"><option value="">选择提醒时间…</option><option value="-1d">截止前 1 天 09:00</option><option value="-2h">截止前 2 小时</option><option value="0d">截止当天 09:00</option><option value="custom">自定义…</option></select><input type="datetime-local" id="reminder-custom" hidden></div>` : `<p class="helper">设置截止时间后可添加提醒。</p>`;
  return `<button class="link task-detail-back" data-action="back-tasks">← 返回待办列表</button>` + heading(esc(t.title), t.pending ? t.conflict ? '其他设备已修改此待办。本机草稿仍保留，重新编辑后确认合并。' : '本机修改等待同步。' : '材料准备好以后，再从提交入口完成交件。', `<button class="secondary" data-action="edit-task">编辑待办</button><button class="primary" data-action="package" ${t.pending ? 'disabled' : ''}>下载材料包</button>`) +
    `<div class="task-detail-grid"><section class="panel"><div class="panel-head"><h3>待办内容</h3></div><div class="task-main-content">${statusSwitch}<div class="task-description">${esc(t.description || '暂无说明')}</div>${t.conflict ? '<button class="secondary" data-action="discard-conflict">放弃本机草稿，使用云端版本</button>' : ''}<div class="section-heading"><h3>待办材料</h3><small class="helper">${t.attachments.filter(f => f.kind === 'material').length} 个文件</small></div>${t.attachments.filter(f => f.kind === 'material').map(f => fileRow(f, t)).join('')}<label class="drop-zone">点击或拖入文件添加材料<input id="material-upload" type="file" multiple ${t.pending ? 'disabled' : ''} aria-label="上传待办材料"></label><div class="section-heading"><h3>提交回执</h3><small class="helper">成功截图、确认邮件或回执文件</small></div>${t.attachments.filter(f => f.kind === 'receipt').map(f => fileRow(f, t)).join('')}<label class="drop-zone">添加提交凭证<input id="receipt-upload" type="file" multiple ${t.pending ? 'disabled' : ''} aria-label="上传提交回执"></label>${sourceHistory}${window.shares?.taskActions(t)||""}<div class="section-heading"><h3>待办管理</h3></div><div class="small-actions"><button class="plain-button" data-action="${t.status==='archived'?'restore-task':'archive-task'}" ${t.pending ? 'disabled' : ''}>${t.status==='archived'?'恢复待办':'归档待办'}</button><button class="plain-button danger-button" data-action="delete-task" ${t.pending ? 'disabled' : ''}>删除待办</button></div></div></section><aside><section class="panel task-side"><div class="info-label">紧急度</div><div class="urgency-switch" role="group" aria-label="紧急度">${urgencySwitch(t)}</div><div class="info-label">截止时间</div><div class="info-value">${formatDate(t.due_at)}</div><div class="info-label">提醒</div><div class="info-value reminders-block">${reminderList || '<p class="helper">暂无提醒</p>'}${reminderAdd}</div><div class="info-label">文件命名</div><div class="info-value">${esc(t.naming_hint || t.filename_pattern || '未设置命名要求')}</div><div class="info-label">提交入口</div><div class="info-value">${t.submit_url ? `<button class="link" data-external="${esc(t.submit_url)}">打开提交页面 ↗</button>` : '未填写'}</div><div class="section-heading"><h3>材料核对</h3><button class="link" data-action="check-task">重新核对</button></div><div id="task-check">${t.requirements.length ? t.requirements.map(r => `<div class="check-row"><span class="check-symbol manual">○</span><div><strong>${esc(r.label)}</strong><small>${esc(r.extensions.join(' / ') || '任意格式')} · 至少 ${r.min_count} 份</small></div></div>`).join('') : '<p class="helper">未设置材料清单，可在编辑待办中添加。</p>'}</div></section></aside></div>`;
}
function settingsView() {
  return heading('设置', '选择服务器提供的 AI，或连接自己的模型接口。') + `<div id="model-settings"><div class="service-toolbar"><div class="chart-mode" id="llm-mode" hidden role="tablist" aria-label="模型使用方式"><button type="button" role="tab" data-llm-mode="managed">默认</button><button type="button" role="tab" data-llm-mode="custom">自定义</button></div><span id="llm-mode-status" class="helper" role="status"></span></div><div id="llm-managed-panel" hidden><div class="managed-overview"><section class="panel credit-panel"><span class="helper">可用积分</span><strong id="llm-credit-balance">—</strong><p id="llm-credit-note" class="helper"></p><p id="llm-managed-vision" class="helper"></p><span class="service-badge">服务器提供 · 免配置</span></section><section class="panel checkin-panel" id="llm-checkin-card" hidden><div><h3>每日签到</h3><p id="llm-checkin-note" class="helper"></p></div><strong id="llm-checkin-state">—</strong><button type="button" class="secondary" data-credit-checkin hidden>立即签到</button></section></div></div><div class="settings-grid" id="llm-custom-panel" data-motion-key="model-preferences"><form id="llm-form" class="panel settings-panel"><div id="llm-provider-fields"><h3>自定义接口</h3><p class="helper">支持兼容 Chat Completions 的接口。配置按账号保存，电脑和手机共用。</p><p id="llm-managed-note" class="helper" hidden></p><label>API 地址<input id="llm-url" type="url" placeholder="https://api.example.com/v1" required></label><label>API Key<input id="llm-key" type="password" autocomplete="new-password" placeholder="留空保留已保存的 Key"><span id="llm-key-note" class="helper"></span></label><div class="form-grid"><label>模型<input id="llm-model" list="model-options" required placeholder="填写模型名称"><datalist id="model-options"></datalist></label></div></div><h3>分析偏好</h3><label>默认上下文条数<input id="llm-context" type="number" min="0" max="50" value="12" required></label><label id="llm-vision-setting" class="switch-line"><input id="llm-vision" type="checkbox"><span><strong>模型支持图片分析</strong><small>启用后，图片会发送实际图像给模型，判断截图内容和提交状态；纯文本模型请关闭。</small></span></label><label class="switch-line"><input id="llm-auto" type="checkbox"><span><strong>自动分析新消息</strong><small>仅处理桌面端所选会话同步的新消息。关闭后，可在通知页手动分析。</small></span></label><label class="switch-line" id="auto-task-line" hidden><input id="llm-auto-task" type="checkbox"><span><strong>自动新建与追加待办</strong><small>新建待办后，同会话的后续通知可自动补充提交链接、截止时间或材料；仍可编辑或删除。</small></span></label><div class="form-grid"><label>只自动分析含这些词的消息<input id="llm-include" placeholder="提交,报名,截止（留空处理全部）"></label><label>跳过含这些词的消息<input id="llm-exclude" placeholder="签到成功,红包（英文逗号分隔）"></label></div><label>分类偏好<textarea id="llm-instruction" rows="3" placeholder="例如：重点关注课程作业与比赛报名，日常约饭视为普通聊天。"></textarea></label><div class="detail-actions"><button type="submit" class="primary">保存设置</button><button type="button" class="secondary" data-custom-action data-action="test-llm">保存并读取模型</button><button type="button" class="plain-button" data-custom-action data-action="clear-llm-key">清除 Key</button></div><div id="llm-status" class="settings-status" role="status"></div><div id="models-output" class="models-output" hidden></div></form><aside class="settings-side"><h3>分析如何进行</h3><ol><li>采集端同步你选择的联系人和群聊。</li><li>模型结合上下文，区分待办通知、普通聊天和其他信息。</li><li>你可以查看理由、调整上下文，再确认待办草稿。</li></ol><div class="divider"></div><p>只有目标消息和所选上下文会发送给你配置的模型服务。</p><p>API Key 加密保存在服务端。留空保存会沿用已有 Key。</p></aside></div></div>`;
}
function applyLlmMode(mode, animate = false) {
  if (animate) return uiMotion.relayout($('#model-settings'), () => applyLlmMode(mode));
  if (!$('#model-settings')) return;
  const managed = mode === 'managed' && !!llmCredit?.enabled;
  $('#model-settings').dataset.mode = managed ? 'managed' : 'custom';
  $('#llm-mode').hidden = !llmCredit?.enabled;
  $$('[data-llm-mode]').forEach(b => { const active = b.dataset.llmMode === (managed ? 'managed' : 'custom'); b.classList.toggle('active', active); b.setAttribute('aria-selected', String(active)); b.tabIndex = active ? 0 : -1; });
  $('#llm-managed-panel').hidden = !managed;
  $('#llm-provider-fields').hidden = managed;
  $('#llm-vision-setting').hidden = managed;
  $('#llm-url').required = $('#llm-model').required = !managed;
  $$('[data-custom-action]').forEach(b => b.hidden = managed);
  if (llmCredit) {
    const n = v => Number(v || 0).toLocaleString('zh-CN', {maximumFractionDigits: 3});
    $('#llm-credit-balance').textContent = n(llmCredit.balance);
    $('#llm-managed-vision').textContent = llmCredit.vision_enabled ? '支持图片分析 · 管理员已启用' : '仅支持文本分析 · 由管理员配置';
    $('#llm-credit-note').textContent = '1 积分 = ' + n(llmCredit.tokens_per_credit) + ' tokens';
    $('#llm-checkin-card').hidden = !llmCredit.checkin_enabled;
    $('#llm-checkin-state').textContent = llmCredit.checked_today ? '今日已签到' : '+' + n(llmCredit.checkin_credits) + ' 积分';
    $('#llm-checkin-note').textContent = llmCredit.checked_today ? '明天再来，继续领取积分。' : '每天领取 ' + n(llmCredit.checkin_credits) + ' 积分，用于通知分析和文件整理。';
    $('#llm-checkin-card button').hidden = !!llmCredit.checked_today;
  }
  uiMotion.syncSegments();

}
async function selectLlmMode(mode) {
  const old = llmSettings?.service_mode || (llmSettings?.base_url && llmSettings?.model ? 'custom' : 'managed');
  if (mode === old || !llmSettings) return;
  const host = $('#model-settings'), generation = state.generation;
  applyLlmMode(mode, true);
  $$('[data-llm-mode]').forEach(b => b.disabled = true);
  try {
    const saved = await api('/api/settings/llm', 'PUT', {...llmSettings, service_mode: mode});
    if (!host.isConnected || generation !== state.generation) return;
    llmSettings = saved;
    window.dispatchEvent(new Event('llm-service-changed'));
    $('#llm-mode-status').textContent = mode === 'managed' ? '已使用服务器 AI' : '已使用自定义接口';
  } catch (error) { if (host.isConnected && generation === state.generation) { applyLlmMode(old); $('#llm-mode-status').textContent = error.message; } }
  finally { if (host.isConnected) host.querySelectorAll('[data-llm-mode]').forEach(b => b.disabled = false); }
}
document.addEventListener('click', async event => {
  const tab = event.target.closest('[data-llm-mode]');
  if (tab) return selectLlmMode(tab.dataset.llmMode);
  const button = event.target.closest('[data-credit-checkin]');
  if (!button) return;
  button.disabled = true;
  const generation = state.generation;
  try {
    await api('/api/ai/credit/checkin', 'POST');
    const credit = await api('/api/ai/credit');
    if (generation !== state.generation) return;
    llmCredit = credit;
    if ($('#model-settings')) applyLlmMode($('#model-settings').dataset.mode);
    window.dispatchEvent(new Event('credit-changed'));
    toast('签到成功，积分已到账');
  } catch (error) { toast(error.message); }
  finally { if (button.isConnected) button.disabled = false; }
});
function sourcesView() {
  if (!window.desktop) return heading('触发器', '桌面负责运行触发器，所有设备实时查看结果。') + `<div class="panel">${empty('在电脑上连接触发器', '使用桌面版连接 QQ、微信或插件触发器。<br>这里可以继续查看同步的通知、分析并管理待办。')}</div>`;
  const c = state.sources;
  return heading('触发器', '选择需要关注的会话，把通知带进工作台。') + `<div class="source-grid"><section class="panel source-card"><div class="source-title"><span class="source-mark qq">QQ</span><div><h3>QQ · SnowLuma</h3><small>OneBot v11 · Windows / macOS / Linux</small></div></div><label>HTTP 地址<input id="qq-http" type="url" value="${esc(c.qq_http_url)}"></label><label>WebSocket 地址<input id="qq-ws" type="url" value="${esc(c.qq_ws_url)}"></label><label>Access Token<input id="qq-token" type="password" value="${esc(c.qq_token || '')}" autocomplete="new-password"></label><button class="secondary" data-action="list-qq">读取 QQ 联系人和群</button><div id="qq-conversations">${conversations('qq')}</div></section><section class="panel source-card"><div class="source-title"><span class="source-mark">微</span><div><h3>微信 · 本地数据库</h3><small>Windows · 复用 wechatauto-replica</small></div></div><label>微信账号目录名<input id="wechat-account" value="${esc(c.wechat_account || '')}" placeholder="留空自动识别，读取后固定到该账号"></label><label>微信数据库根目录<input id="wechat-db-dir" value="${esc(c.wechat_db_dir || '')}" placeholder="留空自动检测"></label><p class="helper">微信保持登录即可。采用数据库读取，同步文字、引用和文件卡片信息。</p><button class="secondary" data-action="list-wechat">读取微信最近会话</button><div id="wechat-conversations">${conversations('wechat')}</div></section></div><section class="panel source-global"><div class="form-grid"><label>Python 解释器<input id="python-path" value="${esc(c.python_path || '')}" placeholder="python 或完整的 python.exe 路径"></label><label>仅采集含关键词的消息<input id="capture-keywords" value="${esc(c.capture_keywords || '')}" placeholder="英文逗号分隔，留空同步所选会话全部消息"></label></div><p class="helper">解释器需安装项目依赖。微信接入还需你现有的 wechatauto-replica；QQ 需先运行 SnowLuma。微信首次选择会话从当前时刻开始，后续重启会补读积压消息。</p><div class="source-actions"><button class="primary" data-action="start-collector">保存并启动采集</button><button class="secondary" data-action="stop-collector">停止采集</button><button class="plain-button" data-action="save-sources">仅保存</button></div><div id="collector-status" class="collector-status" role="status">尚未启动采集</div></section>`;
}
function syncLocationHash() {
  const hash = state.page === 'tasks' && state.taskId ? '#/task/' + state.taskId : state.page === 'inbox' && state.selected ? '#/message/' + state.selected : '#/' + state.page;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}
function render() {
  const active = document.activeElement;
  const focus = active?.id;
  const selection = active?.selectionStart;
  const viewKey = state.page + ':' + (state.taskId || '');
  const sameView = $('#view').dataset.viewKey === viewKey;
  const scrollTop = sameView ? $('#view').scrollTop : 0;
  const pageScroll = sameView ? document.scrollingElement.scrollTop : 0;
  const titles = { files:'文件', inbox: '通知', tasks: '待办', shares:'分享', sources: '触发器', agent:'AI', settings: '设置',stats:'统计',plugins:'插件' };
  $('#breadcrumb').textContent = titles[state.page]||window.pluginUI?.title(state.page)||'插件';
  $$('[data-nav]').forEach(button => button.classList.toggle('active', button.dataset.nav === state.page));
  // 分享依赖服务器，离线工作区不显示入口。
  const sharesNav = document.querySelector('[data-nav="shares"]');
  if (sharesNav) sharesNav.hidden = state.session?.mode === 'offline';
  if (state.page !== 'agent') window.agentUI?.unmount();
  window.statistics?.unmount();
  $('#view').innerHTML = state.page.startsWith('plugin:') ? '<div id=plugin-page></div>' : state.page === 'sources' && window.experience ? experience.sourcesView() : ({ files:()=>window.shelf?.page()||'', inbox: inboxView, tasks: tasksView, shares:()=>window.shares?.page()||'', sources: sourcesView, agent:()=>window.agentUI?.page()||'', settings: settingsView,plugins:()=>window.pluginUI?.page()||'',stats:()=>window.statistics.page() })[state.page]();
  hydrateIcons(); updateCounts(); syncLocationHash();
  $('#view').dataset.viewKey = viewKey;
  $('#view').scrollTop = scrollTop;
  uiMotion.syncNavigation();
  if(state.page==='stats')window.statistics?.mount();
  if(state.page==='agent')window.agentUI?.mount();
  if(state.page==='files')window.shelf?.refreshStorage?.();
  if(state.page==='shares')window.shares?.mount();
  state.firstRenderDone = true;
  window.appearance?.refresh(); window.experience?.decorate(state.page);
  if(state.session?.mode!=='offline')window.jjbAdmin?.mount();
  window.accountUI?.mount();
 window.pluginUI?.mount();
  window.pageNavigation?.sync();
  window.dispatchEvent(new CustomEvent('workspace-render', { detail: { page: state.page } }));
  document.scrollingElement.scrollTop = pageScroll;
  if ($('#source-filter')) $('#source-filter').value = state.source;
  if ($('#category-filter')) $('#category-filter').value = state.category;
  if ($('#task-filter')) $('#task-filter').value = state.taskFilter;
  if (focus && document.getElementById(focus)) {
    document.getElementById(focus).focus({preventScroll:true});
    if (selection != null && ['text', 'search'].includes(document.getElementById(focus).type)) document.getElementById(focus).setSelectionRange(selection, selection);
  }
  if (state.page === 'tasks' && state.taskId && !state.taskId.startsWith('local:')) checkTask().catch(() => {});
  if (state.page === 'sources' && window.desktop) desktop.collectorState().then(showCollectorState);
}
function renderDetailOnly(messageId) {
  const holder = document.querySelector('.inbox-grid>.detail');
  if (!holder) return;
  const message = state.snapshot.messages.find(m => m.id === messageId);
  holder.innerHTML = message ? messageDetail(message) : empty('先选一条消息', '通知原文、上下文和分析结果会显示在这里。');
  hydrateIcons();
}
async function navigate(page) {
  const changed=state.page!==page;
  state.page = page; state.search = ''; state.taskId = null;
  if(changed){
    $$('[data-nav]').forEach(button=>{const active=button.dataset.nav===page;button.classList.toggle('active',active);if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});
    uiMotion.syncNavigation();
    await uiMotion.swapPage($('#view'),render);
  }else render();
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
  $('#task-dialog-title').textContent = task.id ? task.conflict ? '确认本机修改并合并' : '编辑待办' : '新建待办';
  $('#task-title').value = task.title || ''; $('#task-description').value = task.description || '';
  $('#task-due').value = dateInput(task.due_at); $('#task-status').value = task.status || 'collecting';
  $('#task-max-size').value = task.max_total_bytes ? task.max_total_bytes / 1024 ** 2 : '';
  $('#task-naming').value = task.naming_hint || ''; $('#task-pattern').value = task.filename_pattern || ''; $('#task-url').value = task.submit_url || '';
  const repeat = task.repeat_rule || {};
  $('#task-repeat').checked = !!repeat.enabled;
  $('#task-repeat-options').hidden = !repeat.enabled;
  $('#task-repeat-interval').value = repeat.interval || 1;
  const repeatFrequency = repeat.frequency || 'weekly';
  $$('#task-repeat-frequency [data-repeat-frequency]').forEach(button => {
    const active = button.dataset.repeatFrequency === repeatFrequency;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  uiMotion.syncSegments();
  $('#task-notes').textContent = (task.notes || []).join(' ');
  (task.requirements || []).forEach(requirementRow);
  editingUrgency = task.id ? (task.urgency || null) : null;
  editingReminders = task.id ? (Array.isArray(task.reminders) ? task.reminders : null) : null;
  uiMotion.openDialog($('#task-dialog')); $('#task-title').focus();
}
function dialogSubmit(dialogId, task) {
  const dialog = document.getElementById(dialogId);
  dialog.addEventListener('submit', () => dialog.classList.remove('closing'), { capture: true, once: false });
}
async function saveTask(event) {
  event.preventDefault();
  const id = $('#edit-task-id').value;
  const body = { title: $('#task-title').value.trim(), description: $('#task-description').value,
    due_at: $('#task-due').value ? new Date($('#task-due').value).toISOString() : null, status: $('#task-status').value,
    requirements: $$('#requirements-editor .requirement-row').map(row => ({ label: row.querySelector('.req-label').value.trim(), extensions: row.querySelector('.req-extensions').value.split(/[,，]/).map(x => x.trim().replace(/^\./, '')).filter(Boolean), min_count: Number(row.querySelector('.req-count').value) })),
    max_total_bytes: $('#task-max-size').value ? Math.round(Number($('#task-max-size').value) * 1024 ** 2) : null,
    naming_hint: $('#task-naming').value, filename_pattern: $('#task-pattern').value, submit_url: $('#task-url').value,
    repeat_rule: { enabled: $('#task-repeat').checked, frequency: $('#task-repeat-frequency .active')?.dataset.repeatFrequency || 'weekly', interval: Number($('#task-repeat-interval').value) || 1 },
    source_message_id: $('#task-source-id').value || null, version: editingVersion,
  };
  const existingPending = state.pending.find(x => (x.taskId || x.localId) === id);
  if (!id || id.startsWith('local:')) body.client_id = existingPending?.body.client_id || crypto.randomUUID();
  $('#task-save').disabled = true; $('#task-error').textContent = '';
  try {
    const saved = await api(id && !id.startsWith('local:') ? '/api/tasks/' + id : '/api/tasks', id && !id.startsWith('local:') ? 'PUT' : 'POST', body);
    state.pending = state.pending.filter(x => x !== existingPending);
    state.snapshot.tasks = state.snapshot.tasks.filter(x => x.id !== id && x.id !== saved.id); state.snapshot.tasks.unshift(saved);
    closableDialog($('#task-dialog')); state.page = 'tasks'; state.taskId = saved.id; cacheSoon(); render(); refresh(); toast('待办已保存');
  } catch (error) {
    if (!error.status && (error instanceof TypeError || error.name === 'TimeoutError')) {
      const localId = id || 'local:' + crypto.randomUUID();
      state.pending = state.pending.filter(x => x !== existingPending);
      state.pending.push({ taskId: id && !id.startsWith('local:') ? id : null, localId, body });
      state.snapshot = applyPending(state.snapshot);
      try { await storeSet('cache-' + state.profile, { snapshot: state.snapshot, pending: state.pending }); }
      catch { $('#task-error').textContent = '本机存储失败，请保留此窗口并检查磁盘空间'; return; }
      closableDialog($('#task-dialog')); state.page = 'tasks'; state.taskId = localId; online(false); cacheSoon(); render(); toast('已保存在本机，恢复连接后自动同步');
    } else $('#task-error').textContent = error.message;
  } finally { $('#task-save').disabled = false; }
}
async function checkTask() {
  const taskId = state.taskId;
  const result = await api('/api/tasks/' + taskId + '/check');
  if (state.taskId !== taskId || !$('#task-check')) return;
  $('#task-check').innerHTML = result.results.map(r => `<div class="check-row"><span class="check-symbol ${r.ok === false ? 'fail' : r.ok === null ? 'manual' : ''}">${r.ok === true ? '✓' : r.ok === false ? '×' : '○'}</span><div><strong>${esc(r.label)}</strong><small>${esc(r.detail)}</small></div></div>`).join('') + `<p class="helper">${result.ready ? '材料检查通过，提交前请再核对内容。' : result.material_count ? '请处理缺失项或人工核对项。' : '添加材料后，会自动核对清单。'}</p>`;
  const task = state.snapshot.tasks.find(t => t.id === taskId);
  if (task) suggestStatus(task, result);
}
const statusSuggestion = { id: null, suppressed: new Set(), timer: null };
function clearStatusSuggestion(taskId) {
  if (!taskId || statusSuggestion.id === taskId) $('#status-suggest')?.remove();
  clearTimeout(statusSuggestion.timer);
  statusSuggestion.timer = null;
  statusSuggestion.id = null;
  syncToastPosition();
}
function suppressStatusSuggestion(taskId) {
  if (taskId) statusSuggestion.suppressed.add(taskId);
  clearStatusSuggestion(taskId);
}
function allowStatusSuggestion(taskId) {
  if (taskId) statusSuggestion.suppressed.delete(taskId);
}
function suggestStatus(task, check, { force = false } = {}) {
  clearStatusSuggestion(task.id);
  if (onboardActive) return;
  if (!force && statusSuggestion.suppressed.has(task.id)) return;
  let target = null, text = '';
  if (check.ready && task.status === 'collecting') { target = 'ready'; text = '材料已齐，把「' + task.title.slice(0, 18) + '」更新为待提交？'; }
  else if (task.status === 'ready' && check.results.some(r => r.ok === false)) { target = 'collecting'; text = '「' + task.title.slice(0, 18) + '」有材料缺失，改回准备材料？'; }
  if (!target) return;
  statusSuggestion.id = task.id;
  const card = document.createElement('div'); card.id = 'status-suggest'; card.className = 'onboard-card'; card.setAttribute('role', 'status');
  card.innerHTML = `<div class="eyebrow">更新待办状态</div><p class="suggest-text">${esc(text)}</p><div class="detail-actions"><button class="plain-button" data-status-suggest="dismiss">暂不</button><span class="flex-spacer"></span><button class="primary" data-status-suggest="apply">更新为${states[target][0]}</button></div>`;
  card.querySelector('[data-status-suggest="apply"]').dataset.target = target;
  document.body.append(card);
  syncToastPosition();
  card.addEventListener('animationend', () => requestAnimationFrame(() => requestAnimationFrame(syncToastPosition)), { once: true });
  statusSuggestion.timer = setTimeout(() => {
    if (card.isConnected && statusSuggestion.id === task.id) clearStatusSuggestion(task.id);
  }, 12000);
}
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-status-suggest]'); if (!button) return;
  if (button.dataset.statusSuggest === 'dismiss') { suppressStatusSuggestion(statusSuggestion.id); return; }
  const task = state.snapshot.tasks.find(t => t.id === statusSuggestion.id);
  clearStatusSuggestion(task?.id);
  if (!task || task.pending) return;
  try {
    const updated = await api('/api/tasks/' + task.id, 'PUT', { ...task, status: button.dataset.target });
    suppressStatusSuggestion(task.id);
    await refresh();
    toast('已更新为' + states[button.dataset.target][0], { label: '撤销', run: async () => { try { await api('/api/tasks/' + task.id, 'PUT', { ...task, status: task.status }); await refresh(); } catch (error) { toast(error.message); } } });
  } catch (error) { toast(error.message); }
});
async function uploadFiles(input, kind, taskId = state.taskId) {
  const files = [...input.files]; input.value = '';
  if (!files.length) return;
  let task = state.snapshot.tasks.find(t => t.id === taskId);
  if(!task||task.pending)throw new Error('请先同步待办后添加文件');
  uploading = true;
  try { for (const file of files) {
    showUploadProgress(file.name, { received: 0, total: file.size, bytesPerSecond: 0 });
    const form = new FormData(); form.append('file', file);
    task = await apiUpload(`/api/tasks/${taskId}/files?version=${task.version}&kind=${kind}`, form, uploadTracker(file.name));
    const index = state.snapshot.tasks.findIndex(t => t.id === taskId); if (index >= 0) state.snapshot.tasks[index] = task;
    allowStatusSuggestion(taskId);
    await refresh({ renderPage: false });
  } } finally { uploading = false; }
  hideUploadProgress();
  cacheSoon(); render(); toast('文件已添加');
}
async function saveDownload(route, name) {
  if (window.mobile) { const saved=await mobile.download(route,name); if(saved)toast('文件已保存'); return; }
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
    const loaded = await api('/api/settings/llm');
    if (!form?.isConnected) return;
    llmSettings = loaded;
    $('#llm-url').value = llmSettings.base_url; $('#llm-model').value = llmSettings.model;
    $('#llm-vision').checked=!!llmSettings.vision_enabled;$('#llm-context').value = llmSettings.context_count; $('#llm-auto').checked = llmSettings.auto_analyze; $('#llm-auto-task').checked=!!llmSettings.auto_task&&llmSettings.auto_analyze;
    $('#auto-task-line').hidden=!llmSettings.auto_analyze;
    $('#llm-include').value = llmSettings.include_keywords; $('#llm-exclude').value = llmSettings.exclude_keywords;
    $('#llm-instruction').value = llmSettings.instruction;
    $('#llm-key-note').textContent = llmSettings.has_key ? '已保存 Key，留空即可沿用。' : '尚未保存 Key，本地免鉴权模型可留空。';
    const credit = await api('/api/ai/credit').catch(() => null);
    if (!form?.isConnected) return;
    llmCredit = credit;
    applyLlmMode(llmSettings.service_mode || (llmSettings.base_url && llmSettings.model ? 'custom' : credit?.enabled ? 'managed' : 'custom'));
    $('#llm-status').textContent = '';
  } catch (error) { toast(error.message); }
  finally { if (form?.isConnected) form.querySelectorAll('input,textarea,button').forEach(input => { input.disabled = false; }); }
}
async function saveLlm() {
  if (!$('#llm-form').reportValidity()) throw new Error('请补全 API 地址与模型');
  const key = $('#llm-key').value;
  const body = { service_mode: $('#model-settings')?.dataset.mode || 'custom', base_url: $('#llm-url').value.trim(), model: $('#llm-model').value.trim(), context_count: Number($('#llm-context').value), auto_analyze: $('#llm-auto').checked, auto_task: $('#llm-auto').checked&&$('#llm-auto-task').checked, vision_enabled:$('#llm-vision').checked, include_keywords: $('#llm-include').value.replaceAll('，', ','), exclude_keywords: $('#llm-exclude').value.replaceAll('，', ','), instruction: $('#llm-instruction').value };
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
  value={...value,message:String(value.message||'').replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'')};
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
    case 'close-task': return closableDialog($('#task-dialog'));
    case 'add-requirement': return requirementRow();
    case 'paste': $('#paste-content').value = ''; return uiMotion.openDialog($('#paste-dialog'));
    case 'close-paste': return closableDialog($('#paste-dialog'));
    case 'close-rename': return closableDialog($('#rename-dialog'));
    case 'back-inbox': state.selected = null; return render();
    case 'back-tasks': state.taskId = null; return render();
    case 'clear-context': state.contexts.clear(); return render();
    case 'message-task': {
      const draft = message.analysis || message.draft;
      return openTask({ ...draft, description: message.text, title: draft.title || message.draft.title }, message.id);
    }
    case 'analyze': {
      if (state.busyAnalysis.has(message.id) || (!message.analysis && message.analysis_pending)) return;
      const body = { message_id: message.id, context_count: Number($('#context-count').value) };
      if (state.contexts.size) body.context_ids = [...state.contexts].filter(id => id !== message.id);
      const analysisGeneration=state.generation;state.busyAnalysis.add(message.id); render();
      try { const result = await liveAnalysis.run('/api/analyze',body,'message:'+message.id);if(analysisGeneration!==state.generation)return; const current=state.snapshot.messages.find(m=>m.id===message.id);if(current){current.analysis=result;delete current.analysis_pending;delete current.analysis_error;current.analysis_state='done';}cacheSoon();toast('分析完成，确认后可生成待办'); }
      finally { state.busyAnalysis.delete(message.id); if (state.page === 'inbox') render(); }
      return;
    }
    case 'cancel-analysis': return window.liveAnalysis?.cancel('message:'+message.id);
    case 'ignore-message': {
      const target = message || state.snapshot.messages.find(m => m.id === runAction.sourceId);
      if (!target) return;
      const previous = target.triage || 'unread';
      await api('/api/messages/' + target.id + '/triage', 'PUT', { state: target.triage === 'ignored' ? 'unread' : 'ignored' });
      await refresh();
      if (previous !== 'ignored') toast('已忽略「' + (target.conversation_name || '通知') + '」', { label: '撤销', run: async () => { try { await api('/api/messages/' + target.id + '/triage', 'PUT', { state: previous }); await refresh(); } catch (error) { toast(error.message); } } });
      return;
    }
    case 'delete-message': {
      const target = message || state.snapshot.messages.find(m => m.id === runAction.sourceId);
      if (!target) return;
      if (!confirm('把「' + (target.conversation_name || '通知') + '」移入回收站？内容会保留 30 天，可随时恢复。')) return;
      await api('/api/messages/' + target.id, 'DELETE');
      state.snapshot.messages = state.snapshot.messages.filter(item => item.id !== target.id);
      state.contexts.delete(target.id);
      if (state.selected === target.id) state.selected = null;
      cacheSoon();
      render();
      await refresh();
      toast('通知已移入回收站', { label: '查看', run: () => window.productivity?.open('recycle') });
      return;
    }
    case 'undo-pending': {
      state.pending = state.pending.filter(x => (x.taskId || x.localId) !== pendingUndoId);
      cacheSoon(); await refresh(); return toast('已撤销，云端版本保持不变');
    }
    case 'more-messages': {
      const oldest = state.snapshot.messages.at(-1); const rows = await api('/api/messages?limit=100' + (oldest ? '&before=' + oldest.id : ''));
      const ids = new Set(state.snapshot.messages.map(m => m.id)); state.snapshot.messages.push(...rows.filter(m => !ids.has(m.id))); cacheSoon(); render(); if (!rows.length) toast('没有更早的消息了'); return;
    }
    case 'set-status': {
      if (!task || task.pending) return;
      const target = runAction.sourceId;
      if (!['collecting', 'ready', 'submitted'].includes(target)) return;
      const previousStatus = task.status;
      await api('/api/tasks/' + task.id, 'PUT', { ...task, status: target });
      suppressStatusSuggestion(task.id);
      if (target === 'submitted') showDoneBurst();
      await refresh();
      toast(target === 'submitted' ? '已标记提交' : '已更新为' + states[target][0], { label: '撤销', run: async () => { try { await api('/api/tasks/' + task.id, 'PUT', { ...task, status: previousStatus }); await refresh(); } catch (error) { toast(error.message); } } });
      return;
    }
    case 'set-urgency': {
      if (!task || task.pending) return;
      const target = runAction.sourceId;
      if (!['high', 'normal', 'low'].includes(target)) return;
      await api('/api/tasks/' + task.id, 'PUT', { ...task, urgency: target });
      await refresh(); toast('紧急度已更新'); return;
    }
    case 'remove-reminder': {
      if (!task || task.pending) return;
      const remaining = (task.reminders || []).filter(r => r !== runAction.sourceId);
      await api('/api/tasks/' + task.id, 'PUT', { ...task, reminders: remaining });
      await refresh(); toast('提醒已移除'); return;
    }
    case 'check-task': allowStatusSuggestion(task?.id); return checkTask();
    case 'package': return saveDownload('/api/tasks/' + task.id + '/package', task.title.replace(/[<>:"/\\|?*]/g, '_') + '.zip');
    case 'delete-task': {
      if(!task||task.pending)return;
      if(!confirm('把待办“'+task.title+'”移入回收站？\n相关材料和回执会保留 30 天，可随时恢复。'))return;
      await api('/api/tasks/'+task.id+'?version='+task.version,'DELETE');
      state.snapshot.tasks=state.snapshot.tasks.filter(t=>t.id!==task.id);
      state.snapshot.shelf=(state.snapshot.shelf||[]).filter(f=>f.task_id!==task.id);
      state.taskId=null;cacheSoon();render();await refresh();toast('待办已移入回收站',{label:'查看',run:()=>window.productivity?.open('recycle')});return;
    }
    case 'show-archived': state.taskId=null;state.taskFilter='archived';render();return;
    case 'mark-submitted': case 'archive-task': case 'restore-task': {
      const previousStatus = task.status;
      const updated=await api('/api/tasks/' + task.id, 'PUT', { ...task, status: action === 'mark-submitted' ? 'submitted' : action==='restore-task'?'collecting':'archived' });
      suppressStatusSuggestion(task.id); await refresh();
      if (action === 'mark-submitted') showDoneBurst();
      toast(action === 'mark-submitted' ? '已标记提交' : action==='restore-task'?'已恢复为准备材料':'待办已归档', { label: '撤销', run: async () => { try { await api('/api/tasks/' + task.id, 'PUT', { ...updated, status: previousStatus }); await refresh(); } catch (error) { toast(error.message); } } });
      return;
    }
    case 'discard-conflict': state.pending = state.pending.filter(x => (x.taskId || x.localId) !== task.id); cacheSoon(); await refresh(); return;
    case 'test-llm': {
      await saveLlm(); $('#llm-status').textContent = '正在读取模型列表…';
      const result = await api('/api/settings/llm/test', 'POST');
      $('#model-options').innerHTML = result.models.map(model => `<option value="${esc(model)}"></option>`).join('');
      $('#models-output').hidden = false; $('#models-output').textContent = result.models.length ? result.models.join(' · ') : '接口连通，未返回模型列表，可手动填写模型名。'; $('#llm-status').textContent = '连接成功'; return;
    }
    case 'clear-llm-key': {
      if (!llmSettings) return;
      const backup = { ...llmSettings };
      await api('/api/settings/llm', 'PUT', { ...llmSettings, api_key: '' }); $('#llm-key').value = ''; await loadLlm();
      return toast('Key 已清除', { label: '撤销', run: async () => { try { await api('/api/settings/llm', 'PUT', { ...backup, api_key: backup.has_key ? '____RESTORE____' : '' }); await loadLlm(); } catch { toast('无法恢复 Key，请重新填写'); } } });
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
    const rowAction = event.target.closest('[data-row-action]');
    if (rowAction) { runAction.sourceId = rowAction.dataset.id; return await runAction(rowAction.dataset.rowAction, rowAction); }
    const row = event.target.closest('[data-message]');
    if (row) {
      // 就地切换选中态，不重建列表 DOM，保持滚动位置与勾选状态。
      const id = row.dataset.message;
      if (state.selected === id) return;
      state.selected = id;
      const list = row.closest('.message-list');
      const previous = list?.querySelector('.message-row.selected');
      if (previous) previous.classList.remove('selected');
      row.classList.add('selected');
      const grid = row.closest('.inbox-grid');
      if (grid && !grid.classList.contains('has-selection')) {
        // 移动端首次选中：需要切换双栏显示，此时才整页重绘。
        return render();
      }
      renderDetailOnly(id);
      syncLocationHash();
      return;
    }
    const card = event.target.closest('[data-task]'); if (card) { state.taskId = card.dataset.task; return render(); }
    const action = event.target.closest('[data-action]'); if (action) { runAction.sourceId = null; return await runAction(action.dataset.action, action); }
    const urgencyStep = event.target.closest('[data-set-urgency]');
    if (urgencyStep) { runAction.sourceId = urgencyStep.dataset.setUrgency; return await runAction('set-urgency'); }
    const removeReminder = event.target.closest('[data-remove-reminder]');
    if (removeReminder) { runAction.sourceId = removeReminder.dataset.removeReminder; return await runAction('remove-reminder'); }
    const statusStep = event.target.closest('[data-set-status]');
    if (statusStep) { runAction.sourceId = statusStep.dataset.setStatus; return await runAction('set-status'); }
    const remove = event.target.closest('.remove-requirement'); if (remove) return remove.parentElement.remove();
    const file = event.target.closest('[data-download]'); if (file) return await saveDownload('/api/files/' + file.dataset.download, file.dataset.name);
    const changeKind=event.target.closest('[data-change-kind]');if(changeKind){allowStatusSuggestion(state.taskId);await api(`/api/tasks/${state.taskId}/files/${changeKind.dataset.changeKind}/kind`,'PUT',{kind:changeKind.dataset.nextKind,version:Number(changeKind.dataset.version)});await refresh();toast(changeKind.dataset.nextKind==='material'?'已转为待办材料，并重新核对清单':'已转为提交回执');return;}
    const renamed = event.target.closest('[data-rename-file]'); if (renamed) {
      $('#rename-form').dataset.fileId = renamed.dataset.renameFile; $('#rename-form').dataset.version = renamed.dataset.version;
      $('#rename-form').dataset.taskId = state.taskId; $('#rename-name').value = renamed.dataset.name; $('#rename-error').textContent = ''; uiMotion.openDialog($('#rename-dialog')); $('#rename-name').focus();
      return;
    }
    const deleted = event.target.closest('[data-delete-file]');
    if (deleted) {
      const version=deleted.dataset.version,fileId=deleted.dataset.deleteFile;
      if(!confirm('把这份云端文件移入回收站？电脑中的原文件会保留，30 天内可恢复。'))return;
      allowStatusSuggestion(state.taskId);
      await api(`/api/tasks/${state.taskId}/files/${fileId}?version=${version}`,'DELETE');await refresh();toast('文件已移入回收站，本机原文件保留');
      return;
    }
    const external = event.target.closest('[data-external]'); if (external) {
      const url = new URL(external.dataset.external); if (!['http:', 'https:'].includes(url.protocol)) return;
      if (window.desktop) await desktop.external(url.href); else window.open(url.href, '_blank', 'noopener,noreferrer');
    }
  } catch (error) { toast(error.message || '操作失败，请重试'); }
});
function showDoneBurst() {
  const holder = document.createElement('div'); holder.className = 'done-burst';
  holder.innerHTML = '<svg viewBox="0 0 72 72"><circle cx="36" cy="36" r="33"/><path d="m23 37 9 9 17-19"/></svg>';
  document.body.append(holder); setTimeout(() => holder.remove(), 1300);
}
const CMDK_COMMANDS = [
  { icon: 'inbox', label: '前往：通知', kbd: 'G I', run: () => navigate('inbox') },
  { icon: 'check', label: '前往：待办', kbd: 'G T', run: () => navigate('tasks') },
  { icon: 'connect', label: '前往：触发器', kbd: 'G S', run: () => navigate('sources') },
  { icon: 'agent', label: '前往：AI 助手', kbd: 'G A', run: () => navigate('agent') },
  { icon: 'settings', label: '前往：设置', kbd: 'G C', run: () => navigate('settings') },
  { icon: 'plus', label: '新建待办', kbd: 'N', run: () => { state.page = 'inbox'; render(); openTask(); } },
  { icon: 'file', label: '粘贴一条通知', kbd: 'P', run: () => { state.page = 'inbox'; render(); $('#paste-content').value = ''; uiMotion.openDialog($('#paste-dialog')); } },
  { icon: 'refresh', label: '立即同步', kbd: 'R', run: () => { refresh(); flushOutbox(); } },
  { icon: 'connect', label: '打开文件收纳框', kbd: 'F', run: () => window.shelf?.show() },
  { icon: 'search', label: '搜索全部内容', kbd: 'CTRL SHIFT F', run: () => window.productivity?.open('search') },
  { icon: 'check', label: '打开待办模板', kbd: 'TEMPLATES', run: () => window.productivity?.open('templates') },
  { icon: 'file', label: '打开回收站', kbd: 'TRASH', run: () => window.productivity?.open('recycle') },
];
let cmdkOpen = false, cmdkItems = [], cmdkReturnFocus = null, cmdkCloseGeneration = 0;
function cmdkFilter(query) {
  const q = query.trim().toLowerCase();
  const all = [...CMDK_COMMANDS, ...window.pluginUI?.commands() || []];
  return !q ? all : all.filter(c => c.label.toLowerCase().includes(q) || c.kbd.toLowerCase().includes(q));
}
function cmdkRender() {
  const list = $('#cmdk-list');
  list.innerHTML = cmdkItems.length ? cmdkItems.map((c, i) => `<button class="cmdk-item ${i === state.cmdkIndex ? 'active' : ''}" id="cmdk-option-${i}" data-cmdk="${i}" role="option" tabindex="-1" aria-selected="${i === state.cmdkIndex}"><span data-icon="${c.icon}"></span>${esc(c.label)}<kbd>${c.kbd}</kbd></button>`).join('') : '<div class="cmdk-empty">没有匹配的命令</div>';
  hydrateIcons();
  const active = list.querySelector('.cmdk-item.active');
  if(active){
    $('#cmdk-input').setAttribute('aria-activedescendant',active.id);
    const item=active.getBoundingClientRect(),bounds=list.getBoundingClientRect();
    if(item.top<bounds.top)list.scrollTop-=bounds.top-item.top;
    else if(item.bottom>bounds.bottom)list.scrollTop+=item.bottom-bounds.bottom;
  }else $('#cmdk-input').removeAttribute('aria-activedescendant');
}
function syncCommandPaletteBounds() {
  if (innerWidth > 620) return;
  const topbar = $('.main .topbar'), nav = $('.workspace > .sidebar');
  const viewport = window.visualViewport;
  const height = Math.round(viewport?.height || innerHeight || 0);
  const offsetTop = Math.round(viewport?.offsetTop || 0);
  const root = document.documentElement.style;
  if (height > 0) root.setProperty('--jjb-viewport-height', height + 'px');
  root.setProperty('--jjb-viewport-offset-top', offsetTop + 'px');
  if (topbar) root.setProperty('--jjb-mobile-topbar-bottom', Math.ceil(topbar.getBoundingClientRect().bottom) + 'px');
  if (nav) root.setProperty('--jjb-mobile-nav-offset', Math.ceil(innerHeight - nav.getBoundingClientRect().top) + 'px');
}
function cmdkShow() {
  if (!state.session || cmdkOpen || document.querySelector('dialog[open]')) return;
  ++cmdkCloseGeneration;
  cmdkReturnFocus=document.activeElement;
  $('#workspace').inert=true;document.body.classList.add('cmdk-open');
  cmdkOpen = true; state.cmdkIndex = 0; cmdkItems = cmdkFilter('');
  syncCommandPaletteBounds();
  const backdrop = $('#cmdk-backdrop');
  const panel = backdrop.querySelector('.cmdk');
  backdrop.hidden = false;
  $('#cmdk-input').value = ''; cmdkRender(); $('#cmdk-input').focus();
  if (window.uiMotion) return uiMotion.openSurface(panel, backdrop);
  backdrop.classList.add('show');
  return Promise.resolve();
}
function cmdkHide() {
  if (!cmdkOpen && $('#cmdk-backdrop').hidden) return Promise.resolve();
  cmdkOpen = false;
  const backdrop = $('#cmdk-backdrop');
  $('#workspace').inert=false;document.body.classList.remove('cmdk-open');
  if(cmdkReturnFocus?.isConnected)cmdkReturnFocus.focus({preventScroll:true});
  const generation = ++cmdkCloseGeneration;
  const finish = () => { if (!cmdkOpen && generation === cmdkCloseGeneration) backdrop.hidden = true; };
  if (window.uiMotion) return uiMotion.closeSurface(backdrop.querySelector('.cmdk'), backdrop).then(finish, finish);
  backdrop.classList.remove('show'); finish();
  return Promise.resolve();
}
function cmdkExecute(index) {
  const item = cmdkItems[index];
  if (!item) return;
  cmdkHide();
  Promise.resolve().then(() => item.run()).catch(error => toast(error?.message || '命令执行失败'));
}
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    window.productivity?.open('search');
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    return cmdkOpen ? cmdkHide() : cmdkShow();
  }
  if (cmdkOpen) {
    if (event.key === 'Tab') { event.preventDefault();$('#cmdk-input').focus();return; }
    if (event.key === 'Escape') { event.preventDefault(); return cmdkHide(); }
    if (event.key === 'ArrowDown') { event.preventDefault(); state.cmdkIndex = Math.min(state.cmdkIndex + 1, cmdkItems.length - 1); return cmdkRender(); }
    if (event.key === 'ArrowUp') { event.preventDefault(); state.cmdkIndex = Math.max(state.cmdkIndex - 1, 0); return cmdkRender(); }
    if (event.key === 'Enter') { event.preventDefault(); return cmdkExecute(state.cmdkIndex); }
    return;
  }
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || event.target.isContentEditable;
  if (typing || !state.session || $('#task-dialog').open || $('#paste-dialog').open || $('#rename-dialog').open) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const key = event.key.toLowerCase();
  const shelfOpen = document.body.classList.contains('shelf-open');
  if (key === 'g' && !shelfOpen) { awaitG = !awaitG; setTimeout(() => { awaitG = false; }, 1200); return; }
  if (awaitG && !shelfOpen) {
    awaitG = false;
    const goto = { i: 'inbox', t: 'tasks', s: 'sources', a: 'agent', c: 'settings' }[key];
    if (goto) { event.preventDefault(); return navigate(goto); }
    return;
  }
  if (shelfOpen) return;
  if (state.page === 'inbox') {
    const rows = filteredMessages();
    if (['j', 'arrowdown'].includes(key)) { event.preventDefault(); const next = rows[rows.findIndex(m => m.id === state.selected) + 1] || rows[0]; if (next) { state.selected = next.id; render(); } return; }
    if (['k', 'arrowup'].includes(key)) { event.preventDefault(); const index = rows.findIndex(m => m.id === state.selected); const prev = rows[index <= 0 ? rows.length - 1 : index - 1]; if (prev) { state.selected = prev.id; render(); } return; }
    if (key === 'e' && state.selected) { event.preventDefault(); runAction.sourceId = state.selected; return runAction('ignore-message'); }
    if (key === 't' && state.selected) { event.preventDefault(); const message = state.snapshot.messages.find(m => m.id === state.selected); if (!message) return; const draft = message.analysis || message.draft; return openTask({ ...draft, description: message.text, title: draft.title || message.draft.title }, message.id); }
    if (key === 'enter' && state.selected) { event.preventDefault(); return render(); }
  }
  if (state.page === 'tasks' && key === 'n') { event.preventDefault(); return openTask(); }
  if (key === 'f' && !shelfOpen) { event.preventDefault(); return window.shelf?.show(); }
});
const closableDialog = dialog => uiMotion.closeDialog(dialog);
document.addEventListener('click', event => {
  const closer = event.target.closest('[data-action="close-task"]');
  if (closer) { event.preventDefault(); return closableDialog($('#task-dialog')); }
  const paste = event.target.closest('[data-action="close-paste"]');
  if (paste) { event.preventDefault(); return closableDialog($('#paste-dialog')); }
  const rename = event.target.closest('[data-action="close-rename"]');
  if (rename) { event.preventDefault(); return closableDialog($('#rename-dialog')); }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.target.matches('[data-message],[data-task]')) { event.preventDefault(); event.target.click(); }
  if (event.key === 'Escape') ['task-dialog', 'paste-dialog', 'rename-dialog'].forEach(id => { const d = document.getElementById(id); if (d.open) { event.preventDefault(); closableDialog(d); } });
});
let awaitG = false;
$('#cmdk-input').addEventListener('input', event => { cmdkItems = cmdkFilter(event.target.value); state.cmdkIndex = 0; cmdkRender(); });
$('#cmdk-backdrop').addEventListener('click', event => { if (event.target.id === 'cmdk-backdrop') cmdkHide(); });
$('#cmdk-list').addEventListener('click', event => { const item = event.target.closest('[data-cmdk]'); if (item) cmdkExecute(Number(item.dataset.cmdk)); });
function applyHashRoute() {
  if (!state.session) return;
  const hash = location.hash.replace(/^#\/?/, '');
  if (hash.startsWith('task/')) { const id = hash.slice(5); if (state.snapshot.tasks.some(t => t.id === id)) { state.page = 'tasks'; state.taskId = id; render(); return true; } }
  if (hash.startsWith('message/')) { const id = hash.slice(8); if (state.snapshot.messages.some(m => m.id === id)) { state.page = 'inbox'; state.selected = id; render(); return true; } }
  if(hash==='shares'&&state.session.mode!=='offline'){state.page='shares';render();return true;}
  if(hash==='stats'){state.page='stats';render();return true;}
  return false;
}
window.jjbOpenTask = async id => {
  if (!id) return;
  location.hash = '#/task/' + id;
  if (!state.session) return;
  if (!state.snapshot.tasks.some(t => t.id === id)) {
    try { await refresh(); } catch {}
  }
  if (state.snapshot.tasks.some(t => t.id === id)) {
    state.page = 'tasks'; state.taskId = id; render();
  }
};
window.addEventListener('hashchange', () => applyHashRoute());
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
    if (event.target.id === 'reminder-preset') {
      const task = state.snapshot.tasks.find(t => t.id === state.taskId); if (!task) return;
      const custom = $('#reminder-custom'); custom.hidden = event.target.value !== 'custom';
      if (event.target.value === 'custom') return;
      const iso = reminderIso(task, event.target.value);
      if (!iso) return;
      const reminders = [...(task.reminders || []), iso].sort();
      await api('/api/tasks/' + task.id, 'PUT', { ...task, reminders });
      await refresh(); toast('提醒已添加'); return;
    }
    if (['material-upload', 'receipt-upload'].includes(event.target.id)) { /* handled below */ }    if (event.target.id === 'material-upload') await uploadFiles(event.target, 'material');
    if (event.target.id === 'receipt-upload') await uploadFiles(event.target, 'receipt');    if (event.target.id === 'reminder-custom') {
      const task = state.snapshot.tasks.find(t => t.id === state.taskId); if (!task || !event.target.value) return;
      const iso = reminderIso(task, 'custom', event.target.value);
      if (!iso) return;
      const reminders = [...(task.reminders || []), iso].sort();
      await api('/api/tasks/' + task.id, 'PUT', { ...task, reminders });
      await refresh(); toast('提醒已添加'); return;
    }
  } catch (error) { toast(error.message); }
});
$('#task-form').addEventListener('submit', saveTask);
$('#rename-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.target; const button = form.querySelector('[type=submit]'); button.disabled = true;
  try { allowStatusSuggestion(form.dataset.taskId); await api(`/api/tasks/${form.dataset.taskId}/files/${form.dataset.fileId}`, 'PUT', {name:$('#rename-name').value.trim(),version:Number(form.dataset.version)}); closableDialog($('#rename-dialog')); await refresh(); toast('文件名已保存'); }
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
    state.selected = result.id; closableDialog($('#paste-dialog')); state.page = 'inbox'; await refresh();
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
    const server = url.href.replace(/\/$/, ''); const credentials = { username: $('#username').value.trim(), password: $('#password').value, invitation_code: $('#invitation-code').value.trim() };
    async function call(route) {
      const response = await fetch(server + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials), signal: AbortSignal.timeout(20000) });
      const data = await response.json(); if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '请检查用户名与密码'); return data;
    }
    if (state.isRegister) {const registration=await call('/api/auth/register');if(registration.verification_required){$('#auth-error').textContent=registration.message;$('#password').value='';return;}}
    const result = await call('/api/auth/login'); const session = { ...result, server };
    if (window.desktop) await storeSet('session', session); else localStorage.setItem('jjb-session', JSON.stringify(session));
    $('#password').value = ''; await enter(session);
  } catch (error) { $('#auth-error').textContent = error instanceof TypeError ? '无法连接服务端，请检查地址与网络。' : error.message; }
  finally { $('#auth-submit').disabled = false; }
});
$('#logout').addEventListener('click', async () => {
  if (state.pending.length && !confirm(`还有 ${state.pending.length} 项修改未同步，本机草稿会保留。仍要退出吗？`)) return;
  try { await api('/api/auth/logout', 'POST'); } catch { /* 离线仍可退出本机。 */ }
  state.generation++;window.liveAnalysis?.cancelAll();window.statistics?.unmount();window.shelf?.reset();clearTimeout(reconnectTimer); clearTimeout(cacheTimer); state.socket?.close();
  if (window.desktop) { await desktop.stopCollector(); await desktop.remove('session'); } else localStorage.removeItem('jjb-session');
  window.pluginUI?.stop();state.session = null; state.selected = null; state.contexts.clear(); state.pending = []; state.snapshot = { tasks: [], messages: [], cursor: 0 };
  $('#workspace').hidden = true; $('#auth').hidden = false;
  if (window.mobile) await mobile.logout();
});
$('#refresh').addEventListener('click', () => { refresh(); flushOutbox(); });
window.addEventListener('online', () => { refresh(); flushOutbox(); if (!state.socket || state.socket.readyState > 1) syncSocket(); });
window.addEventListener('offline', () => online(false));
window.desktop?.onCollector(showCollectorState);
setInterval(() => { if (state.session) { refresh({ renderPage: false }); if (state.pending.length) flushOutbox(); } }, 30000);
(async () => {
  hydrateIcons();
  if(window.desktop){try{appearance.restore(await desktop.getAppearance());}catch{}}
  $('#server-url').value = window.desktop ? 'https://jiaojianbox.bansonic.top' : location.origin;
  try {
    const session = window.desktop ? await storeGet('session') : JSON.parse(localStorage.getItem('jjb-session') || 'null');
    if (session) {if(session.mode==='offline'&&window.desktop){const current=await desktop.offlineStart();await storeSet('session',current);return await enter(current);}return await enter(session);}
  } catch (error) { toast(error.message); }
  $('#auth').hidden = false;
  window.experience?.prepareLogin();
})();
