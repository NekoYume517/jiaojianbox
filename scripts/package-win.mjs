import { packager } from '@electron/packager';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const zipArgument=process.argv.find(s=>s.startsWith('--electron-zip-dir='));
const results=await packager({dir:root,name:'JiaojianBox',platform:'win32',arch:'x64',out:path.join(root,'artifacts'),overwrite:true,asar:true,
  ignore:[/^\/(data|tests|artifacts|\.venv|\.pytest_cache|work|node_modules|docs\/verification)($|\/)/,/__pycache__/],
  ...(zipArgument?{electronZipDir:path.resolve(root,zipArgument.split('=').slice(1).join('='))}:{}),
});
for(const output of results){
  const pythonRoot=path.join(output,'resources','python');
  await fs.mkdir(pythonRoot,{recursive:true});
  await fs.cp(path.join(root,'collector'),path.join(pythonRoot,'collector'),{recursive:true,filter:source=>!source.includes('__pycache__')});
  await fs.copyFile(path.join(root,'requirements.txt'),path.join(pythonRoot,'requirements.txt'));
  await fs.copyFile(path.join(root,'README.md'),path.join(output,'使用说明.md'));
  console.log('Packaged:',output);
}
