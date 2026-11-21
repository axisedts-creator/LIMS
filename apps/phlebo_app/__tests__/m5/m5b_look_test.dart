// T0A-M5-PHLEBO-2 (LD-258): the M5 look on M7 payment, M8 complete, M9 fail visit, M10 handover, M11 outbox, M12 settings.
// 13-M-SERIES s2.3 + s5, C17 04-UI-UX s3.7-3.12. RESTYLE ONLY: behaviour, routes, storage, outbox, sync and payment logic stay with the
// existing tests (visit_payment_outcome, handover_screen, outbox_screen, settings_screen, route_handover_outbox_integration, ...),
// which must pass unchanged except for presentation.
// Rules checked on every screen, at text scale 1.0 and 1.3 on a 360 dp wide phone (same rules as PHLEBO-1, m5_look_test.dart):
//   no overflow | page = neutral.50 | content on white 24 radius cards, no border, no elevation | buttons fully round and >= 48 dp |
//   every field-work control >= 48 dp | Semantics label on every button and tap row | Poppins, no unthemed Text | text >= 4.5:1 |
//   450 ms enter motion on the cards, none under reduced motion, no looping animation on a loaded data screen.
// ASSUMED (spec names none): the offline banner of the board lives on the route screen (done in PHLEBO-1); these six screens have no
// offline input, so none is required here (adding one would be an API change). The outbox shows the real sync state through SyncChip.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:phlebo_app/features/outbox/domain/sync_summary.dart';
import 'package:phlebo_app/features/outcome/ui/complete_screen.dart' show PaymentSummary;
import 'package:phlebo_app/features/visit/ui/save_once.dart' show ChoiceTile, InlineNotice;

import '../support/hc27_fixture.dart';
import '../support/m5b_harness.dart';

BuildContext ctxOf(WidgetTester t) => t.element(find.byType(Material, skipOffstage: false).first);

List<double> enterOpacities(WidgetTester t) => find.byType(Card).evaluate().isEmpty
    ? const []
    : [
        for (final f in t.widgetList<FadeTransition>(find.descendant(of: find.byType(Card).first, matching: find.byType(FadeTransition)))) f.opacity.value,
      ];

double inheritedOpacity(Element e) {
  var o = 1.0;
  e.visitAncestorElements((a) {
    final w = a.widget;
    if (w is Opacity) o *= w.opacity;
    return true;
  });
  return o;
}

bool hasAncestor(Element e, bool Function(Widget) test) {
  var found = false;
  e.visitAncestorElements((a) {
    if (test(a.widget)) found = true;
    return !found;
  });
  return found;
}

/// The Card that holds [of] (first one up the tree).
Finder cardOf(Finder of) => find.ancestor(of: of, matching: find.byType(Card)).first;

void main() {
  for (final scale in [1.0, 1.3]) {
    for (final s in screensB) {
      group('${s.id} at text scale $scale, 360 dp wide', () {
        testWidgets('renders with no overflow and no card wider than the screen', (t) async {
          await s.open(t, scale: scale, reduceMotion: false, settle: true);
          expect(t.takeException(), isNull);
          for (var i = 0; i < t.widgetList(find.byType(Card)).length; i++) {
            expect(t.getSize(find.byType(Card).at(i)).width, lessThanOrEqualTo(360));
          }
        });

        testWidgets('the page is neutral.50, never white or a literal colour', (t) async {
          await s.open(t, scale: scale, reduceMotion: false, settle: true);
          final theme = Theme.of(ctxOf(t));
          expect(theme.scaffoldBackgroundColor, LimsTokens.colorNeutral50);
          for (final sc in t.widgetList<Scaffold>(find.byType(Scaffold))) {
            expect(sc.backgroundColor ?? theme.scaffoldBackgroundColor, LimsTokens.colorNeutral50, reason: 'a Scaffold paints another page colour');
          }
        });

        testWidgets('content sits on white 24 radius cards: no border, no elevation, no row loose on the page', (t) async {
          await s.open(t, scale: scale, reduceMotion: false, settle: true);
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
          for (final row in [find.byType(LimsListTile), find.byType(ChoiceTile), find.byType(ListTile), find.byType(TextField), find.byType(Checkbox)]) {
            for (var i = 0; i < row.evaluate().length; i++) {
              expect(find.ancestor(of: row.at(i), matching: find.byType(Card)), findsWidgets, reason: '${s.id}: ${row.describeMatch(Plurality.one)} #$i is outside a card');
            }
          }
        });

        testWidgets('buttons are fully round and 48 dp, every field-work control is at least 48 dp', (t) async {
          await s.open(t, scale: scale, reduceMotion: false, settle: true);
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
          for (final w in [find.byType(IconButton), find.byType(ListTile), find.byType(LimsListTile), find.byType(ChoiceTile), find.byType(TextField)]) {
            for (var i = 0; i < w.evaluate().length; i++) {
              final size = t.getSize(w.at(i));
              expect(size.height, greaterThanOrEqualTo(48), reason: '${w.describeMatch(Plurality.one)} #$i is ${size.height} dp high');
              expect(size.width, greaterThanOrEqualTo(48), reason: '${w.describeMatch(Plurality.one)} #$i is ${size.width} dp wide');
            }
          }
        });

        testWidgets('every button and tap row keeps its Semantics label', (t) async {
          final handle = t.ensureSemantics();
          await s.open(t, scale: scale, reduceMotion: false, settle: true);
          for (final b in t.widgetList<ButtonStyleButton>(find.byType(ButtonStyleButton)).toList()) {
            expect(t.getSemantics(find.byWidget(b)).label.trim(), isNotEmpty, reason: 'a button has no semantic label');
          }
          for (final w in [find.byType(LimsListTile), find.byType(ChoiceTile)]) {
            for (var i = 0; i < w.evaluate().length; i++) {
              expect(t.getSemantics(w.at(i)).label.trim(), isNotEmpty, reason: '${w.describeMatch(Plurality.one)} #$i has no semantic label');
            }
          }
          handle.dispose();
        });

        testWidgets('all text is Poppins from the theme (no unthemed or underlined Text)', (t) async {
          await s.open(t, scale: scale, reduceMotion: false, settle: true);
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
          await s.open(t, scale: scale, reduceMotion: false, settle: true);
          for (final e in find.byType(Text).evaluate()) {
            // buttons and notices paint their own fill, chips their tinted fill, inputs their field fill: those pairs are covered by the lims_ui gates
            if (hasAncestor(e, (w) => w is ButtonStyleButton || w is LimsStatusChip || w is InlineNotice || w is LimsOfflineBanner || w is InputDecorator || w is AppBar)) continue;
            final w = e.widget as Text;
            final c = DefaultTextStyle.of(e).style.merge(w.style).color;
            if (c == null) continue;
            final o = inheritedOpacity(e);
            final seen = Color.alphaBlend(c.withValues(alpha: c.a * o), LimsTokens.colorNeutral0);
            expect(contrast(seen, LimsTokens.colorNeutral0), greaterThanOrEqualTo(4.5), reason: '"${w.data}" is too faint to read in sunlight (opacity $o)');
          }
        });
      });
    }
  }

  group('enter motion: 450 ms on the cards, none under reduced motion', () {
    for (final s in screensB) {
      testWidgets('${s.id}: the first card fades in over 450 ms (still fading at 300 ms, done by 600 ms)', (t) async {
        await s.open(t, scale: 1.0, reduceMotion: false, settle: false);
        expect(enterOpacities(t), isNotEmpty, reason: 'the card has no enter FadeTransition');
        expect(enterOpacities(t).reduce((a, b) => a < b ? a : b), lessThan(1), reason: 'content is shown at once, no enter motion');
        await t.pump(const Duration(milliseconds: 300));
        expect(enterOpacities(t).reduce((a, b) => a < b ? a : b), lessThan(1), reason: 'the motion is shorter than 450 ms');
        await pumpFor(t, const Duration(milliseconds: 300));
        expect(enterOpacities(t).every((o) => o == 1.0), isTrue);
      });

      testWidgets('${s.id}: reduced motion shows the cards at once', (t) async {
        await s.open(t, scale: 1.0, reduceMotion: true, settle: false);
        expect(enterOpacities(t), isNotEmpty);
        expect(enterOpacities(t).every((o) => o == 1.0), isTrue, reason: 'a card fades although reduced motion is on');
      });

      testWidgets('${s.id}: a loaded data screen has no looping animation', (t) async {
        await s.open(t, scale: 1.0, reduceMotion: true, settle: true);
        await t.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 3));
        expect(find.byType(CircularProgressIndicator), findsNothing);
        expect(find.byType(LinearProgressIndicator), findsNothing);
      });
    }
  });

  group('M7 payment: amount due, methods and fields on cards, wording from the spec and the API model', () {
    for (final scale in [1.0, 1.3]) {
      testWidgets('amount due, the four methods and the money field are on cards (scale $scale)', (t) async {
        await openPayment(t, scale: scale);
        expect(t.takeException(), isNull);
        final due = find.textContaining('Amount due: NPR 1,800.00 as of 08:45');
        expect(due, findsOneWidget, reason: 'the amount due comes from the API model: "NPR 1,800.00 as of 08:45"');
        expect(find.ancestor(of: due, matching: find.byType(Card)), findsWidgets, reason: 'the amount due is loose on the page');
        expect(find.byType(ChoiceTile), findsNWidgets(4));
        for (var i = 0; i < 4; i++) {
          expect(find.ancestor(of: find.byType(ChoiceTile).at(i), matching: find.byType(Card)), findsWidgets, reason: 'method $i is loose on the page');
        }
        for (final m in ['Cash', 'Fonepay QR', 'Card', 'eSewa']) {
          expect(find.text(m), findsOneWidget, reason: 'method "$m" comes from config');
        }
        expect(find.ancestor(of: find.byKey(const ValueKey('payment.amount')), matching: find.byType(Card)), findsWidgets);
        expect(t.getSize(find.byKey(const ValueKey('payment.amount'))).height, greaterThanOrEqualTo(48));
      });
    }

    testWidgets('a picked method is shown by an icon shape, not colour alone, and stays on its card', (t) async {
      await openPayment(t, scale: 1.3);
      await t.tap(find.text('Cash'));
      await t.pumpAndSettle();
      expect(find.byIcon(Icons.radio_button_checked), findsOneWidget);
      expect(find.ancestor(of: find.byIcon(Icons.radio_button_checked), matching: find.byType(Card)), findsWidgets);
      expect(t.takeException(), isNull);
    });

    for (final scale in [1.0, 1.3]) {
      testWidgets('a method with a reference shows the reference field on a card, 48 dp, with its label (scale $scale)', (t) async {
        await openPayment(t, scale: scale);
        await t.tap(find.text('Fonepay QR'));
        await t.pumpAndSettle();
        expect(t.takeException(), isNull);
        final ref = find.byKey(const ValueKey('payment.reference'));
        expect(ref, findsOneWidget);
        expect(find.ancestor(of: ref, matching: find.byType(Card)), findsWidgets, reason: 'the reference field is loose on the page');
        expect(t.getSize(ref).height, greaterThanOrEqualTo(48));
        expect(find.text('Transaction / QR reference'), findsWidgets);
      });
    }

    testWidgets('the buttons and the receipt copy keep the spec wording; one primary, the skip button is secondary and 48 dp', (t) async {
      await openPayment(t, scale: 1.3);
      expect(find.text('This records the payment. The bill receipt is issued by the centre.'), findsOneWidget);
      expect(find.widgetWithText(LimsButton, 'Record payment'), findsOneWidget);
      final skip = find.widgetWithText(LimsButton, 'Skip — patient pays at centre');
      expect(skip, findsOneWidget);
      expect(t.widget<LimsButton>(skip).secondary, isTrue);
      expect(t.getSize(skip).height, greaterThanOrEqualTo(48));
      expectOnePrimary(t);
    });
  });

  group('M8 complete: the summary sits on cards, wording from the spec', () {
    for (final scale in [1.0, 1.3]) {
      testWidgets('Tubes and Payment cards, Finish visit 48 dp (scale $scale)', (t) async {
        await openComplete(t, scale: scale);
        expect(t.takeException(), isNull);
        expect(find.ancestor(of: find.text('Collected: 1'), matching: find.byType(Card)), findsWidgets);
        expect(find.ancestor(of: find.text('Not collected: 1'), matching: find.byType(Card)), findsWidgets);
        expect(find.ancestor(of: find.text('Cash · NPR 1,800.00'), matching: find.byType(Card)), findsWidgets);
        expect(t.getSize(find.widgetWithText(LimsButton, 'Finish visit')).height, greaterThanOrEqualTo(48));
        expectOnePrimary(t);
      });
    }

    testWidgets('no payment recorded keeps "Not recorded: patient pays at centre" on its card', (t) async {
      await openComplete(t, scale: 1.3, noPayment: true);
      expect(t.takeException(), isNull);
      expect(find.text('Not recorded: patient pays at centre'), findsOneWidget);
      expect(find.ancestor(of: find.text('Not recorded: patient pays at centre'), matching: find.byType(Card)), findsWidgets);
    });

    testWidgets('PaymentSummary keeps its two fields (the payment logic is untouched)', (t) async {
      const p = PaymentSummary(methodDisplay: 'eSewa', amountPaisa: 5);
      expect(p.methodDisplay, 'eSewa');
      expect(p.amountPaisa, 5);
    });
  });

  group('M9 fail visit: reasons and details on cards, the preselected reason is shown', () {
    for (final scale in [1.0, 1.3]) {
      testWidgets('the six reasons from config are on cards and the details field is on a card (scale $scale)', (t) async {
        await openFail(t, scale: scale);
        expect(t.takeException(), isNull);
        expect(find.byType(ChoiceTile), findsNWidgets(6));
        for (var i = 0; i < 6; i++) {
          expect(find.ancestor(of: find.byType(ChoiceTile).at(i), matching: find.byType(Card)), findsWidgets, reason: 'reason $i is loose on the page');
        }
        expect(find.ancestor(of: find.byKey(const ValueKey('fail.reason_text')), matching: find.byType(Card)), findsWidgets);
        expect(t.getSize(find.byKey(const ValueKey('fail.reason_text'))).height, greaterThanOrEqualTo(48));
        expect(find.text('Details (optional)'), findsWidgets);
      });
    }

    testWidgets('a preselected reason (identity_mismatch) is marked by an icon shape and Fail visit is enabled; "Other" asks for details', (t) async {
      await openFail(t, scale: 1.3, preselected: 'identity_mismatch');
      expect(find.byIcon(Icons.radio_button_checked), findsOneWidget);
      expect(t.widget<LimsButton>(find.widgetWithText(LimsButton, 'Fail visit')).onPressed, isNotNull);
      await t.ensureVisible(find.text('Other'));
      await t.tap(find.text('Other'));
      await t.pumpAndSettle();
      expect(find.text('Details (required)'), findsWidgets);
      expect(t.widget<LimsButton>(find.widgetWithText(LimsButton, 'Fail visit')).onPressed, isNull, reason: 'Other needs details');
      expect(t.takeException(), isNull);
      expectOnePrimary(t);
    });
  });

  group('M10 handover: instruction, centres and tubes on cards, per-tube results kept', () {
    for (final scale in [1.0, 1.3]) {
      testWidgets('instruction, both centres and every tube row are on cards, results shown with icon and words (scale $scale)', (t) async {
        await openHandover(t, scale: scale);
        expect(t.takeException(), isNull);
        expect(find.ancestor(of: find.text('Give the tubes to the centre staff. They will scan them to confirm.'), matching: find.byType(Card)), findsWidgets,
            reason: 'the instruction is loose on the page');
        expect(find.byType(ChoiceTile), findsNWidgets(2));
        for (var i = 0; i < 2; i++) {
          expect(find.ancestor(of: find.byType(ChoiceTile).at(i), matching: find.byType(Card)), findsWidgets, reason: 'centre $i is loose on the page');
        }
        for (final id in [specA, specB, specC]) {
          final row = find.byKey(ValueKey('handover.tube.$id'));
          expect(t.getSize(row).height, greaterThanOrEqualTo(48));
          expect(find.ancestor(of: row, matching: find.byType(Card)), findsWidgets, reason: 'tube $id is loose on the page');
        }
        for (final w in ['Included', 'Not collected by you', 'Already handed over']) {
          expect(find.ancestor(of: find.text(w), matching: find.byType(Card)), findsWidgets, reason: '"$w" is loose on the page');
        }
        // a tube row and its result share one card: the result belongs to the tube
        expect(
          find.descendant(of: cardOf(find.byKey(ValueKey('handover.tube.$specB'))), matching: find.text('Not collected by you')),
          findsOneWidget,
          reason: 'the result is not on its tube card',
        );
      });
    }

    testWidgets('tubes show type and last 4 only, never a full barcode', (t) async {
      await openHandover(t, scale: 1.3);
      expect(find.text('…0042'), findsOneWidget);
      expect(find.textContaining('HC00000042'), findsNothing);
    });

    testWidgets('the Hand over button stays at the bottom, 48 dp, one primary; ticking a tube off changes its label', (t) async {
      await openHandover(t, scale: 1.3);
      expect(t.getSize(find.widgetWithText(LimsButton, 'Hand over 3 tubes')).height, greaterThanOrEqualTo(48));
      expectOnePrimary(t);
      await t.tap(find.byKey(ValueKey('handover.tube.$specC')));
      await t.pumpAndSettle();
      expect(find.widgetWithText(LimsButton, 'Hand over 2 tubes'), findsOneWidget);
    });

    testWidgets('the empty state keeps its words at 1.3', (t) async {
      await openHandover(t, scale: 1.3, empty: true);
      expect(t.takeException(), isNull);
      expect(find.text('No tubes to hand over'), findsOneWidget);
      expect(find.text('Tubes you have collected will appear here.'), findsOneWidget);
    });
  });

  group('M11 outbox: one card per mutation with its state and reason, the real sync state in the header', () {
    for (final scale in [1.0, 1.3]) {
      testWidgets('every mutation is its own card (scale $scale)', (t) async {
        await openOutbox(t, scale: scale);
        expect(t.takeException(), isNull);
        final tiles = find.byType(LimsListTile);
        expect(tiles, findsNWidgets(6));
        final cards = <Widget>{};
        for (var i = 0; i < 6; i++) {
          await t.ensureVisible(tiles.at(i));
          cards.add(find.ancestor(of: tiles.at(i), matching: find.byType(Card)).first.evaluate().first.widget);
        }
        expect(cards.length, 6, reason: 'mutations share a card: one card per mutation');
      });

      testWidgets('pending item: label, visit sequence + window + time and "Waiting" on one card (scale $scale)', (t) async {
        await openOutbox(t, scale: scale);
        final card = cardOf(find.text('Arrived'));
        expect(find.descendant(of: card, matching: find.text('#2 · 09:00–10:00 · 09:15')), findsOneWidget);
        expect(find.descendant(of: card, matching: find.text('Waiting')), findsOneWidget);
      });

      testWidgets('failed item: "Not accepted: {reason}" and the review note are on the same card as the item (scale $scale)', (t) async {
        await openOutbox(t, scale: scale);
        await t.ensureVisible(find.text('Visit finished'));
        final card = cardOf(find.text('Visit finished'));
        expect(find.descendant(of: card, matching: find.text('Not accepted: homecollection.specimen_not_found')), findsOneWidget);
        expect(find.descendant(of: card, matching: find.text('The centre will review this. Your record is saved.')), findsOneWidget);
        // the held item keeps its reason words too
        await t.ensureVisible(find.text('Payment'));
        final held = cardOf(find.text('Payment'));
        expect(find.descendant(of: held, matching: find.text('On hold at centre')), findsOneWidget);
        expect(find.descendant(of: held, matching: find.text('The centre will review this. Your record is saved.')), findsOneWidget);
        expect(t.takeException(), isNull);
      });
    }

    testWidgets('a state is always icon AND words, on its own card', (t) async {
      await openOutbox(t, scale: 1.3);
      for (final w in ['Waiting', 'Uploading', 'Uploaded', 'On hold at centre', 'Not accepted: homecollection.specimen_not_found']) {
        await t.ensureVisible(find.text(w).first);
        expect(find.ancestor(of: find.text(w).first, matching: find.byType(LimsStatusChip)), findsOneWidget, reason: '"$w" is not a status chip');
        expect(find.ancestor(of: find.text(w).first, matching: find.byType(Card)), findsWidgets, reason: '"$w" is loose on the page');
      }
    });

    testWidgets('the header shows the real sync state: waiting count and last upload from the SyncSummary', (t) async {
      await openOutbox(t, scale: 1.3, sync: SyncSummary(waiting: 4, lastUpload: DateTime(2026, 11, 14, 9, 15)));
      expect(find.text('4 waiting · Last upload 09:15'), findsOneWidget);
      await openOutbox(t, scale: 1.3, rows: const [], sync: const SyncSummary(waiting: 0));
      expect(find.text('0 waiting · Last upload —'), findsOneWidget, reason: 'no upload yet: a dash, never an invented time');
    });

    testWidgets('empty: "Everything is uploaded." and the Upload now button stays 48 dp at 1.3', (t) async {
      await openOutbox(t, scale: 1.3, rows: const []);
      expect(t.takeException(), isNull);
      expect(find.text('Everything is uploaded.'), findsOneWidget);
      expect(t.getSize(find.widgetWithText(LimsButton, 'Upload now')).height, greaterThanOrEqualTo(48));
    });

    testWidgets('Upload now still calls the injected upload once and a failed upload shows the spec words on screen', (t) async {
      var calls = 0;
      await openOutbox(t, onUploadNow: () async {
        calls++;
        throw StateError('offline');
      });
      await t.tap(find.widgetWithText(LimsButton, 'Upload now'));
      await t.pumpAndSettle();
      expect(calls, 1);
      expect(find.text("Couldn't upload. Your records stay on this phone and will try again."), findsOneWidget);
      expect(find.byType(InlineNotice), findsOneWidget);
    });

    testWidgets('no patient name or full barcode ever appears in the outbox', (t) async {
      await openOutbox(t, scale: 1.3);
      expect(find.textContaining('Test Patient'), findsNothing);
      expect(find.textContaining('HC000000'), findsNothing);
    });
  });

  group('M12 settings: the facts sit on one card, sign-out wording kept', () {
    for (final scale in [1.0, 1.3]) {
      testWidgets('device, version, user and the two times are on a card (scale $scale)', (t) async {
        await openSettings(t, scale: scale);
        expect(t.takeException(), isNull);
        final facts = {
          'Device ID (last 8)': deviceIdLong.substring(deviceIdLong.length - 8),
          'App version': '1.0.0+1',
          'Signed in as': displayName,
          'Last download': '14/11/2026 07:05',
          'Last upload': '14/11/2026 09:15',
        };
        for (final e in facts.entries) {
          expect(find.ancestor(of: find.text(e.key), matching: find.byType(Card)), findsWidgets, reason: '"${e.key}" is loose on the page');
          expect(find.ancestor(of: find.text(e.value), matching: find.byType(Card)), findsWidgets, reason: '"${e.value}" is loose on the page');
        }
        expect(find.text(deviceIdLong), findsNothing, reason: 'only the last 8 of the device id are shown');
        expect(t.getSize(find.widgetWithText(LimsButton, 'Sign out')).height, greaterThanOrEqualTo(48));
        expectOnePrimary(t);
      });
    }

    testWidgets('unsent changes: the warning keeps its words and Sign out is disabled', (t) async {
      await openSettings(t, scale: 1.3, pending: 2);
      expect(t.takeException(), isNull);
      expect(find.text('Sync first — 2 changes are not uploaded yet'), findsOneWidget);
      expect(t.widget<LimsButton>(find.widgetWithText(LimsButton, 'Sign out')).onPressed, isNull);
      await openSettings(t, scale: 1.3, pending: 1);
      expect(find.text('Sync first — 1 change is not uploaded yet'), findsOneWidget);
    });

    testWidgets('sign-out asks first with the spec words', (t) async {
      await openSettings(t, scale: 1.3);
      await t.tap(find.widgetWithText(LimsButton, 'Sign out'));
      await t.pumpAndSettle();
      expect(find.text("Signing out erases today's visit list from this phone."), findsOneWidget);
      expect(t.takeException(), isNull);
    });
  });
}
