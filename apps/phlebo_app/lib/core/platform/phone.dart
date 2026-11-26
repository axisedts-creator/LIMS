// PHLEBO-UI-FULL-1: everything the app shell asks of the handset, behind one interface so tests run without a device.
// Plugins are the CR-C17-010 pins: local_auth (re-auth gate), url_launcher (tel: / maps), geolocator (GPS point).
import 'dart:io';

import 'package:geolocator/geolocator.dart';
import 'package:local_auth/local_auth.dart';
import 'package:url_launcher/url_launcher.dart';

import 'platform_channel.dart';

class PhoneInfo {
  const PhoneInfo({required this.platform, required this.osVersion, this.model});

  /// 'android' | 'ios'
  final String platform;
  final String osVersion;
  final String? model;
}

abstract interface class Phone {
  /// App-private directory that is never backed up to a cloud account (the two SQLCipher files live here).
  Future<Directory> dataDirectory();
  Future<PhoneInfo> info();

  /// A PIN, pattern, password or biometric is set (REQ-SEC-110).
  Future<bool> hasScreenLock();

  /// The OS unlock prompt; true only when the user passed it.
  Future<bool> unlock();

  /// A `gps` object of TRD §6.3 for one point capture. Never throws.
  Future<Map<String, Object?>> readGps();

  /// The current position for live sharing while on the way to a visit (asks for permission if needed). Same shape as
  /// [readGps]; never throws.
  Future<Map<String, Object?>> readPosition();

  /// tel: and geo: hand-off.
  Future<void> openUri(Uri uri);
  Future<void> openLocationSettings();
  Future<bool> locationAllowed();
}

class RealPhone implements Phone {
  RealPhone([LocalAuthentication? auth]) : _auth = auth ?? LocalAuthentication();

  final LocalAuthentication _auth;

  @override
  Future<Directory> dataDirectory() async {
    final path = await limsPlatformChannel.invokeMethod<String>('dataDir');
    if (path == null || path.isEmpty) throw StateError('app data directory unavailable');
    return Directory(path);
  }

  @override
  Future<PhoneInfo> info() async {
    final m = await limsPlatformChannel.invokeMapMethod<String, String>('deviceInfo') ?? const {};
    String clip(String s, int n) => s.length > n ? s.substring(0, n) : s;
    final os = m['os_version'] ?? Platform.operatingSystemVersion;
    final model = m['model'];
    return PhoneInfo(
      platform: Platform.isIOS ? 'ios' : 'android',
      osVersion: clip(os.isEmpty ? 'unknown' : os, 40),
      model: model == null || model.isEmpty ? null : clip(model, 80),
    );
  }

  @override
  Future<bool> hasScreenLock() async {
    try {
      return await _auth.isDeviceSupported();
    } catch (_) {
      return false; // fail closed
    }
  }

  @override
  Future<bool> unlock() async {
    try {
      return await _auth.authenticate(localizedReason: 'Unlock to continue');
    } catch (_) {
      return false;
    }
  }

  @override
  Future<bool> locationAllowed() async {
    try {
      final p = await Geolocator.checkPermission();
      return await Geolocator.isLocationServiceEnabled() && (p == LocationPermission.always || p == LocationPermission.whileInUse);
    } catch (_) {
      return false;
    }
  }

  @override
  Future<Map<String, Object?>> readPosition() => readGps();

  @override
  Future<Map<String, Object?>> readGps() async {
    try {
      if (!await Geolocator.isLocationServiceEnabled()) return {'status': 'off'};
      var p = await Geolocator.checkPermission();
      if (p == LocationPermission.denied) p = await Geolocator.requestPermission();
      if (p == LocationPermission.denied || p == LocationPermission.deniedForever) return {'status': 'denied'};
      final at = await Geolocator.getCurrentPosition(
          locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, timeLimit: Duration(seconds: 8)));
      return {
        'status': 'ok',
        'latitude': at.latitude.toStringAsFixed(6),
        'longitude': at.longitude.toStringAsFixed(6),
        'accuracy_m': at.accuracy.isFinite ? at.accuracy.round().clamp(0, 10000) : 10000,
      };
    } catch (_) {
      return {'status': 'unavailable'}; // a visit is never blocked because a position could not be read
    }
  }

  @override
  Future<void> openUri(Uri uri) async {
    if (uri.scheme != 'tel' && uri.scheme != 'geo') return;
    if (uri.scheme == 'tel' && uri.path.isEmpty) return;
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  @override
  Future<void> openLocationSettings() async {
    try {
      await Geolocator.openLocationSettings();
    } catch (_) {}
  }
}
