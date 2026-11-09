export function activate(host) {
  host.onRender('plugins', () => {
    const card = document.querySelector('.plugin-overview .plugin-capabilities');
    if (!card || card.dataset.copyRewritten === '1') return;
    const copy = [
      ['自由开发', '本条文案由示例插件改写：onRender 在每次页面渲染后重新生效。'],
      ['标题也能改', '插件可以读取并替换管理页的任何节点，包括这一格的标题。'],
      ['停用即恢复', '停用或删除本插件后，下次渲染自动还原官方文案。'],
    ];
    [...card.children].forEach((item, index) => {
      const entry = copy[index];
      if (!entry) return;
      const strong = item.querySelector('strong');
      const span = item.querySelector('span');
      if (strong) strong.textContent = entry[0];
      if (span) span.textContent = entry[1];
    });
    card.dataset.copyRewritten = '1';
  });
}
