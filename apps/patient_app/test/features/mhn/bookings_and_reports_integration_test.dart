import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:patient_app/app/providers.dart';
import 'package:patient_app/features/bookings/booking_detail_screen.dart';
import 'package:patient_app/features/mhn/bookings_screen.dart';
import 'package:patient_app/features/mhn/mhn_theme.dart';
import 'package:patient_app/features/mhn/reports_screen.dart';
import 'package:patient_app/features/orders/order_detail_screen.dart';
import 'package:patient_app/features/orders/orders_providers.dart';
import 'package:patient_app/features/reports/report_viewer_screen.dart';
import 'package:patient_app/features/reports/reports_providers.dart';

import '../../support/auth_fakes.dart' hide settle;
import '../../support/bookings_fakes.dart';
import '../../support/orders_fakes.dart' hide orderId, profileId;
import '../../support/reports_fakes.dart' hide settle;
import '../../support/rig.dart';

void main() {
  late Rig rig;
  late FakeBookingsApi bookingsApi;
  late Host reportsHost;

  setUp(() async {
    rig = await Rig.create();
    bookingsApi = FakeBookingsApi();
    reportsHost = Host(rig);
  });

  tearDown(() => rig.dispose());

  group('MhnBookingsScreen Integration (E34 listMyBookings)', () {
    testWidgets('fetches bookings via E34 and displays upcoming cards', (tester) async {
      bookingsApi.onBookings = (_) => {
        'data': [
          booking(bk1, no: 'BK26000001', status: 'confirmed', kind: 'home_collection'),
          booking(bk2, no: 'BK26000002', status: 'completed'),
          booking(bk3, no: 'BK26000003', status: 'cancelled'),
        ],
        'page': {'limit': 50},
      };

      await tester.pumpWidget(bookingsScope(rig, bookingsApi, home: const MhnBookingsScreen(isTab: true)));
      await settle(tester);

      expect(bookingsApi.listCalls, hasLength(1));
      // By default in 'Upcoming' tab (tab 0)
      expect(find.text('Booking #BK26000001'), findsOneWidget);
      expect(find.text('Home collection'), findsOneWidget);
      expect(find.text('Confirmed'), findsOneWidget);
      // Completed and Cancelled not in Upcoming
      expect(find.text('Booking #BK26000002'), findsNothing);
      expect(find.text('Booking #BK26000003'), findsNothing);
    });

    testWidgets('switches to Past and Cancelled tabs displaying corresponding bookings', (tester) async {
      bookingsApi.onBookings = (_) => {
        'data': [
          booking(bk1, no: 'BK26000001', status: 'confirmed'),
          booking(bk2, no: 'BK26000002', status: 'completed'),
          booking(bk3, no: 'BK26000003', status: 'cancelled'),
        ],
        'page': {'limit': 50},
      };

      await tester.pumpWidget(bookingsScope(rig, bookingsApi, home: const MhnBookingsScreen(isTab: true)));
      await settle(tester);

      // Tap 'Past' tab
      await tester.tap(find.text('Past'));
      await settle(tester);

      expect(find.text('Booking #BK26000002'), findsOneWidget);
      expect(find.text('Completed'), findsOneWidget);
      expect(find.text('Booking #BK26000001'), findsNothing);

      // Tap 'Cancelled' tab
      await tester.tap(find.text('Cancelled'));
      await settle(tester);

      expect(find.text('Booking #BK26000003'), findsOneWidget);
      expect(find.widgetWithText(MhnTag, 'Cancelled'), findsOneWidget);
      expect(find.text('Booking #BK26000002'), findsNothing);
    });

    testWidgets('shows empty state when tab has no matching bookings', (tester) async {
      bookingsApi.onBookings = (_) => {
        'data': <Map<String, Object?>>[],
        'page': {'limit': 50},
      };

      await tester.pumpWidget(bookingsScope(rig, bookingsApi, home: const MhnBookingsScreen(isTab: true)));
      await settle(tester);

      expect(find.text('No bookings yet'), findsOneWidget);
      expect(find.text('Book a test'), findsOneWidget);

      await tester.tap(find.text('Past'));
      await settle(tester);
      expect(find.text('No past bookings'), findsOneWidget);

      await tester.tap(find.text('Cancelled'));
      await settle(tester);
      expect(find.text('No cancelled bookings'), findsOneWidget);
    });

    testWidgets('tapping a booking opens BookingDetailScreen', (tester) async {
      bookingsApi.onBookings = (_) => {
        'data': [
          booking(bk1, no: 'BK26000001', status: 'confirmed'),
        ],
        'page': {'limit': 50},
      };

      await tester.pumpWidget(bookingsScope(rig, bookingsApi, home: const MhnBookingsScreen(isTab: true)));
      await settle(tester);

      await tester.tap(find.text('Booking #BK26000001'));
      await settle(tester);

      expect(find.byType(BookingDetailScreen), findsOneWidget);
    });

    testWidgets('BookingDetailScreen for home collection displays sample guide and timeline explainer', (tester) async {
      bookingsApi.onGetBooking = (_) => booking(
            bk1,
            no: 'BK26000001',
            kind: 'home_collection',
            homeAddressId: addr1,
          );

      await tester.pumpWidget(bookingsScope(
        rig,
        bookingsApi,
        home: const BookingDetailScreen(bookingId: bk1),
      ));
      await settle(tester);

      expect(find.text('Home Collection'), findsOneWidget);
      expect(find.text('Sample guide'), findsOneWidget);
      expect(find.text('Report timeline'), findsOneWidget);
      // PHLEBO-UI-FULL-1: the "integration pending (BLOCKED)" placeholder is gone now that live tracking is wired.
      expect(find.textContaining('Live tracking starts when the phlebotomist is on the way'), findsOneWidget);

      await tester.ensureVisible(find.text('Sample guide'));
      await tester.tap(find.text('Sample guide'));
      await settle(tester);

      expect(find.text('How sample collection works'), findsOneWidget);
      expect(find.text('Got it'), findsOneWidget);
      await tester.tap(find.text('Got it'));
      await settle(tester);
      expect(find.text('How sample collection works'), findsNothing);
    });

    testWidgets('BookingDetailScreen with order_id displays Track Order & Samples button', (tester) async {
      final b = booking(bk1, no: 'BK26000001');
      b['order_id'] = '01950c16-0000-7000-8000-000000000a01';
      bookingsApi.onGetBooking = (_) => b;

      await tester.pumpWidget(bookingsScope(
        rig,
        bookingsApi,
        home: const BookingDetailScreen(bookingId: bk1),
      ));
      await settle(tester);

      expect(find.text('Order Tracking'), findsOneWidget);
      expect(find.text('Track Order & Samples'), findsOneWidget);
    });
  });

  group('MhnReportsScreen Integration (E22 listMyReports)', () {
    testWidgets('fetches reports via E22 and displays report cards', (tester) async {
      reportsHost.api.onList = (_, includeSuperseded) => {
        'data': [
          reportRow(
            id: reportId,
            version: 1,
            kind: 'final',
            panels: ['Complete Blood Count', 'Lipid Panel'],
            smart: true,
          ),
        ],
        'page': {'limit': 50},
      };

      await tester.pumpWidget(reportsHost.scope(const MhnReportsScreen(isTab: true)));
      await settle(tester);

      expect(reportsHost.api.listCalls, hasLength(1));
      expect(find.text('Complete Blood Count, Lipid Panel'), findsOneWidget);
      expect(find.text('Final'), findsOneWidget);
      expect(find.text('Smart'), findsNothing); // Gated per ADR-SCOPE-001 (no unapproved AI medical features)
    });

    testWidgets('toggling "Show older versions" requests include_superseded: true', (tester) async {
      reportsHost.api.onList = (_, includeSuperseded) => {
        'data': [
          reportRow(id: reportId, version: 1, kind: 'final'),
          if (includeSuperseded)
            reportRow(id: reportId2, version: 1, kind: 'superseded', status: 'superseded'),
        ],
        'page': {'limit': 50},
      };

      await tester.pumpWidget(reportsHost.scope(const MhnReportsScreen(isTab: true)));
      await settle(tester);

      expect(reportsHost.api.listCalls.last.includeSuperseded, isFalse);

      await tester.tap(find.byType(Switch));
      await settle(tester);

      expect(reportsHost.api.listCalls.last.includeSuperseded, isTrue);
    });

    testWidgets('shows empty state when no reports exist', (tester) async {
      reportsHost.api.onList = (_, _) => {
        'data': <Map<String, Object?>>[],
        'page': {'limit': 50},
      };

      await tester.pumpWidget(reportsHost.scope(const MhnReportsScreen(isTab: true)));
      await settle(tester);

      expect(find.text('No reports yet'), findsOneWidget);
    });

    testWidgets('tapping a non-smart report opens ReportViewerScreen', (tester) async {
      reportsHost.api.onList = (_, _) => {
        'data': [
          reportRow(id: reportId, version: 1, kind: 'final', smart: false),
        ],
        'page': {'limit': 50},
      };

      await tester.pumpWidget(reportsHost.scope(const MhnReportsScreen(isTab: true)));
      await settle(tester);

      await tester.tap(find.text('Synthetic Lipid Profile'));
      await settle(tester);

      expect(find.byType(ReportViewerScreen), findsOneWidget);
    });

    testWidgets('OrderDetailScreen report item tap navigates to ReportViewerScreen', (tester) async {
      final fakeOrders = FakeOrdersApi();
      const testOrderId = '01950c16-0000-7000-8000-000000000a01';
      const testProfileId = '01950c16-0000-7000-8000-000000000a02';
      fakeOrders.onGet = (_, _) => {
            'order_id': testOrderId,
            'profile_id': testProfileId,
            'registered_at': '2026-03-01T04:15:00.000Z',
            'stage': 'report_ready',
            'payment_due': false,
            'specimen_count': 1,
            'report_count': 1,
            'specimens': [
              {'specimen_ref': 1, 'stage': 'report_ready'},
            ],
            'reports': [
              {
                'report_id': reportId,
                'version_no': 1,
                'order_id': testOrderId,
                'kind': 'final',
                'status': 'valid',
                'released_at': '2026-03-01T08:00:00.000Z',
                'panel_names': ['Complete Blood Count'],
              },
            ],
            'etag': '"1.1.1"',
          };

      await tester.pumpWidget(ProviderScope(
        overrides: [
          flavourProvider.overrideWithValue(alphaFlavour()),
          sessionControllerProvider.overrideWithValue(rig.controller),
          patientOrdersApiProvider.overrideWithValue(fakeOrders),
          patientReportsApiProvider.overrideWithValue(reportsHost.api),
          secureTempFilesProvider.overrideWithValue(rig.temp),
          reportSharerProvider.overrideWithValue(reportsHost.sharer),
          reportViewerBuilderProvider.overrideWithValue(reportsHost.viewer.build),
        ],
        child: MaterialApp(
          theme: LimsTheme.light(),
          home: const OrderDetailScreen(orderId: testOrderId),
        ),
      ));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text('Final report'), findsOneWidget);
      await tester.tap(find.text('Final report'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.byType(ReportViewerScreen), findsOneWidget);
    });

    testWidgets('BookingDetailScreen displays assigned collector name and tracking status chip', (tester) async {
      final b = booking(bk1, no: 'BK26000001', kind: 'home_collection');
      b['tracking'] = {
        'tracking_status': 'collector_assigned',
        'location_status': 'delayed',
        'status_message': 'Phlebotomist assigned. Live GPS tracking will begin when en route.',
        'collector_display_name': 'Ramesh Sharma',
        'eta_available': true,
        'eta_minutes': 25,
      };
      bookingsApi.onGetBooking = (_) => b;

      await tester.pumpWidget(bookingsScope(
        rig,
        bookingsApi,
        home: const BookingDetailScreen(bookingId: bk1),
      ));
      await settle(tester);

      expect(find.text('Home Collection'), findsOneWidget);
      expect(find.text('Phlebotomist assigned'), findsOneWidget);
      expect(find.text('Phlebotomist: Ramesh Sharma'), findsOneWidget);
      expect(find.text('Phlebotomist assigned. Live GPS tracking will begin when en route.'), findsOneWidget);
      expect(find.text('Estimated arrival in 25 min'), findsOneWidget);
    });

    testWidgets('OrderDetailScreen displays multi-specimen tracking and recollection alert without exposing clinical codes (US-EN-07.4)', (tester) async {
      final fakeOrders = FakeOrdersApi();
      const testOrderId = '01950c16-0000-7000-8000-000000000a01';
      const testProfileId = '01950c16-0000-7000-8000-000000000a02';
      fakeOrders.onGet = (_, _) => {
            'order_id': testOrderId,
            'profile_id': testProfileId,
            'registered_at': '2026-03-01T04:15:00.000Z',
            'stage': 'recollection_needed',
            'payment_due': false,
            'specimen_count': 2,
            'report_count': 0,
            'specimens': [
              {
                'specimen_ref': 1,
                'stage': 'sample_collected',
                'collected_at': '2026-03-01T04:30:00.000Z',
              },
              {
                'specimen_ref': 2,
                'stage': 'recollection_needed',
              },
            ],
            'reports': <Map<String, Object?>>[],
            'etag': '"1.1.2"',
          };

      await tester.pumpWidget(ProviderScope(
        overrides: [
          flavourProvider.overrideWithValue(alphaFlavour()),
          sessionControllerProvider.overrideWithValue(rig.controller),
          patientOrdersApiProvider.overrideWithValue(fakeOrders),
          patientReportsApiProvider.overrideWithValue(reportsHost.api),
          secureTempFilesProvider.overrideWithValue(rig.temp),
          reportSharerProvider.overrideWithValue(reportsHost.sharer),
          reportViewerBuilderProvider.overrideWithValue(reportsHost.viewer.build),
        ],
        child: MaterialApp(
          theme: LimsTheme.light(),
          home: const OrderDetailScreen(orderId: testOrderId),
        ),
      ));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text('New sample needed — the lab will contact you'), findsOneWidget);
      expect(find.text('Samples'), findsOneWidget);
      expect(find.textContaining('Sample 1'), findsOneWidget);
      expect(find.textContaining('Sample 2'), findsOneWidget);
      // No internal rejection codes or specimen tube types leaked (US-EN-07.4)
      expect(find.textContaining('HEMOLYZED'), findsNothing);
      expect(find.textContaining('EDTA'), findsNothing);
    });

    testWidgets('BookingDetailScreen displays reassigned status chip and updates collector info (S30g)', (tester) async {
      final b = booking(bk1, no: 'BK26000001', kind: 'home_collection');
      b['tracking'] = {
        'tracking_status': 'reassigned',
        'location_status': 'waiting_for_location',
        'status_message': 'Phlebotomist reassigned. Updating live tracking details.',
        'collector_display_name': 'Suresh Shrestha',
        'reassigned': true,
        'eta_available': false,
      };
      bookingsApi.onGetBooking = (_) => b;

      await tester.pumpWidget(bookingsScope(
        rig,
        bookingsApi,
        home: const BookingDetailScreen(bookingId: bk1),
      ));
      await settle(tester);

      expect(find.text('Phlebotomist reassigned'), findsOneWidget);
      expect(find.text('Phlebotomist: Suresh Shrestha'), findsOneWidget);
      expect(find.text('Phlebotomist reassigned. Updating live tracking details.'), findsOneWidget);
    });

    testWidgets('BookingDetailScreen displays offline retry chip when refresh fails while holding last known booking (S30e/f)', (tester) async {
      var callCount = 0;
      final b = booking(bk1, no: 'BK26000001', kind: 'home_collection');
      b['tracking'] = {
        'tracking_status': 'en_route',
        'location_status': 'delayed',
        'status_message': 'Phlebotomist is on the way to your address.',
        'collector_display_name': 'Ramesh Sharma',
      };

      bookingsApi.onGetBooking = (_) {
        callCount++;
        if (callCount == 1) return b;
        throw LimsException('common.network_error');
      };

      await tester.pumpWidget(bookingsScope(
        rig,
        bookingsApi,
        home: const BookingDetailScreen(bookingId: bk1),
      ));
      await settle(tester);

      expect(find.text('Phlebotomist is on the way to your address.'), findsOneWidget);

      // Advance periodic timer to trigger a failed background refresh
      await tester.pump(const Duration(seconds: 30));
      await tester.pumpAndSettle();

      // Last known booking is preserved and offline indicator is shown
      expect(find.text('Phlebotomist is on the way to your address.'), findsOneWidget);
      expect(find.text('Offline — tracking paused'), findsOneWidget);
      expect(find.text('Your device is offline. Live location tracking is paused until connection is restored.'), findsOneWidget);
      expect(find.text('Could not refresh. Showing the last update.'), findsOneWidget);
    });
  });
}
