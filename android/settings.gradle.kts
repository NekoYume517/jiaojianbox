pluginManagement {
    repositories {
        google()
        // The upstream compiler JAR redirects to GitHub and can time out on CI.
        // Limit the mirror to this artifact; its SHA-1 matches Maven Central.
        maven("https://maven.aliyun.com/repository/central") {
            content { includeModule("org.jetbrains.kotlin", "kotlin-compiler-embeddable") }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "JiaojianBox"
include(":app")
