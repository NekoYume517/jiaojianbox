# 第三方与来源

- Electron：MIT，见打包运行时的 LICENSE 文件；按 [官方安全建议](https://www.electronjs.org/docs/latest/tutorial/security) 启用 contextIsolation、sandbox，禁用 Node integration，通过受限 preload 连接本机功能。
- FastAPI、Uvicorn、httpx、websockets、cryptography 等：通过依赖安装，版权与许可证归各项目所有。
- `wechatauto-replica`：独立可选 Python 依赖，本项目调用数据库读取接口，未捆绑或修改用户原有源码。分发该底座前请保留其原始许可证。
- [thawline/dsh-wechat-bridge](https://github.com/thawline/dsh-wechat-bridge)，源自 Yuuyuko-uu/dsh-wechat-bridge，MIT：作为微信数据库接入架构参考，没有复制 DSH 插件或发送模块。
- 用户已有 `wxexport.py`：参考其群消息前缀、引用、卡片和分片标识处理；新采集器采用独立实现。没有打包聊天导出结果、全局媒体缓存或数据库密钥。
- SnowLuma 是独立运行的 QQ 接入框架。本项目使用其公开 OneBot 兼容接口，不捆绑 QQ 客户端或 SnowLuma 二进制。
- SnowCat QQ 连接器包含 SnowCatQQ 来源的 `napcat.mjs`、`winmm-v8.dll` 与独立启动适配文件，上游提交为 `5fe48676bcaf3bddea0b6f3e6ce302a8e51c6bc1`。其 NapCat Limited Redistribution License 要求保留完整许可、标明来源、禁止商业使用，并禁止公开分发修改版；许可证原文随 `runtime-vendor/snowcat/LICENSE` 和安装包 `runtime/snowcat/LICENSE` 一并提供。本项目按非商业用途分发未经修改的上游运行时，项目根目录 MIT License 不覆盖这些文件；任何商业使用、修改后公开分发或再发布都须由使用者自行取得上游授权。
- [Express](https://github.com/expressjs/express) 5.1.0：MIT。作为 SnowCat 的本地服务依赖随安装包提供，许可证归属 expressjs/express 及其依赖作者；精确版本和传递依赖锁定在 `runtime-vendor/snowcat/package-lock.json`。
- [ws](https://github.com/websockets/ws) 8.18.3：MIT。作为 SnowCat 的本地 WebSocket 依赖随安装包提供，版权归 websockets/ws 作者。
- [webot](https://github.com/cancelGuMu/webot) 1.2.2（MIT）：`collector/wcdb_client.py` 与 `collector/wcdb_reader.py` 基于其 WCDB 直读实现改写；`runtime-vendor/wcdb` 下的 `WCDB.dll`、`wcdb_api.dll`、`MSVCP140.dll`、`VCRUNTIME140*.dll` 来自该项目 `native/windows`。WCDB 上游为 Tencent/WCDB（BSD-3-Clause），`wcdb_api.dll` 是配套封装；分发前按上游仓库许可与微信版本核对。


0.2.0 私人构建包含 SnowLuma 2.1.1（原始运行时、native/client、Node；EULA.md 和 PRIVACY.md 位于 resources/runtime/snowluma）、CPython 3.13（LICENSE.txt 随包）、数据库专用 wechatauto-replica 1.2.9 衍生模块（Apache-2.0，LICENSE/NOTICE 随模块）以及 Python wheel 许可证元数据。读取模块保留原 db.py，替换包初始化和 logger，以移除 UI 自动化依赖。未包含用户配置或聊天数据。

Apache ECharts 6.1.0 / zrender：Apache-2.0。ECharts 本地脚本与 LICENSE、NOTICE 位于 web/vendor，离线可用。图片预处理使用 Pillow（许可随服务端依赖分发），只用于给支持图片的模型准备尺寸受限、无元数据的图像，上传原件不改变。

## Magpie theme reference

Palette, component motion and Windows native title bar handling adapted from yetone/magpie (internal/gui/assets/app.css, app.js, mainwindow.go, titletint_windows.go), revision b1e8eb15a668bbccfcd46977c75602ceaa4d66b3.

MIT License

Copyright (c) 2026 yetone

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Local Markdown and diagram rendering

The locally bundled renderer uses marked (MIT), marked-footnote (MIT), DOMPurify (Apache-2.0 OR MPL-2.0), highlight.js (BSD-3-Clause), KaTeX (MIT), and Mermaid (MIT). Exact versions are pinned in package-lock.json. License texts accompany the bundles in web/vendor. Rebuild with `node scripts/build-markdown.mjs`; clients never download these engines at runtime.
