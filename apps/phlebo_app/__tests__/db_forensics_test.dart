// HC-T22 forensic test — REQ-SEC-103, 07-SECURITY §5 item 7, plan row HC-T22:
//   "file header != 'SQLite format 3'; reopening after key deletion fails" (WAL/SHM removal is in db_wipe_test.dart).
// Runs the REAL cache.db / outbox.db implementation (drift + SQLCipher/SQLite3MultipleCiphers hook) on the host.
// Synthetic patient strings only.
//
// ASSUMED API (package:phlebo_app/core/db/{cache_db,outbox_db}.dart) — same shape for both:
//   class CacheDb {                       // file: <dir>/cache.db      (class OutboxDb: <dir>/outbox.db)
//     static Future<CacheDb> open({required Directory dir, required DbKeys keys});
//        // gets-or-creates the key via keys, opens with PRAGMA key = "x'<64 hex>'", journal_mode=WAL, foreign_keys=ON.
//        // Throws (any exception) when the file exists but the key is wrong/missing — never falls back to plaintext.
//     File get file;
//     Future<void> execute(String sql, [List<Object?> args = const []]);
//     Future<List<Map<String, Object?>>> select(String sql, [List<Object?> args = const []]);
//     Future<void> close();               // checkpoints + closes
//   }
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:phlebo_app/core/db/cache_db.dart';
import 'package:phlebo_app/core/db/keys.dart';
import 'package:phlebo_app/core/db/outbox_db.dart';

import 'support/db_fixture.dart';

// Synthetic PHI planted in the cache (names/phones/addresses live only there, TRD §7.1) and PHI-free outbox data.
const _name = 'Zzyxqa Synthetic-Patient Quuxbert';
const _phone = '+9779800000123';
const _address = 'Synthetic Lane 42, Zzyx Tole';
const _barcode = 'ZZBC-7731-QX'; // outbox holds barcodes, no names

class _Store {
  _Store(this.label, this.fileName, this.open, this.keyName, this.needles);
  final String label;
  final String fileName;
  final Future<dynamic> Function(Directory, DbKeys) open;
  final String keyName;
  final List<String> needles;
}

final _stores = [
  _Store('cache.db', 'cache.db', (d, k) => CacheDb.open(dir: d, keys: k), cacheKeyName, [_name, _phone, _address]),
  _Store('outbox.db', 'outbox.db', (d, k) => OutboxDb.open(dir: d, keys: k), outboxKeyName, [_barcode, 'ZZ-GPS-27.7172,85.3240']),
];

Future<void> _plant(dynamic db, _Store s) async {
  await db.execute('CREATE TABLE forensic_probe (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
  await db.execute('BEGIN');
  for (var r = 0; r < 40; r++) {
    for (final n in s.needles) {
      await db.execute('INSERT INTO forensic_probe (v) VALUES (?)', ['$n #$r']);
    }
  }
  await db.execute('COMMIT');
}

void main() {
  late Directory dir;
  late FakeKeyStore store;
  late DbKeys keys;
  setUp(() {
    dir = newTempDir();
    store = FakeKeyStore();
    keys = DbKeys(store);
  });
  tearDown(() => deleteQuietly(dir));

  for (final s in _stores) {
    group(s.label, () {
      test('opens with its key; data written is read back after close + reopen with the same key', () async {
        final db = await s.open(dir, keys);
        await _plant(db, s);
        final rows = await db.select('SELECT count(*) AS n FROM forensic_probe');
        expect(rows.single['n'], 40 * s.needles.length);
        await db.close();

        final again = await s.open(dir, DbKeys(store)); // new handle, key from secure storage
        final back = await again.select('SELECT v FROM forensic_probe ORDER BY id LIMIT 1');
        expect(back.single['v'], '${s.needles.first} #0');
        await again.close();
      });

      test('pragmas (05-SCHEMA Part B): journal_mode=wal, foreign_keys=1', () async {
        final db = await s.open(dir, keys);
        final jm = await db.select('PRAGMA journal_mode');
        expect(jm.single.values.single.toString().toLowerCase(), 'wal');
        final fk = await db.select('PRAGMA foreign_keys');
        expect(fk.single.values.single, 1);
        await db.close();
      });

      test('FORENSIC: file header is not "SQLite format 3" (open handle AND after close)', () async {
        final db = await s.open(dir, keys);
        await _plant(db, s);
        final f = File('${dir.path}/${s.fileName}');
        expect(f.existsSync(), isTrue);
        expect(hasPlainSqliteHeader(f), isFalse, reason: 'header while open');
        await db.close();
        expect(f.lengthSync(), greaterThanOrEqualTo(16), reason: 'after close/checkpoint the file holds real pages');
        expect(hasPlainSqliteHeader(f), isFalse, reason: 'header after close = plaintext SQLite (REQ-SEC-103 broken)');
      });

      test('FORENSIC: no plaintext PHI/barcode/GPS anywhere in the sandbox — db, -wal, -shm (while open and after close)', () async {
        final db = await s.open(dir, keys);
        await _plant(db, s);
        // proof the data is really there (so absence below is meaningful, not an empty DB)
        final n = await db.select('SELECT count(*) AS n FROM forensic_probe WHERE v LIKE ?', ['${s.needles.first}%']);
        expect(n.single['n'], 40);
        for (final needle in s.needles) {
          expect(sandboxContains(dir, needle), isFalse, reason: 'plaintext "$needle" on disk while open (WAL included)');
        }
        await db.close();
        for (final needle in s.needles) {
          expect(sandboxContains(dir, needle), isFalse, reason: 'plaintext "$needle" on disk after close');
        }
      });

      test('FORENSIC: the DB key itself never lands on disk (only in secure storage, then PRAGMA key)', () async {
        final db = await s.open(dir, keys);
        await _plant(db, s);
        await db.close();
        final key = store.data[s.keyName];
        expect(key, isNotNull);
        expect(key, matches(hex64));
        expect(sandboxContains(dir, key!), isFalse, reason: 'key hex found in the app sandbox');
      });

      test('opening with a different key fails, and does not damage the file for the right key', () async {
        final db = await s.open(dir, keys);
        await _plant(db, s);
        await db.close();
        final before = File('${dir.path}/${s.fileName}').readAsBytesSync();

        final wrong = DbKeys(FakeKeyStore()); // empty store -> would generate a different key
        await expectLater(s.open(dir, wrong), throwsA(anything), reason: 'wrong key must not open (and must not silently re-create)');
        expect(File('${dir.path}/${s.fileName}').readAsBytesSync(), before, reason: 'wrong-key attempt must not rewrite the file');

        final ok = await s.open(dir, DbKeys(store));
        expect((await ok.select('SELECT count(*) AS n FROM forensic_probe')).single['n'], 40 * s.needles.length);
        await ok.close();
      });

      test('reopening after KEY deletion fails (crypto-shred leaves the file unreadable)', () async {
        final db = await s.open(dir, keys);
        await _plant(db, s);
        await db.close();
        expect(File('${dir.path}/${s.fileName}').existsSync(), isTrue);

        // key gone, file still there (e.g. app killed between the two destroy steps)
        store.data.remove(s.keyName);
        await expectLater(s.open(dir, DbKeys(store)), throwsA(anything),
            reason: 'with the key shredded the old file must stay unreadable — a fresh random key cannot open it');
      });
    });
  }

  test('cache.db and outbox.db are encrypted under independent keys (one key cannot open the other file)', () async {
    final c = await CacheDb.open(dir: dir, keys: keys);
    final o = await OutboxDb.open(dir: dir, keys: keys);
    await c.execute('CREATE TABLE t (v TEXT)');
    await o.execute('CREATE TABLE t (v TEXT)');
    await c.close();
    await o.close();
    expect(store.data[cacheKeyName], isNot(store.data[outboxKeyName]));
    // swap: put the outbox key in the cache slot -> cache.db must not open
    store.data[cacheKeyName] = store.data[outboxKeyName]!;
    await expectLater(CacheDb.open(dir: dir, keys: DbKeys(store)), throwsA(anything));
  });
}
