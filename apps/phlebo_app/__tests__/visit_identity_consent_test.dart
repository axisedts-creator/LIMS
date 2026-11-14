// HC-T26 widget tests: M3 Visit, M4 Identity check, M5 Consent (US-07-1/2/3; 04-UI-UX §3.3-§3.5; REQ-SEC-109/111).
// ASSUMED API (see support/visit_fixture.dart for models/sink):
//   VisitScreen({visit, config, sink, readGps, launchUri: Future<void> Function(Uri), onArrived, onCannotDo})
//   IdentityScreen({visit, sink, onContinue, onFail: ValueChanged<String> /*reason code*/, onBack})
//   ConsentScreen({visit, config, sink, onAgreed, onRefused})
// Keys/labels are the spec copy verbatim. Callbacks fire only after the mutation was persisted (sink future completed).
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:phlebo_app/features/consent/ui/consent_screen.dart';
import 'package:phlebo_app/features/identity/ui/identity_screen.dart';
import 'package:phlebo_app/features/visit/ui/visit_screen.dart';

import 'support/visit_fixture.dart';

void main() {
  group('M3 Visit', () {
    late RecordingSink sink;
    late List<Uri> launched;
    late int arrived;
    late int cannot;

    Future<void> open(WidgetTester t, {bool stale = false, bool maps = true, String? note = 'Ring the bell twice'}) async {
      sink = RecordingSink();
      launched = [];
      arrived = 0;
      cannot = 0;
      await pumpScreen(
        t,
        VisitScreen(
          visit: sampleVisit(stale: stale, note: note),
          config: sampleConfig(maps: maps),
          sink: sink,
          readGps: readGpsOff,
          launchUri: (u) async => launched.add(u),
          onArrived: () => arrived++,
          onCannotDo: () => cannot++,
        ),
      );
    }

    testWidgets('shows patient, address, landmark, window, note, tubes (type + container + last 4) and amount due as of hh:mm', (t) async {
      await open(t);
      for (final s in [patientName, 'Blue gate', 'Ring the bell twice', 'Serum', 'Gel tube', '…0042', 'EDTA whole blood', '…0043']) {
        expect(find.textContaining(s), findsWidgets, reason: s);
      }
      expect(find.textContaining(patientAddress), findsOneWidget);
      expect(find.textContaining('09:00'), findsWidgets);
      expect(find.textContaining('1,800.00'), findsOneWidget);
      expect(find.textContaining('as of 08:45'), findsOneWidget);
      expect(find.textContaining(barcode1), findsNothing, reason: 'only the last 4 characters of a barcode are shown');
    });

    testWidgets('chrome: LimsScaffold inside LimsSecureScreen; one primary button; secondary "Can\'t do this visit"', (t) async {
      await open(t);
      expect(find.byType(LimsSecureScreen), findsOneWidget);
      expect(find.byType(LimsScaffold), findsOneWidget);
      expectOnePrimary(t);
      expect(t.widget<LimsButton>(button("I've arrived")).secondary, isFalse);
      expect(t.widget<LimsButton>(button("Can't do this visit")).secondary, isTrue);
    });

    testWidgets('"I\'ve arrived" records visit.arrived with gps + label (no name) and moves on only AFTER it was saved', (t) async {
      await open(t);
      sink.gate = Completer<void>();
      await tapButton(t, "I've arrived");
      expect(sink.types, ['visit.arrived']);
      expect(sink.calls.single.visitId, visitId);
      expect(sink.calls.single.visitLabel, visitLabel);
      expect(sink.calls.single.payload, {'gps': gpsOff});
      expect(arrived, 0, reason: 'UI must not ack before the mutation is persisted');
      sink.gate!.complete();
      await t.pumpAndSettle();
      expect(arrived, 1);
    });

    testWidgets('double tap on "I\'ve arrived" enqueues exactly one visit.arrived', (t) async {
      await open(t);
      sink.gate = Completer<void>();
      await t.tap(button("I've arrived"));
      await t.pump();
      await t.tap(button("I've arrived"), warnIfMissed: false);
      await t.pump();
      sink.gate!.complete();
      await t.pumpAndSettle();
      expect(sink.types, ['visit.arrived']);
      expect(arrived, 1);
    });

    testWidgets('a failed save keeps the user on the screen and shows an error (nothing lost silently)', (t) async {
      await open(t);
      sink.failWith = StateError('disk full');
      await tapButton(t, "I've arrived");
      expect(arrived, 0);
      expect(find.byType(VisitScreen), findsOneWidget);
      expect(find.textContaining("Couldn't save"), findsOneWidget);
    });

    testWidgets('"Can\'t do this visit" goes to M9 without recording anything yet', (t) async {
      await open(t);
      await tapButton(t, "Can't do this visit");
      expect(cannot, 1);
      expect(sink.calls, isEmpty);
    });

    testWidgets('Call hands off to tel: with the recorded number', (t) async {
      await open(t);
      await tapButton(t, 'Call');
      expect(launched.single.scheme, 'tel');
      expect(launched.single.path, patientPhone);
    });

    testWidgets('Navigate is shown only when map_handoff_enabled', (t) async {
      await open(t);
      expect(button('Navigate'), findsOneWidget);
      await tapButton(t, 'Navigate');
      expect(launched, hasLength(1));
      await open(t, maps: false);
      expect(button('Navigate'), findsNothing);
    });

    testWidgets('specimens_stale: inline LimsErrorState "Tubes unavailable — refresh before collecting", no tube list (review #2)', (t) async {
      await open(t, stale: true);
      expect(find.byType(LimsErrorState), findsOneWidget);
      expect(find.text('Tubes unavailable — refresh before collecting'), findsOneWidget);
      expect(find.textContaining('…0042'), findsNothing);
    });

    testWidgets('text scale 2.0 does not overflow', (t) async {
      sink = RecordingSink();
      await pumpScreen(
        t,
        VisitScreen(
            visit: sampleVisit(), config: sampleConfig(), sink: sink, readGps: readGpsOff, launchUri: (_) async {}, onArrived: () {}, onCannotDo: () {}),
        textScale: 2.0,
      );
      expect(t.takeException(), isNull);
    });
  });

  group('M4 Identity check', () {
    late RecordingSink sink;
    late int cont;
    late List<String> failed;
    late int back;

    Future<void> open(WidgetTester t, {String second = 'phone'}) async {
      sink = RecordingSink();
      cont = 0;
      failed = [];
      back = 0;
      await pumpScreen(
        t,
        IdentityScreen(
          visit: sampleVisit(secondIdentifier: second),
          sink: sink,
          onContinue: () => cont++,
          onFail: failed.add,
          onBack: () => back++,
        ),
      );
    }

    testWidgets('copy, recorded name + phone shown for comparison; Continue disabled until BOTH are answered', (t) async {
      await open(t);
      expect(find.textContaining("Ask the patient to tell you their full name and phone number. Don't read them out."), findsOneWidget);
      expect(find.textContaining(patientName), findsOneWidget);
      expect(find.textContaining(patientPhone), findsOneWidget);
      expect(find.textContaining(patientBirth), findsNothing);
      expect(isEnabled(t, 'Continue'), isFalse);
      await tapText(t, 'Name matches');
      expect(isEnabled(t, 'Continue'), isFalse);
      await tapText(t, 'Phone matches');
      expect(isEnabled(t, 'Continue'), isTrue);
      expectOnePrimary(t);
    });

    testWidgets('date-of-birth variant (second_identifier = birth_date)', (t) async {
      await open(t, second: 'birth_date');
      expect(find.textContaining('date of birth'), findsOneWidget);
      expect(find.textContaining(patientBirth), findsOneWidget);
      expect(find.textContaining(patientPhone), findsNothing);
      await tapText(t, 'Name matches');
      await tapText(t, 'DOB matches');
      await tapButton(t, 'Continue');
      expect(sink.only('visit.identity_checked').payload,
          {'name_check': 'matches', 'second_identifier': 'birth_date', 'second_check': 'matches'});
    });

    testWidgets('both match: visit.identity_checked recorded, then (and only then) continue', (t) async {
      await open(t);
      await tapText(t, 'Name matches');
      await tapText(t, 'Phone matches');
      sink.gate = Completer<void>();
      await tapButton(t, 'Continue');
      expect(sink.only('visit.identity_checked').payload, {'name_check': 'matches', 'second_identifier': 'phone', 'second_check': 'matches'});
      expect(sink.calls.single.visitId, visitId);
      expect(cont, 0);
      sink.gate!.complete();
      await t.pumpAndSettle();
      expect(cont, 1);
      expect(find.byType(AlertDialog), findsNothing);
    });

    for (final c in [
      ("Name doesn't match", 'Phone matches', 'mismatch', 'matches'),
      ('Name matches', "Phone doesn't match", 'matches', 'mismatch'),
      ("Name doesn't match", "Phone doesn't match", 'mismatch', 'mismatch'),
    ]) {
      testWidgets('mismatch (${c.$1} / ${c.$2}): recorded, confirm dialog offers only Fail visit / Back, never Continue (US-07-2)', (t) async {
        await open(t);
        await tapText(t, c.$1);
        await tapText(t, c.$2);
        await tapButton(t, 'Continue');
        expect(sink.only('visit.identity_checked').payload,
            {'name_check': c.$3, 'second_identifier': 'phone', 'second_check': c.$4},
            reason: 'the mismatch is evidence: it is recorded');
        expect(cont, 0);
        expect(find.text("Identity doesn't match. You can't collect samples for this visit."), findsOneWidget);
        expect(find.text('Fail visit'), findsOneWidget);
        expect(find.text('Back'), findsOneWidget);
        await t.tap(find.text('Fail visit'));
        await t.pumpAndSettle();
        expect(failed, ['identity_mismatch'], reason: 'M9 opens with identity_mismatch preselected');
        expect(cont, 0);
      });
    }

    testWidgets('dialog "Back" returns to the form without failing the visit or continuing', (t) async {
      await open(t);
      await tapText(t, "Name doesn't match");
      await tapText(t, 'Phone matches');
      await tapButton(t, 'Continue');
      await t.tap(find.text('Back'));
      await t.pumpAndSettle();
      expect(failed, isEmpty);
      expect(cont, 0);
      expect(find.byType(AlertDialog), findsNothing);
      expect(find.byType(IdentityScreen), findsOneWidget);
    });

    testWidgets('chrome: secure screen, scaffold; the spoken name/phone is never in a mutation payload or label', (t) async {
      await open(t);
      expect(find.byType(LimsSecureScreen), findsOneWidget);
      await tapText(t, 'Name matches');
      await tapText(t, 'Phone matches');
      await tapButton(t, 'Continue');
      final blob = '${sink.calls.single.payload} ${sink.calls.single.visitLabel}';
      for (final s in [patientName, patientPhone, patientBirth, patientAddress]) {
        expect(blob.contains(s), isFalse, reason: 'PHI in outbox: $s');
      }
    });
  });

  group('M5 Consent', () {
    late RecordingSink sink;
    late int agreed;
    late int refused;

    Future<void> open(WidgetTester t) async {
      sink = RecordingSink();
      agreed = 0;
      refused = 0;
      await pumpScreen(
        t,
        ConsentScreen(visit: sampleVisit(), config: sampleConfig(), sink: sink, onAgreed: () => agreed++, onRefused: () => refused++),
      );
    }

    testWidgets('shows consent text (scrollable) and its version; one primary button', (t) async {
      await open(t);
      expect(find.textContaining('synthetic consent text'), findsOneWidget);
      expect(find.textContaining('hc-consent-v1'), findsOneWidget);
      expect(find.ancestor(of: find.textContaining('synthetic consent text'), matching: find.byType(Scrollable)), findsWidgets);
      expect(find.byType(LimsSecureScreen), findsOneWidget);
      expectOnePrimary(t);
      expect(t.widget<LimsButton>(button('Patient agrees')).secondary, isFalse);
      expect(t.widget<LimsButton>(button('Patient refuses')).secondary, isTrue);
    });

    testWidgets('"Patient agrees" records visit.consent_recorded given:true with the shown text version, then continues', (t) async {
      await open(t);
      sink.gate = Completer<void>();
      await tapButton(t, 'Patient agrees');
      expect(sink.only('visit.consent_recorded').payload, {'consent_text_version': 'hc-consent-v1', 'given': true});
      expect(sink.calls.single.visitId, visitId);
      expect(agreed, 0);
      sink.gate!.complete();
      await t.pumpAndSettle();
      expect(agreed, 1);
      expect(refused, 0);
    });

    testWidgets('"Patient refuses" records given:false, then M9 (patient_refused) - collection is not offered (US-07-3)', (t) async {
      await open(t);
      await tapButton(t, 'Patient refuses');
      expect(sink.only('visit.consent_recorded').payload, {'consent_text_version': 'hc-consent-v1', 'given': false});
      expect(refused, 1);
      expect(agreed, 0);
    });

    testWidgets('double tap records one consent; a failed save advances nothing', (t) async {
      await open(t);
      sink.gate = Completer<void>();
      await t.tap(button('Patient agrees'));
      await t.pump();
      await t.tap(button('Patient agrees'), warnIfMissed: false);
      await t.tap(button('Patient refuses'), warnIfMissed: false);
      await t.pump();
      sink.gate!.complete();
      await t.pumpAndSettle();
      expect(sink.types, ['visit.consent_recorded'], reason: 'a second tap (agree OR refuse) while saving must be ignored');
      await open(t);
      sink.failWith = StateError('disk full');
      await tapButton(t, 'Patient agrees');
      expect(agreed, 0);
      expect(find.textContaining("Couldn't save"), findsOneWidget);
    });
  });
}
