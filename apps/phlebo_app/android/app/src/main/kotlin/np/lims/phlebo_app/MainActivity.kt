package np.lims.phlebo_app

import android.os.SystemClock
import android.provider.Settings
import android.view.WindowManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "np.lims.phlebo/platform")
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    // HC-T24 / TRD 7.5: monotonic channel. Includes deep sleep: UNVERIFIED (spike).
                    "monotonicMs" -> result.success(SystemClock.elapsedRealtime())
                    // HC-T24 / TRD 7.5: boot id from the boot counter. Readable on all target devices: UNVERIFIED (spike).
                    "bootId" -> try {
                        val n = Settings.Global.getInt(contentResolver, Settings.Global.BOOT_COUNT)
                        result.success("b-" + n.toString().padStart(10, '0'))
                    } catch (e: Settings.SettingNotFoundException) {
                        result.error("boot_id_unavailable", "BOOT_COUNT not readable", null)
                    }
                    else -> result.notImplemented()
                }
            }
        // HC-T29 / REQ-SEC-109: FLAG_SECURE blocks screenshots, recording and the recent-apps thumbnail.
        // Channel name matches lims_ui LimsSecureScreen; it enables on the first PHI screen and disables on the last.
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "lims_ui/secure_screen")
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "enable" -> {
                        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
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
