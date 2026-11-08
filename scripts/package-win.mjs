import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
execFileSync(process.env.PYTHON||'python',[path.join(root,'scripts/package-native.py'),...process.argv.slice(2)],{cwd:root,stdio:'inherit'});
