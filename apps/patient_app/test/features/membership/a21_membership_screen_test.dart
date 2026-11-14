// T-M1 — 04-UI-UX A21 Membership card; 03-APP-FLOW §10.1 (A21 row); PRD US-EN-17.3; 02-TRD §5 E47; 07-SECURITY "Membership card QR". Synthetic data only.
// A21: LimsCard (plan name, card no. monospace, "Valid {from} – {to}", status); LimsQrCode of card_token (error correction M); screen brightness raised while visible;
//      "Show this at the front desk."; PHI screen -> LimsSecureScreen; states: empty "No membership", skeleton, error + retry.
// IMPL CONTRACT (writer: match or dispute) — all under apps/patient_app/lib/features/membership/:
//   membership_api.dart        abstract interface class MembershipApi { Future<Object?> listMyMemberships(); }  returns the decoded E47 wire JSON `{data: [MembershipCard...]}`;
//                              TransportMembershipApi({required PatientTransport transport}) -> GET /v1/engagement/me/memberships (no body, no query); errors surface as LimsException.
//   membership_providers.dart  membershipApiProvider (Provider<MembershipApi>), cardBrightnessProvider (Provider<CardBrightness>);
//                              abstract interface class CardBrightness { Future<void> raise(); Future<void> restore(); }
//   membership_screen.dart     class MembershipScreen (const MembershipScreen({super.key})) — A21, a Riverpod consumer; shows one LimsCard per card in API order.
// Choices the brief left open (cite if disputed): card title = plan_display_name; the QR semantic label is "Membership QR code" (must not contain the token);
//   brightness is raised once when at least one card is shown and restored on dispose; an empty list does not touch brightness.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:patient_app/core/api/api_client_factory.dart';
import 'package:patient_app/features/membership/membership_api.dart';
import 'package:patient_app/features/membership/membership_providers.dart';
import 'package:patient_app/features/membership/membership_screen.dart';

const token = '0123456789ABCDEFGHJKMNPQRS';
const token2 = '7ABCDEFGHJKMNPQRSTVWXYZ012';

Map<String, Object?> card({String id = '01950c16-0000-7000-8000-000000000077', String profile = '01950c16-0000-7000-8000-000000000078', String plan = 'Gold plan (synthetic)',
        String no = 'MB26000001', String tok = token, String status = 'active', String from = '2026-10-01', String to = '2027-10-01'}) =>
    {'membership_id': id, 'profile_id': profile, 'plan_display_name': plan, 'card_no': no, 'card_token': tok, 'valid_from': from, 'valid_to': to, 'status': status};

class FakeMembershipApi implements MembershipApi {
  FakeMembershipApi(this.answer);
  Future<Object?> Function(int call) answer;
  int calls = 0;
  @override
  Future<Object?> listMyMemberships() => answer(++calls);
}

class FakeBrightness implements CardBrightness {
  int raised = 0, restored = 0;
  @override
  Future<void> raise() async => raised++;
  @override
  Future<void> restore() async => restored++;
}

Widget host(FakeMembershipApi api, CardBrightness b) => ProviderScope(
      overrides: [membershipApiProvider.overrideWithValue(api), cardBrightnessProvider.overrideWithValue(b)],
      child: const MaterialApp(home: MembershipScreen()),
    );

Future<void> settle(WidgetTester t) async {
  await t.pump();
  await t.pump();
  await t.pump();
}

Iterable<LimsQrCode> qrs(WidgetTester t) => t.widgetList<LimsQrCode>(find.byType(LimsQrCode));

void main() {
  late FakeBrightness brightness;
  setUp(() => brightness = FakeBrightness());

  group('states', () {
    testWidgets('loading: skeleton / spinner while the request is open, no card, no empty text', (tester) async {
      final c = Completer<Object?>();
      await tester.pumpWidget(host(FakeMembershipApi((_) => c.future), brightness));
      await tester.pump();
      expect(find.byType(LimsLoading), findsOneWidget);
      expect(find.text('No membership'), findsNothing);
      expect(find.byType(LimsQrCode), findsNothing);
      c.complete({'data': <Object?>[]});
      await settle(tester);
      expect(find.byType(LimsLoading), findsNothing);
    });

    testWidgets('empty: "No membership" (LimsEmptyState), no QR, brightness untouched', (tester) async {
      await tester.pumpWidget(host(FakeMembershipApi((_) async => {'data': <Object?>[]}), brightness));
      await settle(tester);
      expect(find.byType(LimsEmptyState), findsOneWidget);
      expect(find.text('No membership'), findsOneWidget);
      expect(find.byType(LimsQrCode), findsNothing);
      expect(brightness.raised, 0);
    });

    testWidgets('error: LimsErrorState with [Retry]; Retry asks again and then shows the card', (tester) async {
      final api = FakeMembershipApi((n) async => n == 1 ? throw LimsException('common.internal') : {'data': [card()]});
      await tester.pumpWidget(host(api, brightness));
      await settle(tester);
      expect(find.byType(LimsErrorState), findsOneWidget);
      expect(find.byType(LimsQrCode), findsNothing);
      await tester.tap(find.text('Retry'));
      await settle(tester);
      expect(api.calls, 2);
      expect(find.byType(LimsErrorState), findsNothing);
      expect(find.byType(LimsQrCode), findsOneWidget);
    });
  });

  group('the card (US-EN-17.3)', () {
    testWidgets('shows plan name, card number, validity "Valid {from} – {to}", status as a word and "Show this at the front desk."', (tester) async {
      await tester.pumpWidget(host(FakeMembershipApi((_) async => {'data': [card()]}), brightness));
      await settle(tester);
      expect(find.byType(LimsCard), findsOneWidget);
      expect(find.text('Gold plan (synthetic)'), findsOneWidget);
      expect(find.text('MB26000001'), findsOneWidget);
      final valid = find.byWidgetPredicate((w) => w is Text && RegExp(r'^Valid .*2026.* – .*2027.*$').hasMatch(w.data ?? ''));
      expect(valid, findsOneWidget);
      expect(find.textContaining(RegExp(r'^active$', caseSensitive: false)), findsOneWidget);
      expect(find.text('Show this at the front desk.'), findsOneWidget);
    });

    testWidgets('the card number is monospace (04-UI-UX A21)', (tester) async {
      await tester.pumpWidget(host(FakeMembershipApi((_) async => {'data': [card()]}), brightness));
      await settle(tester);
      final t = tester.widget<Text>(find.text('MB26000001'));
      final family = (t.style?.fontFamily ?? '') + (t.style?.fontFamilyFallback ?? const []).join();
      expect(family.toLowerCase(), anyOf(contains('mono'), contains('courier'), contains('consolas')), reason: 'use the lims_ui mono token');
    });

    testWidgets('the QR encodes ONLY the card token; the token is not printed as text and not in any semantics label', (tester) async {
      await tester.pumpWidget(host(FakeMembershipApi((_) async => {'data': [card()]}), brightness));
      await settle(tester);
      final q = qrs(tester).single;
      expect(q.data, token);
      expect(q.semanticLabel, isNotEmpty);
      expect(q.semanticLabel, isNot(contains(token)));
      expect(q.semanticLabel, isNot(contains('MB26000001')));
      expect(find.textContaining(token), findsNothing);
      final labels = tester.widgetList<Semantics>(find.byType(Semantics)).map((s) => s.properties.label ?? '').join(' ');
      expect(labels, isNot(contains(token)));
    });

    testWidgets('QR is large enough to scan (>= 200 logical px)', (tester) async {
      await tester.pumpWidget(host(FakeMembershipApi((_) async => {'data': [card()]}), brightness));
      await settle(tester);
      expect(qrs(tester).single.size, greaterThanOrEqualTo(200));
    });

    testWidgets('two cards: one LimsCard and one QR each, in API order, each QR with its own token', (tester) async {
      final api = FakeMembershipApi((_) async => {'data': [card(), card(id: '01950c16-0000-7000-8000-000000000079', plan: 'Silver plan (synthetic)', no: 'MB26000002', tok: token2)]});
      await tester.pumpWidget(host(api, brightness));
      await settle(tester);
      expect(find.byType(LimsCard), findsNWidgets(2));
      expect(qrs(tester).map((q) => q.data).toList(), [token, token2]);
      expect(tester.getTopLeft(find.text('Gold plan (synthetic)')).dy, lessThan(tester.getTopLeft(find.text('Silver plan (synthetic)')).dy));
    });

    testWidgets('a cancelled or expired card shows its status word (not colour only)', (tester) async {
      for (final s in ['cancelled', 'expired']) {
        await tester.pumpWidget(host(FakeMembershipApi((_) async => {'data': [card(status: s)]}), brightness));
        await settle(tester);
        expect(find.textContaining(RegExp('^$s\$', caseSensitive: false)), findsOneWidget, reason: s);
      }
    });

    testWidgets('only the E47 call is made: one GET on open, none on rebuild', (tester) async {
      final api = FakeMembershipApi((_) async => {'data': [card()]});
      await tester.pumpWidget(host(api, brightness));
      await settle(tester);
      await tester.pump(const Duration(seconds: 5));
      expect(api.calls, 1);
    });
  });

  group('PHI screen + brightness (REQ-SEC-109; 04-UI-UX A21)', () {
    testWidgets('the screen is wrapped in LimsSecureScreen', (tester) async {
      await tester.pumpWidget(host(FakeMembershipApi((_) async => {'data': [card()]}), brightness));
      await settle(tester);
      expect(find.byType(LimsSecureScreen), findsOneWidget);
    });

    testWidgets('brightness is raised once while a card is shown and restored when the screen goes away', (tester) async {
      await tester.pumpWidget(host(FakeMembershipApi((_) async => {'data': [card()]}), brightness));
      await settle(tester);
      expect(brightness.raised, 1);
      expect(brightness.restored, 0);
      await tester.pumpWidget(const SizedBox());
      await tester.pump();
      expect(brightness.restored, 1);
    });

    testWidgets('a failed brightness call never breaks the card (best effort)', (tester) async {
      final b = _ThrowingBrightness();
      await tester.pumpWidget(host(FakeMembershipApi((_) async => {'data': [card()]}), b));
      await settle(tester);
      expect(find.byType(LimsQrCode), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });

  group('TransportMembershipApi (E47 wire)', () {
    test('GET /v1/engagement/me/memberships, no body, no query; returns the transport answer untouched', () async {
      final seen = <List<Object?>>[];
      Future<Object?> transport(String method, String path, {Map<String, Object?>? query, Map<String, String>? headers, Object? body}) async {
        seen.add([method, path, query, body]);
        return {'data': [card()]};
      }

      final PatientTransport t = transport;
      final out = await TransportMembershipApi(transport: t).listMyMemberships();
      expect(seen, [['GET', '/v1/engagement/me/memberships', null, null]]);
      expect((out as Map)['data'], hasLength(1));
    });

    test('errors are not swallowed (LimsException passes through)', () async {
      Future<Object?> transport(String method, String path, {Map<String, Object?>? query, Map<String, String>? headers, Object? body}) async => throw LimsException('common.rate_limited');
      final PatientTransport t = transport;
      await expectLater(TransportMembershipApi(transport: t).listMyMemberships(), throwsA(isA<LimsException>()));
    });
  });
}

class _ThrowingBrightness implements CardBrightness {
  @override
  Future<void> raise() async => throw StateError('no brightness plugin');
  @override
  Future<void> restore() async => throw StateError('no brightness plugin');
}
