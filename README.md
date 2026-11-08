# 交件箱 · 0.6.1

通知、待办与文件，一处整理。

桌面端和服务端共用 Go 核心；Windows 桌面使用 Wails v3 与系统 WebView2，界面采用原生 JavaScript/CSS。Android 保持原生 Material 3。技术结构参考 [Magpie](https://github.com/yetone/magpie)，视觉采用扁平、直角和细边框，支持浅色、深色、跟随系统，以及 Tokyo Night、Nord、Graphite 配色。

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

延续原数据库文件名、SQLite 表结构、文件 ID、密码哈希与 Fernet 加密格式。Go 接管既有数据前，在同一持久卷生成不可覆盖的数据库、密钥及附件校验备份；缺少原加密密钥时停止启动。旧 Electron 的 Windows 登录凭证可从原 `Local State` 与 DPAPI 安全迁移。安装/卸载不会删除本机工作空间。

云端始终挂载原 `/data` 数据卷。不要在升级时删除或替换卷，也不要更换 `master.key`/`JJB_MASTER_KEY`。云端与本机迁移为复制式，不删除来源，不迁移账号凭证和模型密钥。部署步骤见 [Coolify 指南](docs/deploy-coolify.md)。

`server/` 和旧 Electron 模块保留为兼容测试及回滚参考，不参与 0.6.0 安装包/服务端镜像。历史实现说明见 [历史文档](docs/legacy-implementation.md)。
