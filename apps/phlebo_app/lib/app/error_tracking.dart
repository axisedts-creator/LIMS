// LD-24 (2026-11-07, A33-1): Sentry SDK -> self-hosted GlitchTip via the lims_ui wrapper; off when the DSN is unset.
import 'package:lims_ui/lims_ui.dart';
import 'package:sentry_flutter/sentry_flutter.dart';

import 'flavor.dart';

void configureAppErrorTracking(SentryFlutterOptions options, AppConfig config) =>
    LimsErrorTracking.configure(options, dsn: config.sentryDsn, environment: config.flavor.name);
