import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// HC-T29 / REQ-SEC-107: secret-store inputs come from env vars first, then the git-ignored android/key.properties.
val keystoreProperties = Properties().apply {
    rootProject.file("key.properties").takeIf { it.isFile }?.inputStream()?.use { load(it) }
}

fun sec(name: String): String? = System.getenv(name) ?: keystoreProperties.getProperty(name)

android {
    namespace = "np.lims.phlebo_app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "np.lims.phlebo_app"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = 26 // sentry_flutter (LD-24 error tracking) requires API 26, same as patient_app
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // The flavours below set app_name through resValue, which AGP 8+ only allows when this is on.
    buildFeatures {
        resValues = true
    }

    // HC-T21 flavours; Dart side reads --dart-define=FLAVOR (lib/app/flavor.dart). Release signing config is
    // injected by CI (no keystore or debug-key signing is committed here, REQ-SEC-107).
    flavorDimensions += "env"
    productFlavors {
        create("dev") {
            dimension = "env"
            applicationIdSuffix = ".dev"
            resValue("string", "app_name", "LIMS Phlebo (dev)")
        }
        create("staging") {
            dimension = "env"
            applicationIdSuffix = ".staging"
            resValue("string", "app_name", "LIMS Phlebo (staging)")
        }
        create("prod") {
            dimension = "env"
            resValue("string", "app_name", "LIMS Phlebo")
        }
    }

    // HC-T29 / REQ-SEC-107/128: signing material from the C1 secret store (LIMS_RELEASE_*), nothing in the repo.
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
        throw GradleException("Release signing inputs missing from the C1 secret store: $missing (see apps/phlebo_app/android/RELEASE.md)")
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
