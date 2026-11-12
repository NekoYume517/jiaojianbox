# Magpie 插件架构研究与交件箱落地建议

研究日期：2026-11-09。核对源码提交：`67d06c24ea1f2c9214fa0978e34152b6a38b887f`。本文记录架构判断；交件箱已在 `web/plugins.js`、`internal/gui/plugins.go` 实现 `jjb-plugin-1` 桌面运行时，并以宿主 API `1.1` 增加超时、故障隔离、服务生命周期和包内模块加载。

## 已核实的三层实现

| 层 | Magpie 实现 | 对交件箱的意义 |
| --- | --- | --- |
| Go 内置功能插件 | `internal/pluginrt` 注册 Manifest，声明 API 版本、Requires/Provides 服务依赖、配置 Schema、界面贡献点；Reconcile 按依赖启动、反向释放；失败或 panic 标记失败并撤销本次注册 | 可先把采集器、统计、导出等可选能力模块化；这些 Go 插件编译进主程序，不是下载一个 Go 文件即可动态加载 |
| 第三方 JS 插件 | `internal/plugin` 维护 plugins.json、安装目录、选项、认证信息；支持 npm、Git 和本地路径；OpenCode provider 插件通过 Bun 子进程 host.js 运行，主程序用 stdin/stdout 通信 | 依赖外部库、访问网络或启动本地工具的采集适配器适合进程外托管；进程隔离本身不是操作系统权限沙箱 |
| 高频 JS 钩子 | `internal/middleware` 使用 Go 内嵌 moejs 引擎；编译缓存、每请求运行时池、超时中断；源码参数为请求 250ms、单流事件 50ms、加载 1s | 纯消息过滤、字段规范化、规则匹配适合受限脚本；读文件、网络和模型调用走宿主能力接口，不能直接放进这些短时限钩子 |

UI 是另外一道边界：package.json 的 magpie.page / panels / actions 声明独立页面、嵌入面板和菜单动作。页面在 sandbox="allow-scripts" iframe 中懒加载；CSP 默认禁止网络、同源存储、顶层导航。用 postMessage 获取主题、配置和声明过的读取能力，后端再次检查权限。页面超时或报错显示局部错误与重试，离开后可回收 iframe。

## 适配方案

建议复用架构思路，定义交件箱自己的插件契约，不承诺直接兼容全部 Magpie/OpenCode 插件。它们依赖模型网关、供应商认证和 Agent 等宿主服务，与交件箱的消息、待办、材料数据模型不同。

首期固定宿主 API `1.0`，分为以下扩展点：

| 扩展点 | 示例 | 执行位置 |
| --- | --- | --- |
| message.source | QQ、微信、邮箱、Webhook 的消息导入 | 桌面本地采集器或服务端；微信读取固定在本机 |
| message.filter | 群聊过滤、消息去重、字段转换 | 受限脚本；失败保留原始消息 |
| task.action | 导出日历、发送提醒、生成提交清单 | 宿主授权能力，写操作经过校验 |
| file.extractor / file.classifier | 新文件格式提取、材料命名规则 | 本机 worker；文件只传获准的引用 |
| ui.page / ui.panel / ui.action | 周视图、课程面板、右键动作 | sandbox iframe 与宿主消息桥 |

插件清单建议：

```json
{
  "id": "calendar-export",
  "name": "日历导出",
  "version": "0.1.0",
  "api": "^1.0",
  "targets": ["desktop", "server"],
  "permissions": ["tasks:read", "files:create"],
  "contributes": {
    "page": {"title": "日历", "file": "ui/index.html"},
    "actions": [{"id": "export-ics", "menu": "task", "title": "导出到日历"}]
  }
}
```

权限实现必须带账号与工作区上下文。服务端插件安装/更新属于管理员操作，普通用户只能启用管理员许可的插件；桌面插件的 QQ/微信采集权限与云端数据权限分开。插件不能获取通用账号 token、数据库句柄、主密钥或任意 SQL。

插件数据独立命名空间保存。停用仅停止运行，不删除插件数据、通知或待办；升级先验证包与 API 兼容性，在新目录准备完成后原子切换，失败回退上一版本。卸载代码与删除数据是两个明确动作。

实施顺序：先抽象内置模块生命周期与贡献点，再做页面沙箱和受控数据桥，最后开放第三方包安装/更新。优先提供一个日历导出或规则过滤示例验证完整闭环；QQ/微信原生依赖继续由可信采集器处理。

当前实现采用“完整信任的本机 WebView 插件”：页面直接复用宿主 DOM 与 UI kit，触发器和钩子共享主线程，因此不能用 `Promise` 超时强行终止同步死循环。激活、挂载、请求/响应钩子、命令、事件监听、服务和触发器均已增加异步超时与独立错误边界；CPU 密集任务仍必须交给 Web Worker、`host.exec` 或服务端。进一步隔离页面时，应保留 `jjb-plugin-1` 的注册 API，并把页面渲染迁入同源 sandbox iframe，而不是直接推翻现有插件包格式。

## 依据

- [内置插件运行时与完整生命周期文档](https://github.com/yetone/magpie/blob/67d06c24ea1f2c9214fa0978e34152b6a38b887f/docs/subsystems/plugin-runtime.md)
- [第三方插件安装、持久化与 Bun 托管](https://github.com/yetone/magpie/blob/67d06c24ea1f2c9214fa0978e34152b6a38b887f/internal/plugin/store.go)
- [页面、面板、菜单及权限声明](https://github.com/yetone/magpie/blob/67d06c24ea1f2c9214fa0978e34152b6a38b887f/internal/plugin/page.go)
- [页面 CSP 与服务端限制](https://github.com/yetone/magpie/blob/67d06c24ea1f2c9214fa0978e34152b6a38b887f/internal/gui/pluginpage.go)
- [页面沙箱、主题桥与懒加载](https://github.com/yetone/magpie/blob/67d06c24ea1f2c9214fa0978e34152b6a38b887f/internal/gui/assets/pluginpages.js)
- [moejs 钩子和超时](https://github.com/yetone/magpie/blob/67d06c24ea1f2c9214fa0978e34152b6a38b887f/internal/middleware/middleware.go)

Magpie 使用 MIT 许可证。若后续实际复制其代码，需保留相应版权与许可证说明。
