// Interceptors around the generated client's transport (02-TRD §3.5; US-EN-02.2, US-EN-20.1; review C16 #20):
// Bearer JWT, app version/platform headers, UUIDv7 X-Request-Id, 401 refresh-once, 426 -> A1. No response caching here.
// The generated `lims_api_client` (CR-C16-016/017) is not in the workspace yet; this typedef is the shape it takes.
import 'package:flutter/foundation.dart';
import 'package:lims_shared/lims_shared.dart';

import '../session/session_controller.dart';

typedef PatientTransport = Future<Object?> Function(
  String method,
  String path, {
  Map<String, Object?>? query,
  Map<String, String>? headers,
  Object? body,
});

PatientTransport buildPatientTransport({
  required PatientTransport inner,
  required SessionController session,
  required String appVersion,
  required String platform,
  required ValueNotifier<bool> updateRequired,
}) {
  return (method, path, {query, headers, body}) async {
    final given = <String, String>{...?headers};
    // Pre-auth calls carry their own credential (OTP challenge); it is never replaced and never triggers a refresh.
    final ownCredential = given.keys.any((k) => k.toLowerCase() == 'authorization');

    Future<Object?> attempt(String? jwt) => inner(method, path, query: query, headers: {
          ...given,
          'X-Lims-App-Version': appVersion,
          'X-Lims-App-Platform': platform,
          'X-Request-Id': uuidv7(),
          if (!ownCredential && jwt != null) 'Authorization': 'Bearer $jwt',
        }, body: body);

    final jwt = ownCredential ? null : await session.freshAccessToken();
    try {
      return await attempt(jwt);
    } on LimsException catch (e) {
      switch (e.code) {
        case LimsErrorCodes.engagementAppVersionUnsupported:
          updateRequired.value = true; // 426: router shows A1; no refresh, no retry, session kept
          rethrow;
        case LimsErrorCodes.authSessionExpired:
          await session.expire();
          rethrow;
        case LimsErrorCodes.authTokenExpired:
          if (ownCredential || session.status.value != SessionStatus.signedIn) rethrow;
          // Another call may have refreshed already; only hit resolve when the JWT we sent is still the current one.
          if (session.accessToken == null || session.accessToken == jwt) await session.refresh(); // session_expired: wiped + thrown
          return attempt(session.accessToken); // exactly one retry; a second failure is surfaced
        default:
          rethrow;
      }
    }
  };
}
