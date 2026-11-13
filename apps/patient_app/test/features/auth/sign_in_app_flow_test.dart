// T-A4 — A0-A4 wired into PatientApp (router + AppLockGate + session): US-EN-01.3, US-EN-02.1/.3/.4/.5.
// Synthetic data only.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient_app/app/app.dart';
import 'package:patient_app/core/lifecycle/background_timer.dart';
import 'package:patient_app/core/session/session_controller.dart';

import '../../support/auth_fakes.dart';
import '../../support/device_auth_fake.dart';
import '../../support/rig.dart';

void main() {
  late Rig rig;
  late FakeAuthApi api;
  late DateTime clock;
  late BackgroundTimer timer;

  setUp(() async {
    rig = await Rig.create();
    clock = DateTime.utc(2026, 11, 12, 6);
    api = FakeAuthApi(now: () => rig.now);
    timer = BackgroundTimer(now: () => clock);
  });
  tearDown(() async {
    timer.dispose();
    await rig.dispose();
  });

  Future<void> boot(WidgetTester tester, ScriptedDeviceAuth auth) async {
    await tester.pumpWidget(authScope(rig, api, deviceAuth: auth, timer: timer, child: const PatientApp()));
    await settle(tester, seconds: 3);
  }

  Future<void> signInThroughUi(WidgetTester tester) async {
    await sendCodeFor(tester, '12345678');
    await typeCode(tester, '123456');
  }

  testWidgets('signed out at start: A0 -> A2 sign-in, no device prompt (nothing to protect yet)', (tester) async {
    final auth = ScriptedDeviceAuth([]);
    await boot(tester, auth);
    expect(api.configCalls, 1);
    expect(find.text('Send code'), findsOneWidget);
    expect(auth.prompts, 0);
  });

  testWidgets('OTP success signs in, leaves the sign-in area and does not trigger the lock', (tester) async {
    final auth = ScriptedDeviceAuth([]);
    await boot(tester, auth);
    await signInThroughUi(tester);
    expect(rig.controller.status.value, SessionStatus.signedIn);
    expect(find.text('Send code'), findsNothing);
    expect(find.textContaining('Enter the 6-digit code'), findsNothing);
    expect(auth.prompts, 0, reason: 'a fresh sign-in is not locked');
  });

  testWidgets('A2/A3 are not PHI: more than 5 minutes in the background does not lock or prompt, typed input stays', (tester) async {
    final auth = ScriptedDeviceAuth([]);
    await boot(tester, auth);
    await tester.enterText(find.byType(TextField), '12345678');
    await tester.pump();
    await goBackground(tester);
    clock = clock.add(const Duration(minutes: 6));
    await comeForeground(tester);
    await settle(tester, seconds: 1);
    expect(auth.prompts, 0);
    expect(find.text('Send code'), findsOneWidget);
    expect(find.text('12345678'), findsOneWidget);
    expect(find.text('Try again'), findsNothing);
  });

  testWidgets('signed in + more than 300 s in the background: A4 lock screen with [Try again], no PHI', (tester) async {
    await rig.store.write(tok('S0'));
    final auth = ScriptedDeviceAuth([true, false]); // cold start unlock, then the cancelled prompt
    await boot(tester, auth);
    expect(timer.locked.value, isFalse);
    await goBackground(tester);
    clock = clock.add(const Duration(minutes: 6));
    await comeForeground(tester);
    await settle(tester, seconds: 1);
    expect(auth.prompts, 2);
    expect(timer.locked.value, isTrue);
    expect(find.text('Try again'), findsOneWidget);
  });

  testWidgets('no device screen lock + stored session: session wiped, server logout called, OTP sign-in shown (US-EN-02.4)', (tester) async {
    await rig.store.write(tok('S0'));
    final auth = ScriptedDeviceAuth([], secure: false);
    await boot(tester, auth);
    await settle(tester, seconds: 3);
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
    await settle(tester, seconds: 1);
    expect(auth.prompts, 0);
    expect(rig.controller.status.value, SessionStatus.signedOut);
    expect(await rig.storage.readAll(), isEmpty);
    expect(rig.identity.logoutCalls, 1);
    expect(find.text('Send code'), findsOneWidget);
  });

  testWidgets('auth.session_expired while signed in (US-EN-02.3): storage and temp files wiped, sign-in screen shown', (tester) async {
    await rig.store.write(tok('S0'));
    await tester.runAsync(() => File('${rig.tempDir.path}/report.pdf').writeAsBytes([1, 2, 3]));
    final auth = ScriptedDeviceAuth([true]);
    await boot(tester, auth);
    expect(find.text('Send code'), findsNothing);
    await tester.runAsync(() => rig.controller.expire()); // what the transport does on auth.session_expired
    await settle(tester, seconds: 3);
    expect(await rig.storage.readAll(), isEmpty);
    expect(File('${rig.tempDir.path}/report.pdf').existsSync(), isFalse);
    expect(find.text('Send code'), findsOneWidget);
  });

  testWidgets('logout (US-EN-02.5) clears sign-in state: A2 again, empty field, no stale challenge, fresh E2/E3 on the next sign-in', (tester) async {
    final auth = ScriptedDeviceAuth([]);
    await boot(tester, auth);
    await signInThroughUi(tester);
    expect(rig.controller.status.value, SessionStatus.signedIn);

    await tester.runAsync(() => rig.controller.logout());
    await settle(tester, seconds: 3);
    expect(rig.identity.logoutCalls, 1);
    expect(find.text('Send code'), findsOneWidget);
    expect(find.text('12345678'), findsNothing, reason: 'the previous number is not kept');
    expect(find.textContaining('Enter the 6-digit code'), findsNothing);
    expect(await rig.storage.readAll(), isEmpty);

    await signInThroughUi(tester);
    expect(api.requestedPhones, hasLength(2));
    expect(api.verifyCalls.last.challengeToken, api.challengeToken(2), reason: 'the first challenge is gone');
    expect(rig.controller.status.value, SessionStatus.signedIn);
  });
}
