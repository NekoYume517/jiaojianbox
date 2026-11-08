const {LocalWorkspace}=require('../desktop/local-workspace.cjs');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'..'),userData=await fs.mkdtemp(path.join(root,'work','offline-smoke-')),vault={};
 const local=new LocalWorkspace({root,userData,python:path.join(root,'work','bundle','python','python.exe'),get:async k=>vault[k],put:async(k,v)=>{vault[k]=v;}});
 try{
  let session=await local.start();assert.equal(session.mode,'offline');
  const request=async(route,method='GET',body)=>{const r=await fetch(session.server+route,{method,headers:{Authorization:'Bearer '+session.token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});assert.equal(r.status,method==='POST'?201:200,await r.clone().text());return r.json();};
  const task=await request('/api/tasks','POST',{title:'离线持久化验收',description:'无需安装系统 Python'});
  assert.equal((await request('/api/snapshot')).tasks[0].id,task.id);
  local.stop();await new Promise(r=>setTimeout(r,500));session=await local.start();
  assert.equal((await request('/api/snapshot')).tasks[0].id,task.id);
  assert.equal((await request('/api/auth/registration')).mode,'closed');
  console.log(JSON.stringify({offlineStart:true,persistsAfterRestart:true,bundledPython:true,scratch:userData}));
 }finally{local.stop();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
