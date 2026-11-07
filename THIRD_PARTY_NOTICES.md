# 第三方与来源

- Electron：MIT，见打包运行时的 LICENSE 文件；按 [官方安全建议](https://www.electronjs.org/docs/latest/tutorial/security) 启用 contextIsolation、sandbox，禁用 Node integration，通过受限 preload 连接本机功能。
- FastAPI、Uvicorn、httpx、websockets、cryptography 等：通过依赖安装，版权与许可证归各项目所有。
- `wechatauto-replica`：独立可选 Python 依赖，本项目调用数据库读取接口，未捆绑或修改用户原有源码。分发该底座前请保留其原始许可证。
- [thawline/dsh-wechat-bridge](https://github.com/thawline/dsh-wechat-bridge)，源自 Yuuyuko-uu/dsh-wechat-bridge，MIT：作为微信数据库接入架构参考，没有复制 DSH 插件或发送模块。
- 用户已有 `wxexport.py`：参考其群消息前缀、引用、卡片和分片标识处理；新采集器采用独立实现。没有打包聊天导出结果、全局媒体缓存或数据库密钥。
- SnowLuma 是独立运行的 QQ 接入框架。本项目使用其公开 OneBot 兼容接口，不捆绑 QQ 客户端或 SnowLuma 二进制。
