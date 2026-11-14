// HC-T22: cache.db — purgeable read-only snapshot (05-SCHEMA B.1), SQLCipher key phlebo.cache_db_key.
import 'dart:io';

import 'encrypted_db.dart';
import 'keys.dart';

class CacheDb extends EncryptedDb {
  CacheDb._(super.file, super.db);

  static Future<CacheDb> open({required Directory dir, required DbKeys keys}) async {
    final f = File('${dir.path}/cache.db');
    return CacheDb._(f, EncryptedDb.openRaw(f, await keys.getOrCreateCacheKey()));
  }
}
