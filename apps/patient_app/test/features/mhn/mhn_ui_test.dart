// My Health Now UI (sample data): shell and tabs, search, cart, the whole booking flow, membership saving, profile validation, members, FAQ.
// Synthetic data only. No API, no network.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:patient_app/features/mhn/mhn_data.dart';
import 'package:patient_app/features/mhn/mhn_shell.dart';
import 'package:patient_app/features/mhn/mhn_state.dart';

SemanticsHandle? _sem;

final _vertical = find.byWidgetPredicate((w) => w is Scrollable && w.axis == Axis.vertical).first;

Future<ProviderContainer> open(WidgetTester t, {double scale = 1.0, Size size = const Size(390, 844)}) async {
  t.view.physicalSize = size;
  t.view.devicePixelRatio = 1;
  addTearDown(t.view.reset);
  _sem = t.ensureSemantics();
  final c = ProviderContainer();
  addTearDown(c.dispose);
  await t.pumpWidget(UncontrolledProviderScope(
    container: c,
    child: MediaQuery(
      data: MediaQueryData(size: size, textScaler: TextScaler.linear(scale)),
      child: MaterialApp(theme: LimsTheme.light(), home: const MhnShell()),
    ),
  ));
  await t.pump(const Duration(milliseconds: 100));
  return c;
}

Future<void> tab(WidgetTester t, String label) async {
  await t.tap(find.byKey(ValueKey<String>('mhn-nav-$label')));
  await t.pump(const Duration(milliseconds: 300));
}

Future<void> end(WidgetTester t) async {
  await t.pumpWidget(const SizedBox()); // dispose the periodic timers of the home tab
  _sem?.dispose();
  _sem = null;
}

/// Real glyph widths: the flutter_test default font (Ahem) is far wider than Poppins and gives false overflows.
Future<void> loadPoppins() async {
  final loader = FontLoader('Poppins');
  for (final f in ['Regular', 'Medium', 'SemiBold', 'Bold']) {
    final bytes = File('../../packages/ui-flutter/assets/fonts/Poppins-$f.ttf').readAsBytesSync();
    loader.addFont(Future.value(ByteData.sublistView(bytes)));
  }
  await loader.load();
}

void main() {
  setUpAll(loadPoppins);
  group('formatting', () {
    test('rs uses Indian digit grouping like the prototype', () {
      expect(rs(75), 'Rs 75');
      expect(rs(2999), 'Rs 2,999');
      expect(rs(12999), 'Rs 12,999');
      expect(rs(142000), 'Rs 1,42,000');
      expect(rs(1500000), 'Rs 15,00,000');
    });
    test('sample data has 8 categories, 25 tests and 5 packages, every test in a known category', () {
      expect(kCategories.length, 8);
      expect(kTests.length, 25);
      expect(kPackages.length, 5);
      for (final t in kTests) {
        expect(kCategories.any((c) => c.id == t.cat), isTrue, reason: t.id);
      }
    });
  });

  for (final scale in [1.0, 1.3]) {
    testWidgets('home renders at text scale $scale without overflow and shows the prototype sections', (t) async {
      await open(t, scale: scale);
      expect(t.takeException(), isNull);
      expect(find.text('Hi, Aayush'), findsOneWidget);
      expect(find.bySemanticsLabel('Cart'), findsOneWidget);
      expect(find.text('Popular tests'), findsOneWidget);
      for (final l in ['Home', 'All Tests', 'Bookings', 'Reports', 'Profile']) {
        expect(find.text(l), findsWidgets, reason: l);
      }
      for (final s in ['Tests by category', 'Routine Health Checkup for Men', 'Health Checkup Packages', 'ISO 9001:2015 certified · NPHL approved']) {
        for (var n = 0; n < 40 && find.text(s).evaluate().isEmpty; n++) {
          await t.drag(_vertical, const Offset(0, -240));
          await t.pump();
        }
        expect(find.text(s), findsOneWidget, reason: s);
      }
      expect(t.takeException(), isNull);
      await end(t);
    });
  }

  for (final width in [360.0, 390.0, 430.0]) {
    testWidgets('responsive layout: ${width}dp viewport with 1.3x text scale across all 5 tabs renders without overflow', (t) async {
      await open(t, scale: 1.3, size: Size(width, 740));
      expect(t.takeException(), isNull);
      for (final l in ['Home', 'All Tests', 'Bookings', 'Reports', 'Profile']) {
        await tab(t, l);
        expect(t.takeException(), isNull, reason: 'Tab $l has overflow at width $width');
      }
      await end(t);
    });
  }

  testWidgets('accessibility: 390dp viewport with 2.0x enlarged text scale renders without overflow', (t) async {
    await open(t, scale: 2.0, size: const Size(390, 844));
    expect(t.takeException(), isNull);
    for (final l in ['Home', 'All Tests', 'Bookings', 'Reports', 'Profile']) {
      await tab(t, l);
      expect(t.takeException(), isNull, reason: 'Tab $l has overflow at 2.0x text scale');
    }
    await end(t);
  });

  testWidgets('hero carousel changes slide after 4.8 s', (t) async {
    await open(t);
    expect(find.text('Looking for a full body checkup?'), findsOneWidget);
    await t.pump(const Duration(milliseconds: 5200));
    await t.pump(const Duration(milliseconds: 500));
    expect(find.text('Home sample collection'), findsOneWidget);
    await end(t);
  });

  testWidgets('H02 city change dialog: tap location opens sheet and updates location', (t) async {
    final c = await open(t);
    expect(find.text('Baneshwor, Kathmandu'), findsOneWidget);
    await t.tap(find.text('Baneshwor, Kathmandu'));
    await t.pumpAndSettle();
    expect(find.text('Select service location'), findsOneWidget);
    expect(find.text('Patan, Lalitpur'), findsOneWidget);
    await t.tap(find.text('Patan, Lalitpur'));
    await t.pumpAndSettle();
    expect(c.read(mhnProvider).selectedLocationLabel, 'Patan, Lalitpur');
    expect(find.text('Patan, Lalitpur'), findsOneWidget);
    await end(t);
  });

  testWidgets('add a popular test: cart bar appears, the cart lists it with the total', (t) async {
    final c = await open(t);
    await t.tap(find.bySemanticsLabel('Add Complete Blood Count (CBC)'));
    await t.pump();
    expect(c.read(mhnProvider).cart, ['cbc']);
    expect(find.text('1 item'), findsOneWidget);
    await t.tap(find.text('View cart'));
    await t.pumpAndSettle();
    expect(find.text('Complete Blood Count (CBC)'), findsOneWidget);
    expect(find.text('Rs 500'), findsWidgets);
    expect(find.textContaining('Members would save'), findsNothing);
    await t.tap(find.byTooltip('Remove Complete Blood Count (CBC)'));
    await t.pumpAndSettle();
    expect(find.text('Your cart is empty'), findsOneWidget);
    await end(t);
  });

  testWidgets('All Tests: categories, search by name / description, empty result', (t) async {
    await open(t);
    await tab(t, 'All Tests');
    expect(find.text('Browse by category'), findsOneWidget);
    expect(find.text('Vital organs'), findsOneWidget);
    await t.enterText(find.byType(TextField), 'thyroid');
    await t.pump();
    expect(find.text('Thyroid Function Test'), findsOneWidget);
    expect(find.textContaining('found'), findsOneWidget);
    await t.enterText(find.byType(TextField), 'zzzz');
    await t.pump();
    expect(find.text('No tests found'), findsOneWidget);
    await t.tap(find.byTooltip('Clear search'));
    await t.pump();
    expect(find.text('Browse by category'), findsOneWidget);
    await end(t);
  });

  testWidgets('category opens its tests; imaging shows the centre note and forces a centre visit', (t) async {
    final c = await open(t);
    await tab(t, 'All Tests');
    await t.tap(find.text('X-ray & imaging'));
    await t.pumpAndSettle();
    expect(find.textContaining('Home collection is not available'), findsOneWidget);
    await t.tap(find.text('Add to cart').first);
    await t.pump();
    expect(c.read(mhnProvider.notifier).effectiveMode, 'lab');
    await end(t);
  });

  testWidgets('whole booking flow: cart, date and time, review and pay, confirmed, my bookings', (t) async {
    final c = await open(t);
    c.read(mhnProvider.notifier).setMockPrototype(true);
    c.read(mhnProvider.notifier).toggleCart('lft');
    c.read(mhnProvider.notifier).toggleCart('kft');
    await t.pump();
    await t.tap(find.text('View cart'));
    await t.pumpAndSettle();
    expect(find.text('Rs 2,400'), findsWidgets);
    await t.tap(find.text('Choose date & time'));
    await t.pumpAndSettle();
    expect(find.text('Book collection'), findsOneWidget);
    // validation wording
    await t.tap(find.text('Review & pay'));
    await t.pump();
    expect(find.text('Choose a time slot.'), findsOneWidget);
    await t.tap(find.text('7:00–8:00 AM'));
    await t.pump();
    await t.tap(find.text('Review & pay'));
    await t.pump();
    expect(find.text('Enter the full collection address.'), findsWidgets);
    await t.enterText(find.byType(TextField).first, 'House 12, Baneshwor, Kathmandu');
    await t.pump();
    await t.tap(find.text('Review & pay'));
    await t.pumpAndSettle();
    expect(find.text('Review & pay'), findsWidgets);
    expect(find.text('Pay Rs 2,400'), findsOneWidget);
    expect(find.text('House 12, Baneshwor, Kathmandu'), findsOneWidget);
    await t.tap(find.text('Pay Rs 2,400'));
    await t.pump();
    expect(find.text('Processing payment…'), findsOneWidget);
    await t.pump(const Duration(seconds: 2));
    await t.pumpAndSettle();
    expect(find.text('Booking confirmed'), findsOneWidget);
    expect(find.textContaining('MHN-'), findsOneWidget);
    expect(c.read(mhnProvider).cart, isEmpty);
    expect(c.read(mhnProvider).bookings, hasLength(1));
    await t.tap(find.text('View my bookings'));
    await t.pumpAndSettle();
    expect(find.text('Upcoming'), findsOneWidget);
    expect(find.textContaining('LFT Advanced, Kidney Function Test'), findsOneWidget);
    expect(find.text('eSewa'), findsOneWidget);
    await end(t);
  });

  testWidgets('membership: excluded per ADR-SCOPE-001', (t) async {
    await open(t);
    expect(find.text('Become a Member'), findsNothing);
    await tab(t, 'Profile');
    expect(find.text('Membership'), findsNothing);
    await end(t);
  });

  testWidgets('profile: completeness, edit validation, save', (t) async {
    final c = await open(t);
    await tab(t, 'Profile');
    expect(find.text('Aayush Shrestha'), findsOneWidget);
    expect(find.text('57%'), findsOneWidget);
    await t.tap(find.text('My profile'));
    await t.pumpAndSettle();
    expect(find.text('Complete your profile'), findsOneWidget);
    expect(find.text('Add your email, date of birth, blood group.'), findsOneWidget);
    await t.tap(find.text('Edit profile'));
    await t.pumpAndSettle();
    await t.enterText(find.byType(TextField).at(0), '12345');
    await t.enterText(find.byType(TextField).at(1), 'not-an-email');
    await t.tap(find.text('Save'));
    await t.pump();
    expect(find.text('Enter a 10-digit mobile number starting with 96, 97 or 98.'), findsOneWidget);
    expect(find.text('Enter a valid email address.'), findsOneWidget);
    await t.enterText(find.byType(TextField).at(0), '9812345678');
    await t.enterText(find.byType(TextField).at(1), 'aayush@example.com');
    await t.tap(find.text('B+'));
    await t.pump();
    await t.tap(find.text('Save'));
    await t.pump(const Duration(seconds: 1));
    await t.pumpAndSettle();
    final p = c.read(mhnProvider).profile;
    expect((p.phone, p.email, p.blood), ('9812345678', 'aayush@example.com', 'B+'));
    expect(p.completeness, 86);
    await end(t);
  });

  testWidgets('profile: saved addresses opens AddressesScreen', (t) async {
    await open(t);
    await tab(t, 'Profile');
    expect(find.text('Saved addresses'), findsOneWidget);
    await t.tap(find.text('Saved addresses'));
    await t.pumpAndSettle();
    expect(find.text('Addresses'), findsOneWidget);
    await end(t);
  });

  testWidgets('family members: add, appears in booking and reports, edit, remove', (t) async {
    final c = await open(t);
    await tab(t, 'Profile');
    await t.tap(find.text('Other members'));
    await t.pumpAndSettle();
    expect(find.textContaining('no other member is added'), findsOneWidget);
    await t.tap(find.text('+ Add a member'));
    await t.pumpAndSettle();
    await t.tap(find.text('Add member').last);
    await t.pump();
    expect(find.text('Enter the member’s full name.'), findsOneWidget);
    await t.enterText(find.byType(TextField).first, 'Sita Shrestha');
    await t.tap(find.text('Add member').last);
    await t.pump();
    expect(find.text('Choose how they are related to you.'), findsOneWidget);
    await t.tap(find.text('Spouse'));
    await t.pump();
    await t.tap(find.text('Female'));
    await t.tap(find.text('Add member').last);
    await t.pumpAndSettle();
    expect(c.read(mhnProvider).members.single.name, 'Sita Shrestha');
    expect(find.text('Spouse · Female'), findsOneWidget);
    await t.tap(find.text('Sita Shrestha'));
    await t.pumpAndSettle();
    expect(find.text('Edit member'), findsOneWidget);
    await t.tap(find.text('Remove member'));
    await t.pumpAndSettle();
    expect(c.read(mhnProvider).members, isEmpty);
    await end(t);
  });

  testWidgets('reports: ready opens values with a Low flag, processing only toasts', (t) async {
    await open(t);
    await tab(t, 'Reports');
    await t.pumpAndSettle();
    expect(find.text('Ready'), findsOneWidget);
    expect(find.text('Processing'), findsOneWidget);
    await t.tap(find.text('HbA1c'));
    await t.pump();
    expect(find.text('This report is still being processed'), findsOneWidget);
    await t.tap(find.text('Complete Blood Count'));
    await t.pumpAndSettle();
    expect(find.text('Sample values'), findsOneWidget);
    expect(find.text('Low'), findsOneWidget);
    expect(find.text('Download PDF'), findsOneWidget);
    await end(t);
  });

  testWidgets('contact: FAQ search and accordion', (t) async {
    await open(t);
    await tab(t, 'Profile');
    await t.tap(find.text('Contact us'));
    await t.pumpAndSettle();
    expect(find.text('Metro Labs, Baneshwor'), findsOneWidget);
    await t.drag(find.byType(ListView).first, const Offset(0, -600));
    await t.pump();
    await t.tap(find.text('Do I need to fast before my test?'));
    await t.pumpAndSettle();
    expect(find.textContaining('8–12 hours without food'), findsOneWidget);
    await t.enterText(find.byType(TextField), 'payment');
    await t.pump();
    expect(find.text('Which payment methods can I use?'), findsOneWidget);
    expect(find.text('Do I need to fast before my test?'), findsNothing);
    await end(t);
  });

  testWidgets('report a problem: validation wording', (t) async {
    await open(t);
    await tab(t, 'Profile');
    await t.drag(find.byType(ListView).first, const Offset(0, -700));
    await t.pump();
    await t.tap(find.text('Report a problem'));
    await t.pumpAndSettle();
    await t.tap(find.text('Send report'));
    await t.pump();
    expect(find.text('Choose what the problem is about.'), findsOneWidget);
    await t.tap(find.text('Payment'));
    await t.enterText(find.byType(TextField), 'short');
    await t.tap(find.text('Send report'));
    await t.pump();
    expect(find.text('Add a short description (at least 10 characters).'), findsOneWidget);
    await end(t);
  });
}
