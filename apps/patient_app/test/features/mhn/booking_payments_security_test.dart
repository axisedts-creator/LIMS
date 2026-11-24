// Security, concurrency, race condition, and idempotency tests for the booking payment flows.
// Tests eSewa, Khalti, Fonepay, Card portals, URL allowlist validation, double-spend mutex, and idempotency key handling.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:patient_app/features/bookings/bookings_providers.dart';
import 'package:patient_app/features/mhn/fonepay_modal.dart';
import 'package:patient_app/features/mhn/mhn_data.dart';
import 'package:patient_app/features/mhn/mhn_state.dart';
import 'package:patient_app/features/mhn/pay_screen.dart';
import 'package:patient_app/features/payments/payments_api.dart';
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

class FakePaymentsApi implements PatientPaymentsApi {
  final List<({String orderId, String gateway, String idempotencyKey})> calls = [];
  Object? response;

  @override
  Future<Object?> createPaymentRequest({required String orderId, required String gateway, required String idempotencyKey}) async {
    calls.add((orderId: orderId, gateway: gateway, idempotencyKey: idempotencyKey));
    return response ?? {
      'id': '01950c16-0000-7000-8000-000000000068',
      'order_id': orderId,
      'gateway': gateway,
      'status': 'ready',
      'action': {'kind': 'redirect', 'url': 'https://pay.khalti.com/?pidx=SERVER_KHALTI_PIDX_AUTH'},
    };
  }

  @override
  Future<Object?> getPaymentRequest({required String paymentRequestId}) async {
    return {'id': paymentRequestId, 'status': 'completed'};
  }
}

void main() {
  setUpAll(loadPoppins);

  group('Payment Security & URL Allowlist Tests (Anti-Phishing / Anti-Spoofing)', () {
    test('strictly rejects non-HTTPS schemes (e.g. http, javascript, file, data, blob, ws, ftp)', () {
      final invalidSchemeUrls = [
        'http://epay.esewa.com.np/api/epay/main/v2/form',
        'javascript:alert(1)',
        'file:///etc/passwd',
        'data:text/html,<html></html>',
        'blob:https://esewa.com.np/uuid',
        'ftp://pay.khalti.com/',
        'ws://client.fonepay.com/',
        'wss://pay.khalti.com/',
        'intent://pay.khalti.com#Intent;scheme=https;package=com.khalti;end',
      ];
      for (final raw in invalidSchemeUrls) {
        expect(isAllowedPaymentUrl(Uri.parse(raw)), isFalse, reason: 'Failed to reject $raw');
      }
    });

    test('rejects userinfo spoofing (e.g. credentials embedded before @)', () {
      final spoofUrls = [
        'https://epay.esewa.com.np@attacker.com/steal',
        'https://pay.khalti.com@phishing.site/',
        'https://user:password@rc-epay.esewa.com.np/form',
        'https://token@pay.khalti.com/',
        'https://admin:secret@client.fonepay.com/',
      ];
      for (final raw in spoofUrls) {
        expect(isAllowedPaymentUrl(Uri.parse(raw)), isFalse, reason: 'Failed to reject $raw');
      }
    });

    test('rejects non-standard ports on production gateways', () {
      final badPortUrls = [
        'https://rc-epay.esewa.com.np:8080/api/epay/main/v2/form',
        'https://pay.khalti.com:8443/',
        'https://client.fonepay.com:3000/api',
      ];
      for (final raw in badPortUrls) {
        expect(isAllowedPaymentUrl(Uri.parse(raw)), isFalse, reason: 'Failed to reject non-standard port $raw');
      }
    });

    test('rejects off-allowlist domains, subdomains of attacker domains, and suffix tricks', () {
      final badDomains = [
        'https://evil-esewa.com/',
        'https://fake-khalti.com/checkout',
        'https://fonepay.malicious.net/',
        'https://epay.esewa.com.np.attacker.com/steal',
        'https://pay.khalti.com.evil.co/',
        'https://client.fonepay.com.hack.org/',
        'https://not-khalti.com/',
        'https://fakefonepay.com/',
        'https://evillims.internal/v1/payments/launch/123',
        'https://metrolabs.com.np.attacker.com/v1/payments/launch/123',
      ];
      for (final raw in badDomains) {
        expect(isAllowedPaymentUrl(Uri.parse(raw)), isFalse, reason: 'Failed to reject $raw');
      }
    });

    test('rejects path traversal attacks on launch proxy routes', () {
      expect(isAllowedPaymentUrl(Uri.parse('https://lims.internal/v1/payments/launch/../../etc/passwd')), isFalse);
      expect(isAllowedPaymentUrl(Uri.parse('https://metrolabs.com.np/v1/payments/launch/../admin')), isFalse);
    });

    test('rejects null, empty, whitespace, and hostless URIs', () {
      expect(isAllowedPaymentUrl(null), isFalse);
      expect(isAllowedPaymentUrl(Uri.parse('')), isFalse);
      expect(isAllowedPaymentUrl(Uri.parse('https://')), isFalse);
      expect(isAllowedPaymentUrl(Uri.parse('https:///path')), isFalse);
    });

    test('accepts verified gateway URLs', () {
      expect(isAllowedPaymentUrl(Uri.parse('https://rc-epay.esewa.com.np/api/epay/main/v2/form')), isTrue);
      expect(isAllowedPaymentUrl(Uri.parse('https://epay.esewa.com.np/api/epay/main/v2/form')), isTrue);
      expect(isAllowedPaymentUrl(Uri.parse('https://test-pay.khalti.com/?pidx=123')), isTrue);
      expect(isAllowedPaymentUrl(Uri.parse('https://pay.khalti.com/?pidx=123')), isTrue);
      expect(isAllowedPaymentUrl(Uri.parse('https://client.fonepay.com/api/merchantRequest')), isTrue);
      expect(isAllowedPaymentUrl(Uri.parse('https://lims.internal/v1/payments/launch/secret-tok')), isTrue);
      expect(isAllowedPaymentUrl(Uri.parse('https://metrolabs.com.np/v1/payments/launch/secret-tok')), isTrue);
      expect(isAllowedPaymentUrl(Uri.parse('http://localhost:4000/v1/payments/launch/tok')), isTrue);
      expect(isAllowedPaymentUrl(Uri.parse('http://127.0.0.1:4000/v1/payments/launch/tok')), isTrue);
    });

    test('Fonepay EMVCo MPM QR format conforms to Nepal QR specification', () {
      final qr = buildFonepayEmvcoQr(
        merchantId: 'METROLABS',
        merchantName: 'METRO LABS',
        bookingNo: 'BK26000001',
        amountRupees: 450,
      );
      // Format Indicator (000201) and Dynamic QR (010212)
      expect(qr.startsWith('000201010212'), isTrue);
      // Fonepay merchant identification
      expect(qr.contains('NP.COM.FONEPAY'), isTrue);
      expect(qr.contains('METROLABS'), isTrue);
      // NPR ISO 4217 Currency (5303524)
      expect(qr.contains('5303524'), isTrue);
      // Amount tag 54 with length 03 and value 450 (5403450)
      expect(qr.contains('5403450'), isTrue);
      // Booking reference in tag 62 (Additional Data)
      expect(qr.contains('BK26000001'), isTrue);
      // Ends with 4-hex CRC16 checksum
      expect(qr, matches(r'6304[0-9A-F]{4}$'));
    });
  });

  group('Booking Payment Flow Integration & Security Invariants', () {
    late FakeBookingsApi api;
    late List<Uri> openedUrls;
    late FakePaymentsApi paymentsApi;

    setUp(() {
      api = FakeBookingsApi();
      paymentsApi = FakePaymentsApi();
      openedUrls = <Uri>[];
      registerCartItem(const MhnCartItem(oCbc, 'Complete Blood Count', 450, 'Blood test', false));
    });

    ProviderContainer createContainer({FakePaymentsApi? payments}) {
      return ProviderContainer(
        overrides: [
          patientBookingsApiProvider.overrideWithValue(api),
          bookingProfilesProvider.overrideWith((_) async => profiles),
          patientPaymentsApiProvider.overrideWithValue(payments ?? paymentsApi),
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

    testWidgets('Aggressive 20-tap simultaneous burst race condition test on online portal', (t) async {
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

      final payButton = find.text('Pay Rs 450');
      // Fire 20 rapid taps in succession before the asynchronous frame resolves
      for (var i = 0; i < 20; i++) {
        await t.tap(payButton, warnIfMissed: false);
      }
      await t.pumpAndSettle();

      // Exactly ONE booking creation call must be made
      expect(api.createCalls.length, 1);
      // Exactly ONE payment URL must be launched
      expect(openedUrls.length, 1);
    });

    testWidgets('Idempotency key is strictly retained when retrying after a failure', (t) async {
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

      var shouldFail = true;
      api.onCreate = (call, body, key) {
        if (shouldFail) {
          throw LimsException(LimsErrorCodes.engagementSlotUnavailable);
        }
        return booking(bk1, kind: body['booking_kind']! as String, slot: body['slot_start']! as String);
      };

      await t.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(theme: LimsTheme.light(), home: const MhnPayScreen()),
        ),
      );
      await t.pumpAndSettle();

      // First tap -> fails with slot conflict
      await t.tap(find.text('Pay Rs 450'));
      await t.pumpAndSettle();

      expect(api.createCalls.length, 1);
      final firstKey = api.createCalls.first.key;
      expect(firstKey.isNotEmpty, isTrue);
      expect(find.text('That time was just taken — pick another'), findsOneWidget);

      // Now configure API to succeed on retry
      shouldFail = false;

      // Tap retry
      await t.tap(find.text('Pay Rs 450'));
      await t.pumpAndSettle();

      expect(api.createCalls.length, 2);
      final secondKey = api.createCalls[1].key;
      // P-8 invariant: Retried request must reuse the SAME idempotency key
      expect(secondKey, equals(firstKey));
    });

    testWidgets('Closing Fonepay modal resets mutex allowing re-payment', (t) async {
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

      // Open Fonepay modal
      await t.tap(find.text('Pay Rs 450'));
      await t.pump();
      await t.pump(const Duration(milliseconds: 500));
      expect(find.text('Fonepay Dynamic QR'), findsOneWidget);

      // Dismiss modal by tapping outside / back button
      Navigator.of(t.element(find.text('Fonepay Dynamic QR'))).pop();
      await t.pumpAndSettle();

      expect(find.text('Fonepay Dynamic QR'), findsNothing);

      // Tap Pay again - mutex must not be locked
      await t.tap(find.text('Pay Rs 450'));
      await t.pump();
      await t.pump(const Duration(milliseconds: 500));
      expect(find.text('Fonepay Dynamic QR'), findsOneWidget);
    });

    testWidgets('Loophole 1 & 2 Fix: Server-side payment intent is requested via E41 when booking has order_id', (t) async {
      t.view.physicalSize = const Size(390, 1600);
      t.view.devicePixelRatio = 1;
      addTearDown(t.view.reset);

      final fakePayments = FakePaymentsApi();
      final container = createContainer(payments: fakePayments);
      addTearDown(container.dispose);

      const testOrderId = '01950c16-0000-7000-8000-000000000099';
      api.onCreate = (call, body, key) => {
        ...booking(bk1, kind: body['booking_kind']! as String, slot: body['slot_start']! as String),
        'order_id': testOrderId,
      };

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

      // Verify E41 createPaymentRequest was called with orderId and gateway
      expect(fakePayments.calls.length, 1);
      expect(fakePayments.calls.first.orderId, testOrderId);
      expect(fakePayments.calls.first.gateway, 'khalti');
      expect(fakePayments.calls.first.idempotencyKey.isNotEmpty, isTrue);

      // Verify the authoritative server-signed URL was opened
      expect(openedUrls.length, 1);
      expect(openedUrls.first.toString(), 'https://pay.khalti.com/?pidx=SERVER_KHALTI_PIDX_AUTH');
    });

    testWidgets('Loophole 3 & 4 Fix: Done screen reflects online payment pending verification status', (t) async {
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

      // Done screen must clarify that online payment is pending verification
      expect(find.text('Booking confirmed'), findsOneWidget);
      expect(find.textContaining('Online payment pending verification'), findsOneWidget);
    });
  });
}
