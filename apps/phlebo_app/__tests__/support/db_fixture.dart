// HC-T22 test support: in-memory SecureKeyStore fake + temp-dir / raw-byte helpers. Synthetic data only.
import 'dart:convert';
import 'dart:io';

import 'package:phlebo_app/core/db/keys.dart';

/// Stands in for flutter_secure_storage (Keystore/Keychain). Records every call and can observe the disk at delete time.
class FakeKeyStore implements SecureKeyStore {
  final Map<String, String> data = {};
  final List<String> events = [];

  /// Called (before the key is removed) with the storage key name — tests snapshot the file system here.
  void Function(String name)? onDelete;

  /// When set, delete() throws this instead of deleting.
  Object? failDeleteWith;

  @override
  Future<String?> read(String key) async => data[key];

  @override
  Future<void> write(String key, String value) async {
    events.add('write:$key');
    data[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    events.add('delete:$key');
    onDelete?.call(key);
    if (failDeleteWith != null) throw failDeleteWith!;
    data.remove(key);
  }
}

const cacheKeyName = 'phlebo.cache_db_key'; // 05-SCHEMA B.3
const outboxKeyName = 'phlebo.outbox_db_key';

Directory newTempDir() => Directory.systemTemp.createTempSync('hc_t22_');

void deleteQuietly(Directory d) {
  try {
    if (d.existsSync()) d.deleteSync(recursive: true);
  } catch (_) {}
}

/// "SQLite format 3\0" — the 16-byte header of a plaintext SQLite file.
final List<int> sqlitePlainMagic = [...ascii.encode('SQLite format 3'), 0];

bool hasPlainSqliteHeader(File f) {
  if (!f.existsSync()) return false;
  final raf = f.openSync();
  try {
    final head = raf.readSync(16);
    if (head.length < 16) return false;
    for (var i = 0; i < 16; i++) {
      if (head[i] != sqlitePlainMagic[i]) return false;
    }
    return true;
  } finally {
    raf.closeSync();
  }
}

bool containsBytes(List<int> hay, List<int> needle) {
  if (needle.isEmpty) return true;
  outer:
  for (var i = 0; i + needle.length <= hay.length; i++) {
    for (var j = 0; j < needle.length; j++) {
      if (hay[i + j] != needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/// Every byte of every file under [d] (db, -wal, -shm, anything else the app left there).
List<int> allBytes(Directory d) => [
      for (final f in d.listSync(recursive: true).whereType<File>()) ...f.readAsBytesSync(),
    ];

/// Whether any file under [d] contains the UTF-8 [needle] (also checks UTF-16LE, the other way text could be stored).
bool sandboxContains(Directory d, String needle) {
  final bytes = allBytes(d);
  final utf16 = [for (final u in needle.codeUnits) ...[u & 0xff, u >> 8]];
  return containsBytes(bytes, utf8.encode(needle)) || containsBytes(bytes, utf16);
}

final RegExp hex64 = RegExp(r'^[0-9a-f]{64}$');
