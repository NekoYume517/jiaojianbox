const { app, BrowserWindow, ipcMain, protocol, net, safeStorage, dialog, shell, Menu, nativeTheme, screen } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createWriteStream } = require('node:fs');
const {EdgeWindow}=require('./edge-window.cjs');
const {QQManager,READ_ACTIONS}=require('./qq-manager.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
if (process.env.JJB_USER_DATA) app.setPath('userData', process.env.JJB_USER_DATA);
const single=app.requestSingleInstanceLock();if(!single)app.quit();
app.on('second-instance',()=>{window?.show();window?.focus();});
let window, collector, collectorState = { state: 'stopped' };
const storageWrites = new Map();
const sourceRoot = path.resolve(__dirname, '..');
const collectorRoot = app.isPackaged ? path.join(process.resourcesPath, 'python') : sourceRoot;
const allowedAssets = new Set(['index.html', 'app.css', 'select-arrow.css', 'app.js', 'analysis.js', 'statistics.js', 'vendor/echarts.min.js', 'theme.js', 'experience.js', 'shelf.js', 'icon.svg', 'edge.html', 'edge.css', 'edge.js']);
let appearance = { theme: 'system', density: 'comfortable', textSize: 'normal' };
let qqManager,edgeWindow;
const bridgeRoot=app.isPackaged?path.join(process.resourcesPath,"bridge"):path.join(sourceRoot,"desktop");
function normalizeAppearance(value) {
  return {theme:['system','light','dark'].includes(value?.theme)?value.theme:'system', density:['comfortable','compact'].includes(value?.density)?value.density:'comfortable',textSize:['normal','large'].includes(value?.textSize)?value.textSize:'normal'};
}
function updateNativeAppearance() {
  const dark=nativeTheme.shouldUseDarkColors;
  window?.setBackgroundColor(dark?'#101914':'#f5f7f3');
  if(process.platform==='win32' && window)window.setTitleBarOverlay({color:dark?'#141f19':'#eff3ed',symbolColor:dark?'#dce9df':'#34483a',height:40});
  if(window&&!window.isDestroyed())window.webContents.send('appearance-updated',appearance);
}

function validateSender(event) {
  if (event.senderFrame !== window?.webContents.mainFrame || !event.senderFrame.url.startsWith('app://jiaojianbox/')) throw new Error('请求来源无效');
}
function publishState(value) {
  const sources = value.source ? { ...(collectorState.sources || {}), [value.source]: value } : {};
  collectorState = { ...collectorState, ...value, sources, at: new Date().toISOString() };
  if(window&&!window.isDestroyed()&&!window.webContents.isDestroyed())window.webContents.send('collector-state', collectorState);
}
async function storageFile(key) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(key)) throw new Error('存储键无效');
  const directory = path.join(app.getPath('userData'), 'vault');
  await fs.mkdir(directory, { recursive: true });
  return path.join(directory, key + '.bin');
}
async function put(key, value) {
  const previous = storageWrites.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => writeEncrypted(key, value));
  storageWrites.set(key, next);
  try { return await next; } finally { if (storageWrites.get(key) === next) storageWrites.delete(key); }
}
async function writeEncrypted(key, value) {
  if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('系统凭据存储不可用，无法保存登录信息');
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') throw new Error('请启用系统密钥环后保存凭据');
  const file = await storageFile(key);
  const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(value));
  await fs.writeFile(file + '.tmp', encrypted, { mode: 0o600 });
  await fs.rename(file + '.tmp', file);
}
async function get(key) {
  try {
    const result = await safeStorage.decryptStringAsync(await fs.readFile(await storageFile(key)));
    return JSON.parse(result.result);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('无法读取本机加密数据，请重新登录');
  }
}
async function stopCollector() {
  if (collector) {
    const child = collector;
    collector = null;
    child.kill();
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 1500))]);
  }
  publishState({ state: 'stopped', message: '采集已停止' });
}
function runPython(command, config, onEvent) {
  const python = config.python_path || (app.isPackaged?path.join(process.resourcesPath,'runtime','python','python.exe'):null) || (process.platform === 'win32' ? 'python' : 'python3');
  const child = spawn(python, ['-u', '-m', 'collector.agent', command, '--state-dir', path.join(app.getPath('userData'), 'collector')], {
    cwd: collectorRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(config) + '\n');
  child.stdout.setEncoding('utf8');
  let pending = '';
  child.stdout.on('data', chunk => {
    pending += chunk.toString('utf8');
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      try { onEvent(JSON.parse(line)); } catch { /* 底座库的非 JSON 输出不进入界面。 */ }
    }
  });
  // 底座库诊断可能包含本地路径或数据库信息，不转发到聊天或云端。
  child.stderr.on('data', () => {});
  return child;
}

function installHandlers() {
  const handle = (name, fn) => ipcMain.handle(name, (event, ...args) => { validateSender(event); return fn(...args); });
  handle('local-get', get);
  handle('local-set',async(key,value)=>{await put(key,value);if(key==='session')edgeWindow?.resetSession();});
  handle('local-remove',async key=>{await fs.rm(await storageFile(key),{force:true});if(key==='session')edgeWindow?.resetSession();});
  handle('platform', () => ({ platform: process.platform, version: app.getVersion(), nativeTitlebar:process.platform==='win32' }));
  handle('appearance-get',()=>appearance);
  handle('appearance-set',async value=>{
    appearance=normalizeAppearance(value);
    nativeTheme.themeSource=appearance.theme;
    updateNativeAppearance();
    await fs.mkdir(app.getPath('userData'),{recursive:true});
    await put('appearance',appearance);
    return appearance;
  });
  handle('open-external', async value => {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('链接无效');
    await shell.openExternal(url.href);
  });
  handle('collector-state', () => collectorState);
  handle('qq-discover',preferred=>qqManager.discover(preferred));
  handle('qq-connect',async ({pid,home})=>{const account=await qqManager.attach(pid,home);return{...account,...await qqManager.contacts(account.uin)};});
  handle('source-diagnostics',async()=>{let wechat=[];try{wechat=(await fs.readFile(path.join(app.getPath('userData'),'collector','wechat-diagnostics.jsonl'),'utf8')).trim().split('\n').slice(-10).map(line=>JSON.parse(line));}catch{}return {...qqManager.diagnostics(),collector:collectorState,wechat_errors:wechat};});
  handle('qq-debug',async({uin,action,params})=>{
    if(!READ_ACTIONS.has(action))throw new Error('仅支持读取类调试动作');
    return qqManager.call('action',{uin,action,params});
  });
  handle('select-runtime',async()=>{const selected=await dialog.showOpenDialog(window,{title:'选择已安装的 SnowLuma 目录',properties:['openDirectory']});return selected.canceled?null:selected.filePaths[0];});
  handle('collector-list', (type, config) => new Promise((resolve, reject) => {
    if (!['qq', 'wechat'].includes(type)) return reject(new Error('来源无效'));
    if (type === 'wechat' && process.platform !== 'win32') return reject(new Error('微信数据库接入目前仅支持 Windows'));
    let result;
    const child = runPython('list-' + type, config, value => { result = value; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('读取超时，请确认已登录且 Python 已安装依赖')); }, 90000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('无法启动 Python，请在设置中填写解释器路径')); });
    child.once('exit', code => { clearTimeout(timer); code === 0 && result?.conversations ? resolve(result) : reject(new Error(result?.message || '读取失败，请检查登录状态、端口和 Python 依赖')); });
  }));
  handle('collector-start', async config => {
    config=await qqManager.prepare(config);
    await stopCollector();
    if (!config.server_token || !config.user_id) throw new Error('请先登录');
    collector = runPython('run', config, publishState);
    collector.once('error', () => publishState({ state: 'error', message: '无法启动 Python，请检查解释器路径' }));
    const active = collector;
    collector.once('exit', code => { if (collector === active) { collector = null; publishState({ state: 'stopped', message: `采集进程已退出（${code}）` }); } });
    publishState({ state: 'starting', message: '正在连接所选会话' });
    return { ok: true };
  });
  handle('collector-stop', stopCollector);
  handle('download-file', async ({ route, name }) => {
    if (!/^\/api\/(files\/[0-9a-f-]{36}|tasks\/[0-9a-f-]{36}\/package)$/.test(route)) throw new Error('下载路径无效');
    const session = await get('session');
    if (!session?.token) throw new Error('请先登录');
    const result = await dialog.showSaveDialog(window, { defaultPath: path.basename(name || '交件材料.zip') });
    if (result.canceled || !result.filePath) return false;
    const temporary = result.filePath + '.' + crypto.randomUUID() + '.partial';
    try {
      const response = await fetch(session.server.replace(/\/$/, '') + route, { headers: { Authorization: 'Bearer ' + session.token }, redirect: 'error' });
      if (!response.ok) throw new Error('下载失败，请刷新登录状态后重试');
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }));
      await fs.rename(temporary, result.filePath);
      return true;
    } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  });
}

app.whenReady().then(async () => {
  try { appearance=normalizeAppearance(await get('appearance')); } catch {}
  nativeTheme.themeSource=appearance.theme;
  protocol.handle('app', request => {
    const url = new URL(request.url);
    const asset = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (url.hostname !== 'jiaojianbox' || !allowedAssets.has(asset)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(path.join(sourceRoot, 'web', asset)).href);
  });
  Menu.setApplicationMenu(null);
  const area=screen.getPrimaryDisplay().workAreaSize;
  window = new BrowserWindow({ width:Math.max(360,Math.min(1360,area.width-48)), height:Math.max(520,Math.min(900,area.height-48)), minWidth:360, minHeight:520,
    ...(process.env.JJB_TEST_OFFSCREEN==='1'?{x:-10000,y:-10000}:{}),
    title: '交件箱', backgroundColor:nativeTheme.shouldUseDarkColors?'#101914':'#f5f7f3', autoHideMenuBar: true, show: false,
    ...(process.platform==='win32'?{titleBarStyle:'hidden',titleBarOverlay:{color:nativeTheme.shouldUseDarkColors?'#141f19':'#eff3ed',symbolColor:nativeTheme.shouldUseDarkColors?'#dce9df':'#34483a',height:40}}:{}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  window.once('ready-to-show', () => process.env.JJB_TEST_OFFSCREEN==='1'?window.showInactive():window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
  installHandlers();
  qqManager=new QQManager({userData:app.getPath('userData'),sourceRoot,bridgeRoot,runtimeRoot:app.isPackaged?path.join(process.resourcesPath,'runtime','snowluma'):null,onStatus:publishState,acceptConsent:async runtime=>{
    while(true){const r=await dialog.showMessageBox(window,{type:'question',title:'QQ 读取组件首次启用',message:'启用内置 SnowLuma 读取组件',detail:'使用前请阅读组件的用户协议和隐私政策。点击同意表示接受这两份协议。',buttons:['查看用户协议','查看隐私政策','同意并继续','取消'],defaultId:3,cancelId:3});if(r.response===3)return false;if(r.response===2)return true;await shell.openPath(path.join(runtime,r.response===0?'EULA.md':'PRIVACY.md'));}
  }});
  nativeTheme.on('updated',updateNativeAppearance);
  await window.loadURL('app://jiaojianbox/index.html');
  edgeWindow=new EdgeWindow({root:sourceRoot,main:window,get,resources:bridgeRoot});await edgeWindow.start();
});
app.on('before-quit', () => { edgeWindow?.stop(); collector?.kill(); qqManager?.stop(); });
app.on('window-all-closed', () => {if(!edgeWindow)app.quit();});
