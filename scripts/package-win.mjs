import { packager } from '@electron/packager';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const outArgument=process.argv.find(s=>s.startsWith('--out-dir='));
const zipArgument=process.argv.find(s=>s.startsWith('--electron-zip-dir='));
await fs.access(path.join(root,'work','bundle','manifest.json'));
await fs.mkdir(path.join(root,'web','vendor'),{recursive:true});
await fs.copyFile(path.join(root,'node_modules','echarts','dist','echarts.min.js'),path.join(root,'web','vendor','echarts.min.js'));
await fs.copyFile(path.join(root,'node_modules','echarts','LICENSE'),path.join(root,'web','vendor','echarts.LICENSE'));
await fs.copyFile(path.join(root,'node_modules','echarts','NOTICE'),path.join(root,'web','vendor','echarts.NOTICE'));
const results=await packager({dir:root,name:'JiaojianBox',platform:'win32',arch:'x64',out:outArgument?path.resolve(root,outArgument.slice(10)):path.join(root,'artifacts'),overwrite:true,asar:true,
  // Let electron-packager prune devDependencies while keeping runtime deps (e.g. ws).
  ignore:[/^\/(data|tests|artifacts[^/]*|\.venv|\.pytest_cache|work|docs\/verification)($|\/)/,/__pycache__/],
  ...(zipArgument?{electronZipDir:path.resolve(root,zipArgument.split('=').slice(1).join('='))}:{}),
});
for(const output of results){
  const runtimeRoot=path.join(output,'resources','runtime');
  for(const name of ['python','snowluma'])await fs.cp(path.join(root,'work','bundle',name),path.join(runtimeRoot,name),{recursive:true,filter:source=>!source.includes('__pycache__')});
  await fs.copyFile(path.join(root,'work','bundle','manifest.json'),path.join(runtimeRoot,'manifest.json'));
  const bridgeRoot=path.join(output,'resources','bridge');await fs.mkdir(bridgeRoot,{recursive:true});
  for(const name of ['snow-loader.mjs','snow-bridge.mjs','drag-watch.exe','tray.png'])await fs.copyFile(path.join(root,'desktop',name),path.join(bridgeRoot,name));
  const pythonRoot=path.join(output,'resources','python');
  await fs.mkdir(pythonRoot,{recursive:true});
  await fs.cp(path.join(root,'collector'),path.join(pythonRoot,'collector'),{recursive:true,filter:source=>!source.includes('__pycache__')});
  await fs.copyFile(path.join(root,'requirements.txt'),path.join(pythonRoot,'requirements.txt'));
  await fs.copyFile(path.join(root,'README.md'),path.join(output,'使用说明.md'));
  await fs.copyFile(path.join(root,'THIRD_PARTY_NOTICES.md'),path.join(output,'THIRD_PARTY_NOTICES.md'));
  console.log('Packaged:',output);
}
