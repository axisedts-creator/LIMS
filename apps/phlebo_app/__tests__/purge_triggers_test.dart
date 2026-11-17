// HC-T28 unit tests (fake clocks, real SQLCipher, fake key store) — PRD US-13-3 (offline hours / local date change purge the read-only
// cache, mutation log kept), US-13-4 (session revoked/expired -> cache destroyed immediately, pending mutations stay), US-13-5 (wipe
// destroys both DBs, cache first), TRD §7.1 (key first), 03-APP-FLOW E15, 07-SECURITY §6 item 7 + REQ-SEC-103.
// ASSUMED API: see the header of support/purge_fixture.dart.
import 'package:flutter_test/flutter_test.dart';
import 'package:phlebo_app/core/sync/purge_triggers.dart';

import 'support/db_fixture.dart';
import 'support/outbox_fixture.dart';
import 'support/purge_fixture.dart';

void main() {
  late PurgeBase fx;
  setUp(() async => fx = await PurgeBase.create());
  tearDown(() => fx.dispose());

  void at(DateTime utc) => fx.wall.now = utc;

  group('US-13-3 offline hours (default 16 h) — fake clock', () {
    test('15 h 59 m 59 s after the last successful pull: nothing is purged', () async {
      await fx.seed(); // pull at 2026-11-06T00:30:00Z
      at(DateTime.utc(2026, 11, 6, 16, 29, 59));
      expect(await fx.purge.purgeIfStale(), isNull);
      expect(fx.cacheFilesExist(), isTrue);
      expect(fx.cacheKeyExists, isTrue);
    });

    test('exactly 16 h: cache.db + key + WAL/SHM destroyed, outbox.db + key + pending row kept, no patient string left on disk', () async {
      await enqueueType(fx.ofx, 'visit.arrived');
      await fx.seed();
      expect(sandboxContains(fx.dir, 'Test Patient 0042'), isFalse, reason: 'precondition: SQLCipher already hides it');
      at(DateTime.utc(2026, 11, 6, 16, 30, 0));
      expect(await fx.purge.purgeIfStale(), PurgeReason.offlineHours);
      expect(fx.cacheFilesExist(), isFalse);
      expect(fx.cacheKeyExists, isFalse);
      expect(fx.outboxFilesExist(), isTrue);
      expect(fx.outboxKeyExists, isTrue);
      expect(await fx.pendingRows(), 1, reason: 'the mutation log is kept');
      expect(fx.trace, ['destroy:cache'], reason: 'only the cache is destroyed');
    });

    test('the limit is config_json.offline_purge_hours: 8 -> purged at 8 h, not at 7 h 59 m 59 s', () async {
      await fx.seed(offlinePurgeHours: 8);
      at(DateTime.utc(2026, 11, 6, 8, 29, 59));
      expect(await fx.purge.purgeIfStale(), isNull);
      at(DateTime.utc(2026, 11, 6, 8, 30, 0));
      expect(await fx.purge.purgeIfStale(), PurgeReason.offlineHours);
    });

    test('24 -> still kept after 17 h (a hard-coded 16 would purge here)', () async {
      at(DateTime.utc(2026, 11, 6, 18, 20)); // local 00:05 on 2026-11-07
      await fx.seed(routeDate: '2026-11-07', offlinePurgeHours: 24);
      at(DateTime.utc(2026, 11, 7, 11, 20)); // +17 h, local 17:05 the same day
      expect(await fx.purge.purgeIfStale(), isNull);
      expect(fx.cacheFilesExist(), isTrue);
    });

    test('the clock runs from the last SUCCESSFUL PULL (device_state), not from the last cache replace: an unchanged pull resets it', () async {
      await fx.seed(lastPull: DateTime.utc(2026, 11, 6, 15, 0), pulledAtDeviceNow: false); // cache replaced 00:30, unchanged pull 15:00
      at(DateTime.utc(2026, 11, 6, 17, 0)); // 16 h 30 m after the replace, 2 h after the last pull, local 22:45 same date
      expect(await fx.purge.purgeIfStale(), isNull);
      expect(fx.cacheFilesExist(), isTrue);
    });
  });

  group('US-13-3 local date change / E15 route date rollover', () {
    setUp(() async {
      at(DateTime.utc(2026, 11, 6, 18, 0)); // local 23:45 on 2026-11-06
      await fx.seed(); // route_date 2026-11-06, pulled 15 minutes ago
    });

    test('local 23:59:59 on the route date: kept', () async {
      at(DateTime.utc(2026, 11, 6, 18, 14, 59));
      expect(fx.localNow().day, 6);
      expect(await fx.purge.purgeIfStale(), isNull);
    });

    test('local 00:00:00 the next day (Kathmandu, only 15 minutes after the pull): cache destroyed, outbox kept with its pending rows', () async {
      await enqueueType(fx.ofx, 'visit.arrived');
      await enqueueType(fx.ofx, 'visit.completed');
      at(DateTime.utc(2026, 11, 6, 18, 15, 0));
      expect(fx.localNow().day, 7);
      expect(await fx.purge.purgeIfStale(), PurgeReason.dateRollover);
      expect(fx.cacheFilesExist(), isFalse);
      expect(fx.cacheKeyExists, isFalse);
      expect(fx.outboxFilesExist(), isTrue);
      expect(fx.outboxKeyExists, isTrue);
      expect(await fx.pendingRows(), 2, reason: 'E15: pending mutations upload later');
    });

    test('the date compared is the DEVICE-LOCAL date, not the UTC date: at 18:15Z UTC is still the 6th but local is the 7th', () async {
      at(DateTime.utc(2026, 11, 6, 18, 14, 59)); // UTC date still the 6th, local 23:59:59 -> kept
      expect(await fx.purge.purgeIfStale(), isNull);
      at(DateTime.utc(2026, 11, 6, 18, 15, 0)); // UTC date is STILL the 6th, local date is the 7th -> purged
      expect(fx.wall.now.toUtc().day, 6);
      expect(await fx.purge.purgeIfStale(), PurgeReason.dateRollover);
    });
  });

  group('edges', () {
    test('a cache that was never filled by a pull (no meta, no last pull) is not purged and nothing throws', () async {
      at(DateTime.utc(2026, 11, 20));
      expect(await fx.purge.purgeIfStale(), isNull);
      expect(fx.cacheFilesExist(), isTrue);
      expect(fx.trace, isEmpty);
    });

    test('both triggers due at once purge once; a second call (cache handle already closed) returns null without throwing', () async {
      await fx.seed();
      at(DateTime.utc(2026, 11, 8)); // 2 days: offline AND date change
      expect(await fx.purge.purgeIfStale(), isNotNull);
      expect(await fx.purge.purgeIfStale(), isNull);
      await fx.purge.purgeOnSessionEnd();
      expect(fx.trace.where((e) => e == 'destroy:cache').length, 1, reason: 'destroyed exactly once');
    });

    test('fail closed: when the key cannot be deleted purgeIfStale throws and no file is touched', () async {
      await fx.seed();
      at(DateTime.utc(2026, 11, 7, 12));
      fx.store.failDeleteWith = StateError('keystore unavailable');
      await expectLater(fx.purge.purgeIfStale(), throwsA(isA<StateError>()));
      expect(fx.cacheFilesExist(), isTrue);
    });
  });

  group('US-13-4 session revoked / expired', () {
    test('purgeOnSessionEnd destroys cache.db + key at once (no clock needed); outbox.db, key, pending rows, device_state and anchors stay', () async {
      await enqueueType(fx.ofx, 'visit.arrived');
      await enqueueType(fx.ofx, 'specimen.collected');
      await fx.seed();
      final anchorsBefore = (await fx.ofx.rows('SELECT count(*) AS n FROM clock_anchors')).single['n'];
      await fx.purge.purgeOnSessionEnd();
      expect(fx.cacheFilesExist(), isFalse);
      expect(fx.cacheKeyExists, isFalse);
      expect(fx.outboxFilesExist(), isTrue);
      expect(fx.outboxKeyExists, isTrue);
      expect(await fx.pendingRows(), 2);
      expect((await fx.ofx.rows('SELECT count(*) AS n FROM clock_anchors')).single['n'], anchorsBefore);
      expect((await fx.ofx.rows("SELECT value FROM device_state WHERE key = 'last_successful_pull_at'")), isNotEmpty);
      expect(fx.trace, ['destroy:cache']);
    });

    test('idempotent: the second call (revoke seen twice, or after an offline purge) does not throw', () async {
      await fx.seed();
      await fx.purge.purgeOnSessionEnd();
      await fx.purge.purgeOnSessionEnd();
      expect(fx.trace.where((e) => e == 'destroy:cache').length, 1);
    });

    test('fail closed: key delete failure propagates', () async {
      await fx.seed();
      fx.store.failDeleteWith = StateError('keystore unavailable');
      await expectLater(fx.purge.purgeOnSessionEnd(), throwsA(isA<StateError>()));
      expect(fx.cacheFilesExist(), isTrue);
    });
  });

  group('US-13-5 wipeAll', () {
    test('both DBs and both keys destroyed, cache before outbox, the cache key deleted before the outbox key', () async {
      await fx.seed();
      await fx.purge.wipeAll();
      expect(fx.cacheFilesExist(), isFalse);
      expect(fx.outboxFilesExist(), isFalse);
      expect(fx.cacheKeyExists, isFalse);
      expect(fx.outboxKeyExists, isFalse);
      expect(fx.trace, ['destroy:cache', 'destroy:outbox']);
      final del = fx.store.events.where((e) => e.startsWith('delete:')).toList();
      expect(del.indexOf('delete:$cacheKeyName'), lessThan(del.indexOf('delete:$outboxKeyName')));
    });

    test('nothing readable is left in the sandbox directory (no -wal/-shm, no synthetic strings)', () async {
      await enqueueType(fx.ofx, 'specimen.collected');
      await fx.seed();
      await fx.purge.wipeAll();
      expect(fx.dir.listSync().where((e) => e.path.contains('.db')), isEmpty);
      expect(sandboxContains(fx.dir, 'Test Patient 0042'), isFalse);
      expect(sandboxContains(fx.dir, 'E2600000042'), isFalse);
    });
  });
}
