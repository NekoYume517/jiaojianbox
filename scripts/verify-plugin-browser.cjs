const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..');
  const scratch = await fs.mkdtemp(path.join(root, 'work/plugins-browser-'));
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  const serverBinary = process.env.JJB_VERIFY_SERVER || path.join(root, 'work/JiaojianBox-UISmoke.exe');
  const server = spawn(serverBinary, ['-data', scratch, '-listen', '127.0.0.1:' + port], { windowsHide: true, stdio: 'ignore', env: { ...process.env, JJB_REQUIRE_EMAIL: 'false', JJB_ALLOW_REGISTRATION: 'true', JJB_ALLOW_PRIVATE_UPSTREAMS: 'true' } });
  let browser;
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/health')).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const registration = await fetch(base + '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'plugin_user', password: 'plugin-test-password' }),
    });
    assert(registration.ok);
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'plugin_user', password: 'plugin-test-password' }),
    });
    assert(login.ok);
    const session = { ...await login.json(), server: base };
    browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
    const errors = [];
    page.on('pageerror', error => console.log('PAGEERROR:', error.message));
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(value => localStorage.setItem('jjb-session', JSON.stringify(value)), session);
    await page.goto(base);
    await page.locator('#workspace').waitFor({ state: 'visible' });
    await page.locator('[data-onboard=skip]').click();
    await page.evaluate(value => {
      const plugins = new Map();
      window.desktop = {
        async get(key) { return key === 'session' ? value : null; },
        async set() { return null; },
        async remove() { return null; },
        async pluginList() {
        return [...plugins.entries()].map(([id, { manifest, enabled, config, revision, data, runs, installed_at, updated_at }]) => ({ id, manifest, enabled, config, revision, data, runs, installed_at, updated_at }));
        },
        async pluginGet(id) {
          const record = plugins.get(id);
          if (!record) throw Error('插件不存在');
          return { id, ...record };
        },
        async pluginImport(bundle) {
          const id = bundle.manifest.id;
          const old = plugins.get(id);
          plugins.set(id, {
            manifest: bundle.manifest, files: bundle.files, enabled: false,
            config: old?.config || {}, data: old?.data || {}, runs: old?.runs || [],
            revision: (old?.revision || 0) + 1,
            installed_at: old?.installed_at || new Date().toISOString(), updated_at: new Date().toISOString(),
          });
          return { id, enabled: false, revision: plugins.get(id).revision, created: !old };
        },
        async pluginImportArchive() { throw Error('not used'); },
        async pluginSet(id, patch) {
          const record = plugins.get(id);
          if (!record) throw Error('插件不存在');
          if (typeof patch.enabled === 'boolean') record.enabled = patch.enabled;
          if (patch.config) record.config = patch.config;
          return { id, ...record, files: undefined };
        },
        async pluginDelete(id) { plugins.delete(id); return { ok: true }; },
        async pluginDataGet(id, key) { return { value: plugins.get(id)?.data?.[key] }; },
        async pluginDataSet(id, key, value) {
          const record = plugins.get(id);
          record.data = { ...record.data, [key]: value };
          return { ok: true };
        },
        async pluginRecord(id, entry) {
          const record = plugins.get(id);
          record.runs = [...record.runs, { ...entry, id: String(record.runs.length + 1), at: new Date().toISOString() }];
          return record.runs.at(-1);
        },
        async pluginRuns(id) { return plugins.get(id)?.runs || []; },
        async platform() { return { platform: 'win32', version: '0.0.0-test', runtime: 'wails' }; },
        async quickGet() { return { enabled: true, drop: true, note: true, files: true }; },
        async quickSet(value) { return { enabled: true, drop: true, note: true, files: true, ...value }; },
        async quickState() { return { visible: false }; },
        async quickChoose() { return { ok: false }; },
        async quickNote() { return { ok: true }; },
        async quickHide() { return { ok: true }; },
        async launcherGet() { return { openAtLogin: false }; },
        async launcherSet(value) { return { openAtLogin: !!value.openAtLogin }; },
        async getAppearance() { return { theme: 'dark', density: 'compact', textSize: 'normal' }; },
        async setAppearance(value) { return { theme: 'dark', density: 'compact', textSize: 'normal', ...value }; },
        async tintTitlebar() { return { ok: true }; },
        async external() { return { ok: true }; },
        async collectorState() { return { state: 'stopped', message: '采集未启动' }; },
        async discoverQQ() { return { instances: [] }; },
        async connectQQ() { return {}; },
        async listConversations() { return []; },
        async startCollector() { return {}; },
        async stopCollector() { return { ok: true }; },
        async selectRuntime() { return ''; },
        async sourceDiagnostics() { return {}; },
        async debugQQ() { return {}; },
        async sourceConsent() { return { eula: '', privacy: '' }; },
        async acceptSourceConsent() { return { ok: true }; },
        async offlineStart() { return { ok: true }; },
        async updateGet() { return { autoCheck: true, intervalMinutes: 360, autoDownload: false, lastCheck: null }; },
        async updateSet(value) { return { autoCheck: true, intervalMinutes: 360, autoDownload: false, ...value }; },
        async updateCheck() { return { updatable: false, latest: null }; },
        async updateDownload() { return { ok: false }; },
        async updateInstall() { return { ok: false }; },
        async updateCancel() { return { ok: true }; },
        async download() { return { ok: false }; },
        async window() { return {}; },
        async pluginExec(id, options) { return { stdout: JSON.stringify({ summary: '本机工具已执行:' + options.command }), stderr: '', exitCode: 0 }; },
      };
    }, session);
    await page.evaluate(() => pluginUI.sync(true));
    await page.evaluate(() => {
      const settings = document.querySelector('[data-nav=settings]');
      if (!document.querySelector('[data-nav=plugins]') && settings) {
        settings.insertAdjacentHTML('beforebegin', '<button data-nav="plugins" data-short="插件" title="插件"><span data-icon="connect"></span>插件</button>');
      }
    });
    await page.locator('[data-nav=plugins]').click();
    await page.locator('#plugin-import').click();
    const code = `export function activate(host){
      window.__pluginPlainFetch = fetch('/api/snapshot').then(async response => ({status:response.status,ok:response.ok,body:await response.json()}));
      window.__pluginAllApi = host.apiAll('/api/snapshot','GET');
      host.registerPage({key:'page',title:'扩展入口',children:[
        {id:'one',title:'概览',mount({container}){window.__pageOneMounts=(window.__pageOneMounts||0)+1;container.textContent='插件概览已挂载'}},
        {id:'two',title:'工具',mount({container}){container.textContent='插件工具已挂载'}}
      ]});
      host.registerPage({key:'direct',title:'单页入口',mount({container}){container.textContent='插件单页已挂载'}});
      host.registerPage({key:'custom',title:'自定义组件',chrome:false,mount({container,host}){container.append(host.createComponent({tag:'section',className:'panel',children:[{tag:'div',className:'panel-head',children:[{tag:'h3',text:'任意组件已挂载'}]}]}))}});
      host.registerPage({key:'boom',title:'错误演示',mount(){throw Error('演示错误')}});
      host.registerCommand({id:'mark',title:'插件测试命令',run:()=>{window.__pluginCommand=true;host.toast('插件命令已执行')}});
      host.registerTrigger({id:'calendar',title:'日历触发器',description:'验证插件触发器适配器',event:'trigger:demo:calendar'});
      host.onTrigger('task.created',context=>({summary:'处理完成：'+context.task.title}));
      host.onTrigger('trigger:demo:calendar',context=>({summary:'触发器测试通过',payload:context.payload}));
    }`;
    const bundle = {
      manifest: { id: 'demo', name: '测试插件', api: '^1', version: '1.0', entry: 'main.js', events: ['task.created', 'trigger:demo:calendar'], description: '桌面插件验收',
        settings: [{ key: 'greeting', type: 'string', title: '问候语', description: '用于插件页面的问候', default: '你好' }],
        permissions: ['tasks:read'] },
      files: { 'main.js': code },
    };
    await page.locator('#plugin-file').setInputFiles({ name: 'demo.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle)) });
    const row = page.locator('.plugin-row[data-plugin-id="demo"]');
    await row.waitFor();
    await row.locator('[data-plugin-enable]').check();
    await page.locator('[data-plugin-tab=demo]').first().waitFor();
    await page.waitForFunction(async () => {
      const plain = await window.__pluginPlainFetch;
      const all = await window.__pluginAllApi;
      return plain.status === 200 && plain.ok && !!plain.body && !!all;
    });
    await page.locator('[data-plugin-tab=demo]').first().click();
    await page.locator('.nav-sub').getByRole('tab', { name: '工具' }).click();
    await page.getByText('插件工具已挂载', { exact: true }).waitFor();
    await page.locator('.nav-sub').getByRole('tab', { name: '概览' }).click();
    await page.getByText('插件概览已挂载', { exact: true }).waitFor();
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => window.__pageOneMounts), 2, 'navigation sync remounted a stable plugin tab');
    await page.locator('.nav-sub').getByRole('tab', { name: '工具' }).click();
    await page.getByText('插件工具已挂载', { exact: true }).waitFor();
    await page.keyboard.press('Control+K');
    await page.locator('#cmdk-input').fill('插件测试命令');
    await page.getByText('插件测试命令').click();
    await page.waitForFunction(() => window.__pluginCommand === true);
    await page.keyboard.press('Escape');
    const task = await page.evaluate(async () => {
      const created = await api('/api/tasks', 'POST', { title: '交给本机插件的任务' });
      await refresh();
      return created;
    });
    await page.waitForFunction(async id => {
      const runs = await desktop.pluginRuns('demo');
      return runs.some(run => run.event === 'task.created' && run.result?.summary === '处理完成：交给本机插件的任务');
    }, task.id);
    await page.locator('[data-nav=sources]').click();
    await page.locator('#page-subnav [data-subnav="adapters"]').click();
    const adapter = page.locator('[data-trigger-adapter="plugin:demo:calendar"]');
    await adapter.waitFor();
    await adapter.getByRole('button', { name: '测试' }).click();
    await page.waitForFunction(async () => {
      const runs = await desktop.pluginRuns('demo');
      return runs.some(run => run.event === 'trigger:demo:calendar' && run.result?.summary === '触发器测试通过');
    });
    await page.locator('[data-nav=plugins]').click();
    await page.locator('.plugin-row[data-plugin-id="demo"]').waitFor();
    await page.waitForTimeout(300);
    await page.getByTitle('单页入口').click();
    await page.getByText('插件单页已挂载', { exact: true }).waitFor();
    // Regression: a direct page must re-mount after the view was rebuilt.
    await page.locator('[data-nav=plugins]').click();
    await page.locator('.plugin-row[data-plugin-id="demo"]').waitFor();
    await page.getByTitle('单页入口').click();
    await page.getByText('插件单页已挂载', { exact: true }).waitFor();
    await page.locator('[data-nav=plugins]').click();
    await page.locator('.plugin-row[data-plugin-id="demo"]').waitFor();
    await page.getByTitle('自定义组件').click();
    await page.getByText('任意组件已挂载', { exact: true }).waitFor();
    // Error boundary: a throwing page shows the retry card and stays broken.
    await page.getByTitle('错误演示').click();
    await page.getByText('此页面已停止工作').waitFor();
    await page.locator('[data-plugin-retry]').click();
    await page.getByText('此页面已停止工作').waitFor();
    // Schema settings: edit the declared field and persist through the form.
    await page.locator('[data-nav=plugins]').click();
    await page.locator('.plugin-row[data-plugin-id="demo"]').waitFor();
    await row.locator('.plugin-debug>summary').click();
    await page.evaluate(() => {
      document.querySelector('.plugin-row[data-plugin-id="demo"]')?.setAttribute('data-stability-check', 'kept');
    });
    await page.locator('[data-plugin-setting=greeting]').fill('早上好');
    await page.locator('[data-plugin-save]').click();
    await page.waitForFunction(async () => {
      const record = await desktop.pluginGet('demo');
      return record.config?.greeting === '早上好';
    });
    await page.locator('.plugin-row[data-plugin-id="demo"]').waitFor();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.plugin-row[data-plugin-id="demo"][data-stability-check=kept]').count(), 1, 'saving settings rebuilt the plugin manager');
    assert.equal(await row.locator('.plugin-debug').getAttribute('open'), '');
    assert.equal(await page.locator('[data-plugin-setting=greeting]').inputValue(), '早上好');
    await row.locator('[data-plugin-enable]').uncheck();
    await page.locator('[data-plugin-tab=demo]').first().waitFor({ state: 'detached' });
    await row.locator('[data-plugin-delete]').click();
    await row.waitFor({ state: 'detached' });
    const webPage = await browser.newPage();
    await webPage.goto(base);
    await webPage.waitForTimeout(500);
    assert.equal(await webPage.locator('[data-nav=plugins]').count(), 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({
      desktopImport: true, tabs: true, secondaryTabs: true, commandPalette: true,
      triggerAdapter: true,
      localTrigger: true, disable: true, delete: true, webEntryHidden: true, pageErrors: 0, evidence: scratch,
    }));
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
