// T0D-15 / AC-0D-9.2: LimsStatusChip and web StatusChip use the same colour token and label key for the same status.
// ASSUMED API: LimsStatusChip({required String kind, required String status, String? tone, String? label}) (const)
//   getters: String tone, String labelKey ('ui.status.<kind>.<status>'); renders the English label in tone fg on tone bg.
//   LimsFlagBadge({required String flag, bool showNormal = false}) (04 §1.3 flag rows).
// Mapping rows are parsed from the web component (packages/ui/.../StatusChip.tsx) = 04 §1.3.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';

import '_helpers.dart';

Color _fg(String tone) => switch (tone) {
      'neutral' => LimsTokens.colorToneNeutralFg,
      'info' => LimsTokens.colorToneInfoFg,
      'success' => LimsTokens.colorToneSuccessFg,
      'warning' => LimsTokens.colorToneWarningFg,
      'danger' => LimsTokens.colorToneDangerFg,
      'critical' => LimsTokens.colorToneCriticalFg,
      _ => throw ArgumentError(tone),
    };
Color _bg(String tone) => switch (tone) {
      'neutral' => LimsTokens.colorToneNeutralBg,
      'info' => LimsTokens.colorToneInfoBg,
      'success' => LimsTokens.colorToneSuccessBg,
      'warning' => LimsTokens.colorToneWarningBg,
      'danger' => LimsTokens.colorToneDangerBg,
      'critical' => LimsTokens.colorToneCriticalBg,
      _ => throw ArgumentError(tone),
    };

void main() {
  final web = webStatusMap();
  const kinds = ['specimen', 'result', 'report_version', 'order', 'invoice', 'payment_intent', 'dead_letter'];

  test('parsed web table is non-trivial (guards the oracle itself)', () {
    expect(web.keys, containsAll(kinds));
    expect(web['specimen']!.length, 14);
  });

  for (final k in kinds) {
    testWidgets('AC-0D-9.2 $k: every status has the same tone token, label key and text as web', (tester) async {
      for (final e in web[k]!.entries) {
        final (tone, label) = e.value;
        final chip = LimsStatusChip(kind: k, status: e.key);
        expect(chip.tone, tone, reason: '$k.${e.key}');
        expect(chip.labelKey, 'ui.status.$k.${e.key}');
        await tester.pumpWidget(host(chip));
        expect(find.text(label), findsOneWidget, reason: '$k.${e.key} label');
        final ctx = tester.element(find.text(label));
        final style = DefaultTextStyle.of(ctx).style.merge(tester.widget<Text>(find.text(label)).style);
        expect(style.color, _fg(tone), reason: '$k.${e.key} fg');
        final bgs = [
          ...tester.widgetList<Container>(find.descendant(of: find.byType(LimsStatusChip), matching: find.byType(Container)))
              .map((c) => c.decoration).whereType<BoxDecoration>().map((d) => d.color),
          ...tester.widgetList<Material>(find.descendant(of: find.byType(LimsStatusChip), matching: find.byType(Material)))
              .map((m) => m.color),
          ...tester.widgetList<DecoratedBox>(find.descendant(of: find.byType(LimsStatusChip), matching: find.byType(DecoratedBox)))
              .map((d) => d.decoration).whereType<BoxDecoration>().map((d) => d.color),
        ];
        expect(bgs, contains(_bg(tone)), reason: '$k.${e.key} bg');
      }
    });
  }

  testWidgets('unknown status/kind -> neutral chip with raw code, never throws (CV 4.11)', (tester) async {
    await tester.pumpWidget(host(const LimsStatusChip(kind: 'specimen', status: 'brand_new_code')));
    expect(find.text('brand_new_code'), findsOneWidget);
    expect(tester.takeException(), isNull);
    expect(const LimsStatusChip(kind: 'nonesuch', status: 'x').tone, 'neutral');
    expect(const LimsStatusChip(kind: 'specimen', status: '__proto__').tone, 'neutral');
  });

  test('generic kind takes tone + label; invalid tone falls back to neutral', () {
    expect(const LimsStatusChip(kind: 'generic', status: 's', tone: 'success', label: 'Fine').tone, 'success');
    expect(const LimsStatusChip(kind: 'generic', status: 's', tone: 'purple', label: 'x').tone, 'neutral');
  });

  testWidgets('no colour-only status: critical flag has icon + bold label; low flag has text', (tester) async {
    await tester.pumpWidget(host(const Column(children: [
      LimsFlagBadge(flag: 'HH'),
      LimsFlagBadge(flag: 'L'),
    ])));
    expect(find.text('Critical high'), findsOneWidget);
    expect(find.text('Low'), findsOneWidget);
    expect(find.descendant(of: find.byType(LimsFlagBadge).first, matching: find.byType(Icon)), findsWidgets);
    final t = tester.widget<Text>(find.text('Critical high'));
    expect(t.style?.fontWeight?.value ?? 400, greaterThanOrEqualTo(600));
  });

  testWidgets('FlagBadge N renders no text unless showNormal', (tester) async {
    await tester.pumpWidget(host(const LimsFlagBadge(flag: 'N')));
    expect(find.byType(Text), findsNothing);
  });

  testWidgets('chip survives 200% text scale with a Devanagari label', (tester) async {
    await tester.pumpWidget(host(const LimsStatusChip(kind: 'generic', status: 'x', tone: 'info', label: 'नमूना प्राप्त भयो'), textScale: 2.0));
    expect(tester.takeException(), isNull);
  });
}
