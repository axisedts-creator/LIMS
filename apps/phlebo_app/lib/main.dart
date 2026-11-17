// HC-T21 entry point. Runtime config via --dart-define=FLAVOR=dev|staging|prod --dart-define=API_BASE_URL=https://...
// [--dart-define=SENTRY_DSN=...] (LD-24: unset -> error tracking off). No secrets are compiled in (REQ-SEC-107).
import 'package:flutter/material.dart';
import 'package:sentry_flutter/sentry_flutter.dart';

import 'app/app.dart';
import 'app/error_tracking.dart';
import 'app/flavor.dart';
import 'app/router.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final config = AppConfig.fromDefines(const {
    'FLAVOR': String.fromEnvironment('FLAVOR'),
    'API_BASE_URL': String.fromEnvironment('API_BASE_URL'),
    'SENTRY_DSN': String.fromEnvironment('SENTRY_DSN'),
  });
  // With no DSN the SDK stays disabled, but appRunner still runs the app.
  await SentryFlutter.init(
    (o) => configureAppErrorTracking(o, config),
    appRunner: () => runApp(PhleboApp(router: buildRouter())),
  );
}
