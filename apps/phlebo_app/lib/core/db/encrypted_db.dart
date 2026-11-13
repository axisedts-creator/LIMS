// HC-T22: shared SQLCipher-keyed handle for cache.db / outbox.db (05-SCHEMA Part B). Never falls back to plaintext.
import 'dart:io';

import 'package:sqlite3/sqlite3.dart';

class EncryptedDb {
  EncryptedDb(this.file, this._db);
  final File file;
  final Database _db;
  bool _closed = false;

  /// Opens [file] keyed with `PRAGMA key = "x'<64 hex>'"`. Throws if the key is wrong (a keyed read of sqlite_master fails).
  static Database openRaw(File file, String hexKey) {
    if (!RegExp(r'^[0-9a-f]{64}$').hasMatch(hexKey)) throw ArgumentError('DB key must be 64 lowercase hex chars');
    final db = sqlite3.open(file.path);
    try {
      db.execute('PRAGMA key = "x\'$hexKey\'"');
      db.select('SELECT count(*) FROM sqlite_master'); // wrong/missing key -> "file is not a database"
      db.execute('PRAGMA journal_mode = WAL');
      db.execute('PRAGMA foreign_keys = ON');
    } catch (_) {
      db.close();
      rethrow;
    }
    return db;
  }

  Database get _open => _closed ? throw StateError('database is closed') : _db;

  Future<void> execute(String sql, [List<Object?> args = const []]) async => _open.execute(sql, args);

  Future<List<Map<String, Object?>>> select(String sql, [List<Object?> args = const []]) async =>
      [for (final r in _open.select(sql, args)) Map<String, Object?>.of(r)];

  /// Checkpoints (removes WAL/SHM) and closes; idempotent.
  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    try {
      _db.execute('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      _db.close();
    }
  }
}
