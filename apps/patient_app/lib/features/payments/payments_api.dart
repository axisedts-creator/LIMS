// E41 createPaymentRequest / E42 getPaymentRequest over the app transport (02-TRD §5, §4.7; 04-UI-UX A15). Returns the decoded wire JSON; throws LimsException.
// REQ-SEC-046: the body carries the gateway only, never a sum. The Idempotency-Key is made by the caller (one per attempt, reused by a retry of the same choice, P-8).
// Nothing here logs or stores the payment action (it carries the gateway callback token; 02-CV 9.2, REQ-SEC-103).
import 'package:lims_shared/lims_shared.dart';

import '../../core/api/api_client_factory.dart';

abstract interface class PatientPaymentsApi {
  /// E41: 202 + the queued PaymentRequest, or 200 + the order's open one.
  Future<Object?> createPaymentRequest({required String orderId, required String gateway, required String idempotencyKey});

  /// E42: the PaymentRequest (server state only).
  Future<Object?> getPaymentRequest({required String paymentRequestId});
}

final _uuid = RegExp(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$');

class TransportPatientPaymentsApi implements PatientPaymentsApi {
  TransportPatientPaymentsApi({required PatientTransport transport}) : _t = transport;

  final PatientTransport _t;

  @override
  Future<Object?> createPaymentRequest({required String orderId, required String gateway, required String idempotencyKey}) {
    if (!_uuid.hasMatch(orderId)) throw LimsException(LimsErrorCodes.commonNotFound); // never build a path from anything but a UUID
    return _t('POST', '/v1/engagement/me/orders/$orderId/payment-requests', headers: {'Idempotency-Key': idempotencyKey}, body: {'gateway': gateway});
  }

  @override
  Future<Object?> getPaymentRequest({required String paymentRequestId}) {
    if (!_uuid.hasMatch(paymentRequestId)) throw LimsException(LimsErrorCodes.commonNotFound);
    return _t('GET', '/v1/engagement/me/payment-requests/$paymentRequestId');
  }
}
