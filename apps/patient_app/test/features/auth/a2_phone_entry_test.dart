// T-A4 — 04-UI-UX A2 Phone entry; 03-APP-FLOW §2.1 screen rules 1 and 3; US-EN-01.1/.6/.7.
// LD-28 (2026-11-07, A33-5): "Privacy policy" and "Terms of use" links on first run (A2), system browser, URLs from
// platform config, optional tenant privacy URL under the lab's name. LD-140: lims_ui only, one primary button.
// Synthetic data only.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
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

  final e164 = RegExp(r'^\+[1-9][0-9]{7,14}$');

  group('layout and field rules', () {
    testWidgets('mobile number field with the default (first) prefix chip and one primary [Send code]', (tester) async {
      await bootSignIn(tester, rig, api);
      expect(find.text('Mobile number'), findsWidgets);
      expect(find.text('+999'), findsOneWidget);
      expect(find.text('Send code'), findsOneWidget);
      expect(find.byType(FilledButton), findsOneWidget, reason: 'one primary button per page (LD-140)');
    });

    testWidgets('prefixes come from E1 allowed_phone_prefixes, first = default; choosing another changes the E.164 value', (tester) async {
      api.prefixes = ['+999', '+998'];
      await bootSignIn(tester, rig, api);
      await tester.tap(find.byType(DropdownButton<String>));
      await tester.pump(const Duration(seconds: 1));
      await tester.tap(find.text('+998').last);
      await tester.pump(const Duration(seconds: 1));
      await sendCodeFor(tester, '12345678');
      expect(api.requestedPhones, ['+99812345678']);
    });

    testWidgets('text field hygiene: no suggestions, no autocorrect (REQ-SEC-111)', (tester) async {
      await bootSignIn(tester, rig, api);
      final f = tester.widget<TextField>(find.byType(TextField));
      expect(f.enableSuggestions, isFalse);
      expect(f.autocorrect, isFalse);
      expect(f.keyboardType, TextInputType.phone);
    });

    testWidgets('digits only, 15 digits in total: pasted letters and extra digits are dropped', (tester) async {
      await bootSignIn(tester, rig, api);
      await sendCodeFor(tester, '12ab34567890123456789');
      expect(api.requestedPhones, hasLength(1));
      final sent = api.requestedPhones.single;
      expect(sent, matches(e164));
      expect(sent.length, 16, reason: '"+" and 15 digits');
      expect(sent.startsWith('+999'), isTrue);
    });

    testWidgets('a too-short number never reaches the API (E.164 pattern checked client-side)', (tester) async {
      await bootSignIn(tester, rig, api);
      await sendCodeFor(tester, '1');
      expect(api.requestedPhones, isEmpty);
      expect(find.text('Send code'), findsOneWidget, reason: 'still on A2');
    });

    testWidgets('only a number that matches E.164 is sent, exactly prefix + national digits', (tester) async {
      await bootSignIn(tester, rig, api);
      await sendCodeFor(tester, '12345678');
      expect(api.requestedPhones, ['+99912345678']);
      expect(api.requestedPhones.single, matches(e164));
    });

    testWidgets('semantics: the field has the label "Mobile number"; [Send code] is a 48 dp target', (tester) async {
      final handle = tester.ensureSemantics();
      await bootSignIn(tester, rig, api);
      expect(find.bySemanticsLabel(RegExp('Mobile number')), findsWidgets);
      final button = find.ancestor(of: find.text('Send code'), matching: find.byWidgetPredicate((w) => w is ButtonStyleButton));
      expect(tester.getSize(button.first).height, greaterThanOrEqualTo(48));
      handle.dispose();
    });

    testWidgets('text scale 2.0 does not overflow', (tester) async {
      tester.platformDispatcher.textScaleFactorTestValue = 2.0;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      tester.view.physicalSize = const Size(1080, 1920);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      await bootSignIn(tester, rig, api, flavour: alphaFlavour(tenantPrivacyUrl: 'https://alpha.invalid/privacy'));
      expect(tester.takeException(), isNull);
    });
  });

  group('request flow', () {
    testWidgets('success moves to A3 (6-digit code entry)', (tester) async {
      await reachOtpScreen(tester, rig, api);
      expect(find.textContaining('Enter the 6-digit code sent to'), findsOneWidget);
      expect(find.text('Send code'), findsNothing);
    });

    testWidgets('while the request runs the button cannot fire a second request and a spinner shows', (tester) async {
      api.requestHold = Completer<void>();
      await bootSignIn(tester, rig, api);
      await tester.enterText(find.byType(TextField), '12345678');
      await tester.pump();
      await tester.tap(find.text('Send code'));
      await tester.pump();
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      final b = find.byType(FilledButton);
      if (b.evaluate().isNotEmpty) await tester.tap(b.first, warnIfMissed: false);
      await tester.pump();
      expect(api.requestedPhones, hasLength(1));
      api.requestHold!.complete();
      await settle(tester, seconds: 2);
      expect(api.requestedPhones, hasLength(1));
      expect(find.textContaining('Enter the 6-digit code sent to'), findsOneWidget);
    });
  });

  group('errors (04-UI-UX A2, 03-APP-FLOW 2.1 rule 3)', () {
    testWidgets('400 common.validation_failed at /phone_e164 -> prefix copy with the configured prefixes', (tester) async {
      api.requestFail = (_) => LimsException(LimsErrorCodes.commonValidationFailed, fieldErrors: const [
            FieldError(path: '/phone_e164', code: 'common.validation_failed', message: 'server text'),
          ]);
      await bootSignIn(tester, rig, api);
      await sendCodeFor(tester, '12345678');
      expect(find.text('This app accepts numbers starting with +999 only.'), findsOneWidget);
      expect(find.text('Send code'), findsOneWidget, reason: 'stays on A2 so the user can fix the number');
    });

    testWidgets('429 with Retry-After 600 s -> "Try again in 10 minutes."', (tester) async {
      api.requestFail = (_) => RateLimitedException(const Duration(seconds: 600));
      await bootSignIn(tester, rig, api);
      await sendCodeFor(tester, '12345678');
      expect(find.text('Too many codes requested. Try again in 10 minutes.'), findsOneWidget);
    });

    testWidgets('429 without a usable Retry-After still explains and does not crash', (tester) async {
      api.requestFail = (_) => LimsException(LimsErrorCodes.commonRateLimited);
      await bootSignIn(tester, rig, api);
      await sendCodeFor(tester, '12345678');
      expect(find.textContaining('Too many codes requested'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('403 common.feature_disabled -> "The app isn\'t available for {lab} yet."', (tester) async {
      api.requestFail = (_) => LimsException(LimsErrorCodes.commonFeatureDisabled);
      await bootSignIn(tester, rig, api);
      await sendCodeFor(tester, '12345678');
      expect(find.text("The app isn't available for Synthetic Lab Alpha yet."), findsOneWidget);
    });

    testWidgets('500: no server detail on screen, and the user can send again', (tester) async {
      api.requestFail = (c) => c == 1 ? serverError() : null;
      await bootSignIn(tester, rig, api);
      await sendCodeFor(tester, '12345678');
      expect(find.textContaining('hunter2'), findsNothing);
      expect(find.text('Send code'), findsOneWidget);
      await tester.tap(find.text('Send code'));
      await settle(tester, seconds: 2);
      expect(api.requestedPhones, hasLength(2));
      expect(find.textContaining('Enter the 6-digit code sent to'), findsOneWidget);
    });
  });

  group('consent notice (03-APP-FLOW 2.1 rule 1)', () {
    const sentence = "By continuing you agree to Synthetic Lab Alpha's app terms.";

    testWidgets('shows the notice with the flavour display name; tapping it opens the E1 consent text in a dialog', (tester) async {
      await bootSignIn(tester, rig, api);
      expect(find.text(sentence), findsOneWidget);
      await tester.tap(find.text(sentence));
      await tester.pump(const Duration(seconds: 1));
      expect(find.byType(AlertDialog), findsOneWidget);
      expect(find.text('Synthetic advice text.'), findsOneWidget);
    });
  });

  group('LD-28 legal links on first run', () {
    testWidgets('"Privacy policy" and "Terms of use" are shown and open the configured URLs in the system browser', (tester) async {
      final opened = <Uri>[];
      await bootSignIn(tester, rig, api, onOpen: opened.add);
      expect(find.text('Privacy policy'), findsOneWidget);
      expect(find.text('Terms of use'), findsOneWidget);
      await tester.tap(find.text('Privacy policy'));
      await tester.pump();
      await tester.tap(find.text('Terms of use'));
      await tester.pump();
      expect(opened, [Uri.parse('https://legal.invalid/privacy'), Uri.parse('https://legal.invalid/terms')]);
    });

    testWidgets('an optional tenant privacy URL is a second privacy link under the lab name', (tester) async {
      final opened = <Uri>[];
      await bootSignIn(tester, rig, api, flavour: alphaFlavour(tenantPrivacyUrl: 'https://alpha.invalid/privacy'), onOpen: opened.add);
      expect(find.text('Privacy policy'), findsNWidgets(2));
      await tester.tap(find.text('Privacy policy').at(0));
      await tester.pump();
      await tester.tap(find.text('Privacy policy').at(1));
      await tester.pump();
      expect(opened.toSet(), {Uri.parse('https://legal.invalid/privacy'), Uri.parse('https://alpha.invalid/privacy')});
      expect(find.text('Terms of use'), findsOneWidget);
    });

    testWidgets('without a tenant URL there is exactly one privacy link', (tester) async {
      await bootSignIn(tester, rig, api);
      expect(find.text('Privacy policy'), findsOneWidget);
    });

    testWidgets('legal links do not add a second primary button', (tester) async {
      await bootSignIn(tester, rig, api, flavour: alphaFlavour(tenantPrivacyUrl: 'https://alpha.invalid/privacy'));
      expect(find.byType(FilledButton), findsOneWidget);
    });
  });
}
