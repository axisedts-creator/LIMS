// HC-T21 api factory + error mapping (TRD §3.4 `core/net/api_factory.dart`; 02-CV §4.6 problem+json; TRD §5 header rules;
// REQ-SEC-104: TLS pin failure must be distinguishable from "offline" and must never be retried unpinned).
//
// ASSUMED API (package:phlebo_app/core/net/api_factory.dart):
//   ApiClient createApiClient({
//     required Uri baseUrl,                       // https only (ArgumentError otherwise); path prefix kept, e.g. https://h:1/v1/homecollection
//     required List<String> pinnedCaPems,         // -> createPinnedHttpClient
//     required String appVersion,                 // header X-Lims-App-Version
//     required String deviceId,                   // header X-Lims-Device-Id
//     required FutureOr<String?> Function() accessToken,   // null -> no Authorization header
//   })
//   Future<Map<String, Object?>> ApiClient.getJson(String path, {Map<String, String>? query})
//   Future<Map<String, Object?>> ApiClient.postJson(String path, Map<String, Object?> body, {String? idempotencyKey})
//     idempotencyKey: header `Idempotency-Key`, must match ^[A-Za-z0-9_-]{1,64}$ (CV §4.5) else ArgumentError (before any I/O)
//     2xx -> decoded JSON object ({} for 204/empty). Non-2xx -> throws LimsException (lims_shared):
//       problem+json with a `code` registered in limsErrorHttpStatus -> LimsException(code, safeDetail: detail, fieldErrors from errors[])
//       unregistered code, non-JSON body (proxy HTML), or malformed JSON -> LimsException(LimsErrorCodes.commonInternal), safeDetail null
//     transport failure -> throws ApiTransportException { bool isTlsFailure; Object cause }  (HandshakeException => isTlsFailure true)
//   class ApiTransportException implements Exception
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:phlebo_app/core/net/api_factory.dart';

import 'support/tls_fixture.dart';

const _device = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const _jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c3ludGhldGljLXNpZ25hdHVyZQ';

void main() {
  late TestPki pki;
  setUpAll(() async => pki = await TestPki.create());
  tearDownAll(() => pki.dispose());

  Future<(ApiClient, TestServer)> make(TestHandler handler, {String? token = _jwt}) async {
    final server = await pki.serve(signedByPinnedCa: true, handler: handler);
    addTearDown(server.close);
    final client = createApiClient(
      baseUrl: server.baseUrl.replace(path: '/v1/homecollection'),
      pinnedCaPems: [pki.caAPem],
      appVersion: '1.2.3',
      deviceId: _device,
      accessToken: () => token,
    );
    return (client, server);
  }

  Map<String, Object?> problem(int status, String code, {String? detail, List<Map<String, Object?>>? errors}) => {
        'type': 'urn:lims:error:$code',
        'title': 'Synthetic title',
        'status': status,
        'code': code,
        if (detail != null) 'detail': detail,
        'request_id': '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c',
        if (errors != null) 'errors': errors,
      };

  group('requests', () {
    test('GET sends bearer token, app version, device id, Accept; base path prefix is kept; query is encoded', () async {
      final (client, server) = await make((r, _) => respond(r, 200, {'ok': true}));
      final out = await client.getJson('/visits/0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2d', query: {'limit': '50', 'q': 'a b&c'});
      expect(out, {'ok': true});
      final r = server.requests.single;
      expect(r.method, 'GET');
      expect(r.uri.path, '/v1/homecollection/visits/0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2d');
      expect(r.uri.queryParameters, {'limit': '50', 'q': 'a b&c'});
      expect(r.header('authorization'), 'Bearer $_jwt');
      expect(r.header('x-lims-app-version'), '1.2.3');
      expect(r.header('x-lims-device-id'), _device);
      expect(r.header('accept'), contains('application/json'));
      expect(r.header('idempotency-key'), isNull);
    });

    test('no token -> no Authorization header at all', () async {
      final (client, server) = await make((r, _) => respond(r, 200, {}), token: null);
      await client.getJson('/x');
      expect(server.requests.single.header('authorization'), isNull);
    });

    test('POST sends JSON body, content-type and Idempotency-Key; the token is never in URL or body', () async {
      final (client, server) = await make((r, _) => respond(r, 201, {'id': '1'}));
      final out = await client.postJson('/app/sync/push', {'device_id': _device, 'mutations': <Object?>[]}, idempotencyKey: 'batch_01-ab');
      expect(out, {'id': '1'});
      final r = server.requests.single;
      expect(r.method, 'POST');
      expect(r.header('content-type'), startsWith('application/json'));
      expect(r.header('idempotency-key'), 'batch_01-ab');
      expect(jsonDecode(r.body), {'device_id': _device, 'mutations': <Object?>[]});
      expect(r.uri.toString(), isNot(contains(_jwt)));
      expect(r.body, isNot(contains(_jwt)));
    });

    test('204 / empty body -> empty map', () async {
      final (client, _) = await make((r, _) => respond(r, 204, null));
      expect(await client.postJson('/x', {}), isEmpty);
    });

    test('invalid Idempotency-Key is rejected before any request is sent', () async {
      final (client, server) = await make((r, _) => respond(r, 200, {}));
      for (final bad in ['', 'a b', 'ключ', 'x' * 65, 'a\r\nX-Evil: 1', 'a:b']) {
        expect(() => client.postJson('/x', {}, idempotencyKey: bad), throwsArgumentError, reason: 'key "${bad.replaceAll('\n', r'\n')}"');
      }
      expect(server.requests, isEmpty);
    });

    test('non-https base URL (and credentials in the URL) are refused at construction', () {
      for (final u in ['http://127.0.0.1:1/v1', 'https://user:pw@127.0.0.1:1/v1', 'ftp://127.0.0.1/v1']) {
        expect(
          () => createApiClient(baseUrl: Uri.parse(u), pinnedCaPems: [pki.caAPem], appVersion: '1.0.0', deviceId: _device, accessToken: () => null),
          throwsArgumentError,
          reason: u,
        );
      }
    });

    test('empty pin set is refused at construction (no unpinned fallback)', () {
      expect(
        () => createApiClient(baseUrl: Uri.parse('https://127.0.0.1:1/v1'), pinnedCaPems: const [], appVersion: '1.0.0', deviceId: _device, accessToken: () => null),
        throwsArgumentError,
      );
    });
  });

  group('error mapping (CV §4.6 problem+json -> LimsException)', () {
    for (final c in [
      (409, LimsErrorCodes.homecollectionDeviceNotRegistered),
      (426, LimsErrorCodes.homecollectionAppVersionUnsupported),
      (401, LimsErrorCodes.authTokenExpired),
      (401, LimsErrorCodes.authSessionExpired),
      (429, LimsErrorCodes.commonRateLimited),
      (409, LimsErrorCodes.commonVersionConflict),
      (500, LimsErrorCodes.commonInternal),
    ]) {
      test('${c.$1} ${c.$2}', () async {
        final (client, _) = await make((r, _) => respond(r, c.$1, problem(c.$1, c.$2, detail: 'Synthetic detail.'), contentType: 'application/problem+json', headers: {'retry-after': '7'}));
        await expectLater(
          client.getJson('/x'),
          throwsA(isA<LimsException>().having((e) => e.code, 'code', c.$2).having((e) => e.safeDetail, 'safeDetail', 'Synthetic detail.')),
        );
      });
    }

    test('400 common.validation_failed carries errors[] as fieldErrors (JSON pointer path, code, message)', () async {
      final (client, _) = await make((r, _) => respond(
          r, 400, problem(400, LimsErrorCodes.commonValidationFailed, errors: [
            {'path': '/mutations/0/reason_code', 'code': 'common.field_required', 'message': 'reason_code is required'},
          ]),
          contentType: 'application/problem+json'));
      await expectLater(
        client.postJson('/x', {}),
        throwsA(isA<LimsException>()
            .having((e) => e.code, 'code', LimsErrorCodes.commonValidationFailed)
            .having((e) => e.fieldErrors?.single.path, 'path', '/mutations/0/reason_code')
            .having((e) => e.fieldErrors?.single.code, 'field code', 'common.field_required')
            .having((e) => e.fieldErrors?.single.message, 'message', 'reason_code is required')),
      );
    });

    test('code not in the registry -> common.internal (server text is not trusted as a code)', () async {
      final (client, _) = await make((r, _) => respond(r, 418, problem(418, 'evil.made_up_code', detail: 'Synthetic detail.'), contentType: 'application/problem+json'));
      await expectLater(client.getJson('/x'), throwsA(isA<LimsException>().having((e) => e.code, 'code', LimsErrorCodes.commonInternal)));
    });

    test('non-JSON error body (proxy HTML) -> common.internal; body text and token never leak into the exception', () async {
      const html = '<html>502 Bad Gateway Sita Poudel 9812345678</html>';
      final (client, _) = await make((r, _) => respond(r, 502, html, contentType: 'text/html'));
      try {
        await client.getJson('/x');
        fail('expected LimsException');
      } on LimsException catch (e) {
        expect(e.code, LimsErrorCodes.commonInternal);
        expect(e.safeDetail, isNull);
        expect('$e', isNot(anyOf(contains('Poudel'), contains('9812345678'), contains(_jwt))));
      }
    });

    test('malformed JSON with a 4xx status -> common.internal (never a FormatException)', () async {
      final (client, _) = await make((r, _) => respond(r, 400, '{"code": ', contentType: 'application/problem+json'));
      await expectLater(client.getJson('/x'), throwsA(isA<LimsException>().having((e) => e.code, 'code', LimsErrorCodes.commonInternal)));
    });

    test('2xx with a non-object JSON body -> common.internal', () async {
      final (client, _) = await make((r, _) => respond(r, 200, '[1,2,3]'));
      await expectLater(client.getJson('/x'), throwsA(isA<LimsException>().having((e) => e.code, 'code', LimsErrorCodes.commonInternal)));
    });
  });

  group('transport failures', () {
    test('MITM proxy (untrusted CA) -> ApiTransportException(isTlsFailure) and the server sees no request', () async {
      final mitm = await pki.serve(signedByPinnedCa: false, handler: (r, _) => respond(r, 200, {'leaked': true}));
      addTearDown(mitm.close);
      final client = createApiClient(
        baseUrl: mitm.baseUrl.replace(path: '/v1/homecollection'),
        pinnedCaPems: [pki.caAPem],
        appVersion: '1.2.3',
        deviceId: _device,
        accessToken: () => _jwt,
      );
      for (var i = 0; i < 2; i++) {
        await expectLater(
          client.postJson('/app/sync/push', {'x': 1}, idempotencyKey: 'k1'),
          throwsA(isA<ApiTransportException>().having((e) => e.isTlsFailure, 'isTlsFailure', isTrue).having((e) => e.cause, 'cause', isA<HandshakeException>())),
        );
      }
      expect(mitm.requests, isEmpty, reason: 'bearer token / body must never be sent to an unpinned peer');
    });

    test('connection refused -> ApiTransportException with isTlsFailure false (offline, retryable)', () async {
      final s = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      final port = s.port;
      await s.close(); // nothing listens any more
      final client = createApiClient(
        baseUrl: Uri.parse('https://127.0.0.1:$port/v1/homecollection'),
        pinnedCaPems: [pki.caAPem],
        appVersion: '1.2.3',
        deviceId: _device,
        accessToken: () => _jwt,
      );
      await expectLater(client.getJson('/x'), throwsA(isA<ApiTransportException>().having((e) => e.isTlsFailure, 'isTlsFailure', isFalse)));
    });
  });
}
