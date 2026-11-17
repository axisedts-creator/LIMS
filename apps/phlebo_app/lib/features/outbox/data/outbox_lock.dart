// HC-T24: one FIFO lock per open outbox connection. The sqlite3 calls are synchronous but each `await` between BEGIN and
// COMMIT lets another task run, so every multi-statement write (and every anchor insert) takes this lock.
import '../../../core/db/outbox_db.dart';

class OutboxLock {
  Future<void> _tail = Future<void>.value();

  Future<T> run<T>(Future<T> Function() body) {
    final result = _tail.then((_) => body());
    _tail = result.then((_) {}, onError: (_) {});
    return result;
  }
}

final Expando<OutboxLock> _locks = Expando<OutboxLock>('outbox-lock');

OutboxLock outboxLockFor(OutboxDb db) => _locks[db] ??= OutboxLock();

/// BEGIN IMMEDIATE … COMMIT (ROLLBACK on any error). Caller must already hold the lock.
Future<T> inTransaction<T>(OutboxDb db, Future<T> Function() body) async {
  await db.execute('BEGIN IMMEDIATE');
  try {
    final v = await body();
    await db.execute('COMMIT');
    return v;
  } catch (_) {
    try {
      await db.execute('ROLLBACK');
    } catch (_) {}
    rethrow;
  }
}
