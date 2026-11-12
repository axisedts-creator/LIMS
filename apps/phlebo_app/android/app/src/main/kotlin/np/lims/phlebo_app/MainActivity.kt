package np.lims.phlebo_app

import android.os.SystemClock
import android.provider.Settings
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
    }
}
