# قواعد R8 لإصدار النشر
# واجهات الجسر التي تستدعيها صفحات الويب بالاسم يجب ألا تُغيَّر أسماؤها
-keepclassmembers class net.arena.rafiq.** {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class net.arena.rafiq.web.** { *; }
-keep class net.arena.rafiq.DeviceBridge { *; }
-keep class net.arena.rafiq.data.** { *; }
-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod
-dontwarn org.bouncycastle.**
