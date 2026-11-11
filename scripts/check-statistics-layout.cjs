const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.connectOverCDP('http://127.0.0.1:9333');
  let page=null;
  for(const context of browser.contexts()) for(const item of context.pages()) if(!page&&!item.url().startsWith('devtools')) page=item;
  assert(page,'no page');
  await page.waitForTimeout(2000);
  const state=await page.evaluate(()=>({workspaceHidden:document.querySelector('#workspace')?.hidden,accountServer:document.querySelector('#account-server')?.textContent}));
  assert.equal(state.workspaceHidden,false,'session lost after restart');
  await page.evaluate(()=>{document.querySelector('[data-nav="stats"]')?.click();});
  await page.waitForTimeout(1800);
  const layout=await page.evaluate(()=>{
    const controls=document.querySelector('.statistics-controls');
    const label=controls?.querySelector('label');
    const pill=controls?.querySelector('.segment-choice');
    const labelRange=document.createRange();
    if(label) labelRange.selectNodeContents(label);
    const textWidth=[...label?.childNodes||[]].filter(n=>n.nodeType===3).map(n=>{const r=document.createRange();r.selectNode(n);return r.getBoundingClientRect();});
    return {
      controlsHeight:controls?.offsetHeight,
      labelHeight:label?.offsetHeight,
      labelTextLines:textWidth.map(r=>({width:Math.round(r.width),height:Math.round(r.height)})),
      pillWidth:pill?.offsetWidth,
      pillHeight:pill?.offsetHeight,
      helpers:[...controls.querySelectorAll('.helper')].map(h=>({text:h.textContent.slice(0,24),w:h.offsetWidth,h:h.offsetHeight}))
    };
  });
  console.log(JSON.stringify(layout,null,2));
  await page.screenshot({path:'work/update-test/statistics-check.png',clip:{x:200,y:40,width:1060,height:340}});
  await browser.close();
})().catch(e=>{console.error('FAIL',e.message);process.exit(1);});

