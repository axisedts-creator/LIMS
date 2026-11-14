// REQ-SEC-102: the session token is the only thing the app persists, and only in platform secure storage.
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class SessionStore {
  const SessionStore(this._storage);

  static const key = 'lims.patient.session_token';

  final FlutterSecureStorage _storage;

  Future<String?> read() => _storage.read(key: key);
  Future<void> write(String sessionToken) => _storage.write(key: key, value: sessionToken);
  Future<void> wipe() => _storage.delete(key: key);
}
