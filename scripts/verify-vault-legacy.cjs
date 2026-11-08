const {spawn}=require('node:child_process'),path=require('node:path'),fs=require('node:fs/promises');
(async()=>{const root=path.resolve(__dirname,'..'),dir=await fs.mkdtemp(path.join(root,'work','vault-legacy-'));const source=path.join(dir,'main.cjs');
await fs.writeFile(source,`const {app,safeStorage}=require('electron');const fs=require('node:fs/promises'),path=require('node:path');app.setPath('userData',process.argv[2]);app.whenReady().then(async()=>{await fs.mkdir(path.join(process.argv[2],'vault'),{recursive:true});const data=await safeStorage.encryptStringAsync(JSON.stringify({theme:'dark',palette:'nord',density:'compact',textSize:'normal'}));await fs.writeFile(path.join(process.argv[2],'vault','appearance.bin'),data);app.quit();});`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
await new Promise((resolve,reject)=>{const child=spawn(require('electron'),[source,dir],{env,windowsHide:true,stdio:'ignore'});child.on('exit',code=>code===0?resolve():reject(Error('legacy encryption failed')));child.on('error',reject);});
const blob=await fs.readFile(path.join(dir,'vault','appearance.bin'));console.log(JSON.stringify({profile:dir,prefix:blob.subarray(0,8).toString('hex')}));
})().catch(e=>{console.error(e);process.exitCode=1});
