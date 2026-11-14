// T-A1 — US-EN-02.4 (REQ-SEC-110): app lock after > 300 s in background, fake clock; no device lock -> OTP re-login.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient_app/app/app_lock_gate.dart';
import 'package:patient_app/core/lifecycle/background_timer.dart';

class FakeDeviceAuth implements DeviceAuth {
  FakeDeviceAuth({this.secure = true, this.result = true});
  bool secure;
  bool result;
  int prompts = 0;
  @override
  Future<bool> isDeviceSecure() async => secure;
  @override
  Future<bool> authenticate() async {
    prompts++;
    return result;
  }
}

void main() {
  final t0 = DateTime.utc(2026, 11, 12, 6);
  late DateTime now;
  late BackgroundTimer timer;

  setUp(() {
    now = t0;
    timer = BackgroundTimer(now: () => now);
  });

  group('BackgroundTimer (300 s rule, fake clock)', () {
    test('default threshold is 300 s', () => expect(BackgroundTimer(now: () => now).threshold, const Duration(seconds: 300)));

    test('starts unlocked', () => expect(timer.locked.value, isFalse));

    test('resume after 299 s keeps it unlocked', () {
      timer.onLifecycle(AppLifecycleState.paused);
      now = t0.add(const Duration(seconds: 299));
      timer.onLifecycle(AppLifecycleState.resumed);
      expect(timer.locked.value, isFalse);
    });

    test('resume after exactly 300 s keeps it unlocked (rule is "more than")', () {
      timer.onLifecycle(AppLifecycleState.paused);
      now = t0.add(const Duration(seconds: 300));
      timer.onLifecycle(AppLifecycleState.resumed);
      expect(timer.locked.value, isFalse);
    });

    test('resume after 301 s locks', () {
      timer.onLifecycle(AppLifecycleState.paused);
      now = t0.add(const Duration(seconds: 301));
      timer.onLifecycle(AppLifecycleState.resumed);
      expect(timer.locked.value, isTrue);
    });

    test('a repeated paused event does not restart the clock', () {
      timer.onLifecycle(AppLifecycleState.paused);
      now = t0.add(const Duration(seconds: 200));
      timer.onLifecycle(AppLifecycleState.paused);
      now = t0.add(const Duration(seconds: 301));
      timer.onLifecycle(AppLifecycleState.resumed);
      expect(timer.locked.value, isTrue);
    });

    test('inactive/hidden alone (system dialog, biometric prompt) never lock', () {
      timer.onLifecycle(AppLifecycleState.inactive);
      timer.onLifecycle(AppLifecycleState.hidden);
      now = t0.add(const Duration(minutes: 30));
      timer.onLifecycle(AppLifecycleState.resumed);
      expect(timer.locked.value, isFalse);
    });

    test('resumed without a prior pause does not lock', () {
      now = t0.add(const Duration(hours: 1));
      timer.onLifecycle(AppLifecycleState.resumed);
      expect(timer.locked.value, isFalse);
    });

    test('unlock() clears the lock and a short background afterwards does not re-lock', () {
      timer.onLifecycle(AppLifecycleState.paused);
      now = t0.add(const Duration(minutes: 6));
      timer.onLifecycle(AppLifecycleState.resumed);
      timer.unlock();
      expect(timer.locked.value, isFalse);
      timer.onLifecycle(AppLifecycleState.paused);
      now = now.add(const Duration(seconds: 10));
      timer.onLifecycle(AppLifecycleState.resumed);
      expect(timer.locked.value, isFalse);
    });

    test('lock is sticky: resuming again quickly does not clear it', () {
      timer.onLifecycle(AppLifecycleState.paused);
      now = t0.add(const Duration(minutes: 6));
      timer.onLifecycle(AppLifecycleState.resumed);
      timer.onLifecycle(AppLifecycleState.paused);
      now = now.add(const Duration(seconds: 1));
      timer.onLifecycle(AppLifecycleState.resumed);
      expect(timer.locked.value, isTrue);
    });

    test('clock moved backwards while backgrounded fails closed (locks)', () {
      timer.onLifecycle(AppLifecycleState.paused);
      now = t0.subtract(const Duration(minutes: 10));
      timer.onLifecycle(AppLifecycleState.resumed);
      expect(timer.locked.value, isTrue);
    });
  });

  group('AppLockGate widget', () {
    const childKey = Key('phi-child');
    Widget host(BackgroundTimer t, FakeDeviceAuth auth, {VoidCallback? onSignInRequired}) => MaterialApp(
          home: AppLockGate(
            timer: t,
            deviceAuth: auth,
            onSignInRequired: onSignInRequired ?? () {},
            child: const Text('orders list (synthetic)', key: childKey),
          ),
        );

    void background(BackgroundTimer t, Duration d) {
      t.onLifecycle(AppLifecycleState.paused);
      now = now.add(d);
      t.onLifecycle(AppLifecycleState.resumed);
    }

    testWidgets('unlocked: child visible, no prompt', (tester) async {
      final auth = FakeDeviceAuth();
      await tester.pumpWidget(host(timer, auth));
      expect(find.byKey(childKey), findsOneWidget);
      expect(auth.prompts, 0);
    });

    testWidgets('after > 300 s in background the child is hidden and the device prompt is requested', (tester) async {
      final auth = FakeDeviceAuth(result: false);
      await tester.pumpWidget(host(timer, auth));
      background(timer, const Duration(seconds: 301));
      await tester.pump();
      await tester.pump();
      expect(find.byKey(childKey), findsNothing);
      expect(auth.prompts, 1);
    });

    testWidgets('successful biometric/PIN unlocks and shows the child again', (tester) async {
      final auth = FakeDeviceAuth(result: true);
      await tester.pumpWidget(host(timer, auth));
      background(timer, const Duration(minutes: 6));
      await tester.pump();
      await tester.pump();
      await tester.pump();
      expect(timer.locked.value, isFalse);
      expect(find.byKey(childKey), findsOneWidget);
    });

    testWidgets('failed/cancelled authentication keeps the PHI hidden', (tester) async {
      final auth = FakeDeviceAuth(result: false);
      await tester.pumpWidget(host(timer, auth));
      background(timer, const Duration(minutes: 6));
      await tester.pump();
      await tester.pump();
      expect(timer.locked.value, isTrue);
      expect(find.byKey(childKey), findsNothing);
    });

    testWidgets('no device screen lock: requires a new OTP sign-in instead of the prompt', (tester) async {
      final auth = FakeDeviceAuth(secure: false);
      var signInRequired = 0;
      await tester.pumpWidget(host(timer, auth, onSignInRequired: () => signInRequired++));
      background(timer, const Duration(minutes: 6));
      await tester.pump();
      await tester.pump();
      expect(signInRequired, 1);
      expect(auth.prompts, 0);
      expect(find.byKey(childKey), findsNothing);
    });

    testWidgets('within 5 minutes nothing is asked', (tester) async {
      final auth = FakeDeviceAuth();
      await tester.pumpWidget(host(timer, auth));
      background(timer, const Duration(minutes: 4));
      await tester.pump();
      expect(find.byKey(childKey), findsOneWidget);
      expect(auth.prompts, 0);
    });
  });
}
