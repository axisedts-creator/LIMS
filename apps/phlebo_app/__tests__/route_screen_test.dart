// HC-T27 M2 Today's route (04-UI-UX §3.2). ASSUMED API: see support/hc27_fixture.dart (RouteScreen, RouteVisit, SyncSummary).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:phlebo_app/features/outbox/domain/sync_summary.dart';
import 'package:phlebo_app/features/route/domain/route_models.dart';
import 'package:phlebo_app/features/route/ui/route_screen.dart';

import 'support/hc27_fixture.dart';

void main() {
  late List<String> opened;
  late List<String> nav;
  late int refreshes;

  Future<void> open(
    WidgetTester t,
    List<RouteVisit> visits, {
    bool purged = false,
    bool offline = false,
    SyncSummary? sync,
    double textScale = 1.0,
  }) async {
    opened = [];
    nav = [];
    refreshes = 0;
    await pumpScreen(
      t,
      RouteScreen(
        routeDate: DateTime(2026, 11, 14),
        visits: visits,
        purged: purged,
        offline: offline,
        sync: sync ?? SyncSummary(waiting: 3, lastUpload: DateTime(2026, 11, 14, 9, 15)),
        onRefresh: () async => refreshes++,
        onOpenVisit: opened.add,
        onOpenHandover: () => nav.add('handover'),
        onOpenOutbox: () => nav.add('outbox'),
        onOpenSettings: () => nav.add('settings'),
        onHelp: () => nav.add('help'),
      ),
      textScale: textScale,
    );
  }

  Future<void> menu(WidgetTester t, String item) async {
    await t.tap(find.byKey(const ValueKey('route.menu')));
    await t.pumpAndSettle();
    await t.tap(find.text(item).last);
    await t.pumpAndSettle();
  }

  testWidgets('header: "Today · DD/MM/YYYY" and the sync chip "{n} waiting · Last upload hh:mm"', (t) async {
    await open(t, [routeVisit(1)]);
    expect(find.text('Today · 14/11/2026'), findsOneWidget);
    expect(find.text('3 waiting · Last upload 09:15'), findsOneWidget);
  });

  testWidgets('list is ordered by sequence, whatever order it arrives in', (t) async {
    await open(t, [
      routeVisit(3, name: 'Test Patient Three'),
      routeVisit(1, name: 'Test Patient One'),
      routeVisit(2, name: 'Test Patient Two'),
    ]);
    final y = [for (final n in ['One', 'Two', 'Three']) t.getTopLeft(find.text('Test Patient $n')).dy];
    expect(y[0] < y[1] && y[1] < y[2], isTrue, reason: 'sequence 1, 2, 3 top to bottom: $y');
  });

  testWidgets('tile: sequence number, patient name, window + landmark, tube badge', (t) async {
    await open(t, [routeVisit(2, collected: 1)]);
    expect(find.byType(LimsListTile), findsOneWidget);
    expect(find.text('2'), findsWidgets, reason: 'leading sequence number');
    expect(find.text('Test Patient One'), findsOneWidget);
    expect(find.textContaining('08:00–09:00'), findsOneWidget);
    expect(find.textContaining('Blue gate'), findsOneWidget);
    expect(find.text('1/2 tubes'), findsOneWidget);
  });

  testWidgets('landmark is truncated to 40 characters', (t) async {
    await open(t, [routeVisit(1, landmark: longLandmark)]);
    expect(find.textContaining(longLandmark), findsNothing);
    expect(find.textContaining(longLandmark.substring(0, 30)), findsOneWidget);
  });

  testWidgets('status chips: To do, In progress, Completed, Failed, "Cancelled — do not visit"', (t) async {
    await open(t, [
      routeVisit(1),
      routeVisit(2, status: 'in_progress'),
      routeVisit(3, status: 'completed'),
      routeVisit(4, status: 'failed'),
      routeVisit(5, status: 'cancelled'),
    ]);
    for (final w in ['To do', 'In progress', 'Completed', 'Failed', 'Cancelled — do not visit']) {
      expect(find.descendant(of: find.byType(LimsStatusChip), matching: find.text(w)), findsOneWidget, reason: w);
    }
  });

  testWidgets('tapping a visit opens it', (t) async {
    await open(t, [routeVisit(1), routeVisit(2, name: 'Test Patient Two')]);
    await tapText(t, 'Test Patient Two');
    expect(opened, [routeVisit(2).visitId]);
  });

  testWidgets('cancelled stub: greyed, not opened, shows "This visit was cancelled by the centre."', (t) async {
    await open(t, [routeVisit(1, status: 'cancelled')]);
    expect(find.text('This visit was cancelled by the centre.'), findsNothing);
    await tapText(t, 'Test Patient One');
    expect(opened, isEmpty, reason: 'a cancelled visit never opens M3');
    expect(find.text('This visit was cancelled by the centre.'), findsOneWidget);
  });

  testWidgets('menu: Handover, Outbox, Settings', (t) async {
    await open(t, [routeVisit(1)]);
    await menu(t, 'Handover');
    await menu(t, 'Outbox');
    await menu(t, 'Settings');
    expect(nav, ['handover', 'outbox', 'settings']);
  });

  testWidgets('? icon opens the bundled help', (t) async {
    await open(t, [routeVisit(1)]);
    await t.tap(find.byIcon(Icons.help_outline));
    await t.pumpAndSettle();
    expect(nav, ['help']);
  });

  testWidgets('pull to refresh calls onRefresh once', (t) async {
    await open(t, [routeVisit(1), routeVisit(2)]);
    await t.fling(find.byType(ListView).first, const Offset(0, 400), 1000);
    await t.pumpAndSettle();
    expect(refreshes, 1);
  });

  testWidgets('empty list: "No visits assigned for today. Pull down to refresh."', (t) async {
    await open(t, const []);
    expect(find.text('No visits assigned for today. Pull down to refresh.'), findsOneWidget);
    expect(find.text('Your list was cleared for security. Connect to the internet to download it again.'), findsNothing);
  });

  testWidgets('purged: LimsEmptyState "Your list was cleared for security…" and no visit tiles', (t) async {
    await open(t, [routeVisit(1)], purged: true);
    expect(find.byType(LimsEmptyState), findsOneWidget);
    expect(find.text('Your list was cleared for security. Connect to the internet to download it again.'), findsOneWidget);
    expect(find.text('Test Patient One'), findsNothing, reason: 'a purged cache shows no patient names');
    expect(find.text('No visits assigned for today. Pull down to refresh.'), findsNothing);
  });

  testWidgets('offline: LimsOfflineBanner slot is filled; online: absent', (t) async {
    await open(t, [routeVisit(1)], offline: true);
    expect(find.byType(LimsOfflineBanner), findsOneWidget);
    await open(t, [routeVisit(1)]);
    expect(find.byType(LimsOfflineBanner), findsNothing);
  });

  testWidgets('LD-140: LimsSecureScreen + LimsScaffold, at most one primary button, 2.0 text scale does not overflow', (t) async {
    await open(t, [routeVisit(1), routeVisit(2, status: 'cancelled')], textScale: 2.0);
    expect(find.byType(LimsSecureScreen), findsOneWidget);
    expect(find.byType(LimsScaffold), findsOneWidget);
    final primary = t.widgetList<LimsButton>(find.byType(LimsButton)).where((b) => !b.secondary);
    expect(primary.length, lessThanOrEqualTo(1));
    expect(t.takeException(), isNull);
  });
}
