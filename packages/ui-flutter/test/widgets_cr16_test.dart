// T0D-15 / CR-C16-016 widgets (04-UI-UX §8 list; props from C16 04-UI-UX §9.1). Behaviour per C16 04-UI-UX
// §3-§7 rows cited inline and C16 TRD §4.3 (code normalisation: uppercase, strip '-'/spaces, O->0, I/L->1).
// ASSUMED Dart shapes (spec gives `{a, b}` record notation): Dart records with named fields; LimsStepState enum
// {done,current,todo,alert}; calendarMode is String 'AD' | 'BS'; alphabet is a String of allowed symbols.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart' show adToBs, formatBs;
import 'package:lims_ui/lims_ui.dart';

import '_helpers.dart';

const _crockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

TextField _tf(WidgetTester t) => t.widget<TextField>(find.byType(TextField).first);

void main() {
  group('LimsOtpField (C16 04 §3: 6 digits, ^[0-9]{6}\$, single semantic field, oneTimeCode)', () {
    testWidgets('completes once on the 6th digit; non-digits dropped; extra digits truncated', (tester) async {
      final done = <String>[];
      await tester.pumpWidget(host(LimsOtpField(length: 6, onCompleted: done.add, autofocus: true)));
      expect(find.byType(EditableText), findsOneWidget);
      await tester.enterText(find.byType(TextField), '48291');
      expect(done, isEmpty);
      await tester.enterText(find.byType(TextField), '48 29-13');
      expect(done, ['482913']);
      await tester.enterText(find.byType(TextField), 'ab4829137');
      expect(done.last, '482913');
    });

    testWidgets('autofill + keypad + no suggestions (REQ-SEC-111)', (tester) async {
      await tester.pumpWidget(host(LimsOtpField(length: 6, onCompleted: (_) {})));
      final f = _tf(tester);
      expect(f.autofillHints, contains(AutofillHints.oneTimeCode));
      expect(f.keyboardType, TextInputType.number);
      expect(f.enableSuggestions, isFalse);
      expect(f.autocorrect, isFalse);
    });

    testWidgets('errorText is shown and exposed to semantics', (tester) async {
      await tester.pumpWidget(host(LimsOtpField(length: 6, onCompleted: (_) {}, errorText: 'Wrong code')));
      expect(find.text('Wrong code'), findsOneWidget);
    });
  });

  group('LimsPhoneField (C16 04 §3: E.164 ^\\+[1-9][0-9]{7,14}\$, 15 digits max, display-only formatting)', () {
    testWidgets('emits E.164 = prefix + national digits only', (tester) async {
      final got = <String>[];
      await tester.pumpWidget(host(LimsPhoneField(label: 'Mobile number', prefixes: const ['+977', '+91'], initialPrefix: '+977', onChanged: got.add)));
      expect(find.text('+977'), findsWidgets);
      await tester.enterText(find.byType(TextField), '98 1234-5678');
      expect(got.last, '+9779812345678');
      await tester.enterText(find.byType(TextField), 'abc9812345678');
      expect(got.last, '+9779812345678');
    });

    testWidgets('total digits capped at 15; numeric keypad; no suggestions', (tester) async {
      final got = <String>[];
      await tester.pumpWidget(host(LimsPhoneField(label: 'Mobile number', prefixes: const ['+977'], initialPrefix: '+977', onChanged: got.add)));
      await tester.enterText(find.byType(TextField), '9' * 30);
      expect(got.last.replaceAll('+', '').length, lessThanOrEqualTo(15));
      final f = _tf(tester);
      expect(f.keyboardType, TextInputType.phone);
      expect(f.enableSuggestions, isFalse);
      expect(f.autocorrect, isFalse);
    });

    testWidgets('initialPrefix not in prefixes is rejected (no silent wrong country code)', (tester) async {
      expect(() => LimsPhoneField(label: 'm', prefixes: const ['+977'], initialPrefix: '+1', onChanged: (_) {}), throwsA(anything));
    });
  });

  group('LimsCodeField (C16 04 §4: XXXXX-XXXXX, uppercase, strips spaces/dashes, O->0 I/L->1, 10 symbols)', () {
    Future<List<String>> pump(WidgetTester t) async {
      final got = <String>[];
      await t.pumpWidget(host(LimsCodeField(label: 'Code', groupSize: 5, groups: 2, alphabet: _crockford, onChanged: got.add)));
      return got;
    }

    testWidgets('normalises case, separators and look-alikes', (tester) async {
      final got = await pump(tester);
      await tester.enterText(find.byType(TextField), 'a2c4e-fghjk');
      expect(got.last, 'A2C4EFGHJK');
      await tester.enterText(find.byType(TextField), 'oilOIL1234');
      expect(got.last, '0110111234');
    });

    testWidgets('display is grouped XXXXX-XXXXX and capped at 13 chars incl. separators', (tester) async {
      await pump(tester);
      await tester.enterText(find.byType(TextField), 'a2c4efghjk');
      expect(tester.widget<EditableText>(find.byType(EditableText)).controller.text, 'A2C4E-FGHJK');
      await tester.enterText(find.byType(TextField), 'a2c4e fghjk mnpqr');
      expect(tester.widget<EditableText>(find.byType(EditableText)).controller.text.length, lessThanOrEqualTo(13));
    });

    testWidgets('symbols outside the alphabet are dropped; no suggestions/autocorrect', (tester) async {
      final got = await pump(tester);
      await tester.enterText(find.byType(TextField), 'AB!@#CD');
      expect(got.last, 'ABCD');
      expect(_tf(tester).autocorrect, isFalse);
      expect(_tf(tester).enableSuggestions, isFalse);
      expect(_tf(tester).textCapitalization, TextCapitalization.characters);
    });
  });

  group('LimsStageTimeline (text + icon per state, never colour-only)', () {
    testWidgets('renders every label, one icon per step, alert step distinguishable', (tester) async {
      await tester.pumpWidget(host(const LimsStageTimeline(steps: [
        (label: 'Registered', state: LimsStepState.done),
        (label: 'Sample collected', state: LimsStepState.done),
        (label: 'In the lab', state: LimsStepState.current),
        (label: 'Report ready', state: LimsStepState.todo),
        (label: 'New sample needed', state: LimsStepState.alert),
      ])));
      for (final l in ['Registered', 'Sample collected', 'In the lab', 'Report ready', 'New sample needed']) {
        expect(find.text(l), findsOneWidget);
      }
      final icons = tester.widgetList<Icon>(find.descendant(of: find.byType(LimsStageTimeline), matching: find.byType(Icon))).map((i) => i.icon).toList();
      expect(icons.length, 5);
      expect(icons.toSet().length, greaterThanOrEqualTo(3), reason: 'done/current/todo/alert must not share one glyph');
      expect(find.bySemanticsLabel(RegExp('In the lab')), findsWidgets);
    });
  });

  group('LimsSlotPicker (C16 04 §6: "3 left", capped "9+"; B.S. via lims_shared/bsdate)', () {
    final days = [
      (date: '2026-11-10', slots: [
        (start: '2026-11-10T08:00:00+05:45', label: '08:00', remaining: 3),
        (start: '2026-11-10T09:00:00+05:45', label: '09:00', remaining: 12),
        (start: '2026-11-10T10:00:00+05:45', label: '10:00', remaining: 1),
      ]),
      (date: '2026-11-11', slots: [(start: '2026-11-11T08:00:00+05:45', label: '08:00', remaining: 5)]),
    ];

    testWidgets('remaining counts, cap at 9+, tap selects slot start', (tester) async {
      final picked = <String>[];
      await tester.pumpWidget(host(LimsSlotPicker(days: days, onSelected: picked.add, calendarMode: 'AD')));
      expect(find.textContaining('3 left'), findsOneWidget);
      expect(find.textContaining('9+'), findsOneWidget);
      expect(find.textContaining('12 left'), findsNothing);
      await tester.tap(find.text('09:00'));
      expect(picked, ['2026-11-10T09:00:00+05:45']);
    });

    testWidgets('BS mode labels the day strip with the lims_shared B.S. conversion', (tester) async {
      await tester.pumpWidget(host(LimsSlotPicker(days: days, onSelected: (_) {}, calendarMode: 'BS')));
      final bs = adToBs('2026-11-10');
      expect(find.textContaining('${bs.day}'), findsWidgets);
      expect(find.textContaining('${bs.year}'), findsWidgets, reason: formatBs(bs));
    });

    testWidgets('empty days renders an empty state, not a crash', (tester) async {
      await tester.pumpWidget(host(LimsSlotPicker(days: const [], onSelected: (_) {}, calendarMode: 'AD')));
      expect(tester.takeException(), isNull);
    });
  });

  group('LimsSegmentedControl / LimsBottomNav / LimsCard / LimsProfileSwitcher', () {
    testWidgets('segmented control: selected option marked, onChanged with the typed value', (tester) async {
      String v = 'self';
      await tester.pumpWidget(host(StatefulBuilder(builder: (c, set) => LimsSegmentedControl<String>(
            options: const [(value: 'self', label: 'Myself'), (value: 'child', label: 'My child')],
            value: v,
            onChanged: (n) => set(() => v = n),
          ))));
      await tester.tap(find.text('My child'));
      await tester.pump();
      expect(v, 'child');
    });

    testWidgets('bottom nav: labels always visible, tap index, badge shown, targets >= 48dp', (tester) async {
      var idx = 0;
      await tester.pumpWidget(host(LimsBottomNav(
        items: const [
          (icon: Icons.receipt_long, label: 'Orders', badge: null),
          (icon: Icons.description, label: 'Reports', badge: '2'),
          (icon: Icons.event, label: 'Bookings', badge: null),
          (icon: Icons.more_horiz, label: 'More', badge: null),
        ],
        index: idx,
        onTap: (i) => idx = i,
      )));
      for (final l in ['Orders', 'Reports', 'Bookings', 'More']) {
        expect(find.text(l), findsOneWidget);
      }
      expect(find.text('2'), findsOneWidget);
      await tester.tap(find.text('Reports'));
      expect(idx, 1);
      expect(tester.getSize(find.ancestor(of: find.text('Orders'), matching: find.byType(InkResponse)).first).height, greaterThanOrEqualTo(48));
    });

    testWidgets('bottom nav fits 360dp at 200% text scale without overflow', (tester) async {
      await tester.pumpWidget(host(LimsBottomNav(items: const [
        (icon: Icons.receipt_long, label: 'Orders', badge: null),
        (icon: Icons.description, label: 'Reports', badge: null),
        (icon: Icons.event, label: 'Bookings', badge: null),
        (icon: Icons.more_horiz, label: 'More', badge: null),
      ], index: 0, onTap: (_) {}), textScale: 2.0));
      expect(tester.takeException(), isNull);
    });

    testWidgets('card: title, child, footer', (tester) async {
      await tester.pumpWidget(host(const LimsCard(title: 'Health score', footer: Text('Good'), child: Text('82/100'))));
      expect(find.text('Health score'), findsOneWidget);
      expect(find.text('82/100'), findsOneWidget);
      expect(find.text('Good'), findsOneWidget);
    });

    testWidgets('profile switcher: "All profiles" + each label/sublabel; selection callback; selection not persisted', (tester) async {
      final picked = <String?>[];
      await tester.pumpWidget(host(LimsProfileSwitcher(
        profiles: const [(id: 'p1', label: 'Asha Test', sublabel: 'Myself'), (id: 'p2', label: 'Bikash Test', sublabel: 'Child')],
        selectedId: null,
        onChanged: picked.add,
      )));
      expect(find.text('All profiles'), findsOneWidget);
      await tester.tap(find.byType(LimsProfileSwitcher));
      await tester.pumpAndSettle();
      expect(find.text('Asha Test'), findsOneWidget);
      expect(find.text('Child'), findsOneWidget);
      await tester.tap(find.text('Bikash Test'));
      await tester.pumpAndSettle();
      expect(picked.last, 'p2');
      await tester.tap(find.byType(LimsProfileSwitcher));
      await tester.pumpAndSettle();
      await tester.tap(find.text('All profiles').last);
      await tester.pumpAndSettle();
      expect(picked.last, isNull);
    });
  });

  group('LimsAppLockGate (C16 04 §3/§5: locked -> PHI hidden from tree interaction, unlock requested)', () {
    testWidgets('locked: child is not interactable/visible to semantics, unlock prompt requested once; unlocked: shown', (tester) async {
      var asked = 0;
      var tapped = 0;
      Widget build(bool locked) => host(LimsAppLockGate(
            isLocked: locked,
            onUnlockRequested: () => asked++,
            child: ElevatedButton(onPressed: () => tapped++, child: const Text('Patient report')),
          ));
      await tester.pumpWidget(build(true));
      await tester.pump();
      expect(asked, 1);
      await tester.tap(find.text('Patient report'), warnIfMissed: false);
      expect(tapped, 0, reason: 'a locked gate must swallow taps on the child');
      expect(find.bySemanticsLabel('Patient report'), findsNothing, reason: 'PHI must not be exposed to accessibility while locked');
      await tester.pumpWidget(build(false));
      await tester.tap(find.text('Patient report'));
      expect(tapped, 1);
    });
  });

  group('LimsQrCode (offline render, semanticLabel required)', () {
    testWidgets('renders at requested size with semantics label; empty data does not crash', (tester) async {
      await tester.pumpWidget(host(const LimsQrCode(data: 'MB26000042-SYNTHETIC-TOKEN', size: 200, semanticLabel: 'Membership QR')));
      expect(tester.getSize(find.byType(LimsQrCode)).width, 200);
      expect(find.bySemanticsLabel('Membership QR'), findsOneWidget);
      await tester.pumpWidget(host(const LimsQrCode(data: '', size: 120, semanticLabel: 'Empty')));
      expect(tester.takeException(), isNull);
    });
  });

  group('LimsPdfViewer', () {
    testWidgets('missing file shows an error state and still offers close; never throws', (tester) async {
      var closed = 0;
      await tester.pumpWidget(host(LimsPdfViewer(filePath: '/definitely/not/here.pdf', onClose: () => closed++)));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await tester.tap(find.byTooltip('Close'));
      expect(closed, 1);
    });
  });
}
