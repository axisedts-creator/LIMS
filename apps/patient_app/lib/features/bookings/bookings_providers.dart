import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../orders/orders_format.dart';
import 'bookings_api.dart';

/// Screens keep booking / address data in widget state only (never persisted, TRD §3.5): leaving the screen or logging out drops it.
final patientBookingsApiProvider = Provider<PatientBookingsApi>(
  (ref) => TransportPatientBookingsApi(transport: ref.watch(transportProvider)),
);

/// One bookable profile. [id] is the link id = the E33 `profile_id` (never a patient id). [sex] 'male' | 'female' | 'other' | 'unknown' | null (null = unknown to C16).
class BookingProfile {
  const BookingProfile({required this.id, required this.displayName, this.sex});

  final String id;
  final String displayName;
  final String? sex;
}

/// What the wizard needs from the app config (E1 `features.home_collection`, `calendar_display`) and the settings (`max_orderables_per_booking`).
class BookingConfig {
  const BookingConfig({
    required this.homeCollection,
    this.maxOrderablesPerBooking = 20,
    this.calendarMode = 'AD',
  });

  final bool homeCollection;
  final int maxOrderablesPerBooking;
  final String calendarMode; // 'AD' | 'BS'
}

/// The active profiles (E13). [CONV] E13 `Profile` has no `sex` (03-APP-FLOW §6.1 needs it): until a CR adds it the sex is null = unknown, the wizard shows every item
/// with "Suitability is confirmed at the lab" and the API enforces the restriction (E33 -> 422 orderable_not_bookable).
final bookingProfilesProvider = FutureProvider<List<BookingProfile>>((
  ref,
) async {
  final body = asMap(
    await ref.watch(transportProvider)('GET', '/v1/engagement/me/profiles'),
  );
  return [
    for (final p in mapList(body?['data']))
      if (p['status'] == 'active' && p['profile_id'] is String)
        BookingProfile(
          id: p['profile_id']! as String,
          displayName: p['display_name'] is String
              ? p['display_name']! as String
              : '',
          sex: p['sex'] is String ? p['sex']! as String : null,
        ),
  ];
});

/// [CONV] The signed-in shell (not built yet) overrides this from the E1 config; until then home collection is off (the safe default).
final bookingConfigProvider = Provider<BookingConfig>(
  (_) => const BookingConfig(homeCollection: false),
);
