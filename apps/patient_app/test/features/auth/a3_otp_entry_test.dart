// T-A4 — 04-UI-UX A3 OTP entry; 03-APP-FLOW §2.1 rules 2 and 4; US-EN-01.3/.4/.5/.6, US-EN-02.1. Synthetic data only.
// Resend countdown: driven by one-second timer ticks (not the wall clock), so tester.pump(Duration) advances it.
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:patient_app/core/session/session_controller.dart';
import 'package:patient_app/core/session/session_store.dart';
import 'package:patient_app/features/auth/patient_auth_api.dart';

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

  const phone = '+99912345678';

  group('layout (A3)', () {
    testWidgets('prompt shows a MASKED number, never the full one', (tester) async {
      await reachOtpScreen(tester, rig, api);
      final prompt = find.byWidgetPredicate((w) => w is Text && (w.data ?? '').startsWith('Enter the 6-digit code sent to'));
      expect(prompt, findsOneWidget);
      final text = tester.widget<Text>(prompt).data!;
      expect(text, endsWith('.'));
      expect(text, contains('78'), reason: 'last digits identify the number');
      expect(text, isNot(contains(phone)));
      expect(text, isNot(contains('123456')), reason: 'middle digits are masked');
      // 07-SECURITY.md:179 / 02-TRD.md:407: prefix + exactly five bullets + last 2 digits (never reveals the length).
      expect(RegExp(r'\+\d+•{5}78\.$').hasMatch(text), isTrue, reason: 'masked form is prefix•••••NN, got: $text');
      expect(find.textContaining(phone), findsNothing);
    });

    testWidgets('one semantic text field: digits only, oneTimeCode autofill, no suggestions, numeric keypad, max 6', (tester) async {
      await reachOtpScreen(tester, rig, api);
      expect(find.byType(TextField), findsOneWidget);
      final f = tester.widget<TextField>(find.byType(TextField));
      expect(f.autofillHints, [AutofillHints.oneTimeCode]);
      expect(f.enableSuggestions, isFalse);
      expect(f.autocorrect, isFalse);
      expect(f.keyboardType, TextInputType.number);
      await tester.enterText(find.byType(TextField), '12ab34');
      await tester.pump();
      expect(find.text('1234'), findsOneWidget, reason: 'letters filtered');
      await tester.enterText(find.byType(TextField), '');
      await tester.pump();
      await tester.enterText(find.byType(TextField), '12345');
      await tester.pump();
      expect(api.verifyCalls, isEmpty, reason: '5 digits do not submit');
    });

    testWidgets('actions: [Resend code] with countdown, [Change number]; at most one primary button', (tester) async {
      await reachOtpScreen(tester, rig, api);
      expect(find.text('Resend in 0:43'), findsOneWidget); // 2 s of fake time pumped by sendCodeFor/settle after the E2 202
      expect(find.text('Change number'), findsOneWidget);
      expect(find.byType(FilledButton).evaluate().length, lessThanOrEqualTo(1));
    });

    testWidgets('text scale 2.0 does not overflow', (tester) async {
      tester.platformDispatcher.textScaleFactorTestValue = 2.0;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      await reachOtpScreen(tester, rig, api);
      expect(tester.takeException(), isNull);
    });
  });

  group('verify (US-EN-01.3)', () {
    testWidgets('the 6th digit submits once, with the challenge token from E2 and the code', (tester) async {
      await reachOtpScreen(tester, rig, api);
      await typeCode(tester, '123456');
      expect(api.verifyCalls, [(challengeToken: api.challengeToken(1), code: '123456')]);
    });

    testWidgets('success: session token only in secure storage, JWT only in memory, nothing else persisted (US-EN-02.1)', (tester) async {
      await reachOtpScreen(tester, rig, api);
      await typeCode(tester, '123456');
      expect(rig.controller.status.value, SessionStatus.signedIn);
      expect(rig.controller.accessToken, api.accessToken(1));
      expect(await rig.store.read(), api.sessionToken(1));
      final dump = await rig.storage.readAll();
      expect(dump.keys, {SessionStore.key}, reason: 'the session token is the only persisted value');
      for (final secret in [api.accessToken(1), phone, '12345678', '123456', api.challengeToken(1)]) {
        expect(dump.values.any((v) => v.contains(secret)), isFalse, reason: 'storage must not hold $secret');
      }
    });

    testWidgets('nothing sensitive is logged during the whole sign-in (02-CV 9.2)', (tester) async {
      final logs = <String>[];
      final old = debugPrint;
      debugPrint = (m, {wrapWidth}) => logs.add(m ?? '');
      try {
        await reachOtpScreen(tester, rig, api);
        await typeCode(tester, '123456');
      } finally {
        debugPrint = old;
      }
      final all = logs.join('\n');
      for (final secret in [api.accessToken(1), api.sessionToken(1), api.challengeToken(1), '12345678', '123456']) {
        expect(all, isNot(contains(secret)));
      }
    });

    testWidgets('while verify runs further input does not submit a second request', (tester) async {
      api.verifyHold = Completer<void>();
      await reachOtpScreen(tester, rig, api);
      await typeCode(tester, '123456');
      await tester.enterText(find.byType(TextField), '654321');
      await tester.pump();
      expect(api.verifyCalls, hasLength(1));
      api.verifyHold!.complete();
      await settle(tester, seconds: 2);
      expect(api.verifyCalls, hasLength(1));
    });
  });

  group('errors', () {
    testWidgets('auth.otp_invalid (wrong or expired, US-EN-01.5): fixed copy, stays on A3, a new code can be tried', (tester) async {
      api.verifyFail = (c) => c == 1 ? wrongCode() : null;
      await reachOtpScreen(tester, rig, api);
      await typeCode(tester, '123456');
      expect(find.text('That code is wrong or has expired.'), findsOneWidget);
      expect(find.text('Change number'), findsOneWidget);
      expect(rig.controller.status.value, SessionStatus.signedOut);
      await typeCode(tester, '654321');
      expect(api.verifyCalls.map((c) => c.code), ['123456', '654321']);
      expect(rig.controller.status.value, SessionStatus.signedIn);
    });

    testWidgets('auth.otp_attempts_exhausted (US-EN-01.4): back to A2 with "Too many attempts. Request a new code."', (tester) async {
      api.verifyFail = (_) => exhausted();
      await reachOtpScreen(tester, rig, api);
      await typeCode(tester, '123456');
      expect(find.text('Too many attempts. Request a new code.'), findsOneWidget);
      expect(find.text('Send code'), findsOneWidget);
      expect(find.textContaining('Enter the 6-digit code'), findsNothing);
      expect(rig.controller.status.value, SessionStatus.signedOut);
      expect(await rig.storage.readAll(), isEmpty);
    });

    testWidgets('after exhaustion a new request starts a NEW challenge; the old token is never used again', (tester) async {
      api.verifyFail = (c) => c == 1 ? exhausted() : null;
      await reachOtpScreen(tester, rig, api);
      await typeCode(tester, '123456');
      await sendCodeFor(tester, '12345678');
      await typeCode(tester, '123456');
      expect(api.requestedPhones, hasLength(2));
      expect(api.verifyCalls.map((c) => c.challengeToken), [api.challengeToken(1), api.challengeToken(2)]);
      expect(rig.controller.status.value, SessionStatus.signedIn);
    });

    testWidgets('500 from the server (C2 port error): no detail shown, the same code can be retried (03-APP-FLOW 2.1 rule 4)', (tester) async {
      api.verifyFail = (c) => c == 1 ? serverError() : null;
      await reachOtpScreen(tester, rig, api);
      await typeCode(tester, '123456');
      expect(find.textContaining('hunter2'), findsNothing);
      expect(find.textContaining('Enter the 6-digit code sent to'), findsOneWidget);
      await tester.enterText(find.byType(TextField), '');
      await tester.pump();
      await typeCode(tester, '123456');
      expect(api.verifyCalls.map((c) => c.code), ['123456', '123456']);
      expect(api.verifyCalls.map((c) => c.challengeToken).toSet(), {api.challengeToken(1)});
      expect(rig.controller.status.value, SessionStatus.signedIn);
    });
  });

  group('resend and change number', () {
    testWidgets('[Resend code] is disabled with a ticking countdown, enabled at 0 (resend_after_seconds)', (tester) async {
      await reachOtpScreen(tester, rig, api);
      expect(find.text('Resend in 0:43'), findsOneWidget);
      await tester.tap(find.text('Resend in 0:43'), warnIfMissed: false);
      await tester.pump();
      expect(api.requestedPhones, hasLength(1), reason: 'disabled while counting down');
      await tester.pump(const Duration(seconds: 40));
      expect(find.text('Resend in 0:03'), findsOneWidget);
      await tester.pump(const Duration(seconds: 3));
      expect(find.textContaining('Resend in'), findsNothing);
      expect(find.text('Resend code'), findsOneWidget);
    });

    testWidgets('resend requests a new challenge for the same phone and the next verify uses the new token', (tester) async {
      await reachOtpScreen(tester, rig, api);
      await tester.pump(const Duration(seconds: 45));
      await tester.tap(find.text('Resend code'));
      await settle(tester, seconds: 1);
      expect(api.requestedPhones, [phone, phone]);
      expect(find.text('Resend in 0:44'), findsOneWidget, reason: 'countdown restarts (1 s settled after the 202)');
      await typeCode(tester, '123456');
      expect(api.verifyCalls.single.challengeToken, api.challengeToken(2));
    });

    testWidgets('429 on resend shows the minutes from Retry-After', (tester) async {
      api.requestFail = (c) => c == 2 ? RateLimitedException(const Duration(seconds: 600)) : null;
      await reachOtpScreen(tester, rig, api);
      await tester.pump(const Duration(seconds: 45));
      await tester.tap(find.text('Resend code'));
      await settle(tester, seconds: 1);
      expect(find.text('Too many codes requested. Try again in 10 minutes.'), findsOneWidget);
    });

    testWidgets('[Change number] returns to A2; the next code is requested for the new number with a new challenge', (tester) async {
      await reachOtpScreen(tester, rig, api);
      await tester.tap(find.text('Change number'));
      await settle(tester, seconds: 1);
      expect(find.text('Send code'), findsOneWidget);
      await sendCodeFor(tester, '87654321');
      expect(api.requestedPhones, [phone, '+99987654321']);
      await typeCode(tester, '123456');
      expect(api.verifyCalls.single.challengeToken, api.challengeToken(2));
    });

    testWidgets('leaving A3 stops the countdown timer (no pending timers after the screen is gone)', (tester) async {
      await reachOtpScreen(tester, rig, api);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 60));
      expect(tester.takeException(), isNull);
    });
  });

  test('RateLimitedException is a LimsException with code common.rate_limited and the Retry-After value', () {
    final e = RateLimitedException(const Duration(minutes: 3));
    expect(e, isA<LimsException>());
    expect(e.code, LimsErrorCodes.commonRateLimited);
    expect(e.retryAfter, const Duration(minutes: 3));
  });
}
