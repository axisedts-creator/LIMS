// T-A1 test rig: fake clock, fake identity API, mock secure storage, temp dir. Synthetic data only.
import 'dart:async';
import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:patient_app/core/lifecycle/secure_temp_files.dart';
import 'package:patient_app/core/session/session_controller.dart';
import 'package:patient_app/core/session/session_store.dart';

/// 43-char opaque token, shape of the OpenAPI pattern ^[A-Za-z0-9_-]{43}$.
String tok(String p) => p.padRight(43, 'x');

String jwt(int n) => 'eyJhbGciOiJFUzI1NiJ9.synthetic$n.signature';

class FakeIdentity {
  final List<Map<String, String>> resolveHeaders = [];
  final List<Map<String, String>> logoutHeaders = [];
  int resolveCalls = 0;
  int logoutCalls = 0;

  /// Awaited before each resolve answers (lets tests hold a refresh in flight).
  Future<void>? hold;

  /// Throws instead of answering when set; receives the 1-based call number.
  Object? Function(int call)? failWith;
  Object? Function(int call)? logoutFailWith;

  /// Clock the fake uses to stamp `access_expires_at` (now + 1 h).
  late DateTime Function() now;

  /// Assumption (CR-C16-004): the patient resolve answer carries the rotated `session_token`.
  Future<Object?> resolve({Map<String, String>? headers, Object? body}) async {
    final call = ++resolveCalls;
    resolveHeaders.add(Map.of(headers ?? const {}));
    if (hold != null) await hold;
    final f = failWith?.call(call);
    if (f != null) throw f;
    return <String, Object?>{
      'session_token': tok('S$call'),
      'access_token': jwt(call),
      'access_expires_at': now().add(const Duration(hours: 1)).toUtc().toIso8601String(),
      'session': {'session_id': '0193a5c0-0000-7000-8000-000000000001', 'kind': 'patient', 'state': 'active'},
    };
  }

  Future<Object?> logout({Map<String, String>? headers}) async {
    logoutCalls++;
    logoutHeaders.add(Map.of(headers ?? const {}));
    final f = logoutFailWith?.call(logoutCalls);
    if (f != null) throw f;
    return <String, Object?>{};
  }
}

class Rig {
  Rig._(this.storage, this.store, this.identity, this.tempDir, this.temp, this.controller, this._clock);

  final FlutterSecureStorage storage;
  final SessionStore store;
  final FakeIdentity identity;
  final Directory tempDir;
  final SecureTempFiles temp;
  final SessionController controller;
  final _Clock _clock;

  DateTime get now => _clock.now;
  void advance(Duration d) => _clock.now = _clock.now.add(d);

  static Future<Rig> create() async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    const storage = FlutterSecureStorage();
    final store = SessionStore(storage);
    final clock = _Clock(DateTime.utc(2026, 11, 12, 6));
    final identity = FakeIdentity()..now = () => clock.now;
    final dir = await Directory.systemTemp.createTemp('patient_app_t_a1_');
    final temp = SecureTempFiles(dir);
    final c = SessionController(
      store: store,
      resolve: identity.resolve,
      logout: identity.logout,
      tempFiles: temp,
      now: () => clock.now,
    );
    return Rig._(storage, store, identity, dir, temp, c, clock);
  }

  /// Signed-in state as after verifyPatientOtp: session token S0, JWT jwt(0) valid 1 h.
  Future<void> signIn() => controller.signIn(
        sessionToken: tok('S0'),
        accessToken: jwt(0),
        accessExpiresAt: now.add(const Duration(hours: 1)),
      );

  Future<void> dispose() async {
    if (await tempDir.exists()) await tempDir.delete(recursive: true);
  }
}

class _Clock {
  _Clock(this.now);
  DateTime now;
}
