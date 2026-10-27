import java.security.KeyFactory
import java.security.interfaces.RSAPublicKey
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.devtools.ksp")
}

// مفتاح التحقق من الرخص: مطلوب لإصدار النشر، ويُمرَّر عبر متغير البيئة RAFIQ_LICENSE_PUBKEY
val licensePublicKey: String = System.getenv("RAFIQ_LICENSE_PUBKEY")?.trim().orEmpty()
fun checkReleasePublicKey() {
    if (licensePublicKey.isEmpty()) {
        throw GradleException("رفض بناء إصدار النشر: لم يُضبط RAFIQ_LICENSE_PUBKEY (المفتاح العام لتحقق الرخص).")
    }
    // لا نبني APK مغلقاً للأبد بسبب نسخ نص «جارٍ التحميل» أو مفتاح آخر غير RSA من هاتف المالك.
    try {
        val decoded = Base64.getDecoder().decode(licensePublicKey)
        val key = KeyFactory.getInstance("RSA")
            .generatePublic(X509EncodedKeySpec(decoded))
        require(key is RSAPublicKey && key.modulus.bitLength() >= 2048)
    } catch (e: Exception) {
        throw GradleException("رفض بناء إصدار النشر: المفتاح العام للرخصة غير صالح؛ انسخ مفتاح RSA من تطبيق المالك.")
    }
}
// مهمة assemble العامة تبني Debug وRelease معاً؛ لا تكفي مراقبة اسم الطلب الأعلى.
// افحص مخطط المهام قبل تشغيل أول مهمة كي لا يخرج Release غير مرخّص بأي طريقة بناء.
gradle.taskGraph.whenReady {
    if (allTasks.any { it.project == project && it.name.contains("release", ignoreCase = true) }) {
        checkReleasePublicKey()
    }
}

android {
    namespace = "net.arena.rafiq"
    compileSdk = 34

    defaultConfig {
        applicationId = "net.arena.rafiq"
        minSdk = 24
        targetSdk = 34
        // يزيد مع كل بناء في CI (رقم التشغيل)، فيقبل الهاتف التحديث فوق النسخة السابقة
        versionCode = maxOf(130, System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 1)
        versionName = "0.3.4"
        // مفتاح التحقق من الرخص (Base64 لـ X.509) يُمرَّر من متغير البيئة RAFIQ_LICENSE_PUBKEY
        buildConfigField("String", "LICENSE_PUBLIC_KEY", "\"$licensePublicKey\"")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    // مفتاح توقيع ثابت للنسخ التجريبية: لا يتغيّر بين البنيات، فيُحدَّث التطبيق فوق نفسه دون حذف.
    // (ليس مفتاح نشر نهائي؛ يُستبدل عند إصدار المتجر)
    signingConfigs {
        getByName("debug") {
            storeFile = file("rafiq-debug.keystore")
            storeType = "pkcs12"
            storePassword = "rafiq-debug"
            keyAlias = "rafiq"
            keyPassword = "rafiq-debug"
        }
    }

    buildTypes {
        release {
            // إصدار النشر: تصغير وإخفاء أسماء الكود (R8)، وحذف الموارد غير المستخدمة
            isMinifyEnabled = true
            isShrinkResources = true
            // التوقيع الحالي نفسه (لا تغيير في هوية التوقيع، فتتحدّث النسخ فوق بعضها). يُستبدل بالمفتاح النهائي بعد الموافقة.
            signingConfig = signingConfigs.getByName("debug")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
    }
}

ksp {
    // يُكتب مخطط قاعدة البيانات هنا كل مرة يُبنى فيها المشروع (للترحيلات لاحقاً)
    arg("room.schemaLocation", "$projectDir/schemas")
}

dependencies {
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.12.2")
    testImplementation("androidx.test:core:1.5.0")
    testImplementation("androidx.test.ext:junit:1.1.5")
}
