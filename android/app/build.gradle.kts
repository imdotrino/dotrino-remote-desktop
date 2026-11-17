// Dotrino Remote Desktop para Android: la versión NATIVA del cliente de
// remote-desktop.dotrino.com/desktops (CONVENCIONES §16). La PWA va delante; `versionName` es la
// versión de la PWA con la que esta está a la par (§16.3).
import java.io.File
import java.util.Base64

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// La misma llave de subida que Terminal y la app de identidad, del cajón `claude` de dotrino-env
// (ANDROID_UPLOAD_KEYSTORE_B64 / _STORE_PASSWORD / _KEY_ALIAS / _KEY_PASSWORD). El .jks se escribe
// en $XDG_RUNTIME_DIR —memoria, no disco— y se borra al salir la JVM. Sin esas variables el release
// sale SIN firmar: no hay otra llave de repuesto a la que caer.
val uploadKey: Map<String, String>? = run {
    val b64 = System.getenv("ANDROID_UPLOAD_KEYSTORE_B64") ?: return@run null
    val dir = System.getenv("XDG_RUNTIME_DIR") ?: error("XDG_RUNTIME_DIR is not set: refusing to write the upload key to disk")
    val f = File(dir, "dotrino-upload-${ProcessHandle.current().pid()}.jks")
    f.writeBytes(Base64.getDecoder().decode(b64))
    f.setReadable(false, false); f.setReadable(true, true)
    f.deleteOnExit()
    mapOf(
        "storeFile" to f.absolutePath,
        "storePassword" to (System.getenv("ANDROID_UPLOAD_STORE_PASSWORD") ?: error("ANDROID_UPLOAD_STORE_PASSWORD missing")),
        "keyAlias" to (System.getenv("ANDROID_UPLOAD_KEY_ALIAS") ?: error("ANDROID_UPLOAD_KEY_ALIAS missing")),
        "keyPassword" to (System.getenv("ANDROID_UPLOAD_KEY_PASSWORD") ?: error("ANDROID_UPLOAD_KEY_PASSWORD missing")),
    )
}

android {
    namespace = "com.dotrino.remotedesktop"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.dotrino.remotedesktop"
        minSdk = 31
        targetSdk = 36
        versionCode = 1
        versionName = "0.11.0"
    }

    // La MISMA llave que la app de identidad (Play App Signing «misma llave que otra app»): su
    // servicio es de nivel firma y no atiende a una app firmada con otra.
    signingConfigs {
        if (uploadKey != null) {
            create("release") {
                storeFile = file(uploadKey.getValue("storeFile"))
                storePassword = uploadKey.getValue("storePassword")
                keyAlias = uploadKey.getValue("keyAlias")
                keyPassword = uploadKey.getValue("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            if (uploadKey != null) signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
    // La lógica de la escena y de la vista corre en la JVM: lo de Android que toque devuelve valores vacíos.
    testOptions { unitTests.isReturnDefaultValues = true }
}

dependencies {
    implementation("com.dotrino:dotrino-native")   // includeBuild de dotrino-native/android
    implementation("com.dotrino:dotrino-webrtc")   // el camino directo (WebRTC directo o por TURN)
    testImplementation("junit:junit:4.13.2")
}
