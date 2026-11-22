// Integration tests for the complete MHN patient booking vertical slice:
// Test Selection -> Cart -> Patient Selection -> Collection Method -> Address -> Available Slots -> Review -> Booking Confirmation (E30, E13, E31, E37, E32, E33).
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:patient_app/features/bookings/bookings_providers.dart';
import 'package:patient_app/features/mhn/book_screen.dart';
import 'package:patient_app/features/mhn/cart_screen.dart';
import 'package:patient_app/features/mhn/mhn_state.dart';
import 'package:patient_app/features/mhn/pay_screen.dart';

import '../../support/bookings_fakes.dart';

Future<void> loadPoppins() async {
  final loader = FontLoader('Poppins');
  for (final f in ['Regular', 'Medium', 'SemiBold', 'Bold']) {
    final file = File('../../packages/ui-flutter/assets/fonts/Poppins-$f.ttf');
    if (file.existsSync()) {
      loader.addFont(Future.value(ByteData.sublistView(file.readAsBytesSync())));
    }
  }
  await loader.load();
}

void main() {
  setUpAll(loadPoppins);

  late FakeBookingsApi api;

  setUp(() {
    api = FakeBookingsApi();
  });

  group('Booking vertical slice E13-E38', () {
    testWidgets('complete home collection booking journey: selection -> cart -> who -> address -> slot -> quote review -> E33 201 confirmed', (t) async {
      t.view.physicalSize = const Size(390, 1600);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.reset);

      // Pre-seed cart with server items
      registerCartItem(const MhnCartItem(oCbc, 'Complete Blood Count', 450, 'Blood test', false));
      registerCartItem(const MhnCartItem(oGlu, 'Glucose Fasting', 200, 'Fasting test', false));

      final container = ProviderContainer(
        overrides: [
          patientBookingsApiProvider.overrideWithValue(api),
          bookingProfilesProvider.overrideWith((_) async => profiles),
        ],
      );
      addTearDown(container.dispose);

      container.read(mhnProvider.notifier).toggleCart(oCbc);
      container.read(mhnProvider.notifier).toggleCart(oGlu);

      await t.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(theme: LimsTheme.light(), home: const MhnCartScreen()),
        ),
      );
      await t.pumpAndSettle();

      // Cart screen displays items and estimated total
      expect(find.text('Complete Blood Count'), findsOneWidget);
      expect(find.text('Glucose Fasting'), findsOneWidget);
      expect(find.text('Estimated total'), findsOneWidget);
      expect(find.text('Rs 650'), findsWidgets);

      // Tap Choose date & time -> opens MhnBookScreen
      await t.tap(find.text('Choose date & time'));
      await t.pumpAndSettle();

      expect(find.text('Book collection'), findsOneWidget);

      // Patient selection (E13): Sita Synthetic, Ram Synthetic, Hari Synthetic
      expect(find.text('Sita Synthetic (you)'), findsOneWidget);
      expect(find.text('Ram Synthetic'), findsOneWidget);

      // Saved address from E37
      expect(find.textContaining('Synthetic Tole 4'), findsWidgets);

      // Available slots from E32
      expect(api.slotCalls.isNotEmpty, isTrue);
      expect(find.text('Time slot'), findsOneWidget);

      // Select first available slot
      final slotChip = find.textContaining('AM').first;
      await t.tap(slotChip);
      await t.pumpAndSettle();

      // Tap Review & pay -> opens MhnPayScreen
      await t.tap(find.text('Review & pay'));
      await t.pumpAndSettle();

      expect(find.text('Review & pay'), findsWidgets);
      expect(find.text('Complete Blood Count'), findsOneWidget);
      expect(find.text('Total quote'), findsOneWidget);
      expect(find.text('Rs 650'), findsWidgets);

      // Choose Pay on collection
      await t.tap(find.text('Pay on collection'));
      await t.pumpAndSettle();

      expect(find.text('Confirm booking'), findsOneWidget);

      // Confirm booking -> triggers E33 createBooking
      await t.tap(find.text('Confirm booking'));
      await t.pumpAndSettle();

      // Verify E33 call parameters
      expect(api.createCalls.length, 1);
      final createCall = api.createCalls.single;
      expect(createCall.body['booking_kind'], 'home_collection');
      expect(createCall.body['orderable_ids'], [oCbc, oGlu]);
      expect(createCall.body['profile_id'], pFemale);
      expect(createCall.key.isNotEmpty, isTrue);

      // Lands on Confirmed screen with server Booking ID
      expect(find.text('Booking confirmed'), findsOneWidget);
      expect(find.textContaining('BK26000001'), findsOneWidget);
      expect(container.read(mhnProvider).cart, isEmpty);
    });

    testWidgets('centre visit booking journey: centre selection -> slot -> review -> E33 with centre_id', (t) async {
      t.view.physicalSize = const Size(390, 1600);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.reset);

      registerCartItem(const MhnCartItem(oCbc, 'Complete Blood Count', 450, 'Blood test', false));

      final container = ProviderContainer(
        overrides: [
          patientBookingsApiProvider.overrideWithValue(api),
          bookingProfilesProvider.overrideWith((_) async => profiles),
        ],
      );
      addTearDown(container.dispose);

      container.read(mhnProvider.notifier).toggleCart(oCbc);

      await t.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(theme: LimsTheme.light(), home: const MhnBookScreen()),
        ),
      );
      await t.pumpAndSettle();

      // Switch to Centre visit
      await t.tap(find.text('Centre visit'));
      await t.pumpAndSettle();

      // Verify centres loaded from E31
      expect(api.centreCalls, contains('centre_visit'));
      expect(find.text('Synthetic Centre One'), findsOneWidget);

      // Select slot
      final slotChip = find.textContaining('AM').first;
      await t.tap(slotChip);
      await t.pumpAndSettle();

      // Proceed to review
      await t.tap(find.text('Review & pay'));
      await t.pumpAndSettle();

      // Confirm
      await t.tap(find.text('Pay on collection'));
      await t.pumpAndSettle();
      await t.tap(find.text('Confirm booking'));
      await t.pumpAndSettle();

      expect(api.createCalls.length, 1);
      final call = api.createCalls.single;
      expect(call.body['booking_kind'], 'centre_visit');
      expect(call.body['centre_id'], c1);
      expect(call.body.containsKey('home_address_id'), isFalse);
    });

    testWidgets('slot conflict error (409) displays error notice and allows slot recovery', (t) async {
      t.view.physicalSize = const Size(390, 1600);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.reset);

      registerCartItem(const MhnCartItem(oCbc, 'Complete Blood Count', 450, 'Blood test', false));

      api.onCreate = (call, body, key) {
        throw LimsException(LimsErrorCodes.engagementSlotUnavailable);
      };

      final container = ProviderContainer(
        overrides: [
          patientBookingsApiProvider.overrideWithValue(api),
          bookingProfilesProvider.overrideWith((_) async => profiles),
        ],
      );
      addTearDown(container.dispose);

      container.read(mhnProvider.notifier).toggleCart(oCbc);
      container.read(mhnProvider.notifier).setSelectedProfileId(pFemale);
      container.read(mhnProvider.notifier).setSelectedSlot(
        slotStart: '2026-11-23T02:00:00.000Z',
        slotLabel: '7:45 AM',
      );

      await t.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(theme: LimsTheme.light(), home: const MhnPayScreen()),
        ),
      );
      await t.pumpAndSettle();

      // Tap Confirm booking
      await t.tap(find.text('Pay on collection'));
      await t.pumpAndSettle();
      await t.tap(find.text('Confirm booking'));
      await t.pumpAndSettle();

      // Verify conflict banner appears
      expect(find.textContaining('That time was just taken'), findsOneWidget);
      expect(find.text('Change slot'), findsOneWidget);
    });

    for (final width in [360.0, 390.0, 430.0]) {
      testWidgets('responsive layout on width $width px and 1.3x text scale without overflow', (t) async {
        t.view.physicalSize = Size(width, 1400);
        t.view.devicePixelRatio = 1;
        addTearDown(t.view.reset);

        registerCartItem(const MhnCartItem(oCbc, 'Complete Blood Count', 450, 'Blood test', false));

        final container = ProviderContainer(
          overrides: [
            patientBookingsApiProvider.overrideWithValue(api),
            bookingProfilesProvider.overrideWith((_) async => profiles),
          ],
        );
        addTearDown(container.dispose);
        container.read(mhnProvider.notifier).toggleCart(oCbc);

        await t.pumpWidget(
          UncontrolledProviderScope(
            container: container,
            child: MediaQuery(
              data: MediaQueryData(size: Size(width, 1400), textScaler: const TextScaler.linear(1.3)),
              child: MaterialApp(theme: LimsTheme.light(), home: const MhnBookScreen()),
            ),
          ),
        );
        await t.pumpAndSettle();

        expect(t.takeException(), isNull);
        expect(find.text('Book collection'), findsOneWidget);
      });
    }
  });
}
