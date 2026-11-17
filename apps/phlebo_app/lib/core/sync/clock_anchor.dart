// HC-T24: clock anchors (TRD §7.5, 05-SCHEMA B.2 clock_anchors). One is stored after EVERY successful API response.
// Anchors are facts: inserted once, never updated.
import '../../features/outbox/data/outbox_lock.dart';
import '../../features/outbox/data/time_format.dart';
import '../db/outbox_db.dart';
import '../platform/boot_id.dart';
import '../platform/monotonic_clock.dart';

class ClockAnchor {
  const ClockAnchor({
    required this.anchorId,
    required this.serverTime,
    required this.deviceWallTime,
    required this.monotonicMs,
    required this.bootId,
    required this.createdSeq,
  });

  factory ClockAnchor.fromRow(Map<String, Object?> r) => ClockAnchor(
        anchorId: r['anchor_id']! as String,
        serverTime: r['server_time']! as String,
        deviceWallTime: r['device_wall_time']! as String,
        monotonicMs: r['monotonic_ms']! as int,
        bootId: r['boot_id']! as String,
        createdSeq: r['created_seq']! as int,
      );

  final String anchorId;
  final String serverTime;
  final String deviceWallTime;
  final int monotonicMs;
  final String bootId;
  final int createdSeq;

  /// The `Anchor` object of the PushRequest (TRD §6.3). created_seq is local only.
  Map<String, Object?> toWire() => {
        'anchor_id': anchorId,
        'server_time': serverTime,
        'device_wall_time': deviceWallTime,
        'monotonic_ms': monotonicMs,
        'boot_id': bootId,
      };
}

class ClockAnchorStore {
  ClockAnchorStore({
    required this.db,
    required this.clock,
    required this.bootId,
    required this.wallNow,
    required this.newId,
  });

  final OutboxDb db;
  final MonotonicClock clock;
  final BootIdSource bootId;
  final DateTime Function() wallNow;
  final String Function() newId;

  /// Stores an anchor for a successful response whose body carried [serverTime] (IsoUtc, kept verbatim).
  /// Throws, storing nothing, when [serverTime], the boot id or the monotonic reading is invalid.
  Future<ClockAnchor> record({required String serverTime}) {
    if (!isIsoUtc(serverTime)) return Future.error(ArgumentError('server_time is not IsoUtc'));
    return outboxLockFor(db).run(() async {
      final mono = await freshMonotonicMs(clock);
      final boot = await bootId.read();
      if (mono < 0) throw StateError('monotonic clock out of range');
      if (!validBootId(boot)) throw StateError('boot id must be 1..64 chars');
      final wall = isoUtcMs(wallNow());
      final id = newId();
      return inTransaction(db, () async {
        final seq = await db.select("SELECT value FROM device_state WHERE key = 'next_device_seq'");
        final createdSeq = int.parse(seq.single['value']! as String) - 1; // last assigned device_seq
        await db.execute(
          'INSERT INTO clock_anchors (anchor_id, server_time, device_wall_time, monotonic_ms, boot_id, created_seq) VALUES (?,?,?,?,?,?)',
          [id, serverTime, wall, mono, boot, createdSeq],
        );
        return ClockAnchor(
            anchorId: id, serverTime: serverTime, deviceWallTime: wall, monotonicMs: mono, bootId: boot, createdSeq: createdSeq);
      });
    });
  }

  /// The most recently recorded anchor (rowid order, so two anchors from the same instant resolve to the later insert).
  Future<ClockAnchor?> latest() async {
    final rows = await db.select('SELECT * FROM clock_anchors ORDER BY rowid DESC LIMIT 1');
    return rows.isEmpty ? null : ClockAnchor.fromRow(rows.single);
  }
}
