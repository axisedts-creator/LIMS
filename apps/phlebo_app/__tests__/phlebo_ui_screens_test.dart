// PHLEBO-UI-FULL-1: every screen lays out on a small phone at 1.0 and 2.0 text scale; the gate, sign-in and Today behave.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:phlebo_app/app/controller.dart';
import 'package:phlebo_app/app/router.dart';
import 'package:phlebo_app/app/shell.dart';
import 'package:phlebo_app/app/theme.dart';
import 'package:phlebo_app/core/platform/phone.dart';
import 'package:phlebo_app/features/help/ui/help_screens.dart';
import 'package:phlebo_app/features/login/ui/gate_screens.dart';

import 'support/db_fixture.dart';
import 'support/outbox_fixture.dart' show FakeBootId, FakeMonotonicClock;
import 'support/ui_screens.dart';

Future<void> _pump(WidgetTester t, Widget screen, {double scale = 1}) async {
  t.view.physicalSize = const Size(360, 740);
  t.view.devicePixelRatio = 1;
  addTearDown(t.view.reset);
  await t.pumpWidget(MaterialApp(
    theme: phleboTheme(),
    builder: (c, child) => MediaQuery(data: MediaQuery.of(c).copyWith(textScaler: TextScaler.linear(scale)), child: child!),
    home: screen,
  ));
  await t.pump(const Duration(milliseconds: 600)); // card fade-in; spinners never settle
}

class _NoPhone implements Phone {
  /// The lock screen asks at once; the prompt is simply never answered here.
  @override
  Future<bool> hasScreenLock() => Completer<bool>().future;

  @override
  dynamic noSuchMethod(Invocation invocation) => throw StateError('no phone in this test');
}

AppController _controller() => AppController(
      phone: _NoPhone(),
      keyStore: FakeKeyStore(),
      apiBuilder: (_, __, ___) => throw StateError('no network in this test'),
      clock: FakeMonotonicClock(0),
      bootId: FakeBootId('b'),
      appVersion: '0.0.0',
    );

void main() {
  group('layout', () {
    for (final entry in demoScreens().entries) {
      for (final scale in [1.0, 2.0]) {
        testWidgets('${entry.key} at text scale $scale has no overflow or error', (t) async {
          await _pump(t, entry.value(), scale: scale);
          expect(t.takeException(), isNull);
        });
      }
    }
  });

  testWidgets('sign in: the button is off until both fields are filled; a failure clears the password', (t) async {
    final calls = <(String, String)>[];
    await _pump(
        t,
        SignInScreen(
            versionLabel: 'v',
            onSignIn: (e, p) async {
              calls.add((e, p));
              return badLoginText;
            }));
    FilledButton button() =>
        t.widget<FilledButton>(find.descendant(of: find.byKey(const ValueKey('login.submit')), matching: find.byType(FilledButton)));
    expect(button().onPressed, isNull);
    await t.enterText(find.byKey(const ValueKey('login.email')), '  person@example.test ');
    await t.pump();
    expect(button().onPressed, isNull);
    await t.enterText(find.byKey(const ValueKey('login.password')), 'synthetic');
    await t.pump();
    await t.ensureVisible(find.byKey(const ValueKey('login.submit')));
    await t.pump();
    await t.tap(find.byKey(const ValueKey('login.submit')));
    await t.pump(const Duration(milliseconds: 300));
    expect(calls, [('person@example.test', 'synthetic')]);
    expect(find.text(badLoginText), findsOneWidget);
    expect(button().onPressed, isNull, reason: 'password was cleared');
    final password = t.widget<TextField>(find.descendant(of: find.byKey(const ValueKey('login.password')), matching: find.byType(TextField)));
    expect(password.obscureText, isTrue);
    expect(password.enableSuggestions, isFalse);
  });

  testWidgets('today: one button opens the next stop; collected, partly collected and missed are labelled', (t) async {
    await _pump(t, demoScreens()['today']!());
    expect(find.text('2 of 5 collected'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Open visit'), findsOneWidget);
    await t.scrollUntilVisible(find.text('Missed'), 200, scrollable: find.byType(Scrollable).first);
    expect(find.text('Partly collected'), findsOneWidget);
  });

  testWidgets('FAQ search filters and says when nothing matches', (t) async {
    await _pump(t, const FaqScreen());
    await t.enterText(find.byType(TextField), 'signal');
    await t.pump();
    expect(find.byType(ExpansionTile), findsOneWidget);
    await t.enterText(find.byType(TextField), 'zzzz');
    await t.pump();
    expect(find.text('No answers found'), findsOneWidget);
  });

  testWidgets('gate: the app is hidden and cannot take focus while locked, and comes back with its state', (t) async {
    final c = _controller()..phase = AppPhase.ready;
    final focus = FocusNode();
    addTearDown(focus.dispose);
    final typed = TextEditingController(text: 'kept');
    addTearDown(typed.dispose);
    await t.pumpWidget(MaterialApp(
      theme: phleboTheme(),
      home: PhaseGate(
        controller: c,
        versionLabel: 'v',
        onSignedOut: () {},
        child: Scaffold(body: TextField(focusNode: focus, controller: typed, autofocus: true)),
      ),
    ));
    await t.pump();
    expect(focus.hasFocus, isTrue);

    c.phase = AppPhase.locked;
    c.notifyListeners(); // ignore: invalid_use_of_protected_member, invalid_use_of_visible_for_testing_member
    await t.pump();
    await t.pump(const Duration(milliseconds: 300));
    expect(find.byType(LockScreen), findsOneWidget);
    // The page stays in the tree to keep its state; it is not painted and cannot be touched.
    expect(find.text('kept').hitTestable(), findsNothing);
    expect(t.widgetList<Visibility>(find.byType(Visibility)).any((v) => !v.visible && v.maintainState), isTrue);
    focus.requestFocus();
    await t.pump();
    expect(focus.hasFocus, isFalse, reason: 'a hardware scanner must not type into the hidden screen');

    c.phase = AppPhase.signedOut;
    c.notifyListeners(); // ignore: invalid_use_of_protected_member, invalid_use_of_visible_for_testing_member
    await t.pump(const Duration(milliseconds: 300));
    expect(find.byType(LockScreen), findsNothing);
    expect(find.byType(SignInScreen), findsOneWidget, reason: 'the cover follows the phase');

    c.phase = AppPhase.ready;
    c.notifyListeners(); // ignore: invalid_use_of_protected_member, invalid_use_of_visible_for_testing_member
    await t.pump();
    expect(find.byType(SignInScreen), findsNothing);
    expect(find.text('kept'), findsOneWidget);
  });

  testWidgets('resetNavigation closes pages opened with Navigator', (t) async {
    final router = GoRouter(routes: [GoRoute(path: '/', builder: (_, __) => const Scaffold(body: Text('home')))]);
    await t.pumpWidget(MaterialApp.router(routerConfig: router));
    await t.pumpAndSettle();
    router.routerDelegate.navigatorKey.currentState!
        .push(MaterialPageRoute<void>(builder: (_) => const Scaffold(body: Text('settings'))));
    await t.pumpAndSettle();
    expect(find.text('settings'), findsOneWidget);
    resetNavigation(router);
    await t.pumpAndSettle();
    expect(find.text('settings'), findsNothing);
    expect(find.text('home'), findsOneWidget);
  });
}
