const assert=require('node:assert/strict');const http=require('node:http');
module.exports=async(page,base)=>{
 const markdown=['# 渲染验收','**加粗**、*斜体*、~~删除~~ 与 `行内代码`。','> 引用内容','- [x] 已完成\n- [ ] 待完成','1. 第一项\n   - 嵌套列表','| 学号 | 姓名 |\n| --- | --- |\n| 123456789012 | 张三 |','```javascript\nconst value = "hello";\nconsole.log(value);\n```','公式 $E=mc^2$。','$$\n\\frac{1}{2} + x^2\n$$','脚注[^note]\n\n[^note]: 这是脚注。','```mermaid\ngraph LR\n A[通知] --> B[待办]\n```','[示例链接](https://example.com) ![图标](/icon.svg)','<img src="missing" onerror="window.markdownPwned=true"><script>window.markdownPwned=true</script>','<button data-agent-delete>不可信动作</button>'].join('\n\n');
 let calls=0;const upstream=http.createServer(async(req,res)=>{for await(const _ of req){}calls++;res.writeHead(200,{'Content-Type':'application/json'});if(calls===1)res.end(JSON.stringify({choices:[{message:{role:'assistant',tool_calls:[{id:'tool-render-1',type:'function',function:{name:'list_tasks',arguments:'{"limit":5}'}}]}}]}));else {await new Promise(r=>setTimeout(r,200));res.end(JSON.stringify({choices:[{message:{role:'assistant',content:markdown}}]}));}});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 try{
 await page.evaluate(async url=>{await api('/api/settings/llm','PUT',{base_url:url,model:'render-fixture'});await navigate('sources');pageNavigation.select('history');await api('/api/agent/sessions','POST',{title:'Markdown 与工具验收'});await agentUI.reload(true)},`http://127.0.0.1:${upstream.address().port}`);
 await page.locator('[data-agent-session]').filter({hasText:'Markdown 与工具验收'}).click();
 await page.locator('[data-agent-input]').fill('请查看待办，并给出带 Markdown 的说明');
 await page.locator('[data-agent-send]').click();
 await page.locator('.agent-tool-row.done').waitFor({state:'attached'});
 const reply=page.locator('.agent-message-assistant').last();
 await reply.locator('.markdown-body table').waitFor();
 if(!(await reply.locator('.agent-tool-events').evaluate(el=>el.open)))await reply.locator('.agent-tool-events>summary').click();
 await reply.locator('.agent-tool-row>summary').click();
 assert.match(await reply.locator('[data-tool-result]').innerText(),/tasks/);
 assert.match(await reply.locator('.agent-tool-detail pre').first().innerText(),/limit/);
 assert.equal(await reply.locator('.markdown-body strong').count(),1);
 assert.equal(await reply.locator('.markdown-body del').count(),1);
 assert.equal(await reply.locator('.markdown-body input[type=checkbox]').count(),2);
 assert(await reply.locator('.hljs-keyword').count()>0);
 assert(await reply.locator('.katex').count()>=2);
 assert(await reply.locator('.footnotes').count()>0);
 await reply.locator('.md-diagram svg').waitFor({timeout:20000});
 assert(await reply.locator('.md-diagram text').count()>0);
 assert.equal(await reply.locator('[onerror],script,[data-agent-delete]').count(),0);
 assert.equal(await page.evaluate(()=>!!window.markdownPwned),false);
 assert(await reply.locator('.agent-message-bubble').evaluate(el=>parseFloat(getComputedStyle(el).borderTopLeftRadius)>=10 && getComputedStyle(el).borderTopStyle==='solid'));
 for(const width of [1280,390,320]){
 await page.setViewportSize({width,height:860});await page.waitForTimeout(100);
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Markdown overflow at ${width}`);
 }
 await page.setViewportSize({width:1280,height:860});
 await reply.locator('.agent-tool-events').scrollIntoViewIfNeeded();
 await page.screenshot({path:'work/agent-markdown-tools.png'});
 console.log('Agent rendering: streamed tool records, parameters/results, rounded bubbles, GFM, math, diagrams, sanitization and narrow bounds passed.');
 }finally{await new Promise(r=>upstream.close(r));}
};
