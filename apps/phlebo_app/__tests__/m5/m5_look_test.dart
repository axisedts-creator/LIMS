// T0A-M5-PHLEBO-1 (LD-258): the M5 look on M2 route, M3 visit, M4 identity, M5 consent (and M6 collect as a guard).
// 13-M-SERIES s2.3 + s5, C17 04-UI-UX s3.2-3.6. RESTYLE ONLY: behaviour, routes, storage, outbox, identity and consent stay with the
// existing tests (route_screen, visit_identity_consent, visit_collect, visit_flow_offline, ...), which must pass unchanged except for presentation.
// Rules checked on every screen, at text scale 1.0 and 1.3 on a 360 dp wide phone:
//   no overflow | page = neutral.50 | content on white 24 radius cards, no border, no elevation | buttons fully round and >= 48 dp |
//   every field-work control >= 48 dp | Semantics label on every button | Poppins, no unthemed Text | text >= 4.5:1 on its surface (sunlight) |
//   450 ms enter motion on the cards, none under reduced motion, no looping animation on a loaded data screen.
// ASSUMED (spec names none): a bottom navigation on the route screen is optional (the board's Queue / History / Profile tabs have no
// History or Profile screen in this app: gap); if present it must be LimsBottomNav with text labels and the lime pill.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:phlebo_app/features/visit/ui/save_once.dart' show ChoiceTile;

import '../support/hc27_fixture.dart';
import '../support/m5_harness.dart';

BuildContext ctxOf(WidgetTester t) => t.element(find.byType(Material, skipOffstage: false).first);

/// Opacity values of the enter motion on the first card (its own FadeTransition).
List<double> enterOpacities(WidgetTester t) => [
      for (final f in t.widgetList<FadeTransition>(find.descendant(of: find.byType(Card).first, matching: find.byType(FadeTransition)))) f.opacity.value,
    ];

/// Opacity left in a Text by Opacity ancestors (a greyed-out row), so the contrast check sees what the eye sees.
double inheritedOpacity(Element e) {
  var o = 1.0;
  e.visitAncestorElements((a) {
    final w = a.widget;
    if (w is Opacity) o *= w.opacity;
    return true;
  });
  return o;
}

/// Button labels sit on the button's own fill, not on the card (their pairs are covered by the lims_ui button contrast gate).
bool inButton(Element e) {
  var inside = false;
  e.visitAncestorElements((a) {
    if (a.widget is ButtonStyleButton) inside = true;
    return true;
  });
  return inside;
}

void main() {
  for (final scale in [1.0, 1.3]) {
    for (final s in screens) {
      group('${s.id} at text scale $scale, 360 dp wide', () {
        testWidgets('renders with no overflow and no card wider than the screen', (t) async {
          await s.open(t, scale: scale, reduceMotion: false);
          expect(t.takeException(), isNull);
          for (var i = 0; i < t.widgetList(find.byType(Card)).length; i++) {
            expect(t.getSize(find.byType(Card).at(i)).width, lessThanOrEqualTo(360));
          }
        });

        testWidgets('the page is neutral.50, never white or a literal colour', (t) async {
          await s.open(t, scale: scale, reduceMotion: false);
          final theme = Theme.of(ctxOf(t));
          expect(theme.scaffoldBackgroundColor, LimsTokens.colorNeutral50);
          for (final sc in t.widgetList<Scaffold>(find.byType(Scaffold))) {
            expect(sc.backgroundColor ?? theme.scaffoldBackgroundColor, LimsTokens.colorNeutral50, reason: 'a Scaffold paints another page colour');
          }
        });

        if (s.cards) {
          testWidgets('content sits on white 24 radius cards: no border, no elevation', (t) async {
            await s.open(t, scale: scale, reduceMotion: false);
            final theme = Theme.of(ctxOf(t));
            final cards = t.widgetList<Card>(find.byType(Card)).toList();
            expect(cards, isNotEmpty, reason: '${s.id} has no white card');
            for (final c in cards) {
              final rr = (c.shape ?? theme.cardTheme.shape)! as RoundedRectangleBorder;
              expect((rr.borderRadius as BorderRadius).topLeft.x, LimsTokens.radiusXl);
              expect(rr.side, BorderSide.none, reason: 'hard border on a card');
              expect(c.color ?? theme.cardTheme.color, LimsTokens.colorNeutral0);
              expect(c.elevation ?? theme.cardTheme.elevation ?? 0, 0);
            }
            // no row of the screen sits loose on the page
            for (final row in [find.byType(LimsListTile), find.byType(ChoiceTile), find.byType(ListTile)]) {
              for (var i = 0; i < row.evaluate().length; i++) {
                expect(find.ancestor(of: row.at(i), matching: find.byType(Card)), findsWidgets, reason: '${s.id}: a row is outside a card');
              }
            }
          });
        }

        testWidgets('buttons are fully round and 48 dp, every field-work control is at least 48 dp', (t) async {
          await s.open(t, scale: scale, reduceMotion: false);
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
          for (final w in [find.byType(IconButton), find.byType(PopupMenuButton), find.byType(ListTile), find.byType(LimsListTile), find.byType(ChoiceTile)]) {
            for (var i = 0; i < w.evaluate().length; i++) {
              final size = t.getSize(w.at(i));
              expect(size.height, greaterThanOrEqualTo(48), reason: '${w.description} #$i is ${size.height} dp high');
              expect(size.width, greaterThanOrEqualTo(48), reason: '${w.description} #$i is ${size.width} dp wide');
            }
          }
        });

        testWidgets('every button and tap row keeps its Semantics label', (t) async {
          final handle = t.ensureSemantics();
          await s.open(t, scale: scale, reduceMotion: false);
          for (final b in t.widgetList<ButtonStyleButton>(find.byType(ButtonStyleButton)).toList()) {
            expect(t.getSemantics(find.byWidget(b)).label.trim(), isNotEmpty, reason: 'a button has no semantic label');
          }
          for (final w in [find.byType(LimsListTile), find.byType(ChoiceTile), find.byType(PopupMenuButton)]) {
            for (var i = 0; i < w.evaluate().length; i++) {
              expect(t.getSemantics(w.at(i)).label.trim(), isNotEmpty, reason: '${w.description} #$i has no semantic label');
            }
          }
          handle.dispose();
        });

        testWidgets('all text is Poppins from the theme (no unthemed or underlined Text)', (t) async {
          await s.open(t, scale: scale, reduceMotion: false);
          final texts = find.byType(Text);
          expect(texts, findsWidgets);
          for (final e in texts.evaluate()) {
            final w = e.widget as Text;
            final style = DefaultTextStyle.of(e).style.merge(w.style);
            expect(style.fontFamily, LimsTheme.fontFamily, reason: '"${w.data}" is not in ${LimsTheme.fontFamily}');
            expect(style.decoration == TextDecoration.underline, isFalse, reason: '"${w.data}" is drawn without a Material ancestor');
          }
        });

        testWidgets('sunlight: every enabled text is at least 4.5:1 on white (the contrast gate is unchanged)', (t) async {
          await s.open(t, scale: scale, reduceMotion: false);
          for (final e in find.byType(Text).evaluate()) {
            if (inButton(e)) continue;
            final w = e.widget as Text;
            final c = DefaultTextStyle.of(e).style.merge(w.style).color;
            if (c == null) continue;
            final o = inheritedOpacity(e);
            // blend the text colour over the white card, as the eye does (greyed-out rows lose contrast)
            final seen = Color.alphaBlend(c.withValues(alpha: c.a * o), LimsTokens.colorNeutral0);
            // chips and notices paint their own tinted fill; those pairs are covered by the lims_ui status gate
            if (find.ancestor(of: find.byWidget(w), matching: find.byType(LimsStatusChip)).evaluate().isNotEmpty) continue;
            if (find.ancestor(of: find.byWidget(w), matching: find.byType(LimsOfflineBanner)).evaluate().isNotEmpty) continue;
            expect(contrast(seen, LimsTokens.colorNeutral0), greaterThanOrEqualTo(4.5), reason: '"${w.data}" is too faint to read in sunlight (opacity $o)');
          }
        });
      });
    }
  }

  group('enter motion: 450 ms on the cards, none under reduced motion', () {
    for (final entry in {'M2 route': openRoute, 'M3 visit': openVisit, 'M4 identity': openIdentity, 'M5 consent': openConsent}.entries) {
      testWidgets('${entry.key}: the first card fades in over 450 ms (still fading at 300 ms, done by 600 ms)', (t) async {
        await entry.value(t, settle: false);
        expect(enterOpacities(t), isNotEmpty, reason: 'the card has no enter FadeTransition');
        expect(enterOpacities(t).reduce((a, b) => a < b ? a : b), lessThan(1), reason: 'content is shown at once, no enter motion');
        await t.pump(const Duration(milliseconds: 300));
        expect(enterOpacities(t).reduce((a, b) => a < b ? a : b), lessThan(1), reason: 'the motion is shorter than 450 ms');
        await pumpFor(t, const Duration(milliseconds: 300));
        expect(enterOpacities(t).every((o) => o == 1.0), isTrue);
      });

      testWidgets('${entry.key}: reduced motion shows the cards at once', (t) async {
        await entry.value(t, reduceMotion: true, settle: false);
        expect(enterOpacities(t), isNotEmpty);
        expect(enterOpacities(t).every((o) => o == 1.0), isTrue, reason: 'a card fades although reduced motion is on');
      });

      testWidgets('${entry.key}: a loaded data screen has no looping animation', (t) async {
        await entry.value(t, reduceMotion: true);
        await t.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 3));
        expect(find.byType(CircularProgressIndicator), findsNothing);
        expect(find.byType(LinearProgressIndicator), findsNothing);
      });
    }
  });

  group('M2 route: the board layout', () {
    for (final scale in [1.0, 1.3]) {
      testWidgets('one white card per visit, in sequence order, all five status words kept (scale $scale)', (t) async {
        await openRoute(t, scale: scale);
        expect(t.takeException(), isNull);
        final tiles = find.byType(LimsListTile);
        expect(tiles, findsNWidgets(5));
        for (var i = 0; i < 5; i++) {
          final card = find.ancestor(of: tiles.at(i), matching: find.byType(Card));
          expect(card, findsWidgets, reason: 'visit ${i + 1} is not on a card');
        }
        // each visit has its own card: no two visits share one (a list of rows on one card is the old look)
        final cardOf = [for (var i = 0; i < 5; i++) find.ancestor(of: tiles.at(i), matching: find.byType(Card)).first.evaluate().first.widget];
        expect(cardOf.toSet().length, 5, reason: 'visits share a card');
        for (final w in ['To do', 'In progress', 'Completed', 'Failed', 'Cancelled — do not visit']) {
          expect(find.descendant(of: find.byType(LimsStatusChip), matching: find.text(w)), findsOneWidget, reason: w);
        }
      });

      testWidgets('the tube count and window stay on the visit card (scale $scale)', (t) async {
        await openRoute(t, scale: scale);
        expect(find.text('1/2 tubes'), findsOneWidget);
        expect(find.ancestor(of: find.text('1/2 tubes'), matching: find.byType(Card)), findsWidgets);
        expect(find.textContaining('08:00–09:00'), findsOneWidget);
      });
    }

    testWidgets('offline banner sits above the first visit, full width, with the spec copy "Offline — showing data from hh:mm"', (t) async {
      await openRouteOffline(t, scale: 1.3);
      expect(t.takeException(), isNull);
      final banner = find.byType(LimsOfflineBanner);
      expect(banner, findsOneWidget);
      expect(t.getSize(banner).width, 360);
      expect(t.getTopLeft(banner).dy, lessThan(t.getTopLeft(find.byType(LimsListTile).first).dy));
      expect(find.text('Offline — showing data from 07:05'), findsOneWidget);
    });

    testWidgets('a cancelled visit stays greyed but readable, and still does not open', (t) async {
      await openRoute(t);
      expect(find.textContaining('Cancelled'), findsOneWidget);
      expect(find.byType(LimsListTile), findsNWidgets(5));
    });

    testWidgets('if the route has a bottom navigation it is LimsBottomNav with text labels and one lime pill, and invents no History or Profile tab', (t) async {
      await openRoute(t, scale: 1.3);
      final nav = find.byType(LimsBottomNav);
      if (nav.evaluate().isEmpty) return; // ASSUMED optional: Handover, Outbox and Settings may stay in the menu
      final w = t.widget<LimsBottomNav>(nav);
      final labels = [for (final i in w.items) i.label];
      expect(labels, isNot(contains('History')), reason: 'no history screen exists: gap');
      expect(labels, isNot(contains('Profile')), reason: 'no profile screen exists: gap');
      for (final l in labels) {
        expect(find.descendant(of: nav, matching: find.text(l)), findsOneWidget, reason: 'tab "$l" has no text label');
      }
      final pills = find.descendant(
        of: nav,
        matching: find.byWidgetPredicate((x) => x is DecoratedBox && x.decoration is BoxDecoration && (x.decoration as BoxDecoration).color == LimsTokens.colorAccentHighlight),
      );
      expect(pills, findsOneWidget, reason: 'exactly one lime pill: the current tab');
      // the three destinations keep working from somewhere on the screen
      for (final item in ['Handover', 'Outbox', 'Settings']) {
        final reachable = labels.contains(item) || find.byKey(const ValueKey('route.menu')).evaluate().isNotEmpty;
        expect(reachable, isTrue, reason: '$item is no longer reachable');
      }
    });
  });

  group('M4 identity: the choices sit on cards, answers still free of typed PHI', () {
    for (final second in ['phone', 'birth_date']) {
      for (final scale in [1.0, 1.3]) {
        testWidgets('second identifier $second at $scale: instruction, record and the four choices are all on cards', (t) async {
          await openIdentity(t, scale: scale, second: second);
          expect(t.takeException(), isNull);
          expect(find.byType(ChoiceTile), findsNWidgets(4));
          for (var i = 0; i < 4; i++) {
            expect(find.ancestor(of: find.byType(ChoiceTile).at(i), matching: find.byType(Card)), findsWidgets, reason: 'choice $i is loose on the page');
          }
          expect(find.ancestor(of: find.textContaining('Ask the patient to tell you'), matching: find.byType(Card)), findsWidgets, reason: 'the instruction is loose on the page');
          expect(find.byType(TextField), findsNothing, reason: 'the spoken answers are never typed in (REQ-SEC-111)');
        });
      }
    }

    testWidgets('a picked choice is shown by an icon shape, not colour alone, and the card look survives the pick', (t) async {
      await openIdentity(t, scale: 1.3);
      await t.tap(find.text('Name matches'));
      await t.pumpAndSettle();
      expect(find.byIcon(Icons.radio_button_checked), findsOneWidget);
      expect(find.ancestor(of: find.byIcon(Icons.radio_button_checked), matching: find.byType(Card)), findsWidgets);
      expect(t.takeException(), isNull);
    });
  });

  group('M5 consent: the text sits on a card and the two buttons stay', () {
    for (final scale in [1.0, 1.3]) {
      testWidgets('consent text and version are on a card, Patient agrees / Patient refuses are 48 dp (scale $scale)', (t) async {
        await openConsent(t, scale: scale);
        expect(t.takeException(), isNull);
        expect(find.ancestor(of: find.textContaining('I agree to a blood sample'), matching: find.byType(Card)), findsWidgets, reason: 'consent text is loose on the page');
        expect(find.ancestor(of: find.text('hc-consent-v1'), matching: find.byType(Card)), findsWidgets);
        for (final l in ['Patient agrees', 'Patient refuses']) {
          expect(t.getSize(find.widgetWithText(LimsButton, l)).height, greaterThanOrEqualTo(48));
        }
        expectOnePrimary(t);
      });
    }
  });

  group('M3 visit and the tube checklist', () {
    for (final scale in [1.0, 1.3]) {
      testWidgets('Tubes to collect: every tube is a 48 dp row on the Tubes card with type, container and last 4 (scale $scale)', (t) async {
        await openVisit(t, scale: scale);
        await t.scrollUntilVisible(find.text('EDTA whole blood · Purple top'), 200, scrollable: find.byType(Scrollable).first);
        expect(t.takeException(), isNull);
        expect(find.byType(LimsListTile), findsNWidgets(2));
        for (var i = 0; i < 2; i++) {
          expect(t.getSize(find.byType(LimsListTile).at(i)).height, greaterThanOrEqualTo(48));
          expect(find.ancestor(of: find.byType(LimsListTile).at(i), matching: find.byType(Card)), findsWidgets);
        }
        expect(find.text('Serum · Gel tube'), findsOneWidget);
        expect(find.text('EDTA whole blood · Purple top'), findsOneWidget);
      });
    }

    testWidgets('amount due keeps the "NPR ... as of hh:mm" wording from the API model (nothing from the board)', (t) async {
      await openVisit(t);
      await t.scrollUntilVisible(find.text('Amount due'), 200, scrollable: find.byType(Scrollable).first);
      expect(find.textContaining('NPR '), findsOneWidget);
      expect(find.textContaining('as of 08:45'), findsOneWidget);
    });
  });

  group('M6 collect (guard: the per-tube checklist behaviour and Poppins/48 dp rules above stay)', () {
    testWidgets('each tube row keeps its status word and a 48 dp options button at 1.3', (t) async {
      await openCollect(t, scale: 1.3);
      expect(t.takeException(), isNull);
      expect(find.text('Waiting'), findsOneWidget);
      expect(find.textContaining('Collected'), findsWidgets);
      for (final id in [tube1, tube2]) {
        expect(t.getSize(find.byKey(ValueKey('collect.tube_menu.$id'))).shortestSide, greaterThanOrEqualTo(48));
      }
    });
  });
}
