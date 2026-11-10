const assert=require('node:assert/strict');
const path=require('node:path');
module.exports=async(browser,base,scratch)=>{
  const post=async(route,body)=>{const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert(r.ok,route+' '+r.status);return r.json();};
  const errors=[],contexts=[];
  try{
    const start=await post('/api/auth/device/start',{});
    const context=await browser.newContext({viewport:{width:1000,height:780}});contexts.push(context);
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+start.verification_path);
    await page.locator('#authorize-signup-tab').click();
    const username='browser-'+Date.now()+'@example.test',password='browser-fixture-password';
    await page.locator('#authorize-username').fill(username);await page.locator('#authorize-password').fill(password);
    await page.locator('#authorize-login-submit').click();
    await page.locator('#authorize-consent').waitFor({state:'visible'});
    assert((await page.locator('#authorize-account').innerText()).includes(username));
    await page.locator('#authorize-approve').click();await page.locator('#authorize-complete').waitFor({state:'visible'});
    const approved=await post('/api/auth/device/poll',{device_code:start.device_code});assert.equal(approved.status,'approved');

    // The backend's one-use token/session contract is covered by accounts_test.go;
    // here verify the browser consumes that response and resumes the exact request.
    const second=await post('/api/auth/device/start',{}),session=await post('/api/auth/login',{username,password});
    const verifyContext=await browser.newContext();contexts.push(verifyContext);
    await verifyContext.route('**/api/auth/mail/confirm',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({confirmed:true,message:'邮箱验证成功，已自动登录',session,continue_path:second.verification_path})}));
    const verifyPage=await verifyContext.newPage();verifyPage.on('pageerror',e=>errors.push(e.message));
    await verifyPage.goto(base+'/?mail_action=register&token=fixture-verification-token');
    await verifyPage.locator('dialog[open] [data-confirm]').click();
    await verifyPage.waitForURL('**/authorize?code=*');
    await verifyPage.locator('#authorize-consent').waitFor({state:'visible'});
    assert.equal(await verifyPage.evaluate(()=>JSON.parse(localStorage.getItem('jjb-session')).username),username);
    await verifyPage.screenshot({path:path.join(scratch,'authorize-after-verification.png')});
    assert.deepEqual(errors,[]);
    console.log('Authorization: registration, immediate login, consent, email-verification session restore and exact device continuation passed.');
  }finally{for(const context of contexts)await context.close();}
};
