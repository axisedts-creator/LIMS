// T-AC1 - A23 Settings (04-UI-UX A23; 03-APP-FLOW A23: E10, E11, E12, C2 logout; PRD US-EN-19.1/19.2, US-EN-23.3; LD-28 legal links). Synthetic data only.
// Fails now: lib/features/settings/ does not exist (see support/settings_fakes.dart for the impl contract).
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:patient_app/core/session/session_controller.dart';

import '../../support/rig.dart';
import '../../support/settings_fakes.dart';

void main() {
  late Rig rig;
  late FakeAccountApi api;

  setUp(() async {
    rig = await Rig.create();
    api = FakeAccountApi();
  });
  tearDown(() => rig.dispose());

  Future<Host> open(WidgetTester t, {FakeAccountApi? withApi, String? tenantPrivacyUrl, String? privacyUrl = 'https://legal.invalid/privacy', String? termsUrl = 'https://legal.invalid/terms', VoidCallback? onSignedOut}) async {
    await t.runAsync(rig.signIn);
    final h = settingsHost(rig, withApi ?? api, tenantPrivacyUrl: tenantPrivacyUrl, privacyUrl: privacyUrl, termsUrl: termsUrl, onSignedOut: onSignedOut);
    await t.pumpWidget(h.widget);
    await settleIo(t);
    return h;
  }

  Finder reminderSwitch() => find.byType(Switch);
  bool switchOn(WidgetTester t) => t.widget<Switch>(reminderSwitch()).value;
  Finder deleteButton() => find.text('Delete my app account');
  Finder dialogConfirm() => find.widgetWithText(FilledButton, 'Delete account');

  Future<void> openDeleteDialog(WidgetTester t) async {
    await t.ensureVisible(deleteButton());
    await t.tap(deleteButton());
    await t.pumpAndSettle();
  }

  Future<void> typeConfirmation(WidgetTester t, String text) async {
    await t.enterText(find.descendant(of: find.byType(AlertDialog), matching: find.byType(TextField)), text);
    await t.pump();
  }

  group('load and reminder opt-out (E10/E11, US-EN-23.3)', () {
    testWidgets('opening A23 asks E10 once and shows the SMS reminder switch as the INVERSE of reminders_opt_out', (t) async {
      await open(t);
      expect(api.getCalls, 1);
      expect(find.text('Reminder messages by SMS'), findsOneWidget);
      expect(switchOn(t), isTrue, reason: 'opt_out=false means reminders are on');
    });

    testWidgets('opt_out=true on the server: the switch is off', (t) async {
      await open(t, withApi: FakeAccountApi(optOut: true));
      expect(switchOn(t), isFalse);
    });

    testWidgets('turning the switch off sends E11 {reminders_opt_out:true} with the loaded version, and the switch stays off', (t) async {
      await open(t);
      await t.tap(reminderSwitch());
      await settleIo(t);
      expect(api.updates, [(version: 3, optOut: true)]);
      expect(switchOn(t), isFalse);
    });

    testWidgets('a second toggle uses the version E11 returned (3 -> 4), not the stale one', (t) async {
      await open(t);
      await t.tap(reminderSwitch());
      await settleIo(t);
      await t.tap(reminderSwitch());
      await settleIo(t);
      expect(api.updates, [(version: 3, optOut: true), (version: 4, optOut: false)]);
      expect(switchOn(t), isTrue);
    });

    testWidgets('a failed E11 puts the switch back to the server state and says so in words (no silent flip)', (t) async {
      api.updateFail = (_) => LimsException(LimsErrorCodes.commonInternal);
      await open(t);
      await t.tap(reminderSwitch());
      await settleIo(t);
      expect(t.takeException(), isNull);
      expect(switchOn(t), isTrue);
      expect(find.textContaining('Something went wrong'), findsOneWidget);
    });

    testWidgets('a stale version (changed on another phone) re-reads E10, shows the fresh state and lets the next toggle succeed', (t) async {
      await open(t);
      api.bump(); // another device changed the account: server version 4
      await t.tap(reminderSwitch());
      await settleIo(t);
      expect(api.getCalls, 2, reason: 'version_conflict -> E10 again');
      await t.tap(reminderSwitch());
      await settleIo(t);
      expect(api.updates.last, (version: 4, optOut: true));
    });

    testWidgets('E10 failing shows an error state, not a switch with a guessed value', (t) async {
      api.getFail = (_) => LimsException(LimsErrorCodes.commonInternal);
      await open(t);
      expect(reminderSwitch(), findsNothing);
      expect(find.textContaining('Something went wrong'), findsOneWidget);
    });
  });

  group('app lock and sign out (informational + C2 logout)', () {
    testWidgets('"App lock" is informational: a device screen lock is required, there is no switch for it', (t) async {
      await open(t);
      expect(find.text('App lock'), findsOneWidget);
      expect(find.byType(Switch), findsOneWidget, reason: 'only the reminder switch');
    });

    testWidgets('Sign out calls the C2 logout once, wipes the local session and tells the host', (t) async {
      var signedOut = 0;
      await open(t, onSignedOut: () => signedOut++);
      await t.ensureVisible(find.text('Sign out'));
      await t.tap(find.text('Sign out'));
      await settleIo(t);
      expect(rig.identity.logoutCalls, 1);
      expect(rig.controller.status.value, SessionStatus.signedOut);
      expect(signedOut, 1);
      expect(api.deletes, isEmpty);
    });
  });

  group('delete my app account (E12, US-EN-19.1 / 19.2, 04-UI-UX A23)', () {
    testWidgets('the button opens a danger dialog with the lab name, the DELETE typed confirmation, and nothing is sent yet', (t) async {
      await open(t);
      await openDeleteDialog(t);
      expect(find.textContaining('This deletes your app account and removes all profiles from this app.'), findsOneWidget);
      expect(find.textContaining('Your records at Synthetic Lab Alpha are not deleted.'), findsOneWidget);
      expect(find.descendant(of: find.byType(AlertDialog), matching: find.byType(TextField)), findsOneWidget);
      expect(api.deletes, isEmpty);
    });

    testWidgets('Confirm stays disabled until the text is exactly DELETE (case-sensitive, no spaces)', (t) async {
      await open(t);
      await openDeleteDialog(t);
      expect(t.widget<FilledButton>(dialogConfirm()).onPressed, isNull);
      for (final wrong in ['delete', 'Delete', 'DELET', 'DELETE ', ' DELETE', 'DELETE!']) {
        await typeConfirmation(t, wrong);
        expect(t.widget<FilledButton>(dialogConfirm()).onPressed, isNull, reason: '"$wrong" must not enable Confirm');
      }
      await typeConfirmation(t, 'DELETE');
      expect(t.widget<FilledButton>(dialogConfirm()).onPressed, isNotNull);
      await typeConfirmation(t, 'DELETEX');
      expect(t.widget<FilledButton>(dialogConfirm()).onPressed, isNull, reason: 'editing it away again disables Confirm');
    });

    testWidgets('Cancel sends nothing, keeps the session, and a re-opened dialog starts empty', (t) async {
      await open(t);
      await openDeleteDialog(t);
      await typeConfirmation(t, 'DELETE');
      await t.tap(find.text('Cancel'));
      await t.pumpAndSettle();
      expect(api.deletes, isEmpty);
      expect(rig.controller.status.value, SessionStatus.signedIn);
      await openDeleteDialog(t);
      expect(t.widget<FilledButton>(dialogConfirm()).onPressed, isNull, reason: 'the typed text must not survive a cancel');
    });

    testWidgets('Confirm sends E12 once with the loaded version; then the LOCAL session is wiped without a server logout (C2 already revoked it) and the host is told', (t) async {
      var signedOut = 0;
      await open(t, onSignedOut: () => signedOut++);
      await openDeleteDialog(t);
      await typeConfirmation(t, 'DELETE');
      await t.tap(dialogConfirm());
      await settleIo(t);
      expect(api.deletes, [3]);
      expect(api.deleted, isTrue);
      expect(rig.controller.status.value, SessionStatus.signedOut);
      expect(rig.identity.logoutCalls, 0, reason: 'sessions are already revoked server-side; a logout call would only fail');
      expect(signedOut, 1);
      expect(await t.runAsync(() => rig.store.read()), isNull, reason: 'the stored session token is wiped');
    });

    testWidgets('a double tap on Confirm while E12 is in flight sends ONE request', (t) async {
      final hold = Completer<void>();
      api.hold = hold.future;
      await open(t);
      await openDeleteDialog(t);
      await typeConfirmation(t, 'DELETE');
      await t.tap(dialogConfirm());
      await t.pump();
      final again = dialogConfirm();
      if (again.evaluate().isNotEmpty) await t.tap(again, warnIfMissed: false);
      await t.pump();
      expect(api.deletes.length, 1);
      hold.complete();
      await settleIo(t);
      expect(api.deletes.length, 1);
    });

    testWidgets('a failed E12 keeps the user signed in, says so in words and sends no logout; a retry is a new request', (t) async {
      api.deleteFail = (n) => n == 1 ? LimsException(LimsErrorCodes.commonInternal) : null;
      await open(t);
      await openDeleteDialog(t);
      await typeConfirmation(t, 'DELETE');
      await t.tap(dialogConfirm());
      await settleIo(t);
      expect(t.takeException(), isNull);
      expect(rig.controller.status.value, SessionStatus.signedIn);
      expect(rig.identity.logoutCalls, 0);
      expect(find.textContaining('Something went wrong'), findsOneWidget);
      expect(api.deleted, isFalse);
    });

    testWidgets('a stale version on E12 re-reads E10 and does not wipe the session', (t) async {
      await open(t);
      api.bump();
      await openDeleteDialog(t);
      await typeConfirmation(t, 'DELETE');
      await t.tap(dialogConfirm());
      await settleIo(t);
      expect(api.getCalls, 2);
      expect(rig.controller.status.value, SessionStatus.signedIn);
      expect(api.deleted, isFalse);
    });
  });

  group('legal links (LD-28): system browser, from the build config', () {
    testWidgets('"Privacy policy" and "Terms of use" open the flavour URLs through the external opener', (t) async {
      final h = await open(t);
      await t.ensureVisible(find.text('Privacy policy'));
      await t.tap(find.text('Privacy policy'));
      await t.pump();
      await t.ensureVisible(find.text('Terms of use'));
      await t.tap(find.text('Terms of use'));
      await t.pump();
      expect(h.opened, [Uri.parse('https://legal.invalid/privacy'), Uri.parse('https://legal.invalid/terms')]);
    });

    testWidgets('the tenant privacy URL, when configured, is a second "Privacy policy" link under the lab name', (t) async {
      final h = await open(t, tenantPrivacyUrl: 'https://lab.invalid/privacy');
      expect(find.text('Synthetic Lab Alpha'), findsWidgets);
      expect(find.text('Privacy policy'), findsNWidgets(2));
      await t.tap(find.text('Privacy policy').first);
      await t.pump();
      expect(h.opened.single.toString(), anyOf('https://lab.invalid/privacy', 'https://legal.invalid/privacy'));
    });

    testWidgets('an empty or missing URL hides its link instead of showing a dead one', (t) async {
      await open(t, privacyUrl: '', termsUrl: null);
      expect(find.text('Privacy policy'), findsNothing);
      expect(find.text('Terms of use'), findsNothing);
    });
  });
}
