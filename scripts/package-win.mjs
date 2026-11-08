import { packager } from '@electron/packager';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {execFileSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
execFileSync(process.env.PYTHON || 'python',[path.join(root,'scripts','prepare-core-runtime.py')],{cwd:root,stdio:'inherit'});
const coreRuntime=JSON.parse(await fs.readFile(path.join(root,'work','core-runtime.json'),'utf8')).python;
const outArgument=process.argv.find(s=>s.startsWith('--out-dir='));
const zipArgument=process.argv.find(s=>s.startsWith('--electron-zip-dir='));
const bundleAvailable=await fs.access(path.join(root,'work','bundle','manifest.json')).then(()=>true,()=>false);
await fs.mkdir(path.join(root,'web','vendor'),{recursive:true});
await fs.copyFile(path.join(root,'node_modules','echarts','dist','echarts.min.js'),path.join(root,'web','vendor','echarts.min.js'));
await fs.copyFile(path.join(root,'node_modules','echarts','LICENSE'),path.join(root,'web','vendor','echarts.LICENSE'));
await fs.copyFile(path.join(root,'node_modules','echarts','NOTICE'),path.join(root,'web','vendor','echarts.NOTICE'));
const results=await packager({dir:root,name:'JiaojianBox',platform:'win32',arch:'x64',out:outArgument?path.resolve(root,outArgument.slice(10)):path.join(root,'artifacts'),overwrite:true,asar:true,
  // Let electron-packager prune devDependencies while keeping runtime deps (e.g. ws).
  ignore:[/^\/(android|data|tests|artifacts[^/]*|\.venv|\.pytest_cache|work|docs\/verification)($|\/)/,/__pycache__/],
  ...(zipArgument?{electronZipDir:path.resolve(root,zipArgument.split('=').slice(1).join('='))}:{}),
});
for(const output of results){
  const runtimeRoot=path.join(output,'resources','runtime');
  const bundleAvailable=await fs.access(path.join(root,'work','bundle','manifest.json')).then(()=>true,()=>false);
  if(bundleAvailable){
    // 私有 runtime（wechatauto-replica 数据读取 + SnowLuma）：本机执行 scripts/prepare-runtime.py 后才有。
    for(const name of ['python','snowluma'])await fs.cp(path.join(root,'work','bundle',name),path.join(runtimeRoot,name),{recursive:true,filter:source=>!source.includes('__pycache__')});
    await fs.copyFile(path.join(root,'work','bundle','manifest.json'),path.join(runtimeRoot,'manifest.json'));
  } else console.log('Skipping private runtime bundle (open-source build): QQ/微信采集 runtime 见 scripts/prepare-runtime.py');
  const bridgeRoot=path.join(output,'resources','bridge');await fs.mkdir(bridgeRoot,{recursive:true});
  await fs.cp(coreRuntime,path.join(runtimeRoot,'python'),{recursive:true,filter:source=>!source.includes('__pycache__')});
  for(const name of ['snow-loader.mjs','snow-bridge.mjs','drag-watch.exe','tray.png'])await fs.copyFile(path.join(root,'desktop',name),path.join(bridgeRoot,name));
  const pythonRoot=path.join(output,'resources','python');
  await fs.mkdir(pythonRoot,{recursive:true});
  await fs.cp(path.join(root,'collector'),path.join(pythonRoot,'collector'),{recursive:true,filter:source=>!source.includes('__pycache__')});
  await fs.cp(path.join(root,'server'),path.join(pythonRoot,'server'),{recursive:true,filter:source=>!source.includes('__pycache__')});
  await fs.cp(path.join(root,'web'),path.join(pythonRoot,'web'),{recursive:true});
  await fs.copyFile(path.join(root,'requirements.txt'),path.join(pythonRoot,'requirements.txt'));
  await fs.copyFile(path.join(root,'README.md'),path.join(output,'使用说明.md'));
  await fs.copyFile(path.join(root,'THIRD_PARTY_NOTICES.md'),path.join(output,'THIRD_PARTY_NOTICES.md'));
  console.log('Packaged:',output);
}
