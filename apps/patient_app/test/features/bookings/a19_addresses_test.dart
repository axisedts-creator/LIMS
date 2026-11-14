// T-BK1 — A19 addresses (04-UI-UX A19 field table; 02-TRD §5 E37-E40; 01-PRD US-EN-13.1; 07-SECURITY REQ-SEC-098 / 109: addresses are P2 PII).
// Contract: header of test/support/bookings_fakes.dart. Assumed chrome pinned here: tapping an address row opens the form prefilled (controllers hold the current text); the form has a primary-looking "Save" LimsButton,
// the label control offers the words Home / Work / Other, an edit form has a secondary "Remove address" button that asks for confirmation ("Remove" / "Cancel") before E40; the list has "Add address". Synthetic data only.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:patient_app/features/bookings/addresses_screen.dart';

import '../../support/bookings_fakes.dart';
import '../../support/rig.dart';

Future<void> openAddresses(WidgetTester t, Rig rig, FakeBookingsApi api) async {
  await t.pumpWidget(bookingsScope(rig, api, home: const AddressesScreen()));
  await settle(t);
}

Finder save() => find.widgetWithText(LimsButton, 'Save');
String controllerText(WidgetTester t, String label) => t.widget<LimsTextField>(field(label)).controller?.text ?? '';

void main() {
  late Rig rig;
  late FakeBookingsApi api;

  setUp(() async {
    rig = await Rig.create();
    api = FakeBookingsApi();
  });
  tearDown(() => rig.dispose());

  testWidgets('A19 lists the account\'s addresses (E37, no profile filter) inside a LimsSecureScreen; empty -> LimsEmptyState; the list offers "Add address"', (tester) async {
    await openAddresses(tester, rig, api);
    expect(api.addressListCalls, [null]);
    expect(find.byType(LimsSecureScreen), findsOneWidget);
    expect(find.text('Synthetic Tole 4, Ward 2'), findsOneWidget);
    expect(find.text('Synthetic Marg 9'), findsOneWidget);
    expect(find.textContaining('Add address'), findsOneWidget);
    api.addresses = [];
    await tester.pumpWidget(const SizedBox()); // unmount so initState/_load runs again (T-BK1 ruling)
    await openAddresses(tester, rig, api);
    expect(api.addressListCalls.length, 2);
    expect(find.byType(LimsEmptyState), findsOneWidget);
  });

  group('form (A19 field table)', () {
    Future<void> openForm(WidgetTester t) async {
      await openAddresses(t, rig, api);
      await tapText(t, 'Add address');
    }

    testWidgets('fields and limits: Address 300, Landmark 120, Municipality 80, Ward no. 2, District 60, Contact phone 15; label Home / Work / Other; NO map pin / latitude / longitude control', (tester) async {
      await openForm(tester);
      expect(tester.widget<LimsTextField>(field('Address')).maxLength, 300);
      expect(tester.widget<LimsTextField>(field('Landmark')).maxLength, 120);
      expect(tester.widget<LimsTextField>(field('Municipality')).maxLength, 80);
      expect(tester.widget<LimsTextField>(field('Ward no.')).maxLength, 2);
      expect(tester.widget<LimsTextField>(field('District')).maxLength, 60);
      expect(tester.widget<LimsTextField>(field('Contact phone')).maxLength, 15);
      for (final l in ['Home', 'Work', 'Other']) {
        expect(find.text(l), findsOneWidget);
      }
      expect(find.textContaining(RegExp('latitude|longitude|pin on map|map', caseSensitive: false)), findsNothing);
    });

    testWidgets('only Address is required: an empty address (or whitespace) shows a field error and sends nothing', (tester) async {
      await openForm(tester);
      await tester.tap(save());
      await settle(tester);
      expect(api.createAddressCalls, isEmpty);
      expect(tester.widget<LimsTextField>(field('Address')).errorText, isNotNull);
      await typeIn(tester, 'Address', '   ');
      await tester.tap(save());
      await settle(tester);
      expect(api.createAddressCalls, isEmpty);
    });

    testWidgets('ward no. must be 1-99 and the phone E.164: invalid values are refused locally (nothing sent), valid ones are sent as ward_no (int) and contact_phone_e164', (tester) async {
      await openForm(tester);
      await typeIn(tester, 'Address', 'Synthetic Lane 7');
      await typeIn(tester, 'Ward no.', '0');
      await tester.tap(save());
      await settle(tester);
      expect(api.createAddressCalls, isEmpty);
      await typeIn(tester, 'Ward no.', '12');
      await typeIn(tester, 'Contact phone', '9800000000');
      await tester.tap(save());
      await settle(tester);
      expect(api.createAddressCalls, isEmpty, reason: 'not E.164 (+ and country code)');
      await typeIn(tester, 'Contact phone', '+9779800000000');
      await tester.tap(save());
      await settle(tester);
      expect(api.createAddressCalls, hasLength(1));
      final b = api.createAddressCalls.single.body;
      expect(b['ward_no'], 12);
      expect(b['contact_phone_e164'], '+9779800000000');
      expect(b['address_text'], 'Synthetic Lane 7');
    });

    testWidgets('create: body has profile_id (a profile of the account - never patient_id / account_id), label, optional fields only when filled; an Idempotency-Key is sent; the new address appears', (tester) async {
      await openForm(tester);
      await typeIn(tester, 'Address', 'New Lane 5');
      await typeIn(tester, 'Landmark', 'Near the temple');
      await tapText(tester, 'Other');
      await tester.tap(save());
      await settle(tester);
      final c = api.createAddressCalls.single;
      expect(c.key.length, greaterThanOrEqualTo(16));
      expect(c.body['profile_id'], isIn([pFemale, pUnknown, pMale]));
      expect(c.body['label'], 'other');
      expect(c.body['landmark'], 'Near the temple');
      expect(c.body.keys.where(['patient_id', 'account_id', 'latitude', 'longitude', 'municipality', 'district', 'ward_no'].contains), isEmpty);
      expect(find.text('New Lane 5'), findsOneWidget);
    });

    testWidgets('a retry after a timeout reuses the same Idempotency-Key (P-8)', (tester) async {
      var n = 0;
      api.onCreateAddress = (call, body, key) {
        n++;
        if (n == 1) throw TimeoutException('synthetic timeout');
        return address('01950c16-0000-7000-8000-000000000f99', text: body['address_text']! as String, label: body['label']! as String);
      };
      await openForm(tester);
      await typeIn(tester, 'Address', 'New Lane 5');
      await tester.tap(save());
      await settle(tester);
      await tester.tap(save());
      await settle(tester);
      expect(api.createAddressCalls, hasLength(2));
      expect(api.createAddressCalls[1].key, api.createAddressCalls[0].key);
    });

    testWidgets('409 link_limit_reached (more than 10): friendly text, no code, the form stays open with the typed text', (tester) async {
      api.onCreateAddress = (call, body, key) => throw LimsException(LimsErrorCodes.engagementLinkLimitReached);
      await openForm(tester);
      await typeIn(tester, 'Address', 'New Lane 5');
      await tester.tap(save());
      await settle(tester);
      expect(find.textContaining('link_limit_reached'), findsNothing);
      expect(controllerText(tester, 'Address'), 'New Lane 5');
    });

    testWidgets('server detail never shows (an internal error with a hostile safeDetail)', (tester) async {
      api.onCreateAddress = (call, body, key) => throw LimsException(LimsErrorCodes.commonInternal, safeDetail: 'db password hunter2');
      await openForm(tester);
      await typeIn(tester, 'Address', 'New Lane 5');
      await tester.tap(save());
      await settle(tester);
      expect(find.textContaining('hunter2'), findsNothing);
    });
  });

  group('edit (E39) and remove (E40)', () {
    testWidgets('tapping a row opens the form prefilled; Save sends E39 with If-Match = the address version, the same profile_id and the changed text', (tester) async {
      api.addresses = [address(addr1, version: 3)];
      await openAddresses(tester, rig, api);
      await tapText(tester, 'Synthetic Tole 4, Ward 2');
      expect(controllerText(tester, 'Address'), 'Synthetic Tole 4, Ward 2');
      await typeIn(tester, 'Address', 'Synthetic Tole 4, Ward 3');
      await tester.tap(save());
      await settle(tester);
      expect(api.updateAddressCalls, hasLength(1));
      expect(api.updateAddressCalls.single.id, addr1);
      expect(api.updateAddressCalls.single.version, 3);
      expect(api.updateAddressCalls.single.body, containsPair('profile_id', pFemale));
      expect(api.updateAddressCalls.single.body, containsPair('address_text', 'Synthetic Tole 4, Ward 3'));
      expect(api.createAddressCalls, isEmpty);
      expect(find.text('Synthetic Tole 4, Ward 3'), findsOneWidget);
    });

    testWidgets('409 version_conflict on save: the list is refetched, no code shown', (tester) async {
      api.onUpdateAddress = (call, id, version, body) => throw LimsException(LimsErrorCodes.commonVersionConflict);
      await openAddresses(tester, rig, api);
      await tapText(tester, 'Synthetic Tole 4, Ward 2');
      await typeIn(tester, 'Address', 'Changed');
      final before = api.addressListCalls.length;
      await tester.tap(save());
      await settle(tester);
      expect(find.textContaining('version_conflict'), findsNothing);
      expect(api.addressListCalls.length, greaterThan(before));
    });

    testWidgets('"Remove address" asks first; Cancel sends nothing; Remove sends E40 with If-Match = the version and the address leaves the list', (tester) async {
      api.addresses = [address(addr1, version: 2), address(addr2, text: 'Synthetic Marg 9', label: 'work')];
      await openAddresses(tester, rig, api);
      await tapText(tester, 'Synthetic Tole 4, Ward 2');
      await tester.tap(find.widgetWithText(LimsButton, 'Remove address'));
      await settle(tester);
      expect(find.byType(AlertDialog), findsOneWidget);
      await tester.tap(find.descendant(of: find.byType(AlertDialog), matching: find.text('Cancel')));
      await settle(tester);
      expect(api.deactivateCalls, isEmpty);
      await tester.tap(find.widgetWithText(LimsButton, 'Remove address'));
      await settle(tester);
      await tester.tap(find.descendant(of: find.byType(AlertDialog), matching: find.text('Remove')));
      await settle(tester);
      expect(api.deactivateCalls, [(id: addr1, version: 2)]);
      expect(find.text('Synthetic Tole 4, Ward 2'), findsNothing);
      expect(find.text('Synthetic Marg 9'), findsOneWidget);
    });
  });
}
