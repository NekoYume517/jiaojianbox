# 交件箱动效规范入口

UI 与动效规则已统一到 [《交件箱 UI、控件与动效规范》](ui-design-standard.md)。后续所有界面开发和验收以该文档为准，本文件仅保留旧链接兼容，不维护第二套参数。

- 视觉、布局、控件与文件入口：第 3–7 节。
- 动效时长、共享元素、tab、中断、滚动与降级：第 8 节。
- 系统通知、安装与卸载：第 11 节。
- 开发步骤、验收矩阵与验证入口：第 12 节。

实现继续使用 `web/motion.css` 和 `web/motion.js`，复用 `uiMotion.openDialog`、`closeDialog`、`syncSegments`、`syncNavigation`、`relayout`。快捷收集 `quick.html` 仍不加载该运行时。
