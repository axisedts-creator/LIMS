// E13-E19 (TRD §5; US-EN-03 to US-EN-06). Each call returns the decoded wire JSON exactly as contracts/openapi/engagement.yaml defines it
// and throws LimsException. This file owns the paths. Nothing here logs or stores the lab code, the report link or the registration details.
// E14/E15/E16 need an Idempotency-Key (x-idempotency: required), fresh per call, so a retry after `failed` is a new request.
// E18/E19 send `If-Match: "<version>"` with Profile.version from E13 (LD-164, CR-C16-T-L6 item 1 option A).
import 'package:lims_shared/lims_shared.dart';

import '../../core/api/api_client_factory.dart';

abstract interface class ProfilesApi {
  /// E13: `{data, pending, paused_count}`.
  Future<Object?> listMyProfiles();

  /// E14: `code` is `XXXXX-XXXXX`, 10 Crockford symbols.
  Future<Object?> redeemLinkCode({required String code});

  /// E15: `linkUrl` is a portal `/r/` link.
  Future<Object?> redeemReportLink({required String linkUrl});

  /// E16: 202 SelfRegistration.
  Future<Object?> createSelfRegistration(Map<String, Object?> body);

  /// E17.
  Future<Object?> getSelfRegistration(String id);

  /// E18: change the relationship.
  Future<Object?> updateMyProfile({required String profileId, required String relationship, required int version});

  /// E19: 204.
  Future<void> removeMyProfile({required String profileId, required int version});
}

/// [ProfilesApi] over the app transport (version headers, request id and 426 handling are added there).
class TransportProfilesApi implements ProfilesApi {
  TransportProfilesApi({required PatientTransport transport}) : _t = transport;

  static const _base = '/v1/engagement/me/profiles';

  final PatientTransport _t;

  Map<String, String> _idempotent() => {'Idempotency-Key': uuidv7()};

  Map<String, String> _ifMatch(int version) => {'If-Match': '"$version"'}; // LD-164

  String _one(String id) => '$_base/${Uri.encodeComponent(id)}';

  @override
  Future<Object?> listMyProfiles() => _t('GET', _base);

  @override
  Future<Object?> redeemLinkCode({required String code}) => _t('POST', '$_base/redeem-code', headers: _idempotent(), body: {'code': code});

  @override
  Future<Object?> redeemReportLink({required String linkUrl}) =>
      _t('POST', '$_base/redeem-report-link', headers: _idempotent(), body: {'link_url': linkUrl});

  @override
  Future<Object?> createSelfRegistration(Map<String, Object?> body) => _t('POST', '$_base/self-registrations', headers: _idempotent(), body: body);

  @override
  Future<Object?> getSelfRegistration(String id) => _t('GET', '$_base/self-registrations/${Uri.encodeComponent(id)}');

  @override
  Future<Object?> updateMyProfile({required String profileId, required String relationship, required int version}) =>
      _t('PATCH', _one(profileId), headers: _ifMatch(version), body: {'relationship': relationship});

  @override
  Future<void> removeMyProfile({required String profileId, required int version}) async {
    await _t('POST', '${_one(profileId)}/remove', headers: _ifMatch(version));
  }
}
