# android/keystore

本地构建把永久签名密钥库放在这里：

```
android/keystore/jiaojianbox-signing.keystore
```

该文件被 `.gitignore` 忽略，不进公开仓库。没有它时 Gradle 直接报错，不会生成随机密钥。
完整规则、密码和校验方式见 `docs/android-signing.md`。
