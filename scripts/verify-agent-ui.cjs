const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');

async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const scratch = await fs.mkdtemp(path.join(root, 'work/agent-ui-'));
  const [appPort, modelPort] = await Promise.all([freePort(), freePort()]);
  const base = `http://127.0.0.1:${appPort}`;
  const modelRequests = [];
  const model = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    modelRequests.push(JSON.parse(body));
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '已检查' } }] })}\n\n`);
    await new Promise(resolve => setTimeout(resolve, 35));
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '当前待办。' } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 24, completion_tokens: 6, total_tokens: 30 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => model.listen(modelPort, '127.0.0.1', resolve));

  const server = spawn(process.env.JJB_VERIFY_SERVER || path.join(root, 'work/JiaojianBox-UISmoke.exe'), [
    '-data', scratch,
    '-listen', `127.0.0.1:${appPort}`,
  ], {
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, JJB_REQUIRE_EMAIL: 'false' },
  });

  let browser;
  try {
    const deadline = Date.now() + 15000;
    while (true) {
      try {
        if ((await fetch(base + '/health')).ok) break;
      } catch {}
      if (Date.now() > deadline) throw Error('Server did not start');
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const register = await fetch(base + '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'agent_ui_user', password: 'agent-ui-password' }),
    });
    assert(register.ok);
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'agent_ui_user', password: 'agent-ui-password' }),
    });
    assert(login.ok);
    const session = { ...await login.json(), server: base };

    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.JJB_CHROMIUM || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: 'dark' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(value => localStorage.setItem('jjb-session', JSON.stringify(value)), session);
    await page.goto(base);
    await page.locator('#workspace').waitFor({ state: 'visible' });
    await page.locator('[data-onboard=skip]').click();
    await page.evaluate(async modelURL => {
      await api('/api/settings/llm', 'PUT', { base_url: modelURL, model: 'agent-fixture' });
      await navigate('agent');
    }, `http://127.0.0.1:${modelPort}`);

    await page.getByRole('heading', { name: 'AI', exact: true }).waitFor();
    assert.equal(await page.locator('[data-agent-permission][aria-selected=true]').textContent(), '受限模式');
    await page.locator('[data-agent-permission=full]').click();
    assert.equal(await page.locator('[data-agent-permission=full]').getAttribute('aria-selected'), 'true');

    const input = page.locator('[data-agent-input]');
    await input.fill('检查当前待办');
    await page.locator('[data-agent-form]').evaluate(form => form.requestSubmit());
    await page.getByText('已检查当前待办。', { exact: true }).waitFor();
    assert.equal(modelRequests.length, 1);
    assert.equal(modelRequests[0].response_format, undefined, 'agent requests must use normal text streaming');
    assert.equal(modelRequests[0].messages.at(-1).content, '检查当前待办');
    assert(await page.locator('[data-agent-context]').innerText().then(value => value.includes('/')));
    assert(await input.isEnabled());

    page.once('dialog', dialog => dialog.accept());
    await page.locator('[data-agent-clear]').click();
    await page.locator('[data-agent-empty]').waitFor();

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 760 });
      await page.waitForTimeout(80);
      const layout = await page.evaluate(() => {
        const shell = document.querySelector('.agent-shell').getBoundingClientRect();
        const composer = document.querySelector('.agent-composer').getBoundingClientRect();
        return {
          scrollWidth: document.documentElement.scrollWidth,
          width: innerWidth,
          shellWidth: shell.width,
          composerWidth: composer.width,
        };
      });
      assert(layout.scrollWidth <= width, `AI page overflows horizontally at ${width}px`);
      assert(layout.shellWidth <= width && layout.composerWidth <= width, `AI frame exceeds ${width}px viewport`);
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({
      agentUI: true,
      streaming: true,
      permissionSwitch: true,
      contextUsage: true,
      clearContext: true,
      responsive: [390, 320],
      pageErrors: 0,
      evidence: scratch,
    }));
  } finally {
    await browser?.close();
    server.kill();
    await new Promise(resolve => model.close(resolve));
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
