/* Desktop plugin contract jjb-plugin-1.
   The kernel, slots, schema settings and error boundary follow Magpie's design
   (MIT; see THIRD_PARTY_NOTICES). Packages, code, config and history live on
   this computer. The browser build never executes or installs plugins. */
(() => {
  const HOST_API = '1.0';
  const running = new Map(), pages = new Map(), commands = new Map(), services = new Map();
  const pageSelection = new Map(), pluginErrors = new Map(), brokenPages = new Map();
  let entries = [], identity = '', syncing = false, lastSync = 0, pageCleanup, epoch = 0;
  let previousTasks = new Map(), renderedPage = '', renderedSelection = '', renderedTarget = null;
  const key = () => state.session ? state.session.server + '|' + state.session.user_id : '';
  const errorText = error => String(error?.message || error);
  const matches = (pattern, route) => pattern === '*' || pattern === '/api/*' ? /^\/api(?:\/|$)/.test(route) :
    new RegExp('^' + String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:[/?#]|$)').test(route);
  const pageKey = (pluginId, partKey) => `plugin:${pluginId}:${partKey}`;

  /* ---- Schema: manifest settings declare the form; config composes like
         Magpie's Compose. Defaults first, then values the schema allows. ---- */
  function composeConfig(manifest, userConfig) {
    const composed = {};
    for (const setting of Array.isArray(manifest?.settings) ? manifest.settings : []) {
      if (setting?.key && 'default' in setting) composed[setting.key] = setting.default;
    }
    const valueMatches = (setting, value) => {
      switch (setting.type) {
        case 'bool': return typeof value === 'boolean';
        case 'number': return typeof value === 'number' && Number.isFinite(value);
        default:
          if (typeof value !== 'string') return false;
          return !Array.isArray(setting.enum) || setting.enum.includes(value);
      }
    };
    for (const [name, value] of Object.entries(userConfig || {})) {
      const setting = (manifest?.settings || []).find(item => item?.key === name);
      if (setting && valueMatches(setting, value)) composed[name] = value;
    }
    return composed;
  }

  /* ---- UI kit, the host counterpart of Magpie's magpie.ui. ---- */
  const ui = {
    el(tag, attrs = {}, ...children) {
      const element = document.createElement(tag);
      if (attrs.class) element.className = attrs.class;
      if (attrs.style) Object.assign(element.style, attrs.style);
      for (const [name, value] of Object.entries(attrs.attrs || {})) element.setAttribute(name, String(value));
      for (const [name, value] of Object.entries(attrs.dataset || {})) element.dataset[name] = value;
      for (const [type, listener] of Object.entries(attrs.events || {})) element.addEventListener(type, listener);
      for (const child of children.flat()) {
        if (child == null || child === false) continue;
        element.append(child instanceof Node ? child : document.createTextNode(String(child)));
      }
      return element;
    },
    button({ label, kind = 'secondary', onClick, title }) {
      const button = ui.el('button', { class: kind, events: { click: onClick } }, label);
      if (title) button.title = title;
      return button;
    },
    toggle({ label, description, checked, onChange }) {
      const input = ui.el('input', { attrs: { type: 'checkbox' } });
      input.checked = !!checked;
      if (onChange) input.addEventListener('change', () => onChange(input.checked));
      const text = ui.el('span', {}, ui.el('strong', {}, label), description ? ui.el('small', {}, description) : null);
      return ui.el('label', { class: 'switch-line' }, input, text);
    },
    row(label, control, description) {
      const holder = ui.el('label', {}, label, control);
      if (description) holder.append(ui.el('small', { class: 'helper' }, description));
      return holder;
    },
    form(schema, values, onChange) {
      const inputs = new Map();
      const element = ui.el('div', { class: 'plugin-settings' });
      const read = () => {
        const out = {};
        for (const setting of schema) {
          const input = inputs.get(setting.key);
          if (!input) continue;
          out[setting.key] = setting.type === 'bool' ? input.checked :
            setting.type === 'number' ? Number(input.value) : input.value;
        }
        return out;
      };
      const notify = () => onChange?.(read());
      for (const setting of schema || []) {
        const value = values?.[setting.key];
        let control;
        if (setting.type === 'bool') {
          control = ui.el('input', { attrs: { type: 'checkbox' } });
          control.checked = !!value;
          control.addEventListener('change', notify);
        } else if (setting.type === 'number') {
          control = ui.el('input', { attrs: { type: 'number' } });
          if (setting.min !== undefined) control.min = setting.min;
          if (setting.max !== undefined) control.max = setting.max;
          control.value = typeof value === 'number' ? value : '';
          control.addEventListener('input', notify);
        } else if (Array.isArray(setting.enum)) {
          control = ui.el('select', {}, ...setting.enum.map(option => ui.el('option', { attrs: { value: option } }, option)));
          control.value = typeof value === 'string' ? value : '';
          control.addEventListener('change', notify);
        } else {
          control = ui.el('input', { attrs: { type: 'text', spellcheck: 'false' } });
          control.value = typeof value === 'string' ? value : '';
          control.addEventListener('input', notify);
        }
        inputs.set(setting.key, control);
        element.append(ui.row(setting.title || setting.key, control, setting.description));
      }
      return { element, values: read };
    },
  };

  function removePage(id) {
    const page = pages.get(id);
    if (!page) return;
    page.button.remove();
    pages.delete(id);
    brokenPages.delete(id);
    if (renderedPage === id) { renderedPage = ''; renderedSelection = ''; renderedTarget = null; }
  }

  function dispose(plugin) {
    plugin.controller.abort();
    for (const cleanup of plugin.cleanup.reverse()) {
      try { cleanup(); } catch (error) { console.error(error); }
    }
    for (const [id, page] of [...pages]) if (page.owner === plugin.id) removePage(id);
    for (const [id, command] of [...commands]) if (command.owner === plugin.id) commands.delete(id);
    for (const [id, service] of [...services]) if (service.owner === plugin.id) services.delete(id);
    for (const url of plugin.urls) URL.revokeObjectURL(url);
    pluginErrors.delete(plugin.id);
  }

  function stop() {
    epoch++;
    for (const plugin of running.values()) dispose(plugin);
    running.clear();
    entries = [];
    pluginErrors.clear();
    identity = '';
    previousTasks.clear();
    document.querySelectorAll('[data-plugin-tab]').forEach(button => button.remove());
    pageCleanup?.();
    pageCleanup = null;
  }

  /* ---- Slots. A page part becomes a sidebar entry, like Magpie's page slot. ---- */
  function validateMount(fn) {
    if (typeof fn !== 'function') throw Error('页面需要 mount(ctx)');
    return fn;
  }

  function registerPage(plugin, part) {
    part = part || {};
    const partKey = part.key || part.id;
    if (!partKey || !part.title || (!part.mount && !part.render && !part.children?.length)) {
      throw Error('页面需要 key、title 和 mount 或 children');
    }
    const id = pageKey(plugin.id, partKey);
    if (pages.has(id)) throw Error('页面 key 重复：' + partKey);
    const button = document.createElement('button');
    button.dataset.nav = id;
    button.dataset.pluginTab = plugin.id;
    button.dataset.short = part.title;
    button.title = part.title;
    button.innerHTML = icon(part.icon || 'connect');
    button.append(document.createTextNode(part.title));
    document.querySelector('.sidebar nav').append(button);
    const page = { ...part, key: partKey, owner: plugin.id, button };
    pages.set(id, page);
    const remove = () => removePage(id);
    plugin.cleanup.push(remove);
    uiMotion.syncNavigation(true);
    window.pageNavigation?.sync();
    return remove;
  }

  function registerCommand(plugin, spec) {
    if (!spec?.title || typeof spec.run !== 'function') throw Error('command 需要 title 和 run');
    const id = `plugin:${plugin.id}:${spec.id || commands.size}`;
    if (commands.has(id)) throw Error('command id 重复');
    const command = { id, icon: spec.icon || 'connect', label: spec.title, kbd: spec.kbd || '', run: spec.run, owner: plugin.id };
    commands.set(id, command);
    const remove = () => commands.delete(id);
    plugin.cleanup.push(remove);
    return remove;
  }

  function registerService(plugin, spec) {
    if (!spec?.id || !spec.service) throw Error('service 需要 id 和 service');
    const id = `plugin:${plugin.id}:${spec.id}`;
    if (services.has(id)) throw Error('service id 重复');
    services.set(id, { ...spec, owner: plugin.id });
    const remove = () => services.delete(id);
    plugin.cleanup.push(remove);
    return remove;
  }

  function hook(plugin, bucket, spec) {
    const item = { ...spec, owner: plugin.id };
    bucket.push(item);
    const remove = () => {
      const index = bucket.indexOf(item);
      if (index >= 0) bucket.splice(index, 1);
    };
    plugin.cleanup.push(remove);
    return remove;
  }

  function host(plugin, bundle) {
    return {
      contract: 'jjb-plugin-1',
      apiVersion: HOST_API,
      desktopOnly: true,
      id: plugin.id,
      revision: plugin.revision,
      manifest: bundle.manifest,
      app: window,
      state,
      document,
      desktop: window.desktop,
      ui,
      signal: plugin.controller.signal,
      get config() { return plugin.config; },
      onConfig(fn) {
        if (typeof fn !== 'function') throw Error('onConfig 需要 listener');
        plugin.configListeners.push(fn);
        return () => {
          const index = plugin.configListeners.indexOf(fn);
          if (index >= 0) plugin.configListeners.splice(index, 1);
        };
      },
      onDispose(fn) { plugin.cleanup.push(fn); },
      async getData(name) { return (await desktop.pluginDataGet(plugin.id, name)).value; },
      async setData(name, value) { await desktop.pluginDataSet(plugin.id, name, value); },
      async saveConfig(config) {
        const composed = composeConfig(bundle.manifest, config);
        await desktop.pluginSet(plugin.id, { config: composed });
        applyConfig(plugin, composed);
        return composed;
      },
      api, navigate, render, refresh, toast,
      open(url) { return desktop.external(url); },
      registerPage(spec) { return registerPage(plugin, spec); },
      registerTab(spec) { return registerPage(plugin, spec); },
      registerPanel(spec) { return registerPage(plugin, spec); },
      registerCommand(spec) { return registerCommand(plugin, spec); },
      registerService(spec) { return registerService(plugin, spec); },
      service(name) {
        for (const item of services.values()) if (item.id === name || item.title === name) return item.service;
        throw Error('插件服务不存在：' + name);
      },
      intercept(pattern, handler) {
        if (typeof handler !== 'function') throw Error('请求拦截器需要 handler');
        return hook(plugin, plugin.requests, { pattern, handler });
      },
      onResponse(pattern, handler) {
        if (typeof handler !== 'function') throw Error('响应钩子需要 handler');
        return hook(plugin, plugin.responses, { pattern, handler });
      },
      onRender(name, handler) {
        if (typeof handler !== 'function') throw Error('渲染钩子需要 handler');
        const listener = event => {
          if (event.detail?.page === name && !plugin.controller.signal.aborted) handler(event.detail);
        };
        window.addEventListener('workspace-render', listener);
        const remove = () => window.removeEventListener('workspace-render', listener);
        plugin.cleanup.push(remove);
        return remove;
      },
      onSnapshot(handler) {
        if (typeof handler !== 'function') throw Error('快照钩子需要 handler');
        const listener = () => !plugin.controller.signal.aborted && handler(state.snapshot);
        window.addEventListener('snapshot-updated', listener);
        const remove = () => window.removeEventListener('snapshot-updated', listener);
        plugin.cleanup.push(remove);
        return remove;
      },
      onTrigger(event, handler) {
        if (typeof handler !== 'function') throw Error('触发器需要 handler');
        plugin.triggers.set(event, handler);
        return () => plugin.triggers.delete(event);
      },
      on(name, handler, options) {
        window.addEventListener(name, handler, options);
        const remove = () => window.removeEventListener(name, handler, options);
        plugin.cleanup.push(remove);
        return remove;
      },
      emit(name, detail) { window.dispatchEvent(new CustomEvent(name, { detail })); },
      addStyle(css) {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.append(style);
        plugin.cleanup.push(() => style.remove());
        return style;
      },
      createComponent(spec) {
        if (typeof spec === 'string') return document.createTextNode(spec);
        if (spec instanceof Node) return spec;
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw Error('component 需要 DOM 节点或组件描述');
        const element = document.createElement(spec.tag || 'div');
        if (spec.className) element.className = String(spec.className);
        if (spec.style) Object.assign(element.style, spec.style);
        for (const [name, value] of Object.entries(spec.attrs || {})) element.setAttribute(name, String(value));
        if (spec.text !== undefined) element.textContent = String(spec.text);
        for (const child of spec.children || []) element.append(this.createComponent(child));
        return element;
      },
      asset(name) {
        if (!(name in bundle.files)) throw Error('插件文件不存在：' + name);
        return bundle.files[name];
      },
      assetURL(name, type = 'text/plain') {
        const url = URL.createObjectURL(new Blob([this.asset(name)], { type }));
        plugin.urls.push(url);
        return url;
      },
      patch(target, name, replacement) {
        const original = target[name];
        target[name] = replacement;
        plugin.cleanup.push(() => { if (target[name] === replacement) target[name] = original; });
        return original;
      },
      async record(event, result, error) {
        const entry = { event, status: error ? 'failed' : 'done' };
        if (result !== undefined) entry.result = result;
        if (error) entry.error = errorText(error);
        return desktop.pluginRecord(plugin.id, entry);
      },
      async runs() { return desktop.pluginRuns(plugin.id); },
      async exec(options) { return desktop.pluginExec(plugin.id, options); },
    };
  }

  function applyConfig(plugin, config) {
    const before = JSON.stringify(plugin.config);
    plugin.config = config;
    if (JSON.stringify(config) === before) return;
    for (const listener of [...plugin.configListeners]) {
      try { listener(config); } catch (error) { console.error(error); }
    }
  }

  async function beforeRequest(request) {
    let current = { ...request };
    for (const plugin of running.values()) {
      for (const item of plugin.requests) {
        if (plugin.controller.signal.aborted || !matches(item.pattern, current.route)) continue;
        const next = await item.handler({ ...current, request: current });
        if (next) current = {
          route: String(next.route || current.route),
          method: String(next.method || current.method).toUpperCase(),
          body: next.body,
        };
      }
    }
    return current;
  }

  async function afterResponse(request, response, result) {
    for (const plugin of running.values()) {
      for (const item of plugin.responses) {
        if (plugin.controller.signal.aborted || !matches(item.pattern, request.route)) continue;
        const next = await item.handler({ ...request, response, status: response.status, ok: response.ok, result });
        if (next !== undefined) result = next;
      }
    }
    return result;
  }

  async function sync(force = false) {
    if (!window.desktop || !state.session || syncing) return;
    if (!force && Date.now() - lastSync < 1000) return;
    if (identity !== key()) stop();
    identity = key();
    const mine = epoch;
    syncing = true;
    lastSync = Date.now();
    try {
      entries = await desktop.pluginList();
      if (mine !== epoch) return;
      for (const [id, plugin] of running) {
        const entry = entries.find(item => item.id === id);
        if (!entry || !entry.enabled || entry.revision !== plugin.revision) {
          dispose(plugin);
          running.delete(id);
        } else applyConfig(plugin, composeConfig(entry.manifest, entry.config));
      }
      for (const entry of entries) {
        if (!entry.enabled || running.has(entry.id)) continue;
        const plugin = {
          id: entry.id, revision: entry.revision, config: composeConfig(entry.manifest, entry.config),
          triggers: new Map(), requests: [], responses: [], configListeners: [],
          cleanup: [], urls: [], controller: new AbortController(), error: '',
        };
        running.set(plugin.id, plugin);
        try {
          const bundle = await desktop.pluginGet(entry.id);
          if (mine !== epoch || plugin.controller.signal.aborted) continue;
          const api = host(plugin, bundle);
          plugin.host = api;
          const url = api.assetURL(bundle.manifest.entry, 'text/javascript');
          const module = await import(url);
          if (mine !== epoch || plugin.controller.signal.aborted) continue;
          const cleanup = await (module.activate || module.default)?.(api);
          if (typeof cleanup === 'function') plugin.cleanup.push(cleanup);
          pluginErrors.delete(plugin.id);
        } catch (error) {
          dispose(plugin);
          pluginErrors.set(plugin.id, errorText(error));
        }
      }
      if (state.page.startsWith('plugin:') && !pages.has(state.page) && state.page !== 'plugins') navigate('plugins');
      uiMotion.syncNavigation(true);
      if (state.page === 'plugins') render();
    } catch (error) {
      if (force) toast(errorText(error));
    } finally {
      syncing = false;
    }
  }

  /* ---- Page surface. `chrome:false` gives the part the full page area. ---- */
  function surface(container, spec) {
    if (spec?.chrome === false) {
      container.className = 'plugin-page plugin-page-full';
      container.replaceChildren();
      return container;
    }
    container.className = 'plugin-page';
    const title = spec?.title || '';
    const description = spec?.description || '';
    container.innerHTML = `<div class="plugin-page-heading"><h1>${esc(title)}</h1>${description ? `<p>${esc(description)}</p>` : ''}</div><div id="plugin-child"></div>`;
    return container.querySelector('#plugin-child');
  }

  /* ---- Error boundary, Magpie style: a broken page shows a retry card and
         stops running further mounts until the reader retries. ---- */
  function breakPage(target, owner, label, error) {
    brokenPages.set(target, { label, error });
    console.error(`[jjb-plugin] ${owner || 'plugin'}: ${label}`, error);
    const container = document.querySelector('#plugin-page');
    if (!container) return;
    container.className = 'plugin-page';
    container.innerHTML = `<div class="plugin-error" role="alert"><strong>此页面已停止工作</strong><span>${esc(errorText(error))}</span><div class="plugin-actions"><button type="button" class="secondary" data-plugin-retry>重试</button></div></div>`;
    container.querySelector('[data-plugin-retry]')?.addEventListener('click', () => {
      brokenPages.delete(target);
      showPage(target);
    });
  }

  function mountResult(target, result, signature, onCleanup) {
    const apply = value => {
      if (renderedPage !== signature.page || renderedSelection !== signature.selection || !target.isConnected) return;
      let node = value, cleanup;
      if (value && typeof value === 'object' && !(value instanceof Node) && 'node' in value) {
        node = value.node;
        cleanup = value.cleanup;
      }
      if (node instanceof Node) target.replaceChildren(node);
      if (node instanceof Node) hydrateIcons();
      if (typeof cleanup === 'function') onCleanup(cleanup);
    };
    if (typeof result === 'function') return onCleanup(result);
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).then(apply).catch(error => breakPage(signature.page, signature.owner, 'mount', error));
      return;
    }
    apply(result);
  }

  function showPage(currentPage, childId = pageSelection.get(currentPage)) {
    if (brokenPages.has(currentPage)) return;
    const page = pages.get(currentPage);
    const plugin = running.get(page?.owner);
    const container = document.querySelector('#plugin-page');
    if (!page || !plugin?.host || !container) return;
    const owner = plugin.id;
    if (typeof page.mount === 'function' || typeof page.render === 'function') {
      const mount = validateMount(page.mount || page.render);
      const selection = currentPage + ':direct';
      if (renderedPage === currentPage && renderedSelection === selection && renderedTarget?.isConnected) return;
      renderedPage = currentPage;
      renderedSelection = selection;
      pageCleanup?.();
      pageCleanup = null;
      const target = surface(container, page);
      renderedTarget = target;
      try {
        const result = mount({ container: target, root: container, host: plugin.host, page, config: plugin.config, signal: plugin.controller.signal });
        mountResult(target, result, { page: currentPage, selection, owner }, cleanup => pageCleanup = cleanup);
      } catch (error) {
        breakPage(currentPage, owner, 'mount', error);
      }
      return;
    }
    const children = page.children || [];
    const child = children.find(item => item.id === childId) || children[0];
    if (!child) return;
    pageSelection.set(currentPage, child.id);
    const selection = currentPage + ':' + child.id;
    if (renderedPage === currentPage && renderedSelection === child.id && renderedTarget?.isConnected) return;
    renderedPage = currentPage;
    renderedSelection = child.id;
    pageCleanup?.();
    pageCleanup = null;
    const target = surface(container, child.chrome === false ? child : page);
    renderedTarget = target;
    const mount = validateMount(child.mount || child.render);
    try {
      const result = mount({ container: target, root: container, host: plugin.host, page, child, config: plugin.config, signal: plugin.controller.signal });
      mountResult(target, result, { page: currentPage, selection, owner }, cleanup => pageCleanup = cleanup);
    } catch (error) {
      breakPage(currentPage, owner, child.id + '.mount', error);
    }
  }

  function mount() {
    pageCleanup?.();
    pageCleanup = null;
    if (!window.desktop) return;
    if (state.page === 'plugins') return mountManager();
    if (state.page.startsWith('plugin:')) showPage(state.page);
  }

  async function dispatchTrigger(event, payload) {
    for (const plugin of running.values()) {
      const declared = entries.find(entry => entry.id === plugin.id)?.manifest.events || [];
      const matched = declared.includes('*') || declared.includes(event);
      const handler = plugin.triggers.get(event) || plugin.triggers.get('*');
      if (!matched || !handler) continue;
      let result, error = '';
      try { result = await handler(payload, plugin.host); }
      catch (triggerError) { error = errorText(triggerError); }
      try { await desktop.pluginRecord(plugin.id, { event, status: error ? 'failed' : 'done', result: result || {}, error }); }
      catch (recordError) { console.error(recordError); }
    }
  }

  function detectTaskEvents() {
    const snapshot = state.snapshot;
    const current = new Map((snapshot.tasks || []).map(task => [task.id, task]));
    for (const task of current.values()) {
      const old = previousTasks.get(task.id);
      if (!old) dispatchTrigger('task.created', { event: 'task.created', task });
      else if (old.version !== task.version) dispatchTrigger('task.upsert', { event: 'task.upsert', task, previous: old });
    }
    for (const old of previousTasks.values()) if (!current.has(old.id)) dispatchTrigger('task.delete', { event: 'task.delete', task: old });
    previousTasks = current;
  }

  /* ---- Manager. Schema settings draw their own form; raw JSON stays for
         plugins without a schema. ---- */
  function settingsEditor(entry) {
    const schema = Array.isArray(entry.manifest.settings) ? entry.manifest.settings : [];
    if (!schema.length) {
      return `<label>插件配置<textarea data-plugin-config rows="6" spellcheck="false" aria-label="插件 JSON 配置">${esc(JSON.stringify(entry.config || {}, null, 2))}</textarea></label>`;
    }
    const composed = composeConfig(entry.manifest, entry.config);
    return `<div class="plugin-settings" data-plugin-schema="${esc(entry.id)}">${schema.map(setting => {
      const value = composed[setting.key];
      const control = setting.type === 'bool'
        ? `<input type="checkbox" data-plugin-setting="${esc(setting.key)}" ${value ? 'checked' : ''}>`
        : setting.type === 'number'
          ? `<input type="number" data-plugin-setting="${esc(setting.key)}" value="${typeof value === 'number' ? esc(String(value)) : ''}" ${setting.min !== undefined ? `min="${esc(String(setting.min))}"` : ''} ${setting.max !== undefined ? `max="${esc(String(setting.max))}"` : ''}>`
          : Array.isArray(setting.enum)
            ? `<select data-plugin-setting="${esc(setting.key)}">${setting.enum.map(option => `<option value="${esc(option)}" ${option === value ? 'selected' : ''}>${esc(option)}</option>`).join('')}</select>`
            : `<input type="text" data-plugin-setting="${esc(setting.key)}" value="${esc(String(value ?? ''))}" spellcheck="false">`;
      return `<label>${esc(setting.title || setting.key)}${control}${setting.description ? `<small class="helper">${esc(setting.description)}</small>` : ''}</label>`;
    }).join('')}</div>`;
  }

  function schemaValues(entry) {
    const schema = Array.isArray(entry.manifest.settings) ? entry.manifest.settings : [];
    if (!schema.length) return null;
    const row = document.querySelector(`.plugin-row[data-plugin-id="${CSS.escape(entry.id)}"]`);
    const values = {};
    for (const setting of schema) {
      const input = row?.querySelector(`[data-plugin-setting="${CSS.escape(setting.key)}"]`);
      if (!input) continue;
      values[setting.key] = setting.type === 'bool' ? input.checked : setting.type === 'number' ? Number(input.value) : input.value;
    }
    return composeConfig(entry.manifest, values);
  }

  function pluginPage(entry) {
    const runtime = running.get(entry.id);
    const runtimeError = pluginErrors.get(entry.id);
    const triggers = entry.manifest.events?.length ? entry.manifest.events.join('、') : '手动调用';
    const status = runtimeError
      ? `<span class="tag red">运行错误</span>`
      : entry.enabled ? `<span class="tag green">运行中</span>` : `<span class="tag">已停用</span>`;
    const owned = [...pages].filter(([, page]) => page.owner === entry.id).map(([id, page]) => [id, page.title]);
    const permissions = Array.isArray(entry.manifest.permissions) ? entry.manifest.permissions : [];
    return `<section class="plugin-card plugin-row" data-plugin-id="${esc(entry.id)}">
      <div class="plugin-head">
        <div class="plugin-identity">
          <span class="plugin-mark" aria-hidden="true">${esc(entry.manifest.name.slice(0, 1).toUpperCase())}</span>
          <div class="plugin-title"><h3>${esc(entry.manifest.name)}</h3><small>${esc(entry.manifest.version)} · 修订 ${entry.revision}</small></div>
          ${status}
        </div>
        <label class="plugin-switch"><input type="checkbox" data-plugin-enable ${entry.enabled ? 'checked' : ''}><span>启用</span></label>
      </div>
      <p class="plugin-description">${esc(entry.manifest.description || '开发者未提供描述。')}</p>
      <div class="plugin-tags">
        <span class="plugin-chip">契约 ${esc(entry.manifest.api)}</span>
        <span class="plugin-chip">触发 ${esc(triggers)}</span>
        ${owned.length ? `<span class="plugin-chip">${owned.length} 个页面</span>` : `<span class="plugin-chip">无页面入口</span>`}
        ${permissions.map(permission => `<span class="plugin-chip">${esc(permission)}</span>`).join('')}
      </div>
      ${runtimeError ? `<div class="plugin-error">${esc(runtimeError)}</div>` : ''}
      <details class="plugin-debug">
        <summary>设置与调试<small>${Array.isArray(entry.manifest.settings)?.length ? '声明式设置 · 执行记录' : '本机配置 · 执行记录'}</small></summary>
        <div class="plugin-debug-body">
          ${settingsEditor(entry)}
          <div class="plugin-actions"><button class="secondary" data-plugin-save>保存设置</button><button class="secondary" data-plugin-runs>执行记录</button></div>
          <pre class="plugin-output" data-plugin-output hidden></pre>
        </div>
      </details>
      <footer class="plugin-footer">
        <div class="plugin-actions">
          ${owned.map(([id, title]) => `<button class="secondary" data-plugin-open="${esc(id)}">打开 ${esc(title)}</button>`).join('')}
        </div>
        <button class="plain-button plugin-delete" data-plugin-delete>删除插件</button>
      </footer>
    </section>`;
  }

  function page() {
    if (!window.desktop) return heading('插件', '插件只在桌面端运行。') + `<div class="panel">${empty('使用桌面版安装插件', '网页端不执行本机插件，也不保存插件代码。')}</div>`;
    const enabledCount = entries.filter(entry => entry.enabled).length;
    return heading('桌面插件', '自由安装和开发插件。插件在本机运行，可以修改界面、访问应用 API 和调用本机工具。', `<button class="primary" id="plugin-import">${icon('plus')}导入插件</button><input type="file" id="plugin-file" accept=".json,.zip" hidden>`) +
      `<section class="panel plugin-overview"><div class="panel-head"><h3>开放桌面契约</h3><small>jjb-plugin-1 · 本机运行</small></div>
        <div class="plugin-capabilities">
          <div><strong>自由开发</strong><span>导入 JSON 或 ZIP，修改后重新导入即可升级。</span></div>
          <div><strong>声明式设置</strong><span>manifest.settings 生成设置表单，权限对外公示。</span></div>
          <div><strong>本机能力</strong><span>调用桌面桥和本机工具，代码与记录都保存在这台电脑。</span></div>
        </div>
      </section>
      <section class="panel plugin-board">
        <div class="panel-head"><h3>已安装插件</h3><small>${entries.length ? `${enabledCount} 个运行中 · 共 ${entries.length} 个` : '支持 JSON 和 ZIP 插件包'}</small></div>
        ${entries.map(pluginPage).join('') || empty('尚未安装插件', '导入开发者提供的 JSON 或 ZIP 插件包。<br>契约：jjb-plugin-1')}
      </section>`;
  }

  async function importFile(file) {
    if (!window.desktop) throw Error('插件导入只能在桌面端使用');
    if (/\.zip$/i.test(file.name)) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      await desktop.pluginImportArchive(btoa(binary));
    } else {
      await desktop.pluginImport(JSON.parse(await file.text()));
    }
    toast('插件已导入，启用后在本机运行');
    await sync(true);
  }

  async function importInput(event) {
    const input = event.target, file = input.files?.[0];
    if (!file) return;
    try { await importFile(file); }
    catch (error) { toast(errorText(error)); }
    finally { input.value = ''; }
  }

  async function managerClick(event) {
    const row = event.target.closest('[data-plugin-id]');
    if (!row || state.page !== 'plugins') return;
    if (event.target.matches('[data-plugin-retry]')) return;
    const id = row.dataset.pluginId;
    const entry = entries.find(item => item.id === id);
    try {
      if (event.target.matches('[data-plugin-open]')) navigate(event.target.dataset.pluginOpen);
      if (event.target.matches('[data-plugin-delete]')) { await desktop.pluginDelete(id); await sync(true); }
      if (event.target.matches('[data-plugin-save]')) {
        const values = schemaValues(entry);
        const config = values || JSON.parse(row.querySelector('[data-plugin-config]').value);
        await desktop.pluginSet(id, { config });
        await sync(true);
        toast('插件设置已保存');
      }
      if (event.target.matches('[data-plugin-runs]')) {
        const output = row.querySelector('[data-plugin-output]');
        output.hidden = false;
        output.textContent = JSON.stringify(await desktop.pluginRuns(id), null, 2);
      }
    } catch (error) { toast(errorText(error)); }
  }

  async function managerChange(event) {
    if (!event.target.matches('[data-plugin-enable]')) return;
    const row = event.target.closest('[data-plugin-id]');
    try {
      await desktop.pluginSet(row.dataset.pluginId, { enabled: event.target.checked });
      await sync(true);
    } catch (error) { toast(errorText(error)); }
  }

  function mountManager() {
    document.querySelector('#plugin-import')?.addEventListener('click', () => document.querySelector('#plugin-file').click());
    document.querySelector('#plugin-file')?.addEventListener('change', importInput);
  }

  window.addEventListener('snapshot-updated', detectTaskEvents);
  window.addEventListener('beforeunload', stop);
  document.addEventListener('click', managerClick);
  document.addEventListener('change', managerChange);

  window.pluginUI = {
    page, mount, sync, stop,
    beforeRequest, afterResponse,
    commands: () => [...commands.values()],
    services: () => [...services.values()],
    children: pageIdText => [...(pages.get(pageIdText)?.children || [])].map(child => [child.id, child.title || child.id]),
    childTitle: (pageIdText, childId) => (pages.get(pageIdText)?.children || []).find(child => child.id === childId)?.title,
    showChild: (pageIdText, childId) => { renderedPage = ''; renderedSelection = ''; showPage(pageIdText, childId); },
    title: id => pages.get(id)?.title,
  };
  window.jiaojianbox = { contract: 'jjb-plugin-1', apiVersion: HOST_API, desktopOnly: true, api, navigate, render, refresh, state, desktop: window.desktop, ui };
  if (document.documentElement.dataset.runtime === 'web') document.querySelector('[data-nav="plugins"]')?.remove();
})();
