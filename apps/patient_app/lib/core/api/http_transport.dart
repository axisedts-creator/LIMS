// LOCAL TEST WIRING (until the generated lims_api_client lands, CR-C16-016/017): the inner PatientTransport over dart:io.
// Version headers, request id, Bearer and 401/426 handling are added by buildPatientTransport (api_client_factory.dart);
// this layer only does HTTP: JSON in/out, problem+json -> LimsException, 429 -> RateLimitedException, PDF -> Uint8List.
// Nothing is logged. No request or response body is kept.
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:lims_shared/lims_shared.dart';

import '../../features/auth/patient_auth_api.dart';
import 'api_client_factory.dart';

PatientTransport buildHttpTransport({required String baseUrl, Duration timeout = const Duration(seconds: 60)}) {
  final base = Uri.parse(baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl);
  final client = HttpClient()..connectionTimeout = const Duration(seconds: 15);

  return (method, path, {query, headers, body}) async {
    final q = <String, String>{
      for (final e in (query ?? const <String, Object?>{}).entries)
        if (e.value != null) e.key: '${e.value}',
    };
    final uri = base.replace(path: '${base.path}$path', queryParameters: q.isEmpty ? null : q);
    final req = await client.openUrl(method, uri).timeout(timeout);
    final wantsPdf = (headers ?? const {}).entries.any((h) => h.key.toLowerCase() == 'accept' && h.value.contains('application/pdf'));
    req.headers.set(HttpHeaders.acceptHeader, wantsPdf ? 'application/pdf' : 'application/json');
    headers?.forEach((k, v) {
      if (k.toLowerCase() != 'accept') req.headers.set(k, v);
    });
    if (body != null) {
      req.headers.contentType = ContentType.json;
      req.add(utf8.encode(jsonEncode(body)));
    }
    final res = await req.close().timeout(timeout);
    final bytes = await res.fold<BytesBuilder>(BytesBuilder(copy: false), (b, d) => b..add(d)).then((b) => b.takeBytes());

    if (res.statusCode >= 200 && res.statusCode < 300) {
      if (wantsPdf) return Uint8List.fromList(bytes);
      if (bytes.isEmpty) return null;
      return jsonDecode(utf8.decode(bytes));
    }

    // Error: application/problem+json with `code` and optional `errors[]` (IC §4.1).
    String code = res.statusCode == 429 ? LimsErrorCodes.commonRateLimited : LimsErrorCodes.commonInternal;
    List<FieldError>? fields;
    try {
      final j = jsonDecode(utf8.decode(bytes));
      if (j is Map) {
        if (j['code'] is String) code = j['code'] as String;
        final errs = j['errors'];
        if (errs is List) {
          fields = [
            for (final e in errs)
              if (e is Map) FieldError(path: '${e['path']}', code: '${e['code']}', message: '${e['message']}'),
          ];
        }
      }
    } catch (_) {/* keep the status-derived code */}
    if (res.statusCode == 429) {
      final s = int.tryParse(res.headers.value('retry-after') ?? '');
      throw RateLimitedException(s == null ? null : Duration(seconds: s));
    }
    throw LimsException(code, fieldErrors: fields);
  };
}
