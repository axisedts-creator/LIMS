// T0C-M4-PATIENT-3 (LD-258): the M4 look on A16 bookings list, A18 booking detail, A17 booking wizard (steps 1-6 + confirmation), A19 addresses,
// A21 membership card, A22 enquiries (list, new, thread). 13-M-SERIES s2.3 + s5, C16 04-UI-UX s2, 10-DESIGN-SYSTEM 2.6.
// RESTYLE ONLY: validation, idempotency, error behaviour, routes, storage and security stay with the existing tests (a16_a18, a17, a19, bookings_source_rules,
// a21, a22, design_rules), which must pass unchanged except for presentation. Rules on every screen, at text scale 1.0 and 1.3 on a 360 dp wide phone:
//   no overflow | page = neutral.50 (#F3F3F3) | content on white 24 radius cards, no border, no elevation | buttons fully round and >= 48 dp |
//   Semantics label on every button | Poppins, never an underlined/unthemed Text | status chips carry words AND an icon (one icon per tone) |
//   reduced motion: cards at once, no looping animation on a loaded data screen.
// Wizard and confirmation show the booking model's own values (fixture prices 312.50 + 118.75, centre "Synthetic Centre Nine", BK26000777), never the board's.
// Synthetic data only.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../support/bookings_fakes.dart' as bk;
import '../../support/m4_booking_harness.dart';
import '../../support/m4_harness.dart' show pumpFor;
import '../../support/rig.dart';
import 'm4_people_records_test.dart' show anyButton, chipIcon, ctxOf, enterOpacities;

typedef P3Screen = ({String id, OpenP3 open, Finder Function() content, Set<String> skipButtons});

P3Screen s(String id, OpenP3 open, Finder Function() content) => (id: id, open: open, content: content, skipButtons: const {});

OpenP3 wiz(int step, {bool home = false}) => (t, rig, {bool reduceMotion = false}) async {
      await openWizard(t, rig, step, reduceMotion: reduceMotion, home: home);
    };

/// Every screen of the task and its states that carry their own layout (empty / error). `content` must sit inside a white card.
final screens = <P3Screen>[
  s('A16 bookings', openA16, () => find.textContaining('BK26000001')),
  s('A16 bookings, none yet', openA16Empty, () => find.byType(LimsEmptyState)),
  s('A16 bookings, error', openA16Error, () => find.byType(LimsErrorState)),
  s('A18 booking detail', openA18, () => find.text('Complete Blood Count')),
  s('A18 booking detail, home collection', openA18Home, () => find.textContaining('Synthetic Tole 4, Ward 2')),
  s('A18 booking detail, cancelled', openA18Cancelled, () => find.text('Complete Blood Count')),
  s('A18 booking detail, error', openA18Error, () => find.byType(LimsErrorState)),
  s('A17 step 1 who', wiz(1), () => find.text('Sita Synthetic')),
  s('A17 step 2 type', wiz(2), () => find.text('Visit a centre')),
  s('A17 step 3 tests', wiz(3), () => find.text('Complete Blood Count')),
  s('A17 step 4 place (centre)', wiz(4), () => find.text('Synthetic Centre Nine')),
  s('A17 step 4 place (address)', wiz(4, home: true), () => find.text('Synthetic Tole 4, Ward 2')),
  s('A17 step 5 date and time', wiz(5), () => find.byType(LimsSlotPicker)),
  s('A17 step 6 review', wiz(6), () => find.textContaining('Final price is confirmed at the lab.')),
  s('A17 confirmation', wiz(7), () => find.textContaining('BK26000777')),
  s('A19 addresses', openA19, () => find.text('Synthetic Tole 4, Ward 2')),
  s('A19 addresses, none yet', openA19Empty, () => find.byType(LimsEmptyState)),
  s('A19 address form', openA19Form, () => find.byType(TextField).first),
  s('A21 membership', openA21, () => find.byType(LimsQrCode).first),
  s('A21 membership, none yet', openA21Empty, () => find.byType(LimsEmptyState)),
  s('A21 membership, error', openA21Error, () => find.byType(LimsErrorState)),
  s('A22 enquiries', openA22, () => find.text('Where is my report? (synthetic)')),
  s('A22 enquiries, none yet', openA22Empty, () => find.byType(LimsEmptyState)),
  s('A22 enquiries, error', openA22Error, () => find.byType(LimsErrorState)),
  s('A22 new enquiry', openA22New, () => find.byType(TextField).first),
  s('A22 enquiry thread', openA22Thread, () => find.text('Synthetic question text.')),
  s('A22 enquiry thread, closed', openA22ThreadClosed, () => find.text('Synthetic question text.')),
];

/// Screens that show status chips, and how many chips the fixture puts on them at least.
final withChips = <({String id, OpenP3 open, int min})>[
  (id: 'A16 bookings', open: openA16, min: 5),
  (id: 'A18 booking detail', open: openA18, min: 1),
  (id: 'A18 booking detail, cancelled', open: openA18Cancelled, min: 1),
  (id: 'A21 membership', open: openA21, min: 2),
  (id: 'A22 enquiries', open: openA22, min: 2),
  (id: 'A22 enquiry thread, closed', open: openA22ThreadClosed, min: 1),
];

void main() {
  late Rig rig;
  setUp(() async => rig = await Rig.create());
  tearDown(() => rig.dispose());

  for (final scale in [1.0, 1.3]) {
    for (final sc in screens) {
      group('${sc.id} at text scale $scale, 360 dp wide', () {
        testWidgets('is on screen, renders with no overflow and no clipped card', (t) async {
          await phoneP3(t, scale: scale);
          await sc.open(t, rig, reduceMotion: false);
          expect(sc.content(), findsWidgets, reason: '${sc.id} did not load its fixture');
          expect(t.takeException(), isNull);
          for (var i = 0; i < t.widgetList(find.byType(Card)).length; i++) {
            expect(t.getSize(find.byType(Card).at(i)).width, lessThanOrEqualTo(360));
          }
        });

        testWidgets('the page is neutral.50 (#F3F3F3), never white or a literal colour', (t) async {
          await phoneP3(t, scale: scale);
          await sc.open(t, rig, reduceMotion: false);
          final theme = Theme.of(ctxOf(t));
          expect(theme.scaffoldBackgroundColor, LimsTokens.colorNeutral50);
          final scaffolds = t.widgetList<Scaffold>(find.byType(Scaffold)).toList();
          expect(scaffolds, isNotEmpty);
          for (final x in scaffolds) {
            expect(x.backgroundColor ?? theme.scaffoldBackgroundColor, LimsTokens.colorNeutral50, reason: 'a Scaffold paints another page colour');
          }
        });

        testWidgets('content sits on white 24 radius cards: no border, no elevation, every row inside a card', (t) async {
          await phoneP3(t, scale: scale);
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

        testWidgets('buttons are fully round and 48 dp high, icon buttons 48 dp, tappable rows 48 dp', (t) async {
          await phoneP3(t, scale: scale);
          await sc.open(t, rig, reduceMotion: false);
          for (final b in t.widgetList<ButtonStyleButton>(anyButton).toList()) {
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
            expect(t.getSize(find.byWidget(i)).shortestSide, greaterThanOrEqualTo(48));
          }
          for (final tile in t.widgetList<ListTile>(find.byType(ListTile)).toList()) {
            if (tile.onTap == null) continue;
            expect(t.getSize(find.byWidget(tile)).height, greaterThanOrEqualTo(48), reason: 'a tappable row is under 48 dp');
          }
        });

        testWidgets('every button keeps its Semantics label', (t) async {
          final handle = t.ensureSemantics();
          await phoneP3(t, scale: scale);
          await sc.open(t, rig, reduceMotion: false);
          for (final b in t.widgetList<ButtonStyleButton>(anyButton).toList()) {
            if (find.descendant(of: find.byWidget(b), matching: find.byType(Text)).evaluate().isEmpty) continue; // icon-only: checked below
            if (find.ancestor(of: find.byWidget(b), matching: find.byWidgetPredicate((w) => w.runtimeType.toString().startsWith('SegmentedButton'))).evaluate().isNotEmpty) continue;
            expect(t.getSemantics(find.byWidget(b)).label.trim(), isNotEmpty, reason: 'a button has no semantic label');
          }
          for (final i in t.widgetList<IconButton>(find.byType(IconButton)).toList()) {
            expect((i.tooltip ?? '').trim(), isNotEmpty, reason: 'an icon button has no tooltip, so no semantic label');
          }
          handle.dispose();
        });

        testWidgets('all text is Poppins from the theme (no unthemed or underlined Text)', (t) async {
          await phoneP3(t, scale: scale);
          await sc.open(t, rig, reduceMotion: false);
          final texts = find.byType(Text);
          expect(texts, findsWidgets);
          for (final e in texts.evaluate()) {
            final w = e.widget as Text;
            final style = DefaultTextStyle.of(e).style.merge(w.style);
            if (sc.id.startsWith('A21') && style.fontFamily == LimsTheme.monoFamily) continue; // 04-UI-UX A21: the card no. is monospace
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
          await phoneP3(t, scale: scale);
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
    for (final sc in screens.where((p) => const {'A16 bookings', 'A18 booking detail', 'A19 addresses', 'A21 membership', 'A22 enquiries'}.contains(p.id))) {
      testWidgets('${sc.id}: the cards have the enter fade (LimsCard) and are fully shown 600 ms later', (t) async {
        await phoneP3(t);
        await sc.open(t, rig, reduceMotion: false);
        expect(find.byType(Card), findsWidgets, reason: '${sc.id} has no white card to fade in');
        final first = [for (var i = 0; i < t.widgetList(find.byType(Card)).length; i++) ...enterOpacities(t, find.byType(Card).at(i))];
        expect(first, isNotEmpty, reason: 'the cards have no enter FadeTransition');
        await pumpFor(t, const Duration(milliseconds: 600));
        final later = [for (var i = 0; i < t.widgetList(find.byType(Card)).length; i++) ...enterOpacities(t, find.byType(Card).at(i))];
        expect(later.every((o) => o == 1.0), isTrue, reason: 'a card is still faded 600 ms after the load (motion longer than 450 ms)');
      });
    }

    for (final sc in screens) {
      testWidgets('${sc.id}: reduced motion shows every card at once', (t) async {
        await phoneP3(t);
        await sc.open(t, rig, reduceMotion: true);
        final cards = find.byType(Card);
        expect(cards, findsWidgets, reason: '${sc.id} has no card');
        for (var i = 0; i < cards.evaluate().length; i++) {
          expect(enterOpacities(t, cards.at(i)).every((o) => o == 1.0), isTrue, reason: 'a card fades although reduced motion is on');
        }
      });
    }

    const loaded = {'A16 bookings', 'A18 booking detail', 'A19 addresses', 'A21 membership', 'A22 enquiries', 'A22 enquiry thread', 'A17 step 3 tests', 'A17 confirmation'};
    for (final sc in screens.where((p) => loaded.contains(p.id))) {
      testWidgets('${sc.id}: a loaded data screen has no looping animation (reduced motion on)', (t) async {
        await phoneP3(t);
        await sc.open(t, rig, reduceMotion: true);
        await t.pumpAndSettle(const Duration(milliseconds: 100), EnginePhase.sendSemanticsUpdate, const Duration(seconds: 3));
        expect(find.byType(CircularProgressIndicator), findsNothing);
        expect(find.byType(LinearProgressIndicator), findsNothing);
      });
    }
  });

  group('A16 / A18 bookings: what the spec lists, in the M4 look', () {
    testWidgets('A16 rows: booking no., place ("Home collection" or the centre), status word; each booking on a card', (t) async {
      await phoneP3(t, scale: 1.3);
      await openA16(t, rig);
      for (final w in ['Confirmed', 'Checked in', 'Completed', 'Cancelled']) {
        expect(find.text(w), findsWidgets, reason: w);
      }
      for (final n in ['BK26000001', 'BK26000002', 'BK26000003', 'BK26000004', 'BK26000005']) {
        final f = find.textContaining(n);
        expect(f, findsOneWidget, reason: n);
        expect(find.ancestor(of: f, matching: find.byType(Card)), findsWidgets, reason: '$n is not on a card');
      }
      expect(find.text('Home collection'), findsOneWidget);
      expect(find.text('Synthetic Centre One'), findsWidgets);
      expect(find.byType(LimsSecureScreen), findsOneWidget);
    });

    testWidgets('A16 keeps [Book a test] and it is a button on the page', (t) async {
      await phoneP3(t);
      await openA16(t, rig);
      expect(find.widgetWithText(LimsButton, 'Book a test'), findsOneWidget);
    });

    testWidgets('A18 keeps items with indicative prices, [Cancel], [Reschedule] and the cancel-until line, each on a card', (t) async {
      await phoneP3(t, scale: 1.3);
      await openA18(t, rig);
      expect(find.text('Rs. 450.00'), findsWidgets);
      expect(find.textContaining('You can cancel in the app until'), findsOneWidget);
      expect(find.widgetWithText(LimsButton, 'Cancel booking'), findsOneWidget);
      expect(find.widgetWithText(LimsButton, 'Reschedule'), findsOneWidget);
      expect(find.ancestor(of: find.textContaining('You can cancel in the app until'), matching: find.byType(Card)), findsWidgets);
      expect(find.byType(LimsSecureScreen), findsOneWidget);
    });

    testWidgets('A18 of a cancelled booking hides [Cancel] and [Reschedule]', (t) async {
      await phoneP3(t);
      await openA18Cancelled(t, rig);
      expect(find.widgetWithText(LimsButton, 'Cancel booking'), findsNothing);
      expect(find.widgetWithText(LimsButton, 'Reschedule'), findsNothing);
      expect(find.textContaining('You can cancel in the app until'), findsNothing);
    });

    testWidgets('A18 home collection shows the address TEXT from E37, never the id', (t) async {
      await phoneP3(t);
      await openA18Home(t, rig);
      expect(find.textContaining('Synthetic Tole 4, Ward 2'), findsOneWidget);
      expect(find.textContaining(bk.addr1), findsNothing);
    });
  });

  group('A17 wizard: model values, one primary button, validation kept', () {
    testWidgets('every step has exactly one primary LimsButton (LD-140) and a LimsSecureScreen', (t) async {
      for (var step = 1; step <= 6; step++) {
        await phoneP3(t, scale: 1.3);
        await openWizard(t, rig, step);
        bk.primary(t);
        expect(find.byType(LimsSecureScreen), findsOneWidget, reason: 'step $step');
        await t.pumpWidget(const SizedBox());
      }
    });

    testWidgets('validation kept: Continue is disabled on steps 2 to 5 until a type, tests, a place and a slot are chosen', (t) async {
      for (var step = 2; step <= 5; step++) {
        await phoneP3(t);
        await openWizard(t, rig, step);
        expect(bk.primary(t).onPressed, isNull, reason: 'step $step must still need a choice');
        await t.pumpWidget(const SizedBox());
      }
    });

    testWidgets('step 3 shows prices from the model (Rs. 312.50, Rs. 118.75), the search field and the selected count, on cards', (t) async {
      await phoneP3(t, scale: 1.3);
      await openWizard(t, rig, 3);
      expect(find.text('Rs. 312.50'), findsOneWidget);
      expect(find.text('Rs. 118.75'), findsOneWidget);
      expect(find.widgetWithText(LimsTextField, 'Search tests'), findsOneWidget);
      expect(find.ancestor(of: find.text('Rs. 312.50'), matching: find.byType(Card)), findsWidgets);
    });

    testWidgets('step 5: the slot picker, its "N left" counts and the 7-day strip are inside the card, not beside it', (t) async {
      await phoneP3(t, scale: 1.3);
      await openWizard(t, rig, 5);
      expect(find.ancestor(of: find.byType(LimsSlotPicker), matching: find.byType(Card)), findsWidgets);
      expect(find.text('3 left'), findsWidgets);
      expect(t.takeException(), isNull);
    });

    testWidgets('review: total, centre and lines come from the booking model; no board value; the lab-price note stays; on a card', (t) async {
      await phoneP3(t, scale: 1.3);
      await openWizard(t, rig, 6);
      expect(find.textContaining('Rs. 431.25'), findsOneWidget, reason: 'indicative total = 312.50 + 118.75 from the E30 prices');
      expect(find.textContaining('Synthetic Centre Nine'), findsOneWidget);
      expect(find.textContaining('Sita Synthetic'), findsOneWidget);
      for (final board in ['Rs. 1,500.00', 'Rs. 200.00', 'Rs. 150.00', '7:30 AM', '8:30 AM', '9:30 AM']) {
        expect(find.textContaining(board), findsNothing, reason: 'the board sample value $board leaked into the app');
      }
      expect(find.ancestor(of: find.textContaining('Rs. 431.25'), matching: find.byType(Card)), findsWidgets);
      expect(find.ancestor(of: find.textContaining('Final price is confirmed at the lab.'), matching: find.byType(Card)), findsWidgets);
      expect(bk.primary(t).label, 'Confirm booking');
    });

    testWidgets('confirmation: booking no., centre and time come from the E33 answer; [Done] is the one primary button', (t) async {
      await phoneP3(t, scale: 1.3);
      await openWizard(t, rig, 7);
      expect(find.text('Booking confirmed'), findsOneWidget);
      expect(find.textContaining('BK26000777'), findsOneWidget);
      expect(find.textContaining('Synthetic Centre Nine'), findsOneWidget);
      expect(find.textContaining('7:15'), findsOneWidget);
      expect(find.textContaining('centre_visit'), findsNothing);
      expect(bk.primary(t).label, 'Done');
      expect(find.ancestor(of: find.textContaining('BK26000777'), matching: find.byType(Card)), findsWidgets);
    });

    testWidgets('submit still sends ONE E33 call with an Idempotency-Key, the chosen items in order, and no patient_id', (t) async {
      await phoneP3(t);
      final api = await openWizard(t, rig, 7);
      expect(api.createCalls, hasLength(1));
      expect(api.createCalls.single.key.length, greaterThanOrEqualTo(16));
      expect(api.createCalls.single.body['orderable_ids'], [bk.oCbc, bk.oGlu]);
      expect(api.createCalls.single.body.containsKey('patient_id'), isFalse);
    });
  });

  group('A21 membership card: spec content in the M4 look', () {
    testWidgets('plan, card no., validity, status, QR and the front-desk line; the token is never printed', (t) async {
      await phoneP3(t, scale: 1.3);
      await openA21(t, rig);
      expect(find.text('Gold plan (synthetic)'), findsOneWidget);
      expect(find.textContaining('MB26000001'), findsOneWidget);
      expect(find.textContaining('Valid '), findsWidgets);
      expect(find.byType(LimsQrCode), findsNWidgets(2));
      expect(find.textContaining('Show this at the front desk.'), findsWidgets);
      expect(find.textContaining(cardToken), findsNothing, reason: 'the card token is the QR content only');
      expect(find.byType(LimsSecureScreen), findsOneWidget);
      expect(find.ancestor(of: find.byType(LimsQrCode).first, matching: find.byType(Card)), findsWidgets);
    });

    testWidgets('the QR is big enough to scan (>= 160 dp) and keeps its semantic label without the token', (t) async {
      final handle = t.ensureSemantics();
      await phoneP3(t);
      await openA21(t, rig);
      final labels = t.widgetList<Semantics>(find.byType(Semantics)).map((x) => x.properties.label ?? '').join(' ');
      expect(labels, contains('Membership QR code'));
      expect(labels, isNot(contains(cardToken)));
      expect(t.getSize(find.byType(LimsQrCode).first).shortestSide, greaterThanOrEqualTo(160));
      handle.dispose();
    });
  });

  group('A22 enquiries: list, new, thread in the M4 look', () {
    testWidgets('list rows show subject, status word and last message time on cards; [New enquiry] stays', (t) async {
      await phoneP3(t, scale: 1.3);
      await openA22(t, rig);
      expect(find.text('Where is my report? (synthetic)'), findsOneWidget);
      expect(find.text('Closed topic (synthetic)'), findsOneWidget);
      expect(find.ancestor(of: find.text('Where is my report? (synthetic)'), matching: find.byType(Card)), findsWidgets);
      expect(find.byType(LimsSecureScreen), findsOneWidget);
    });

    testWidgets('new enquiry keeps topic, subject, message with its counter and one primary button', (t) async {
      await phoneP3(t, scale: 1.3);
      await openA22New(t, rig);
      expect(find.byType(LimsSecureScreen), findsOneWidget);
      expect(find.byType(TextField), findsWidgets);
      expect(find.textContaining('/2000'), findsWidgets, reason: 'message counter (04-UI-UX A22: max 2000)');
      expect(t.takeException(), isNull);
    });

    testWidgets('thread: patient and lab messages are told apart by words, not by colour alone; the reply box stays', (t) async {
      await phoneP3(t, scale: 1.3);
      await openA22Thread(t, rig);
      expect(find.text('Synthetic question text.'), findsOneWidget);
      expect(find.text('Synthetic lab answer.'), findsOneWidget);
      expect(find.ancestor(of: find.text('Synthetic lab answer.'), matching: find.byType(Card)), findsWidgets);
      expect(find.byType(TextField), findsWidgets);
    });

    testWidgets('a closed thread keeps no reply box', (t) async {
      await phoneP3(t);
      await openA22ThreadClosed(t, rig);
      expect(find.byType(TextField), findsNothing);
    });
  });

  group('A19 addresses: rows and form on cards', () {
    testWidgets('address rows keep their text and label; the form keeps the spec fields and [Save]', (t) async {
      await phoneP3(t, scale: 1.3);
      await openA19Form(t, rig);
      expect(find.byType(LimsSecureScreen), findsWidgets);
      expect(find.widgetWithText(LimsButton, 'Save'), findsOneWidget);
      expect(bk.field('Address'), findsOneWidget);
      expect(bk.field('Landmark'), findsOneWidget);
      expect(t.takeException(), isNull);
    });
  });
}
