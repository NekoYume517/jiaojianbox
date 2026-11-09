# 交件箱桌面插件开发指南

契约版本：`jjb-plugin-1`（宿主 API `1.0`，manifest 声明 `api: "^1"`）。内核、页面 slot、声明式设置和错误边界遵循 Magpie 的设计（MIT，见 THIRD_PARTY_NOTICES）。插件只在桌面端运行；网页端不显示插件入口，也不执行或存储插件。任何登录用户都可以导入、启用、停用、升级、删除和开发插件。插件是完整信任的本机扩展，可以访问当前页面、应用 API 和本机工具，因此请只安装来自可信开发者的插件。

## 1. 安装包

插件页支持两种格式：

```text
my-plugin.zip
├── manifest.json
└── main.js
```

```json
{
  "manifest": {
    "api": "^1",
    "id": "my-plugin",
    "name": "我的插件",
    "version": "0.1.0",
    "entry": "main.js",
    "description": "一个桌面插件",
    "settings": [
      { "key": "endpoint", "type": "string", "title": "接口地址", "default": "" },
      { "key": "retries", "type": "number", "title": "重试次数", "default": 2, "min": 0, "max": 10 },
      { "key": "mode", "type": "string", "title": "运行模式", "enum": ["fast", "safe"], "default": "safe" },
      { "key": "enabled", "type": "bool", "title": "默认启用", "default": false }
    ],
    "permissions": ["tasks:read", "tools:exec"],
    "events": ["task.created", "*"]
  },
  "files": {
    "main.js": "export function activate(host) { /* ... */ }"
  }
}
```

字段约定：

- `api` 必须是 `^1` 形式的 caret 范围，主版本需要与宿主 API 一致，否则导入被拒绝。
- `id` 只能使用小写字母、数字和短横线；`name`、`version`、`entry` 必填。
- `settings` 是声明式设置 schema。`key` 使用小写字母、数字和短横线；`type` 支持 `bool`、`number`、`string`；`string` 可带 `enum`，`number` 可带 `min` / `max`。插件页会根据 schema 自动生成设置表单，配置按 schema 校验合成：默认值在前，类型或枚举不符的值被丢弃。
- `permissions` 是声明的能力列表（如 `tasks:read`、`messages:read`、`tools:exec`），会在插件卡片上公示。契约目前是完整信任模型，权限声明用于向用户说明插件会接触的数据。
- `events` 声明触发器：`task.created`、`task.upsert`、`task.delete`，`*` 表示全部。

ZIP 必须在根目录包含 `manifest.json`。单文件最大 4 MB，解压后最大 16 MB；路径不能包含 `..`、绝对路径或反斜杠。入口是一个 ES module，导出 `activate(host)` 或默认函数。代码只允许 UTF-8 文本；需要二进制资产时用 base64 编码并自行解码。

导入相同 `id` 会替换代码，`revision` 加一；本机配置、数据和历史执行记录保留，配置会按新 manifest 的 schema 重新合成。新代码默认停用，需要重新启用。删除插件会删除本机代码、配置、数据和执行记录。

## 2. 宿主上下文

`activate(host)` 收到的宿主对象仿照 Magpie 的内核上下文：

```js
export function activate(host) {
  host.id;              // 插件 id
  host.contract;        // 'jjb-plugin-1'
  host.apiVersion;      // '1.0'
  host.manifest;        // 完整 manifest（含 settings schema）
  host.config;          // 按 schema 合成后的配置
  host.ui;              // UI 套件（见下）
  host.state;           // 应用状态（只读约定）
  host.desktop;         // 桌面桥（完整信任）
  host.signal;          // AbortSignal，插件停用或删除时中止
  host.app;             // window
  host.document;        // document
}
```

### 页面（slot）

`registerPage` 把一个页面注册进侧边栏，页面 `key` 决定路由 `plugin:<插件id>:<key>`：

```js
host.registerPage({
  key: 'board',            // 或 id；不能重复
  title: '看板',
  icon: 'file',            // 可选，内置线性图标名
  description: '材料看板',  // 可选，页面副标题
  chrome: true,            // false 时占据整个页面区域（无标题头）
  mount(ctx) {             // ctx = { container, root, host, page, config, signal }
    ctx.container.textContent = '你好，' + ctx.config.endpoint;
    // 返回清理函数、{node, cleanup}、DOM 节点或 Promise 均可
  },
});
```

二级页面用 `children`，每项 `{ id, title, mount(ctx), chrome? }`，会生成 Magpie 风格的缩进子导航；子项 `chrome:false` 同样生效。`registerTab` / `registerPanel` 是 `registerPage` 的别名。

### 错误边界

每次页面挂载都在错误边界内运行。挂载抛错或 Promise 失败时，页面替换为「此页面已停止工作」卡片，显示错误信息和重试按钮；重试之前该页面不再执行后续挂载，其他页面不受影响。`activate` 本身抛错时插件标记为运行错误，不注册任何页面。重试会重新执行 `mount`。

### UI 套件

`host.ui` 提供与应用一致的基础组件（对应 Magpie 的 `magpie.ui`）：

```js
host.ui.el('div', { class: 'panel', events: { click: fn } }, children);
host.ui.button({ label: '保存', kind: 'primary', onClick });
host.ui.toggle({ label: '自动刷新', checked, onChange });
host.ui.row('标签', control, '说明');
const form = host.ui.form(host.manifest.settings, host.config, onChange);
form.element;  // 按 schema 生成的表单
form.values(); // 收集当前值
```

### 命令、服务与钩子

```js
host.registerCommand({ id: 'send', title: '发送日报', icon: 'file', kbd: 'D', run() {} });   // 进入 Ctrl+K 命令面板
host.registerService({ id: 'ticker', service: { start() {}, stop() {} } });
host.service('ticker');
host.onTrigger('task.created', async context => ({ summary: '已处理' }));  // 返回值写入执行记录
host.intercept('/api/tasks', ({ request }) => ({ ...request, body }));      // 请求拦截
host.onResponse('/api/*', ({ result }) => result);                          // 响应钩子
host.onRender('inbox', detail => {});                                       // 页面渲染钩子
host.onSnapshot(snapshot => {});                                            // 快照更新
host.onConfig(config => {});                                                // 配置变化
host.onDispose(fn);                                                          // 停用/删除时执行，逆序
```

### 数据与配置

```js
await host.getData('last-run');        // 插件独立命名空间
await host.setData('last-run', {...});
await host.saveConfig({ endpoint: '...' });  // 按 schema 合成后持久化，触发 onConfig
await host.record('manual', { name: 'read' });  // 执行记录
await host.runs();
await host.exec({ command: 'node', args: ['script.js'], cwd: '', stdin: '...' });  // 本机工具，5 分钟超时
```

### 界面与网络

```js
host.api('/api/tasks', 'POST', { title: '新待办' });  // 应用 API（带会话）
host.navigate('tasks'); host.render(); host.refresh();
host.toast('提示'); host.open('https://example.com');
host.addStyle('.my-plugin { color: var(--ink) }');
host.createComponent({ tag: 'section', className: 'panel', children: [{ tag: 'h3', text: '标题' }] });
host.asset('data.json'); host.assetURL('data.json', 'application/json');
host.patch(window, 'fetch', wrapped);  // 运行期补丁，停用时自动还原
```

## 3. 示例

`examples/plugins/task-agent/` 是完整示例：声明 schema 设置（工具命令、参数模板、超时）、`tasks:read` 与 `tools:exec` 权限，`task.created` 触发时把任务上下文交给本机命令行工具，并把结果写回执行记录。

## 4. 升级与调试

- 插件卡片显示契约版本、触发器、页面数量和权限声明；设置区按 schema 生成表单，无 schema 时保留 JSON 编辑器。
- 「执行记录」查看每次触发的结果与错误。
- 升级只替换代码，配置、数据、执行记录保留；`revision` 递增后插件需要重新启用。
- 停用仅停止运行；删除才清除本机数据。
