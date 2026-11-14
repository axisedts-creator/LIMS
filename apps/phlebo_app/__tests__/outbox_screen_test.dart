// HC-T27 M11 Outbox (04-UI-UX §3.11). ASSUMED API: OutboxScreen({rows, sync, onUploadNow}), OutboxRow, SyncSummary (support/hc27_fixture.dart).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:phlebo_app/features/outbox/domain/outbox_row.dart';
import 'package:phlebo_app/features/outbox/domain/sync_summary.dart';
import 'package:phlebo_app/features/outbox/ui/outbox_screen.dart';

import 'support/hc27_fixture.dart';

void main() {
  late int uploads;

  Future<void> open(WidgetTester t, List<OutboxRow> rows, {double textScale = 1.0, Future<void> Function()? onUpload}) async {
    uploads = 0;
    await pumpScreen(
      t,
      OutboxScreen(
        rows: rows,
        sync: SyncSummary(waiting: rows.where((r) => r.state == 'pending').length, lastUpload: DateTime(2026, 11, 14, 9, 15)),
        onUploadNow: onUpload ?? () async => uploads++,
      ),
      textScale: textScale,
    );
  }

  testWidgets('header is the sync status chip; empty list says nothing is waiting', (t) async {
    await open(t, const []);
    expect(find.text('0 waiting · Last upload 09:15'), findsOneWidget);
    expect(find.byType(LimsEmptyState), findsOneWidget);
  });

  testWidgets('every mutation type has its plain label', (t) async {
    const labels = {
      'visit.arrived': 'Arrived',
      'visit.identity_checked': 'ID check',
      'visit.consent_recorded': 'Consent',
      'specimen.collected': 'Tube collected',
      'specimen.not_collected': 'Tube not collected',
      'payment.captured': 'Payment',
      'visit.completed': 'Visit finished',
      'visit.failed': 'Visit failed',
      'handover.recorded': 'Handover',
    };
    var i = 0;
    await open(t, [for (final e in labels.keys) outboxRow('m${i++}', e, 'pending')]);
    for (final l in labels.values) {
      await t.ensureVisible(find.text(l));
      expect(find.text(l), findsOneWidget, reason: l);
    }
  });

  testWidgets('states: Waiting / Uploading / Uploaded / On hold at centre / Not accepted: {reason}', (t) async {
    await open(t, [
      outboxRow('m1', 'visit.arrived', 'pending'),
      outboxRow('m2', 'visit.identity_checked', 'sending'),
      outboxRow('m3', 'visit.consent_recorded', 'applied'),
      outboxRow('m4', 'specimen.collected', 'duplicate'),
      outboxRow('m5', 'payment.captured', 'held', code: 'homecollection.visit_cancelled'),
      outboxRow('m6', 'visit.completed', 'rejected', code: 'homecollection.specimen_not_found'),
    ]);
    expect(find.text('Waiting'), findsOneWidget);
    expect(find.text('Uploading'), findsOneWidget);
    expect(find.text('Uploaded'), findsNWidgets(2), reason: 'applied and duplicate are both done');
    expect(find.text('On hold at centre'), findsOneWidget);
    expect(find.text('Not accepted: homecollection.specimen_not_found'), findsOneWidget);
  });

  testWidgets('held and rejected rows explain: "The centre will review this. Your record is saved."', (t) async {
    await open(t, [
      outboxRow('m1', 'payment.captured', 'held', code: 'homecollection.visit_cancelled'),
      outboxRow('m2', 'visit.completed', 'rejected', code: 'common.validation_failed'),
      outboxRow('m3', 'visit.arrived', 'applied'),
    ]);
    expect(find.text('The centre will review this. Your record is saved.'), findsNWidgets(2));
  });

  testWidgets('row shows visit sequence + window and time, never a patient name', (t) async {
    await open(t, [outboxRow('m1', 'visit.arrived', 'pending', at: DateTime(2026, 11, 14, 9, 15))]);
    expect(find.textContaining('#2 · 09:00–10:00'), findsOneWidget);
    expect(find.textContaining('09:15'), findsWidgets);
    final shown = t.widgetList<Text>(find.byType(Text)).map((w) => w.data ?? '').join(' | ');
    for (final s in [patientName, patientPhone, patientBirth, patientAddress]) {
      expect(shown.contains(s), isFalse, reason: 'PHI "$s" on the outbox screen');
    }
  });

  testWidgets('a handover row has no visit label and still renders', (t) async {
    await open(t, [outboxRow('m1', 'handover.recorded', 'pending', label: null)]);
    expect(find.text('Handover'), findsOneWidget);
    expect(t.takeException(), isNull);
  });

  testWidgets('"Upload now" asks for one upload; a second tap while it runs does nothing', (t) async {
    final gate = Future<void>.delayed(const Duration(seconds: 1));
    await open(t, [outboxRow('m1', 'visit.arrived', 'pending')], onUpload: () {
      uploads++;
      return gate;
    });
    await t.tap(button('Upload now'));
    await t.pump();
    await t.tap(button('Upload now'), warnIfMissed: false);
    await t.pump();
    expect(uploads, 1);
    await t.pumpAndSettle(const Duration(seconds: 2));
  });

  testWidgets('LD-140: LimsSecureScreen + LimsScaffold, "Upload now" is the one primary button, 2.0 text scale does not overflow', (t) async {
    await open(t, [outboxRow('m1', 'payment.captured', 'held', code: 'x'), outboxRow('m2', 'visit.arrived', 'pending')], textScale: 2.0);
    expect(find.byType(LimsSecureScreen), findsOneWidget);
    expect(find.byType(LimsScaffold), findsOneWidget);
    expectOnePrimary(t);
    expect(find.byIcon(Icons.sync), findsNothing, reason: 'no raw icon buttons; actions are LimsButton');
    expect(t.takeException(), isNull);
  });
}
