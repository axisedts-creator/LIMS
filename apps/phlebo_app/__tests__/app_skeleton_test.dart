// HC-T21 app skeleton: flavours, router, theme, error tracking (TRD §3.4; plan row HC-T21; REQ-SEC-107 no secrets in the binary).
// LD-24 (2026-11-07, A33-1, binding for HC-T21): client error tracking = Sentry SDK via the lims_ui wrapper
// (LimsErrorTracking / limsBeforeSend) pointing at self-hosted GlitchTip; DSN from runtime config; SDK OFF when unset.
//
// ASSUMED API (package:phlebo_app/...):
//   app/flavor.dart:  enum Flavor { dev, staging, prod }
//                     class AppConfig { Flavor flavor; Uri apiBaseUrl; String? sentryDsn;
//                       factory AppConfig.fromDefines(Map<String, String> defines) }   // keys FLAVOR, API_BASE_URL, SENTRY_DSN
//                     fromDefines: ArgumentError when FLAVOR is missing/unknown, API_BASE_URL missing/not https/has user-info; blank SENTRY_DSN -> null
//   app/error_tracking.dart: void configureAppErrorTracking(SentryFlutterOptions options, AppConfig config)
//   app/routes.dart:  String phleboRouteLocation(String routeDate)   // '/routes/2026-11-12'; ArgumentError unless a real YYYY-MM-DD date
//                     String phleboVisitLocation(String visitId)     // '/visits/<uuid>';   ArgumentError unless a UUID
//   app/router.dart:  GoRouter buildRouter()                          // GoRoute paths '/routes/:route_date' and '/visits/:visit_id' (contracts/routes.yaml ids phlebo_app.route / phlebo_app.visit)
//   app/app.dart:     class PhleboApp extends StatelessWidget { PhleboApp({required GoRouter router}) }  // MaterialApp.router with LimsTheme.light()
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:phlebo_app/app/app.dart';
import 'package:phlebo_app/app/error_tracking.dart';
import 'package:phlebo_app/app/flavor.dart';
import 'package:phlebo_app/app/router.dart';
import 'package:phlebo_app/app/routes.dart';
import 'package:sentry_flutter/sentry_flutter.dart';

const _api = 'https://api.staging.example.test/v1/homecollection';
const _visit = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2d';

void main() {
  group('flavours', () {
    test('exactly dev, staging, prod', () {
      expect(Flavor.values.map((f) => f.name), ['dev', 'staging', 'prod']);
    });

    for (final f in ['dev', 'staging', 'prod']) {
      test('fromDefines builds the $f config; DSN unset -> null (SDK off)', () {
        final c = AppConfig.fromDefines({'FLAVOR': f, 'API_BASE_URL': _api});
        expect(c.flavor.name, f);
        expect(c.apiBaseUrl, Uri.parse(_api));
        expect(c.sentryDsn, isNull);
      });
    }

    test('blank / whitespace DSN -> null; real DSN kept', () {
      expect(AppConfig.fromDefines({'FLAVOR': 'dev', 'API_BASE_URL': _api, 'SENTRY_DSN': ''}).sentryDsn, isNull);
      expect(AppConfig.fromDefines({'FLAVOR': 'dev', 'API_BASE_URL': _api, 'SENTRY_DSN': '  '}).sentryDsn, isNull);
      const dsn = 'https://abc123@glitchtip.example.test/7';
      expect(AppConfig.fromDefines({'FLAVOR': 'dev', 'API_BASE_URL': _api, 'SENTRY_DSN': dsn}).sentryDsn, dsn);
    });

    test('bad defines are refused (no silent default flavour, no plaintext/credentialed API URL)', () {
      final bad = <Map<String, String>>[
        {'API_BASE_URL': _api}, // FLAVOR missing
        {'FLAVOR': '', 'API_BASE_URL': _api},
        {'FLAVOR': 'production', 'API_BASE_URL': _api}, // unknown name
        {'FLAVOR': 'PROD', 'API_BASE_URL': _api}, // case-sensitive
        {'FLAVOR': 'dev'}, // API_BASE_URL missing
        {'FLAVOR': 'dev', 'API_BASE_URL': ''},
        {'FLAVOR': 'dev', 'API_BASE_URL': 'http://api.dev.example.test/v1'}, // REQ-SEC-104: TLS only
        {'FLAVOR': 'dev', 'API_BASE_URL': 'https://user:secret@api.dev.example.test/v1'}, // REQ-SEC-107
        {'FLAVOR': 'dev', 'API_BASE_URL': '/v1/homecollection'}, // relative
      ];
      for (final d in bad) {
        expect(() => AppConfig.fromDefines(d), throwsArgumentError, reason: '$d');
      }
    });
  });

  group('error tracking (LD-24)', () {
    test('DSN unset -> SDK stays off; scrubber installed anyway; no PII, screenshots or view hierarchy', () {
      final o = SentryFlutterOptions();
      configureAppErrorTracking(o, AppConfig.fromDefines({'FLAVOR': 'dev', 'API_BASE_URL': _api}));
      expect(o.dsn, isNull);
      expect(o.beforeSend, same(limsBeforeSend));
      expect(o.sendDefaultPii, isFalse);
      expect(o.attachScreenshot, isFalse);
      expect(o.attachViewHierarchy, isFalse);
    });

    test('DSN set -> options.dsn set, environment = flavour name, scrubber installed', () {
      const dsn = 'https://abc123@glitchtip.example.test/7';
      final o = SentryFlutterOptions();
      configureAppErrorTracking(o, AppConfig.fromDefines({'FLAVOR': 'staging', 'API_BASE_URL': _api, 'SENTRY_DSN': dsn}));
      expect(o.dsn, dsn);
      expect(o.environment, 'staging');
      expect(o.beforeSend, same(limsBeforeSend));
      expect(o.sendDefaultPii, isFalse);
    });
  });

  group('router (routes.yaml ids phlebo_app.route / phlebo_app.visit)', () {
    List<String> paths(List<RouteBase> rs, [String prefix = '']) => [
          for (final r in rs)
            if (r is GoRoute) ...[
              '$prefix${r.path.startsWith('/') ? r.path : '/${r.path}'}',
              ...paths(r.routes, '$prefix${r.path.startsWith('/') ? r.path : '/${r.path}'}'),
            ],
        ];
    String colon(String tpl) => tpl.replaceAllMapped(RegExp(r'\{(\w+)\}'), (m) => ':${m[1]}');

    test('registers the two contract paths verbatim from limsRoutePaths', () {
      final registered = paths(buildRouter().configuration.routes);
      expect(registered, contains(colon(limsRoutePaths['phlebo_app.route']!)));
      expect(registered, contains(colon(limsRoutePaths['phlebo_app.visit']!)));
    });

    test('location builders produce the contract paths', () {
      expect(phleboRouteLocation('2026-11-12'), '/routes/2026-11-12');
      expect(phleboVisitLocation(_visit), '/visits/$_visit');
    });

    test('location builders reject path-injection and malformed ids', () {
      for (final bad in ['', '../admin', '$_visit/../x', '$_visit?x=1', '$_visit#f', 'not-a-uuid', '%2e%2e', ' $_visit']) {
        expect(() => phleboVisitLocation(bad), throwsArgumentError, reason: bad);
      }
      for (final bad in ['', '2026-13-01', '2026-02-30', '26-11-12', '2026-11-12/../x', '2026-11-12?x=1', '2082-07-27 BS']) {
        expect(() => phleboRouteLocation(bad), throwsArgumentError, reason: bad);
      }
    });
  });

  group('theme', () {
    testWidgets('PhleboApp uses LimsTheme.light()', (tester) async {
      final router = GoRouter(routes: [GoRoute(path: '/', builder: (_, __) => const SizedBox())]);
      await tester.pumpWidget(PhleboApp(router: router));
      await tester.pump();
      final app = tester.widget<MaterialApp>(find.byType(MaterialApp));
      expect(app.theme?.colorScheme.primary, LimsTheme.light().colorScheme.primary);
      expect(app.theme?.textTheme.bodyMedium?.fontFamily, LimsTheme.light().textTheme.bodyMedium?.fontFamily);
    });
  });
}
