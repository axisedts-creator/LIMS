// E22 listMyReports / E23 downloadMyReport over the app transport (02-TRD §5; 04-UI-UX A12/A13). E22 returns decoded wire JSON; E23 returns the PDF bytes. Both throw LimsException.
// The app never sees a Storage URL (REQ-SEC-034/035): bytes only through the API. Nothing here logs or stores PHI (02-CV 9.2, REQ-SEC-103).
import 'dart:typed_data';

import 'package:lims_shared/lims_shared.dart';

import '../../core/api/api_client_factory.dart';

abstract interface class PatientReportsApi {
  /// E22: `{data:[PatientReport], page:{next_cursor?, limit}}`.
  Future<Object?> listReports({String? profileId, String? orderId, bool includeSuperseded = false, String? cursor, int? limit});

  /// E23: the PDF bytes of one report version.
  Future<Uint8List> downloadReport({required String reportId, required int versionNo});
}

final _uuid = RegExp(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$');

class TransportPatientReportsApi implements PatientReportsApi {
  TransportPatientReportsApi({required PatientTransport transport}) : _t = transport;

  final PatientTransport _t;

  @override
  Future<Object?> listReports({String? profileId, String? orderId, bool includeSuperseded = false, String? cursor, int? limit}) => _t('GET', '/v1/engagement/me/reports', query: {
        if (profileId != null) 'profile_id': profileId,
        if (orderId != null) 'order_id': orderId,
        if (includeSuperseded) 'include_superseded': true,
        if (cursor != null) 'cursor': cursor,
        if (limit != null) 'limit': limit,
      });

  /// [CONV] The transport typedef carries no binary: the generated client (CR-C16-016) must hand back the raw `application/pdf` body as a [Uint8List]; anything else is an internal failure.
  @override
  Future<Uint8List> downloadReport({required String reportId, required int versionNo}) async {
    if (!_uuid.hasMatch(reportId) || versionNo < 1 || versionNo > 9999) throw LimsException(LimsErrorCodes.commonNotFound); // never build a path from anything but a UUID + version
    final body = await _t('GET', '/v1/engagement/me/reports/$reportId/versions/$versionNo/file', headers: {'Accept': 'application/pdf'});
    if (body is Uint8List) return body;
    throw LimsException(LimsErrorCodes.commonInternal);
  }
}
