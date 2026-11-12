const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..');
  const scratch = await fs.mkdtemp(path.join(root, 'work/plugin-resilience-'));
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  const serverBinary = process.env.JJB_VERIFY_SERVER || path.join(root, 'work/JiaojianBox-UISmoke.exe');
  const server = spawn(serverBinary, ['-data', scratch, '-listen', '127.0.0.1:' + port], {
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, JJB_REQUIRE_EMAIL: 'false' },
  });
  let browser;
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/health')).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const registration = await fetch(base + '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'plugin_resilience', password: 'plugin-test-password' }),
    });
    assert(registration.ok);
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'plugin_resilience', password: 'plugin-test-password' }),
    });
    assert(login.ok);
    const session = { ...await login.json(), server: base };

    browser = await chromium.launch({
      headless: true,
      executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.addInitScript(value => {
      localStorage.setItem('jjb-session', JSON.stringify(value));
      window.__serviceStarted = 0;
      window.__serviceStopped = 0;
      const plugins = new Map();
      window.__pluginStore = plugins;
      const stubs = {
        get: async key => key === 'session' ? value : null,
        set: async (key, item) => key === 'session' ? item : null,
        remove: async () => {},
        pluginList: async () => [...plugins.entries()].map(([id, item]) => ({ id, ...item })),
        pluginGet: async id => {
          const item = plugins.get(id);
          if (!item) throw Error('插件不存在');
          return { id, ...item };
        },
        pluginImport: async bundle => {
          const id = bundle.manifest.id;
          const old = plugins.get(id);
          plugins.set(id, {
            manifest: bundle.manifest,
            files: bundle.files,
            enabled: false,
            config: old?.config || {},
            data: old?.data || {},
            runs: old?.runs || [],
            revision: (old?.revision || 0) + 1,
            installed_at: old?.installed_at || new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          return { id, enabled: false, revision: plugins.get(id).revision };
        },
        pluginImportArchive: async () => { throw Error('not used'); },
        pluginSet: async (id, patch) => {
          const item = plugins.get(id);
          if (!item) throw Error('插件不存在');
          if (typeof patch.enabled === 'boolean') item.enabled = patch.enabled;
          if (patch.config) item.config = patch.config;
          return { id, ...item };
        },
        pluginDelete: async id => { plugins.delete(id); return { ok: true }; },
        pluginDataGet: async (id, key) => ({ value: plugins.get(id)?.data?.[key] }),
        pluginDataSet: async (id, key, item) => {
          const plugin = plugins.get(id);
          plugin.data = { ...plugin.data, [key]: item };
          return { ok: true };
        },
        pluginRecord: async (id, entry) => {
          const plugin = plugins.get(id);
          plugin.runs = [...(plugin.runs || []), {
            ...entry,
            id: String((plugin.runs || []).length + 1),
            at: new Date().toISOString(),
          }];
          return plugin.runs.at(-1);
        },
        pluginRuns: async id => plugins.get(id)?.runs || [],
        pluginExec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        platform: async () => ({ platform: 'win32', version: '0.0.0-test', runtime: 'wails' }),
        quickGet: async () => ({ enabled: true, drop: true, note: true, files: true }),
        quickSet: async value => ({ enabled: true, drop: true, note: true, files: true, ...value }),
        quickState: async () => ({ visible: false }),
        quickChoose: async () => ({ ok: false }),
        quickNote: async () => ({ ok: true }),
        quickHide: async () => ({ ok: true }),
        launcherGet: async () => ({ openAtLogin: false }),
        launcherSet: async value => ({ openAtLogin: !!value.openAtLogin }),
        getAppearance: async () => ({ theme: 'dark', density: 'compact', textSize: 'normal' }),
        setAppearance: async value => ({ theme: 'dark', density: 'compact', textSize: 'normal', ...value }),
        tintTitlebar: async () => ({ ok: true }),
        external: async () => ({ ok: true }),
        collectorState: async () => ({ state: 'stopped', message: '采集未启动' }),
        discoverQQ: async () => ({ instances: [] }),
        connectQQ: async () => ({}),
        listConversations: async () => [],
        startCollector: async () => ({}),
        stopCollector: async () => ({ ok: true }),
        selectRuntime: async () => '',
        sourceDiagnostics: async () => ({}),
        debugQQ: async () => ({}),
        sourceConsent: async () => ({ eula: '', privacy: '' }),
        acceptSourceConsent: async () => ({ ok: true }),
        offlineStart: async () => ({ mode: 'offline', server: location.origin }),
        reminderGet: async () => ({}),
        reminderSet: async value => value,
        reminderTest: async () => ({ ok: true }),
        updateGet: async () => ({ autoCheck: true, intervalMinutes: 360, autoDownload: false }),
        updateSet: async value => ({ autoCheck: true, intervalMinutes: 360, autoDownload: false, ...value }),
        updateCheck: async () => ({ updatable: false, latest: null }),
        updateDownload: async () => ({ ok: false }),
        updateInstall: async () => ({ ok: false }),
        updateCancel: async () => ({ ok: true }),
        download: async () => ({ ok: false }),
        window: async () => ({}),
      };
      window.desktop = new Proxy(stubs, {
        get(target, key) {
          if (key in target) return target[key];
          return async () => ({});
        },
      });
    }, session);

    await page.goto(base);
    await page.locator('#workspace').waitFor({ state: 'visible' });
    await page.locator('[data-onboard=skip]').click({ timeout: 2000 }).catch(() => {});

    const result = await page.evaluate(async () => {
      const add = async (id, manifest, files) => {
        await desktop.pluginImport({ manifest: { id, name: id, version: '1.0.0', api: '^1', ...manifest }, files });
        await desktop.pluginSet(id, { enabled: true });
      };

      await add('baseline', {
        entry: 'main.js',
        events: ['task.created'],
        runtime: { triggerTimeoutMs: 150 },
      }, {
        'main.js': `export function activate(host){
          host.registerService({
            id: 'test-service',
            service: {
              start(){ window.__serviceStarted++; },
              stop(){ window.__serviceStopped++; },
            },
          });
          host.onTrigger('task.created', context => ({ id: context.task.id }));
        }`,
      });
      await add('relative', {
        entry: 'main.js',
        runtime: {},
      }, {
        'main.js': `import { label } from './lib/util.js';
          export function activate(host){
            host.registerPage({ key:'page', title:'相对模块', mount({container}){ container.textContent=label; } });
          }`,
        'lib/util.js': `export const label = '相对模块已加载';`,
      });
      await add('stuck-activate', {
        entry: 'main.js',
        runtime: { activationTimeoutMs: 150 },
      }, {
        'main.js': `export async function activate(){ await new Promise(() => {}); }`,
      });
      await add('stuck-hook', {
        entry: 'main.js',
        events: ['task.created'],
        runtime: { hookTimeoutMs: 120, failureThreshold: 1, cooldownMs: 2000, triggerTimeoutMs: 120 },
      }, {
        'main.js': `export function activate(host){
          host.intercept('/api/snapshot', () => new Promise(() => {}));
          host.onResponse('/api/snapshot', () => new Promise(() => {}));
          host.onTrigger('task.created', () => new Promise(() => {}));
        }`,
      });
      await add('healthy-late', {
        entry: 'main.js',
        runtime: { hookTimeoutMs: 120 },
      }, {
        'main.js': `export function activate(host){
          host.intercept('/api/snapshot', request => {
            window.__healthyHookRan = true;
            return request.request;
          });
        }`,
      });
      await add('event-queue', {
        entry: 'main.js',
        events: ['task.created'],
        runtime: { triggerTimeoutMs: 1000, eventTimeoutMs: 1000 },
      }, {
        'main.js': `export function activate(host){
          window.__eventQueueStarted = [];
          window.__eventQueueFinished = [];
          window.__snapshotQueueStarted = [];
          window.__snapshotQueueFinished = [];
          host.onTrigger('task.created', async context => {
            window.__eventQueueStarted.push(context.task.id);
            await new Promise(resolve => setTimeout(resolve, 80));
            window.__eventQueueFinished.push(context.task.id);
            return { id: context.task.id };
          });
          host.onSnapshot(async snapshot => {
            window.__snapshotQueueStarted.push(snapshot.test_marker || '');
            await new Promise(resolve => setTimeout(resolve, 80));
            window.__snapshotQueueFinished.push(snapshot.test_marker || '');
            return { marker: snapshot.test_marker || '' };
          });
        }`,
      });

      const syncStarted = performance.now();
      await pluginUI.sync(true);
      const syncElapsed = performance.now() - syncStarted;
      if (syncElapsed > 1500) throw Error('插件同步被坏插件拖住：' + Math.round(syncElapsed));
      await new Promise(resolve => setTimeout(resolve, 30));
      if (window.__serviceStarted !== 1) throw Error('插件服务未启动');
      navigate('plugins');
      render();
      await new Promise(resolve => setTimeout(resolve, 120));
      const issueShown = document.querySelector('[data-plugin-id="stuck-activate"] .plugin-error')?.textContent || '';
      if (!issueShown.includes('插件启用超时')) throw Error('插件管理器未显示启用超时');

      // Recreate the plugin runtimes, then verify the first snapshot only
      // establishes history and does not launch task.created for every old task.
      pluginUI.stop();
      await new Promise(resolve => setTimeout(resolve, 30));
      if (window.__serviceStopped !== 1) throw Error('插件服务停用后未清理');
      await pluginUI.sync(true);
      state.snapshot.tasks = [{ id: 'historical', version: 1 }];
      window.dispatchEvent(new CustomEvent('snapshot-updated', { detail: state.snapshot }));
      await new Promise(resolve => setTimeout(resolve, 50));
      if ((await desktop.pluginRuns('baseline')).length !== 0) throw Error('历史任务被误触发');

      state.snapshot.tasks = [
        { id: 'historical', version: 1 },
        { id: 'new-task', version: 1 },
      ];
      state.snapshot.test_marker = 'first';
      window.dispatchEvent(new CustomEvent('snapshot-updated', { detail: state.snapshot }));
      await new Promise(resolve => setTimeout(resolve, 12));
      state.snapshot.tasks = [
        { id: 'historical', version: 1 },
        { id: 'new-task', version: 1 },
        { id: 'queued-task', version: 1 },
      ];
      state.snapshot.test_marker = 'latest';
      window.dispatchEvent(new CustomEvent('snapshot-updated', { detail: state.snapshot }));
      for (let i = 0; i < 30; i++) {
        const runs = await desktop.pluginRuns('baseline');
        if (runs.some(run => run.event === 'task.created' && run.result?.id === 'new-task')) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }

      const apiStarted = performance.now();
      const snapshot = await api('/api/snapshot');
      const apiElapsed = performance.now() - apiStarted;
      if (!snapshot || apiElapsed > 1200) throw Error('卡住的请求钩子阻断了 API');
      if (!window.__healthyHookRan) throw Error('坏插件阻断了后续健康插件的钩子');

      for (let i = 0; i < 30; i++) {
        const runs = await desktop.pluginRuns('stuck-hook');
        if (runs.some(run => run.event === 'task.created' && run.status === 'failed' && /超时/.test(run.error || ''))) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      for (let i = 0; i < 40; i++) {
        const runs = await desktop.pluginRuns('event-queue');
        if (runs.some(run => run.result?.id === 'queued-task') &&
            runs.some(run => run.event === 'snapshot' && run.result?.marker === 'latest')) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }

      navigate('plugin:relative:page');
      render();
      await new Promise(resolve => setTimeout(resolve, 50));
      if (!document.querySelector('#plugin-page')?.textContent.includes('相对模块已加载')) {
        throw Error('相对模块导入未生效');
      }

      return {
        syncElapsed: Math.round(syncElapsed),
        apiElapsed: Math.round(apiElapsed),
        baselineRuns: await desktop.pluginRuns('baseline'),
        activateRuns: await desktop.pluginRuns('stuck-activate'),
        hookRuns: await desktop.pluginRuns('stuck-hook'),
        queuedRuns: await desktop.pluginRuns('event-queue'),
        serviceLifecycle: window.__serviceStarted === 2 && window.__serviceStopped === 1,
        healthyHookRan: !!window.__healthyHookRan,
        issueShown,
        relativeModule: true,
        eventQueueStarted: window.__eventQueueStarted,
        eventQueueFinished: window.__eventQueueFinished,
        snapshotQueueStarted: window.__snapshotQueueStarted,
        snapshotQueueFinished: window.__snapshotQueueFinished,
      };
    });

    assert(result.syncElapsed < 1500);
    assert(result.apiElapsed < 1200);
    assert(result.baselineRuns.some(run => run.result?.id === 'new-task'));
    assert(result.activateRuns.some(run => run.status === 'failed' && /超时/.test(run.error || '')));
    assert(result.hookRuns.some(run => run.event === 'task.created' && run.status === 'failed'));
    assert(result.queuedRuns.some(run => run.result?.id === 'queued-task'));
    assert(result.snapshotQueueStarted.includes('latest'));
    assert(result.snapshotQueueFinished.includes('latest'));
    assert(result.serviceLifecycle);
    assert.deepEqual(pageErrors, []);
    console.log(JSON.stringify({ ...result, pageErrors, evidence: scratch }, null, 2));
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
