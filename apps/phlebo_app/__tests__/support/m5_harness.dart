// T0A-M5-PHLEBO-1 test harness (LD-258): mounts M2 route, M3 visit, M4 identity, M5 consent and M6 collect on a 360 dp phone at a given
// text scale, with or without reduced motion, inside the real LimsTheme. Synthetic data only. Restyle only: no screen API changes.
// The existing hc27 / visit fixtures supply the data (no existing file is edited).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:phlebo_app/features/collect/ui/collect_screen.dart';
import 'package:phlebo_app/features/consent/ui/consent_screen.dart';
import 'package:phlebo_app/features/identity/ui/identity_screen.dart';
import 'package:phlebo_app/features/outbox/domain/sync_summary.dart';
import 'package:phlebo_app/features/route/domain/route_models.dart';
import 'package:phlebo_app/features/route/ui/route_screen.dart';
import 'package:phlebo_app/features/visit/ui/visit_screen.dart';

import 'hc27_fixture.dart';

typedef Open = Future<void> Function(WidgetTester t, {double scale, bool reduceMotion});

/// 360 dp wide phone. Text scale and reduced motion are app-level MediaQuery values (what the OS setting sets).
Future<void> mount(WidgetTester t, Widget screen, {double scale = 1.0, bool reduceMotion = false, bool settle = true}) async {
  t.view.physicalSize = const Size(360, 780);
  t.view.devicePixelRatio = 1.0;
  addTearDown(() {
    t.view.resetPhysicalSize();
    t.view.resetDevicePixelRatio();
  });
  await t.pumpWidget(MaterialApp(
    theme: LimsTheme.light(),
    builder: (c, child) => MediaQuery(
      data: MediaQuery.of(c).copyWith(textScaler: TextScaler.linear(scale), disableAnimations: reduceMotion),
      child: child!,
    ),
    home: screen,
  ));
  if (settle) {
    await t.pumpAndSettle();
  } else {
    await t.pump(); // first frame only: the card enter motion has just started
  }
}

Future<void> pumpFor(WidgetTester t, Duration d) async {
  for (var left = d; left > Duration.zero; left -= const Duration(milliseconds: 50)) {
    await t.pump(const Duration(milliseconds: 50));
  }
}

List<RouteVisit> allStatuses() => [
      routeVisit(1),
      routeVisit(2, status: 'in_progress', collected: 1),
      routeVisit(3, status: 'completed', collected: 2),
      routeVisit(4, status: 'failed'),
      routeVisit(5, status: 'cancelled'),
    ];

RouteScreen routeScreen({List<RouteVisit>? visits, bool offline = false, bool purged = false, void Function(String)? onOpenVisit}) => RouteScreen(
      routeDate: DateTime(2026, 11, 14),
      visits: visits ?? allStatuses(),
      purged: purged,
      offline: offline,
      dataAsOf: offline ? DateTime(2026, 11, 14, 7, 5) : null,
      sync: SyncSummary(waiting: 3, lastUpload: DateTime(2026, 11, 14, 9, 15)),
      onRefresh: () async {},
      onOpenVisit: onOpenVisit ?? (_) {},
      onOpenHandover: () {},
      onOpenOutbox: () {},
      onOpenSettings: () {},
      onHelp: () {},
    );

Future<void> openRoute(WidgetTester t, {double scale = 1.0, bool reduceMotion = false, bool settle = true, void Function(String)? onOpenVisit}) =>
    mount(t, routeScreen(onOpenVisit: onOpenVisit), scale: scale, reduceMotion: reduceMotion, settle: settle);

Future<void> openRouteOffline(WidgetTester t, {double scale = 1.0, bool reduceMotion = false, bool settle = true}) =>
    mount(t, routeScreen(offline: true), scale: scale, reduceMotion: reduceMotion, settle: settle);

Future<void> openVisit(WidgetTester t, {double scale = 1.0, bool reduceMotion = false, bool settle = true}) => mount(
      t,
      VisitScreen(
        visit: sampleVisit(),
        config: sampleConfig(),
        sink: RecordingSink(),
        readGps: readGpsOff,
        launchUri: (_) async {},
        onArrived: () {},
        onCannotDo: () {},
      ),
      scale: scale,
      reduceMotion: reduceMotion,
      settle: settle,
    );

Future<void> openIdentity(WidgetTester t, {double scale = 1.0, bool reduceMotion = false, bool settle = true, String second = 'phone'}) => mount(
      t,
      IdentityScreen(visit: sampleVisit(secondIdentifier: second), sink: RecordingSink(), onContinue: () {}, onFail: (_) {}, onBack: () {}),
      scale: scale,
      reduceMotion: reduceMotion,
      settle: settle,
    );

Future<void> openConsent(WidgetTester t, {double scale = 1.0, bool reduceMotion = false, bool settle = true}) => mount(
      t,
      ConsentScreen(visit: sampleVisit(), config: sampleConfig(), sink: RecordingSink(), onAgreed: () {}, onRefused: () {}),
      scale: scale,
      reduceMotion: reduceMotion,
      settle: settle,
    );

Future<void> openCollect(WidgetTester t, {double scale = 1.0, bool reduceMotion = false, bool settle = true}) => mount(
      t,
      CollectScreen(
        visit: sampleVisit(),
        config: sampleConfig(),
        otherVisitBarcodes: const {otherVisitBarcode},
        sink: RecordingSink(),
        readGps: readGpsOff,
        now: () => DateTime(2026, 11, 14, 9, 30),
        onDone: () {},
        initialCollected: const {tube1},
      ),
      scale: scale,
      reduceMotion: reduceMotion,
      settle: settle,
    );

/// The screens of the task. `cards`: the screen's own content must sit on white 24 radius cards.
final screens = <({String id, Open open, bool cards})>[
  (id: 'M2 route', open: openRoute, cards: true),
  (id: 'M2 route offline', open: openRouteOffline, cards: true),
  (id: 'M3 visit', open: openVisit, cards: true),
  (id: 'M4 identity', open: openIdentity, cards: true),
  (id: 'M5 consent', open: openConsent, cards: true),
  (id: 'M6 collect', open: openCollect, cards: false), // collect/** is not in the task's file list: guards only
];

/// WCAG relative-luminance contrast of two opaque colours.
double contrast(Color a, Color b) {
  final la = a.computeLuminance(), lb = b.computeLuminance();
  final hi = la > lb ? la : lb, lo = la > lb ? lb : la;
  return (hi + 0.05) / (lo + 0.05);
}
