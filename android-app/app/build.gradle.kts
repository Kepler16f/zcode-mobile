import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// SDK 位置：优先环境变量，其次本机默认路径（当前机器没有 ANDROID_HOME）。
val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}
val sdkDir: String = localProperties.getProperty("sdk.dir")
    ?: System.getenv("ANDROID_HOME")
    ?: System.getenv("LOCALAPPDATA")?.let { "$it\\Android\\Sdk" }
    ?: error("未找到 Android SDK，请写 local.properties: sdk.dir=...")

android {
    namespace = "cn.zcode.mobile"
    compileSdk = 34

    defaultConfig {
        applicationId = "cn.zcode.mobile"
        minSdk = 26
        targetSdk = 34
        versionCode = 73
        versionName = "0.8.0"
    }

    // 安装包命名规则：应用名＋版本号（aZCode-0.3.2.apk），不随 buildType 变。
    applicationVariants.all {
        outputs.all {
            (this as com.android.build.gradle.internal.api.BaseVariantOutputImpl).outputFileName =
                "aZCode-$versionName.apk"
        }
    }

    signingConfigs {
        create("local") {
            // debug 包仍走系统 debug keystore，方便本机 adb install 调试。
            storeFile = file(System.getProperty("user.home") + "/.android/debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
        // release 用正式 keystore（android-app/keystore/azcode-release.keystore + keystore.properties）。
        // 为什么不用 debug 签名出货：debug 证书只签 v2、不签 v1（JAR），OPPO/ColorOS 等厂商安装器
        // 对这种包会直接报"安装包损坏"（实测 0.3.3 即栽在这），而且换签名后无法覆盖安装。
        create("release") {
            val props = Properties()
            val propsFile = rootProject.file("keystore/keystore.properties")
            if (propsFile.exists()) propsFile.inputStream().use { props.load(it) }
            val storeFileRel = props.getProperty("store.file")
            val storePw = props.getProperty("store.password")
            val alias = props.getProperty("key.alias")
            val keyPw = props.getProperty("key.password")
            if (storeFileRel == null || storePw == null || alias == null || keyPw == null) {
                throw GradleException(
                    "缺少正式签名材料 keystore/keystore.properties —— 不出包。" +
                        "绝不能用 debug keystore 出 release：debug 只签 v2 缺 v1，厂商安装器报\"安装包损坏\"。",
                )
            }
            storeFile = rootProject.file(storeFileRel)
            storePassword = storePw
            keyAlias = alias
            keyPassword = keyPw
            // v1 是给厂商安装器的兼容线；v2/v3 是 Play 与 targetSdk 30+ 的完整保护。三档全开。
            enableV1Signing = true
            enableV2Signing = true
            enableV3Signing = true
        }
    }

    buildTypes {
        debug { signingConfig = signingConfigs.getByName("local") }
        release {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // 0.0.1 是自检包：assets 只从生成目录取，src/main/assets/www（桌面 Web UI，54 MB）不进包。
    // 要带 UI 就加 -PincludeWebUi=true。
    sourceSets.getByName("main").assets.setSrcDirs(listOf(file("build/generated/assets")))

    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }
}

tasks.register<Copy>("copyMobileRuntime") {
    description = "把端侧 runtime + 真机自检页同步到 assets/mobile（装机即出 §3.4 关卡报告）"
    from(rootProject.file("../mobile-runtime/build")) {
        include("dist/**")
        include("selfcheck.html")
        include("m1-run.mjs")
        include("selfcheck.mjs")
        include("harness.html")
    }
    into(file("build/generated/assets/mobile"))
}

// 端侧真 UI（build/bundle-ui.mjs 的产物）：4293 个文件、正式构建约 36 MB。
// 这里只"复制"，不做第二次打包——dist-ui 与源码是否一致由 bundle-ui.mjs 的 metafile 断言负责，
// 0.0.3 的教训就是"包内内容与源码不一致"只能在装机后发现，所以两边都必须各自成立。
// 前提：先 `node mobile-runtime/build/bundle-ui.mjs`，否则这里显式报错而不是静默出一个没有 UI 的包。
tasks.register("checkUiBundle") {
    description = "断言 mobile-runtime/build/dist-ui 已生成且非空（真 UI 进包的前置条件）"
    doLast {
        val entry = rootProject.file("../mobile-runtime/build/dist-ui/entry.js")
        val page = rootProject.file("../mobile-runtime/build/dist-ui/ui.html")
        if (!entry.isFile || !page.isFile) {
            throw GradleException(
                "缺 ${entry.path}（或 ui.html）：先跑 node mobile-runtime/build/bundle-ui.mjs 再装 APK",
            )
        }
        if (entry.length() < 200_000) throw GradleException("dist-ui/entry.js 只有 ${entry.length()} B，不像是完整产物")
    }
}

tasks.register<Sync>("copyMobileUi") {
    description = "把 dist-ui 同步到 assets/ui（Sync 会清掉上一轮的旧哈希 chunk，避免死文件跟着进 APK）"
    dependsOn("checkUiBundle")
    from(rootProject.file("../mobile-runtime/build/dist-ui"))
    into(file("build/generated/assets/ui"))
}

tasks.register<Copy>("copyWebDist") {
    description = "把 packages/web 的生产构建产物同步到 assets/www（剔除 sourcemap）"
    onlyIf { providers.gradleProperty("includeWebUi").isPresent }
    from(rootProject.file("../zcode/packages/web/dist")) {
        // 生产构建用 hidden sourcemap，产物里仍落 80 MB 的 .map；端侧不需要。
        exclude("**/*.map")
    }
    into(file("build/generated/assets/www"))
}

// R13：L2（随包 ELF 走 execve）成立的前提是 so 被解到 nativeLibraryDir 且可读。
// 这个开关一旦被改掉，execve 会拿到一个 mmap 在 zip 里的路径而失败，症状是"权限错误"，
// 排查成本极高，所以在构建期直接断言死掉，而不是等装机。
tasks.register("checkNativeLibExtraction") {
    description = "断言 AndroidManifest 里 extractNativeLibs=true（R13 前置条件）"
    val manifest = file("src/main/AndroidManifest.xml")
    doLast {
        val text = manifest.readText()
        val line = text.lineSequence().find { it.contains("extractNativeLibs") }
        if (line == null) throw GradleException("AndroidManifest.xml 缺 android:extractNativeLibs（R13）")
        if (!line.contains("\"true\"")) {
            throw GradleException("R13：android:extractNativeLibs 必须为 true，否则随包 ELF 无法 execve")
        }
    }
}

tasks.named("preBuild") {
    dependsOn("copyMobileRuntime", "copyMobileUi", "copyWebDist", "checkNativeLibExtraction")
}

dependencies {
    // 外壳只用原生 Activity，避免 appcompat 连带 kotlinx-coroutines 等传递依赖。
    implementation("androidx.webkit:webkit:1.12.1")
    // SAF 树（外部工作区）的读写口：TreeBridge 用 DocumentFile 走授权 URI，
    // File API 在 scoped storage 下对这些目录一律 EACCES，见 TreeBridge.kt 头注。
    implementation("androidx.documentfile:documentfile:1.0.1")
}
