const { chromium } = require('playwright');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const installer = process.env.JJB_UPDATE_INSTALLER ? path.resolve(process.env.JJB_UPDATE_INSTALLER) : '';
const version = path.basename(installer).match(/JiaojianBox-Setup-(.+)-x64\.exe/)?.[1];

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForCDP(port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1200 });
      return browser;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  throw new Error('desktop WebView2 did not expose its debug endpoint');
}

async function waitForMainPage(browser) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    for (const page of browser.contexts()[0].pages()) {
      try {
        if (await page.locator('#offline-login').count()) return page;
      } catch {}
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('desktop main workspace page did not load');
}

async function main() {
  assert(installer, 'JJB_UPDATE_INSTALLER must point to an installer');
  assert(version, 'installer filename must include a version');
  const scratch = await fs.mkdtemp(path.join(root, 'work', 'update-flow-'));
  const target = path.join(scratch, 'app');
  const profile = path.join(scratch, 'profile');
  let app, browser;
  try {
    execFileSync(installer, ['--silent', '--dir', target, '--no-shortcuts', '--no-register'], { timeout: 180000, windowsHide: true });
    const sentinel = path.join(profile, 'update-sentinel.txt');
    await fs.mkdir(profile, { recursive: true });
    await fs.writeFile(sentinel, 'preserved');
    const firstPort = await freePort();
    app = spawn(path.join(target, '交件箱.exe'), ['--silent'], {
      windowsHide: true,
      env: { ...process.env, JJB_USER_DATA: profile, JJB_DEBUG_PORT: String(firstPort) },
      stdio: 'ignore',
    });
    const firstExit = new Promise(resolve => app.once('exit', resolve));
    browser = await waitForCDP(firstPort);
    const page = await waitForMainPage(browser);
    await page.waitForFunction(() => window.desktop?.set && window.desktop?.updateInstall);
    await page.evaluate(async ({ installer }) => {
      await desktop.set('update-state', { status: 'downloaded', path: installer, latest: '0.6.23-preview', progress: 1 });
      await desktop.updateInstall();
    }, { installer });
    await page.waitForTimeout(2000);
    assert.equal(app.exitCode, null, 'desktop exited when the installer was launched');
    assert(await page.evaluate(() => desktop.platform().then(value => Boolean(value?.version))), 'desktop stopped responding after launching the installer');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${installer.replaceAll("'", "''")}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { windowsHide: true });
    await browser.close();
    browser = null;

    execFileSync(installer, ['--silent', '--dir', target, '--no-shortcuts', '--no-register'], { timeout: 180000, windowsHide: true });
    await firstExit;
    const manifest = JSON.parse(await fs.readFile(path.join(target, '.jiaojianbox-install.json'), 'utf8'));
    assert.equal(manifest.version, version);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'preserved');

    const secondPort = await freePort();
    app = spawn(path.join(target, '交件箱.exe'), ['--silent'], {
      windowsHide: true,
      env: { ...process.env, JJB_USER_DATA: profile, JJB_DEBUG_PORT: String(secondPort) },
      stdio: 'ignore',
    });
    browser = await waitForCDP(secondPort);
    const updatedPage = await waitForMainPage(browser);
    await updatedPage.waitForFunction(() => window.desktop?.platform);
    assert.equal(await updatedPage.evaluate(() => desktop.platform().then(value => value.version)), version);
    console.log(JSON.stringify({ updateFlow: true, installerExitRequest: true, dataPreserved: true, version, evidence: scratch }));
  } finally {
    await browser?.close().catch(() => {});
    if (app && app.exitCode === null) {
      app.kill();
      await new Promise(resolve => app.once('exit', resolve));
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
