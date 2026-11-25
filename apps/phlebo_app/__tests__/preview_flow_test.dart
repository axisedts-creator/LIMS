// End to end through the real PhleboApp + go_router + preview store (synthetic data): the whole app is reachable and reacts.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:phlebo_app/app/app.dart';
import 'package:phlebo_app/app/router.dart';
import 'package:phlebo_app/features/outbox/domain/outbox_row.dart';
import 'package:phlebo_app/preview/preview_data.dart';
import 'package:phlebo_app/preview/preview_screens.dart';
import 'package:phlebo_app/preview/preview_store.dart';

import 'support/phlebo_pump.dart';

final _now = DateTime(2026, 11, 25, 9, 50);

void main() {
  late PreviewStore store;

  Future<void> boot(WidgetTester t, {bool signedIn = true}) async {
    store = PreviewStore(now: () => _now, syncDelay: Duration.zero);
    t.view.physicalSize = const Size(800, 1800);
    t.view.devicePixelRatio = 1.0;
    addTearDown(t.view.reset);
    await t.pumpWidget(PhleboApp(router: buildRouter(screens: PreviewScreens(store, splashFor: Duration.zero))));
    await t.pumpAndSettle();
    if (signedIn) {
      await t.enterText(find.widgetWithText(TextField, 'Email'), 'user@example.test');
      await t.enterText(find.widgetWithText(TextField, 'Password'), 'pw');
      await t.pump();
      await tapLabel(t, limsButton('Sign in'));
    }
  }

  Finder navTab(String label) => find.descendant(of: find.byType(LimsBottomNav), matching: find.text(label));

  testWidgets('splash goes to sign in; a wrong password shows the spec copy and stays on sign in', (t) async {
    await boot(t, signedIn: false);
    expect(find.text('Sign in'), findsWidgets);
    await t.enterText(find.widgetWithText(TextField, 'Email'), 'user@example.test');
    await t.enterText(find.widgetWithText(TextField, 'Password'), 'wrong');
    await t.pump();
    await tapLabel(t, limsButton('Sign in'));
    expect(find.text('Email or password is incorrect.'), findsOneWidget);
    expect(find.textContaining('Today ·'), findsNothing);
  });

  testWidgets('signed in: Today shows the route, the next stop and the handover prompt', (t) async {
    await boot(t);
    expect(find.text('Today · 25/11/2026'), findsOneWidget);
    expect(find.text('Dipa Demo'), findsOneWidget);
    expect(find.text('5 tubes to hand over'), findsOneWidget);
    expect(find.text('Recollection'), findsOneWidget);
  });

  testWidgets('On my way > Open visit > I\'ve arrived records visit.arrived and opens the identity check', (t) async {
    await boot(t);
    await tapLabel(t, limsButton('On my way'));
    expect(find.text('On the way'), findsOneWidget, reason: 'the queue chip');
    await tapLabel(t, limsButton('Open visit'));
    expect(find.text("I've arrived"), findsOneWidget);
    expect(find.text('Travel'), findsOneWidget);
    expect(find.text('12 min'), findsOneWidget);
    await tapLabel(t, limsButton("I've arrived"));
    expect(find.text('Identity check'), findsOneWidget);
    expect(store.logOf(PreviewData.visits()[3].id).map((e) => e.$1), ['visit.arrived']);
    expect(store.outbox.first.type, 'visit.arrived');
    expect(store.routeVisits.firstWhere((v) => v.sequence == 4).status, 'in_progress');
  });

  testWidgets('"Can\'t do this visit" > Patient not home > Fail visit fails it, returns to Today and the next stop moves on', (t) async {
    await boot(t);
    await tapLabel(t, find.text('Dipa Demo'));
    await tapLabel(t, limsButton("Can't do this visit"));
    await tapLabel(t, find.text('Patient not home'));
    await tapLabel(t, limsButton('Fail visit'));
    expect(find.textContaining('Today ·'), findsOneWidget);
    expect(find.text('Ekraj Demo'), findsOneWidget, reason: 'the recollection visit is the next stop now');
    expect(find.text('2 missed visits · 2 stops to go'), findsOneWidget);
    expect(store.outbox.first.type, 'visit.failed');
  });

  testWidgets('offline: new records wait in the outbox, sync is refused, then back online they upload', (t) async {
    await boot(t);
    store.setOffline(true);
    await t.pumpAndSettle();
    expect(find.text('Offline'), findsOneWidget, reason: 'net chip, nothing waiting yet');
    await store.enqueue(type: 'visit.arrived', visitId: PreviewData.visits()[3].id, visitLabel: '#4', payload: const {'gps': {}});
    await t.pumpAndSettle();
    expect(store.pending, 1);
    await expectLater(store.syncNow(), throwsStateError);
    store.setOffline(false);
    await t.runAsync(store.syncNow);
    await t.pumpAndSettle();
    expect(store.pending, 0);
    expect(store.outbox.every((OutboxRow r) => r.state == 'applied'), isTrue);
  });

  testWidgets('tabs: History > a day, Alerts > a visit alert opens that visit, Profile > ID card', (t) async {
    await boot(t);
    await tapLabel(t, navTab('History'));
    expect(find.text('Last 3 working days'), findsOneWidget);
    await tapLabel(t, find.textContaining('Tuesday, 24 Nov'));
    expect(find.text('All synced. The centre has every visit of this day.'), findsOneWidget);
    await t.pageBack();
    await t.pumpAndSettle();
    await tapLabel(t, navTab('Alerts'));
    expect(find.text('Recollection added'), findsOneWidget);
    await tapLabel(t, find.text('Recollection added'));
    expect(find.text('Recollection visit'), findsOneWidget, reason: 'alert opened the recollection visit');
    await t.pageBack();
    await t.pumpAndSettle();
    expect(find.text('1 new'), findsOneWidget, reason: 'reading the alert cleared one of two unread');
    await tapLabel(t, navTab('Profile'));
    await tapLabel(t, find.text('My ID card'));
    expect(find.text('PHL-DEMO-01'), findsOneWidget);
  });

  testWidgets('handover: pick the centre, hand over, the receipt waits for the centre; a sync confirms it', (t) async {
    await boot(t);
    await tapLabel(t, limsButton('Hand over'));
    await tapLabel(t, find.text('Central Lab (demo)'));
    await tapLabel(t, limsButton('Hand over 5 tubes'));
    expect(find.text('Waiting for the centre'), findsOneWidget);
    expect(store.handoverPool, isEmpty);
    await t.runAsync(store.syncNow);
    await t.pumpAndSettle();
    expect(store.lastReceipt?.status.name, 'confirmed');
  });

  testWidgets('preview controls: lock gate and wipe request take over the screen', (t) async {
    await boot(t);
    store.setLocked(true);
    await t.pumpAndSettle();
    expect(find.text('Phone locked'), findsOneWidget);
    await tapLabel(t, limsButton('Unlock'));
    expect(find.textContaining('Today ·'), findsOneWidget);
    store.setWipeRequested(true);
    await t.pumpAndSettle();
    expect(find.text('This phone will be erased'), findsOneWidget);
    await tapLabel(t, limsButton('Upload now'));
    expect(find.text('Sign in again to set up this phone.'), findsOneWidget, reason: 'after the wipe the phone is set up again from sign in');
  });

  testWidgets('settings sign-out is refused while changes are waiting', (t) async {
    await boot(t);
    store.setOffline(true);
    await store.enqueue(type: 'visit.arrived', visitId: PreviewData.visits()[3].id, visitLabel: '#4', payload: const {});
    await tapLabel(t, navTab('Profile'));
    await tapLabel(t, find.text('Settings and sign out'));
    expect(find.text('Sync first — 1 change is not uploaded yet'), findsOneWidget);
  });
}
