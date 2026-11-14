// HC-T26 test support: synthetic visit + config, a recording MutationSink and widget-test helpers. Synthetic data only.
//
// ASSUMED API (names are mine; the spec has only the screen names M3-M9 and the mutation table, TRD §6.3). The writer provides:
//   features/visit/data/mutation_sink.dart : abstract interface class MutationSink {
//       Future<SavedMutation> enqueue({required String type, String? visitId, String? visitLabel, required Map<String, Object?> payload}); }
//       (OutboxRepository implements it; a screen never touches the DB directly, so a mutation is persisted before the UI moves on)
//   features/visit/domain/visit_models.dart : ExpectedTube, VisitView, ReasonOption, PaymentMethodOption, VisitConfig (fields below)
//   features/visit/domain/visit_guard.dart  : enum VisitStep, enum IdentityState, enum ConsentState, class VisitProgress, abstract final class VisitGuard
//   features/visit/ui/visit_screen.dart    : VisitScreen        (M3)   features/identity/ui/identity_screen.dart : IdentityScreen (M4)
//   features/consent/ui/consent_screen.dart: ConsentScreen      (M5)   features/collect/ui/collect_screen.dart   : CollectScreen  (M6)
//   features/payment/ui/payment_screen.dart: PaymentScreen      (M7)   features/outcome/ui/complete_screen.dart  : CompleteScreen (M8)
//   features/outcome/ui/fail_visit_screen.dart: FailVisitScreen (M9)   features/visit/ui/visit_flow_screen.dart  : VisitFlowScreen (host of M3-M9)
// Every screen: LimsSecureScreen + LimsScaffold, only lims_ui widgets, ONE non-secondary LimsButton (LD-140), every callback fires only AFTER
// the sink future completed (mutation persisted before the UI acks), a second tap while a save is pending enqueues nothing.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:phlebo_app/features/outbox/data/outbox_repository.dart' show SavedMutation;
import 'package:phlebo_app/features/visit/data/mutation_sink.dart';
import 'package:phlebo_app/features/visit/domain/visit_models.dart';

const visitId = '01a1a98a-ac40-7000-8000-000000130001';
const orderId = '01a1a98a-ac40-7000-8000-000000050002';
const tube1 = '01a1a98a-ac40-7000-8000-000000090011';
const tube2 = '01a1a98a-ac40-7000-8000-000000090012';
const barcode1 = 'HC00000042';
const barcode2 = 'HC00000043';
const otherVisitBarcode = 'HC00000099';
const patientName = 'Test Patient One';
const patientPhone = '9800000001';
const patientBirth = '1990-01-15';
const patientAddress = 'Synthetic Tole 7, Testville';
const visitLabel = '#2 · 09:00–10:00'; // sequence + window, never a name (TRD §6.3 / M11)

const gpsOff = <String, Object?>{'status': 'off'};
Future<Map<String, Object?>> readGpsOff() async => gpsOff;

ExpectedTube tubeA() => const ExpectedTube(
    specimenId: tube1, typeCode: 'SERUM', typeDisplay: 'Serum', container: 'Gel tube', barcode: barcode1);
ExpectedTube tubeB() => const ExpectedTube(
    specimenId: tube2, typeCode: 'EDTA_WB', typeDisplay: 'EDTA whole blood', container: 'Purple top', barcode: barcode2);

VisitView sampleVisit({
  String secondIdentifier = 'phone',
  bool stale = false,
  String? note = 'Ring the bell twice',
  List<ExpectedTube>? tubes,
}) =>
    VisitView(
      visitId: visitId,
      sequence: 2,
      patientName: patientName,
      phone: patientPhone,
      birthDate: patientBirth,
      secondIdentifier: secondIdentifier,
      address: patientAddress,
      landmark: 'Blue gate',
      windowStart: '09:00',
      windowEnd: '10:00',
      noteFromCentre: note,
      orderId: orderId,
      amountDuePaisa: 180000,
      amountAsOf: '08:45',
      specimensStale: stale,
      tubes: stale ? const [] : (tubes ?? [tubeA(), tubeB()]),
    );

VisitConfig sampleConfig({bool manual = true, bool maps = true}) => VisitConfig(
      mapHandoffEnabled: maps,
      manualBarcodeEntryAllowed: manual,
      consentText: 'I agree to a blood sample being taken at my home (synthetic consent text).',
      consentTextVersion: 'hc-consent-v1',
      paymentMethods: const [
        PaymentMethodOption(code: 'cash', display: 'Cash', requiresReference: false),
        PaymentMethodOption(code: 'fonepay_qr', display: 'Fonepay QR', requiresReference: true),
        PaymentMethodOption(code: 'card', display: 'Card', requiresReference: true),
        PaymentMethodOption(code: 'esewa', display: 'eSewa', requiresReference: false),
      ],
      visitFailReasons: const [
        ReasonOption(code: 'patient_not_home', display: 'Patient not home', requiresText: false),
        ReasonOption(code: 'address_not_found', display: 'Address not found', requiresText: false),
        ReasonOption(code: 'patient_refused', display: 'Patient refused', requiresText: false),
        ReasonOption(code: 'identity_mismatch', display: 'Identity mismatch', requiresText: false),
        ReasonOption(code: 'unable_to_draw', display: 'Unable to draw', requiresText: false),
        ReasonOption(code: 'other', display: 'Other', requiresText: true),
      ],
      notCollectedReasons: const [
        ReasonOption(code: 'unable_to_draw', display: 'Unable to draw', requiresText: false),
        ReasonOption(code: 'patient_declined_tube', display: 'Patient declined tube', requiresText: false),
        ReasonOption(code: 'tube_missing', display: 'Tube missing', requiresText: false),
        ReasonOption(code: 'other', display: 'Other', requiresText: false),
      ],
    );

class SinkCall {
  SinkCall(this.type, this.visitId, this.visitLabel, this.payload);
  final String type;
  final String? visitId;
  final String? visitLabel;
  final Map<String, Object?> payload;
}

/// Records every enqueue. [gate] holds the future open (to prove "UI acks only after persist"); [failWith] makes it throw.
class RecordingSink implements MutationSink {
  final List<SinkCall> calls = [];
  Completer<void>? gate;
  Object? failWith;
  int _seq = 0;

  List<String> get types => [for (final c in calls) c.type];
  SinkCall only(String type) => calls.singleWhere((c) => c.type == type);

  @override
  Future<SavedMutation> enqueue({
    required String type,
    String? visitId,
    String? visitLabel,
    required Map<String, Object?> payload,
  }) async {
    calls.add(SinkCall(type, visitId, visitLabel, payload));
    if (gate != null) await gate!.future;
    if (failWith != null) throw failWith!;
    _seq++;
    return SavedMutation(clientMutationId: 'cmid-$_seq', deviceSeq: _seq);
  }
}

/// Counts haptic + sound calls (scan outcomes give sound AND haptic, 04-UI-UX §3.6).
class FeedbackLog {
  int haptics = 0;
  int sounds = 0;
}

FeedbackLog captureFeedback(WidgetTester t) {
  final log = FeedbackLog();
  t.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
    if (call.method == 'HapticFeedback.vibrate') log.haptics++;
    if (call.method == 'SystemSound.play') log.sounds++;
    return null;
  });
  addTearDown(() => t.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
  return log;
}

Future<void> pumpScreen(WidgetTester t, Widget screen, {double textScale = 1.0}) async {
  t.view.physicalSize = const Size(800, 1800);
  t.view.devicePixelRatio = 1.0;
  addTearDown(t.view.reset);
  await t.pumpWidget(MaterialApp(
    theme: LimsTheme.light(),
    builder: (c, child) => MediaQuery(data: MediaQuery.of(c).copyWith(textScaler: TextScaler.linear(textScale)), child: child!),
    home: screen,
  ));
  await t.pumpAndSettle();
}

Finder button(String label) => find.widgetWithText(LimsButton, label);
bool isEnabled(WidgetTester t, String label) => t.widget<LimsButton>(button(label)).onPressed != null;

Future<void> tapButton(WidgetTester t, String label) async {
  await t.ensureVisible(button(label));
  await t.tap(button(label));
  await t.pumpAndSettle();
}

Future<void> tapText(WidgetTester t, String text) async {
  await t.ensureVisible(find.text(text).first);
  await t.tap(find.text(text).first);
  await t.pumpAndSettle();
}

/// LD-140: one primary button per page (every other LimsButton is `secondary: true`).
void expectOnePrimary(WidgetTester t) {
  final primary = t.widgetList<LimsButton>(find.byType(LimsButton)).where((b) => !b.secondary).toList();
  expect(primary.length, 1, reason: 'exactly one primary LimsButton per page, found ${[for (final b in primary) b.label]}');
}

Finder fieldByKey(String key) => find.descendant(of: find.byKey(ValueKey(key)), matching: find.byType(TextField));

Future<void> hidScan(WidgetTester t, String code) async {
  await t.enterText(fieldByKey('collect.hid_input'), code);
  await t.testTextInput.receiveAction(TextInputAction.done);
  await t.pumpAndSettle();
}

Future<void> manualScan(WidgetTester t, String tubeId, String code) async {
  await t.tap(find.byKey(ValueKey('collect.tube_menu.$tubeId')));
  await t.pumpAndSettle();
  await t.tap(find.text('Type barcode'));
  await t.pumpAndSettle();
  await t.enterText(fieldByKey('collect.manual_input'), code);
  await t.testTextInput.receiveAction(TextInputAction.done);
  await t.pumpAndSettle();
}
