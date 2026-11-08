Set shell = CreateObject("WScript.Shell")
shell.Environment("PROCESS").Remove "ELECTRON_RUN_AS_NODE"
shell.CurrentDirectory = "C:\Users\zzy\Documents\Codex\2026-11-07\jie-h\outputs\jiaojianbox"
shell.Run "node_modules\electron\dist\electron.exe .", 1, False
