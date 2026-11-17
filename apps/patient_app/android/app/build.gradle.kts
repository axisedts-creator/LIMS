import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Secret-store inputs: env var first, then the git-ignored android/key.properties (same key names).
val keystoreProperties = Properties().apply {
    rootProject.file("key.properties").takeIf { it.isFile }?.inputStream()?.use { load(it) }
}

fun sec(name: String): String? = System.getenv(name) ?: keystoreProperties.getProperty(name)

android {
    namespace = "invalid.lims.patient_app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // Placeholder id (like the `.invalid` flavour URLs): the real per-tenant id is not in the spec yet.
        applicationId = "invalid.lims.patient_app"
        minSdk = 26 // sentry_flutter (LD-24 error tracking via lims_ui) requires API 26
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // Matches lib/main_{dev,staging,prod}.dart: build with `--flavor <name> -t lib/main_<name>.dart`.
    flavorDimensions += "env"
    productFlavors {
        create("dev") {
            dimension = "env"
            applicationIdSuffix = ".dev"
        }
        create("staging") {
            dimension = "env"
            applicationIdSuffix = ".staging"
        }
        create("prod") {
            dimension = "env"
        }
    }

    // T-REL1 / REQ-SEC-128: signing material comes from the C1 secret store, materialised at build time as
    // env vars (LIMS_RELEASE_*) or an untracked android/key.properties. Nothing is stored in the repo.
    signingConfigs {
        create("release") {
            storeFile = sec("LIMS_RELEASE_STORE_FILE")?.let { file(it) }
            storePassword = sec("LIMS_RELEASE_STORE_PASSWORD")
            keyAlias = sec("LIMS_RELEASE_KEY_ALIAS")
            keyPassword = sec("LIMS_RELEASE_KEY_PASSWORD")
        }
    }

    buildTypes {
        release {
            // Never the debug key. Fail closed (below) when the secret-store inputs are missing.
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true // REQ-SEC-112
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }
}

// Fail closed: a release build without the full signing set must stop, never fall back to debug signing.
if (gradle.startParameter.taskNames.any { it.contains("release", ignoreCase = true) }) {
    val missing = listOf("STORE_FILE", "STORE_PASSWORD", "KEY_ALIAS", "KEY_PASSWORD").filter { sec("LIMS_RELEASE_$it").isNullOrBlank() }
    if (missing.isNotEmpty()) {
        throw GradleException("Release signing inputs missing from the C1 secret store: $missing (see apps/patient_app/RELEASE.md)")
    }
    if (!file(sec("LIMS_RELEASE_STORE_FILE")!!).isFile) {
        throw GradleException("LIMS_RELEASE_STORE_FILE does not point to an existing keystore file")
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
