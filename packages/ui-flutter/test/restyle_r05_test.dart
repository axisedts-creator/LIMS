// T0D-UI-R05 (LD-140, spec/program/10-DESIGN-SYSTEM.md section 5), amended by T0D-MSERIES-3 (LD-251, LD-246,
// spec/program/13-M-SERIES.md s2, s5): lims_ui theme and widgets follow the tokens.
// Contract tested: page #F3F3F3 (tokens neutral.50), white cards radius 24 (radius.xl), primary pill buttons 48 dp high,
// lime highlight (LimsTokens.colorAccentHighlight) on the current bottom-nav tab, 48 dp targets, tap scale .96, nav text
// labels, Poppins first with Devanagari fallback, no hand-copied hex / pixel radii in lib/src.
// Expected values come from tokens.json / LimsTokens (independent parse), never from the code under test.
// MSERIES-3 edits of this file (old Metro Green values replaced by the 13-M-SERIES values, not weakened): page #F3F7F4 ->
// #F3F3F3, accent #0E4B3B -> #005A52, card radius 16-18 -> 24, targets >= 44 -> >= 48, Plus Jakarta Sans -> Poppins.
import 'dart:io';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';

import '_helpers.dart';

// ---- helpers -------------------------------------------------------------------------------------------------

double _radiusOf(ShapeBorder? s) {
  if (s is RoundedRectangleBorder) return s.borderRadius.resolve(TextDirection.ltr).topLeft.x;
  return -1;
}

/// Pill = StadiumBorder, or rounded rectangle whose radius is at least half the height.
bool _isPill(ShapeBorder? s, double height) => s is StadiumBorder || (s is RoundedRectangleBorder && _radiusOf(s) >= height / 2);

Material _buttonMaterial(WidgetTester t, Finder button) =>
    t.widget<Material>(find.descendant(of: button, matching: find.byType(Material)).first);

/// Every fill colour under [root] (DecoratedBox / ColoredBox / Material / PhysicalModel), with the widget's global rect.
List<(Color, Rect)> _fills(WidgetTester t, Finder root) {
  final out = <(Color, Rect)>[];
  final all = find.descendant(of: root, matching: find.byWidgetPredicate((w) => w is DecoratedBox || w is ColoredBox || w is Material || w is PhysicalModel));
  for (final e in all.evaluate()) {
    final w = e.widget;
    Color? c;
    if (w is DecoratedBox && w.decoration is BoxDecoration) c = (w.decoration as BoxDecoration).color;
    if (w is ColoredBox) c = w.color;
    if (w is Material) c = w.color;
    if (w is PhysicalModel) c = w.color;
    if (c == null) continue;
    final box = e.renderObject;
    if (box is! RenderBox || !box.hasSize) continue;
    out.add((c, box.localToGlobal(Offset.zero) & box.size));
  }
  return out;
}

double _contrast(Color a, Color b) {
  final la = a.computeLuminance(), lb = b.computeLuminance();
  final hi = la > lb ? la : lb, lo = la > lb ? lb : la;
  return (hi + 0.05) / (lo + 0.05);
}

const _navItems = <LimsNavItem>[
  (icon: Icons.receipt_long, label: 'Orders', badge: null),
  (icon: Icons.description, label: 'Reports', badge: null),
  (icon: Icons.event, label: 'Bookings', badge: null),
  (icon: Icons.more_horiz, label: 'More', badge: null),
];

Widget _nav(int index, ValueChanged<int> onTap) => host(Align(alignment: Alignment.bottomCenter, child: LimsBottomNav(items: _navItems, index: index, onTap: onTap)));

/// Width of the label's on-screen rect (applies ancestor transforms, so a scale wrapper shows up here).
double _w(WidgetTester t, Finder f) => t.getRect(f).width;

Future<void> _pressAndHold(WidgetTester t, Finder at, Future<void> Function() whilePressed) async {
  final g = await t.startGesture(t.getCenter(at));
  await t.pump(const Duration(milliseconds: 120));
  await t.pump(const Duration(milliseconds: 400));
  await whilePressed();
  await g.up();
  await t.pumpAndSettle();
}

// ---- tests ---------------------------------------------------------------------------------------------------

void main() {
  final tok = tokensJson();
  final neutral = (tok['color'] as Map)['neutral'] as Map;
  final accent = (tok['color'] as Map)['accent'] as Map;

  group('tokens only (no hand-copied values in lib/src)', () {
    final files = Directory('${pkgDir().path}/lib')
        .listSync(recursive: true)
        .whereType<File>()
        .where((f) => f.path.endsWith('.dart') && !f.path.endsWith('tokens.g.dart'))
        // QR modules must be pure black on white to stay scannable; not a theme colour (functional exception).
        .where((f) => !f.path.replaceAll('\\', '/').endsWith('lib/src/qr_code.dart'))
        .toList();

    test('source files found', () => expect(files.length, greaterThan(5)));

    test('no Color(0x..), Color.fromARGB/RGBO, #RRGGBB string or Colors.<name> literal outside tokens.g.dart', () {
      final bad = RegExp(r'Color\(\s*0x|Color\.from(ARGB|RGBO)|#[0-9A-Fa-f]{6}\b|Colors\.(?!transparent\b)\w+');
      for (final f in files) {
        final lines = f.readAsLinesSync();
        for (var i = 0; i < lines.length; i++) {
          final code = lines[i].replaceFirst(RegExp(r'//.*$'), '');
          expect(bad.hasMatch(code), isFalse, reason: '${f.path}:${i + 1} hand-copied colour: ${lines[i].trim()}');
        }
      }
    });

    test('no pixel radius literal (BorderRadius.circular(12), Radius.circular(8), radius: 16): use LimsTokens.radius*', () {
      final bad = RegExp(r'(?:BorderRadius|Radius)\.circular\(\s*[0-9]|BorderRadius\.all\(\s*Radius\.[a-z]+\(\s*[0-9]|\bradius:\s*[0-9]');
      for (final f in files) {
        final lines = f.readAsLinesSync();
        for (var i = 0; i < lines.length; i++) {
          final code = lines[i].replaceFirst(RegExp(r'//.*$'), '');
          expect(bad.hasMatch(code), isFalse, reason: '${f.path}:${i + 1} pixel radius: ${lines[i].trim()}');
        }
      }
    });

    test('the theme reads the lime highlight and the page colour from LimsTokens', () {
      final src = files.map((f) => f.readAsStringSync()).join('\n');
      expect(src, contains('LimsTokens.colorAccentHighlight'));
      expect(src, contains('LimsTokens.colorNeutral50'));
      expect(src, contains('LimsTokens.radiusXl'));
    });
  });

  group('tokens.json values the M series names (13-M-SERIES s2.1, s2.3)', () {
    test('page #F3F3F3, primary #005A52, lime highlight #A0C032, radius.xl 24 (cards)', () {
      expect(neutral['50'], '#F3F3F3');
      expect(accent['default'], '#005A52');
      expect(accent['highlight'], '#A0C032');
      expect(LimsTokens.colorAccentHighlight.toARGB32(), hex(accent['highlight'] as String).toARGB32());
      expect(LimsTokens.radiusXl, 24);
    });
  });

  group('theme', () {
    test('page background is neutral.50 (#F3F3F3) and cards sit on it as white', () {
      final t = LimsTheme.light();
      expect(t.scaffoldBackgroundColor.toARGB32(), hex(neutral['50'] as String).toARGB32());
      expect(t.scaffoldBackgroundColor, LimsTokens.colorNeutral50);
      expect(t.colorScheme.primary.toARGB32(), hex(accent['default'] as String).toARGB32());
      expect(t.colorScheme.surface.toARGB32(), hex(neutral['0'] as String).toARGB32());
    });

    test('Poppins first (family named by LimsTokens.fontFamilySans), Devanagari fallback, both spellings', () {
      final first = RegExp(r'"([^"]+)"').firstMatch(LimsTokens.fontFamilySans)!.group(1)!;
      expect(first, 'Poppins');
      final t = LimsTheme.light();
      for (final s in [t.textTheme.bodyMedium!, t.textTheme.titleMedium!, t.textTheme.labelLarge!, t.textTheme.headlineSmall!]) {
        expect(s.fontFamily, first);
        expect(s.fontFamilyFallback, containsAll(['Noto Sans Devanagari', 'packages/lims_ui/Poppins', 'packages/lims_ui/Noto Sans Devanagari']));
      }
      expect(LimsTheme.fontFamily, first);
    });

    test('pubspec declares Poppins, Noto Sans Devanagari and Mono; every asset exists', () {
      final pub = File('${pkgDir().path}/pubspec.yaml').readAsStringSync();
      for (final f in ['Poppins', 'Noto Sans Devanagari', 'Noto Sans Mono']) {
        expect(pub, contains('family: $f'));
      }
      for (final m in RegExp(r'asset:\s*(\S+)').allMatches(pub)) {
        expect(File('${pkgDir().path}/${m.group(1)}').existsSync(), isTrue, reason: m.group(1));
      }
    });

    test('tap targets stay padded (>= 44)', () {
      expect(LimsTheme.light().materialTapTargetSize, MaterialTapTargetSize.padded);
    });
  });

  group('stock widgets under LimsTheme.light()', () {
    testWidgets('Scaffold page colour is #F3F3F3', (tester) async {
      await tester.pumpWidget(host(const Text('x')));
      final ctx = tester.element(find.byType(Scaffold));
      expect(Theme.of(ctx).scaffoldBackgroundColor.toARGB32(), hex(neutral['50'] as String).toARGB32());
    });

    testWidgets('FilledButton: primary fill, pill, >= 44 tall', (tester) async {
      await tester.pumpWidget(host(Center(child: FilledButton(onPressed: () {}, child: const Text('Save')))));
      final f = find.bySubtype<FilledButton>();
      final h = tester.getSize(f).height;
      expect(h, greaterThanOrEqualTo(44));
      final m = _buttonMaterial(tester, f);
      expect(m.color, LimsTokens.colorAccentDefault);
      expect(_isPill(m.shape, h), isTrue, reason: 'shape was ${m.shape}');
    });

    testWidgets('OutlinedButton: pill, >= 44 tall', (tester) async {
      await tester.pumpWidget(host(Center(child: OutlinedButton(onPressed: () {}, child: const Text('Cancel')))));
      final f = find.bySubtype<OutlinedButton>();
      final h = tester.getSize(f).height;
      expect(h, greaterThanOrEqualTo(44));
      expect(_isPill(_buttonMaterial(tester, f).shape, h), isTrue);
    });

    testWidgets('Card: white fill, radius 24 (radius.xl), flat (elevation <= 1)', (tester) async {
      await tester.pumpWidget(host(const Card(child: SizedBox(width: 200, height: 80))));
      final m = _buttonMaterial(tester, find.byType(Card));
      expect(m.color, LimsTokens.colorNeutral0);
      expect(_radiusOf(m.shape), 24, reason: 'shape was ${m.shape}');
      expect(_radiusOf(m.shape), LimsTokens.radiusXl);
      expect(m.elevation, lessThanOrEqualTo(1));
    });
  });

  group('Lims widgets', () {
    testWidgets('LimsButton primary: pill, primary fill, white label, >= 44; secondary: pill', (tester) async {
      await tester.pumpWidget(host(Column(children: [
        LimsButton(label: 'Collect', onPressed: () {}),
        LimsButton(label: 'Back', secondary: true, onPressed: () {}),
        const LimsButton(label: 'Locked', onPressed: null),
      ])));
      for (final label in ['Collect', 'Back', 'Locked']) {
        final btn = find.ancestor(of: find.text(label), matching: find.byWidgetPredicate((w) => w is FilledButton || w is OutlinedButton)).first;
        final h = tester.getSize(btn).height;
        expect(h, greaterThanOrEqualTo(44), reason: label);
        expect(_isPill(_buttonMaterial(tester, btn).shape, h), isTrue, reason: '$label shape ${_buttonMaterial(tester, btn).shape}');
      }
      final primary = find.ancestor(of: find.text('Collect'), matching: find.bySubtype<FilledButton>()).first;
      expect(_buttonMaterial(tester, primary).color, LimsTokens.colorAccentDefault);
    });

    testWidgets('LimsCard: white card, radius 24, page colour behind it differs', (tester) async {
      await tester.pumpWidget(host(const LimsCard(title: 'Health score', child: Text('82/100'))));
      final m = _buttonMaterial(tester, find.byType(Card));
      expect(m.color, LimsTokens.colorNeutral0);
      expect(_radiusOf(m.shape), 24, reason: 'shape was ${m.shape}');
      expect(Theme.of(tester.element(find.byType(Card))).scaffoldBackgroundColor, isNot(m.color));
    });

    testWidgets('targets >= 44: list tile, slot picker button, segmented control', (tester) async {
      await tester.pumpWidget(host(Column(children: [
        LimsListTile(title: 'Row', onTap: () {}),
        LimsSlotPicker(days: [
          (date: '2026-11-10', slots: [(start: 's1', label: '08:00', remaining: 3)])
        ], onSelected: (_) {}, calendarMode: 'AD'),
        LimsSegmentedControl<String>(options: const [(value: 'a', label: 'Myself'), (value: 'b', label: 'My child')], value: 'a', onChanged: (_) {}),
      ])));
      expect(tester.getSize(find.byType(LimsListTile)).height, greaterThanOrEqualTo(44));
      expect(tester.getSize(find.bySubtype<OutlinedButton>().first).height, greaterThanOrEqualTo(44));
      expect(tester.getSize(find.bySubtype<SegmentedButton<String>>()).height, greaterThanOrEqualTo(44));
    });
  });

  group('bottom navigation (text labels + lime current tab)', () {
    testWidgets('every item shows its text label; targets >= 44', (tester) async {
      await tester.pumpWidget(_nav(0, (_) {}));
      for (final i in _navItems) {
        expect(find.text(i.label), findsOneWidget);
        expect(tester.getSize(find.ancestor(of: find.text(i.label), matching: find.byType(InkResponse)).first).height, greaterThanOrEqualTo(44));
      }
    });

    testWidgets('lime highlight sits on the current tab only and follows the selection', (tester) async {
      var idx = 0;
      await tester.pumpWidget(host(StatefulBuilder(
        builder: (c, set) => Align(alignment: Alignment.bottomCenter, child: LimsBottomNav(items: _navItems, index: idx, onTap: (i) => set(() => idx = i))),
      )));

      Future<void> expectLimeOn(int cur) async {
        final lime = _fills(tester, find.byType(LimsBottomNav)).where((f) => f.$1 == LimsTokens.colorAccentHighlight).map((f) => f.$2).toList();
        expect(lime, isNotEmpty, reason: 'no fill with LimsTokens.colorAccentHighlight under LimsBottomNav');
        bool hits(int i) => lime.any((r) => r.contains(tester.getCenter(find.text(_navItems[i].label))) || r.contains(tester.getCenter(find.byIcon(_navItems[i].icon))));
        expect(hits(cur), isTrue, reason: 'highlight must cover tab $cur (icon or label)');
        for (var i = 0; i < _navItems.length; i++) {
          if (i != cur) expect(hits(i), isFalse, reason: 'tab $i must not be highlighted while $cur is current');
        }
      }

      await expectLimeOn(0);
      await tester.tap(find.text('Bookings'));
      await tester.pumpAndSettle();
      expect(idx, 2);
      await expectLimeOn(2);
    });

    testWidgets('current label keeps >= 4.5:1 contrast on the lime highlight', (tester) async {
      await tester.pumpWidget(_nav(1, (_) {}));
      final el = tester.element(find.text('Reports'));
      final style = DefaultTextStyle.of(el).style.merge(tester.widget<Text>(find.text('Reports')).style);
      expect(_contrast(style.color!, LimsTokens.colorAccentHighlight), greaterThanOrEqualTo(4.5));
    });
  });

  group('tap scale .96', () {
    testWidgets('LimsButton (primary): label scales to .96 while pressed, back to 1 on release, onPressed still fires', (tester) async {
      var taps = 0;
      await tester.pumpWidget(host(Center(child: LimsButton(label: 'Collect sample', onPressed: () => taps++))));
      final label = find.text('Collect sample');
      final rest = _w(tester, label);
      await _pressAndHold(tester, label, () async => expect(_w(tester, label) / rest, closeTo(0.96, 0.01)));
      expect(_w(tester, label) / rest, closeTo(1.0, 0.002));
      expect(taps, 1);
    });

    testWidgets('LimsButton (secondary) scales too', (tester) async {
      await tester.pumpWidget(host(Center(child: LimsButton(label: 'Back to worklist', secondary: true, onPressed: () {}))));
      final label = find.text('Back to worklist');
      final rest = _w(tester, label);
      await _pressAndHold(tester, label, () async => expect(_w(tester, label) / rest, closeTo(0.96, 0.01)));
    });

    testWidgets('disabled LimsButton does not scale', (tester) async {
      await tester.pumpWidget(host(const Center(child: LimsButton(label: 'Locked item', onPressed: null))));
      final label = find.text('Locked item');
      final rest = _w(tester, label);
      await _pressAndHold(tester, label, () async => expect(_w(tester, label) / rest, closeTo(1.0, 0.002)));
    });

    testWidgets('bottom-nav item scales to .96 while pressed; tap still selects', (tester) async {
      var idx = 0;
      await tester.pumpWidget(_nav(0, (i) => idx = i));
      final label = find.text('Reports');
      final rest = _w(tester, label);
      await _pressAndHold(tester, label, () async => expect(_w(tester, label) / rest, closeTo(0.96, 0.01)));
      expect(idx, 1);
    });

    testWidgets('scale wrapper keeps the button tappable at 200% text scale without overflow', (tester) async {
      var taps = 0;
      await tester.pumpWidget(host(LimsButton(label: 'Collect sample', onPressed: () => taps++), textScale: 2.0));
      await tester.tap(find.text('Collect sample'));
      expect(taps, 1);
      expect(tester.takeException(), isNull);
    });
  });

  group('golden baselines updated for the restyle', () {
    // FNV-style hash of the PNG bytes the repo held before T0D-UI-R05 (taken from HEAD at test-writing time).
    int h(List<int> b) {
      var x = 7;
      for (final v in b) {
        x = (x * 31 + v) & 0x7FFFFFFFFFFFFFFF;
      }
      return x;
    }

    for (final name in ['status_chips.png', 'cr16_widgets.png']) {
      test('$name was re-recorded (differs from the pre-restyle baseline)', () {
        final f = File('${pkgDir().path}/test/goldens/$name');
        expect(f.existsSync(), isTrue);
        expect(h(f.readAsBytesSync()), isNot(_staleHashes[name]), reason: 'run: flutter test --update-goldens (inside packages/ui-flutter)');
      });
    }

    for (final name in ['restyle_buttons.png', 'restyle_card_nav.png']) {
      test('$name baseline exists and is a PNG', () {
        final f = File('${pkgDir().path}/test/goldens/$name');
        expect(f.existsSync(), isTrue, reason: 'record with: flutter test --update-goldens test/restyle_r05_test.dart');
        expect(f.readAsBytesSync().take(8).toList(), [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      });
    }

    // T0D-MSERIES-3: every golden was re-recorded by this change (bytes differ from those committed before it).
    for (final e in _preMSeries3Hashes.entries) {
      test('${e.key} was re-recorded by T0D-MSERIES-3 (differs from the Metro Green baseline)', () {
        final f = File('${pkgDir().path}/test/goldens/${e.key}');
        expect(f.existsSync(), isTrue);
        expect(h(f.readAsBytesSync()), isNot(e.value), reason: 'run: flutter test --update-goldens (inside packages/ui-flutter)');
      });
    }

    testWidgets('golden: buttons (primary / secondary / disabled), card on the page, text field', (tester) async {
      await tester.binding.setSurfaceSize(const Size(360, 520));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(host(Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          LimsButton(label: 'Collect sample', icon: Icons.qr_code_scanner, onPressed: () {}),
          const SizedBox(height: 12),
          LimsButton(label: 'Back to worklist', secondary: true, onPressed: () {}),
          const SizedBox(height: 12),
          const LimsButton(label: 'Locked', onPressed: null),
          const SizedBox(height: 12),
          const LimsTextField(label: 'Patient code', maxLength: 12),
          const LimsCard(title: 'नमूना सङ्कलन', footer: Text('Poppins'), child: Text('Accession 000123')),
        ]),
      )));
      await expectLater(find.byType(Scaffold), matchesGoldenFile('goldens/restyle_buttons.png'));
    });

    testWidgets('golden: bottom navigation with lime current tab on the page colour', (tester) async {
      await tester.binding.setSurfaceSize(const Size(360, 160));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(host(Column(children: [
        const LimsCard(title: 'Orders', child: Text('3 open')),
        LimsBottomNav(items: _navItems, index: 1, onTap: (_) {}),
      ])));
      await expectLater(find.byType(Scaffold), matchesGoldenFile('goldens/restyle_card_nav.png'));
    });
  });
}

// Hashes (h() above) of the baselines committed before this task; a re-record under the new theme must change them.
// Same hash of the four baselines committed before T0D-MSERIES-3 (Metro Green look, taken at test-writing time).
const _preMSeries3Hashes = <String, int>{
  'status_chips.png': 3652146056648981758,
  'cr16_widgets.png': 1273363468543190539,
  'restyle_buttons.png': 8475314103812708341,
  'restyle_card_nav.png': 5889508457191634608,
};

const _staleHashes = <String, int>{
  'status_chips.png': 7004372987761365903,
  'cr16_widgets.png': 5759708319527510114,
};
