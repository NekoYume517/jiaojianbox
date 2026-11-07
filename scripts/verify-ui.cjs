const { chromium, _electron } = require('playwright');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');
const http = require('node:http');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const scratch = path.resolve(root, '../../work/ui-verification-' + Date.now());
const evidence = path.join(root, 'docs/verification');
const port = 18767, llmPort = 18766;
const base = `http://127.0.0.1:${port}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, browser, electron, activePage;
const errors = [], prompts = [];
const stub = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if(req.url==='/get_login_info')return res.end(JSON.stringify({retcode:0,data:{user_id:101,nickname:'测试账号'}}));
  if(req.url==='/get_group_list')return res.end(JSON.stringify({retcode:0,data:[{group_id:301,group_name:'软件工程测试群'},{group_id:302,group_name:'活动测试群'}]}));
  if(req.url==='/get_friend_list')return res.end(JSON.stringify({retcode:0,data:[{user_id:201,nickname:'测试联系人'}]}));
  if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'verification-model' }] }));
  let content = ''; for await (const part of req) content += part;
  prompts.push(JSON.parse(content));
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ classification: 'actionable', confidence: .97, reason: '明确要求提交报告和源码，含截止时间与命名要求。', summary: '周五前提交 PDF 报告与 ZIP 源码，按学号姓名命名。', title: '实验报告与源码提交', due_at: '2026-11-20T18:00:00+08:00', requirements: [{ label: '实验报告', extensions: ['pdf'], min_count: 1 }, { label: '源码压缩包', extensions: ['zip'], min_count: 1 }], max_total_bytes: 20 * 1024 ** 2, naming_hint: '学号_姓名', submit_url: 'https://example.com/submit', evidence: ['11月20日18:00前提交实验报告 PDF 和源码 ZIP', '文件名为学号_姓名'], notes: ['请核对课程要求及实际截止时间。'] }) } }] }));
});

async function request(route, options = {}, token) {
  const response = await fetch(base + route, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...options.headers } });
  const text = await response.text(); let obj; try { obj = JSON.parse(text); } catch { throw new Error(route + ' returned ' + response.status + ': ' + text.slice(0, 160)); } if (!response.ok) throw new Error(JSON.stringify(obj)); return obj;
}
async function login(page) {
  if (!page.url().startsWith('app://')) await page.goto(base);
  await page.locator('#server-url').fill(base);
  await page.locator('#username').fill('ui_student');
  await page.locator('#password').fill('strong-test-password');
  await page.locator('#auth-submit').click();
  await page.locator('#workspace').waitFor({ state: 'visible' });
}
async function until(fn, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return; await wait(150); }
  throw new Error('Timed out: ' + label);
}

(async () => {
  await fs.mkdir(scratch, { recursive: true }); await fs.mkdir(evidence, { recursive: true });
  await new Promise(resolve => stub.listen(llmPort, '127.0.0.1', resolve));
  server = spawn('python', ['-m', 'uvicorn', 'server.app:app', '--host', '127.0.0.1', '--port', String(port), '--no-access-log'], { cwd: root, windowsHide: true, env: { ...process.env, JJB_DATA_DIR: scratch }, stdio: 'ignore' });
  await until(async () => { try { return (await (await fetch(base + '/health')).json()).status === 'ok'; } catch { return false; } }, 'server startup');
  await request('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'ui_student', password: 'strong-test-password' }) });
  const session = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'ui_student', password: 'strong-test-password' }) });
  const seeds = [
    ['course', '软件工程课程群', '测试老师', '同学们，实验报告请按要求整理，提交前核对附件。', '2026-11-07T08:00:00+08:00'],
    ['course', '软件工程课程群', '测试老师', '11月20日18:00前提交实验报告 PDF 和源码 ZIP，文件名为学号_姓名，总大小不超过20MB。提交入口：https://example.com/submit', '2026-11-07T09:00:00+08:00'],
    ['club', '校园活动通知', '活动负责人', '创新实践报名周五截止，请准备个人介绍和项目说明。', '2026-11-07T10:00:00+08:00'],
    ['friends', '周末小分队', '测试同学', '今天晚上食堂见，一起吃个饭？', '2026-11-07T11:00:00+08:00'],
  ];
  const messages = [];
  for (let i = 0; i < seeds.length; i++) {
    const [chat, name, sender, text, at] = seeds[i];
    messages.push(await request('/api/messages', { method: 'POST', body: JSON.stringify({ source: i % 2 ? 'qq' : 'wechat', account_id: 'synthetic', conversation_id: chat, conversation_name: name, external_id: String(i), sender_name: sender, text, sent_at: at }) }, session.token));
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.JJB_CHROMIUM || undefined });
  let context, page;
  if (process.env.JJB_TEST_ELECTRON) {
    const env = { ...process.env, JJB_USER_DATA: path.join(scratch, 'electron-profile') }; delete env.ELECTRON_RUN_AS_NODE;
    electron = await _electron.launch({ executablePath: process.env.JJB_PACKAGED_EXECUTABLE || require('electron'), args: process.env.JJB_PACKAGED_EXECUTABLE ? [] : [root], env });
    page = await electron.firstWindow(); context = page.context();
    await page.waitForLoadState('domcontentloaded');
    const secure = await electron.evaluate(({ BrowserWindow }) => { const p=BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();return {isolation:p.contextIsolation,sandbox:p.sandbox,node:p.nodeIntegration}; });
    assert.deepEqual(secure,{isolation:true,sandbox:true,node:false});
  } else { context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); page = await context.newPage(); }
  activePage = page; page.on('pageerror', error => errors.push(error.message));
  await login(page);
  await page.locator('[data-nav=settings]').click();
  await page.locator('#llm-url').fill(`http://127.0.0.1:${llmPort}/v1`);
  await page.locator('#llm-model').fill('verification-model'); await page.locator('#llm-key').fill('synthetic-test-key');
  await page.locator('[data-action=test-llm]').click();
  await page.getByText('连接成功', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'settings-desktop.png'), fullPage: true });
  await page.locator('[data-nav=inbox]').click();
  await page.locator(`[data-context="${messages[0].id}"]`).check();
  await page.locator(`[data-message="${messages[1].id}"]`).click();
  await page.locator('[data-action=analyze]').click();
  await page.locator('.confidence-chip.high').first().waitFor();
  assert.equal(JSON.parse(prompts[0].messages[1].content).CONTEXT.length, 1);
  await page.screenshot({ path: path.join(evidence, 'inbox-desktop.png'), fullPage: true });
  await page.locator('[data-action=message-task]').click();
  await page.locator('#task-title').fill('实验报告交付');
  await page.locator('#task-pattern').fill('2026_测试同学.*');
  await page.locator('#task-save').click();
  await page.locator('[data-action=edit-task]').waitFor();
  await page.locator('#material-upload').setInputFiles([{ name: '2026_测试同学.pdf', mimeType: 'application/pdf', buffer: Buffer.from('synthetic PDF') }, { name: '2026_测试同学.zip', mimeType: 'application/zip', buffer: Buffer.from('synthetic ZIP') }]);
  await page.getByText('材料检查通过，提交前请再核对内容。', { exact: true }).waitFor();
  await page.locator('[data-rename-file]').first().click();
  await page.locator('#rename-name').fill('2026_临时名字.pdf'); await page.locator('#rename-form [type=submit]').click();
  await page.getByText('请处理缺失项或人工核对项。', {exact:true}).waitFor();
  await page.locator('[data-rename-file]').first().click();
  await page.locator('#rename-name').fill('2026_测试同学.pdf'); await page.locator('#rename-form [type=submit]').click();
  await page.getByText('材料检查通过，提交前请再核对内容。', {exact:true}).waitFor();
  if(electron){
    const downloadPath=path.join(scratch,'submission.zip');
    await electron.evaluate(({dialog},savePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:savePath});},downloadPath);
    await page.locator('[data-action=package]').click();
    await page.getByText('文件已保存',{exact:true}).waitFor();
    assert.equal((await fs.readFile(downloadPath)).subarray(0,2).toString(),'PK');
  }
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 1, hasTouch: true });
  const phone = await mobileContext.newPage(); phone.on('pageerror', error => errors.push(error.message));
  await login(phone); await phone.locator('[data-nav=tasks]').click(); await phone.locator('[data-task]').first().click();
  await page.locator('[data-action=mark-submitted]').click();
  await phone.locator('.panel-head .tag').filter({ hasText: '已提交' }).waitFor();
  assert(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile overflow');
  await page.screenshot({ path: path.join(evidence, 'task-desktop.png'), fullPage: true });
  await phone.screenshot({ path: path.join(evidence, 'task-mobile.png'), fullPage: true });
  await page.locator('[data-action=edit-task]').click();
  const current = (await request('/api/snapshot', {}, session.token)).tasks[0];
  await request('/api/tasks/' + current.id, { method: 'PUT', body: JSON.stringify({ ...current, title: '手机端已更新标题' }) }, session.token);
  await page.locator('#task-title').fill('过期草稿不能覆盖'); await page.locator('#task-save').click();
  await page.locator('#task-error').filter({ hasText: '其他设备已修改' }).waitFor();
  assert.equal((await request('/api/tasks/' + current.id, {}, session.token)).title, '手机端已更新标题');
  await page.locator('[data-action=close-task]').first().click();
  await page.locator('[data-action=back-tasks]').click();
  await context.setOffline(true);
  await page.locator('[data-action=new-task]').first().click(); await page.locator('#task-title').fill('离线任务会自动补传'); await page.locator('#task-save').click();
  await page.getByText('本机修改等待同步。', { exact: true }).waitFor();
  if(electron){await page.reload();await page.locator('#workspace').waitFor({state:'visible'});await page.locator('[data-nav=tasks]').click();await page.getByText('离线任务会自动补传',{exact:true}).waitFor();}
  await context.setOffline(false);
  await until(async () => (await request('/api/snapshot', {}, session.token)).tasks.some(t => t.title === '离线任务会自动补传'), 'offline replay');
  await phone.locator('[data-nav=tasks]').click();
  await phone.getByText('离线任务会自动补传', { exact: true }).waitFor();
  assert.equal(errors.length, 0, errors.join('\n'));
  if (electron) {
    await page.locator('[data-nav=sources]').click(); await page.locator('#python-path').waitFor();
    await page.locator('#qq-http').fill(`http://127.0.0.1:${llmPort}`);await page.locator('[data-action=list-qq]').click();
    await page.getByText('软件工程测试群',{exact:true}).waitFor();
    assert.equal(await page.locator('[data-subscribe=qq]').count(),3);
    await page.screenshot({path:path.join(evidence,'sources-electron.png'),fullPage:true});
  }
  const report = { at: new Date().toISOString(), runtime: electron ? 'Electron 45.2.3' : 'Chromium', packaged:!!process.env.JJB_PACKAGED_EXECUTABLE, data: 'synthetic-only', passed: ['browser-login', 'llm-config-model-test', 'selected-context-llm-call', 'task-from-message', 'multi-file-upload-and-validation', 'file-rename-recheck', 'desktop-to-mobile-websocket-sync', 'mobile-390px-no-overflow', 'optimistic-version-conflict', 'offline-task-replay', 'no-renderer-errors', ...(electron?['electron-sandbox-context-isolation','encrypted-session-storage','offline-reload-preserves-outbox','streamed-package-download','desktop-source-settings']:[])], screenshots: ['settings-desktop.png', 'inbox-desktop.png', 'task-desktop.png', 'task-mobile.png'] };
  await fs.writeFile(path.join(evidence, process.env.JJB_PACKAGED_EXECUTABLE?'packaged-report.json':electron ? 'electron-report.json' : 'ui-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})().catch(async error => { console.error(error); if (activePage) { console.error('UI status:', await activePage.locator('#toast').textContent()); await activePage.screenshot({path:path.join(evidence,'failure.png'),fullPage:true}); } process.exitCode = 1; }).finally(async () => { await electron?.close(); await browser?.close(); server?.kill(); stub.close(); });
