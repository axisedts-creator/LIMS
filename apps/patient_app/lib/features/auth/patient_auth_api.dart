// Pre-auth engagement calls (TRD §5 E1 getPatientAppConfig, E2 requestPatientOtp, E3 verifyPatientOtp; TRD §4.2 credentials).
// Each call returns the decoded wire JSON exactly as contracts/openapi/engagement.yaml defines it and throws LimsException.
// Nothing here logs or stores the phone number, the code or any token (02-CV 9.2, REQ-SEC-103).
import 'package:lims_shared/lims_shared.dart';

import '../../core/api/api_client_factory.dart';

/// `429`: [retryAfter] is the Retry-After value when the transport could read it, null otherwise.
class RateLimitedException extends LimsException {
  RateLimitedException([this.retryAfter]) : super(LimsErrorCodes.commonRateLimited);

  final Duration? retryAfter;
}

abstract interface class PatientAuthApi {
  /// E1.
  Future<Object?> getAppConfig();

  /// E2: `phoneE164` must already match `^\+[1-9][0-9]{7,14}$`.
  Future<Object?> requestOtp({required String phoneE164});

  /// E3: `challengeToken` is the E2 token (credential `c.<tenant_code>.<token>`), `code` is 6 digits.
  Future<Object?> verifyOtp({required String challengeToken, required String code});
}

/// [PatientAuthApi] over the app transport (version headers, request id and 426 handling are added there).
class TransportPatientAuthApi implements PatientAuthApi {
  TransportPatientAuthApi({
    required PatientTransport transport,
    required this.tenantCode,
    required this.platform,
    String Function()? newInstanceId,
  })  : _t = transport,
        _instanceId = (newInstanceId ?? uuidv7)();

  static const _preAuth = 'X-Lims-Patient-PreAuth';

  final PatientTransport _t;
  final String tenantCode;
  final String platform; // android | ios

  /// `app_instance_id`: random per process, memory only (nothing else may be persisted, REQ-SEC-103).
  final String _instanceId;

  @override
  Future<Object?> getAppConfig() => _t('GET', '/v1/engagement/app/config', headers: {_preAuth: 't.$tenantCode'});

  @override
  Future<Object?> requestOtp({required String phoneE164}) => _t(
        'POST',
        '/v1/engagement/auth/otp-challenges',
        headers: {_preAuth: 't.$tenantCode'},
        body: {'phone_e164': phoneE164, 'app_instance_id': _instanceId, 'app_platform': platform},
      );

  @override
  Future<Object?> verifyOtp({required String challengeToken, required String code}) => _t(
        'POST',
        '/v1/engagement/auth/otp-challenges/verify',
        headers: {_preAuth: 'c.$tenantCode.$challengeToken'},
        body: {'code': code},
      );
}
