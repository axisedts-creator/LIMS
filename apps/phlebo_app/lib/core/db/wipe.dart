// HC-T22 / US-13-2, US-13-3, REQ-SEC-103 (TRD §7.1): destruction = delete the key FIRST (crypto-shred),
// then close the handle and delete the DB file + -wal/-shm. A key-delete failure aborts before any file is touched.
import 'dart:io';

import 'cache_db.dart';
import 'keys.dart';
import 'outbox_db.dart';

class DbWipe {
  DbWipe({required this.dir, required this.keys});
  final Directory dir;
  final DbKeys keys;

  Future<void> destroyCache({CacheDb? open}) => _destroy('cache.db', keys.deleteCacheKey, open);
  Future<void> destroyOutbox({OutboxDb? open}) => _destroy('outbox.db', keys.deleteOutboxKey, open);

  /// Cache (key, files) completely, THEN outbox (key, files).
  Future<void> destroyAll({CacheDb? cache, OutboxDb? outbox}) async {
    await destroyCache(open: cache);
    await destroyOutbox(open: outbox);
  }

  Future<void> _destroy(String base, Future<void> Function() deleteKey, dynamic open) async {
    await deleteKey();
    // Closing checkpoints the WAL, so the WAL/SHM still exist at key-delete time and are removed here.
    try {
      await open?.close();
    } catch (_) {
      // best effort: the key is already shredded, files are deleted below regardless
    }
    for (final suffix in const ['-wal', '-shm', '']) {
      final f = File('${dir.path}/$base$suffix');
      if (f.existsSync()) f.deleteSync();
    }
  }
}
