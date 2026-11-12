const assert = require('node:assert/strict');

function almostEqual(actual, expected, message, tolerance = 0.75) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} != ${expected}`);
}

async function measureSearch(page) {
  await page.waitForFunction(() => document.querySelector('#global-search-dialog')?.open);
  await page.waitForTimeout(220);
  return page.evaluate(() => {
    const rect = selector => {
      const box = document.querySelector(selector).getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width };
    };
    return {
      tabs: rect('#global-search-types'),
      search: rect('.product-search'),
      meta: rect('.product-search-meta'),
      viewport: document.documentElement.clientWidth,
    };
  });
}

module.exports = async function verifyProductivityLayout(page) {
  await page.evaluate(() => productivity.search());
  let box = await measureSearch(page);
  almostEqual(box.search.left, box.tabs.left, 'search input must align with type tabs');
  almostEqual(box.meta.left, box.tabs.left, 'search filters must align with type tabs');
  almostEqual(box.search.right, box.meta.right, 'search input and filters must share a right edge');

  await page.evaluate(() => uiMotion.closeDialog(document.querySelector('#global-search-dialog')));
  await page.waitForFunction(() => !document.querySelector('#global-search-dialog')?.open);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => productivity.search());
  box = await measureSearch(page);
  almostEqual(box.search.left, box.tabs.left, 'mobile search input must align with type tabs');
  assert.ok(box.search.width <= box.viewport - 28, 'mobile search input overflowed the dialog');

  await page.evaluate(() => uiMotion.closeDialog(document.querySelector('#global-search-dialog')));
  await page.waitForFunction(() => !document.querySelector('#global-search-dialog')?.open);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.evaluate(() => productivity.recycle());
  await page.waitForFunction(() => document.querySelector('#recycle-dialog')?.open);
  await page.waitForTimeout(260);
  const icon = page.locator('#recycle-dialog .product-empty svg').first();
  await icon.waitFor();
  const iconBox = await icon.boundingBox();
  assert.ok(iconBox && Math.abs(iconBox.width - 32) < 0.75 && Math.abs(iconBox.height - 32) < 0.75, `empty-state icon was stretched: ${JSON.stringify(iconBox)}`);
  const iconStyle = await icon.evaluate(element => {
    const style = getComputedStyle(element);
    return { fill: style.fill, stroke: style.stroke };
  });
  assert.equal(iconStyle.fill, 'none');
  assert.notEqual(iconStyle.stroke, 'none');

  await page.evaluate(() => uiMotion.closeDialog(document.querySelector('#recycle-dialog')));
  await page.waitForFunction(() => !document.querySelector('#recycle-dialog')?.open);
  console.log('Productivity: search alignment and empty-state icons passed.');
};
