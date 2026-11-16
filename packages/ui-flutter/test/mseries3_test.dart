// T0D-MSERIES-3 (LD-251, LD-246; spec/program/13-M-SERIES.md s2 and s5): lims_ui follows the M series.
// done_when: tokens.g.dart only (no hand-copied hex); page #F3F3F3, white cards radius 24, fully round primary and outline
// buttons 48 dp high, lime pill for the current bottom-nav tab with a text label, 48 dp targets, tap scale .96, 450 ms enter
// motion with reduced motion honoured, Poppins bundled as a font asset (no network fetch) with Noto Sans Devanagari fallback,
// goldens re-recorded by this change (hash checks live in restyle_r05_test.dart). Expected values come from tokens.json
// (independent parse) or the spec text, never from the code under test.
//
// ASSUMED public API (the spec names no widget for "enter motion"): LimsCard fades in over motion.duration.normal (450 ms)
// on first build and shows at full opacity at once when MediaQuery.disableAnimations is true. Measured on the effective
// opacity of the card content (RenderOpacity / RenderAnimatedOpacity ancestors), so FadeTransition, AnimatedOpacity and
// Opacity all satisfy it. Everything else is tested through existing names (LimsTheme, LimsButton, LimsCard, LimsBottomNav).
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';

import '_helpers.dart';

typedef _Face = ({String asset, int weight});

/// Faces declared for [family] in pubspec.yaml (weight defaults to 400 like Flutter).
List<_Face> _faces(String pub, String family) {
  final out = <_Face>[];
  var inFamily = false;
  for (final raw in pub.split('\n')) {
    final l = raw.trim();
    if (l.startsWith('- family:')) {
      inFamily = l == '- family: $family';
      continue;
    }
    if (!inFamily) continue;
    if (l.startsWith('- asset:')) out.add((asset: l.substring('- asset:'.length).trim(), weight: 400));
    if (l.startsWith('weight:') && out.isNotEmpty) out[out.length - 1] = (asset: out.last.asset, weight: int.parse(l.substring(7).trim()));
  }
  return out;
}

String _stripComments(String s) => s.split('\n').map((l) => l.replaceFirst(RegExp(r'//.*$'), '')).join('\n');

double _contrast(Color a, Color b) {
  final la = a.computeLuminance(), lb = b.computeLuminance();
  final hi = la > lb ? la : lb, lo = la > lb ? lb : la;
  return (hi + 0.05) / (lo + 0.05);
}

/// Product of every opacity layer between [f] and the root.
double _opacityAt(WidgetTester t, Finder f) {
  var o = 1.0;
  RenderObject? r = t.renderObject(f);
  while (r != null) {
    if (r is RenderOpacity) o *= r.opacity;
    if (r is RenderAnimatedOpacity) o *= r.opacity.value;
    r = r.parent;
  }
  return o;
}

Widget _hostMotion(Widget child, {required bool reduce}) => MaterialApp(
      theme: LimsTheme.light(),
      home: MediaQuery(
        data: MediaQueryData(disableAnimations: reduce, size: const Size(360, 800)),
        child: Scaffold(body: SingleChildScrollView(child: child)),
      ),
    );

const _navItems = <LimsNavItem>[
  (icon: Icons.receipt_long, label: 'Orders', badge: null),
  (icon: Icons.description, label: 'Reports', badge: null),
  (icon: Icons.event, label: 'Bookings', badge: null),
  (icon: Icons.more_horiz, label: 'More', badge: null),
];

void main() {
  final tok = tokensJson();
  final neutral = (tok['color'] as Map)['neutral'] as Map;
  final accent = (tok['color'] as Map)['accent'] as Map;
  final pkg = pkgDir().path;
  final pub = File('$pkg/pubspec.yaml').readAsStringSync();
  final libFiles = Directory('$pkg/lib').listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart')).toList();
  final libSrc = libFiles.map((f) => _stripComments(f.readAsStringSync())).join('\n');
  final libNoTokens = libFiles.where((f) => !f.path.endsWith('tokens.g.dart')).map((f) => _stripComments(f.readAsStringSync())).join('\n');

  group('tokens.g.dart carries the M series values (13 s2.1, s2.3) and the theme reads them', () {
    test('Dart tokens equal tokens.json: page, accent, lime, pop, ink, card radius, enter motion, target', () {
      expect(LimsTokens.colorNeutral50.toARGB32(), hex('#F3F3F3').toARGB32());
      expect(LimsTokens.colorNeutral50.toARGB32(), hex(neutral['50'] as String).toARGB32());
      expect(LimsTokens.colorAccentDefault.toARGB32(), hex('#005A52').toARGB32());
      expect(LimsTokens.colorAccentHighlight.toARGB32(), hex('#A0C032').toARGB32());
      expect(LimsTokens.colorAccentPop.toARGB32(), hex(accent['pop'] as String).toARGB32());
      expect(LimsTokens.colorNeutral900.toARGB32(), hex('#0A1A17').toARGB32());
      expect(LimsTokens.radiusXl, 24);
      expect(LimsTokens.motionDurationNormal, 450);
      expect(LimsTokens.touchTargetFlutter, 48);
    });

    test('lib reads motion, radius and target from tokens (no 450 / 24 / 48 typed into code)', () {
      expect(libNoTokens, contains('LimsTokens.motionDurationNormal'), reason: 'enter motion must use motion.duration.normal');
      expect(libNoTokens, contains('LimsTokens.radiusXl'));
      expect(libNoTokens, contains('LimsTokens.touchTargetFlutter'));
      expect(RegExp(r'Duration\(\s*milliseconds:\s*\d').hasMatch(libNoTokens), isFalse, reason: 'millisecond literal: use LimsTokens.motionDuration*');
      expect(RegExp(r'Radius\.circular\(\s*\d').hasMatch(libNoTokens), isFalse);
    });

    test('the theme font family is the first family of LimsTokens.fontFamilySans (not a second hand-typed copy of the stack)', () {
      expect(libNoTokens, contains('LimsTokens.fontFamilySans'), reason: 'theme.dart must derive the family from the token');
    });
  });

  group('Poppins is bundled as a Flutter font asset, Plus Jakarta Sans is gone, no network font fetch (13 s2.2)', () {
    final faces = _faces(pub, 'Poppins');

    test('pubspec declares family Poppins with weights 400, 500, 600, 700', () {
      expect(faces.map((f) => f.weight).toSet(), {400, 500, 600, 700}, reason: 'faces: $faces');
    });

    test('each Poppins asset exists, is a TrueType/OpenType file (Flutter cannot load woff2) and is not a stub', () {
      for (final f in faces) {
        final file = File('$pkg/${f.asset}');
        expect(file.existsSync(), isTrue, reason: f.asset);
        final b = file.readAsBytesSync();
        expect(b.length, greaterThan(10000), reason: '${f.asset} too small to be a font');
        final magic = b.take(4).toList();
        final isTtf = magic[0] == 0 && magic[1] == 1 && magic[2] == 0 && magic[3] == 0;
        final isOtf = String.fromCharCodes(magic) == 'OTTO';
        expect(isTtf || isOtf, isTrue, reason: '${f.asset} magic $magic (woff2 starts with wOF2)');
      }
    });

    test('the Poppins licence text (OFL-1.1) ships with the font files', () {
      final txt = Directory('$pkg/assets/fonts').listSync().whereType<File>().where((f) => f.path.endsWith('.txt'));
      final ok = txt.any((f) {
        final s = f.readAsStringSync();
        return s.contains('Poppins') && s.contains('SIL OPEN FONT LICENSE');
      });
      expect(ok, isTrue, reason: 'no .txt in assets/fonts names Poppins and the SIL Open Font License');
    });

    test('Plus Jakarta Sans is removed: no font file, licence, pubspec family or lib reference', () {
      final names = Directory('$pkg/assets/fonts').listSync().map((e) => e.path.split(RegExp(r'[\\/]')).last).toList();
      expect(names.where((n) => n.toLowerCase().contains('jakarta')), isEmpty);
      expect(pub, isNot(contains('Jakarta')));
      expect(libSrc, isNot(contains('Jakarta')));
    });

    test('Noto Sans Devanagari stays bundled (Poppins has no Devanagari glyphs) with 400 and 700', () {
      final dev = _faces(pub, 'Noto Sans Devanagari');
      expect(dev.map((f) => f.weight), containsAll([400, 700]));
      for (final f in dev) {
        expect(File('$pkg/${f.asset}').existsSync(), isTrue, reason: f.asset);
      }
    });

    test('no network font fetch: no google_fonts package, no fonts.googleapis / gstatic URL, no runtime fetching flag', () {
      expect(pub, isNot(contains('google_fonts')));
      expect(libSrc, isNot(anyOf(contains('GoogleFonts'), contains('googleapis'), contains('gstatic'), contains('allowRuntimeFetching'))));
    });

    test('theme: Poppins first on every text style, Devanagari fallback in both package spellings', () {
      final t = LimsTheme.light();
      expect(LimsTheme.fontFamily, 'Poppins');
      for (final s in [t.textTheme.displaySmall!, t.textTheme.titleLarge!, t.textTheme.bodyLarge!, t.textTheme.bodySmall!, t.textTheme.labelMedium!]) {
        expect(s.fontFamily, 'Poppins');
        expect(s.fontFamilyFallback, containsAll(['Noto Sans Devanagari', 'packages/lims_ui/Poppins', 'packages/lims_ui/Noto Sans Devanagari']));
        expect(s.fontFamilyFallback!.indexOf('Noto Sans Devanagari'), lessThan(s.fontFamilyFallback!.indexOf('Noto Sans')), reason: 'Devanagari must come before the Latin fallback');
      }
    });
  });

  group('theme shapes and sizes (13 s2.3)', () {
    test('page is #F3F3F3, white surface, primary #005A52', () {
      final t = LimsTheme.light();
      expect(t.scaffoldBackgroundColor.toARGB32(), hex('#F3F3F3').toARGB32());
      expect(t.colorScheme.surface.toARGB32(), hex('#FFFFFF').toARGB32());
      expect(t.colorScheme.primary.toARGB32(), hex('#005A52').toARGB32());
    });

    test('cardTheme: white, flat, radius 24, no hard border', () {
      final c = LimsTheme.light().cardTheme;
      expect(c.color, LimsTokens.colorNeutral0);
      expect(c.elevation, 0);
      final shape = c.shape as RoundedRectangleBorder;
      expect(shape.borderRadius.resolve(TextDirection.ltr).topLeft.x, 24);
      expect(shape.side, BorderSide.none);
    });

    test('dialogs share the card radius 24 (13 s2.3: cards, panels, dialogs, drawers)', () {
      final shape = LimsTheme.light().dialogTheme.shape;
      expect(shape, isA<RoundedRectangleBorder>(), reason: 'dialogTheme.shape was $shape');
      expect((shape as RoundedRectangleBorder).borderRadius.resolve(TextDirection.ltr).topLeft.x, 24);
    });

    test('filled, outlined and text buttons: stadium shape, minimum 48 x 48', () {
      final t = LimsTheme.light();
      for (final s in [t.filledButtonTheme.style!, t.outlinedButtonTheme.style!, t.textButtonTheme.style!]) {
        expect(s.shape!.resolve({}), isA<StadiumBorder>());
        expect(s.minimumSize!.resolve({})!.height, 48);
        expect(s.minimumSize!.resolve({})!.width, greaterThanOrEqualTo(48));
      }
    });

    test('single-line fields are fully round with the neutral.300 control border (13 s2.3, s2.1: never the light board border)', () {
      final d = LimsTheme.light().inputDecorationTheme;
      for (final b in [d.enabledBorder, d.border]) {
        expect(b, isA<OutlineInputBorder>(), reason: 'input border was $b');
        final ob = b as OutlineInputBorder;
        expect(ob.borderRadius.resolve(TextDirection.ltr).topLeft.x, greaterThanOrEqualTo(23), reason: 'half of the 46 dp field');
      }
      expect((d.enabledBorder as OutlineInputBorder).borderSide.color.toARGB32(), hex(neutral['300'] as String).toARGB32());
    });
  });

  group('buttons render 48 dp high and fully round', () {
    testWidgets('FilledButton and OutlinedButton under the theme are 48 dp high', (tester) async {
      await tester.pumpWidget(host(Column(children: [
        FilledButton(onPressed: () {}, child: const Text('Save')),
        OutlinedButton(onPressed: () {}, child: const Text('Cancel')),
      ])));
      expect(tester.getSize(find.bySubtype<FilledButton>()).height, closeTo(48, 0.5));
      expect(tester.getSize(find.bySubtype<OutlinedButton>()).height, closeTo(48, 0.5));
    });

    testWidgets('LimsButton primary, secondary (outline) and icon variants: 48 dp high, stadium, also outside LimsTheme', (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: Column(children: [
            LimsButton(label: 'Collect', onPressed: () {}),
            LimsButton(label: 'Back', secondary: true, onPressed: () {}),
            LimsButton(label: 'Scan', icon: Icons.qr_code_scanner, onPressed: () {}),
            LimsButton(label: 'Scan back', icon: Icons.qr_code_scanner, secondary: true, onPressed: () {}),
          ]),
        ),
      ));
      for (final label in ['Collect', 'Back', 'Scan', 'Scan back']) {
        final btn = find.ancestor(of: find.text(label), matching: find.byWidgetPredicate((w) => w is FilledButton || w is OutlinedButton)).first;
        expect(tester.getSize(btn).height, closeTo(48, 0.5), reason: label);
        final m = tester.widget<Material>(find.descendant(of: btn, matching: find.byType(Material)).first);
        expect(m.shape, isA<StadiumBorder>(), reason: '$label shape ${m.shape}');
      }
    });

    testWidgets('outline button border passes the 3:1 control rule on the page (neutral.300 or darker)', (tester) async {
      await tester.pumpWidget(host(Center(child: LimsButton(label: 'Back', secondary: true, onPressed: () {}))));
      final m = tester.widget<Material>(find.descendant(of: find.bySubtype<OutlinedButton>(), matching: find.byType(Material)).first);
      // Border is drawn by the shape's side; resolve it from the OutlinedButton style.
      final side = tester.widget<OutlinedButton>(find.bySubtype<OutlinedButton>()).style?.side?.resolve({}) ??
          Theme.of(tester.element(find.bySubtype<OutlinedButton>())).outlinedButtonTheme.style?.side?.resolve({}) ??
          (m.shape is OutlinedBorder ? (m.shape as OutlinedBorder).side : BorderSide.none);
      expect(side.width, greaterThan(0), reason: 'outline button must show a border');
      expect(_contrast(side.color, LimsTokens.colorNeutral50), greaterThanOrEqualTo(3.0));
    });
  });

  group('bottom navigation: lime pill for the current tab, text label, 48 dp targets', () {
    Widget nav(int i) => host(Align(alignment: Alignment.bottomCenter, child: LimsBottomNav(items: _navItems, index: i, onTap: (_) {})));

    testWidgets('current tab sits on a fully round lime (accent.highlight) fill; the others have none; every tab keeps its text label', (tester) async {
      await tester.pumpWidget(nav(2));
      for (final i in _navItems) {
        expect(find.text(i.label), findsOneWidget);
      }
      final limeBoxes = find
          .descendant(
              of: find.byType(LimsBottomNav),
              matching: find.byWidgetPredicate((w) => w is DecoratedBox && w.decoration is BoxDecoration && (w.decoration as BoxDecoration).color == LimsTokens.colorAccentHighlight))
          .evaluate()
          .toList();
      expect(limeBoxes, hasLength(1), reason: 'exactly one lime pill');
      final box = limeBoxes.single;
      final deco = (box.widget as DecoratedBox).decoration as BoxDecoration;
      final size = (box.renderObject! as RenderBox).size;
      expect(deco.borderRadius!.resolve(TextDirection.ltr).topLeft.x, greaterThanOrEqualTo(size.height / 2), reason: 'pill must be fully round');
      final pill = (box.renderObject! as RenderBox).localToGlobal(Offset.zero) & size;
      expect(pill.contains(tester.getCenter(find.text('Bookings'))), isTrue, reason: 'pill must hold the current label');
      expect(pill.contains(tester.getCenter(find.text('Orders'))), isFalse);
    });

    testWidgets('every tab is a 48 dp target (height and width)', (tester) async {
      await tester.pumpWidget(nav(0));
      for (final i in _navItems) {
        final s = tester.getSize(find.ancestor(of: find.text(i.label), matching: find.byType(InkResponse)).first);
        expect(s.height, greaterThanOrEqualTo(48), reason: i.label);
        expect(s.width, greaterThanOrEqualTo(48), reason: i.label);
      }
    });

    testWidgets('on the lime pill the label keeps >= 4.5:1 and the icon >= 3:1 (13 s2.1: accent.default on lime is only 3.90)', (tester) async {
      await tester.pumpWidget(nav(1));
      final lbl = tester.widget<Text>(find.text('Reports'));
      final style = DefaultTextStyle.of(tester.element(find.text('Reports'))).style.merge(lbl.style);
      expect(_contrast(style.color!, LimsTokens.colorAccentHighlight), greaterThanOrEqualTo(4.5));
      final icon = tester.widget<Icon>(find.byIcon(Icons.description));
      final iconColor = icon.color ?? IconTheme.of(tester.element(find.byIcon(Icons.description))).color!;
      expect(_contrast(iconColor, LimsTokens.colorAccentHighlight), greaterThanOrEqualTo(3.0));
    });

    testWidgets('inactive label stays >= 4.5:1 on the nav surface', (tester) async {
      await tester.pumpWidget(nav(0));
      final lbl = tester.widget<Text>(find.text('Reports'));
      final style = DefaultTextStyle.of(tester.element(find.text('Reports'))).style.merge(lbl.style);
      expect(_contrast(style.color!, LimsTokens.colorNeutral0), greaterThanOrEqualTo(4.5));
    });
  });

  group('tap scale .96 is kept (13 s2.3: hover and press 150 ms)', () {
    test('LimsPressScale.pressedScale is .96 and the press duration is motion.duration.fast (150 ms)', () {
      expect(LimsPressScale.pressedScale, 0.96);
      expect(LimsTokens.motionDurationFast, 150);
    });

    testWidgets('with reduced motion the press scale lands on the very next frame (no 150 ms tween)', (tester) async {
      await tester.pumpWidget(_hostMotion(Center(child: LimsButton(label: 'Collect sample', onPressed: () {})), reduce: true));
      final label = find.text('Collect sample');
      final rest = tester.getRect(label).width;
      final g = await tester.startGesture(tester.getCenter(label));
      await tester.pump(); // one frame, no time advanced
      await tester.pump(const Duration(milliseconds: 16));
      expect(tester.getRect(label).width / rest, closeTo(0.96, 0.01));
      await g.up();
      await tester.pumpAndSettle();
    });
  });

  group('450 ms enter motion, reduced motion honoured (13 s2.3; ASSUMED on LimsCard, see header)', () {
    Widget card(bool reduce) => _hostMotion(const LimsCard(title: 'Orders', child: Text('3 open')), reduce: reduce);

    testWidgets('the card content enters: not fully opaque early, fully opaque after 450 ms, in one 450 ms run', (tester) async {
      await tester.pumpWidget(card(false));
      final c = find.text('3 open');
      expect(_opacityAt(tester, c), lessThan(0.999), reason: 'first frame must not be at rest: no enter motion found');
      await tester.pump(const Duration(milliseconds: 100));
      final early = _opacityAt(tester, c);
      expect(early, lessThan(0.999));
      await tester.pump(const Duration(milliseconds: 125)); // 225 ms
      final mid = _opacityAt(tester, c);
      expect(mid, greaterThan(early), reason: 'opacity must rise while entering');
      expect(mid, lessThan(0.999));
      await tester.pump(const Duration(milliseconds: 235)); // 460 ms
      expect(_opacityAt(tester, c), greaterThanOrEqualTo(0.999), reason: 'done after 450 ms');
      await tester.pumpAndSettle();
      expect(_opacityAt(tester, c), 1.0);
    });

    testWidgets('reduced motion: shown at full opacity on the first frame and nothing animates', (tester) async {
      await tester.pumpWidget(card(true));
      expect(_opacityAt(tester, find.text('3 open')), 1.0);
      expect(tester.hasRunningAnimations, isFalse);
    });

    testWidgets('the enter motion never hides content from a screen reader or a tap (semantics and hit test intact)', (tester) async {
      await tester.pumpWidget(card(false));
      expect(find.text('3 open'), findsOneWidget);
      expect(find.text('Orders'), findsOneWidget);
      expect(find.text('Orders').hitTestable(), findsOneWidget);
      await tester.pumpAndSettle();
    });
  });
}
