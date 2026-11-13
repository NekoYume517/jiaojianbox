/* Wails adapter. The browser build uses the same UI without native capabilities. */
(() => {
  if (new URLSearchParams(location.search).get('desktop') !== '1') {
    document.documentElement.dataset.runtime = 'web';
    return;
  }
  document.documentElement.dataset.runtime = 'wails';
  const ready = new Promise((resolve, reject) => {
    const started = Date.now();
    let requested=false;
    const check = () => {
      if(window.wails?.Call?.ByName)return resolve(window.wails);
      if(!requested&&window._wails?.invoke){requested=true;import('/wails/runtime.js').then(runtime=>{window.wails=runtime;}).catch(()=>reject(Error('桌面组件加载失败，请重新打开应用')));}
      if(Date.now()-started>15000)return reject(Error('桌面组件尚未就绪，请重新打开应用'));
      setTimeout(check,20);
    };
    check();
  });
  const invoke = async (name, ...args) => (await ready).Call.ByName('github.com/NekoYume517/jiaojianbox/internal/gui.Desktop.Invoke', name, args);
  const on = (name, callback) => {
    let unsubscribe, cancelled = false;
    ready.then(runtime => { unsubscribe = runtime.Events.On(name, event => callback(event.data)); if (cancelled) unsubscribe?.(); });
    return () => { cancelled = true; unsubscribe?.(); };
  };
  window.desktop = Object.fromEntries(['pluginExec','pluginList','pluginGet','pluginImport','pluginImportArchive','pluginSet','pluginDelete','pluginDataGet','pluginDataSet','pluginRecord','pluginRuns','offlineStart', 'quickGet', 'quickSet', 'reminderGet', 'reminderSet', 'reminderTest', 'launcherGet', 'launcherSet', 'updateGet', 'updateSet', 'updateCheck', 'updateDownload', 'updateInstall', 'updateCancel', 'get', 'set', 'remove', 'platform', 'getAppearance', 'setAppearance', 'tintTitlebar', 'qqConnectorGet', 'qqConnectorSet', 'discoverQQ', 'connectQQ', 'sourceConsent', 'acceptSourceConsent', 'sourceDiagnostics', 'debugQQ', 'selectRuntime', 'external', 'listConversations', 'startCollector', 'stopCollector', 'collectorState', 'download', 'quickState', 'quickChoose', 'quickNote', 'quickHide', 'window'].map(name => [name, (...args) => invoke(name, ...args)]));
  Object.assign(window.desktop, { nativeFileDrop: true, onAppearance: callback => on('appearance-updated', callback), onCollector: callback => on('collector-state', callback), on });
  const discover = desktop.discoverQQ, connect = desktop.connectQQ;
  const requestConsent = async (preferred,connector) => {
    const info = await invoke('sourceConsent', preferred, connector);
    const dialog = document.createElement('dialog'); dialog.className = 'component-consent';
    const form = document.createElement('form'); form.method = 'dialog';
    const title = document.createElement('h2'); title.textContent = connector === 'snowcat' ? '启用 SnowCat 连接器' : '启用 QQ 采集组件';
    const note = document.createElement('p'); note.textContent = connector === 'snowcat' ? 'SnowCat 需要在本机 QQ 进程中运行。继续后会部署连接器文件，重启 QQ 后生效。' : '请阅读采集组件的用户协议与隐私政策。';
    const content = document.createElement('pre'); content.textContent = info.eula + '\n\n' + info.privacy;
    const actions = document.createElement('div'); actions.className = 'dialog-footer';
    for (const [value, label, className] of [['cancel', '取消', 'secondary'], ['accept', '同意并继续', 'primary']]) { const button = document.createElement('button'); Object.assign(button, { value, textContent: label, className }); actions.append(button); }
    form.append(title, note, content, actions); dialog.append(form); document.body.append(dialog);
    const accepted = await new Promise(resolve => { dialog.addEventListener('close', () => resolve(dialog.returnValue === 'accept'), { once: true }); dialog.showModal(); }); dialog.remove();
    if (!accepted) throw Error('尚未同意组件协议，QQ 采集未启用');
    await invoke('acceptSourceConsent', preferred, connector);
  };
  desktop.discoverQQ = async (preferred,quiet=false,connector='snowluma') => {
    try { return await discover(preferred,quiet,connector); }
    catch (error) {
      if (!String(error.message).includes('CONSENT_REQUIRED')) throw error;
      if(quiet)return {instances:[],needs_consent:true};
      await requestConsent(preferred,connector); return discover(preferred,quiet,connector);
    }
  };
  desktop.connectQQ = async (value={}) => {
    try { return await connect(value); }
    catch (error) {
      if (!String(error.message).includes('CONSENT_REQUIRED')) throw error;
      const connector=value.qq_connector||'snowluma';
      await requestConsent(connector==='snowcat'?value.snowcat_home:value.snowluma_home,connector);
      return connect(value);
    }
  };
  function markTargets() {
    document.body?.setAttribute('data-file-drop-target', '');
    document.querySelectorAll('.drop-zone,[data-task],.shelf-drop,.plugin-board,.share-drop,.file-picker').forEach(target => {
      target.setAttribute('data-file-drop-target', '');
      const picker = target.matches('.share-drop,.file-picker');
      if (picker && !target.dataset.nativePicker) target.dataset.nativePicker = 'picker-' + Math.random().toString(36).slice(2, 10);
      const task = target.dataset.task || (target.classList.contains('drop-zone') && typeof state !== 'undefined' ? state.taskId : '');
      if (task && !picker) target.dataset.nativeTask = task; else delete target.dataset.nativeTask;
      target.dataset.nativeKind = picker ? 'picker'
        : target.classList.contains('plugin-board') ? 'plugin'
        : target.querySelector('#receipt-upload') ? 'receipt' : 'material';
    });
  }
  document.addEventListener('DOMContentLoaded', () => {
    document.documentElement.dataset.runtime = 'wails'; markTargets();
    new MutationObserver(markTargets).observe(document.body, { childList: true, subtree: true });
  });
  on('update-state', value => { if (typeof updateUI !== 'undefined') updateUI(value); });
  on('update-download', value => { if (typeof updateUI !== 'undefined') updateUI(value, true); });
  on('native-drop-complete', () => { if (typeof refresh === 'function') refresh(); });
  on('native-status', message => { if (typeof toast === 'function') toast(message); });
})();
