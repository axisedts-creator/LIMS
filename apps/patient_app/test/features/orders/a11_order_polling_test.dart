// T-P2 — A11 order detail: E21 polling lifecycle (US-EN-07.8; 02-TRD §4.6 polling contract; 03-APP-FLOW §11 A11 states; 04-UI-UX A11). Synthetic data only.
// done_when: "30 s foreground polling, stops in background". Time is driven by tester.pump (fake clock): never pumpAndSettle (the poll timer never settles).
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../support/auth_fakes.dart' show comeForeground, goBackground;
import '../../support/orders_fakes.dart';
import '../../support/rig.dart';

void main() {
  late Rig rig;
  late FakeOrdersApi api;

  setUp(() async {
    rig = await Rig.create();
    api = FakeOrdersApi();
  });
  tearDown(() => rig.dispose());

  group('first load', () {
    testWidgets('opening A11 fetches E21 once, without If-None-Match, and shows the order', (tester) async {
      await openDetail(tester, rig, api);
      expect(api.getCalls, hasLength(1));
      expect(api.getCalls.single.orderId, orderId);
      expect(api.getCalls.single.ifNoneMatch, isNull, reason: 'nothing cached yet');
      expect(find.textContaining('Sample 1'), findsOneWidget);
      expect(find.textContaining('Updated'), findsOneWidget, reason: '"Updated hh:mm" line (04-UI-UX A11)');
    });

    testWidgets('the screen is a LimsSecureScreen (PHI, REQ-SEC-109)', (tester) async {
      await openDetail(tester, rig, api);
      expect(find.byType(LimsSecureScreen), findsOneWidget);
    });

    testWidgets('payment due shows the "Payment due" banner', (tester) async {
      api.onGet = (_, _) => detail(paymentDue: true);
      await openDetail(tester, rig, api);
      expect(find.textContaining('Payment due'), findsWidgets);
    });
  });

  group('foreground cadence (30 s) and the ETag contract', () {
    testWidgets('no second request before 30 s; the poll at 30 s sends If-None-Match = the last body etag', (tester) async {
      await openDetail(tester, rig, api);
      await elapse(tester, const Duration(seconds: 28));
      expect(api.getCalls, hasLength(1), reason: 'still inside the first interval');
      await elapse(tester, const Duration(seconds: 3));
      expect(api.getCalls, hasLength(2));
      expect(api.getCalls[1].ifNoneMatch, '"1.1.0"');
    });

    testWidgets('304 (null body): the screen keeps showing the order, no error, and the next poll still sends the same ETag', (tester) async {
      api.onGet = (call, inm) => call == 1 ? detail() : null;
      await openDetail(tester, rig, api);
      await elapse(tester, const Duration(seconds: 31));
      expect(api.getCalls, hasLength(2));
      expect(find.textContaining('Sample 1'), findsOneWidget);
      expect(find.textContaining('no longer available'), findsNothing);
      expect(find.textContaining('Something went wrong'), findsNothing);
      await elapse(tester, const Duration(seconds: 30));
      expect(api.getCalls, hasLength(3));
      expect(api.getCalls[2].ifNoneMatch, '"1.1.0"', reason: '304 does not change the cached etag');
    });

    testWidgets('a changed body (200) updates the screen and the next poll sends the NEW etag', (tester) async {
      api.onGet = (call, inm) => call == 1 ? detail() : detailInLab();
      await openDetail(tester, rig, api);
      expect(find.textContaining('Sample 1 — In the lab'), findsNothing);
      await elapse(tester, const Duration(seconds: 31));
      expect(find.textContaining('Sample 1 — In the lab'), findsOneWidget, reason: 'sample line shows the new stage (04-UI-UX A11)');
      await elapse(tester, const Duration(seconds: 30));
      expect(api.getCalls[2].ifNoneMatch, '"2.2.0"');
    });

    testWidgets('steady state: one request per 30 s for 5 minutes (11 requests incl. the first), never faster', (tester) async {
      api.onGet = (call, _) => call == 1 ? detail() : null;
      await openDetail(tester, rig, api);
      await elapse(tester, const Duration(minutes: 5));
      expect(api.getCalls.length, inInclusiveRange(10, 11));
    });
  });

  group('background / foreground (US-EN-07.8 "stops polling in background")', () {
    testWidgets('while the app is in the background no request is made, however long it stays there', (tester) async {
      await openDetail(tester, rig, api);
      await elapse(tester, const Duration(seconds: 10));
      final before = api.getCalls.length;
      await goBackground(tester);
      await elapse(tester, const Duration(minutes: 10));
      expect(api.getCalls.length, before, reason: 'timer cancelled while paused');
    });

    testWidgets('inactive (system dialog, biometric prompt) is not background: polling goes on; paused is and stops it', (tester) async {
      await openDetail(tester, rig, api);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await elapse(tester, const Duration(seconds: 31));
      expect(api.getCalls, hasLength(2));
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await elapse(tester, const Duration(minutes: 2));
      expect(api.getCalls, hasLength(2));
    });

    testWidgets('on resume polling restarts: at least one request within 30 s, and no burst of catch-up requests', (tester) async {
      await openDetail(tester, rig, api);
      await goBackground(tester);
      await elapse(tester, const Duration(minutes: 5));
      final before = api.getCalls.length;
      await comeForeground(tester);
      await elapse(tester, const Duration(seconds: 31));
      final after = api.getCalls.length;
      expect(after - before, inInclusiveRange(1, 2), reason: 'one refresh on resume and/or the first tick, not 10 missed ticks');
      await elapse(tester, const Duration(seconds: 60));
      expect(api.getCalls.length - after, inInclusiveRange(1, 2), reason: 'back to the 30 s cadence');
    });

    testWidgets('a pause/resume pair inside one interval does not double the cadence', (tester) async {
      await openDetail(tester, rig, api);
      for (var i = 0; i < 5; i++) {
        await goBackground(tester);
        await comeForeground(tester);
      }
      await elapse(tester, const Duration(seconds: 60));
      expect(api.getCalls.length, lessThanOrEqualTo(1 + 5 + 2), reason: 'at most one refresh per resume plus ~2 ticks');
      expect(api.maxInFlight, 1);
    });
  });

  group('leaving the screen, the session, in-flight requests', () {
    testWidgets('closing A11 stops polling for good', (tester) async {
      await openDetail(tester, rig, api);
      await elapse(tester, const Duration(seconds: 5));
      final before = api.getCalls.length;
      await tester.pumpWidget(const MaterialApp(home: SizedBox()));
      await elapse(tester, const Duration(minutes: 5));
      expect(api.getCalls.length, before);
    });

    testWidgets('a slow request is never overlapped by the next tick (at most one E21 in flight)', (tester) async {
      final hold = Completer<void>();
      api.holdGet = (call) => call == 2 ? hold.future : null;
      await openDetail(tester, rig, api);
      await elapse(tester, const Duration(seconds: 100));
      expect(api.maxInFlight, 1);
      expect(api.getCalls, hasLength(2), reason: 'call 2 is still in flight; ticks during it are skipped');
      hold.complete();
      await elapse(tester, const Duration(seconds: 35));
      expect(api.getCalls.length, greaterThanOrEqualTo(3));
      expect(api.maxInFlight, 1);
    });

    testWidgets('closing A11 while a request is in flight does not throw when the answer arrives', (tester) async {
      final hold = Completer<void>();
      api.holdGet = (call) => call == 2 ? hold.future : null;
      await openDetail(tester, rig, api);
      await elapse(tester, const Duration(seconds: 31));
      await tester.pumpWidget(const MaterialApp(home: SizedBox()));
      hold.complete();
      await elapse(tester, const Duration(seconds: 2));
      expect(tester.takeException(), isNull);
    });

    testWidgets('logout / session expiry stops polling and drops the order from memory', (tester) async {
      await rig.signIn();
      await openDetail(tester, rig, api);
      await elapse(tester, const Duration(seconds: 5));
      final before = api.getCalls.length;
      await rig.controller.expire();
      await tester.pump();
      await elapse(tester, const Duration(minutes: 3));
      expect(api.getCalls.length, before, reason: 'no E21 after the session is gone');
      expect(find.textContaining('Sample 1'), findsNothing, reason: 'Riverpod state is cleared on logout (TRD §3.5)');
    });
  });

  group('errors (03-APP-FLOW §11 A11 row)', () {
    testWidgets('404 on first load: "This order is no longer available", no timer left behind', (tester) async {
      api.onGet = (_, _) => throw LimsException(LimsErrorCodes.commonNotFound);
      await openDetail(tester, rig, api);
      expect(find.text('This order is no longer available'), findsOneWidget);
      await elapse(tester, const Duration(minutes: 3));
      expect(api.getCalls, hasLength(1), reason: 'a missing order is not polled again');
    });

    testWidgets('404 on a later poll (link revoked / order hidden): message shown, polling stops, old data not kept on screen', (tester) async {
      api.onGet = (call, _) => call == 1 ? detail() : throw LimsException(LimsErrorCodes.commonNotFound);
      await openDetail(tester, rig, api);
      await elapse(tester, const Duration(seconds: 31));
      expect(find.text('This order is no longer available'), findsOneWidget);
      expect(find.textContaining('Sample 1'), findsNothing);
      await elapse(tester, const Duration(minutes: 3));
      expect(api.getCalls, hasLength(2));
    });

    testWidgets('a transient error on a poll keeps the last data, shows no server detail, and the next tick tries again', (tester) async {
      api.onGet = (call, _) => call == 2 ? throw LimsException(LimsErrorCodes.commonInternal, safeDetail: 'db password hunter2') : (call == 1 ? detail() : null);
      await openDetail(tester, rig, api);
      await elapse(tester, const Duration(seconds: 31));
      expect(find.textContaining('Sample 1'), findsOneWidget, reason: 'last known state stays visible');
      expect(find.textContaining('hunter2'), findsNothing);
      await elapse(tester, const Duration(seconds: 30));
      expect(api.getCalls, hasLength(3), reason: 'polling survives the error');
    });

    testWidgets('error on first load shows a retry that fetches again (and then polls)', (tester) async {
      api.onGet = (call, _) => call == 1 ? throw LimsException(LimsErrorCodes.commonInternal) : detail();
      await openDetail(tester, rig, api);
      expect(find.textContaining('Sample 1'), findsNothing);
      await tester.tap(find.textContaining(RegExp('retry|try again', caseSensitive: false)));
      await tester.pump(const Duration(milliseconds: 20));
      await tester.pump(const Duration(milliseconds: 20));
      expect(api.getCalls.length, greaterThanOrEqualTo(2));
      expect(find.textContaining('Sample 1'), findsOneWidget);
    });
  });
}
