// T-BK1 test support: fake bookings API (E30-E40 wire bodies as plain JSON maps), fixtures and the screen host. Synthetic data only.
//
// IMPL CONTRACT these tests assume (writer: match it or dispute in .orchestra/notes):
//   lib/features/bookings/bookings_api.dart
//     abstract interface class PatientBookingsApi {                                   // every method returns the DECODED wire body (Map) and throws LimsException (LimsErrorCodes.*) on a non-2xx
//       Future<Object?> listBookableItems({required String bookingKind, String? query, String? cursor, int? limit});        // E30 -> {data:[BookableItem], page:{next_cursor?, limit}}
//       Future<Object?> listBookingCentres({required String bookingKind});                                                  // E31 -> {data:[BookingCentre]}
//       Future<Object?> listSlots({required String bookingKind, String? centreId, required String dateFrom, required String dateTo}); // E32 -> {data:[Slot]}; dates 'yyyy-MM-dd'; centreId null for home_collection
//       Future<Object?> createBooking({required Map<String, Object?> body, required String idempotencyKey});               // E33 -> Booking (201)
//       Future<Object?> listBookings({String? status, String? cursor, int? limit});                                         // E34 -> {data:[Booking], page}
//       Future<Object?> getBooking({required String bookingId});                                                            // E35 -> Booking
//       Future<Object?> cancelBooking({required String bookingId, required int version, required String idempotencyKey});   // E36 (If-Match = version) -> Booking
//       Future<Object?> listAddresses({String? profileId});                                                                 // E37 -> {data:[Address]}
//       Future<Object?> createAddress({required Map<String, Object?> body, required String idempotencyKey});                // E38 -> Address (201)
//       Future<Object?> updateAddress({required String addressId, required int version, required Map<String, Object?> body}); // E39 -> Address
//       Future<void> deactivateAddress({required String addressId, required int version});                                  // E40 -> 204
//     }
//   lib/features/bookings/bookings_providers.dart
//     patientBookingsApiProvider  (Provider<PatientBookingsApi>)
//     bookingProfilesProvider     (FutureProvider<List<BookingProfile>>)   BookingProfile({required String id /* = link id = E33 profile_id */, required String displayName, String? sex /* 'male'|'female'|'other'|'unknown'|null = unknown to C16 */})
//     bookingConfigProvider       (Provider<BookingConfig>)                BookingConfig({required bool homeCollection /* features.home_collection */, int maxOrderablesPerBooking = 20, String calendarMode = 'AD' /* 'AD'|'BS' */})
//     NOTE (flag for the orchestrator): the E13 Profile DTO has NO sex field, yet 03-APP-FLOW §6.1 / 04-UI-UX A17 step 3 need the profile's sex_snapshot in the app. The tests inject it through BookingProfile.sex;
//     how the writer fills it (CR to add `sex` to E13 Profile, or app shows all restricted items "Suitability is confirmed at the lab" and the API enforces) is NOT pinned beyond the unknown-sex behaviour.
//   lib/features/bookings/bookings_list_screen.dart       BookingsListScreen()                         = A16 (tab; E34; pull-to-refresh; [Book a test] opens A17)
//   lib/features/bookings/booking_detail_screen.dart      BookingDetailScreen({required String bookingId})  = A18 (E35, [Cancel] E36, [Reschedule] opens A17 at the slot step)
//   lib/features/bookings/booking_wizard_screen.dart      BookingWizardScreen({Map<String, Object?>? rescheduleOf /* the decoded Booking being replaced */})   = A17
//   lib/features/bookings/addresses_screen.dart           AddressesScreen()                            = A19 (E37-E40, add / edit / deactivate)
//   Wizard chrome: ONE primary LimsButton per page (LD-140): "Continue" on steps 1-5, "Confirm booking" on step 6; a secondary LimsButton "Back" from step 2 on (entries kept in memory); steps in the order of 04-UI-UX A17.
//   All five screens are wrapped in LimsSecureScreen (REQ-SEC-109: A18 PHI; bookings / addresses carry PHI). Status chips are LimsStatusChip (generic kind: tone + word). Money = rupees() of orders_format.dart ("Rs. 450.00").
//   Slot labels are Asia/Kathmandu (UTC+05:45) clock times ("7:15" is contained in the label of 2026-11-16T01:30:00.000Z).
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:patient_app/app/providers.dart';
import 'package:patient_app/features/bookings/addresses_screen.dart';
import 'package:patient_app/features/bookings/booking_detail_screen.dart';
import 'package:patient_app/features/bookings/booking_wizard_screen.dart';
import 'package:patient_app/features/bookings/bookings_api.dart';
import 'package:patient_app/features/bookings/bookings_list_screen.dart';
import 'package:patient_app/features/bookings/bookings_providers.dart';

import 'auth_fakes.dart';
import 'rig.dart';

const pFemale = '01950c16-0000-7000-8000-000000000c01', pUnknown = '01950c16-0000-7000-8000-000000000c02', pMale = '01950c16-0000-7000-8000-000000000c03';
const c1 = '01950c16-0000-7000-8000-000000000d01', c2 = '01950c16-0000-7000-8000-000000000d02';
const oCbc = '01950c16-0000-7000-8000-000000000e01', oGlu = '01950c16-0000-7000-8000-000000000e02', oWhp = '01950c16-0000-7000-8000-000000000e03', oPsa = '01950c16-0000-7000-8000-000000000e04', oHome = '01950c16-0000-7000-8000-000000000e05';
const addr1 = '01950c16-0000-7000-8000-000000000f01', addr2 = '01950c16-0000-7000-8000-000000000f02';
const bk1 = '01950c16-0000-7000-8000-000000000b01', bk2 = '01950c16-0000-7000-8000-000000000b02', bk3 = '01950c16-0000-7000-8000-000000000b03';

final profiles = [
  const BookingProfile(id: pFemale, displayName: 'Sita Synthetic', sex: 'female'),
  const BookingProfile(id: pUnknown, displayName: 'Ram Synthetic'),
  const BookingProfile(id: pMale, displayName: 'Hari Synthetic', sex: 'male'),
];

Map<String, Object?> bookable(String id, String kind, String name, {int? price = 45000, String? sex, List<String> kinds = const ['centre_visit', 'home_collection']}) => {
      'orderable_id': id, 'kind': kind, 'code': name.replaceAll(' ', '').substring(0, 4).toUpperCase(), 'display_name': name,
      if (price != null) 'indicative_price': {'amount_paisa': price, 'currency': 'NPR'}, 'booking_kinds': kinds, if (sex != null) 'sex_restriction': sex,
    };

List<Map<String, Object?>> catalogue() => [
      bookable(oCbc, 'test', 'Complete Blood Count'), bookable(oGlu, 'test', 'Glucose Fasting', price: 20000), bookable(oWhp, 'panel', 'Womens Health Package', price: 250000, sex: 'female'),
      bookable(oPsa, 'test', 'Prostate Marker', price: null, sex: 'male'), bookable(oHome, 'test', 'Home Only Test', kinds: const ['home_collection']),
    ];

Map<String, Object?> centre(String id, String name, String address) => {'centre_id': id, 'display_name': name, 'address_text': address, 'booking_kinds': ['centre_visit']};

Map<String, Object?> address(String id, {String text = 'Synthetic Tole 4, Ward 2', String label = 'home', String profile = pFemale, int version = 1}) =>
    {'id': id, 'profile_id': profile, 'label': label, 'address_text': text, 'version': version};

Map<String, Object?> booking(String id, {String status = 'confirmed', String no = 'BK26000001', String slot = '2026-11-16T01:30:00.000Z', String kind = 'centre_visit', int version = 1, String? cancellableUntil = '2026-11-16T00:30:00.000Z',
        String profile = pFemale, List<Map<String, Object?>>? items, String? homeAddressId, String centreName = 'Synthetic Centre One'}) =>
    {
      'id': id, 'booking_no': no, 'profile_id': profile, 'booking_kind': kind, 'centre_id': c1, 'centre_display_name': centreName, 'slot_start': slot, 'slot_end': '2026-11-16T01:45:00.000Z', 'status': status,
      'items': items ?? [{'orderable_id': oCbc, 'display_name': 'Complete Blood Count', 'indicative_price': {'amount_paisa': 45000, 'currency': 'NPR'}}],
      if (homeAddressId != null) 'home_address_id': homeAddressId, if (cancellableUntil != null && status == 'confirmed') 'cancellable_until': cancellableUntil, 'created_via': 'app', 'version': version,
    };

String _ymd(DateTime d) => '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

class FakeBookingsApi implements PatientBookingsApi {
  Object? Function(String kind, String? query) onItems = (kind, q) => {
        'data': [for (final i in catalogue()) if ((i['booking_kinds']! as List).contains(kind) && (q == null || (i['display_name']! as String).toLowerCase().contains(q.toLowerCase()))) i],
        'page': {'limit': 50},
      };
  Object? Function(String kind) onCentres = (kind) => {'data': kind == 'centre_visit' ? [centre(c1, 'Synthetic Centre One', 'Synthetic Road 1'), centre(c2, 'Synthetic Centre Two', 'Synthetic Road 2')] : <Object?>[]};
  /// Answers E32 call n (1-based): default = two slots (remaining 3 and 1) and a full one on the first day of the window.
  Object? Function(int call, String kind, String? centreId, String from, String to) onSlots = (call, kind, centreId, from, to) => {
        'data': [
          for (final s in const [('01:15', 3), ('01:30', 3), ('01:45', 1), ('02:00', 0)]) if (s.$2 > 0) {'slot_start': '${from}T${s.$1}:00.000Z', 'slot_end': '${from}T${s.$1}:00.000Z', 'remaining': s.$2, 'booking_kind': kind, 'centre_id': centreId ?? c1},
        ],
      };
  Object? Function(int call, Map<String, Object?> body, String key) onCreate = (call, body, key) => booking(bk1, kind: body['booking_kind']! as String, slot: body['slot_start']! as String, homeAddressId: body['home_address_id'] as String?);
  Object? Function(int call) onBookings = (_) => {'data': <Object?>[], 'page': {'limit': 50}};
  Object? Function(String id) onGetBooking = (id) => booking(id);
  Object? Function(int call, String id, int version, String key) onCancel = (call, id, version, key) => booking(id, status: 'cancelled', version: version + 1);
  List<Map<String, Object?>> addresses = [address(addr1), address(addr2, text: 'Synthetic Marg 9', label: 'work')];
  Object? Function(int call, Map<String, Object?> body, String key) onCreateAddress = (call, body, key) => address('01950c16-0000-7000-8000-000000000f99', text: body['address_text']! as String, label: body['label']! as String);
  Object? Function(int call, String id, int version, Map<String, Object?> body) onUpdateAddress = (call, id, version, body) => address(id, text: body['address_text']! as String, version: version + 1);
  /// Awaited before the matching call answers (holds a request in flight).
  Future<void>? Function()? holdCreate;

  final List<({String kind, String? query, String? cursor, int? limit})> itemCalls = [];
  final List<String> centreCalls = [];
  final List<({String kind, String? centreId, String from, String to})> slotCalls = [];
  final List<({Map<String, Object?> body, String key})> createCalls = [];
  final List<({String? status, String? cursor, int? limit})> listCalls = [];
  final List<String> getCalls = [];
  final List<({String id, int version, String key})> cancelCalls = [];
  final List<String?> addressListCalls = [];
  final List<({Map<String, Object?> body, String key})> createAddressCalls = [];
  final List<({String id, int version, Map<String, Object?> body})> updateAddressCalls = [];
  final List<({String id, int version})> deactivateCalls = [];
  int inFlightCreate = 0, maxInFlightCreate = 0;

  @override
  Future<Object?> listBookableItems({required String bookingKind, String? query, String? cursor, int? limit}) async {
    itemCalls.add((kind: bookingKind, query: query, cursor: cursor, limit: limit));
    return onItems(bookingKind, query);
  }

  @override
  Future<Object?> listBookingCentres({required String bookingKind}) async {
    centreCalls.add(bookingKind);
    return onCentres(bookingKind);
  }

  @override
  Future<Object?> listSlots({required String bookingKind, String? centreId, required String dateFrom, required String dateTo}) async {
    slotCalls.add((kind: bookingKind, centreId: centreId, from: dateFrom, to: dateTo));
    return onSlots(slotCalls.length, bookingKind, centreId, dateFrom, dateTo);
  }

  @override
  Future<Object?> createBooking({required Map<String, Object?> body, required String idempotencyKey}) async {
    createCalls.add((body: Map.of(body), key: idempotencyKey));
    inFlightCreate++;
    if (inFlightCreate > maxInFlightCreate) maxInFlightCreate = inFlightCreate;
    try {
      final h = holdCreate?.call();
      if (h != null) await h;
      return onCreate(createCalls.length, body, idempotencyKey);
    } finally {
      inFlightCreate--;
    }
  }

  @override
  Future<Object?> listBookings({String? status, String? cursor, int? limit}) async {
    listCalls.add((status: status, cursor: cursor, limit: limit));
    return onBookings(listCalls.length);
  }

  @override
  Future<Object?> getBooking({required String bookingId}) async {
    getCalls.add(bookingId);
    return onGetBooking(bookingId);
  }

  @override
  Future<Object?> cancelBooking({required String bookingId, required int version, required String idempotencyKey}) async {
    cancelCalls.add((id: bookingId, version: version, key: idempotencyKey));
    return onCancel(cancelCalls.length, bookingId, version, idempotencyKey);
  }

  @override
  Future<Object?> listAddresses({String? profileId}) async {
    addressListCalls.add(profileId);
    return {'data': [for (final a in addresses) if (profileId == null || a['profile_id'] == profileId) a]};
  }

  @override
  Future<Object?> createAddress({required Map<String, Object?> body, required String idempotencyKey}) async {
    createAddressCalls.add((body: Map.of(body), key: idempotencyKey));
    final a = onCreateAddress(createAddressCalls.length, body, idempotencyKey);
    if (a is Map<String, Object?>) addresses = [...addresses, a];
    return a;
  }

  @override
  Future<Object?> updateAddress({required String addressId, required int version, required Map<String, Object?> body}) async {
    updateAddressCalls.add((id: addressId, version: version, body: Map.of(body)));
    final a = onUpdateAddress(updateAddressCalls.length, addressId, version, body);
    if (a is Map<String, Object?>) addresses = [for (final x in addresses) x['id'] == addressId ? a : x];
    return a;
  }

  @override
  Future<void> deactivateAddress({required String addressId, required int version}) async {
    deactivateCalls.add((id: addressId, version: version));
    addresses = [for (final x in addresses) if (x['id'] != addressId) x];
  }
}

Widget bookingsScope(Rig rig, FakeBookingsApi api, {required Widget home, BookingConfig? config, List<BookingProfile>? withProfiles}) => ProviderScope(
      overrides: [
        flavourProvider.overrideWithValue(alphaFlavour()),
        sessionControllerProvider.overrideWithValue(rig.controller),
        patientBookingsApiProvider.overrideWithValue(api),
        bookingProfilesProvider.overrideWith((ref) async => withProfiles ?? profiles),
        bookingConfigProvider.overrideWithValue(config ?? const BookingConfig(homeCollection: true)),
      ],
      child: MaterialApp(theme: LimsTheme.light(), home: home),
    );

Future<void> settle(WidgetTester tester) async {
  await tester.pump(const Duration(milliseconds: 10));
  await tester.pump(const Duration(milliseconds: 10));
  await tester.pumpAndSettle(const Duration(milliseconds: 50));
}

Future<void> openWizard(WidgetTester tester, Rig rig, FakeBookingsApi api, {BookingConfig? config, Map<String, Object?>? rescheduleOf, List<BookingProfile>? withProfiles}) async {
  await tester.pumpWidget(bookingsScope(rig, api, home: BookingWizardScreen(rescheduleOf: rescheduleOf), config: config, withProfiles: withProfiles));
  await settle(tester);
}

/// The one primary (non-secondary) button of the page; fails when there is not exactly one (LD-140: one primary button per page).
LimsButton primary(WidgetTester tester) {
  final all = tester.widgetList<LimsButton>(find.byType(LimsButton)).where((b) => !b.secondary).toList();
  expect(all, hasLength(1), reason: 'exactly one primary LimsButton per page (LD-140)');
  return all.single;
}

Future<void> tapPrimary(WidgetTester tester) async {
  final b = primary(tester);
  expect(b.onPressed, isNotNull, reason: 'primary button "${b.label}" must be enabled here');
  await tester.tap(find.widgetWithText(LimsButton, b.label));
  await settle(tester);
}

Future<void> tapText(WidgetTester tester, String text) async {
  await tester.tap(find.textContaining(text).first);
  await settle(tester);
}

Future<void> tapBack(WidgetTester tester) async {
  await tester.tap(find.widgetWithText(LimsButton, 'Back'));
  await settle(tester);
}

Finder field(String label) => find.byWidgetPredicate((w) => w is LimsTextField && w.label == label);

Future<void> typeIn(WidgetTester tester, String label, String text) async {
  await tester.enterText(find.descendant(of: field(label), matching: find.byType(TextField)), text);
  await tester.pump();
}

/// Walks the wizard for a centre visit up to (and including) the chosen step: 1 who, 2 type, 3 tests, 4 place, 5 slot, 6 review.
Future<void> walk(WidgetTester tester, {int to = 6, String profile = 'Sita Synthetic', List<String> items = const ['Complete Blood Count'], String centreName = 'Synthetic Centre One', String slotText = '7:15', bool home = false, String? addressText}) async {
  await tapText(tester, profile);
  if (to >= 2) await tapPrimary(tester);
  if (to >= 3) {
    await tapText(tester, home ? 'Home collection' : 'Visit a centre');
    await tapPrimary(tester);
  }
  if (to >= 4) {
    for (final i in items) {
      await tapText(tester, i);
    }
    await tapPrimary(tester);
  }
  if (to >= 5) {
    await tapText(tester, home ? (addressText ?? 'Synthetic Tole 4, Ward 2') : centreName);
    await tapPrimary(tester);
  }
  if (to >= 6) {
    await tapText(tester, slotText);
    await tapPrimary(tester);
  }
}

int daysBetween(String from, String to) => DateTime.parse(to).difference(DateTime.parse(from)).inDays;
String ymd(DateTime d) => _ymd(d);
