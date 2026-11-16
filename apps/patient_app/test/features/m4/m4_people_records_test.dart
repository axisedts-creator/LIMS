// T0C-M4-PATIENT-2 (LD-258): the M4 look on A6 profiles, A7 redeem, A8 report link, A9 register, A10 orders, A11 order detail,
// A12 reports, A13 report viewer, A14 smart summary, A15 pay due and its result. 13-M-SERIES s2.3 + s5, C16 04-UI-UX s2, 10-DESIGN-SYSTEM 2.6.
// RESTYLE ONLY: behaviour, API, routes, storage and security stay with the existing tests (a6..a15, a13 temp-file tests, *_source_rules,
// design_rules), which must pass unchanged except for presentation. Rules on every screen, at text scale 1.0 and 1.3 on a 360 dp wide phone:
//   no overflow | page = neutral.50 (#F3F3F3) | content on white 24 radius cards, no border, no elevation (not the full-screen PDF) |
//   buttons fully round and >= 48 dp | Semantics label on every button | Poppins, never an underlined/unthemed Text |
//   status chips carry words AND an icon (a different icon per tone) | reduced motion: cards at once, no spinner on a loaded data screen.
// Synthetic data only.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../support/m4_harness.dart' show pumpFor;
import '../../support/m4_people_harness.dart';
import '../../support/rig.dart';

/// find.byType is an exact-type match, so FilledButton / OutlinedButton / TextButton (and their .icon forms) need a predicate.
final anyButton = find.byWidgetPredicate((w) => w is ButtonStyleButton, description: 'a Material button');

BuildContext ctxOf(WidgetTester t) => t.element(find.byType(Material, skipOffstage: false).first);

typedef P2Screen = ({String id, OpenP2 open, bool cards, Finder Function() content, Set<String> skipButtons});

P2Screen s(String id, OpenP2 open, Finder Function() content, {bool cards = true, Set<String> skipButtons = const {}}) =>
    (id: id, open: open, cards: cards, content: content, skipButtons: skipButtons);

/// Every screen of the task and its states that carry their own layout (empty / error). `content` must sit inside a white card.
final people = <P2Screen>[
  s('A6 profiles', openA6, () => find.text('Asha Test (synthetic)')),
  s('A6 profiles, none yet', openA6Empty, () => find.byType(LimsEmptyState)),
  s('A7 redeem lab code', openA7, () => find.byType(TextField).first),
  s('A8 add from report message', openA8, () => find.byType(TextField).first),
  s('A9 register', openA9, () => find.byType(TextField).first),
  s('A10 orders', openA10, () => find.byType(LimsStatusChip).first),
  s('A10 orders, none yet', openA10Empty, () => find.byType(LimsEmptyState)),
  s('A10 orders, error', openA10Error, () => find.byType(LimsErrorState)),
  s('A11 order detail', openA11, () => find.byType(LimsStageTimeline)),
  s('A11 order detail, new sample needed', openA11Recollect, () => find.byType(LimsStageTimeline)),
  s('A12 reports', openA12, () => find.byType(LimsStatusChip).first),
  s('A13 report viewer', openA13, () => find.text('PDF VIEWER STUB'), cards: false, skipButtons: {'Close viewer'}),
  s('A13 report viewer, error', openA13Error, () => find.byType(LimsErrorState)),
  s('A14 smart summary', openA14, () => find.text('Health score')),
  s('A14 smart summary, error', openA14Error, () => find.byType(LimsErrorState)),
  s('A15 pay due', openA15, () => find.text('Rs. 2,250.00')),
  s('A15 result, paid', openA15Paid, () => find.text('Paid — thank you')),
  s('A15 result, not completed', openA15Failed, () => find.text('Payment not completed')),
  s('A15 result, confirming', openA15Confirming, () => find.text('We are confirming your payment. This can take a few minutes.')),
];

/// Screens that show status chips, and how many chips the fixture puts on them at least.
final withChips = <({String id, OpenP2 open, int min})>[
  (id: 'A10 orders', open: openA10, min: 7),
  (id: 'A11 order detail', open: openA11, min: 1),
  (id: 'A11 order detail, new sample needed', open: openA11Recollect, min: 1),
  (id: 'A12 reports', open: openA12, min: 4),
  (id: 'A14 smart summary', open: openA14, min: 7),
  (id: 'A15 result, paid', open: openA15Paid, min: 1),
  (id: 'A15 result, not completed', open: openA15Failed, min: 1),
  (id: 'A15 result, confirming', open: openA15Confirming, min: 1),
];

/// The icon a chip carries: inside the chip, or the Icon next to it in its own Row (A14 draws icon + chip like that).
IconData? chipIcon(WidgetTester t, Finder chip) {
  final inside = find.descendant(of: chip, matching: find.byType(Icon));
  if (inside.evaluate().isNotEmpty) return t.widget<Icon>(inside.first).icon;
  Element? row;
  chip.evaluate().first.visitAncestorElements((e) {
    final w = e.widget;
    if (w is Row) {
      row = e;
      return false;
    }
    return w is Flexible || w is Padding || w is Align || w is Semantics || w is SizedBox || w is Center;
  });
  if (row == null) return null;
  for (final c in (row!.widget as Row).children) {
    if (c is Icon) return c.icon;
  }
  return null;
}

/// Fade values of every card's enter motion (its own FadeTransition, or one wrapped around it inside the page).
List<double> enterOpacities(WidgetTester t, Finder card) {
  final out = <double>[
    for (final f in t.widgetList<FadeTransition>(find.descendant(of: card, matching: find.byType(FadeTransition)))) f.opacity.value,
  ];
  t.element(card).visitAncestorElements((e) {
    if (e.widget is Scaffold) return false;
    final w = e.widget;
    if (w is FadeTransition) out.add(w.opacity.value);
    return true;
  });
  return out;
}

double minOf(List<double> xs) => xs.reduce((a, b) => a < b ? a : b);

void main() {
  late Rig rig;
  setUp(() async => rig = await Rig.create());
  tearDown(() => rig.dispose());

  for (final scale in [1.0, 1.3]) {
    for (final sc in people) {
      group('${sc.id} at text scale $scale, 360 dp wide', () {
        testWidgets('is on screen, renders with no overflow and no clipped card', (t) async {
          await phoneP2(t, scale: scale);
          await sc.open(t, rig, reduceMotion: false);
          expect(sc.content(), findsWidgets, reason: '${sc.id} did not load its fixture');
          expect(t.takeException(), isNull);
          for (var i = 0; i < t.widgetList(find.byType(Card)).length; i++) {
            expect(t.getSize(find.byType(Card).at(i)).width, lessThanOrEqualTo(360));
          }
        });

        testWidgets('the page is neutral.50 (#F3F3F3), never white or a literal colour', (t) async {
          await phoneP2(t, scale: scale);
          await sc.open(t, rig, reduceMotion: false);
          final theme = Theme.of(ctxOf(t));
          expect(theme.scaffoldBackgroundColor, LimsTokens.colorNeutral50);
          final scaffolds = t.widgetList<Scaffold>(find.byType(Scaffold)).toList();
          expect(scaffolds, isNotEmpty);
          for (final x in scaffolds) {
            expect(x.backgroundColor ?? theme.scaffoldBackgroundColor, LimsTokens.colorNeutral50, reason: 'a Scaffold paints another page colour');
          }
        });

        if (sc.cards) {
          testWidgets('content sits on white 24 radius cards: no border, no elevation, every row inside a card', (t) async {
            await phoneP2(t, scale: scale);
            await sc.open(t, rig, reduceMotion: false);
            final theme = Theme.of(ctxOf(t));
            final cards = t.widgetList<Card>(find.byType(Card)).toList();
            expect(cards, isNotEmpty, reason: '${sc.id} has no white card');
            for (final c in cards) {
              final shape = c.shape ?? theme.cardTheme.shape;
              expect(shape, isA<RoundedRectangleBorder>());
              final rr = shape! as RoundedRectangleBorder;
              expect((rr.borderRadius as BorderRadius).topLeft.x, LimsTokens.radiusXl);
              expect(rr.side, BorderSide.none, reason: 'hard border on a card');
              expect(c.color ?? theme.cardTheme.color, LimsTokens.colorNeutral0);
              expect(c.elevation ?? theme.cardTheme.elevation ?? 0, 0);
            }
            expect(find.ancestor(of: sc.content(), matching: find.byType(Card)), findsWidgets, reason: 'the ${sc.id} content is not inside a card');
            final tiles = find.byType(ListTile);
            for (var i = 0; i < tiles.evaluate().length; i++) {
              expect(find.ancestor(of: tiles.at(i), matching: find.byType(Card)), findsWidgets, reason: '${sc.id}: a list row is outside a card');
            }
          });
        } else {
          testWidgets('the PDF is full screen: no card around the viewer, the page stays neutral.50', (t) async {
            await phoneP2(t, scale: scale);
            await sc.open(t, rig, reduceMotion: false);
            expect(find.ancestor(of: sc.content(), matching: find.byType(Card)), findsNothing, reason: 'the report PDF must not be squeezed into a card');
            expect(t.getSize(find.text('PDF VIEWER STUB')).width, lessThanOrEqualTo(360));
          });
        }

        testWidgets('buttons are fully round and 48 dp high, icon buttons 48 dp', (t) async {
          await phoneP2(t, scale: scale);
          await sc.open(t, rig, reduceMotion: false);
          for (final b in t.widgetList<ButtonStyleButton>(anyButton).toList()) {
            final f = find.byWidget(b);
            if (sc.skipButtons.any((l) => find.descendant(of: f, matching: find.text(l)).evaluate().isNotEmpty)) continue; // the test's own viewer stub
            final size = t.getSize(f);
            expect(size.height, greaterThanOrEqualTo(48), reason: 'a button is under 48 dp');
            if (b is FilledButton || b is OutlinedButton) {
              final m = t.widget<Material>(find.descendant(of: f, matching: find.byType(Material)).first);
              final shape = m.shape;
              final round = shape is StadiumBorder || (shape is RoundedRectangleBorder && (shape.borderRadius as BorderRadius).topLeft.x >= size.height / 2);
              expect(round, isTrue, reason: 'a button is not fully round: $shape');
            }
          }
          for (final i in t.widgetList<IconButton>(find.byType(IconButton)).toList()) {
            expect(t.getSize(find.byWidget(i)).shortestSide, greaterThanOrEqualTo(48));
          }
        });

        testWidgets('every button keeps its Semantics label', (t) async {
          final handle = t.ensureSemantics();
          await phoneP2(t, scale: scale);
          await sc.open(t, rig, reduceMotion: false);
          for (final b in t.widgetList<ButtonStyleButton>(anyButton).toList()) {
            if (sc.skipButtons.any((l) => find.descendant(of: find.byWidget(b), matching: find.text(l)).evaluate().isNotEmpty)) continue;
            if (find.descendant(of: find.byWidget(b), matching: find.byType(Text)).evaluate().isEmpty) continue; // icon-only: checked below
            if (find.ancestor(of: find.byWidget(b), matching: find.byWidgetPredicate((w) => w.runtimeType.toString().startsWith('SegmentedButton'))).evaluate().isNotEmpty) continue; // lims_ui segment: names itself on the group
            expect(t.getSemantics(find.byWidget(b)).label.trim(), isNotEmpty, reason: 'a button has no semantic label');
          }
          // an icon-only button is named by its tooltip (the Semantics label Flutter derives from it)
          for (final i in t.widgetList<IconButton>(find.byType(IconButton)).toList()) {
            expect((i.tooltip ?? '').trim(), isNotEmpty, reason: 'an icon button has no tooltip, so no semantic label');
          }
          handle.dispose();
        });

        testWidgets('all text is Poppins from the theme (no unthemed or underlined Text)', (t) async {
          await phoneP2(t, scale: scale);
          await sc.open(t, rig, reduceMotion: false);
          final texts = find.byType(Text);
          expect(texts, findsWidgets);
          for (final e in texts.evaluate()) {
            final w = e.widget as Text;
            final style = DefaultTextStyle.of(e).style.merge(w.style);
            expect(style.fontFamily, LimsTheme.fontFamily, reason: '"${w.data}" is not in ${LimsTheme.fontFamily}');
            expect(style.decoration == TextDecoration.underline, isFalse, reason: '"${w.data}" is drawn without a Material ancestor');
          }
        });
      });
    }
  }

  group('status chips: words, an icon and a tone (10-DESIGN-SYSTEM 2.6), never colour alone', () {
    for (final scale in [1.0, 1.3]) {
      for (final sc in withChips) {
        testWidgets('${sc.id} at $scale: every chip has text and an icon, one icon per tone', (t) async {
          await phoneP2(t, scale: scale);
          await sc.open(t, rig, reduceMotion: false);
          final chips = find.byType(LimsStatusChip);
          expect(chips.evaluate().length, greaterThanOrEqualTo(sc.min), reason: '${sc.id} shows fewer chips than its fixture');
          final toneOfIcon = <IconData, Set<String>>{};
          for (var i = 0; i < chips.evaluate().length; i++) {
            final chip = chips.at(i);
            final label = find.descendant(of: chip, matching: find.byType(Text));
            expect(label, findsWidgets, reason: 'chip $i has no words');
            expect((t.widget<Text>(label.first).data ?? '').trim(), isNotEmpty);
            final icon = chipIcon(t, chip);
            expect(icon, isNotNull, reason: 'chip $i (${t.widget<Text>(label.first).data}) has no icon: colour alone says the status');
            toneOfIcon.putIfAbsent(icon!, () => {}).add(t.widget<LimsStatusChip>(chip).tone);
          }
          toneOfIcon.forEach((icon, tones) => expect(tones.length, 1, reason: 'icon $icon is used for tones $tones: each tone needs its own icon'));
        });
      }
    }
  });

  group('enter motion: 450 ms on the cards, none under reduced motion', () {
    for (final entry in {'A7 redeem lab code': openA7, 'A8 add from report message': openA8, 'A15 pay due': openA15}.entries) {
      testWidgets('${entry.key}: the card fades in over 450 ms (still fading at 300 ms, done by 600 ms)', (t) async {
        await phoneP2(t);
        await entry.value(t, rig, reduceMotion: false);
        expect(find.byType(Card), findsWidgets, reason: '${entry.key} has no white card to fade in');
        final card = find.byType(Card).first;
        expect(enterOpacities(t, card), isNotEmpty, reason: 'the card has no enter FadeTransition');
        expect(minOf(enterOpacities(t, card)), lessThan(1), reason: 'content is shown at once, no enter motion');
        await t.pump(const Duration(milliseconds: 300));
        expect(minOf(enterOpacities(t, find.byType(Card).first)), lessThan(1), reason: 'the motion is shorter than 450 ms');
        await pumpFor(t, const Duration(milliseconds: 300));
        expect(enterOpacities(t, find.byType(Card).first).every((o) => o == 1.0), isTrue);
      });
    }

    for (final sc in people.where((p) => p.cards)) {
      testWidgets('${sc.id}: reduced motion shows every card at once', (t) async {
        await phoneP2(t);
        await sc.open(t, rig, reduceMotion: true);
        final cards = find.byType(Card);
        expect(cards, findsWidgets, reason: '${sc.id} has no card');
        for (var i = 0; i < cards.evaluate().length; i++) {
          expect(enterOpacities(t, cards.at(i)).every((o) => o == 1.0), isTrue, reason: 'a card fades although reduced motion is on');
        }
      });
    }

    const loaded = {'A6 profiles', 'A10 orders', 'A11 order detail', 'A12 reports', 'A14 smart summary', 'A15 pay due', 'A15 result, paid'};
    for (final sc in people.where((p) => loaded.contains(p.id))) {
      testWidgets('${sc.id}: a loaded data screen has no looping animation (reduced motion on)', (t) async {
        await phoneP2(t);
        await sc.open(t, rig, reduceMotion: true);
        await t.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 3));
        expect(find.byType(CircularProgressIndicator), findsNothing);
        expect(find.byType(LinearProgressIndicator), findsNothing);
      });
    }
  });

  group('A6 profiles: what the spec lists, in the M4 look', () {
    testWidgets('profile rows keep name, relationship and method; paused banner keeps icon and words; three actions stay', (t) async {
      await phoneP2(t);
      await openA6(t, rig);
      for (final n in ['Asha Test (synthetic)', 'Bikram Test (synthetic)', 'Sita Test (synthetic)']) {
        expect(find.text(n), findsOneWidget);
        expect(find.ancestor(of: find.text(n), matching: find.byType(Card)), findsWidgets, reason: '$n is not on a card');
      }
      final banner = find.textContaining('paused. Ask the lab for a new code.');
      expect(banner, findsOneWidget);
      expect(find.ancestor(of: banner, matching: find.byType(Card)), findsWidgets, reason: 'the paused banner is a loose coloured box');
      final bannerRow = find.ancestor(of: banner, matching: find.byType(Row)).first;
      expect(find.descendant(of: bannerRow, matching: find.byType(Icon)), findsWidgets, reason: 'the paused banner is colour only');
      expect(find.widgetWithText(FilledButton, 'I have a code from the lab'), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, 'Add from a report message'), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, 'Register myself / my child'), findsOneWidget);
      expect(find.byTooltip('Actions for Asha Test (synthetic)'), findsOneWidget);
    });
  });

  group('A11 order detail: sections on cards, words kept', () {
    testWidgets('header, timeline, samples, reports and payment due each sit on a card; amount comes from the order', (t) async {
      await phoneP2(t);
      await openA11(t, rig);
      for (final txt in ['Samples', 'Reports']) {
        expect(find.text(txt), findsOneWidget);
        expect(find.ancestor(of: find.text(txt), matching: find.byType(Card)), findsWidgets, reason: '$txt is loose on the page');
      }
      final due = find.text('Payment due Rs. 2,250.00 — your report will be released after payment');
      expect(due, findsOneWidget);
      expect(find.ancestor(of: due, matching: find.byType(Card)), findsWidgets, reason: 'payment due is a loose coloured box');
      expect(find.descendant(of: find.ancestor(of: due, matching: find.byType(Row)).first, matching: find.byType(Icon)), findsWidgets, reason: 'payment due is colour only');
      expect(find.textContaining('Sample 1'), findsOneWidget);
      expect(find.byWidgetPredicate((w) => w is Text && RegExp(r'^Updated \d\d:\d\d$').hasMatch(w.data ?? '')), findsOneWidget);
      expect(find.text('Partial report'), findsWidgets);
    });

    testWidgets('new sample needed: the red step keeps its words and the timeline stays on a card', (t) async {
      await phoneP2(t, scale: 1.3);
      await openA11Recollect(t, rig);
      expect(find.text('New sample needed — the lab will contact you'), findsOneWidget);
      expect(find.ancestor(of: find.byType(LimsStageTimeline), matching: find.byType(Card)), findsWidgets);
      expect(t.takeException(), isNull);
    });
  });

  group('A12 reports: toggle on a card, older versions keep their label', () {
    testWidgets('"Show older versions" sits on a card; switching it on adds the superseded row with its words', (t) async {
      await phoneP2(t);
      await openA12(t, rig);
      final toggle = find.text('Show older versions');
      expect(toggle, findsOneWidget);
      expect(find.ancestor(of: toggle, matching: find.byType(Card)), findsWidgets, reason: 'the toggle is a loose row');
      await t.tap(find.byType(SwitchListTile));
      await rep2settle(t);
      expect(find.text('Replaced by a newer version'), findsWidgets);
      expect(t.takeException(), isNull);
    });
  });

  group('A13 report viewer keeps its PHI chrome', () {
    testWidgets('LimsSecureScreen stays, the share control is a labelled 48 dp icon button, no card squeezes the PDF', (t) async {
      final handle = t.ensureSemantics();
      await phoneP2(t, scale: 1.3);
      await openA13(t, rig);
      expect(find.byType(LimsSecureScreen), findsOneWidget);
      final share = find.byTooltip('Share or save report');
      expect(share, findsOneWidget);
      expect(t.getSize(share).shortestSide, greaterThanOrEqualTo(48));
      expect(t.getSemantics(share).label, contains('Share or save report'));
      expect(find.byType(Card), findsNothing, reason: 'the viewer page has a card around the PDF');
      handle.dispose();
    });
  });

  group('A14 smart summary: every section on a card, status words kept', () {
    testWidgets('sections in spec order, each on a card; panel, band and trend words keep their icon and tone', (t) async {
      await phoneP2(t, scale: 1.3);
      await openA14(t, rig);
      final titles = ['Health score', 'Panels', 'Results that need attention', 'Advice', 'Suggested follow-up', 'Trends'];
      var last = -1.0;
      for (final title in titles) {
        final f = find.text(title);
        expect(f, findsOneWidget, reason: title);
        expect(find.ancestor(of: f, matching: find.byType(Card)), findsWidgets, reason: '$title is loose');
        final y = t.getTopLeft(f).dy;
        expect(y, greaterThan(last), reason: '$title is out of order');
        last = y;
      }
      for (final w in ['Good', 'In range', 'Borderline', 'Out of range', 'Critical — contact your doctor', 'Improved', 'Worse', 'Stable']) {
        expect(find.text(w), findsOneWidget, reason: w);
      }
      expect(find.text('Synthetic disclaimer text.'), findsOneWidget);
    });

    testWidgets('the A13 "Smart summary" row is a card row, 48 dp, labelled', (t) async {
      final handle = t.ensureSemantics();
      await phoneP2(t, scale: 1.3);
      await openA14Entry(t, rig);
      final row = find.widgetWithText(ListTile, 'Smart summary');
      expect(row, findsOneWidget);
      expect(find.ancestor(of: row, matching: find.byType(Card)), findsWidgets, reason: 'the entry row is loose on the page');
      expect(t.getSize(row).height, greaterThanOrEqualTo(48));
      expect(t.getSemantics(row).label, contains('Smart summary'));
      handle.dispose();
    });
  });

  group('A15 pay due: amount and gateway choice in the M4 look', () {
    testWidgets('amount is read-only text from the order, gateways come from the list, one primary [Continue]', (t) async {
      await phoneP2(t, scale: 1.3);
      await openA15(t, rig);
      expect(find.text('Rs. 2,250.00'), findsOneWidget);
      expect(find.byType(TextField), findsNothing, reason: 'the amount must not be editable (REQ-SEC-046)');
      expect(find.text('eSewa'), findsOneWidget);
      expect(find.text('Khalti'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Continue'), findsOneWidget);
      expect(find.byType(FilledButton), findsOneWidget, reason: 'one primary per page (LD-140)');
      expect(find.ancestor(of: find.text('Rs. 2,250.00'), matching: find.byType(Card)), findsWidgets);
      expect(find.ancestor(of: find.text('Khalti'), matching: find.byType(Card)), findsWidgets, reason: 'the gateway choice is loose');
    });

    testWidgets('result not completed keeps its words and its primary action [Try again]', (t) async {
      await phoneP2(t);
      await openA15Failed(t, rig);
      expect(find.text('Payment not completed'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Try again'), findsOneWidget);
    });

    testWidgets('result confirming keeps its words and its secondary action [Check again]', (t) async {
      await phoneP2(t);
      await openA15Confirming(t, rig);
      expect(find.text('We are confirming your payment. This can take a few minutes.'), findsOneWidget);
      expect(find.widgetWithText(OutlinedButton, 'Check again'), findsOneWidget);
    });
  });
}

/// A12 reads the older versions with a real round trip; let it land.
Future<void> rep2settle(WidgetTester t) async {
  for (var i = 0; i < 3; i++) {
    await t.pump(const Duration(milliseconds: 100));
  }
}
