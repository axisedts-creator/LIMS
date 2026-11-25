// Test helper for the phlebotomist look: PhleboTheme, 800x1800 view, optional text scale. Time is controlled by the caller.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:phlebo_app/ui/phlebo_theme.dart';

Future<void> pumpPhlebo(WidgetTester t, Widget screen, {double textScale = 1.0, bool settle = true}) async {
  t.view.physicalSize = const Size(800, 1800);
  t.view.devicePixelRatio = 1.0;
  addTearDown(t.view.reset);
  await t.pumpWidget(MaterialApp(
    theme: PhleboTheme.light(),
    builder: (c, child) => MediaQuery(data: MediaQuery.of(c).copyWith(textScaler: TextScaler.linear(textScale)), child: child!),
    home: screen,
  ));
  if (settle) {
    await t.pumpAndSettle();
  } else {
    await t.pump();
  }
}

Finder limsButton(String label) => find.widgetWithText(LimsButton, label);

Future<void> tapLabel(WidgetTester t, Finder f) async {
  await t.ensureVisible(f);
  await t.tap(f);
  await t.pumpAndSettle();
}
