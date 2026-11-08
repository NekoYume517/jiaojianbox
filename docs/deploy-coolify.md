# Coolify 部署指南

服务端是标准 FastAPI 容器，Coolify 可直接部署。

## 部署步骤（coolify.bansonic.top）

1. **新建项目 → 资源 → Docker Compose**（或 Dockerfile）
2. **Git 来源**：`https://github.com/NekoYume517/jiaojianbox.git`（私有，需在 Coolify 配 GitHub token；或用 Gitea 镜像 `https://git.bansonic.top/zzy/jiaojianbox.git`）
3. **分支**：`main`
4. **构建**：仓库根目录的 `Dockerfile`（Python 3.11-slim + uvicorn，自带健康检查 `/health`）
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

桌面端与安卓端登录时填 `https://jiaojianbox.bansonic.top`（手机浏览器也访问这个地址）。

## 超级管理员与注册方式

首次部署在运行时配置 `JJB_BOOTSTRAP_ADMIN_USERNAME` 和 `JJB_BOOTSTRAP_ADMIN_PASSWORD`，启动时创建指定账号并授予超级管理员角色。已有同名账号只授予角色，不会覆盖密码。首次确认管理员登录后应移除这两个初始化变量；角色保存在 `/data` 数据库中。

超级管理员登录网页后，在「设置 → 站点管理」选择关闭注册、公开注册或仅邀请码注册。保存立即生效，并持久化到数据卷；`JJB_ALLOW_REGISTRATION` 仅作为尚未保存站点配置时的默认值。建议首次运行设为 `false`，通过初始化变量创建管理员。

邀请码支持备注、有效天数、最大使用次数及停用；完整邀请码仅生成时显示，数据库仅保存哈希。注册和次数扣减在同一事务内，注册失败不会消耗次数。普通用户无法访问管理接口，超级管理员的站点权限不会授予读取其他用户聊天内容或模型密钥的权限。

## 版本发布流程

1. 改代码 → 更新 `package.json` 的 `version` 与 `android/app/build.gradle.kts` 的 `versionName`
2. 提交并打 tag：`git tag v0.4.0 && git push origin v0.4.0`（Gitea 同步：`git push gitea main --tags`）
3. GitHub Actions 自动构建 Windows 桌面包 + 安卓 APK 并发布到 GitHub Releases
4. 桌面端「设置 → 启动与更新 → 检查更新」/ 安卓端「提醒页 → 检查更新」会提示新版本
5. Coolify 里对应用点 Redeploy 即可更新服务端（数据在卷里不受影响）
