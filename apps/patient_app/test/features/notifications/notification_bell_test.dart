// T-P5 — the A5 app-bar bell (04-UI-UX §1.1: "bell with unread count (E45 unread_only=true, count of first page capped '9+')"; 03-APP-FLOW A5 row: E45 (badge)).
// No push (B11): the badge refreshes on launch (mount) and on resume. Synthetic data only.
// Choices the brief left open (cite if disputed): the semantics label is "Notifications" with " , {n} unread" appended when n > 0; no badge text at 0 or on error.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:patient_app/features/notifications/notification_bell.dart';

import '../../support/notifications_fakes.dart';

List<Map<String, Object?>> unread(int n) => [for (var i = 0; i < n; i++) nWire(id: nid(i + 1), createdAt: '2026-11-04T10:${i.toString().padLeft(2, '0')}:00.000Z')];

Widget bell(FakeNotificationsApi api, {VoidCallback? onPressed}) =>
    hostWith(Scaffold(appBar: AppBar(title: const Text('Home'), actions: [NotificationBell(onPressed: onPressed)])), api);

Iterable<String> texts(WidgetTester t) => t.widgetList<Text>(find.byType(Text)).map((w) => w.data ?? '');

void main() {
  testWidgets('asks E45 with unread_only=true once on launch', (tester) async {
    final api = FakeNotificationsApi(unread(2));
    await tester.pumpWidget(bell(api));
    await settle(tester);
    expect(api.listCalls, 1);
    expect(api.unreadOnlyArgs, [true]);
  });

  for (final n in [1, 3, 9]) {
    testWidgets('$n unread -> badge "$n"', (tester) async {
      await tester.pumpWidget(bell(FakeNotificationsApi(unread(n))));
      await settle(tester);
      expect(find.text('$n'), findsOneWidget);
      expect(find.text('9+'), findsNothing);
    });
  }

  for (final n in [10, 12, 50]) {
    testWidgets('$n unread -> badge capped "9+"', (tester) async {
      await tester.pumpWidget(bell(FakeNotificationsApi(unread(n))));
      await settle(tester);
      expect(find.text('9+'), findsOneWidget);
      expect(find.text('$n'), findsNothing);
    });
  }

  testWidgets('read rows are not counted (the unread_only answer is what counts)', (tester) async {
    final items = [...unread(2), nWire(id: nid(9), readAt: '2026-11-04T09:00:00.000Z', createdAt: '2026-11-04T08:00:00.000Z')];
    await tester.pumpWidget(bell(FakeNotificationsApi(items)));
    await settle(tester);
    expect(find.text('2'), findsOneWidget);
  });

  testWidgets('0 unread: the bell is there, no badge number', (tester) async {
    await tester.pumpWidget(bell(FakeNotificationsApi([])));
    await settle(tester);
    expect(find.byIcon(Icons.notifications_outlined).evaluate().length + find.byIcon(Icons.notifications).evaluate().length + find.byIcon(Icons.notifications_none).evaluate().length, greaterThan(0));
    expect(texts(tester).where((t) => RegExp(r'^\d+\+?$').hasMatch(t)), isEmpty);
  });

  testWidgets('semantics: the bell is a button named "Notifications" and announces the unread count', (tester) async {
    final h = tester.ensureSemantics();
    await tester.pumpWidget(bell(FakeNotificationsApi(unread(3))));
    await settle(tester);
    expect(find.bySemanticsLabel(RegExp(r'Notifications.*3 unread')), findsOneWidget);
    h.dispose();
  });

  testWidgets('tap calls onPressed', (tester) async {
    var taps = 0;
    await tester.pumpWidget(bell(FakeNotificationsApi(unread(1)), onPressed: () => taps++));
    await settle(tester);
    await tester.tap(find.byType(NotificationBell));
    await tester.pump();
    expect(taps, 1);
  });

  testWidgets('an E45 error shows no badge and no exception (the bell must not break the home bar)', (tester) async {
    final api = FakeNotificationsApi([])..onListOverride = (_) async => throw LimsException('common.internal');
    await tester.pumpWidget(bell(api));
    await settle(tester);
    expect(tester.takeException(), isNull);
    expect(texts(tester).where((t) => RegExp(r'^\d+\+?$').hasMatch(t)), isEmpty);
    expect(find.byType(NotificationBell), findsOneWidget);
  });

  testWidgets('slow E45: the bell renders at once without a badge, then the count appears', (tester) async {
    final c = Completer<void>();
    final api = FakeNotificationsApi(unread(4))..hold = c.future;
    await tester.pumpWidget(bell(api));
    await tester.pump();
    expect(find.byType(NotificationBell), findsOneWidget);
    expect(find.text('4'), findsNothing);
    c.complete();
    await settle(tester);
    expect(find.text('4'), findsOneWidget);
  });

  testWidgets('on resume the count is refreshed (no push: resume is the refresh trigger); nothing is asked in the background', (tester) async {
    final api = FakeNotificationsApi(unread(1));
    await tester.pumpWidget(bell(api));
    await settle(tester);
    expect(find.text('1'), findsOneWidget);
    api.items.add(nWire(id: nid(2), createdAt: '2026-11-05T01:00:00.000Z'));
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();
    expect(api.listCalls, 1);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await settle(tester);
    expect(api.listCalls, 2);
    expect(api.unreadOnlyArgs, [true, true]);
    expect(find.text('2'), findsOneWidget);
  });

  testWidgets('no polling: the bell asks nothing while idle', (tester) async {
    final api = FakeNotificationsApi(unread(1));
    await tester.pumpWidget(bell(api));
    await settle(tester);
    await tester.pump(const Duration(minutes: 10));
    expect(api.listCalls, 1);
  });
}
