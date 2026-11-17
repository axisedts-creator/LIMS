// HC-T24 test support: real SQLCipher outbox.db + controllable clocks / ids. Synthetic data only.
//
// ASSUMED API used here (the writer must provide it; each test file repeats the part it uses):
//   core/platform/monotonic_clock.dart : abstract interface class MonotonicClock { int nowMs(); }          // elapsedRealtime-style ms
//   core/platform/boot_id.dart         : abstract interface class BootIdSource  { Future<String> read(); }  // 1..64 chars
//   core/sync/clock_anchor.dart        : class ClockAnchorStore(db:, clock:, bootId:, wallNow:, newId:)
//   features/outbox/data/outbox_schema.dart     : class OutboxSchema { static Future<void> ensure(OutboxDb db); }  // idempotent 05-SCHEMA B.2 DDL
//   features/outbox/data/outbox_repository.dart: class OutboxRepository(db:, anchors:, clock:, bootId:, wallNow:, newId:, deviceId:)
import 'dart:io';

import 'package:lims_shared/lims_shared.dart';
import 'package:phlebo_app/core/db/keys.dart';
import 'package:phlebo_app/core/db/outbox_db.dart';
import 'package:phlebo_app/core/platform/boot_id.dart';
import 'package:phlebo_app/core/platform/monotonic_clock.dart';
import 'package:phlebo_app/core/sync/clock_anchor.dart';
import 'package:phlebo_app/features/outbox/data/outbox_repository.dart';
import 'package:phlebo_app/features/outbox/data/outbox_schema.dart';

import 'db_fixture.dart';

class FakeMonotonicClock implements MonotonicClock {
  FakeMonotonicClock(this.ms);
  int ms;
  @override
  int nowMs() => ms;
}

class FakeBootId implements BootIdSource {
  FakeBootId(this.id);
  String id;
  @override
  Future<String> read() async => id;
}

/// Mutable wall clock (the user can move it — it must never drive elapsed_since_anchor_ms).
class FakeWall {
  FakeWall(this.now);
  DateTime now;
  DateTime call() => now;
}

const deviceId = '01a1a98a-ac40-7000-8000-0000001b0001';
const visitA = '01a1a98a-ac40-7000-8000-000000130001';
const visitB = '01a1a98a-ac40-7000-8000-000000130002';
const specimen1 = '01a1a98a-ac40-7000-8000-000000090011';
const specimen2 = '01a1a98a-ac40-7000-8000-000000090012';

final RegExp isoUtcMs = RegExp(r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$');

class OutboxFx {
  OutboxFx._(this.dir, this.store, this.keys, this.db, this.mono, this.boot, this.wall, this.newId);

  final Directory dir;
  final FakeKeyStore store;
  final DbKeys keys;
  OutboxDb db;
  final FakeMonotonicClock mono;
  final FakeBootId boot;
  final FakeWall wall;
  final String Function() newId;
  late ClockAnchorStore anchors;
  late OutboxRepository repo;

  /// Fresh outbox: wall 2026-11-06T00:30:00Z, monotonic 86 400 123 ms, boot id b-0000000017 (the TRD §6.3 example values).
  static Future<OutboxFx> create({bool withAnchor = true}) async {
    final dir = newTempDir();
    final store = FakeKeyStore();
    final keys = DbKeys(store);
    final fx = OutboxFx._(
      dir,
      store,
      keys,
      await OutboxDb.open(dir: dir, keys: keys),
      FakeMonotonicClock(86400123),
      FakeBootId('b-0000000017'),
      FakeWall(DateTime.utc(2026, 11, 6, 0, 30, 0)),
      createSeededUuidv7(seed: 24, startMs: DateTime.utc(2026, 11, 6).millisecondsSinceEpoch),
    );
    await OutboxSchema.ensure(fx.db);
    fx._wire();
    if (withAnchor) await fx.anchor();
    return fx;
  }

  void _wire() {
    anchors = ClockAnchorStore(db: db, clock: mono, bootId: boot, wallNow: wall.call, newId: newId);
    repo = OutboxRepository(
        db: db, anchors: anchors, clock: mono, bootId: boot, wallNow: wall.call, newId: newId, deviceId: deviceId);
  }

  /// A successful API response arrived: store a clock anchor (server_time = body.server_time).
  Future<ClockAnchor> anchor({String serverTime = '2026-11-06T00:30:00.000Z'}) => anchors.record(serverTime: serverTime);

  /// Advance monotonic and wall time together by [d] (the normal case).
  void tick(Duration d) {
    mono.ms += d.inMilliseconds;
    wall.now = wall.now.add(d);
  }

  /// Force-close + reopen the same outbox.db with the same key (the app was killed and restarted).
  Future<void> restart() async {
    await db.close();
    db = await OutboxDb.open(dir: dir, keys: keys);
    await OutboxSchema.ensure(db);
    _wire();
  }

  /// A second connection to the same file WITHOUT closing the first — sees only committed data (kill-app view).
  Future<OutboxDb> otherConnection() => OutboxDb.open(dir: dir, keys: keys);

  Future<List<Map<String, Object?>>> rows(String sql, [List<Object?> args = const []]) => db.select(sql, args);

  Future<void> dispose() async {
    try {
      await db.close();
    } catch (_) {}
    deleteQuietly(dir);
  }
}

/// A realistic PHI-free payload per mutation type (TRD §6.3 table).
Map<String, Object?> payloadFor(String type, {String barcode = 'E2600000042', String specimenId = specimen1}) {
  const gpsOff = {'status': 'off'};
  switch (type) {
    case 'visit.arrived':
      return {'gps': gpsOff};
    case 'visit.identity_checked':
      return {'name_check': 'matches', 'second_identifier': 'phone', 'second_check': 'matches'};
    case 'visit.consent_recorded':
      return {'consent_text_version': 'hc-consent-v1', 'given': true};
    case 'specimen.collected':
      return {
        'specimen_id': specimenId,
        'scanned_barcode': barcode,
        'scan_method': 'camera',
        'specimen_type_code': 'EDTA_WB',
        'gps': gpsOff,
      };
    case 'specimen.not_collected':
      return {'specimen_id': specimenId, 'reason_code': 'unable_to_draw'};
    case 'payment.captured':
      return {
        'order_id': '01a1a98a-ac40-7000-8000-000000050002',
        'payment_method_code': 'cash',
        'amount': {'amount_paisa': 180000, 'currency': 'NPR'},
      };
    case 'visit.completed':
      return {'outcome': 'collected'};
    case 'visit.failed':
      return {'reason_code': 'patient_not_home', 'gps': gpsOff};
    case 'handover.recorded':
      return {
        'handover_id': '01a1a98a-ac40-7000-8000-0000001e0001',
        'to_centre_id': '01a1a98a-ac40-7000-8000-000000020002',
        'specimen_ids': [specimen1, specimen2],
      };
  }
  throw ArgumentError(type);
}

/// Enqueue one mutation of [type] with a realistic payload; handover has no visit id.
Future<SavedMutation> enqueueType(OutboxFx fx, String type, {String visit = visitA, Map<String, Object?>? payload}) =>
    fx.repo.enqueue(
      type: type,
      visitId: type == 'handover.recorded' ? null : visit,
      visitLabel: '#3 · 07:15–07:45',
      payload: payload ?? payloadFor(type),
    );

const allTypes = [
  'visit.arrived',
  'visit.identity_checked',
  'visit.consent_recorded',
  'specimen.collected',
  'specimen.not_collected',
  'payment.captured',
  'visit.completed',
  'visit.failed',
  'handover.recorded',
];
