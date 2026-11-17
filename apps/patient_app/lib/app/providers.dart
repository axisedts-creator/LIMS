// Riverpod wiring (CV §2.5). Providers hold the long-lived singletons; feature state added later must be invalidated on
// logout (TRD §3.5 rule: Riverpod state is cleared on logout).
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../core/api/api_client_factory.dart';
import '../core/lifecycle/background_timer.dart';
import '../core/lifecycle/secure_temp_files.dart';
import '../core/session/session_controller.dart';
import '../core/session/session_store.dart';
import 'app_lock_gate.dart';
import 'flavour.dart';

final flavourProvider = Provider<Flavour>((_) => throw StateError('flavourProvider must be overridden in bootstrap'));

/// Raw HTTP transport of the generated `lims_api_client` (CR-C16-016/017). Until that package lands the app has no
/// network layer, so this fails loudly instead of guessing the wire format.
final innerTransportProvider = Provider<PatientTransport>(
  (_) => (method, path, {query, headers, body}) => throw UnimplementedError('lims_api_client not generated yet (CR-C16-016/017)'),
);

final updateRequiredProvider = Provider<ValueNotifier<bool>>((ref) {
  final n = ValueNotifier(false);
  ref.onDispose(n.dispose);
  return n;
});

final backgroundTimerProvider = Provider<BackgroundTimer>((ref) {
  final t = BackgroundTimer(now: DateTime.now);
  ref.onDispose(t.dispose);
  return t;
});

final deviceAuthProvider = Provider<DeviceAuth>((_) => LocalDeviceAuth());

final secureTempFilesProvider = Provider<SecureTempFiles>(
  (_) => SecureTempFiles(Directory('${Directory.systemTemp.path}/lims_pdf')),
);

final sessionControllerProvider = Provider<SessionController>((ref) {
  // resolve/logout go straight to the inner transport (authenticated by the session token header, no JWT); routing them
  // through the interceptors would recurse into refresh.
  final inner = ref.watch(innerTransportProvider);
  final c = SessionController(
    store: const SessionStore(FlutterSecureStorage()),
    resolve: ({headers, body}) => inner('POST', '/v1/identity/auth/patient/session/resolve', headers: headers, body: body),
    logout: ({headers}) => inner('POST', '/v1/identity/auth/patient/session/logout', headers: headers),
    tempFiles: ref.watch(secureTempFilesProvider),
    now: DateTime.now,
  );
  ref.onDispose(c.status.dispose);
  return c;
});

final transportProvider = Provider<PatientTransport>((ref) => buildPatientTransport(
      inner: ref.watch(innerTransportProvider),
      session: ref.watch(sessionControllerProvider),
      appVersion: kAppVersion,
      platform: Platform.isIOS ? 'ios' : 'android',
      updateRequired: ref.watch(updateRequiredProvider),
    ));
