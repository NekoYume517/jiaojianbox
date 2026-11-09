const ring = { work: '#7aa2f7', break: '#9ece6a' };

export function activate(host) {
  // 计时状态存在插件数据里，切页或重启应用都能恢复。
  let timer = { mode: 'idle', endAt: 0, remain: 0 };
  let view = null;

  async function load() {
    const saved = await host.getData('timer').catch(() => null);
    if (saved && saved.mode === 'running') {
      if (Date.now() >= saved.endAt) {
        await finish(saved.mode);
        return;
      }
      timer = saved;
    } else if (saved) {
      timer = { mode: 'paused', endAt: 0, remain: saved.remain || 0, from: saved.from || 'work' };
    }
    draw();
  }

  async function persist() {
    await host.setData('timer', timer).catch(() => {});
  }

  function minutes(setting) {
    const value = Number(host.config[setting]);
    return Number.isFinite(value) && value > 0 ? value : setting === 'work-minutes' ? 25 : 5;
  }

  function start(mode) {
    timer = { mode: 'running', from: mode, endAt: Date.now() + minutes(mode === 'break' ? 'break-minutes' : 'work-minutes') * 60000 };
    persist();
    draw();
  }

  function pause() {
    if (timer.mode !== 'running') return;
    timer = { mode: 'paused', from: timer.from, remain: Math.max(0, timer.endAt - Date.now()) };
    persist();
    draw();
  }

  async function resume() {
    if (timer.mode !== 'paused') return;
    timer = { mode: 'running', from: timer.from, endAt: Date.now() + timer.remain };
    await persist();
    draw();
  }

  function reset() {
    timer = { mode: 'idle' };
    persist();
    draw();
  }

  async function finish(mode) {
    timer = { mode: 'idle' };
    await persist();
    if (mode === 'work') {
      await recordSession();
      host.toast('专注完成，休息一下吧', { type: 'info' });
      if (host.config['auto-start-break']) start('break');
    } else {
      host.toast('休息结束，开始下一轮专注', { type: 'info' });
    }
    draw();
  }

  async function recordSession() {
    const day = new Date().toISOString().slice(0, 10);
    const stats = await host.getData('stats').catch(() => null);
    const all = stats && typeof stats === 'object' ? stats : {};
    const list = Array.isArray(all[day]) ? all[day] : [];
    list.push({ at: new Date().toISOString(), minutes: minutes('work-minutes') });
    const days = Object.keys(all).sort().slice(-30);
    const trimmed = {};
    for (const key of days) trimmed[key] = all[key];
    trimmed[day] = list;
    await host.setData('stats', trimmed);
  }

  function fmt(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }

  async function todayCount() {
    const day = new Date().toISOString().slice(0, 10);
    const stats = await host.getData('stats').catch(() => null);
    const list = stats && Array.isArray(stats[day]) ? stats[day] : [];
    return list.length;
  }

  function draw() {
    if (!view) return;
    const label = timer.mode === 'running' ? (timer.from === 'break' ? '休息中' : '专注中')
      : timer.mode === 'paused' ? '已暂停' : '准备开始';
    const remain = timer.mode === 'running' ? timer.endAt - Date.now() : timer.mode === 'paused' ? timer.remain : 0;
    const color = timer.from === 'break' || timer.mode === 'running' && timer.from === 'break' ? ring.break : ring.work;
    view.label.textContent = label;
    view.time.textContent = timer.mode === 'idle' ? fmt(minutes('work-minutes') * 60000) : fmt(remain);
    view.time.style.color = timer.mode === 'idle' ? 'var(--ink)' : color;
    view.start.hidden = timer.mode === 'running';
    view.pause.hidden = timer.mode !== 'running';
    view.reset.hidden = timer.mode === 'idle';
    view.ring.style.setProperty('--progress', timer.mode === 'idle' ? '0%' : '100%');
  }

  function injectStyle(container) {
    const style = document.createElement('style');
    style.textContent = `
      .pomodoro-panel { display: flex; flex-direction: column; align-items: center; gap: 18px; padding: 40px 24px 32px; }
      .pomodoro-label { font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
      .pomodoro-time { font-size: 64px; font-weight: 200; font-variant-numeric: tabular-nums; line-height: 1; letter-spacing: -0.02em; transition: color 240ms ease; }
      .pomodoro-bar { width: min(320px, 100%); height: 3px; border-radius: 2px; background: var(--line); overflow: hidden; }
      .pomodoro-bar::after { content: ''; display: block; height: 100%; width: var(--progress, 0%); background: var(--green); transition: width 500ms ease; }
      .pomodoro-controls { display: flex; gap: 10px; }
      .pomodoro-controls button[hidden] { display: none; }
      .pomodoro-stats { font-size: 13px; color: var(--muted); }`;
    container.append(style);
    return style;
  }

  host.registerPage({
    key: 'timer',
    title: '专注',
    icon: 'refresh',
    mount({ container, signal }) {
      view = {};
      const style = injectStyle(container);
      const card = host.ui.el('div', { class: 'panel pomodoro-panel' });
      view.label = host.ui.el('div', { class: 'pomodoro-label' }, '准备开始');
      view.time = host.ui.el('div', { class: 'pomodoro-time' }, '--:--');
      view.ring = host.ui.el('div', { class: 'pomodoro-bar' });
      view.start = host.ui.button({ label: '开始专注', kind: 'primary', onClick: () => start('work') });
      view.pause = host.ui.button({ label: '暂停', kind: 'secondary', onClick: pause });
      const resumeButton = host.ui.button({ label: '继续', kind: 'primary', onClick: resume });
      view.reset = host.ui.button({ label: '重置', kind: 'secondary', onClick: reset });
      const controls = host.ui.el('div', { class: 'pomodoro-controls' }, view.start, view.pause, resumeButton, view.reset);
      const stats = host.ui.el('div', { class: 'pomodoro-stats' }, '今日专注：统计中');
      card.append(view.label, view.time, view.ring, controls, stats);
      container.append(card);
      view.pause.hidden = view.reset.hidden = true;
      load();
      todayCount().then(count => { stats.textContent = `今日已完成 ${count} 轮专注`; }).catch(() => {});

      const tick = setInterval(() => {
        if (timer.mode === 'running' && Date.now() >= timer.endAt) finish(timer.from);
        draw();
      }, 500);
      signal.addEventListener('abort', () => { clearInterval(tick); style.remove(); view = null; });
    },
  });

  host.registerCommand({
    id: 'start',
    title: '专注：开始一轮番茄钟',
    icon: 'refresh',
    run: () => { start('work'); host.navigate('plugin:pomodoro:timer'); },
  });
}
