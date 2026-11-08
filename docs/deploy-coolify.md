# Coolify 部署指南

服务端是 Go 原生 HTTP 容器，Coolify 可直接部署。

## 部署步骤（coolify.bansonic.top）

1. **新建项目 → 资源 → Docker Compose**（或 Dockerfile）
2. **Git 来源**：`https://github.com/NekoYume517/jiaojianbox.git`（公开；或用 Gitea 镜像 `https://git.bansonic.top/zzy/jiaojianbox.git`）
3. **分支**：`main`
4. **构建**：仓库根目录的 `Dockerfile`（Go 多阶段编译 + Debian slim，自带健康检查 `/health`）
5. **端口**：容器内 `8765`，对外由 Coolify 反代
6. **持久卷**：`jiaojianbox-data:/data`（SQLite + 附件 + `master.key` 都在这里，**备份要带整个 /data**）
7. **环境变量**（Coolify 环境变量面板）：
   - `JJB_ALLOW_REGISTRATION=false`（首个账号注册后关闭开放注册）
   - `JJB_MAX_UPLOAD_MB=50`
8. **域名**：Coolify 应用 → Domains 绑定 `jiaojianbox.bansonic.top`，勾选 Let's Encrypt 证书（HTTPS 自动配好；WebSocket `/api/sync` 由 Coolify 反代默认支持）

## 域名规划（bansonic.top）

| 子域 | 用途 | 部署位置 |
|---|---|---|
| `jiaojianbox.bansonic.top` | 服务端 API + 网页工作台（手机/浏览器访问这个） | Coolify |
| `git.bansonic.top` | 私有 Git（Gitea，已有） | 服务器 |
| `coolify.bansonic.top` | Coolify 面板（已有） | 服务器 |

桌面端与安卓端默认连接 `https://jiaojianbox.bansonic.top`，地址隐藏（手机浏览器也访问这个地址）。

## 超级管理员与注册方式

v0.5.0：桌面端和安卓端默认连接 `https://jiaojianbox.bansonic.top`，地址默认隐藏。「连接其他自建服务器」可以指定独立服务，浏览器授权只会访问所选服务。桌面和安卓均提供独立离线工作区；桌面使用 Go 本机核心，采集组件独立打包，无需安装解释器。离线模式不连接交件箱云端，用户自行启用的 LLM API 仍会访问对应模型服务。

「设置 → 数据与连接」支持复制到本机离线使用、登录云端上传本地数据，以及 ZIP 数据包导出/导入。安卓对应入口在「我的」。复制包括通知、待办、材料和回执，不删除来源；重复导入跳过已复制内容，已修改的两端数据不会自动双向合并。模型配置会复制，但 API Key 需要重新填写；账号、密码、会话与站点管理配置不会被迁移。旧服务不可达时，桌面端可仅复制本机缓存的任务和通知（不含未下载附件），待同步草稿也会保留。安卓迁移包上限为 256MB。

新用户通过邮箱注册，原有用户名账号继续兼容登录。用户可在设置修改昵称、绑定邮箱或修改密码；密码变更/找回会使既有会话失效。原有账号需要先绑定邮箱，才能通过邮箱找回密码。

「设置 → 服务器邮件设置」可配置发件邮箱、SMTP 主机、端口、SSL/TLS 或 STARTTLS、登录账号及授权码，并决定新注册是否需要验证邮箱。密码加密存储，读取接口只返回是否已配置，留空保存会保留原授权码。邮件链接服务地址必须指向自己的部署；可用 `JJB_PUBLIC_URL` 指定默认值。验证/绑定/重置链接 30 分钟有效、只可使用一次，默认提供 HTML 样式及纯文本邮件。未配置 SMTP 时不会发送邮件，可通过管理员的「发送样式测试邮件」完成真实邮件投递验收。

首次部署在运行时配置 `JJB_BOOTSTRAP_ADMIN_USERNAME` 和 `JJB_BOOTSTRAP_ADMIN_PASSWORD`，启动时创建指定账号并授予超级管理员角色。已有同名账号只授予角色，不会覆盖密码。首次确认管理员登录后应移除这两个初始化变量；角色保存在 `/data` 数据库中。

超级管理员登录网页后，在「设置 → 站点管理」选择关闭注册、公开注册或仅邀请码注册。保存立即生效，并持久化到数据卷；`JJB_ALLOW_REGISTRATION` 仅作为尚未保存站点配置时的默认值。建议首次运行设为 `false`，通过初始化变量创建管理员。

邀请码支持备注、有效天数、最大使用次数及停用；完整邀请码仅生成时显示，数据库仅保存哈希。注册和次数扣减在同一事务内，注册失败不会消耗次数。普通用户无法访问管理接口，超级管理员的站点权限不会授予读取其他用户聊天内容或模型密钥的权限。

## 版本发布流程

1. 改代码 → 更新 `package.json` 的 `version` 与 `android/app/build.gradle.kts` 的 `versionName`
2. 提交并打 tag：`git tag v0.4.0 && git push origin v0.4.0`（Gitea 同步：`git push gitea main --tags`）
3. GitHub Actions 自动构建 Windows 桌面包 + 安卓 APK 并发布到 GitHub Releases
4. 桌面端「设置 → 启动与更新 → 检查更新」/ 安卓端「提醒页 → 检查更新」会提示新版本
5. Coolify 里对应用点 Redeploy 即可更新服务端（数据在卷里不受影响）

## 0.6.0 升级与回滚

保留原 `/data` 持久卷和 UID 1000，先备份完整 SQLite、附件和实际加密密钥。新进程首次启动时会生成 `/data/backups/before-go/`，每次代码版本升级生成对应版本目录；包括一致性数据库、master.key、workspace.id 和按 SHA-256 验证的附件。备份未完成时不会继续启动。升级只添加兼容字段，账号、会话、角色、SMTP、邀请码和文件路径沿用原格式。

部署后必须核对健康状态、账号/待办/消息/附件计数，并测试已有账号登录。需要回滚时优先切回原镜像且继续挂载当前卷；自动化兼容验收已覆盖 Go 写入后旧 Python 版本读取。若要恢复历史数据，先停止写入，再整体恢复同一份备份中的数据库、附件和密钥；不要只恢复数据库或把加密密钥替换为新生成的文件。
