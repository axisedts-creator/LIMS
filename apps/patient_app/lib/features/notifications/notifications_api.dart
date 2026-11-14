// E45 listMyNotifications, E46 markMyNotificationsRead (TRD §5; US-EN-11.1-11.3). Each call returns the decoded wire JSON exactly as
// contracts/openapi/engagement.yaml defines it and throws LimsException. Nothing here stores or logs notification content.
import '../../core/api/api_client_factory.dart';

abstract interface class NotificationsApi {
  /// E45: newest first; `unreadOnly` is sent only when true, `cursor` / `limit` only when given.
  Future<Object?> listMyNotifications({bool unreadOnly = false, String? cursor, int? limit});

  /// E46: one answer per id (`updated` | `not_found`); an id that is not the caller's is `not_found`, never an error.
  Future<Object?> markMyNotificationsRead({required List<String> ids});
}

/// [NotificationsApi] over the app transport (version headers, request id and 426 handling are added there).
class TransportNotificationsApi implements NotificationsApi {
  TransportNotificationsApi({required PatientTransport transport}) : _t = transport;

  final PatientTransport _t;
  static const _base = '/v1/engagement/me/notifications';

  @override
  Future<Object?> listMyNotifications({bool unreadOnly = false, String? cursor, int? limit}) {
    final query = <String, Object?>{if (unreadOnly) 'unread_only': true, 'cursor': ?cursor, 'limit': ?limit};
    return query.isEmpty ? _t('GET', _base) : _t('GET', _base, query: query);
  }

  @override
  Future<Object?> markMyNotificationsRead({required List<String> ids}) => _t('POST', '$_base/bulk-mark-read', body: {'ids': ids});
}
