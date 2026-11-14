// E24 getMySmartSummary over the app transport (02-TRD §5 E24; contract SmartSummaryView). The app only knows E24 (08 A2.3): the summary is the approved
// snapshot the server stored; nothing here logs or stores it (02-CV 9.2, REQ-SEC-103). Errors propagate unchanged as LimsException.
import 'package:lims_shared/lims_shared.dart';

import '../../../core/api/api_client_factory.dart';

abstract interface class PatientSmartSummaryApi {
  /// E24: decoded SmartSummaryView. `common.not_found` = nothing approved for this version, or hidden.
  Future<Object?> getSmartSummary({required String reportId, required int versionNo});
}

final _uuid = RegExp(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$');

class TransportPatientSmartSummaryApi implements PatientSmartSummaryApi {
  TransportPatientSmartSummaryApi({required PatientTransport transport}) : _t = transport;

  final PatientTransport _t;

  @override
  Future<Object?> getSmartSummary({required String reportId, required int versionNo}) async {
    if (!_uuid.hasMatch(reportId) || versionNo < 1 || versionNo > 9999) throw LimsException(LimsErrorCodes.commonNotFound); // path only from a UUID + version
    return _t('GET', '/v1/engagement/me/reports/$reportId/versions/$versionNo/smart-summary');
  }
}
