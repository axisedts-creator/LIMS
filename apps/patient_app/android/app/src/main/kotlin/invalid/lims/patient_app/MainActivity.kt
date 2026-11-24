package invalid.lims.patient_app

import android.content.pm.ApplicationInfo
import android.view.WindowManager
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

// local_auth (app lock, US-EN-02.4) requires a FragmentActivity.
class MainActivity : FlutterFragmentActivity() {
    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        val isDebuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        if (!isDebuggable && android.os.Debug.isDebuggerConnected()) {
            android.os.Process.killProcess(android.os.Process.myPid())
        }
    }

    // REQ-SEC-109 / LD-140 [CONV channel name]: lims_ui LimsSecureScreen -> FLAG_SECURE blocks screenshots and recents thumbnails on PHI screens.
    // In debug builds, skip FLAG_SECURE so visual QA and screenshot inspection work during automated testing.
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "lims_ui/secure_screen").setMethodCallHandler { call, result ->
            when (call.method) {
                "enable" -> {
                    val isDebuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
                    if (!isDebuggable) {
                        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                    }
                    result.success(null)
                }
                "disable" -> {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
    }
}
