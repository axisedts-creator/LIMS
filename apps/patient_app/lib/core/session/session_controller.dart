// 02-TRD §4.1 step 5 (US-EN-02.1/2/3/5, review C16 #20): session token in secure storage, access JWT in memory only,
// single-flight refresh, token rotation persisted BEFORE refresh() returns, wipe on auth.session_expired and logout.
import 'package:flutter/foundation.dart';
import 'package:lims_shared/lims_shared.dart';

import '../lifecycle/secure_temp_files.dart';
import 'session_store.dart';

enum SessionStatus { signedOut, signedIn }

/// resolvePatientSession / logoutPatientSession as the generated client exposes them (CR-C16-004, CR-C16-016).
typedef ResolveSession = Future<Object?> Function({Map<String, String>? headers, Object? body});
typedef LogoutSession = Future<Object?> Function({Map<String, String>? headers});

const patientSessionHeader = 'X-Lims-Patient-Session';

class SessionController {
  SessionController({
    required SessionStore store,
    required ResolveSession resolve,
    required LogoutSession logout,
    required SecureTempFiles tempFiles,
    required DateTime Function() now,
  })  : _store = store,
        _resolve = resolve,
        _logout = logout,
        _temp = tempFiles,
        _now = now;

  /// Refresh when the JWT has this much life left or less (TRD §4.1: "expires within 120 s").
  static const refreshWindow = Duration(seconds: 120);

  final SessionStore _store;
  final ResolveSession _resolve;
  final LogoutSession _logout;
  final SecureTempFiles _temp;
  final DateTime Function() _now;

  final ValueNotifier<SessionStatus> status = ValueNotifier(SessionStatus.signedOut);

  String? _accessToken;
  DateTime? _accessExpiresAt;
  Future<void>? _inFlight;
  int _epoch = 0; // bumped by every wipe so a refresh that finishes after logout cannot resurrect the session

  /// In-memory only; never persisted (REQ-SEC-102).
  String? get accessToken => _accessToken;

  Future<void> restore() async {
    final t = await _store.read();
    status.value = t == null ? SessionStatus.signedOut : SessionStatus.signedIn;
  }

  Future<void> signIn({required String sessionToken, required String accessToken, required DateTime accessExpiresAt}) async {
    await _store.write(sessionToken);
    _accessToken = accessToken;
    _accessExpiresAt = accessExpiresAt;
    status.value = SessionStatus.signedIn;
  }

  /// JWT for the next call, refreshed first when missing or within [refreshWindow] of expiry. Null when signed out.
  Future<String?> freshAccessToken() async {
    if (status.value != SessionStatus.signedIn) return null;
    final exp = _accessExpiresAt;
    if (_accessToken == null || exp == null || exp.difference(_now()) <= refreshWindow) await refresh();
    return _accessToken;
  }

  /// Single-flight: concurrent callers share one resolve call and all get its result or error.
  Future<void> refresh() => _inFlight ??= _refresh().whenComplete(() => _inFlight = null);

  Future<void> _refresh() async {
    if (status.value != SessionStatus.signedIn) throw LimsException(LimsErrorCodes.authUnauthenticated);
    final epoch = _epoch;
    final token = await _store.read();
    if (token == null) {
      await _wipe();
      throw LimsException(LimsErrorCodes.authSessionExpired);
    }
    final Object? answer;
    try {
      answer = await _resolve(headers: {patientSessionHeader: token});
    } on LimsException catch (e) {
      if (e.code == LimsErrorCodes.authSessionExpired) await _wipe();
      rethrow;
    }
    final r = answer is Map ? answer : const <String, Object?>{};
    final rotated = r['session_token'];
    final jwt = r['access_token'];
    final exp = DateTime.tryParse('${r['access_expires_at']}');
    if (rotated is! String || jwt is! String || exp == null) throw LimsException(LimsErrorCodes.commonInternal);
    if (epoch != _epoch) return; // logged out / wiped while in flight: drop the answer
    await _store.write(rotated); // before returning, so the retry and the next refresh present the new token
    _accessToken = jwt;
    _accessExpiresAt = exp;
  }

  /// A call answered `auth.session_expired`: the session is gone server-side.
  Future<void> expire() => _wipe();

  /// US-EN-02.5: server logout, then wipe. The wipe happens even when the server call fails (the error is rethrown).
  Future<void> logout() async {
    if (status.value == SessionStatus.signedOut) return;
    try {
      final token = await _store.read();
      if (token != null) await _logout(headers: {patientSessionHeader: token});
    } finally {
      await _wipe();
    }
  }

  Future<void> _wipe() async {
    _epoch++;
    _accessToken = null;
    _accessExpiresAt = null;
    try {
      await _store.wipe();
      await _temp.deleteAll();
    } finally {
      status.value = SessionStatus.signedOut;
    }
  }
}
