import java.util.Base64
import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Release signing comes from android/key.properties (git-ignored; see docs/RELEASE_BUILDS.md). There is deliberately NO fallback to the
// debug key: a release build without a real key fails instead of producing an app signed with a key everybody has.
val keystoreProperties = Properties().apply {
    val file = rootProject.file("key.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}
val releaseKeyConfigured = listOf("storeFile", "storePassword", "keyAlias", "keyPassword").all { !keystoreProperties.getProperty(it).isNullOrBlank() }

gradle.taskGraph.whenReady {
    val releaseRequested = allTasks.any { t ->
        val n = t.name
        (n.startsWith("assemble") || n.startsWith("bundle") || n.startsWith("package") || n.startsWith("sign")) && n.endsWith("Release")
    }
    if (releaseRequested && !releaseKeyConfigured) {
        throw GradleException(
            "Release signing is not configured. Create android/key.properties (storeFile, storePassword, keyAlias, keyPassword) " +
                "pointing at your release keystore. Release builds are never signed with the debug key. See docs/RELEASE_BUILDS.md."
        )
    }
}

// The Google Maps key. Looked up in this order, so it never has to be written into a tracked file:
//   1. --dart-define / --dart-define-from-file GOOGLE_MAPS_API_KEY (Flutter passes the dart-defines to Gradle, base64 encoded),
//   2. MAPS_API_KEY in android/local.properties (git-ignored), a Gradle property, or the MAPS_API_KEY environment variable.
// An empty value is allowed: the map then shows blank tiles and the app says maps are not set up.
fun mapsApiKey(): String {
    val fromDartDefines = (project.findProperty("dart-defines") as String?)
        ?.split(',')
        ?.map { String(Base64.getDecoder().decode(it)) }
        ?.firstOrNull { it.startsWith("GOOGLE_MAPS_API_KEY=") }
        ?.substringAfter('=')
    val local = Properties().apply {
        val f = rootProject.file("local.properties")
        if (f.exists()) f.inputStream().use { load(it) }
    }
    return fromDartDefines?.takeIf { it.isNotBlank() }
        ?: local.getProperty("MAPS_API_KEY")?.takeIf { it.isNotBlank() }
        ?: (project.findProperty("MAPS_API_KEY") as String?)?.takeIf { it.isNotBlank() }
        ?: System.getenv("MAPS_API_KEY")
        ?: ""
}

android {
    namespace = "com.saudihomeservices.customer_app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.saudihomeservices.customer_app"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        manifestPlaceholders["MAPS_API_KEY"] = mapsApiKey()
    }

    signingConfigs {
        create("release") {
            if (releaseKeyConfigured) {
                storeFile = rootProject.file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = if (releaseKeyConfigured) signingConfigs.getByName("release") else null
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
