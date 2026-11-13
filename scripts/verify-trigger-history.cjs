const assert = require('node:assert/strict');
const http = require('node:http');

module.exports = async (page, base) => {
  // Prior workflow checks may leave onboarding and status suggestions open.
  for (const selector of ['[data-onboard="skip"]','[data-status-suggest="dismiss"]']) {
    const dismiss = page.locator(selector);
    if (await dismiss.isVisible()) await dismiss.click();
  }
  const analysis = {
    classification: 'actionable',
    confidence: 0.95,
    summary: '周五中午前需要提交 3D 建模电子版作业。',
    title: '3D 建模电子版作业',
    due_at: '2026-11-13T12:00:00+08:00',
    urgency: 'high',
    requirements: [{ label: '3D 建模文件', extensions: ['zip'], min_count: 1 }],
    reason: '通知包含明确截止时间与提交材料',
  };
  const upstream = http.createServer(async (request, response) => {
    for await (const _ of request) {
      // Drain the OpenAI-compatible request before returning the fixture.
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: JSON.stringify(analysis) } }],
      usage: { prompt_tokens: 24, completion_tokens: 18, total_tokens: 42 },
    }));
  });
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  try {
    const upstreamURL = `http://127.0.0.1:${upstream.address().port}`;
    const result = await page.evaluate(async upstreamURL => {
      await api('/api/settings/llm', 'PUT', {
        base_url: upstreamURL,
        model: 'trigger-history-fixture',
        context_window_tokens: 65536,
      });
      const message = await api('/api/messages', 'POST', {
        source: 'wechat',
        account_id: 'wx-history-1',
        conversation_id: 'group-history-1',
        conversation_name: '25 虚拟 1 班',
        sender_name: '王恒',
        external_id: 'trigger-history-browser-1',
        sent_at: '2026-11-12T10:39:00+08:00',
        text: '请大家于本周五中午 12 点前提交 3D 建模电子版作业',
      });
      return api('/api/analyze', 'POST', { message_id: message.id });
    }, upstreamURL);
    assert.equal(result.classification, 'actionable');

    assert.equal(await page.locator('[data-nav="agent"]').count(), 0, 'AI must not return as a primary navigation page');
    await page.evaluate(async () => {
      await navigate('sources');
      window.pageNavigation?.select('history');
    });
    await page.locator('[data-trigger-history]').waitFor({ state: 'visible' });
    await page.locator('[data-agent-origin]').filter({ hasText: '微信触发器' }).waitFor();
    await page.locator('[data-agent-session]').filter({ hasText: '25 虚拟 1 班' }).waitFor();
    assert.equal(await page.locator('[data-agent-permission="full"]').getAttribute('aria-selected'), 'true');
    await page.locator('[data-agent-permission="restricted"]').click();
    assert.equal(await page.locator('[data-agent-input]').isVisible(), true);
    assert.match(await page.locator('[data-agent-thread]').innerText(), /电子版作业|三维建模|3D 建模/);

    // A notification session can coexist with manually started continuing work.
    await page.evaluate(async () => {
      await api('/api/agent/sessions', 'POST', { title: '跨会话检查', permission: 'restricted' });
      await agentUI.reload(true);
    });
    await page.locator('[data-agent-origin]').filter({ hasText: '手动触发' }).click();
    await page.locator('[data-agent-session]').filter({ hasText: '跨会话检查' }).waitFor();
    await page.evaluate(() => { window.historyThumb = document.querySelector('[data-agent-origins]>.segment-highlight'); });
    await page.locator('[data-agent-session]').filter({hasText:'25 虚拟 1 班'}).click();
    await page.waitForTimeout(320);
    assert(await page.evaluate(() => window.historyThumb === document.querySelector('[data-agent-origins]>.segment-highlight')), 'session selection must reuse one moving highlight');
    await page.locator('[data-agent-session]').filter({hasText:'跨会话检查'}).click();
    await page.waitForTimeout(320);
    await page.locator('[data-agent-input]').fill('保留输入草稿');
    await page.locator('[data-agent-permission="full"]').click();
    await page.waitForFunction(() => document.querySelector('[data-agent-permission="full"]').getAttribute('aria-selected') === 'true');
    assert.equal(await page.locator('[data-agent-input]').inputValue(),'保留输入草稿');
    await page.locator('[data-agent-permission="restricted"]').click();
    await page.locator('[data-agent-input]').fill('');
    await page.locator('[data-agent-context] summary').hover();
    assert(await page.locator('.agent-context-popup').isVisible());
    await page.keyboard.press('Escape');

    await page.locator('[data-agent-cross]').click();
    await page.locator('.trigger-cross-dialog').waitFor({ state: 'visible' });
    assert(await page.locator('[data-cross-target] option').count() >= 1);
    await page.locator('[data-cross-close]').first().click();
    await page.locator('.trigger-cross-dialog').waitFor({ state: 'detached' });

    for (const width of [1280, 820, 390, 320]) {
      await page.setViewportSize({ width, height: 860 });
      await page.waitForTimeout(80);
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `trigger history overflows at ${width}px`,
      );
      assert(await page.locator('[data-trigger-history]').isVisible());
      const spacing = await page.evaluate(() => {
        const panel = document.querySelector('[data-trigger-history]');
        const head = panel.querySelector('.trigger-history-head');
        const thread = panel.querySelector('[data-agent-thread]');
        const composer = panel.querySelector('[data-agent-form]');
        return [head, thread, composer].map(node => parseFloat(getComputedStyle(node).paddingLeft));
      });
      assert(Math.max(...spacing) - Math.min(...spacing) < 1, `trigger history spacing is not aligned at ${width}px: ${spacing}`);
      assert(spacing[0] === (width <= 620 ? 12 : 16), `unexpected trigger spacing token at ${width}px: ${spacing}`);
      // Real wheel input must scroll the transcript, leaving composer and page fixed.
      await page.evaluate(() => {
        const thread = document.querySelector('[data-agent-thread]');
        thread.querySelector('[data-agent-empty]')?.remove();
        thread.innerHTML = Array.from({length: 35}, (_, i) => `<article class="agent-message"><div class="agent-message-copy">滚动验收 ${i}<br>这是一段较长的会话内容，用来验证消息区域可以独立滚动。</div></article>`).join('');
        thread.scrollTop = 0;
      });
      const before = await page.evaluate(() => {
        const thread = document.querySelector('[data-agent-thread]');
        const input = document.querySelector('[data-agent-form]').getBoundingClientRect();
        const panel = document.querySelector('[data-trigger-history]').getBoundingClientRect();
        return {inputTop:input.top,inputBottom:input.bottom,panelBottom:panel.bottom,scroll:document.scrollingElement.scrollTop,client:thread.clientHeight,total:thread.scrollHeight};
      });
      assert(before.total > before.client + 100, 'transcript needs a bounded scrolling area');
      assert(Math.abs(before.panelBottom - before.inputBottom) < 3, 'composer must be pinned to bottom');
      const threadBox = await page.locator('[data-agent-thread]').boundingBox();
      await page.mouse.move(threadBox.x + threadBox.width / 2, threadBox.y + Math.min(80,threadBox.height/2));
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(120);
      const after = await page.evaluate(() => ({top:document.querySelector('[data-agent-thread]').scrollTop,inputTop:document.querySelector('[data-agent-form]').getBoundingClientRect().top,scroll:document.scrollingElement.scrollTop}));
      assert(after.top > 0, `wheel must scroll transcript at ${width}px`);
      assert(Math.abs(after.inputTop - before.inputTop) < 1, 'composer moved while scrolling');
      assert.equal(after.scroll,before.scroll,'wheel escaped to outer page');
      if (width <= 620) {
        const bottomNav = await page.locator('.sidebar').boundingBox();
        assert(before.inputBottom <= bottomNav.y - 4, 'composer overlaps mobile navigation');
      }

    }
    console.log('Trigger history: notification session, restricted continuation, manual session, cross-session call and responsive bounds passed.');
  } finally {
    await new Promise(resolve => upstream.close(resolve));
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.evaluate(() => navigate('tasks'));
  }
};
