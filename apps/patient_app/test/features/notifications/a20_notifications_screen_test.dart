// T-P5 — 04-UI-UX A20 Notifications; 03-APP-FLOW §10.1 (A20 row: "You're all caught up", skeleton, error, list); PRD US-EN-11.1 (rows render from local message keys, no text on the wire)
// and US-EN-11.2 (no push: the inbox refreshes on launch, resume and pull-to-refresh); 02-TRD §4.9 (keys patient_app.notification.<kind>, profile display name from the app's own profile list);
// 07-SECURITY §6.5 (bulk mark with foreign ids -> per-id not_found, not an error). Synthetic data only.
// Message keys (04-UI-UX A20), {profile} = display name of the row's profile_id from E13:
//   report_ready "A new report is ready for {profile}" | sample_recollection "The lab needs a new sample for {profile}" | booking_confirmed "Booking {booking_no} confirmed" |
//   booking_cancelled "Booking {booking_no} cancelled" | booking_reminder "Reminder: booking {booking_no} soon" | payment_completed "Payment received" |
//   follow_up_reminder "Time for a follow-up test for {profile}" | enquiry_reply "The lab replied to your message" | profile_paused "Access to a profile is paused".
// {booking_no} comes from the app's own booking data fetched on tap, NEVER from the row: the list therefore renders the booking kinds WITHOUT a number (the number part is optional
//   in the patterns below, but nothing that looks like one may be taken from the wire).
// Choices the brief left open (cite if disputed): button label "Mark all read" (04-UI-UX); unknown profile -> the key text without the profile (no "{profile}", no "null");
//   an unknown future `kind` renders a generic row and never crashes; the Mark-all-read button is shown only when at least one visible row is unread.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:patient_app/features/notifications/notifications_providers.dart';
import 'package:patient_app/features/notifications/notifications_screen.dart';

import '../../support/notifications_fakes.dart';
import '../../support/profiles_fakes.dart' show FakeProfilesApi;

Widget screen(FakeNotificationsApi api, {FakeProfilesApi? profiles, void Function(NotificationItem)? onOpen}) =>
    hostWith(NotificationsScreen(onOpen: onOpen), api, profiles: profiles);

Iterable<String> allText(WidgetTester t) => t.widgetList<Text>(find.byType(Text)).map((w) => w.data ?? w.textSpan?.toPlainText() ?? '');

void main() {
  group('states (03-APP-FLOW §10.1)', () {
    testWidgets('loading: skeleton / spinner while E45 is open; no list, no empty text', (tester) async {
      final c = Completer<void>();
      final api = FakeNotificationsApi([nWire(id: nid(1))])..hold = c.future;
      await tester.pumpWidget(screen(api));
      await tester.pump();
      expect(find.byType(LimsLoading), findsOneWidget);
      expect(find.text("You're all caught up"), findsNothing);
      c.complete();
      await settle(tester);
      expect(find.byType(LimsLoading), findsNothing);
    });

    testWidgets('empty: "You\'re all caught up" (LimsEmptyState) and no Mark all read', (tester) async {
      await tester.pumpWidget(screen(FakeNotificationsApi([])));
      await settle(tester);
      expect(find.byType(LimsEmptyState), findsOneWidget);
      expect(find.text("You're all caught up"), findsOneWidget);
      expect(find.text('Mark all read'), findsNothing);
    });

    testWidgets('error: LimsErrorState with [Retry]; Retry asks again and shows the list', (tester) async {
      final api = FakeNotificationsApi([nWire(id: nid(1))])..onListOverride = (n) async => n == 1 ? throw LimsException('common.internal') : pageOf([nWire(id: nid(1))]);
      await tester.pumpWidget(screen(api));
      await settle(tester);
      expect(find.byType(LimsErrorState), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
      await tester.tap(find.text('Retry'));
      await settle(tester);
      expect(api.listCalls, 2);
      expect(find.byType(LimsErrorState), findsNothing);
      expect(find.text('A new report is ready for Asha Test (synthetic)'), findsOneWidget);
    });

    testWidgets('a malformed answer (no data list) is the error state, not a crash', (tester) async {
      final api = FakeNotificationsApi([])..onListOverride = (_) async => {'oops': true};
      await tester.pumpWidget(screen(api));
      await settle(tester);
      expect(find.byType(LimsErrorState), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('A20 is built on lims_ui (LimsScaffold) with a title', (tester) async {
      await tester.pumpWidget(screen(FakeNotificationsApi([nWire(id: nid(1))])));
      await settle(tester);
      expect(find.byType(LimsScaffold), findsOneWidget);
      expect(find.text('Notifications'), findsWidgets);
    });
  });

  group('rendering per kind (US-EN-11.1: text comes from local message keys)', () {
    final profileKinds = <String, String>{
      'report_ready': 'A new report is ready for Asha Test (synthetic)',
      'sample_recollection': 'The lab needs a new sample for Asha Test (synthetic)',
      'follow_up_reminder': 'Time for a follow-up test for Asha Test (synthetic)',
    };
    for (final e in profileKinds.entries) {
      testWidgets('${e.key}: "${e.value}"', (tester) async {
        await tester.pumpWidget(screen(FakeNotificationsApi([nWire(id: nid(1), kind: e.key, entityId: eid(1))])));
        await settle(tester);
        expect(find.text(e.value), findsOneWidget);
      });
    }

    final fixed = <String, String>{
      'payment_completed': 'Payment received',
      'enquiry_reply': 'The lab replied to your message',
      'profile_paused': 'Access to a profile is paused',
    };
    for (final e in fixed.entries) {
      testWidgets('${e.key}: "${e.value}"', (tester) async {
        await tester.pumpWidget(screen(FakeNotificationsApi([nWire(id: nid(1), kind: e.key, profileId: null, routeId: null, entityId: eid(1))])));
        await settle(tester);
        expect(find.text(e.value), findsOneWidget);
      });
    }

    final booking = <String, RegExp>{
      'booking_confirmed': RegExp(r'^Booking( \S+)? confirmed$'),
      'booking_cancelled': RegExp(r'^Booking( \S+)? cancelled$'),
      'booking_reminder': RegExp(r'^Reminder: booking( \S+)? soon$'),
    };
    for (final e in booking.entries) {
      testWidgets('${e.key}: key text, and no booking number or id is taken from the row', (tester) async {
        final wire = nWire(id: nid(1), kind: e.key, entityType: 'booking', entityId: eid(7), profileId: null, routeId: 'patient_app.booking', extra: {'booking_no': 'BK26000042'});
        await tester.pumpWidget(screen(FakeNotificationsApi([wire])));
        await settle(tester);
        expect(allText(tester).where(e.value.hasMatch), hasLength(1), reason: allText(tester).join(' | '));
        expect(allText(tester).any((t) => t.contains('BK26000042') || t.contains(eid(7))), isFalse);
      });
    }

    testWidgets('two profiles: each row names its own profile (joined on profile_id from E13)', (tester) async {
      final api = FakeNotificationsApi([
        nWire(id: nid(1), profileId: nSelf, createdAt: '2026-11-04T10:00:00.000Z'),
        nWire(id: nid(2), profileId: nChild, createdAt: '2026-11-04T09:00:00.000Z'),
      ]);
      await tester.pumpWidget(screen(api));
      await settle(tester);
      expect(find.text('A new report is ready for Asha Test (synthetic)'), findsOneWidget);
      expect(find.text('A new report is ready for Ravi Test (synthetic)'), findsOneWidget);
    });

    testWidgets('a profile not in the list (removed / paused) renders the key text without the name: no "{profile}", no "null"', (tester) async {
      await tester.pumpWidget(screen(FakeNotificationsApi([nWire(id: nid(1), profileId: nUnknownProfile)])));
      await settle(tester);
      final t = allText(tester).firstWhere((x) => x.startsWith('A new report is ready'), orElse: () => '');
      expect(t, isNotEmpty);
      expect(t, isNot(contains('{')));
      expect(t.toLowerCase(), isNot(contains('null')));
      expect(t, isNot(contains(nUnknownProfile)));
    });

    testWidgets('E13 failing does not break the inbox: rows still render (without names), no error state', (tester) async {
      await tester.pumpWidget(screen(FakeNotificationsApi([nWire(id: nid(1))]), profiles: profilesFake(fail: true)));
      await settle(tester);
      expect(find.byType(LimsErrorState), findsNothing);
      expect(allText(tester).any((t) => t.startsWith('A new report is ready')), isTrue);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a row without a profile_id still renders its key text', (tester) async {
      await tester.pumpWidget(screen(FakeNotificationsApi([nWire(id: nid(1), kind: 'follow_up_reminder', profileId: null, routeId: null)])));
      await settle(tester);
      final t = allText(tester).firstWhere((x) => x.startsWith('Time for a follow-up test'), orElse: () => '');
      expect(t, isNotEmpty);
      expect(t, isNot(contains('{')));
    });

    testWidgets('an unknown future kind renders a generic row: no crash, the raw key is not shown, the other rows still render', (tester) async {
      final api = FakeNotificationsApi([nWire(id: nid(1), kind: 'future_kind_v9', profileId: null, routeId: null), nWire(id: nid(2), kind: 'payment_completed', profileId: null, routeId: null)]);
      await tester.pumpWidget(screen(api));
      await settle(tester);
      expect(tester.takeException(), isNull);
      expect(allText(tester).any((t) => t.contains('future_kind_v9')), isFalse);
      expect(find.text('Payment received'), findsOneWidget);
    });

    testWidgets('text-like fields on the wire (title/body/message/text) are never rendered; neither are ids', (tester) async {
      final wire = nWire(id: nid(1), entityId: eid(1), extra: {'title': 'Glucose 7.1 mmol/L', 'body': 'Hb 11.0 g/dL', 'message': 'Positive', 'text': 'Secret result'});
      await tester.pumpWidget(screen(FakeNotificationsApi([wire])));
      await settle(tester);
      final all = allText(tester).join(' | ');
      for (final s in ['Glucose', 'Hb 11.0', 'Positive', 'Secret result', nid(1), eid(1), nSelf, 'patient_app.report', 'report_ready']) {
        expect(all, isNot(contains(s)), reason: s);
      }
    });

    testWidgets('rows keep API order (newest first as served)', (tester) async {
      final api = FakeNotificationsApi([
        nWire(id: nid(1), kind: 'payment_completed', profileId: null, routeId: null, createdAt: '2026-11-04T10:00:00.000Z'),
        nWire(id: nid(2), kind: 'enquiry_reply', profileId: null, routeId: null, createdAt: '2026-11-04T09:00:00.000Z'),
        nWire(id: nid(3), kind: 'profile_paused', profileId: null, routeId: null, createdAt: '2026-11-03T09:00:00.000Z'),
      ]);
      await tester.pumpWidget(screen(api));
      await settle(tester);
      double y(String s) => tester.getTopLeft(find.text(s)).dy;
      expect(y('Payment received'), lessThan(y('The lab replied to your message')));
      expect(y('The lab replied to your message'), lessThan(y('Access to a profile is paused')));
    });
  });

  group('tap', () {
    testWidgets('tapping a row calls onOpen with that row\'s kind, entity, profile and route ids (the app resolves booking_no etc. itself)', (tester) async {
      final opened = <NotificationItem>[];
      final api = FakeNotificationsApi([
        nWire(id: nid(1), kind: 'report_ready', entityType: 'order', entityId: eid(1), profileId: nSelf, routeId: 'patient_app.report'),
        nWire(id: nid(2), kind: 'booking_confirmed', entityType: 'booking', entityId: eid(2), profileId: null, routeId: 'patient_app.booking', createdAt: '2026-11-04T09:00:00.000Z'),
      ]);
      await tester.pumpWidget(screen(api, onOpen: opened.add));
      await settle(tester);
      await tester.tap(find.text('A new report is ready for Asha Test (synthetic)'));
      await tester.pump();
      expect(opened, hasLength(1));
      expect(opened.single.id, nid(1));
      expect(opened.single.kind, 'report_ready');
      expect(opened.single.entityType, 'order');
      expect(opened.single.entityId, eid(1));
      expect(opened.single.profileId, nSelf);
      expect(opened.single.routeId, 'patient_app.report');
    });

    testWidgets('a row without a route id can still be tapped (opens the app\'s own destination); null route is passed as null', (tester) async {
      final opened = <NotificationItem>[];
      final api = FakeNotificationsApi([nWire(id: nid(1), kind: 'enquiry_reply', entityType: 'enquiry', entityId: eid(1), profileId: null, routeId: null)]);
      await tester.pumpWidget(screen(api, onOpen: opened.add));
      await settle(tester);
      await tester.tap(find.text('The lab replied to your message'));
      await tester.pump();
      expect(opened.single.routeId, isNull);
      expect(opened.single.entityType, 'enquiry');
    });
  });

  group('refresh without push (US-EN-11.2)', () {
    testWidgets('on launch: opening A20 asks E45 once (no unread_only filter)', (tester) async {
      final api = FakeNotificationsApi([nWire(id: nid(1))]);
      await tester.pumpWidget(screen(api));
      await settle(tester);
      expect(api.listCalls, 1);
      expect(api.unreadOnlyArgs, [false]);
    });

    testWidgets('on resume: coming back from background asks E45 again and shows rows that arrived meanwhile', (tester) async {
      final api = FakeNotificationsApi([nWire(id: nid(1))]);
      await tester.pumpWidget(screen(api));
      await settle(tester);
      api.items.insert(0, nWire(id: nid(2), kind: 'payment_completed', profileId: null, routeId: null, createdAt: '2026-11-05T01:00:00.000Z'));
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      await tester.pump();
      expect(api.listCalls, 1, reason: 'no request while in the background');
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await settle(tester);
      expect(api.listCalls, 2);
      expect(find.text('Payment received'), findsOneWidget);
    });

    testWidgets('pull-to-refresh asks E45 again, also when the list is short', (tester) async {
      final api = FakeNotificationsApi([nWire(id: nid(1)), nWire(id: nid(2), kind: 'payment_completed', profileId: null, routeId: null, createdAt: '2026-11-04T09:00:00.000Z')]);
      await tester.pumpWidget(screen(api));
      await settle(tester);
      expect(find.byType(RefreshIndicator), findsOneWidget);
      await tester.fling(find.byType(Scrollable).first, const Offset(0, 400), 1000);
      await settle(tester);
      expect(api.listCalls, 2);
    });

    testWidgets('no polling: nothing is requested while the screen idles', (tester) async {
      final api = FakeNotificationsApi([nWire(id: nid(1))]);
      await tester.pumpWidget(screen(api));
      await settle(tester);
      await tester.pump(const Duration(minutes: 10));
      expect(api.listCalls, 1);
    });
  });

  group('Mark all read (E46 with the visible ids)', () {
    List<Map<String, Object?>> three() => [
          nWire(id: nid(1), createdAt: '2026-11-04T10:00:00.000Z'),
          nWire(id: nid(2), kind: 'payment_completed', profileId: null, routeId: null, readAt: '2026-11-04T09:30:00.000Z', createdAt: '2026-11-04T09:00:00.000Z'),
          nWire(id: nid(3), kind: 'enquiry_reply', profileId: null, routeId: null, createdAt: '2026-11-03T09:00:00.000Z'),
        ];

    testWidgets('sends the visible ids in one E46 call (every unread id included, nothing that is not shown), then reloads the inbox', (tester) async {
      final api = FakeNotificationsApi(three());
      await tester.pumpWidget(screen(api));
      await settle(tester);
      await tester.tap(find.text('Mark all read'));
      await settle(tester);
      expect(api.markCalls, 1);
      expect(api.marked.single, containsAll([nid(1), nid(3)]));
      expect(api.marked.single.toSet().difference({nid(1), nid(2), nid(3)}), isEmpty);
      expect(api.marked.single.length, lessThanOrEqualTo(200));
      expect(api.listCalls, 2, reason: 'reloaded after marking');
      expect(find.text('Mark all read'), findsNothing, reason: 'nothing unread is left');
    });

    testWidgets('per-id not_found in the answer is not an error: the list stays, no error state', (tester) async {
      final api = FakeNotificationsApi(three())..onMarkOverride = (ids, _) async => {'results': [for (final id in ids) {'id': id, 'outcome': id == nid(3) ? 'not_found' : 'updated'}]};
      await tester.pumpWidget(screen(api));
      await settle(tester);
      await tester.tap(find.text('Mark all read'));
      await settle(tester);
      expect(find.byType(LimsErrorState), findsNothing);
      expect(find.text('Payment received'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a failing E46 keeps the list on screen and does not crash', (tester) async {
      final api = FakeNotificationsApi(three())..onMarkOverride = (_, __) async => throw LimsException('common.internal');
      await tester.pumpWidget(screen(api));
      await settle(tester);
      await tester.tap(find.text('Mark all read'));
      await settle(tester);
      expect(tester.takeException(), isNull);
      expect(find.text('Payment received'), findsOneWidget);
      expect(find.text('A new report is ready for Asha Test (synthetic)'), findsOneWidget);
    });

    testWidgets('a double tap does not send two overlapping E46 calls', (tester) async {
      final c = Completer<void>();
      final api = FakeNotificationsApi(three())
        ..onMarkOverride = (ids, _) async {
          await c.future;
          return {'results': [for (final id in ids) {'id': id, 'outcome': 'updated'}]};
        };
      await tester.pumpWidget(screen(api));
      await settle(tester);
      await tester.tap(find.text('Mark all read'));
      await tester.pump();
      await tester.tap(find.text('Mark all read'), warnIfMissed: false);
      await tester.pump();
      expect(api.markCalls, 1);
      c.complete();
      await settle(tester);
    });

    testWidgets('all rows already read: no Mark all read button', (tester) async {
      final api = FakeNotificationsApi([nWire(id: nid(1), readAt: '2026-11-04T10:30:00.000Z')]);
      await tester.pumpWidget(screen(api));
      await settle(tester);
      expect(find.text('Mark all read'), findsNothing);
    });

    testWidgets('one primary button per page (LD-140): Mark all read is the only LimsButton on the list', (tester) async {
      await tester.pumpWidget(screen(FakeNotificationsApi(three())));
      await settle(tester);
      expect(find.byType(LimsButton), findsOneWidget);
    });
  });
}
