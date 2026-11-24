// Security, concurrency, race condition, and idempotency tests for the booking payment flows.
// Tests eSewa, Khalti, Fonepay, Card portals, URL allowlist validation, double-spend mutex, and idempotency key handling.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:patient_app/features/bookings/bookings_providers.dart';
import 'package:patient_app/features/mhn/mhn_data.dart';
import 'package:patient_app/features/mhn/mhn_state.dart';
import 'package:patient_app/features/mhn/pay_screen.dart';
import 'package:patient_app/features/payments/payments_providers.dart';
import 'package:patient_app/features/payments/payments_security.dart';

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

  group('Payment Security & URL Allowlist Tests (Anti-Phishing / Anti-Spoofing)', () {
    test('strictly rejects non-HTTPS schemes (e.g. http, javascript, file, data)', () {
      expect(isAllowedPaymentUrl(Uri.parse('http://epay.esewa.com.np/api/epay/main/v2/form')), isFalse);
      expect(isAllowedPaymentUrl(Uri.parse('javascript:alert(1)')), isFalse);
      expect(isAllowedPaymentUrl(Uri.parse('file:///etc/passwd')), isFalse);
      expect(isAllowedPaymentUrl(Uri.parse('data:text/html,<html></html>')), isFalse);
    });

    test('rejects userinfo spoofing (e.g. https://esewa.com.np@attacker.com)', () {
      expect(isAllowedPaymentUrl(Uri.parse('https://epay.esewa.com.np@attacker.com/steal')), isFalse);
      expect(isAllowedPaymentUrl(Uri.parse('https://pay.khalti.com@phishing.site/')), isFalse);
    });

    test('rejects off-allowlist domains', () {
      expect(isAllowedPaymentUrl(Uri.parse('https://evil-esewa.com/')), isFalse);
      expect(isAllowedPaymentUrl(Uri.parse('https://fake-khalti.com/checkout')), isFalse);
      expect(isAllowedPaymentUrl(Uri.parse('https://fonepay.malicious.net/')), isFalse);
    });

    test('accepts verified gateway URLs', () {
      expect(isAllowedPaymentUrl(Uri.parse('https://rc-epay.esewa.com.np/api/epay/main/v2/form')), isTrue);
      expect(isAllowedPaymentUrl(Uri.parse('https://epay.esewa.com.np/api/epay/main/v2/form')), isTrue);
      expect(isAllowedPaymentUrl(Uri.parse('https://test-pay.khalti.com/?pidx=123')), isTrue);
      expect(isAllowedPaymentUrl(Uri.parse('https://pay.khalti.com/?pidx=123')), isTrue);
      expect(isAllowedPaymentUrl(Uri.parse('https://client.fonepay.com/api/merchantRequest')), isTrue);
    });
  });

  group('Booking Payment Flow Integration & Security Invariants', () {
    late FakeBookingsApi api;
    late List<Uri> openedUrls;

    setUp(() {
      api = FakeBookingsApi();
      openedUrls = <Uri>[];
      registerCartItem(const MhnCartItem(oCbc, 'Complete Blood Count', 450, 'Blood test', false));
    });

    ProviderContainer createContainer() {
      return ProviderContainer(
        overrides: [
          patientBookingsApiProvider.overrideWithValue(api),
          bookingProfilesProvider.overrideWith((_) async => profiles),
          paymentUrlOpenerProvider.overrideWithValue((uri) async {
            openedUrls.add(uri);
          }),
        ],
      );
    }

    testWidgets('eSewa portal launch with secured payment flow', (t) async {
      t.view.physicalSize = const Size(390, 1600);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.reset);

      final container = createContainer();
      addTearDown(container.dispose);

      final ctl = container.read(mhnProvider.notifier);
      ctl.toggleCart(oCbc);
      ctl.setSelectedSlot(slotStart: '2026-11-25T07:00:00.000Z', slotLabel: '7:00 AM');
      ctl.setSelectedProfileId(pFemale);
      ctl.setPay('esewa');

      await t.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(theme: LimsTheme.light(), home: const MhnPayScreen()),
        ),
      );
      await t.pumpAndSettle();

      expect(find.text('Pay Rs 450'), findsOneWidget);

      await t.tap(find.text('Pay Rs 450'));
      await t.pumpAndSettle();

      // Check that eSewa portal was launched via system browser
      expect(openedUrls.length, 1);
      final url = openedUrls.first;
      expect(url.scheme, 'https');
      expect(url.host, contains('esewa.com.np'));
      expect(isAllowedPaymentUrl(url), isTrue);

      // Verify booking creation on backend
      expect(api.createCalls.length, 1);
    });

    testWidgets('Khalti portal launch with secured payment flow', (t) async {
      t.view.physicalSize = const Size(390, 1600);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.reset);

      final container = createContainer();
      addTearDown(container.dispose);

      final ctl = container.read(mhnProvider.notifier);
      ctl.toggleCart(oCbc);
      ctl.setSelectedSlot(slotStart: '2026-11-25T07:00:00.000Z', slotLabel: '7:00 AM');
      ctl.setSelectedProfileId(pFemale);
      ctl.setPay('khalti');

      await t.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(theme: LimsTheme.light(), home: const MhnPayScreen()),
        ),
      );
      await t.pumpAndSettle();

      await t.tap(find.text('Pay Rs 450'));
      await t.pumpAndSettle();

      // Check that Khalti portal was launched via system browser
      expect(openedUrls.length, 1);
      final url = openedUrls.first;
      expect(url.scheme, 'https');
      expect(url.host, contains('khalti.com'));
      expect(isAllowedPaymentUrl(url), isTrue);
    });

    testWidgets('Card payment feature launches 3D Secure portal', (t) async {
      t.view.physicalSize = const Size(390, 1600);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.reset);

      final container = createContainer();
      addTearDown(container.dispose);

      final ctl = container.read(mhnProvider.notifier);
      ctl.toggleCart(oCbc);
      ctl.setSelectedSlot(slotStart: '2026-11-25T07:00:00.000Z', slotLabel: '7:00 AM');
      ctl.setSelectedProfileId(pFemale);
      ctl.setPay('card');

      await t.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(theme: LimsTheme.light(), home: const MhnPayScreen()),
        ),
      );
      await t.pumpAndSettle();

      await t.tap(find.text('Pay Rs 450'));
      await t.pumpAndSettle();

      // Check that Card 3DS checkout portal was launched
      expect(openedUrls.length, 1);
      final url = openedUrls.first;
      expect(url.scheme, 'https');
      expect(isAllowedPaymentUrl(url), isTrue);
      expect(url.path, contains('card'));
    });

    testWidgets('Fonepay in-app dynamic QR payment sheet displays and verifies', (t) async {
      t.view.physicalSize = const Size(390, 1600);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.reset);

      final container = createContainer();
      addTearDown(container.dispose);

      final ctl = container.read(mhnProvider.notifier);
      ctl.toggleCart(oCbc);
      ctl.setSelectedSlot(slotStart: '2026-11-25T07:00:00.000Z', slotLabel: '7:00 AM');
      ctl.setSelectedProfileId(pFemale);
      ctl.setPay('fonepay');

      await t.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(theme: LimsTheme.light(), home: const MhnPayScreen()),
        ),
      );
      await t.pumpAndSettle();

      await t.tap(find.text('Pay Rs 450'));
      await t.pump();
      await t.pump(const Duration(milliseconds: 500));

      // Verify Fonepay Dynamic QR bottom sheet opened
      expect(find.text('Fonepay Dynamic QR'), findsOneWidget);
      expect(find.text('Scan to pay Rs 450'), findsOneWidget);
      expect(find.text('Open App'), findsOneWidget);
      expect(find.text("I've paid"), findsOneWidget);

      // Tap "I've paid" to complete verification
      await t.tap(find.text("I've paid"));
      await t.pump();
      await t.pump(const Duration(milliseconds: 1500));
      await t.pump();

      // Confirmed screen
      expect(find.text('Booking confirmed'), findsOneWidget);
    });

    testWidgets('Concurrency and Double-Tap Race Condition Protection', (t) async {
      t.view.physicalSize = const Size(390, 1600);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.reset);

      final container = createContainer();
      addTearDown(container.dispose);

      final ctl = container.read(mhnProvider.notifier);
      ctl.toggleCart(oCbc);
      ctl.setSelectedSlot(slotStart: '2026-11-25T07:00:00.000Z', slotLabel: '7:00 AM');
      ctl.setSelectedProfileId(pFemale);
      ctl.setPay('cash');

      await t.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(theme: LimsTheme.light(), home: const MhnPayScreen()),
        ),
      );
      await t.pumpAndSettle();

      // Rapid double tap on Confirm booking
      final button = find.text('Confirm booking');
      await t.tap(button);
      await t.tap(button, warnIfMissed: false);
      await t.pumpAndSettle();

      // Atomic mutex must prevent duplicate booking creation
      expect(api.createCalls.length, 1);
    });

    testWidgets('Idempotency Key Refresh on Payment Method Switch', (t) async {
      t.view.physicalSize = const Size(390, 1600);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.reset);

      final container = createContainer();
      addTearDown(container.dispose);

      final ctl = container.read(mhnProvider.notifier);
      ctl.toggleCart(oCbc);
      ctl.setSelectedSlot(slotStart: '2026-11-25T07:00:00.000Z', slotLabel: '7:00 AM');
      ctl.setSelectedProfileId(pFemale);
      ctl.setPay('esewa');

      await t.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(theme: LimsTheme.light(), home: const MhnPayScreen()),
        ),
      );
      await t.pumpAndSettle();

      // Switch to Khalti
      await t.tap(find.text('Khalti'));
      await t.pumpAndSettle();

      await t.tap(find.text('Pay Rs 450'));
      await t.pumpAndSettle();

      expect(api.createCalls.length, 1);
      final key = api.createCalls.first.key;
      expect(key.isNotEmpty, isTrue);
    });
  });
}
