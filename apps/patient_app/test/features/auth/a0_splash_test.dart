// T-A4 — 04-UI-UX A0 Splash: calls E1; if E1 fails 3x -> LimsErrorState "We can't reach {lab} right now." [Try again].
// Synthetic data only.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';

import '../../support/auth_fakes.dart';
import '../../support/rig.dart';

void main() {
  late Rig rig;
  late FakeAuthApi api;

  setUp(() async {
    rig = await Rig.create();
    api = FakeAuthApi(now: () => rig.now);
  });
  tearDown(() => rig.dispose());

  testWidgets('shows a spinner and calls E1 exactly once while it is pending; no form yet', (tester) async {
    api.configHold = Completer<void>();
    await tester.pumpWidget(signInHost(rig, api));
    await tester.pump();
    expect(api.configCalls, 1);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.text('Send code'), findsNothing);
    api.configHold!.complete();
    await settle(tester, seconds: 3);
    expect(find.text('Send code'), findsOneWidget);
    expect(api.configCalls, 1, reason: 'one E1 call per start');
  });

  testWidgets('E1 success lands on A2 (phone entry)', (tester) async {
    await bootSignIn(tester, rig, api);
    expect(api.configCalls, 1);
    expect(find.text('Mobile number'), findsWidgets);
    expect(find.text('Send code'), findsOneWidget);
  });

  testWidgets('two failures then success: still ends on A2 after 3 calls, no error state', (tester) async {
    api.configFail = (c) => c <= 2 ? serverError() : null;
    await tester.pumpWidget(signInHost(rig, api));
    await settle(tester, seconds: 30);
    expect(api.configCalls, 3);
    expect(find.text('Send code'), findsOneWidget);
    expect(find.textContaining("We can't reach"), findsNothing);
  });

  testWidgets('E1 failing 3x shows the error state with the lab name and [Try again]; no 4th automatic call', (tester) async {
    api.configFail = (_) => serverError();
    await tester.pumpWidget(signInHost(rig, api));
    await settle(tester, seconds: 30);
    expect(api.configCalls, 3);
    expect(find.text("We can't reach Synthetic Lab Alpha right now."), findsOneWidget);
    expect(find.text('Try again'), findsOneWidget);
    expect(find.byIcon(Icons.error_outline), findsOneWidget, reason: 'status shows tone icon + word (LD-140)');
    await settle(tester, seconds: 60);
    expect(api.configCalls, 3, reason: 'retry is the user\'s action now');
    expect(find.text('Send code'), findsNothing);
  });

  testWidgets('[Try again] calls E1 again and A2 appears once it succeeds', (tester) async {
    api.configFail = (c) => c <= 3 ? serverError() : null;
    await tester.pumpWidget(signInHost(rig, api));
    await settle(tester, seconds: 30);
    await tester.tap(find.text('Try again'));
    await settle(tester, seconds: 3);
    expect(api.configCalls, 4);
    expect(find.text('Send code'), findsOneWidget);
    expect(find.textContaining("We can't reach"), findsNothing);
  });

  testWidgets('server detail never reaches the screen', (tester) async {
    api.configFail = (_) => serverError(); // safeDetail 'db password hunter2'
    await tester.pumpWidget(signInHost(rig, api));
    await settle(tester, seconds: 30);
    expect(find.textContaining('hunter2'), findsNothing);
    expect(find.textContaining('LimsException'), findsNothing);
  });

  testWidgets('426 engagement.app_version_unsupported: no retry loop (the router shows A1)', (tester) async {
    api.configFail = (_) => LimsException(LimsErrorCodes.engagementAppVersionUnsupported);
    await tester.pumpWidget(signInHost(rig, api));
    await settle(tester, seconds: 30);
    expect(api.configCalls, 1);
  });

  testWidgets('A0 error state: one primary button at most, 48 dp target, text scale 2.0 does not overflow', (tester) async {
    tester.platformDispatcher.textScaleFactorTestValue = 2.0;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    api.configFail = (_) => serverError();
    await tester.pumpWidget(signInHost(rig, api));
    await settle(tester, seconds: 30);
    expect(tester.takeException(), isNull);
    expect(find.byType(FilledButton).evaluate().length, lessThanOrEqualTo(1));
    expect(tester.getSize(find.text('Try again')).height, greaterThan(0));
    final button = find.ancestor(of: find.text('Try again'), matching: find.byWidgetPredicate((w) => w is ButtonStyleButton));
    expect(tester.getSize(button.first).height, greaterThanOrEqualTo(48));
  });
}
