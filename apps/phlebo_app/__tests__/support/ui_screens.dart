// PHLEBO-UI-FULL-1 test support: every new or restyled screen with synthetic data.
import 'package:flutter/material.dart';
import 'package:phlebo_app/features/handover/domain/handover_models.dart';
import 'package:phlebo_app/features/handover/ui/handover_receipt_screen.dart';
import 'package:phlebo_app/features/help/ui/help_screens.dart';
import 'package:phlebo_app/features/login/ui/gate_screens.dart';
import 'package:phlebo_app/features/outbox/domain/sync_summary.dart';
import 'package:phlebo_app/features/profile/ui/profile_screens.dart';
import 'package:phlebo_app/features/route/data/day_reader.dart';
import 'package:phlebo_app/features/route/domain/route_models.dart';
import 'package:phlebo_app/features/route/ui/today_screen.dart';
import 'package:phlebo_app/features/visit/domain/visit_models.dart';
import 'package:phlebo_app/features/visit/ui/visit_screen.dart';
import 'package:phlebo_app/features/identity/ui/identity_screen.dart';
import 'package:phlebo_app/features/collect/ui/collect_screen.dart';
import 'package:phlebo_app/features/outcome/ui/complete_screen.dart';
import 'package:phlebo_app/features/visit/data/mutation_sink.dart';

class _NoSink implements MutationSink {
  @override
  Future<SavedMutation> enqueue({required String type, String? visitId, String? visitLabel, required Map<String, Object?> payload}) =>
      throw StateError('screens test never saves');
}

const _view = VisitView(
  visitId: '01a1a98a-ac40-7000-8000-000000130004',
  sequence: 4,
  patientName: 'Dipa Demo',
  phone: '+9779800000004',
  birthDate: '',
  secondIdentifier: 'phone',
  address: 'Demo Marg 21, Synthetic Tole, Kathmandu',
  landmark: 'Beside the demo gate, cream building, second floor',
  windowStart: '10:30',
  windowEnd: '11:30',
  noteFromCentre: 'Fasting sample',
  orderId: '01a1a98a-ac40-7000-8000-000000050002',
  amountDuePaisa: 250000,
  amountAsOf: '06:45',
  specimensStale: false,
  tubes: [
    ExpectedTube(specimenId: 's1', typeCode: 'SERUM', typeDisplay: 'SERUM', container: 'RED_PLAIN', barcode: 'E2600000401'),
    ExpectedTube(specimenId: 's2', typeCode: 'EDTA_WB', typeDisplay: 'EDTA_WB', container: 'LAV_3ML', barcode: 'E2600000402'),
  ],
);

const _config = VisitConfig(
  mapHandoffEnabled: true,
  manualBarcodeEntryAllowed: true,
  consentText: 'I agree to give a blood sample (synthetic text).',
  consentTextVersion: 'hc-consent-v1',
  paymentMethods: [PaymentMethodOption(code: 'cash', display: 'Cash', requiresReference: false)],
  visitFailReasons: [ReasonOption(code: 'patient_not_home', display: 'Patient not at home', requiresText: false)],
  notCollectedReasons: [ReasonOption(code: 'unable_to_draw', display: 'Unable to draw', requiresText: false)],
);

DayVisit _dayVisit(int n, String name, String status, {String kind = 'booking', bool partial = false}) => DayVisit(
      kind: kind,
      log: const [],
      partial: partial,
      view: status == 'assigned' ? _view : null,
      row: RouteVisit(
        visitId: 'v$n',
        sequence: n,
        patientName: name,
        windowStart: '${n + 6}:30'.padLeft(5, '0'),
        windowEnd: '${n + 7}:30'.padLeft(5, '0'),
        landmark: 'Synthetic landmark $n',
        status: status,
        expectedTubes: 3,
        collectedTubes: status == 'completed' ? 3 : 0,
      ),
    );

DayData demoDay({bool allDone = false}) => DayData(
      routeDate: DateTime(2026, 11, 25),
      config: _config,
      handoverTubes: const [HandoverTube(specimenId: 's1', typeDisplay: 'SERUM', barcode: 'E2600000101')],
      visits: [
        _dayVisit(1, 'Asha Demo', 'completed'),
        _dayVisit(2, 'Bikash Demo', 'completed', partial: true),
        _dayVisit(3, 'Chandra Demo', 'failed'),
        if (!allDone) _dayVisit(4, 'Dipa Demo', 'assigned'),
        if (!allDone) _dayVisit(5, 'Ekraj Demo', 'assigned', kind: 'recollection'),
      ],
    );

Widget _today(DayData day, {bool offline = false, bool purged = false}) => TodayScreen(
      day: day,
      today: DateTime(2026, 11, 25),
      sync: const SyncSummary(waiting: 0),
      offline: offline,
      purged: purged,
      syncing: false,
      onRefresh: () async {},
      onOpenVisit: (_) {},
      onOpenHandover: () {},
      onOpenOutbox: () {},
      onOpenFullList: () {},
      onHelp: () {},
    );

void _noop() {}

Map<String, Widget Function()> demoScreens() => {
      'splash': () => const SplashScreen(),
      'sign_in': () => SignInScreen(onSignIn: (_, __) async => null, versionLabel: 'dev · Phlebotomist app 0.0.0'),
      'lock': () => LockScreen(attemptsLeft: 3, maxAttempts: 5, onUnlock: () async {}),
      'session_ended': () => const SessionEndedScreen(onSignIn: _noop),
      'wipe_pending': () => const DeviceStateScreen.wipePending(waiting: 2, onUpload: _noop),
      'wiped': () => const DeviceStateScreen.wiped(onSignIn: _noop),
      'update_required': () => const DeviceStateScreen.updateRequired(),
      'no_screen_lock': () => const DeviceStateScreen.noScreenLock(onRetry: _noop),
      'blocked': () => const DeviceStateScreen.blocked(),
      'today': () => _today(demoDay()),
      'today_offline': () => _today(demoDay(), offline: true),
      'today_done': () => _today(demoDay(allDone: true)),
      'today_empty': () => _today(DayData(routeDate: DateTime(2026, 11, 25))),
      'today_cleared': () => _today(const DayData(), purged: true),
      'visit': () => VisitScreen(
          visit: _view, config: _config, sink: _NoSink(), readGps: () async => {'status': 'off'}, launchUri: (_) async {}, onArrived: _noop, onCannotDo: _noop),
      'identity': () => IdentityScreen(visit: _view, sink: _NoSink(), onContinue: _noop, onFail: (_) {}),
      'collect': () => CollectScreen(
          visit: _view, config: _config, otherVisitBarcodes: const {}, sink: _NoSink(), readGps: () async => {'status': 'off'}, now: () => DateTime(2026, 11, 25, 10), onDone: _noop),
      'complete_partial': () => CompleteScreen(visit: _view, collectedCount: 2, notCollectedCount: 1, payment: null, sink: _NoSink(), onFinished: _noop),
      'receipt': () => HandoverReceiptScreen(
          centreName: 'Central Lab (demo)', at: DateTime(2026, 11, 25, 9, 50), tubes: demoDay().handoverTubes, onDone: _noop),
      'profile': () => ProfileScreen(
          name: 'Sanjay Demo', sync: SyncSummary(waiting: 0, lastUpload: DateTime(2026, 11, 25, 9, 40)), syncing: false, onSync: _noop, onIdCard: _noop, onHandover: _noop, onOutbox: _noop, onLocation: _noop, onHelp: _noop, onSettings: _noop),
      'id_card': () => const IdCardScreen(name: 'Sanjay Demo'),
      'location_off': () => const LocationScreen(captureOn: true, allowed: false, onOpenSettings: _noop),
      'help': () => const HelpScreen(onFaqs: _noop, onContact: _noop, onReport: _noop),
      'faqs': () => const FaqScreen(),
      'history': () => historyPage,
      
      'alerts': () => alertsPage,
      'contact': () => contactDispatchPage,
      'report': () => reportProblemPage,
    };
