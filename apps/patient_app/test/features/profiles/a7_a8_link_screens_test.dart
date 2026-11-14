// T-L6 — A7 Redeem lab code (E14) and A8 Add from report message (E15). PRD US-EN-03.2-.4, US-EN-04.1-.3/.5; 03-APP-FLOW §10.1 A7/A8 row; 04-UI-UX A7/A8.
// done_when "copy and identical error text": the same words for every 422 cause on BOTH screens (no oracle: unknown / expired / wrong phone / already redeemed look alike).
// Choices the brief left open (cite if disputed):
//   - the submit button is the page's ONE FilledButton (label not pinned); it is disabled until the input is valid (A7: 10 symbols after normalisation; A8: portal-origin /r/ link).
//   - A7 field label "Code"; A8 field label "Link" (04-UI-UX tables). Fields found by type (LimsCodeField / LimsTextField), not label.
//   - A8 client check: trimmed text must start with `{flavour.portalOrigin}/r/` followed by a non-empty token; the origin must end at "/" (so "https://portal.invalid.evil.example/r/x" fails).
//   - Success: SnackBar "Profile added" and onAdded(profile_id); 201 and 200 ("already linked", E14/E15) are both success (the wire cannot tell them apart in the body).
//   - Generic failure copy: "Something went wrong. Try again." (same as A2/A3 in sign_in_flow.dart).
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:patient_app/features/auth/patient_auth_api.dart' show RateLimitedException;
import 'package:patient_app/features/profiles/link_code_screen.dart';
import 'package:patient_app/features/profiles/report_link_screen.dart';

import '../../support/profiles_fakes.dart';

const goodLink = 'https://portal.invalid/r/AbCdEf0123456789_-synthetic';

void main() {
  late FakeProfilesApi api;
  setUp(() => api = FakeProfilesApi());

  group('A7 lab code (E14)', () {
    Future<void> open(WidgetTester t, {void Function(String)? onAdded}) async {
      await t.pumpWidget(const SizedBox()); // fresh State for every open (some tests open several times)
      await t.pumpWidget(host(LinkCodeScreen(onAdded: onAdded), api));
      await settle(t);
    }

    Future<void> type(WidgetTester t, String s) async {
      await t.enterText(find.byType(TextField), s);
      await t.pump();
    }

    bool enabled(WidgetTester t) => t.widget<FilledButton>(primaryButtons()).onPressed != null;

    testWidgets('layout: LimsCodeField with the Crockford alphabet, help text, one primary button, LimsSecureScreen', (t) async {
      await open(t);
      final f = t.widget<LimsCodeField>(find.byType(LimsCodeField));
      expect(f.label, 'Code');
      expect(f.groupSize, 5);
      expect(f.groups, 2);
      expect(f.alphabet.split('').toSet(), kCrockford.split('').toSet());
      expect(find.text('Ask the front desk for an app code. It works once, on this phone number only.'), findsOneWidget);
      expect(primaryButtons(), findsOneWidget);
      expect(find.byType(LimsSecureScreen), findsOneWidget);
    });

    testWidgets('submit is disabled until 10 symbols are entered; 9 is not enough', (t) async {
      await open(t);
      expect(enabled(t), isFalse);
      await type(t, 'ABCDEFGHJ');
      expect(enabled(t), isFalse);
      await type(t, 'ABCDEFGHJK');
      expect(enabled(t), isTrue);
    });

    testWidgets('input is grouped XXXXX-XXXXX, upper-cased, spaces and dashes stripped, capped at 10 symbols', (t) async {
      await open(t);
      await type(t, 'abcde fghjk zzz');
      // LimsCodeField builds its TextField without a controller; read the EditableText's (T-L6 ruling).
      final text = t.widget<EditableText>(find.byType(EditableText)).controller.text;
      expect(text.replaceAll('-', ''), 'ABCDEFGHJK');
      expect(text.length, lessThanOrEqualTo(13));
    });

    testWidgets('O -> 0 and I/L -> 1 (Crockford, TRD §4.3); the sent code is the normalised one', (t) async {
      await open(t);
      await type(t, 'oil-abcdefg');
      await t.tap(primaryButtons());
      await settle(t);
      expect(api.redeemCodes.single.replaceAll('-', ''), '011ABCDEFG');
    });

    testWidgets('E14 is called once with the 10 normalised symbols (dash allowed), nothing else', (t) async {
      await open(t);
      await type(t, 'abcde-fghjk');
      await t.tap(primaryButtons());
      await settle(t);
      expect(api.redeemCodes, hasLength(1));
      expect(api.redeemCodes.single.replaceAll('-', ''), 'ABCDEFGHJK');
      expect(api.redeemCodes.single, matches(RegExp(r'^[0-9A-Za-z -]{10,13}$')), reason: 'E14 schema: 10-13 chars');
    });

    testWidgets('success (201): toast "Profile added" + onAdded(profile_id); in flight a spinner shows and a double tap sends one request', (t) async {
      final gate = Completer<Object?>();
      api.onRedeemCode = (_) => gate.future;
      String? added;
      await open(t, onAdded: (id) => added = id);
      await type(t, 'ABCDEFGHJK');
      await t.tap(primaryButtons());
      await t.tap(primaryButtons(), warnIfMissed: false);
      await t.pump();
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(api.redeemCodes, hasLength(1));
      gate.complete(profile(id: newProfileId));
      await settle(t);
      expect(find.text('Profile added'), findsOneWidget);
      expect(added, newProfileId);
      expect(find.byType(CircularProgressIndicator), findsNothing);
    });

    testWidgets('success (200 already linked) is the same as 201', (t) async {
      api.onRedeemCode = (_) async => profile(id: pidSelf);
      String? added;
      await open(t, onAdded: (id) => added = id);
      await type(t, 'ABCDEFGHJK');
      await t.tap(primaryButtons());
      await settle(t);
      expect(added, pidSelf);
    });

    group('error copy (03-APP-FLOW §10.1 A7/A8)', () {
      Future<void> submitWith(WidgetTester t, Object error) async {
        api.onRedeemCode = (_) async => throw error;
        await open(t);
        await type(t, 'ABCDEFGHJK');
        await t.tap(primaryButtons());
        await settle(t);
      }

      testWidgets('422 engagement.link_code_invalid -> the one sentence, with an icon', (t) async {
        await submitWith(t, invalidCode());
        expect(find.text(copyInvalid), findsOneWidget);
        expect(find.byIcon(kErrIcon), findsWidgets);
      });

      testWidgets('identical text whatever the server detail says (unknown / expired / wrong phone / redeemed)', (t) async {
        final seen = <String>{};
        for (final d in [null, 'expired', 'wrong phone', 'already redeemed', 'engagement.link_code_expired']) {
          await submitWith(t, invalidCode(detail: d));
          final texts = t.widgetList<Text>(find.byType(Text)).map((x) => x.data ?? '').where((s) => s.contains("didn't work")).toSet();
          expect(texts, {copyInvalid}, reason: 'detail=$d');
          seen.addAll(texts);
          for (final leak in ['expired', 'wrong phone', 'redeemed']) {
            expect(find.textContaining(leak), findsNothing, reason: 'detail=$d leaks "$leak"');
          }
        }
        expect(seen, {copyInvalid});
      });

      testWidgets('429 (LimsException or RateLimitedException with any Retry-After) -> "Too many tries. Try again in an hour."', (t) async {
        for (final e in [LimsException(LimsErrorCodes.commonRateLimited), RateLimitedException(const Duration(seconds: 5)), RateLimitedException()]) {
          await submitWith(t, e);
          expect(find.text(copyTooMany), findsOneWidget, reason: '$e');
          expect(find.textContaining('5 seconds'), findsNothing);
        }
      });

      testWidgets('409 engagement.link_limit_reached -> "You have the maximum number of profiles."', (t) async {
        await submitWith(t, LimsException(LimsErrorCodes.engagementLinkLimitReached));
        expect(find.text(copyLimit), findsOneWidget);
      });

      testWidgets('any other failure -> generic words, no code, no stack text; the field keeps the code so the user can fix it', (t) async {
        await submitWith(t, LimsException('common.internal', safeDetail: 'db exploded'));
        expect(find.text('Something went wrong. Try again.'), findsOneWidget);
        expect(find.textContaining('common.internal'), findsNothing);
        expect(find.textContaining('db exploded'), findsNothing);
        expect(find.byType(LimsCodeField), findsOneWidget);
      });

      testWidgets('the error clears when the user edits the code, and a second try can succeed', (t) async {
        var n = 0;
        api.onRedeemCode = (_) async => ++n == 1 ? throw invalidCode() : profile(id: newProfileId);
        await open(t);
        await type(t, 'ABCDEFGHJK');
        await t.tap(primaryButtons());
        await settle(t);
        expect(find.text(copyInvalid), findsOneWidget);
        await type(t, 'ABCDEFGHJM');
        expect(find.text(copyInvalid), findsNothing);
        await t.tap(primaryButtons());
        await settle(t);
        expect(find.text('Profile added'), findsOneWidget);
        expect(api.redeemCodes, hasLength(2));
      });

      testWidgets('the entered code is never echoed back in the error text', (t) async {
        await submitWith(t, invalidCode());
        final msgs = t.widgetList<Text>(find.byType(Text)).map((x) => x.data ?? '').where((s) => s.contains("didn't work"));
        for (final m in msgs) {
          expect(m, isNot(contains('ABCDE')));
        }
      });
    });
  });

  group('A8 report message (E15)', () {
    Future<void> open(WidgetTester t, {void Function(String)? onAdded}) async {
      await t.pumpWidget(const SizedBox());
      await t.pumpWidget(host(ReportLinkScreen(onAdded: onAdded), api));
      await settle(t);
    }

    Future<void> paste(WidgetTester t, String s) async {
      await t.enterText(find.byType(TextField), s);
      await t.pump();
    }

    LimsTextField field(WidgetTester t) => t.widget<LimsTextField>(find.byType(LimsTextField));
    bool enabled(WidgetTester t) => t.widget<FilledButton>(primaryButtons()).onPressed != null;

    testWidgets('layout: LimsTextField max 2000 (multiline is not offered by LimsTextField today), explanatory text from 04-UI-UX A8, one primary button, LimsSecureScreen', (t) async {
      await open(t);
      expect(field(t).maxLength, 2000);
      expect(find.text("Paste the report link from the SMS or WhatsApp message the lab sent to this phone. You'll see reports from that one onwards. For older reports, ask the lab for an app code."), findsOneWidget);
      expect(primaryButtons(), findsOneWidget);
      expect(find.byType(LimsSecureScreen), findsOneWidget);    });

    testWidgets('a portal /r/ link of this environment: E15 {link_url} once; toast "Profile added"; onAdded(profile_id)', (t) async {
      String? added;
      await open(t, onAdded: (id) => added = id);
      await paste(t, goodLink);
      expect(enabled(t), isTrue);
      await t.tap(primaryButtons());
      await settle(t);
      expect(api.redeemUrls, [goodLink]);
      expect(find.text('Profile added'), findsOneWidget);
      expect(added, newProfileId);
    });

    testWidgets('surrounding whitespace / newlines from a paste are trimmed before sending', (t) async {
      await open(t);
      await paste(t, '  \n$goodLink\n ');
      await t.tap(primaryButtons());
      await settle(t);
      expect(api.redeemUrls, [goodLink]);
    });

    for (final bad in <String, String>{
      'empty': '',
      'other origin': 'https://evil.invalid/r/abc',
      'origin as a prefix of a longer host': 'https://portal.invalid.evil.example/r/abc',
      'origin as userinfo': 'https://portal.invalid@evil.example/r/abc',
      'http instead of https': 'http://portal.invalid/r/abc',
      'wrong path': 'https://portal.invalid/x/r/abc',
      'path without token': 'https://portal.invalid/r/',
      'not a link': 'hello there',
      'a report number': 'RPT-000123',
    }.entries) {
      testWidgets('rejected on the phone, no API call (US-EN-04.5): ${bad.key}', (t) async {
        await open(t);
        await paste(t, bad.value);
        await t.tap(primaryButtons(), warnIfMissed: false);
        await settle(t);
        expect(api.redeemUrls, isEmpty);
        expect(enabled(t), isFalse);
      });
    }

    testWidgets('a wrong link shows an inline message in words (not just a disabled button)', (t) async {
      await open(t);
      await paste(t, 'https://evil.invalid/r/abc');
      expect(field(t).errorText, isNotNull);
      expect(field(t).errorText, isNotEmpty);
      expect(find.textContaining('evil.invalid'), findsOneWidget, reason: 'only the field itself shows what was pasted');
    });

    group('error copy: identical to A7 (03-APP-FLOW §10.1)', () {
      Future<void> submitWith(WidgetTester t, Object error) async {
        api.onRedeemReport = (_) async => throw error;
        await open(t);
        await paste(t, goodLink);
        await t.tap(primaryButtons());
        await settle(t);
      }

      testWidgets('422 engagement.link_code_invalid -> the very same sentence as A7 (expired / revoked / other phone all alike)', (t) async {
        for (final d in [null, 'expired', 'revoked', 'reporting.link_invalid']) {
          await submitWith(t, invalidCode(detail: d));
          expect(find.text(copyInvalid), findsOneWidget, reason: 'detail=$d');
          for (final leak in ['expired', 'revoked', 'reporting.']) {
            expect(find.textContaining(leak), findsNothing, reason: 'detail=$d leaks "$leak"');
          }
        }
      });

      testWidgets('429 and 409 use the same copy as A7', (t) async {
        await submitWith(t, LimsException(LimsErrorCodes.commonRateLimited));
        expect(find.text(copyTooMany), findsOneWidget);
        await submitWith(t, LimsException(LimsErrorCodes.engagementLinkLimitReached));
        expect(find.text(copyLimit), findsOneWidget);
      });

      testWidgets('400 common.validation_failed (server re-check) -> the invalid-link sentence, not a code', (t) async {
        await submitWith(t, LimsException('common.validation_failed'));
        expect(find.text(copyInvalid), findsOneWidget);
        expect(find.textContaining('validation_failed'), findsNothing);
      });

      testWidgets('the pasted link (a secret token) is never repeated in an error message or a toast', (t) async {
        await submitWith(t, invalidCode());
        final texts = t.widgetList<Text>(find.byType(Text)).map((x) => x.data ?? '');
        final inField = t.widget<EditableText>(find.byType(EditableText)).controller.text;
        expect(inField, goodLink);
        expect(texts.where((s) => s.contains('AbCdEf0123456789')), isEmpty);
      });

      testWidgets('generic failure words; double tap in flight sends one request', (t) async {
        final gate = Completer<Object?>();
        api.onRedeemReport = (_) => gate.future;
        await open(t);
        await paste(t, goodLink);
        await t.tap(primaryButtons());
        await t.tap(primaryButtons(), warnIfMissed: false);
        await t.pump();
        expect(find.byType(CircularProgressIndicator), findsOneWidget);
        expect(api.redeemUrls, hasLength(1));
        gate.completeError(LimsException('common.internal'));
        await settle(t);
        expect(find.text('Something went wrong. Try again.'), findsOneWidget);
      });
    });
  });
}
