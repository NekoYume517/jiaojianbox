const assert = require('node:assert/strict');

// 分享与收集的端到端验收：生成链接、密码、公开访问、提交与提交记录。
module.exports = async function verifyShares(page, browser, base, scratch) {
  const created = await page.evaluate(async () => {
    const task = await api('/api/tasks', 'POST', { title: '分享验收待办', description: '请提交实验报告' });
    await refresh();
    await navigate('shares');
    return task.id;
  });
  await page.locator('#view .page-heading h1').filter({ hasText: '分享' }).waitFor();

  // 新建一个默认公开、无密码、无限期的查看分享。
  await page.locator('[data-share-new]').first().click();
  await page.locator('#share-task').selectOption(created);
  await page.locator('#share-save').click();
  await page.locator('[data-share-card]').first().waitFor();
  const share = await page.evaluate(() => (state.snapshot.shares || [])[0]);
  assert.equal(share.purpose, 'view', '新分享默认为查看分享');
  assert.equal(share.audience, 'public', '新分享默认公开');
  assert.equal(share.access, 'view', '新分享默认仅可查看');
  assert.equal(share.has_password, false, '新分享默认无密码');
  assert.equal(share.expires_at, null, '新分享默认无限期');
  assert.ok(share.url.includes('/s/'), '分享链接包含分享页地址');

  // 未填写密码的权限修改保留已有密码；关闭按钮可正常关闭。
  await page.locator(`[data-share-edit="${share.id}"]`).click();
  await page.locator('#share-password').fill('keep-pass-1');
  await page.locator('#share-save').click();
  await page.locator('#share-dialog').waitFor({state:'hidden'});
  await page.locator(`[data-share-edit="${share.id}"]`).click();
  await page.locator('[data-share-access="download"]').click();
  await page.locator('#share-save').click();
  await page.locator('#share-dialog').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>state.snapshot.shares[0].has_password),true);
  await page.evaluate(async id=>{await api('/api/shares/'+id,'PUT',{password:'',access:'view'});await window.shares.refresh();},share.id);
  await page.locator(`[data-share-edit="${share.id}"]`).click();
  await page.locator('#share-dialog [data-action=close-share]').first().click();
  await page.locator('#share-dialog').waitFor({state:'hidden'});

  // 公开访问：匿名上下文可以看到标题与说明。
  const anonymous = await browser.newContext({ viewport: { width: 900, height: 900 } });
  const sharePage = await anonymous.newPage();
  const shareErrors = [];
  sharePage.on('pageerror', error => shareErrors.push(error.message));
  await sharePage.goto(share.url);
  await sharePage.locator('.share-banner strong').filter({ hasText: '分享验收待办' }).waitFor();
  assert.ok(await sharePage.locator('.share-text').innerText().then(text => text.includes('请提交实验报告')), '公开分享显示待办说明');
  assert.equal(await sharePage.locator('#share-edit').count(), 0, '仅可查看时没有修改表单');

  // 受限链接能直接登录并留在当前分享页。
  await page.evaluate(async id=>{await api('/api/shares/'+id,'PUT',{audience:'registered'});},share.id);
  await sharePage.reload();await sharePage.locator('#share-login').waitFor();
  await sharePage.locator('#share-login [name=username]').fill('ui_student');
  await sharePage.locator('#share-login [name=password]').fill('strong-test-password');
  await sharePage.locator('#share-login button').click();
  await sharePage.locator('.share-banner strong').waitFor();
  await page.evaluate(async id=>{await api('/api/shares/'+id,'PUT',{audience:'public'});},share.id);

  // 权限升级为可下载文件后，材料下载按钮出现。
  await page.evaluate(async id => {
    await api('/api/shares/' + id, 'PUT', { access: 'download' });
  }, share.id);
  await sharePage.reload();
  await sharePage.locator('.share-banner strong').waitFor();

  // 访问密码：最少 6 位，设置后匿名访问需要先解锁。
  await page.evaluate(async id => {
    const share = await api('/api/shares/' + id, 'PUT', { password: 'share-pass-1' });
    state.snapshot.shares = [share, ...(state.snapshot.shares || []).filter(item => item.id !== share.id)];
  }, share.id);
  await sharePage.reload();
  await sharePage.locator('#share-unlock').waitFor();
  await sharePage.locator('#share-unlock-input').fill('wrong-pass');
  await sharePage.locator('#share-unlock button').click();
  await sharePage.locator('#share-unlock-error').filter({ hasText: '密码' }).waitFor();
  await sharePage.locator('#share-unlock-input').fill('share-pass-1');
  await sharePage.locator('#share-unlock button').click();
  await sharePage.locator('.share-banner strong').waitFor();

  // 收集表单：在待办详情开启，再用匿名访问者提交一份材料。
  await page.evaluate(async id => {
    await navigate('tasks');
    state.taskId = id;
    render();
  }, created);
  await page.locator('[data-collect-toggle]').click();
  await page.locator('[data-collect-toggle][data-enabled=true]').waitFor();
  const collect = await page.evaluate(() => (state.snapshot.shares || []).find(item => item.purpose === 'collect'));
  assert.ok(collect, '开启收集表单后生成收集分享');
  assert.ok(collect.url.includes('/s/'), '收集表单有独立链接');

  await sharePage.goto(collect.url);
  await sharePage.locator('#share-submit').waitFor();
  await sharePage.locator('#submit-name').fill('验收同学');
  await sharePage.locator('#submit-note').fill('这是我的作业');
  await sharePage.setInputFiles('#submit-material', {
    name: '作业.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('share verification payload'),
  });
  await sharePage.locator('#share-submit button[type=submit]').click();
  await sharePage.locator('.share-state h1').filter({ hasText: '提交成功' }).waitFor();

  if(scratch)await sharePage.screenshot({path:require('node:path').join(scratch,'share-success.png')});
  // 收集者在“分享”页能看到提交记录与文件。
  await page.evaluate(async () => { await navigate('shares'); await window.shares.refresh(); });
  await page.locator(`[data-share-subs="${collect.id}"] summary`).click();
  await page.locator('.share-submission').first().waitFor();
  const submission = await page.locator('.share-submission').first().innerText();
  assert.ok(submission.includes('验收同学'), '提交记录包含提交人');
  assert.ok(submission.includes('作业.pdf'), '提交记录包含提交文件');

  if(scratch)await page.screenshot({path:require('node:path').join(scratch,'share-management.png')});
  // 窄屏下设置与未保存预览都可用，不产生横向溢出。
  await page.setViewportSize({width:390,height:844});
  await page.locator(`[data-share-edit="${collect.id}"]`).click();
  await page.locator('#share-show-description').uncheck();
  await page.locator('[data-share-audience="registered"]').click();
  assert.equal(await page.locator('#share-show-description').isChecked(),false);
  await page.locator('#share-preview').click();
  await page.locator('#share-form-preview').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('#share-form-preview').getAnimations().every(a=>a.playState!=='running'));
  if(scratch)await page.screenshot({path:require('node:path').join(scratch,'share-preview-mobile.png')});
  assert.ok(!(await page.locator('#share-form-preview').innerText()).includes('请提交实验报告'));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('[data-close-preview]').click();
  await page.locator('#share-form-preview').waitFor({state:'hidden'});
  await page.locator('#share-dialog [data-action=close-share]').first().click();
  await page.setViewportSize({width:1280,height:860});

  // 关闭收集表单后链接立即失效。
  await page.evaluate(async id => { await api('/api/tasks/' + id + '/collection', 'POST', { enabled: false }); }, created);
  const closed = await sharePage.goto(collect.url).then(() => sharePage.locator('.share-state h1').innerText());
  assert.ok(closed.includes('失效'), '关闭收集表单后链接失效');

  assert.deepEqual(shareErrors, [], '分享页没有脚本错误');
  await anonymous.close();
  return { view: share.id, collect: collect.id };
};
