plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

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

    buildTypes {
        release {
            // Debug signing until the C1 release-signing secret exists (T-REL1). Never ship this.
            signingConfig = signingConfigs.getByName("debug")
        }
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
