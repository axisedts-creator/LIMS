// HC-T22 / US-13-2, US-13-3, US-13-5, REQ-SEC-103 — TRD §7.1:
//   "Destruction = delete the key from secure storage FIRST (crypto-shred), then close and delete the DB file + -wal/-shm."
//   US-13-2: cache DB and its key destroyed, THEN the mutation (outbox) DB and its key.
//   US-13-3: cache destroyed while the mutation log is kept.
//
// ASSUMED API (package:phlebo_app/core/db/wipe.dart):
//   class DbWipe {
//     DbWipe({required Directory dir, required DbKeys keys});     // dir holds cache.db / outbox.db (+ -wal / -shm)
//     Future<void> destroyCache({CacheDb? open});                 // key -> close(open) -> delete cache.db, -wal, -shm
//     Future<void> destroyOutbox({OutboxDb? open});               // key -> close(open) -> delete outbox.db, -wal, -shm
//     Future<void> destroyAll({CacheDb? cache, OutboxDb? outbox});// cache (key, files) THEN outbox (key, files)
//   }
//   Idempotent: nothing on disk / no key -> completes without error. Key-delete failure -> the future completes with that error.
// Plus CacheDb/OutboxDb as in db_forensics_test.dart.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:phlebo_app/core/db/cache_db.dart';
import 'package:phlebo_app/core/db/keys.dart';
import 'package:phlebo_app/core/db/outbox_db.dart';
import 'package:phlebo_app/core/db/wipe.dart';

import 'support/db_fixture.dart';

List<File> _files(Directory d, String base) => [for (final s in ['', '-wal', '-shm']) File('${d.path}/$base$s')];
bool _anyExists(Directory d, String base) => _files(d, base).any((f) => f.existsSync());
bool _allExist(Directory d, String base) => _files(d, base).every((f) => f.existsSync());

Future<void> _plant(dynamic db) async {
  await db.execute('CREATE TABLE probe (v TEXT)');
  await db.execute('INSERT INTO probe (v) VALUES (?)', ['synthetic row']);
}

void main() {
  late Directory dir;
  late FakeKeyStore store;
  late DbKeys keys;
  late DbWipe wipe;
  setUp(() {
    dir = newTempDir();
    store = FakeKeyStore();
    keys = DbKeys(store);
    wipe = DbWipe(dir: dir, keys: keys);
  });
  tearDown(() => deleteQuietly(dir));

  test('open handle has WAL+SHM on disk (precondition: journal_mode=WAL really in use)', () async {
    final c = await CacheDb.open(dir: dir, keys: keys);
    await _plant(c);
    expect(_allExist(dir, 'cache.db'), isTrue, reason: 'cache.db, cache.db-wal, cache.db-shm expected while a WAL connection is open');
    await c.close();
  });

  test('destroyCache(open): key first, files still there at that instant; afterwards key + db + WAL + SHM all gone', () async {
    final c = await CacheDb.open(dir: dir, keys: keys);
    await _plant(c);
    expect(_allExist(dir, 'cache.db'), isTrue);

    var dbPresentWhenKeyDeleted = false;
    var sidecarsPresentWhenKeyDeleted = false;
    store.onDelete = (name) {
      if (name != cacheKeyName) return;
      dbPresentWhenKeyDeleted = File('${dir.path}/cache.db').existsSync();
      sidecarsPresentWhenKeyDeleted = File('${dir.path}/cache.db-wal').existsSync() || File('${dir.path}/cache.db-shm').existsSync();
    };
    await wipe.destroyCache(open: c);

    expect(dbPresentWhenKeyDeleted, isTrue, reason: 'order must be key -> file: the file was already gone when the key was deleted');
    expect(sidecarsPresentWhenKeyDeleted, isTrue, reason: 'WAL/SHM must still exist at key-delete time (deleted after the key)');
    expect(store.data.containsKey(cacheKeyName), isFalse, reason: 'key destroyed');
    expect(_anyExists(dir, 'cache.db'), isFalse, reason: 'cache.db / -wal / -shm must all be removed');
    await expectLater(c.select('SELECT 1'), throwsA(anything), reason: 'the open handle must be closed');
  });

  test('destroyCache leaves the outbox untouched: key kept, files kept, data still readable (US-13-3)', () async {
    final c = await CacheDb.open(dir: dir, keys: keys);
    final o = await OutboxDb.open(dir: dir, keys: keys);
    await _plant(c);
    await _plant(o);
    final outboxKey = store.data[outboxKeyName];
    await wipe.destroyCache(open: c);
    expect(store.data[outboxKeyName], outboxKey);
    expect(File('${dir.path}/outbox.db').existsSync(), isTrue);
    expect((await o.select('SELECT v FROM probe')).single['v'], 'synthetic row');
    await o.close();
    final again = await OutboxDb.open(dir: dir, keys: DbKeys(store));
    expect((await again.select('SELECT v FROM probe')).single['v'], 'synthetic row');
    await again.close();
  });

  test('after destroyCache a new cache gets a NEW key and an empty DB (old rows unrecoverable)', () async {
    final c = await CacheDb.open(dir: dir, keys: keys);
    await _plant(c);
    final oldKey = store.data[cacheKeyName];
    await wipe.destroyCache(open: c);
    final fresh = await CacheDb.open(dir: dir, keys: DbKeys(store));
    expect(store.data[cacheKeyName], isNot(oldKey));
    await expectLater(fresh.select('SELECT v FROM probe'), throwsA(anything), reason: 'no table from the destroyed DB');
    await fresh.close();
  });

  test('destroyOutbox(open): key first, then outbox.db + WAL + SHM removed; cache untouched', () async {
    final c = await CacheDb.open(dir: dir, keys: keys);
    final o = await OutboxDb.open(dir: dir, keys: keys);
    await _plant(c);
    await _plant(o);
    var dbPresentAtKeyDelete = false;
    store.onDelete = (n) {
      if (n == outboxKeyName) dbPresentAtKeyDelete = File('${dir.path}/outbox.db').existsSync();
    };
    await wipe.destroyOutbox(open: o);
    expect(dbPresentAtKeyDelete, isTrue, reason: 'key -> file order');
    expect(store.data.containsKey(outboxKeyName), isFalse);
    expect(_anyExists(dir, 'outbox.db'), isFalse);
    expect(store.data.containsKey(cacheKeyName), isTrue);
    expect(File('${dir.path}/cache.db').existsSync(), isTrue);
    await c.close();
  });

  test('destroyAll (sign-off / wipe, US-13-2/5): cache key+files first, THEN outbox key+files', () async {
    final c = await CacheDb.open(dir: dir, keys: keys);
    final o = await OutboxDb.open(dir: dir, keys: keys);
    await _plant(c);
    await _plant(o);
    final log = <String>[];
    store.onDelete = (n) {
      final cacheAny = _anyExists(dir, 'cache.db');
      final outboxAny = _anyExists(dir, 'outbox.db');
      log.add('$n cache=${cacheAny ? 'present' : 'gone'} outbox=${outboxAny ? 'present' : 'gone'}');
    };
    await wipe.destroyAll(cache: c, outbox: o);

    expect(log, [
      'phlebo.cache_db_key cache=present outbox=present',
      'phlebo.outbox_db_key cache=gone outbox=present',
    ], reason: 'each key is deleted while its own files still exist; cache is completely gone before the outbox key is touched');
    expect(store.data.containsKey(cacheKeyName), isFalse);
    expect(store.data.containsKey(outboxKeyName), isFalse);
    expect(_anyExists(dir, 'cache.db'), isFalse);
    expect(_anyExists(dir, 'outbox.db'), isFalse);
    expect(dir.listSync().whereType<File>().where((f) => f.path.contains('cache.db') || f.path.contains('outbox.db')), isEmpty);
  });

  test('stale files from a crash (no open handle): db + -wal + -shm all removed, key removed', () async {
    await keys.getOrCreateCacheKey();
    for (final f in _files(dir, 'cache.db')) {
      f.writeAsBytesSync(List.filled(64, 7));
    }
    await wipe.destroyCache();
    expect(_anyExists(dir, 'cache.db'), isFalse);
    expect(store.data.containsKey(cacheKeyName), isFalse);
    // same for outbox
    await keys.getOrCreateOutboxKey();
    for (final f in _files(dir, 'outbox.db')) {
      f.writeAsBytesSync(List.filled(64, 9));
    }
    await wipe.destroyOutbox();
    expect(_anyExists(dir, 'outbox.db'), isFalse);
    expect(store.data.containsKey(outboxKeyName), isFalse);
  });

  test('key already gone but files remain (interrupted earlier destroy): files are still deleted', () async {
    for (final f in _files(dir, 'cache.db')) {
      f.writeAsBytesSync(List.filled(64, 1));
    }
    await wipe.destroyCache();
    expect(_anyExists(dir, 'cache.db'), isFalse);
  });

  test('idempotent: destroying when nothing exists (no key, no files) completes; twice in a row too', () async {
    await wipe.destroyCache();
    await wipe.destroyOutbox();
    await wipe.destroyAll();
    await wipe.destroyAll();
    expect(dir.listSync(), isEmpty);
  });

  test('forced key-delete failure surfaces and the file is NOT deleted before its key (never plaintext-adjacent)', () async {
    final c = await CacheDb.open(dir: dir, keys: keys);
    await _plant(c);
    store.failDeleteWith = StateError('keystore unavailable');
    await expectLater(wipe.destroyCache(open: c), throwsA(isA<StateError>()));
    expect(store.data.containsKey(cacheKeyName), isTrue, reason: 'key still present -> shred did not happen, caller must retry');
    expect(File('${dir.path}/cache.db').existsSync(), isTrue, reason: 'no file deletion ahead of the key deletion');
    store.failDeleteWith = null;
    await wipe.destroyCache(open: c); // retry works
    expect(_anyExists(dir, 'cache.db'), isFalse);
    expect(store.data.containsKey(cacheKeyName), isFalse);
  });

  test('after destroy, the destroyed DB cannot be reopened with the old key even if the old file is restored from a backup', () async {
    final c = await CacheDb.open(dir: dir, keys: keys);
    await _plant(c);
    await c.close();
    final backup = File('${dir.path}/cache.db').readAsBytesSync(); // e.g. adb backup / cloud restore of the sandbox
    await wipe.destroyCache();
    File('${dir.path}/cache.db').writeAsBytesSync(backup);
    await expectLater(CacheDb.open(dir: dir, keys: DbKeys(store)), throwsA(anything),
        reason: 'crypto-shred: restored ciphertext is useless once the key is gone');
  });
}
