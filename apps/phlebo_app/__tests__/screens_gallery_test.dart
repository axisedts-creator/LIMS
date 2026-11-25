// Gallery of every phlebotomist screen on synthetic preview data: each renders at phone size and at 2.0 text scale without
// an exception or overflow (C17 04-UI-UX §3 global rules). With PHLEBO_SHOTS_DIR set it also writes one PNG per screen.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phlebo_app/features/alerts/ui/alerts_screen.dart';
import 'package:phlebo_app/features/collect/ui/collect_screen.dart';
import 'package:phlebo_app/features/consent/ui/consent_screen.dart';
import 'package:phlebo_app/features/entry/ui/device_notice_screen.dart';
import 'package:phlebo_app/features/entry/ui/lock_screen.dart';
import 'package:phlebo_app/features/entry/ui/login_screen.dart';
import 'package:phlebo_app/features/entry/ui/splash_screen.dart';
import 'package:phlebo_app/features/handover/domain/handover_status.dart';
import 'package:phlebo_app/features/handover/ui/handover_receipt_screen.dart';
import 'package:phlebo_app/features/handover/ui/handover_screen.dart';
import 'package:phlebo_app/features/history/ui/history_day_screen.dart';
import 'package:phlebo_app/features/history/ui/history_screen.dart';
import 'package:phlebo_app/features/identity/ui/identity_screen.dart';
import 'package:phlebo_app/features/outbox/ui/outbox_screen.dart';
import 'package:phlebo_app/features/outcome/ui/complete_screen.dart';
import 'package:phlebo_app/features/outcome/ui/fail_visit_screen.dart';
import 'package:phlebo_app/features/payment/ui/payment_screen.dart';
import 'package:phlebo_app/features/profile/ui/id_card_screen.dart';
import 'package:phlebo_app/features/profile/ui/location_screen.dart';
import 'package:phlebo_app/features/profile/ui/profile_screen.dart';
import 'package:phlebo_app/features/route/ui/queue_screen.dart';
import 'package:phlebo_app/features/route/ui/route_screen.dart';
import 'package:phlebo_app/features/settings/domain/sign_out.dart';
import 'package:phlebo_app/features/settings/ui/settings_screen.dart';
import 'package:phlebo_app/features/shell/ui/phlebo_shell.dart';
import 'package:phlebo_app/features/support/ui/contact_screen.dart';
import 'package:phlebo_app/features/support/ui/faq_screen.dart';
import 'package:phlebo_app/features/support/ui/help_screen.dart';
import 'package:phlebo_app/features/support/ui/report_problem_screen.dart';
import 'package:phlebo_app/features/travel/domain/travel_models.dart';
import 'package:phlebo_app/features/visit/ui/visit_screen.dart';
import 'package:phlebo_app/preview/preview_data.dart';
import 'package:phlebo_app/preview/preview_store.dart';
import 'package:phlebo_app/ui/phlebo_theme.dart';

import 'support/shots.dart';

final _now = DateTime(2026, 11, 25, 9, 50);

typedef _Build = Widget Function(PreviewStore s);

Future<Map<String, Object?>> _gps() async => const {'status': 'off'};

void main() {
  setUpAll(loadTestFonts);

  PreviewStore store() => PreviewStore(now: () => _now, syncDelay: Duration.zero);

  final entries = <String, _Build>{
    '01_splash': (s) => const SplashScreen(),
    '02_login': (s) => LoginScreen(onSignIn: (_, __) async => LoginOutcome.ok, appVersion: '0.0.0+1', environmentName: 'Preview'),
    '02b_login_wrong_password': (s) => LoginScreen(onSignIn: (_, __) async => LoginOutcome.ok, appVersion: '0.0.0+1', initialOutcome: LoginOutcome.badCredentials),
    '02c_login_offline': (s) => LoginScreen(onSignIn: (_, __) async => LoginOutcome.ok, appVersion: '0.0.0+1', offline: true),
    '02d_login_other_user_unsent': (s) => LoginScreen(onSignIn: (_, __) async => LoginOutcome.ok, appVersion: '0.0.0+1', onUseFingerprint: () async {}, initialOutcome: LoginOutcome.otherUserUnsent),
    '03_lock': (s) => LockScreen(onUnlock: () {}, attemptsLeft: 3),
    '03b_session_ended': (s) => LockScreen(onUnlock: () {}, sessionEnded: true, onSignInAgain: () {}),
    '04_wipe_requested': (s) => const DeviceNoticeScreen(kind: DeviceNotice.wipeRequested, pendingChanges: 2),
    '04b_wiped': (s) => const DeviceNoticeScreen(kind: DeviceNotice.wiped),
    '04c_update_required': (s) => const DeviceNoticeScreen(kind: DeviceNotice.updateRequired),
    '04d_no_screen_lock': (s) => const DeviceNoticeScreen(kind: DeviceNotice.noScreenLock),
    '04e_rooted': (s) => const DeviceNoticeScreen(kind: DeviceNotice.rooted),
    '05_today': (s) => QueueScreen(routeDate: _now, visits: s.routeVisits, purged: false, sync: s.sync, dataAsOf: s.lastDownload, onRefresh: () async {}, onOpenVisit: (_) {}, onStartTravel: (_) {}, onOpenAll: () {}, onOpenOutbox: () {}, onOpenHandover: () {}, handoverTubes: 5, onHelp: () {}),
    '05b_today_offline': (s) => QueueScreen(routeDate: _now, visits: s.routeVisits, purged: false, offline: true, sync: s.sync, dataAsOf: s.lastDownload, onRefresh: () async {}, onOpenVisit: (_) {}, onOpenAll: () {}, onOpenOutbox: () {}, onHelp: () {}),
    '05c_today_empty': (s) => QueueScreen(routeDate: _now, visits: const [], purged: false, sync: s.sync, onRefresh: () async {}, onOpenVisit: (_) {}, onOpenAll: () {}, onOpenOutbox: () {}, onHelp: () {}),
    '05d_today_purged': (s) => QueueScreen(routeDate: _now, visits: const [], purged: true, sync: s.sync, onRefresh: () async {}, onOpenVisit: (_) {}, onOpenAll: () {}, onOpenOutbox: () {}, onHelp: () {}),
    '05e_today_all_done': (s) => QueueScreen(
          routeDate: _now,
          visits: [for (final v in s.routeVisits.where((v) => v.sequence <= 3)) v],
          purged: false,
          sync: s.sync,
          onRefresh: () async {},
          onOpenVisit: (_) {},
          onOpenAll: () {},
          onOpenOutbox: () {},
          onOpenHandover: () {},
          handoverTubes: 5,
          onHelp: () {},
        ),
    '06_all_stops': (s) => RouteScreen(routeDate: _now, visits: s.routeVisits, purged: false, sync: s.sync, onRefresh: () async {}, onOpenVisit: (_) {}, onOpenHandover: () {}, onOpenOutbox: () {}, onOpenSettings: () {}, onHelp: () {}),
    '07_visit_before_travel': (s) => VisitScreen(visit: s.view(PreviewData.visits()[3].id)!, config: PreviewData.config, sink: s, readGps: _gps, launchUri: (_) async {}, onArrived: () {}, onCannotDo: () {}, travel: const TravelState(), onStartTravel: () {}),
    '07b_visit_on_the_way': (s) => VisitScreen(visit: s.view(PreviewData.visits()[3].id)!, config: PreviewData.config, sink: s, readGps: _gps, launchUri: (_) async {}, onArrived: () {}, onCannotDo: () {}, travel: const TravelState(onTheWay: true, lastShared: '4 s ago', etaMin: 12, distanceKm: 2.4)),
    '07c_visit_location_off': (s) => VisitScreen(visit: s.view(PreviewData.visits()[3].id)!, config: PreviewData.config, sink: s, readGps: _gps, launchUri: (_) async {}, onArrived: () {}, onCannotDo: () {}, travel: const TravelState(onTheWay: true, sharing: LocationSharing.permissionOff, etaMin: 12), onOpenLocationSettings: () {}),
    '07d_visit_recollection': (s) => VisitScreen(visit: s.view(PreviewData.visits()[4].id)!, config: PreviewData.config, sink: s, readGps: _gps, launchUri: (_) async {}, onArrived: () {}, onCannotDo: () {}),
    '07e_visit_address_missing': (s) => VisitScreen(visit: s.view(PreviewData.visits()[5].id)!, config: PreviewData.config, sink: s, readGps: _gps, launchUri: (_) async {}, onArrived: () {}, onCannotDo: () {}),
    '08_identity': (s) => IdentityScreen(visit: s.view(PreviewData.visits()[3].id)!, sink: s, onContinue: () {}, onFail: (_) {}),
    '09_consent': (s) => ConsentScreen(visit: s.view(PreviewData.visits()[3].id)!, config: PreviewData.config, sink: s, onAgreed: () {}, onRefused: () {}),
    '10_collect': (s) => CollectScreen(visit: s.view(PreviewData.visits()[3].id)!, config: PreviewData.config, otherVisitBarcodes: const {}, sink: s, readGps: _gps, now: () => _now, onDone: () {}, initialCollected: {PreviewData.visits()[3].tubes.first.specimenId}),
    '11_payment': (s) => PaymentScreen(visit: s.view(PreviewData.visits()[3].id)!, config: PreviewData.config, sink: s, onRecorded: () {}, onSkipped: () {}),
    '12_complete': (s) => CompleteScreen(visit: s.view(PreviewData.visits()[3].id)!, collectedCount: 3, notCollectedCount: 0, payment: const PaymentSummary(methodDisplay: 'Cash', amountPaisa: 250000), sink: s, onFinished: () {}),
    '12b_complete_partial': (s) => CompleteScreen(visit: s.view(PreviewData.visits()[3].id)!, collectedCount: 2, notCollectedCount: 1, payment: null, sink: s, onFinished: () {}),
    '13_fail_visit': (s) => FailVisitScreen(visit: s.view(PreviewData.visits()[3].id)!, config: PreviewData.config, sink: s, readGps: _gps, onFailed: () {}),
    '14_handover': (s) => HandoverScreen(centres: PreviewData.centres, tubes: s.handoverPool, itemResults: const {}, sink: s, newId: () => 'h1', onDone: (_) {}),
    '14b_receipt_waiting': (s) => HandoverReceiptScreen(receipt: HandoverReceipt(centreName: 'Central Lab (demo)', handedOverAt: _now, tubes: const ['Serum · …0101', 'Plasma · …0102'], status: HandoverStatus.pending), onDone: () {}),
    '14c_receipt_missing_tube': (s) => HandoverReceiptScreen(receipt: HandoverReceipt(centreName: 'Central Lab (demo)', handedOverAt: _now, tubes: const ['Serum · …0101', 'Plasma · …0102'], status: HandoverStatus.discrepancy, missingCount: 1), onDone: () {}, onContactDispatch: () {}),
    '15_outbox': (s) {
      s.setOffline(true);
      return OutboxScreen(rows: s.outbox, sync: s.sync, onUploadNow: () async {});
    },
    '16_history': (s) => HistoryScreen(days: s.history, onOpenDay: (_) {}, sync: s.sync),
    '16b_history_day': (s) => HistoryDayScreen(day: s.history.first),
    '17_alerts': (s) => AlertsScreen(alerts: s.alerts, now: _now, onOpen: (_) {}, onMarkAllRead: () {}),
    '17b_alerts_empty': (s) => AlertsScreen(alerts: const [], now: _now, onOpen: (_) {}),
    '18_profile': (s) => ProfileScreen(profile: PreviewData.profile, sync: s.sync, onSyncNow: () {}, onOpenIdCard: () {}, onOpenHandover: () {}, onOpenOutbox: () {}, onOpenLocation: () {}, onOpenHelp: () {}, onOpenSettings: () {}),
    '18b_id_card': (s) => const IdCardScreen(profile: PreviewData.profile),
    '18c_location': (s) => LocationScreen(permission: LocationPermission.granted, onOpenPhoneSettings: () {}),
    '18d_location_off': (s) => LocationScreen(permission: LocationPermission.denied, onOpenPhoneSettings: () {}),
    '19_settings': (s) => SettingsScreen(deviceId: 'preview-device-00000001', appVersion: '0.0.0+1', userDisplayName: PreviewData.profile.displayName, lastDownload: s.lastDownload, lastUpload: s.lastUpload, pendingCount: 0, signOut: () async => SignOutResult.done, onSignedOut: () {}),
    '20_help': (s) => HelpScreen(onOpenFaqs: () {}, onOpenContact: () {}, onOpenReport: () {}),
    '20b_faqs': (s) => const FaqScreen(),
    '20c_contact': (s) => ContactScreen(contact: PreviewData.dispatch, onCall: (_) {}, onReport: () {}),
    '20d_report_problem': (s) => ReportProblemScreen(onSubmit: (_, __) async => ReportResult.sent),
    '21_shell': (s) => PhleboShell(
          alertsBadge: 2,
          pages: {
            PhleboTab.today: QueueScreen(routeDate: _now, visits: s.routeVisits, purged: false, sync: s.sync, dataAsOf: s.lastDownload, onRefresh: () async {}, onOpenVisit: (_) {}, onStartTravel: (_) {}, onOpenAll: () {}, onOpenOutbox: () {}, onOpenHandover: () {}, handoverTubes: 5, onHelp: () {}),
          },
        ),
  };

  Future<void> show(WidgetTester t, Widget home, {double textScale = 1.0, GlobalKey? key}) async {
    t.view.physicalSize = const Size(780, 1688);
    t.view.devicePixelRatio = 2.0;
    addTearDown(t.view.reset);
    await t.pumpWidget(RepaintBoundary(
      key: key,
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: PhleboTheme.light(),
        builder: (c, child) => MediaQuery(data: MediaQuery.of(c).copyWith(textScaler: TextScaler.linear(textScale)), child: child!),
        home: home,
      ),
    ));
    // decode the brand marks before the first capture (otherwise the shot is taken with the logo still loading)
    await t.runAsync(() async {
      final ctx = t.element(find.byType(MaterialApp));
      for (final n in ['ml-logo-white', 'ml-logo-landscape-white']) {
        await precacheImage(AssetImage('assets/brand/$n.png'), ctx);
      }
    });
    // one frame, then past the 450 ms card fade; no pumpAndSettle (the splash spinner never settles)
    await t.pump();
    await t.pump(const Duration(milliseconds: 600));
  }

  for (final e in entries.entries) {
    testWidgets('${e.key}: renders at phone size', (t) async {
      final key = GlobalKey();
      await show(t, e.value(store()), key: key);
      expect(t.takeException(), isNull);
      await shoot(t, key, e.key);
    });
    testWidgets('${e.key}: no overflow at text scale 2.0', (t) async {
      await show(t, e.value(store()), textScale: 2.0);
      expect(t.takeException(), isNull);
    });
  }
}
