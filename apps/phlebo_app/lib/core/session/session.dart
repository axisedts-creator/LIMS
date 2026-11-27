// PHLEBO-UI-FULL-1: device auth (TRD §7.4, CR-C17-004) over the C2 staff mobile session routes.
// The session token rotates on every refresh (08 R10, reuse detection), so refreshes are single-flight and the new token is
// stored BEFORE the new access token is used. The access JWT stays in memory. Nothing is logged.
import 'dart:convert';

import 'package:lims_shared/lims_shared.dart';

import '../db/keys.dart';
import '../net/api_factory.dart';
import '../sync/sync_engine.dart' show SyncSession;

/// Secure-storage keys (TRD §7.1).
const deviceIdKey = 'phlebo.device_id';
const outboxOwnerKey = 'phlebo.outbox_owner_user_id';
const sessionTokenKey = 'phlebo.session_token';
const accessExpiresKey = 'phlebo.access_expires_at';
const sessionExpiresKey = 'phlebo.session_expires_at';
const displayNameKey = 'phlebo.display_name'; // [CONV] shown on Profile / Settings while offline
/// [CONV] Written only after the outbox-owner check and device registration passed. Without it a stored session token is
/// a sign-in that never finished (the app died half way) and is dropped, so it can never upload another user's records.
const sessionReadyKey = 'phlebo.session_ready';

const _base = '/v1/identity/mobile/sessions';

/// `sub` of a JWT (the user id the outbox is bound to, TRD §7.4 step 1). The signature is the server's business: the phone
/// only uses the value to compare "same person as before".
String? jwtSubject(String jwt) {
  final parts = jwt.split('.');
  if (parts.length != 3) return null;
  try {
    final claims = jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))));
    final sub = claims is Map ? claims['sub'] : null;
    return sub is String && sub.isNotEmpty ? sub : null;
  } on FormatException {
    return null;
  }
}

class SessionManager implements SyncSession {
  SessionManager({required this.identityApi, required this.store, required this.wallNow});

  /// Client for the identity routes; it sends no bearer token (the session token in the body authenticates).
  final ApiClient identityApi;
  final SecureKeyStore store;
  final DateTime Function() wallNow;

  String? _access;
  DateTime? _accessExpires;
  Future<void>? _refreshing;
  String? displayName;
  String? userId;

  String? get accessToken => _access;

  Future<bool> get hasStoredSession async =>
      await store.read(sessionTokenKey) != null && await store.read(sessionReadyKey) != null;

  Future<void> markReady() => store.write(sessionReadyKey, '1');

  /// Online only. Throws LimsException (auth.login_failed, auth.account_locked, ...) or ApiTransportException.
  Future<void> open({required String email, required String password, required String deviceId, required String platform}) async {
    final res = await identityApi.postJson(_base, {
      'email': email,
      'password': password,
      'app_instance_id': deviceId,
      'app_platform': platform,
    });
    await _accept(res);
  }

  Future<void> restore() async => displayName = await store.read(displayNameKey);

  Future<void> _accept(Map<String, Object?> res) async {
    final token = res['session_token'], access = res['access_token'];
    final accessExpires = DateTime.tryParse('${res['access_expires_at']}');
    final session = res['session'];
    if (token is! String || access is! String || accessExpires == null || session is! Map) {
      throw LimsException(LimsErrorCodes.commonInternal);
    }
    // A session that still needs a second factor or a new password cannot be used by this app.
    if (session['state'] != 'active') throw LimsException(LimsErrorCodes.authStepUpRequired);
    final actor = session['actor'];
    final name = actor is Map ? actor['display_name'] : null;
    await store.write(sessionTokenKey, token); // before the new access token is used
    await store.write(accessExpiresKey, '${res['access_expires_at']}');
    await store.write(sessionExpiresKey, '${res['session_expires_at']}');
    if (name is String) {
      displayName = name;
      await store.write(displayNameKey, name);
    }
    _access = access;
    _accessExpires = accessExpires;
    userId = jwtSubject(access);
  }

  @override
  Future<void> ensureFresh() async {
    final expires = _accessExpires;
    if (_access != null && expires != null && expires.difference(wallNow()) >= const Duration(seconds: 60)) return;
    await refreshNow();
  }

  @override
  Future<void> refreshNow() => _refreshing ??= _refresh().whenComplete(() => _refreshing = null);

  Future<void> _refresh() async {
    final token = await store.read(sessionTokenKey);
    if (token == null) throw LimsException(LimsErrorCodes.authSessionExpired);
    final res = await identityApi.postJson('$_base/refresh', {'session_token': token});
    await _accept(res);
  }

  /// Ends the server session. A network failure is ignored: the local session is dropped either way.
  Future<void> logout() async {
    final token = await store.read(sessionTokenKey);
    if (token != null) {
      try {
        await identityApi.postJson('$_base/logout', {'session_token': token});
      } on ApiTransportException {
        // offline: the server session ends at its own expiry
      } on LimsException {
        // already ended
      }
    }
    await forget();
  }

  /// Drops the session on this phone only.
  Future<void> forget() async {
    _access = null;
    _accessExpires = null;
    displayName = null;
    userId = null;
    for (final k in const [sessionReadyKey, sessionTokenKey, accessExpiresKey, sessionExpiresKey, displayNameKey]) {
      await store.delete(k);
    }
  }
}
