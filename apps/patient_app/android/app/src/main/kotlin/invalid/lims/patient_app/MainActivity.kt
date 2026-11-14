package invalid.lims.patient_app

import android.view.WindowManager
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

// local_auth (app lock, US-EN-02.4) requires a FragmentActivity.
class MainActivity : FlutterFragmentActivity() {
    // REQ-SEC-109 / LD-140 [CONV channel name]: lims_ui LimsSecureScreen -> FLAG_SECURE blocks screenshots and recents thumbnails on PHI screens.
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "lims_ui/secure_screen").setMethodCallHandler { call, result ->
            when (call.method) {
                "enable" -> { window.addFlags(WindowManager.LayoutParams.FLAG_SECURE); result.success(null) }
                "disable" -> { window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE); result.success(null) }
                else -> result.notImplemented()
            }
        }
    }
}
