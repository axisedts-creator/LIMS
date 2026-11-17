import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:sentry_flutter/sentry_flutter.dart';

import 'app.dart';
import 'flavour.dart';
import 'providers.dart';

Future<void> runPatientApp(Flavour flavour) async {
  WidgetsFlutterBinding.ensureInitialized();
  // LD-24 (2026-11-07, A33-1): self-hosted GlitchTip via the lims_ui wrapper; PHI scrubber in beforeSend; off when the
  // DSN is empty.
  await SentryFlutter.init(
    (o) => LimsErrorTracking.configure(o, dsn: kErrorTrackingDsn, environment: flavour.env, release: kAppVersion),
    appRunner: () => runApp(ProviderScope(
      overrides: [flavourProvider.overrideWithValue(flavour)],
      child: const PatientApp(),
    )),
  );
}
