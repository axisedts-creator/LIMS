// HC-T27 M12 Settings/About + sign-out (04-UI-UX §3.12, US-13-1/2 device side, TRD §7.4 step 5).
// ASSUMED API: SettingsScreen({deviceId, appVersion, userDisplayName, lastDownload, lastUpload, pendingCount, signOut, onSignedOut}),
// SignOutResult { done, unsyncedChanges } (support/hc27_fixture.dart). The screen only asks `signOut`; the server calls
// (signOffPhleboDevice, logoutMobileSession) and the wipe belong to the injected function, not the widget.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:phlebo_app/features/settings/domain/sign_out.dart';
import 'package:phlebo_app/features/settings/ui/settings_screen.dart';

import 'support/hc27_fixture.dart';

void main() {
  late int signOutCalls;
  late int signedOut;

  Future<void> open(
    WidgetTester t, {
    int pending = 0,
    SignOutResult result = SignOutResult.done,
    double textScale = 1.0,
  }) async {
    signOutCalls = 0;
    signedOut = 0;
    await pumpScreen(
      t,
      SettingsScreen(
        deviceId: deviceIdLong,
        appVersion: '1.4.0+27',
        userDisplayName: displayName,
        lastDownload: DateTime(2026, 11, 14, 8, 30),
        lastUpload: DateTime(2026, 11, 14, 9, 15),
        pendingCount: pending,
        signOut: () async {
          signOutCalls++;
          return result;
        },
        onSignedOut: () => signedOut++,
      ),
      textScale: textScale,
    );
  }

  Finder dialogButton(String label) => find.descendant(of: find.byType(AlertDialog), matching: find.text(label));

  testWidgets('About: device id (last 8 only), app version, user display name, last download and upload times', (t) async {
    await open(t);
    expect(find.textContaining('001b0001'), findsOneWidget, reason: 'last 8 characters of the device id');
    expect(find.textContaining(deviceIdLong), findsNothing, reason: 'the full device id is never shown');
    expect(find.textContaining('1.4.0+27'), findsOneWidget);
    expect(find.text(displayName), findsOneWidget);
    expect(find.textContaining('08:30'), findsOneWidget);
    expect(find.textContaining('09:15'), findsOneWidget);
  });

  testWidgets('US-13-1: pending > 0 disables Sign out and says "Sync first — n changes are not uploaded yet"', (t) async {
    await open(t, pending: 4);
    expect(isEnabled(t, 'Sign out'), isFalse);
    expect(find.text('Sync first — 4 changes are not uploaded yet'), findsOneWidget);
    await t.tap(button('Sign out'), warnIfMissed: false);
    await t.pumpAndSettle();
    expect(find.byType(AlertDialog), findsNothing, reason: 'no confirmation for a blocked action');
    expect(signOutCalls, 0);
  });

  testWidgets('empty outbox: Sign out enabled, no "Sync first" text', (t) async {
    await open(t);
    expect(isEnabled(t, 'Sign out'), isTrue);
    expect(find.textContaining('Sync first'), findsNothing);
  });

  testWidgets('US-13-2: confirmation "Signing out erases today\'s visit list from this phone."; Cancel signs nothing out', (t) async {
    await open(t);
    await tapButton(t, 'Sign out');
    expect(find.text("Signing out erases today's visit list from this phone."), findsOneWidget);
    expect(signOutCalls, 0, reason: 'not before the user confirms');
    await t.tap(dialogButton('Cancel'));
    await t.pumpAndSettle();
    expect(signOutCalls, 0);
    expect(signedOut, 0);
  });

  testWidgets('US-13-2: confirm -> signOut runs once -> onSignedOut', (t) async {
    await open(t);
    await tapButton(t, 'Sign out');
    await t.tap(dialogButton('Sign out'));
    await t.pumpAndSettle();
    expect(signOutCalls, 1);
    expect(signedOut, 1);
  });

  testWidgets('US-13-2: server says 409 homecollection.unsynced_changes -> refused, stays signed in, tells the user to sync', (t) async {
    await open(t, result: SignOutResult.unsyncedChanges);
    await tapButton(t, 'Sign out');
    await t.tap(dialogButton('Sign out'));
    await t.pumpAndSettle();
    expect(signOutCalls, 1);
    expect(signedOut, 0, reason: 'sign-out refused: nothing is destroyed');
    expect(find.textContaining('Sync first'), findsOneWidget);
    expect(find.text(displayName), findsOneWidget, reason: 'still on the settings screen');
  });

  testWidgets('a thrown sign-out error (offline) is shown, nothing signed out, no crash', (t) async {
    signOutCalls = 0;
    signedOut = 0;
    await pumpScreen(
      t,
      SettingsScreen(
        deviceId: deviceIdLong,
        appVersion: '1.4.0+27',
        userDisplayName: displayName,
        lastDownload: null,
        lastUpload: null,
        pendingCount: 0,
        signOut: () async => throw StateError('offline'),
        onSignedOut: () => signedOut++,
      ),
    );
    await tapButton(t, 'Sign out');
    await t.tap(dialogButton('Sign out'));
    await t.pumpAndSettle();
    expect(signedOut, 0);
    expect(find.textContaining('connection'), findsOneWidget, reason: 'plain-language offline message');
    expect(t.takeException(), isNull);
  });

  testWidgets('while sign-out is running Sign out is disabled: a second attempt does not start another', (t) async {
    final gate = Completer<SignOutResult>();
    signOutCalls = 0;
    signedOut = 0;
    await pumpScreen(
      t,
      SettingsScreen(
        deviceId: deviceIdLong,
        appVersion: '1.4.0+27',
        userDisplayName: displayName,
        lastDownload: null,
        lastUpload: null,
        pendingCount: 0,
        signOut: () {
          signOutCalls++;
          return gate.future;
        },
        onSignedOut: () => signedOut++,
      ),
    );
    await tapButton(t, 'Sign out');
    await t.tap(dialogButton('Sign out'));
    await t.pump();
    expect(isEnabled(t, 'Sign out'), isFalse, reason: 'busy');
    expect(signOutCalls, 1);
    gate.complete(SignOutResult.done);
    await t.pumpAndSettle();
    expect(signOutCalls, 1);
    expect(signedOut, 1);
  });

  testWidgets('never-synced phone: missing times render as a dash, no crash', (t) async {
    await pumpScreen(
      t,
      SettingsScreen(
        deviceId: deviceIdLong,
        appVersion: '1.4.0+27',
        userDisplayName: displayName,
        lastDownload: null,
        lastUpload: null,
        pendingCount: 0,
        signOut: () async => SignOutResult.done,
        onSignedOut: () {},
      ),
    );
    expect(find.text('—'), findsWidgets);
    expect(t.takeException(), isNull);
  });

  testWidgets('LD-140: LimsSecureScreen + LimsScaffold, one primary button, 2.0 text scale does not overflow', (t) async {
    await open(t, pending: 4, textScale: 2.0);
    expect(find.byType(LimsSecureScreen), findsOneWidget);
    expect(find.byType(LimsScaffold), findsOneWidget);
    expectOnePrimary(t);
    expect(t.takeException(), isNull);
  });
}
