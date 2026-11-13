const assert=require('node:assert/strict');const http=require('node:http');
module.exports=async(page,base)=>{
 let cancelled=false,cancelCount=0;const sockets=new Set();
 const upstream=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const notification=!!JSON.parse(body).response_format;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(`data: ${JSON.stringify({choices:[{delta:{content:notification?'{"summary":"正在检查截图材料，':'正在手动处理任务，'}}]})}\n\n`);const timer=setTimeout(()=>res.write(`data: ${JSON.stringify({choices:[{delta:{content:'随后补充提交入口'}}]})}\n\n`),450);res.on('close',()=>{cancelled=true;cancelCount++;clearTimeout(timer)});});
 upstream.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 try{
 const message=await page.evaluate(async url=>{
  await api('/api/settings/llm','PUT',{base_url:url,model:'trigger-live',auto_analyze:true});
  const message=await api('/api/messages','POST',{source:'wechat',account_id:'wx-live',conversation_id:'live-group',conversation_name:'实时流式验收群',external_id:'live-1',text:'上传截图材料并提交作业',sent_at:'2026-11-12T12:00:00+08:00'});
  await navigate('sources');pageNavigation.select('history');await agentUI.reload(true);return message;
 },`http://127.0.0.1:${upstream.address().port}`);
 await page.locator('[data-agent-session]').filter({hasText:'实时流式验收群'}).waitFor();
 await page.locator('[data-agent-session]').filter({hasText:'实时流式验收群'}).click();
 assert.equal(await page.locator('[data-agent-permission=full]').getAttribute('aria-selected'),'true');
 let run=page.locator(`[data-agent-run="notification-${message.id}"]`);
 await run.locator('[data-run-text]').filter({hasText:'正在检查截图材料'}).waitFor();
 await run.locator('[data-run-text]').filter({hasText:'随后补充提交入口'}).waitFor();
 const node=await run.elementHandle();
 await page.locator('[data-agent-input]').fill('处理时仍保留草稿');
 await page.waitForTimeout(400);
 assert(await node.evaluate(el=>el.isConnected),'live stream must preserve bubble DOM identity');
 await page.evaluate(async()=>{await navigate('tasks');await new Promise(resolve=>setTimeout(resolve,220));});
 await page.evaluate(async id=>{await navigate('sources');pageNavigation.select('history');await agentUI.reload(true);return id},message.id);
 run=page.locator(`[data-agent-run="notification-${message.id}"]`);
 await run.locator('[data-run-text]').filter({hasText:'随后补充提交入口'}).waitFor();
 await page.screenshot({path:'work/trigger-live-preview.png'});
 await run.locator('[data-agent-stop]').click();
 await run.locator('[data-run-status]').filter({hasText:'已停止'}).waitFor();
 for(let i=0;i<40&&!cancelled;i++)await page.waitForTimeout(50);
 assert(cancelled,'stop must cancel upstream generation');
 assert.equal(await page.locator('[data-agent-input]').inputValue(),'处理时仍保留草稿');
 const beforeCancel=cancelCount;
 await page.evaluate(async()=>{const created=await api('/api/agent/sessions','POST',{title:'手动停止验收'});await agentUI.reload(true,created.session.id)});
 await page.locator('[data-agent-session]').filter({hasText:'手动停止验收'}).click();
 await page.locator('[data-agent-input]').fill('手动处理并保持流式输出');
 await page.locator('[data-agent-send]').click();
 await page.locator('.agent-message-assistant .agent-message-copy').filter({hasText:'正在手动处理任务'}).waitFor();
 await page.locator('[data-agent-stop-local]').click();
 for(let i=0;i<40&&cancelCount===beforeCancel;i++)await page.waitForTimeout(50);
 assert(cancelCount>beforeCancel,'manual stop must cancel its actual upstream request');
 await page.waitForFunction(()=>!document.querySelector('[data-agent-input]').disabled);

 await page.evaluate(async()=>{await navigate('settings');pageNavigation.select('model')});
 assert.equal(await page.locator('#llm-auto-task,#auto-task-line').count(),0);
 console.log('Live trigger UI: pre-completion streamed output, stable DOM, full access default, real stop, draft retention and removed obsolete setting passed.');
 }finally{for(const socket of sockets)socket.destroy();await new Promise(r=>upstream.close(r));}
};
