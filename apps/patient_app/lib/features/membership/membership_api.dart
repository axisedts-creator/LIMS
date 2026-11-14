// E47 listMyMemberships (TRD §5; US-EN-17.3). Returns the decoded wire JSON `{data: [MembershipCard...]}` exactly as contracts/openapi/engagement.yaml defines it
// and throws LimsException. Nothing here logs or stores the card number or the card token (07-SECURITY "Membership card QR").
import '../../core/api/api_client_factory.dart';

abstract interface class MembershipApi {
  /// E47: the cards of the signed-in account's active profiles.
  Future<Object?> listMyMemberships();
}

/// [MembershipApi] over the app transport (version headers, request id and 426 handling are added there).
class TransportMembershipApi implements MembershipApi {
  TransportMembershipApi({required PatientTransport transport}) : _t = transport;

  final PatientTransport _t;

  @override
  Future<Object?> listMyMemberships() => _t('GET', '/v1/engagement/me/memberships');
}
