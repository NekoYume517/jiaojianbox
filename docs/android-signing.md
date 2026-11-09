# 安卓签名固定规则

交件箱的安卓包只有一套签名身份，并且永远不变：

| 项目 | 值 |
| --- | --- |
| 别名 | `androiddebugkey` |
| 证书 SHA-256 | `256994e591fe61061ed76b88aabe518f140deefb4dab7f947d64e461dbb158ab` |
| 密钥库格式 | PKCS12 |
| 存储密码 / 密钥密码 | `android` |
| 文件名 | `jiaojianbox-signing.keystore` |
| 大小 | 2618 字节 |
| 密钥库 SHA-256 | `eff021f82202cf3d09686f4c77352fa001324fabac30535cdd26ec8a6dc83dad` |

已发布的 `v0.6.4` 就是这一套签名，之后所有版本必须继续用它。**不要重新生成密钥库。**

## 为什么不能换

安卓只允许同一签名的包覆盖安装。换了密钥，用户必须卸载旧版才能装新版，本地数据会一起没掉。历史上出现过这个问题：

- `v0.6.2` 及更早的包由 CI 在每台机器上自动生成临时调试密钥，于是每个版本签名都不同。
- `v0.6.4` 起改为固定密钥，此后的版本都可以直接覆盖升级。

## 密钥放在哪里

密钥库不进公开仓库，保存在三处：

1. GitHub Actions Secret `JJB_ANDROID_DEBUG_KEYSTORE`（base64 值），发布流水线使用它。
2. 自建 Git `git.bansonic.top/zzy/jiaojianbox` 的 `signing-key` 分支（私有）。
3. 打包机本地：`android/keystore/jiaojianbox-signing.keystore`（已在 `.gitignore` 中）。

## 构建怎么用

`android/app/build.gradle.kts` 按以下顺序取密钥，debug 和 release 变体都用它：

1. 环境变量 `JJB_ANDROID_KEYSTORE_PATH`；
2. `android/keystore/jiaojianbox-signing.keystore`。

两者都没有时构建**直接失败**，不会再悄悄生成随机调试密钥。密码可用
`JJB_ANDROID_KEYSTORE_PASSWORD`、`JJB_ANDROID_KEY_ALIAS`、`JJB_ANDROID_KEY_PASSWORD` 覆盖，
默认就是上表的值。

## 怎么校验

```bash
python scripts/verify-android-signing.py
python scripts/verify-android-signing.py --apk android/app/build/outputs/apk/debug/app-debug.apk
```

脚本把证书 SHA-256 与上表固定值比较，不一致就返回非零。它已经接在三个位置：

- 发布流水线：还原密钥后先校验密钥库，构建后再校验 APK，任一不符就终止发布；
- `Android signing identity` 工作流：改动 `android/**` 时、以及每周一自动校验 Secret 是否仍然一致；
- `docs/verification` 里的本地检查。

Secret 被删除或被替换时会立刻失败，不会静默发出一批装不上的包。

## 万一要换

只有一种情况需要换：主动放弃老用户的覆盖升级。那必须同时改
`scripts/verify-android-signing.py` 里的固定指纹、本文档、以及发布说明中的卸载提示，
并明确告知用户先同步数据再卸载重装。
