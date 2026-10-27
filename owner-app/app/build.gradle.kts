plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "net.arena.rafiq.owner"
    compileSdk = 34

    defaultConfig {
        applicationId = "net.arena.rafiq.owner"
        minSdk = 26
        targetSdk = 34
        versionCode = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 1
        versionName = "0.1.0"
    }

    // توقيع ثابت (نفس مفتاح التطبيق الرئيسي حالياً) حتى يُحدَّث التطبيق فوق نفسه ولا يضيع المفتاح الخاص عند التحديث.
    // ملاحظة: هذا المفتاح في المستودع؛ يجب نقله إلى أسرار GitHub قبل الإصدار النهائي.
    signingConfigs {
        getByName("debug") {
            storeFile = file("../../app/rafiq-debug.keystore")
            storeType = "pkcs12"
            storePassword = "rafiq-debug"
            keyAlias = "rafiq"
            keyPassword = "rafiq-debug"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
    }
}

dependencies {
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("androidx.core:core-ktx:1.13.1")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.12.2")
    testImplementation("androidx.test:core:1.5.0")
}
