// HC-T25: sync engine — one cycle = push all pending (batches <= 100) -> pull snapshot -> ack (TRD §6.1 S-4/S-5, §6.2-6.4, §7.2).
// - Push retries send OutboxBatch.bodyJson as stored (05-SCHEMA B.2 invariant 3); the frozen body is never edited or re-formed
//   except after 422 common.idempotency_key_reused (OutboxRepository.reformAfterKeyReused).
// - Every call goes through the pinned ApiClient (REQ-SEC-104); the session is checked before EVERY call (S-4, no token grace).
// - Snapshot replace is one cache.db transaction (05-SCHEMA B.1): BEGIN IMMEDIATE, DELETE every table, insert, COMMIT; ROLLBACK on error.
// - No timers and no sleeping: the caller waits SyncCycleResult.retryAfter (5 s, 15 s, 45 s, 2 min, 5 min cap [CONV]; reset on success).
// - No logging anywhere: bodies and tokens carry barcodes, amounts and bearer credentials (P2). Time comes from [wallNow] only (§7.5).
import 'dart:convert';

import 'package:lims_shared/lims_shared.dart';

import '../../features/outbox/data/outbox_lock.dart';
import '../../features/outbox/data/outbox_repository.dart';
import '../../features/outbox/data/time_format.dart';
import '../db/cache_db.dart';
import '../db/outbox_db.dart';
import '../net/api_factory.dart';
import 'clock_anchor.dart';
import 'purge_triggers.dart';

/// Token handling owned by the auth layer (TRD §7.4).
abstract interface class SyncSession {
  /// Refresh when the access JWT expires in < 60 s. Throws LimsException(auth.session_expired) if refused.
  Future<void> ensureFresh();

  /// Called after 401 auth.token_expired. Throws LimsException(auth.session_expired) if refused.
  Future<void> refreshNow();
}

/// [purged]: cycle-start stale purge (US-13-3), nothing was sent; build a new engine over a new cache.db.
/// [wiped]: the server's wipe command was carried out after the outbox drained (US-13-5).
enum SyncStatus { ok, retryLater, sessionExpired, tlsFailure, blocked, busy, purged, wiped }

class SyncCycleResult {
  const SyncCycleResult({
    required this.status,
    this.retryAfter,
    this.code,
    this.batchesPushed = 0,
    this.pulled = false,
    this.acked = false,
  });

  final SyncStatus status;

  /// Set only for [SyncStatus.retryLater].
  final Duration? retryAfter;

  /// Error code of a [SyncStatus.blocked] / [SyncStatus.retryLater] outcome when the server named one.
  final String? code;
  final int batchesPushed;
  final bool pulled;
  final bool acked;
}

const _backoffLadder = <Duration>[
  Duration(seconds: 5),
  Duration(seconds: 15),
  Duration(seconds: 45),
  Duration(minutes: 2),
  Duration(minutes: 5),
];

const _maxReformsPerCycle = 2;

/// B.1 replace: child tables first (foreign keys are ON).
const _deleteAll = <String>[
  'DELETE FROM visit_specimens',
  'DELETE FROM visits',
  'DELETE FROM routes',
  'DELETE FROM reasons',
  'DELETE FROM payment_methods',
  'DELETE FROM handover_centres',
  'DELETE FROM meta',
];

const _cacheSchemaVersion = '1';

Map<String, Object?> _map(Object? v) => (v as Map).cast<String, Object?>();
List<Object?> _list(Object? v) => v == null ? const [] : (v as List).cast<Object?>(); // stubs carry no specimens
int _flag(Object? v) => v == true ? 1 : 0;

class SyncEngine {
  SyncEngine({
    required this.api,
    required this.deviceId,
    required this.outbox,
    required this.outboxDb,
    required this.cache,
    required this.anchors,
    required this.session,
    required this.wallNow,
    this.purge,
    this.onWiped,
  });

  /// HC-T28: the only way the engine reaches the stores for destruction. Null = no purge/wipe behaviour (HC-T25 callers).
  final PurgeTriggers? purge;

  /// Sign-out after a wipe (US-13-5), called after the wipe ack was attempted.
  final Future<void> Function()? onWiped;

  final ApiClient api;
  final String deviceId;
  final OutboxRepository outbox;
  final OutboxDb outboxDb;
  final CacheDb cache;
  final ClockAnchorStore anchors;
  final SyncSession session;
  final DateTime Function() wallNow;

  bool _busy = false;
  int _failures = 0;

  /// ONE cycle. A second call while one runs returns [SyncStatus.busy] and sends nothing (TRD §7.2 mutex).
  Future<SyncCycleResult> syncNow() async {
    if (_busy) return const SyncCycleResult(status: SyncStatus.busy);
    _busy = true;
    try {
      return await _cycle();
    } finally {
      _busy = false;
    }
  }

  Future<SyncCycleResult> _cycle() async {
    var pushed = 0;
    var pulled = false;
    var acked = false;

    SyncCycleResult result(SyncStatus s, {Duration? after, String? code}) => SyncCycleResult(
        status: s, retryAfter: after, code: code, batchesPushed: pushed, pulled: pulled, acked: acked);
    SyncCycleResult retry([String? code]) => result(SyncStatus.retryLater, after: _nextBackoff(), code: code);

    try {
      // ---- US-13-3: offline hours / local date change destroy cache.db before anything is sent (outbox stays)
      if (await purge?.purgeIfStale() != null) return result(SyncStatus.purged);

      // ---- push: oldest outstanding (sending) batch first, then newly formed batches, one in flight at a time
      var reforms = 0;
      while (true) {
        final batch = await outbox.outstandingBatch() ?? await outbox.formBatch();
        if (batch == null) break;
        await outbox.recordAttempt(batch.batchId);
        final Map<String, Object?> res;
        try {
          // The stored body is decoded and handed to ApiClient, which writes it out again; the stored text came from
          // jsonEncode, so the bytes on the wire are the stored bytes (key order and integers survive the round trip).
          final body = _map(jsonDecode(batch.bodyJson));
          res = await _authed(() => api.postJson('/sync/mutations', body, idempotencyKey: batch.batchId));
        } on LimsException catch (e) {
          if (e.code == LimsErrorCodes.commonIdempotencyKeyReused && reforms < _maxReformsPerCycle) {
            reforms++;
            await outbox.reformAfterKeyReused(batch.batchId); // new batch_id, new frozen body; same rows, same order
            continue;
          }
          rethrow;
        }
        try {
          final outcomes = [
            for (final r in _list(res['results']).map(_map))
              PushOutcome(r['client_mutation_id']! as String, r['outcome']! as String, r['code'] as String?),
          ];
          await outbox.applyResponse(batch.batchId, outcomes);
        } on TypeError {
          throw LimsException(LimsErrorCodes.commonInternal);
        } on ArgumentError {
          throw LimsException(LimsErrorCodes.commonInternal);
        }
        // An answer that left rows of this batch unanswered must not make the loop spin.
        if ((await outbox.outstandingBatch())?.batchId == batch.batchId) throw LimsException(LimsErrorCodes.commonInternal);
        await _anchor(res);
        await _setState('last_successful_push_at');
        pushed++;
      }

      // ---- pull
      final cursorRows = await cache.select("SELECT value FROM meta WHERE key = 'snapshot_cursor'");
      final storedCursor = cursorRows.isEmpty ? null : cursorRows.single['value']! as String;
      final snap = await _authed(() => api.getJson('/sync/snapshot', query: {
            'device_id': deviceId,
            if (storedCursor != null) 'cursor': storedCursor,
          }));
      await _anchor(snap);

      // ---- US-13-5: wipe command (full or unchanged pull) is carried out only when nothing is pending/sending
      final wipeCursor = snap['cursor'];
      if (purge != null && snap['device_command'] == 'wipe' && wipeCursor is String && await _drained()) {
        pulled = true;
        return await _wipe(wipeCursor, () => acked = true, result);
      }

      final String ackCursor;
      try {
        ackCursor = snap['cursor']! as String;
        if (snap['unchanged'] == true) {
          await _applyUnchanged(snap);
        } else {
          await _replace(snap);
        }
      } catch (_) {
        // Malformed or constraint-breaking snapshot: the transaction was rolled back, the old cache and cursor stay.
        return retry(LimsErrorCodes.commonInternal);
      }
      pulled = true;
      await _setState('last_successful_pull_at');

      // ---- ack (only after the cache really holds this cursor)
      final seq = await outboxDb.select(
          "SELECT max(device_seq) AS m FROM mutation_log WHERE state IN ('applied','duplicate','held','rejected')");
      await _authed(() => api.postJson('/sync/ack', {
            'device_id': deviceId,
            'cursor': ackCursor,
            'applied_at_device': isoUtcMs(wallNow()),
            'max_device_seq_acked': (seq.single['m'] as int?) ?? 0,
          }));
      acked = true;
      await _setState('last_ack_cursor', value: ackCursor);

      _failures = 0;
      return result(SyncStatus.ok);
    } on ApiTransportException catch (e) {
      return e.isTlsFailure ? result(SyncStatus.tlsFailure) : retry();
    } on LimsException catch (e) {
      final code = e.code;
      if (code == LimsErrorCodes.authSessionExpired || code == LimsErrorCodes.authTokenExpired) {
        await purge?.purgeOnSessionEnd(); // US-13-4: cache destroyed at once; outbox + pending rows stay for the next login
        return result(SyncStatus.sessionExpired, code: code);
      }
      final http = limsErrorHttpStatus[code] ?? 500;
      if (http >= 500 || http == 429 || code == LimsErrorCodes.commonIdempotencyInProgress) return retry(code);
      return result(SyncStatus.blocked, code: code); // 426 app_version_unsupported, 409 device_not_registered, 4xx
    }
  }

  /// Nothing left to upload: no pending and no sending rows (held/duplicate/rejected rows are answered, so they do not block).
  Future<bool> _drained() async {
    final r = await outboxDb.select("SELECT count(*) AS n FROM mutation_log WHERE state IN ('pending','sending')");
    return (r.single['n']! as int) == 0;
  }

  /// Destroy both DBs (cache first), then tell the server (wipe_completed) and sign out. The wipe never depends on the network:
  /// a failed ack is not retried here because outbox.db (and its device_state) no longer exist [CONV: spec silent].
  Future<SyncCycleResult> _wipe(
    String cursor,
    void Function() markAcked,
    SyncCycleResult Function(SyncStatus s, {Duration? after, String? code}) result,
  ) async {
    final seq = await outboxDb.select(
        "SELECT max(device_seq) AS m FROM mutation_log WHERE state IN ('applied','duplicate','held','rejected')"); // read before destruction
    await purge!.wipeAll();
    try {
      await _authed(() => api.postJson('/sync/ack', {
            'device_id': deviceId,
            'cursor': cursor,
            'applied_at_device': isoUtcMs(wallNow()),
            'max_device_seq_acked': (seq.single['m'] as int?) ?? 0,
            'wipe_completed': true,
          }));
      markAcked();
    } on ApiTransportException {
      // device is already wiped; sign-out below
    } on LimsException {
      // same
    }
    await onWiped?.call();
    return result(SyncStatus.wiped);
  }

  Duration _nextBackoff() {
    final d = _backoffLadder[_failures < _backoffLadder.length ? _failures : _backoffLadder.length - 1];
    _failures++;
    return d;
  }

  /// S-4: session check before the call; on 401 auth.token_expired refresh and send the SAME request once more.
  Future<Map<String, Object?>> _authed(Future<Map<String, Object?>> Function() send) async {
    await session.ensureFresh();
    try {
      return await send();
    } on LimsException catch (e) {
      if (e.code != LimsErrorCodes.authTokenExpired) rethrow;
    }
    await session.refreshNow();
    return send();
  }

  /// TRD §7.5: one anchor per successful answer that carries a server_time.
  Future<void> _anchor(Map<String, Object?> res) async {
    final t = res['server_time'];
    if (t is String && isIsoUtc(t)) await anchors.record(serverTime: t);
  }

  Future<void> _setState(String key, {String? value}) => outboxLockFor(outboxDb).run(() => outboxDb.execute(
        'INSERT INTO device_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [key, value ?? isoUtcMs(wallNow())],
      ));

  /// US-06-2: only visits.balance_* and meta.server_time_at_pull change.
  Future<void> _applyUnchanged(Map<String, Object?> s) => _inCacheTx(() async {
        for (final b in _list(s['balances']).map(_map)) {
          final due = _map(b['balance_due']);
          await cache.execute(
            'UPDATE visits SET balance_due_paisa = ?, balance_as_of = ?, balance_unavailable = 0 WHERE visit_id = ?',
            [due['amount_paisa'], b['as_of'], b['visit_id']],
          );
        }
        await _putMeta('server_time_at_pull', s['server_time']! as String);
      });

  /// 05-SCHEMA B.1 replace algorithm.
  Future<void> _replace(Map<String, Object?> s) => _inCacheTx(() async {
        for (final d in _deleteAll) {
          await cache.execute(d);
        }
        final config = _map(s['config']);
        await _putMeta('snapshot_cursor', s['cursor']! as String);
        await _putMeta('route_date', s['route_date']! as String);
        await _putMeta('server_time_at_pull', s['server_time']! as String);
        await _putMeta('pulled_at_device', isoUtcMs(wallNow()));
        await _putMeta('config_json', jsonEncode(config));
        await _putMeta('schema_version', _cacheSchemaVersion);

        for (final r in _list(s['routes']).map(_map)) {
          await cache.execute('INSERT INTO routes (route_id, centre_id, version) VALUES (?,?,?)', [r['route_id'], r['centre_id'], r['version']]);
        }
        for (final v in _list(s['visits']).map(_map)) {
          final patient = v['patient'] == null ? null : _map(v['patient']);
          final address = v['address'] == null ? null : _map(v['address']);
          final balance = v['balance'] == null ? null : _map(v['balance']);
          await cache.execute(
            'INSERT INTO visits (visit_id, version, route_id, route_sequence, status, kind, window_start, window_end, order_id, '
            'patient_full_name, patient_phone_e164, patient_birth_on, patient_unavailable, address_text, landmark, latitude, longitude, '
            'note_for_phlebotomist, balance_due_paisa, balance_as_of, balance_unavailable, specimens_stale) '
            'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [
              v['visit_id'], v['version'], v['route_id'], v['route_sequence'], v['status'], v['kind'],
              v['window_start'], v['window_end'], v['order_id'],
              patient?['full_name'], patient?['phone_e164'], patient?['birth_on'], _flag(v['patient_unavailable']),
              address?['address_text'], address?['landmark'], address?['latitude']?.toString(), address?['longitude']?.toString(),
              v['note_for_phlebotomist'],
              balance == null ? null : _map(balance['balance_due'])['amount_paisa'], balance?['as_of'], _flag(v['balance_unavailable']),
              _flag(v['specimens_stale']),
            ],
          );
          for (final sp in _list(v['specimens']).map(_map)) {
            await cache.execute(
              'INSERT INTO visit_specimens (specimen_id, visit_id, barcode, specimen_type_code, container_code, status) VALUES (?,?,?,?,?,?)',
              [sp['specimen_id'], v['visit_id'], sp['barcode'], sp['specimen_type_code'], sp['container_code'], sp['status']],
            );
          }
        }
        for (final p in _list(config['payment_methods']).map(_map)) {
          await cache.execute('INSERT INTO payment_methods (code, display, requires_reference) VALUES (?,?,?)',
              [p['code'], p['display'], _flag(p['requires_reference'])]);
        }
        for (final set in _map(config['reasons']).entries) {
          for (final r in _list(set.value).map(_map)) {
            await cache.execute('INSERT INTO reasons (set_code, code, display, requires_text) VALUES (?,?,?,?)',
                [set.key, r['code'], r['display'], _flag(r['requires_text'])]);
          }
        }
        for (final c in _list(config['handover_centres']).map(_map)) {
          await cache.execute('INSERT INTO handover_centres (centre_id, name) VALUES (?,?)', [c['centre_id'], c['name']]);
        }
      });

  Future<void> _putMeta(String key, String value) => cache.execute(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);

  Future<void> _inCacheTx(Future<void> Function() body) async {
    await cache.execute('BEGIN IMMEDIATE');
    try {
      await body();
      await cache.execute('COMMIT');
    } catch (_) {
      try {
        await cache.execute('ROLLBACK');
      } catch (_) {}
      rethrow;
    }
  }
}
