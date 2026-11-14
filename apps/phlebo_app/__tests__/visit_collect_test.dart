// HC-T26 widget tests: M6 Collect tubes (US-07-1/4/5/6; 04-UI-UX §3.6, §4; TRD §6.3 specimen.collected / specimen.not_collected).
// ASSUMED API:
//   CollectScreen({visit, config, otherVisitBarcodes: Set<String> /*barcodes of OTHER visits cached on this device*/, sink, readGps,
//                  now: DateTime Function(), scannerBuilder: Widget Function(ValueChanged<String> onScanned)? /*default: LimsBarcodeScanner*/,
//                  onDone})
//   keys: collect.hid_input (LimsTextField, scan_method hid), collect.tube_menu.<specimen_id> (per-tube overflow: "Mark not collected",
//         "Type barcode" only when manual_barcode_entry_allowed), collect.manual_input (LimsTextField max 20, scan_method manual),
//         collect.reason_text (optional text <= 200), collect.reason_confirm (confirm of the not-collected dialog), collect.camera_toggle.
//   Tube state texts: "Waiting" / "Collected hh:mm" / "Not collected: {reason display}".
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:phlebo_app/features/collect/ui/collect_screen.dart';

import 'support/visit_fixture.dart';

void main() {
  late RecordingSink sink;
  late int done;
  late FeedbackLog feedback;
  late void Function(String) cameraScan;

  Future<void> open(WidgetTester t, {bool manual = true, bool stale = false}) async {
    sink = RecordingSink();
    done = 0;
    feedback = captureFeedback(t);
    await pumpScreen(
      t,
      CollectScreen(
        visit: sampleVisit(stale: stale),
        config: sampleConfig(manual: manual),
        otherVisitBarcodes: const {otherVisitBarcode},
        sink: sink,
        readGps: readGpsOff,
        now: () => DateTime(2026, 11, 6, 10, 42),
        scannerBuilder: (onScanned) {
          cameraScan = onScanned;
          return const SizedBox(key: ValueKey('fake_camera'));
        },
        onDone: () => done++,
      ),
    );
  }

  group('layout', () {
    testWidgets('lists every expected tube with type, container, "…last4" and state Waiting; Done collecting disabled', (t) async {
      await open(t);
      expect(find.byType(LimsSecureScreen), findsOneWidget);
      for (final s in ['Serum', 'Gel tube', '…0042', 'EDTA whole blood', 'Purple top', '…0043']) {
        expect(find.textContaining(s), findsWidgets, reason: s);
      }
      expect(find.text('Waiting'), findsNWidgets(2));
      expect(find.textContaining(barcode1), findsNothing, reason: 'the full expected barcode is never on screen');
      expect(isEnabled(t, 'Done collecting'), isFalse);
      expectOnePrimary(t);
    });

    testWidgets('HID input is present without the camera and is a LimsTextField (suggestions/autocorrect off via lims_ui)', (t) async {
      await open(t);
      expect(find.byKey(const ValueKey('collect.hid_input')), findsOneWidget);
      expect(find.descendant(of: find.byKey(const ValueKey('collect.hid_input')), matching: find.byType(TextField)), findsOneWidget);
      final tf = t.widget<TextField>(fieldByKey('collect.hid_input'));
      expect(tf.enableSuggestions, isFalse);
      expect(tf.autocorrect, isFalse);
    });

    testWidgets('specimens_stale: error message, no scan input, no Done collecting (review #2)', (t) async {
      await open(t, stale: true);
      expect(find.text('Tubes unavailable — refresh before collecting'), findsOneWidget);
      expect(find.byKey(const ValueKey('collect.hid_input')), findsNothing);
      expect(find.byWidgetPredicate((w) => w is LimsButton && w.label == 'Done collecting' && w.onPressed != null), findsNothing,
          reason: 'Collect is disabled for a stale visit');
      expect(sink.calls, isEmpty);
    });
  });

  group('scan outcomes (US-07-4)', () {
    testWidgets('HID scan of an expected tube: "Collected Serum", row "Collected 10:42", specimen.collected(hid), sound + haptic', (t) async {
      await open(t);
      await hidScan(t, barcode1);
      expect(find.text('Collected Serum'), findsOneWidget);
      expect(find.text('Collected 10:42'), findsOneWidget);
      expect(find.text('Waiting'), findsOneWidget);
      final c = sink.only('specimen.collected');
      expect(c.visitId, visitId);
      expect(c.visitLabel, visitLabel);
      expect(c.payload, {
        'specimen_id': tube1,
        'scanned_barcode': barcode1,
        'scan_method': 'hid',
        'specimen_type_code': 'SERUM',
        'gps': gpsOff,
      });
      expect(feedback.haptics, greaterThan(0));
      expect(feedback.sounds, greaterThan(0));
    });

    testWidgets('camera scan: same outcome, scan_method camera', (t) async {
      await open(t);
      await t.tap(find.byKey(const ValueKey('collect.camera_toggle')));
      await t.pumpAndSettle();
      expect(find.byKey(const ValueKey('fake_camera')), findsOneWidget);
      cameraScan(barcode2);
      await t.pumpAndSettle();
      expect(sink.only('specimen.collected').payload['scan_method'], 'camera');
      expect(sink.only('specimen.collected').payload['specimen_id'], tube2);
      expect(find.text('Collected EDTA whole blood'), findsOneWidget);
    });

    testWidgets('barcode of ANOTHER visit on this device: error text, nothing recorded, error feedback still given', (t) async {
      await open(t);
      await hidScan(t, otherVisitBarcode);
      expect(find.text("This tube belongs to another patient. Don't use it here."), findsOneWidget);
      expect(sink.calls, isEmpty);
      expect(find.text('Waiting'), findsNWidgets(2));
      expect(feedback.haptics, greaterThan(0));
    });

    testWidgets('unknown barcode: "This tube is not on this visit.", nothing recorded', (t) async {
      await open(t);
      await hidScan(t, 'ZZ99999999');
      expect(find.text('This tube is not on this visit.'), findsOneWidget);
      expect(sink.calls, isEmpty);
    });

    testWidgets('repeat scan of an already-collected tube: "Already collected.", no second mutation', (t) async {
      await open(t);
      await hidScan(t, barcode1);
      await hidScan(t, barcode1);
      expect(find.text('Already collected.'), findsOneWidget);
      expect(sink.types, ['specimen.collected']);
    });

    testWidgets('input that is not a valid barcode (lowercase symbols, > 20 chars) records nothing', (t) async {
      await open(t);
      await hidScan(t, 'hc 42!');
      await hidScan(t, 'A' * 21);
      expect(sink.calls, isEmpty);
    });

    testWidgets('scan whose save fails is NOT shown as collected (nothing lost silently)', (t) async {
      await open(t);
      sink.failWith = StateError('disk full');
      await hidScan(t, barcode1);
      expect(find.text('Collected 10:42'), findsNothing);
      expect(find.text('Waiting'), findsNWidgets(2));
      expect(find.textContaining("Couldn't save"), findsOneWidget);
    });
  });

  group('manual entry (US-07-5)', () {
    testWidgets('typing the FULL barcode (lowercase accepted, uppercased) records scan_method manual', (t) async {
      await open(t);
      await manualScan(t, tube2, 'hc00000043');
      final p = sink.only('specimen.collected').payload;
      expect(p['scan_method'], 'manual');
      expect(p['scanned_barcode'], barcode2);
      expect(p['specimen_id'], tube2);
    });

    testWidgets('typing only the last 4 characters shown on screen is NOT enough: "This tube is not on this visit."', (t) async {
      await open(t);
      await manualScan(t, tube1, '0042');
      expect(find.text('This tube is not on this visit.'), findsOneWidget);
      expect(sink.calls, isEmpty);
    });

    testWidgets('manual field: max 20 chars, pattern ^[A-Z0-9]{1,20}\$', (t) async {
      await open(t);
      await t.tap(find.byKey(const ValueKey('collect.tube_menu.$tube1')));
      await t.pumpAndSettle();
      await t.tap(find.text('Type barcode'));
      await t.pumpAndSettle();
      await t.enterText(fieldByKey('collect.manual_input'), 'A' * 25);
      expect(t.widget<TextField>(fieldByKey('collect.manual_input')).controller!.text.length, lessThanOrEqualTo(20));
      await t.enterText(fieldByKey('collect.manual_input'), 'HC-42 !');
      await t.testTextInput.receiveAction(TextInputAction.done);
      await t.pumpAndSettle();
      expect(sink.calls, isEmpty);
    });

    testWidgets('manual_barcode_entry_allowed = false: no "Type barcode" in the tube menu', (t) async {
      await open(t, manual: false);
      await t.tap(find.byKey(const ValueKey('collect.tube_menu.$tube1')));
      await t.pumpAndSettle();
      expect(find.text('Mark not collected'), findsOneWidget);
      expect(find.text('Type barcode'), findsNothing);
    });
  });

  group('not collected (US-07-6)', () {
    Future<void> markNotCollected(WidgetTester t, String tubeId, String reasonDisplay, {String? text}) async {
      await t.tap(find.byKey(ValueKey('collect.tube_menu.$tubeId')));
      await t.pumpAndSettle();
      await t.tap(find.text('Mark not collected'));
      await t.pumpAndSettle();
      await t.tap(find.text(reasonDisplay));
      await t.pumpAndSettle();
      if (text != null) await t.enterText(fieldByKey('collect.reason_text'), text);
      await t.tap(find.byKey(const ValueKey('collect.reason_confirm')));
      await t.pumpAndSettle();
    }

    testWidgets('dialog lists the configured reasons; saving records specimen.not_collected and the row says why', (t) async {
      await open(t);
      await t.tap(find.byKey(const ValueKey('collect.tube_menu.$tube1')));
      await t.pumpAndSettle();
      await t.tap(find.text('Mark not collected'));
      await t.pumpAndSettle();
      for (final r in ['Unable to draw', 'Patient declined tube', 'Tube missing', 'Other']) {
        expect(find.text(r), findsWidgets, reason: r);
      }
      await t.tap(find.text('Tube missing'));
      await t.pumpAndSettle();
      await t.tap(find.byKey(const ValueKey('collect.reason_confirm')));
      await t.pumpAndSettle();
      final c = sink.only('specimen.not_collected');
      expect(c.visitId, visitId);
      expect(c.payload, {'specimen_id': tube1, 'reason_code': 'tube_missing'}, reason: 'reason_text is omitted when empty');
      expect(find.text('Not collected: Tube missing'), findsOneWidget);
    });

    testWidgets('optional text is recorded and capped at 200 characters', (t) async {
      await open(t);
      await markNotCollected(t, tube1, 'Other', text: 'x' * 250);
      final p = sink.only('specimen.not_collected').payload;
      expect(p['reason_code'], 'other');
      expect((p['reason_text']! as String).length, 200);
    });

    testWidgets('confirming without picking a reason records nothing', (t) async {
      await open(t);
      await t.tap(find.byKey(const ValueKey('collect.tube_menu.$tube1')));
      await t.pumpAndSettle();
      await t.tap(find.text('Mark not collected'));
      await t.pumpAndSettle();
      await t.tap(find.byKey(const ValueKey('collect.reason_confirm')), warnIfMissed: false);
      await t.pumpAndSettle();
      expect(sink.calls, isEmpty);
    });

    testWidgets('a collected tube cannot then be marked not collected, and a not-collected tube cannot be scanned in', (t) async {
      await open(t);
      await hidScan(t, barcode1);
      await t.tap(find.byKey(const ValueKey('collect.tube_menu.$tube1')));
      await t.pumpAndSettle();
      expect(find.text('Mark not collected'), findsNothing);
      await t.tapAt(const Offset(1, 1));
      await t.pumpAndSettle();
      await markNotCollected(t, tube2, 'Unable to draw');
      await hidScan(t, barcode2);
      expect(sink.types, ['specimen.collected', 'specimen.not_collected'], reason: 'a resolved tube is final');
    });
  });

  group('Done collecting', () {
    testWidgets('enabled only when EVERY tube is resolved (collected or not collected); then onDone after nothing more is pending', (t) async {
      await open(t);
      await hidScan(t, barcode1);
      expect(isEnabled(t, 'Done collecting'), isFalse);
      await t.tap(find.byKey(const ValueKey('collect.tube_menu.$tube2')));
      await t.pumpAndSettle();
      await t.tap(find.text('Mark not collected'));
      await t.pumpAndSettle();
      await t.tap(find.text('Unable to draw'));
      await t.pumpAndSettle();
      await t.tap(find.byKey(const ValueKey('collect.reason_confirm')));
      await t.pumpAndSettle();
      expect(isEnabled(t, 'Done collecting'), isTrue);
      await tapButton(t, 'Done collecting');
      expect(done, 1);
      expect(sink.types, ['specimen.collected', 'specimen.not_collected'], reason: 'Done collecting itself records nothing');
    });

    testWidgets('mutation payloads carry no PHI (no name, phone, DOB, address)', (t) async {
      await open(t);
      await hidScan(t, barcode1);
      final blob = '${sink.calls.single.payload} ${sink.calls.single.visitLabel}';
      for (final s in [patientName, patientPhone, patientBirth, patientAddress]) {
        expect(blob.contains(s), isFalse, reason: s);
      }
    });
  });
}
