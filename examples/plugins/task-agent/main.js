export function activate(host) {
  host.registerPage({ key: 'agent', title: '任务自动化', description: '把任务上下文交给本机工具处理。', children: [
    { id: 'runs', title: '执行记录', mount({ container, host }) {
      const output = document.createElement('pre');
      output.className = 'plugin-status';
      container.append(output);
      host.record('manual', { name: 'read' })
        .then(async () => output.textContent = JSON.stringify(await host.runs(), null, 2))
        .catch(error => { output.textContent = error.message; });
    } },
    { id: 'settings', title: '工具配置', mount({ container, host, config }) {
      const form = host.ui.form(host.manifest.settings || [], config);
      container.append(form.element);
      const save = host.ui.button({ label: '保存配置', kind: 'primary', onClick: async () => {
        try { await host.saveConfig(form.values()); host.toast('已保存'); }
        catch (error) { host.toast(error.message); }
      } });
      container.append(save);
    } },
  ] });
  host.onTrigger('task.created', async context => {
    if (!host.config.command) throw Error('请先在任务自动化的工具配置中填写本机工具。');
    const args = String(host.config['args-template'] || '{stdin}').split(/\s+/).map(part => part === '{stdin}' ? JSON.stringify(context) : part);
    const result = await host.exec({ command: host.config.command, args, cwd: host.config.cwd || '', stdin: JSON.stringify(context) });
    if (result.exitCode !== 0) throw Error(result.stderr || '工具执行失败');
    let output;
    try { output = JSON.parse(result.stdout); } catch { output = { summary: result.stdout }; }
    return output;
  });
}
