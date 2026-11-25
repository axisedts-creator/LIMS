// M1 Sign in (C17 04-UI-UX §3.1, 03-APP-FLOW §3 Login row): every message is the spec's copy.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:phlebo_app/features/entry/ui/login_screen.dart';

import 'support/phlebo_pump.dart';

void main() {
  late List<(String, String)> calls;

  Future<void> open(WidgetTester t, {LoginOutcome outcome = LoginOutcome.ok, bool offline = false, LoginOutcome? initial, bool throws = false, Future<void> Function()? finger, String? env}) async {
    calls = [];
    await pumpPhlebo(
      t,
      LoginScreen(
        appVersion: '1.2.3+4',
        environmentName: env,
        offline: offline,
        initialOutcome: initial,
        onUseFingerprint: finger,
        onSignIn: (e, p) async {
          calls.add((e, p));
          if (throws) throw StateError('boom');
          return outcome;
        },
      ),
    );
  }

  Future<void> fill(WidgetTester t, {String email = '  user@example.test ', String password = 'pw'}) async {
    await t.enterText(find.widgetWithText(TextField, 'Email'), email);
    await t.enterText(find.widgetWithText(TextField, 'Password'), password);
    await t.pump();
  }

  bool enabled(WidgetTester t) => t.widget<LimsButton>(find.widgetWithText(LimsButton, 'Sign in')).onPressed != null;

  testWidgets('sign in is disabled until both fields are filled', (t) async {
    await open(t);
    expect(enabled(t), isFalse);
    await t.enterText(find.widgetWithText(TextField, 'Email'), 'a@b.test');
    await t.pump();
    expect(enabled(t), isFalse);
    await t.enterText(find.widgetWithText(TextField, 'Password'), 'x');
    await t.pump();
    expect(enabled(t), isTrue);
  });

  testWidgets('submits the trimmed email and the password as typed', (t) async {
    await open(t);
    await fill(t);
    await tapLabel(t, find.widgetWithText(LimsButton, 'Sign in'));
    expect(calls, [('user@example.test', 'pw')]);
  });

  for (final c in {
    LoginOutcome.badCredentials: 'Email or password is incorrect.',
    LoginOutcome.rateLimited: 'Too many attempts. Try again later.',
    LoginOutcome.locked: 'Your account is locked. Contact your lab administrator.',
    LoginOutcome.noScreenLock: 'Set a screen lock (PIN, pattern or fingerprint) on this phone first.',
    LoginOutcome.rooted: "This phone can't be used for home collection.",
    LoginOutcome.updateRequired: 'Update the app to continue.',
    LoginOutcome.otherUserUnsent: 'This phone has unsent changes from another user. Ask that user to sign in, or the lab admin to wipe it.',
    LoginOutcome.rebind: 'Sign in again to set up this phone.',
  }.entries) {
    testWidgets('${c.key.name}: shows "${c.value}" and clears the password', (t) async {
      await open(t, outcome: c.key);
      await fill(t);
      await tapLabel(t, find.widgetWithText(LimsButton, 'Sign in'));
      expect(find.text(c.value), findsOneWidget);
      expect(t.widget<TextField>(find.widgetWithText(TextField, 'Password')).controller!.text, isEmpty, reason: 'a failed attempt never keeps the password');
    });
  }

  testWidgets('a thrown error is shown as a plain failure, never as an unhandled exception', (t) async {
    await open(t, throws: true);
    await fill(t);
    await tapLabel(t, find.widgetWithText(LimsButton, 'Sign in'));
    expect(find.text("Couldn't sign in. Try again."), findsOneWidget);
    expect(t.takeException(), isNull);
  });

  testWidgets('offline: the spec message and no way to submit', (t) async {
    await open(t, offline: true);
    expect(find.text('You need an internet connection to sign in.'), findsOneWidget);
    await fill(t);
    expect(enabled(t), isFalse);
  });

  testWidgets('fingerprint is offered only when the host provides it, and works without typing', (t) async {
    await open(t);
    expect(find.text('Use fingerprint'), findsNothing);
    var used = 0;
    await open(t, finger: () async => used++);
    await tapLabel(t, find.widgetWithText(LimsButton, 'Use fingerprint'));
    expect(used, 1);
  });

  testWidgets('footer: app version always, environment only when given (non-prod)', (t) async {
    await open(t);
    expect(find.text('Phlebotomist app 1.2.3+4'), findsOneWidget);
    await open(t, env: 'Staging');
    expect(find.text('Staging · Phlebotomist app 1.2.3+4'), findsOneWidget);
  });

  testWidgets('sign-in is the one screen without LimsSecureScreen (spec §3 Global)', (t) async {
    await open(t);
    expect(find.byType(LimsSecureScreen), findsNothing);
  });

  testWidgets('2.0 text scale does not overflow', (t) async {
    await pumpPhlebo(t, LoginScreen(appVersion: '1', onSignIn: (_, __) async => LoginOutcome.ok, onUseFingerprint: () async {}, initialOutcome: LoginOutcome.otherUserUnsent), textScale: 2.0);
    expect(t.takeException(), isNull);
  });
}
