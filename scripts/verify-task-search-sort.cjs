const assert = require('node:assert/strict');
const path = require('node:path');

async function composeSearch(page, selector, pinyin, committed) {
  await page.locator(selector).evaluate((input, text) => {
    input.focus();
    window.__imeNode = input;
    window.__imeRenderCount = 0;
    const observer = new MutationObserver(() => { window.__imeRenderCount++; });
    observer.observe(document.querySelector('#view'), { childList: true, subtree: true });
    window.__imeObserver = observer;
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    input.value = text;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, isComposing: true, inputType: 'insertCompositionText' }));
  }, pinyin);
  assert.equal(await page.evaluate(() => window.__imeNode === document.activeElement), true, `${selector} lost focus during composition`);
  assert.equal(await page.evaluate(() => window.__imeRenderCount), 0, `${selector} was rebuilt during composition`);
  await page.locator(selector).evaluate((input, text) => {
    input.value = text;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, isComposing: true, inputType: 'insertCompositionText' }));
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: text }));
    window.__imeObserver.disconnect();
  }, committed);
  await page.waitForFunction(selector => document.querySelector(selector)?.value !== '', selector);
  assert.equal(await page.locator(selector).inputValue(), committed, `${selector} did not retain committed Chinese text`);
}

module.exports = async function verifyTaskSearchSort(page, scratch) {
  await page.evaluate(async () => {
    await api('/api/tasks', 'POST', { title: '高数中文作业', description: '中文搜索验证', created_at: '2026-11-01T08:00:00+08:00', due_at: '2026-11-20T12:00:00+08:00' });
    await api('/api/tasks', 'POST', { title: 'Alpha task', description: '排序验证', created_at: '2026-11-02T08:00:00+08:00', due_at: '2026-11-18T12:00:00+08:00' });
    await api('/api/tasks', 'POST', { title: 'Zeta task', description: '排序验证', created_at: '2026-11-03T08:00:00+08:00', due_at: null });
    await api('/api/messages', 'POST', { text: '本周五前提交高数中文作业', source: 'manual', account_id: 'ui_student', conversation_id: 'ime-room', conversation_name: '中文输入验证', external_id: 'ime-message-1', sender_id: 'ui_student', sender_name: '测试用户', sent_at: new Date().toISOString() });
    await refresh();
  });

  await page.evaluate(() => navigate('inbox'));
  await page.waitForFunction(() => document.querySelector('#inbox-search'));
  await composeSearch(page, '#inbox-search', 'gaoshu', '高数');
  assert.equal(await page.evaluate(() => state.search), '高数');
  assert(await page.locator('.message-row').count() >= 1, 'Chinese inbox search returned no messages');

  await page.evaluate(() => { state.search = ''; navigate('tasks'); });
  await page.waitForFunction(() => document.querySelector('#task-search'));
  await composeSearch(page, '#task-search', 'gaoshu', '高数');
  assert.deepEqual(await page.locator('.task-card>h3').allTextContents(), ['高数中文作业']);

  await page.evaluate(() => { state.search = ''; state.taskFilter = 'all'; render(); });
  const orders = {};
  for (const sort of ['created-desc', 'created-asc', 'due-asc', 'due-desc', 'title-asc', 'title-desc']) {
    await page.locator('#task-sort').selectOption(sort);
    await page.waitForFunction(sort => state.taskSort === sort, sort);
    const order = await page.locator('.task-card>h3').allTextContents();
    orders[sort] = order;
    assert.equal(new Set(order).size, order.length, `${sort} duplicated a task`);
    if (sort === 'title-asc' || sort === 'title-desc') {
      const expected = order.slice().sort((left, right) => {
        const comparison = left.localeCompare(right, 'zh-CN', { numeric: true, sensitivity: 'base' });
        return sort === 'title-asc' ? comparison : -comparison;
      });
      assert.deepEqual(order, expected, `${sort} does not follow zh-CN collation`);
    }
  }
  assert.equal(orders['title-asc'].filter(title => /[A-Za-z]/.test(title))[0], 'Alpha task');
  assert(orders['title-asc'].includes('高数中文作业'));
  assert.deepEqual(orders['title-desc'], [...orders['title-asc']].reverse());
  assert.deepEqual(orders['created-asc'], ['网页界面验收待办', '高数中文作业', 'Alpha task', 'Zeta task']);
  assert.deepEqual(orders['created-desc'], [...orders['created-asc']].reverse());
  assert.equal(orders['due-asc'][0], 'Alpha task');
  assert.equal(orders['due-asc'][1], '高数中文作业');
  assert.deepEqual(orders['due-asc'].slice(0, 2), ['Alpha task', '高数中文作业']);
  assert.deepEqual(new Set(orders['due-asc'].slice(2)), new Set(['Zeta task', '网页界面验收待办']), 'Ascending deadlines must place missing dates last');
  assert.deepEqual(orders['due-desc'].slice(0, 2), ['高数中文作业', 'Alpha task']);
  assert.deepEqual(new Set(orders['due-desc'].slice(2)), new Set(['Zeta task', '网页界面验收待办']), 'Missing deadlines must remain last in both directions');

  await page.locator('#task-sort').selectOption('due-asc');
  await page.evaluate(() => localStorage.setItem('onboarded-' + state.profile, true));
  await page.reload();
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.evaluate(() => navigate('tasks'));
  await page.waitForFunction(() => document.querySelector('#task-sort')?.value === 'due-asc');

  for (const selector of ['#task-search', '#task-title']) {
    if (selector === '#task-title') {
      await page.locator('#view [data-action="new-task"]').filter({ visible: true }).click();
      await page.locator('#task-dialog').waitFor({ state: 'visible' });
    }
    await page.locator(selector).focus();
    const focus = await page.locator(selector).evaluate(input => {
      const target = input.id === 'task-search' ? input.closest('.search') : input;
      const style = getComputedStyle(target);
      return { outlineWidth: style.outlineWidth, outlineOffset: style.outlineOffset, boxShadow: style.boxShadow, radius: style.borderRadius };
    });
    assert.equal(focus.outlineWidth, '1px', `${selector} has a misaligned outer focus outline`);
    assert.equal(focus.outlineOffset, '1px', `${selector} focus ring is not concentric with its border`);
    assert.equal(focus.boxShadow, 'none', `${selector} still has a second focus halo`);
    if (selector === '#task-title') {
      await page.keyboard.press('Escape');
      await page.locator('#task-dialog').waitFor({ state: 'hidden' });
    }
  }
  for (const width of [1280, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `task toolbar overflows at ${width}px`);
    if (width === 1280 || width === 390) await page.screenshot({ path: path.join(scratch, `task-search-sort-${width}.png`) });
  }
  await page.setViewportSize({ width: 1280, height: 860 });
  console.log('Task search/sort: IME composition, Chinese filtering, six orderings, persistence and concentric focus passed.');
};
