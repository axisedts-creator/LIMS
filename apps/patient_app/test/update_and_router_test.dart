// T-A1 — 426 -> A1 update screen (04-UI-UX A1), route table from routes.yaml ids, redirect rules.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:patient_app/app/router.dart';
import 'package:patient_app/app/update_required_screen.dart';
import 'package:patient_app/core/session/session_controller.dart';

void main() {
  group('A1 Update required', () {
    final store = Uri.parse('https://play.google.com/store/apps/details?id=example.demo_lab');

    testWidgets('shows the spec copy and only the Open store action', (tester) async {
      Uri? opened;
      await tester.pumpWidget(MaterialApp(home: UpdateRequiredScreen(storeUrl: store, openUrl: (u) async => opened = u)));
      expect(find.text('Update required'), findsOneWidget);
      expect(find.text('This version of the app is no longer supported. Please update to continue.'), findsOneWidget);
      expect(find.text('Open store'), findsOneWidget);
      expect(find.byType(BackButton), findsNothing);
      expect(find.byType(BottomNavigationBar), findsNothing);
      await tester.tap(find.text('Open store'));
      await tester.pump();
      expect(opened, store);
    });

    testWidgets('cannot be popped away', (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: Builder(
          builder: (c) => TextButton(
            onPressed: () => Navigator.of(c).push(MaterialPageRoute<void>(
              builder: (_) => UpdateRequiredScreen(storeUrl: store, openUrl: (_) async {}),
            )),
            child: const Text('go'),
          ),
        ),
      ));
      await tester.tap(find.text('go'));
      await tester.pumpAndSettle();
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(find.text('Update required'), findsOneWidget);
    });
  });

  group('router', () {
    test('registers every patient_app.* route id of routes.yaml (path params as :name)', () {
      final expected = {
        for (final e in limsRoutePaths.entries)
          if (e.key.startsWith('patient_app.')) e.value.replaceAllMapped(RegExp(r'\{(\w+)\}'), (m) => ':${m[1]}'),
      };
      expect(expected, isNotEmpty);
      expect(patientRoutePatterns.toSet().containsAll(expected), isTrue, reason: 'missing: ${expected.difference(patientRoutePatterns.toSet())}');
    });

    test('update required wins over everything and A1 itself is stable', () {
      expect(patientRedirect(updateRequired: true, status: SessionStatus.signedIn, location: '/orders/x'), kUpdateRequiredPath);
      expect(patientRedirect(updateRequired: true, status: SessionStatus.signedOut, location: kSignInPath), kUpdateRequiredPath);
      expect(patientRedirect(updateRequired: true, status: SessionStatus.signedIn, location: kUpdateRequiredPath), isNull);
    });

    test('signed out: deep links to PHI screens go to sign-in; sign-in itself is reachable', () {
      for (final p in ['/orders/0193a5c0-0000-7000-8000-000000000001', '/reports/r1', '/bookings/b1', '/payments/p1/done']) {
        expect(patientRedirect(updateRequired: false, status: SessionStatus.signedOut, location: p), kSignInPath, reason: p);
      }
      expect(patientRedirect(updateRequired: false, status: SessionStatus.signedOut, location: kSignInPath), isNull);
    });

    test('signed in: deep links pass through', () {
      expect(patientRedirect(updateRequired: false, status: SessionStatus.signedIn, location: '/orders/o1'), isNull);
    });
  });
}
