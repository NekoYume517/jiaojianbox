'use strict';
(()=>{
 const entries=new Map();let paintTimer;
 function preview(text){const out=[];for(const field of ['reason','summary']){const re=new RegExp('"'+field+'"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)');const match=re.exec(text);if(match)try{out.push(JSON.parse('"'+match[1]+'"'));}catch{}}return out.join('\n');}
 function description(entry){const labels={starting:'正在准备分析',context:'已准备通知和上下文',extracting:'正在提取文件正文',request:'请求已发送，等待模型首字',receiving:'正在接收分析结果',validating:'正在校验分类、日期和材料要求',waiting:'模型仍在处理，等待返回'};let text=labels[entry.stage]||'正在分析';if(entry.context_count!=null)text+=' · '+entry.context_count+' 条上下文';if(entry.task_count!=null)text+=' · '+entry.task_count+' 项候选待办';if(entry.image_count)text+=' · '+entry.image_count+' 张图片';if(entry.extracted_characters!=null)text+=' · 正文 '+entry.extracted_characters+' 字';if(entry.received_chars)text+=' · 已接收 '+entry.received_chars+' 字';text+=' · '+Math.floor((Date.now()-entry.started)/1000)+' 秒';return text;}
 function paint(){paintTimer=null;document.querySelectorAll('[data-analysis-key]').forEach(el=>{const entry=entries.get(el.dataset.analysisKey);if(!entry)return;el.querySelector('[data-live-status]').textContent=description(entry);el.querySelector('[data-live-preview]').textContent=preview(entry.text);});}
 function update(key,value){const entry=entries.get(key);if(!entry)return;Object.assign(entry,value);if(value.delta)entry.text+=value.delta;if(!paintTimer)paintTimer=setTimeout(paint,80);}
 function markup(key){const entry=entries.get(key)||{stage:'starting',started:Date.now(),text:''};return '<div class="analysis-live" data-analysis-key="'+esc(key)+'" role="status"><p class="helper" data-live-status>'+esc(description(entry))+'</p><p class="analysis-live-preview" data-live-preview>'+esc(preview(entry.text))+'</p></div>';}
 function performance(value){
  const p=value?.performance;if(!p)return '';
  const valid=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
  const items=[];
  if(valid(p.first_token_ms)&&p.streamed===true)items.push('首字 '+(p.first_token_ms/1000).toFixed(1)+' 秒');
  if(valid(p.elapsed_ms))items.push('模型总耗时 '+(p.elapsed_ms/1000).toFixed(1)+' 秒');
  if(valid(p.input_chars))items.push('输入 '+p.input_chars.toLocaleString('zh-CN')+' 字（含规则）');
  return items.length?'<p class="helper">'+items.join(' · ')+'</p>':'';
 }
 async function run(route,body,key){const controller=new AbortController();entries.set(key,{stage:'starting',started:Date.now(),text:'',controller});const timeout=setTimeout(()=>controller.abort(),190000);let result,ended=false;
  try{const response=await fetch(apiUrl(route)+(route.includes('?')?'&':'?')+'stream=true',{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+state.session.token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
   if(!response.ok){let data;try{data=await response.json();}catch{}throw Error(typeof data?.detail==='string'?data.detail:'分析请求失败（HTTP '+response.status+'）');}
   if(!response.headers.get('content-type')?.includes('text/event-stream'))return await response.json(); // Compatible with an older server.
   const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
   function consume(block){let event='message',data='';for(const line of block.split('\n')){if(line.startsWith('event:'))event=line.slice(6).trim();if(line.startsWith('data:'))data+=line.slice(5).trimStart();}if(!data)return;const value=JSON.parse(data);if(event==='error')throw Error(typeof value.message==='string'?value.message:'分析失败');if(event==='progress')update(key,value);if(event==='result'){result=value;ended=true;}}
   while(true){const {value,done}=await reader.read();buffer+=decoder.decode(value||new Uint8Array(),{stream:!done});buffer=buffer.replace(/\r\n/g,'\n');let end;while((end=buffer.indexOf('\n\n'))>=0){consume(buffer.slice(0,end));buffer=buffer.slice(end+2);}if(done)break;}
   if(!ended)throw Error('分析连接中断，尚未取得完整结果，请重试');return result;
  }catch(error){if(controller.signal.aborted)throw Error('本次分析已停止或超时');throw error;}finally{clearTimeout(timeout);controller.abort();entries.delete(key);}
 }
 setInterval(()=>{if(entries.size)paint();},500);
 window.liveAnalysis={run,markup,performance,cancel:key=>entries.get(key)?.controller.abort(),cancelAll:()=>entries.forEach(entry=>entry.controller.abort())};
})();
