# Windows 文件拖动检测

资料：
- Microsoft SetWinEventHook：https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook
- Microsoft 事件常量：https://learn.microsoft.com/en-us/windows/win32/winauto/event-constants
- .NET WinForms AccessibleEvents 源码说明：https://source.dot.net/System.Windows.Forms/System/Windows/Forms/Accessibility/AccessibleEvents.cs.html
- Microsoft Q&A 中基于 SysDragImage 的探测：https://learn.microsoft.com/en-us/answers/questions/2244534/how-to-detect-system-wide-drag-drop-start-outside

实现采用 out-of-context WinEvent 钩子，并对当前每个 `explorer.exe` 进程分别限定拖放事件范围；`SysDragImage` 兼容回退进一步限定到资源管理器窗口所属的 UI 线程。优先接收 `EVENT_SYSTEM_DRAGDROPSTART/END` 与 `EVENT_OBJECT_DRAGSTART/CANCEL/COMPLETE`；Explorer 未上报这些文档化事件时，仅以 `SysDragImage` 的显示、隐藏和销毁作为兼容回退。没有向 Explorer 注入模块，也不在检测时调用 `IDataObject` 或读取拖动文件内容。

旧版的 32ms 全局轮询和 `FindWindow("SysDragImage")` 已删除。新增的空闲检查只有每两秒一次的父进程存活检查，以及每 30 秒一次的 Explorer 进程/窗口 UI 线程集合对账；集合变化时自动重挂钩子。拖拽进行中才启动 250ms 的安全结束检查，用于处理 Explorer 没有发送结束事件或取消后未销毁拖动图像的情况。

快捷收集 WebView 在应用启动后预创建。自动拖拽呼出使用 `WS_EX_NOACTIVATE` 包裹 Wails 的显示调用，避免从 Explorer 的 OLE 拖动循环抢走焦点；用户通过快捷键或托盘手动呼出时仍会正常聚焦。自动呼出不再立即请求整份 `/api/snapshot`，避免在拖拽开始的热路径上做数据库和网络工作。

主窗口可见时不自动展开独立快捷窗；隐藏/最小化时系统拖动才自动呼出。手动快捷键始终可用。前端拖入阶段只高亮明确区域：材料、回执、任务卡片直接归属，不调用模型；放入主内容空白处才调用文件分类。搜索后的会话选择仍统计全部勾选项，并本机持久保存。
