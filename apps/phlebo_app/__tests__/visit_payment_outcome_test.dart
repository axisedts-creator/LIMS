// HC-T26 widget tests: M7 Payment (US-07-7 reference rule), M8 Complete (US-07-6 partial), M9 Fail visit (US-07-2/3).
// ASSUMED API:
//   PaymentScreen({visit, config, sink, onRecorded, onSkipped}); keys payment.amount (LimsMoneyField, default text = amount due "1800.00"),
//     payment.reference (LimsTextField max 100, label "Transaction / QR reference", present only for requires_reference methods).
//     Amount != due -> LimsConfirmDialog "Amount differs from the amount due (NPR 1,800.00). Continue?" [Continue] [Back].
//   CompleteScreen({visit, collectedCount, notCollectedCount, payment: PaymentSummary? /*(methodDisplay, amountPaisa)*/, sink, onFinished})
//     outcome = notCollectedCount > 0 ? 'partial' : 'collected'. Snackbar "Saved on phone. It will upload automatically."
//   FailVisitScreen({visit, config, sink, readGps, preselectedReasonCode, onFailed}); keys fail.reason_text (<= 200, required for requiresText).
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:phlebo_app/features/outcome/ui/complete_screen.dart';
import 'package:phlebo_app/features/outcome/ui/fail_visit_screen.dart';
import 'package:phlebo_app/features/payment/ui/payment_screen.dart';

import 'support/visit_fixture.dart';

void main() {
  group('M7 Payment', () {
    late RecordingSink sink;
    late int recorded;
    late int skipped;

    Future<void> open(WidgetTester t) async {
      sink = RecordingSink();
      recorded = 0;
      skipped = 0;
      await pumpScreen(
        t,
        PaymentScreen(visit: sampleVisit(), config: sampleConfig(), sink: sink, onRecorded: () => recorded++, onSkipped: () => skipped++),
      );
    }

    Future<void> setAmount(WidgetTester t, String v) => t.enterText(fieldByKey('payment.amount'), v);

    /// Taps "Record payment" and confirms the "differs from the amount due" dialog when it appears.
    Future<void> record(WidgetTester t, {bool confirmDiffers = true}) async {
      await tapButton(t, 'Record payment');
      if (confirmDiffers && find.textContaining('Amount differs from the amount due').evaluate().isNotEmpty) {
        await t.tap(find.text('Continue'));
        await t.pumpAndSettle();
      }
    }

    testWidgets('shows amount due as of hh:mm, methods from config, amount defaults to the due amount, copy under the button', (t) async {
      await open(t);
      expect(find.byType(LimsSecureScreen), findsOneWidget);
      expect(find.textContaining('1,800.00'), findsWidgets);
      expect(find.textContaining('as of 08:45'), findsOneWidget);
      for (final m in ['Cash', 'Fonepay QR', 'Card', 'eSewa']) {
        expect(find.text(m), findsOneWidget, reason: m);
      }
      expect(find.text('Khalti'), findsNothing, reason: 'the method list comes from config, not from a hard-coded list');
      expect(t.widget<TextField>(fieldByKey('payment.amount')).controller!.text, '1800.00');
      expect(find.text('This records the payment. The bill receipt is issued by the centre.'), findsOneWidget);
      expectOnePrimary(t);
      expect(t.widget<LimsButton>(button('Skip — patient pays at centre')).secondary, isTrue);
    });

    testWidgets('no method chosen: Record payment disabled', (t) async {
      await open(t);
      expect(isEnabled(t, 'Record payment'), isFalse);
      await tapText(t, 'Cash');
      expect(isEnabled(t, 'Record payment'), isTrue);
    });

    testWidgets('cash at the due amount: payment.captured with order_id, method, integer paisa, NPR and NO reference (US-07-1)', (t) async {
      await open(t);
      await tapText(t, 'Cash');
      expect(find.byKey(const ValueKey('payment.reference')), findsNothing);
      sink.gate = Completer<void>();
      await record(t);
      final c = sink.only('payment.captured');
      expect(c.visitId, visitId);
      expect(c.payload, {
        'order_id': orderId,
        'payment_method_code': 'cash',
        'amount': {'amount_paisa': 180000, 'currency': 'NPR'},
      });
      expect(recorded, 0, reason: 'persist first');
      sink.gate!.complete();
      await t.pumpAndSettle();
      expect(recorded, 1);
    });

    group('reference rule (US-07-7)', () {
      for (final m in [('Fonepay QR', 'fonepay_qr'), ('Card', 'card')]) {
        testWidgets('${m.$2} requires_reference: field appears; empty or blank reference records nothing', (t) async {
          await open(t);
          await tapText(t, m.$1);
          expect(find.byKey(const ValueKey('payment.reference')), findsOneWidget);
          expect(find.text('Transaction / QR reference'), findsOneWidget);
          await record(t);
          expect(sink.calls, isEmpty);
          expect(recorded, 0);
          await t.enterText(fieldByKey('payment.reference'), '    ');
          await record(t);
          expect(sink.calls, isEmpty, reason: 'whitespace is not a reference');
          expect(t.widget<TextField>(fieldByKey('payment.reference')).decoration!.errorText, isNotNull);
        });

        testWidgets('${m.$2} with a reference: recorded, reference trimmed into the payload', (t) async {
          await open(t);
          await tapText(t, m.$1);
          await t.enterText(fieldByKey('payment.reference'), '  FP-TEST-0001 ');
          await record(t);
          expect(sink.only('payment.captured').payload, {
            'order_id': orderId,
            'payment_method_code': m.$2,
            'amount': {'amount_paisa': 180000, 'currency': 'NPR'},
            'reference': 'FP-TEST-0001',
          });
        });
      }

      testWidgets('reference is capped at 100 characters', (t) async {
        await open(t);
        await tapText(t, 'Card');
        await t.enterText(fieldByKey('payment.reference'), 'R' * 130);
        await record(t);
        expect((sink.only('payment.captured').payload['reference']! as String).length, 100);
      });

      testWidgets('switching from a reference method to cash drops the stale reference from the payload', (t) async {
        await open(t);
        await tapText(t, 'Card');
        await t.enterText(fieldByKey('payment.reference'), 'CARD-REF-9');
        await tapText(t, 'Cash');
        expect(find.byKey(const ValueKey('payment.reference')), findsNothing);
        await record(t);
        expect(sink.only('payment.captured').payload.containsKey('reference'), isFalse);
      });

      testWidgets('esewa (requires_reference false in this config): reference optional and absent', (t) async {
        await open(t);
        await tapText(t, 'eSewa');
        expect(find.byKey(const ValueKey('payment.reference')), findsNothing);
        await record(t);
        expect(sink.only('payment.captured').payload['payment_method_code'], 'esewa');
      });
    });

    group('amount', () {
      testWidgets('different from due: warning with the due amount; "Back" records nothing, "Continue" records', (t) async {
        await open(t);
        await tapText(t, 'Cash');
        await setAmount(t, '1500.50');
        await record(t, confirmDiffers: false);
        expect(find.text('Amount differs from the amount due (NPR 1,800.00). Continue?'), findsOneWidget);
        await t.tap(find.text('Back'));
        await t.pumpAndSettle();
        expect(sink.calls, isEmpty);
        await record(t);
        expect((sink.only('payment.captured').payload['amount']! as Map)['amount_paisa'], 150050);
      });

      testWidgets('same as due: no warning dialog', (t) async {
        await open(t);
        await tapText(t, 'Cash');
        await tapButton(t, 'Record payment');
        expect(find.textContaining('Amount differs'), findsNothing);
        expect(sink.types, ['payment.captured']);
      });

      for (final bad in ['', '0', '0.00', '500000.01', '600000']) {
        testWidgets('amount "$bad" is outside NPR 0.01..500,000.00: nothing recorded', (t) async {
          await open(t);
          await tapText(t, 'Cash');
          await setAmount(t, bad);
          await record(t);
          expect(sink.calls, isEmpty);
          expect(recorded, 0);
        });
      }

      for (final ok in [('0.01', 1), ('500000', 50000000), ('500000.00', 50000000)]) {
        testWidgets('amount "${ok.$1}" is the inclusive bound -> ${ok.$2} paisa', (t) async {
          await open(t);
          await tapText(t, 'Cash');
          await setAmount(t, ok.$1);
          await record(t);
          expect((sink.only('payment.captured').payload['amount']! as Map)['amount_paisa'], ok.$2);
        });
      }

      testWidgets('amount is integer paisa, never a double (no float rounding on 0.29)', (t) async {
        await open(t);
        await tapText(t, 'Cash');
        await setAmount(t, '1800.29');
        await record(t);
        final a = sink.only('payment.captured').payload['amount']! as Map;
        expect(a['amount_paisa'], isA<int>());
        expect(a['amount_paisa'], 180029);
      });
    });

    testWidgets('"Skip — patient pays at centre": no mutation, goes on', (t) async {
      await open(t);
      await tapButton(t, 'Skip — patient pays at centre');
      expect(sink.calls, isEmpty);
      expect(skipped, 1);
    });

    testWidgets('double tap on Record payment records one payment; failed save does not advance', (t) async {
      await open(t);
      await tapText(t, 'Cash');
      sink.gate = Completer<void>();
      await t.tap(button('Record payment'));
      await t.pump();
      await t.tap(button('Record payment'), warnIfMissed: false);
      await t.pump();
      sink.gate!.complete();
      await t.pumpAndSettle();
      expect(sink.types, ['payment.captured']);
      await open(t);
      await tapText(t, 'Cash');
      sink.failWith = StateError('disk full');
      await record(t);
      expect(recorded, 0);
      expect(find.textContaining("Couldn't save"), findsOneWidget);
    });
  });

  group('M8 Complete', () {
    late RecordingSink sink;
    late int finished;

    Future<void> open(WidgetTester t, {required int collected, required int notCollected, PaymentSummary? payment}) async {
      sink = RecordingSink();
      finished = 0;
      await pumpScreen(
        t,
        CompleteScreen(
          visit: sampleVisit(),
          collectedCount: collected,
          notCollectedCount: notCollected,
          payment: payment,
          sink: sink,
          onFinished: () => finished++,
        ),
      );
    }

    testWidgets('summary shows collected / not collected and the payment; all collected -> outcome collected', (t) async {
      await open(t, collected: 2, notCollected: 0, payment: const PaymentSummary(methodDisplay: 'Cash', amountPaisa: 180000));
      expect(find.byType(LimsSecureScreen), findsOneWidget);
      expect(find.text('Collected: 2'), findsOneWidget);
      expect(find.text('Not collected: 0'), findsOneWidget);
      expect(find.textContaining('1,800.00'), findsOneWidget);
      expect(find.textContaining('Cash'), findsOneWidget);
      expectOnePrimary(t);
      await tapButton(t, 'Finish visit');
      expect(sink.only('visit.completed').payload, {'outcome': 'collected'});
      expect(sink.calls.single.visitId, visitId);
      expect(finished, 1);
      expect(find.text('Saved on phone. It will upload automatically.'), findsOneWidget);
    });

    testWidgets('any tube not collected -> outcome partial (US-07-6)', (t) async {
      await open(t, collected: 1, notCollected: 1);
      expect(find.text('Collected: 1'), findsOneWidget);
      expect(find.text('Not collected: 1'), findsOneWidget);
      await tapButton(t, 'Finish visit');
      expect(sink.only('visit.completed').payload, {'outcome': 'partial'});
    });

    testWidgets('no payment recorded: summary says the patient pays at the centre', (t) async {
      await open(t, collected: 2, notCollected: 0);
      expect(find.textContaining('pays at centre'), findsOneWidget);
    });

    testWidgets('double tap on Finish visit records one visit.completed; failed save does not finish', (t) async {
      await open(t, collected: 2, notCollected: 0);
      sink.gate = Completer<void>();
      await t.tap(button('Finish visit'));
      await t.pump();
      await t.tap(button('Finish visit'), warnIfMissed: false);
      await t.pump();
      sink.gate!.complete();
      await t.pumpAndSettle();
      expect(sink.types, ['visit.completed']);
      await open(t, collected: 2, notCollected: 0);
      sink.failWith = StateError('disk full');
      await tapButton(t, 'Finish visit');
      expect(finished, 0);
      expect(find.text('Saved on phone. It will upload automatically.'), findsNothing);
      expect(find.textContaining("Couldn't save"), findsOneWidget);
    });
  });

  group('M9 Fail visit', () {
    late RecordingSink sink;
    late int failed;

    Future<void> open(WidgetTester t, {String? preselected}) async {
      sink = RecordingSink();
      failed = 0;
      await pumpScreen(
        t,
        FailVisitScreen(
            visit: sampleVisit(),
            config: sampleConfig(),
            sink: sink,
            readGps: readGpsOff,
            preselectedReasonCode: preselected,
            onFailed: () => failed++),
      );
    }

    testWidgets('lists the configured reasons; nothing chosen -> "Fail visit" disabled', (t) async {
      await open(t);
      expect(find.byType(LimsSecureScreen), findsOneWidget);
      for (final r in ['Patient not home', 'Address not found', 'Patient refused', 'Identity mismatch', 'Unable to draw', 'Other']) {
        expect(find.text(r), findsOneWidget, reason: r);
      }
      expect(isEnabled(t, 'Fail visit'), isFalse);
      expectOnePrimary(t);
    });

    for (final p in [('identity_mismatch', 'Identity mismatch'), ('patient_refused', 'Patient refused')]) {
      testWidgets('preselected ${p.$1} (from M4 / M5): enabled at once and recorded with gps', (t) async {
        await open(t, preselected: p.$1);
        expect(isEnabled(t, 'Fail visit'), isTrue);
        await tapButton(t, 'Fail visit');
        expect(sink.only('visit.failed').payload, {'reason_code': p.$1, 'gps': gpsOff});
        expect(sink.calls.single.visitId, visitId);
        expect(failed, 1);
      });
    }

    testWidgets('"other" needs text (<= 200); empty or blank text records nothing', (t) async {
      await open(t);
      await tapText(t, 'Other');
      expect(isEnabled(t, 'Fail visit'), isFalse, reason: 'other requires text');
      await t.enterText(fieldByKey('fail.reason_text'), '   ');
      await t.pump();
      expect(isEnabled(t, 'Fail visit'), isFalse);
      await t.enterText(fieldByKey('fail.reason_text'), 'y' * 250);
      await t.pump();
      await tapButton(t, 'Fail visit');
      final p = sink.only('visit.failed').payload;
      expect(p['reason_code'], 'other');
      expect((p['reason_text']! as String).length, 200);
    });

    testWidgets('a reason that does not require text still lets the user add optional text', (t) async {
      await open(t);
      await tapText(t, 'Address not found');
      await t.enterText(fieldByKey('fail.reason_text'), 'Lane blocked');
      await tapButton(t, 'Fail visit');
      expect(sink.only('visit.failed').payload,
          {'reason_code': 'address_not_found', 'reason_text': 'Lane blocked', 'gps': gpsOff});
    });

    testWidgets('double tap fails the visit once; failed save does not advance', (t) async {
      await open(t, preselected: 'patient_refused');
      sink.gate = Completer<void>();
      await t.tap(button('Fail visit'));
      await t.pump();
      await t.tap(button('Fail visit'), warnIfMissed: false);
      await t.pump();
      sink.gate!.complete();
      await t.pumpAndSettle();
      expect(sink.types, ['visit.failed']);
      await open(t, preselected: 'patient_refused');
      sink.failWith = StateError('disk full');
      await tapButton(t, 'Fail visit');
      expect(failed, 0);
      expect(find.textContaining("Couldn't save"), findsOneWidget);
    });
  });
}
