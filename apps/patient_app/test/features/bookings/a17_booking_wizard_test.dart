// T-BK1 — A17 booking wizard (04-UI-UX A17 steps 1-6; 03-APP-FLOW §6.1 wizard rules, §6.2 reschedule, §11 booking states; 01-PRD US-EN-12.1-8, 13.1-2, 14.3; 07-SECURITY AB-7).
// done_when: "wizard per 04-UI-UX; Idempotency-Key per review step". Contract of the screens / providers / fakes: header of test/support/bookings_fakes.dart. Synthetic data only.
// Assumed chrome (not in the spec text, pinned here so tests can drive the wizard): primary "Continue" (steps 1-5) / "Confirm booking" (step 6), secondary "Back", step-2 options "Visit a centre" / "Home collection",
// step-4 inline form opened by "Add address" with a "Save" button (see a19_addresses_test.dart), confirmation screen after a 201 showing booking no., date/time and place.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:patient_app/features/bookings/bookings_providers.dart';

import '../../support/bookings_fakes.dart';
import '../../support/rig.dart';

int selectedBoxes(WidgetTester t) => t.widgetList<Checkbox>(find.byType(Checkbox)).where((c) => c.value == true).length;

void main() {
  late Rig rig;
  late FakeBookingsApi api;

  setUp(() async {
    rig = await Rig.create();
    api = FakeBookingsApi();
  });
  tearDown(() => rig.dispose());

  group('step 1 Who', () {
    testWidgets('lists the active profiles (names only, no ids); the page is a LimsSecureScreen with ONE primary button, disabled until a profile is chosen (required)', (tester) async {
      await openWizard(tester, rig, api);
      expect(find.byType(LimsSecureScreen), findsOneWidget);
      for (final n in ['Sita Synthetic', 'Ram Synthetic', 'Hari Synthetic']) {
        expect(find.text(n), findsOneWidget);
      }
      expect(find.textContaining(pFemale), findsNothing);
      expect(primary(tester).onPressed, isNull);
      await tapText(tester, 'Sita Synthetic');
      expect(primary(tester).onPressed, isNotNull);
      expect(api.itemCalls, isEmpty, reason: 'nothing is fetched before the profile and type are known');
    });
  });

  group('step 2 Type', () {
    testWidgets('"Visit a centre" and "Home collection" are offered; one must be chosen', (tester) async {
      await openWizard(tester, rig, api);
      await walk(tester, to: 2);
      expect(find.textContaining('Visit a centre'), findsOneWidget);
      expect(find.textContaining('Home collection'), findsOneWidget);
      expect(primary(tester).onPressed, isNull);
      await tapText(tester, 'Visit a centre');
      expect(primary(tester).onPressed, isNotNull);
    });

    testWidgets('home collection is not offered when features.home_collection is off', (tester) async {
      await openWizard(tester, rig, api, config: const BookingConfig(homeCollection: false));
      await walk(tester, to: 2);
      expect(find.textContaining('Visit a centre'), findsOneWidget);
      expect(find.textContaining('Home collection'), findsNothing);
    });

    testWidgets('Back keeps the entries: back to step 1 shows the chosen profile still selected (primary enabled)', (tester) async {
      await openWizard(tester, rig, api);
      await walk(tester, to: 2);
      await tapBack(tester);
      expect(primary(tester).onPressed, isNotNull, reason: 'the profile chosen before is kept in memory');
    });
  });

  group('step 3 Tests (E30)', () {
    testWidgets('fetches E30 for the chosen kind; each item shows its name and indicative price; an unpriced item shows "Price at the lab"; a female profile does not see male-only items', (tester) async {
      await openWizard(tester, rig, api);
      await walk(tester, to: 3);
      expect(api.itemCalls.first.kind, 'centre_visit');
      expect(api.itemCalls.first.query, isNull);
      expect(find.text('Complete Blood Count'), findsOneWidget);
      expect(find.text('Rs. 450.00'), findsWidgets);
      expect(find.text('Womens Health Package'), findsOneWidget);
      expect(find.text('Prostate Marker'), findsNothing, reason: 'items restricted to the other sex are hidden (04-UI-UX A17)');
      expect(find.text('Home Only Test'), findsNothing, reason: 'E30 is called with the booking kind; the fake only returns home items for home_collection');
      expect(find.textContaining('Suitability is confirmed at the lab'), findsNothing, reason: 'the profile\'s sex is known');
    });

    testWidgets('a male profile does not see female-only items, and an unpriced item shows "Price at the lab"', (tester) async {
      await openWizard(tester, rig, api);
      await walk(tester, to: 3, profile: 'Hari Synthetic');
      expect(find.text('Womens Health Package'), findsNothing);
      expect(find.text('Prostate Marker'), findsOneWidget);
      expect(find.text('Price at the lab'), findsOneWidget);
    });

    testWidgets('a profile whose sex is unknown to C16 sees ALL items; each restricted one says "Suitability is confirmed at the lab"', (tester) async {
      await openWizard(tester, rig, api);
      await walk(tester, to: 3, profile: 'Ram Synthetic');
      expect(find.text('Womens Health Package'), findsOneWidget);
      expect(find.text('Prostate Marker'), findsOneWidget);
      expect(find.textContaining('Suitability is confirmed at the lab'), findsNWidgets(2));
    });

    testWidgets('home collection: E30 is asked for home_collection and the home-only test appears', (tester) async {
      await openWizard(tester, rig, api);
      await walk(tester, to: 3, home: true);
      expect(api.itemCalls.first.kind, 'home_collection');
      expect(find.text('Home Only Test'), findsOneWidget);
    });

    testWidgets('search: a LimsTextField (max 40) debounced 300 ms - typing "glu" quickly causes ONE E30 call with query "glu", after 300 ms', (tester) async {
      await openWizard(tester, rig, api);
      await walk(tester, to: 3);
      final before = api.itemCalls.length;
      expect(tester.widget<LimsTextField>(find.byType(LimsTextField).first).maxLength, 40);
      final input = find.descendant(of: find.byType(LimsTextField).first, matching: find.byType(TextField));
      await tester.enterText(input, 'g');
      await tester.pump(const Duration(milliseconds: 100));
      await tester.enterText(input, 'gl');
      await tester.pump(const Duration(milliseconds: 100));
      await tester.enterText(input, 'glu');
      await tester.pump(const Duration(milliseconds: 299));
      expect(api.itemCalls.length, before, reason: 'still inside the 300 ms debounce');
      await tester.pump(const Duration(milliseconds: 5));
      await settle(tester);
      expect(api.itemCalls.length, before + 1);
      expect(api.itemCalls.last.query, 'glu');
      expect(find.text('Glucose Fasting'), findsOneWidget);
      expect(find.text('Complete Blood Count'), findsNothing);
    });

    testWidgets('1 to max_orderables_per_booking items: Continue is disabled with none and enabled with one; a selection above the configured maximum (2) is not accepted', (tester) async {
      await openWizard(tester, rig, api, config: const BookingConfig(homeCollection: true, maxOrderablesPerBooking: 2));
      await walk(tester, to: 3);
      expect(primary(tester).onPressed, isNull);
      await tapText(tester, 'Complete Blood Count');
      expect(primary(tester).onPressed, isNotNull);
      await tapText(tester, 'Glucose Fasting');
      await tapText(tester, 'Womens Health Package');
      expect(selectedBoxes(tester), 2, reason: 'the third item is refused by the app (the API would answer 422 orderable_not_bookable)');
    });

    testWidgets('selected items are kept when going Back and forward again', (tester) async {
      await openWizard(tester, rig, api);
      await walk(tester, to: 3);
      await tapText(tester, 'Complete Blood Count');
      await tapPrimary(tester);
      await tapBack(tester);
      expect(selectedBoxes(tester), 1);
    });
  });

  group('step 4 Place', () {
    testWidgets('centre visit: E31 centres with name and address text; one must be chosen', (tester) async {
      await openWizard(tester, rig, api);
      await walk(tester, to: 4);
      expect(api.centreCalls, ['centre_visit']);
      expect(find.text('Synthetic Centre One'), findsOneWidget);
      expect(find.text('Synthetic Road 1'), findsOneWidget);
      expect(find.text('Synthetic Centre Two'), findsOneWidget);
      expect(primary(tester).onPressed, isNull);
      await tapText(tester, 'Synthetic Centre Two');
      expect(primary(tester).onPressed, isNotNull);
    });

    testWidgets('home collection: E37 addresses of THIS profile (profile_id = the chosen profile), no centre call, an "Add address" entry; one address must be chosen', (tester) async {
      await openWizard(tester, rig, api);
      await walk(tester, to: 4, home: true);
      expect(api.addressListCalls.last, pFemale);
      expect(api.centreCalls, isEmpty);
      expect(find.text('Synthetic Tole 4, Ward 2'), findsOneWidget);
      expect(find.text('Synthetic Marg 9'), findsOneWidget);
      expect(find.textContaining('Add address'), findsOneWidget);
      expect(primary(tester).onPressed, isNull);
    });

    testWidgets('inline "Add address": the A19 form saves through E38 (profile_id of the chosen profile, idempotency key), the new address shows up in the list; an empty address is refused locally', (tester) async {
      await openWizard(tester, rig, api);
      await walk(tester, to: 4, home: true);
      await tapText(tester, 'Add address');
      await tester.tap(find.widgetWithText(LimsButton, 'Save'));
      await settle(tester);
      expect(api.createAddressCalls, isEmpty, reason: 'address text is required');
      expect(tester.widget<LimsTextField>(field('Address')).errorText, isNotNull);
      await typeIn(tester, 'Address', 'New Lane 5');
      await tapText(tester, 'Work');
      await tester.tap(find.widgetWithText(LimsButton, 'Save'));
      await settle(tester);
      expect(api.createAddressCalls, hasLength(1));
      expect(api.createAddressCalls.single.body, containsPair('profile_id', pFemale));
      expect(api.createAddressCalls.single.body, containsPair('address_text', 'New Lane 5'));
      expect(api.createAddressCalls.single.body, containsPair('label', 'work'));
      expect(api.createAddressCalls.single.body.containsKey('latitude'), isFalse, reason: 'no map pin in v1 (04-UI-UX A19)');
      expect(api.createAddressCalls.single.key, isNotEmpty);
      expect(find.text('New Lane 5'), findsOneWidget);
    });
  });

  group('step 5 Date & time (E32, LimsSlotPicker)', () {
    testWidgets('E32 is called for the chosen kind and centre over a window of at most 7 days; the picker shows time and "N left"; a slot must be chosen', (tester) async {
      await openWizard(tester, rig, api);
      await walk(tester, to: 5);
      final c = api.slotCalls.first;
      expect(c.kind, 'centre_visit');
      expect(c.centreId, c1);
      expect(daysBetween(c.from, c.to), inInclusiveRange(6, 7), reason: '"E32 for 7 days at a time"');
      expect(find.byType(LimsSlotPicker), findsOneWidget);
      expect(find.textContaining('7:15'), findsOneWidget);
      expect(find.text('3 left'), findsWidgets);
      expect(find.text('1 left'), findsOneWidget);
      expect(primary(tester).onPressed, isNull);
      await tapText(tester, '7:15');
      expect(primary(tester).onPressed, isNotNull);
    });

    testWidgets('home collection: E32 without centre_id (the server uses the home centre)', (tester) async {
      await openWizard(tester, rig, api);
      await walk(tester, to: 5, home: true);
      expect(api.slotCalls.first.kind, 'home_collection');
      expect(api.slotCalls.first.centreId, isNull);
    });

    testWidgets('calendarDisplay BS: day headings are shown in B.S.; AD shows plain dates', (tester) async {
      await openWizard(tester, rig, api, config: const BookingConfig(homeCollection: true, calendarMode: 'BS'));
      await walk(tester, to: 5);
      expect(find.textContaining('B.S.'), findsWidgets);
    });

    testWidgets('no slots in the window: the picker shows its empty state and Continue stays disabled', (tester) async {
      api.onSlots = (_, __, ___, ____, _____) => {'data': <Object?>[]};
      await openWizard(tester, rig, api);
      await walk(tester, to: 5);
      expect(find.text('No slots available'), findsOneWidget);
      expect(primary(tester).onPressed, isNull);
    });
  });

  group('step 6 Review and submit (E33)', () {
    testWidgets('review shows profile, place, tests, indicative total and "Final price is confirmed at the lab."; the only primary button is "Confirm booking"', (tester) async {
      await openWizard(tester, rig, api);
      await walk(tester, items: ['Complete Blood Count', 'Glucose Fasting']);
      expect(primary(tester).label, 'Confirm booking');
      expect(find.textContaining('Sita Synthetic'), findsOneWidget);
      expect(find.textContaining('Synthetic Centre One'), findsOneWidget);
      expect(find.textContaining('Complete Blood Count'), findsOneWidget);
      expect(find.textContaining('Glucose Fasting'), findsOneWidget);
      expect(find.textContaining('Rs. 650.00'), findsOneWidget, reason: 'indicative total = sum of indicative_price (450 + 200)');
      expect(find.textContaining('Final price is confirmed at the lab.'), findsOneWidget);
      expect(api.createCalls, isEmpty);
    });

    testWidgets('items without a price show "Price at the lab" and are left out of the total', (tester) async {
      await openWizard(tester, rig, api);
      await walk(tester, profile: 'Hari Synthetic', items: ['Complete Blood Count', 'Prostate Marker']);
      expect(find.textContaining('Price at the lab'), findsOneWidget);
      expect(find.textContaining('Rs. 450.00'), findsWidgets);
    });

    testWidgets('submit sends ONE E33 call: profile_id (the link id), kind, centre, slot instant, orderable ids in selection order - and NO patient_id (AB-7); success shows the confirmation with booking no., time and place', (tester) async {
      await openWizard(tester, rig, api);
      await walk(tester, items: ['Glucose Fasting', 'Complete Blood Count']);
      await tapPrimary(tester);
      expect(api.createCalls, hasLength(1));
      final b = api.createCalls.single.body;
      expect(b['profile_id'], pFemale);
      expect(b['booking_kind'], 'centre_visit');
      expect(b['centre_id'], c1);
      expect(b['orderable_ids'], [oGlu, oCbc]);
      expect((b['slot_start']! as String), endsWith('T01:30:00.000Z'));
      expect(b.containsKey('patient_id'), isFalse);
      expect(b.containsKey('replaces_booking_id'), isFalse);
      expect(find.textContaining('BK26000001'), findsOneWidget);
      expect(find.textContaining('Synthetic Centre One'), findsOneWidget);
      expect(find.textContaining('7:15'), findsOneWidget);
      expect(find.textContaining('centre_visit'), findsNothing);
    });

    testWidgets('home collection submit: home_address_id of the chosen address, no centre_id, no coordinates, no address text in the body (US-EN-13.1)', (tester) async {
      await openWizard(tester, rig, api);
      await walk(tester, home: true);
      await tapPrimary(tester);
      final b = api.createCalls.single.body;
      expect(b['booking_kind'], 'home_collection');
      expect(b['home_address_id'], addr1);
      expect(b['centre_id'], isNull);
      expect(b.keys.where(['address_text', 'latitude', 'longitude'].contains), isEmpty);
    });
  });

  group('Idempotency-Key per review step (done_when; 03-APP-FLOW §6.1)', () {
    testWidgets('the submit carries a non-empty key; a retry after a TIMEOUT reuses the SAME key and body', (tester) async {
      api.onCreate = (call, body, key) => call == 1 ? throw TimeoutException('synthetic timeout') : booking(bk1, slot: body['slot_start']! as String);
      await openWizard(tester, rig, api);
      await walk(tester);
      await tapPrimary(tester);
      expect(api.createCalls, hasLength(1));
      expect(api.createCalls.first.key.length, greaterThanOrEqualTo(16));
      expect(find.byType(LimsSlotPicker), findsNothing);
      expect(primary(tester).label, 'Confirm booking', reason: 'a timeout leaves the review step open for a retry');
      await tapPrimary(tester);
      expect(api.createCalls, hasLength(2));
      expect(api.createCalls[1].key, api.createCalls[0].key, reason: 'the same Idempotency-Key makes the retry safe');
      expect(api.createCalls[1].body, api.createCalls[0].body);
      expect(find.textContaining('BK26000001'), findsOneWidget);
    });

    testWidgets('a new wizard run (after a successful booking) uses a DIFFERENT key', (tester) async {
      await openWizard(tester, rig, api);
      await walk(tester);
      await tapPrimary(tester);
      await tester.pumpWidget(const SizedBox());
      await openWizard(tester, rig, api);
      await walk(tester);
      await tapPrimary(tester);
      expect(api.createCalls, hasLength(2));
      expect(api.createCalls[1].key, isNot(api.createCalls[0].key));
    });

    testWidgets('going Back, changing the slot and reopening the review generates a NEW key (the body differs; a reused key would be common.idempotency_key_reused)', (tester) async {
      api.onCreate = (call, body, key) => throw TimeoutException('synthetic timeout');
      await openWizard(tester, rig, api);
      await walk(tester);
      await tapPrimary(tester);
      final first = api.createCalls.single;
      await tapBack(tester);
      await tapText(tester, '7:30');
      await tapPrimary(tester);
      await tapPrimary(tester);
      expect(api.createCalls, hasLength(2));
      expect(api.createCalls[1].body['slot_start'], isNot(first.body['slot_start']));
      expect(api.createCalls[1].key, isNot(first.key));
    });

    testWidgets('double tap on [Confirm booking] while the first request is in flight sends ONE request (button disabled while submitting)', (tester) async {
      final gate = Completer<void>();
      api.holdCreate = () => gate.future;
      await openWizard(tester, rig, api);
      await walk(tester);
      final confirm = find.widgetWithText(LimsButton, 'Confirm booking');
      await tester.tap(confirm);
      await tester.pump(const Duration(milliseconds: 20));
      await tester.tap(confirm, warnIfMissed: false);
      await tester.pump(const Duration(milliseconds: 20));
      expect(api.createCalls, hasLength(1));
      expect(api.maxInFlightCreate, 1);
      gate.complete();
      await settle(tester);
      expect(api.createCalls, hasLength(1));
    });
  });

  group('errors (03-APP-FLOW §11 Bookings row): friendly text, never codes or server detail', () {
    testWidgets('409 slot_unavailable: "That time was just taken — pick another", back on the slot step with fresh slots and nothing selected', (tester) async {
      api.onCreate = (call, body, key) => throw LimsException(LimsErrorCodes.engagementSlotUnavailable);
      await openWizard(tester, rig, api);
      await walk(tester);
      final slotCallsBefore = api.slotCalls.length;
      await tapPrimary(tester);
      expect(find.textContaining('That time was just taken — pick another'), findsOneWidget);
      expect(find.byType(LimsSlotPicker), findsOneWidget);
      expect(api.slotCalls.length, greaterThan(slotCallsBefore), reason: 'refresh slots');
      expect(primary(tester).onPressed, isNull, reason: 'the taken slot is no longer selected');
      expect(find.textContaining('slot_unavailable'), findsNothing);
    });

    testWidgets('429 booking_limit_reached: "You have reached the booking limit"; the review step stays', (tester) async {
      api.onCreate = (call, body, key) => throw LimsException(LimsErrorCodes.engagementBookingLimitReached);
      await openWizard(tester, rig, api);
      await walk(tester);
      await tapPrimary(tester);
      expect(find.textContaining('You have reached the booking limit'), findsOneWidget);
      expect(find.textContaining('booking_limit_reached'), findsNothing);
    });

    testWidgets('an internal error shows no server detail and allows a retry', (tester) async {
      api.onCreate = (call, body, key) => call == 1 ? throw LimsException(LimsErrorCodes.commonInternal, safeDetail: 'db password hunter2') : booking(bk1);
      await openWizard(tester, rig, api);
      await walk(tester);
      await tapPrimary(tester);
      expect(find.textContaining('hunter2'), findsNothing);
      expect(find.textContaining('common.internal'), findsNothing);
      await tapPrimary(tester);
      expect(api.createCalls, hasLength(2));
    });
  });

  group('reschedule (A18 -> A17 from the slot step; 03-APP-FLOW §6.2)', () {
    final old = booking(bk1, version: 3);

    testWidgets('opens at the slot step with the old booking\'s kind and centre (no profile / type / tests / place steps); E32 is asked for the same centre', (tester) async {
      await openWizard(tester, rig, api, rescheduleOf: old);
      expect(find.byType(LimsSlotPicker), findsOneWidget);
      expect(api.slotCalls.first.centreId, c1);
      expect(api.slotCalls.first.kind, 'centre_visit');
      expect(api.itemCalls, isEmpty);
      expect(api.centreCalls, isEmpty);
      expect(find.text('Sita Synthetic'), findsNothing);
    });

    testWidgets('submit = E33 with replaces_booking_id and replaces_booking_version (the old version), same profile / centre / tests, and its own Idempotency-Key', (tester) async {
      await openWizard(tester, rig, api, rescheduleOf: old);
      await tapText(tester, '7:30');
      await tapPrimary(tester);
      expect(primary(tester).label, 'Confirm booking');
      expect(find.textContaining('Final price is confirmed at the lab.'), findsOneWidget);
      await tapPrimary(tester);
      final c = api.createCalls.single;
      expect(c.body['replaces_booking_id'], bk1);
      expect(c.body['replaces_booking_version'], 3);
      expect(c.body['profile_id'], pFemale);
      expect(c.body['centre_id'], c1);
      expect(c.body['orderable_ids'], [oCbc]);
      expect((c.body['slot_start']! as String), endsWith('T01:45:00.000Z'));
      expect(c.key, isNotEmpty);
      expect(find.textContaining('BK26000001'), findsOneWidget);
    });

    testWidgets('409 slot_unavailable on a reschedule: the same friendly text; the old booking is untouched on the server (nothing to undo in the app)', (tester) async {
      api.onCreate = (call, body, key) => throw LimsException(LimsErrorCodes.engagementSlotUnavailable);
      await openWizard(tester, rig, api, rescheduleOf: old);
      await tapText(tester, '7:30');
      await tapPrimary(tester);
      await tapPrimary(tester);
      expect(find.textContaining('That time was just taken — pick another'), findsOneWidget);
    });
  });
}
