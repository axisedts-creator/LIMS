// T-A4 test support: fake engagement pre-auth API (E1/E2/E3 wire bodies as plain JSON maps, like T-A1's resolve fake),
// flavour fixtures and pump helpers. Synthetic data only (tenant "Synthetic Lab Alpha", phone prefix +999).
//
// IMPL CONTRACT these tests assume (writer: match it or dispute in .orchestra/notes):
//   lib/features/auth/patient_auth_api.dart
//     abstract interface class PatientAuthApi { getAppConfig() E1; requestOtp({phoneE164}) E2; verifyOtp({challengeToken, code}) E3 }
//       each returns the decoded JSON body (Object?) exactly as in contracts/openapi/engagement.yaml and throws LimsException.
//     class RateLimitedException extends LimsException { RateLimitedException(Duration retryAfter) } (code common.rate_limited)
//   lib/features/auth/auth_providers.dart
//     patientAuthApiProvider (Provider<PatientAuthApi>), externalUrlOpenerProvider (Provider<Future<void> Function(Uri)>, system browser)
//   lib/features/auth/sign_in_flow.dart  SignInFlow: A0 -> A2 -> A3 in one widget, mounted at kSignInPath by the router.
//   lib/app/flavour.dart  Flavour gains optional String? privacyUrl, termsUrl, tenantPrivacyUrl (LD-28).
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:patient_app/app/app_lock_gate.dart';
import 'package:patient_app/app/flavour.dart';
import 'package:patient_app/core/lifecycle/background_timer.dart';
import 'package:patient_app/app/providers.dart';
import 'package:patient_app/features/auth/auth_providers.dart';
import 'package:patient_app/features/auth/patient_auth_api.dart';
import 'package:patient_app/features/auth/sign_in_flow.dart';

import 'rig.dart';

Flavour alphaFlavour({String? tenantPrivacyUrl, String? privacyUrl = 'https://legal.invalid/privacy', String? termsUrl = 'https://legal.invalid/terms'}) =>
    Flavour(
      env: 'dev',
      tenantCode: 'syn_alpha',
      displayName: 'Synthetic Lab Alpha',
      apiBaseUrl: 'https://api.invalid',
      portalOrigin: 'https://portal.invalid',
      storeUrl: 'https://store.invalid/app',
      privacyUrl: privacyUrl,
      termsUrl: termsUrl,
      tenantPrivacyUrl: tenantPrivacyUrl,
    );

class FakeAuthApi implements PatientAuthApi {
  FakeAuthApi({this.prefixes = const ['+999'], required this.now});

  List<String> prefixes;
  final DateTime Function() now;

  int configCalls = 0;
  final List<String> requestedPhones = [];
  final List<({String challengeToken, String code})> verifyCalls = [];

  Object? Function(int call)? configFail;
  Object? Function(int call)? requestFail;
  Object? Function(int call)? verifyFail;
  Completer<void>? configHold;
  Completer<void>? requestHold;
  Completer<void>? verifyHold;
  int resendAfterSeconds = 45;

  /// Tokens the fake hands out: challenge n -> tok('Cn'), session n -> tok('Vn'), JWT n -> jwt(100 + n).
  String challengeToken(int n) => tok('C$n');
  String sessionToken(int n) => tok('V$n');
  String accessToken(int n) => jwt(100 + n);

  @override
  Future<Object?> getAppConfig() async {
    final call = ++configCalls;
    if (configHold != null) await configHold!.future;
    final f = configFail?.call(call);
    if (f != null) throw f;
    return <String, Object?>{
      'features': {'app': true, 'bookings': false, 'home_collection': false, 'payments': false, 'membership': false, 'enquiries': false, 'smart_report': false},
      'min_app_version': {'android': '1.0.0', 'ios': '1.0.0'},
      'consent': {'text_version': '2026-01', 'text': 'Synthetic advice text.'},
      'gateways': <String>[],
      'allowed_phone_prefixes': prefixes,
      'calendar_display': 'AD',
      'timezone': 'Asia/Kathmandu',
      'order_poll_seconds': 30,
    };
  }

  @override
  Future<Object?> requestOtp({required String phoneE164}) async {
    requestedPhones.add(phoneE164);
    final call = requestedPhones.length;
    if (requestHold != null) await requestHold!.future;
    final f = requestFail?.call(call);
    if (f != null) throw f;
    return <String, Object?>{
      'challenge_token': challengeToken(call),
      'expires_at': now().add(const Duration(minutes: 5)).toUtc().toIso8601String(),
      'resend_after_seconds': resendAfterSeconds,
      'code_length': 6,
    };
  }

  @override
  Future<Object?> verifyOtp({required String challengeToken, required String code}) async {
    verifyCalls.add((challengeToken: challengeToken, code: code));
    final call = verifyCalls.length;
    if (verifyHold != null) await verifyHold!.future;
    final f = verifyFail?.call(call);
    if (f != null) throw f;
    final exp = now().add(const Duration(hours: 1)).toUtc().toIso8601String();
    return <String, Object?>{
      'session_token': sessionToken(call),
      'access_token': accessToken(call),
      'access_expires_at': exp,
      'session_expires_at': now().add(const Duration(days: 30)).toUtc().toIso8601String(),
      'account': {
        'id': '01950c16-0000-7000-8000-000000000002',
        'phone_masked': '+99X•••••78',
        'status': 'active',
        'reminders_opt_out': false,
        'last_login_at': exp,
        'created_at': exp,
        'version': 1,
      },
    };
  }
}

LimsException wrongCode() => LimsException(LimsErrorCodes.authOtpInvalid);
LimsException exhausted() => LimsException(LimsErrorCodes.authOtpAttemptsExhausted);
LimsException serverError() => LimsException(LimsErrorCodes.commonInternal, safeDetail: 'db password hunter2');

/// ProviderScope with every provider the auth screens read overridden (device auth / background timer only when given).
Widget authScope(
  Rig rig,
  FakeAuthApi api, {
  required Widget child,
  Flavour? flavour,
  void Function(Uri)? onOpen,
  DeviceAuth? deviceAuth,
  BackgroundTimer? timer,
}) =>
    ProviderScope(
      overrides: [
        flavourProvider.overrideWithValue(flavour ?? alphaFlavour()),
        sessionControllerProvider.overrideWithValue(rig.controller),
        patientAuthApiProvider.overrideWithValue(api),
        externalUrlOpenerProvider.overrideWithValue((Uri u) async => onOpen?.call(u)),
        if (deviceAuth != null) deviceAuthProvider.overrideWithValue(deviceAuth),
        if (timer != null) backgroundTimerProvider.overrideWithValue(timer),
      ],
      child: child,
    );

Widget signInHost(Rig rig, FakeAuthApi api, {Flavour? flavour, void Function(Uri)? onOpen}) => authScope(
      rig,
      api,
      flavour: flavour,
      onOpen: onOpen,
      child: MaterialApp(theme: LimsTheme.light(), home: const SignInFlow()),
    );

/// Advances fake time in 1 s steps (never pumpAndSettle: spinners and the resend countdown never "settle").
Future<void> settle(WidgetTester tester, {int seconds = 20}) async {
  for (var i = 0; i < seconds; i++) {
    await tester.pump(const Duration(seconds: 1));
  }
}

/// Boots the sign-in flow and waits until A2 (or the A0 error) is on screen.
Future<void> bootSignIn(WidgetTester tester, Rig rig, FakeAuthApi api, {Flavour? flavour, void Function(Uri)? onOpen}) async {
  await tester.pumpWidget(signInHost(rig, api, flavour: flavour, onOpen: onOpen));
  await settle(tester, seconds: 3);
}

/// A2: national digits into the phone field, then [Send code].
Future<void> sendCodeFor(WidgetTester tester, String nationalDigits) async {
  await tester.enterText(find.byType(TextField), nationalDigits);
  await tester.pump();
  await tester.tap(find.text('Send code'));
  await settle(tester, seconds: 2);
}

/// Boots, enters `12345678` (phone +99912345678) and lands on A3.
Future<void> reachOtpScreen(WidgetTester tester, Rig rig, FakeAuthApi api, {Flavour? flavour}) async {
  await bootSignIn(tester, rig, api, flavour: flavour);
  await sendCodeFor(tester, '12345678');
}

Future<void> typeCode(WidgetTester tester, String code) async {
  await tester.enterText(find.byType(TextField), code);
  await settle(tester, seconds: 2);
}

/// Drives lifecycle through the transitions Flutter accepts in debug mode.
Future<void> goBackground(WidgetTester tester) async {
  for (final s in [AppLifecycleState.inactive, AppLifecycleState.hidden, AppLifecycleState.paused]) {
    tester.binding.handleAppLifecycleStateChanged(s);
  }
  await tester.pump();
}

Future<void> comeForeground(WidgetTester tester) async {
  for (final s in [AppLifecycleState.hidden, AppLifecycleState.inactive, AppLifecycleState.resumed]) {
    tester.binding.handleAppLifecycleStateChanged(s);
  }
  await tester.pump();
  await tester.pump();
}
