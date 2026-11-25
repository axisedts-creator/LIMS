// Behaviour of the new phlebotomist screens (history, alerts, profile, ID card, location, support, device states, lock, receipt).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:phlebo_app/features/alerts/domain/alert_models.dart';
import 'package:phlebo_app/features/alerts/ui/alerts_screen.dart';
import 'package:phlebo_app/features/entry/ui/device_notice_screen.dart';
import 'package:phlebo_app/features/entry/ui/lock_screen.dart';
import 'package:phlebo_app/features/handover/domain/handover_status.dart';
import 'package:phlebo_app/features/handover/ui/handover_receipt_screen.dart';
import 'package:phlebo_app/features/history/domain/history_models.dart';
import 'package:phlebo_app/features/history/ui/history_day_screen.dart';
import 'package:phlebo_app/features/history/ui/history_screen.dart';
import 'package:phlebo_app/features/outbox/domain/sync_summary.dart';
import 'package:phlebo_app/features/profile/domain/staff_profile.dart';
import 'package:phlebo_app/features/profile/ui/id_card_screen.dart';
import 'package:phlebo_app/features/profile/ui/location_screen.dart';
import 'package:phlebo_app/features/profile/ui/profile_screen.dart';
import 'package:phlebo_app/features/shell/ui/phlebo_shell.dart';
import 'package:phlebo_app/features/support/ui/contact_screen.dart';
import 'package:phlebo_app/features/support/ui/faq_screen.dart';
import 'package:phlebo_app/features/support/ui/help_screen.dart';
import 'package:phlebo_app/features/support/ui/report_problem_screen.dart';
import 'package:phlebo_app/features/travel/domain/travel_models.dart';
import 'package:phlebo_app/features/travel/ui/travel_card.dart';
import 'package:phlebo_app/ui/phlebo_kit.dart';

import 'support/phlebo_pump.dart';

const profile = StaffProfile(displayName: 'Test Staff', staffId: 'STAFF-1', labName: 'Lab One', weekCollections: 7, onTimePercent: 90, rejectedSamples: 2);
final now = DateTime(2026, 11, 25, 10, 0);

HistoryDay day(int back, List<String> statuses) => HistoryDay(
      id: 'd$back',
      date: DateTime(2026, 11, 25).subtract(Duration(days: back)),
      rows: [for (var i = 0; i < statuses.length; i++) HistoryRow(name: 'Person $back$i', locality: 'Area', time: '8:0$i AM', summary: 'CBC', status: statuses[i], reason: statuses[i] == 'missed' ? 'Patient not home' : null)],
    );

void main() {
  group('history', () {
    test('success percent counts collected and partly collected, never divides by zero', () {
      expect(successPercent(const []), 0);
      expect(successPercent([day(1, ['collected', 'missed']), day(2, ['collected', 'partial', 'collected', 'missed'])]), 67);
      expect(day(1, ['collected', 'partial', 'missed']).collected, 2);
      expect(day(1, ['collected', 'partial', 'missed']).missed, 1);
    });

    testWidgets('lists days newest first with totals; tapping opens the day', (t) async {
      HistoryDay? opened;
      await pumpPhlebo(t, HistoryScreen(days: [day(3, ['collected']), day(1, ['collected', 'missed']), day(2, ['collected'])], onOpenDay: (d) => opened = d));
      expect(find.text('Last 3 working days'), findsOneWidget);
      expect(find.text('75%'), findsOneWidget);
      final tue = t.getTopLeft(find.text('Tuesday, 24 Nov')).dy, mon = t.getTopLeft(find.text('Monday, 23 Nov')).dy;
      expect(tue < mon, isTrue);
      await tapLabel(t, find.text('Tuesday, 24 Nov'));
      expect(opened?.id, 'd1');
    });

    testWidgets('empty state', (t) async {
      await pumpPhlebo(t, HistoryScreen(days: const [], onOpenDay: (_) {}));
      expect(find.text('No past visits on this phone yet.'), findsOneWidget);
    });

    testWidgets('day screen shows each outcome and the missed reason; sync note follows allSynced', (t) async {
      await pumpPhlebo(t, HistoryDayScreen(day: day(1, ['collected', 'partial', 'missed']), allSynced: false));
      expect(find.text('Collected'), findsWidgets);
      expect(find.text('Partly collected'), findsOneWidget);
      expect(find.text('Missed'), findsWidgets);
      expect(find.text('Patient not home'), findsOneWidget);
      expect(find.text('Some changes of this day are still waiting to upload.'), findsOneWidget);
    });
  });

  group('alerts', () {
    PhleboAlert a(String id, AlertKind k, {bool unread = true, String? visit, Duration ago = Duration.zero}) =>
        PhleboAlert(id: id, kind: k, title: 'Title $id', body: 'Body $id', at: now.subtract(ago), unread: unread, visitId: visit);

    testWidgets('grouped Today / Yesterday, newest first, with the new count; tap reports the alert', (t) async {
      PhleboAlert? tapped;
      var all = 0;
      await pumpPhlebo(t, AlertsScreen(alerts: [a('old', AlertKind.handover, ago: const Duration(days: 1), unread: false), a('n1', AlertKind.cancelled, visit: 'v1', ago: const Duration(minutes: 5)), a('n2', AlertKind.assigned)], now: now, onOpen: (x) => tapped = x, onMarkAllRead: () => all++));
      expect(find.text('2 new'), findsOneWidget);
      expect(find.text('Today'), findsOneWidget);
      expect(find.text('Yesterday'), findsOneWidget);
      expect(t.getTopLeft(find.text('Title n2')).dy < t.getTopLeft(find.text('Title n1')).dy, isTrue);
      await tapLabel(t, find.text('Title n1'));
      expect(tapped?.visitId, 'v1');
      await tapLabel(t, find.text('Mark all read'));
      expect(all, 1);
    });

    testWidgets('nothing unread: no "Mark all read"; empty list explains where alerts come from', (t) async {
      await pumpPhlebo(t, AlertsScreen(alerts: [a('x', AlertKind.message, unread: false)], now: now, onOpen: (_) {}, onMarkAllRead: () {}));
      expect(find.text('Mark all read'), findsNothing);
      await pumpPhlebo(t, AlertsScreen(alerts: const [], now: now, onOpen: (_) {}));
      expect(find.text('No alerts'), findsOneWidget);
      expect(find.textContaining('after each sync'), findsOneWidget);
    });
  });

  group('profile, ID card, location', () {
    testWidgets('profile shows who is signed in, the numbers, and every row calls back', (t) async {
      final nav = <String>[];
      await pumpPhlebo(
        t,
        ProfileScreen(
          profile: profile,
          sync: const SyncSummary(waiting: 3),
          onSyncNow: () => nav.add('sync'),
          onOpenIdCard: () => nav.add('id'),
          onOpenHandover: () => nav.add('handover'),
          onOpenOutbox: () => nav.add('outbox'),
          onOpenLocation: () => nav.add('location'),
          onOpenHelp: () => nav.add('help'),
          onOpenSettings: () => nav.add('settings'),
        ),
      );
      expect(find.text('Phlebotomist · STAFF-1'), findsOneWidget);
      expect(find.text('3 changes waiting to upload'), findsOneWidget);
      for (final l in ['Sync now', 'My ID card', 'Handover', 'Outbox', 'Location sharing', 'Help & support', 'Settings and sign out']) {
        await tapLabel(t, find.text(l));
      }
      expect(nav, ['sync', 'id', 'handover', 'outbox', 'location', 'help', 'settings']);
    });

    testWidgets('offline: Sync now is disabled', (t) async {
      await pumpPhlebo(t, ProfileScreen(profile: profile, sync: const SyncSummary(waiting: 0), offline: true, onSyncNow: () {}, onOpenIdCard: () {}, onOpenHandover: () {}, onOpenOutbox: () {}, onOpenLocation: () {}, onOpenHelp: () {}, onOpenSettings: () {}));
      expect(t.widget<LimsButton>(limsButton('Sync now')).onPressed, isNull);
    });

    testWidgets('ID card: name, staff ID and what the patient checks', (t) async {
      await pumpPhlebo(t, const IdCardScreen(profile: profile));
      expect(find.text('Test Staff'), findsOneWidget);
      expect(find.text('STAFF-1'), findsOneWidget);
      expect(find.text('What the patient will check'), findsOneWidget);
    });

    testWidgets('location: granted vs off, off offers the phone settings', (t) async {
      var opened = 0;
      await pumpPhlebo(t, LocationScreen(permission: LocationPermission.granted, onOpenPhoneSettings: () => opened++));
      expect(find.text('Location is on'), findsOneWidget);
      expect(find.text('Open phone settings'), findsNothing);
      await pumpPhlebo(t, LocationScreen(permission: LocationPermission.serviceOff, onOpenPhoneSettings: () => opened++));
      expect(find.text('Location service is off'), findsOneWidget);
      await tapLabel(t, find.text('Open phone settings'));
      expect(opened, 1);
    });
  });

  group('travel card', () {
    testWidgets('before: explains "On my way"; on the way: ETA and live; arrived: sharing ended', (t) async {
      await pumpPhlebo(t, const Scaffold(body: TravelCard(state: TravelState())));
      expect(find.textContaining('Tap "On my way" when you leave'), findsOneWidget);
      await pumpPhlebo(t, const Scaffold(body: TravelCard(state: TravelState(onTheWay: true, etaMin: 9, distanceKm: 1.5, lastShared: '2 s ago'))));
      expect(find.text('9 min'), findsOneWidget);
      expect(find.text('Live · 2 s ago'), findsOneWidget);
      await pumpPhlebo(t, const Scaffold(body: TravelCard(state: TravelState(onTheWay: true), arrived: true)));
      expect(find.text('You are at the address. Location sharing has ended.'), findsOneWidget);
    });

    for (final c in {LocationSharing.delayed: 'Location is a little late', LocationSharing.noSignal: 'No signal', LocationSharing.permissionOff: 'Location is off'}.entries) {
      testWidgets('${c.key.name}: "${c.value}"', (t) async {
        await pumpPhlebo(t, Scaffold(body: TravelCard(state: TravelState(onTheWay: true, sharing: c.key))));
        expect(find.text(c.value), findsOneWidget);
      });
    }
  });

  group('support', () {
    testWidgets('FAQs filter by question and answer; no results has its own state', (t) async {
      await pumpPhlebo(t, const FaqScreen());
      expect(find.text('What if I have no signal?'), findsOneWidget);
      await t.enterText(find.byKey(const ValueKey('faq.search')), 'handover');
      await t.pumpAndSettle();
      expect(find.text('How do I hand tubes over?'), findsOneWidget);
      expect(find.text('What if I have no signal?'), findsNothing);
      await t.enterText(find.byKey(const ValueKey('faq.search')), 'zzzz');
      await t.pumpAndSettle();
      expect(find.text('No answers found'), findsOneWidget);
    });

    testWidgets('help hub opens its three places', (t) async {
      final nav = <String>[];
      await pumpPhlebo(t, HelpScreen(onOpenFaqs: () => nav.add('faq'), onOpenContact: () => nav.add('contact'), onOpenReport: () => nav.add('report')));
      for (final l in ['FAQs', 'Contact dispatch', 'Report a problem']) {
        await tapLabel(t, find.text(l));
      }
      expect(nav, ['faq', 'contact', 'report']);
    });

    testWidgets('contact: call uses the configured number; without a contact it says so and cannot call', (t) async {
      final called = <String>[];
      await pumpPhlebo(t, ContactScreen(contact: const DispatchContact(name: 'Desk', phone: '123'), onCall: called.add, onReport: () {}));
      await tapLabel(t, limsButton('Call dispatch'));
      expect(called, ['123']);
      await pumpPhlebo(t, ContactScreen(contact: null, onCall: called.add, onReport: () {}));
      expect(find.text('No dispatch contact on this phone'), findsOneWidget);
      expect(t.widget<LimsButton>(limsButton('Call dispatch')).onPressed, isNull);
    });

    testWidgets('report: needs a category and some text; shows sent / saved on phone / failed', (t) async {
      final results = [ReportResult.failed, ReportResult.savedOnPhone];
      final sent = <(String, String)>[];
      await pumpPhlebo(t, ReportProblemScreen(onSubmit: (c, d) async {
        sent.add((c, d));
        return results.removeAt(0);
      }));
      expect(t.widget<LimsButton>(limsButton('Send report')).onPressed, isNull);
      await t.enterText(find.byKey(const ValueKey('report.text')), 'The scanner did not read');
      await t.pump();
      expect(t.widget<LimsButton>(limsButton('Send report')).onPressed, isNull, reason: 'no category yet');
      await tapLabel(t, find.text('Tubes or barcodes'));
      await tapLabel(t, limsButton('Send report'));
      expect(find.text("Couldn't send"), findsOneWidget);
      expect((t.widget<TextField>(find.byKey(const ValueKey('report.text'))).controller!.text), 'The scanner did not read', reason: 'text is kept after a failure');
      await tapLabel(t, limsButton('Send report'));
      expect(find.text('Saved on this phone'), findsOneWidget);
      expect(sent, hasLength(2));
      expect(sent.first.$1, 'Tubes or barcodes');
    });
  });

  group('device states and lock', () {
    for (final c in {
      DeviceNotice.wipeRequested: 'This phone will be erased',
      DeviceNotice.wiped: 'This phone was erased',
      DeviceNotice.updateRequired: 'Update the app to continue',
      DeviceNotice.noScreenLock: 'Set a screen lock first',
      DeviceNotice.rooted: "This phone can't be used",
    }.entries) {
      testWidgets('${c.key.name}: "${c.value}" inside LimsSecureScreen', (t) async {
        await pumpPhlebo(t, DeviceNoticeScreen(kind: c.key, onPrimary: () {}));
        expect(find.text(c.value), findsOneWidget);
        expect(find.byType(LimsSecureScreen), findsOneWidget);
      });
    }

    testWidgets('rooted phone has no action at all', (t) async {
      await pumpPhlebo(t, const DeviceNoticeScreen(kind: DeviceNotice.rooted));
      expect(find.byType(LimsButton), findsNothing);
    });

    testWidgets('wipe requested: counts what is still waiting, and the button is off while uploading', (t) async {
      await pumpPhlebo(t, const DeviceNoticeScreen(kind: DeviceNotice.wipeRequested, pendingChanges: 1));
      expect(find.textContaining('1 change is not uploaded yet'), findsOneWidget);
      await pumpPhlebo(t, const DeviceNoticeScreen(kind: DeviceNotice.wipeRequested, uploading: true));
      expect(find.textContaining('Everything is uploaded'), findsOneWidget);
      expect(t.widget<LimsButton>(limsButton('Uploading…')).onPressed, isNull);
    });

    testWidgets('lock: attempts left, then session ended offers only "Sign in again"', (t) async {
      var unlocked = 0, again = 0;
      await pumpPhlebo(t, LockScreen(onUnlock: () => unlocked++, attemptsLeft: 1), settle: false);
      expect(find.text('1 attempt left'), findsOneWidget);
      await t.tap(limsButton('Unlock'));
      expect(unlocked, 1);
      await pumpPhlebo(t, LockScreen(onUnlock: () => unlocked++, sessionEnded: true, onSignInAgain: () => again++), settle: false);
      expect(find.text('Session ended'), findsOneWidget);
      expect(limsButton('Unlock'), findsNothing);
      await t.tap(limsButton('Sign in again'));
      expect(again, 1);
    });
  });

  group('handover receipt', () {
    for (final c in {
      HandoverStatus.pending: 'Waiting for the centre',
      HandoverStatus.confirmed: 'Handover confirmed',
      HandoverStatus.discrepancy: '2 tubes were not found',
    }.entries) {
      testWidgets('${c.key.name}: "${c.value}"', (t) async {
        await pumpPhlebo(t, HandoverReceiptScreen(receipt: HandoverReceipt(centreName: 'Lab', handedOverAt: now, tubes: const ['Serum · …0001'], status: c.key, missingCount: 2), onDone: () {}, onContactDispatch: () {}));
        expect(find.text(c.value), findsOneWidget);
        expect(find.text('Serum · …0001'), findsOneWidget, reason: 'last 4 characters only');
      });
    }

    testWidgets('a missing tube offers "Call dispatch"; the other states do not', (t) async {
      HandoverReceipt r(HandoverStatus s) => HandoverReceipt(centreName: 'Lab', handedOverAt: now, tubes: const [], status: s, missingCount: 1);
      await pumpPhlebo(t, HandoverReceiptScreen(receipt: r(HandoverStatus.discrepancy), onDone: () {}, onContactDispatch: () {}));
      expect(limsButton('Call dispatch'), findsOneWidget);
      await pumpPhlebo(t, HandoverReceiptScreen(receipt: r(HandoverStatus.pending), onDone: () {}, onContactDispatch: () {}));
      expect(limsButton('Call dispatch'), findsNothing);
    });
  });

  group('shell and kit', () {
    testWidgets('tabs switch and keep their state; alerts badge shows the count', (t) async {
      final seen = <PhleboTab>[];
      await pumpPhlebo(t, PhleboShell(alertsBadge: 3, onTabChanged: seen.add, pages: const {PhleboTab.today: Text('page today'), PhleboTab.history: Text('page history'), PhleboTab.alerts: Text('page alerts'), PhleboTab.profile: Text('page profile')}));
      expect(find.text('3'), findsOneWidget);
      await tapLabel(t, find.text('Alerts'));
      await tapLabel(t, find.text('Profile'));
      expect(seen, [PhleboTab.alerts, PhleboTab.profile]);
      expect(find.text('page profile'), findsOneWidget);
    });

    test('initials: two at most, never the whole name; blank is "?"', () {
      expect(initialsOf('Sunita Kumari Khadka'), 'SK');
      expect(initialsOf('  asha '), 'A');
      expect(initialsOf(''), '?');
    });

    test('tube tone follows the container name, with neutral for the unknown', () {
      expect(tubeToneFor('Purple · EDTA'), 'info');
      expect(tubeToneFor('Red · Plain'), 'danger');
      expect(tubeToneFor('Gold · SST gel'), 'warning');
      expect(tubeToneFor('Urine cup'), 'warning');
      expect(tubeToneFor('Grey · Fluoride'), 'neutral');
    });
  });
}
