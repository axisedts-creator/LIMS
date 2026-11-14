// T-L6 — A6 Profiles (04-UI-UX A6; 03-APP-FLOW §10.1 A6 row); PRD US-EN-03.2, US-EN-04.1 (method subtitle), US-EN-06.1/.4/.5, US-EN-05.1 (pending).
// E13 listMyProfiles, E18 updateMyProfile (change relationship), E19 removeMyProfile. Contract + seams: test/support/profiles_fakes.dart.
// Choices the brief left open (cite if disputed):
//   - tile subtitle = "{relationship label} · {method text}" is NOT pinned; the subtitle must CONTAIN both ("Me"/"Child"/"Parent"/"Spouse"/"Sibling"/"Other" and the method text).
//   - [⋯] is a PopupMenuButton whose icon is Icons.more_horiz or Icons.more_vert; items "Change relationship" and "Remove".
//   - Change relationship: a dialog/sheet listing the labels; tapping a label chooses it; if a "Save" button is shown it is tapped too.
//   - Remove confirm button label: "Remove" (LimsConfirmDialog.confirmLabel); the message text is in 04-UI-UX.
//   - Paused banner follows 04-UI-UX A6: "Access to {n} profile(s) is paused. Ask the lab for a new code." with (s) resolved: 1 -> "profile is", n>1 -> "profiles are".
//     (03-APP-FLOW §10.1 and PRD US-EN-06.1 word it differently; 04-UI-UX is the screen spec.)
//   - Exactly one FilledButton on the page (LD-140 one primary); the three add-actions are LimsButton labels from 04-UI-UX A6.
//   - If-Match for E18/E19 (LD-164): the screen passes Profile.version of the tapped row to the API (seam in test/support/profiles_fakes.dart); the header itself is pinned in profiles_api_wire_test.dart.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:patient_app/features/profiles/profiles_screen.dart';

import '../../support/profiles_fakes.dart';

const addCode = 'I have a code from the lab';
const addReport = 'Add from a report message';
const addRegister = 'Register myself / my child';

Finder moreMenu() => find.byWidgetPredicate((w) => w is Icon && (w.icon == Icons.more_horiz || w.icon == Icons.more_vert));

Future<void> chooseRelationship(WidgetTester t, String label) async {
  await t.tap(find.text(label).last);
  await settle(t);
  final save = find.text('Save');
  if (save.evaluate().isNotEmpty) {
    await t.tap(save);
    await settle(t);
  }
}

void main() {
  late FakeProfilesApi api;
  setUp(() => api = FakeProfilesApi());

  Future<void> open(WidgetTester t, {FakeConfigApi? config, void Function(String)? onAdded}) async {
    await t.pumpWidget(host(ProfilesScreen(onProfileAdded: onAdded), api, config: config));
    await settle(t);
  }

  group('states (03-APP-FLOW §10.1)', () {
    testWidgets('loading: skeleton while E13 is open; no empty text yet', (t) async {
      final c = Completer<Object?>();
      api.onList = (_) => c.future;
      await t.pumpWidget(host(const ProfilesScreen(), api));
      await t.pump();
      expect(find.byType(LimsLoading), findsOneWidget);
      expect(find.text('No profiles yet'), findsNothing);
      c.complete(listBody());
      await settle(t);
      expect(find.byType(LimsLoading), findsNothing);
    });

    testWidgets('empty: "No profiles yet" + the 3 options', (t) async {
      await open(t);
      expect(find.text('No profiles yet'), findsOneWidget);
      expect(find.byType(LimsEmptyState), findsOneWidget);
      for (final a in [addCode, addReport, addRegister]) {
        expect(find.text(a), findsOneWidget, reason: a);
      }
    });

    testWidgets('error: LimsErrorState with [Retry]; Retry asks again and then lists the profile', (t) async {
      api.onList = (n) async => n == 1 ? throw LimsException('common.internal') : listBody(data: [profile()]);
      await open(t);
      expect(find.byType(LimsErrorState), findsOneWidget);
      await t.tap(find.text('Retry'));
      await settle(t);
      expect(api.listCalls, 2);
      expect(find.byType(LimsErrorState), findsNothing);
      expect(find.text('Asha Test (synthetic)'), findsOneWidget);
    });

    testWidgets('one E13 call on open, none on rebuild', (t) async {
      await open(t);
      await t.pump(const Duration(seconds: 5));
      expect(api.listCalls, 1);
    });

    testWidgets('PHI screen: wrapped in LimsSecureScreen (REQ-SEC-109, A6-A15)', (t) async {
      await open(t);
      expect(find.byType(LimsSecureScreen), findsOneWidget);
    });
  });

  group('list (US-EN-03.2, US-EN-04.1, US-EN-05.1)', () {
    setUp(() => api.onList = (_) async => listBody(data: [
          profile(),
          profile(id: pidChild, name: 'Binod Test (synthetic)', rel: 'child', method: 'self_registered'),
          profile(id: pidReport, name: 'Chandra Test (synthetic)', rel: 'parent', method: 'report_link'),
        ]));

    testWidgets('one LimsListTile per profile, in API order, with display name', (t) async {
      await open(t);
      final tiles = t.widgetList<LimsListTile>(find.byType(LimsListTile)).toList();
      expect(tiles.map((x) => x.title).toList(), ['Asha Test (synthetic)', 'Binod Test (synthetic)', 'Chandra Test (synthetic)']);
    });

    testWidgets('subtitle carries the relationship label and the method text (exact strings from 04-UI-UX A6)', (t) async {
      await open(t);
      final subs = t.widgetList<LimsListTile>(find.byType(LimsListTile)).map((x) => x.subtitle ?? '').toList();
      expect(subs[0], allOf(contains('Me'), contains('Linked with lab code')));
      expect(subs[1], allOf(contains('Child'), contains('Registered in the app')));
      expect(subs[2], allOf(contains('Parent'), contains('Linked from a report message — earlier reports are not shown')));
    });

    testWidgets('every relationship label: Me / Child / Parent / Spouse / Sibling / Other', (t) async {
      api.onList = (_) async => listBody(data: [
            for (final (i, r) in ['self', 'child', 'parent', 'spouse', 'sibling', 'other'].indexed)
              profile(id: '01950c16-0000-7000-8000-0000000001a$i', name: 'P$i (synthetic)', rel: r),
          ]);
      await open(t);
      final subs = t.widgetList<LimsListTile>(find.byType(LimsListTile)).map((x) => x.subtitle ?? '').toList();
      for (final (i, l) in ['Me', 'Child', 'Parent', 'Spouse', 'Sibling', 'Other'].indexed) {
        expect(subs[i], contains(l), reason: l);
      }
    });

    testWidgets('the raw enum wire values never show (self / link_code / report_link / self_registered)', (t) async {
      await open(t);
      for (final raw in ['link_code', 'report_link', 'self_registered']) {
        expect(find.textContaining(raw), findsNothing, reason: raw);
      }
    });

    testWidgets('the internal profile id and patient_code are not shown', (t) async {
      api.onList = (_) async => listBody(data: [
            {...profile(), 'patient_code': 'SYN-000123'}
          ]);
      await open(t);
      expect(find.textContaining(pidSelf), findsNothing);
      expect(find.textContaining('SYN-000123'), findsNothing);
    });

    testWidgets('a pending self-registration shows a spinner and "Creating record…" (US-EN-05.1)', (t) async {
      api.onList = (_) async => listBody(data: [profile()], pending: [selfReg()]);
      await open(t);
      expect(find.text('Creating record…'), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsWidgets);
      expect(find.text('Asha Test (synthetic)'), findsOneWidget);
    });

    testWidgets('no empty state when only a pending registration exists', (t) async {
      api.onList = (_) async => listBody(pending: [selfReg()]);
      await open(t);
      expect(find.text('Creating record…'), findsOneWidget);
    });
  });

  group('paused profiles (US-EN-06.1 / 06.5)', () {
    testWidgets('paused_count 0: no banner', (t) async {
      api.onList = (_) async => listBody(data: [profile()]);
      await open(t);
      expect(find.textContaining('paused'), findsNothing);
    });

    testWidgets('paused_count 1: banner "Access to 1 profile is paused. Ask the lab for a new code."; the paused profile is not listed', (t) async {
      api.onList = (_) async => listBody(data: [profile()], paused: 1);
      await open(t);
      expect(find.text('Access to 1 profile is paused. Ask the lab for a new code.'), findsOneWidget);
      expect(find.byType(LimsListTile), findsOneWidget);
    });

    testWidgets('paused_count 2: plural banner', (t) async {
      api.onList = (_) async => listBody(paused: 2);
      await open(t);
      expect(find.text('Access to 2 profiles are paused. Ask the lab for a new code.'), findsOneWidget);
    });

    testWidgets('the banner shows an icon as well as words (LD-140: tone + icon + word)', (t) async {
      api.onList = (_) async => listBody(data: [profile()], paused: 1);
      await open(t);
      final banner = find.ancestor(of: find.textContaining('is paused'), matching: find.byType(Row));
      expect(find.descendant(of: banner.first, matching: find.byType(Icon)), findsWidgets);
    });

    testWidgets('only paused profiles: banner and the 3 add options, no empty-state dead end', (t) async {
      api.onList = (_) async => listBody(paused: 1);
      await open(t);
      expect(find.textContaining('paused'), findsOneWidget);
      for (final a in [addCode, addReport]) {
        expect(find.text(a), findsOneWidget);
      }
    });
  });

  group('add actions', () {
    testWidgets('one primary (filled) button on the page, the other two are secondary (LD-140)', (t) async {
      await open(t);
      expect(primaryButtons(), findsOneWidget);
      expect(find.byType(LimsButton), findsNWidgets(3));
    });

    testWidgets('also with profiles listed: still one primary button', (t) async {
      api.onList = (_) async => listBody(data: [profile(), profile(id: pidChild, name: 'B (synthetic)', rel: 'child')]);
      await open(t);
      expect(primaryButtons(), findsOneWidget);
    });

    testWidgets('[I have a code from the lab] opens A7, [Add from a report message] opens A8, [Register myself / my child] opens A9', (t) async {
      await open(t);
      await t.tap(find.text(addCode));
      await t.pumpAndSettle();
      expect(find.byType(LimsCodeField), findsOneWidget);
      t.state<NavigatorState>(find.byType(Navigator)).pop();
      await t.pumpAndSettle();

      await t.tap(find.text(addReport));
      await t.pumpAndSettle();
      expect(find.textContaining('Paste the report link'), findsOneWidget);
      t.state<NavigatorState>(find.byType(Navigator)).pop();
      await t.pumpAndSettle();

      await t.tap(find.text(addRegister));
      await t.pumpAndSettle();
      expect(find.text('Create record'), findsOneWidget);
    });

    testWidgets('[Register myself / my child] is hidden when the tenant has no consent text_version (04-UI-UX A6)', (t) async {
      await open(t, config: FakeConfigApi(() => configBody(textVersion: null)));
      expect(find.text(addRegister), findsNothing);
      expect(find.text(addCode), findsOneWidget);
      expect(find.text(addReport), findsOneWidget);
    });

    testWidgets('a config (E1) failure hides Register but keeps the list and the other two actions', (t) async {
      api.onList = (_) async => listBody(data: [profile()]);
      await open(t, config: FakeConfigApi(() => LimsException('common.internal')));
      expect(find.text('Asha Test (synthetic)'), findsOneWidget);
      expect(find.text(addRegister), findsNothing);
      expect(find.text(addCode), findsOneWidget);
    });

    testWidgets('after A7 succeeds: toast "Profile added", the list is read again, onProfileAdded gets the new profile id (03-APP-FLOW §10.1)', (t) async {
      String? added;
      await open(t, onAdded: (id) => added = id);
      await t.tap(find.text(addCode));
      await t.pumpAndSettle();
      await t.enterText(find.byType(TextField), 'ABCDEFGHJK');
      await t.pump();
      await t.tap(primaryButtons());
      await t.pumpAndSettle();
      expect(find.text('Profile added'), findsOneWidget);
      expect(added, newProfileId);
      expect(api.listCalls, greaterThanOrEqualTo(2));
    });
  });

  group('change relationship (E18, US-EN-06 / 04-UI-UX A6)', () {
    setUp(() => api.onList = (n) async => listBody(data: [profile(), profile(id: pidChild, name: 'Binod Test (synthetic)', rel: n == 1 ? 'other' : 'parent', method: 'report_link')]));

    testWidgets('each profile has a [⋯] menu with "Change relationship" and "Remove"', (t) async {
      await open(t);
      expect(moreMenu(), findsNWidgets(2));
      await t.tap(moreMenu().first);
      await t.pumpAndSettle();
      expect(find.text('Change relationship'), findsOneWidget);
      expect(find.text('Remove'), findsOneWidget);
    });

    testWidgets('choosing "Parent" sends E18 {profile_id, relationship: parent} once and the list is read again', (t) async {
      await open(t);
      await t.tap(moreMenu().last);
      await t.pumpAndSettle();
      await t.tap(find.text('Change relationship'));
      await t.pumpAndSettle();
      await chooseRelationship(t, 'Parent');
      await t.pumpAndSettle();
      expect(api.updates, [(id: pidChild, rel: 'parent')]);
      expect(api.listCalls, 2);
      final subs = t.widgetList<LimsListTile>(find.byType(LimsListTile)).map((x) => x.subtitle ?? '').toList();
      expect(subs.last, contains('Parent'));
    });

    testWidgets('Change relationship sends the version of the tapped row, not another row\'s (LD-164)', (t) async {
      api.onList = (_) async => listBody(data: [profile(version: 2), profile(id: pidChild, name: 'Binod Test (synthetic)', rel: 'other', method: 'report_link', version: 5)]);
      await open(t);
      await t.tap(moreMenu().last);
      await t.pumpAndSettle();
      await t.tap(find.text('Change relationship'));
      await t.pumpAndSettle();
      await chooseRelationship(t, 'Parent');
      await t.pumpAndSettle();
      expect(api.updates, [(id: pidChild, rel: 'parent')]);
      expect(api.updateVersions, [5]);
    });

    testWidgets('the relationship choices are the labels Me / Child / Parent / Spouse / Sibling / Other', (t) async {
      await open(t);
      await t.tap(moreMenu().last);
      await t.pumpAndSettle();
      await t.tap(find.text('Change relationship'));
      await t.pumpAndSettle();
      for (final l in ['Child', 'Parent', 'Spouse', 'Sibling', 'Other']) {
        expect(find.text(l), findsWidgets, reason: l);
      }
      expect(api.updates, isEmpty, reason: 'opening the chooser changes nothing');
    });

    testWidgets('a failed update shows words (not a crash) and leaves the list as it was', (t) async {
      api.onUpdate = (_, __) async => throw LimsException('common.version_conflict');
      await open(t);
      await t.tap(moreMenu().last);
      await t.pumpAndSettle();
      await t.tap(find.text('Change relationship'));
      await t.pumpAndSettle();
      await chooseRelationship(t, 'Parent');
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      expect(find.text('Binod Test (synthetic)'), findsOneWidget);
      expect(find.textContaining('version_conflict'), findsNothing, reason: 'error codes are not user copy');
    });

    testWidgets('not_found on update (link was paused/removed meanwhile): the list is read again so the profile disappears', (t) async {
      api.onUpdate = (_, __) async => throw LimsException('common.not_found');
      await open(t);
      await t.tap(moreMenu().last);
      await t.pumpAndSettle();
      await t.tap(find.text('Change relationship'));
      await t.pumpAndSettle();
      await chooseRelationship(t, 'Parent');
      await t.pumpAndSettle();
      expect(api.listCalls, greaterThanOrEqualTo(2));
    });
  });

  group('remove (E19, US-EN-06.4)', () {
    setUp(() => api.onList = (n) async => n == 1
        ? listBody(data: [profile(), profile(id: pidChild, name: 'Binod Test (synthetic)', rel: 'child', method: 'self_registered')])
        : listBody(data: [profile()]));

    Future<void> openRemove(WidgetTester t) async {
      await t.tap(moreMenu().last);
      await t.pumpAndSettle();
      await t.tap(find.text('Remove'));
      await t.pumpAndSettle();
    }

    testWidgets('LimsConfirmDialog: "Remove {name}? You\'ll stop seeing their orders and reports in this app." — nothing is sent before confirm', (t) async {
      await open(t);
      await openRemove(t);
      expect(find.textContaining('Remove Binod Test (synthetic)?'), findsOneWidget);
      expect(find.textContaining("You'll stop seeing their orders and reports in this app."), findsOneWidget);
      expect(api.removed, isEmpty);
    });

    testWidgets('Cancel keeps the profile and sends nothing', (t) async {
      await open(t);
      await openRemove(t);
      await t.tap(find.text('Cancel'));
      await t.pumpAndSettle();
      expect(api.removed, isEmpty);
      expect(find.text('Binod Test (synthetic)'), findsOneWidget);
    });

    testWidgets('Confirm sends E19 for that profile only, once; the list is read again and the profile is gone', (t) async {
      await open(t);
      await openRemove(t);
      await t.tap(find.widgetWithText(FilledButton, 'Remove'));
      await t.pumpAndSettle();
      expect(api.removed, [pidChild]);
      expect(api.listCalls, 2);
      expect(find.text('Binod Test (synthetic)'), findsNothing);
      expect(find.text('Asha Test (synthetic)'), findsOneWidget);
    });

    testWidgets('Confirm sends the version of the removed row, not another row\'s (LD-164)', (t) async {
      api.onList = (n) async => n == 1
          ? listBody(data: [profile(version: 2), profile(id: pidChild, name: 'Binod Test (synthetic)', rel: 'child', method: 'self_registered', version: 7)])
          : listBody(data: [profile(version: 2)]);
      await open(t);
      await openRemove(t);
      await t.tap(find.widgetWithText(FilledButton, 'Remove'));
      await t.pumpAndSettle();
      expect(api.removed, [pidChild]);
      expect(api.removeVersions, [7]);
    });

    testWidgets('a failed remove keeps the profile visible and shows words', (t) async {
      api.onRemove = (_) async => throw LimsException('common.internal');
      api.onList = (_) async => listBody(data: [profile(id: pidChild, name: 'Binod Test (synthetic)', rel: 'child')]);
      await open(t);
      await openRemove(t);
      await t.tap(find.widgetWithText(FilledButton, 'Remove'));
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      expect(find.text('Binod Test (synthetic)'), findsOneWidget);
      expect(find.textContaining('Something went wrong'), findsOneWidget);
    });

    testWidgets('removing the last profile ends in the empty state with the 3 options', (t) async {
      api.onList = (n) async => n == 1 ? listBody(data: [profile(id: pidChild, name: 'Binod Test (synthetic)', rel: 'child')]) : listBody();
      await open(t);
      await openRemove(t);
      await t.tap(find.widgetWithText(FilledButton, 'Remove'));
      await t.pumpAndSettle();
      expect(find.text('No profiles yet'), findsOneWidget);
    });

    testWidgets('double tap on Remove sends E19 once', (t) async {
      final gate = Completer<void>();
      api.onRemove = (_) => gate.future;
      await open(t);
      await openRemove(t);
      final confirm = find.widgetWithText(FilledButton, 'Remove');
      await t.tap(confirm); // no frame between the two taps: the second one lands on the same, still-built button
      await t.tap(confirm, warnIfMissed: false);
      await t.pump();
      gate.complete();
      await t.pumpAndSettle();
      expect(api.removed, hasLength(1));
    });
  });
}
