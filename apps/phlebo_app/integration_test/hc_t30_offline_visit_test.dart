// HC-T30 device scenario (02-TRD §15 "Device" row; DoD §5.2): a visit is collected OFFLINE, the app is killed mid-batch,
// the push is retried under airplane mode with the SAME frozen bytes, then the server answers and the outbox drains.
// Forensic check at the end: cache.db / outbox.db on disk do not start with "SQLite format 3" (REQ-SEC-103).
// Real SQLCipher stores, no network (the server is played by applyResponse). Synthetic data only.
// Run: flutter test integration_test/hc_t30_offline_visit_test.dart   (emulator: flutter test -d <id> integration_test)
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:phlebo_app/core/db/cache_db.dart';
import 'package:phlebo_app/core/sync/sync_engine.dart' show SyncStatus;
import 'package:phlebo_app/features/outbox/data/outbox_repository.dart' show PushOutcome;

import '../__tests__/support/db_fixture.dart';
import '../__tests__/support/outbox_fixture.dart';
import '../__tests__/support/sync_fixture.dart';
import '../__tests__/support/tls_fixture.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('offline visit -> kill app mid-batch -> airplane-mode retry (same bytes) -> drained; stores are not plaintext SQLite', (t) async {
    await t.runAsync(() async {
      final fx = await OutboxFx.create();
      try {
        // 1. offline: the phlebotomist works the visit; every step is saved on the phone only.
        for (final type in const ['visit.arrived', 'visit.identity_checked', 'visit.consent_recorded', 'specimen.collected', 'visit.completed']) {
          fx.tick(const Duration(seconds: 5));
          await enqueueType(fx, type);
        }
        expect(await fx.repo.pendingCount(), 5);

        // 2. a push starts (batch frozen, rows -> sending), then the app is killed before any response.
        final first = (await fx.repo.formBatch())!;
        await fx.repo.recordAttempt(first.batchId);
        await fx.restart();

        // 3. airplane mode: the retry after restart sends the stored body byte for byte (idempotent on the server).
        final retry = (await fx.repo.outstandingBatch())!;
        expect(retry.batchId, first.batchId);
        expect(retry.bodyJson, first.bodyJson);
        expect(await fx.repo.formBatch(), isNull, reason: 'no second batch while one has no response');
        await fx.repo.recordAttempt(retry.batchId);
        expect(await fx.repo.pendingCount(), 5, reason: 'nothing confirmed while offline');

        // 4. back online: the server applies every mutation; the outbox drains.
        final ids = (jsonDecode(retry.bodyJson)['mutations'] as List).map((m) => (m as Map)['client_mutation_id'] as String).toList();
        await fx.repo.applyResponse(retry.batchId, [for (final id in ids) PushOutcome(id, 'applied')]);
        expect(await fx.repo.pendingCount(), 0);
        expect(await fx.repo.outstandingBatch(), isNull);

        // 5. forensic: encrypted at rest (outbox.db here; cache.db below).
        await fx.db.close();
        expect(hasPlainSqliteHeader(fx.db.file), isFalse, reason: 'outbox.db must not start with "SQLite format 3"');
        final cache = await CacheDb.open(dir: fx.dir, keys: fx.keys);
        await cache.execute('CREATE TABLE probe (v TEXT)');
        await cache.execute('INSERT INTO probe (v) VALUES (?)', ['Zzyxqa Synthetic-Patient']);
        await cache.close();
        expect(hasPlainSqliteHeader(cache.file), isFalse, reason: 'cache.db must not start with "SQLite format 3"');
        expect(sandboxContains(fx.dir, 'Zzyxqa Synthetic-Patient'), isFalse);
      } finally {
        await fx.dispose();
      }
    });
  });

  // 02-TRD §15 Device row: "expired token -> refresh -> same key". Reuses the HC-T25 fakes (real pinned ApiClient over TLS,
  // FakeHcServer, FakeSession); the batch was frozen before an app kill, the first push after restart gets 401
  // auth.token_expired, the session refreshes and the retry carries the same Idempotency-Key (= batch_id) and identical body.
  testWidgets('kill mid-batch -> expired token: 401 -> refresh -> same batch_id + identical body -> drained', (t) async {
    await t.runAsync(() async {
      final pki = await TestPki.create();
      final fx = await SyncFx.create(pki);
      try {
        await enqueueVisitFlow(fx.ofx);
        final frozen = (await fx.ofx.repo.formBatch())!;
        await fx.restart();

        fx.server.validToken = 'tok-2'; // tok-1 expired while the phone was offline
        fx.session.tokenAfterRefresh = 'tok-2';
        final r = await fx.sync();

        expect(r.status, SyncStatus.ok);
        expect(fx.session.refreshCalls, 1);
        final p = fx.server.pushes;
        expect(p, hasLength(2));
        expect(p[0].header('authorization'), 'Bearer tok-1');
        expect(p[1].header('authorization'), 'Bearer tok-2');
        for (final push in p) {
          expect(push.header('idempotency-key'), frozen.batchId);
          expect(push.body, frozen.bodyJson, reason: 'byte for byte');
        }
        expect(await fx.states(), List.filled(7, 'applied'));
        expect(await fx.ofx.repo.outstandingBatch(), isNull);
      } finally {
        await fx.dispose();
        pki.dispose();
      }
    });
  });
}
