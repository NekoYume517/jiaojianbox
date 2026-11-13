# android/keystore

本地构建把永久签名密钥库放在这里：

```
android/keystore/jiaojianbox-signing.keystore
```

该文件被 `.gitignore` 忽略，不进公开仓库。发布构建没有它或没有密码环境变量时会直接报错，不会生成随机密钥；日常调试构建使用本地 Android 调试签名。

本机密码配置放在同目录的 `signing.properties`，同样被 `.gitignore` 忽略：

```properties
storeFile=jiaojianbox-signing.keystore
storePassword=<local secret>
keyAlias=androiddebugkey
keyPassword=<local secret>
storeType=PKCS12
```

CI 环境变量优先于本地配置，因此正式流水线仍可使用 GitHub Secrets。

完整规则、Secret 名称和校验方式见 `docs/android-signing.md`。
