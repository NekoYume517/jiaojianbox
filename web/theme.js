/* 在样式表前应用外观，避免深色模式启动时先闪过白色页面。 */
(() => {
  const key = 'jjb-appearance';
  const defaults = { theme: 'system', density: 'comfortable', textSize: 'normal' };
  const normalize = input => ({
    theme: ['system', 'light', 'dark'].includes(input?.theme) ? input.theme : defaults.theme,
    density: ['comfortable', 'compact'].includes(input?.density) ? input.density : defaults.density,
    textSize: ['normal', 'large'].includes(input?.textSize) ? input.textSize : defaults.textSize,
  });
  let settings;
  try { settings = normalize(JSON.parse(localStorage.getItem(key))); } catch { settings = { ...defaults }; }
  const query = matchMedia('(prefers-color-scheme: dark)');
  const shapes = {
    light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    dark: '<path d="M20.6 14A9 9 0 0 1 10 3.4 9 9 0 1 0 20.6 14Z"/>',
    system: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  };
  const labels = { light: '浅色', dark: '深色', system: '跟随系统' };
  const svg = mode => `<svg viewBox="0 0 24 24" aria-hidden="true">${shapes[mode]}</svg>`;
  function paint() {
    const resolved = settings.theme === 'system' ? query.matches ? 'dark' : 'light' : settings.theme;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themeMode = settings.theme;
    document.documentElement.dataset.density = settings.density;
    document.documentElement.dataset.textSize = settings.textSize;
    document.querySelectorAll('[data-theme-picker]').forEach(container => {
      if (container.children.length) return;
      container.className = 'theme-picker'; container.setAttribute('role', 'group'); container.setAttribute('aria-label', '颜色模式');
      container.innerHTML = ['light', 'dark', 'system'].map(mode => `<button type="button" data-theme-mode="${mode}" aria-label="${labels[mode]}" title="${labels[mode]}">${svg(mode)}</button>`).join('');
    });
    document.querySelectorAll('[data-theme-mode]').forEach(button => {
      const active = button.dataset.themeMode === settings.theme;
      button.setAttribute('aria-pressed', String(active)); button.classList.toggle('active', active);
    });
    for (const [id, name] of [['appearance-density', 'density'], ['appearance-text-size', 'textSize']]) {
      const input = document.getElementById(id); if (input) input.value = settings[name];
    }
    return resolved;
  }
  async function update(patch) {
    settings = normalize({ ...settings, ...patch });
    try { localStorage.setItem(key, JSON.stringify(settings)); } catch { /* 无法持久化时仍保留本次选择。 */ }
    paint();
    if (window.desktop?.setAppearance) {
      try { await window.desktop.setAppearance(settings); }
      catch { window.dispatchEvent(new CustomEvent('appearance-error')); }
    }
    window.dispatchEvent(new CustomEvent('appearance-changed', { detail: { ...settings } }));
  }
  window.appearance = {
    get: () => ({ ...settings }),
    update,
    refresh: paint,
    icon: svg,
    restore: value => { settings = normalize(value); try { localStorage.setItem(key, JSON.stringify(settings)); } catch {} paint(); },
  };
  paint();
  query.addEventListener('change', paint);
  window.addEventListener('storage', event => {
    if (event.key === key) { try { settings = normalize(JSON.parse(event.newValue)); paint(); } catch {} }
  });
  document.addEventListener('DOMContentLoaded', paint);
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-theme-mode]');
    if (button) update({ theme: button.dataset.themeMode });
  });
  document.addEventListener('change', event => {
    if (event.target.id === 'appearance-density') update({ density: event.target.value });
    if (event.target.id === 'appearance-text-size') update({ textSize: event.target.value });
  });
})();
