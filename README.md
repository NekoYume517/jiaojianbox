# 交件箱 · 0.6.20

通知、待办与文件，一处整理。

> **合规与隐私声明**
>
> 交件箱只用于处理使用者有权访问的工作通知、待办与文件。QQ、微信采集默认只在本机 Windows 设备上运行，使用者必须在应用内确认授权并主动选择要监听的会话；不采集聊天软件密码，不代替用户登录，不自动发送消息。QQ 通过本机 SnowLuma/SnowCat OneBot 接口读取获准消息；微信通过本机已登录客户端的数据目录进行只读查询，媒体通常只保留类型占位，除用户主动上传外不会把聊天数据库、媒体文件或数据库密钥上传到服务器。
>
> 默认服务端 `https://jiaojianbox.bansonic.top` 只在启用云端或登录后同步时处理账号资料、同步的通知/待办/文件、用户主动创建或接收的分享与收集内容、触发器会话、模型用量和必要配置。用户选择的聊天上下文、文件内容或图片可由交件箱发往用户自行配置的模型接口；启用管理员提供的默认 AI 服务时，则由服务端转发到管理员配置的上游模型。分享是否公开、是否需要登录、是否允许下载或修改以及访问期限由分享者设置。项目不出售用户数据，不用于广告画像。
>
> 完整范围与删除、备份和安全边界见 [隐私与数据处理](PRIVACY.md)，微信本地只读采集规则见 [微信采集协议](docs/wechat-collection.md)。使用者应遵守适用法律、平台规则和所在组织的数据制度，并仅在具有合法处理依据时收集他人信息。

桌面端和服务端共用 Go 核心；Windows 桌面使用 Wails v3 与系统 WebView2，界面采用原生 JavaScript/CSS，本机能力通过 Wails 绑定调用。Android 在线模式采用 M3 登录门、共享网页工作区和文件/日历连接器，见 [Android 套壳预览说明](docs/android-web-shell.md)。技术结构参考 [Magpie](https://github.com/yetone/magpie)，视觉采用中性表面、克制圆角和细边框，支持浅色、深色、跟随系统，以及 Tokyo Night、Nord、Graphite 配色。

所有界面开发以 [UI、控件与动效规范](docs/ui-design-standard.md) 为统一基线，涵盖配色、字号、间距、布局、tab、表单、文件拖放、进度反馈、动效与验收矩阵。主工作区和服务端页面复用同一运行时与验收脚本，快捷收集保持轻量例外。

## 安装使用

从 [GitHub Releases](https://github.com/NekoYume517/jiaojianbox/releases/latest) 下载 Windows 安装程序 EXE 或 Android APK。Windows 自定义安装程序包含采集器、独立 Python 运行环境、微信数据库读取模块、SnowLuma/Node、WebView2 离线安装程序和 VC++ 运行库，无需另外配置开发环境。首次启用 QQ 时在应用内阅读组件协议、选择已登录实例和会话。

默认服务端为 `https://jiaojianbox.bansonic.top`，登录页隐藏地址，通过浏览器授权登录。选择“连接其他自建服务器”后直接访问该服务。也可离线使用；AI 功能只访问用户自行配置的模型 API。

- 通知：QQ、微信或随手记，筛选后使用 AI 分析，可选择上下文，支持流式进度与格式容错。
- 待办：材料要求、截止时间、提醒、回执、归档、删除及版本冲突检查。
- 文件：直接拖入指定待办；拖入空白区域后由 AI 建议归属，也可手动整理。
- 快捷收集：快捷键 `Ctrl+Shift+Space` 或文件拖动时显示，固定尺寸、记住位置，收下文件后保持打开；可在设置中关闭或调整显示内容。
- 统计：ECharts 展示每日 Token、首字/完整响应耗时、成功与失败情况。
- 账号：昵称、密码、邮箱、密码找回；管理员配置注册方式、邀请码和 SMTP。

## 开发与验证

需要 Go 1.26.8 或更新版本。Windows 桌面开发需要系统 WebView2。核心 HTTP 服务不依赖 Node 或 Python。

```powershell
go run ./cmd/jiaojianbox-server
go run ./cmd/jiaojianbox
go test ./internal/api ./internal/store ./internal/setup ./internal/gui
go vet ./internal/api ./internal/store ./internal/setup ./internal/gui
```

仅构建采集组件/安装程序时需要 Python 和 Node 构建工具：

```powershell
npm ci
python -m pip install -r requirements-dev.txt
npm run package:win
python -X utf8 scripts/verify-installer.py
```

采集器使用 PyInstaller 独立打包，构建后执行 `self-test` 验证 SQLite、psutil、cryptography 与微信读取模块。QQ 使用独立子进程及本机只读网关，实例、联系人与调试操作均由交件箱管理。Windows 专用读取模块不影响其他平台的通用工作空间；macOS/Linux 桌面尚未实机验收。

## 数据与升级

延续原数据库文件名、SQLite 表结构、文件 ID、密码哈希与 Fernet 加密格式。每次升级前会先合并 SQLite WAL、检查完整性，再在同一持久卷生成不可覆盖的数据库、密钥及附件校验备份；0 字节或中断备份会自动重建。主库损坏或缺失时会优先原位修复，再回退到最新完整备份并恢复附件与密钥；无法恢复时只隔离坏文件，不删除原内容。缺少原加密密钥时停止启动。为兼容历史升级，仍可从旧版本的 `Local State` 与 DPAPI 凭证安全读取 Windows 登录信息。安装/卸载不会删除本机工作空间。

云端始终挂载原 `/data` 数据卷。不要在升级时删除或替换卷，也不要更换 `master.key`/`JJB_MASTER_KEY`。云端与本机迁移为复制式，不删除来源，不迁移账号凭证和模型密钥。部署步骤见 [Coolify 指南](docs/deploy-coolify.md)。

当前发行包统一使用 Go 核心、Wails v3 桌面、共享 Web 界面、独立采集组件与自定义安装程序。`server/` 仅保留用于兼容测试与历史数据行为；历史架构说明见 [历史文档](docs/legacy-implementation.md)。

## 插件开发

扩展契约、一级/二级 tab、任务触发器与外部 AI 工具接入见 [插件开发指南](docs/plugin-development.md)。可导入样例位于 [examples/plugins/task-agent](examples/plugins/task-agent)。

## 开源许可与贡献

本项目原创代码采用 [MIT License](LICENSE)。第三方组件仍分别适用各自许可证，尤其 SnowCat/NapCat 运行时受其 Limited Redistribution License 限制；详见 [第三方与来源](THIRD_PARTY_NOTICES.md)。

维护者与代码贡献者见 [CONTRIBUTORS.md](CONTRIBUTORS.md)。
