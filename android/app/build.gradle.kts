import java.io.File
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Permanent signing identity of shipped release builds. Debug builds use the
// Android toolchain's local debug identity and must never overwrite a release.
// See docs/android-signing.md.
val localSigningFile = rootProject.file("keystore/signing.properties")
val localSigning = Properties().apply {
    if (localSigningFile.isFile) {
        localSigningFile.inputStream().buffered().use(::load)
    }
}
fun signingSetting(name: String): String? = localSigning.getProperty(name)?.takeIf { it.isNotBlank() }
fun signingFile(value: String?): File? {
    val raw = value?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val path = File(raw)
    return if (path.isAbsolute) path else rootProject.file("keystore/$raw")
}

val configuredStableKeystore = signingFile(System.getenv("JJB_ANDROID_KEYSTORE_PATH") ?: signingSetting("storeFile"))
val repositoryStableKeystore = rootProject.file("keystore/jiaojianbox-signing.keystore").takeIf { it.isFile }
val stableKeystore: File? = configuredStableKeystore ?: repositoryStableKeystore
val stableStorePassword: String? = System.getenv("JJB_ANDROID_KEYSTORE_PASSWORD")?.takeIf { it.isNotBlank() }
    ?: signingSetting("storePassword")
val stableKeyAlias: String = System.getenv("JJB_ANDROID_KEY_ALIAS")?.takeIf { it.isNotBlank() }
    ?: signingSetting("keyAlias")
    ?: "androiddebugkey"
val stableKeyPassword: String? = System.getenv("JJB_ANDROID_KEY_PASSWORD")?.takeIf { it.isNotBlank() }
    ?: signingSetting("keyPassword")
    ?: stableStorePassword
val stableStoreType: String = System.getenv("JJB_ANDROID_STORE_TYPE")?.takeIf { it.isNotBlank() }
    ?: signingSetting("storeType")
    ?: "PKCS12"

if (configuredStableKeystore != null && !configuredStableKeystore.isFile) {
    throw GradleException("Android signing keystore not found: $configuredStableKeystore (see docs/android-signing.md)")
}

android {
    namespace = "com.jiaojianbox.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.jiaojianbox.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 29
        versionName = "0.6.21"
    }
    signingConfigs {
        if (stableKeystore != null && stableStorePassword != null) {
            create("stable") {
                storeFile = stableKeystore
                storePassword = stableStorePassword
                keyAlias = stableKeyAlias
                keyPassword = stableKeyPassword
                storeType = stableStoreType
                enableV1Signing = true
                enableV2Signing = true
            }
        }
    }
    buildTypes {
        debug {}
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfigs.findByName("stable")?.let { signingConfig = it }
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

tasks.matching { it.name == "assembleRelease" || it.name == "bundleRelease" }.configureEach {
    doFirst {
        if (stableKeystore == null || stableStorePassword == null) {
            throw GradleException(
                "Release builds require the permanent Android signing keystore and " +
                    "JJB_ANDROID_KEYSTORE_PASSWORD or android/keystore/signing.properties. " +
                    "See docs/android-signing.md.",
            )
        }
    }
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
