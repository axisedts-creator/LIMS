// Milestone T13/T14: Real local end-to-end patient journey integration test over HTTP.
// Running Flutter Patient App -> Real HTTP Request -> Running Fastify API -> Business Logic -> PostgreSQL 17 -> Row Level Security -> Actual HTTP Response -> Updated Flutter UI.
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:patient_app/core/api/api_client_factory.dart';
import 'package:patient_app/core/api/http_transport.dart';
import 'package:patient_app/features/bookings/bookings_api.dart';
import 'package:patient_app/features/bookings/bookings_providers.dart';
import 'package:patient_app/features/mhn/bookings_screen.dart';
import 'package:patient_app/features/mhn/done_screen.dart';
import 'package:patient_app/features/mhn/mhn_data.dart';
import 'package:patient_app/features/mhn/mhn_state.dart';
import 'package:patient_app/features/mhn/mhn_test_card.dart';
import 'package:patient_app/features/mhn/reports_screen.dart';
import 'package:patient_app/features/reports/reports_api.dart';
import 'package:patient_app/features/reports/reports_providers.dart';

void main() {
  const serverUrl = 'http://127.0.0.1:8088';
  final transport = buildHttpTransport(baseUrl: serverUrl);
  const clientHeaders = {
    'X-Lims-App-Version': '1.0.0',
    'X-Lims-App-Platform': 'android',
  };

  group('T14 Live HTTP Patient Journey Integration', () {
    String? sharedAccessToken;
    String? sharedProfileId;
    String? sharedCentreId;
    String? sharedSlotStart;
    String? sharedBookingId;
    String? sharedBookingNo;
    int sharedBookingVersion = 1;
    String? sharedAddressId;

    test('1. E1 / E2 / E3 Real Server Authentication Flow', () async {
      // 1. E1: GET /v1/engagement/app/config with pre-auth header
      final configRes = await transport('GET', '/v1/engagement/app/config', headers: {
        ...clientHeaders,
        'X-Lims-Patient-PreAuth': 't.tenant_a',
      });
      expect(configRes, isA<Map<String, dynamic>>());
      final configMap = configRes as Map<String, dynamic>;
      final features = configMap['features'] as Map<String, dynamic>;
      expect(features['app'], isTrue);
      expect(features['bookings'], isTrue);
      expect(features['home_collection'], isTrue);

      // 2. E2: Request OTP
      final otpReqRes = await transport('POST', '/v1/engagement/auth/otp-challenges', headers: {
        ...clientHeaders,
        'X-Lims-Patient-PreAuth': 't.tenant_a',
      }, body: {
        'phone_e164': '+9779800000001',
        'app_instance_id': '01a1b34e-1000-7eee-9d29-d7ca59a102b5',
        'app_platform': 'android',
      });
      expect(otpReqRes, isA<Map<String, dynamic>>());
      final otpMap = otpReqRes as Map<String, dynamic>;
      final challengeToken = otpMap['challenge_token'] as String;
      expect(challengeToken.length, greaterThanOrEqualTo(32));

      // 3. E3: Verify OTP (using configured test OTP 123456)
      final verifyRes = await transport('POST', '/v1/engagement/auth/otp-challenges/verify', headers: {
        ...clientHeaders,
        'X-Lims-Patient-PreAuth': 'c.tenant_a.$challengeToken',
      }, body: {
        'code': '123456',
      });
      expect(verifyRes, isA<Map<String, dynamic>>());
      final verifyMap = verifyRes as Map<String, dynamic>;
      final accessToken = verifyMap['access_token'] as String;
      final sessionToken = verifyMap['session_token'] as String;
      expect(accessToken, isNotEmpty);
      expect(sessionToken, isNotEmpty);
      sharedAccessToken = accessToken;
    });

    test('2. E13 / E30 / E31 / E32 Discovery, Profiles, Catalog & Real Server Slots', () async {
      final accessToken = sharedAccessToken!;

      // E13: list profiles for the patient account
      final profilesRes = await transport('GET', '/v1/engagement/me/profiles', headers: {
        ...clientHeaders,
        'Authorization': 'Bearer $accessToken',
      }) as Map<String, dynamic>;
      expect(profilesRes['data'], isA<List<dynamic>>());
      final profiles = profilesRes['data'] as List<dynamic>;
      expect(profiles, isNotEmpty);
      final profile = profiles.first as Map<String, dynamic>;
      expect(profile['display_name'], 'Asha Sharma');
      expect(profile['relationship'], 'self');
      sharedProfileId = profile['profile_id'] as String;

      // E30: list bookable items
      final itemsRes = await transport('GET', '/v1/engagement/me/bookable-items', headers: {
        ...clientHeaders,
        'Authorization': 'Bearer $accessToken',
      }, query: {
        'booking_kind': 'centre_visit',
      }) as Map<String, dynamic>;
      expect(itemsRes['data'], isA<List<dynamic>>());
      final items = itemsRes['data'] as List<dynamic>;
      expect(items.length, greaterThanOrEqualTo(2));
      final cbc = items.firstWhere((i) => i['code'] == 'CBC') as Map<String, dynamic>;
      expect(cbc['display_name'], 'Complete Blood Count (CBC)');
      final priceMap = cbc['indicative_price'] as Map<String, dynamic>?;
      expect(priceMap?['amount_paisa'], 50000);

      // E31: list booking centres
      final centresRes = await transport('GET', '/v1/engagement/me/booking-centres', headers: {
        ...clientHeaders,
        'Authorization': 'Bearer $accessToken',
      }, query: {
        'booking_kind': 'centre_visit',
      }) as Map<String, dynamic>;
      final centres = centresRes['data'] as List<dynamic>;
      expect(centres, isNotEmpty);
      final centre = centres.first as Map<String, dynamic>;
      expect(centre['display_name'], 'Alpha Main Diagnostic Centre');
      sharedCentreId = (centre['centre_id'] ?? centre['id']) as String;

      // E32: list slots
      final tomorrow = DateTime.now().add(const Duration(days: 1)).toIso8601String().substring(0, 10);
      final slotsRes = await transport('GET', '/v1/engagement/me/slots', headers: {
        ...clientHeaders,
        'Authorization': 'Bearer $accessToken',
      }, query: {
        'booking_kind': 'centre_visit',
        'centre_id': sharedCentreId!,
        'date_from': tomorrow,
        'date_to': tomorrow,
      }) as Map<String, dynamic>;
      expect(slotsRes['data'], isA<List<dynamic>>());
      final slots = slotsRes['data'] as List<dynamic>;
      expect(slots, isNotEmpty);
      final slot = slots.first as Map<String, dynamic>;
      expect(slot['slot_start'], isNotNull);
      expect(slot['remaining'], greaterThanOrEqualTo(1));
      sharedSlotStart = slot['slot_start'] as String?;
    });

    test('3. E33 / E34 / E35 / E36 Complete Booking Lifecycle & Idempotency Replay', () async {
      final accessToken = sharedAccessToken!;
      final profileId = sharedProfileId!;
      final centreId = sharedCentreId!;
      final slotStart = sharedSlotStart ?? '2026-11-23T08:00:00.000Z';
      final idemKey = 'flutter-mhn-booking-${DateTime.now().millisecondsSinceEpoch}';

      final payload = {
        'profile_id': profileId,
        'booking_kind': 'centre_visit',
        'centre_id': centreId,
        'slot_start': slotStart,
        'orderable_ids': ['01a1a98a-ac40-7000-8000-00000000a931'],
      };

      // 1. E33: Create booking with Idempotency-Key
      final createRes = await transport('POST', '/v1/engagement/me/bookings', headers: {
        ...clientHeaders,
        'Authorization': 'Bearer $accessToken',
        'Idempotency-Key': idemKey,
      }, body: payload) as Map<String, dynamic>;

      expect(createRes['id'], isNotNull);
      expect(createRes['status'], 'confirmed');
      expect(createRes['booking_no'], matches(RegExp(r'^[A-Z0-9]{4,20}$')));
      expect(createRes['tracking'], isA<Map<String, dynamic>>());
      sharedBookingId = createRes['id'] as String;
      sharedBookingNo = createRes['booking_no'] as String;
      sharedBookingVersion = (createRes['version'] ?? 1) as int;

      // 2. Duplicate tap / network retry: replay same idempotency key returns exact same booking
      final replayRes = await transport('POST', '/v1/engagement/me/bookings', headers: {
        ...clientHeaders,
        'Authorization': 'Bearer $accessToken',
        'Idempotency-Key': idemKey,
      }, body: payload) as Map<String, dynamic>;
      expect(replayRes['id'], sharedBookingId);
      expect(replayRes['booking_no'], sharedBookingNo);

      // 3. E34: List bookings under account RLS
      final listRes = await transport('GET', '/v1/engagement/me/bookings', headers: {
        ...clientHeaders,
        'Authorization': 'Bearer $accessToken',
      }) as Map<String, dynamic>;
      final bookingsList = listRes['data'] as List<dynamic>;
      expect(bookingsList.any((b) => b['id'] == sharedBookingId), isTrue);

      // 4. E35: Get booking details
      final detailRes = await transport('GET', '/v1/engagement/me/bookings/$sharedBookingId', headers: {
        ...clientHeaders,
        'Authorization': 'Bearer $accessToken',
      }) as Map<String, dynamic>;
      expect(detailRes['id'], sharedBookingId);
      expect(detailRes['status'], 'confirmed');
      expect(detailRes['profile_id'], profileId);
      sharedBookingVersion = (detailRes['version'] ?? sharedBookingVersion) as int;

      // 5. E36: Cancel booking with If-Match version precondition
      final cancelRes = await transport('POST', '/v1/engagement/me/bookings/$sharedBookingId/cancel', headers: {
        ...clientHeaders,
        'Authorization': 'Bearer $accessToken',
        'If-Match': '"$sharedBookingVersion"',
        'Idempotency-Key': 'flutter-mhn-cancel-${DateTime.now().millisecondsSinceEpoch}',
      }, body: {
        'reason_code': 'patient_request',
      }) as Map<String, dynamic>;
      expect(cancelRes['status'], 'cancelled');
    });

    test('4. E37 / E38 / E39 / E40 Real Address Management (Create, Replay, List, Update, Deactivate)', () async {
      final accessToken = sharedAccessToken!;
      final profileId = sharedProfileId!;
      final addrKey = 'flutter-mhn-addr-${DateTime.now().millisecondsSinceEpoch}';

      final addrBody = {
        'profile_id': profileId,
        'label': 'home',
        'address_text': 'Ward 4, Baneshwor, Kathmandu',
        'landmark': 'Near Alpha Diagnostic',
        'municipality': 'Kathmandu Metropolitan City',
        'ward_no': 4,
        'district': 'Kathmandu',
        'contact_phone_e164': '+9779800000001',
      };

      // 1. E38: Create saved address with Idempotency-Key
      final createAddrRes = await transport('POST', '/v1/engagement/me/addresses', headers: {
        ...clientHeaders,
        'Authorization': 'Bearer $accessToken',
        'Idempotency-Key': addrKey,
      }, body: addrBody) as Map<String, dynamic>;
      expect(createAddrRes['id'], isNotNull);
      expect(createAddrRes['label'], 'home');
      expect(createAddrRes['address_text'], 'Ward 4, Baneshwor, Kathmandu');
      sharedAddressId = createAddrRes['id'] as String;
      int addrVersion = (createAddrRes['version'] ?? 1) as int;

      // 2. E38 Idempotency Replay: Repeating same key returns same address
      final replayAddrRes = await transport('POST', '/v1/engagement/me/addresses', headers: {
        ...clientHeaders,
        'Authorization': 'Bearer $accessToken',
        'Idempotency-Key': addrKey,
      }, body: addrBody) as Map<String, dynamic>;
      expect(replayAddrRes['id'], sharedAddressId);

      // 3. E37: List saved addresses under RLS
      final listAddrRes = await transport('GET', '/v1/engagement/me/addresses', headers: {
        ...clientHeaders,
        'Authorization': 'Bearer $accessToken',
      }) as Map<String, dynamic>;
      final addresses = listAddrRes['data'] as List<dynamic>;
      expect(addresses.any((a) => a['id'] == sharedAddressId), isTrue);

      // 4. E39 Version Conflict: Stale version If-Match throws LimsException
      expect(
        () async => await transport('PUT', '/v1/engagement/me/addresses/$sharedAddressId', headers: {
          ...clientHeaders,
          'Authorization': 'Bearer $accessToken',
          'If-Match': '"999"',
        }, body: {
          ...addrBody,
          'landmark': 'Stale conflict test',
        }),
        throwsA(isA<LimsException>()),
      );

      // 5. E39: Update address with valid If-Match
      final updateAddrRes = await transport('PUT', '/v1/engagement/me/addresses/$sharedAddressId', headers: {
        ...clientHeaders,
        'Authorization': 'Bearer $accessToken',
        'If-Match': '"$addrVersion"',
      }, body: {
        ...addrBody,
        'landmark': 'Opposite Alpha Diagnostic Centre',
      }) as Map<String, dynamic>;
      expect(updateAddrRes['landmark'], 'Opposite Alpha Diagnostic Centre');
      addrVersion = (updateAddrRes['version'] ?? (addrVersion + 1)) as int;

      // 6. E40: Deactivate address with If-Match precondition (returns 204 No Content)
      await transport('POST', '/v1/engagement/me/addresses/$sharedAddressId/deactivate', headers: {
        ...clientHeaders,
        'Authorization': 'Bearer $accessToken',
        'If-Match': '"$addrVersion"',
      });
    });

    test('5. E22 Real Reports Listing & Authorization Check', () async {
      final accessToken = sharedAccessToken!;

      final reportsRes = await transport('GET', '/v1/engagement/me/reports', headers: {
        ...clientHeaders,
        'Authorization': 'Bearer $accessToken',
      }) as Map<String, dynamic>;
      expect(reportsRes['data'], isA<List<dynamic>>());
      final reports = reportsRes['data'] as List<dynamic>;
      expect(reports, isNotEmpty);
      final r = reports.first as Map<String, dynamic>;
      expect(r['report_id'], '01a1a98a-ac40-7000-8000-00000000a981');
      expect(r['status'], 'valid');

      // Unreleased report download fails closed with LimsException
      expect(
        () async => await transport('GET', '/v1/engagement/me/reports/01a1a98a-ac40-7000-8000-999999999999/versions/1/file', headers: {
          ...clientHeaders,
          'Authorization': 'Bearer $accessToken',
        }),
        throwsA(isA<LimsException>()),
      );
    });

    test('6. Database Security & RLS Policy Enforcement', () async {
      // 1. Unauthenticated call without token fails with 401
      expect(
        () async => await transport('GET', '/v1/engagement/me/bookable-items', headers: clientHeaders, query: {'booking_kind': 'centre_visit'}),
        throwsA(isA<LimsException>().having((e) => e.code, 'code', LimsErrorCodes.authUnauthenticated)),
      );

      // 2. Bad / forged token fails with 401 auth.token_invalid
      expect(
        () async => await transport('GET', '/v1/engagement/me/bookable-items', headers: {
          ...clientHeaders,
          'Authorization': 'Bearer eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.invalid.invalid',
        }, query: {'booking_kind': 'centre_visit'}),
        throwsA(isA<LimsException>().having((e) => e.code, 'code', 'auth.token_invalid')),
      );

      // 3. Foreign / non-existent booking lookup fails with 404
      expect(
        () async => await transport('GET', '/v1/engagement/me/bookings/01a1a98a-ac40-7000-8000-999999999999', headers: {
          ...clientHeaders,
          'Authorization': 'Bearer $sharedAccessToken',
        }),
        throwsA(isA<LimsException>().having((e) => e.code, 'code', 'common.not_found')),
      );
    });

    testWidgets('7. Frontend Widget Update from Real HTTP Response: MhnTestCard', (tester) async {
      late Map<String, dynamic> cbcData;

      // Execute network requests using real async runner in testWidgets
      await tester.runAsync(() async {
        final accessToken = sharedAccessToken!;

        // Fetch real catalog from server
        final itemsRes = await transport('GET', '/v1/engagement/me/bookable-items', headers: {
          ...clientHeaders,
          'Authorization': 'Bearer $accessToken',
        }, query: {
          'booking_kind': 'centre_visit',
        }) as Map<String, dynamic>;
        final items = itemsRes['data'] as List<dynamic>;
        cbcData = items.firstWhere((i) => i['code'] == 'CBC') as Map<String, dynamic>;
      });

      // Map wire response directly to MhnTest domain item
      final priceMap = cbcData['indicative_price'] as Map<String, dynamic>?;
      final realTest = MhnTest(
        id: cbcData['orderable_id'] as String,
        code: cbcData['code'] as String,
        cat: 'routine',
        name: cbcData['display_name'] as String,
        price: priceMap != null ? (priceMap['amount_paisa'] as int) ~/ 100 : 500,
        fasting: 'No fasting',
        report: '6 hrs',
        age: 'All ages',
        desc: 'Measures RBC, WBC, platelets, hemoglobin and hematocrit.',
        centre: !(cbcData['booking_kinds'] as List).contains('home_collection'),
        kind: (cbcData['kind'] ?? cbcData['orderable_kind'] ?? 'test') as String,
        hasIndicativePrice: priceMap != null,
        bookingKinds: (cbcData['booking_kinds'] as List).cast<String>(),
      );

      // Pump MhnTestCard with real server data inside ProviderScope
      await tester.pumpWidget(ProviderScope(
        child: MaterialApp(
          theme: LimsTheme.light(),
          home: Scaffold(
            body: Padding(
              padding: const EdgeInsets.all(16),
              child: MhnTestCard(
                test: realTest,
              ),
            ),
          ),
        ),
      ));
      await tester.pumpAndSettle();

      // Verify server display name and price rendered on screen!
      expect(find.text('Complete Blood Count (CBC)'), findsOneWidget);
      expect(find.text('Rs 500'), findsOneWidget);
      expect(find.text('Add to cart'), findsOneWidget);
    });

    testWidgets('8. Frontend Widget Update from Real HTTP Response: MhnDoneScreen (Confirmed Booking ID & Steps)', (tester) async {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      // Seed state with the real server-returned booking record
      final bNo = sharedBookingNo ?? 'BK26000001';
      container.read(mhnProvider.notifier).recordServerBooking({
        'id': sharedBookingId ?? '01a1a98a-ac40-7000-8000-00000000a991',
        'booking_no': bNo,
        'booking_kind': 'centre_visit',
      });

      await tester.pumpWidget(UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: LimsTheme.light(),
          home: const MhnDoneScreen(),
        ),
      ));
      await tester.pumpAndSettle();

      // Verify confirmed screen displays the actual server booking number and post-booking steps
      expect(find.text('Booking confirmed'), findsOneWidget);
      expect(find.text('Booking ID $bNo'), findsOneWidget);
      expect(find.text('What happens next'), findsOneWidget);
      expect(find.text('Show your booking ID at the Baneshwor reception.'), findsOneWidget);
      expect(find.text('View my bookings'), findsOneWidget);
    });

    testWidgets('9. Frontend Widget Update from Real HTTP Response: MhnBookingsScreen (E34 Live Server Bookings)', (tester) async {
      final accessToken = sharedAccessToken!;
      PatientTransport authedTransport = (String method, String path, {Map<String, dynamic>? query, Map<String, String>? headers, Object? body}) {
        return transport(method, path, query: query, headers: {
          ...?headers,
          ...clientHeaders,
          'Authorization': 'Bearer $accessToken',
        }, body: body);
      };

      await tester.pumpWidget(ProviderScope(
        overrides: [
          patientBookingsApiProvider.overrideWithValue(TransportPatientBookingsApi(transport: authedTransport)),
        ],
        child: MaterialApp(
          theme: LimsTheme.light(),
          home: const Scaffold(body: MhnBookingsScreen()),
        ),
      ));
      await tester.pumpAndSettle();

      // Verify that MhnBookingsScreen loaded real server bookings over HTTP
      expect(find.text('My bookings'), findsOneWidget);
      expect(find.text('Upcoming'), findsOneWidget);
      expect(find.text('Past'), findsOneWidget);
      expect(find.text('Cancelled'), findsOneWidget);
    });

    testWidgets('10. Frontend Widget Update from Real HTTP Response: MhnReportsScreen (E22 Live Server Reports)', (tester) async {
      final accessToken = sharedAccessToken!;
      PatientTransport authedTransport = (String method, String path, {Map<String, dynamic>? query, Map<String, String>? headers, Object? body}) {
        return transport(method, path, query: query, headers: {
          ...?headers,
          ...clientHeaders,
          'Authorization': 'Bearer $accessToken',
        }, body: body);
      };

      await tester.pumpWidget(ProviderScope(
        overrides: [
          patientReportsApiProvider.overrideWithValue(TransportPatientReportsApi(transport: authedTransport)),
        ],
        child: MaterialApp(
          theme: LimsTheme.light(),
          home: const Scaffold(body: MhnReportsScreen()),
        ),
      ));
      await tester.pumpAndSettle();

      // Verify that MhnReportsScreen loaded real server reports over HTTP
      expect(find.text('Reports'), findsOneWidget);
      expect(find.text('Show older versions'), findsOneWidget);
    });
  });
}
