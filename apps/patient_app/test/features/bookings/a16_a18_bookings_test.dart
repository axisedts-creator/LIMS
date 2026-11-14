// T-BK1 — A16 bookings list and A18 booking detail (04-UI-UX A16/A18; 03-APP-FLOW §11 Bookings row; 01-PRD US-EN-14.1-3; 07-SECURITY AB-6 (404 -> "no longer available" style), REQ-SEC-109).
// Contract: header of test/support/bookings_fakes.dart. Assumed chrome pinned here: A16 empty state "No bookings" + [Book a test] (spec text), A18 buttons "Cancel booking" and "Reschedule", cancel confirm dialog with
// "Yes, cancel" / "Keep booking", the line "You can cancel in the app until {cancellable_until}" (spec text; the date format is not pinned). Synthetic data only.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:patient_app/features/bookings/booking_detail_screen.dart';
import 'package:patient_app/features/bookings/bookings_list_screen.dart';

import '../../support/bookings_fakes.dart';
import '../../support/rig.dart';

Future<void> openList(WidgetTester t, Rig rig, FakeBookingsApi api) async {
  await t.pumpWidget(bookingsScope(rig, api, home: const BookingsListScreen()));
  await settle(t);
}

Future<void> openDetail(WidgetTester t, Rig rig, FakeBookingsApi api, {String id = bk1}) async {
  await t.pumpWidget(bookingsScope(rig, api, home: BookingDetailScreen(bookingId: id)));
  await settle(t);
}

Finder btn(String label) => find.widgetWithText(LimsButton, label);

void main() {
  late Rig rig;
  late FakeBookingsApi api;

  setUp(() async {
    rig = await Rig.create();
    api = FakeBookingsApi();
  });
  tearDown(() => rig.dispose());

  group('A16 list (E34)', () {
    setUp(() {
      api.onBookings = (_) => {
            'data': [
              booking(bk1, no: 'BK26000001'),
              booking(bk2, no: 'BK26000002', status: 'checked_in', kind: 'home_collection', homeAddressId: addr1, centreName: 'Synthetic Home Base'),
              booking(bk3, no: 'BK26000003', status: 'cancelled'),
              booking('01950c16-0000-7000-8000-000000000b04', no: 'BK26000004', status: 'completed'),
            ],
            'page': {'limit': 50},
          };
    });

    testWidgets('one row per booking: booking no., centre or "Home collection", date/time, and a LimsStatusChip with the WORD (Confirmed / Checked in / Completed / Cancelled), no raw codes', (tester) async {
      await openList(tester, rig, api);
      expect(api.listCalls, hasLength(1));
      expect(find.byType(LimsStatusChip), findsNWidgets(4));
      for (final w in ['Confirmed', 'Checked in', 'Completed', 'Cancelled']) {
        expect(find.text(w), findsOneWidget);
      }
      for (final n in ['BK26000001', 'BK26000002', 'BK26000003', 'BK26000004']) {
        expect(find.textContaining(n), findsOneWidget);
      }
      expect(find.text('Synthetic Centre One'), findsWidgets);
      expect(find.text('Home collection'), findsOneWidget, reason: 'a home booking shows "Home collection" instead of a centre');
      for (final raw in ['checked_in', 'centre_visit', 'home_collection', 'confirmed']) {
        expect(find.textContaining(raw), findsNothing);
      }
      expect(find.byType(LimsSecureScreen), findsOneWidget);
    });

    testWidgets('empty list: "No bookings" and a [Book a test] button', (tester) async {
      api.onBookings = (_) => {'data': <Object?>[], 'page': {'limit': 50}};
      await openList(tester, rig, api);
      expect(find.textContaining('No bookings'), findsOneWidget);
      expect(btn('Book a test'), findsOneWidget);
      expect(find.byType(LimsStatusChip), findsNothing);
    });

    testWidgets('[Book a test] opens the wizard (step 1 shows the profiles)', (tester) async {
      api.onBookings = (_) => {'data': <Object?>[], 'page': {'limit': 50}};
      await openList(tester, rig, api);
      await tester.tap(btn('Book a test'));
      await settle(tester);
      expect(find.text('Sita Synthetic'), findsOneWidget);
    });

    testWidgets('error: retry control, no server detail; retry refetches and shows the rows', (tester) async {
      final ok = api.onBookings;
      api.onBookings = (call) => call == 1 ? throw LimsException(LimsErrorCodes.commonInternal, safeDetail: 'db password hunter2') : ok(call);
      await openList(tester, rig, api);
      expect(find.textContaining('hunter2'), findsNothing);
      expect(find.byType(LimsStatusChip), findsNothing);
      await tester.tap(find.textContaining(RegExp('retry|try again', caseSensitive: false)));
      await settle(tester);
      expect(api.listCalls, hasLength(2));
      expect(find.byType(LimsStatusChip), findsNWidgets(4));
    });

    testWidgets('tapping a row opens A18 for that booking (E35 with the id; the booking number is never used as an id)', (tester) async {
      await openList(tester, rig, api);
      await tester.tap(find.textContaining('BK26000001'));
      await settle(tester);
      expect(api.getCalls, [bk1]);
    });

    testWidgets('pull to refresh fetches E34 again', (tester) async {
      await openList(tester, rig, api);
      await tester.fling(find.byType(Scrollable).first, const Offset(0, 400), 1000);
      await tester.pump(const Duration(milliseconds: 100));
      await settle(tester);
      expect(api.listCalls.length, greaterThanOrEqualTo(2));
    });
  });

  group('A18 detail (E35)', () {
    testWidgets('shows booking no., status chip, centre, date/time, items with indicative prices, the cancel-until line and BOTH [Cancel booking] and [Reschedule] while cancellable', (tester) async {
      await openDetail(tester, rig, api);
      expect(api.getCalls, [bk1]);
      expect(find.byType(LimsSecureScreen), findsOneWidget);
      expect(find.textContaining('BK26000001'), findsOneWidget);
      expect(find.text('Confirmed'), findsOneWidget);
      expect(find.text('Synthetic Centre One'), findsOneWidget);
      expect(find.text('Complete Blood Count'), findsOneWidget);
      expect(find.text('Rs. 450.00'), findsWidgets);
      expect(find.textContaining('You can cancel in the app until'), findsOneWidget);
      expect(btn('Cancel booking'), findsOneWidget);
      expect(btn('Reschedule'), findsOneWidget);
      expect(find.byType(LimsButton).evaluate().where((e) => !(e.widget as LimsButton).secondary).length, lessThanOrEqualTo(1), reason: 'one primary button per page (LD-140)');
    });

    testWidgets('past the cutoff (no cancellable_until) neither [Cancel booking] nor [Reschedule] is shown; a cancelled or completed booking offers neither', (tester) async {
      for (final b in [booking(bk1, cancellableUntil: null), booking(bk1, status: 'cancelled'), booking(bk1, status: 'completed')]) {
        api.onGetBooking = (_) => b;
        await openDetail(tester, rig, api);
        expect(btn('Cancel booking'), findsNothing);
        expect(btn('Reschedule'), findsNothing);
        expect(find.textContaining('You can cancel in the app until'), findsNothing);
      }
    });

    testWidgets('home collection: the address text of home_address_id is shown (from E37), not the id', (tester) async {
      api.onGetBooking = (_) => booking(bk1, kind: 'home_collection', homeAddressId: addr1, centreName: 'Synthetic Home Base');
      await openDetail(tester, rig, api);
      expect(find.textContaining('Synthetic Tole 4, Ward 2'), findsOneWidget);
      expect(find.textContaining(addr1), findsNothing);
    });

    testWidgets('404 / unknown booking: friendly "no longer available" style text, no code, no buttons', (tester) async {
      api.onGetBooking = (_) => throw LimsException(LimsErrorCodes.commonNotFound);
      await openDetail(tester, rig, api);
      expect(find.textContaining('common.not_found'), findsNothing);
      expect(btn('Cancel booking'), findsNothing);
      expect(find.byType(LimsStatusChip), findsNothing);
    });

    group('cancel (E36)', () {
      testWidgets('[Cancel booking] asks for confirmation first (LimsConfirmDialog); "Keep booking" sends nothing', (tester) async {
        await openDetail(tester, rig, api);
        await tester.tap(btn('Cancel booking'));
        await settle(tester);
        expect(find.byType(AlertDialog), findsOneWidget);
        await tester.tap(find.descendant(of: find.byType(AlertDialog), matching: find.text('Keep booking')));
        await settle(tester);
        expect(api.cancelCalls, isEmpty);
        expect(find.byType(AlertDialog), findsNothing);
      });

      testWidgets('confirming sends E36 with If-Match = the booking version and an Idempotency-Key; the screen then shows Cancelled with no actions', (tester) async {
        api.onGetBooking = (_) => booking(bk1, version: 4);
        await openDetail(tester, rig, api);
        await tester.tap(btn('Cancel booking'));
        await settle(tester);
        await tester.tap(find.descendant(of: find.byType(AlertDialog), matching: find.text('Yes, cancel')));
        await settle(tester);
        expect(api.cancelCalls, hasLength(1));
        expect(api.cancelCalls.single.id, bk1);
        expect(api.cancelCalls.single.version, 4);
        expect(api.cancelCalls.single.key.length, greaterThanOrEqualTo(16));
        expect(find.text('Cancelled'), findsOneWidget);
        expect(btn('Cancel booking'), findsNothing);
        expect(btn('Reschedule'), findsNothing);
      });

      testWidgets('a retry after a TIMEOUT reuses the same Idempotency-Key', (tester) async {
        api.onCancel = (call, id, version, key) => call == 1 ? throw TimeoutException('synthetic timeout') : booking(id, status: 'cancelled', version: version + 1);
        await openDetail(tester, rig, api);
        for (var i = 0; i < 2; i++) {
          await tester.tap(btn('Cancel booking'));
          await settle(tester);
          await tester.tap(find.descendant(of: find.byType(AlertDialog), matching: find.text('Yes, cancel')));
          await settle(tester);
        }
        expect(api.cancelCalls, hasLength(2));
        expect(api.cancelCalls[1].key, api.cancelCalls[0].key);
        expect(find.text('Cancelled'), findsOneWidget);
      });

      testWidgets('409 booking_not_cancellable: "Too close to the appointment to cancel in the app — call the lab", the booking is refetched, no code shown', (tester) async {
        api.onCancel = (call, id, version, key) => throw LimsException(LimsErrorCodes.engagementBookingNotCancellable);
        await openDetail(tester, rig, api);
        await tester.tap(btn('Cancel booking'));
        await settle(tester);
        await tester.tap(find.descendant(of: find.byType(AlertDialog), matching: find.text('Yes, cancel')));
        await settle(tester);
        expect(find.textContaining('Too close to the appointment to cancel in the app — call the lab'), findsOneWidget);
        expect(find.textContaining('booking_not_cancellable'), findsNothing);
        expect(api.getCalls.length, greaterThanOrEqualTo(2), reason: 'refetch after a conflict');
      });

    });

    testWidgets('[Reschedule] opens the wizard at the slot step for the same centre (E32), without the profile step', (tester) async {
      api.onGetBooking = (_) => booking(bk1, version: 3);
      await openDetail(tester, rig, api);
      await tester.tap(btn('Reschedule'));
      await settle(tester);
      expect(find.byType(LimsSlotPicker), findsOneWidget);
      expect(api.slotCalls.first.centreId, c1);
      expect(find.text('Sita Synthetic'), findsNothing);
    });
  });
}
