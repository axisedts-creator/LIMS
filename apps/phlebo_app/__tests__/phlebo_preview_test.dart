// The sample-data host: route list renders, a visit opens, outbox opens. Synthetic data only.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:phlebo_app/app/phlebo_preview.dart';

void main() {
  testWidgets('route shows the sample visits; a visit opens; settings opens', (t) async {
    t.view.physicalSize = const Size(390, 844);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.reset);
    await t.pumpWidget(MaterialApp(theme: LimsTheme.light(), home: const PhleboPreviewHome()));
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
    expect(find.textContaining('Sample Patient One'), findsWidgets);
    await t.tap(find.textContaining('Sample Patient One').first);
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
    expect(find.textContaining('Sample Patient One'), findsWidgets);
    await t.pageBack();
    await t.pumpAndSettle();
    expect(find.textContaining('Sample Patient Two'), findsWidgets);
  });
}
