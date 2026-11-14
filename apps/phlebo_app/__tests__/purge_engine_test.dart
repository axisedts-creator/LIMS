// HC-T28 engine hooks — PRD US-13-3 (purge on offline hours / date change, log kept), US-13-4 (revoke -> cache destroyed immediately,
// pending mutations upload after the next login by the same user), US-13-5 (wipe command: finish uploading, destroy both DBs + keys,
// ackSync wipe_completed:true, sign out); plan row HC-T28 tests "fake clock tests; wipe after drain"; 03-APP-FLOW E15, §5.8; TRD §6.4, §7.1.
// ASSUMED API: header of support/purge_fixture.dart (PurgeTriggers, SyncEngine.purge / onWiped, SyncStatus.purged / wiped).
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:phlebo_app/core/db/cache_db.dart';
import 'package:phlebo_app/core/sync/purge_triggers.dart';
import 'package:phlebo_app/core/sync/sync_engine.dart';

import 'support/db_fixture.dart';
import 'support/outbox_fixture.dart';
import 'support/purge_fixture.dart';
import 'support/sync_fixture.dart';
import 'support/tls_fixture.dart';

Map<String, Object?> wipeSnapshot([String cursor = 'c9']) => {
      ...snapshotDto(cursor, [visitJson(visitA, 1, 42)]),
      'device_command': 'wipe',
    };

void main() {
  late TestPki pki;
  late PurgeFx fx;

  setUpAll(() async => pki = await TestPki.create());
  tearDownAll(() => pki.dispose());
  setUp(() async => fx = await PurgeFx.create(pki));
  tearDown(() => fx.dispose());

  int at(String e) => fx.trace.indexOf(e);
  int lastAt(String e) => fx.trace.lastIndexOf(e);
  Future<List<String>> states() async =>
      [for (final r in await fx.ofx.rows('SELECT state FROM mutation_log ORDER BY device_seq')) r['state']! as String];

  group('US-13-4 revoke / session end', () {
    test('ensureFresh refused (auth.session_expired): cache.db + key destroyed at once, nothing sent, outbox + pending rows kept', () async {
      await enqueueType(fx.ofx, 'visit.arrived');
      await fx.base.seed();
      fx.session.ensureThrows = sessionExpired();
      final r = await fx.sync();
      expect(r.status, SyncStatus.sessionExpired);
      expect(fx.base.cacheFilesExist(), isFalse);
      expect(fx.base.cacheKeyExists, isFalse);
      expect(fx.base.outboxFilesExist(), isTrue);
      expect(fx.base.outboxKeyExists, isTrue);
      expect(await fx.base.pendingRows(), 1);
      expect(fx.server.log, isEmpty);
      expect(fx.wipedCalls, 0, reason: 'a revoke is not a wipe');
    });

    test('401 -> refreshNow refused (revoked / old session token reused): same purge, rows stay resendable', () async {
      await enqueueType(fx.ofx, 'visit.arrived');
      await fx.base.seed();
      fx.server.validToken = 'tok-other'; // the device's token is now rejected
      fx.session.refreshThrows = sessionExpired();
      final r = await fx.sync();
      expect(r.status, SyncStatus.sessionExpired);
      expect(fx.base.cacheFilesExist(), isFalse);
      expect(fx.base.cacheKeyExists, isFalse);
      expect(fx.base.outboxFilesExist(), isTrue);
      expect(await fx.base.pendingRows(), 1);
    });

    test('pending mutations upload after the next login: new cache.db, new session, same frozen batch body, all applied', () async {
      await enqueueType(fx.ofx, 'visit.arrived');
      await enqueueType(fx.ofx, 'visit.completed');
      await fx.base.seed();
      fx.server.validToken = 'tok-other';
      fx.session.refreshThrows = sessionExpired();
      expect((await fx.sync()).status, SyncStatus.sessionExpired);

      // login again (same user): fresh cache.db with a NEW key, valid token
      fx.session.refreshThrows = null;
      fx.session.token = 'tok-2';
      fx.server.validToken = 'tok-2';
      final cache2 = await CacheDb.open(dir: fx.ofx.dir, keys: fx.ofx.keys);
      for (final s in cacheDdl) {
        await cache2.execute(s);
      }
      fx.base.cache = cache2;
      final purge2 = PurgeTriggers(
          wipe: fx.base.wipe, cache: cache2, outboxDb: fx.ofx.db, wallNow: fx.ofx.wall.call, localNow: () => fx.base.localNow());
      final engine2 = fx.buildEngine(cache: cache2, purge: purge2);
      final r = await engine2.syncNow();
      expect(r.status, SyncStatus.ok);
      expect(await states(), ['applied', 'applied']);
      expect(fx.server.appliedCount, 2);
      final pushes = fx.server.pushes;
      expect(pushes.length, 2, reason: 'one refused attempt, one accepted retry');
      expect(pushes[1].body, pushes[0].body, reason: 'frozen body byte for byte (05-SCHEMA B.2 invariant 3)');
    });

    test('a network failure is NOT a revoke: the cache stays and work continues offline', () async {
      await fx.base.seed();
      fx.server.faults['push']!.add(const Fault.dropBeforeApply());
      await enqueueType(fx.ofx, 'visit.arrived');
      final r = await fx.sync();
      expect(r.status, SyncStatus.retryLater);
      expect(fx.base.cacheFilesExist(), isTrue);
      expect(fx.base.cacheKeyExists, isTrue);
      expect(fx.trace.where((e) => e.startsWith('destroy:')), isEmpty);
    });
  });

  group('US-13-3 offline hours / date rollover at cycle start (fake clock)', () {
    test('17 h after the last successful pull: syncNow -> purged, NO request sent, cache gone, outbox + pending rows kept', () async {
      expect((await fx.sync()).status, SyncStatus.ok);
      await enqueueType(fx.ofx, 'visit.arrived');
      fx.ofx.tick(const Duration(hours: 17)); // 17:30Z = local 23:15, same date
      final sent = fx.server.log.length;
      final r = await fx.sync();
      expect(r.status, SyncStatus.purged);
      expect(fx.server.log.length, sent);
      expect(fx.base.cacheFilesExist(), isFalse);
      expect(fx.base.cacheKeyExists, isFalse);
      expect(fx.base.outboxFilesExist(), isTrue);
      expect(await fx.base.pendingRows(), 1);
    });

    test('recovery: after an offline-hours purge the next engine over a fresh empty cache syncs (pending row applied, new route_date), not purged again', () async {
      expect((await fx.sync()).status, SyncStatus.ok);
      await enqueueType(fx.ofx, 'visit.arrived');
      fx.ofx.tick(const Duration(hours: 17));
      expect((await fx.sync()).status, SyncStatus.purged);

      // login again (same user): fresh empty cache.db; device_state.last_successful_pull_at (outbox.db) is still 17 h old
      final cache2 = await CacheDb.open(dir: fx.ofx.dir, keys: fx.ofx.keys);
      for (final s in cacheDdl) {
        await cache2.execute(s);
      }
      fx.base.cache = cache2;
      final purge2 = PurgeTriggers(
          wipe: fx.base.wipe, cache: cache2, outboxDb: fx.ofx.db, wallNow: fx.ofx.wall.call, localNow: () => fx.base.localNow());
      final engine2 = fx.buildEngine(cache: cache2, purge: purge2);
      final r = await engine2.syncNow();
      expect(r.status, SyncStatus.ok, reason: 'a cache never filled by a pull is never purged; the pull must be allowed to reset the clock');
      expect(await states(), ['applied']);
      final meta = await cache2.select("SELECT value FROM meta WHERE key = 'route_date'");
      expect(meta.single['value'], isNotNull);
    });

    test('exactly under the limit: 15 h 59 m after the pull the cycle runs normally', () async {
      expect((await fx.sync()).status, SyncStatus.ok);
      fx.ofx.tick(const Duration(hours: 15, minutes: 59));
      expect((await fx.sync()).status, SyncStatus.ok);
      expect(fx.base.cacheFilesExist(), isTrue);
    });

    test('successful pulls keep resetting the clock; the next LOCAL date then purges even though the last pull was 15 minutes ago (E15)', () async {
      expect((await fx.sync()).status, SyncStatus.ok); // 00:30Z
      fx.ofx.tick(const Duration(hours: 10));
      expect((await fx.sync()).status, SyncStatus.ok); // 10:30Z, unchanged pull
      fx.ofx.tick(const Duration(hours: 7, minutes: 30));
      expect((await fx.sync()).status, SyncStatus.ok); // 18:00Z, local 23:45 on the route date
      await enqueueType(fx.ofx, 'visit.completed');
      fx.ofx.tick(const Duration(minutes: 15)); // 18:15Z = local 00:00 on 2026-11-07
      final r = await fx.sync();
      expect(r.status, SyncStatus.purged);
      expect(fx.base.cacheFilesExist(), isFalse);
      expect(await fx.base.pendingRows(), 1);
    });
  });

  group('US-13-5 wipe command: wipe after drain', () {
    test('pending rows are uploaded first, then cache THEN outbox destroyed (keys gone), ack wipe_completed:true last, then sign-out', () async {
      fx.server.snapshot = wipeSnapshot();
      await enqueueVisitFlow(fx.ofx); // 7 mutations
      await fx.base.seed();
      final r = await fx.sync();
      expect(r.status, SyncStatus.wiped);
      expect(fx.server.appliedCount, 7, reason: 'everything pending reached the server before the wipe');

      expect(at('req:push'), greaterThanOrEqualTo(0));
      expect(at('req:push'), lessThan(at('req:pull')));
      expect(at('req:pull'), lessThan(at('destroy:cache')));
      expect(at('destroy:cache'), lessThan(at('destroy:outbox')));
      expect(at('destroy:outbox'), lessThan(lastAt('req:ack')));
      expect(lastAt('req:ack'), lessThan(at('signout')));
      expect(fx.wipedCalls, 1);

      final ack = fx.server.acks.last;
      expect(ack['wipe_completed'], isTrue);
      expect(ack['device_id'], deviceId);
      expect(ack['cursor'], 'c9');
      expect(ack['max_device_seq_acked'], 7);
      expect(fx.server.acks.where((a) => a['wipe_completed'] == true).length, 1);

      expect(fx.base.cacheFilesExist(), isFalse);
      expect(fx.base.outboxFilesExist(), isFalse);
      expect(fx.base.cacheKeyExists, isFalse);
      expect(fx.base.outboxKeyExists, isFalse);
      expect(sandboxContains(fx.ofx.dir, 'Test Patient 0042'), isFalse);
      expect(sandboxContains(fx.ofx.dir, 'E2600000042'), isFalse);
    });

    test('the command also arrives on an UNCHANGED pull', () async {
      expect((await fx.sync()).status, SyncStatus.ok); // stores cursor c0
      fx.server.snapshot['device_command'] = 'wipe'; // same cursor -> unchanged:true, device_command wipe
      final r = await fx.sync();
      expect(r.status, SyncStatus.wiped);
      expect(fx.server.pulls.last.uri.queryParameters['cursor'], 'c0');
      expect(fx.server.acks.last['wipe_completed'], isTrue);
      expect(fx.base.outboxFilesExist(), isFalse);
    });

    test('device_command none: nothing is destroyed and no wipe ack is sent', () async {
      await enqueueType(fx.ofx, 'visit.arrived');
      final r = await fx.sync();
      expect(r.status, SyncStatus.ok);
      expect(fx.trace.where((e) => e.startsWith('destroy:')), isEmpty);
      expect(fx.server.acks.every((a) => a['wipe_completed'] != true), isTrue);
      expect(fx.wipedCalls, 0);
      expect(fx.base.outboxFilesExist(), isTrue);
    });

    test('NOT drained: a mutation saved while the pull is in flight blocks the wipe; it is uploaded next cycle, THEN the wipe happens', () async {
      fx.server.snapshot = wipeSnapshot();
      await fx.base.seed();
      fx.server.faults['pull']!.add(const Fault.delay(Duration(milliseconds: 600)));
      final cycle = fx.sync();
      final deadline = DateTime.now().add(const Duration(seconds: 10)); // real time: only to wait for the real socket
      while (!fx.trace.contains('req:pull') && DateTime.now().isBefore(deadline)) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
      expect(fx.trace, contains('req:pull'));
      await enqueueType(fx.ofx, 'visit.arrived'); // the phlebotomist taps while the answer is on the wire
      final first = await cycle;

      expect(first.status, isNot(SyncStatus.wiped));
      expect(fx.base.cacheFilesExist(), isTrue);
      expect(fx.base.outboxFilesExist(), isTrue);
      expect(fx.base.cacheKeyExists && fx.base.outboxKeyExists, isTrue);
      expect(fx.server.acks.every((a) => a['wipe_completed'] != true), isTrue);
      expect(await states(), ['pending']);
      expect(fx.wipedCalls, 0);

      final second = await fx.sync();
      expect(second.status, SyncStatus.wiped);
      expect(fx.server.appliedCount, 1, reason: 'the late mutation was uploaded before the wipe');
      expect(fx.server.acks.last['max_device_seq_acked'], 1);
      expect(fx.base.outboxFilesExist(), isFalse);
    });

    test('rows the server answered held/duplicate/rejected are drained too: the wipe is not blocked by them', () async {
      fx.server.snapshot = wipeSnapshot();
      await enqueueType(fx.ofx, 'visit.arrived');
      fx.server.outcomeOverride['visit.arrived'] = ('held', 'homecollection.mutation_superseded');
      final r = await fx.sync();
      expect(r.status, SyncStatus.wiped);
      expect(fx.base.outboxFilesExist(), isFalse);
    });

    test('push fails (503) while a wipe is waiting on the server: no pull, no wipe, rows stay', () async {
      fx.server.snapshot = wipeSnapshot();
      await enqueueType(fx.ofx, 'visit.arrived');
      fx.server.faults['push']!.add(Fault.status(503, LimsErrorCodes.commonDependencyUnavailable));
      final r = await fx.sync();
      expect(r.status, SyncStatus.retryLater);
      expect(fx.server.pulls, isEmpty);
      expect(fx.trace.where((e) => e.startsWith('destroy:')), isEmpty);
      expect(fx.base.outboxFilesExist(), isTrue);
      expect(await fx.base.pendingRows(), 1);
    });

    test('the wipe does not depend on the network: ackSync fails (503) after the destruction, both DBs and keys are still gone', () async {
      fx.server.snapshot = wipeSnapshot();
      fx.server.faults['ack']!.add(Fault.status(503, LimsErrorCodes.commonDependencyUnavailable));
      await fx.sync();
      expect(fx.base.cacheFilesExist(), isFalse);
      expect(fx.base.outboxFilesExist(), isFalse);
      expect(fx.base.cacheKeyExists, isFalse);
      expect(fx.base.outboxKeyExists, isFalse);
    });

    test('a pull that fails (connection dropped) is not a wipe command: nothing destroyed', () async {
      fx.server.snapshot = wipeSnapshot();
      fx.server.faults['pull']!.add(const Fault.dropBeforeApply());
      final r = await fx.sync();
      expect(r.status, SyncStatus.retryLater);
      expect(fx.trace.where((e) => e.startsWith('destroy:')), isEmpty);
      expect(Directory(fx.ofx.dir.path).existsSync(), isTrue);
    });
  });
}
