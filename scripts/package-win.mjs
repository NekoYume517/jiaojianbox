import { build } from 'electron-builder';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.env.PYTHON || 'python', [path.join(root, 'scripts', 'build-helper.py')], { cwd: root, stdio: 'inherit' });
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const installedElectron = path.join(root, 'node_modules', 'electron', 'dist');
const electronDist = await fs.access(path.join(installedElectron, 'electron.exe')).then(() => installedElectron).catch(() => undefined);
const outArgument = process.argv.find(item => item.startsWith('--out-dir='));
const outputRoot = outArgument ? path.resolve(root, outArgument.slice(10)) : path.join(root, 'artifacts');
process.env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/';
process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||= 'https://npmmirror.com/mirrors/electron-builder-binaries/';

await fs.mkdir(path.join(root, 'web', 'vendor'), { recursive: true });
await fs.copyFile(path.join(root, 'node_modules', 'echarts', 'dist', 'echarts.min.js'), path.join(root, 'web', 'vendor', 'echarts.min.js'));
await fs.copyFile(path.join(root, 'node_modules', 'echarts', 'LICENSE'), path.join(root, 'web', 'vendor', 'echarts.LICENSE'));
await fs.copyFile(path.join(root, 'node_modules', 'echarts', 'NOTICE'), path.join(root, 'web', 'vendor', 'echarts.NOTICE'));

const noCacheFilter = ['**/*', '!**/__pycache__/**'];
await build({
  publish: 'never',
  config: {
    electronVersion: packageJson.devDependencies.electron,
    electronDist,
    directories: { output: outputRoot },
    files: ['desktop/**/*', 'web/**/*'],
    extraResources: [
      { from: path.join(root, 'work', 'helper', 'collector-agent'), to: 'runtime/collector-agent' },
      { from: path.join(root, 'work', 'helper', 'local-server'), to: 'runtime/local-server' },
      { from: path.join(root, 'vendor', 'snowluma'), to: 'runtime/snowluma', filter: noCacheFilter },
      ...['snow-loader.mjs', 'snow-bridge.mjs', 'drag-watch.exe', 'tray.png'].map(name => ({ from: path.join(root, 'desktop', name), to: `bridge/${name}` })),
    ],
    icon: path.join(root, 'build', 'installer.ico'),
    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
      icon: path.join(root, 'build', 'installer.ico'),
      requestedExecutionLevel: 'asInvoker',
    },
    nsis: {
      oneClick: false,
      perMachine: true,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: '交件箱',
      artifactName: 'JiaojianBox-Setup-${version}-x64.exe',
    },
  },
});
console.log('Installer:', path.join(outputRoot, `JiaojianBox-Setup-${packageJson.version}-x64.exe`));
