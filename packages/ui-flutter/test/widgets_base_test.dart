// T0D-15 / 04-UI-UX §8 base widgets + Accessibility + Security hooks (REQ-SEC-109/111).
// ASSUMED API: LimsTextField({label, required int maxLength, bool sensitive=false, controller?, onChanged?, errorText?})
//   LimsButton({required String label, VoidCallback? onPressed}); LimsConfirmDialog.show(context, {title, message, reasons: List<({String code,String label})>, requireReason}) -> Future<String?> (reason code | null)
//   LimsEmptyState({title, message?}) LimsErrorState({title, message?, onRetry?}) LimsLoading() LimsOfflineBanner() LimsSyncStatus({queued, syncing, synced, error})
//   LimsSecureScreen({required child}) - screenshot protection wrapper (platform call is a no-op in tests).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';

import '_helpers.dart';

void main() {
  testWidgets('LimsTextField enforces maxLength (04 §2 / REQ-SEC)', (tester) async {
    final got = <String>[];
    await tester.pumpWidget(host(LimsTextField(label: 'Note', maxLength: 5, onChanged: got.add)));
    await tester.enterText(find.byType(TextField), 'abcdefghij');
    expect(tester.widget<EditableText>(find.byType(EditableText)).controller.text.length, lessThanOrEqualTo(5));
  });

  testWidgets('sensitive LimsTextField: no suggestions, no autocorrect (REQ-SEC-111)', (tester) async {
    await tester.pumpWidget(host(const LimsTextField(label: 'Reg no', maxLength: 20, sensitive: true)));
    final f = tester.widget<TextField>(find.byType(TextField));
    expect(f.enableSuggestions, isFalse);
    expect(f.autocorrect, isFalse);
  });

  testWidgets('LimsButton: >= 48dp tall, label read by semantics, disabled when onPressed null', (tester) async {
    var n = 0;
    await tester.pumpWidget(host(Column(children: [
      LimsButton(label: 'Save', onPressed: () => n++),
      const LimsButton(label: 'Locked', onPressed: null),
    ])));
    expect(tester.getSize(find.widgetWithText(LimsButton, 'Save')).height, greaterThanOrEqualTo(48));
    await tester.tap(find.text('Save'));
    expect(n, 1);
    expect(find.bySemanticsLabel('Save'), findsOneWidget);
    await tester.tap(find.text('Locked'), warnIfMissed: false);
    expect(n, 1);
  });

  testWidgets('LimsConfirmDialog returns the chosen reason code; Cancel returns null', (tester) async {
    String? out = 'unset';
    await tester.pumpWidget(host(Builder(builder: (c) => TextButton(
          onPressed: () async => out = await LimsConfirmDialog.show(c,
              title: 'Discard report?', message: 'This cannot be undone.', requireReason: true,
              reasons: const [(code: 'wrong_patient', label: 'Wrong patient'), (code: 'duplicate', label: 'Duplicate')]),
          child: const Text('open'),
        ))));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('Discard report?'), findsOneWidget);
    await tester.tap(find.text('Wrong patient'));
    await tester.pump();
    await tester.tap(find.text('Confirm'));
    await tester.pumpAndSettle();
    expect(out, 'wrong_patient');
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(out, isNull);
  });

  testWidgets('LimsConfirmDialog with requireReason cannot confirm without a reason', (tester) async {
    String? out = 'unset';
    await tester.pumpWidget(host(Builder(builder: (c) => TextButton(
          onPressed: () async => out = await LimsConfirmDialog.show(c,
              title: 'Discard?', message: 'm', requireReason: true, reasons: const [(code: 'a', label: 'A')]),
          child: const Text('open'),
        ))));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Confirm'), warnIfMissed: false);
    await tester.pumpAndSettle();
    expect(out, 'unset', reason: 'dialog must stay open / not resolve without a reason');
  });

  testWidgets('empty / error / loading / offline / sync states render text, error offers retry', (tester) async {
    var retried = 0;
    await tester.pumpWidget(host(Column(children: [
      const LimsEmptyState(title: 'No orders yet'),
      LimsErrorState(title: 'Could not load', onRetry: () => retried++),
      const LimsLoading(),
      const LimsOfflineBanner(),
      const LimsSyncStatus(queued: 2, syncing: 1, synced: 10, error: 1),
    ])));
    expect(find.text('No orders yet'), findsOneWidget);
    expect(find.text('Could not load'), findsOneWidget);
    await tester.tap(find.text('Retry'));
    expect(retried, 1);
    expect(find.byType(LimsOfflineBanner), findsOneWidget);
    expect(find.textContaining('2'), findsWidgets);
    expect(find.byType(CircularProgressIndicator), findsWidgets);
  });

  testWidgets('LimsSecureScreen wraps child and does not throw without a platform channel', (tester) async {
    await tester.pumpWidget(host(const LimsSecureScreen(child: Text('PHI'))));
    expect(find.text('PHI'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('every interactive Lims widget survives 200% text scale (360dp) with no overflow', (tester) async {
    await tester.pumpWidget(host(Column(children: [
      LimsButton(label: 'Save and continue to the next step', onPressed: () {}),
      const LimsTextField(label: 'A fairly long field label for Devanagari नमूना', maxLength: 10),
      const LimsCard(title: 'Card title that is long enough to wrap', child: Text('x')),
    ]), textScale: 2.0));
    expect(tester.takeException(), isNull);
  });
}
