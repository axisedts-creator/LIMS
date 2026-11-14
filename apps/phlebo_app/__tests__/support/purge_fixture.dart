// HC-T28 test support: real SQLCipher cache.db + outbox.db in ONE directory (DbWipe takes a single dir), fake clocks, fake key store,
// and (PurgeFx) the HC-T25 scripted HTTPS server + real pinned ApiClient. Synthetic data only.
//
// ASSUMED API (names are mine; the spec names only core/db/wipe.dart and core/sync/*). The writer provides:
//   core/sync/purge_triggers.dart:
//     enum PurgeReason { offlineHours, dateRollover }
//     class PurgeTriggers({required DbWipe wipe, required CacheDb cache, required OutboxDb outboxDb,
//                          required DateTime Function() wallNow,      // instant; elapsed = wallNow - device_state.last_successful_pull_at
//                          required DateTime Function() localNow}) {  // device-local wall time; ONLY year/month/day are read (UTC-flagged ok)
//       Future<PurgeReason?> purgeIfStale();   // US-13-3: destroys cache.db + key (NOT outbox) when due; returns why, else null. Idempotent:
//                                              //   after a purge (cache handle closed) it returns null and does not throw.
//       Future<void> purgeOnSessionEnd();      // US-13-4: destroys cache.db + key now. Idempotent.
//       Future<void> wipeAll();                // US-13-5: DbWipe.destroyAll(cache:, outbox:)  (cache key+files, THEN outbox key+files)
//     }
//     Offline limit = config_json.offline_purge_hours from cache.db meta (default 16 when absent); stale when elapsed >= limit.
//     Date rollover = localNow() calendar date is AFTER cache.db meta.route_date. A cache with no meta (never pulled) is never purged.
//   core/sync/sync_engine.dart additions (all new ctor params OPTIONAL so the HC-T25 tests still compile):
//     SyncEngine(..., PurgeTriggers? purge, Future<void> Function()? onWiped /* sign-out after a wipe */)
//     SyncStatus adds `purged` (cycle-start stale purge: nothing is sent, build a new engine over a new cache.db) and `wiped`.
//     Cycle: purgeIfStale -> push -> pull -> [device_command == 'wipe' && no pending/sending rows] wipeAll -> ack{wipe_completed:true} -> onWiped.
//     Session end (auth.session_expired / auth.token_expired after a refused refresh) -> purgeOnSessionEnd before returning sessionExpired.
import 'dart:convert';
import 'dart:io';

import 'package:lims_shared/lims_shared.dart';
import 'package:phlebo_app/core/db/cache_db.dart';
import 'package:phlebo_app/core/db/wipe.dart';
import 'package:phlebo_app/core/net/api_factory.dart';
import 'package:phlebo_app/core/sync/purge_triggers.dart';
import 'package:phlebo_app/core/sync/sync_engine.dart';

import 'db_fixture.dart';
import 'outbox_fixture.dart';
import 'sync_fixture.dart';
import 'tls_fixture.dart';

/// Asia/Kathmandu (+05:45, no DST): local calendar date for the fake wall clock.
const nepalOffset = Duration(hours: 5, minutes: 45);

/// DbWipe that records the order of destruction in [trace].
class TracingWipe extends DbWipe {
  TracingWipe({required super.dir, required super.keys, required this.trace});
  final List<String> trace;

  @override
  Future<void> destroyCache({CacheDb? open}) async {
    trace.add('destroy:cache');
    await super.destroyCache(open: open);
  }

  @override
  Future<void> destroyOutbox({dynamic open}) async {
    trace.add('destroy:outbox');
    await super.destroyOutbox(open: open);
  }
}

class PurgeBase {
  PurgeBase._(this.ofx, this.cache, this.wipe, this.purge, this.trace);

  final OutboxFx ofx;
  CacheDb cache;
  final TracingWipe wipe;
  final PurgeTriggers purge;
  final List<String> trace;

  Directory get dir => ofx.dir;
  FakeKeyStore get store => ofx.store;
  FakeWall get wall => ofx.wall;
  DateTime localNow() => ofx.wall.now.add(nepalOffset);

  static Future<PurgeBase> create({List<String>? trace}) async {
    final ofx = await OutboxFx.create();
    final t = trace ?? <String>[];
    final cache = await CacheDb.open(dir: ofx.dir, keys: ofx.keys);
    for (final s in cacheDdl) {
      await cache.execute(s);
    }
    final wipe = TracingWipe(dir: ofx.dir, keys: ofx.keys, trace: t);
    final purge = PurgeTriggers(
        wipe: wipe, cache: cache, outboxDb: ofx.db, wallNow: ofx.wall.call, localNow: () => ofx.wall.now.add(nepalOffset));
    return PurgeBase._(ofx, cache, wipe, purge, t);
  }

  /// A cache.db that looks like the result of a pull at the current fake wall time: one route, one visit with PHI-like synthetic
  /// strings, config_json with [offlinePurgeHours], route_date [routeDate]. device_state.last_successful_pull_at = [lastPull] or now.
  Future<void> seed({String routeDate = '2026-11-06', int offlinePurgeHours = 16, DateTime? lastPull, bool pulledAtDeviceNow = true}) async {
    final nowIso = _iso(ofx.wall.now);
    Future<void> m(String k, String v) => cache.execute('INSERT INTO meta (key, value) VALUES (?, ?)', [k, v]);
    await m('snapshot_cursor', 'c0');
    await m('route_date', routeDate);
    await m('server_time_at_pull', nowIso);
    await m('pulled_at_device', pulledAtDeviceNow ? nowIso : '2026-11-06T00:30:00.000Z');
    await m('config_json', jsonEncode({...configJson, 'offline_purge_hours': offlinePurgeHours}));
    await m('schema_version', '1');
    await cache.execute('INSERT INTO routes (route_id, centre_id, version) VALUES (?,?,?)', [routeId, centreId, 4]);
    await cache.execute(
        'INSERT INTO visits (visit_id, version, route_id, route_sequence, status, kind, patient_full_name, patient_phone_e164, address_text) '
        "VALUES (?,?,?,?,'assigned','booking',?,?,?)",
        [visitA, 3, routeId, 1, 'Test Patient 0042', '+9779800000042', 'House 42, Synthetic Tole, Ward 4']);
    await setLastPull(lastPull ?? ofx.wall.now);
  }

  Future<void> setLastPull(DateTime t) => ofx.db.execute(
      'INSERT INTO device_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ['last_successful_pull_at', _iso(t)]);

  static String _iso(DateTime t) {
    String p(int n, int w) => n.toString().padLeft(w, '0');
    final u = t.toUtc();
    return '${p(u.year, 4)}-${p(u.month, 2)}-${p(u.day, 2)}T${p(u.hour, 2)}:${p(u.minute, 2)}:${p(u.second, 2)}.${p(u.millisecond, 3)}Z';
  }

  bool cacheFilesExist() => ['', '-wal', '-shm'].any((s) => File('${dir.path}/cache.db$s').existsSync());
  bool outboxFilesExist() => File('${dir.path}/outbox.db').existsSync();
  bool get cacheKeyExists => store.data.containsKey(cacheKeyName);
  bool get outboxKeyExists => store.data.containsKey(outboxKeyName);

  Future<int> pendingRows() async =>
      (await ofx.rows("SELECT count(*) AS n FROM mutation_log WHERE state IN ('pending','sending')")).single['n']! as int;

  Future<void> dispose() async {
    try {
      await cache.close();
    } catch (_) {}
    await ofx.dispose();
  }
}

/// PurgeBase + scripted server + pinned ApiClient + SyncEngine wired with PurgeTriggers.
class PurgeFx {
  PurgeFx._(this.base, this.server, this.session, this.api);

  final PurgeBase base;
  final FakeHcServer server;
  final FakeSession session;
  final ApiClient api;
  late SyncEngine engine;
  int wipedCalls = 0;

  OutboxFx get ofx => base.ofx;
  List<String> get trace => base.trace;

  static Future<PurgeFx> create(TestPki pki) async {
    final trace = <String>[];
    final base = await PurgeBase.create(trace: trace);
    final server = await FakeHcServer.start(pki, trace);
    final session = FakeSession('tok-1', trace);
    final api = createApiClient(
      baseUrl: server.baseUrl,
      pinnedCaPems: [pki.caAPem],
      appVersion: '1.0.0',
      deviceId: deviceId,
      accessToken: () => session.token,
    );
    final fx = PurgeFx._(base, server, session, api);
    fx.engine = fx.buildEngine();
    return fx;
  }

  SyncEngine buildEngine({CacheDb? cache, PurgeTriggers? purge, SyncSession? sess}) => SyncEngine(
        api: api,
        deviceId: deviceId,
        outbox: ofx.repo,
        outboxDb: ofx.db,
        cache: cache ?? base.cache,
        anchors: ofx.anchors,
        session: sess ?? session,
        wallNow: ofx.wall.call,
        purge: purge ?? base.purge,
        onWiped: () async {
          wipedCalls++;
          trace.add('signout');
        },
      );

  Future<SyncCycleResult> sync() => engine.syncNow();

  Future<void> dispose() async {
    api.close();
    await server.close();
    await base.dispose();
    if (server.errors.isNotEmpty) throw StateError('fake server threw: ${server.errors.first}');
  }
}
