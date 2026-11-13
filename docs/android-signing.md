# 安卓签名固定规则

交件箱的安卓发布包只有一套签名身份，并且永远不变：

| 项目 | 值 |
| --- | --- |
| 别名 | `androiddebugkey` |
| 证书 SHA-256 | `256994e591fe61061ed76b88aabe518f140deefb4dab7f947d64e461dbb158ab` |
| 密钥库格式 | PKCS12 |
| 文件名 | `jiaojianbox-signing.keystore` |

已发布的 `v0.6.4` 就是这一套签名，之后所有版本必须继续用它。**不要重新生成密钥库。**

签名密码不写入仓库或本文档。CI 通过 `JJB_ANDROID_KEYSTORE_PASSWORD` 注入存储密码；密钥密码与存储密码不同时，再设置 `JJB_ANDROID_KEY_PASSWORD`。别名只在需要时通过 `JJB_ANDROID_KEY_ALIAS` 覆盖。

## 为什么不能换

安卓只允许同一签名的包覆盖安装。换了密钥，用户必须卸载旧版才能装新版，本地数据会一起没掉。历史上出现过这个问题：

- `v0.6.2` 及更早的包由 CI 在每台机器上自动生成临时调试密钥，于是每个版本签名都不同。
- `v0.6.4` 起改为固定密钥，此后的版本都可以直接覆盖升级。

## 密钥放在哪里

密钥库不进公开仓库，保存在三处：

1. GitHub Actions Secret `JJB_ANDROID_STABLE_KEYSTORE`（base64 值）。迁移期间仍兼容读取旧名称 `JJB_ANDROID_DEBUG_KEYSTORE`，新部署应只配置稳定名称。
2. 自建 Git `git.bansonic.top/zzy/jiaojianbox` 的 `signing-key` 分支（私有）。
3. 打包机本地：`android/keystore/jiaojianbox-signing.keystore`（已在 `.gitignore` 中）。

CI 还必须配置 `JJB_ANDROID_KEYSTORE_PASSWORD`；`JJB_ANDROID_KEY_PASSWORD` 只在单独设置密钥密码时使用。

## 构建怎么用

`android/app/build.gradle.kts` 按以下顺序取发布密钥：

1. 环境变量 `JJB_ANDROID_KEYSTORE_PATH`；
2. `android/keystore/signing.properties` 中的 `storeFile`；
3. `android/keystore/jiaojianbox-signing.keystore`。

本机可以把密码保存在被 `.gitignore` 排除的 `android/keystore/signing.properties`。环境变量优先于该文件，因此 CI 不需要创建本地密钥配置：

```properties
storeFile=jiaojianbox-signing.keystore
storePassword=<local secret>
keyAlias=androiddebugkey
keyPassword=<local secret>
storeType=PKCS12
```

普通 `assembleDebug` 使用 Android 工具链生成的本地调试签名，便于日常开发，也不能覆盖安装正式发布包。`assembleRelease` 缺少固定密钥或密码时直接失败，不会退回到随机密钥。

也可以只在当前 PowerShell 进程临时注入密码，不创建本地配置文件：

```powershell
$env:JJB_ANDROID_KEYSTORE_PATH = "C:\secure\jiaojianbox-signing.keystore"
$env:JJB_ANDROID_KEYSTORE_PASSWORD = "<from deployment secret>"
if ($env:JJB_ANDROID_KEY_PASSWORD -eq $null) {
  $env:JJB_ANDROID_KEY_PASSWORD = $env:JJB_ANDROID_KEYSTORE_PASSWORD
}
.\android\gradlew.bat clean :app:assembleRelease
```

## 怎么校验

```powershell
python -X utf8 scripts/verify-android-signing.py
python -X utf8 scripts/verify-android-signing.py --apk android/app/build/outputs/apk/release/app-release.apk --require-release
```

脚本把证书 SHA-256 与固定值比较，`--require-release` 还会检查 APK 的 `application-debuggable` 标记；任一不符就返回非零。它已经接在三个位置：

- 发布流水线：还原密钥后先校验密钥库，构建后再校验 APK 的签名和不可调试标记；
- `Android signing identity` 工作流：改动 `android/**` 时、以及每周一自动校验 Secret；
- 本地：`npm run verify:signing`，或直接运行上面的命令。

Secret 被删除、密码错误或被替换时会立刻失败，不会静默发出无法覆盖安装的包。

## 万一要换

只有一种情况需要换：主动放弃老用户的覆盖升级。那必须同时改 `scripts/verify-android-signing.py` 里的固定指纹、本文档、以及发布说明中的卸载提示，并明确告知用户先同步数据再卸载重装。
