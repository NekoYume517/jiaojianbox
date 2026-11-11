plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Permanent signing identity of the shipped app. See docs/android-signing.md.
// Never generate a replacement key: a new key changes the signature and forces every
// user to uninstall the previous build before installing an update.
val stableKeystore: File = run {
    val fromEnvironment = System.getenv("JJB_ANDROID_KEYSTORE_PATH")?.let { file(it) }
    val fromRepository = rootProject.file("keystore/jiaojianbox-signing.keystore")
    val resolved = fromEnvironment ?: fromRepository.takeIf { it.isFile }
    if (resolved == null) {
        throw GradleException(
            """
            Missing the permanent Android signing keystore.

            Expected it at: ${rootProject.file("keystore/jiaojianbox-signing.keystore")}
            or set JJB_ANDROID_KEYSTORE_PATH to its location.

            This keystore is the app identity (certificate SHA-256
            256994e591fe61061ed76b88aabe518f140deefb4dab7f947d64e461dbb158ab). Replacing or
            regenerating it silently breaks upgrades for every installed device. Read
            docs/android-signing.md.
            """.trimIndent(),
        )
    }
    if (!resolved.isFile) {
        throw GradleException("Android signing keystore not found: $resolved (see docs/android-signing.md)")
    }
    resolved
}

val stableStorePassword: String = System.getenv("JJB_ANDROID_KEYSTORE_PASSWORD") ?: "android"
val stableKeyAlias: String = System.getenv("JJB_ANDROID_KEY_ALIAS") ?: "androiddebugkey"
val stableKeyPassword: String = System.getenv("JJB_ANDROID_KEY_PASSWORD") ?: stableStorePassword

android {
    namespace = "com.jiaojianbox.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.jiaojianbox.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 23
        versionName = "0.6.15"
    }
    signingConfigs {
        create("stable") {
            storeFile = stableKeystore
            storePassword = stableStorePassword
            keyAlias = stableKeyAlias
            keyPassword = stableKeyPassword
            storeType = "PKCS12"
            enableV1Signing = true
            enableV2Signing = true
        }
    }
    buildTypes {
        debug {
            // Both variants use the permanent key so no build can drift to a fresh one.
            signingConfig = signingConfigs.getByName("stable")
        }
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("stable")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
    sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/workspaceAssets"))
}

val syncWorkspaceAssets by tasks.registering(Sync::class) {
    from(rootProject.file("../web"))
    into(layout.buildDirectory.dir("generated/workspaceAssets/web"))
    exclude("**/*.map")
}
tasks.named("preBuild") { dependsOn(syncWorkspaceAssets) }

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.datastore:datastore-preferences:1.1.1")
    implementation("androidx.navigation:navigation-compose:2.8.5")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:okhttp-sse:4.12.0")
    implementation("org.json:json:20240303")
}
