// E48-E51 + T3b enquiry_categories (TRD §5; US-EN-18.1-18.4). Each call returns the decoded wire JSON exactly as contracts/openapi/engagement.yaml defines it and throws LimsException.
// E49 / E51 need an Idempotency-Key (x-idempotency: required), fresh per call; E51 sends If-Match "<version>". Enquiry text is P3: never in a URL, never stored or logged here.
import 'package:lims_shared/lims_shared.dart';

import '../../core/api/api_client_factory.dart';

abstract interface class EnquiriesApi {
  /// E48: `{data: [EnquirySummary], page}`, newest first.
  Future<Object?> listMyEnquiries({String? cursor, int? limit});

  /// E49: 201 Enquiry. `profileId` (a link id) is sent only when given.
  Future<Object?> createMyEnquiry({required String categoryCode, required String subject, required String message, String? profileId});

  /// E50: Enquiry (messages oldest first, version).
  Future<Object?> getMyEnquiry({required String id});

  /// E51: Enquiry; 409 `engagement.enquiry_invalid_transition` when closed, 409 `common.version_conflict` when stale.
  Future<Object?> replyMyEnquiry({required String id, required String message, required int version});

  /// T3b: `{data: [{code, display, sort_order}]}`.
  Future<Object?> listMyCodedSet(String setName);
}

/// [EnquiriesApi] over the app transport (version headers, request id and 426 handling are added there).
class TransportEnquiriesApi implements EnquiriesApi {
  TransportEnquiriesApi({required PatientTransport transport}) : _t = transport;

  final PatientTransport _t;
  static const _base = '/v1/engagement/me/enquiries';

  Map<String, String> _idempotent() => {'Idempotency-Key': uuidv7()};

  @override
  Future<Object?> listMyEnquiries({String? cursor, int? limit}) {
    final query = <String, Object?>{'cursor': ?cursor, 'limit': ?limit};
    return query.isEmpty ? _t('GET', _base) : _t('GET', _base, query: query);
  }

  @override
  Future<Object?> createMyEnquiry({required String categoryCode, required String subject, required String message, String? profileId}) =>
      _t('POST', _base, headers: _idempotent(), body: {'category_code': categoryCode, 'subject': subject, 'message': message, 'profile_id': ?profileId});

  @override
  Future<Object?> getMyEnquiry({required String id}) => _t('GET', '$_base/${Uri.encodeComponent(id)}');

  @override
  Future<Object?> replyMyEnquiry({required String id, required String message, required int version}) =>
      _t('POST', '$_base/${Uri.encodeComponent(id)}/messages', headers: {..._idempotent(), 'If-Match': '"$version"'}, body: {'message': message});

  @override
  Future<Object?> listMyCodedSet(String setName) => _t('GET', '/v1/engagement/me/coded-sets/${Uri.encodeComponent(setName)}');
}
