pluginManagement {
    repositories {
        // 国内开发机优先镜像；GitHub runner 直接访问官方源，避免镜像 502 禁用仓库后级联失败。
        if (!System.getenv("CI").equals("true", ignoreCase = true)) {
            maven("https://maven.aliyun.com/repository/public")
            maven("https://maven.aliyun.com/repository/google")
            maven("https://maven.aliyun.com/repository/gradle-plugin")
        }
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        if (!System.getenv("CI").equals("true", ignoreCase = true)) {
            maven("https://maven.aliyun.com/repository/public")
            maven("https://maven.aliyun.com/repository/google")
        }
        google()
        mavenCentral()
    }
}

rootProject.name = "zcode-android"
include(":app")
