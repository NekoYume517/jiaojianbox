# 交件箱 UI、控件与动效规范

规范版本：1.3 · 整理日期：2026-11-13 · 状态：供用户验收，作为后续界面开发基线与 CI 强制检查项。

如果是没有历史上下文的新会话，先读第 1–12 节，再提取第 13 节的内嵌交互样板，禁止仅凭风格描述重新猜测实现。

本文是交件箱界面的唯一规范入口，统一视觉、布局、控件、状态反馈、动效与验收要求。新建页面、修改旧页面、开发插件界面和安装程序，先读本文，再写代码。既有页面出现问题时按本文修正，不能把历史缺陷视为规范。

设计基准为仓库固定的 Magpie 参考版本 `b1e8eb15a668bbccfcd46977c75602ceaa4d66b3`，以及本项目已经确认的交互要求。参考代码与许可见 [第三方声明](../THIRD_PARTY_NOTICES.md)。不自动追随上游改版，不引入另一套设计体系。

## 1. 验收时先看这十条

1. 中性灰界面、克制的强调色、细边框、统一圆角；深浅色都清楚，不加装饰性毛玻璃或光晕。
2. 首次渲染直接可见；控件、数字和文案不能为了动画延迟出现。
3. 两个状态中相同的元素连续移动到新位置，优先保留原 DOM；重复渲染不能让高亮跳回起点。
4. 同一组 tab 只有一个选中背景。未选中项悬停只改变文字颜色，不额外画一块底色。
5. 切换二级页、筛选和后台刷新不把页面推回顶部，也不清空表单草稿。
6. 设置固定在桌面左下角、账号上方；只让主导航列表独立滚动。手机底部导航始终保留图标和文字。
7. 弹窗右上角关闭；标题、正文、操作区层次清楚。表单字段不和全部高级选项挤在一起。
8. 所有文件入口用统一自定义样式，提示上下左右居中，支持点击和拖入，不能露出原生文件输入条。
9. 上传、下载、AI 分析立即显示真实状态；已知进度显示真实字节、进度和速度，失败提供重试入口。
10. 窄屏、大字、两种密度、键盘、减少动态效果、快速连续点击均可用；动画中断后界面必须收敛到最后状态。

## 2. 适用范围与实现入口

| 界面 | 必须遵循的规则 |
|---|---|
| Windows 桌面主窗口、服务端网页 | 共用 `web/` 的视觉和动效实现；原生窗口标题栏与系统窗口按钮 |
| 浏览器授权、注册、邮件验证、分享与收集表单 | 共用配色、控件和状态规则；授权登录使用独立页面 |
| 桌面插件 | 复用宿主字体、变量、控件与动效；插件只在桌面运行 |
| 自定义安装与卸载程序 | 同配色、间距和动效节奏；按本文第 11 节处理安装流程 |
| 快捷收集小窗 | 同配色与控件语言，但保持固定尺寸、轻量，不加载主窗口动效运行时 |
| Android | 在线工作区复用现有前端网页；登录门及文件/日历连接器使用 Material 3 原生控件、触控与动效；不再另做整套原生在线工作区。旧离线界面迁移范围见 [套壳说明](android-web-shell.md) |

实现位置：

- `web/theme.js`：首次绘制前应用主题、用户外观偏好。
- `web/app.css`、`web/workspace.css`：基础样式、语义颜色、密度、布局与控件。
- `web/navigation.js`：主栏目二级目录的生成、展开/收起、子页切换、草稿与滚动位置。
- `web/controls.js`：统一选项控件，将保留表单协议的 select 转成分段按钮。
- `web/motion.css`、`web/motion.js`：唯一主窗口动效运行时。
- `web/file-picker.js`：文件选择状态；`web/shelf.js`：拖放路由。

新页面优先复用现有类与 API。不能为一个业务页面引入新组件库、字体或动画库。规范中的尺寸是基线，优先引用现有变量，不能逐页复制硬编码值。

## 3. 视觉语言

### 3.1 颜色和层级

配色名称显示“默认”，不向用户显示“Magpie 默认”等实现名称。支持浅色、深色、跟随系统，切换前后保存用户选择。首次绘制前确定颜色，不能先闪白再变深。

| 语义 | 现有变量 | 使用要求 |
|---|---|---|
| 窗口与页面背景 | `--canvas`、`--sidebar`、`--topbar` | 中性底色，侧栏与正文用细边界区分 |
| 分组和控件表面 | `--panel`、`--surface`、`--input` | 依靠轻微明度差区分，不层层叠卡片 |
| 正文层级 | `--ink`、`--text`、`--muted` | 标题与重要数值、正文、辅助信息三级 |
| 分隔线 | `--line`、`--soft-line` | 外边界与组内分隔两级，通常 1px |
| 主操作与强调 | `--green`、`--on-green`、`--soft` | 变量名是历史命名，不代表必须使用绿色 |
| 选中与分段背景 | `--selected`、`--segment`、`--thumb` | 只表达当前选择，不铺满无关区域 |
| 成功、提示、错误 | `--green-*`、`--orange-*`、`--red-*` 等 | 同时提供文字或图形，不能仅靠颜色 |

不要从 `app.css` 早期回退色值推断默认主题；最终颜色由加载顺序与主题变量决定。新控件引用语义变量，不写死浅色背景或白色文字。正文与辅助说明在各自背景上以 WCAG AA 对比度为验收目标。

### 3.2 字体、图标与圆角

- 正文使用平台系统字体；Windows 沿用 `Segoe UI Variable Text`、`Segoe UI`、`Microsoft YaHei UI`。不另行加载网络字体。
- 沿用现有 rem 字号：正文约 13px、说明约 12px、次要标签约 11px、页面标题约 24px，按根字号共同缩放。不要把整页字号缩小来塞进更多内容。
- 层级主要由字号、字重、间距建立；正文常规字重，标题约 600–650。长正文保证行距，文件名和长 URL 可换行。
- 金额、Token、速度、时间等可比较数字使用等宽数字；代码使用系统等宽字体。
- 线性 SVG 图标统一描边和尺寸，导航图标约 16px。不把 Emoji 当作应用操作图标；用户消息中的 Emoji 保留。
- 常规控件圆角 7–8px，分段内部约 6px，容器约 12px，徽章约 5px。胶囊仅用于状态或已有特定控件。
- 窗口沿用系统边框和窗口按钮。容器不用大投影；控件可保留现有微弱边缘阴影。禁止毛玻璃、光晕、粒子、视差和装饰性大渐变。

## 4. 尺寸、间距与响应式

### 4.1 密度令牌

默认信息密度为“紧凑”。密度调整整个界面的间距和控件尺寸；文字大小是独立设置。

| 变量 | 舒适 | 紧凑 |
|---|---:|---:|
| `--nav-height` | 40px | 32px |
| `--nav-gap` | 4px | 2px |
| `--control-height` | 38px | 32px |
| `--field-height` | 40px | 35px |
| `--panel-space` | 24px | 18px |
| `--list-space` / `--row-space` | 16px | 10px |
| `--layout-gap` | 22px | 16px |
| `--page-space` | 28px | 20px |
| `--topbar-height` | 60px | 52px |
| `--field-space` | 16px | 14px |
| `--section-space` | 24px | 20px |

这些值是最小基线。大字与触控场景允许内容自然撑高，不能固定高度裁字。侧栏舒适/紧凑模式必须看得出差别。

### 4.2 间距节奏

| 场景 | 基线 |
|---|---:|
| 标签到输入框、说明与所属控件 | 8px |
| 同组按钮、下载与整理等行操作 | `--action-gap`，默认 8px |
| 相邻操作组、检查更新与安装操作 | 至少 12px |
| 相邻表单字段 | `--field-space` |
| 设置分节 | `--section-space` |
| 卡片与主次栏之间 | `--layout-gap` |
| 面包屑相邻节点 | 桌面 12px / 手机 8px |

用父容器的 gap 建立间距，子字段不再叠加底边距。按钮和伪装成按钮的文件 label 共用最小高度、内边距与居中方式；“导出”“导入”必须顶底对齐。空说明隐藏后不能留下占位空行。

### 4.3 页面布局

- 桌面侧栏文字模式 212px、图标模式 52px，左上角按钮平滑切换。主内容与侧栏同步调整，不重叠、不出现底部横条。
- 桌面侧栏主导航可以独立滚动；设置区和账号区锚定底部。设置展开二级项后仍在账号上方，不能被主列表一起卷走。
- 顶栏保持面包屑和右侧操作稳定；页面内容、标题与顶栏使用一致的水平对齐线。
- 设置和二级导航文字靠左；设置内容不能因子页内容宽窄而左右居中跳动。
- 620px 及以下使用移动网页布局。底部导航保留图标和标签，桌面侧栏折叠偏好不能隐藏手机标签。触控主要操作与输入框至少 44px。
- 主次栏放不下时改纵向排列，操作组允许换行，标题不竖排。全页禁止横向溢出；表格或代码等确需横向滚动时仅在自身容器内滚动。
- 桌面主内容拥有自己的滚动区域；移动网页预留底部导航和安全区空间。弹窗正文自行滚动，标题与底部操作保持可见。

## 5. 导航、tab 与筛选

### 5.1 导航和面包屑

- 主导航使用一个 `.nav-highlight`；二级选择使用对应共享背景。只有选中项有底色，其他项悬停仅文字提亮。
- 侧栏键盘操作不额外出现整行外圈高亮；保持可见的当前项和键盘选中状态。其他按钮、链接和表单保留 `:focus-visible`。
- 二级导航沿用 16px 缩进、8px 内边距和 1px 竖线；不加重复的桌面页顶标签条。移动端二级项使用页面顶部统一分段栏。
- 面包屑每层文字与分隔符都是独立节点；只标记一个 `aria-current`。不能用空格拼接斜杠或对所有 span 统一加 margin。
- 长标签单行截断；窄屏先隐藏工作空间根节点及其分隔符，保留当前栏目和子页，不挤压右侧操作。

### 5.2 分段控件

统一使用 `.chart-mode` 与单个 `.segment-highlight`；表单 select 通过 `controls.js` 转换，原 select 仅保留值和事件协议。外圆角 8px、内边距 3px、项间距 1px，桌面项至少 30px，手机至少 44px。

| 情况 | 布局策略 |
|---|---|
| 短标签，如主题、状态、统计日期范围 | 按内容宽度排列，不占满无意义的整行宽度 |
| 提醒预设、归属待办、统计范围、表单工作台 | 允许整个选项换行；使用 `.segment-wrap` 或 `data-segment-wrap="wrap"` |
| 必须维持单行且选项较多的组 | 控件自身水平滚动，保留完整标签；不能撑宽页面 |

单个标签不逐字断行，统计范围标签不被压成竖排；“当前服务”“已更新”属于组外状态，不塞进分段背景。选中块支持跨行平滑移动和 resize 后立即对齐。

语义 tab 使用 `tablist/tab`、`aria-selected`、roving tabindex，支持方向键、Home、End。主题切换等按钮组使用适当的 `group/aria-pressed`。重复点击当前项不重播动画、不重新请求同一份内容。

## 6. 控件与内容组织

| 控件 | 视觉与行为 |
|---|---|
| 按钮 | 一个操作区域优先突出一个主动作；次要、危险动作分级；图标按钮有中文可访问名称 |
| 输入框 | 标签在上、说明在下；占位符不能代替标签；错误在对应字段附近显示，保留输入 |
| 开关/勾选 | 整行标签可点；提交中只禁用相关操作，成功后反映真实持久化状态；失败回滚并说明 |
| 面板与设置行 | 同类内容集中在一个分组，组内用细分隔线；不用每个字段一个卡片 |
| 弹窗 | 右上角 × 关闭，标题/正文/底部操作分区；底部动作对齐，关闭不是左下角普通文字 |
| 菜单 | 锚定触发按钮；边缘至少留 8px；滚动/resize 关闭；支持键盘循环、Esc 关闭和焦点归还 |
| 表格/文件列表 | 列名清楚、行操作对齐，长文件名可读；窄屏压缩低频列，操作不能贴在一起或被裁掉 |
| 空状态 | 一句说明、必要的一个主要入口；不堆多层空卡片，不为了撑满页面放大留白 |
| 状态徽章 | 中文状态配语义色；状态改变就地更新，不能只显示一个无解释的色点 |
| 提示与错误 | 临时操作结果统一放右下角；桌面距边 24px，手机距右边 16px 并避开底部导航和安全区；错误说明下一步，不能直接暴露 `undefined`、原始 HTML 或堆栈 |

“我的”页先展示个人资料卡片与“编辑资料”入口；昵称、邮箱、密码放入有分节的编辑弹窗，数据迁移单独分组。服务器邮件、注册方式、存储配额和默认 AI 服务放在“站点管理”，按职责分节，仅管理员可操作。

## 7. 文件、进度与 AI

### 7.1 文件入口与拖放

- 统一 `.drop-zone`、`.share-drop`、`.file-picker`、`.shelf-drop` 的外观语义。原生 `input[type=file]` 隐藏但仍可通过控件选择文件。
- 拖入框提示上下左右居中，文件名较长时换行，已选文件名和数量明确。控件有键盘入口和可访问名称，点击、键盘、拖放走同一份校验。
- 拖入待办、指定字段、名单、插件页时只执行该目标动作，不能被全局 AI 收纳抢走。只有空白收纳路径使用 AI 归类。
- 只在有效文件拖动期间显示目标反馈，离开、取消、成功或失败后清理。浏览器和桌面都要实测，不能只模拟其中一种。
- 快捷收集由拖动/快捷键/托盘呼出，可关闭或调整内容，位置记忆。收下文件后保持打开，失焦不关闭，宽度不随内容增长。
- Toast 固定右下角。右下角同时存在持久建议卡时，Toast 平滑叠到卡片上方并至少保留 12px 间距；卡片消失后回到底部。任务状态刚被手动修改时，禁止自动出现要求改回去的矛盾建议，只有用户主动核对或文件清单发生变化后才可重新提示。

### 7.2 上传与下载

发起即显示处理中；已知大小显示真实百分比、已传/总字节、速度，剩余时间可用时再显示。未知大小不伪造百分比，显示字节和速度。完成、失败、取消是不同状态；切页不丢失进度，不通过重建按钮更新进度。

更新弹窗上方显示安全渲染的 Markdown 更新说明，下方提供“取消 / 忽略此版本 / 立即下载”。开始下载后操作组淡出，进度和统计在原区域连续接替；完成后显示安装入口。下载完成不等于安装成功，系统启动安装器失败时必须可见并可重试。

### 7.3 AI 与统计

分析入队立即显示“分析中”，不能先显示“未分析”。AI 表单设计接收任务要求，通过流式工具操作增量更新字段、规则和预览；保留已出现的元素，不每个 token 重绘整个表单。用户可取消、查看失败并重试；真实调用记录进入对应统计类型。

统计 ECharts 使用 `animation:false`。默认/自定义来源跟随模型连接设置，统计不再另设来源选择。默认服务展示积分与签到，自定义展示 Token；概览维持四个用量指标，余额不硬塞成第五张卡片。指标、图表、最近调用属于同一来源。没有 usage 就明确未知，不用字符数冒充实际 Token。

## 8. 动效标准

### 8.1 原则和令牌

平滑贯穿状态转换：相同元素保留身份并移动到新位置，新旧内容衔接，不跳变。动效用于说明位置与状态，不能阻塞输入、提交、网络请求或错误显示。

```css
--motion-ease: cubic-bezier(.2, .8, .2, 1);
--motion-out: cubic-bezier(.23, 1, .32, 1);
--ease-drawer: cubic-bezier(.32, .72, 0, 1);
```

| 交互 | 标准节奏 |
|---|---|
| 悬停、选中、焦点颜色 | 160ms |
| 普通按钮 / 图标按钮按压 | 160ms，指针按压分别 `scale(.96)` / `scale(.9)` |
| 导航、菜单项、命令项按压 | 不缩放，使用既有文字/背景反馈 |
| 导航共享选中背景 | 420ms 周期、0.84 阻尼的现有弹簧 |
| 分段共享背景、共享元素 FLIP | 280ms |
| 主页面切换 | 140ms 退场、240ms 进场 |
| 二级内容切换 | 220ms，从 `opacity:.5`、`translateY(2px)` 进入 |
| 子导航展开 / 收起 | 300ms / 240ms，drawer 曲线 |
| 子导航条目进入 | 260ms，上移 6px，初始延迟 40ms、项间 20ms |
| 二级选中条 | 240ms，motion-out 曲线 |
| 菜单开 / 关 | 240ms / 150ms，按锚点方向移动 6px、从 `.94` 缩放 |
| 弹窗开 / 关 | 440ms 原有弹簧 / 220ms；遮罩退场 180ms |
| 抽屉 | 210ms，drawer 曲线 |
| 侧栏模式切换 | 280ms，侧栏与正文同步 |
| 主题颜色过渡 | 250ms，首次绘制不播放 |
| 增量行/结果进入 | 180–240ms，不能用于掩盖等待 |

原则上只动画 `transform`、`opacity`、`clip-path`、SVG `stroke-dashoffset`。短促颜色/边框反馈使用上述颜色过渡；现有微弱边缘阴影可随主题过渡。禁止 `transition:all`。

Android WebView 的顶层 `dialog` 使用与桌面相同的语义、间距和关闭行为，但开闭改为 240ms / 180ms 的淡入与 8px 位移，不使用来源裁剪。弹窗必须有可计算的正尺寸，标题和底部操作固定，正文独立滚动；不得用全屏固定尺寸或动画结束回调作为最终布局条件。部分 Android WebView 会把弹窗内的 `vh/dvh` 解析为零，因此移动壳通过 `visualViewport.height` 同步 `--jjb-viewport-height`，弹窗及正文不能再依赖纯视口单位计算可见高度。

仅以下布局例外允许尺寸变化：共享选中背景的宽高、侧栏模式的宽度与网格列、子导航折叠的高度和上下 margin。子导航条目 `flex:none`，不能被压扁。业务面板、表格、整个页面不动画宽高。

### 8.2 共享元素、重建与中断

```js
// change 同步修改布局；同一业务元素跨状态保持唯一、稳定的 key。
uiMotion.relayout(container, () => {
  // 修改已有节点的位置或状态，避免整块 innerHTML 重建。
});
uiMotion.syncSegments();
uiMotion.syncNavigation();

// 弹窗统一入口；不要在业务代码里直接 showModal()/close()。
uiMotion.openDialog(dialog);
await uiMotion.closeDialog(dialog);
```

- 共享元素使用 `data-motion-key`，禁止同时标记父子导致双重位移；只在用户状态切换时 FLIP，轮询不播放布局装饰动画。
- 每个分段组只有一个共享高亮，目标来自当前选中项矩形。不得给每个按钮各画一个背景做淡入淡出。
- 尽量保留分段容器和表单 DOM；确需重建时由现有运行时接续旧高亮位置，不从首项重新开始。
- 快速点击取最后状态，旧动画不能删除新 DOM、复原旧选项或抹掉草稿。正在运行的导航弹簧按现有防追赶规则直接对齐最新目标，不排队播放。
- 首次挂载、resize、页面重新可见、键盘和减少动态效果时直接对齐。最终位置误差小于 0.5px。
- 弹窗关闭中重开，取消旧关闭动画并保留草稿；关闭有 450ms 安全期限，不能无限等待动画事件。
- 菜单退出克隆不接受鼠标、焦点或拖放，结束后移除，不留覆盖页面的透明层。

二级目录生命周期必须复用 `web/navigation.js`，由它调用 `uiMotion.revealSubnavigation` / `hideSubnavigation`。进入带二级页面的主栏目时，目录按 300ms 展开、条目渐入；离开时 240ms 收起，并立即 `inert`。不能用 `hidden` 或 `display:none` 代替这两个过程。首次载入、键盘与减少动态效果遵循直接显示规则。样板必须运行同一导航模块，不能只演示选中块移动而省掉目录展开/收起。

### 8.3 滚动、首屏与降级

- 首屏不 stagger、不预先透明、不延迟业务数据。增量结果若分批进入，仅处理前 8 项、间隔 40ms；变化提示最多 2 秒。
- 只有主动切换主栏目才回到顶部；二级切换、同页点击、刷新和 DOM 同步保留阅读位置。不能在 MutationObserver 同步路径中滚动页面。
- 键盘切换与 `prefers-reduced-motion:reduce` 直接显示最终状态，保持焦点路径。减少动态效果改变时也立即停止在途动画。
- 同一交互只保留一组有效动画；持续动画只用于真实等待/文件拖动。未知总量传输可有一个循环指示，减少动态效果时静态显示。
- 快捷收集不加载 `motion.js`，不用进出场、弹簧或布局动画，只允许短促颜色反馈及焦点提示。

## 9. 可访问性与中文文案

Tab 可进入操作，焦点顺序与视觉顺序一致；弹窗打开后进入内容，关闭后回触发入口。Esc 走取消路径，不跳过必要状态清理。页面根节点不画整窗焦点边框；命令面板搜索区固定在结果列表上方，焦点边框不能裁成横线。

中文文案直接说明动作与结果，如“导入名单”“保存表单”“重试下载”。同一概念统一名称：通知、待办、待办材料、提交回执、收集任务、我的、站点管理。帮助说明写用户需要知道的影响；API 契约、堆栈和调试信息放调试入口。

错误状态保留用户输入；无权限、离线不可用、尚未配置、请求失败分别说明。没有数据用“暂无”，未知数值用“—”，不能展示 `NaN`、`undefined` 或误导性的 0。成功提示不抢焦点、不重复堆叠。

## 10. 页面组织模板

新业务页默认按“面包屑 → 页面标题与主要动作 → 筛选/分段 → 正文 → 必要辅助说明”组织；没有必要的区域直接省略。设置按职责分节，低频高级项用折叠或弹窗，不能把个人资料、数据迁移、SMTP 和服务配额堆在同一面板。

每个异步区域在编码前确定：未加载、读取中、空、正常、提交中、成功、失败、无权限/离线限制。每种状态都要有合理文案、动作和焦点行为。状态转移保留共同元素，先复用现有控件，再考虑增加新模式。

## 11. 系统通知与安装/卸载

- Windows 10+ 待办提醒使用系统原生通知，点击可打开对应待办；界面显示支持/可用状态及真实错误。测试成功表示已提交系统，不能保证用户关闭系统通知后仍弹出。
- 自定义安装器顶部四步进度为只读条，使用 280ms 共享高亮；底部上一步/下一步/完成，不把进度条伪装成可跳步按钮。
- 检测到已安装后展示当前版本、目标版本、目录与数据保留说明；点击“确认更新”才开始。下载、打开弹窗或动画结束不得自动覆盖安装。
- 安装/卸载进行中显示真实阶段和进度，不能卡在无说明的旋转鼠标。错误有原因与下一步。
- 安装完成页默认勾选“打开交件箱”，点击“完成”才启动；取消勾选只关闭安装器。卸载完成不提供启动应用选项。
- 卸载器沿用安装器的配色和节奏。覆盖升级、数据保留、旧进程退出属于正确性要求，不能靠视觉完成态掩盖失败。

## 12. 开发与验收约定

### 12.1 开发顺序

1. 明确页面层级、状态和主要动作，选用现有类与语义变量。
2. 先完成首屏、深浅色与响应式，再连接真实数据和反馈。
3. 给跨状态元素确定稳定身份，复用共享高亮、FLIP、弹窗和菜单 API。
4. 验证中断、失败、键盘、减少动态效果、草稿与滚动位置。
5. 根据改动运行对应验证并提供截图或可运行预览，失败项不能算验收通过。

### 12.2 验收矩阵

| 维度 | 至少检查 |
|---|---|
| 外观 | 浅色、深色、跟随系统首次渲染无闪烁 |
| 尺寸 | 360/390、620/621 边界、820、1280px；正常/大字、紧凑/舒适 |
| 结构 | 设置/账号固定底部；手机标签不被侧栏偏好隐藏；正文不横向溢出 |
| 连续操作 | 快速连点 tab、动画中反向切换、弹窗关到一半重开、resize 后高亮对齐 |
| 状态 | 加载、空、成功、失败、禁用、无权限和离线；错误后内容保留 |
| 滚动与草稿 | 二级页切换不回顶，表单不清空，同页刷新不移走阅读位置 |
| 文件与进度 | 浏览器/桌面点击及真实拖入；指定目标优先；真实速度/大小/取消/重试 |
| 可访问性 | 键盘、焦点归还、Esc、减少动态效果、标签语义、颜色以外的状态区分 |

验证入口按改动范围选用，不把导出型 `verify-motion.cjs` 的单独启动当成浏览器验收：

```powershell
# 浏览器主界面，组合执行动效、控件和体验验证
node scripts/verify-browser-experience.cjs
# 主窗口动效令牌、运行时、时长与禁用规则
node --test scripts/verify-motion-contract.cjs
# 桌面实际 WebView，按脚本要求先构建并指定验收程序
node scripts/verify-native.cjs
# 安装/卸载界面
node scripts/verify-setup-ui.cjs
```

插件、分享、收集表单等使用其专项验证脚本。新增可复用动效模式或布局例外时，同步修改本文、`scripts/verify-motion-contract.cjs` 与浏览器验收脚本，避免只留口头约定。静态契约禁止未登记的 `.animate()` 文件、`transition: all`、第三方动画库、错误时长和快捷窗加载主窗口动效运行时；CI 会在普通提交和发布构建中执行。纯文档修改检查链接和差异，不要求重新构建安装包。

任何新设计不能自行覆盖本文。变更规则时更新规范版本、说明原因和对应验收；用户本轮明确要求优先于规范，确认后再写回本文。


## 13. 单文件复现基线

### 13.1 “一样”的范围和标准

只给设计形容词不能还原界面。因此本规范同时包含规则与一份冻结的、可直接运行的 HTML/CSS/JS 样板。后续新会话只获得本 Markdown 文件时，也能提取本节源码运行，不需要原仓库、网络资源、业务服务器或聊天记录。

固定复现范围：桌面壳、侧栏与底部设置/账号、移动网页导航、页面标题、面包屑、我的/编辑资料弹窗、分段选择、密度/字号/颜色切换、文件入口、用量指标、共享布局和统一动效。样板含通知、待办、文件、统计、消息来源、设置等示例布局，使用虚构数据。

这不是全部业务页面或业务逻辑的规格。授权后端、实时同步、采集、完整表单设计器、安装流程的实际执行等仍须业务需求与接口契约；不能凭本规范声称已重建完整交件箱。新增业务页面应当使用样板中的同一套控件与令牌，而不是照抄示例中的假数据。

同一系统、同一字体、浏览器版本、缩放、主题与数据下，以样板为基准对齐：颜色、字体、边距、控件结构和状态；布局误差控制在 1 CSS px 内，共享高亮误差小于 0.5px。跨系统字体栅格化、原生窗口边框和系统对话框不要求逐像素相同。桌面样板是 Web 内容区域，不包含 Windows 原生标题栏的高度。

### 13.2 固定内容与允许调整的内容

| 必须固定 | 可随业务调整 |
|---|---|
| 语义色、字号层级、控件圆角、间距令牌 | 文案、数据、字段数量与业务校验 |
| 侧栏/底栏结构和断点、弹窗分区 | 内容主次栏数量，按宽度自然降级 |
| tab 共享高亮、焦点与键盘路径 | 选项内容，按规范选换行或组内滚动 |
| 时长、缓动、中断处理、减少动态效果 | 哪个状态需要动效；无状态变化不播放 |
| 表单/文件入口/进度控件样式 | 业务提交、导出、上传的接口适配 |

新实现不得把“参考一下”解释为重新设计。先把样板运行并与固定截图对照，再添加业务；原运行时已有实现优先直接复用。不能为了通过视觉验收而用改动后的产品 CSS 反向覆盖冻结样板。需要改规范时同时更新版本、样板、截图和校验摘要，并说明改变的规则。

### 13.3 样板和对照图

仓库内可以直接打开 [离线交互样板](ui-reference.html)。它不登录任何真实账号，也不访问外部网络。可以切换主题、密度、字号、侧栏模式和示例页面，操作 tab、弹窗和文件选择；示例操作不会调用业务 API。

| 图 | 固定环境 |
|---|---|
| [桌面深色](ui-reference-assets/desktop-dark.png) / [桌面浅色](ui-reference-assets/desktop-light.png) | Windows、1280×860 CSS px、DPR 1、100% 缩放、紧凑、标准字号、文字侧栏 |
| [编辑资料弹窗](ui-reference-assets/dialog-dark.png) | 同上，弹窗已完成进入动画 |
| [文件控件](ui-reference-assets/files-dark.png) | 同上，已选择虚构的实验报告文本文件 |
| [统计与分段](ui-reference-assets/statistics-dark.png) | 同上，最近 30 天选中，动画结束 |
| [移动网页](ui-reference-assets/mobile-dark.png) | 390×860 CSS px，其余同深色桌面样板 |

图仅用于方便人工对照；单文件复现不依赖这些图片。准确色值与完整实现都已嵌入下文，不需要打开图片才能知道设计参数。

### 13.4 默认配色的准确值

下列值来自样板运行后的最终 CSS 变量，优先于旧样式文件中被覆盖的回退值。密度/大小的完整运行值见下一小节。

| 变量 | 浅色 | 深色 |
|---|---|---|
| `--canvas` | `#f4f4f6` | `#1a1a1e` |
| `--panel` | `#fff` | `#232327` |
| `--sidebar` | `#f4f4f6` | `#1a1a1e` |
| `--topbar` | `#f4f4f6` | `#1a1a1e` |
| `--surface` | `#f9f9fb` | `#1f1f23` |
| `--input` | `#fff` | `#232327` |
| `--control` | `#f1f1f4` | `#2d2d33` |
| `--hover` | `#e9e9ee` | `#2d2d33` |
| `--selected` | `#fff` | `#232327` |
| `--selected-border` | `#e3e3e8` | `#3b3b42` |
| `--ink` | `#1c1c21` | `#ededf1` |
| `--text` | `#4b4b53` | `#b9b9c1` |
| `--muted` | `#707079` | `#a1a1aa` |
| `--line` | `#e3e3e8` | `#333339` |
| `--soft-line` | `#ececf0` | `#2c2c32` |
| `--green` | `#4f46e5` | `#a5b4fc` |
| `--green-hover` | `#4338ca` | `#c0caff` |
| `--on-green` | `#fff` | `#14142a` |
| `--focus` | `#4f46e5` | `#a5b4fc` |
| `--focus-soft` | `#4f46e51c` | `#a5b4fc22` |
| `--soft` | `#eeedfd` | `#2b2c47` |
| `--segment` | `#e6e6eb` | `#ffffff09` |
| `--thumb` | `#fff` | `#ffffff26` |
| `--green-bg` | `#e4f6ec` | `#1e3a2b` |
| `--green-text` | `#187748` | `#6fd99b` |
| `--orange-bg` | `#fbf0df` | `#3f3220` |
| `--orange-text` | `#92500a` | `#f2b544` |
| `--red-bg` | `#fbe9e9` | `#45272a` |
| `--red-text` | `#bd3333` | `#f28b82` |
| `--backdrop` | `#1c1c2144` | `#00000066` |
| `--control-edge` | `0 1px 2px #00000014,0 0 0 .5px #0000000d` | `inset 0 .5px 0 #ffffff14,0 1px 2px #0000004d` |

注意：`workspace.css` 在 `palettes.css` 之后加载，会覆盖其中部分控件变量。不要单独复制配色文件后声称视觉已一致；以下内联样板固定了真实加载顺序。基线默认紧凑、14px 根字号，正文约 13px；相同控件仍有最小高度/行高约束，不能只看一个变量便强行裁成固定高度。

### 13.5 最终运行令牌快照

此 JSON 为桌面 1280×860、文字侧栏、紧凑、标准字号时的最终变量。它提供颜色和布局的可核对数值，不替代组件 CSS。

```json
{
  "dark": {
    "--accent": "#a5b4fc",
    "--action-gap": "8px",
    "--backdrop": "#00000066",
    "--base-size": "14px",
    "--blue-bg": "#2b2c47",
    "--blue-text": "#b7b9fb",
    "--canvas": "#1a1a1e",
    "--chart-amber": "#fcd34d",
    "--chart-blue": "#7dd3fc",
    "--control": "#2d2d33",
    "--control-edge": "inset 0 .5px 0 #ffffff14,0 1px 2px #0000004d",
    "--control-height": "32px",
    "--control-hover": "#36363d",
    "--ease-drawer": "cubic-bezier(.32,.72,0,1)",
    "--ease-out": "cubic-bezier(.16,1,.3,1)",
    "--field-height": "35px",
    "--field-space": "14px",
    "--focus": "#a5b4fc",
    "--focus-soft": "#a5b4fc22",
    "--font-scale": "1",
    "--green": "#a5b4fc",
    "--green-bg": "#1e3a2b",
    "--green-hover": "#c0caff",
    "--green-text": "#6fd99b",
    "--hover": "#2d2d33",
    "--ink": "#ededf1",
    "--input": "#232327",
    "--layout-gap": "16px",
    "--line": "#333339",
    "--list-space": "10px",
    "--motion-ease": "cubic-bezier(.2,.8,.2,1)",
    "--motion-out": "cubic-bezier(.23,1,.32,1)",
    "--muted": "#a1a1aa",
    "--nav-gap": "2px",
    "--nav-height": "32px",
    "--on-green": "#14142a",
    "--orange-bg": "#3f3220",
    "--orange-text": "#f2b544",
    "--page-space": "20px",
    "--panel": "#232327",
    "--panel-space": "18px",
    "--purple-bg": "#302a40",
    "--purple-text": "#c4b5fd",
    "--red-bg": "#45272a",
    "--red-text": "#f28b82",
    "--row-space": "10px",
    "--section-space": "20px",
    "--segment": "#ffffff09",
    "--segment-gap": "1px",
    "--segment-height": "calc(35px - 8px)",
    "--segment-pad": "3px",
    "--segment-radius": "8px",
    "--selected": "#232327",
    "--selected-border": "#3b3b42",
    "--shadow": "0 16px 44px #14161e20",
    "--shadow-color": "#00000055",
    "--sidebar": "#1a1a1e",
    "--sidebar-width": "212px",
    "--soft": "#2b2c47",
    "--soft-line": "#2c2c32",
    "--surface": "#1f1f23",
    "--task-height": "80px",
    "--text": "#b9b9c1",
    "--thumb": "#ffffff26",
    "--titlebar": "0px",
    "--toast-accent": "#ededf1",
    "--toast-bg": "#2d2d33",
    "--topbar": "#1a1a1e",
    "--topbar-height": "52px"
  },
  "light": {
    "--accent": "#4f46e5",
    "--action-gap": "8px",
    "--backdrop": "#1c1c2144",
    "--base-size": "14px",
    "--blue-bg": "#eeedfd",
    "--blue-text": "#5046bd",
    "--canvas": "#f4f4f6",
    "--chart-amber": "#b45309",
    "--chart-blue": "#0ea5e9",
    "--control": "#f1f1f4",
    "--control-edge": "0 1px 2px #00000014,0 0 0 .5px #0000000d",
    "--control-height": "32px",
    "--control-hover": "#e9e9ee",
    "--ease-drawer": "cubic-bezier(.32,.72,0,1)",
    "--ease-out": "cubic-bezier(.16,1,.3,1)",
    "--field-height": "35px",
    "--field-space": "14px",
    "--focus": "#4f46e5",
    "--focus-soft": "#4f46e51c",
    "--font-scale": "1",
    "--green": "#4f46e5",
    "--green-bg": "#e4f6ec",
    "--green-hover": "#4338ca",
    "--green-text": "#187748",
    "--hover": "#e9e9ee",
    "--ink": "#1c1c21",
    "--input": "#fff",
    "--layout-gap": "16px",
    "--line": "#e3e3e8",
    "--list-space": "10px",
    "--motion-ease": "cubic-bezier(.2,.8,.2,1)",
    "--motion-out": "cubic-bezier(.23,1,.32,1)",
    "--muted": "#707079",
    "--nav-gap": "2px",
    "--nav-height": "32px",
    "--on-green": "#fff",
    "--orange-bg": "#fbf0df",
    "--orange-text": "#92500a",
    "--page-space": "20px",
    "--panel": "#fff",
    "--panel-space": "18px",
    "--purple-bg": "#eeedfd",
    "--purple-text": "#6558ad",
    "--red-bg": "#fbe9e9",
    "--red-text": "#bd3333",
    "--row-space": "10px",
    "--section-space": "20px",
    "--segment": "#e6e6eb",
    "--segment-gap": "1px",
    "--segment-height": "calc(35px - 8px)",
    "--segment-pad": "3px",
    "--segment-radius": "8px",
    "--selected": "#fff",
    "--selected-border": "#e3e3e8",
    "--shadow": "0 16px 44px #14161e20",
    "--shadow-color": "#14161e18",
    "--sidebar": "#f4f4f6",
    "--sidebar-width": "212px",
    "--soft": "#eeedfd",
    "--soft-line": "#ececf0",
    "--surface": "#f9f9fb",
    "--task-height": "80px",
    "--text": "#4b4b53",
    "--thumb": "#fff",
    "--titlebar": "0px",
    "--toast-accent": "#1c1c21",
    "--toast-bg": "#fff",
    "--topbar": "#f4f4f6",
    "--topbar-height": "52px"
  }
}
```

### 13.6 只获得本文时的运行方法

将本小节唯一的 `html` 四反引号代码块原样保存为 UTF-8 文件 `ui-reference.html`，用系统浏览器打开即可。所有 CSS、图标和动效源码已内联；不需要 npm install、框架、CDN、图片下载或业务服务器。请原样提取，不能只读前几行便凭印象重写。

也可把本文保存为 `ui-design-standard.md`，在同目录运行：

```python
from pathlib import Path
import hashlib
import re

text = Path("ui-design-standard.md").read_text(encoding="utf-8")
match = re.search(r"(?ms)^````html\n(.*?)^````$", text)
assert match, "未找到内嵌样板，不能只凭文字猜测样式"
html = match.group(1)
Path("ui-reference.html").write_bytes(html.encode("utf-8"))
print(hashlib.sha256(html.encode("utf-8")).hexdigest())
```

冻结文件的 SHA-256：`71b7616a2287d15c194c31927cd520faf52e7d0972b6821ec3a89607fc0e4509`。

验收顺序：打开样板 → 桌面深浅色 → tab 快速来回切换 → 关闭中重开弹窗 → 390px 下检查布局 → 舒适/紧凑与大字 → 键盘与减少动态效果 → 再开始制作业务页。

<details>
<summary>展开完整离线 HTML、CSS 与动效源码（单文件复现基线）</summary>

````html
<!doctype html>
<html lang="zh-CN" data-sidebar="labels"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>交件箱 · UI 规范样板</title><script>/* 在样式表前应用外观，避免深色模式启动时先闪过白色页面。 */
(() => {
  const key = 'jjb-appearance';
  const defaults = { theme: 'system', density: 'compact', textSize: 'normal', palette: 'magpie', designVersion: 2 };
  const normalize = input => ({
    theme: ['system', 'light', 'dark'].includes(input?.theme) ? input.theme : defaults.theme,
    density: ['comfortable', 'compact'].includes(input?.density) ? input.density : defaults.density,
    textSize: ['normal', 'large'].includes(input?.textSize) ? input.textSize : defaults.textSize,
    palette: input?.designVersion === 2 && ['magpie', 'tokyo-night', 'nord', 'graphite'].includes(input?.palette) ? input.palette : defaults.palette,
    designVersion: 2,
  });
  let settings;
  let writes=Promise.resolve(), pending=0;
  try { settings = normalize(JSON.parse(localStorage.getItem(key))); } catch { settings = { ...defaults }; }
  const query = matchMedia('(prefers-color-scheme: dark)');
  const shapes = {
    light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    dark: '<path d="M20.6 14A9 9 0 0 1 10 3.4 9 9 0 1 0 20.6 14Z"/>',
    system: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  };
  const labels = { light: '浅色', dark: '深色', system: '跟随系统' };
  const svg = mode => `<svg viewBox="0 0 24 24" aria-hidden="true">${shapes[mode]}</svg>`;
  let chromeFrame = 0, lastChrome = '';
  function tintChrome() {
    if (!window.desktop?.tintTitlebar || !document.getElementById('workspace')) return;
    cancelAnimationFrame(chromeFrame);
    chromeFrame = requestAnimationFrame(() => {
      const canvas = document.createElement('canvas'), context = canvas.getContext('2d', {willReadFrequently:true});
      // Sample the destination palette, not an intermediate crossfade frame.
      context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim();
      context.fillRect(0,0,1,1);
      const [r,g,b] = context.getImageData(0,0,1,1).data;
      const key = [r,g,b].join(','); if (key === lastChrome) return;
      lastChrome = key;
      window.desktop.tintTitlebar({r,g,b,dark:.2126*r+.7152*g+.0722*b<128}).catch(() => { if(lastChrome === key) lastChrome = ''; });
    });
  }
  let themeTimer;
  function paint() {
    const resolved = settings.theme === 'system' ? query.matches ? 'dark' : 'light' : settings.theme;
    const layoutChanged=document.documentElement.dataset.density!==settings.density||document.documentElement.dataset.textSize!==settings.textSize;
    const root=document.documentElement;
    if(root.dataset.theme&&(root.dataset.theme!==resolved||root.dataset.palette!==settings.palette)&&!matchMedia('(prefers-reduced-motion:reduce)').matches){
      clearTimeout(themeTimer);root.classList.add('theming');themeTimer=setTimeout(()=>root.classList.remove('theming'),250);
    }
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themeMode = settings.theme;
    document.documentElement.dataset.density = settings.density;
    document.documentElement.dataset.textSize = settings.textSize;
    document.documentElement.dataset.palette = settings.palette;
    document.querySelectorAll('[data-theme-picker]').forEach(container => {
      if (container.children.length) return;
      container.className = 'theme-picker'; container.setAttribute('role', 'group'); container.setAttribute('aria-label', '颜色模式');
      container.innerHTML = ['light', 'dark', 'system'].map(mode => `<button type="button" data-theme-mode="${mode}" aria-label="${labels[mode]}" title="${labels[mode]}">${svg(mode)}</button>`).join('');
    });
    document.querySelectorAll('[data-theme-mode]').forEach(button => {
      const active = button.dataset.themeMode === settings.theme;
      button.setAttribute('aria-pressed', String(active)); button.classList.toggle('active', active);
    });
    for (const [id, name] of [['appearance-density', 'density'], ['appearance-text-size', 'textSize'], ['appearance-palette', 'palette']]) {
      const input = document.getElementById(id); if (input) input.value = settings[name];
    }
    window.uiMotion?.syncSegments();
    if(layoutChanged)window.uiMotion?.syncNavigation(true);
    tintChrome();
    return resolved;
  }
  async function update(patch) {
    settings = normalize({ ...settings, ...patch });
    try { localStorage.setItem(key, JSON.stringify(settings)); } catch { /* 无法持久化时仍保留本次选择。 */ }
    paint();
    if (window.desktop?.setAppearance) {
      const value={...settings};pending++;
      try { writes=writes.catch(()=>{}).then(()=>window.desktop.setAppearance(value));await writes; }
      catch { window.dispatchEvent(new CustomEvent('appearance-error')); }
      finally { pending--;paint(); }
    }
    window.dispatchEvent(new CustomEvent('appearance-changed', { detail: { ...settings } }));
  }
  window.appearance = {
    get: () => ({ ...settings }),
    update,
    refresh: paint,
    icon: svg,
    restore: value => { if(pending)return;settings = normalize(value); try { localStorage.setItem(key, JSON.stringify(settings)); } catch {} paint(); },
  };
  paint();
  query.addEventListener('change', paint);
  window.addEventListener('storage', event => {
    if (event.key === key) { try { settings = normalize(JSON.parse(event.newValue)); paint(); } catch {} }
  });
  document.addEventListener('DOMContentLoaded', paint);
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-theme-mode]');
    if (button) update({ theme: button.dataset.themeMode });
  });
  document.addEventListener('change', event => {
    if (event.target.id === 'appearance-density') update({ density: event.target.value });
    if (event.target.id === 'appearance-text-size') update({ textSize: event.target.value });
    if (event.target.id === 'appearance-palette') update({ palette: event.target.value });
  });
})();
</script><style>/* Frozen source: web/app.css */
/* 共享桌面/浏览器视觉变量；颜色模式由 theme.js 在首次绘制前确定。 */
:root{color-scheme:light;--canvas:#f5f7f3;--panel:#fff;--sidebar:#eff3ed;--topbar:#fbfcf9;--surface:#f7f9f4;--input:#fff;--hover:#e9f0e5;--selected:#e5efdf;--selected-border:#c6d9bc;--ink:#26372d;--text:#455b4c;--muted:#697b6c;--line:#dfe7d9;--soft-line:#e9eee4;--green:#2b634a;--green-hover:#214f3a;--on-green:#fff;--soft:#edf5e8;--focus:#699874;--focus-soft:#69987422;--green-bg:#e8f3e7;--green-text:#346a3f;--orange-bg:#fcf1dc;--orange-text:#8b5c1c;--blue-bg:#eaf1fa;--blue-text:#456b98;--purple-bg:#f2ecfa;--purple-text:#765896;--red-bg:#faeae6;--red-text:#a24736;--toast-bg:#263d2c;--backdrop:#12231966;--shadow-color:#263c2420;--shadow:0 20px 65px var(--shadow-color);--titlebar:0px;--row-space:18px;--base-size:14px;font-family:Inter,"Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;font-size:var(--base-size)}
:root[data-theme=dark]{color-scheme:dark;--canvas:#101914;--panel:#19251e;--sidebar:#141f19;--topbar:#141f19;--surface:#1d2c22;--input:#121d17;--hover:#26382b;--selected:#263e2c;--selected-border:#49664c;--ink:#e2ebe3;--text:#c1d0c2;--muted:#a3b5a4;--line:#344737;--soft-line:#2a3b2d;--green:#a0d4ad;--green-hover:#bce6c5;--on-green:#162e1d;--soft:#223629;--focus:#a0d4ad;--focus-soft:#a0d4ad22;--green-bg:#294932;--green-text:#b0dab6;--orange-bg:#463820;--orange-text:#ebca8b;--blue-bg:#253c52;--blue-text:#b5d0ec;--purple-bg:#3a2d4b;--purple-text:#d3bce9;--red-bg:#4c302a;--red-text:#edb5a7;--toast-bg:#dce9df;--backdrop:#030b0780;--shadow-color:#00000066}
:root[data-density=compact]{--row-space:11px}
:root[data-text-size=large]{--base-size:16px}

/* 动效令牌：统一缓动与时值（参照 Linear：hover 100ms / 过渡 160-240ms，强 ease-out） */
:root{--ease-out:cubic-bezier(.16,1,.3,1);--ease-drawer:cubic-bezier(.32,.72,0,1);--toast-accent:#a9e6b8}
:root[data-theme=dark]{--toast-accent:var(--green)}

*{box-sizing:border-box}
html{scrollbar-gutter:stable}
html,body{overflow-x:clip}
/* Keep page-sized focus outlines off the viewport edges; controls retain their keyboard focus rings. */
html:focus-visible,body:focus-visible,.workspace:focus-visible,.main:focus-visible,.view:focus-visible{outline:none}
body{margin:0;min-width:0;background:var(--canvas);color:var(--ink)}
[hidden]{display:none!important}
button,input,select,textarea{font:inherit}
button,a,input,textarea,select{-webkit-tap-highlight-color:transparent}
button{cursor:pointer}
button:disabled{opacity:.5;cursor:wait}
button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid var(--focus);outline-offset:3px}
button{border:0;background:none;color:inherit;transition:background 140ms,color 140ms,transform 160ms var(--ease-out)}
button:active:not(:disabled){transform:scale(.97)}
button svg,[data-icon] svg{width:19px;height:19px;stroke:currentColor;stroke-width:1.6;fill:none;stroke-linecap:round;stroke-linejoin:round;display:block}
a{color:var(--green);text-decoration:none}
h1,h2,h3,p{margin-top:0}
h1{font-size:2.0rem;font-weight:650;letter-spacing:-.8px;margin-bottom:9px}
h2{font-size:1.571rem;font-weight:620;letter-spacing:-.5px;margin-bottom:10px}
h3{font-size:1.0rem;font-weight:650;margin-bottom:14px}
p{line-height:1.7}
.muted,.helper{color:var(--muted)}
.helper{font-size:0.857rem;line-height:1.7}
.error{color:var(--red-text);font-size:0.929rem;white-space:pre-wrap}
.eyebrow{font-size:0.82rem;letter-spacing:1.8px;font-weight:650;color:var(--muted);margin-bottom:14px}
.primary,.secondary,.danger{display:inline-flex;align-items:center;justify-content:center;gap:7px;border-radius:7px;min-height:38px;padding:9px 15px;font-weight:550;white-space:nowrap}
.primary{background:var(--green);color:var(--on-green)}
.primary:hover{background:var(--green-hover)}
.secondary{border:1px solid var(--line);background:var(--panel)}
.secondary:hover{background:var(--surface)}
.danger{color:var(--red-text);background:var(--red-bg)}
.link{color:var(--green);font-size:0.929rem;padding:7px 0}
.link:hover{text-decoration:underline}
.full{width:100%}
.icon-button{width:33px;height:33px;display:inline-flex;align-items:center;justify-content:center;border-radius:7px;color:var(--muted);font-size:1.714rem}
.icon-button:hover{background:var(--hover);color:var(--ink)}
.tag{font-size:0.82rem;line-height:1.3;border-radius:4px;padding:4px 6px;display:inline-flex;gap:4px;align-items:center;background:var(--surface);color:var(--muted)}
.tag.green{background:var(--green-bg);color:var(--green-text)}
.tag.orange{background:var(--orange-bg);color:var(--orange-text)}
.tag.blue{background:var(--blue-bg);color:var(--blue-text)}
.tag.purple{background:var(--purple-bg);color:var(--purple-text)}
.tag.red{background:var(--red-bg);color:var(--red-text)}
.pill-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.nowrap{white-space:nowrap}
.prewrap{white-space:pre-wrap;overflow-wrap:anywhere}
.empty{padding:55px 22px;text-align:center;color:var(--muted);line-height:1.8}
.empty>svg{width:48px;height:48px;stroke:var(--selected-border);fill:none;stroke-width:1.2;margin-bottom:15px}
.empty strong{display:block;color:var(--ink);font-size:1.071rem;margin-bottom:8px}
.empty .primary{margin-top:14px}
.workspace{display:grid;grid-template-columns:216px minmax(0,1fr);min-height:100vh;max-width:100vw;min-width:0;overflow:clip}
.sidebar{position:fixed;inset:0 auto 0 0;width:216px;border-right:1px solid var(--line);background:var(--sidebar);display:flex;flex-direction:column;padding:28px 16px 0}
.brand{display:flex;gap:11px;align-items:center;color:var(--ink);font-size:1.429rem;font-weight:650;margin:0 10px 46px}
.brand small{display:block;font-size:0.82rem;font-weight:400;color:var(--muted);letter-spacing:.5px;margin-top:3px}
.nav-label{font-size:0.82rem;letter-spacing:1.4px;color:var(--muted);margin:0 13px 12px}
nav{display:grid;gap:5px}
nav button{display:flex;gap:11px;align-items:center;text-align:left;padding:12px 13px;border-radius:7px;color:var(--muted);font-size:0.929rem}
nav button:hover{background:var(--hover)}
nav button.active{background:var(--selected);color:var(--green);font-weight:600}
nav .count{margin-left:auto;font-size:0.82rem;font-variant-numeric:tabular-nums;min-width:18px;text-align:center;background:var(--panel);border-radius:4px}
.account{border-top:1px solid var(--line);display:flex;gap:9px;align-items:center;padding:19px 2px}
.avatar{width:31px;height:31px;border-radius:50%;background:var(--selected);color:var(--green);display:grid;place-items:center;font-size:0.857rem;font-weight:600}
.account>span:nth-child(2){min-width:0;flex:1}
.account strong{display:block;font-size:0.857rem;overflow:hidden;text-overflow:ellipsis}
.account small{display:block;font-size:0.82rem;color:var(--muted);max-width:115px;overflow:hidden;text-overflow:ellipsis;margin-top:4px}
.account .icon-button{width:27px}
.main{grid-column:2;min-width:0}
.topbar{height:65px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;padding:0 34px;background:var(--topbar)}
.breadcrumb{font-size:0.82rem;color:var(--muted)}
.breadcrumb span{margin:0 12px;color:var(--muted)}
.breadcrumb strong{font-weight:500;color:var(--text)}
.topbar-right{display:flex;align-items:center;gap:13px}
.sync-state{font-size:0.82rem;color:var(--muted);display:flex;align-items:center;gap:6px}
.sync-state i{width:5px;height:5px;border-radius:50%;background:var(--green)}
.sync-state.offline{color:var(--orange-text)}
.sync-state.offline i{background:var(--orange-text)}
.view{padding:34px;max-width:1800px;min-width:0;margin:0 auto}
.page-heading{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;margin-bottom:26px}
.page-heading p{font-size:0.857rem;color:var(--muted);margin:0}
.page-heading .actions{display:flex;gap:8px}
.toolbar{display:flex;gap:10px;align-items:center;margin-bottom:18px;flex-wrap:wrap}
.search{position:relative;flex:1;min-width:180px;max-width:360px}
.search>input.search-field,.search input{padding-left:38px!important;background:var(--panel);line-height:1.5}
.search>span{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--muted);display:flex;align-items:center}
.search svg{width:16px;height:16px}
.toolbar select{width:auto;min-width:132px;padding-right:34px}
.toolbar .result-count{margin-left:auto;color:var(--muted);font-size:0.82rem}
.inbox-grid{display:grid;grid-template-columns:minmax(290px,.85fr) minmax(370px,1.15fr);gap:22px;align-items:start}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.panel-head{padding:17px 19px;border-bottom:1px solid var(--soft-line);display:flex;justify-content:space-between;align-items:center}
.panel-head h3{margin:0;font-size:0.857rem}
.panel-head small{font-size:0.82rem;color:var(--muted)}
.message-list{max-height:calc(100vh - 289px);min-height:410px;overflow:auto;padding:5px}
.message-row{display:flex;gap:10px;padding:16px 13px;border-radius:7px;border:1px solid transparent;margin:2px 0;position:relative;transition:background 120ms var(--ease-out),border-color 120ms var(--ease-out)}
.message-row:hover{background:var(--surface)}
.message-row:hover .row-actions{opacity:1;pointer-events:auto}
.message-row.selected{background:var(--selected);border-color:var(--selected-border)}
.message-row.flash{animation:row-flash 2s var(--ease-out)}
.message-row.entering{animation:row-enter 240ms var(--ease-out)}
@keyframes row-flash{0%,45%{background:var(--selected)}100%{background:transparent}}
@keyframes row-enter{from{opacity:0;transform:translateY(-7px)}to{opacity:1;transform:none}}
.row-actions{position:absolute;right:9px;top:9px;z-index:2;display:flex;gap:5px;opacity:0;pointer-events:none;transition:opacity 100ms var(--ease-out);background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:3px;box-shadow:0 2px 9px var(--shadow-color)}
.row-actions button{font-size:.74rem;padding:4px 9px;border-radius:5px;color:var(--text);min-height:26px}
.row-actions button:hover{background:var(--hover);color:var(--green)}
.row-actions button.danger-hover:hover{color:var(--red-text)}
.message-row .select-context{align-self:flex-start;margin-top:4px;accent-color:var(--green);width:14px;height:14px;flex-shrink:0}
.message-body{flex:1;min-width:0}
.message-meta{display:flex;align-items:center;gap:7px;margin-bottom:9px}
.message-meta strong{font-size:0.857rem;font-weight:600;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.message-meta time{font-size:0.82rem;color:var(--muted);margin-left:auto;white-space:nowrap}
.message-excerpt{font-size:0.857rem;line-height:1.8;color:var(--text);margin-bottom:12px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.message-bottom{display:flex;gap:6px;align-items:center}
.message-bottom .sender{margin-left:auto;font-size:0.82rem;color:var(--muted)}
.detail{position:sticky;top:20px}
.detail-content{padding:22px}
.detail-meta{display:flex;justify-content:space-between;gap:10px;margin-bottom:16px}
.detail-title{font-size:1.143rem;line-height:1.6;font-weight:600;margin-bottom:7px}
.detail-byline{font-size:0.82rem;color:var(--muted);margin-bottom:20px}
.message-original{font-size:0.929rem;line-height:1.9;white-space:pre-wrap;overflow-wrap:anywhere;max-height:270px;overflow:auto;padding:17px;background:var(--surface);border:1px solid var(--soft-line);border-radius:7px;margin-bottom:20px}
.analysis-box{background:var(--soft);border:1px solid var(--selected-border);border-radius:8px;padding:17px;margin-bottom:18px}
.analysis-top{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:12px}
.analysis-top h3{margin:0;color:var(--green);font-size:0.857rem}
.analysis-top small{font-size:0.82rem;color:var(--muted)}
.analysis-box p{font-size:0.857rem;color:var(--text);margin-bottom:12px}
.analysis-reason{border-top:1px solid var(--selected-border);padding-top:11px;font-size:0.82rem;color:var(--muted);line-height:1.7}
.detail-actions{display:flex;gap:8px;flex-wrap:wrap}
.context-options{display:flex;align-items:center;gap:8px;font-size:0.82rem;color:var(--muted);margin-bottom:12px}
.context-options input[type=number]{width:61px;padding:5px 7px;min-height:29px}
.context-list{border-top:1px solid var(--soft-line);margin-top:23px;padding-top:16px}
.context-list summary{font-size:0.82rem;color:var(--muted);cursor:pointer}
.context-message{padding:13px 0;border-bottom:1px solid var(--soft-line)}
.context-message small{color:var(--muted);font-size:0.82rem}
.context-message p{font-size:0.857rem;color:var(--muted);margin:6px 0 0;white-space:pre-wrap}
.notice{padding:11px 34px;color:var(--orange-text);background:var(--orange-bg);font-size:0.857rem}
.task-summary{display:flex;gap:22px;margin-bottom:25px;align-items:stretch;justify-content:space-between}
.summary-cell{border-right:1px solid var(--line);padding-right:24px;min-width:108px;flex:1;display:flex;align-items:center;gap:14px}
.summary-cell:last-child{border:0}
.summary-cell strong{font-size:2rem;font-weight:550;font-variant-numeric:tabular-nums;color:var(--green);line-height:1.1;margin:0}
.summary-cell span{font-size:0.86rem;color:var(--muted);line-height:1.4}
.task-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:17px}
.task-card{background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:21px;cursor:default;transition:border-color 140ms var(--ease-out),box-shadow 140ms var(--ease-out),transform 140ms var(--ease-out)}
.task-card:hover{border-color:var(--selected-border);box-shadow:0 4px 15px var(--shadow-color);transform:translateY(-2px)}
.task-card.card-overdue{border-color:var(--red-text)}
.task-card h3{font-size:1.071rem;line-height:1.6;margin:17px 0 10px}
.task-card p{color:var(--muted);font-size:0.82rem;line-height:1.8;white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:39px}
.task-card-footer{display:flex;justify-content:space-between;border-top:1px solid var(--soft-line);margin-top:17px;padding-top:14px;font-size:0.82rem;color:var(--muted);gap:8px;flex-wrap:wrap;align-items:center}
.task-card-footer .overdue{color:var(--red-text);font-weight:600}
.due-chip{display:inline-flex;align-items:center;gap:5px;border-radius:5px;padding:3px 7px;font-variant-numeric:tabular-nums}
.due-chip.far{background:var(--surface);color:var(--muted)}
.due-chip.soon{background:var(--orange-bg);color:var(--orange-text)}
.due-chip.today{background:var(--red-bg);color:var(--red-text)}
.due-chip.overdue{background:var(--red-text);color:#fff}
:root[data-theme=dark] .due-chip.overdue{background:#7c3a2c;color:#fff}
.task-detail-grid{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:22px}
.task-main-content{padding:25px}
.task-description{font-size:0.929rem;line-height:1.9;color:var(--text);margin:20px 0;white-space:pre-wrap}
.section-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:23px 0 12px}
.section-heading h3{margin:0;font-size:0.929rem}
.file-row{display:flex;gap:12px;align-items:center;border:1px solid var(--line);border-radius:7px;padding:12px;margin-bottom:8px}
.file-icon{width:33px;height:37px;display:grid;place-items:center;background:var(--soft);border-radius:4px;font-size:0.82rem;text-transform:uppercase;font-weight:600}
.file-icon[data-ext=pdf]{background:#fae6e3;color:#b0432f}
.file-icon[data-ext=zip],.file-icon[data-ext=7z],.file-icon[data-ext=rar],.file-icon[data-ext=tar],.file-icon[data-ext=gz]{background:#fdf1d8;color:#946a15}
.file-icon[data-ext=doc],.file-icon[data-ext=docx],.file-icon[data-ext=rtf]{background:#e7eefb;color:#44659c}
.file-icon[data-ext=xls],.file-icon[data-ext=xlsx],.file-icon[data-ext=csv]{background:#e5f2e2;color:#3c7340}
.file-icon[data-ext=ppt],.file-icon[data-ext=pptx]{background:#fdeee2;color:#b05f2a}
.file-icon[data-ext=png],.file-icon[data-ext=jpg],.file-icon[data-ext=jpeg],.file-icon[data-ext=gif],.file-icon[data-ext=webp]{background:#efe9fa;color:#765896}
.file-icon[data-ext=mp4],.file-icon[data-ext=mkv],.file-icon[data-ext=avi],.file-icon[data-ext=mov]{background:#e2f1f4;color:#3f7484}
.file-info{min-width:0;flex:1}
.file-info strong{font-size:0.857rem;display:block;overflow-wrap:anywhere;font-weight:500}
.file-info small{font-size:0.82rem;color:var(--muted);display:block;margin-top:4px}
.drop-zone{border:1px dashed var(--selected-border);border-radius:7px;padding:25px;text-align:center;background:var(--surface);color:var(--muted);font-size:0.857rem;position:relative}
.drop-zone input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%}
.task-side{padding:22px}
.info-label{font-size:0.82rem;color:var(--muted);margin-bottom:7px;line-height:1.5}
.info-value{font-size:0.857rem;color:var(--text);line-height:1.7;margin-bottom:23px;overflow-wrap:anywhere}
.check-row{padding:11px 0;border-bottom:1px solid var(--soft-line);display:flex;gap:9px;font-size:0.857rem;align-items:baseline}
.check-symbol{color:var(--green);width:14px;text-align:center;flex-shrink:0;line-height:inherit}
.check-row strong{font-weight:500}
.check-row small{display:block;font-size:0.82rem;color:var(--muted);margin-top:5px}
.check-symbol{color:var(--green)}
.check-symbol.fail{color:var(--red-text)}
.check-symbol.manual{color:var(--orange-text)}
.settings-grid{display:grid;grid-template-columns:minmax(0,740px) minmax(200px,280px);gap:25px;align-items:start}
.settings-panel{padding:27px}
.settings-panel h3{font-size:1.0rem;margin-bottom:7px}
.settings-panel .helper{margin-bottom:24px}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.form-grid.three{grid-template-columns:1fr 1fr 1fr}
label{display:block;font-size:0.857rem;color:var(--text);margin-bottom:19px}
input:not([type=checkbox]),select,textarea{display:block;min-height:38px;width:100%;border:1px solid var(--line);border-radius:6px;background:var(--panel);padding:9px 34px 9px 11px;color:var(--text);margin-top:8px;outline-offset:2px}
input::placeholder,textarea::placeholder{color:var(--muted);font-size:0.857rem}
input:focus,textarea:focus,select:focus{border-color:var(--focus);outline:none;box-shadow:0 0 0 3px var(--focus-soft)}
textarea{resize:vertical;line-height:1.7}
.toolbar input,.toolbar select{margin-top:0}
.switch-line{display:flex;align-items:flex-start;gap:10px;padding:16px 0;border-top:1px solid var(--soft-line);margin-bottom:12px}
.switch-line input{accent-color:var(--green);margin-top:4px}
.switch-line strong{font-size:0.857rem;font-weight:500}
.switch-line small{display:block;font-size:0.82rem;color:var(--muted);margin-top:6px;line-height:1.6}
.settings-side{font-size:0.857rem;color:var(--muted);line-height:1.9;padding:13px 0}
.settings-side h3{color:var(--green);font-size:0.857rem}
.settings-side ol{padding-left:18px}
.settings-side li{margin-bottom:15px}
.settings-side .divider{height:1px;background:var(--line);margin:24px 0}
.models-output{padding:12px;background:var(--soft);border-radius:6px;font-size:0.857rem;color:var(--text);margin-top:15px;white-space:pre-wrap;overflow-wrap:anywhere}
.source-grid{display:grid;grid-template-columns:1fr 1fr;gap:22px}
.source-card{padding:23px}
.source-title{display:flex;align-items:center;gap:12px;margin-bottom:21px}
.source-mark{display:grid;place-items:center;width:39px;height:39px;background:var(--green-bg);color:var(--green);font-size:0.929rem;border-radius:10px;font-weight:600}
.source-mark.qq{background:var(--blue-bg);color:var(--blue-text)}
.source-title h3{margin:0 0 4px}
.source-title small{color:var(--muted);font-size:0.82rem}
.conversation-list{max-height:250px;overflow:auto;border:1px solid var(--line);border-radius:6px;margin-top:16px}
.conversation-row{display:flex;align-items:center;gap:10px;padding:10px 12px;margin:0;border-bottom:1px solid var(--soft-line);cursor:pointer}
.conversation-row input{accent-color:var(--green)}
.conversation-row span{flex:1;min-width:0}
.conversation-row strong{font-size:0.857rem;font-weight:500;display:block;overflow-wrap:anywhere}
.conversation-row small{display:block;font-size:0.82rem;color:var(--muted);margin-top:3px}
.source-actions{display:flex;gap:8px;align-items:center;margin-top:22px}
.collector-status{font-size:0.82rem;color:var(--muted);line-height:1.8;margin-top:13px}
.source-global{margin-top:22px;padding:24px}
.source-global .form-grid{max-width:800px}
.source-global .helper{margin:0}
.load-more{padding:16px;text-align:center}
.task-origin{margin-top:20px;padding:16px;border:1px solid var(--soft-line);background:var(--surface);border-radius:6px}
.task-origin p{font-size:0.82rem;margin:10px 0 0;white-space:pre-wrap;color:var(--muted)}
dialog{border:1px solid var(--line);border-radius:13px;width:min(680px,calc(100vw - 30px));max-height:90vh;padding:0;box-shadow:var(--shadow);color:var(--ink);background:var(--panel)}
dialog::backdrop{background:var(--backdrop)}
dialog[open]{animation:dialog-in 170ms var(--ease-out)}
dialog.closing{animation:dialog-out 130ms ease forwards}
@keyframes dialog-out{to{opacity:0;transform:translateY(5px) scale(.985)}}
.dialog-heading{padding:24px 26px 18px;border-bottom:1px solid var(--soft-line);display:flex;justify-content:space-between;align-items:center}
.dialog-heading h2{margin:0;font-size:1.429rem}
.dialog-heading .eyebrow{margin-bottom:7px;font-size:0.82rem}
.dialog-body{padding:22px 26px 4px;max-height:65vh;overflow:auto}
.dialog-footer{padding:16px 26px;display:flex;justify-content:flex-end;gap:10px;border-top:1px solid var(--soft-line);background:var(--surface)}
.requirement-row{display:grid;grid-template-columns:1fr 1fr 60px 30px;gap:8px;margin-bottom:10px;align-items:center}
.requirement-row input{margin:0;min-height:34px;font-size:0.857rem}
.toast{position:fixed;bottom:26px;left:50%;transform:translateX(-50%);padding:11px 11px 11px 20px;background:var(--toast-bg);color:var(--panel);border-radius:9px;box-shadow:0 7px 25px var(--shadow-color);font-size:0.857rem;z-index:1000;max-width:min(90vw,650px);line-height:1.7;display:flex;align-items:center;gap:11px;transition:opacity 180ms var(--ease-out),transform 180ms var(--ease-out)}
.toast::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--toast-accent);flex-shrink:0}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.toast:not(.show){opacity:0;transform:translateX(-50%) translateY(13px);pointer-events:none}
.toast button{color:var(--toast-accent);font-weight:600;padding:5px 9px;border-radius:6px;min-height:28px}
.toast button:hover{background:#ffffff1c}
.auth-layout{min-height:100vh;display:grid;grid-template-columns:1fr 1fr}
.auth-story{padding:70px 15%;background:var(--sidebar);display:flex;flex-direction:column;align-items:flex-start;justify-content:center}
.auth-story>.eyebrow{margin-top:40px;color:var(--muted);font-size:0.82rem}
.auth-story h1{font-size:clamp(36px,4.5vw,70px);font-weight:550;line-height:1.27;color:var(--green);letter-spacing:-2px;margin:15px 0 28px}
.auth-story p{font-size:1.0rem;color:var(--muted);line-height:1.9}
.story-note{font-size:0.82rem;color:var(--muted);letter-spacing:1px;margin-top:35px}
.auth-form{width:min(360px,80%);margin:auto}
.auth-form .eyebrow{font-size:0.82rem}
.auth-form h2{font-size:1.929rem;color:var(--green)}
.auth-form>.muted{font-size:0.857rem;margin-bottom:30px}
.auth-form .full{margin-top:5px}
.auth-form>.link{display:block;margin:17px auto}
.mobile-back{display:none}
.task-detail-back{margin-bottom:18px}
.pending-note{color:var(--orange-text);font-size:0.82rem}
.small-actions{display:flex;gap:7px}
.plain-button{font-size:0.82rem;color:var(--muted);padding:5px 0}
.plain-button:hover{color:var(--green)}
.message-detail-empty{padding-top:130px;padding-bottom:130px}
.settings-status{font-size:0.857rem;color:var(--green);margin-top:15px}
.load-file-input{display:none}

@keyframes dialog-in{from{opacity:0;transform:translateY(7px) scale(.99)}
to{opacity:1;transform:none}
}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}
}

/* 置信度三档 */
.confidence-chip{display:inline-flex;align-items:center;gap:6px;font-size:.8rem;border-radius:5px;padding:3px 8px}
.confidence-chip i{width:7px;height:7px;border-radius:50%}
.confidence-chip.high{background:var(--green-bg);color:var(--green-text)}
.confidence-chip.high i{background:var(--green)}
.confidence-chip.medium{background:var(--orange-bg);color:var(--orange-text)}
.confidence-chip.medium i{background:var(--orange-text)}
.confidence-chip.low{background:var(--surface);color:var(--muted)}
.confidence-chip.low i{background:var(--muted)}

/* 分析证据摘句 */
.evidence-quote{border-left:3px solid var(--green);background:var(--panel);border-radius:0 7px 7px 0;padding:9px 13px;margin:9px 0;font-size:.86rem;color:var(--text);line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}
.evidence-quote em{font-style:normal;background:var(--selected);color:var(--green-text);border-radius:3px;padding:0 3px;box-decoration-break:clone;-webkit-box-decoration-break:clone}

/* AI 徽章（消息卡可展开） */
.ai-badge{display:inline-flex;align-items:center;gap:6px;font-size:.78rem;color:var(--green);background:var(--green-bg);border:0;border-radius:6px;padding:3px 9px;min-height:24px;font-weight:550}
.ai-badge svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.shelf-badge{display:inline-flex;align-items:center;gap:6px;font-size:.8rem;color:var(--green);cursor:pointer;background:var(--selected);border:0;border-radius:6px;padding:5px 10px;min-height:28px;font-weight:550;transition:background 120ms}
.shelf-badge:hover{background:var(--selected-border)}
.shelf-evidence{display:none;margin:9px 0 0;padding:11px 13px;background:var(--panel);border:1px solid var(--soft-line);border-radius:7px;font-size:.84rem;color:var(--muted);line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}
.shelf-evidence.open{display:block;animation:dialog-in 150ms var(--ease-out)}

/* AI 思考中：shimmer */
.thinking{display:inline-flex;align-items:center;gap:3px;height:14px}
.thinking i{width:5px;height:5px;border-radius:50%;background:var(--muted);animation:think 1.1s ease-in-out infinite}
.thinking i:nth-child(2){animation-delay:.18s}
.thinking i:nth-child(3){animation-delay:.36s}
@keyframes think{0%,100%{opacity:.25;transform:translateY(0)}50%{opacity:1;transform:translateY(-4px)}}

/* 完成庆祝：✓ 描边 */
.done-burst{position:fixed;inset:0;z-index:1100;display:grid;place-items:center;pointer-events:none}
.done-burst svg{width:86px;height:86px;stroke:var(--green);fill:none;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round;filter:drop-shadow(0 4px 18px var(--shadow-color));animation:burst-pop 1.15s var(--ease-out) forwards}
.done-burst circle{stroke-dasharray:210;stroke-dashoffset:210;animation:burst-ring .5s var(--ease-out) forwards}
.done-burst path{stroke-dasharray:44;stroke-dashoffset:44;animation:burst-check .34s var(--ease-out) .3s forwards}
@keyframes burst-pop{0%{opacity:0;transform:scale(.72)}18%{opacity:1;transform:scale(1)}72%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(1.12)}}
@keyframes burst-ring{to{stroke-dashoffset:0}}
@keyframes burst-check{to{stroke-dashoffset:0}}

/* 首屏 stagger（仅列表首次渲染前 8 项） */
.stagger>.stagger-item{opacity:1;transform:none}
.stagger>.stagger-item:nth-child(2){animation-delay:40ms}.stagger>.stagger-item:nth-child(3){animation-delay:80ms}
.stagger>.stagger-item:nth-child(4){animation-delay:120ms}.stagger>.stagger-item:nth-child(5){animation-delay:160ms}
.stagger>.stagger-item:nth-child(6){animation-delay:200ms}.stagger>.stagger-item:nth-child(7){animation-delay:240ms}
.stagger>.stagger-item:nth-child(8){animation-delay:280ms}
@keyframes stagger-in{to{opacity:1;transform:none}}

/* 列表行去手型光标（Raycast）：选中态承担可点暗示 */
.message-row,.task-card,.conversation-row,.instance-row{cursor:default}

/* 拖拽目标态 overlay */
.drop-overlay{position:fixed;inset:var(--titlebar);z-index:80;display:grid;place-items:center;pointer-events:none;opacity:0;transition:opacity 140ms var(--ease-out)}
body.dragging-files .drop-overlay{opacity:1}
.drop-overlay::before{content:"";position:absolute;inset:12px;border:2px dashed var(--green);border-radius:16px;background:var(--selected);opacity:.92}
.drop-overlay-inner{position:relative;display:flex;flex-direction:column;align-items:center;gap:11px;color:var(--green);font-weight:600;font-size:1.15rem;text-align:center;padding:0 30px}
.drop-overlay-inner svg{width:42px;height:42px;stroke:currentColor;fill:none;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;animation:drop-breathe 1.5s ease-in-out infinite}
@keyframes drop-breathe{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}
body.dragging-files .file-shelf{border-left:2px solid var(--green);box-shadow:0 0 0 5px var(--focus-soft),var(--shadow)}

/* 命令面板 */
.cmdk-backdrop{position:fixed;inset:var(--titlebar);z-index:900;background:var(--backdrop);display:flex;justify-content:center;align-items:flex-start;padding:clamp(68px,11vh,120px) 20px 20px}
.cmdk{width:min(560px,100%);min-height:0;max-height:100%;background:var(--panel);border:1px solid var(--line);border-radius:13px;box-shadow:var(--shadow);overflow:hidden;animation:dialog-in 150ms var(--ease-out)}
.cmdk:focus-within{border-color:color-mix(in srgb,var(--line) 78%,var(--focus) 22%);box-shadow:var(--shadow),0 0 0 1px var(--focus-soft)}
.cmdk #cmdk-input{margin:0;border:0;border-bottom:1px solid var(--soft-line);border-radius:0;min-height:50px;font-size:1.05rem;padding:14px 18px;background:transparent}
.cmdk input:focus,.cmdk input:focus-visible{outline:none!important;box-shadow:none!important;border-color:var(--soft-line)}
.cmdk-list{max-height:min(46vh,330px);overflow:auto;padding:5px}
@media(max-width:620px){
  .cmdk-backdrop{inset:calc(var(--jjb-viewport-offset-top,0px) + var(--jjb-mobile-topbar-bottom,60px) + 8px) 12px auto;height:max(0px,calc(var(--jjb-viewport-height,100dvh) - var(--jjb-viewport-offset-top,0px) - var(--jjb-mobile-topbar-bottom,60px) - var(--jjb-mobile-nav-offset,80px) - 20px));padding:0;display:grid;justify-content:stretch;justify-items:stretch;align-items:start}
  .cmdk{width:min(560px,100%);max-height:100%;margin:0 auto}
  .cmdk-list{min-height:0;max-height:none;overflow:auto;overscroll-behavior:contain}
}
.cmdk-item{display:flex;align-items:center;gap:11px;min-height:38px;padding:8px 12px;border-radius:8px;color:var(--text);width:100%;text-align:left;font-size:.94rem;transition:background 120ms var(--ease-out)}
.cmdk-item [data-icon] svg,.cmdk-item>span:first-child svg{width:17px;height:17px;stroke:currentColor;fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0;color:var(--muted)}
.cmdk-item kbd{margin-left:auto;font-family:inherit;font-size:.74rem;color:var(--muted);background:var(--control,var(--surface));border:1px solid var(--line);border-radius:4px;padding:2px 6px}
.cmdk-item.active,.cmdk-item:hover{background:var(--selected);color:var(--ink)}
.cmdk-item.active [data-icon] svg,.cmdk-item:hover [data-icon] svg,.cmdk-item.active>span:first-child svg,.cmdk-item:hover>span:first-child svg{color:var(--green)}
.cmdk-empty{padding:22px;text-align:center;color:var(--muted);font-size:.86rem}

@media(min-width:1550px){.view{padding:40px 50px}
.inbox-grid{grid-template-columns:minmax(340px,.85fr) minmax(420px,1.15fr)}
}

@media(max-width:1150px){.workspace{grid-template-columns:185px minmax(0,1fr)}
.sidebar{width:185px;padding-left:11px;padding-right:11px}
.brand{font-size:1.286rem;margin-left:8px}
.view{padding:26px 22px}
.topbar{padding:0 22px}
.inbox-grid{gap:14px;grid-template-columns:minmax(260px,.85fr) minmax(330px,1.15fr)}
.message-row{padding:13px 9px}
.message-meta strong{max-width:115px}
.detail-content{padding:17px}
.settings-grid{grid-template-columns:minmax(0,1fr)}
.settings-side{display:none}
.task-detail-grid{grid-template-columns:minmax(0,1fr) 260px}
.source-card{padding:18px}
.source-grid{gap:15px}
}

@media(max-width:850px){.workspace{grid-template-columns:70px minmax(0,1fr)}
.sidebar{width:70px;padding:24px 8px 0}
.brand{margin:0 auto 38px}
.brand>span,.nav-label,nav button>.count,.account>span:nth-child(2),.account>.icon-button{display:none}
nav button{font-size:0;justify-content:center;padding:14px}
nav button [data-icon]{font-size:1.143rem}
nav{gap:9px}
.account{justify-content:center;margin-top:auto}
.inbox-grid{grid-template-columns:1fr 1.1fr}
.topbar{height:56px}
.view{padding:22px 18px}
.page-heading h1{font-size:1.786rem}
.message-meta{flex-wrap:wrap}
.message-meta time{margin-left:0}
.task-detail-grid{grid-template-columns:1fr}
.source-grid{grid-template-columns:1fr}
}

@media(max-width:620px){.workspace{display:block}
.sidebar{position:fixed;top:auto;bottom:0;left:0;right:0;width:100%;height:62px;z-index:20;border-top:1px solid var(--line);border-right:0;padding:0;background:var(--sidebar)}
.brand,.account{display:none}
nav{display:flex;justify-content:space-around;height:100%;gap:0}
nav button{font-size:0.82rem;display:flex;flex-direction:column;gap:5px;padding:9px 8px;min-width:70px;border-radius:0;background:transparent!important}
nav button.active{color:var(--green)}
nav button svg{width:20px;height:20px}
.main{padding-bottom:65px}
.topbar{padding:0 18px}
.breadcrumb{font-size:0.82rem}
.sync-state{font-size:0.82rem}
.view{padding:24px 17px}
.page-heading{margin-bottom:22px}
.page-heading h1{font-size:1.786rem}
.page-heading p{font-size:0.82rem;max-width:240px}
.page-heading .actions{gap:5px}
.page-heading .secondary{display:none}
.page-heading .primary{padding:8px 10px;font-size:0.82rem;min-height:34px}
.toolbar{gap:7px}
.search{min-width:100%;max-width:none}
.toolbar select{flex:1;min-width:70px;font-size:0.82rem}
.toolbar .result-count{font-size:0.82rem}
.inbox-grid{display:block}
.message-list{max-height:none;min-height:300px}
.message-row{padding:16px 10px}
.message-meta strong{max-width:190px}
.message-meta time{margin-left:auto}
.detail{position:static;margin-top:16px}
.inbox-grid.has-selection>.messages-panel{display:none}
.inbox-grid:not(.has-selection)>.detail{display:none}
.mobile-back{display:inline-flex;margin-bottom:13px}
.detail-content{padding:20px}
.task-grid{grid-template-columns:1fr}
.task-summary{gap:12px}
.summary-cell{padding-right:14px;min-width:90px}
.summary-cell strong{font-size:1.714rem}
.settings-panel{padding:21px}
.form-grid,.form-grid.three{grid-template-columns:1fr;gap:0}
.source-global{padding:20px}
.source-grid{gap:16px}
.task-main-content{padding:20px}
.auth-layout{display:block;padding:45px 0}
.auth-story{background:transparent;padding:0;width:82%;margin:0 auto 35px}
.auth-story>img{width:42px;height:42px}
.auth-story>.eyebrow{margin:16px 0 7px}
.auth-story h1{font-size:2.143rem;margin:5px 0 10px;letter-spacing:-.5px}
.auth-story h1 br{display:none}
.auth-story p,.story-note{display:none}
.auth-form{width:82%}
.auth-form>.eyebrow{display:none}
.auth-form h2{font-size:1.571rem}
.dialog-body{padding:18px}
.dialog-heading{padding:20px 18px 15px}
.dialog-footer{padding:15px 18px}
.requirement-row{grid-template-columns:1fr 1fr 45px 25px;gap:5px}
.notice{padding:10px 18px;font-size:0.82rem}
}


.search svg{stroke:currentColor;fill:none;stroke-width:1.6;stroke-linecap:round}

@media(max-width:620px){.page-heading .secondary{display:inline-flex;padding:8px 10px;font-size:0.82rem;min-height:34px}
.page-heading .actions{flex-wrap:wrap;justify-content:flex-end;max-width:160px}
}


/* 外观、原生窗口与窄屏布局 */
*{scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--muted) 28%,transparent) transparent}
*::-webkit-scrollbar{width:8px;height:8px}
*::-webkit-scrollbar-track{background:transparent}
*::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--muted) 28%,transparent);border:2px solid transparent;border-radius:999px;background-clip:padding-box}
*::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--muted) 42%,transparent);border:2px solid transparent;background-clip:padding-box}
*::-webkit-scrollbar-corner{background:transparent}
body{line-height:1.5}
::selection{background:var(--selected-border);color:var(--ink)}
button:focus-visible,a:focus-visible,summary:focus-visible,[tabindex="0"]:focus-visible{outline:2px solid var(--focus);outline-offset:3px}
.workspace{min-height:calc(100dvh - var(--titlebar))}.sidebar{top:var(--titlebar)}
.topbar{position:sticky;top:var(--titlebar);z-index:30;min-height:65px;height:auto;padding-top:12px;padding-bottom:12px;gap:14px}
.topbar-right{gap:10px}.sync-state{white-space:nowrap}.main,.view,.panel,.message-body,.file-info{min-width:0}
.panel,.task-card{border-radius:12px}.primary,.secondary,.danger{min-height:40px;border-radius:8px}
.primary{color:var(--on-green)}.secondary,.search input,input:not([type=checkbox]),select,textarea{background:var(--input);color:var(--ink)}
input:not([type=checkbox]),select,textarea{min-width:0;min-height:41px;font-size:.97rem}
input::placeholder,textarea::placeholder{color:var(--muted);opacity:.8;font-size:.9rem}
input:focus,textarea:focus,select:focus{border-color:var(--focus);box-shadow:0 0 0 3px var(--focus-soft)}
.message-row{padding-top:var(--row-space);padding-bottom:var(--row-space)}.message-excerpt{font-size:.94rem;color:var(--text);overflow-wrap:anywhere}
.message-original,.task-description{font-size:1rem;overflow-wrap:anywhere}.detail-byline{font-size:.86rem}
.message-meta time,.summary-cell strong{font-variant-numeric:tabular-nums}.message-list{max-height:max(350px,calc(100dvh - var(--titlebar) - 330px))}
.tag{border-radius:5px}.theme-picker{display:flex;gap:2px;padding:3px;border:1px solid var(--line);border-radius:9px;background:var(--surface);flex-shrink:0}
.theme-picker button{width:30px;height:29px;display:grid;place-items:center;border-radius:6px;color:var(--muted)}
.theme-picker button:hover{background:var(--hover)}.theme-picker button.active{color:var(--green);background:var(--panel);box-shadow:0 1px 4px #0000000d}
.theme-picker svg,.theme-option svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:1.65;stroke-linecap:round;stroke-linejoin:round}
.auth-layout{position:relative;min-height:calc(100dvh - var(--titlebar))}.auth-utilities{position:absolute;right:28px;top:24px;z-index:2}
.auth-form{margin:90px auto;align-self:center}.auth-story{border-right:1px solid var(--line)}.auth-form .full{min-height:44px}
.appearance-panel{padding:26px;margin-bottom:24px}.appearance-heading{display:flex;justify-content:space-between;align-items:center;gap:12px}.appearance-heading h3{margin-bottom:6px}.appearance-heading p{margin-bottom:0}
.theme-options{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:22px 0;max-width:780px}
.theme-option{padding:13px;text-align:left;border:1px solid var(--line);border-radius:9px;background:var(--surface)}.theme-option:hover{border-color:var(--selected-border)}.theme-option.active{border-color:var(--green);box-shadow:inset 0 0 0 1px var(--green)}
.theme-option>span{display:flex;align-items:center;gap:8px;margin-top:12px;font-size:.94rem}
.theme-preview{height:66px;display:flex;border:1px solid #ccd8c8;border-radius:6px;overflow:hidden;background:#fafcf7}.theme-preview:before{content:"";width:24%;background:#e1eada;border-right:1px solid #ccd8c8}.theme-preview:after{content:"";width:58%;margin:13px 10px;border-radius:4px;border:1px solid #dde6d6;background:repeating-linear-gradient(0deg,#e7eddf 0 3px,#fff 3px 12px)}
.theme-preview.dark{background:#18261c;border-color:#3a4d3d}.theme-preview.dark:before{background:#263b2a;border-color:#3a4d3d}.theme-preview.dark:after{background:repeating-linear-gradient(0deg,#3b503d 0 3px,#1b2b20 3px 12px);border-color:#3a4d3d}
.theme-preview.system{background:linear-gradient(90deg,#fafcf7 50%,#18261c 50%)}.theme-preview.system:after{background:linear-gradient(90deg,#e7eddf 50%,#3b503d 50%)}
.appearance-fields{display:grid;grid-template-columns:repeat(2,minmax(0,280px));gap:20px}.appearance-fields label{margin-bottom:0}
.form-grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.source-grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
.page-heading>div:first-child{min-width:0}.page-heading h1,.task-card h3,.context-message p{overflow-wrap:anywhere}.page-heading .actions{flex-shrink:0}.source-actions{flex-wrap:wrap}
.task-grid{grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr))}.task-card-footer{flex-wrap:wrap;gap:8px}
.task-summary{padding:20px 22px;background:var(--panel);border:1px solid var(--line);border-radius:10px}.file-icon{flex-shrink:0}.file-info strong{font-size:.94rem}
.drop-zone:focus-within{outline:2px solid var(--focus);outline-offset:3px}.drop-zone:hover{background:var(--hover)}
dialog{max-height:calc(100dvh - var(--titlebar) - 30px);background:var(--panel)}.dialog-body{max-height:calc(100dvh - var(--titlebar) - 215px)}
.requirement-row{grid-template-columns:minmax(0,1fr) minmax(0,1fr) 60px 30px}.toast{color:var(--panel);background:var(--toast-bg)}

@media(max-width:1020px){.settings-grid,.source-grid,.task-detail-grid{grid-template-columns:minmax(0,1fr)}.settings-side{display:none}.topbar-right{gap:8px}}
@media(max-width:800px){.inbox-grid{display:block}.detail{position:static;margin-top:0}.inbox-grid.has-selection>.messages-panel{display:none}.inbox-grid:not(.has-selection)>.detail{display:none}.message-list{max-height:none;min-height:300px}.mobile-back{display:inline-flex;margin-bottom:15px}.page-heading .actions{flex-wrap:wrap;justify-content:flex-end;max-width:190px}.message-meta time{margin-left:auto}.message-meta strong{max-width:230px}}
@media(max-width:620px){
 .sidebar{top:auto;height:calc(66px + env(safe-area-inset-bottom));padding-bottom:env(safe-area-inset-bottom);background:color-mix(in srgb,var(--sidebar) 94%,transparent)}nav{height:66px}nav button{font-size:.74rem;gap:6px;min-width:66px}
 .main{padding-bottom:calc(80px + env(safe-area-inset-bottom))}.topbar{padding:10px 13px;gap:6px;min-height:62px}.topbar-right{gap:6px}.breadcrumb{font-size:0}.breadcrumb span{display:none}.breadcrumb strong{font-size:0.857143rem}.sync-state{font-size:0.714286rem}.theme-picker{padding:2px}.theme-picker button{width:27px;height:28px}.topbar .icon-button{width:28px}
 .page-heading .actions{max-width:145px}.page-heading h1{font-size:1.72rem}.page-heading .primary,.page-heading .secondary{font-size:.8rem;min-height:36px}.page-heading p{font-size:.86rem}
 .toolbar .result-count{width:100%;margin:0}.form-grid,.form-grid.three,.appearance-fields{grid-template-columns:minmax(0,1fr)}.appearance-fields{gap:17px}
 .task-summary{gap:0;justify-content:space-around;padding:18px 10px}.summary-cell{flex:1;min-width:0;padding:0 12px;gap:8px}.summary-cell span{font-size:.8rem;white-space:nowrap}
 .file-row{flex-wrap:wrap;gap:6px;padding:10px}.file-info{min-width:100px}.file-row .icon-button{width:30px;height:34px}
 .auth-layout{padding:76px 0 26px}.auth-form{margin:0 auto;width:85%}.auth-story{border:0;width:85%}.auth-utilities{right:20px;top:20px}.auth-story h1{font-size:2.142857rem}
 .appearance-panel{padding:21px 18px}.appearance-heading{flex-wrap:wrap}.theme-options{gap:8px}.theme-option{padding:8px}.theme-option>span{font-size:.83rem;gap:5px}.theme-preview{height:55px}.theme-preview:after{margin:11px 6px}
 .requirement-row{grid-template-columns:minmax(0,1fr) minmax(0,1fr) 47px 26px}.toast{bottom:calc(85px + env(safe-area-inset-bottom));width:max-content}
}
@media(max-width:370px){.sync-state{max-width:65px;overflow:hidden}.theme-option>span{font-size:0.785714rem}.topbar{padding-left:10px;padding-right:10px}}
@media(forced-colors:active){.primary,.theme-option.active,nav button.active{border:1px solid ButtonText}.tag{border:1px solid CanvasText}}

/* 简便接入、浏览器授权与文件收纳 */
.auto-source-panel{padding:19px 23px;margin-bottom:22px;display:flex;justify-content:space-between;gap:20px;align-items:center}.auto-source-panel .switch-line{border:0;padding:0;margin:0}.auto-source-panel .collector-status{margin:0;max-width:330px}
.source-title>input{margin-left:auto;accent-color:var(--green);width:17px;height:17px}.instance-list{margin-bottom:18px}.instance-row{display:flex;gap:11px;align-items:center;border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:9px}.instance-avatar{width:34px;height:34px;display:grid;place-items:center;border-radius:50%;background:var(--blue-bg);color:var(--blue-text)}.instance-row>div{min-width:0;flex:1}.instance-row strong,.instance-row small{display:block;overflow-wrap:anywhere}.instance-row small{font-size:.8rem;color:var(--muted);margin-top:3px}
.chat-toolbar{display:flex;gap:10px;align-items:center}.chat-toolbar input{margin:0;flex:1;min-width:0}.chat-toolbar span{white-space:nowrap}.advanced-source{margin-top:24px}.advanced-source>summary{padding:20px 23px;cursor:pointer;font-weight:550}.advanced-source>summary span{font-weight:400;margin-left:10px}.advanced-body{padding:0 23px 23px}.advanced-body>details{margin:15px 0}.advanced-body>details>summary{cursor:pointer;margin-bottom:17px}.debug-controls{margin-top:22px}.debug-output{background:var(--input);border:1px solid var(--line);padding:16px;border-radius:7px;max-height:360px;overflow:auto;font-size:0.857143rem;white-space:pre-wrap;overflow-wrap:anywhere}
.device-status{padding:18px;margin-top:18px;border:1px solid var(--line);border-radius:9px;background:var(--surface)}.device-status>p{margin:0}.device-code{font-size:1.857143rem;letter-spacing:4px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--green);margin:18px 0}.consent-page{min-height:calc(100dvh - var(--titlebar));padding:50px 20px;display:grid;place-items:center}.consent-card{padding:35px;max-width:500px}.consent-card>img{margin-bottom:24px}.consent-card h1{font-size:1.785714rem}.consent-card .detail-actions{margin-top:27px}.consent-card>.link{margin-top:15px}
.shelf-handle{position:relative;color:var(--muted)}
.shelf-count{position:absolute;top:-3px;right:-3px;min-width:16px;height:16px;padding:0 4px;border-radius:9px;background:var(--green-bg);color:var(--green-text);font-size:0.714286rem;font-weight:600;line-height:16px;text-align:center;box-shadow:0 0 0 2px var(--topbar)}
.shelf-backdrop{position:fixed;inset:var(--titlebar) 0 0;z-index:70;background:var(--backdrop);opacity:0;transition:opacity 180ms var(--ease-out)}
.shelf-backdrop.show{opacity:1}
.file-shelf{position:fixed;inset:var(--titlebar) 0 0 auto;width:min(440px,100vw);z-index:71;background:var(--panel);border-left:1px solid var(--line);box-shadow:var(--shadow);display:flex;flex-direction:column;padding:24px;transform:translateX(40px);opacity:.6;transition:transform 210ms var(--ease-drawer),opacity 210ms var(--ease-drawer),box-shadow 180ms var(--ease-out)}
.file-shelf.show{transform:none;opacity:1}
.shelf-heading{display:flex;justify-content:space-between;gap:15px;margin-bottom:18px}.shelf-heading h2{font-size:1.642857rem;margin:0 0 5px}.shelf-heading p{margin:0}.shelf-drop{position:relative;padding:24px 14px;text-align:center;border:1px dashed var(--selected-border);border-radius:9px;background:var(--soft);color:var(--green);font-size:.94rem;margin-bottom:15px}.shelf-drop input{position:absolute;inset:0;opacity:0;cursor:pointer;height:100%;margin:0}.shelf-auto{display:flex;gap:9px;align-items:center;font-size:.86rem;margin-bottom:18px}.shelf-files{overflow:auto;flex:1;min-height:0;padding-right:2px}.shelf-file{padding:17px;border:1px solid var(--line);border-radius:10px;margin-bottom:13px;background:var(--surface)}.shelf-file-title{display:flex;gap:10px;align-items:center}.shelf-file-title>div{min-width:0;flex:1}.shelf-file-title strong{display:block;font-size:.94rem;overflow-wrap:anywhere;font-weight:550}.shelf-file-title small{display:block;font-size:.8rem;color:var(--muted);margin-top:4px}.shelf-file .file-icon{height:37px;width:32px}.shelf-reason{font-size:.9rem;color:var(--text);margin:14px 0 6px}.shelf-task-label{display:flex;align-items:center;gap:7px;background:var(--selected);border-radius:6px;padding:9px;margin-top:12px;color:var(--green);font-size:.9rem}.shelf-task-label svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:1.6;flex-shrink:0}.shelf-select-label{font-size:.8rem;margin:15px 0 13px}.shelf-select-label select{margin-top:5px;font-size:.9rem}.shelf-file .secondary{font-size:.85rem;min-height:35px;padding:7px 11px}.shelf-file .plain-button{font-size:.8rem}.shelf-footnote{margin:13px 0 0;border-top:1px solid var(--line);padding-top:12px;font-size:0.785714rem}.shelf-open{overflow:hidden}
@media(max-width:800px){.auto-source-panel{align-items:flex-start;flex-direction:column;gap:11px}.source-grid{grid-template-columns:minmax(0,1fr)}}
@media(max-width:620px){.auto-source-panel{padding:18px}.advanced-source>summary{padding:18px}.advanced-source>summary span{display:block;margin:6px 0 0}.advanced-body{padding:0 18px 18px}.file-shelf{padding:20px 17px;bottom:env(safe-area-inset-bottom)}.shelf-handle{display:none}.shelf-file{padding:14px}.consent-card{padding:26px 22px}.device-code{font-size:1.642857rem}}
/* Drag frames use only compositor transforms; avoid repainting the full desktop. */
body.dragging-files .shelf-backdrop{backdrop-filter:none;background:#0003}
body.dragging-files .file-shelf{box-shadow:none;will-change:transform;contain:layout paint}
body.dragging-files .drop-overlay{display:none}
body.dragging-files .file-shelf *{animation:none!important}
.conversation-list{content-visibility:auto;contain-intrinsic-size:auto 260px}

.toast-close{flex-shrink:0;background:transparent;color:inherit;padding:0 7px;font-size:1.428571rem;min-width:32px;min-height:32px;border-radius:5px}.toast-close:hover{background:#8882}.danger-button{color:var(--red-text)}

.drop-zone.drag-target{border-style:solid;border-color:var(--green);background:var(--selected)}

.task-card.drag-target{border-color:var(--green);background:var(--selected)}

.analysis-live-preview{white-space:pre-wrap;line-height:1.8;overflow-wrap:anywhere;font-size:.9rem}.analysis-live-preview:empty{display:none}

.statistics-controls{display:flex;align-items:center;gap:20px;margin-bottom:18px}.statistics-controls label{display:flex;align-items:center;gap:12px;margin:0;white-space:nowrap}.statistics-controls select{width:150px;margin:0}.statistics-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:20px}.stat-metric{padding:20px;min-width:0}.stat-metric>span{font-size:.85rem;color:var(--muted)}.stat-metric strong{display:block;font-size:1.8rem;margin:12px 0;color:var(--green);font-variant-numeric:tabular-nums}.stat-metric small{color:var(--muted);font-size:.78rem;line-height:1.7}.statistics-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-bottom:16px}.statistics-wide{grid-column:1/-1}.statistics-grid>.panel{min-width:0;overflow:hidden}.statistics-chart{width:100%;height:290px}.statistics-table{overflow:auto;padding:0 20px}.statistics-table table{border-collapse:collapse;width:100%;min-width:540px;text-align:left;font-size:.85rem}.statistics-table th{font-weight:500;color:var(--muted);white-space:nowrap}.statistics-table td,.statistics-table th{padding:13px 10px;border-bottom:1px solid var(--soft-line)}.statistics-table td small{display:block;color:var(--muted);font-size:.77rem;margin-top:5px;max-width:240px;overflow-wrap:anywhere}.statistics-models{margin-bottom:20px}
@media(max-width:1000px){.statistics-summary{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:620px){.statistics-grid{grid-template-columns:minmax(0,1fr)}.statistics-controls{align-items:flex-start;flex-direction:column;gap:10px}.statistics-summary{gap:10px}.stat-metric{padding:16px}.stat-metric strong{font-size:1.5rem}.statistics-chart{height:260px}.sidebar nav button{min-width:0;flex:1;font-size:0;padding-left:4px;padding-right:4px}.sidebar nav button::after{content:attr(data-short);font-size:.74rem;white-space:nowrap}.sidebar nav button [data-icon]{font-size:1rem}}

.shelf-placement{display:grid;grid-template-columns:minmax(0,1fr);gap:0}.shelf-placement select{width:100%;min-width:0}.shelf-draft-note{color:var(--orange-text);margin-bottom:12px}

.file-kind-button{font-size:.75rem;padding:6px 7px;white-space:nowrap;color:var(--green);border:1px solid var(--line);border-radius:5px}

/* 首次使用引导 */
.onboard-card{position:fixed;right:26px;bottom:26px;z-index:950;width:min(360px,calc(100vw - 40px));background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);padding:24px;animation:dialog-in 200ms var(--ease-out)}
/* 进度直达：任务详情顶部三段开关 */
.status-switch{display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 18px}
.status-step{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:20px;padding:8px 15px;color:var(--muted);background:var(--surface);transition:border-color 140ms var(--ease-out),background 140ms var(--ease-out),color 140ms var(--ease-out);min-height:36px}
.status-step i{font-style:normal;font-size:.75rem;width:14px;text-align:center}
.status-step.on{border-color:var(--green);background:var(--selected);color:var(--green);font-weight:600}
.status-step.on.blue{border-color:var(--blue-text);background:var(--blue-bg);color:var(--blue-text)}
.status-step:not(.on):hover{border-color:var(--selected-border);color:var(--text)}
.status-step:disabled{opacity:.5}
.flex-spacer{flex:1}
.suggest-text{margin-bottom:14px}
.status-step.red.on{border-color:var(--red-text);background:var(--red-bg);color:var(--red-text)}
.reminder-row{display:flex;align-items:center;gap:9px;padding:9px 0;border-bottom:1px solid var(--soft-line);font-size:.86rem;line-height:1.5}
.reminder-row>span{display:inline-flex;align-items:center;gap:8px;line-height:1.5}
.reminder-row svg{width:15px;height:15px;stroke:var(--green);fill:none;stroke-width:1.8;flex-shrink:0;transform:translateY(1px)}
.reminder-row .plain-button{margin-left:auto;font-size:.78rem}
.reminder-add select,.reminder-add input{margin-top:6px}
.task-side .info-value .helper{margin-top:2px}
.onboard-card h3{margin:0 0 10px;font-size:1.15rem}
.onboard-card p{font-size:.9rem;color:var(--text);line-height:1.8;margin-bottom:16px}
.onboard-dots{display:flex;gap:7px;margin-bottom:16px}
.onboard-dots i{width:7px;height:7px;border-radius:50%;background:var(--line);transition:background 160ms}
.onboard-dots i.on{background:var(--green)}
.onboard-dots i.done{background:var(--selected-border)}
.onboard-card .detail-actions{align-items:center;margin:0}
@media(max-width:620px){.onboard-card{right:12px;left:12px;bottom:calc(80px + env(safe-area-inset-bottom));width:auto}}

.admin-panel { margin-top: 24px; }
.admin-panel .detail-actions { flex-wrap: wrap; overflow-wrap: anywhere; }

body.cmdk-open{overflow:hidden}

/* Frozen source: web/select-arrow.css */
/* Native select behavior and keyboard access, with a theme-aware disclosure arrow. */
select:not([multiple]) {
  appearance: none;
  padding-inline-end: 2rem;
  background-image:
    linear-gradient(45deg, transparent 50%, var(--muted, #617366) 50%),
    linear-gradient(135deg, var(--muted, #617366) 50%, transparent 50%);
  background-position: calc(100% - 17px) center, calc(100% - 12px) center;
  background-size: 5px 5px;
  background-repeat: no-repeat;
}
@media (forced-colors: active) {
  select:not([multiple]) { appearance: auto; background-image: none; }
}

/* Frozen source: web/palettes.css */
/* Complete coordinated palettes. The same roles are shared by every surface. */
:root{--canvas:#f4f5fa;--panel:#fafbfe;--sidebar:#eceff7;--topbar:#fafbfe;--surface:#e9edf7;--input:#fafbfe;--hover:#e3e8f4;--selected:#dce5f8;--selected-border:#819bd0;--ink:#303854;--text:#454e6e;--muted:#5b6480;--line:#ccd2e2;--soft-line:#e1e5ef;--green:#315bba;--green-hover:#254a9f;--on-green:#fafbfe;--focus:#315bba;--focus-soft:#315bba22;--soft:#e3eafa;--green-bg:#e0ede5;--green-text:#236441;--orange-bg:#f6ecd9;--orange-text:#865718;--blue-bg:#e0e8f8;--blue-text:#315bba;--purple-bg:#e9e3f6;--purple-text:#68529b;--red-bg:#f6e1e6;--red-text:#a4364e;--toast-bg:#303854;--toast-accent:#a9c5fc;--backdrop:#232b4566;--shadow-color:transparent;--shadow:none;--chart-blue:#4062ad;--chart-amber:#956c25;--accent:var(--green)}
:root[data-theme=dark]{--canvas:#1a1b26;--panel:#1d1f2d;--sidebar:#161720;--topbar:#1a1b26;--surface:#24283b;--input:#1a1b26;--hover:#292e42;--selected:#29334e;--selected-border:#566da2;--ink:#c0caf5;--text:#b3bcdf;--muted:#96a2c9;--line:#353c56;--soft-line:#2b3046;--green:#7aa2f7;--green-hover:#9bbafb;--on-green:#151a2c;--focus:#7aa2f7;--focus-soft:#7aa2f722;--soft:#25314a;--green-bg:#223c35;--green-text:#9ecea3;--orange-bg:#403624;--orange-text:#e0af68;--blue-bg:#273650;--blue-text:#9bbafb;--purple-bg:#352e49;--purple-text:#bb9af7;--red-bg:#422b39;--red-text:#f7768e;--toast-bg:#24283b;--toast-accent:#7aa2f7;--backdrop:#0e101bd9;--chart-blue:#7dcfff;--chart-amber:#e0af68}
:root[data-palette=nord]{--canvas:#eef1f5;--panel:#fafbfc;--sidebar:#e7ecf0;--topbar:#fafbfc;--surface:#e4eaf0;--input:#fafbfc;--hover:#dde5ed;--selected:#d8e5ec;--selected-border:#7394a5;--ink:#2e3440;--text:#434c5e;--muted:#566579;--line:#c6d1dc;--soft-line:#dce3ea;--green:#376c80;--green-hover:#2c586b;--on-green:#fafbfc;--focus:#376c80;--focus-soft:#376c8022;--soft:#dde8ee;--blue-text:#386486;--blue-bg:#e0e9f1;--toast-bg:#2e3440;--toast-accent:#88c0d0;--chart-blue:#5e81ac;--chart-amber:#937143}
:root[data-palette=nord][data-theme=dark]{--canvas:#2e3440;--panel:#323947;--sidebar:#272d38;--topbar:#2e3440;--surface:#3b4252;--input:#2e3440;--hover:#434c5e;--selected:#3d5261;--selected-border:#6d98aa;--ink:#eceff4;--text:#d8dee9;--muted:#b1becf;--line:#4c566a;--soft-line:#424b5e;--green:#88c0d0;--green-hover:#a1d0db;--on-green:#253440;--focus:#88c0d0;--focus-soft:#88c0d022;--soft:#344f5c;--green-bg:#33473f;--green-text:#a3be8c;--orange-bg:#4e4435;--orange-text:#ebcb8b;--blue-bg:#35465e;--blue-text:#a9c0dc;--purple-bg:#4b3f53;--purple-text:#d3afd0;--red-bg:#513942;--red-text:#e4a0a8;--toast-bg:#3b4252;--toast-accent:#88c0d0;--backdrop:#171b23d9;--chart-blue:#81a1c1;--chart-amber:#ebcb8b}
:root[data-palette=graphite]{--canvas:#f2f3f3;--panel:#fafbfb;--sidebar:#e9ecec;--topbar:#fafbfb;--surface:#e5e9e8;--input:#fafbfb;--hover:#dfe5e3;--selected:#d8e8e2;--selected-border:#7b9f91;--ink:#293632;--text:#45554f;--muted:#596b63;--line:#c7d1cc;--soft-line:#dee4e1;--green:#2c6c54;--green-hover:#225541;--on-green:#fafbfb;--focus:#2c6c54;--focus-soft:#2c6c5422;--soft:#dfebe5;--toast-bg:#293632;--toast-accent:#a3d9bf}
:root[data-palette=graphite][data-theme=dark]{--canvas:#1b201e;--panel:#202723;--sidebar:#171c19;--topbar:#1b201e;--surface:#29332e;--input:#1b201e;--hover:#303e36;--selected:#2d4438;--selected-border:#577d66;--ink:#e0e9e3;--text:#c2d0c6;--muted:#a0b4a7;--line:#3a4d41;--soft-line:#2e3c33;--green:#a3cfae;--green-hover:#bde0c4;--on-green:#1b2b20;--focus:#a3cfae;--focus-soft:#a3cfae22;--soft:#293e2e;--green-bg:#2c4533;--green-text:#b3d5ae;--toast-bg:#29332e;--toast-accent:#a3cfae;--backdrop:#0b130ed9}

/* Magpie's neutral surface roles, adapted to the workspace's semantic tokens. */
:root,:root[data-palette=magpie]{color-scheme:light;--canvas:#f4f4f6;--panel:#fff;--sidebar:#f4f4f6;--topbar:#f4f4f6;--surface:#f9f9fb;--input:#fff;--hover:#e9e9ee;--selected:#fff;--selected-border:#e3e3e8;--ink:#1c1c21;--text:#4b4b53;--muted:#707079;--line:#e3e3e8;--soft-line:#ececf0;--green:#4f46e5;--green-hover:#4338ca;--on-green:#fff;--focus:#4f46e5;--focus-soft:#4f46e51c;--soft:#eeedfd;--green-bg:#e4f6ec;--green-text:#187748;--orange-bg:#fbf0df;--orange-text:#92500a;--blue-bg:#eeedfd;--blue-text:#5046bd;--purple-bg:#eeedfd;--purple-text:#6558ad;--red-bg:#fbe9e9;--red-text:#bd3333;--toast-bg:#fff;--toast-accent:#1c1c21;--backdrop:#1c1c2144;--shadow-color:#14161e18;--shadow:0 16px 44px #14161e20;--chart-blue:#0ea5e9;--chart-amber:#b45309;--control:#f1f1f4;--control-hover:#e9e9ee;--segment:#e6e6eb;--thumb:#fff;--control-edge:0 1px 2px #00000014,0 0 0 .5px #0000000d}
:root[data-theme=dark][data-palette=magpie]{color-scheme:dark;--canvas:#1a1a1e;--panel:#232327;--sidebar:#1a1a1e;--topbar:#1a1a1e;--surface:#1f1f23;--input:#232327;--hover:#2d2d33;--selected:#232327;--selected-border:#3b3b42;--ink:#ededf1;--text:#b9b9c1;--muted:#a1a1aa;--line:#333339;--soft-line:#2c2c32;--green:#a5b4fc;--green-hover:#c0caff;--on-green:#14142a;--focus:#a5b4fc;--focus-soft:#a5b4fc22;--soft:#2b2c47;--green-bg:#1e3a2b;--green-text:#6fd99b;--orange-bg:#3f3220;--orange-text:#f2b544;--blue-bg:#2b2c47;--blue-text:#b7b9fb;--purple-bg:#302a40;--purple-text:#c4b5fd;--red-bg:#45272a;--red-text:#f28b82;--toast-bg:#2d2d33;--toast-accent:#ededf1;--backdrop:#00000066;--shadow-color:#00000055;--chart-blue:#7dd3fc;--chart-amber:#fcd34d;--control:#2d2d33;--control-hover:#36363d;--segment:#ffffff09;--thumb:#ffffff26;--control-edge:inset 0 .5px 0 #ffffff14,0 1px 2px #0000004d}

/* Frozen source: web/workspace.css */
/* Magpie-inspired default: neutral surfaces, compact native controls and quiet grouping.
   Source reference: yetone/magpie internal/gui/assets/app.css (MIT). */
:root{font-family:"Segoe UI Variable Text","Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;--font-scale:1;--control:var(--surface);--control-hover:var(--hover);--segment:var(--surface);--thumb:var(--panel);--control-edge:0 1px 2px #00000012;--row-space:16px}
:root[data-text-size=large]{--font-scale:1.12}:root[data-density=compact]{--row-space:12px}
body{font-size:.928571rem;line-height:1.4;-webkit-font-smoothing:antialiased}button,input,select,textarea{font-family:inherit}button{transition:background-color .15s,color .15s,border-color .15s}button:active:not(:disabled){transform:none}button:disabled{cursor:default}::selection{background:var(--soft);color:var(--ink)}
h1{font-size:1.714286rem;line-height:1.4;letter-spacing:-.5px;font-weight:650;margin:0 0 6px}h2{font-size:1.428571rem;letter-spacing:-.3px}h3{font-size:1rem;font-weight:600;letter-spacing:0}.helper{font-size:0.857143rem;line-height:1.7;color:var(--muted)}.eyebrow,.nav-label{font-size:0.785714rem;letter-spacing:.02em;font-weight:500;text-transform:none}
.workspace{grid-template-columns:212px minmax(0,1fr);min-height:calc(100dvh - var(--titlebar));overflow:clip}.sidebar{display:flex;flex-direction:column;background:var(--sidebar);border-right:1px solid var(--soft-line);padding:20px 12px 14px;gap:0}.brand{margin:0;padding:4px 8px 24px;gap:10px}.brand img{width:28px;height:28px}.brand>span{font-size:0.964286rem;font-weight:600}.brand small{font-size:0.785714rem;letter-spacing:0;margin-top:2px}.nav-label{margin:12px 8px 9px;color:var(--muted)}.sidebar nav{gap:1px}.sidebar nav button{height:30px;min-height:30px;padding:0 10px;border:0;border-radius:7px;gap:10px;font-size:0.928571rem;font-weight:400;color:var(--text)}.sidebar nav button svg{width:16px;height:16px;color:var(--muted)}.sidebar nav button.active{background:var(--selected);color:var(--ink);box-shadow:var(--control-edge);font-weight:500}.sidebar nav button.active svg{color:var(--ink)}.sidebar nav button:hover:not(.active){background:var(--hover)}.count{background:transparent!important;font-size:0.785714rem;color:var(--muted)}.account{border-top:1px solid var(--soft-line);padding:14px 3px 0;gap:8px}.avatar{border-radius:8px;width:30px;height:30px;background:var(--control);color:var(--text);font-size:0.857143rem}.account strong{font-size:0.857143rem;font-weight:500}.account small{font-size:0.714286rem}.topbar{min-height:54px;height:54px;padding:0 32px;background:var(--canvas);border-bottom:0}.breadcrumb{font-size:0.857143rem;color:var(--muted)}.breadcrumb strong{font-weight:500;color:var(--text)}.topbar-right{gap:14px}.sync-state{font-size:0.785714rem;color:var(--muted)}.sync-state i{width:5px;height:5px}.theme-picker{padding:3px;border-radius:8px;background:var(--segment);border:0;gap:1px}.theme-picker button{width:27px;height:25px;padding:5px;border-radius:6px;color:var(--muted)}.theme-picker button.active{background:var(--thumb);color:var(--ink);box-shadow:var(--control-edge)}.theme-picker svg{width:14px;height:14px}.view{padding:20px 32px 36px;width:100%;max-width:1320px;min-width:0;margin:auto}.page-heading{margin-bottom:22px;align-items:center;gap:18px}.page-heading p{font-size:0.857143rem;line-height:1.7;color:var(--muted);margin:0;max-width:640px}.page-heading .actions{gap:8px}
.primary,.secondary,.danger{min-height:32px;padding:6px 12px;font-size:0.857143rem;font-weight:500;border-radius:7px;border:1px solid transparent;gap:6px}.primary{background:var(--green);color:var(--on-green)}.primary:hover{background:var(--green-hover)}.secondary{background:var(--control);color:var(--ink);border-color:color-mix(in srgb,var(--line) 60%,transparent)}.secondary:hover{background:var(--control-hover)}.danger{background:var(--red-bg);color:var(--red-text)}.plain-button,.link{font-size:0.857143rem}.icon-button{width:28px;height:28px;border-radius:6px;font-size:1.428571rem}.icon-button svg{width:16px;height:16px}.tag,.due-chip,.confidence-chip,.urgency-badge{border-radius:5px;padding:3px 7px;font-size:0.714286rem;font-weight:500;border:0}.confidence-chip{background:var(--control);color:var(--muted)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:0 1px 2px #00000003;overflow:hidden}.panel-head{padding:14px 18px;min-height:46px;border-bottom:1px solid var(--soft-line);background:transparent}.panel-head h3{margin:0;font-size:0.857143rem;font-weight:600}.panel-head small{font-size:0.785714rem;color:var(--muted)}.toolbar{padding:0;background:transparent;border:0;margin-bottom:14px;gap:8px;flex-wrap:wrap}.toolbar input,.toolbar select{height:34px;min-height:34px;font-size:0.857143rem}.search{background:var(--input);border:1px solid var(--line);border-radius:8px;min-height:34px;min-width:180px;padding:0 10px}.search input{border:0!important;background:transparent!important;height:32px;min-height:32px}.search svg{width:15px;height:15px}.result-count{font-size:0.785714rem;color:var(--muted)}
.inbox-grid{grid-template-columns:minmax(290px,.95fr) minmax(360px,1.4fr);gap:18px;align-items:start}.message-row{padding:var(--row-space) 18px;border:0;border-bottom:1px solid var(--soft-line);border-radius:0;background:transparent}.message-row:hover{background:var(--surface)}.message-row.selected{background:var(--soft);box-shadow:inset 3px 0 var(--green)}.message-meta strong{font-size:0.857143rem;font-weight:600}.message-meta time,.sender{font-size:0.785714rem}.message-excerpt{font-size:0.928571rem;line-height:1.7;color:var(--text)}.message-bottom{margin-top:10px;gap:6px}.row-actions button{font-size:0.785714rem}.select-context{accent-color:var(--green)}.detail-content{padding:22px}.detail-title{font-size:1.428571rem;line-height:1.5;font-weight:600;margin:12px 0}.detail-meta,.detail-byline{font-size:0.785714rem}.message-original{padding:16px 0;margin:16px 0;background:transparent;border:0;border-top:1px solid var(--soft-line);border-bottom:1px solid var(--soft-line);font-size:1rem;line-height:1.9}.analysis-box{background:var(--surface);border:0;border-radius:9px;padding:16px}.analysis-top h3{font-size:0.857143rem}.analysis-box p{font-size:0.928571rem}.analysis-reason{border:0;padding:10px 0 0;color:var(--muted);font-size:0.857143rem}.detail-actions{gap:8px;flex-wrap:wrap}.context-options{font-size:0.857143rem}.context-options input{height:30px;min-height:30px;max-width:70px}.context-list{margin-top:20px;border-top:1px solid var(--soft-line);padding-top:14px}.context-list summary{font-size:0.857143rem}.evidence-quote{background:var(--soft);border-left:2px solid var(--green);border-radius:0 7px 7px 0}
.task-grid{gap:14px}.task-card{padding:20px;border:1px solid var(--line);border-radius:12px;background:var(--panel);box-shadow:0 1px 2px #00000003;transform:none!important}.task-card:hover{border-color:var(--selected-border);background:var(--surface);box-shadow:0 2px 6px #00000008}.task-card h3{font-size:1.071429rem;line-height:1.6}.task-card-footer{font-size:0.785714rem;border-color:var(--soft-line)}.task-detail-grid{grid-template-columns:minmax(0,1fr) 290px;gap:18px}.task-main-content,.task-side{padding:22px}.task-description{font-size:1rem;line-height:1.8}.section-heading{margin:22px 0 12px}.section-heading h3{font-size:0.928571rem}.info-label{font-size:0.785714rem;color:var(--muted)}.info-value{font-size:0.928571rem}.drop-zone,.shelf-drop,.files-drop{display:grid;place-items:center;text-align:center;cursor:pointer;border:1px dashed var(--line);background:var(--surface);border-radius:9px;min-height:88px;padding:18px;color:var(--muted);font-size:0.857143rem;transition:border-color 160ms var(--motion-ease),background-color 160ms var(--motion-ease)}.drop-zone:hover,.shelf-drop:hover,.files-drop:hover{border-color:var(--green);background:var(--soft)}.file-row{border:0;border-bottom:1px solid var(--soft-line);border-radius:0;background:transparent;padding:12px 0}.file-icon{border-radius:7px;background:var(--control);color:var(--text);font-size:0.714286rem}.check-row{padding:11px 0;border-color:var(--soft-line)}
.settings-grid{gap:24px;align-items:start}.settings-grid>.panel,.appearance-panel{padding:24px}.appearance-panel{margin-bottom:20px}.appearance-heading{margin-bottom:14px}.appearance-fields{grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.theme-options{gap:10px;max-width:680px;margin:18px 0 22px}.theme-option{border-radius:10px;background:var(--surface);border:1px solid var(--line);padding:10px;color:var(--text)}.theme-option.active{border-color:var(--green);box-shadow:0 0 0 1px var(--green);background:var(--soft);color:var(--ink)}.theme-option>span{font-size:0.857143rem;margin-top:9px}.theme-preview{height:58px;border-radius:6px;border-color:#e3e3e8;background:#f4f4f6}.theme-preview:before{background:#e6e6eb;border-color:#e3e3e8}.theme-preview:after{border-color:#e3e3e8;background:repeating-linear-gradient(0deg,#e3e3e8 0 2px,#fff 2px 12px)}.theme-preview.dark{background:#1a1a1e;border-color:#333339}.theme-preview.dark:before{background:#1f1f23;border-color:#333339}.theme-preview.dark:after{background:repeating-linear-gradient(0deg,#333339 0 2px,#232327 2px 12px);border-color:#333339}.theme-preview.system{background:linear-gradient(90deg,#f4f4f6 50%,#1a1a1e 50%)}.theme-preview.system:after{background:linear-gradient(90deg,#fff 50%,#232327 50%)}.switch-line{padding:14px 0;border-bottom:1px solid var(--soft-line);font-size:0.928571rem}.switch-line small{font-size:0.857143rem}label{font-size:0.857143rem;font-weight:500}input:not([type=checkbox]),select,textarea{border:1px solid var(--line);border-radius:7px;background:var(--input);color:var(--ink);font-size:0.928571rem;min-height:35px;padding:8px 10px}textarea{line-height:1.7}.form-grid{gap:14px}.notice{border:0;border-radius:8px;background:var(--soft);padding:14px;font-size:0.857143rem}.settings-side{padding:8px 0}.settings-side p,.settings-side li{font-size:0.857143rem;line-height:1.8;color:var(--muted)}.source-cards,.source-grid{gap:18px}.chat-list{border-radius:9px;border:1px solid var(--line);background:var(--input)}.chat-row{padding:11px 12px;border-bottom:1px solid var(--soft-line);font-size:0.928571rem}
.files-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}.files-drop{display:grid;place-items:center;margin-bottom:18px}.files-table{border-collapse:collapse;width:100%;font-size:0.928571rem}.files-table th{text-align:left;font-size:0.785714rem;font-weight:500;color:var(--muted);background:var(--surface);padding:13px 18px;border-bottom:1px solid var(--soft-line)}.files-table td{padding:15px 18px;border-bottom:1px solid var(--soft-line);color:var(--text)}.files-table tbody tr:last-child td{border:0}.files-table tbody tr:hover{background:var(--surface)}.files-table .file-title{display:block;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--ink)}.files-table small{display:block;font-size:0.785714rem;color:var(--muted);margin-top:4px}.file-name-cell{display:flex;align-items:center;gap:12px}.file-name-cell .file-icon{flex-shrink:0;width:32px;height:36px;display:grid;place-items:center}.files-table .file-place{max-width:240px}.storage-usage{display:inline-flex;align-items:center;height:38px;padding:0 16px;border:1px solid color-mix(in srgb,var(--green) 55%,transparent);border-radius:9px;color:var(--green);font-size:0.928571rem;font-variant-numeric:tabular-nums;white-space:nowrap}.storage-usage[hidden]{display:none}.quota-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;column-gap:16px;row-gap:4px;padding:13px 0;border-bottom:1px solid var(--soft-line)}.quota-row:last-child{border-bottom:0}.quota-user{display:flex;align-items:baseline;gap:10px;min-width:0}.quota-user strong{font-weight:500;color:var(--ink)}.quota-user small{color:var(--muted);font-size:0.857143rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.quota-controls{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px}.quota-controls input{width:110px;height:34px;min-height:34px}.quota-status{grid-column:1/-1;margin:0;min-height:1.2em}.files-table .file-controls{display:flex;align-items:center;justify-content:flex-end;gap:10px;white-space:nowrap}.files-table-wrap{overflow:auto}.file-shelf{width:min(480px,100vw);background:var(--panel);border-left:1px solid var(--line);box-shadow:-8px 0 32px #00000010;padding:24px}.shelf-file{border:0;border-bottom:1px solid var(--soft-line);border-radius:0;background:transparent;padding:18px 0}.shelf-file-title strong{font-size:0.928571rem}.shelf-task-label{border-radius:6px;background:var(--soft);color:var(--green);font-size:0.785714rem;padding:6px 8px}.shelf-handle{border:0;background:transparent;border-radius:6px;color:var(--muted)}.shelf-count{box-shadow:0 0 0 2px var(--topbar)}.file-drop-target-active{outline:2px solid var(--green);outline-offset:-2px}.drop-overlay{background:color-mix(in srgb,var(--canvas) 90%,transparent)}.drop-overlay-inner{background:var(--panel);border-radius:16px;border:1px solid var(--line);padding:36px}
.statistics-grid,.statistics-charts{gap:18px}.stat-metric{padding:20px}.stat-metric>span{font-size:0.857143rem;color:var(--muted)}.stat-metric strong{font-size:2rem;font-weight:600;letter-spacing:-.6px}.statistics-table th,.statistics-table td{font-size:0.857143rem;border-color:var(--soft-line);padding:12px}.statistics-table th{font-weight:500;color:var(--muted)}
dialog{padding:0;border:1px solid var(--line);border-radius:14px;background:var(--panel);color:var(--ink);box-shadow:var(--shadow);max-width:min(680px,calc(100vw - 32px))}dialog::backdrop{background:var(--backdrop);backdrop-filter:none}.dialog-heading{padding:22px 24px;border-bottom:1px solid var(--soft-line)}.dialog-heading h2{margin:0;font-size:1.357143rem}.dialog-body{padding:24px}.dialog-footer{padding:16px 24px;background:var(--surface);border-top:1px solid var(--soft-line);gap:8px}.component-consent{padding:24px}.component-consent pre{font:12px/1.7 inherit;white-space:pre-wrap;max-height:45vh;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:14px}.component-consent .dialog-footer{margin:16px -24px -24px}.toast{background:var(--toast-bg);color:var(--toast-accent);border:1px solid var(--line);border-radius:10px;padding:11px 16px;box-shadow:0 4px 20px #00000016;font-size:0.857143rem}.toast button{color:var(--muted)}.empty{min-height:230px;padding:42px 22px;color:var(--muted)}.empty svg{width:28px;height:28px;opacity:.55}.empty strong{font-size:1rem;font-weight:500;margin:16px 0 7px;color:var(--text)}.empty div,.empty p{font-size:0.857143rem;line-height:1.8}.cmdk{border-radius:12px;background:var(--panel);border:1px solid var(--line);box-shadow:var(--shadow)}.cmdk-item.active{border-radius:7px;background:var(--soft)}
.auth-layout{background:var(--canvas);grid-template-columns:1fr 1fr}.auth-story{background:var(--canvas);border-right:1px solid var(--line);padding:clamp(40px,7vw,112px)}.auth-story h1{font-size:2.714286rem;line-height:1.5;font-weight:600;letter-spacing:-1px}.auth-story p{color:var(--muted);font-size:1rem;line-height:1.9}.story-note{border:0;border-top:1px solid var(--line);background:none;border-radius:0;padding:18px 0;font-size:0.857143rem}.auth-form{background:transparent;border:0;width:min(400px,100%);margin:auto;padding:0 28px}.auth-form h2{font-size:1.714286rem}.auth-form>.eyebrow{font-size:0.785714rem;letter-spacing:.04em}.auth-form>p{font-size:0.928571rem}.auth-form input{min-height:40px}.auth-form .full{min-height:38px}.consent-card{border-radius:14px;border:1px solid var(--line);padding:30px}.device-code{border-radius:9px;background:var(--surface);font-family:Consolas,monospace;font-size:2rem;letter-spacing:.1em;padding:16px}
.stagger,.stagger-item{animation:none!important}button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
@media(max-width:1100px){.view{padding:20px 24px}.topbar{padding:0 24px}.workspace{grid-template-columns:178px minmax(0,1fr)}.inbox-grid{grid-template-columns:minmax(260px,1fr) minmax(310px,1.2fr)}.task-detail-grid{grid-template-columns:minmax(0,1fr) 250px}.appearance-fields{grid-template-columns:1fr 1fr}}
@media(max-width:820px){.workspace{grid-template-columns:154px minmax(0,1fr)}.sidebar{padding-left:8px;padding-right:8px}.brand{padding-left:6px}.brand>span{font-size:1rem}.brand small{font-size:0.642857rem}.inbox-grid,.task-detail-grid,.settings-grid{grid-template-columns:1fr}.detail{display:none}.inbox-grid.has-selection .messages-panel{display:none}.inbox-grid.has-selection .detail{display:block}.mobile-back{display:inline-flex}.auth-story{padding:40px 26px}.auth-story h1{font-size:2rem}}
@media(max-width:620px){.workspace{display:block}.sidebar{position:fixed;bottom:0;top:auto;width:100%;height:64px;padding:4px 6px;background:var(--panel);border:0;border-top:1px solid var(--line);z-index:30}.sidebar .brand,.sidebar .nav-label,.sidebar .account{display:none}.sidebar-bottom{display:contents}.sidebar nav{height:100%;display:flex;flex-direction:row;gap:3px}.sidebar nav button,.sidebar-bottom [data-nav]{height:54px;min-height:54px;min-width:0;flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;padding:5px 1px;font-size:0.714286rem;gap:4px}.sidebar nav button::after,.sidebar-bottom [data-nav]::after{display:none!important;content:none!important}.sidebar nav .count{display:none}.sidebar nav button.active,.sidebar-bottom [data-nav].active{box-shadow:none;background:var(--soft);color:var(--green)}.main{padding:0 0 68px}.topbar{height:48px;min-height:48px;padding:0 16px}.breadcrumb{font-size:0.714286rem}.topbar-right{gap:8px}.sync-state{font-size:0.714286rem}.view{padding:18px 16px 24px}.page-heading{flex-wrap:wrap;margin-bottom:18px}h1{font-size:1.571429rem}.page-heading p{font-size:0.857143rem}.task-grid{grid-template-columns:1fr}.task-card{padding:18px}.toolbar .search{flex-basis:100%}.toolbar select{flex:1;min-width:0}.appearance-fields{grid-template-columns:1fr}.settings-grid>.panel,.appearance-panel{padding:18px}.theme-options{gap:8px}.theme-option{padding:8px}.theme-option>span{font-size:0.714286rem}.theme-preview{height:50px}.auth-layout{display:block}.auth-story{padding:54px 28px 24px;border:0}.auth-story>img{width:32px;height:32px}.auth-story h1{font-size:1.928571rem;margin-bottom:10px}.auth-story .eyebrow,.auth-story .story-note{display:none}.auth-form{padding:24px 28px}.files-table th,.files-table td{padding:12px}.files-table .file-place{display:none}.files-table .file-title{max-width:170px}.component-consent{padding:18px}.component-consent .dialog-footer{margin:16px -18px -18px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}

.summary-cell strong{color:var(--ink);font-size:1.857143rem;font-weight:600}.summary-cell span{color:var(--muted)}.task-summary{border-color:var(--soft-line);padding:18px 22px}.task-card-footer>span:last-child{color:var(--muted)}

/* Grouped rows mirror Magpie's list structure, with one border around a collection. */
.task-grid{display:flex;flex-direction:column;gap:0;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--panel)}
.task-card{display:grid;grid-template-columns:115px minmax(0,1fr) 160px;grid-template-areas:"state title footer" "state description footer";gap:3px 18px;min-height:96px;padding:18px 20px;border:0;border-bottom:1px solid var(--soft-line);border-radius:0;box-shadow:none}
.task-card:last-child{border-bottom:0}.task-card:hover{background:var(--surface);box-shadow:none}.task-card>.pill-row{grid-area:state;align-self:center;flex-wrap:wrap}.task-card>h3{grid-area:title;align-self:end;margin:0;font-size:1rem}.task-card>p{grid-area:description;align-self:start;margin:0;font-size:0.857143rem;line-height:1.65;color:var(--muted)}.task-card>.task-card-footer{grid-area:footer;display:flex;flex-direction:column;justify-content:center;align-items:flex-end;gap:8px;margin:0;padding:0;border:0}.task-grid:empty{display:none}
@media(max-width:700px){.task-card{grid-template-columns:1fr auto;grid-template-areas:"state footer" "title title" "description description";padding:16px;gap:8px 12px}.task-card>.task-card-footer{flex-direction:row;gap:10px}.task-card>.pill-row{align-self:start}.task-card>h3{font-size:1.071429rem}}

/* Shared density tokens. Density changes spacing; text size is controlled by rem. */
:root{--sidebar-width:212px;--nav-height:40px;--nav-gap:4px;--control-height:38px;--field-height:40px;--panel-space:24px;--list-space:16px;--task-height:100px;--layout-gap:22px;--page-space:28px;--topbar-height:60px;--row-space:16px}
:root[data-density=compact]{--nav-height:32px;--nav-gap:2px;--control-height:32px;--field-height:35px;--panel-space:18px;--list-space:10px;--task-height:80px;--layout-gap:16px;--page-space:20px;--topbar-height:52px;--row-space:10px}
.workspace{grid-template-columns:var(--sidebar-width) minmax(0,1fr)}
.sidebar{width:var(--sidebar-width);min-height:0}
.sidebar .brand{margin:0;padding-bottom:var(--panel-space);flex-shrink:0}
.sidebar nav{gap:var(--nav-gap);flex-shrink:0}
.sidebar nav button{height:auto;min-height:max(var(--nav-height),2.4em);padding:6px 10px;line-height:1.4}
.sidebar .account{flex-shrink:0}
.topbar{height:auto;min-height:var(--topbar-height);gap:12px;padding-block:8px}
.topbar-right{flex-shrink:0}
.breadcrumb{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chart-mode{display:flex;flex:none;padding:3px;border-radius:8px;background:var(--segment);border:1px solid var(--soft-line);gap:1px}.chart-mode button{padding:4px 12px;border:0;border-radius:6px;background:transparent;color:var(--muted);font-size:0.785714rem;transition:background .18s ease,color .18s ease}.chart-mode button.active{background:var(--thumb);color:var(--ink);box-shadow:var(--control-edge)}.chart-mode button:hover:not(.active){color:var(--text)}
.toast.corner{left:auto;right:26px;transform:translateY(13px)}.toast.corner.show{transform:translateY(0)}.toast.corner:not(.show){transform:translateY(13px)}
.view{padding-block:var(--page-space)}
.page-heading{margin-bottom:var(--layout-gap)}
.primary,.secondary,.danger{min-height:max(var(--control-height),2.4em)}
.icon-button{min-width:var(--control-height);min-height:var(--control-height);flex-shrink:0}
.settings-grid,.source-grid,.task-detail-grid,.statistics-grid{gap:var(--layout-gap)}
.settings-grid>.panel,.appearance-panel,.source-card,.task-main-content,.task-side,.detail-content,.stat-metric{padding:var(--panel-space)}
.panel-head{padding-block:var(--list-space)}
.task-card{min-height:var(--task-height);padding-block:var(--list-space)}
.conversation-row,.file-row,.shelf-file,.check-row,.switch-line{padding-block:var(--list-space)}
.files-table td,.files-table th,.statistics-table td,.statistics-table th{padding-block:var(--list-space)}
input:not([type=checkbox]):not([type=hidden]):not([type=file]),select{min-height:max(var(--field-height),2.5em)}
.toolbar input,.toolbar select,.search,.search input{height:auto;min-height:var(--field-height)}
.cmdk{display:grid;grid-template-rows:auto minmax(0,1fr);min-height:0;max-height:min(640px,100%)}
.cmdk #cmdk-input{flex-shrink:0}
.cmdk-list{min-height:0;overscroll-behavior:contain}
@media(min-width:621px){
 .sidebar{flex:1 1 auto}
 .sidebar .brand>span,.sidebar .nav-label,.sidebar .account>span:nth-child(2){display:block}
 .sidebar .account>.icon-button{display:inline-flex}
 .sidebar nav{display:flex;flex-direction:column;flex:1 1 auto;height:auto;min-height:0;overflow-y:auto;overscroll-behavior:contain}
 .sidebar-bottom{flex-shrink:0;display:flex;flex-direction:column;gap:var(--nav-gap);border-top:1px solid var(--soft-line);margin-top:6px;padding-top:6px}
 .sidebar-bottom [data-nav]{height:auto;min-height:max(var(--nav-height),2.4em);padding:6px 10px;border:0;border-radius:7px;display:flex;align-items:center;gap:10px;font-size:0.928571rem;font-weight:400;color:var(--text);background:transparent;cursor:pointer;text-align:left;width:100%}
 .sidebar-bottom [data-nav] svg{width:16px;height:16px;color:var(--muted);flex:none}
 .sidebar-bottom [data-nav].active{background:var(--selected);color:var(--ink);box-shadow:var(--control-edge);font-weight:500}
 .sidebar-bottom [data-nav].active svg{color:var(--ink)}
 .sidebar-bottom [data-nav]:hover:not(.active){background:var(--hover)}
 .sidebar nav button{font-size:.928571rem;flex-direction:row;justify-content:flex-start}
 .sidebar nav button>.count{display:block}
}
@media(max-width:1100px){.view{padding-inline:24px}}
@media(max-width:820px){.sidebar{padding-top:18px}}
:root[data-sidebar=icons]{--sidebar-width:52px}
:root[data-sidebar=labels]{--sidebar-width:212px}
:root[data-sidebar] .workspace{transition:grid-template-columns 280ms cubic-bezier(.32,.72,0,1)}
:root[data-sidebar] .sidebar{transition:width 280ms cubic-bezier(.32,.72,0,1)}
.sidebar-top{display:flex;align-items:center;flex-shrink:0;padding:0 0 var(--panel-space)}
.sidebar-toggle{width:30px;min-width:30px;height:30px;min-height:30px;border-radius:7px;background:transparent;color:var(--muted)}
.sidebar-toggle:hover{background:var(--hover);color:var(--ink)}
:root[data-sidebar=icons] .sidebar-top{justify-content:center}
:root[data-sidebar=icons] .sidebar-toggle{margin-inline:auto}
:root[data-sidebar=icons] .brand{display:none}
:root[data-sidebar=icons] .sidebar{padding-inline:8px}
:root[data-sidebar=icons] .brand{justify-content:center;padding-inline:0}
:root[data-sidebar=icons] .brand>span,:root[data-sidebar=icons] .nav-label,:root[data-sidebar=icons] .nav-sub,:root[data-sidebar=icons] .account>span:nth-child(2){display:none}
:root[data-sidebar=icons] .sidebar nav button{min-width:0;justify-content:center;padding:0;font-size:0;gap:0}
:root[data-sidebar=icons] .sidebar-bottom [data-nav]{min-width:0;justify-content:center;padding:0;font-size:0;gap:0;width:100%}
:root[data-sidebar=icons] .sidebar nav button svg{flex:none}
:root[data-sidebar=icons] .sidebar nav button>.count{display:none}
:root[data-sidebar=icons] .account{justify-content:center;padding-inline:0}
:root[data-sidebar=icons] .account{flex-direction:column;margin-top:auto;gap:8px}
:root[data-sidebar=icons] .avatar,:root[data-sidebar=icons] .account>.icon-button{width:30px;min-width:30px;height:30px;min-height:30px}
:root[data-sidebar=icons] .account>.icon-button{display:inline-flex;padding:0}
:root[data-sidebar=icons] .main>.page-tabs{display:flex}
:root[data-sidebar=icons] .sidebar nav button::after{content:none!important}
.sidebar nav button{position:relative}
@media(max-width:620px){
 .workspace{display:block}
 .sidebar-top{display:none}
 .sidebar{width:100%;overflow:visible;height:68px;top:auto;bottom:0;padding:4px 6px}
 .sidebar nav{height:100%;gap:3px}
 .sidebar nav button{min-height:56px;height:56px;padding:5px 1px;gap:4px}
 .main{padding-bottom:calc(76px + env(safe-area-inset-bottom))}
 .view{padding:18px 16px 24px}
 .topbar{min-height:52px;padding:8px 16px;gap:8px}
 .topbar-right{gap:4px}
 .topbar .icon-button{min-width:30px;min-height:32px;width:30px}
 .primary,.secondary,.danger{min-height:max(44px,2.5em)}
 .settings-grid>.panel,.appearance-panel,.source-card,.task-main-content,.task-side{padding:18px}
 input:not([type=checkbox]):not([type=hidden]):not([type=file]),select,.toolbar input,.toolbar select,.search,.search input{min-height:44px}
 .theme-picker button{min-width:28px;min-height:32px;height:32px}
 .sync-state{max-width:65px;white-space:nowrap;overflow:hidden}
 :root[data-sidebar=icons] .sidebar nav button{min-height:56px;height:56px;flex-direction:column;justify-content:center;align-items:center;padding:5px 1px;font-size:.714286rem;gap:4px}
}
@media(max-height:680px) and (min-width:621px){.sidebar .account{flex-shrink:0}.sidebar .brand{padding-bottom:12px}.sidebar .nav-label{margin-top:6px}}

/* Contextual tabs: thin hierarchy line, muted labels and one neutral selection. */
.sidebar .nav-sub{position:relative;display:flex;flex-direction:column;gap:1px;margin:2px 0 6px 16px;padding-left:8px;isolation:isolate}
.sidebar .nav-sub::before{content:"";position:absolute;left:0;top:3px;bottom:3px;width:1px;background:var(--line)}
.sidebar .nav-sub>button{position:relative;z-index:1;flex:none;min-height:calc(var(--nav-height) - 4px);height:auto;padding:5px 10px;font-size:.892857rem;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted);border-radius:6px;line-height:1.4;text-align:left}
.sidebar .nav-sub>button.active{background:transparent;box-shadow:none;font-weight:500;color:var(--ink)}
.sidebar .nav-sub>button:hover{background:transparent;color:var(--ink)}
.subnav-highlight{position:absolute;left:8px;right:0;top:0;z-index:0;border-radius:6px;background:color-mix(in srgb,var(--ink) 6.5%,transparent);pointer-events:none}
.source-grid.single-source{grid-template-columns:minmax(0,1fr)}
@media(max-width:620px){.sidebar .nav-sub{display:none}.main>.page-tabs{display:flex}}
.page-tabs{display:none;gap:4px;overflow-x:auto;margin:12px 16px 0;padding:3px;border:1px solid var(--line);border-radius:8px;background:var(--segment)}
.page-tabs button{flex:none;min-height:40px;padding:6px 12px;font-size:.857143rem;white-space:nowrap;border-radius:6px;color:var(--muted)}
.page-tabs button[aria-selected=true]{background:var(--thumb);color:var(--ink);box-shadow:var(--control-edge)}
.page-tabs.motion-segment{position:relative;isolation:isolate;overflow-x:auto;scrollbar-width:none}
.page-tabs.motion-segment::-webkit-scrollbar{display:none}
.page-tabs.motion-segment>button[aria-selected=true]{background:transparent;box-shadow:none}

/* The authorization flow stays outside the workspace as a separate focused page. */
.authorize-page{min-height:100dvh;display:grid;place-items:center;padding:44px 20px;position:relative;background:var(--canvas)}
.authorize-utilities{position:absolute;right:20px;top:20px}
.authorize-card{width:min(480px,100%);padding:34px 30px 30px;text-align:center}
.authorize-card>img{margin-inline:auto}
.authorize-card h1{font-size:1.714286rem;margin:16px 0 8px}
.authorize-card h2{font-size:1.142857rem;margin:0 0 14px}
.authorize-card .helper{margin:0 0 22px}
.authorize-step{display:inline-flex;margin-bottom:12px;padding:4px 9px;border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--muted);font-size:.785714rem}
.authorize-login{display:flex;flex-direction:column;gap:14px;text-align:left}
.authorize-login .link{align-self:center}
.authorize-consent-section{display:block}
.authorize-card .detail-actions{justify-content:center}
.authorize-card .device-code{margin:0 0 18px}
.authorize-card #authorize-status{min-height:1.5em;margin:18px 0 0}
.authorize-card #authorize-error{margin:10px 0 0}
@media(max-width:620px){.authorize-page{align-items:flex-start;padding:22px 16px calc(22px + env(safe-area-inset-bottom))}.authorize-utilities{right:16px;top:16px}.authorize-card{padding:26px 20px}.authorize-card h1{font-size:1.5rem}.authorize-card .device-code{font-size:1.642857rem;padding:14px}.authorize-card .detail-actions{flex-direction:column}.authorize-card .detail-actions .primary,.authorize-card .detail-actions .secondary{width:100%;min-height:44px}}

/* Narrow screens stack page actions and turn the file table into stable cards. */
@media(max-width:620px){
 .page-heading{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;margin-bottom:18px}
 .page-heading .actions{max-width:none;justify-content:flex-start;flex-wrap:wrap}
 .files-table thead{display:none}
 .files-table,.files-table tbody,.files-table tr,.files-table td{display:block}
 .files-table tr{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px 14px;padding:14px 16px;border-bottom:1px solid var(--soft-line)}
 .files-table tr:last-child{border-bottom:0}
 .files-table td:first-child{grid-column:1 / -1}
 .files-table td:nth-child(2){justify-self:start}
 .files-table .file-controls{justify-self:end;display:flex;align-items:center;gap:12px;white-space:nowrap}
 .files-table .file-controls .plain-button,.files-table .file-controls .secondary{min-height:34px;padding:6px 10px}
 .files-table .file-title{max-width:min(48vw,240px)}
 .files-table-wrap{overflow:visible}
}

/* Plugin extensions use the same navigation and content motion contract. */
.plugin-overview{margin-bottom:var(--layout-gap)}
.plugin-overview .panel-head small{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.plugin-capabilities{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0}
.plugin-capabilities>div{padding:var(--panel-space);border-right:1px solid var(--soft-line)}
.plugin-capabilities>div:last-child{border-right:0}
.plugin-capabilities strong{display:block;font-size:.929rem;font-weight:600;color:var(--ink)}
.plugin-capabilities span{display:block;margin-top:7px;color:var(--muted);font-size:.857143rem;line-height:1.7}
.plugin-card{padding:var(--panel-space);border-bottom:1px solid var(--soft-line)}
.plugin-card:last-child{border-bottom:0}
.plugin-board .plugin-card{transition:background-color 160ms var(--motion-ease)}
.plugin-board .plugin-card:hover{background:color-mix(in srgb,var(--surface) 58%,transparent)}
.plugin-board.plugin-drop-ready{background:color-mix(in srgb,var(--selected) 24%,transparent);box-shadow:inset 0 0 0 1px var(--focus)}
.plugin-head{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:18px}
.plugin-identity{display:flex;align-items:center;gap:14px;min-width:0}
.plugin-mark{width:38px;height:38px;flex:none;display:grid;place-items:center;border:1px solid var(--selected-border);border-radius:8px;background:var(--surface);color:var(--green);font-size:.929rem;font-weight:650}
.plugin-title{min-width:0}
.plugin-title h3{margin:0;font-size:1.071rem;line-height:1.4;overflow-wrap:anywhere}
.plugin-title small{display:block;margin-top:4px;color:var(--muted);font-size:.786rem;overflow-wrap:anywhere}
.plugin-switch{display:inline-flex;align-items:center;gap:9px;min-height:34px;padding:7px 10px;border:1px solid color-mix(in srgb,var(--line) 72%,transparent);border-radius:7px;background:var(--surface);color:var(--muted);transition:border-color 160ms var(--motion-ease),background-color 160ms var(--motion-ease),color 160ms var(--motion-ease)}
.plugin-switch:hover{border-color:var(--selected-border);background:var(--hover);color:var(--ink)}
.plugin-switch input{width:15px;height:15px;margin:0;accent-color:var(--green)}
.plugin-switch:has(input:checked){border-color:var(--selected-border);background:var(--soft);color:var(--green);font-weight:550}
.plugin-description{margin:14px 0 0;color:var(--text);font-size:.928571rem;line-height:1.8;overflow-wrap:anywhere}
.plugin-tags{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:12px}
.plugin-chip{display:inline-flex;align-items:center;min-height:26px;padding:4px 8px;border:1px solid var(--soft-line);border-radius:6px;background:var(--surface);color:var(--muted);font-size:.785714rem;overflow-wrap:anywhere}
.plugin-error{margin-top:13px;padding:11px 13px;border:1px solid color-mix(in srgb,var(--red-text) 32%,transparent);border-radius:7px;background:var(--red-bg);color:var(--red-text);font-size:.857143rem;line-height:1.7;overflow-wrap:anywhere}
.plugin-debug{margin-top:14px;border:1px solid var(--soft-line);border-radius:8px;background:var(--surface)}
.plugin-debug>summary{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:42px;padding:9px 12px;border-radius:8px;color:var(--ink);font-size:.875rem;font-weight:550;cursor:pointer;transition:background-color 160ms var(--motion-ease)}
.plugin-debug>summary:hover{background:var(--hover)}
.plugin-debug>summary small{color:var(--muted);font-size:.786rem;font-weight:400}
.plugin-debug-body{margin:0;padding:16px 12px 12px;border-top:1px solid var(--soft-line)}
.plugin-debug-body label{display:block;margin:0}
.plugin-debug-body textarea{width:100%;margin-top:8px;background:var(--input);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.82rem;line-height:1.7;resize:vertical}
.plugin-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.plugin-debug .plugin-actions{margin-top:12px}
.plugin-output{margin:12px 0 0;padding:12px;border:1px solid var(--line);border-radius:7px;background:var(--input);color:var(--text);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.82rem;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto}
.plugin-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px;padding-top:12px;border-top:1px solid var(--soft-line)}
.plugin-footer .plugin-actions{justify-content:flex-start}
.plugin-delete{color:var(--red-text)}
.plugin-delete:hover{color:#fff;background:var(--red-text)}
.plugin-page-heading{max-width:1320px;margin:0 0 var(--layout-gap)}
.plugin-page-heading h1{margin:0}
.plugin-page-heading p{margin:6px 0 0;color:var(--muted);font-size:.857143rem;line-height:1.7}
.plugin-board .empty{border-top:1px solid var(--soft-line)}
@media(max-width:1000px){.plugin-capabilities{grid-template-columns:1fr}.plugin-capabilities>div{border-right:0;border-bottom:1px solid var(--soft-line)}.plugin-capabilities>div:last-child{border-bottom:0}}
@media(max-width:820px){.plugin-card{padding:20px}.plugin-footer{align-items:flex-start;flex-direction:column;gap:10px}}
@media(max-width:620px){.sidebar nav>button[data-plugin-tab]{display:none}.plugin-head{grid-template-columns:minmax(0,1fr);gap:12px}.plugin-switch{justify-self:start}.plugin-tags{margin-top:10px}.plugin-debug>summary{align-items:flex-start;flex-direction:column;min-height:0;padding:12px}.plugin-debug>summary small{margin-top:3px}.plugin-actions .secondary,.plugin-actions .plain-button{flex:1;min-width:0}}

/* Magpie service controls: shared segments, balance and daily check-in. */
.chart-mode{width:max-content;max-width:100%;align-items:center;flex-shrink:0}
.chart-mode[hidden],.managed-overview[hidden],#model-settings[hidden]{display:none}
.chart-mode button{min-height:30px;min-width:64px;padding:5px 14px;white-space:nowrap;transition:color 160ms var(--motion-ease),background-color 160ms var(--motion-ease)}
.service-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:14px;margin-bottom:18px}
.service-toolbar .helper{margin:0}
.service-toolbar:has(.chart-mode[hidden]):has(.helper:empty){display:none}
.managed-overview{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:16px;margin-bottom:20px}
.managed-overview:has(.checkin-panel[hidden]),.managed-overview:not(:has(.checkin-panel)){grid-template-columns:minmax(0,1fr)}
.credit-panel,.checkin-panel{padding:var(--panel-space,24px)}
.credit-panel>strong{display:block;margin:12px 0 8px;font-size:2.5rem;line-height:1.2;letter-spacing:-1px;font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums}
.credit-panel .helper{margin:0;line-height:1.7}
.service-badge{display:inline-flex;margin-top:16px;align-items:center;gap:6px;color:var(--muted);font-size:.786rem}
.service-badge::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--green)}
.checkin-panel{display:flex;flex-direction:column;align-items:flex-start;gap:14px;justify-content:space-between}
.checkin-panel h3{margin:0 0 7px;font-size:.929rem}
.checkin-panel .helper{margin:0;line-height:1.7}
.checkin-panel>strong{font-size:1.286rem;font-weight:500;color:var(--green)}
#model-settings[data-mode=managed] .settings-side{display:none}
#model-settings[data-mode=managed] .settings-grid{grid-template-columns:minmax(0,1fr)}
#llm-provider-fields{padding-bottom:18px;margin-bottom:22px;border-bottom:1px solid var(--soft-line)}
#llm-provider-fields[hidden]{display:none}
#llm-provider-fields .form-grid{grid-template-columns:minmax(0,1fr)}
#llm-context{max-width:240px}
.statistics-controls{flex-wrap:wrap;gap:12px 16px}
.statistics-controls label{flex:1 1 auto;min-width:0;white-space:nowrap}
.statistics-controls .segment-choice.segment-wrap{flex:0 1 auto;width:auto;max-width:100%}
.statistics-controls .helper{margin:0;white-space:nowrap}
.statistics-controls .chart-mode{margin-right:auto}
.statistics-summary{grid-template-columns:repeat(4,minmax(0,1fr))}
#statistics-unit{margin-left:auto}
@media(max-width:1000px){.statistics-summary{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:620px){.managed-overview{grid-template-columns:minmax(0,1fr);gap:12px}.credit-panel>strong{font-size:2rem}.checkin-panel{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center}.checkin-panel>div{grid-column:1/-1}.chart-mode button{min-height:38px}.statistics-controls{flex-direction:row;align-items:center}.statistics-controls>#statistics-state{flex-basis:100%}.service-toolbar{gap:10px}.credit-panel,.checkin-panel{padding:18px}}
/* Sidebar selection is sufficient feedback; keyboard input must not add an outer ring. */
.sidebar button:focus-visible,.sidebar a:focus-visible{outline:none;outline-offset:0}
.statistics-wide .panel-head{gap:12px;flex-wrap:wrap}
.statistics-wide .panel-head>small{margin-left:auto}

/* One breadcrumb contract: equal separators, shared baseline, predictable truncation. */
.topbar .breadcrumb{display:flex;align-items:center;gap:12px;min-width:0;font-size:.857143rem;line-height:1.5}
.topbar .breadcrumb span{display:inline-block;margin:0;font-size:inherit}
.topbar .breadcrumb-root,.topbar .breadcrumb-separator{flex:none;color:var(--muted)}
.topbar .breadcrumb>strong{flex:0 1 auto;min-width:2em;max-width:10em;overflow:hidden;text-overflow:ellipsis;font-size:inherit}
.topbar .breadcrumb .breadcrumb-sub{display:inline-flex;align-items:center;gap:12px;min-width:0;flex:0 1 auto}
.topbar .breadcrumb .breadcrumb-sub-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}
.topbar .breadcrumb .breadcrumb-sub[hidden]{display:none}
@media(max-width:620px){.topbar .breadcrumb{gap:8px;font-size:.786rem}.topbar .breadcrumb .breadcrumb-sub{gap:8px}.topbar .breadcrumb .breadcrumb-root,.topbar .breadcrumb .breadcrumb-root-separator{display:none}}

/* Canonical horizontal segments. Geometry and colour stay identical across screens. */
:root{--segment-radius:8px;--segment-pad:3px;--segment-height:calc(var(--field-height) - 8px);--segment-gap:1px}
.chart-mode,.page-tabs{padding:var(--segment-pad);gap:var(--segment-gap);border:1px solid var(--soft-line);border-radius:var(--segment-radius);background:var(--segment)}
.chart-mode>button,.page-tabs>button{min-height:var(--segment-height);height:auto;padding:5px 12px;border:0;border-radius:6px;background:transparent;color:var(--muted);font-size:.857143rem;font-weight:400;line-height:1.4;white-space:nowrap;transition:color 160ms var(--motion-ease),background-color 160ms var(--motion-ease)}
.chart-mode>button.active,.page-tabs>button[aria-selected=true]{color:var(--ink);font-weight:500}
.chart-mode.motion-segment>button.active,.page-tabs.motion-segment>button[aria-selected=true]{background:transparent;box-shadow:none}
.chart-mode>button:hover:not(:disabled),.page-tabs>button:hover:not(:disabled){color:var(--ink)}
select.segment-source{position:absolute!important;width:1px!important;height:1px!important;min-height:0!important;min-width:0!important;margin:0!important;padding:0!important;opacity:0!important;clip-path:inset(50%)!important;pointer-events:none!important;border:0!important}
.segment-choice{display:flex;max-width:100%;width:max-content;min-width:0;overflow-x:auto;scrollbar-width:none;overscroll-behavior-x:contain}
.segment-choice.segment-wrap{flex-wrap:wrap;overflow:visible;width:100%;scrollbar-width:auto}
.segment-choice::-webkit-scrollbar{display:none}
.segment-choice>button{flex:none;min-width:0;max-width:240px;overflow:hidden;text-overflow:ellipsis}
.segment-choice.segment-wrap>button{max-width:none}
.form-grid>label,.appearance-fields>label{min-width:0}
.toolbar .segment-choice{flex:0 1 auto}
.segment-choice[aria-invalid=true]{outline:2px solid var(--red-text);outline-offset:2px}
.update-progress{padding:18px;margin:16px 0;border:1px solid var(--soft-line);border-radius:10px;background:var(--surface)}
.update-progress[hidden]{display:none}
.update-progress-heading,.update-progress-detail{display:flex;align-items:center;justify-content:space-between;gap:12px;font-variant-numeric:tabular-nums}
.update-progress-heading{margin-bottom:12px;font-size:.857143rem}
.update-progress-heading strong{font-weight:500;color:var(--ink)}
.update-progress-heading>span,.update-progress-detail{color:var(--muted)}
.update-progress-track{height:5px;overflow:hidden;border-radius:99px;background:var(--selected)}
.update-progress-track>i{display:block;height:100%;width:100%;background:var(--green);transform:scaleX(0);transform-origin:left;transition:transform 200ms linear;border-radius:99px}
.update-progress-detail{margin-top:12px;font-size:.786rem;flex-wrap:wrap}
.update-progress.indeterminate .update-progress-track>i{width:30%;animation:jjb-download-pending 1.6s linear infinite}
.upload-progress{position:fixed;right:20px;bottom:24px;z-index:860;width:min(340px,calc(100vw - 32px));padding:16px;border:1px solid var(--soft-line);border-radius:10px;background:var(--panel);box-shadow:var(--shadow)}
.upload-progress[hidden]{display:none}
.upload-progress-heading,.upload-progress-detail{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--muted);font-size:.8rem;font-variant-numeric:tabular-nums}
.upload-progress-heading{margin-bottom:10px;color:var(--ink);font-size:.857143rem}
.upload-progress-heading strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
@keyframes jjb-download-pending{from{transform:translateX(-110%)}to{transform:translateX(450%)}}
@media(max-width:620px){:root{--segment-height:44px}.segment-choice{width:100%}.segment-choice>button{min-height:44px;padding:8px 12px}.update-progress{padding:15px}.update-progress-detail{align-items:flex-start;gap:6px}}
@media(prefers-reduced-motion:reduce){.update-progress-track>i{transition:none}.update-progress.indeterminate .update-progress-track>i{animation:none!important}}
.authorize-auth-tabs{margin-bottom:18px}
.authorize-auth-tabs>button[hidden]{display:none}

/* Shared spacing rhythm for forms, supporting panels and operation groups. */
:root{--field-space:16px;--section-space:24px;--action-gap:8px}
:root[data-density=compact]{--field-space:14px;--section-space:20px}
:is(.settings-panel,.appearance-panel,.advanced-body){padding:var(--panel-space)}
:is(.settings-panel,.appearance-panel,.advanced-body) h3{margin:0 0 8px}
:is(.settings-panel,.appearance-panel,.advanced-body)>p.helper,:is(.settings-panel,.appearance-panel,.advanced-body) form>p.helper{margin:0 0 var(--field-space);line-height:1.7}
:is(.settings-panel,.appearance-panel,.advanced-body)>p.helper:empty,:is(.settings-panel,.appearance-panel,.advanced-body) form>p.helper:empty{margin:0;min-height:0}
:is(.settings-panel,.appearance-panel,.advanced-body) label:not(.switch-line){margin-bottom:var(--field-space)}
:is(.settings-panel,.appearance-panel,.advanced-body) .form-grid{gap:var(--field-space) 16px;margin-bottom:var(--field-space)}
:is(.settings-panel,.appearance-panel,.advanced-body) .form-grid>label{margin:0}
:is(.settings-panel,.appearance-panel,.advanced-body) label input:not([type=checkbox]),:is(.settings-panel,.appearance-panel,.advanced-body) label textarea{margin-top:8px}
:is(.settings-panel,.appearance-panel,.advanced-body) .segment-choice{margin-top:8px}
:is(.settings-panel,.appearance-panel,.advanced-body) .switch-line{margin:0;padding-block:var(--list-space)}
:is(.settings-panel,.appearance-panel,.advanced-body) .switch-line small{margin-top:4px;line-height:1.7}
:is(.settings-panel,.appearance-panel,.advanced-body) .switch-line+.form-grid,:is(.settings-panel,.appearance-panel,.advanced-body) .switch-line+label:not(.switch-line){margin-top:var(--field-space)}
:is(.settings-panel,.appearance-panel,.advanced-body) .divider{height:1px;background:var(--soft-line);margin:var(--section-space) 0}
.detail-actions,.source-actions,.small-actions{gap:var(--action-gap);align-items:center;flex-wrap:wrap}
.detail-actions label.secondary,.settings-row-buttons label.secondary{display:inline-flex;align-items:center;justify-content:center;margin:0;cursor:pointer}
:is(.settings-panel,.appearance-panel,.advanced-body) .detail-actions+.detail-actions,.appearance-panel .detail-actions+.detail-actions{margin-top:12px}
#settings-launcher>.detail-actions+.detail-actions{margin-top:12px}
#settings-launcher [data-launch-status]{margin-top:var(--field-space);margin-bottom:0}
#settings-launcher [data-launch-status]:empty{margin:0}
.panel-head{gap:12px}
.toolbar{gap:8px;margin-bottom:var(--layout-gap)}
.toolbar>label,.statistics-controls>label{margin-bottom:0}
.source-actions{margin-top:var(--field-space)}
.files-table .file-controls{gap:12px}
:is(.settings-panel,.appearance-panel,.advanced-body) .update-progress{margin-block:var(--field-space)}

/* ---------- 更新弹窗 ---------- */
.update-notes{max-height:38vh;overflow:auto;padding:14px 16px;border:1px solid var(--soft-line);border-radius:10px;background:var(--surface);font-size:0.9rem;line-height:1.75}
.update-notes h3,.update-notes h4,.update-notes h5{margin:14px 0 6px;font-size:0.928571rem}
.update-notes h3:first-child{margin-top:0}
.update-notes p{margin:8px 0}
.update-notes ul,.update-notes ol{margin:8px 0;padding-left:22px;display:grid;gap:4px}
.update-notes code{font-family:'Cascadia Mono','SF Mono',Consolas,monospace;font-size:0.85em;background:var(--soft);border-radius:5px;padding:1px 5px}
.update-notes a{color:var(--green)}
.update-dialog-zone{margin-top:var(--field-space)}
.update-dialog-zone .update-progress{margin-block:0}

/* ---------- 设置 · 我的 ---------- */
.profile-card{display:flex;align-items:center;gap:14px;margin-bottom:var(--field-space)}
.profile-avatar{width:44px;height:44px;border-radius:50%;background:var(--green);color:var(--on-green);display:grid;place-items:center;font-size:1.1rem;font-weight:600;flex-shrink:0}
.profile-meta{flex:1;min-width:0;display:grid;gap:2px}
.profile-meta strong{font-size:1rem}
.profile-card+.divider{margin-top:var(--field-space)}
.settings-rows{display:grid}
.settings-row{display:flex;align-items:center;gap:14px;padding:12px 0;border-bottom:1px solid var(--soft-line)}
.settings-row:last-child{border-bottom:0}
.settings-row>div:first-child{flex:1;min-width:0}
.settings-row strong{display:block;font-size:0.9rem}
.settings-row small{color:var(--muted);line-height:1.6}
.settings-row-buttons{display:inline-flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
.settings-row-buttons .secondary,.settings-row-buttons .plain-button{flex-shrink:0}
@media(max-width:620px){:is(.settings-panel,.appearance-panel,.advanced-body) .form-grid{gap:var(--field-space)}.page-heading{row-gap:14px}.detail-actions,.source-actions{row-gap:10px}}

:is(.settings-panel,.appearance-panel,.advanced-body) .appearance-fields>label{margin:0}

/* ---------- 分享与收集 ---------- */
.field{display:block;margin-bottom:var(--field-space)}
.field-label{display:block;font-size:0.857143rem;font-weight:500;margin-bottom:8px}
.share-task-actions{display:flex;flex-wrap:wrap;gap:var(--action-gap);align-items:center}
.share-task-actions+.section-heading{margin-top:var(--section-space)}
.share-list{display:grid;gap:var(--layout-gap)}
.share-card{border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:18px;box-shadow:0 1px 2px #00000003;transition:border-color 160ms var(--motion-ease),background-color 160ms var(--motion-ease)}
.share-card:hover{border-color:var(--selected-border);background:var(--surface)}
.share-card-head{display:flex;gap:16px;justify-content:space-between;align-items:flex-start;flex-wrap:wrap}
.share-card-title{display:grid;gap:8px;min-width:0}
.share-card-title strong{font-size:1rem;line-height:1.5;overflow-wrap:anywhere}
.share-card-actions{display:flex;gap:var(--action-gap);flex-wrap:wrap}
.share-url{margin-top:14px;padding:9px 12px;border:1px solid var(--soft-line);border-radius:8px;background:var(--input);color:var(--muted);font-size:0.785714rem;font-family:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;user-select:all;cursor:text}
.share-card-meta{display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;font-size:0.785714rem;color:var(--muted)}
.share-submissions{margin-top:14px;border-top:1px solid var(--soft-line);padding-top:12px}
.share-submissions summary{cursor:pointer;font-size:0.857143rem;color:var(--text);list-style:none;transition:color 160ms var(--motion-ease)}
.share-submissions summary::-webkit-details-marker{display:none}
.share-submissions summary::before{content:"";display:inline-block;width:6px;height:6px;margin-right:8px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:translateY(-1px) rotate(-45deg);transition:transform 160ms var(--motion-ease)}
.share-submissions[open] summary::before{transform:translateY(-2px) rotate(45deg)}
.share-submissions summary:hover{color:var(--ink)}
.share-submissions-body{display:grid;gap:12px;margin-top:12px}
.share-submission{border:1px solid var(--soft-line);border-radius:9px;background:var(--surface);padding:12px 14px}
.share-submission-head{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.share-submission-head time{font-size:0.785714rem;color:var(--muted)}
.share-submission p{margin:8px 0 0;font-size:0.857143rem;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}
.share-submission-files{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.share-submission-files button{border:1px solid var(--soft-line);border-radius:7px;padding:5px 10px;background:var(--input)}
@media(max-width:620px){.share-card-head{display:grid}.share-card-actions{justify-content:flex-start}}

/* ---------- 独立分享页面 ---------- */
.share-page{min-height:100vh;padding:32px 20px 48px;background:var(--canvas);display:flex;justify-content:center;align-items:flex-start}
.share-shell{width:min(760px,100%);display:grid;gap:16px}
.share-brand{display:flex;align-items:center;gap:10px;font-weight:600;color:var(--ink)}
.share-brand small{display:block;font-size:0.785714rem;font-weight:400;color:var(--muted)}
.share-surface{padding:24px;display:grid;gap:18px}
.share-footnote{margin:0;text-align:center}
.share-state{display:grid;justify-items:center;gap:10px;text-align:center;padding:20px 0 8px}
.share-state h1{margin:0;font-size:1.285714rem}
.share-state p{margin:0;max-width:420px}
.share-state-icon{display:grid;place-items:center;width:44px;height:44px;border-radius:12px;background:var(--soft);color:var(--green)}
.share-state-icon svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.share-form-inline{display:grid;gap:12px;justify-items:stretch;width:min(360px,100%);margin-top:8px}
.share-banner{display:grid;gap:4px;border-bottom:1px solid var(--soft-line);padding-bottom:14px}
.share-banner strong{font-size:1.142857rem;line-height:1.5;overflow-wrap:anywhere}
.share-banner span{font-size:0.857143rem;color:var(--muted)}
.share-block{display:grid;gap:10px}
.share-block h2{margin:0;font-size:0.928571rem;font-weight:600;color:var(--ink)}
.share-text{margin:0;font-size:0.928571rem;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}
.share-meta-row{display:flex;justify-content:space-between;gap:16px;align-items:baseline;padding:10px 0;border-bottom:1px solid var(--soft-line);font-size:0.857143rem}
.share-meta-row span{color:var(--muted)}
.share-meta-row:last-child{border-bottom:0}
.share-requirements{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.share-requirements li{display:grid;gap:2px;border:1px solid var(--soft-line);border-radius:9px;padding:10px 12px;background:var(--surface)}
.share-requirements small{color:var(--muted);font-size:0.785714rem}
.share-files{display:grid;gap:8px}
.share-file-row{display:flex;align-items:center;gap:12px;border:1px solid var(--soft-line);border-radius:9px;padding:10px 12px;background:var(--surface)}
.share-file-name{flex:1;min-width:0;font-size:0.857143rem;overflow-wrap:anywhere}
.share-file-name small{display:block;color:var(--muted);font-size:0.785714rem;margin-top:2px}
.share-form{display:grid;gap:var(--field-space)}
.share-form label:not(.share-drop){display:block}
.share-form input,.share-form textarea,.share-form select{width:100%;margin-top:8px}
.share-drop,.file-picker{position:relative;display:grid;place-items:center;border:1px dashed var(--line);background:var(--surface);border-radius:9px;min-height:84px;padding:18px;color:var(--muted);font-size:0.857143rem;transition:border-color 160ms var(--motion-ease),background-color 160ms var(--motion-ease)}
.share-drop:hover{border-color:var(--green);background:var(--soft)}
.share-drop:hover,.file-picker:hover{border-color:var(--green);background:var(--soft)}
.share-drop .picker-name,.file-picker .picker-name{max-width:100%;margin-top:8px;color:var(--text);font-size:.8rem;line-height:1.6;overflow-wrap:anywhere;text-align:center}
:is(.drop-zone,.share-drop,.file-picker,.shelf-drop)>input[type=file]{position:absolute!important;width:1px!important;height:1px!important;min-height:0!important;min-width:0!important;margin:0!important;padding:0!important;opacity:0!important;clip-path:inset(50%)!important;pointer-events:none!important;border:0!important}
:is(.drop-zone,.share-drop,.file-picker,.shelf-drop):focus-within{outline:2px solid var(--focus);outline-offset:3px}
:is(.drop-zone,.share-drop,.file-picker,.shelf-drop).drag-target{border-style:solid;border-color:var(--green);background:var(--selected)}
.share-progress{display:grid;gap:8px}
@media(max-width:620px){.share-page{padding:20px 12px 36px}.share-surface{padding:18px;border-radius:12px}}
/* 分享表单沿用可换行分段控件，窄屏保持完整可读。 */
#share-dialog{width:min(680px,calc(100vw - 24px))}#share-dialog .chart-mode{flex-wrap:wrap;width:fit-content;max-width:100%}#share-dialog .field>label{margin-top:12px}#share-dialog .switch-line{margin-bottom:0}#share-dialog .dialog-footer{gap:8px;flex-wrap:wrap}#share-url-line{overflow-wrap:anywhere}#share-form-preview{width:min(680px,calc(100vw - 24px))}#share-form-preview .share-surface{border:0}
.share-file-row{flex-wrap:wrap}.share-submission-head{flex-wrap:wrap}.share-submission-files button{max-width:100%;overflow-wrap:anywhere;text-align:left}.share-form-inline label{text-align:left;width:100%}.share-form-inline input{width:100%;margin-top:8px}.share-page .authorize-utilities{position:fixed;right:18px;top:16px}.share-brand{padding-right:110px}.share-page{overflow-x:clip}

.share-card-actions>button{min-height:32px;padding:6px 10px}.share-card-actions{gap:8px}.share-task-actions{row-gap:10px}

#collection-studio{width:min(1180px,calc(100vw - 24px));max-height:92dvh}#collection-studio .studio-tabs{margin:0 24px 16px;flex-wrap:wrap}#collection-studio h3{font-size:14px;margin:0 0 14px}.studio-grid{display:grid;grid-template-columns:150px minmax(220px,1fr) 260px;gap:20px}.studio-palette{display:flex;flex-direction:column;gap:8px}.studio-properties{padding:16px;border-left:1px solid var(--soft-line)}.studio-properties label,.studio-settings label{display:block;margin:0 0 16px}.studio-properties input:not([type=checkbox]),.studio-settings input:not([type=checkbox]),.studio-settings textarea{width:100%;margin-top:8px}.studio-settings{max-width:780px}.studio-field{display:flex;width:100%;gap:12px;padding:18px;margin:0 0 12px;text-align:left;background:var(--surface);border:1px solid var(--line);border-radius:9px;cursor:grab}.studio-field.active{border-color:var(--green);background:var(--selected)}.studio-field small{margin-left:auto;color:var(--muted)}.studio-ai{display:flex;align-items:center;gap:12px;margin-bottom:24px}.studio-ai textarea{flex:1;min-width:0}.studio-table{overflow:auto;margin-top:18px}.studio-table table{width:100%;border-collapse:collapse;white-space:nowrap}.studio-table th,.studio-table td{text-align:left;padding:12px 16px;border-bottom:1px solid var(--soft-line)}.studio-table th{color:var(--muted);font-weight:500}#studio-code{font-family:Consolas,monospace;width:100%}#studio-status{margin-right:auto;max-width:70%;overflow-wrap:anywhere}@media(max-width:760px){.studio-grid{grid-template-columns:1fr}.studio-palette{flex-direction:row;flex-wrap:wrap}.studio-palette h3,.studio-palette p{width:100%;margin:0}.studio-properties{border-left:0;border-top:1px solid var(--line)}.studio-ai{flex-wrap:wrap}.studio-ai textarea{flex-basis:100%}#collection-studio .studio-tabs{margin-inline:16px}}

#collection-studio{max-width:calc(100vw - 24px)}#collection-studio .studio-tabs>button{min-height:34px}#collection-studio .dialog-footer{flex-wrap:wrap}.studio-grid>*{min-width:0}.studio-properties input,.studio-properties textarea{width:100%;min-width:0}.studio-palette>button{text-align:left}.studio-settings .switch-line{display:flex;gap:10px;align-items:center}.studio-canvas{padding:16px;background:var(--canvas);border:1px solid var(--soft-line);border-radius:10px}.studio-palette h3{margin-bottom:0}.studio-settings input[type=file]{max-width:100%}

#collection-studio[open]{display:flex;flex-direction:column;overflow:hidden}#collection-studio>.dialog-body{flex:1;min-height:0;max-height:none;overflow:auto}#collection-studio>.dialog-heading,#collection-studio>.dialog-footer,#collection-studio>.studio-tabs{flex:none}.studio-field{color:var(--ink)}.studio-properties .switch-line{display:flex;align-items:center;gap:10px}.studio-properties input[type=checkbox]{width:auto;margin:0}.studio-properties .section-heading{margin-top:0}

/* Sidebar hover is text-only, Magpie style; the selected row keeps the single moving surface. */
.sidebar nav button:hover:not(.active),.sidebar-bottom [data-nav]:hover:not(.active){background:transparent;color:var(--ink)}

/* Windows native reminder status stays factual and uses the same quiet surface language. */
.reminder-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:12px}
.reminder-heading h3{margin:0 0 4px}
.reminder-heading .helper{max-width:650px;margin:0}
.reminder-native-badge{display:inline-flex;align-items:center;gap:7px;flex:none;min-height:28px;padding:5px 9px;border:1px solid var(--line);border-radius:999px;color:var(--muted);background:var(--surface);font-size:.785714rem;white-space:nowrap}
.reminder-native-badge:before{content:"";width:7px;height:7px;border-radius:50%;background:var(--muted);transition:background-color 160ms var(--motion-ease)}
.reminder-native-badge[data-state="ready"]{color:var(--text);border-color:color-mix(in srgb,var(--green) 42%,var(--line))}
.reminder-native-badge[data-state="ready"]:before{background:var(--green)}
.reminder-native-badge[data-state="waiting"]:before{background:var(--orange)}
.reminder-native-badge[data-state="unsupported"]{color:var(--muted);border-style:dashed}
.reminder-status{min-height:1.7em;margin:0}
.reminder-panel [data-reminder-test]:disabled{opacity:.5}
@media(max-width:620px){.reminder-heading{display:grid;gap:10px}.reminder-native-badge{justify-self:start;white-space:normal}}

/* Frozen source: web/motion.css */
/* Canonical contract: docs/ui-design-standard.md, section 8. Never imported by quick.html. */
:root{--motion-ease:cubic-bezier(.2,.8,.2,1);--motion-out:cubic-bezier(.23,1,.32,1)}
.stagger>.stagger-item{opacity:1;transform:none;animation:none!important}
button{transition:background-color 160ms var(--motion-ease),color 160ms var(--motion-ease),border-color 160ms var(--motion-ease),transform 160ms var(--motion-ease)}
button:active:not(:disabled){transform:scale(.96)}
button.icon-button:active:not(:disabled){transform:scale(.9)}
:root:not([data-input-method=pointer]) button:active:not(:disabled){transform:none}
.sidebar nav button:active:not(:disabled),.cmdk-item:active:not(:disabled),[role=menuitem]:active:not(:disabled){transform:none}
.sidebar nav.motion-nav{position:relative;isolation:isolate}
.sidebar nav.motion-nav>button{position:relative;z-index:1}
.sidebar nav.motion-nav>button.active{background:transparent;box-shadow:none}
.nav-highlight{position:absolute;left:0;top:0;z-index:0;border-radius:7px;background:var(--selected);box-shadow:var(--control-edge);pointer-events:none}
.motion-segment{position:relative;isolation:isolate;background:var(--segment)}
.motion-segment>button{position:relative;z-index:1}
.theme-picker.motion-segment>button.active,.page-tabs.motion-segment>button[aria-selected=true]{background:transparent;box-shadow:none}
.segment-highlight{position:absolute;left:0;top:0;z-index:0;border-radius:6px;background:var(--thumb);box-shadow:var(--control-edge);pointer-events:none}
.chart-mode.motion-segment>button.active{background:transparent;box-shadow:none}
.chart-mode>button:active:not(:disabled){transform:none}
dialog.motion-dialog[open],dialog.motion-dialog.closing{animation:none}
dialog::backdrop{backdrop-filter:none;-webkit-backdrop-filter:none}
.action-menu{position:fixed;z-index:1001;display:flex;flex-direction:column;gap:2px;width:204px;max-width:calc(100vw - 16px);padding:5px;background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:11px;box-shadow:0 8px 28px #00000024}
.action-menu[hidden]{display:none}
.action-menu button{display:flex;align-items:center;width:100%;min-height:34px;padding:7px 10px;border-radius:6px;text-align:left;font-size:12px;gap:9px}
.action-menu button:hover,.action-menu button:focus-visible{background:var(--hover)}
.action-menu .menu-separator{height:1px;margin:4px;background:var(--soft-line)}
.menu-ghost{pointer-events:none!important}
.cmdk{animation:none}
@media(max-width:600px){.nav-highlight{background:var(--soft);box-shadow:none}.action-menu button{min-height:42px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}

.nav-sub.moving{overflow:hidden}
html.theming,html.theming *,html.theming *::before,html.theming *::after{transition:background-color 250ms var(--motion-ease),color 250ms var(--motion-ease),border-color 250ms var(--motion-ease),box-shadow 250ms var(--motion-ease)!important}

/* Reference-only composition: panel arrangement, not a new component skin. */
.reference-page[hidden]{display:none!important}.reference-list{display:grid;gap:var(--layout-gap)}
.reference-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:var(--layout-gap)}
.reference-toolbar .chart-mode{width:max-content;max-width:100%;flex-wrap:wrap}
.reference-controls{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.reference-profile{display:flex;align-items:center;gap:14px;padding-bottom:var(--section-space);border-bottom:1px solid var(--soft-line);margin-bottom:var(--section-space)}
.reference-profile>div{flex:1}.reference-profile h3{margin:0 0 5px}.reference-profile p{margin:0}
.reference-page>.panel{margin-bottom:var(--layout-gap)}.reference-page .file-picker{text-align:center}
.reference-page .panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.reference-form label{display:block}.reference-form input{width:100%;margin-top:8px}
.reference-form .form-grid{margin-block:var(--field-space)}
.reference-nav{margin-bottom:var(--layout-gap);display:flex;width:fit-content;max-width:100%;flex-wrap:wrap}
.reference-page .settings-side{display:none}
</style></head><body>
  <div id="workspace" class="workspace">
<aside class="sidebar"><div class="sidebar-top"><button id="sidebar-toggle" class="icon-button sidebar-toggle" type="button" aria-label="切换侧栏显示" aria-pressed="true" title="切换为图标模式"><span data-icon="sidebar"></span></button></div><a class="brand" href="#inbox" title="交件箱"><img src="./icon.svg" width="34" height="34" alt=""><span>交件箱<small>通知 · 待办 · 文件</small></span></a><div class="nav-label">工作空间</div><nav aria-label="主导航"><button data-nav="inbox" data-short="通知" title="通知"><span data-icon="inbox"></span>通知<span id="inbox-count" class="count"></span></button><button data-nav="tasks" data-short="待办" title="待办"><span data-icon="check"></span>待办<span id="task-count" class="count"></span></button><button data-nav="files" data-short="文件" title="文件"><span data-icon="file"></span>文件</button><button data-nav="sources" data-short="来源" title="消息来源"><span data-icon="connect"></span>消息来源</button><button data-nav="stats" data-short="统计" title="统计"><span data-icon="chart"></span>统计</button></nav><div class="sidebar-bottom"><button data-nav="settings" data-short="设置" title="设置"><span data-icon="settings"></span>设置</button></div><div class="account"><span class="avatar" id="avatar">J</span><span><strong id="account-name">示例用户</strong><small id="account-server">界面规范样板</small></span><button class="icon-button" id="logout" title="退出登录" aria-label="退出登录"><span data-icon="logout"></span></button></div></aside>
    <main class="main"><header class="topbar"><nav class="breadcrumb" aria-label="当前位置"><span class="breadcrumb-root">我的工作空间</span><span class="breadcrumb-separator breadcrumb-root-separator" aria-hidden="true">/</span><strong id="breadcrumb">通知</strong></nav><div class="topbar-right"><span id="sync-state" class="sync-state" role="status"><i></i>已同步</span><div data-theme-picker></div><button id="shelf-handle" class="icon-button shelf-handle" hidden title="打开文件收纳" aria-label="打开文件收纳"><span data-icon="file"></span><span id="shelf-count" class="shelf-count" hidden aria-hidden="true"></span></button><button id="quick-actions" class="icon-button" aria-label="快捷操作" title="快捷操作" aria-haspopup="menu" aria-controls="quick-actions-menu" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button><button id="refresh" class="icon-button" title="刷新" aria-label="刷新"><span data-icon="refresh"></span></button></div></header><div id="offline-banner" class="notice" hidden>当前离线，正在显示本机缓存。待办修改会保存在本机并在恢复连接后同步。</div><section id="view" class="view">
<section class="reference-page" data-page="settings">

  <div class="page-heading"><div><h1>设置</h1><p>管理个人资料与工作区数据。</p></div></div>
  <section id="account-panel" class="panel appearance-panel" data-settings-panel="account">
    <div class="reference-profile"><span class="avatar">示</span><div><h3>示例用户</h3><p class="helper">demo@example.test · 已验证</p></div><button class="secondary" data-open-profile>编辑资料</button></div>
    <h3>数据与连接</h3><p class="helper">当前连接：示例服务器。这里只演示界面，不连接真实账号。</p>
    <div class="settings-rows"><div class="settings-row"><div><strong>复制到本机并离线使用</strong><small>把云端数据复制到这台电脑，断网时也能继续使用。</small></div><div class="settings-row-buttons"><button class="secondary" data-feedback>复制到本机</button></div></div>
    <div class="settings-row"><div><strong>导出与导入数据包</strong><small>导出完整数据包，或从备份恢复当前工作区。</small></div><div class="settings-row-buttons"><button class="secondary" data-feedback>导出</button><label class="secondary">导入<input type="file" hidden aria-label="导入数据包"></label></div></div></div>
  </section>
  <section id="model-settings" class="panel appearance-panel reference-form" data-settings-panel="model" hidden><h3>模型连接</h3><p class="helper">选择服务器提供的 AI，或连接自己的模型接口。</p><div class="chart-mode reference-nav" role="tablist" aria-label="模型来源"><button role="tab" data-ref-source="default" aria-selected="true" class="active">默认</button><button role="tab" data-ref-source="custom" aria-selected="false">自定义</button></div><p class="helper" data-ref-default>服务器提供免配置服务，模型与图片能力由管理员配置。</p><div data-ref-custom hidden><label>API 地址<input placeholder="https://api.example.com/v1"></label><div class="form-grid"><label>模型<input placeholder="填写模型名称"></label><label>默认上下文条数<input type="number" value="12"></label></div></div><button class="primary" data-feedback>保存连接</button></section>
  <div id="appearance-panel-marker"><section id="settings-appearance" class="panel appearance-panel"><h3>外观与信息密度</h3><p class="helper">切换密度时，侧栏、输入框、按钮与分组间距一起调整。</p><div class="reference-toolbar"><select id="appearance-density" aria-label="信息密度"><option value="compact">紧凑</option><option value="comfortable">舒适</option></select><select id="appearance-text-size" aria-label="文字大小"><option value="normal">标准</option><option value="large">较大</option></select></div></section></div>
</section>
<section class="reference-page" data-page="files" hidden><div class="page-heading"><div><h1>文件</h1><p>集中查看材料、参考资料与提交回执。</p></div><div class="actions"><span class="helper">24.6 MB / 10 GB</span><button class="primary" data-choose>添加文件</button></div></div><label class="file-picker" tabindex="0">点击或拖入文件，添加待办材料<input id="reference-file" type="file" multiple aria-label="添加待办材料"><small class="picker-name">未选择文件</small></label><section class="panel" style="margin-top:var(--layout-gap)"><div class="files-table"><table><thead><tr><th>文件</th><th>用途</th><th>操作</th></tr></thead><tbody><tr><td><strong>实验报告.pdf</strong><div class="helper">1.2 MB · 11/11 12:00</div></td><td><span class="tag">待办材料</span></td><td><div class="detail-actions"><button class="plain-button" data-feedback>下载</button><button class="secondary" data-feedback>整理</button></div></td></tr></tbody></table></div></section></section>
<section class="reference-page" data-page="stats" hidden><div class="page-heading"><div><h1>使用统计</h1><p>查看模型消耗与响应表现。统计按北京时间汇总。</p></div><button class="secondary" data-feedback>刷新统计</button></div><div class="reference-toolbar"><span class="helper">统计范围</span><div class="chart-mode" id="reference-range" role="tablist" aria-label="统计范围"><button role="tab" aria-selected="false">最近 7 天</button><button role="tab" aria-selected="true" class="active">最近 30 天</button><button role="tab" aria-selected="false">最近 90 天</button></div><span class="helper">当前服务：自定义</span></div><div id="statistics-summary" class="statistics-summary"><div class="panel stat-metric"><span>已知 Token 消耗</span><strong>2,151</strong><small>输入 1,880 · 输出 271</small></div><div class="panel stat-metric"><span>模型调用</span><strong>1</strong><small>通知分析与文件整理</small></div><div class="panel stat-metric"><span>成功率</span><strong>100%</strong><small>1 次成功 · 0 次失败</small></div><div class="panel stat-metric"><span>平均响应</span><strong>23.1 秒</strong><small>仅统计成功请求</small></div></div><section class="panel appearance-panel" style="margin-top:var(--layout-gap)"><h3>共享布局连续性</h3><p class="helper">点击按钮观察同一元素移动，连续点击可以反向切换。</p><div id="chart-tokens"><div class="reference-controls" id="reference-layout"><button class="secondary" data-motion-key="shared-item">共享操作</button><button class="secondary" data-relayout>切换位置</button></div></div></section><section class="panel appearance-panel"><h3>响应情况</h3><div id="chart-latency"><p class="helper">平均响应 23.1 秒</p></div><div id="chart-status"><p class="helper">成功 1 次 · 失败 0 次</p></div></section><section class="panel appearance-panel"><h3>最近调用</h3><div id="statistics-recent"><p class="helper">11/11 12:00 · 通知分析 · 成功</p></div></section></section>
<section class="reference-page" data-page="tasks" hidden><div class="page-heading"><div><h1>待办</h1><p>要求、材料与提交回执，一处整理。</p></div><button class="primary" data-feedback>新建待办</button></div><div class="task-grid"><article class="task-card"><div class="pill-row"><span class="tag orange">准备材料</span></div><h3>提交课程实验报告</h3><p>准备报告与运行截图，在截止前完成提交。</p><div class="task-card-footer"><span class="helper">11/12 18:00 截止</span><span class="helper">1 / 2 项材料</span></div></article></div></section>
<section class="reference-page" data-page="inbox" hidden><div class="page-heading"><div><h1>通知</h1><p>从聊天中找到重要通知，自动分析并提取待办。</p></div><button class="primary" data-feedback>新建待办</button></div><section class="panel"><div class="panel-head"><h3>最近通知</h3><small>勾选消息可作为上下文</small></div><div class="empty"><strong>暂无通知</strong><div>连接 QQ / 微信，或粘贴一条通知。</div><button class="primary" data-feedback>添加第一条通知</button></div></section></section>
<section class="reference-page" data-page="sources" hidden><div class="page-heading"><div><h1>消息来源</h1><p>QQ 与微信分别连接，互不影响。</p></div></div><section class="panel appearance-panel auto-source-panel"><h3>连接状态</h3><label class="switch-line"><input type="checkbox" checked><span><strong>打开应用后自动读取</strong><small>首次选好聊天后，自动恢复上次选择。</small></span></label><p class="helper">这是界面样板，不读取本机聊天。</p></section><div class="source-grid"><section class="panel source-card"><h3>QQ 消息</h3><p class="helper">尚未连接 QQ</p><button class="secondary" data-feedback>连接 QQ</button></section><section class="panel source-card"><h3>微信消息</h3><p class="helper">尚未连接微信</p><button class="secondary" data-feedback>连接微信</button></section></div><details class="panel appearance-panel advanced-source"><summary>高级与调试</summary><p class="helper">样板不启动本机采集。</p></details></section>
</section></main>
  </div>
<dialog id="reference-profile"><form method="dialog"><div class="dialog-heading"><h2>编辑资料</h2><button type="button" class="icon-button" data-close-profile aria-label="关闭编辑资料">×</button></div><div class="dialog-body reference-form"><label>昵称<input value="示例用户" maxlength="64"></label><div class="form-grid"><label>邮箱<input type="email" value="demo@example.test"></label><label>新密码<input type="password" placeholder="不修改可留空"></label></div><p class="helper">样板只展示交互，保存不会发起网络请求。</p></div><div class="dialog-footer"><button class="secondary" type="button" data-close-profile>取消</button><button class="primary" type="submit">保存资料</button></div></form></dialog><script>
/* Canonical contract: docs/ui-motion-standard.md.  Behavior follows Magpie's continuity principles (MIT; see THIRD_PARTY_NOTICES).
   Main workspace only: quick.html deliberately does not load this module. */
(() => {
  'use strict';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const ease = 'cubic-bezier(.23,1,.32,1)';
  const spring = CSS.supports('animation-timing-function', 'linear(0,1)')
    ? 'linear(0,.0203,.0723,.1448,.2292,.3188,.4086,.4951,.576,.6498,.7157,.7735,.8232,.8654,.9005,.9293,.9525,.9708,.9849,.9956,1.0033,1.0087,1.0122,1.0142,1.015,1.0151,1.0146,1.0136,1.0124,1.0111,1.0097,1.0084,1.0071,1.0059,1.0049,1.0039,1.0031,1.0024,1.0018,1.0013,1)'
    : 'cubic-bezier(.2,.9,.25,1.02)';
  let keyboard = true, pressed = null;
  const dialogs = new WeakMap(), segments = new WeakMap();
  const play = (el, frames, options) => {
    try { return el.animate(frames, options); } catch { return null; }
  };
  const stop = entry => { for (const a of entry?.animations || []) a?.cancel(); };
  document.addEventListener('pointerdown', event => {
    keyboard = false;
    document.documentElement.dataset.inputMethod = 'pointer';
    const el = event.target.closest('[role=menuitem]') ? document.getElementById('quick-actions') : event.target.closest('button,[data-task],[data-message]');
    pressed = el ? { el, time: performance.now(), rect: el.getBoundingClientRect() } : null;
  }, true);
  document.addEventListener('keydown', () => { keyboard = true; pressed = null; document.documentElement.dataset.inputMethod = 'keyboard'; }, true);

  // One background, retaining velocity when the user changes direction.
  let nav, highlight, frame = 0, last = 0, positioned = false;
  const position = { x: 0, y: 0, w: 0, h: 0 }, velocity = { x: 0, y: 0, w: 0, h: 0 };
  const targetRect = () => {
    const active = nav?.querySelector('[data-nav].active');
    if (!active?.getClientRects().length) return null;
    return { x: active.offsetLeft, y: active.offsetTop, w: active.offsetWidth, h: active.offsetHeight };
  };
  const draw = () => {
    highlight.style.transform = `translate(${position.x}px,${position.y}px)`;
    highlight.style.width = position.w + 'px'; highlight.style.height = position.h + 'px';
  };
  function snapNav(to) {
    cancelAnimationFrame(frame); frame = 0;
    if (!to) { if (highlight) highlight.hidden = true; positioned = false; return; }
    Object.assign(position, to); for (const k in velocity) velocity[k] = 0;
    highlight.hidden = false; positioned = true; draw();
  }
  function step(now) {
    const to = targetRect();
    if (!to || document.hidden || reduced.matches) return snapNav(to);
    const dt = Math.min(1 / 30, Math.max(0, (now - last) / 1000)); last = now;
    const stiffness = (2 * Math.PI / .42) ** 2, damping = 4 * Math.PI * .84 / .42;
    let settled = true;
    for (const k in position) {
      for (let i = 0; i < 4; i++) {
        velocity[k] += (stiffness * (to[k] - position[k]) - damping * velocity[k]) * dt / 4;
        position[k] += velocity[k] * dt / 4;
      }
      if (Math.abs(to[k] - position[k]) >= .25 || Math.abs(velocity[k]) >= 4) settled = false;
    }
    if (settled) return snapNav(to);
    draw(); frame = requestAnimationFrame(step);
  }
  function syncNavigation(instant = false) {
    if (!nav) {
      nav = document.querySelector('.sidebar nav'); if (!nav) return;
      highlight = document.createElement('span'); highlight.className = 'nav-highlight';
      highlight.setAttribute('aria-hidden', 'true'); highlight.hidden = true; nav.prepend(highlight);
      nav.classList.add('motion-nav');
      new ResizeObserver(() => { if(!frame)snapNav(targetRect()); }).observe(nav);
    }
    const to = targetRect();
    nav.querySelectorAll('[data-nav]').forEach(b => {
      if (b.classList.contains('active')) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    if (!to || instant || !positioned || keyboard || reduced.matches || document.hidden) return snapNav(to);
    if (!frame && Object.keys(to).some(k => Math.abs(to[k] - position[k]) > .25)) {
      last = performance.now(); frame = requestAnimationFrame(step);
    }
  }

  // Segment boxes are rebuilt by page renders and dialog repaints; the moving
  // highlight survives by remembering the last resting rect per logical tab
  // group and flying from it, the way Magpie's selection never teleports.
  const segmentMemory = new Map();
  const segmentKey = box => box.dataset.selectFor || box.id
    || (box.getAttribute('aria-label') ? 'label:' + box.getAttribute('aria-label') : [...box.classList].join('.'));
  function rememberSegment(box, entry) {
    if (entry.animations.length) return;
    const rect = entry.thumb.getBoundingClientRect();
    if (!rect.width || !box.getClientRects().length) return;
    if (segmentMemory.size > 60) {
      let oldest = null;
      for (const [key, value] of segmentMemory) if (!oldest || value.at < oldest[1].at) oldest = [key, value];
      if (oldest) segmentMemory.delete(oldest[0]);
    }
    segmentMemory.set(segmentKey(box), { rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, at: performance.now() });
  }
  function syncSegments() {
    document.querySelectorAll('.theme-picker,.page-tabs,.chart-mode').forEach(box => {
      const selected = box.querySelector('button.active,button[aria-selected=true]');
      if (!selected?.offsetWidth || !box.getClientRects().length) return;
      let entry = segments.get(box);
      const fresh = !entry;
      if (!entry) {
        const thumb = document.createElement('span'); thumb.className = 'segment-highlight'; thumb.setAttribute('aria-hidden', 'true');
        box.prepend(thumb); entry = { thumb, selected: null, animations: [], to: null }; segments.set(box, entry); box.classList.add('motion-segment');
      }
      const before = entry.thumb.style.width ? getComputedStyle(entry.thumb) : null;
      const from = before && { transform: before.transform, width: before.width, height: before.height };
      const to = { transform: `translate(${selected.offsetLeft}px,${selected.offsetTop}px)`, width: selected.offsetWidth + 'px', height: selected.offsetHeight + 'px' };
      if(entry.selected===selected && entry.to && Object.entries(to).every(([key,value])=>entry.to[key]===value)){if(keyboard||reduced.matches||document.hidden)stop(entry);rememberSegment(box,entry);return;}
      stop(entry);entry.animations=[];
      Object.assign(entry.thumb.style, to);
      entry.to = to;
      if (from && entry.selected !== selected && !keyboard && !reduced.matches) entry.animations = [play(entry.thumb, [from, to], { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' })];
      else if (fresh && !keyboard && !reduced.matches && !document.hidden) {
        const memory = segmentMemory.get(segmentKey(box));
        if (memory && performance.now() - memory.at < 1200) {
          const rect = entry.thumb.getBoundingClientRect();
          if (Math.abs(memory.rect.left - rect.left) + Math.abs(memory.rect.top - rect.top) > 2) {
            entry.animations = [play(entry.thumb, [
              { transform: `translate(${selected.offsetLeft + memory.rect.left - rect.left}px,${selected.offsetTop + memory.rect.top - rect.top}px)`, width: memory.rect.width + 'px', height: memory.rect.height + 'px' },
              to,
            ], { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' })];
          }
        }
      }
      entry.selected = selected;
      if (entry.animations.length) entry.animations[0]?.finished.catch(() => {}).then(() => rememberSegment(box, entry));
      else rememberSegment(box, entry);
    });
  }

  function adoptSegment(box, from) {
    syncSegments();const entry=segments.get(box);
    if(!entry||keyboard||reduced.matches||document.hidden)return;
    const selected=entry.selected,rect=entry.thumb.getBoundingClientRect();
    stop(entry);
    const to={transform:entry.thumb.style.transform,width:entry.thumb.style.width,height:entry.thumb.style.height};
    const start={transform:`translate(${selected.offsetLeft+from.left-rect.left}px,${selected.offsetTop+from.top-rect.top}px)`,width:from.width+'px',height:from.height+'px'};
    entry.animations=[play(entry.thumb,[start,to],{duration:280,easing:'cubic-bezier(.2,.8,.2,1)'})];
    entry.animations[0]?.finished.catch(()=>{});
  }

  document.addEventListener('keydown',event=>{
    const box=event.target.closest('.chart-mode[role=tablist]');
    if(!box||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const buttons=[...box.querySelectorAll('button:not(:disabled)')];
    const index=buttons.indexOf(event.target);if(index<0)return;
    event.preventDefault();event.stopPropagation();
    const next=buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowLeft'?-1:1)+buttons.length)%buttons.length];
    next.focus({preventScroll:true});next.click();
  });
  function sourceRect(entry) {
    if (!entry?.source?.isConnected) return null;
    const r = entry.source.getBoundingClientRect();
    return r.width && r.height && r.bottom > 0 && r.top < innerHeight ? r : null;
  }
  function folded(from, to) {
    const scale = Math.max(.3, Math.min(1, from.width / to.width));
    const height = Math.min(to.height, from.height / scale);
    return { transform: `translate(${from.left + from.width / 2 - to.left - to.width / 2}px,${from.top + from.height / 2 - to.top - to.height / 2}px) scale(${scale})`,
      clipPath: `inset(${(to.height - height) / 2}px 0 round ${Math.min(10, from.height / 2) / scale}px)` };
  }
  const rest = { transform: 'none', clipPath: 'inset(-80px round 14px)', opacity: 1 };
  function openDialog(dialog) {
    const previous = dialogs.get(dialog);
    if (dialog.open && previous?.phase !== 'closing') return;
    const current = dialog.open ? { transform: getComputedStyle(dialog).transform, clipPath: getComputedStyle(dialog).clipPath, opacity: getComputedStyle(dialog).opacity } : null;
    const entry = { phase: 'opening', animations: [], source: !keyboard && pressed && performance.now() - pressed.time < 1000 ? pressed.el : null };
    stop(previous); dialogs.set(dialog, entry);
    dialog.classList.remove('closing'); dialog.classList.add('motion-dialog');
    // Show immediately: browser top-layer focus and inertness remain native.
    if (!dialog.open) dialog.showModal();
    if (keyboard || reduced.matches) { entry.phase = 'open'; return; }
    const to = dialog.getBoundingClientRect(), from = sourceRect(entry);
    entry.animations = [
      play(dialog, [current || { ...(from ? folded(from, to) : { transform: 'translateY(16px) scale(.95)' }), opacity: 0 }, rest], { duration: 440, easing: spring }),
      play(dialog, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out', pseudoElement: '::backdrop' }),
    ];
    Promise.all(entry.animations.map(a => a?.finished.catch(() => {}))).then(() => {
      if (dialogs.get(dialog) === entry) entry.phase = 'open';
    });
  }
  function closeDialog(dialog, value) {
    if (!dialog.open) return Promise.resolve();
    const previous = dialogs.get(dialog);
    if (previous?.phase === 'closing') return previous.done;
    const current = { transform: getComputedStyle(dialog).transform, clipPath: getComputedStyle(dialog).clipPath, opacity: getComputedStyle(dialog).opacity };
    stop(previous);
    const entry = { phase: 'closing', animations: [], source: previous?.source };
    dialogs.set(dialog, entry);
    const finish = () => {
      if (dialogs.get(dialog) !== entry) return;
      stop(entry); dialogs.delete(dialog); dialog.close(value);
    };
    if (keyboard || reduced.matches) { finish(); return Promise.resolve(); }
    const to = dialog.getBoundingClientRect(), from = sourceRect(entry);
    entry.animations = [
      play(dialog, [current, { ...(from ? folded(from, to) : { transform: 'translateY(10px) scale(.97)' }), opacity: 0 }], { duration: 220, easing: ease, fill: 'forwards' }),
      play(dialog, [{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease-out', fill: 'forwards', pseudoElement: '::backdrop' }),
    ];
    // Animation completion, cancellation and a safety deadline all converge here.
    let timer;
    entry.done = Promise.race([
      Promise.all(entry.animations.map(a => a?.finished.catch(() => {}))),
      new Promise(resolve => { timer = setTimeout(resolve, 450); }),
    ]).then(() => { clearTimeout(timer); finish(); });
    return entry.done;
  }
  document.addEventListener('cancel', event => {
    if (event.target.matches('dialog')) { event.preventDefault(); closeDialog(event.target); }
  }, true);
  document.addEventListener('close', event => {
    if (event.target.matches('dialog') && !event.target.open) { stop(dialogs.get(event.target)); dialogs.delete(event.target); }
  }, true);

  // Small anchored menu. The exit copy never receives focus or file drops.
  let menu, trigger, menuAnimation, menuReturnFocus;
  function hideMenu(returnFocus = false) {
    if (!menu || menu.hidden) return;
    const drawn = getComputedStyle(menu), start = { opacity: drawn.opacity, transform: drawn.transform };
    menuAnimation?.cancel();
    if (!keyboard && !reduced.matches) {
      const rect = menu.getBoundingClientRect(), ghost = menu.cloneNode(true);
      ghost.removeAttribute('id'); ghost.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
      ghost.classList.add('menu-ghost'); ghost.inert = true; ghost.setAttribute('aria-hidden', 'true');
      Object.assign(ghost.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px' }); document.body.append(ghost);
      const a = play(ghost, [start, { opacity: 0, transform: 'translateY(-4px) scale(.96)' }], { duration: 150, easing: ease, fill: 'forwards' });
      const timer = setTimeout(() => ghost.remove(), 300); a?.finished.catch(() => {}).then(() => { clearTimeout(timer); ghost.remove(); });
    }
    menu.hidden = true; trigger?.setAttribute('aria-expanded', 'false');
    if (returnFocus) menuReturnFocus?.focus({ preventScroll: true });
  }
  function showMenu(button) {
    if (!menu) menu = document.getElementById('quick-actions-menu');
    if (!menu) return;
    if (!menu.hidden) { hideMenu(true); return; }
    trigger = button; menuReturnFocus = button; menu.hidden = false; trigger.setAttribute('aria-expanded', 'true');
    const r = button.getBoundingClientRect(), w = menu.offsetWidth, h = menu.offsetHeight;
    const x = Math.max(8, Math.min(innerWidth - w - 8, r.right - w));
    const below = r.bottom + 6 + h <= innerHeight - 8;
    const y = below ? r.bottom + 6 : Math.max(8, r.top - h - 6);
    Object.assign(menu.style, { left: x + 'px', top: y + 'px', transformOrigin: `${Math.max(0, Math.min(w, r.left + r.width / 2 - x))}px ${below ? 'top' : 'bottom'}` });
    if (!keyboard && !reduced.matches) menuAnimation = play(menu, [{ opacity: 0, transform: `translateY(${below ? -6 : 6}px) scale(.94)` }, { opacity: 1, transform: 'none' }], { duration: 240, easing: ease });
    menu.querySelector('button')?.focus({ preventScroll: true });
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('#quick-actions');
    if (button) { showMenu(button); return; }
    if (!menu || menu.hidden) return;
    const item = event.target.closest('[data-menu-action]');
    if (item) {
      hideMenu(true);
      if (item.dataset.menuAction === 'shelf') window.shelf?.show();
      else if (item.dataset.menuAction === 'commands') window.cmdkShow?.();
    } else if (!menu.contains(event.target) || event.target.closest('[role=menuitem]')) hideMenu(!!menu.contains(event.target));
  });
  document.addEventListener('keydown', event => {
    if (event.target.closest('#quick-actions') && event.key === 'ArrowDown' && (!menu || menu.hidden)) {
      event.preventDefault(); showMenu(event.target.closest('#quick-actions')); return;
    }
    if (!menu || menu.hidden) return;
    const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
    if (event.key === 'Escape' || event.key === 'Tab') { hideMenu(event.key === 'Escape'); if (event.key === 'Escape') event.preventDefault(); }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const i = buttons.indexOf(document.activeElement), d = event.key === 'ArrowUp' ? -1 : 1;
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (i + d + buttons.length) % buttons.length]?.focus();
    }
  });
  window.addEventListener('resize', () => { hideMenu(); syncNavigation(true); syncSegments(); });
  document.addEventListener('scroll', () => hideMenu(), { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => { hideMenu(); syncNavigation(true); });
  reduced.addEventListener('change', () => {
    document.querySelectorAll('[data-motion-key]').forEach(el=>layoutAnimations.get(el)?.cancel());
    document.querySelectorAll('#view,.nav-sub,.nav-sub button,.subnav-highlight').forEach(el=>el.getAnimations().forEach(a=>a.cancel()));
    if(reduced.matches){document.documentElement.classList.remove('theming');document.querySelectorAll('.nav-sub.leaving').forEach(el=>el.remove());}
    syncNavigation(true); syncSegments(); hideMenu();
    document.querySelectorAll('dialog[open]').forEach(d => {
      const entry = dialogs.get(d); if (entry?.phase === 'closing') closeImmediately(d); else stop(entry);
    });
  });
  function closeImmediately(d) { const entry = dialogs.get(d); stop(entry); dialogs.delete(d); d.close(); }
  const pageAnimations = new WeakMap();
  let pageSwapToken = 0;
  function transitionPage(element, subsection = false) {
    pageAnimations.get(element)?.cancel();
    if (keyboard || reduced.matches || document.hidden) return;
    // Magpie side-nav pages fade; inner content swaps enter from 2px below.
    const animation=play(element,subsection?[{opacity:.5,transform:'translateY(2px)'},{opacity:1,transform:'none'}]:[{opacity:0},{opacity:1}],{duration:subsection?220:240,easing:'cubic-bezier(.2,.8,.2,1)'});
    if(animation)pageAnimations.set(element,animation);
  }
  async function swapPage(element, renderPage, { subsection = false } = {}) {
    const token = ++pageSwapToken;
    pageAnimations.get(element)?.cancel();
    if (keyboard || reduced.matches || document.hidden || !element.getClientRects().length) {
      renderPage();
      // Only main page switches restart from the top; subsection swaps keep the reading position.
      if (!subsection) { element.scrollTop = 0; document.scrollingElement.scrollTop = 0; }
      return;
    }
    const drawn = getComputedStyle(element);
    const exit = play(element, [
      { opacity: drawn.opacity, transform: drawn.transform === 'none' ? 'none' : drawn.transform },
      { opacity: subsection ? .5 : 0, transform: subsection ? 'none' : 'translateY(-4px)' },
    ], { duration: subsection ? 120 : 140, easing: ease, fill: 'forwards' });
    if (exit) pageAnimations.set(element, exit);
    try { await Promise.race([exit?.finished, new Promise(resolve => setTimeout(resolve, subsection ? 160 : 180))]); }
    catch { /* A newer swap can cancel this exit. */ }
    if (token !== pageSwapToken) return;
    exit?.cancel();
    renderPage();
    if (!subsection) { element.scrollTop = 0; document.scrollingElement.scrollTop = 0; }
    const entry = play(element, [
      { opacity: subsection ? .5 : 0, transform: subsection ? 'translateY(2px)' : 'translateY(6px)' },
      { opacity: 1, transform: 'none' },
    ], { duration: subsection ? 220 : 240, easing: 'cubic-bezier(.2,.8,.2,1)' });
    if (entry) pageAnimations.set(element, entry);
  }
  // Shared controls keep their screen-space position across a synchronous layout change.
  const layoutAnimations = new WeakMap();
  function relayout(container, change) {
    if(!container){change();return;}
    const rects=new Map();
    container.querySelectorAll('[data-motion-key]').forEach(el=>{
      if(el.getClientRects().length)rects.set(el.dataset.motionKey,el.getBoundingClientRect());
    });
    container.querySelectorAll('[data-motion-key]').forEach(el=>layoutAnimations.get(el)?.cancel());
    change();
    if(keyboard||reduced.matches||document.hidden)return;
    container.querySelectorAll('[data-motion-key]').forEach(el=>{
      if(!el.getClientRects().length)return;
      const from=rects.get(el.dataset.motionKey),to=el.getBoundingClientRect();
      const frames=from?[{transform:`translate(${from.left-to.left}px,${from.top-to.top}px)`},{transform:'none'}]:[{opacity:0,transform:'translateY(2px)'},{opacity:1,transform:'none'}];
      const animation=play(el,frames,{duration:280,easing:'cubic-bezier(.2,.8,.2,1)'});
      if(animation)layoutAnimations.set(el,animation);
    });
  }
  function revealSubnavigation(element) {
    if (keyboard || reduced.matches || document.hidden) return;
    const css=getComputedStyle(element),navEase='cubic-bezier(.32,.72,0,1)';
    element.classList.add('moving');
    const animation=play(element,[{height:'0px',marginTop:'0px',marginBottom:'0px',opacity:0},{height:element.offsetHeight+'px',marginTop:css.marginTop,marginBottom:css.marginBottom,opacity:1}],{duration:300,easing:navEase});
    animation?.finished.catch(()=>{}).finally(()=>element.classList.remove('moving'));
    element.querySelectorAll('button').forEach((row,i)=>play(row,[{opacity:0,transform:'translateY(-6px)'},{opacity:1,transform:'none'}],{duration:260,delay:40+Math.min(i,12)*20,easing:navEase,fill:'backwards'}));
    play(element.querySelector('.subnav-highlight'),[{opacity:0},{opacity:1}],{duration:200,delay:80,fill:'backwards'});
  }
  function hideSubnavigation(element) {
    element.inert=true;element.classList.add('leaving');element.removeAttribute('id');
    element.querySelectorAll('[role=tab]').forEach(row=>{row.removeAttribute('data-subnav');row.tabIndex=-1;});
    if(keyboard||reduced.matches||document.hidden){element.remove();return;}
    const css=getComputedStyle(element);element.classList.add('moving');
    const animation=play(element,[{height:element.offsetHeight+'px',marginTop:css.marginTop,marginBottom:css.marginBottom,opacity:1},{height:'0px',marginTop:'0px',marginBottom:'0px',opacity:0}],{duration:240,easing:'cubic-bezier(.32,.72,0,1)',fill:'forwards'});
    if(!animation){element.remove();return;}
    const deadline=setTimeout(()=>element.remove(),320);
    animation.finished.catch(()=>{}).finally(()=>{clearTimeout(deadline);element.remove();});
  }
  window.uiMotion = { adoptSegment, relayout, openDialog, closeDialog, syncNavigation, syncSegments, hideMenu, transitionPage, swapPage, revealSubnavigation, hideSubnavigation };
  syncSegments();
})();

</script>
<script>
/* Canonical Magpie segments. Native selects retain the existing form/change contract. */
(() => {
  'use strict';
  const entries = new WeakMap(), pending = new Map();
  let queued = false, nextId = 0;
  function syncSelect(select) {
    if (select.multiple || select.size > 1 || !select.options.length) return;
    let entry = entries.get(select);
    if (!entry || !entry.box.isConnected) {
      const box = document.createElement('div');
      box.className = 'chart-mode segment-choice';
      if (select.closest('.reminders-block,.statistics-controls') || select.dataset.segmentWrap === 'wrap') box.classList.add('segment-wrap');
      box.setAttribute('role', 'tablist');
      box.dataset.selectFor = select.id || select.dataset.updateInterval !== undefined && 'update-interval' || Object.entries(select.dataset).map(([key,value])=>key+':'+value).join('|') || 'choice-' + (++nextId);
      const label = select.getAttribute('aria-label') || [...(select.labels?.[0]?.childNodes || [])].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim() || '选择选项';
      box.setAttribute('aria-label', label);
      select.classList.add('segment-source');select.tabIndex = -1;select.setAttribute('aria-hidden', 'true');
      select.after(box);entry = { box, signature: '' };entries.set(select, entry);
      box.addEventListener('click', event => {
        const button = event.target.closest('[data-choice-index]');
        if (!button || button.disabled) return;
        event.preventDefault();
        const index = Number(button.dataset.choiceIndex);
        if (select.selectedIndex === index) return;
        const thumb=box.querySelector('.segment-highlight');
        if(thumb)pending.set(box.dataset.selectFor,{box,rect:thumb.getBoundingClientRect(),at:performance.now()});
        select.selectedIndex = index;
        syncSelect(select);window.uiMotion?.syncSegments();
        select.dispatchEvent(new Event('change', { bubbles: true }));
        if(box.isConnected)pending.delete(box.dataset.selectFor);
      });
      select.addEventListener('change', () => {syncSelect(select);window.uiMotion?.syncSegments();});
      select.addEventListener('invalid', event => { event.preventDefault();box.setAttribute('aria-invalid', 'true');box.querySelector('button:not(:disabled)')?.focus({ preventScroll: true }); });
    }
    const options = [...select.options];
    const signature = JSON.stringify(options.map(o => [o.value, o.label, o.disabled]));
    if (entry.signature !== signature) {
      entry.signature = signature;const thumb=entry.box.querySelector('.segment-highlight');entry.box.replaceChildren(...(thumb?[thumb]:[]));
      options.forEach((option, index) => {
        const button = document.createElement('button');button.type = 'button';button.setAttribute('role', 'tab');
        button.dataset.choiceIndex = String(index);button.textContent = option.label;button.title = option.label;
        entry.box.append(button);
      });
    }
    entry.box.querySelectorAll('button').forEach((button, index) => {
      const active = index === select.selectedIndex;
      button.classList.toggle('active', active);button.setAttribute('aria-selected', String(active));button.tabIndex = active ? 0 : -1;
      button.disabled = select.disabled || options[index].disabled;
    });
    if (select.validity.valid) entry.box.removeAttribute('aria-invalid');
    const active = entry.box.querySelector('button.active');
    if (active && entry.box.clientWidth && (active.offsetLeft < entry.box.scrollLeft || active.offsetLeft + active.offsetWidth > entry.box.scrollLeft + entry.box.clientWidth)) {
      entry.box.scrollLeft = Math.max(0, active.offsetLeft - (entry.box.clientWidth - active.offsetWidth) / 2);
    }
  }
  function sync() {
    document.querySelectorAll('#view select,dialog select,.file-shelf select,.share-surface select').forEach(syncSelect);
    window.uiMotion?.syncSegments();
    document.querySelectorAll('.segment-choice').forEach(box=>{const previous=pending.get(box.dataset.selectFor);if(!previous)return;if(previous.box!==box&&performance.now()-previous.at<1000)window.uiMotion?.adoptSegment(box,previous.rect);pending.delete(box.dataset.selectFor);});
  }
  function schedule() { if (!queued) { queued = true;requestAnimationFrame(() => { queued = false;sync(); }); } }
  new MutationObserver(records => {
    if (records.some(r => r.target.closest?.('select') || [...r.addedNodes].some(n => n.nodeType === 1 && (n.matches('select') || n.querySelector('select'))))) schedule();
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected'] });
  window.addEventListener('workspace-render', schedule);
  window.addEventListener('appearance-changed', schedule);
  window.addEventListener('resize', schedule);
  window.formControls = { sync, schedule };sync();
})();

</script>
<script>
(() => {
  'use strict';
  // The desktop shell turns native drops into a `native-files` event, so the
  // browser drag events stay unused there and the page is filled from that path.
  const nativeDrop = () => Boolean(window.desktop?.nativeFileDrop);
  function host(input) {
    return input.closest('.share-drop,.file-picker');
  }
  function paint(input) {
    const box = host(input);
    if (!box) return;
    let note = box.querySelector('.picker-name');
    if (!note) {
      note = document.createElement('small');
      note.className = 'picker-name';
      box.append(note);
    }
    const files = [...input.files || []];
    note.textContent = files.length ? files.map(file => file.name).join('、') : '未选择文件';
    box.classList.toggle('has-files', files.length > 0);
  }
  function fill(input, files) {
    const list = [...files || []];
    if (!input || input.disabled || !list.length) return false;
    const transfer = new DataTransfer();
    for (const file of list) transfer.items.add(file);
    input.files = transfer.files;
    paint(input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  function dropInput(target) {
    if (!(target instanceof Element)) return null;
    const box = target.closest('.file-picker,.share-drop');
    if (!box) return null;
    const input = box.querySelector('input[type=file]');
    return input && !input.disabled ? input : null;
  }
  const isFileDrag = event => [...event.dataTransfer?.types || []].includes('Files');
  function clearDrag() {
    document.querySelectorAll('.file-picker.drag-target,.share-drop.drag-target').forEach(el => el.classList.remove('drag-target'));
  }
  function markTarget(input) {
    const box = host(input);
    document.querySelectorAll('.file-picker.drag-target,.share-drop.drag-target').forEach(el => { if (el !== box) el.classList.remove('drag-target'); });
    box?.classList.add('drag-target');
  }
  document.addEventListener('dragover', event => {
    if (nativeDrop() || !isFileDrag(event)) return;
    const input = dropInput(event.target);
    if (!input) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    markTarget(input);
  });
  document.addEventListener('dragleave', event => {
    if (nativeDrop() || !(event.target instanceof Element) || event.relatedTarget) return;
    if (event.target.closest('.file-picker,.share-drop')) clearDrag();
  });
  document.addEventListener('drop', event => {
    if (nativeDrop()) return;
    const input = dropInput(event.target);
    if (!input) return;
    event.preventDefault();
    event.stopPropagation();
    clearDrag();
    fill(input, event.dataTransfer?.files);
  });
  document.addEventListener('dragend', clearDrag);
  document.addEventListener('change', event => {
    if (event.target.matches('input[type=file]')) paint(event.target);
  });
  document.addEventListener('input', event => {
    if (event.target.matches('input[type=file]')) paint(event.target);
  });
  window.desktop?.on?.('native-files', payload => {
    const picker = payload?.picker || '';
    const files = payload?.files || [];
    if (!picker || !files.length) return;
    const box = document.querySelector('[data-native-picker="' + picker + '"]');
    const input = box?.querySelector('input[type=file]');
    if (!input) return;
    const transfer = new DataTransfer();
    for (const file of files) {
      try {
        const binary = atob(file.data || '');
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        transfer.items.add(new File([bytes], file.name || 'file', { type: file.type || 'application/octet-stream' }));
      } catch (error) { /* skip unreadable payload */ }
    }
    if (!transfer.files.length) return;
    input.files = transfer.files;
    paint(input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  window.filePickers = { paint, fill };
})();

</script><script>
const paths={
  inbox: '<path d="M3 4h14l3 9v7H0v-7L3 4Z" transform="translate(2 0)"/><path d="M3 13h5l2 3h4l2-3h5"/>',
  check: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>',
  connect: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/><path d="M17 3v6h4M3 17h6v4M9 17l8-8"/>',
  chart: '<path d="M4 3v17h17M8 16v-5M13 16V6M18 16V9"/>',
  settings: '<path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z"/><circle cx="12" cy="12" r="3"/>',
  refresh: '<path d="M20 10a8 8 0 1 0-2 8M20 4v6h-6"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
  logout: '<path d="M10 4H4v16h6M12 12h9m-4-4 4 4-4 4"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  file: '<path d="M5 3h9l5 5v13H5V3Z"/><path d="M14 3v6h5M9 13h6M9 17h5"/>',
  share: '<circle cx="6" cy="12" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="m9 11 6-3.5M9 13l6 3.5"/>',
};
document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true">'+(paths[el.dataset.icon]||paths.file)+'</svg>');
document.querySelector('.brand img').src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"48\" height=\"48\" viewBox=\"0 0 48 48\"><rect width=\"48\" height=\"48\" rx=\"14\" fill=\"#245a43\"/><path d=\"M12 16h24v20H12z\" fill=\"none\" stroke=\"#fff\" stroke-width=\"2.4\" stroke-linejoin=\"round\"/><path d=\"M10 16l5-6h18l5 6M18 23h12M20 29l3 3 6-7\" fill=\"none\" stroke=\"#fff\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>\n");
document.querySelector('.brand').onclick=e=>{e.preventDefault();navigate('inbox')};
const labels={settings:'设置',inbox:'通知',tasks:'待办',files:'文件',sources:'消息来源',stats:'统计'};
const state={page:'settings'};let page='settings';window.desktop={};
function renderPage(next){document.querySelectorAll('[data-page]').forEach(el=>el.hidden=el.dataset.page!==next);document.getElementById('breadcrumb').textContent=labels[next];window.pageNavigation?.sync();}
async function navigate(next){if(page===next)return;page=next;state.page=next;document.querySelectorAll('[data-nav]').forEach(el=>el.classList.toggle('active',el.dataset.nav===next));uiMotion.syncNavigation();await uiMotion.swapPage(document.getElementById('view'),()=>renderPage(next));}
document.querySelectorAll('[data-nav]').forEach(el=>el.onclick=()=>navigate(el.dataset.nav));
document.addEventListener('click',event=>{
 const tab=event.target.closest('.chart-mode>button');if(!tab)return;
 if(tab.hasAttribute('data-choice-index'))return;
 const group=tab.parentElement;group.querySelectorAll('button').forEach(b=>{b.classList.toggle('active',b===tab);b.setAttribute('aria-selected',String(b===tab));b.tabIndex=b===tab?0:-1;});
 if(tab.dataset.refSource){uiMotion.relayout(document.querySelector('[data-settings-panel="model"]'),()=>{document.querySelector('[data-ref-custom]').hidden=tab.dataset.refSource!=='custom';document.querySelector('[data-ref-default]').hidden=tab.dataset.refSource==='custom';});}
 uiMotion.syncSegments();
});
const dialog=document.getElementById('reference-profile');
document.querySelectorAll('[data-open-profile]').forEach(b=>b.onclick=()=>uiMotion.openDialog(dialog));
document.querySelectorAll('[data-close-profile]').forEach(b=>b.onclick=()=>uiMotion.closeDialog(dialog));
dialog.querySelector('form').onsubmit=e=>{e.preventDefault();uiMotion.closeDialog(dialog)};
document.querySelector('[data-choose]').onclick=()=>document.getElementById('reference-file').click();
document.querySelector('.file-picker').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();document.getElementById('reference-file').click();}};
document.querySelector('[data-relayout]').onclick=()=>{const c=document.getElementById('reference-layout');uiMotion.relayout(c,()=>c.insertBefore(c.lastElementChild,c.firstElementChild));};
document.querySelectorAll('[data-feedback]').forEach(b=>b.onclick=()=>{const status=document.getElementById('sync-state');status.textContent='样板操作完成';setTimeout(()=>status.textContent='已同步',1400)});
renderPage(page);document.querySelector('[data-nav="settings"]').classList.add('active');appearance.refresh();uiMotion.syncNavigation(true);uiMotion.syncSegments();
</script><script>/* Contextual sidebar tabs, following Magpie's indented rows and single moving selection. */
(() => {
  'use strict';
  const definitions = {
    settings: [
      ['general','常规','#settings-appearance'],
      ['quick','快捷收集','#settings-quick'],
      ['startup','启动与更新','#settings-launcher'],
      ['model','模型连接','#model-settings'],
      ['account','我的','#account-panel'],
      ['admin','站点管理','#admin-panel'],
    ],
    sources: [
      ['overview','概览','*'],['qq','QQ 消息','.source-card:first-child'],
      ['wechat','微信消息','.source-card:last-child'],['advanced','高级与调试','.advanced-source'],
    ],
    stats: [
      ['overview','概览','*'],['tokens','Token 消耗','#chart-tokens'],
      ['response','响应情况','#chart-latency,#chart-status'],['recent','最近调用','#statistics-recent'],
    ],
  };
  const chosen = new Map();
  const descriptions={general:'选择适合当前设备的颜色、文字和信息密度。',quick:'设置快捷收集的启用方式和窗口内容。',startup:'管理开机启动与客户端更新。',model:'选择服务器提供的 AI，或连接自己的模型接口。',account:'管理个人资料与工作区数据。',admin:'管理站点注册、邀请码、邮件与账号。'};
  let signature='', currentBox, queued=false, selectionAnimation;
  const sidebarQuery=matchMedia('(max-width:820px)');
  const sidebarKey='jjb-sidebar-mode';
  const readSidebarMode=()=>['icons','labels'].includes(localStorage.getItem(sidebarKey))?localStorage.getItem(sidebarKey):sidebarQuery.matches?'icons':'labels';
  const sidebarButton=document.getElementById('sidebar-toggle');
  function applySidebarMode(mode,animate=true){
    const previous=document.documentElement.dataset.sidebar;
    document.documentElement.dataset.sidebar=mode;
    document.querySelectorAll('[data-nav]').forEach(button=>{
      if(button.title&&!button.dataset.navTitle)button.dataset.navTitle=button.title;
      const label=button.dataset.navTitle||'';
      if(mode==='icons')button.title=label;
      else button.removeAttribute('title');
    });
    const expanded=mode==='labels';
    sidebarButton?.setAttribute('aria-pressed',String(expanded));
    if(sidebarButton){
      sidebarButton.title=expanded?'切换为图标模式':'切换为图标 + 文字';
      sidebarButton.setAttribute('aria-label',expanded?'切换为图标模式':'切换为图标 + 文字');
    }
    if(previous&&previous!==mode&&animate)uiMotion.transitionPage(view,true);
    sync();
  }
  sidebarButton?.addEventListener('click',()=>{
    const mode=readSidebarMode()==='icons'?'labels':'icons';
    try{localStorage.setItem(sidebarKey,mode);}catch{}
    applySidebarMode(mode);
  });
  sidebarQuery.addEventListener('change',()=>{
    if(['icons','labels'].includes(localStorage.getItem(sidebarKey)))return;
    applySidebarMode(sidebarQuery.matches?'icons':'labels');
  });
  const view = document.querySelector('#view');
  const breadcrumb=document.createElement('span');breadcrumb.className='breadcrumb-sub';breadcrumb.hidden=true;breadcrumb.innerHTML='<span class="breadcrumb-separator" aria-hidden="true">/</span><span class="breadcrumb-sub-label" aria-current="page"></span>';document.querySelector('.breadcrumb').append(breadcrumb);
  const breadcrumbLabel=breadcrumb.querySelector('.breadcrumb-sub-label');
  const mobileTabs=document.createElement('div');mobileTabs.className='page-tabs';mobileTabs.setAttribute('role','tablist');mobileTabs.setAttribute('aria-label','栏目内页面');view.before(mobileTabs);
  mobileTabs.addEventListener('click',e=>{const b=e.target.closest('[data-subnav]');if(b)select(b.dataset.subnav);});
  mobileTabs.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();e.stopPropagation();const rows=[...mobileTabs.querySelectorAll('button')],i=rows.indexOf(document.activeElement),target=rows[e.key==='Home'?0:e.key==='End'?rows.length-1:(i+(e.key==='ArrowLeft'?-1:1)+rows.length)%rows.length];select(target.dataset.subnav);target.focus({preventScroll:true});});
  const node = selector => view.querySelector(selector);
  function pageItems(page) {
    if(page.startsWith('plugin:'))return window.pluginUI?.children(page)||[];
    return definitions[page]||[];
  }
  function navParent(page) {
    return document.querySelector(`[data-nav="${CSS.escape(page)}"]`)||document.querySelector('[data-nav=plugins]');
  }
  function visibleGroups(page,key) {
    const show=(el,yes)=>{if(el)el.hidden=!yes;};
    if(page.startsWith('plugin:'))window.pluginUI?.showChild(page,key,node('#plugin-page'));
    if(page==='settings'){
      for(const [id,,selector] of definitions.settings)show(node(selector),id===key);
      show(node('#appearance-panel-marker'),['general','quick','startup'].includes(key));
    }
    if(page==='sources'){
      show(node('.auto-source-panel'),key==='overview');
      show(node('.source-grid'),['overview','qq','wechat'].includes(key));
      show(node('.source-card:first-child'),['overview','qq'].includes(key));
      show(node('.source-card:last-child'),['overview','wechat'].includes(key));
      show(node('.advanced-source'),['overview','advanced'].includes(key));
      const advanced=node('.advanced-source');if(advanced&&key==='advanced')advanced.open=true;
      node('.source-grid')?.classList.toggle('single-source',key!=='overview');
    }
    if(page==='stats'){
      for(const chart of ['chart-tokens','chart-latency','chart-status']){
        const yes=key==='overview'||key==='tokens'&&chart==='chart-tokens'||key==='response'&&chart!=='chart-tokens';
        show(node('#'+chart)?.closest('section'),yes);
      }
      show(node('.statistics-grid'),key!=='recent');
      show(node('#statistics-summary'),key==='overview');
      show(node('#statistics-credit'),key==='overview'&&view.dataset.statisticsSource==='managed');
      show(node('#statistics-models'),['overview','tokens'].includes(key));
      show(node('#statistics-recent')?.closest('section'),['overview','recent'].includes(key));
    }
  }
  function glide(selected,animate) {
    if(!selected)return;
    const thumb=currentBox.querySelector('.subnav-highlight');
    const before=getComputedStyle(thumb).transform,previousTarget=thumb.style.transform,previousHeight=thumb.style.height;
    const to=`translateY(${selected.offsetTop}px)`,height=selected.offsetHeight+'px';
    if(previousTarget===to&&previousHeight===height)return;
    selectionAnimation?.cancel();thumb.style.transform=to;thumb.style.height=height;
    if(animate&&document.documentElement.dataset.inputMethod==='pointer'&&!matchMedia('(prefers-reduced-motion:reduce)').matches&&previousTarget){
      selectionAnimation=thumb.animate([{transform:before,height:previousHeight},{transform:to,height}],{duration:240,easing:'cubic-bezier(.23,1,.32,1)'});
    }
  }
  function select(key,animate=true) {
    const page=state.page;
    const rows=[...currentBox.querySelectorAll('[data-subnav]')];
    if(!rows.some(row=>row.dataset.subnav===key))return;
    chosen.set(page,key);
    mobileTabs.querySelectorAll('button').forEach(b=>{const active=b.dataset.subnav===key;b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;});
    rows.forEach(row=>{const active=row.dataset.subnav===key;row.classList.toggle('active',active);row.setAttribute('aria-selected',String(active));row.tabIndex=active?0:-1;});
    const selected=rows.find(row=>row.dataset.subnav===key);
    glide(selected,true);uiMotion.syncSegments();
    const apply=()=>{
      visibleGroups(page,key);
      if(breadcrumbLabel.textContent!==selected.textContent)breadcrumbLabel.textContent=selected.textContent;breadcrumb.hidden=false;
      document.getElementById('breadcrumb').removeAttribute('aria-current');
      view.setAttribute('role','tabpanel');view.setAttribute('aria-label',selected.textContent);
      const description=node('.page-heading p');
      if(page==='settings'&&description&&description.textContent!==descriptions[key])description.textContent=descriptions[key]||'';
      uiMotion.syncSegments();
    };
    if(animate)uiMotion.swapPage(view,apply,{subsection:true});
    // The render-driven sync path must never move the viewport.
    else apply();
  }
  function sync() {
    const page=state.page;
    const items=pageItems(page).filter(([, , selector])=>page.startsWith('plugin:')||selector==='*'||node(selector));
    // Sources are managed from the desktop; the web page retains its explanation.
    if(page==='sources'&&!window.desktop)items.length=0;
    const next=page+':'+items.map(item=>item[0]).join(',');
    const fresh=next!==signature;
    if(fresh){
      signature=next;selectionAnimation?.cancel();document.querySelectorAll('.nav-sub.leaving').forEach(box=>box.remove());if(currentBox)uiMotion.hideSubnavigation(currentBox);currentBox=null;mobileTabs.replaceChildren();mobileTabs.hidden=!items.length;breadcrumb.hidden=!items.length;
      if(!items.length){document.getElementById('breadcrumb').setAttribute('aria-current','page');view.removeAttribute('role');view.removeAttribute('aria-label');}
      document.querySelectorAll('[data-nav]').forEach(b=>{b.removeAttribute('aria-expanded');b.removeAttribute('aria-controls');});
      if(items.length){
        currentBox=document.createElement('div');currentBox.className='nav-sub';currentBox.id='page-subnav';
        currentBox.setAttribute('role','tablist');currentBox.setAttribute('aria-orientation','vertical');currentBox.setAttribute('aria-label','栏目内页面');
        currentBox.innerHTML='<span class="subnav-highlight" aria-hidden="true"></span>';
        for(const [key,label] of items){const b=document.createElement('button');b.type='button';b.dataset.subnav=key;b.textContent=label;b.setAttribute('role','tab');b.setAttribute('aria-controls','view');currentBox.append(b);mobileTabs.append(b.cloneNode(true));}
        const parent=navParent(page);parent.after(currentBox);parent.setAttribute('aria-expanded','true');parent.setAttribute('aria-controls','page-subnav');
        currentBox.addEventListener('click',e=>{const b=e.target.closest('[data-subnav]');if(b&&chosen.get(state.page)!==b.dataset.subnav)select(b.dataset.subnav);});
        currentBox.addEventListener('pointerdown',e=>{if(e.button===0)glide(e.target.closest('[data-subnav]'),true);});
        currentBox.addEventListener('pointercancel',()=>glide(currentBox.querySelector('[aria-selected=true]'),true));
        currentBox.addEventListener('pointerleave',e=>{if(e.buttons&1)glide(currentBox.querySelector('[aria-selected=true]'),true);});
        currentBox.addEventListener('keydown',e=>{
          if(!['ArrowUp','ArrowDown','Home','End'].includes(e.key))return;e.preventDefault();e.stopPropagation();
          const rows=[...currentBox.querySelectorAll('button')],index=rows.indexOf(document.activeElement);
          const target=rows[e.key==='Home'?0:e.key==='End'?rows.length-1:(index+(e.key==='ArrowUp'?-1:1)+rows.length)%rows.length];
          select(target.dataset.subnav);target.focus({preventScroll:true});
        });
        uiMotion.revealSubnavigation(currentBox);
      }
    }
    if(currentBox){const key=chosen.get(page);select(items.some(item=>item[0]===key)?key:items[0][0],false);}
    uiMotion.syncNavigation();
  }
  new MutationObserver(()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;sync();});}).observe(view,{childList:true,subtree:true});
  window.addEventListener('appearance-changed',sync);
  window.addEventListener('resize',sync);
  matchMedia('(prefers-reduced-motion:reduce)').addEventListener('change',()=>{selectionAnimation?.cancel();sync();});
  window.pageNavigation={sync};
  applySidebarMode(readSidebarMode(),false);
  sync();
})();
</script><script>document.querySelector("#page-subnav [data-subnav=account]")?.click();</script>
</body></html>
````

</details>

### 13.7 本次复现验证记录

- 从本文单独提取 HTML 到隔离目录，字节与冻结样板完全一致，SHA-256 校验通过。
- 在隔离目录运行从本文提取的样板，按固定 Windows / Edge、主题、视口和数据生成对照图。源码以 SHA-256 校验；截图按布局、控件状态和像素外观检查，不把 PNG 文件编码哈希当作跨次渲染一致性的保证。
- 样板运行无外部 HTTP 请求、无页面错误；6 个宽度 × 2 种密度 × 2 种字号，共 24 个布局组合无全页横向溢出。
- 快速切换后分段高亮位置误差 0.078125px；弹窗开关、文件选择与减少动态效果检查通过。
- v1.2 修正：删除样板手写的二级目录显隐控制，直接内联主程序 `web/navigation.js`。设置、统计、消息来源复用真实目录展开/收起和子页切换；回归检查捕获到 6 次进入和 6 次退出，均实际播放动画，快速切换无残留退出目录，表单草稿保留。
- 该记录证明内嵌样板可独立运行与复现，不等于全部业务界面已经重新验收。
