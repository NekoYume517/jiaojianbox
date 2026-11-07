# Windows 文件拖动检测

资料：
- Microsoft SetWinEventHook：https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook
- Microsoft 事件常量：https://learn.microsoft.com/en-us/windows/win32/winauto/event-constants
- .NET WinForms AccessibleEvents 源码说明：https://source.dot.net/System.Windows.Forms/System/Windows/Forms/Accessibility/AccessibleEvents.cs.html
- Microsoft Q&A 中基于 SysDragImage 的探测：https://learn.microsoft.com/en-us/answers/questions/2244534/how-to-detect-system-wide-drag-drop-start-outside

实现采用 out-of-context WinEvent 钩子监听窗口创建/显示/隐藏/销毁，仅匹配 SysDragImage；辅助32ms检查用于遗漏事件、鼠标松开和取消。没有向 Explorer 注入模块，也不在检测时调用 IDataObject 渲染文件。DRAGDROPSTART 依赖源程序发事件，不能当作所有 OLE 拖动都会上报的全局保证。SysDragImage 属于 Explorer 的实现细节，兼容性和实际灵敏度仍需在用户环境实拖验收。

主窗口可见时不自动展开独立快捷窗；隐藏/最小化时系统拖动才自动呼出。手动快捷键始终可用。前端拖入阶段只高亮明确区域：材料、回执、任务卡片直接归属，不调用模型；放入主内容空白处才调用文件分类。搜索后的会话选择仍统计全部勾选项，并本机持久保存。
