# UI / 动效 / 体验调研：同类工具的可抄做法

调研时间：2026-11-07。对象：super-productivity、blinko、devhub、paperless-ngx、Linear、Todoist、Raycast、flomo、滴答清单、Gmail/GitHub 收件箱、Electron 拖拽惯例。方法论参照 Emil Kowalski 设计工程（动画频率决策、缓动曲线、<300ms、transform/opacity 优先）。

## 各工具细节与适用性

| 工具 | 它做了什么 | 为什么有效 | 对交件箱 |
|---|---|---|---|
| super-productivity | 任务行=复选框+标题+元数据徽章（截止/时长）；悬停展开行内操作（今天/明天/删除）；今日视图纵排；底部常驻 Add-task-bar；Ctrl+Space 全局唤起 | 徽章让截止/优先级一眼可见；悬停收起动作减少噪音 | 直接抄「截止徽章+悬停露操作」 |
| blinko | 顶部单输入框即捕捉；时间流按天分组；AI 后处理三模式（加为评论/自动打标签/两者），异步后台跑完通知，结果以可展开评论挂在卡片下 | AI 不阻塞记录主流程，结果可折叠可追溯 | 改造：LLM 分类做成消息卡可展开的 AI 徽章（分类+置信度），异步完成 toast |
| devhub | TweetDeck 式多列，列头过滤器、未读徽章、键盘导航、暗主题 | 待处理流按类型并行分诊 | 不做多列；抄「三分类+计数徽章」与列=容器心智（现有筛选器已接近） |
| paperless-ngx | 上传带 inbox 标签；缩略图卡片网格；AI 识别结果显示为置信度建议 chip，点击即套用；多选浮出批量操作栏 | AI 建议零输入采纳，人只做确认 | 直接抄：建议 chip 点击即用，低置信高亮提醒 |
| Linear | 乐观更新（先本地改、后台同步、失败回滚）；Cmd+K 面板+助记快捷键；密度靠符号；微动效 100ms（hover/复选）、150ms（过渡），cubic-bezier(0.16,1,0.3,1) | 快是可测量的核心特性；一切为了 <100ms 感知 | 直接抄：乐观更新+undo toast；动效参数统一 |
| Todoist | 完成=打勾动画+行划掉淡出上移；quick-add 自然语言识别（日期/优先级输入时高亮）；完成 toast 带撤销 | 微正反馈促完成欲（庆祝动画提升完成率） | 直接抄：任务完成打勾淡出 + 5 秒撤销 |
| Raycast | 窗口渲染完再显示（防白屏闪烁）；刻意不用 cursor:pointer、无 hover 高亮保原生感；toast 底部常驻 | 细节统一=「快」的感知 | 抄：内容就绪后再 display；列表行去 pointer 光标 |
| flomo / 滴答清单 | flomo 打开即写零弹窗、卡片流+标签热力图；滴答日历拖拽改期、稍后读暂存区 | 降低捕捉/改期摩擦 | 抄 flomo 即开即写；滴答日历拖拽改截止时间 |
| Gmail / GitHub 收件箱 | 归档/done/snooze 滑动手势；键盘 e=done；批量 bar 常驻；done 可恢复 | triage 动作 ≤1 次点击 | 抄：消息卡悬停/右滑「建任务/忽略」+键盘快捷键 |
| Electron 拖拽惯例 | dragover 全窗 overlay（虚线框+文案）+目标容器高亮呼吸、落点插入线 | 明确「能放这里」，消除松手犹豫 | 直接抄：拖文件入窗→抽屉边框高亮+计数 |

## 最终 Top 10（成本×收益排序，合并两轮调研）

1. 按钮/行按压 `scale(.97)` 160ms ease-out（Emil）
2. undo toast：操作即执行 + 5 秒撤销按钮，替代 confirm()（Linear/Todoist/Gmail）
3. AI 建议 chip 点击即套用 + 置信度三档颜色门槛（paperless-ngx）
4. 截止时间紧迫度梯度徽章：>7d 灰 / ≤3d 橙 / ≤1d 红 / 逾期红粗（super-productivity）
5. 消息卡悬停露出「建任务/忽略」+ 收件箱键盘 triage（Gmail/DevHub/Linear）
6. 拖文件入窗全窗目标态 overlay + 收纳抽屉高亮（Electron 惯例）
7. AI 分类异步后台 + 完成 toast，不挡主流程（blinko）
8. quick-add / 任务创建时自然语言解析日期并高亮（Todoist）
9. 动效统一：100ms hover、150–200ms 过渡、cubic-bezier(0.16,1,0.3,1) 或 (.23,1,.32,1)，只动 transform/opacity（Linear/Emil）
10. 防闪烁（渲染完再显示）+ 列表行去 pointer 光标（Raycast）

## 已核对的项目现状（app.css）

- dialog 160ms / shelf 190ms，曲线 cubic-bezier(.23,1,.32,1) ✓ 曲线正确
- `prefers-reduced-motion` 全局兜底 ✓
- 缺：按压 scale 反馈（现为 translateY(1px)）、toast 进出场、hover 过渡（message-row/task-card 瞬变）、列表 stagger、拖拽目标态、关闭动画对称性
- toast 为 pointer-events:none —— 要支持撤销需改为可点击
