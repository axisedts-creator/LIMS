// T0C-M4-PATIENT-1 test harness: mounts A0..A5, A20, A23 on a 360 dp phone at a given text scale, with or without reduced motion,
// inside the real LimsTheme and the existing fakes. Synthetic data only. LD-258 (restyle only), 13-M-SERIES s2.3 / s5.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:patient_app/app/app_lock_gate.dart';
import 'package:patient_app/app/providers.dart';
import 'package:patient_app/app/router.dart';
import 'package:patient_app/app/update_required_screen.dart';
import 'package:patient_app/core/lifecycle/background_timer.dart';
import 'package:patient_app/features/auth/auth_providers.dart';
import 'package:patient_app/features/auth/sign_in_flow.dart';
import 'package:patient_app/features/bookings/bookings_providers.dart';
import 'package:patient_app/features/notifications/notifications_providers.dart';
import 'package:patient_app/features/notifications/notifications_screen.dart';
import 'package:patient_app/features/orders/orders_providers.dart';
import 'package:patient_app/features/profiles/profiles_providers.dart';
import 'package:patient_app/features/reports/reports_providers.dart';
import 'package:patient_app/features/settings/settings_providers.dart';
import 'package:patient_app/features/settings/settings_screen.dart';

import 'auth_fakes.dart';
import 'bookings_fakes.dart' show FakeBookingsApi;
import 'device_auth_fake.dart';
import 'notifications_fakes.dart' show FakeNotificationsApi, nWire, nid, profilesFake;
import 'orders_fakes.dart' show FakeOrdersApi;
import 'reports_fakes.dart' show FakeReportsApi;
import 'rig.dart';
import 'settings_fakes.dart' show FakeAccountApi;

/// The 360 dp wide phone of the brief; every screen is also run at text scale 1.3.
Future<void> phone(WidgetTester t, {double scale = 1.0}) async {
  t.view.physicalSize = const Size(360, 780);
  t.view.devicePixelRatio = 1.0;
  t.platformDispatcher.textScaleFactorTestValue = scale;
  addTearDown(() {
    t.view.resetPhysicalSize();
    t.view.resetDevicePixelRatio();
    t.platformDispatcher.clearTextScaleFactorTestValue();
  });
}

/// Reduced motion is the app-level MediaQuery flag (MediaQuery.disableAnimations), the one LimsCard reads.
Widget _motion(Widget? child, bool reduce) => Builder(
      builder: (c) => MediaQuery(data: MediaQuery.of(c).copyWith(disableAnimations: reduce), child: child ?? const SizedBox.shrink()),
    );

MaterialApp appOf(Widget home, {bool reduceMotion = false}) =>
    MaterialApp(theme: LimsTheme.light(), builder: (_, child) => _motion(child, reduceMotion), home: home);

/// What a screen test needs to look at after [open].
class Opened {
  Opened(this.rig, {this.auth, this.notifications, this.timer});
  final Rig rig;
  final FakeAuthApi? auth;
  final FakeNotificationsApi? notifications;
  final BackgroundTimer? timer;
}

Future<void> pumpFor(WidgetTester t, Duration d) async {
  for (var left = d; left > Duration.zero; left -= const Duration(milliseconds: 50)) {
    await t.pump(const Duration(milliseconds: 50));
  }
}

/// A0 splash: E1 is still loading (lab name + spinner).
Future<Opened> openA0(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  final api = FakeAuthApi(now: () => rig.now)..configHold = Completer<void>();
  await t.pumpWidget(authScope(rig, api, child: appOf(const SignInFlow(), reduceMotion: reduceMotion)));
  await t.pump(const Duration(milliseconds: 20));
  return Opened(rig, auth: api);
}

/// A0 error state: E1 failed 3 times.
Future<Opened> openA0Error(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  final api = FakeAuthApi(now: () => rig.now)..configFail = (_) => Exception('offline');
  await t.pumpWidget(authScope(rig, api, child: appOf(const SignInFlow(), reduceMotion: reduceMotion)));
  await settle(t, seconds: 5);
  return Opened(rig, auth: api);
}

Future<Opened> openA1(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  await t.pumpWidget(appOf(UpdateRequiredScreen(storeUrl: Uri.parse('https://store.invalid/app'), openUrl: (_) async {}), reduceMotion: reduceMotion));
  await t.pump();
  return Opened(rig);
}

Future<Opened> openA2(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  final api = FakeAuthApi(now: () => rig.now);
  await t.pumpWidget(authScope(rig, api, child: appOf(const SignInFlow(), reduceMotion: reduceMotion)));
  await t.pump(); // E1 answers; the A2 card has just been built (enter motion not yet finished)
  await t.pump();
  return Opened(rig, auth: api);
}

Future<Opened> openA3(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  final o = await openA2(t, rig, reduceMotion: reduceMotion);
  await t.enterText(find.byType(TextField), '12345678');
  await t.pump();
  await t.tap(find.text('Send code'));
  await t.pump();
  await t.pump();
  return o;
}

/// A4: the real AppLockGate, locked after 6 minutes in the background; device auth fails once (lock screen with [Try again]).
Future<Opened> openA4(WidgetTester t, Rig rig, {bool reduceMotion = false, bool lockedOut = false}) async {
  var now = DateTime.utc(2026, 11, 12, 6);
  final timer = BackgroundTimer(now: () => now);
  final auth = ScriptedDeviceAuth(lockedOut ? [false, false, false] : [false]);
  // Mounted like lib/app/app.dart: in MaterialApp.builder, i.e. ABOVE the Navigator (so no Material ancestor for the lock texts).
  await t.pumpWidget(MaterialApp(
    theme: LimsTheme.light(),
    home: const Scaffold(body: Text('orders list (synthetic)')),
    builder: (_, child) => _motion(AppLockGate(timer: timer, deviceAuth: auth, onSignInRequired: () {}, child: child!), reduceMotion),
  ));
  timer.onLifecycle(AppLifecycleState.paused);
  now = now.add(const Duration(minutes: 6));
  timer.onLifecycle(AppLifecycleState.resumed);
  for (var i = 0; i < 4; i++) {
    await t.pump();
  }
  if (lockedOut) {
    for (var i = 0; i < 2; i++) {
      await t.tap(find.text('Try again'));
      await t.pump();
      await t.pump();
    }
  }
  return Opened(rig, timer: timer);
}

List<Map<String, Object?>> inbox(int unread) => [for (var i = 0; i < unread; i++) nWire(id: nid(i + 1), kind: i.isEven ? 'report_ready' : 'payment_completed')];

/// A5 home: the real router at `/`, signed in, every tab API faked (empty), `unread` notifications for the bell.
Future<Opened> openA5(WidgetTester t, Rig rig, {bool reduceMotion = false, int unread = 12}) async {
  await t.runAsync(rig.signIn);
  final notifications = FakeNotificationsApi(inbox(unread));
  final router = buildPatientRouter(session: rig.controller, updateRequired: ValueNotifier(false), storeUrl: Uri.parse('https://store.invalid/app'), openUrl: (_) async {});
  addTearDown(router.dispose);
  await t.pumpWidget(ProviderScope(
    overrides: [
      flavourProvider.overrideWithValue(alphaFlavour()),
      sessionControllerProvider.overrideWithValue(rig.controller),
      patientOrdersApiProvider.overrideWithValue(FakeOrdersApi()),
      patientReportsApiProvider.overrideWithValue(FakeReportsApi()),
      patientBookingsApiProvider.overrideWithValue(FakeBookingsApi()),
      notificationsApiProvider.overrideWithValue(notifications),
      profilesApiProvider.overrideWithValue(profilesFake()),
      externalUrlOpenerProvider.overrideWithValue((Uri _) async {}),
    ],
    child: MaterialApp.router(theme: LimsTheme.light(), builder: (_, child) => _motion(child, reduceMotion), routerConfig: router),
  ));
  for (var i = 0; i < 6; i++) {
    await t.pump(const Duration(milliseconds: 100));
  }
  return Opened(rig, notifications: notifications);
}

Future<Opened> openA20(WidgetTester t, Rig rig, {bool reduceMotion = false, int unread = 3}) async {
  final api = FakeNotificationsApi(inbox(unread));
  await t.pumpWidget(ProviderScope(
    overrides: [notificationsApiProvider.overrideWithValue(api), profilesApiProvider.overrideWithValue(profilesFake())],
    child: appOf(const NotificationsScreen(), reduceMotion: reduceMotion),
  ));
  for (var i = 0; i < 6; i++) {
    await t.pump(const Duration(milliseconds: 20));
  }
  return Opened(rig, notifications: api);
}

Future<Opened> openA23(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  await t.runAsync(rig.signIn);
  await t.pumpWidget(ProviderScope(
    overrides: [
      accountApiProvider.overrideWithValue(FakeAccountApi()),
      sessionControllerProvider.overrideWithValue(rig.controller),
      flavourProvider.overrideWithValue(alphaFlavour(tenantPrivacyUrl: 'https://legal.invalid/lab')),
      externalUrlOpenerProvider.overrideWithValue((Uri _) async {}),
    ],
    child: appOf(const SettingsScreen(), reduceMotion: reduceMotion),
  ));
  for (var i = 0; i < 4; i++) {
    await t.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    await t.pump(const Duration(milliseconds: 20));
  }
  return Opened(rig);
}

typedef Open = Future<Opened> Function(WidgetTester t, Rig rig, {bool reduceMotion});

/// The eight screens of the task. `cards`: the content sits on white 24 radius cards (A0 splash and the A4 lock surface are page-level).
final screens = <({String id, Open open, bool cards})>[
  (id: 'A0 splash', open: openA0, cards: false),
  (id: 'A0 error', open: openA0Error, cards: true),
  (id: 'A1 update required', open: openA1, cards: true),
  (id: 'A2 phone entry', open: openA2, cards: true),
  (id: 'A3 OTP entry', open: openA3, cards: true),
  // A5 home: now the My Health Now shell (features/mhn, tested in test/features/mhn); the M4 look rules no longer apply to it.
  (id: 'A20 notifications', open: openA20, cards: true),
  (id: 'A23 settings', open: openA23, cards: true),
];
