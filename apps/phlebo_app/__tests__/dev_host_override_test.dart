import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:phlebo_app/core/net/pinned_http.dart';

void main() {
  group('Phlebo DEV_HOST_OVERRIDE parser', () {
    test('parses host=ip:port overrides', () {
      final map = parseHostOverrides('api.lmis.imisaxis.com=100.82.8.12:8443');
      expect(map.length, 1);
      expect(map['api.lmis.imisaxis.com'], const HostOverride('100.82.8.12', 8443));
    });

    test('handles empty and malformed gracefully', () {
      expect(parseHostOverrides(''), isEmpty);
      expect(parseHostOverrides('  '), isEmpty);
      expect(parseHostOverrides('invalid'), isEmpty);
    });
  });

  group('Phlebo DEV_HOST_OVERRIDE prod guard (REQ-SEC-105)', () {
    test('strictly throws UnsupportedError if env is prod', () {
      final client = HttpClient();
      expect(
        () => applyDevHostOverrides(client, env: 'prod', rawOverrides: 'api.lmis.imisaxis.com=100.82.8.12:8443'),
        throwsUnsupportedError,
      );
    });

    test('createPinnedHttpClient with overrides connects to target while preserving Host header', () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      var receivedHostHeader = '';
      final sub = server.listen((req) {
        receivedHostHeader = req.headers.value(HttpHeaders.hostHeader) ?? '';
        req.response
          ..statusCode = 200
          ..write('ok');
        req.response.close();
      });
      addTearDown(() async {
        await sub.cancel();
        await server.close(force: true);
      });

      final client = createPinnedHttpClient(
        [kPhleboInternalCaPem],
        env: 'dev',
        rawOverrides: 'override.phlebo.example=127.0.0.1:${server.port}',
      );
      addTearDown(() => client.close(force: true));

      final req = await client.getUrl(Uri.parse('http://override.phlebo.example/test'));
      final res = await req.close();
      expect(res.statusCode, 200);
      await res.drain<void>();
      expect(receivedHostHeader, 'override.phlebo.example');
    });
  });
}
