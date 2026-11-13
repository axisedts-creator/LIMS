// HC-T24 — TRD §7.5 "Clock handling", 05-SCHEMA B.2 clock_anchors, US-07-1 (anchor id + monotonic elapsed ms on every mutation).
// Monotonic + boot-id channels are injected (MonotonicClock / BootIdSource); the real platform channels cannot run on the host
// (their source is guarded in outbox_ci_guards_test.dart). Real SQLCipher outbox.db. Synthetic data only.
//
// ASSUMED API (package:phlebo_app/core/sync/clock_anchor.dart):
//   class ClockAnchor { String anchorId, serverTime, deviceWallTime; int monotonicMs; String bootId; int createdSeq; }
//   class ClockAnchorStore {
//     ClockAnchorStore({required OutboxDb db, required MonotonicClock clock, required BootIdSource bootId,
//                       required DateTime Function() wallNow, required String Function() newId});
//     Future<ClockAnchor> record({required String serverTime});  // after EVERY successful API response; serverTime = body.server_time (IsoUtc, stored verbatim)
//                                                                //   throws (nothing stored) if serverTime is not IsoUtc "YYYY-MM-DDTHH:MM:SS(.fff)Z"
//     Future<ClockAnchor?> latest();                             // most recently recorded anchor (ties → the later insert), null when none
//   }
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';

import 'support/outbox_fixture.dart';

void main() {
  late OutboxFx fx;
  setUp(() async => fx = await OutboxFx.create(withAnchor: false));
  tearDown(() async => fx.dispose());

  test('record(): stores server_time verbatim, wall time, monotonic ms and boot id from the channels, UUIDv7 id', () async {
    final a = await fx.anchors.record(serverTime: '2026-11-06T00:30:00.000Z');
    expect(isUuidv7(a.anchorId), isTrue);
    expect(a.serverTime, '2026-11-06T00:30:00.000Z');
    expect(a.deviceWallTime, '2026-11-06T00:30:00.000Z');
    expect(a.monotonicMs, 86400123);
    expect(a.bootId, 'b-0000000017');
    final row = (await fx.rows('SELECT * FROM clock_anchors')).single;
    expect(row['anchor_id'], a.anchorId);
    expect(row['server_time'], '2026-11-06T00:30:00.000Z');
    expect(row['device_wall_time'], '2026-11-06T00:30:00.000Z');
    expect(row['monotonic_ms'], 86400123);
    expect(row['boot_id'], 'b-0000000017');
    expect(row['created_seq'], isA<int>());
  });

  test('server time and device wall time are independent: a phone clock that is 3 h off is recorded as is', () async {
    fx.wall.now = DateTime.utc(2026, 11, 6, 3, 29, 41);
    final a = await fx.anchors.record(serverTime: '2026-11-06T00:30:00.000Z');
    expect(a.serverTime, '2026-11-06T00:30:00.000Z');
    expect(a.deviceWallTime, '2026-11-06T03:29:41.000Z');
  });

  test('created_seq tracks device_seq at creation (never behind the last assigned seq, at most next_device_seq)', () async {
    await fx.anchor();
    await enqueueType(fx, 'visit.arrived');
    await enqueueType(fx, 'visit.identity_checked');
    await enqueueType(fx, 'visit.consent_recorded');
    final a = await fx.anchor(serverTime: '2026-11-06T00:31:00.000Z');
    expect(a.createdSeq, inInclusiveRange(3, 4));
    final first = (await fx.rows('SELECT created_seq FROM clock_anchors ORDER BY created_seq')).first;
    expect(first['created_seq'], inInclusiveRange(0, 1));
  });

  test('latest(): null when none; otherwise the most recent, including two anchors recorded at the same instant', () async {
    expect(await fx.anchors.latest(), isNull);
    final a1 = await fx.anchor();
    expect((await fx.anchors.latest())!.anchorId, a1.anchorId);
    fx.tick(const Duration(minutes: 1));
    final a2 = await fx.anchor(serverTime: '2026-11-06T00:31:00.000Z');
    expect((await fx.anchors.latest())!.anchorId, a2.anchorId);
    final a3 = await fx.anchor(serverTime: '2026-11-06T00:31:00.000Z'); // same tick
    expect((await fx.anchors.latest())!.anchorId, a3.anchorId);
  });

  test('anchors survive a restart', () async {
    final a = await fx.anchor();
    await fx.restart();
    final b = (await fx.anchors.latest())!;
    expect(b.anchorId, a.anchorId);
    expect(b.monotonicMs, a.monotonicMs);
    expect(b.bootId, a.bootId);
  });

  test('malformed server_time is refused and nothing is stored', () async {
    for (final bad in ['', 'yesterday', '2026-11-06 00:30:00', '2026-11-06T00:30:00+05:45', '1730853000']) {
      await expectLater(fx.anchors.record(serverTime: bad), throwsA(anything), reason: bad);
    }
    expect((await fx.rows('SELECT count(*) AS n FROM clock_anchors')).single['n'], 0);
  });

  group('capture uses the MONOTONIC channel only (TRD §7.5)', () {
    test('elapsed_since_anchor_ms = monotonic_now − anchor.monotonic_ms, even if the user moves the wall clock back 3 h', () async {
      final a = await fx.anchor();
      fx.mono.ms += 5000; // 5 s really pass …
      fx.wall.now = fx.wall.now.subtract(const Duration(hours: 3)); // … and the user rewinds the phone clock
      await enqueueType(fx, 'visit.arrived');
      final r = (await fx.rows('SELECT * FROM mutation_log')).single;
      expect(r['anchor_id'], a.anchorId);
      expect(r['elapsed_since_anchor_ms'], 5000);
      expect(r['captured_wall_time'], '2026-11-05T21:30:00.000Z', reason: 'raw device wall time is kept as captured, even if wrong');
    });

    test('elapsed counts deep sleep: a jump of 8 h of monotonic time while the app was suspended is reflected 1:1', () async {
      await fx.anchor();
      fx.mono.ms += const Duration(hours: 8).inMilliseconds;
      await enqueueType(fx, 'visit.arrived');
      expect((await fx.rows('SELECT elapsed_since_anchor_ms AS e FROM mutation_log')).single['e'], 28800000);
    });

    test('each mutation references the LATEST anchor at capture time', () async {
      final a1 = await fx.anchor();
      fx.tick(const Duration(minutes: 1));
      await enqueueType(fx, 'visit.arrived');
      fx.tick(const Duration(minutes: 1));
      final a2 = await fx.anchor(serverTime: '2026-11-06T00:32:00.000Z');
      fx.tick(const Duration(seconds: 10));
      await enqueueType(fx, 'visit.identity_checked');
      final rows = await fx.rows('SELECT anchor_id, elapsed_since_anchor_ms AS e FROM mutation_log ORDER BY device_seq');
      expect(rows[0]['anchor_id'], a1.anchorId);
      expect(rows[0]['e'], 60000);
      expect(rows[1]['anchor_id'], a2.anchorId);
      expect(rows[1]['e'], 10000);
    });
  });

  group('boot-id channel', () {
    test('a reboot between anchor and capture: mutation is still stored against the old anchor; batch now.boot_id is the NEW boot, the anchor keeps the OLD one', () async {
      final a = await fx.anchor();
      fx.boot.id = 'b-0000000018'; // phone rebooted offline; monotonic restarted from ~0
      fx.mono.ms = 42000;
      fx.wall.now = fx.wall.now.add(const Duration(minutes: 20));
      await enqueueType(fx, 'visit.arrived');
      final r = (await fx.rows('SELECT anchor_id, elapsed_since_anchor_ms AS e FROM mutation_log')).single;
      expect(r['anchor_id'], a.anchorId, reason: 'device cannot make a newer anchor offline');
      expect(r['e'], 42000 - 86400123, reason: 'raw difference is stored; the server compares boot ids and falls back to offset (§7.5 step 2)');

      final body = jsonDecode((await fx.repo.formBatch())!.bodyJson) as Map<String, Object?>;
      expect((body['now'] as Map)['boot_id'], 'b-0000000018');
      expect((body['now'] as Map)['monotonic_ms'], 42000);
      expect(((body['anchors'] as List).single as Map)['boot_id'], 'b-0000000017');
    });

    test('boot id is read from the source at capture/record time, not cached from app start', () async {
      fx.boot.id = 'b-0000000019';
      final a = await fx.anchor();
      expect(a.bootId, 'b-0000000019');
    });

    test('boot id out of the 1..64 range is refused (server CHECK char_length 1..64) and nothing is stored', () async {
      fx.boot.id = '';
      await expectLater(fx.anchor(), throwsA(anything));
      fx.boot.id = 'b' * 65;
      await expectLater(fx.anchor(), throwsA(anything));
      expect((await fx.rows('SELECT count(*) AS n FROM clock_anchors')).single['n'], 0);
    });
  });
}
