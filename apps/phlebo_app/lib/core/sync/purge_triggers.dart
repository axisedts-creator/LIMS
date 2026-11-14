// HC-T28 / US-13-3, US-13-4, US-13-5, REQ-SEC-103 (TRD §7.1, 03-APP-FLOW E15): when the phone destroys what it holds.
// - purgeIfStale: cache.db (+ key) is destroyed when the last successful pull is >= offline_purge_hours old, or when the device-local
//   calendar date is after the route date of the cached snapshot. outbox.db is NEVER touched here: pending mutations upload later.
// - purgeOnSessionEnd: same destruction at once when the session is revoked / expired (US-13-4).
// - wipeAll: cache THEN outbox, key first each time (US-13-5); the engine calls it only after the outbox has drained.
// Every destruction goes through DbWipe (key first, fail closed: a key-delete failure throws before any file is touched).
// Time comes from the injected clocks only (TRD §7.5); nothing is logged (P2).
import 'dart:convert';

import '../db/cache_db.dart';
import '../db/outbox_db.dart';
import '../db/wipe.dart';

enum PurgeReason { offlineHours, dateRollover }

/// 05-SCHEMA B.1 default when the snapshot config carries no offline_purge_hours.
const _defaultOfflinePurgeHours = 16;

class PurgeTriggers {
  PurgeTriggers({
    required this.wipe,
    required this.cache,
    required this.outboxDb,
    required this.wallNow,
    required this.localNow,
  });

  final DbWipe wipe;
  final CacheDb cache;
  final OutboxDb outboxDb;

  /// An instant: elapsed = wallNow() - device_state.last_successful_pull_at.
  final DateTime Function() wallNow;

  /// Device-local wall time (Asia/Kathmandu on the phone). Only year/month/day are read.
  final DateTime Function() localNow;

  bool _cacheGone = false;

  /// [CONV] stale at elapsed >= limit; a cache never filled by a pull (no last pull / no route_date) is never purged.
  /// Returns why the cache was destroyed, else null. After a destruction it returns null (idempotent).
  Future<PurgeReason?> purgeIfStale() async {
    if (_cacheGone) return null;
    final reason = await _staleReason();
    if (reason == null) return null;
    await _destroyCache();
    return reason;
  }

  /// US-13-4: destroy cache.db + key now. Idempotent.
  Future<void> purgeOnSessionEnd() async {
    if (_cacheGone) return;
    await _destroyCache();
  }

  /// US-13-5: cache (key, files), THEN outbox (key, files).
  Future<void> wipeAll() async {
    await wipe.destroyAll(cache: cache, outbox: outboxDb);
    _cacheGone = true;
  }

  Future<void> _destroyCache() async {
    await wipe.destroyCache(open: cache);
    _cacheGone = true; // only after the key is gone: a failed key delete leaves the purge due
  }

  Future<PurgeReason?> _staleReason() async {
    final meta = {
      for (final r in await cache.select("SELECT key, value FROM meta WHERE key IN ('config_json', 'route_date')"))
        r['key']! as String: r['value']! as String,
    };
    // Review #1: only a cache filled by a pull (route_date set by snapshot apply) can be stale;
    // an empty cache rebuilt after a purge must let the next pull run and reset the clock.
    if (meta['route_date'] == null) return null;

    final pull = await outboxDb.select("SELECT value FROM device_state WHERE key = 'last_successful_pull_at'");
    if (pull.isNotEmpty) {
      final last = DateTime.tryParse(pull.single['value']! as String);
      if (last != null && wallNow().difference(last) >= Duration(hours: _offlinePurgeHours(meta['config_json']))) {
        return PurgeReason.offlineHours;
      }
    }

    final routeDate = meta['route_date'];
    if (routeDate != null && RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(routeDate) && _localDate().compareTo(routeDate) > 0) {
      return PurgeReason.dateRollover; // zero-padded ISO dates order lexicographically
    }
    return null;
  }

  static int _offlinePurgeHours(String? configJson) {
    if (configJson == null) return _defaultOfflinePurgeHours;
    try {
      final h = (jsonDecode(configJson) as Map)['offline_purge_hours'];
      return h is int && h > 0 ? h : _defaultOfflinePurgeHours;
    } catch (_) {
      return _defaultOfflinePurgeHours;
    }
  }

  String _localDate() {
    final d = localNow();
    String p(int n, int w) => n.toString().padLeft(w, '0');
    return '${p(d.year, 4)}-${p(d.month, 2)}-${p(d.day, 2)}';
  }
}
