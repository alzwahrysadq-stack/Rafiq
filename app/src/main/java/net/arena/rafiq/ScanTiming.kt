package net.arena.rafiq

import android.os.SystemClock
import org.json.JSONObject

/** تشخيص محلي فقط؛ لا تُسجّل قيمة الباركود ولا تُرسل أي بيانات. */
object ScanTiming {
    @Volatile private var startedAt = 0L
    @Volatile private var previewAt = 0L
    @Volatile private var finishedAt = 0L

    @Synchronized fun start() {
        startedAt = SystemClock.elapsedRealtime()
        previewAt = 0L
        finishedAt = 0L
    }

    @Synchronized fun previewReady() {
        if (startedAt > 0L && previewAt == 0L) previewAt = SystemClock.elapsedRealtime()
    }

    @Synchronized fun finish() {
        if (startedAt > 0L) finishedAt = SystemClock.elapsedRealtime()
    }

    /** زمن الوصول إلى المعاينة، ثم من المعاينة حتى عودة نتيجة القراءة (التركيز+الفك+إغلاق الكاميرا). */
    @Synchronized fun diagnostics(): String = JSONObject()
        .put("ready_ms", if (previewAt >= startedAt && startedAt > 0) previewAt - startedAt else JSONObject.NULL)
        .put("reading_ms", if (finishedAt >= previewAt && previewAt > 0) finishedAt - previewAt else JSONObject.NULL)
        .put("total_ms", if (finishedAt >= startedAt && startedAt > 0) finishedAt - startedAt else JSONObject.NULL)
        .toString()
}
