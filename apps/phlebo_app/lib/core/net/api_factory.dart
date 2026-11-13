// HC-T21 api factory (TRD §3.4): pinned HTTPS client + header rules + problem+json -> LimsException (CV §4.6).
// REQ-SEC-104: a TLS failure surfaces as ApiTransportException(isTlsFailure: true) and is never retried unpinned.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:lims_shared/lims_shared.dart';

import 'pinned_http.dart';

final _idemKey = RegExp(r'^[A-Za-z0-9_-]{1,64}$'); // CV §4.5
const _maxBody = 8 * 1024 * 1024;
const _timeout = Duration(seconds: 30);

class ApiTransportException implements Exception {
  ApiTransportException(this.cause, {required this.isTlsFailure});
  final Object cause;

  /// true = certificate/handshake failure (possible MITM): do not retry, do not treat as "offline".
  final bool isTlsFailure;
  @override
  String toString() => 'ApiTransportException(isTlsFailure: $isTlsFailure, ${cause.runtimeType})';
}

ApiClient createApiClient({
  required Uri baseUrl,
  required List<String> pinnedCaPems,
  required String appVersion,
  required String deviceId,
  required FutureOr<String?> Function() accessToken,
}) {
  if (baseUrl.scheme != 'https' || baseUrl.host.isEmpty || baseUrl.userInfo.isNotEmpty) {
    throw ArgumentError.value('<redacted>', 'baseUrl', 'must be an absolute https URL without credentials');
  }
  return ApiClient._(createPinnedHttpClient(pinnedCaPems), baseUrl, appVersion, deviceId, accessToken);
}

class ApiClient {
  ApiClient._(this._http, this._base, this._appVersion, this._deviceId, this._token);

  final HttpClient _http;
  final Uri _base;
  final String _appVersion;
  final String _deviceId;
  final FutureOr<String?> Function() _token;

  Future<Map<String, Object?>> getJson(String path, {Map<String, String>? query}) => _send('GET', path, query: query);

  Future<Map<String, Object?>> postJson(String path, Map<String, Object?> body, {String? idempotencyKey}) {
    // Sync throw: validated before any I/O.
    if (idempotencyKey != null && !_idemKey.hasMatch(idempotencyKey)) {
      throw ArgumentError.value('<redacted>', 'idempotencyKey', 'must match ${_idemKey.pattern}');
    }
    return _send('POST', path, body: body, idempotencyKey: idempotencyKey);
  }

  void close() => _http.close(force: true);

  Future<Map<String, Object?>> _send(String method, String path, {Map<String, String>? query, Map<String, Object?>? body, String? idempotencyKey}) async {
    final prefix = _base.path.endsWith('/') ? _base.path.substring(0, _base.path.length - 1) : _base.path;
    final uri = _base.replace(path: '$prefix$path', queryParameters: (query == null || query.isEmpty) ? null : query);
    final token = await _token();
    final int status;
    final List<int> bytes;
    try {
      final req = await _http.openUrl(method, uri);
      req.headers
        ..set(HttpHeaders.acceptHeader, 'application/json')
        ..set('X-Lims-App-Version', _appVersion)
        ..set('X-Lims-Device-Id', _deviceId);
      if (token != null) req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
      if (idempotencyKey != null) req.headers.set('Idempotency-Key', idempotencyKey);
      if (body != null) {
        final data = utf8.encode(jsonEncode(body));
        req.headers.contentType = ContentType('application', 'json', charset: 'utf-8');
        req.contentLength = data.length;
        req.add(data);
      }
      final res = await req.close().timeout(_timeout);
      status = res.statusCode;
      final out = <int>[];
      await for (final c in res.timeout(_timeout)) {
        out.addAll(c);
        if (out.length > _maxBody) throw LimsException(LimsErrorCodes.commonInternal);
      }
      bytes = out;
    } on TlsException catch (e) {
      throw ApiTransportException(e, isTlsFailure: true); // HandshakeException / CertificateException
    } on IOException catch (e) {
      throw ApiTransportException(e, isTlsFailure: false);
    } on TimeoutException catch (e) {
      throw ApiTransportException(e, isTlsFailure: false);
    }
    return _decode(status, bytes);
  }
}

Map<String, Object?> _decode(int status, List<int> bytes) {
  Object? json;
  var parsed = bytes.isEmpty;
  if (!parsed) {
    try {
      json = jsonDecode(utf8.decode(bytes));
      parsed = true;
    } on FormatException {
      // fall through: proxy HTML / malformed body
    }
  }
  final internal = LimsException(LimsErrorCodes.commonInternal); // never carries server text
  if (status >= 200 && status < 300) {
    if (bytes.isEmpty) return {};
    return (parsed && json is Map) ? json.cast<String, Object?>() : throw internal;
  }
  if (!parsed || json is! Map) throw internal;
  final code = json['code'];
  if (code is! String || !limsErrorHttpStatus.containsKey(code)) throw internal;
  final detail = json['detail'];
  final errors = json['errors'];
  throw LimsException(
    code,
    safeDetail: detail is String ? detail : null,
    fieldErrors: errors is List
        ? [
            for (final e in errors)
              if (e is Map && e['path'] is String && e['code'] is String && e['message'] is String)
                FieldError(path: e['path'] as String, code: e['code'] as String, message: e['message'] as String),
          ]
        : null,
  );
}
