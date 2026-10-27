package net.arena.rafiq

import android.app.Activity
import android.os.Bundle
import android.view.KeyEvent
import com.google.zxing.client.android.R as ZxingR
import com.journeyapps.barcodescanner.CameraPreview
import com.journeyapps.barcodescanner.CaptureManager
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import com.journeyapps.barcodescanner.camera.CameraSettings

/**
 * ماسح طولي. دورة الحياة مماثلة لـ CaptureActivity في ZXing 4.3.0؛ يلزم ضبط
 * التركيز *بعد* initializeFromIntent لأنه يستبدل إعدادات الكاميرا داخلياً.
 */
class PortraitCaptureActivity : Activity() {
    private lateinit var capture: CaptureManager
    private lateinit var scanner: DecoratedBarcodeView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(ZxingR.layout.zxing_capture)
        scanner = findViewById(ZxingR.id.zxing_barcode_scanner)
        capture = CaptureManager(this, scanner)
        capture.initializeFromIntent(intent, savedInstanceState)
        val settings = scanner.cameraSettings
        settings.setFocusMode(CameraSettings.FocusMode.CONTINUOUS) // المكتبة ترجع إلى AUTO إن لم يُدعم
        scanner.cameraSettings = settings
        scanner.barcodeView.addStateListener(object : CameraPreview.StateListener {
            override fun previewSized() = Unit
            override fun previewStarted() { ScanTiming.previewReady() }
            override fun previewStopped() = Unit
            override fun cameraError(error: Exception) = Unit
            override fun cameraClosed() = Unit
        })
        capture.decode()
    }

    override fun onResume() { super.onResume(); capture.onResume() }
    override fun onPause() { super.onPause(); capture.onPause() }
    override fun onDestroy() { super.onDestroy(); capture.onDestroy() }
    override fun onSaveInstanceState(outState: Bundle) { super.onSaveInstanceState(outState); capture.onSaveInstanceState(outState) }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        capture.onRequestPermissionsResult(requestCode, permissions, grantResults)
    }
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean =
        scanner.onKeyDown(keyCode, event) || super.onKeyDown(keyCode, event)
}
