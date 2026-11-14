// HC-T24 / US-07-1, US-13-1 — 05-SCHEMA B.2 invariants 3, 4, 5; TRD §6.1 S-4, §6.3 (PushRequest), 02-TRD review #3.
// "batches.body_json re-sent byte for byte". Real SQLCipher outbox.db on the host. Synthetic data only.
//
// ASSUMED API (package:phlebo_app/features/outbox/data/outbox_repository.dart; wiring in support/outbox_fixture.dart):
//   class OutboxBatch { String batchId; String bodyJson; List<String> clientMutationIds; }   // ids in device_seq order
//   class PushOutcome { PushOutcome(String clientMutationId, String outcome, [String? code]); }  // outcome: applied|duplicate|held|rejected
//   Future<OutboxBatch?> formBatch();
//        // null when nothing is pending OR an earlier batch still has 'sending' rows (a new batch only after a response for the old one).
//        // ONE transaction: insert batches row (body_json = serialized PushRequest, written once) + rows pending→sending with batch_id.
//        // Takes the oldest pending by device_seq, ≤100 rows and body ≤ 512*1024 UTF-8 bytes.
//   Future<OutboxBatch?> outstandingBatch();   // the batch whose rows are 'sending' (retry path): bodyJson read back from batches.body_json
//   Future<void> recordAttempt(String batchId);                  // attempts += 1, last_attempt_at = wall now (state stays 'sending')
//   Future<void> applyResponse(String batchId, List<PushOutcome> results);  // state/outcome_code/terminal_at; deletes the batches row once all its rows are terminal
//   Future<OutboxBatch> reformAfterKeyReused(String batchId);    // 422 common.idempotency_key_reused: delete batches row, new batch_id + new body for the same rows
//   Future<void> purge();                                        // invariant 4 (24 h after terminal_at [CONV]; unreferenced non-newest anchors)
//   Future<bool> canLogout();                                    // invariant 5 local half: no pending/sending rows
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:phlebo_app/features/outbox/data/outbox_repository.dart';

import 'support/outbox_fixture.dart';

Map<String, Object?> _body(OutboxBatch b) => jsonDecode(b.bodyJson) as Map<String, Object?>;
Future<int> _count(OutboxFx fx, String sql) async => (await fx.rows(sql)).single['n'] as int;

void main() {
  late OutboxFx fx;
  setUp(() async => fx = await OutboxFx.create());
  tearDown(() async => fx.dispose());

  Future<void> enqueueMany(int n, {Map<String, Object?> Function(int i)? payload}) async {
    for (var i = 0; i < n; i++) {
      fx.tick(const Duration(seconds: 1));
      await enqueueType(fx, 'visit.arrived', payload: payload?.call(i));
    }
  }

  Future<void> answerAll(OutboxBatch b, String outcome, [String? code]) =>
      fx.repo.applyResponse(b.batchId, [for (final id in b.clientMutationIds) PushOutcome(id, outcome, code)]);

  group('forming a batch (invariant 3, PushRequest shape TRD §6.3)', () {
    test('body_json is the serialized PushRequest: device_id, batch_id, sent_at_device, anchors, now.*, mutations', () async {
      final anchor = (await fx.anchors.latest())!;
      fx.tick(const Duration(minutes: 2));
      await enqueueType(fx, 'visit.arrived');
      fx.tick(const Duration(minutes: 2));
      await enqueueType(fx, 'specimen.collected');
      await enqueueType(fx, 'handover.recorded');
      fx.tick(const Duration(minutes: 10));
      final batch = (await fx.repo.formBatch())!;
      final body = _body(batch);

      expect(isUuidv7(batch.batchId), isTrue, reason: 'batch_id is a UUIDv7 = Idempotency-Key');
      expect(body.keys.toSet(), {'device_id', 'batch_id', 'sent_at_device', 'anchors', 'now', 'mutations'});
      expect(body['device_id'], deviceId);
      expect(body['batch_id'], batch.batchId);
      expect(body['sent_at_device'], fx.wall.now.toIso8601String(), reason: 'fixed at the moment the batch is formed');
      expect(body['now'], {
        'device_wall_time': fx.wall.now.toIso8601String(),
        'monotonic_ms': fx.mono.ms,
        'boot_id': 'b-0000000017',
      });
      expect(body['anchors'], [
        {
          'anchor_id': anchor.anchorId,
          'server_time': '2026-11-06T00:30:00.000Z',
          'device_wall_time': '2026-11-06T00:30:00.000Z',
          'monotonic_ms': 86400123,
          'boot_id': 'b-0000000017',
        }
      ]);

      final ms = (body['mutations'] as List).cast<Map<String, Object?>>();
      expect([for (final m in ms) m['device_seq']], [1, 2, 3], reason: 'oldest pending first, strictly increasing');
      expect([for (final m in ms) m['client_mutation_id']], batch.clientMutationIds);
      expect(ms[0].keys.toSet(), {'client_mutation_id', 'device_seq', 'type', 'visit_id', 'captured', 'payload'});
      expect(ms[0]['captured'], {
        'device_wall_time': '2026-11-06T00:32:00.000Z',
        'anchor_id': anchor.anchorId,
        'elapsed_since_anchor_ms': 120000,
      });
      expect(ms[0]['payload'], payloadFor('visit.arrived'), reason: 'payload is an embedded object, not a string');
      expect(ms[2]['type'], 'handover.recorded');
      expect(ms[2].containsKey('visit_id'), isFalse, reason: 'visit_id absent for handover.recorded');
      expect(batch.bodyJson.contains('payload_sha256'), isFalse, reason: 'payload_sha256 is LOCAL ONLY, never sent');
      expect(batch.bodyJson.contains('visit_label'), isFalse);
    });

    test('forming is one transaction: batches row written, rows moved pending→sending with that batch_id', () async {
      await enqueueMany(3);
      final b = (await fx.repo.formBatch())!;
      final stored = await fx.rows('SELECT batch_id, body_json, created_at FROM batches');
      expect(stored.single['batch_id'], b.batchId);
      expect(stored.single['body_json'], b.bodyJson);
      expect(stored.single['created_at'], matches(isoUtcMs));
      final rows = await fx.rows('SELECT state, batch_id FROM mutation_log');
      expect(rows.every((r) => r['state'] == 'sending' && r['batch_id'] == b.batchId), isTrue);
      expect(await fx.repo.canLogout(), isFalse);
    });

    test('nothing pending → null and no batches row', () async {
      expect(await fx.repo.formBatch(), isNull);
      expect(await _count(fx, 'SELECT count(*) AS n FROM batches'), 0);
    });

    test('≤ 100 mutations per batch; the next batch is formed only after a response for the old one', () async {
      await enqueueMany(130);
      final first = (await fx.repo.formBatch())!;
      expect(first.clientMutationIds.length, 100);
      expect(((_body(first)['mutations']) as List).map((m) => (m as Map)['device_seq']).toList(), [for (var i = 1; i <= 100; i++) i]);
      expect(await fx.repo.formBatch(), isNull, reason: 'old batch has no response yet → no second batch');
      expect(await _count(fx, 'SELECT count(*) AS n FROM batches'), 1);

      await answerAll(first, 'applied');
      final second = (await fx.repo.formBatch())!;
      expect(second.batchId, isNot(first.batchId));
      expect(((_body(second)['mutations']) as List).map((m) => (m as Map)['device_seq']).toList(), [for (var i = 101; i <= 130; i++) i]);
    });

    test('≤ 512 KB serialized: oversized pending set is split at a prefix, no gaps, no overlap, no row lost', () async {
      // ~7 KB payload each (8 KB per-mutation cap, 07-SECURITY REQ-SEC-080) × 100 ≈ 700 KB > 512 KB.
      final pad = 'x' * 7000;
      await enqueueMany(100, payload: (i) => {'gps': {'status': 'off'}, 'padding': pad});
      final first = (await fx.repo.formBatch())!;
      expect(utf8.encode(first.bodyJson).length, lessThanOrEqualTo(512 * 1024));
      expect(first.clientMutationIds.length, lessThan(100));
      expect(first.clientMutationIds.length, greaterThan(50), reason: 'fills the batch, does not under-pack');

      final seqs = <int>[for (final m in (_body(first)['mutations'] as List)) (m as Map)['device_seq'] as int];
      await answerAll(first, 'applied');
      while (true) {
        final next = await fx.repo.formBatch();
        if (next == null) break;
        expect(utf8.encode(next.bodyJson).length, lessThanOrEqualTo(512 * 1024));
        seqs.addAll([for (final m in (_body(next)['mutations'] as List)) (m as Map)['device_seq'] as int]);
        await answerAll(next, 'applied');
      }
      expect(seqs, [for (var i = 1; i <= 100; i++) i], reason: 'every mutation sent exactly once, in order');
    });
  });

  group('frozen body: re-sent byte for byte (review #3, TRD S-4)', () {
    test('retries (timeout, 5xx, 401 after refresh, 409 in_progress) return the identical bytes; later activity cannot change them', () async {
      await enqueueMany(3);
      final batch = (await fx.repo.formBatch())!;
      final frozen = utf8.encode(batch.bodyJson);

      // The world moves on: time passes, a new anchor is stored, more mutations queue up, the phone reboots.
      for (var attempt = 1; attempt <= 4; attempt++) {
        fx.tick(Duration(minutes: 7 * attempt));
        await fx.anchor(serverTime: '2026-11-06T0$attempt:00:00.000Z');
        await enqueueType(fx, 'visit.completed');
        fx.boot.id = 'b-00000000${20 + attempt}';
        await fx.repo.recordAttempt(batch.batchId);

        final again = (await fx.repo.outstandingBatch())!;
        expect(again.batchId, batch.batchId, reason: 'same Idempotency-Key');
        expect(utf8.encode(again.bodyJson), frozen, reason: 'byte-identical on attempt $attempt');
        expect((await fx.rows('SELECT body_json FROM batches WHERE batch_id = ?', [batch.batchId])).single['body_json'], batch.bodyJson);
        expect(await fx.repo.formBatch(), isNull, reason: 'a new batch only after a response for the old one');
      }
      final rows = await fx.rows("SELECT attempts, state, last_attempt_at FROM mutation_log WHERE batch_id = '${batch.batchId}'");
      expect(rows.length, 3);
      expect(rows.every((r) => r['attempts'] == 4 && r['state'] == 'sending' && (r['last_attempt_at'] as String).startsWith('2026-11-06')), isTrue);
      expect(await _count(fx, "SELECT count(*) AS n FROM mutation_log WHERE state = 'pending'"), 4, reason: 'later mutations wait');
    });

    test('kill-app: after restart the outstanding batch is re-sent byte for byte with the same batch_id', () async {
      await enqueueMany(5);
      final batch = (await fx.repo.formBatch())!;
      await fx.repo.recordAttempt(batch.batchId);
      await fx.restart();
      final again = (await fx.repo.outstandingBatch())!;
      expect(again.batchId, batch.batchId);
      expect(utf8.encode(again.bodyJson), utf8.encode(batch.bodyJson));
      expect(again.clientMutationIds, batch.clientMutationIds);
      expect(await fx.repo.formBatch(), isNull);
    });

    test('kill-app between batch formation and send: a second connection already sees body_json and sending rows (one commit)', () async {
      await enqueueMany(2);
      final batch = (await fx.repo.formBatch())!;
      final other = await fx.otherConnection();
      addTearDown(other.close);
      expect((await other.select('SELECT body_json FROM batches')).single['body_json'], batch.bodyJson);
      expect((await other.select("SELECT count(*) AS n FROM mutation_log WHERE state='sending' AND batch_id = ?", [batch.batchId])).single['n'], 2);
    });

    test('outstandingBatch() is null when nothing is in flight', () async {
      expect(await fx.repo.outstandingBatch(), isNull);
      await enqueueMany(1);
      expect(await fx.repo.outstandingBatch(), isNull, reason: 'pending is not in flight');
    });
  });

  group('server responses', () {
    test('applied / duplicate / held / rejected set state, outcome_code, terminal_at; batches row deleted when all rows terminal', () async {
      await enqueueMany(4);
      final b = (await fx.repo.formBatch())!;
      fx.tick(const Duration(seconds: 3));
      final ids = b.clientMutationIds;
      await fx.repo.applyResponse(b.batchId, [
        PushOutcome(ids[0], 'applied'),
        PushOutcome(ids[1], 'duplicate'),
        PushOutcome(ids[2], 'held', 'homecollection.mutation_superseded'),
        PushOutcome(ids[3], 'rejected', 'common.not_found'),
      ]);
      final rows = {for (final r in await fx.rows('SELECT * FROM mutation_log')) r['client_mutation_id'] as String: r};
      expect([for (final id in ids) rows[id]!['state']], ['applied', 'duplicate', 'held', 'rejected']);
      expect(rows[ids[2]]!['outcome_code'], 'homecollection.mutation_superseded');
      expect(rows[ids[3]]!['outcome_code'], 'common.not_found');
      expect(rows[ids[0]]!['outcome_code'], isNull);
      expect(rows.values.every((r) => r['terminal_at'] == fx.wall.now.toIso8601String()), isTrue);
      expect(await _count(fx, 'SELECT count(*) AS n FROM batches'), 0, reason: 'batches row deleted when its rows are terminal');
      expect(await fx.repo.outstandingBatch(), isNull);
    });

    test('a response for a different batch_id changes nothing', () async {
      await enqueueMany(2);
      final b = (await fx.repo.formBatch())!;
      await fx.repo.applyResponse('01a1a98a-ac44-7000-8000-00000000dead', [PushOutcome(b.clientMutationIds[0], 'applied')]);
      expect(await _count(fx, "SELECT count(*) AS n FROM mutation_log WHERE state = 'sending'"), 2);
      expect(await _count(fx, 'SELECT count(*) AS n FROM batches'), 1);
    });

    test('422 common.idempotency_key_reused: old batches row deleted, same rows get a NEW batch_id and a new body; facts untouched', () async {
      await enqueueMany(3);
      final old = (await fx.repo.formBatch())!;
      await fx.repo.recordAttempt(old.batchId);
      final cols = 'client_mutation_id, device_seq, type, visit_id, payload_json, payload_sha256, captured_wall_time, anchor_id, elapsed_since_anchor_ms';
      final facts = await fx.rows('SELECT $cols FROM mutation_log ORDER BY device_seq');
      fx.tick(const Duration(minutes: 1));

      final fresh = await fx.repo.reformAfterKeyReused(old.batchId);
      expect(fresh.batchId, isNot(old.batchId));
      expect(isUuidv7(fresh.batchId), isTrue);
      expect(fresh.clientMutationIds, old.clientMutationIds);
      final body = _body(fresh);
      expect(body['batch_id'], fresh.batchId);
      expect((body['mutations'] as List).map((m) => (m as Map)['device_seq']).toList(), [1, 2, 3]);

      final batches = await fx.rows('SELECT batch_id, body_json FROM batches');
      expect(batches.single['batch_id'], fresh.batchId, reason: 'old row deleted, only the new one stored');
      expect(batches.single['body_json'], fresh.bodyJson);
      final rows = await fx.rows('SELECT state, batch_id FROM mutation_log');
      expect(rows.every((r) => r['state'] == 'sending' && r['batch_id'] == fresh.batchId), isTrue);
      expect(await fx.rows('SELECT $cols FROM mutation_log ORDER BY device_seq'), facts);
      expect(utf8.encode((await fx.repo.outstandingBatch())!.bodyJson), utf8.encode(fresh.bodyJson), reason: 'the NEW body is frozen too');
    });
  });

  group('invariant 4: retention', () {
    test('terminal rows are deleted 24 h after terminal_at, not before; non-terminal rows never', () async {
      await enqueueMany(2);
      final b = (await fx.repo.formBatch())!;
      await enqueueMany(1); // stays pending
      await answerAll(b, 'applied');
      final terminalAt = fx.wall.now;

      fx.wall.now = terminalAt.add(const Duration(hours: 23, minutes: 59));
      await fx.repo.purge();
      expect(await _count(fx, "SELECT count(*) AS n FROM mutation_log WHERE state = 'applied'"), 2, reason: '23 h 59 min: kept');

      fx.wall.now = terminalAt.add(const Duration(hours: 24, minutes: 1));
      await fx.repo.purge();
      expect(await _count(fx, "SELECT count(*) AS n FROM mutation_log WHERE state = 'applied'"), 0, reason: '24 h 1 min: gone');
      expect(await _count(fx, "SELECT count(*) AS n FROM mutation_log WHERE state = 'pending'"), 1);

      fx.wall.now = terminalAt.add(const Duration(days: 400));
      await fx.repo.purge();
      expect(await _count(fx, "SELECT count(*) AS n FROM mutation_log WHERE state = 'pending'"), 1, reason: 'never purged while non-terminal');
    });

    test('a stuck "sending" row is never purged either, however old', () async {
      await enqueueMany(1);
      await fx.repo.formBatch();
      fx.wall.now = fx.wall.now.add(const Duration(days: 30));
      await fx.repo.purge();
      expect(await _count(fx, "SELECT count(*) AS n FROM mutation_log WHERE state = 'sending'"), 1);
      expect(await _count(fx, 'SELECT count(*) AS n FROM batches'), 1);
    });

    test('anchors: unreferenced AND older than the newest are deleted; referenced and the newest are kept', () async {
      final a1 = (await fx.anchors.latest())!;
      await enqueueType(fx, 'visit.arrived'); // references a1
      fx.tick(const Duration(minutes: 5));
      final a2 = await fx.anchor(serverTime: '2026-11-06T00:35:00.000Z'); // unreferenced, older than a3
      fx.tick(const Duration(minutes: 5));
      final a3 = await fx.anchor(serverTime: '2026-11-06T00:40:00.000Z'); // newest, unreferenced
      await fx.repo.purge();
      final left = {for (final r in await fx.rows('SELECT anchor_id FROM clock_anchors')) r['anchor_id']};
      expect(left, {a1.anchorId, a3.anchorId});
      expect(left, isNot(contains(a2.anchorId)));
    });

    test('an anchor still referenced by a surviving row is kept even when older than the newest', () async {
      final a1 = (await fx.anchors.latest())!;
      await enqueueType(fx, 'visit.arrived');
      fx.tick(const Duration(minutes: 5));
      await fx.anchor(serverTime: '2026-11-06T00:35:00.000Z');
      await fx.repo.purge();
      expect(await _count(fx, "SELECT count(*) AS n FROM clock_anchors WHERE anchor_id = '${a1.anchorId}'"), 1);
      expect(await fx.repo.integrityViolations(), isEmpty);
    });
  });

  group('invariant 5: logout gate (local half)', () {
    test('canLogout is true only when no row is pending or sending', () async {
      expect(await fx.repo.canLogout(), isTrue, reason: 'empty outbox');
      await enqueueMany(2);
      expect(await fx.repo.canLogout(), isFalse, reason: 'pending');
      final b = (await fx.repo.formBatch())!;
      expect(await fx.repo.canLogout(), isFalse, reason: 'sending');
      await answerAll(b, 'applied');
      expect(await fx.repo.canLogout(), isTrue, reason: 'only terminal rows left');
    });

    test('held and rejected are terminal for the gate; a stuck sending row (no response) still blocks', () async {
      await enqueueMany(2);
      final b = (await fx.repo.formBatch())!;
      await fx.repo.applyResponse(b.batchId, [
        PushOutcome(b.clientMutationIds[0], 'held', 'homecollection.mutation_superseded'),
        // second row: no answer yet
      ]);
      expect(await fx.repo.canLogout(), isFalse);
      await fx.repo.applyResponse(b.batchId, [PushOutcome(b.clientMutationIds[1], 'rejected', 'common.not_found')]);
      expect(await fx.repo.canLogout(), isTrue);
    });

    test('the gate survives a restart (state is in the DB, not in memory)', () async {
      await enqueueMany(1);
      await fx.restart();
      expect(await fx.repo.canLogout(), isFalse);
    });
  });
}
