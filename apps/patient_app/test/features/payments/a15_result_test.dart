// T-PAY1 — A15 result view behind the app link /payments/{payment_request_id}/done (US-EN-10.3; 02-TRD §4.7 step 3; 03-APP-FLOW payment sequence + §10.1; 04-UI-UX A15; REQ-SEC-059). Synthetic data only.
// "Paid" only after E42 reports `completed`; the `outcome` query parameter is ignored. Time is driven by tester.pump (fake clock).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../support/payments_fakes.dart';
import '../../support/rig.dart';

const _confirming = 'We are confirming your payment. This can take a few minutes.';

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

  final okLink = Uri.parse('https://app.invalid/payments/$payId/done?intent_id=01950c16-0000-7000-8000-000000000bbb&outcome=success');
  final failLink = Uri.parse('https://app.invalid/payments/$payId/done?intent_id=01950c16-0000-7000-8000-000000000bbb&outcome=failed');

  group('REQ-SEC-059: the return URL never decides', () {
    testWidgets('outcome=success in the link but E42 says ready -> NOT "Paid" (still checking), and E42 is asked with the request id of the route only', (tester) async {
      api.onGet = (_) => pr('ready');
      await openResult(tester, rig, api, opened, returnUri: okLink);
      expect(find.textContaining('Paid'), findsNothing);
      expect(api.getCalls, [payId]);
      await tick(tester, const Duration(seconds: 10));
      expect(find.textContaining('Paid'), findsNothing);
      expect(api.getCalls.every((c) => c == payId), isTrue);
      expect(opened, isEmpty, reason: 'the result view never reopens the gateway');
    });

    testWidgets('outcome=failed in the link but E42 says completed -> "Paid — thank you"', (tester) async {
      api.onGet = (_) => pr('completed');
      await openResult(tester, rig, api, opened, returnUri: failLink);
      expect(find.text('Paid — thank you'), findsOneWidget);
      expect(find.textContaining('not completed'), findsNothing);
    });

    testWidgets('no link query at all works the same (app opened later, A11 flow)', (tester) async {
      api.onGet = (_) => pr('completed');
      await openResult(tester, rig, api, opened);
      expect(find.text('Paid — thank you'), findsOneWidget);
    });

    for (final s in ['queued', 'ready', 'failed', 'expired']) {
      testWidgets('status $s with outcome=success in the link is never "Paid"', (tester) async {
        api.onGet = (_) => pr(s, failureCode: s == 'failed' ? 'payments.nothing_due' : null);
        await openResult(tester, rig, api, opened, returnUri: okLink);
        await tick(tester, const Duration(seconds: 4));
        expect(find.textContaining('Paid'), findsNothing);
      });
    }

    testWidgets('a malformed or hostile link query (unknown keys, script text) changes nothing and is never shown', (tester) async {
      api.onGet = (_) => pr('ready');
      await openResult(tester, rig, api, opened, returnUri: Uri.parse('https://app.invalid/payments/$payId/done?outcome=<script>alert(1)</script>&amount=1&status=completed'));
      expect(find.textContaining('script'), findsNothing);
      expect(find.textContaining('Paid'), findsNothing);
    });
  });

  group('polling: every 3 s up to 60 s', () {
    testWidgets('first E42 on open, then every 3 s (no faster); a ready request keeps being polled', (tester) async {
      api.onGet = (_) => pr('ready');
      await openResult(tester, rig, api, opened);
      expect(api.getCalls, hasLength(1));
      await tick(tester, const Duration(seconds: 2));
      expect(api.getCalls, hasLength(1), reason: 'still inside the first 3 s');
      await tick(tester, const Duration(seconds: 2));
      expect(api.getCalls, hasLength(2));
      await tick(tester, const Duration(seconds: 6));
      expect(api.getCalls, hasLength(4));
    });

    testWidgets('becoming completed shows "Paid — thank you" and stops polling', (tester) async {
      api.onGet = (call) => call < 3 ? pr('ready') : pr('completed');
      await openResult(tester, rig, api, opened, returnUri: okLink);
      await tick(tester, const Duration(seconds: 8));
      expect(find.text('Paid — thank you'), findsOneWidget);
      final n = api.getCalls.length;
      await tick(tester, const Duration(seconds: 30));
      expect(api.getCalls.length, n);
    });

    testWidgets('60 s without a result -> "We are confirming your payment. This can take a few minutes." + [Check again]; polling has stopped; never "Paid"', (tester) async {
      api.onGet = (_) => pr('ready');
      await openResult(tester, rig, api, opened, returnUri: okLink);
      await tick(tester, const Duration(seconds: 62));
      expect(find.text(_confirming), findsOneWidget);
      expect(find.widgetWithText(LimsButton, 'Check again'), findsOneWidget);
      expect(find.textContaining('Paid'), findsNothing);
      final n = api.getCalls.length;
      expect(n, inInclusiveRange(20, 22));
      await tick(tester, const Duration(seconds: 30));
      expect(api.getCalls.length, n);
    });

    testWidgets('[Check again] asks E42 once more; a completed answer then shows "Paid — thank you"', (tester) async {
      var done = false;
      api.onGet = (_) => done ? pr('completed') : pr('ready');
      await openResult(tester, rig, api, opened);
      await tick(tester, const Duration(seconds: 62));
      final n = api.getCalls.length;
      done = true;
      await tester.tap(find.widgetWithText(LimsButton, 'Check again'));
      await tester.pump(const Duration(milliseconds: 10));
      await tester.pump(const Duration(milliseconds: 10));
      expect(api.getCalls.length, n + 1);
      expect(find.text('Paid — thank you'), findsOneWidget);
    });

    testWidgets('review: true (held for review) shows the confirming message and [Check again] straight away, never "Paid"', (tester) async {
      api.onGet = (_) => pr('ready', review: true);
      await openResult(tester, rig, api, opened, returnUri: okLink);
      expect(find.text(_confirming), findsOneWidget);
      expect(find.widgetWithText(LimsButton, 'Check again'), findsOneWidget);
      expect(find.textContaining('Paid'), findsNothing);
    });

    testWidgets('leaving the screen stops the polling', (tester) async {
      api.onGet = (_) => pr('ready');
      await openResult(tester, rig, api, opened);
      await tester.pumpWidget(const SizedBox());
      final n = api.getCalls.length;
      await tick(tester, const Duration(seconds: 30));
      expect(api.getCalls.length, n);
    });
  });

  group('not completed', () {
    for (final s in ['failed', 'expired']) {
      testWidgets('$s -> "Payment not completed" + [Try again]; polling stops; never "Paid"', (tester) async {
        api.onGet = (_) => pr(s, failureCode: s == 'failed' ? 'payments.amount_not_supported' : null);
        await openResult(tester, rig, api, opened, returnUri: okLink);
        expect(find.text('Payment not completed'), findsOneWidget);
        expect(find.widgetWithText(LimsButton, 'Try again'), findsOneWidget);
        expect(find.textContaining('Paid'), findsNothing);
        expect(find.textContaining('payments.'), findsNothing);
        await tick(tester, const Duration(seconds: 15));
        expect(api.getCalls, hasLength(1));
      });
    }

    testWidgets('E42 404 (the request is not ours / gone) -> an error state, no crash, never "Paid"', (tester) async {
      api.onGet = (_) => throw LimsException(LimsErrorCodes.commonNotFound);
      await openResult(tester, rig, api, opened, returnUri: okLink);
      expect(find.textContaining('Paid'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('the screen is a LimsSecureScreen and shows the status with a LimsStatusChip (tone, icon and word)', (tester) async {
      api.onGet = (_) => pr('completed');
      await openResult(tester, rig, api, opened);
      expect(find.byType(LimsSecureScreen), findsOneWidget);
      expect(find.byType(LimsStatusChip), findsWidgets);
    });
  });
}
