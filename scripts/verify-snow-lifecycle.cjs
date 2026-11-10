const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn,fork}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'jjb-snow-lifecycle-'));
const fixture=path.join(scratch,'bridge-fixture.mjs');
fs.writeFileSync(fixture,`import {start} from ${JSON.stringify(pathToFileURL(path.resolve(__dirname,'../desktop/snow-bridge.mjs')).href)};
const instance={uin:'fixture',subscribeDebugEvents(fn){const t=setInterval(()=>fn({type:'fixture'}),40);return ()=>clearInterval(t);}};
await start({hookManager:{listProcesses:async()=>[{pid:123,uin:'fixture'}]},oneBotManager:{getInstances:()=>[instance]}});
setInterval(()=>{},1000);`);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate,label,ms=5000){const end=Date.now()+ms;while(Date.now()<end){if(predicate())return;await delay(20);}throw Error(label);}
function launch(extra={},ipc=false){const env={...process.env,JJB_SNOW_STDIO:ipc?'0':'1',JJB_SNOW_PARENT_PID:String(process.pid),...extra};const child=ipc?fork(fixture,[],{env,windowsHide:true,stdio:['pipe','pipe','pipe','ipc']}):spawn(process.execPath,[fixture],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});child.lines=[];child.errors='';child.stdout.on('data',data=>{for(const line of data.toString().trim().split('\n'))try{child.lines.push(JSON.parse(line));}catch{}});child.stderr.on('data',d=>child.errors+=d);child.on('message',x=>child.lines.push(x));return child;}
async function ready(child){await until(()=>child.lines.some(x=>x.kind==='ready'),'bridge failed to start: '+child.errors);}
async function exited(child){await until(()=>child.exitCode!==null,'bridge survived loss of host');assert.equal(child.exitCode,0,child.errors);}
test('stdio remains functional while host is connected; EOF then exits',async()=>{const c=launch();try{await ready(c);c.stdin.write(JSON.stringify({id:'probe',method:'processes'})+'\n');await until(()=>c.lines.some(x=>x.id==='probe'&&x.ok),'normal command failed');await delay(400);assert.equal(c.exitCode,null);c.stdin.end();await exited(c);}finally{c.kill();}});
test('IPC disconnect terminates bridge',async()=>{const c=launch({},true);try{await ready(c);c.disconnect();await exited(c);}finally{c.kill();}});
test('lost stdout consumer terminates bridge on broken pipe',async()=>{const c=launch();try{await ready(c);c.stdout.destroy();await exited(c);}finally{c.kill();}});
test('dead parent terminates bridge even when stdin remains open',async()=>{const host=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});const c=launch({JJB_SNOW_PARENT_PID:String(host.pid)});try{await ready(c);host.kill();await until(()=>host.exitCode!==null||host.signalCode!==null,'host did not stop');await exited(c);assert.equal(c.stdin.writableEnded,false);}finally{host.kill();c.kill();}});
process.on('exit',()=>{fs.rmSync(fixture,{force:true});try{fs.rmdirSync(scratch);}catch{}});
