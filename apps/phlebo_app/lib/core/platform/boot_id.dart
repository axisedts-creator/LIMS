// HC-T24: boot-id channel (TRD §7.5). Android = Settings.Global.BOOT_COUNT (readability UNVERIFIED, see HC-T24-spike.md).
import 'platform_channel.dart';

abstract interface class BootIdSource {
  /// 1..64 characters (server CHECK on boot_id). Read at use time, never cached from app start.
  Future<String> read();
}

class PlatformBootIdSource implements BootIdSource {
  @override
  Future<String> read() async {
    final v = await limsPlatformChannel.invokeMethod<String>('bootId');
    if (v == null || v.isEmpty || v.length > 64) throw StateError('boot id unavailable');
    return v;
  }
}
