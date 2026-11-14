// T-PAY1 — A15 Pay due, start view (US-EN-10.1 / 10.2 / 10.4 / 10.6; 03-APP-FLOW §4.2 + §10.1 A15 row + payment sequence; 04-UI-UX A15). Synthetic data only.
// done_when: "Paid only on completed". Time is driven by tester.pump (fake clock): never pumpAndSettle (timers).
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../support/payments_fakes.dart';
import '../../support/rig.dart';

void main() {
  late Rig rig;
  late FakePaymentsApi api;
  late List<Uri> opened;

  setUp(() async {
    rig = await Rig.create();
    api = FakePaymentsApi();
    opened = [];
  });
  tearDown(() => rig.dispose());

  Future<void> choose(WidgetTester tester, String label) async {
    await tester.tap(find.text(label));
    await tester.pump();
  }

  Future<void> proceed(WidgetTester tester, String label) async {
    await choose(tester, label);
    await tester.tap(find.widgetWithText(LimsButton, 'Continue'));
    await tester.pump(const Duration(milliseconds: 10));
    await tester.pump(const Duration(milliseconds: 10));
  }

  group('start view', () {
    testWidgets('amount is read-only text from the order projection (no input accepts an amount, REQ-SEC-046); gateway choice offers exactly the given gateways; one primary [Continue]', (tester) async {
      await openPay(tester, rig, api, opened);
      expect(find.textContaining('Rs. 2,250.00'), findsWidgets);
      expect(find.byType(TextField), findsNothing);
      expect(find.byType(TextFormField), findsNothing);
      expect(find.byType(LimsTextField), findsNothing);
      expect(find.byType(LimsSegmentedControl<String>), findsOneWidget);
      expect(find.text('eSewa'), findsOneWidget);
      expect(find.text('Khalti'), findsOneWidget);
      expect(find.widgetWithText(LimsButton, 'Continue'), findsOneWidget);
      expect(find.byType(LimsSecureScreen), findsOneWidget);
      expect(api.createCalls, isEmpty, reason: 'nothing is sent before Continue');
    });

    testWidgets('only offered gateways are shown (E1 gateways = [khalti])', (tester) async {
      await openPay(tester, rig, api, opened, gateways: const ['khalti']);
      expect(find.text('Khalti'), findsOneWidget);
      expect(find.text('eSewa'), findsNothing);
    });
  });

  group('E41 then E42 polling (US-EN-10.1 / 10.2)', () {
    testWidgets('Continue sends E41 once with the order id, the CHOSEN gateway and a non-empty Idempotency-Key; "Preparing payment…" shows; nothing is opened yet', (tester) async {
      await openPay(tester, rig, api, opened);
      await proceed(tester, 'eSewa');
      expect(api.createCalls, hasLength(1));
      expect(api.createCalls.single.orderId, payOrderId);
      expect(api.createCalls.single.gateway, 'esewa');
      expect(api.createCalls.single.key, isNotEmpty);
      expect(find.textContaining('Preparing payment'), findsOneWidget);
      expect(opened, isEmpty);
    });

    testWidgets('while queued the app polls E42 every 2 s with the request id from E41; when ready the action url is opened ONCE in the system browser, shown as "Opening Khalti…" and never printed on screen', (tester) async {
      api.onGet = (call) => call < 3 ? pr('queued') : pr('ready');
      await openPay(tester, rig, api, opened);
      await proceed(tester, 'Khalti');
      expect(api.getCalls, isEmpty, reason: 'first poll is 2 s after E41');
      await tick(tester, const Duration(seconds: 1));
      expect(api.getCalls, isEmpty);
      await tick(tester, const Duration(seconds: 2));
      expect(api.getCalls, hasLength(1));
      expect(api.getCalls.single, payId);
      expect(opened, isEmpty, reason: 'still queued');
      await tick(tester, const Duration(seconds: 2));
      await tick(tester, const Duration(seconds: 2));
      expect(opened, [Uri.parse(khaltiUrl)]);
      await tick(tester, const Duration(seconds: 10));
      expect(opened, hasLength(1), reason: 'opened exactly once, however long the screen stays');
      expect(find.textContaining(secretToken), findsNothing, reason: 'the action url carries the gateway callback token');
      expect(find.textContaining('SECRET'), findsNothing);
    });

    testWidgets('eSewa: the form_post launch url is what gets opened', (tester) async {
      api.onGet = (_) => pr('ready', gateway: 'esewa');
      api.onCreate = (_, g, _) => pr('queued', gateway: g);
      await openPay(tester, rig, api, opened);
      await proceed(tester, 'eSewa');
      await tick(tester, const Duration(seconds: 3));
      expect(opened, [Uri.parse(esewaUrl)]);
    });

    testWidgets('E41 may answer the already-open request as ready (200): its action is opened without waiting for a poll', (tester) async {
      api.onCreate = (_, g, _) => pr('ready', gateway: g);
      await openPay(tester, rig, api, opened);
      await proceed(tester, 'Khalti');
      await tick(tester, const Duration(seconds: 1));
      expect(opened, [Uri.parse(khaltiUrl)]);
    });

    testWidgets('queued forever: polling stops after 30 s (about 15 polls), never faster than 2 s', (tester) async {
      await openPay(tester, rig, api, opened);
      await proceed(tester, 'Khalti');
      await tick(tester, const Duration(seconds: 31));
      final at31 = api.getCalls.length;
      expect(at31, inInclusiveRange(14, 16));
      await tick(tester, const Duration(seconds: 30));
      expect(api.getCalls.length, at31, reason: 'no poll after the 30 s window');
      expect(opened, isEmpty);
      expect(find.textContaining('Paid'), findsNothing);
    });

    testWidgets('a second tap on Continue while E41 is in flight sends nothing more', (tester) async {
      final gate = Completer<void>();
      api.holdCreate = (_) => gate.future;
      await openPay(tester, rig, api, opened);
      await choose(tester, 'Khalti');
      await tester.tap(find.widgetWithText(LimsButton, 'Continue'));
      await tester.pump();
      await tester.tap(find.widgetWithText(LimsButton, 'Continue'), warnIfMissed: false);
      await tester.pump();
      expect(api.createCalls, hasLength(1));
      gate.complete();
      await tester.pump(const Duration(milliseconds: 10));
    });

    testWidgets('E41 failure (network / server): a message, Continue available again, and the retry reuses the SAME Idempotency-Key (P-8)', (tester) async {
      api.onCreate = (call, g, _) => call == 1 ? throw LimsException('common.internal') : pr('queued', gateway: g);
      await openPay(tester, rig, api, opened);
      await proceed(tester, 'Khalti');
      expect(find.textContaining('Preparing payment'), findsNothing);
      expect(find.textContaining('Paid'), findsNothing);
      expect(find.widgetWithText(LimsButton, 'Continue'), findsOneWidget);
      await tester.tap(find.widgetWithText(LimsButton, 'Continue'));
      await tester.pump(const Duration(milliseconds: 10));
      expect(api.createCalls, hasLength(2));
      expect(api.createCalls[1].key, api.createCalls[0].key);
    });

    testWidgets('leaving the screen stops the polling', (tester) async {
      await openPay(tester, rig, api, opened);
      await proceed(tester, 'Khalti');
      await tick(tester, const Duration(seconds: 4));
      await tester.pumpWidget(const SizedBox());
      final n = api.getCalls.length;
      await tick(tester, const Duration(seconds: 30));
      expect(api.getCalls.length, n);
    });
  });

  group('US-EN-10.4: failed + failure_code -> the matching message (03-APP-FLOW §10.1 A15); the raw code is never shown', () {
    final cases = <String, String>{
      'payments.nothing_due': 'Nothing to pay',
      'payments.intent_open_exists': 'A payment is already in progress',
      'payments.amount_not_supported': "This amount can't be paid online",
      'payments.gateway_not_available': 'This payment method is unavailable',
    };
    for (final e in cases.entries) {
      testWidgets(e.key, (tester) async {
        api.onGet = (_) => pr('failed', failureCode: e.key);
        await openPay(tester, rig, api, opened);
        await proceed(tester, 'Khalti');
        await tick(tester, const Duration(seconds: 3));
        expect(find.textContaining(e.value), findsWidgets);
        expect(find.textContaining('payments.'), findsNothing);
        expect(find.textContaining('Paid'), findsNothing);
        expect(opened, isEmpty);
        await tick(tester, const Duration(seconds: 20));
        expect(api.getCalls, hasLength(1), reason: 'failed is terminal: polling stops');
      });
    }
  });
}
