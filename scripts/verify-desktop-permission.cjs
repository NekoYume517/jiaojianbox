const assert=require('node:assert/strict');const http=require('node:http');
module.exports=async(page,base)=>{
 const seen=[],requestFailures=[];
 page.on('requestfailed',request=>{
  if(request.url().startsWith('http://127.0.0.1:')&&request.url().includes('/api/agent/sessions/'))requestFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText||''}`);
 });
 const proxy=http.createServer((request,response)=>{
  seen.push(`${request.method} ${request.url} auth=${request.headers.authorization?'yes':'no'} acrm=${request.headers['access-control-request-method']||''}`);
  const forwarded=http.request(new URL(request.url,base),{method:request.method,headers:{...request.headers,host:new URL(base).host}},upstream=>{response.writeHead(upstream.statusCode,upstream.headers);upstream.pipe(response)});
  forwarded.on('error',()=>{response.writeHead(502);response.end()});request.pipe(forwarded);
 });
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 const crossOrigin=`http://127.0.0.1:${proxy.address().port}`;
 const previous=await page.evaluate(()=>state.session.server);
 try{
  await page.evaluate(async()=>{await navigate('sources');pageNavigation.select('history');const created=await api('/api/agent/sessions','POST',{title:'桌面跨域权限验收'});await agentUI.reload(true,created.session.id)});
  await page.locator('[data-agent-session]').filter({hasText:'桌面跨域权限验收'}).click();
  await page.locator('[data-agent-input]').fill('权限切换保留这段草稿');
  await page.evaluate(url=>{state.session.server=url},crossOrigin);
  await page.locator('[data-agent-permission=full]').click();
  await page.waitForFunction(()=>document.querySelector('[data-agent-permission=full]').getAttribute('aria-selected')==='true');
   const waitForRequest=async prefix=>{
    const deadline=Date.now()+3000;
    while(Date.now()<deadline&&!seen.some(value=>value.startsWith(prefix)))await new Promise(resolve=>setTimeout(resolve,25));
    const toast=await page.locator('#toast-text').textContent().catch(()=> '');
    assert(seen.some(value=>value.startsWith(prefix)),`browser did not send ${prefix}; seen=${JSON.stringify(seen)} failures=${JSON.stringify(requestFailures)} toast=${JSON.stringify(toast)}`);
   };
   await waitForRequest('PATCH /api/agent/sessions/');
   const patch=seen.find(value=>value.startsWith('PATCH /api/agent/sessions/'));
   assert(patch.includes('auth=yes'),'cross-origin PATCH must carry the current session');
  assert.equal(await page.locator('[data-agent-input]').inputValue(),'权限切换保留这段草稿');
  await page.locator('[data-agent-permission=restricted]').click();
  await page.waitForFunction(()=>document.querySelector('[data-agent-permission=restricted]').getAttribute('aria-selected')==='true');
  await page.evaluate(()=>agentUI.reload(true));
  assert.equal(await page.locator('[data-agent-permission=restricted]').getAttribute('aria-selected'),'true');
   console.log('Desktop permissions: real cross-origin authenticated PATCH, full/restricted persistence and draft retention passed.');
 }finally{
  await page.evaluate(server=>{state.session.server=server},previous);
  await new Promise(resolve=>proxy.close(resolve));
 }
};
