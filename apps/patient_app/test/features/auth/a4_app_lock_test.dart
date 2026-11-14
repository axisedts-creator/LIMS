// T-A4 — 04-UI-UX A4 App lock; 03-APP-FLOW §2.3; US-EN-02.4 (REQ-SEC-110). Synthetic data only.
// Copy: prompt reason "Confirm it's you to view your health records"; [Try again]; after 3 failures
// "Locked. Open the app again later." and the PHI stays hidden.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient_app/app/app_lock_gate.dart';
import 'package:patient_app/core/lifecycle/background_timer.dart';

import '../../support/device_auth_fake.dart';

void main() {
  final t0 = DateTime.utc(2026, 11, 12, 6);
  late DateTime now;
  late BackgroundTimer timer;
  const childKey = Key('phi-child');

  setUp(() {
    now = t0;
    timer = BackgroundTimer(now: () => now);
  });

  Widget host(ScriptedDeviceAuth auth, {VoidCallback? onSignInRequired}) => MaterialApp(
        home: AppLockGate(
          timer: timer,
          deviceAuth: auth,
          onSignInRequired: onSignInRequired ?? () {},
          child: const Text('orders list (synthetic)', key: childKey),
        ),
      );

  Future<void> lockApp(WidgetTester tester) async {
    timer.onLifecycle(AppLifecycleState.paused);
    now = now.add(const Duration(minutes: 6));
    timer.onLifecycle(AppLifecycleState.resumed);
    await tester.pump();
    await tester.pump();
    await tester.pump();
  }

  test('the OS prompt reason is the A4 copy', () {
    expect(LocalDeviceAuth().reason, "Confirm it's you to view your health records");
  });

  testWidgets('locked: lock screen with a lock icon and [Try again]; PHI hidden; one prompt per lock', (tester) async {
    final auth = ScriptedDeviceAuth([false]);
    await tester.pumpWidget(host(auth));
    await lockApp(tester);
    expect(find.byKey(childKey), findsNothing);
    expect(find.byIcon(Icons.lock), findsOneWidget);
    expect(find.text('Try again'), findsOneWidget);
    expect(find.text('Locked. Open the app again later.'), findsNothing);
    expect(auth.prompts, 1);
  });

  testWidgets('[Try again] asks the device again', (tester) async {
    final auth = ScriptedDeviceAuth([false, false]);
    await tester.pumpWidget(host(auth));
    await lockApp(tester);
    await tester.tap(find.text('Try again'));
    await tester.pump();
    await tester.pump();
    expect(auth.prompts, 2);
    expect(find.text('Try again'), findsOneWidget, reason: 'two failures: still allowed');
    expect(find.byKey(childKey), findsNothing);
  });

  testWidgets('3 failures: "Locked. Open the app again later."; no more prompts; PHI stays hidden', (tester) async {
    final auth = ScriptedDeviceAuth([false, false, false, true, true]);
    await tester.pumpWidget(host(auth));
    await lockApp(tester);
    await tester.tap(find.text('Try again'));
    await tester.pump();
    await tester.pump();
    await tester.tap(find.text('Try again'));
    await tester.pump();
    await tester.pump();
    expect(auth.prompts, 3);
    expect(find.text('Locked. Open the app again later.'), findsOneWidget);
    expect(find.text('Try again'), findsNothing);
    expect(find.byKey(childKey), findsNothing);
    expect(timer.locked.value, isTrue);
    await tester.pump(const Duration(seconds: 30));
    expect(auth.prompts, 3, reason: 'no 4th prompt, even though the fake would now succeed');
    expect(find.byKey(childKey), findsNothing);
  });

  testWidgets('success after two failures unlocks, and the next lock starts with a fresh set of 3 tries', (tester) async {
    final auth = ScriptedDeviceAuth([false, false, true, false, false]);
    await tester.pumpWidget(host(auth));
    await lockApp(tester);
    await tester.tap(find.text('Try again'));
    await tester.pump();
    await tester.pump();
    await tester.tap(find.text('Try again'));
    await tester.pump();
    await tester.pump();
    await tester.pump();
    expect(timer.locked.value, isFalse);
    expect(find.byKey(childKey), findsOneWidget);
    await lockApp(tester); // prompt 4 -> false
    await tester.tap(find.text('Try again')); // prompt 5 -> false
    await tester.pump();
    await tester.pump();
    expect(auth.prompts, 5);
    expect(find.text('Try again'), findsOneWidget, reason: 'only 2 failures in this lock');
    expect(find.text('Locked. Open the app again later.'), findsNothing);
  });

  testWidgets('no device screen lock: neither the prompt nor the lock-out copy; a new OTP sign-in is required', (tester) async {
    final auth = ScriptedDeviceAuth([], secure: false);
    var signIn = 0;
    await tester.pumpWidget(host(auth, onSignInRequired: () => signIn++));
    await lockApp(tester);
    expect(signIn, 1);
    expect(auth.prompts, 0);
    expect(find.text('Try again'), findsNothing);
    expect(find.text('Locked. Open the app again later.'), findsNothing);
  });

  testWidgets('accessibility: [Try again] is a 48 dp target and the lock screen survives text scale 2.0', (tester) async {
    tester.platformDispatcher.textScaleFactorTestValue = 2.0;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    final auth = ScriptedDeviceAuth([false]);
    await tester.pumpWidget(host(auth));
    await lockApp(tester);
    expect(tester.takeException(), isNull);
    final button = find.ancestor(of: find.text('Try again'), matching: find.byWidgetPredicate((w) => w is ButtonStyleButton));
    expect(tester.getSize(button.first).height, greaterThanOrEqualTo(48));
  });
}
