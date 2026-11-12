// HC-T24 / US-07-1 — 05-SCHEMA B.2 invariants 1 & 2 (mutation_log), 07-SECURITY "outbox never contains name/phone/address".
// Real SQLCipher outbox.db on the host (same prerequisite as HC-T22 db_forensics_test). Synthetic data only.
//
// ASSUMED API (see support/outbox_fixture.dart for the wiring):
//   OutboxSchema.ensure(OutboxDb)                       — creates device_state / batches / clock_anchors / mutation_log exactly per B.2; seeds next_device_seq='1'
//   class SavedMutation { String clientMutationId; int deviceSeq; }
//   OutboxRepository.enqueue({required String type, String? visitId, String? visitLabel, required Map<String,Object?> payload}) -> Future<SavedMutation>
//        // ONE SQLite transaction: insert mutation_log row + bump device_state.next_device_seq. The future completes only AFTER commit
//        // (the UI shows "Saved on phone" on completion). Throws, leaving NO row and NO seq consumed, on: unknown type, non-handover
//        // without visitId, no clock anchor yet, payload containing a PHI key (name/phone/address/test-name denylist, any depth).
//        // Concurrent calls are serialised (no interleaved BEGIN, no duplicate seq).
//   OutboxRepository.integrityViolations() -> Future<List<String>>   // client_mutation_ids whose sha256(payload_json bytes) != payload_sha256
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:phlebo_app/features/outbox/data/outbox_repository.dart';

import 'support/db_fixture.dart';
import 'support/outbox_fixture.dart';
import 'support/sha256.dart';

Object? _sortedDeep(Object? v) {
  if (v is Map) return {for (final k in (v.keys.toList()..sort())) k as String: _sortedDeep(v[k])};
  if (v is List) return [for (final e in v) _sortedDeep(e)];
  return v;
}

bool _keysSortedDeep(Object? v) {
  if (v is Map) {
    final keys = v.keys.cast<String>().toList();
    final sorted = [...keys]..sort();
    if (keys.join('\u0000') != sorted.join('\u0000')) return false;
    return v.values.every(_keysSortedDeep);
  }
  if (v is List) return v.every(_keysSortedDeep);
  return true;
}

const _immutableCols = [
  'client_mutation_id', 'device_seq', 'type', 'visit_id', 'visit_label', 'payload_json', 'payload_sha256',
  'captured_wall_time', 'anchor_id', 'elapsed_since_anchor_ms',
];

void main() {
  late OutboxFx fx;
  setUp(() async => fx = await OutboxFx.create());
  tearDown(() async => fx.dispose());

  test('sha256 oracle self-check (FIPS vectors)', () {
    expect(sha256OfString(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256OfString('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  group('schema (05-SCHEMA B.2)', () {
    test('tables and columns exist exactly as specified; device_state seeded', () async {
      Future<Set<String>> cols(String t) async => {for (final r in await fx.rows('PRAGMA table_info($t)')) r['name'] as String};
      expect(await cols('mutation_log'), {
        'client_mutation_id', 'device_seq', 'type', 'visit_id', 'visit_label', 'payload_json', 'payload_sha256',
        'captured_wall_time', 'anchor_id', 'elapsed_since_anchor_ms', 'state', 'outcome_code', 'batch_id', 'attempts',
        'last_attempt_at', 'terminal_at',
      });
      expect(await cols('batches'), {'batch_id', 'body_json', 'created_at'});
      expect(await cols('clock_anchors'), {'anchor_id', 'server_time', 'device_wall_time', 'monotonic_ms', 'boot_id', 'created_seq'});
      expect(await cols('device_state'), {'key', 'value'});
      final seq = await fx.rows("SELECT value FROM device_state WHERE key='next_device_seq'");
      expect(seq.single['value'], '1', reason: 'next_device_seq starts at 1');
    });

    test('ensure() is idempotent and never resets next_device_seq', () async {
      await enqueueType(fx, 'visit.arrived');
      await enqueueType(fx, 'visit.completed');
      await fx.restart(); // calls OutboxSchema.ensure again
      final seq = await fx.rows("SELECT value FROM device_state WHERE key='next_device_seq'");
      expect(seq.single['value'], '3');
      expect((await fx.rows('SELECT count(*) AS n FROM mutation_log')).single['n'], 2);
    });

    test('DB itself rejects an unknown type, a bad state and a duplicate device_seq (CHECK / UNIQUE)', () async {
      final a = await fx.anchors.latest();
      Future<void> raw(String id, int seq, String type, [String state = 'pending']) => fx.db.execute(
          "INSERT INTO mutation_log (client_mutation_id, device_seq, type, visit_id, payload_json, payload_sha256, captured_wall_time, anchor_id, elapsed_since_anchor_ms, state) "
          "VALUES (?,?,?,?,?,?,?,?,?,?)",
          [id, seq, type, visitA, '{}', 'x', '2026-11-06T00:30:00.000Z', a!.anchorId, 0, state]);
      await raw('m1', 900, 'visit.arrived');
      await expectLater(raw('m2', 901, 'visit.deleted'), throwsA(anything));
      await expectLater(raw('m3', 902, 'visit.arrived', 'done'), throwsA(anything));
      await expectLater(raw('m4', 900, 'visit.arrived'), throwsA(anything));
      await expectLater(
          fx.db.execute(
              "INSERT INTO mutation_log (client_mutation_id, device_seq, type, payload_json, payload_sha256, captured_wall_time, anchor_id, elapsed_since_anchor_ms) "
              "VALUES ('m5',903,'visit.arrived','{}','x','t','no-such-anchor',0)"),
          throwsA(anything),
          reason: 'anchor_id REFERENCES clock_anchors (foreign_keys=ON)');
    });
  });

  group('US-07-1: airplane-mode flow → 7 mutations', () {
    test('7 mutations: consecutive device_seq, UUIDv7 ids, wall time, anchor id, monotonic elapsed; nothing lost after force-close+reopen', () async {
      final anchor = (await fx.anchors.latest())!; // created by OutboxFx.create at monotonic 86 400 123
      const flow = [
        'visit.arrived', 'visit.identity_checked', 'visit.consent_recorded', 'specimen.collected', 'specimen.collected',
        'payment.captured', 'visit.completed',
      ];
      final saved = <SavedMutation>[];
      for (var i = 0; i < flow.length; i++) {
        fx.tick(const Duration(seconds: 30));
        saved.add(await enqueueType(fx, flow[i],
            payload: flow[i] == 'specimen.collected'
                ? payloadFor(flow[i], barcode: i == 3 ? 'E2600000042' : 'E2600000043', specimenId: i == 3 ? specimen1 : specimen2)
                : null));
      }
      expect([for (final s in saved) s.deviceSeq], [1, 2, 3, 4, 5, 6, 7]);

      Future<void> check() async {
        final rows = await fx.rows('SELECT * FROM mutation_log ORDER BY device_seq');
        expect(rows.length, 7);
        for (var i = 0; i < 7; i++) {
          final r = rows[i];
          expect(r['device_seq'], i + 1);
          expect(r['type'], flow[i]);
          expect(isUuidv7(r['client_mutation_id'] as String), isTrue);
          expect(r['client_mutation_id'], saved[i].clientMutationId);
          expect(r['captured_wall_time'], matches(isoUtcMs));
          expect(r['captured_wall_time'], DateTime.utc(2026, 11, 6, 0, 30, 30 * (i + 1)).toIso8601String(),
              reason: 'wall time of capture, ISO-8601 UTC with ms');
          expect(r['anchor_id'], anchor.anchorId);
          expect(r['elapsed_since_anchor_ms'], 30000 * (i + 1), reason: 'monotonic_now - anchor.monotonic_ms');
          expect(r['state'], 'pending');
          expect(r['attempts'], 0);
          expect(r['batch_id'], isNull);
          expect(r['terminal_at'], isNull);
        }
        expect((await fx.rows("SELECT value FROM device_state WHERE key='next_device_seq'")).single['value'], '8');
      }

      await check();
      await fx.restart(); // force-close + reopen
      await check();
      final next = await enqueueType(fx, 'visit.arrived', visit: visitB);
      expect(next.deviceSeq, 8, reason: 'device_seq continues after restart, never reused or reset');
    });

    test('every mutation type can be stored; handover.recorded has NULL visit_id, others keep theirs', () async {
      for (final t in allTypes) {
        await enqueueType(fx, t);
      }
      final rows = await fx.rows('SELECT type, visit_id, visit_label FROM mutation_log ORDER BY device_seq');
      expect([for (final r in rows) r['type']], allTypes);
      for (final r in rows) {
        expect(r['visit_id'], r['type'] == 'handover.recorded' ? isNull : visitA);
        expect(r['visit_label'], '#3 · 07:15–07:45');
      }
    });

    test('non-handover mutation without visit_id is refused and consumes no device_seq', () async {
      await expectLater(fx.repo.enqueue(type: 'visit.arrived', payload: payloadFor('visit.arrived')), throwsA(anything));
      await expectLater(fx.repo.enqueue(type: 'visit.deleted', visitId: visitA, payload: const {}), throwsA(anything));
      expect((await fx.rows('SELECT count(*) AS n FROM mutation_log')).single['n'], 0);
      expect((await enqueueType(fx, 'visit.arrived')).deviceSeq, 1);
    });

    test('no clock anchor yet → refused, nothing written (anchor_id is NOT NULL)', () async {
      final bare = await OutboxFx.create(withAnchor: false);
      addTearDown(bare.dispose);
      await expectLater(enqueueType(bare, 'visit.arrived'), throwsA(anything));
      expect((await bare.rows('SELECT count(*) AS n FROM mutation_log')).single['n'], 0);
      expect((await bare.rows("SELECT value FROM device_state WHERE key='next_device_seq'")).single['value'], '1');
    });
  });

  group('invariant 2 / kill-app: persisted before UI ack, row + seq in ONE transaction', () {
    test('after enqueue() completes, a second connection (no close, no checkpoint on the first) sees the row AND the bumped seq', () async {
      final saved = await enqueueType(fx, 'visit.arrived'); // "Saved on phone" would be shown now
      final other = await fx.otherConnection();
      addTearDown(other.close);
      final rows = await other.select('SELECT client_mutation_id, device_seq FROM mutation_log');
      expect(rows.single['client_mutation_id'], saved.clientMutationId);
      expect(rows.single['device_seq'], 1);
      expect((await other.select("SELECT value FROM device_state WHERE key='next_device_seq'")).single['value'], '2');
    });

    test('a failed enqueue leaves no row and no gap in device_seq (rolled back together)', () async {
      await enqueueType(fx, 'visit.arrived');
      for (final bad in [
        () => fx.repo.enqueue(type: 'bogus.type', visitId: visitA, payload: const {'a': 1}),
        () => fx.repo.enqueue(type: 'visit.completed', payload: payloadFor('visit.completed')),
      ]) {
        await expectLater(bad(), throwsA(anything));
      }
      final other = await fx.otherConnection();
      addTearDown(other.close);
      expect((await other.select('SELECT count(*) AS n FROM mutation_log')).single['n'], 1);
      expect((await other.select("SELECT value FROM device_state WHERE key='next_device_seq'")).single['value'], '2');
      expect((await enqueueType(fx, 'visit.completed')).deviceSeq, 2, reason: 'no burned sequence numbers');
    });

    test('40 concurrent enqueues → device_seq exactly 1..40, no duplicates, no exceptions', () async {
      final saved = await Future.wait([
        for (var i = 0; i < 40; i++) enqueueType(fx, 'visit.arrived', visit: i.isEven ? visitA : visitB),
      ]);
      expect(saved.map((s) => s.deviceSeq).toSet(), {for (var i = 1; i <= 40; i++) i});
      expect(saved.map((s) => s.clientMutationId).toSet().length, 40);
      expect((await fx.rows('SELECT count(*) AS n FROM mutation_log')).single['n'], 40);
      expect((await fx.rows("SELECT value FROM device_state WHERE key='next_device_seq'")).single['value'], '41');
    });
  });

  group('payload_json is canonical, hashed locally, immutable (invariant 1)', () {
    test('canonical JSON: keys sorted at every depth, round-trips, sha256 of the stored bytes == payload_sha256', () async {
      final p = payloadFor('payment.captured');
      await enqueueType(fx, 'payment.captured', payload: p);
      final r = (await fx.rows('SELECT payload_json, payload_sha256 FROM mutation_log')).single;
      final text = r['payload_json'] as String;
      final decoded = jsonDecode(text);
      expect(decoded, p);
      expect(_keysSortedDeep(decoded), isTrue);
      expect(text, jsonEncode(_sortedDeep(p)), reason: 'compact, sorted-key JSON');
      expect(r['payload_sha256'], sha256OfString(text));
    });

    test('same logical payload, different key order → byte-identical payload_json and hash', () async {
      await enqueueType(fx, 'specimen.collected',
          payload: {'scan_method': 'camera', 'specimen_id': specimen1, 'scanned_barcode': 'E26', 'specimen_type_code': 'EDTA_WB', 'gps': {'status': 'off'}});
      await enqueueType(fx, 'specimen.collected',
          payload: {'gps': {'status': 'off'}, 'specimen_type_code': 'EDTA_WB', 'scanned_barcode': 'E26', 'specimen_id': specimen1, 'scan_method': 'camera'});
      final rows = await fx.rows('SELECT payload_json, payload_sha256 FROM mutation_log ORDER BY device_seq');
      expect(rows[0]['payload_json'], rows[1]['payload_json']);
      expect(rows[0]['payload_sha256'], rows[1]['payload_sha256']);
    });

    test('non-ASCII text is hashed over its UTF-8 bytes', () async {
      await enqueueType(fx, 'visit.failed', payload: {'reason_code': 'other', 'reason_text': 'घरमा कोही थिएन', 'gps': {'status': 'off'}});
      final r = (await fx.rows('SELECT payload_json, payload_sha256 FROM mutation_log')).single;
      expect(r['payload_sha256'], sha256Hex(utf8.encode(r['payload_json'] as String)));
    });

    test('lifecycle (batch → attempt → response) changes ONLY state/outcome_code/batch_id/attempts/last_attempt_at/terminal_at', () async {
      for (final t in ['visit.arrived', 'visit.identity_checked', 'visit.consent_recorded']) {
        fx.tick(const Duration(seconds: 5));
        await enqueueType(fx, t);
      }
      final cols = _immutableCols.join(', ');
      final before = await fx.rows('SELECT $cols FROM mutation_log ORDER BY device_seq');
      final batch = (await fx.repo.formBatch())!;
      await fx.repo.recordAttempt(batch.batchId);
      fx.tick(const Duration(minutes: 1));
      await fx.repo.applyResponse(batch.batchId, [
        for (final id in batch.clientMutationIds) PushOutcome(id, 'applied'),
      ]);
      expect(await fx.rows('SELECT $cols FROM mutation_log ORDER BY device_seq'), before);
      final after = await fx.rows('SELECT state, outcome_code, batch_id, attempts, last_attempt_at, terminal_at FROM mutation_log');
      expect(after.every((r) => r['state'] == 'applied' && r['terminal_at'] != null && r['attempts'] == 1), isTrue);
    });

    test('integrityViolations() is empty normally and names a row whose payload_json was tampered with', () async {
      final a = await enqueueType(fx, 'visit.arrived');
      final b = await enqueueType(fx, 'visit.completed');
      expect(await fx.repo.integrityViolations(), isEmpty);
      await fx.db.execute('UPDATE mutation_log SET payload_json = ? WHERE client_mutation_id = ?', ['{"outcome":"partial"}', b.clientMutationId]);
      expect(await fx.repo.integrityViolations(), [b.clientMutationId]);
      expect(await fx.repo.integrityViolations(), isNot(contains(a.clientMutationId)));
    });
  });

  group('07-SECURITY: no patient name / phone / address / test name in any payload or label', () {
    const phiKeys = [
      'full_name', 'patient_name', 'patient_full_name', 'name', 'phone', 'phone_e164', 'patient_phone_e164', 'address',
      'address_text', 'landmark', 'birth_on', 'birth_date', 'note_for_phlebotomist', 'test_name', 'test_names', 'patient',
    ];

    test('PHI keys are refused at any depth and nothing (row, seq) is written', () async {
      for (final k in phiKeys) {
        await expectLater(
            enqueueType(fx, 'visit.arrived', payload: {'gps': {'status': 'off'}, k: 'Zzyxqa Synthetic-Patient'}), throwsA(anything),
            reason: 'top-level key "$k"');
        await expectLater(
            enqueueType(fx, 'visit.arrived', payload: {'gps': {'status': 'off', 'extra': {k: '+9779800000123'}}}), throwsA(anything),
            reason: 'nested key "$k"');
      }
      expect((await fx.rows('SELECT count(*) AS n FROM mutation_log')).single['n'], 0);
      expect((await fx.rows("SELECT value FROM device_state WHERE key='next_device_seq'")).single['value'], '1');
    });

    test('the realistic payload of every type contains no denylisted key (positive control)', () async {
      for (final t in allTypes) {
        await enqueueType(fx, t);
      }
      final keys = <String>{};
      void walk(Object? v) {
        if (v is Map) {
          for (final e in v.entries) {
            keys.add(e.key as String);
            walk(e.value);
          }
        } else if (v is List) {
          v.forEach(walk);
        }
      }

      for (final r in await fx.rows('SELECT payload_json FROM mutation_log')) {
        walk(jsonDecode(r['payload_json'] as String));
      }
      expect(keys.intersection(phiKeys.toSet()), isEmpty);
    });
  });
}
