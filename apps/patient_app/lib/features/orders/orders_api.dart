// E20 listMyOrders / E21 getMyOrder over the app transport (02-TRD §5; 04-UI-UX A10/A11). Returns decoded wire JSON; throws LimsException.
// [CONV] E21 with If-None-Match: the transport answers `null` for a bodiless 304 (the transport typedef carries no status / headers). Nothing here logs or stores PHI (02-CV 9.2, REQ-SEC-103).
import 'package:lims_shared/lims_shared.dart';

import '../../core/api/api_client_factory.dart';

abstract interface class PatientOrdersApi {
  /// E20: `{data:[PatientOrder], page:{next_cursor?, limit}}`.
  Future<Object?> listOrders({String? profileId, String? stage, String? cursor, int? limit});

  /// E21: the decoded PatientOrderDetail, or `null` when the server answered 304 (the order is unchanged since [ifNoneMatch]).
  Future<Object?> getOrder({required String orderId, String? ifNoneMatch});
}

final _uuid = RegExp(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$');

class TransportPatientOrdersApi implements PatientOrdersApi {
  TransportPatientOrdersApi({required PatientTransport transport}) : _t = transport;

  final PatientTransport _t;

  @override
  Future<Object?> listOrders({String? profileId, String? stage, String? cursor, int? limit}) => _t('GET', '/v1/engagement/me/orders', query: {
        if (profileId != null) 'profile_id': profileId,
        if (stage != null) 'stage': stage,
        if (cursor != null) 'cursor': cursor,
        if (limit != null) 'limit': limit,
      });

  @override
  Future<Object?> getOrder({required String orderId, String? ifNoneMatch}) {
    if (!_uuid.hasMatch(orderId)) throw LimsException(LimsErrorCodes.commonNotFound); // never build a path from anything but a UUID
    return _t('GET', '/v1/engagement/me/orders/$orderId', headers: {if (ifNoneMatch != null) 'If-None-Match': ifNoneMatch});
  }
}
