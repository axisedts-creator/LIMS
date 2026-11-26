// HC-T21 / PHLEBO-UI-FULL-1 entry point. Runtime config via --dart-define=FLAVOR=dev|staging|prod
// --dart-define=API_BASE_URL=https://... --dart-define=PINNED_CA_PEM_B64=<base64 of the PEM issuing CA certs, REQ-SEC-104>
// [--dart-define=APP_VERSION=x.y.z] [--dart-define=SENTRY_DSN=...] (LD-24: unset -> error tracking off).
// No secrets are compiled in (REQ-SEC-107): a CA certificate is public.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:sentry_flutter/sentry_flutter.dart';

import 'app/app.dart';
import 'app/controller.dart';
import 'app/error_tracking.dart';
import 'app/flavor.dart';
import 'app/router.dart';
import 'app/shell.dart';
import 'core/db/keys.dart';
import 'core/net/api_factory.dart';
import 'core/platform/boot_id.dart';
import 'core/platform/monotonic_clock.dart';
import 'core/platform/phone.dart';
import 'features/apply/data/application_api.dart';
import 'features/apply/data/file_pick.dart';

const _appVersion = String.fromEnvironment('APP_VERSION', defaultValue: '0.0.0');

/// Throws on a missing or unreadable value: without pinned certificates there is no connection at all (fail closed).
List<String> _pinnedCas(String b64) {
  if (b64.isEmpty) throw ArgumentError('PINNED_CA_PEM_B64 is not set');
  final pems = RegExp(r'-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----')
      .allMatches(utf8.decode(base64.decode(b64)))
      .map((m) => m[0]!)
      .toList();
  if (pems.isEmpty) throw ArgumentError('PINNED_CA_PEM_B64 holds no certificate');
  return pems;
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final config = AppConfig.fromDefines(const {
    'FLAVOR': String.fromEnvironment('FLAVOR'),
    'API_BASE_URL': String.fromEnvironment('API_BASE_URL'),
    'SENTRY_DSN': String.fromEnvironment('SENTRY_DSN'),
  });
  final cas = _pinnedCas(const String.fromEnvironment('PINNED_CA_PEM_B64'));
  final base = config.apiBaseUrl.toString().replaceFirst(RegExp(r'/+$'), '');

  final controller = AppController(
    phone: RealPhone(),
    keyStore: FlutterSecureKeyStore(),
    apiBuilder: (prefix, deviceId, token) => createApiClient(
        baseUrl: Uri.parse('$base$prefix'), pinnedCaPems: cas, appVersion: _appVersion, deviceId: deviceId, accessToken: token),
    clock: PlatformMonotonicClock(),
    bootId: PlatformBootIdSource(),
    appVersion: _appVersion,
  );
  // The lab an application goes to. Without it the "Apply to join" link is hidden.
  const tenantCode = String.fromEnvironment('TENANT_CODE');
  if (RegExp(r'^[a-z][a-z0-9_]{2,31}$').hasMatch(tenantCode)) {
    controller
      ..pickApplicationFile = pickApplicationFile
      ..sendApplication = (draft) async {
        final api = createApiClient(baseUrl: Uri.parse(base), pinnedCaPems: cas, appVersion: _appVersion, deviceId: controller.deviceId, accessToken: () => null);
        try {
          return await sendApplication(api, tenantCode, draft);
        } finally {
          api.close();
        }
      };
  }
  final router = buildRouter(controller);
  final version = '${config.flavor == Flavor.prod ? '' : '${config.flavor.name} · '}Phlebotomist app $_appVersion';

  // With no DSN the SDK stays disabled, but appRunner still runs the app.
  await SentryFlutter.init(
    (o) => configureAppErrorTracking(o, config),
    appRunner: () {
      runApp(PhleboApp(
        router: router,
        gate: (child) => PhaseGate(controller: controller, versionLabel: version, onSignedOut: () => resetNavigation(router), child: child),
      ));
      unawaited(controller.start());
    },
  );
}
