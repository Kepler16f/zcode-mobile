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

// 打包必须由发起方指定用户本次确认的版本，不沿用上一次构建。
val suppliedAppVersion = providers.gradleProperty("appVersion").orNull
val appVersion = suppliedAppVersion ?: "0.8.1"
val versionParts = appVersion.split(".")
if (versionParts.size != 3 || versionParts.any { !it.matches(Regex("0|[1-9][0-9]{0,2}")) }) {
    throw GradleException("版本号必须是三段数字，例如 -PappVersion=0.8.1")
}
val computedVersionCode = versionParts[0].toInt() * 1_000_000 + versionParts[1].toInt() * 1_000 + versionParts[2].toInt()
if (computedVersionCode <= 73) throw GradleException("Android versionCode 必须大于之前发布的 73")
var releaseSigningConfigured = false

android {
    namespace = "cn.zcode.mobile"
    compileSdk = 34

    defaultConfig {
        applicationId = "cn.zcode.mobile"
        minSdk = 26
        targetSdk = 34
        versionCode = computedVersionCode
        versionName = appVersion
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
            // CI 的 debug 验证没有正式签名材料，不能在配置所有变体时提前失败。
            // release 仍由 taskGraph 的签名闸拒绝，绝不回退到 debug 签名。
            if (storeFileRel != null && storePw != null && alias != null && keyPw != null) {
                storeFile = rootProject.file(storeFileRel)
                storePassword = storePw
                keyAlias = alias
                keyPassword = keyPw
                releaseSigningConfigured = true
            }
            // v1 是给厂商安装器的兼容线；v2/v3 是 Play 与 targetSdk 30+ 的完整保护。三档全开。
            enableV1Signing = true
            enableV2Signing = true
            enableV3Signing = true
        }
    }

    buildTypes {
        debug {
            // AGP 的默认 debug 配置会在全新 CI 机器上生成测试证书。
            signingConfig = signingConfigs.getByName(if (System.getenv("CI").equals("true", ignoreCase = true)) "debug" else "local")
        }
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

tasks.register<Sync>("copyMobileRuntime") {
    description = "把端侧 runtime + 真机自检页同步到 assets/mobile（装机即出 §3.4 关卡报告）"
    from(rootProject.file("../mobile-runtime/build")) {
        include("dist/**")
        include("selfcheck.html")
        include("m1-run.mjs")
        include("selfcheck.mjs")
        include("harness.html")
        // 主界面已携带完全相同的 sql.js 和 WASM。自检页使用同源的 UI 副本，
        // 避免 APK 内重复保存；开发环境的原始自检文件仍可独立运行。
        exclude("dist/sql-wasm.js", "dist/sql-wasm.wasm")
    }
    filteringCharset = "UTF-8"
    filesMatching(listOf("selfcheck.html", "harness.html", "selfcheck.mjs", "m1-run.mjs")) {
        filter { line: String -> line.replace("./dist/sql-wasm.", "../ui/sql-wasm.") }
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

// 修复原因：Gradle 曾只复制已有 bundle，源码变更后仍能成功打出旧代码。
tasks.register<Exec>("checkMobileBundleFingerprint") {
    workingDir(rootProject.projectDir.parentFile)
    commandLine("node", "mobile-runtime/build/bundle-fingerprint.mjs", "check")
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
    dependsOn("copyMobileRuntime", "copyMobileUi", "copyWebDist", "checkNativeLibExtraction", "checkMobileBundleFingerprint")
}

// APK 重打包（压缩率）：AGP 对资源用最快压缩等级（BEST_SPEED）。同一份内容，entry.js 7.8 MB
// 正文在等级 1 下压成 2.48 MB、等级 9 只要 2.06 MB；端侧 UI 有 5000 多个小文件，全包差约 4 MB。
// AGP 任务上的 compressionLevel 属性在 8.13.2 上不生效（由构建类型内部决定），所以在产物层重压：
// 重压条目 → zipalign 恢复对齐 → 用**该变体自己的 keystore** 重新签名（证书不变，可覆盖安装）。
fun registerApkRepack(buildType: String) {
    val apk = file("build/outputs/apk/$buildType/aZCode-$appVersion.apk")
    val repack = tasks.register<Exec>("repack${buildType.replaceFirstChar { it.uppercase() }}Apk") {
        description = "把 $buildType APK 的条目按最大压缩率重压并重新签名（省约 4 MB）"
        dependsOn("package$buildType")
        inputs.file(apk)
        outputs.upToDateWhen { false }
        doFirst {
            val sdkRoot = Properties().apply {
                val file = rootProject.file("local.properties")
                if (file.exists()) file.inputStream().use { load(it) }
            }.getProperty("sdk.dir").orEmpty()
            // 用版本号最大的那套 build-tools（只要里面有 zipalign 与 apksigner）。
            val buildTools = File(sdkRoot, "build-tools").listFiles()
                ?.filter { File(it, "zipalign.exe").isFile && File(it, "lib/apksigner.jar").isFile }
                ?.sortedBy { it.name }
                ?.lastOrNull()
                ?: error("在 $sdkRoot/build-tools 里找不到带 zipalign/apksigner 的版本")
            val java = File(System.getProperty("java.home"), "bin/java.exe").takeIf { it.exists() }?.absolutePath ?: "java"
            val signing = signingConfigs.getByName(if (buildType == "release") "release" else "local")
            val keystoreFile = signing.storeFile ?: error("$buildType 变体没有 storeFile，无法重签")
            exec {
                workingDir(rootProject.projectDir.parentFile)
                environment("ZCODE_KS_PASS", signing.storePassword.orEmpty())
                environment("ZCODE_KEY_PASS", signing.keyPassword.orEmpty())
                environment("ZCODE_KEY_ALIAS", signing.keyAlias.orEmpty())
                commandLine("node", "mobile-runtime/build/repack-apk.mjs", "--apk", apk.absolutePath,
                    "--sdk", buildTools.absolutePath, "--java", java, "--keystore", keystoreFile.absolutePath)
            }
        }
    }
    tasks.matching { it.name == "assemble$buildType" }.configureEach { finalizedBy(repack) }
}
registerApkRepack("debug")
registerApkRepack("release")

// 在任务运行前检查，即使打包任务命中 UP-TO-DATE 也不能跳过本次版本确认。
gradle.taskGraph.whenReady {
    if (!releaseSigningConfigured && allTasks.any { it.name == "packageRelease" || it.name == "validateSigningRelease" }) {
        throw GradleException("缺少正式签名材料 keystore/keystore.properties，不能构建 release")
    }
    if (suppliedAppVersion == null && allTasks.any { it.name == "packageDebug" || it.name == "packageRelease" }) {
        throw GradleException("请先询问用户本次版本号，再用 -PappVersion=版本号 构建 APK")
    }
}

fun registerApkDelivery(buildType: String) {
    val title = buildType.replaceFirstChar { it.uppercase() }
    val publish = tasks.register<Exec>("publish${title}Apk") {
        onlyIf {
            val state = tasks.getByName("assemble$title").state
            state.executed && !state.skipped && state.failure == null &&
                System.getProperty("os.name").startsWith("Windows", ignoreCase = true) &&
                !System.getenv("CI").equals("true", ignoreCase = true)
        }
        workingDir(rootProject.projectDir.parentFile)
        commandLine("node", "mobile-runtime/build/publish-apk.mjs", "--version", appVersion,
            "--apk", file("build/outputs/apk/$buildType/aZCode-$appVersion.apk").absolutePath)
    }
    // AGP 在配置阶段之后注册 variant 任务，因此按名称延迟挂接。
    tasks.matching { it.name == "assemble$title" }.configureEach { finalizedBy(publish) }
}
registerApkDelivery("debug")
registerApkDelivery("release")

// 交付出去的是重压过的包：重打包在 packageDebug 之后、发布之前。
tasks.named("publishDebugApk") { dependsOn("repackDebugApk") }
tasks.named("publishReleaseApk") { dependsOn("repackReleaseApk") }

dependencies {
    // 外壳只用原生 Activity，避免 appcompat 连带 kotlinx-coroutines 等传递依赖。
    implementation("androidx.webkit:webkit:1.12.1")
    // SAF 树（外部工作区）的读写口：TreeBridge 用 DocumentFile 走授权 URI，
    // File API 在 scoped storage 下对这些目录一律 EACCES，见 TreeBridge.kt 头注。
    implementation("androidx.documentfile:documentfile:1.0.1")
}
