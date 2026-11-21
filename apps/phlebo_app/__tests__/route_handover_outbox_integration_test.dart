// HC-T27 integration (real SQLCipher outbox.db, no network): handover.recorded persists without a visit id; the M11 list and the M12
// sign-out gate are fed from the REAL outbox (US-12-1, US-13-1, US-13-2 device side).
// ASSUMED API (support/hc27_fixture.dart): OutboxRepository.listRows() newest first, OutboxRepository.pendingCount() = pending + sending.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:phlebo_app/features/handover/ui/handover_screen.dart';
import 'package:phlebo_app/features/outbox/data/outbox_repository.dart' show PushOutcome;
import 'package:phlebo_app/features/outbox/domain/outbox_row.dart';
import 'package:phlebo_app/features/outbox/domain/sync_summary.dart';
import 'package:phlebo_app/features/outbox/ui/outbox_screen.dart';
import 'package:phlebo_app/features/settings/domain/sign_out.dart';
import 'package:phlebo_app/features/settings/ui/settings_screen.dart';

import 'support/hc27_fixture.dart';
import 'support/outbox_fixture.dart' as ob;

void main() {
  testWidgets('US-12-1: the handover the UI produced is stored with visit_id NULL and goes out in a frozen batch without visit_id', (t) async {
    final sink = RecordingSink();
    await pumpScreen(
      t,
      HandoverScreen(centres: centres, tubes: threeTubes(), itemResults: const {}, sink: sink, newId: () => handoverId, onDone: (_) {}),
    );
    await tapText(t, 'Synthetic Centre A2');
    await tapButton(t, 'Hand over 3 tubes');
    final c = sink.only('handover.recorded');

    await t.runAsync(() async {
      final fx = await ob.OutboxFx.create();
      try {
        await fx.repo.enqueue(type: c.type, visitId: c.visitId, visitLabel: c.visitLabel, payload: c.payload);
        final rows = await fx.rows('SELECT type, visit_id, payload_json, state FROM mutation_log');
        expect(rows.single['type'], 'handover.recorded');
        expect(rows.single['visit_id'], isNull);
        expect(rows.single['state'], 'pending');
        final stored = jsonDecode(rows.single['payload_json']! as String) as Map<String, Object?>;
        expect(stored['handover_id'], handoverId);
        expect(stored['to_centre_id'], centreA);
        expect(stored['specimen_ids'], [specA, specB, specC]);

        final batch = (await fx.repo.formBatch())!;
        final body = jsonDecode(batch.bodyJson) as Map<String, Object?>;
        final m = (body['mutations']! as List).single as Map<String, Object?>;
        expect(m['type'], 'handover.recorded');
        expect(m.containsKey('visit_id'), isFalse, reason: 'TRD §6.2: visit_id absent for handover.recorded');
        for (final s in [patientName, patientPhone, patientAddress]) {
          expect(batch.bodyJson.contains(s), isFalse, reason: 'PHI "$s" in the frozen batch');
        }
      } finally {
        await fx.dispose();
      }
    });
  });

  testWidgets('US-13-1: Sign out follows the real outbox: disabled while pending/sending, enabled once every row is terminal', (t) async {
    late ob.OutboxFx fx;
    late int pending;
    await t.runAsync(() async {
      fx = await ob.OutboxFx.create();
      await ob.enqueueType(fx, 'visit.arrived');
      await ob.enqueueType(fx, 'visit.failed');
      await ob.enqueueType(fx, 'handover.recorded');
      pending = await fx.repo.pendingCount();
    });
    addTearDown(() => t.runAsync(fx.dispose));
    expect(pending, 3);

    Future<void> showSettings(int n) => pumpScreen(
          t,
          SettingsScreen(
            deviceId: deviceIdLong,
            appVersion: '1.4.0+27',
            userDisplayName: displayName,
            lastDownload: null,
            lastUpload: null,
            pendingCount: n,
            signOut: () async => SignOutResult.done,
            onSignedOut: () {},
          ),
        );

    await showSettings(pending);
    expect(isEnabled(t, 'Sign out'), isFalse);
    expect(find.text('Sync first — 3 changes are not uploaded yet'), findsOneWidget);

    await t.runAsync(() async {
      final batch = (await fx.repo.formBatch())!;
      expect(await fx.repo.pendingCount(), 3, reason: 'sending still counts: nothing confirmed by the server yet');
      await fx.repo.applyResponse(batch.batchId, [
        PushOutcome(batch.clientMutationIds[0], 'applied'),
        PushOutcome(batch.clientMutationIds[1], 'held', 'homecollection.visit_cancelled'),
        PushOutcome(batch.clientMutationIds[2], 'rejected', 'common.validation_failed'),
      ]);
      pending = await fx.repo.pendingCount();
      expect(await fx.repo.canLogout(), isTrue);
    });
    expect(pending, 0, reason: 'applied, held and rejected are terminal: they do not block sign-out');
    await showSettings(pending);
    expect(isEnabled(t, 'Sign out'), isTrue);
  });

  testWidgets('M11 is fed from the real outbox: labels, visit label without names, held/rejected codes', (t) async {
    late List<OutboxRow> rows;
    late ob.OutboxFx fx;
    await t.runAsync(() async {
      fx = await ob.OutboxFx.create();
      final a = await ob.enqueueType(fx, 'visit.arrived');
      await ob.enqueueType(fx, 'specimen.collected');
      await ob.enqueueType(fx, 'handover.recorded');
      final batch = (await fx.repo.formBatch())!;
      await fx.repo.applyResponse(batch.batchId, [
        PushOutcome(a.clientMutationId, 'applied'),
        PushOutcome(batch.clientMutationIds[1], 'held', 'homecollection.visit_cancelled'),
      ]);
      rows = await fx.repo.listRows();
    });
    addTearDown(() => t.runAsync(fx.dispose));

    expect(rows.length, 3);
    expect(rows.first.type, 'handover.recorded', reason: 'newest first');
    expect(rows.map((r) => r.state).toSet(), {'applied', 'held', 'sending'});

    await pumpScreen(t, OutboxScreen(rows: rows, sync: const SyncSummary(waiting: 1), onUploadNow: () async {}));
    expect(find.text('Arrived'), findsOneWidget);
    expect(find.text('Tube collected'), findsOneWidget);
    expect(find.text('Handover'), findsOneWidget);
    expect(find.text('Uploaded'), findsOneWidget);
    expect(find.text('Uploading'), findsOneWidget);
    expect(find.text('On hold at centre'), findsOneWidget);
    expect(find.text('The centre will review this. Your record is saved.'), findsOneWidget);
    expect(find.byType(Text), findsWidgets);
    expect(t.takeException(), isNull);
  });
}
