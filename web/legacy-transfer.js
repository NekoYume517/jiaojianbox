'use strict';
/* Older servers expose snapshot/messages/files but do not yet have the archive endpoint.
   Build a standard ZIP locally; traffic remains directly between this client and each server. */
window.legacyTransfer = (() => {
  const enc=new TextEncoder();
  const table=Uint32Array.from({length:256},(_,i)=>{let n=i;for(let j=0;j<8;j++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
  function crc(bytes){let n=0xffffffff;for(const b of bytes)n=table[(n^b)&255]^(n>>>8);return (n^0xffffffff)>>>0;}
  function zip(entries){
    let offset=0;const parts=[],central=[];
    for(const [name,bytes] of entries){
      const key=enc.encode(name),sum=crc(bytes),h=new Uint8Array(30+key.length),v=new DataView(h.buffer);
      v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);v.setUint16(12,0x21,true);v.setUint32(14,sum,true);v.setUint32(18,bytes.length,true);v.setUint32(22,bytes.length,true);v.setUint16(26,key.length,true);h.set(key,30);
      const c=new Uint8Array(46+key.length),w=new DataView(c.buffer);w.setUint32(0,0x02014b50,true);w.setUint16(4,20,true);w.setUint16(6,20,true);w.setUint16(8,0x800,true);w.setUint16(14,0x21,true);w.setUint32(16,sum,true);w.setUint32(20,bytes.length,true);w.setUint32(24,bytes.length,true);w.setUint16(28,key.length,true);w.setUint32(42,offset,true);c.set(key,46);
      parts.push(h,bytes);central.push(c);offset+=h.length+bytes.length;
    }
    const size=central.reduce((sum,p)=>sum+p.length,0),end=new Uint8Array(22),v=new DataView(end.buffer);
    v.setUint32(0,0x06054b50,true);v.setUint16(8,entries.length,true);v.setUint16(10,entries.length,true);v.setUint32(12,size,true);v.setUint32(16,offset,true);
    return new Blob([...parts,...central,end],{type:'application/zip'});
  }
  async function archive(session){
    const get=async route=>{const r=await fetch(session.server+route,{headers:{Authorization:'Bearer '+session.token},signal:AbortSignal.timeout(120000)});if(!r.ok)throw Error('旧服务数据读取失败，请保留来源工作区后重试');return r;};
    const snapshot=await (await get('/api/snapshot')).json(),messages=[];let before='';
    for(let page=0;page<500;page++){
      const batch=await (await get('/api/messages?limit=200'+(before?'&before='+encodeURIComponent(before):''))).json();
      if(!Array.isArray(batch))throw Error('旧服务消息格式不兼容');
      messages.push(...batch);if(batch.length<200)break;
      const next=batch.at(-1).id;if(next===before)throw Error('旧服务分页未能继续');before=next;
      if(page===499)throw Error('消息数量过多，请先升级来源服务后导出');
    }
    const files=new Map(),entries=[];
    for(const task of snapshot.tasks)for(const item of task.attachments||[])files.set(item.id,{...item,task_id:task.id});
    for(const item of snapshot.shelf||[])if(!files.has(item.id))files.set(item.id,{...item,task_id:item.task_id||null});
    let size=0;
    for(const item of files.values()){
      const bytes=new Uint8Array(await (await get('/api/files/'+encodeURIComponent(item.id))).arrayBuffer());size+=bytes.length;
      if(bytes.length>50*1024**2||size>500*1024**2)throw Error('旧服务兼容迁移包过大，请先升级来源服务');
      item.size=bytes.length;item.sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');entries.push(['files/'+item.id,bytes]);
    }
    const origin=[...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(session.server+'|'+session.user_id)))].map(x=>x.toString(16).padStart(2,'0')).join('');
    const manifest={format:'jiaojianbox-workspace',version:1,workspace_id:'legacy:'+origin,tasks:snapshot.tasks,messages,files:[...files.values()],shelf:(snapshot.shelf||[]).map(item=>({...item,file_id:item.id}))};
    try{const config=await (await get('/api/settings/llm')).json();delete config.api_key;delete config.has_key;manifest.llm_settings=config;}catch{}
    const metadata=enc.encode(JSON.stringify(manifest));if(metadata.length>20*1024**2)throw Error('旧服务数据清单过大，请先升级来源服务');entries.unshift(['manifest.json',metadata]);
    return zip(entries);
  }
  return {archive};
})();
