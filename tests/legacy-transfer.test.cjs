const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
test('legacy migration directly reads all message pages and retains attachment bytes',async()=>{
 const fileId=crypto.randomUUID(),taskId=crypto.randomUUID(),messages=Array.from({length:201},()=>({id:crypto.randomUUID(),text:'通知'})),calls=[];
 const window={};
 const source=await fs.readFile(path.join(__dirname,'../web/legacy-transfer.js'),'utf8');
 vm.runInNewContext(source,{window,TextEncoder,Blob,AbortSignal,crypto:crypto.webcrypto,fetch:async (url,options)=>{
  calls.push(url);assert.equal(options.headers.Authorization,'Bearer fixture');assert(url.startsWith('https://self.example.test/'));
  if(url.endsWith('/api/snapshot'))return new Response(JSON.stringify({tasks:[{id:taskId,title:'测试任务',attachments:[{id:fileId,name:'材料.txt',kind:'receipt'}]}],shelf:[]}));
  if(url.includes('/api/messages?'))return new Response(JSON.stringify(url.includes('&before=')?messages.slice(200):messages.slice(0,200)));
  if(url.endsWith('/api/files/'+fileId))return new Response('fixture');
  throw Error('Unexpected network route');
 }});
 const blob=await window.legacyTransfer.archive({server:'https://self.example.test',user_id:'user',token:'fixture'});
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'jjb-legacy-'));
 try{
  const archive=path.join(temp,'workspace.zip');await fs.writeFile(archive,Buffer.from(await blob.arrayBuffer()));
  await require('extract-zip')(archive,{dir:path.join(temp,'extracted')});
  const manifest=JSON.parse(await fs.readFile(path.join(temp,'extracted','manifest.json'),'utf8'));
  assert.equal(manifest.messages.length,201);assert.equal(manifest.files[0].kind,'receipt');
  assert.equal(await fs.readFile(path.join(temp,'extracted','files',fileId),'utf8'),'fixture');
  assert.equal(calls.filter(p=>p.includes('/api/messages?')).length,2);
 }finally{
  assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));assert(path.basename(temp).startsWith('jjb-legacy-'));
  await fs.rm(temp,{recursive:true,force:true});
 }
});
