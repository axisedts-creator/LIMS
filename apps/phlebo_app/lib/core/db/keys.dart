// HC-T22 / REQ-SEC-102, REQ-SEC-103 (TRD §7.1, 05-SCHEMA B.3): DB keys live ONLY in secure storage.
import 'dart:math';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

const cacheDbKeyName = 'phlebo.cache_db_key';
const outboxDbKeyName = 'phlebo.outbox_db_key';

abstract interface class SecureKeyStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

/// Production adapter over Keystore/Keychain.
class FlutterSecureKeyStore implements SecureKeyStore {
  FlutterSecureKeyStore([FlutterSecureStorage? s]) : _s = s ?? const FlutterSecureStorage();
  final FlutterSecureStorage _s;

  @override
  Future<String?> read(String key) => _s.read(key: key);
  @override
  Future<void> write(String key, String value) => _s.write(key: key, value: value);
  @override
  Future<void> delete(String key) => _s.delete(key: key);
}

class DbKeys {
  DbKeys(this._store);
  final SecureKeyStore _store;

  Future<String> getOrCreateCacheKey() => _getOrCreate(cacheDbKeyName);
  Future<String> getOrCreateOutboxKey() => _getOrCreate(outboxDbKeyName);
  Future<void> deleteCacheKey() => _store.delete(cacheDbKeyName);
  Future<void> deleteOutboxKey() => _store.delete(outboxDbKeyName);

  /// Stored key, else 32 `Random.secure()` bytes as 64 lowercase hex chars (persisted before return).
  Future<String> _getOrCreate(String name) async {
    final existing = await _store.read(name);
    if (existing != null) return existing;
    final rng = Random.secure();
    final key = [for (var i = 0; i < 32; i++) rng.nextInt(256).toRadixString(16).padLeft(2, '0')].join();
    await _store.write(name, key);
    return key;
  }
}
