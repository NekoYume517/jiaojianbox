const assert=require('node:assert/strict');
module.exports=async(page)=>{
  const message=await page.evaluate(async()=>{
    const row=await api('/api/messages','POST',{source:'manual',account_id:'verify',conversation_id:'inbox-actions',external_id:'inbox-actions-'+Date.now(),text:'通知卡片忽略按钮回归验证',sent_at:new Date().toISOString()});
    await refresh();
    await navigate('inbox');
    return row.id;
  });
  const row=page.locator(`.message-row[data-message="${message}"]`);
  await row.waitFor({state:'visible'});
  await row.hover();
  await row.locator('[data-row-action="ignore-message"]').click();
  await page.waitForFunction(id=>state.snapshot.messages.find(item=>item.id===id)?.triage==='ignored',message);
  assert.equal(await page.evaluate(id=>state.selected,message),null,'row action must not be swallowed by row selection');
  await page.evaluate(()=>navigate('tasks'));
  console.log('Inbox: row-level ignore action passed.');
};
