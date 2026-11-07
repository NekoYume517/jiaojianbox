# 同类项目调研：事务提醒 / 收纳 / 通知聚合助手（GitHub）

调研时间：2026-11-07，star 数经 GitHub API 核实（约数）。

| # | 项目 | Stars | 定位 |
|---|------|-------|------|
| 1 | [qq-live-digest](https://github.com/wc985732-lang/qq-live-digest) | ≈56 | NapCat/OneBot v11 接 QQ 群，AI 过滤闲聊、提取通知待办，WxPusher 推微信 + 手机 PWA 待办台 |
| 2 | [messageAIHelper](https://github.com/SWSP-Git/messageAIHelper) | ≈4 | Android 通知监听，AI 解析 QQ/微信通知写入系统日历 |
| 3 | [super-productivity](https://github.com/super-productivity/super-productivity) | ≈23.5k | todo + 时间盒 + 时间追踪，集成 Jira/GitHub/GitLab，Web/Desktop/Mobile 三端同构 |
| 4 | [devhub](https://github.com/devhubapp/devhub) | ≈10.1k（停更） | GitHub 通知的 TweetDeck 式多栏过滤面板（Electron + Web + RN） |
| 5 | [blinko](https://github.com/blinkospace/blinko) | ≈11.2k | 自托管 AI 闪念笔记，毫秒捕捉 + AI 语义检索 + 待办标签 |
| 6 | [paperless-ngx](https://github.com/paperless-ngx/paperless-ngx) | ≈47.8k | 文档管理：扫描/OCR/机器学习自动打标签归档 |
| 7 | [ai-triage](https://github.com/visheshgubrani/ai-triage) | ≈1（新） | 自托管 AI 邮件/文档收件箱：LLM 分类 + 字段抽取 + 证据引用 + 人工复核，带内置评测 |
| 8 | [remindee-bot](https://github.com/magnickolas/remindee-bot) | ≈51 | Rust Telegram 提醒 bot，cron / 重复规则 / 时区 |
| 9 | [ai-file-organizer](https://github.com/rdar-lab/ai-file-organizer) | ≈1 | LLM 按内容给文件重命名并归入目标文件夹（先 dry-run 预览再执行） |
| 10 | [Pixly](https://github.com/Sirius-ashwak/Pixly) | ≈0 | 截图按内容智能分目录（场景细分定位） |

## 与本项目重叠点和可借鉴设计

1. **qq-live-digest**：重叠最直接（QQ 采集 + AI 分类 + 任务生成）。借鉴：QQ 采集走 OneBot v11 兼容网关，成熟且避免协议逆向；「群摘要 + 待办提取」两层输出；手机 PWA 待办台验证了「服务端 Web 查看」是真实需求。
2. **messageAIHelper**：纯端侧、零后台的极简路线；证明通知文本里的时间信息足够 LLM 抽取截止时间。
3. **super-productivity**：任务从外部系统「导入」而非手填；提醒策略细（逾期高亮、每日回顾）；多端 99% 代码共享。
4. **devhub**：「列 = 过滤器」的心智模型（可映射为交件/聊天/其他三列）；过滤规则用户可编辑；未读水位与静音列。
5. **blinko**：单输入框「先落库、后归类」，把收纳摩擦降到零；AI 建议标签但保留人工确认。
6. **paperless-ngx**：consumption 目录「丢进去自动处理」；置信度门控——低置信才人工确认，高置信自动归档。这正是「AI 拖拽归类 + 确认」的成熟先例。
7. **ai-triage**：pipeline 工程结构最值得抄：①分类结果附原文「引用证据」降幻觉；②可配置检查项决定自动 vs 人工；③内置 eval 集防换模型/换提示词后质量回退。
8. **remindee-bot**：自然语言时间解析（「每周一」）落统一结构；提醒即对话、确认即静默。
9. **ai-file-organizer**：先 dry-run 给建议方案、预览后批量执行——拖入归档也应先预览后落盘。
10. **Pixly**：场景细分（只做截图）比大而全更容易讲清楚定位。

## 对交件箱的启示

1. **采集层**：QQ 走 OneBot v11 兼容网关（本项目已用 SnowLuma 托管网关实现同等思路，全程应用内页面）；App 启动即自动恢复采集（DevHub 长驻模式），不做手动开关门槛。
2. **LLM 分类 pipeline**：附原文摘句作证据 → 置信度门控决定自动/人工 → 建立小评测集，换模型后回归验证。
3. **归类交互**：AI 先建议，低置信标黄人工确认，高置信自动通过；先预览再落盘；任务生成默认抽好截止时间与材料清单。
4. **收纳零摩擦**：全局拖入即进收纳框，AI 归类异步后台跑，不挡入口。
5. **提醒策略**：自然语言时间解析、重复规则、逾期高亮、临期二提；手机推送可复用 WxPusher 推微信。
6. **服务端 Web**：响应式网页登录查看/管理即可（qq-live-digest 的 PWA 已验证需求），通知内容含隐私，登录态与会话过期要严谨。
