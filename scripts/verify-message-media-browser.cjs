const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..');
  const scratch = await fs.mkdtemp(path.join(root, 'work/message-media-browser-'));
  const port = 18965 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(path.join(root, 'work/JiaojianBox-UISmoke.exe'), ['-data', scratch, '-listen', `127.0.0.1:${port}`], { windowsHide: true, stdio: 'inherit', env: { ...process.env, JJB_REQUIRE_EMAIL: 'false', JJB_ALLOW_REGISTRATION: 'true', JJB_ALLOW_PRIVATE_UPSTREAMS: 'true' } });
  let browser;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(base + '/health')).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'media-preview', password: 'fixture-password-123' }) });
    browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.locator('#username').fill('media-preview');
    await page.locator('#password').fill('fixture-password-123');
    await page.locator('#auth-submit').click();
    await page.locator('#workspace').waitFor({ state: 'visible' });
    const login = await page.evaluate(() => state.session);
    await page.evaluate(async () => {
      await api('/api/messages', 'POST', { source: 'manual', account_id: 'preview', conversation_id: 'ime', conversation_name: '中文验证', external_id: 'ime-1', sender_id: 'someone', text: '本周五前提交高数中文作业', sent_at: new Date().toISOString() });
      await refresh();
      state.inboxMode = 'all'; state.category = 'all'; state.search = '';
      await navigate('inbox');
    });
    const search = page.locator('#inbox-search');
    await search.focus();
    await search.fill('高数');
    await page.waitForTimeout(200);
    console.log('SEARCH', await page.evaluate(() => ({ search: state.search, category: state.category, mode: state.inboxMode, count: document.querySelectorAll('.message-row').length, messages: state.snapshot.messages.map(item => ({ id: item.id, text: item.text, triage: item.triage })) })));
    assert(await page.locator('.message-row').count() >= 1, 'Chinese search should show its message');
    const form = new FormData();
    form.set('payload', JSON.stringify({ source: 'wechat', account_id: 'wx', conversation_id: 'class', conversation_name: '班级群', external_id: 'image-1', sender_id: 'wx', direction: 'self', is_self: true, text: '图片消息', message_type: 'image', sent_at: new Date().toISOString(), media: { kind: 'image', status: 'ready', mime: 'image/png', tier: 'h' } }));
    form.set('media', new Blob([await fs.readFile(path.join(root, 'web/icon.svg'))], { type: 'image/png' }), 'image.png');
    // Use a small, real PNG rather than treating an SVG label as a bitmap.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    form.set('media', new Blob([png], { type: 'image/png' }), 'image.png');
    const response = await fetch(base + '/api/messages', { method: 'POST', headers: { Authorization: 'Bearer ' + login.token }, body: form });
    const message = await response.json();
    assert(response.ok, JSON.stringify(message));
    await page.evaluate(async id => { await refresh(); state.inboxMode = 'all'; state.category = 'all'; state.search = ''; state.selected = id; await navigate('inbox'); }, message.id);
    await page.locator('.message-media img').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.detail-byline').innerText(), '班级群 · 我');
    await page.screenshot({ path: path.join(scratch, 'message-image-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(scratch, 'message-image-mobile.png') });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ mediaBrowser: true, searchChinese: true, ownerLabel: true, mobileOverflow: false, errors, evidence: scratch }));
  } finally {
    await browser?.close();
    server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
