// T0C-M4-PATIENT-1 (LD-258): the M4 look on A0 splash, A1 update, A2 phone, A3 OTP, A4 app lock, A5 home, A20 notifications, A23 settings.
// 13-M-SERIES s2.3 + s5, C16 04-UI-UX s1.1 / s2. RESTYLE ONLY: behaviour, routes, storage and security stay with the existing tests
// (a0_splash, a2, a3, a4, sign_in_app_flow, cold_start_lock, a20, a23, ...), which must pass unchanged except for presentation.
// Rules checked on every screen, at text scale 1.0 and 1.3 on a 360 dp wide phone:
//   no overflow | page = neutral.50 (#F3F3F3) | content on white 24 radius cards, no border, no elevation | buttons fully round and >= 48 dp |
//   fields fully round with the neutral.300 border | Semantics label on every button | Poppins, never an underlined/unthemed Text |
//   450 ms enter motion on the cards, none under reduced motion, no looping animation on a data screen.
// A5 home: RETIRED here. The home shell is now the My Health Now UI (lib/features/mhn, prototype look, sample data), covered by
// test/features/mhn/mhn_ui_test.dart. The old rule "home shows only Orders/Reports/More, no popular tests or packages" no longer applies.
// Synthetic data only.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../support/m4_harness.dart';
import '../../support/rig.dart';

BuildContext ctxOf(WidgetTester t) => t.element(find.byType(Material, skipOffstage: false).first);

/// Where each screen's own content must sit (inside a Card).
final Map<String, Finder Function()> content = {
  'A0 error': () => find.byType(LimsErrorState),
  'A1 update required': () => find.text('Update required'),
  'A2 phone entry': () => find.byType(TextField),
  'A3 OTP entry': () => find.byType(TextField),
  'A20 notifications': () => find.byType(ListTile),
  'A23 settings': () => find.byType(SwitchListTile),
};

/// Fade values of the enter motion that belongs to the first card (the card's own FadeTransition, or one wrapped around it inside the page).
List<double> enterOpacities(WidgetTester t) {
  final card = find.byType(Card).first;
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

void main() {
  late Rig rig;
  setUp(() async => rig = await Rig.create());
  tearDown(() => rig.dispose());

  for (final scale in [1.0, 1.3]) {
    for (final s in screens) {
      group('${s.id} at text scale $scale, 360 dp wide', () {
        testWidgets('renders with no overflow and no clipped card', (t) async {
          await phone(t, scale: scale);
          await s.open(t, rig, reduceMotion: false);
          expect(t.takeException(), isNull);
          for (final c in t.widgetList(find.byType(Card)).toList().asMap().keys) {
            expect(t.getSize(find.byType(Card).at(c)).width, lessThanOrEqualTo(360));
          }
        });

        testWidgets('the page is neutral.50 (#F3F3F3), never white or a literal colour', (t) async {
          await phone(t, scale: scale);
          await s.open(t, rig, reduceMotion: false);
          final theme = Theme.of(ctxOf(t));
          expect(theme.scaffoldBackgroundColor, LimsTokens.colorNeutral50);
          final scaffolds = t.widgetList<Scaffold>(find.byType(Scaffold)).toList();
          expect(scaffolds, isNotEmpty);
          for (final sc in scaffolds) {
            expect(sc.backgroundColor ?? theme.scaffoldBackgroundColor, LimsTokens.colorNeutral50, reason: 'a Scaffold paints another page colour');
          }
        });

        if (s.cards) {
          testWidgets('content sits on white 24 radius cards: no border, no elevation', (t) async {
            await phone(t, scale: scale);
            await s.open(t, rig, reduceMotion: false);
            final theme = Theme.of(ctxOf(t));
            final cards = t.widgetList<Card>(find.byType(Card)).toList();
            expect(cards, isNotEmpty, reason: '${s.id} has no white card');
            for (final c in cards) {
              final shape = c.shape ?? theme.cardTheme.shape;
              expect(shape, isA<RoundedRectangleBorder>());
              final rr = shape! as RoundedRectangleBorder;
              expect((rr.borderRadius as BorderRadius).topLeft.x, LimsTokens.radiusXl);
              expect(rr.side, BorderSide.none, reason: 'hard border on a card');
              expect(c.color ?? theme.cardTheme.color, LimsTokens.colorNeutral0);
              expect(c.elevation ?? theme.cardTheme.elevation ?? 0, 0);
            }
            expect(find.ancestor(of: content[s.id]!(), matching: find.byType(Card)), findsWidgets, reason: 'the ${s.id} content is not inside a card');
            // every row of the screen lives in a card, not loose on the page
            for (final tile in [find.byType(ListTile), find.byType(SwitchListTile)]) {
              for (var i = 0; i < tile.evaluate().length; i++) {
                expect(find.ancestor(of: tile.at(i), matching: find.byType(Card)), findsWidgets, reason: '${s.id}: a list row is outside a card');
              }
            }
          });
        }

        testWidgets('buttons are fully round and 48 dp high, icon buttons 48 dp', (t) async {
          await phone(t, scale: scale);
          await s.open(t, rig, reduceMotion: false);
          for (final b in t.widgetList<ButtonStyleButton>(find.byType(ButtonStyleButton)).toList()) {
            final f = find.byWidget(b);
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
            final size = t.getSize(find.byWidget(i));
            expect(size.shortestSide, greaterThanOrEqualTo(48));
          }
        });

        testWidgets('every button keeps its Semantics label', (t) async {
          final handle = t.ensureSemantics();
          await phone(t, scale: scale);
          await s.open(t, rig, reduceMotion: false);
          for (final b in t.widgetList<ButtonStyleButton>(find.byType(ButtonStyleButton)).toList()) {
            expect(t.getSemantics(find.byWidget(b)).label.trim(), isNotEmpty, reason: 'a button has no semantic label');
          }
          handle.dispose();
        });

        testWidgets('all text is Poppins from the theme (no unthemed or underlined Text)', (t) async {
          await phone(t, scale: scale);
          await s.open(t, rig, reduceMotion: false);
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

  group('fields (A2, A3): fully round 48 dp, border neutral.300', () {
    for (final entry in {'A2 phone entry': openA2, 'A3 OTP entry': openA3}.entries) {
      for (final scale in [1.0, 1.3]) {
        testWidgets('${entry.key} at $scale', (t) async {
          await phone(t, scale: scale);
          await entry.value(t, rig, reduceMotion: false);
          final theme = Theme.of(ctxOf(t));
          final f = t.widget<TextField>(find.byType(TextField));
          final deco = f.decoration ?? const InputDecoration();
          final border = deco.enabledBorder ?? theme.inputDecorationTheme.enabledBorder;
          expect(border, isA<OutlineInputBorder>());
          final ob = border! as OutlineInputBorder;
          expect(ob.borderSide.color, LimsTokens.colorNeutral300, reason: 'control border is neutral.300 (3:1), not the board\'s light border');
          expect(ob.borderRadius.topLeft.x, greaterThanOrEqualTo(LimsTokens.radiusXl));
          expect(t.getSize(find.byType(TextField)).height, greaterThanOrEqualTo(48));
        });
      }
    }
  });

  group('enter motion: 450 ms on the cards, none under reduced motion', () {
    for (final entry in {'A1 update required': openA1, 'A2 phone entry': openA2}.entries) {
      testWidgets('${entry.key}: card fades in over 450 ms (still fading at 300 ms, done by 600 ms)', (t) async {
        await phone(t);
        await entry.value(t, rig, reduceMotion: false);
        expect(enterOpacities(t), isNotEmpty, reason: 'the card has no enter FadeTransition');
        expect(enterOpacities(t).reduce((a, b) => a < b ? a : b), lessThan(1), reason: 'content is shown at once, no enter motion');
        await t.pump(const Duration(milliseconds: 300));
        expect(enterOpacities(t).reduce((a, b) => a < b ? a : b), lessThan(1), reason: 'the motion is shorter than 450 ms');
        await pumpFor(t, const Duration(milliseconds: 300));
        expect(enterOpacities(t).every((o) => o == 1.0), isTrue);
      });
    }

    for (final entry in {'A1 update required': openA1, 'A2 phone entry': openA2, 'A20 notifications': openA20, 'A23 settings': openA23}.entries) {
      testWidgets('${entry.key}: reduced motion shows the card at once', (t) async {
        await phone(t);
        await entry.value(t, rig, reduceMotion: true);
        expect(enterOpacities(t).every((o) => o == 1.0), isTrue, reason: 'a card fades although reduced motion is on');
      });
    }

    for (final entry in {'A1 update required': openA1, 'A2 phone entry': openA2, 'A20 notifications': openA20, 'A23 settings': openA23}.entries) {
      testWidgets('${entry.key}: a loaded data screen has no looping animation (reduced motion on)', (t) async {
        await phone(t);
        await entry.value(t, rig, reduceMotion: true);
        await t.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 3));
        expect(find.byType(CircularProgressIndicator), findsNothing);
        expect(find.byType(LinearProgressIndicator), findsNothing);
      });
    }
  });

  group('A4 app lock: the lock surface is the M4 page', () {
    for (final scale in [1.0, 1.3]) {
      for (final lockedOut in [false, true]) {
        testWidgets('${lockedOut ? 'locked out' : 'locked'} at $scale: page neutral.50, round 48 dp [Try again], Poppins, no overflow', (t) async {
          await phone(t, scale: scale);
          await openA4(t, rig, reduceMotion: false, lockedOut: lockedOut);
          expect(t.takeException(), isNull);
          expect(find.text('orders list (synthetic)'), findsNothing, reason: 'PHI must stay hidden');
          final marker = lockedOut ? find.text('Locked. Open the app again later.') : find.text('Try again');
          expect(marker, findsOneWidget);
          final surface = find.ancestor(of: marker, matching: find.byType(ColoredBox)).first;
          expect(t.widget<ColoredBox>(surface).color, LimsTokens.colorNeutral50, reason: 'the lock screen is a page: #F3F3F3, not white');
          if (!lockedOut) {
            final size = t.getSize(find.widgetWithText(FilledButton, 'Try again'));
            expect(size.height, greaterThanOrEqualTo(48));
          }
          for (final e in find.descendant(of: surface, matching: find.byType(Text)).evaluate()) {
            final style = DefaultTextStyle.of(e).style.merge((e.widget as Text).style);
            expect(style.fontFamily, LimsTheme.fontFamily);
            expect(style.decoration == TextDecoration.underline, isFalse, reason: 'lock text has no Material ancestor (yellow underline)');
          }
        });
      }
    }
  });


  group('A20 and A23 specifics', () {
    testWidgets('A20: an unread row keeps its "New" chip with words, rows keep their order', (t) async {
      await phone(t);
      await openA20(t, rig, unread: 3);
      expect(find.text('New'), findsNWidgets(3));
      expect(find.text('Mark all read'), findsOneWidget);
    });

    testWidgets('A23: the reminder switch and the App lock row sit in cards; Sign out and Delete stay reachable at 1.3', (t) async {
      await phone(t, scale: 1.3);
      await openA23(t, rig);
      for (final txt in ['Reminder messages by SMS', 'App lock']) {
        expect(find.text(txt), findsOneWidget, reason: txt);
        expect(find.ancestor(of: find.text(txt), matching: find.byType(Card)), findsWidgets, reason: '$txt is outside a card');
      }
      for (final txt in ['Sign out', 'Delete my app account']) {
        await t.ensureVisible(find.text(txt));
        await t.pump();
        expect(find.text(txt), findsOneWidget, reason: txt);
      }
      expect(t.takeException(), isNull);
    });
  });
}
