const { chromium } = require('playwright');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const oldInstaller = process.env.JJB_OLD_INSTALLER ? path.resolve(process.env.JJB_OLD_INSTALLER) : '';
const newInstaller = process.env.JJB_NEW_INSTALLER ? path.resolve(process.env.JJB_NEW_INSTALLER) : '';
const newVersion = path.basename(newInstaller).match(/JiaojianBox-Setup-(.+)-x64\.exe/)?.[1];

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForMainPage(port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1200 });
      for (const page of browser.contexts()[0].pages()) {
        try {
          if (await page.locator('#offline-login').count()) return { browser, page };
        } catch {}
      }
      await browser.close();
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('desktop main workspace page did not load');
}

function stopInstallerProcesses() {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${newInstaller.replaceAll("'", "''")}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { windowsHide: true });
}

async function launchDesktop(target, profile, port) {
  const child = spawn(path.join(target, '交件箱.exe'), ['--silent'], {
    windowsHide: true,
    env: { ...process.env, JJB_USER_DATA: profile, JJB_DEBUG_PORT: String(port) },
    stdio: 'ignore',
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const { browser, page } = await waitForMainPage(port);
  return { child, exited, browser, page };
}

async function main() {
  assert(oldInstaller, 'JJB_OLD_INSTALLER must point to the legacy installer');
  assert(newInstaller, 'JJB_NEW_INSTALLER must point to the new installer');
  assert(newVersion, 'new installer filename must include a version');
  const scratch = await fs.mkdtemp(path.join(root, 'work', 'legacy-update-flow-'));
  const target = path.join(scratch, 'app');
  const profile = path.join(scratch, 'profile');
  let active, browser;
  try {
    execFileSync(oldInstaller, ['--silent', '--dir', target, '--no-shortcuts', '--no-register'], { timeout: 180000, windowsHide: true });
    const sentinel = path.join(profile, 'legacy-update-sentinel.txt');
    await fs.mkdir(profile, { recursive: true });
    await fs.writeFile(sentinel, 'preserved');

    const firstPort = await freePort();
    active = await launchDesktop(target, profile, firstPort);
    browser = active.browser;
    await active.page.waitForFunction(() => window.desktop?.set && window.desktop?.updateInstall);
    await active.page.evaluate(async installer => {
      await desktop.set('update-state', { status: 'downloaded', path: installer, latest: '0.6.23-preview', progress: 1 });
      await desktop.updateInstall();
    }, newInstaller);
    await Promise.race([
      active.exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error('old desktop did not exit')), 10000)),
    ]);
    assert.equal(active.child.exitCode, 0);
    await browser.close();
    browser = null;
    stopInstallerProcesses();

    const secondPort = await freePort();
    active = await launchDesktop(target, profile, secondPort);
    browser = active.browser;
    execFileSync(newInstaller, ['--silent', '--dir', target, '--no-shortcuts', '--no-register'], { timeout: 180000, windowsHide: true });
    await active.exited;
    await browser.close();
    browser = null;

    const manifest = JSON.parse(await fs.readFile(path.join(target, '.jiaojianbox-install.json'), 'utf8'));
    assert.equal(manifest.version, newVersion);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'preserved');

    const thirdPort = await freePort();
    active = await launchDesktop(target, profile, thirdPort);
    browser = active.browser;
    assert.equal(await active.page.evaluate(() => desktop.platform().then(value => value.version)), newVersion);
    console.log(JSON.stringify({
      legacyBuiltInUpdateSelfExited: true,
      manualInstallerGracefullyStoppedLegacyApp: true,
      dataPreserved: true,
      newVersion,
      evidence: scratch,
    }));
  } finally {
    await browser?.close().catch(() => {});
    if (active?.child.exitCode === null) {
      active.child.kill();
      await active.exited;
    }
    stopInstallerProcesses();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
