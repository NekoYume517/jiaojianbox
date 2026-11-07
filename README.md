# 交件箱 · 0.2.0 设计方向

Electron 桌面端 + FastAPI 服务端 + 手机网页。QQ/微信通知汇入收件箱，使用用户自己的 LLM API 区分交件通知、普通聊天和其他信息，再确认任务、准备材料、核对文件、下载材料包并保存提交回执。

## 主打：简便易用

1. 打开即用：App 启动时自动恢复上次的 QQ/微信采集（勾选过的聊天自动续读），无需每次手动启动；「消息来源」页有开关可暂停。
2. 零配置接入：
   - QQ 全程使用我们自己的应用内页面——自动检测本机已登录的 QQ 实例、点选实例、勾选聊天列表，不需要去 SnowLuma 的配置接口/WebUI 填 HTTP/WS/Token。连接由桌面端内部托管网关完成（snow-loader 只在子进程内适配运行时，不修改原安装，且禁用其 WebUI 与网络监听端口）。
   - 高级与调试折叠区保留：兼容外部 OneBot 连接参数、Python 解释器、采集关键词、读取动作调试台（get_login_info / get_group_list / get_friend_list / get_status / 群历史等只读动作）与运行日志检查。
3. 文件拖动即收纳：拖文件到窗口任意位置，右侧自动弹出收纳框；AI 根据文件名与正文内容，结合现有待办自动建议归属（material/receipt/reference/other），高置信度且匹配明确时自动归档，其余保留手动选择；随时可撤销、重命名、下载、删除。原文件不变。
4. 浏览器授权登录（桌面端）：登录页只需填服务端地址，点击「在浏览器中登录」→ 系统浏览器打开授权页 → 已登录用户确认授权码 → 桌面自动完成登录。走 OAuth Device Flow 语义（/api/auth/device/start|poll|request|approve），令牌只经加密存储。
5. 服务端即个人主页：任何浏览器打开服务端地址即可登录同一账号，查看消息、任务、收纳文件，也能管理（生成任务、上传材料、提交回执、AI 归类）；桌面不在时手机浏览器就是完整工作台。

## 本地启动

需要 Python 3.11+、Node.js 22+。

```powershell
python -m pip install -r requirements.txt
npm ci
.\Start-Server.ps1
.\Start-Desktop.ps1
```

桌面登录页填写 `http://127.0.0.1:8765`，点「在浏览器中登录」完成授权（首次可先在浏览器里注册账号）。手机在同一局域网时运行 `.\Start-Server.ps1 -Lan`，浏览器打开 `http://电脑局域网IP:8765`。

Windows 打包目录 `artifacts/JiaojianBox-win32-x64`，双击 `JiaojianBox.exe`；打包内置采集脚本，不需要 Node.js。macOS/Linux 可源码运行 `npm ci && npm start`（未做实机验收）。

## 配置自己的模型

「设置」→ LLM 连接：兼容 Chat Completions 的 API 地址、Key、模型。Key 服务端 Fernet 加密；自动分析可设包含/排除关键词与分类偏好；分析理由、上下文与任务草稿全部留痕，模型只产生候选，任务由用户确认。

## 消息来源细节

- QQ：OneBot v11 只读 API。默认「应用内免配置接入」由桌面托管；「外部 OneBot（兼容调试）」模式才暴露 HTTP/WS/Token 表单。重连按锚点补读所选会话，每轮上限 2000 条/会话；首次选择从当前时刻开始，不回灌整段旧聊天。
- 微信：Windows 微信 4.x 本地数据库读取（wechatauto-replica），「读取微信最近会话」勾选即可；高级区可指定账号目录/数据库目录/Python 解释器。
- 本项目只接收和读取，不向 QQ/微信联系人发送消息。

## 交件任务与同步

任务含截止时间、材料格式/数量、总大小、命名要求、文件名通配、提交入口、状态、来源消息；材料包+清单、回执独立保存；版本号乐观锁防多端覆盖；离线修改本地留存、重连补传、冲突保留本机草稿。WebSocket 首帧鉴权 + 游标补读 + 定期校准。

## 服务端部署

```sh
docker compose up -d --build
```

默认 8765，数据卷 `jiaojianbox-data`；生产请配 HTTPS 反代并允许 `/api/sync` WebSocket。注册可用 `JJB_ALLOW_REGISTRATION=false` 关闭。备份/迁移保留整个数据目录（尤其 `master.key`）。环境变量：`JJB_DATA_DIR`、`JJB_ALLOW_REGISTRATION`、`JJB_MAX_UPLOAD_MB`、`JJB_MASTER_KEY`。

## 验证

```powershell
python -m pip install -r requirements-dev.txt
python -m pytest -q          # 16 通过
npm run package:win          # 出 Windows 包
node scripts/verify-ui.cjs   # 浏览器授权登录、桌面↔手机同步、离线重放等 16 项 UI 流程
```

`docs/verification/` 存有最近一轮验证记录与截图（合成数据，不读真实聊天）。

## 同类项目调研

见 `docs/research-similar-projects.md`：qq-live-digest、paperless-ngx、ai-triage、blinko、devhub、super-productivity 等 10 个项目的重叠点与可借鉴设计（置信度门控、先预览后落盘、证据引用、零摩擦收纳、自然语言提醒等）。

## 已知边界

暂无自动更新、安装器签名、系统级推送、OCR/语音转写；手机原生 App（M3 风格）规划中。
