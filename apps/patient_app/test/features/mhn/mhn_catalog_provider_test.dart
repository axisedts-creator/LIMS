import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:patient_app/app/flavour.dart';
import 'package:patient_app/app/providers.dart';
import 'package:patient_app/features/auth/auth_providers.dart';
import 'package:patient_app/features/auth/patient_auth_api.dart';
import 'package:patient_app/features/bookings/bookings_api.dart';
import 'package:patient_app/features/bookings/bookings_providers.dart';
import 'package:patient_app/features/mhn/mhn_catalog_provider.dart';
import 'package:patient_app/features/mhn/mhn_data.dart';

class _FakeAuthApi implements PatientAuthApi {
  @override
  Future<Object?> getAppConfig() async => {
        'features': {
          'app': true,
          'bookings': true,
          'home_collection': false,
          'payments': true,
          'smart_report': true,
        },
        'support_phone': '+977-1-9999999',
        'allowed_phone_prefixes': ['+977'],
        'calendar_display': 'BS',
      };

  @override
  Future<Object?> requestOtp({required String phoneE164, required String appInstanceId, required String appPlatform}) async =>
      throw UnimplementedError();

  @override
  Future<Object?> verifyOtp({required String challengeToken, required String code}) async => throw UnimplementedError();
}

class _FakeBookingsApi implements PatientBookingsApi {
  @override
  Future<Object?> listBookableItems({required String bookingKind, String? query, String? cursor, int? limit}) async => {
        'data': [
          {
            'orderable_id': 'test-server-cbc',
            'kind': 'test',
            'code': 'CBC',
            'display_name': 'Complete Blood Count (Server)',
            'indicative_price': {'amount_paisa': 45000, 'currency': 'NPR'},
            'booking_kinds': ['centre_visit'],
          },
          {
            'orderable_id': 'pkg-server-gold',
            'kind': 'panel',
            'code': 'GOLD',
            'display_name': 'Gold Full Body Profile (Server)',
            'indicative_price': {'amount_paisa': 650000, 'currency': 'NPR'},
            'booking_kinds': ['centre_visit', 'home_collection'],
          },
        ],
      };

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  test('MhnCatalogState defaults gracefully to offline catalog', () {
    const s = MhnCatalogState();
    expect(s.isServerDriven, isFalse);
    expect(s.tests, equals(kTests));
    expect(s.packages, equals(kPackages));
    expect(s.heroSlides, equals(kHero));
    expect(s.supportPhone, '+977-1-5000000');
    expect(s.popularTests, isNotEmpty);
  });

  test('MhnCatalogNotifier loads dynamic server configuration and bookable items', () async {
    final container = ProviderContainer(
      overrides: [
        patientAuthApiProvider.overrideWithValue(_FakeAuthApi()),
        patientBookingsApiProvider.overrideWithValue(_FakeBookingsApi()),
        transportProvider.overrideWithValue((method, path, {query, headers, body}) async => {'data': []}),
      ],
    );
    addTearDown(container.dispose);

    final notifier = container.read(mhnCatalogProvider.notifier);
    await notifier.refreshCatalog();

    final state = container.read(mhnCatalogProvider);
    expect(state.isServerDriven, isTrue);
    expect(state.supportPhone, '+977-1-9999999');
    expect(state.homeCollectionEnabled, isFalse);
    expect(state.paymentsEnabled, isTrue);
    expect(state.smartReportEnabled, isTrue);
    expect(state.calendarDisplay, 'BS');

    // Server-driven tests & packages
    expect(state.tests.any((t) => t.id == 'test-server-cbc'), isTrue);
    expect(state.packages.any((p) => p.id == 'pkg-server-gold'), isTrue);
    final goldPkg = state.packages.firstWhere((p) => p.id == 'pkg-server-gold');
    expect(goldPkg.name, 'Gold Full Body Profile (Server)');
    expect(goldPkg.price, 6500);
  });
}
