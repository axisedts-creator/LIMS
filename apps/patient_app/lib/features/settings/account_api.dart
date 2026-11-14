// E10 getMyAccount, E11 updateMyAccount, E12 deleteMyAccount (TRD §5; US-EN-19.1, 23.3). Each call returns the decoded wire JSON exactly as contracts/openapi/engagement.yaml
// defines it and throws LimsException. E11 / E12 send If-Match "<version>"; E12 needs an Idempotency-Key (x-idempotency: required), fresh per call so a retry is a new request.
// The path is the fixed /me form: no account id, phone or other personal value is ever in a URL.
import 'package:lims_shared/lims_shared.dart';

import '../../core/api/api_client_factory.dart';

abstract interface class AccountApi {
  /// E10: the caller's Account.
  Future<Object?> getMyAccount();

  /// E11: `{reminders_opt_out}` only; returns the updated Account.
  Future<Object?> updateMyAccount({required int version, required bool remindersOptOut});

  /// E12: `{confirm: true}`; 204. C2 revokes every session of the account, so the caller wipes its local session without a logout call.
  Future<void> deleteMyAccount({required int version});
}

/// [AccountApi] over the app transport (version headers, request id and 426 handling are added there).
class TransportAccountApi implements AccountApi {
  TransportAccountApi({required PatientTransport transport}) : _t = transport;

  final PatientTransport _t;
  static const _me = '/v1/engagement/me';

  @override
  Future<Object?> getMyAccount() => _t('GET', _me);

  @override
  Future<Object?> updateMyAccount({required int version, required bool remindersOptOut}) =>
      _t('PATCH', _me, headers: {'If-Match': '"$version"'}, body: {'reminders_opt_out': remindersOptOut});

  @override
  Future<void> deleteMyAccount({required int version}) async {
    await _t('POST', '$_me/delete', headers: {'If-Match': '"$version"', 'Idempotency-Key': uuidv7()}, body: {'confirm': true});
  }
}
