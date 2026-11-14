// HC-T26 end-to-end (widget level, no network at all): US-07-1 "airplane mode" visit, US-07-2/3 dead ends, resume after force-close.
// ASSUMED API: VisitFlowScreen({visit, config, otherVisitBarcodes, sink, readGps, now, launchUri, initialLog: List<(String, Map<String, Object?>)>,
//   onExit: ValueChanged<String> /* 'completed' | 'failed' */}) hosting M3 -> M4 -> M5 -> M6 -> M7 -> M8 and M9, driven by VisitGuard.
//   OutboxRepository implements MutationSink (so the real outbox is the production sink).
// The mutations the UI produced are replayed into the REAL SQLCipher outbox (OutboxFx) to prove consecutive device_seq, UUIDv7
// client_mutation_id, anchor + monotonic elapsed (the screens never invent those themselves).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phlebo_app/features/visit/data/mutation_sink.dart';
import 'package:phlebo_app/features/visit/ui/visit_flow_screen.dart';

import 'support/outbox_fixture.dart' as ob;
import 'support/visit_fixture.dart';

final _uuidV7 = RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');

void main() {
  late RecordingSink sink;
  late List<String> exits;

  Future<void> open(WidgetTester t, {bool stale = false, List<(String, Map<String, Object?>)> log = const []}) async {
    sink = RecordingSink();
    exits = [];
    captureFeedback(t);
    await pumpScreen(
      t,
      VisitFlowScreen(
        visit: sampleVisit(stale: stale),
        config: sampleConfig(),
        otherVisitBarcodes: const {otherVisitBarcode},
        sink: sink,
        readGps: readGpsOff,
        now: () => DateTime(2026, 11, 6, 10, 42),
        launchUri: (_) async {},
        initialLog: log,
        onExit: exits.add,
      ),
    );
  }

  Future<void> driveToCollect(WidgetTester t) async {
    await tapButton(t, "I've arrived");
    await tapText(t, 'Name matches');
    await tapText(t, 'Phone matches');
    await tapButton(t, 'Continue');
    await tapButton(t, 'Patient agrees');
  }

  testWidgets('US-07-1: arrive, identity, consent, 2 tubes, cash NPR 1,800.00, finish = 7 mutations in order, no network', (t) async {
    await open(t);
    await driveToCollect(t);
    await hidScan(t, barcode1);
    await hidScan(t, barcode2);
    await tapButton(t, 'Done collecting');
    await tapText(t, 'Cash');
    await tapButton(t, 'Record payment');
    await tapButton(t, 'Finish visit');

    expect(sink.types, [
      'visit.arrived',
      'visit.identity_checked',
      'visit.consent_recorded',
      'specimen.collected',
      'specimen.collected',
      'payment.captured',
      'visit.completed',
    ]);
    expect(sink.only('payment.captured').payload['amount'], {'amount_paisa': 180000, 'currency': 'NPR'});
    expect(sink.only('visit.completed').payload, {'outcome': 'collected'});
    expect(exits, ['completed']);
    for (final c in sink.calls) {
      expect(c.visitId, visitId);
      expect(c.visitLabel, visitLabel);
      final blob = '${c.payload} ${c.visitLabel}';
      for (final s in [patientName, patientPhone, patientBirth, patientAddress]) {
        expect(blob.contains(s), isFalse, reason: 'PHI "$s" in ${c.type}');
      }
    }

    // Replay into the real outbox: consecutive device_seq, UUIDv7 ids, anchor + monotonic elapsed (US-07-1).
    await t.runAsync(() async {
      final fx = await ob.OutboxFx.create();
      try {
        final MutationSink real = fx.repo; // OutboxRepository must implement MutationSink
        for (final c in sink.calls) {
          fx.tick(const Duration(seconds: 3));
          await real.enqueue(type: c.type, visitId: c.visitId, visitLabel: c.visitLabel, payload: c.payload);
        }
        final rows = await fx.rows(
            'SELECT client_mutation_id, device_seq, type, anchor_id, elapsed_since_anchor_ms, captured_wall_time FROM mutation_log ORDER BY device_seq');
        expect(rows.length, 7);
        expect([for (final r in rows) r['device_seq']], [1, 2, 3, 4, 5, 6, 7]);
        expect([for (final r in rows) r['type']], sink.types);
        for (final r in rows) {
          expect(_uuidV7.hasMatch(r['client_mutation_id']! as String), isTrue, reason: '${r['client_mutation_id']}');
          expect(r['anchor_id'], isNotNull);
          expect(r['elapsed_since_anchor_ms'], isA<int>());
          expect(r['captured_wall_time'], matches(ob.isoUtcMs));
        }
        await fx.restart(); // force-close + reopen: nothing is lost
        expect((await fx.rows('SELECT COUNT(*) AS n FROM mutation_log')).single['n'], 7);
      } finally {
        await fx.dispose();
      }
    });
  });

  testWidgets('identity mismatch (US-07-2): Collect is never reached; Fail visit opens M9 with identity_mismatch preselected', (t) async {
    await open(t);
    await tapButton(t, "I've arrived");
    await tapText(t, "Name doesn't match");
    await tapText(t, 'Phone matches');
    await tapButton(t, 'Continue');
    await t.tap(find.text('Fail visit'));
    await t.pumpAndSettle();
    expect(find.text('Identity mismatch'), findsOneWidget);
    expect(isEnabled(t, 'Fail visit'), isTrue);
    await tapButton(t, 'Fail visit');
    expect(sink.types, ['visit.arrived', 'visit.identity_checked', 'visit.failed']);
    expect(sink.only('visit.failed').payload['reason_code'], 'identity_mismatch');
    expect(exits, ['failed']);
    expect(find.byKey(const ValueKey('collect.hid_input')), findsNothing);
  });

  testWidgets('consent refused (US-07-3): M9 with patient_refused; no collect mutation can happen', (t) async {
    await open(t);
    await tapButton(t, "I've arrived");
    await tapText(t, 'Name matches');
    await tapText(t, 'Phone matches');
    await tapButton(t, 'Continue');
    await tapButton(t, 'Patient refuses');
    expect(isEnabled(t, 'Fail visit'), isTrue);
    await tapButton(t, 'Fail visit');
    expect(sink.types, ['visit.arrived', 'visit.identity_checked', 'visit.consent_recorded', 'visit.failed']);
    expect(sink.only('visit.consent_recorded').payload['given'], isFalse);
    expect(sink.only('visit.failed').payload['reason_code'], 'patient_refused');
    expect(exits, ['failed']);
  });

  testWidgets('one tube not collected -> outcome partial (US-07-6)', (t) async {
    await open(t);
    await driveToCollect(t);
    await hidScan(t, barcode1);
    await t.tap(find.byKey(const ValueKey('collect.tube_menu.$tube2')));
    await t.pumpAndSettle();
    await t.tap(find.text('Mark not collected'));
    await t.pumpAndSettle();
    await t.tap(find.text('Patient declined tube'));
    await t.pumpAndSettle();
    await t.tap(find.byKey(const ValueKey('collect.reason_confirm')));
    await t.pumpAndSettle();
    await tapButton(t, 'Done collecting');
    await tapButton(t, 'Skip — patient pays at centre');
    await tapButton(t, 'Finish visit');
    expect(sink.types, [
      'visit.arrived',
      'visit.identity_checked',
      'visit.consent_recorded',
      'specimen.collected',
      'specimen.not_collected',
      'visit.completed',
    ]);
    expect(sink.only('visit.completed').payload, {'outcome': 'partial'});
  });

  group('resume after force-close (log is the source of truth)', () {
    final arrivedLog = ('visit.arrived', <String, Object?>{'gps': gpsOff});
    final idLog = ('visit.identity_checked', <String, Object?>{'name_check': 'matches', 'second_identifier': 'phone', 'second_check': 'matches'});
    final consentLog = ('visit.consent_recorded', <String, Object?>{'consent_text_version': 'hc-consent-v1', 'given': true});
    final collectedLog = (
      'specimen.collected',
      <String, Object?>{
        'specimen_id': tube1,
        'scanned_barcode': barcode1,
        'scan_method': 'hid',
        'specimen_type_code': 'SERUM',
        'gps': gpsOff
      }
    );

    testWidgets('log = [arrived]: reopens on M4 and does not record "arrived" again', (t) async {
      await open(t, log: [arrivedLog]);
      expect(find.text('Name matches'), findsOneWidget);
      expect(sink.calls, isEmpty);
    });

    testWidgets('log = [arrived, identity, consent]: reopens on M6 Collect', (t) async {
      await open(t, log: [arrivedLog, idLog, consentLog]);
      expect(find.byKey(const ValueKey('collect.hid_input')), findsOneWidget);
    });

    testWidgets('log with one collected tube: that tube shows Collected and a rescan says "Already collected."', (t) async {
      await open(t, log: [arrivedLog, idLog, consentLog, collectedLog]);
      expect(find.textContaining('Collected'), findsOneWidget, reason: 'exactly the one tube from the log shows a Collected state');
      expect(find.text('Waiting'), findsOneWidget);
      await hidScan(t, barcode1);
      expect(find.text('Already collected.'), findsOneWidget);
      expect(sink.calls, isEmpty);
    });
  });

  testWidgets('stale visit: Arrive is possible, but Collect is never reachable and the reason is shown', (t) async {
    await open(t, stale: true);
    expect(find.text('Tubes unavailable — refresh before collecting'), findsOneWidget);
    await tapButton(t, "I've arrived");
    await tapText(t, 'Name matches');
    await tapText(t, 'Phone matches');
    await tapButton(t, 'Continue');
    await tapButton(t, 'Patient agrees');
    expect(find.byKey(const ValueKey('collect.hid_input')), findsNothing);
    expect(find.text('Tubes unavailable — refresh before collecting'), findsOneWidget);
  });
}
