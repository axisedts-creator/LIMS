// T-P4 — E24 over the app transport (02-TRD §5 E24: GET /v1/engagement/me/reports/{report_id}/versions/{version_no}/smart-summary; contract SmartSummaryView). Synthetic data only.
// The path is built only from a UUID and a version 1..9999 (never from any other string); the answer is handed back undecoded; errors propagate as they are (the screen maps them).
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:patient_app/features/reports/smart/smart_summary_api.dart';

import '../../support/smart_fakes.dart';

typedef Call = ({String method, String path, Map<String, Object?>? query, Map<String, String>? headers, Object? body});

void main() {
  late List<Call> calls;
  late Future<Object?> Function(Call) answer;
  late PatientSmartSummaryApi api;

  setUp(() {
    calls = [];
    answer = (_) async => summaryBody();
    api = TransportPatientSmartSummaryApi(transport: (method, path, {query, headers, body}) {
      final c = (method: method, path: path, query: query, headers: headers, body: body);
      calls.add(c);
      return answer(c);
    });
  });

  test('GET on the E24 path with the report id and version; no body, no query; the decoded answer is returned as is', () async {
    final body = summaryBody(version: 3);
    answer = (_) async => body;
    final out = await api.getSmartSummary(reportId: smartReportId, versionNo: 3);
    expect(out, same(body));
    expect(calls, hasLength(1));
    expect(calls.single.method, 'GET');
    expect(calls.single.path, '/v1/engagement/me/reports/$smartReportId/versions/3/smart-summary');
    expect(calls.single.body, isNull);
    expect(calls.single.query ?? const {}, isEmpty);
  });

  test('an id that is not a UUID or a version outside 1..9999 never reaches the transport: LimsException common.not_found', () async {
    for (final (id, v) in [
      ('not-a-uuid', 1),
      ('../../me/orders', 1),
      ('$smartReportId/../x', 1),
      ('$smartReportId?x=1', 1),
      ('', 1),
      (smartReportId, 0),
      (smartReportId, -1),
      (smartReportId, 10000),
    ]) {
      await expectLater(api.getSmartSummary(reportId: id, versionNo: v), throwsA(isA<LimsException>().having((e) => e.code, 'code', LimsErrorCodes.commonNotFound)), reason: '$id / $v');
    }
    expect(calls, isEmpty);
  });

  test('transport errors propagate unchanged (LimsException keeps its code)', () async {
    answer = (_) => throw LimsException(LimsErrorCodes.commonNotFound);
    await expectLater(api.getSmartSummary(reportId: smartReportId, versionNo: 1), throwsA(isA<LimsException>().having((e) => e.code, 'code', LimsErrorCodes.commonNotFound)));
    answer = (_) => throw LimsException(LimsErrorCodes.commonRateLimited);
    await expectLater(api.getSmartSummary(reportId: smartReportId, versionNo: 1), throwsA(isA<LimsException>().having((e) => e.code, 'code', LimsErrorCodes.commonRateLimited)));
  });

  test('the version bounds 1 and 9999 are accepted', () async {
    await api.getSmartSummary(reportId: smartReportId, versionNo: 1);
    await api.getSmartSummary(reportId: smartReportId, versionNo: 9999);
    expect(calls.map((c) => c.path.split('/versions/').last), ['1/smart-summary', '9999/smart-summary']);
  });
}
