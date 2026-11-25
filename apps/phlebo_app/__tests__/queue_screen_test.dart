// Today home (QueueScreen): board M5 Queue. Progress hero, next stop with its one primary action, up next, completed, handover prompt.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:phlebo_app/features/outbox/domain/sync_summary.dart';
import 'package:phlebo_app/features/route/domain/route_models.dart';
import 'package:phlebo_app/features/route/ui/queue_screen.dart';

import 'support/phlebo_pump.dart';

RouteVisit v(int n, {String status = 'assigned', String? name, String kind = 'booking', bool fasting = false, bool onTheWay = false, List<String> flags = const [], int collected = 0, int expected = 2}) => RouteVisit(
      visitId: '00000000-0000-4000-8000-${n.toString().padLeft(12, '0')}',
      sequence: n,
      patientName: name ?? 'Demo Patient $n',
      windowStart: '0$n:00',
      windowEnd: '0$n:30',
      landmark: 'Blue gate',
      status: status,
      expectedTubes: expected,
      collectedTubes: collected,
      kind: kind,
      fasting: fasting,
      onTheWay: onTheWay,
      flags: flags,
      locality: 'Area $n',
      tubeLabels: const ['Purple · EDTA', 'Red · Plain'],
    );

void main() {
  late List<String> opened;
  late List<String> travelled;
  late List<String> nav;

  Future<void> open(WidgetTester t, List<RouteVisit> visits, {bool travel = true, bool offline = false, bool purged = false, bool loading = false, int handover = 0, double scale = 1.0}) async {
    opened = [];
    travelled = [];
    nav = [];
    await pumpPhlebo(
      t,
      QueueScreen(
        routeDate: DateTime(2026, 11, 25),
        visits: visits,
        purged: purged,
        loading: loading,
        offline: offline,
        dataAsOf: DateTime(2026, 11, 25, 6, 45),
        sync: const SyncSummary(waiting: 2),
        onRefresh: () async {},
        onOpenVisit: opened.add,
        onStartTravel: travel ? travelled.add : null,
        onOpenAll: () => nav.add('all'),
        onOpenOutbox: () => nav.add('outbox'),
        onOpenHandover: () => nav.add('handover'),
        handoverTubes: handover,
        onHelp: () => nav.add('help'),
      ),
      textScale: scale,
      settle: !loading,
    );
  }

  testWidgets('hero counts collected of total, missed and stops to go', (t) async {
    await open(t, [v(1, status: 'completed'), v(2, status: 'failed'), v(3), v(4)]);
    expect(find.text('1 of 4 collected'), findsOneWidget);
    expect(find.text('1 missed visit · 2 stops to go'), findsOneWidget);
  });

  testWidgets('next stop is the first open visit by sequence, whatever the order it arrives in', (t) async {
    await open(t, [v(3), v(1, status: 'completed'), v(2, name: 'Next Patient')]);
    expect(find.textContaining('NEXT STOP · 02:00'), findsOneWidget);
    expect(find.text('Next Patient'), findsOneWidget, reason: 'the next stop card names the patient once');
    expect(find.text('Demo Patient 3'), findsOneWidget, reason: 'the later stop sits in Up next');
  });

  testWidgets('"On my way" starts travel for the next stop and is the ONE primary button', (t) async {
    await open(t, [v(1), v(2)]);
    expect(find.byWidgetPredicate((w) => w is LimsButton && !w.secondary && w.label == 'On my way'), findsOneWidget);
    expect(t.widgetList<LimsButton>(find.byType(LimsButton)).where((b) => !b.secondary), hasLength(1));
    await tapLabel(t, limsButton('On my way'));
    expect(travelled, [v(1).visitId]);
    expect(opened, isEmpty);
  });

  testWidgets('no travel step on the host: the primary says "Open visit" and opens it', (t) async {
    await open(t, [v(1)], travel: false);
    await tapLabel(t, limsButton('Open visit'));
    expect(opened, [v(1).visitId]);
  });

  testWidgets('on the way shows the chip and "Open visit"; in progress shows "Continue visit"', (t) async {
    await open(t, [v(1, onTheWay: true)]);
    expect(find.text('On the way'), findsOneWidget);
    expect(limsButton('Open visit'), findsOneWidget);
    await open(t, [v(1, status: 'in_progress')]);
    expect(find.text('In progress'), findsOneWidget);
    expect(limsButton('Continue visit'), findsOneWidget);
  });

  testWidgets('recollection, address flag and fasting are visible on the next stop', (t) async {
    await open(t, [v(1, kind: 'recollection', fasting: true, flags: const ['address_missing'])]);
    expect(find.text('Recollection'), findsOneWidget);
    expect(find.text('Address needed'), findsOneWidget);
    expect(find.text('Fasting sample'), findsOneWidget);
    expect(find.text('Purple · EDTA'), findsOneWidget, reason: 'tube name is always printed, never colour only');
  });

  testWidgets('up next rows open their visit; completed rows say Collected / Partly collected / Missed', (t) async {
    await open(t, [v(1, status: 'completed', collected: 2), v(2, status: 'completed', collected: 1), v(3, status: 'failed'), v(4), v(5, name: 'Later Patient')]);
    expect(find.text('Collected'), findsOneWidget);
    expect(find.text('Partly collected'), findsOneWidget);
    expect(find.text('Missed'), findsOneWidget);
    await tapLabel(t, find.text('Later Patient'));
    expect(opened, [v(5).visitId]);
  });

  testWidgets('cancelled visit is listed apart, not tappable, and explains itself', (t) async {
    await open(t, [v(1), v(2, status: 'cancelled', name: 'Gone Patient')]);
    expect(find.text('Cancelled — do not visit'), findsOneWidget);
    await t.tap(find.text('Gone Patient'));
    await t.pumpAndSettle();
    expect(opened, isEmpty);
    expect(find.text('This visit was cancelled by the centre.'), findsOneWidget);
  });

  testWidgets('all done: no next stop, summary and the handover prompt', (t) async {
    await open(t, [v(1, status: 'completed', collected: 2), v(2, status: 'failed')], handover: 2);
    expect(find.text('All stops done for today'), findsOneWidget);
    expect(find.text('2 tubes to hand over'), findsOneWidget);
    await tapLabel(t, limsButton('Hand over'));
    expect(nav, ['handover']);
  });

  testWidgets('offline banner says when the data is from; net chip opens the outbox', (t) async {
    await open(t, [v(1)], offline: true);
    expect(find.text('Offline — showing data from 06:45'), findsOneWidget);
    expect(find.text('Offline · 2 waiting'), findsOneWidget);
    await t.tap(find.text('Offline · 2 waiting'));
    await t.pumpAndSettle();
    expect(nav, ['outbox']);
  });

  testWidgets('empty, purged and first-load states use the spec copy', (t) async {
    await open(t, const []);
    expect(find.text('No visits assigned for today. Pull down to refresh.'), findsOneWidget);
    await open(t, const [], purged: true);
    expect(find.text('Your list was cleared for security. Connect to the internet to download it again.'), findsOneWidget);
    await open(t, const [], loading: true);
    expect(find.byType(LimsLoading), findsOneWidget);
  });

  testWidgets('"See full list" and help are wired', (t) async {
    await open(t, [v(1)]);
    await tapLabel(t, find.text('See full list'));
    await t.tap(find.byIcon(Icons.help_outline));
    expect(nav, ['all', 'help']);
  });

  testWidgets('LD-140 chrome and 2.0 text scale does not overflow', (t) async {
    await open(t, [v(1, status: 'completed', collected: 2), v(2, kind: 'recollection', fasting: true), v(3), v(4, status: 'cancelled')], handover: 2, scale: 2.0);
    expect(find.byType(LimsSecureScreen), findsOneWidget);
    expect(find.byType(LimsScaffold), findsOneWidget);
    expect(t.takeException(), isNull);
  });
}
