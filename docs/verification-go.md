# 0.6.0 重写验收

已在 Windows 执行：

- Go API、SQLite 兼容、安装器与 Windows 凭证测试；Go vet。
- 原有 Python 回归 49 项、Node 回归 4 项。
- 旧 Python 实际创建账号、通知、待办、2 个附件和加密模型配置，交给 Go 读取与修改，再由旧 Python 读取。ID、密码、管理员角色、附件 SHA-256 和密钥保持兼容。
- 原 Electron 45 的 safeStorage 实际生成 v10 凭证，Go 使用原 Local State/DPAPI 读取；退出后的空值标记避免旧凭证复活。
- Wails/WebView2 实际启动，离线登录、退出后重新进入、创建待办、通知、文件页、颜色切换与 390px 窄屏。
- 指定待办原生文件投递不调用 AI；空白区域调用 AI；快捷窗文件投递后保持打开、固定 360×460、可手动关闭、可移动。
- 自定义 EXE 安装程序：170 个文件逐个 SHA-256 校验，独立采集器依赖自检、覆盖升级、卸载，以及保留安装目录中未由安装器管理的文件。
- Android assembleDebug、lintDebug 通过；保留原生 Material 3。

生产切换前另外保存完整数据库、附件和实际加密密钥。新服务端启动前生成 `backups/before-go` 完整快照，可用以下只读命令检查原记录、附件与密钥：

```sh
/app/jiaojianbox-server --data /data --verify-backup before-go
```

该命令允许新增数据，报告原记录是否有后续修改，发现原记录缺失、附件不符或密钥变化时返回失败。更新后仍需核对真实健康状态和原有账号/待办/通知/附件计数。

macOS/Linux 桌面、真实 Android 设备操作，以及用户各版本 QQ/微信的实时采集仍需要对应设备验收。采集器的依赖自检不代表已在每一种微信版本上连接成功。
