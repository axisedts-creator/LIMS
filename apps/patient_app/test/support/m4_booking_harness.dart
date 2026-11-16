// T0C-M4-PATIENT-3 test harness: mounts A16 bookings list, A18 booking detail, A17 wizard (every step + confirmation), A19 addresses,
// A21 membership card and A22 enquiries (list, new, thread) on a 360 dp wide phone, inside the real LimsTheme and the EXISTING fakes
// (bookings_fakes, enquiries_fakes; no existing file is edited). Synthetic data only.
// Prefixes: bk = bookings_fakes, en = enquiries_fakes (their top-level names clash).
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:patient_app/app/providers.dart';
import 'package:patient_app/features/bookings/addresses_screen.dart';
import 'package:patient_app/features/bookings/booking_detail_screen.dart';
import 'package:patient_app/features/bookings/booking_wizard_screen.dart';
import 'package:patient_app/features/bookings/bookings_list_screen.dart';
import 'package:patient_app/features/bookings/bookings_providers.dart';
import 'package:patient_app/features/enquiries/enquiries_providers.dart';
import 'package:patient_app/features/enquiries/enquiries_screen.dart';
import 'package:patient_app/features/enquiries/enquiry_thread_screen.dart';
import 'package:patient_app/features/enquiries/new_enquiry_screen.dart';
import 'package:patient_app/features/membership/membership_api.dart';
import 'package:patient_app/features/membership/membership_providers.dart';
import 'package:patient_app/features/membership/membership_screen.dart';
import 'package:patient_app/features/profiles/profiles_providers.dart';

import 'auth_fakes.dart' show alphaFlavour;
import 'bookings_fakes.dart' as bk;
import 'enquiries_fakes.dart' as en;
import 'm4_harness.dart' show appOf;
import 'rig.dart';

/// 360 dp wide phone of the brief, tall enough that a lazy list builds every row; every screen is also run at text scale 1.3.
Future<void> phoneP3(WidgetTester t, {double scale = 1.0}) async {
  t.view.physicalSize = const Size(360, 1800);
  t.view.devicePixelRatio = 1.0;
  t.platformDispatcher.textScaleFactorTestValue = scale;
  addTearDown(() {
    t.view.resetPhysicalSize();
    t.view.resetDevicePixelRatio();
    t.platformDispatcher.clearTextScaleFactorTestValue();
  });
}

typedef OpenP3 = Future<void> Function(WidgetTester t, Rig rig, {bool reduceMotion});

Widget _scope(Rig rig, List<Override> extra, Widget home, bool reduce) => ProviderScope(
      overrides: [flavourProvider.overrideWithValue(alphaFlavour()), sessionControllerProvider.overrideWithValue(rig.controller), ...extra],
      child: appOf(home, reduceMotion: reduce),
    );

Future<void> _pumpN(WidgetTester t, {int n = 8, int ms = 50}) async {
  for (var i = 0; i < n; i++) {
    await t.pump(Duration(milliseconds: ms));
  }
}

// ---------------------------------------------------------------- bookings (A16, A17, A18, A19)

List<Override> _bkOverrides(bk.FakeBookingsApi api, {BookingConfig? config}) => [
      patientBookingsApiProvider.overrideWithValue(api),
      bookingProfilesProvider.overrideWith((ref) async => bk.profiles),
      bookingConfigProvider.overrideWithValue(config ?? const BookingConfig(homeCollection: true)),
    ];

/// One booking per status of 04-UI-UX A16 and one home collection, so every chip tone and both place lines are on screen.
Future<void> openA16(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  final api = bk.FakeBookingsApi()
    ..onBookings = (_) => {
          'data': [
            bk.booking(bk.bk1),
            bk.booking(bk.bk2, status: 'checked_in', no: 'BK26000002'),
            bk.booking(bk.bk3, status: 'completed', no: 'BK26000003'),
            bk.booking('01950c16-0000-7000-8000-000000000b04', status: 'cancelled', no: 'BK26000004'),
            bk.booking('01950c16-0000-7000-8000-000000000b05', no: 'BK26000005', kind: 'home_collection', homeAddressId: bk.addr1),
          ],
          'page': {'limit': 50},
        };
  await t.pumpWidget(_scope(rig, _bkOverrides(api), const BookingsListScreen(), reduceMotion));
  await _pumpN(t);
}

Future<void> openA16Empty(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  await t.pumpWidget(_scope(rig, _bkOverrides(bk.FakeBookingsApi()), const BookingsListScreen(), reduceMotion));
  await _pumpN(t);
}

Future<void> openA16Error(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  final api = bk.FakeBookingsApi()..onBookings = (_) => throw LimsException(LimsErrorCodes.commonInternal);
  await t.pumpWidget(_scope(rig, _bkOverrides(api), const BookingsListScreen(), reduceMotion));
  await _pumpN(t);
}

/// A18 of a confirmed centre booking that can still be cancelled ([Cancel], [Reschedule], cancel-until line).
Future<void> openA18(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  await t.pumpWidget(_scope(rig, _bkOverrides(bk.FakeBookingsApi()), BookingDetailScreen(bookingId: bk.bk1), reduceMotion));
  await _pumpN(t);
}

/// A18 of a home collection: the address line from E37 (address text, never the id).
Future<void> openA18Home(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  final api = bk.FakeBookingsApi()..onGetBooking = (id) => bk.booking(id, kind: 'home_collection', homeAddressId: bk.addr1);
  await t.pumpWidget(_scope(rig, _bkOverrides(api), BookingDetailScreen(bookingId: bk.bk1), reduceMotion));
  await _pumpN(t);
}

/// A18 of a cancelled booking: no [Cancel], no [Reschedule].
Future<void> openA18Cancelled(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  final api = bk.FakeBookingsApi()..onGetBooking = (id) => bk.booking(id, status: 'cancelled');
  await t.pumpWidget(_scope(rig, _bkOverrides(api), BookingDetailScreen(bookingId: bk.bk1), reduceMotion));
  await _pumpN(t);
}

Future<void> openA18Error(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  final api = bk.FakeBookingsApi()..onGetBooking = (_) => throw LimsException(LimsErrorCodes.commonInternal);
  await t.pumpWidget(_scope(rig, _bkOverrides(api), BookingDetailScreen(bookingId: bk.bk1), reduceMotion));
  await _pumpN(t);
}

Future<void> openA19(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  await t.pumpWidget(_scope(rig, _bkOverrides(bk.FakeBookingsApi()), const AddressesScreen(), reduceMotion));
  await _pumpN(t);
}

Future<void> openA19Empty(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  final api = bk.FakeBookingsApi()..addresses = [];
  await t.pumpWidget(_scope(rig, _bkOverrides(api), const AddressesScreen(), reduceMotion));
  await _pumpN(t);
}

/// A19 form: opened by [Add address] (the screen's own entry, wording per the existing a19 tests).
Future<void> openA19Form(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  await openA19(t, rig, reduceMotion: reduceMotion);
  await t.tap(find.textContaining('Add address').first);
  await _pumpN(t);
}

/// The wizard on step [to] of 04-UI-UX A17 (1 who .. 6 review) for a centre visit; 7 = the confirmation after [Confirm booking].
/// Values come from the model: prices 312.50 and 118.75 (total 431.25), centre "Synthetic Centre Nine", booking no. BK26000777.
Future<bk.FakeBookingsApi> openWizard(WidgetTester t, Rig rig, int to, {bool reduceMotion = false, bool home = false}) async {
  final api = bk.FakeBookingsApi()
    ..onItems = ((kind, q) => {
          'data': [
            bk.bookable(bk.oCbc, 'test', 'Complete Blood Count', price: 31250),
            bk.bookable(bk.oGlu, 'test', 'Glucose Fasting', price: 11875),
          ],
          'page': {'limit': 50},
        })
    ..onCentres = ((kind) => {'data': [bk.centre(bk.c1, 'Synthetic Centre Nine', 'Synthetic Lane 9')]})
    ..onCreate = ((call, body, key) => bk.booking(bk.bk1,
        no: 'BK26000777', kind: body['booking_kind']! as String, slot: body['slot_start']! as String, centreName: 'Synthetic Centre Nine', homeAddressId: body['home_address_id'] as String?));
  await t.pumpWidget(_scope(rig, _bkOverrides(api), const BookingWizardScreen(), reduceMotion));
  await bk.settle(t);
  await bk.walk(t, to: to > 6 ? 6 : to, items: const ['Complete Blood Count', 'Glucose Fasting'], centreName: 'Synthetic Centre Nine', home: home);
  if (to > 6) await bk.tapPrimary(t);
  return api;
}

// ---------------------------------------------------------------- membership (A21)

class _FakeMembershipApi implements MembershipApi {
  _FakeMembershipApi(this.answer);
  final Future<Object?> Function() answer;
  @override
  Future<Object?> listMyMemberships() => answer();
}

class _NoBrightness implements CardBrightness {
  @override
  Future<void> raise() async {}
  @override
  Future<void> restore() async {}
}

const cardToken = '0123456789ABCDEFGHJKMNPQRS';

Map<String, Object?> _card({String plan = 'Gold plan (synthetic)', String no = 'MB26000001', String status = 'active'}) => {
      'membership_id': '01950c16-0000-7000-8000-000000000077',
      'profile_id': '01950c16-0000-7000-8000-000000000078',
      'plan_display_name': plan,
      'card_no': no,
      'card_token': cardToken,
      'valid_from': '2026-10-01',
      'valid_to': '2027-10-01',
      'status': status,
    };

Future<void> _openA21(WidgetTester t, Rig rig, Future<Object?> Function() answer, bool reduce) async {
  await t.pumpWidget(_scope(rig, [membershipApiProvider.overrideWithValue(_FakeMembershipApi(answer)), cardBrightnessProvider.overrideWithValue(_NoBrightness())], const MembershipScreen(), reduce));
  await _pumpN(t);
}

Future<void> openA21(WidgetTester t, Rig rig, {bool reduceMotion = false}) =>
    _openA21(t, rig, () async => {'data': [_card(), _card(plan: 'Silver plan (synthetic)', no: 'MB26000002', status: 'expired')]}, reduceMotion);

Future<void> openA21Empty(WidgetTester t, Rig rig, {bool reduceMotion = false}) => _openA21(t, rig, () async => {'data': <Object?>[]}, reduceMotion);

Future<void> openA21Error(WidgetTester t, Rig rig, {bool reduceMotion = false}) =>
    _openA21(t, rig, () => Future<Object?>.error(LimsException(LimsErrorCodes.commonInternal)), reduceMotion);

// ---------------------------------------------------------------- enquiries (A22)

List<Override> _enOverrides(en.FakeEnquiriesApi api) => [enquiriesApiProvider.overrideWithValue(api), profilesApiProvider.overrideWithValue(en.profilesFake())];

en.FakeEnquiriesApi _threads() => en.FakeEnquiriesApi(threads: [
      en.threadWire(id: en.enqId(1), subject: 'Where is my report? (synthetic)', messages: [
        en.msg('patient', 'Synthetic question text.'),
        en.msg('staff', 'Synthetic lab answer.', at: '2026-11-04T11:00:00.000Z'),
      ]),
      en.threadWire(id: en.enqId(2), status: 'closed', subject: 'Closed topic (synthetic)'),
    ]);

Future<void> openA22(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  await t.pumpWidget(_scope(rig, _enOverrides(_threads()), const EnquiriesScreen(), reduceMotion));
  await _pumpN(t);
}

Future<void> openA22Empty(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  await t.pumpWidget(_scope(rig, _enOverrides(en.FakeEnquiriesApi()), const EnquiriesScreen(), reduceMotion));
  await _pumpN(t);
}

Future<void> openA22Error(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  final api = en.FakeEnquiriesApi()..onListOverride = (_) => Future<Object?>.error(LimsException(LimsErrorCodes.commonInternal));
  await t.pumpWidget(_scope(rig, _enOverrides(api), const EnquiriesScreen(), reduceMotion));
  await _pumpN(t);
}

Future<void> openA22New(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  await t.pumpWidget(_scope(rig, _enOverrides(_threads()), const NewEnquiryScreen(), reduceMotion));
  await _pumpN(t);
}

Future<void> openA22Thread(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  await t.pumpWidget(_scope(rig, _enOverrides(_threads()), EnquiryThreadScreen(enquiryId: en.enqId(1)), reduceMotion));
  await _pumpN(t);
}

Future<void> openA22ThreadClosed(WidgetTester t, Rig rig, {bool reduceMotion = false}) async {
  await t.pumpWidget(_scope(rig, _enOverrides(_threads()), EnquiryThreadScreen(enquiryId: en.enqId(2)), reduceMotion));
  await _pumpN(t);
}
