# 交件箱 · 0.1.0

Electron 桌面端 + FastAPI 服务端 + 同源手机网页。QQ/微信通知汇入收件箱，使用用户自己的 LLM API 区分交件通知、普通聊天和其他信息，再确认任务、准备材料、核对文件、下载材料包并保存提交回执。

## 本地启动

需要 Python 3.11+、Node.js 22+。服务端和桌面端可以放在不同电脑。

```powershell
python -m pip install -r requirements.txt
npm ci
```

分别在两个终端启动：

```powershell
.\Start-Server.ps1
.\Start-Desktop.ps1
```

桌面登录页填写 `http://127.0.0.1:8765`，点击「创建账号」。用户名支持字母、数字、`_.@-`，密码至少 10 位。

手机在同一局域网时，运行 `./Start-Server.ps1 -Lan`，然后浏览器打开 `http://电脑局域网IP:8765`。浏览器和桌面使用同一账号。公网部署见下文。

Windows 打包目录在 `artifacts/JiaojianBox-win32-x64`，双击 `JiaojianBox.exe` 可运行；不需要 Node.js。消息采集仍需本机 Python 环境。macOS/Linux 可以从源码 `npm ci && npm start`，尚未做这些系统的实机验收。

## 配置自己的模型

进入「设置」，填写兼容 Chat Completions 的 API 地址、Key 和模型。地址可填写 `https://你的接口/v1` 或完整 `/chat/completions` 地址。支持本地免 Key 的兼容接口。

- Key 在服务端以 Fernet 加密保存，读取设置不会返回 Key；留空保留旧值，点击「清除 Key」才删除。
- 默认手动分析。在收件箱选择目标消息，设置同会话上下文条数（0–50），或勾选具体消息作为上下文。
- 开启自动分析后，新消息进入服务端持久队列。可设置包含/排除关键词和分类偏好；失败最多尝试 3 次，也可手动重试。
- 原始通知、分析理由、使用的上下文 ID 和任务草稿均保存。模型分类与日期推断需要用户确认，不自动生成正式任务。
- 只有选中的消息及上下文发送给该模型服务，数据库密钥不上传。当前模型调用为文字接口，图片/语音/视频内容尚未接入视觉识别或转写。
- 「保存并读取模型」验证鉴权及 `/models` 接口；真正的推理连通性通过「使用 LLM 分析」验证。部分兼容服务没有 `/models`，可直接手动填模型名使用。

## QQ · SnowLuma

1. 根据 [SnowLuma 官方说明](https://snowluma.github.io/en/docs/guide/introduction) 启动 QQ 与 SnowLuma。
2. 在「消息来源」填写 HTTP、WebSocket 地址和 Access Token。常用端口分别为 3000、3001，以你自己的配置为准。
3. 点击「读取 QQ 联系人和群」，勾选需要同步的会话，然后「保存并启动采集」。

使用 [OneBot v11 兼容的只读 API](https://snowluma.github.io/en/docs/api) 与正向 WebSocket。重连会按已记录锚点补读所选会话历史，每轮最多 2000 条/会话；上游历史不可用时显示状态提示。首次选择从当前时刻开始采集，不自动上传整段旧聊天。采集不到的消息取决于上游历史的可用范围。

本项目只接收和读取，不向 QQ/微信联系人发送消息。

## 微信 · 复用现有数据库读取底座

微信数据库采集当前仅支持 **Windows 微信 4.x**。需要在「Python 解释器」中选择装有 `wechatauto-replica` 的 Python。你现有的 editable 安装可以直接复用；更换解释器则需在那个环境安装。

```powershell
python -m pip install -e "你的 wechatauto-replica 源码目录"
```

在微信保持登录时，点击「读取微信最近会话」，选择联系人/群并启动。会话用真实 username/wxid 订阅，不依靠昵称匹配。读取后固定所选账号，避免账号切换后误同步。

数据库解析参考了 [thawline/dsh-wechat-bridge](https://github.com/thawline/dsh-wechat-bridge) 的读库流程和用户自己的 `wxexport.py`：处理分片 ID、群成员前缀、引用消息和文件卡片。直接依赖 `wechatauto.db.WeChatDB`，没有拷贝 UIA 发送或 DSH 代理功能。微信本地媒体文件没有复制到项目，也没有自动上传整个媒体缓存。

本地队列以服务端地址和登录用户区分，事件去重还包含平台、聊天账号、会话和消息 ID。微信水位与待上传消息在同一个本地 SQLite 事务中写入，服务端不可用时先留在本机，恢复后补传；上传成功清除队列正文，保留去重键。停止采集或关闭桌面后微信可在下次启动补读，前提是本地聊天数据仍存在。

## 交件任务和实时同步

- 任务支持截止时间、材料格式/数量、总大小限制、命名要求、文件名通配规则、提交入口、状态和来源消息。
- `filename_pattern` 是简单文件名通配符（如 `2026_张三.*`）；自然语言命名要求没有填写匹配规则时显示为人工核对，不冒充自动通过。
- 上传材料或提交回执，材料包包含交件材料与核对清单，回执单独保留。同名材料打包时自动编号，原文件内容不变。检查的是名称/格式/数量/大小，不证明文档内容正确。
- 任务修改使用版本号校验。旧设备不能静默覆盖新版本；离线任务修改保存在本机，重连后补传，冲突时保留本机草稿供人工处理。
- 服务端持久化事件，WebSocket 首帧鉴权，断线后按游标补读；列表同时有定期校准。浏览器关闭后不会继续接收提醒，此版本未实现系统推送。

## 部署服务端

```sh
docker compose up -d --build
```

默认映射 8765，持久数据卷为 `jiaojianbox-data`。给服务端配置 HTTPS 反向代理，并允许 `/api/sync` WebSocket。电脑端填写公网 HTTPS 地址，手机浏览器打开同一地址即可。

首次注册完成后，可以在 Compose 环境设置 `JJB_ALLOW_REGISTRATION=false` 关闭新注册。登录令牌有效期 30 天，退出会撤销当前令牌。

数据目录包含 SQLite、附件和 `master.key`。**备份/迁移要保留整个数据目录，尤其是 master.key**，否则已保存的 LLM Key 无法解密。可通过环境变量 `JJB_MASTER_KEY` 提供标准 Fernet 密钥；不要把密钥提交进源码。

环境变量：`JJB_DATA_DIR`（默认 `data`）、`JJB_ALLOW_REGISTRATION`（默认 `true`）、`JJB_MAX_UPLOAD_MB`（默认 50）、`JJB_MASTER_KEY`（可选）。使用单个 Uvicorn worker；自动分析队列当前按单进程服务部署。

## 验证和开发

```powershell
python -m pip install -r requirements-dev.txt
python -m pytest -q
npm run package:win
```

`scripts/verify-ui.cjs` 用隔离目录、合成通知和本地模型桩验证完整流程；不读取实际聊天。先安装 Playwright Chromium（`npx playwright install chromium`），或通过 `JJB_CHROMIUM` 指定已安装的测试浏览器。设置 `JJB_TEST_ELECTRON=1` 可执行实际 Electron 端联调。验证记录和截图见 `docs/verification/`。

当前未包含自动更新、安装器签名、OCR/语音转写和原生手机应用。服务端代码已提供容器配置，生产服务器部署需填写实际域名和运行环境；本项目不会读取其他项目的部署凭据。
