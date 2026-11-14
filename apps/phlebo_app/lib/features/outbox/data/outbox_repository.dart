// HC-T24: durable mutation outbox over outbox.db (05-SCHEMA B.2 invariants 1–5, TRD §6.3 PushRequest, §7.5 clocks).
// No logging anywhere in this file: payloads carry barcodes and amounts (P2).
import 'dart:convert';

import '../../../core/db/outbox_db.dart';
import '../../../core/platform/boot_id.dart';
import '../../../core/platform/monotonic_clock.dart';
import '../../../core/sync/clock_anchor.dart';
import 'outbox_lock.dart';
import 'sha256.dart';
import 'time_format.dart';

const mutationTypes = <String>{
  'visit.arrived',
  'visit.identity_checked',
  'visit.consent_recorded',
  'specimen.collected',
  'specimen.not_collected',
  'payment.captured',
  'visit.completed',
  'visit.failed',
  'handover.recorded',
};

/// LIMS_HOMECOLLECTION_PUSH_MAX_MUTATIONS / _MAX_BYTES (TRD §6.3), REQ-SEC-080 per-mutation cap.
const maxMutationsPerBatch = 100;
const maxBatchBytes = 512 * 1024;
const maxPayloadBytes = 8 * 1024;
const maxAnchorsPerBatch = 20;

/// Retention of terminal rows after terminal_at [CONV] (invariant 4).
const terminalRetention = Duration(hours: 24);

/// Keys that must never appear in a payload (07-SECURITY: no patient name / phone / address / test name), at any depth.
const phiKeyDenylist = <String>{
  'full_name', 'patient_name', 'patient_full_name', 'patient_display_name', 'display_name', 'name', 'first_name', 'last_name',
  'phone', 'phone_e164', 'patient_phone_e164', 'phone_number', 'mobile', 'email',
  'address', 'address_text', 'address_line', 'landmark',
  'birth_on', 'birth_date', 'date_of_birth', 'dob',
  'note_for_phlebotomist', 'test_name', 'test_names', 'patient',
};

class SavedMutation {
  const SavedMutation({required this.clientMutationId, required this.deviceSeq});
  final String clientMutationId;
  final int deviceSeq;
}

class OutboxBatch {
  const OutboxBatch({required this.batchId, required this.bodyJson, required this.clientMutationIds});
  final String batchId;

  /// The serialized PushRequest, written once; sent byte for byte on every retry.
  final String bodyJson;

  /// Mutation ids in device_seq order.
  final List<String> clientMutationIds;
}

/// One entry of a PushResponse `results`. [outcome] is applied | duplicate | held | rejected.
class PushOutcome {
  const PushOutcome(this.clientMutationId, this.outcome, [this.code]);
  final String clientMutationId;
  final String outcome;
  final String? code;
}

const _terminalOutcomes = <String>{'applied', 'duplicate', 'held', 'rejected'};

Object? _canonical(Object? v) {
  if (v is Map) {
    final keys = <String>[
      for (final k in v.keys) k is String ? k : throw ArgumentError('payload keys must be strings'),
    ]..sort();
    return {for (final k in keys) k: _canonical(v[k])};
  }
  if (v is List) return [for (final e in v) _canonical(e)];
  if (v == null || v is String || v is num || v is bool) return v;
  throw ArgumentError('payload contains a non-JSON value');
}

String? _phiKeyIn(Object? v) {
  if (v is Map) {
    for (final e in v.entries) {
      final k = (e.key as String).toLowerCase();
      if (phiKeyDenylist.contains(k)) return e.key as String;
      final nested = _phiKeyIn(e.value);
      if (nested != null) return nested;
    }
  } else if (v is List) {
    for (final e in v) {
      final nested = _phiKeyIn(e);
      if (nested != null) return nested;
    }
  }
  return null;
}

String _j(Object? v) => jsonEncode(v);
int _bytes(String s) => utf8.encode(s).length;

class OutboxRepository {
  OutboxRepository({
    required this.db,
    required this.anchors,
    required this.clock,
    required this.bootId,
    required this.wallNow,
    required this.newId,
    required this.deviceId,
  });

  final OutboxDb db;
  final ClockAnchorStore anchors;
  final MonotonicClock clock;
  final BootIdSource bootId;
  final DateTime Function() wallNow;
  final String Function() newId;
  final String deviceId;

  OutboxLock get _lock => outboxLockFor(db);

  /// Stores one mutation. Completes only after COMMIT (the UI shows "Saved on phone" on completion); the row and the
  /// next_device_seq bump are one transaction (invariant 2). Throws, writing nothing, on any invalid input.
  Future<SavedMutation> enqueue({
    required String type,
    String? visitId,
    String? visitLabel,
    required Map<String, Object?> payload,
  }) {
    final String payloadJson;
    try {
      if (!mutationTypes.contains(type)) throw ArgumentError('unknown mutation type');
      if (type == 'handover.recorded') {
        if (visitId != null) throw ArgumentError('handover.recorded has no visit_id');
      } else if (visitId == null || visitId.isEmpty) {
        throw ArgumentError('visit_id is required for $type');
      }
      final phi = _phiKeyIn(payload);
      if (phi != null) throw ArgumentError('payload key "$phi" is not allowed (no PHI in the outbox)');
      payloadJson = jsonEncode(_canonical(payload));
      if (_bytes(payloadJson) > maxPayloadBytes) throw ArgumentError('payload exceeds $maxPayloadBytes bytes');
    } catch (e) {
      return Future.error(e);
    }
    final payloadSha = sha256OfUtf8(payloadJson);

    return _lock.run(() async {
      final mono = await freshMonotonicMs(clock);
      final id = newId();
      final wall = isoUtcMs(wallNow());
      return inTransaction(db, () async {
        final anchor = await anchors.latest();
        if (anchor == null) throw StateError('no clock anchor yet: cannot capture a mutation');
        final seqRows = await db.select("SELECT value FROM device_state WHERE key = 'next_device_seq'");
        final seq = int.parse(seqRows.single['value']! as String);
        await db.execute(
          'INSERT INTO mutation_log (client_mutation_id, device_seq, type, visit_id, visit_label, payload_json, payload_sha256, '
          "captured_wall_time, anchor_id, elapsed_since_anchor_ms, state) VALUES (?,?,?,?,?,?,?,?,?,?,'pending')",
          [id, seq, type, visitId, visitLabel, payloadJson, payloadSha, wall, anchor.anchorId, mono - anchor.monotonicMs],
        );
        await db.execute("UPDATE device_state SET value = ? WHERE key = 'next_device_seq'", ['${seq + 1}']);
        return SavedMutation(clientMutationId: id, deviceSeq: seq);
      });
    });
  }

  /// Forms the next batch: oldest pending rows (≤ 100, ≤ 512 KB), frozen into one `batches` row, rows → sending (invariant 3).
  /// Null when nothing is pending or an earlier batch has no response yet.
  Future<OutboxBatch?> formBatch() => _lock.run(() async {
        final inFlight = await db.select("SELECT 1 AS x FROM mutation_log WHERE state = 'sending' LIMIT 1");
        if (inFlight.isNotEmpty) return null;
        final pending = await db.select(
            "SELECT * FROM mutation_log WHERE state = 'pending' ORDER BY device_seq LIMIT $maxMutationsPerBatch");
        if (pending.isEmpty) return null;
        return _freeze(pending, pack: true);
      });

  /// The batch whose rows are 'sending' (retry path): the stored body, untouched.
  Future<OutboxBatch?> outstandingBatch() async {
    final rows = await db.select(
        "SELECT b.batch_id AS batch_id, b.body_json AS body_json FROM mutation_log m JOIN batches b ON b.batch_id = m.batch_id "
        "WHERE m.state = 'sending' ORDER BY m.device_seq LIMIT 1");
    if (rows.isEmpty) return null;
    final batchId = rows.single['batch_id']! as String;
    return OutboxBatch(
        batchId: batchId, bodyJson: rows.single['body_json']! as String, clientMutationIds: await _idsOf(batchId));
  }

  Future<List<String>> _idsOf(String batchId) async => [
        for (final r in await db.select('SELECT client_mutation_id FROM mutation_log WHERE batch_id = ? ORDER BY device_seq', [batchId]))
          r['client_mutation_id']! as String,
      ];

  /// A send attempt of [batchId] is starting: attempts += 1, last_attempt_at = now (state stays 'sending').
  Future<void> recordAttempt(String batchId) => _lock.run(() => db.execute(
        "UPDATE mutation_log SET attempts = attempts + 1, last_attempt_at = ? WHERE batch_id = ? AND state = 'sending'",
        [isoUtcMs(wallNow()), batchId],
      ));

  /// Applies a PushResponse. Unknown batch → no change. Only 'sending' rows of that batch move; the `batches` row is
  /// deleted once none of its rows is still 'sending'.
  Future<void> applyResponse(String batchId, List<PushOutcome> results) {
    for (final r in results) {
      if (!_terminalOutcomes.contains(r.outcome)) return Future.error(ArgumentError('unknown outcome ${r.outcome}'));
    }
    return _lock.run(() async {
      final exists = await db.select('SELECT 1 AS x FROM batches WHERE batch_id = ?', [batchId]);
      if (exists.isEmpty) return;
      final now = isoUtcMs(wallNow());
      await inTransaction(db, () async {
        for (final r in results) {
          await db.execute(
            'UPDATE mutation_log SET state = ?, outcome_code = ?, terminal_at = ? '
            "WHERE client_mutation_id = ? AND batch_id = ? AND state = 'sending'",
            [r.outcome, r.code, now, r.clientMutationId, batchId],
          );
        }
        final left = await db.select("SELECT 1 AS x FROM mutation_log WHERE batch_id = ? AND state = 'sending' LIMIT 1", [batchId]);
        if (left.isEmpty) {
          // Terminal rows keep no pointer to a deleted batch (FK mutation_log.batch_id → batches).
          await db.execute('UPDATE mutation_log SET batch_id = NULL WHERE batch_id = ?', [batchId]);
          await db.execute('DELETE FROM batches WHERE batch_id = ?', [batchId]);
        }
      });
    });
  }

  /// 422 common.idempotency_key_reused: delete the batches row, give the same rows a new batch_id and a new frozen body.
  Future<OutboxBatch> reformAfterKeyReused(String batchId) => _lock.run(() async {
        final rows = await db.select("SELECT * FROM mutation_log WHERE batch_id = ? AND state = 'sending' ORDER BY device_seq", [batchId]);
        if (rows.isEmpty) throw StateError('no sending rows for batch $batchId');
        return (await _freeze(rows, pack: false, replacing: batchId))!;
      });

  /// Builds the PushRequest for [rows], writes it once, and points the rows at it (one transaction).
  Future<OutboxBatch?> _freeze(List<Map<String, Object?>> rows, {required bool pack, String? replacing}) async {
    final boot = await bootId.read();
    final mono = await freshMonotonicMs(clock);
    if (!validBootId(boot)) throw StateError('boot id must be 1..64 chars');
    if (mono < 0) throw StateError('monotonic clock out of range');
    final wall = isoUtcMs(wallNow());
    final newBatchId = newId();

    final anchorById = <String, Map<String, Object?>>{};
    for (final r in await db.select('SELECT * FROM clock_anchors')) {
      anchorById[r['anchor_id']! as String] = r;
    }

    final head = '{"device_id":${_j(deviceId)},"batch_id":${_j(newBatchId)},"sent_at_device":${_j(wall)},"anchors":[';
    final mid = '],"now":${_j({'device_wall_time': wall, 'monotonic_ms': mono, 'boot_id': boot})},"mutations":[';
    const tail = ']}';
    var size = _bytes(head) + _bytes(mid) + tail.length;

    final used = <String>[]; // anchor ids in first-use order
    final anchorJson = <String>[];
    final mutJson = <String>[];
    final ids = <String>[];
    for (final r in rows) {
      final aid = r['anchor_id']! as String;
      final isNew = !used.contains(aid);
      final a = anchorById[aid] ?? (throw StateError('anchor $aid missing'));
      final aj = isNew ? _j(ClockAnchor.fromRow(a).toWire()) : '';
      final visit = r['visit_id'] as String?;
      final mj = '{"client_mutation_id":${_j(r['client_mutation_id'])},"device_seq":${r['device_seq']},"type":${_j(r['type'])},'
          '${visit == null ? '' : '"visit_id":${_j(visit)},'}'
          '"captured":{"device_wall_time":${_j(r['captured_wall_time'])},"anchor_id":${_j(aid)},'
          '"elapsed_since_anchor_ms":${r['elapsed_since_anchor_ms']}},"payload":${r['payload_json']}}';
      final add = _bytes(mj) + (mutJson.isEmpty ? 0 : 1) + (isNew ? _bytes(aj) + (used.isEmpty ? 0 : 1) : 0);
      if (pack && ids.isNotEmpty && (size + add > maxBatchBytes || (isNew && used.length >= maxAnchorsPerBatch))) break;
      size += add;
      if (isNew) {
        used.add(aid);
        anchorJson.add(aj);
      }
      mutJson.add(mj);
      ids.add(r['client_mutation_id']! as String);
    }
    final body = '$head${anchorJson.join(',')}$mid${mutJson.join(',')}$tail';
    if (_bytes(body) > maxBatchBytes) throw StateError('batch exceeds $maxBatchBytes bytes');

    await inTransaction(db, () async {
      await db.execute('INSERT INTO batches (batch_id, body_json, created_at) VALUES (?,?,?)', [newBatchId, body, wall]);
      final marks = List.filled(ids.length, '?').join(',');
      await db.execute(
          "UPDATE mutation_log SET state = 'sending', batch_id = ? WHERE client_mutation_id IN ($marks)", [newBatchId, ...ids]);
      if (replacing != null) {
        // Rows of the old batch that already got an answer must not keep pointing at the deleted row (FK).
        await db.execute('UPDATE mutation_log SET batch_id = NULL WHERE batch_id = ?', [replacing]);
        await db.execute('DELETE FROM batches WHERE batch_id = ?', [replacing]);
      }
    });
    return OutboxBatch(batchId: newBatchId, bodyJson: body, clientMutationIds: ids);
  }

  /// Invariant 4: terminal rows 24 h after terminal_at; anchors that no row references and that are older than the newest.
  Future<void> purge() => _lock.run(() async {
        final cutoff = isoUtcMs(wallNow().subtract(terminalRetention));
        await inTransaction(db, () async {
          await db.execute(
              "DELETE FROM mutation_log WHERE state IN ('applied','duplicate','held','rejected') AND terminal_at IS NOT NULL AND terminal_at <= ?",
              [cutoff]);
          await db.execute(
              'DELETE FROM clock_anchors WHERE anchor_id NOT IN (SELECT anchor_id FROM mutation_log) '
              'AND rowid < (SELECT max(rowid) FROM clock_anchors)');
        });
      });

  /// Invariant 5, local half: nothing pending or sending.
  Future<bool> canLogout() async {
    final r = await db.select("SELECT count(*) AS n FROM mutation_log WHERE state IN ('pending','sending')");
    return r.single['n'] == 0;
  }

  /// client_mutation_ids whose payload_json no longer matches the payload_sha256 stored at capture.
  Future<List<String>> integrityViolations() async {
    final out = <String>[];
    for (final r in await db.select('SELECT client_mutation_id, payload_json, payload_sha256 FROM mutation_log ORDER BY device_seq')) {
      if (sha256OfUtf8(r['payload_json']! as String) != r['payload_sha256']) out.add(r['client_mutation_id']! as String);
    }
    return out;
  }
}
