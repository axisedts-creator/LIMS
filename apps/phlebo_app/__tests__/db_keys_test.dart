// HC-T22 / REQ-SEC-102, REQ-SEC-103 — TRD §7.1, 05-SCHEMA B.3: DB keys live ONLY in secure storage.
//   32 random bytes as hex (64 lowercase hex chars), `phlebo.cache_db_key` / `phlebo.outbox_db_key`, generated with Random.secure(),
//   a NEW key for every new cache (B.3 "every cache destruction (new key per new cache)").
//
// ASSUMED API (package:phlebo_app/core/db/keys.dart):
//   abstract interface class SecureKeyStore { Future<String?> read(String key); Future<void> write(String key, String value); Future<void> delete(String key); }
//     // production adapter wraps flutter_secure_storage; tests use support/db_fixture.dart FakeKeyStore
//   class DbKeys {
//     DbKeys(SecureKeyStore store);
//     Future<String> getOrCreateCacheKey();    // returns stored key, else generates + stores one
//     Future<String> getOrCreateOutboxKey();
//     Future<void> deleteCacheKey();           // removes ONLY phlebo.cache_db_key
//     Future<void> deleteOutboxKey();          // removes ONLY phlebo.outbox_db_key
//   }
import 'package:flutter_test/flutter_test.dart';
import 'package:phlebo_app/core/db/keys.dart';

import 'support/db_fixture.dart';

void main() {
  test('cache key: 64 lowercase hex chars, persisted under phlebo.cache_db_key, stable across calls', () async {
    final store = FakeKeyStore();
    final keys = DbKeys(store);
    final k1 = await keys.getOrCreateCacheKey();
    expect(k1, matches(hex64));
    expect(store.data[cacheKeyName], k1);
    expect(await keys.getOrCreateCacheKey(), k1, reason: 'second call must reuse the stored key, not rotate it');
    expect(await DbKeys(store).getOrCreateCacheKey(), k1, reason: 'a fresh DbKeys over the same store sees the same key');
  });

  test('outbox key: 64 hex chars under phlebo.outbox_db_key, different from the cache key', () async {
    final store = FakeKeyStore();
    final keys = DbKeys(store);
    final c = await keys.getOrCreateCacheKey();
    final o = await keys.getOrCreateOutboxKey();
    expect(o, matches(hex64));
    expect(store.data[outboxKeyName], o);
    expect(o, isNot(c), reason: 'two DBs, two independent keys (cache purge must not touch the outbox key)');
  });

  test('keys are random: 25 independent generations give 25 distinct keys, none degenerate', () async {
    final seen = <String>{};
    for (var i = 0; i < 25; i++) {
      final k = await DbKeys(FakeKeyStore()).getOrCreateCacheKey();
      expect(k, matches(hex64));
      expect(RegExp(r'^(.)\1{63}$').hasMatch(k), isFalse, reason: 'all-same-char key = broken RNG');
      seen.add(k);
    }
    expect(seen.length, 25);
  });

  test('deleteCacheKey removes only the cache key; next getOrCreate makes a NEW key (new key per new cache)', () async {
    final store = FakeKeyStore();
    final keys = DbKeys(store);
    final c1 = await keys.getOrCreateCacheKey();
    final o1 = await keys.getOrCreateOutboxKey();
    await keys.deleteCacheKey();
    expect(store.data.containsKey(cacheKeyName), isFalse);
    expect(store.data[outboxKeyName], o1, reason: 'outbox key survives a cache purge (US-13-3)');
    final c2 = await keys.getOrCreateCacheKey();
    expect(c2, matches(hex64));
    expect(c2, isNot(c1), reason: 'a destroyed key must never come back');
  });

  test('deleteOutboxKey removes only the outbox key', () async {
    final store = FakeKeyStore();
    final keys = DbKeys(store);
    final c = await keys.getOrCreateCacheKey();
    await keys.getOrCreateOutboxKey();
    await keys.deleteOutboxKey();
    expect(store.data.containsKey(outboxKeyName), isFalse);
    expect(store.data[cacheKeyName], c);
  });

  test('deleting an absent key is not an error (purge triggers fire repeatedly)', () async {
    final keys = DbKeys(FakeKeyStore());
    await keys.deleteCacheKey();
    await keys.deleteOutboxKey();
  });

  test('a store failure on delete surfaces (crypto-shred must never silently "succeed")', () async {
    final store = FakeKeyStore()..failDeleteWith = StateError('keystore unavailable');
    final keys = DbKeys(store);
    await keys.getOrCreateCacheKey();
    await expectLater(keys.deleteCacheKey(), throwsA(isA<StateError>()));
  });
}
