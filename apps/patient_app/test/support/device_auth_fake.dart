// T-A4 test support: scripted device biometric/PIN (kept apart from auth_fakes.dart so A4 tests compile on their own).
import 'package:patient_app/app/app_lock_gate.dart';

/// [results] are consumed per prompt (false once exhausted); [secure] = the device has a screen lock.
class ScriptedDeviceAuth implements DeviceAuth {
  ScriptedDeviceAuth(this.results, {this.secure = true});
  final List<bool> results;
  final bool secure;
  int prompts = 0;
  @override
  Future<bool> isDeviceSecure() async => secure;
  @override
  Future<bool> authenticate() async {
    final r = prompts < results.length && results[prompts];
    prompts++;
    return r;
  }
}
