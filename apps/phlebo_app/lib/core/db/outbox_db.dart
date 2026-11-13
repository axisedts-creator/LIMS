// HC-T22: outbox.db — durable mutation log (05-SCHEMA B.2), SQLCipher key phlebo.outbox_db_key.
import 'dart:io';

import 'encrypted_db.dart';
import 'keys.dart';

class OutboxDb extends EncryptedDb {
  OutboxDb._(super.file, super.db);

  static Future<OutboxDb> open({required Directory dir, required DbKeys keys}) async {
    final f = File('${dir.path}/outbox.db');
    return OutboxDb._(f, EncryptedDb.openRaw(f, await keys.getOrCreateOutboxKey()));
  }
}
