import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:patient_app/core/api/dev_host_override.dart';
import 'package:patient_app/core/api/patient_security_context.dart';

void main() {
  group('DEV_HOST_OVERRIDE parser', () {
    test('parses single host=ip:port override', () {
      final map = parseHostOverrides('api.lmis.imisaxis.com=100.82.8.12:8443');
      expect(map.length, 1);
      expect(map['api.lmis.imisaxis.com'], const HostOverride('100.82.8.12', 8443));
    });

    test('parses comma-separated multiple host overrides', () {
      final map = parseHostOverrides(
        'api.lmis.imisaxis.com=100.82.8.12:8443, portal.lmis.imisaxis.com=100.82.8.12:8443',
      );
      expect(map.length, 2);
      expect(map['api.lmis.imisaxis.com'], const HostOverride('100.82.8.12', 8443));
      expect(map['portal.lmis.imisaxis.com'], const HostOverride('100.82.8.12', 8443));
    });

    test('handles empty or malformed strings gracefully', () {
      expect(parseHostOverrides(''), isEmpty);
      expect(parseHostOverrides('   '), isEmpty);
      expect(parseHostOverrides('invalid-format'), isEmpty);
      expect(parseHostOverrides('host=ip'), isEmpty);
      expect(parseHostOverrides('host=ip:not_a_number'), isEmpty);
    });
  });

  group('DEV_HOST_OVERRIDE prod guard (REQ-SEC-105)', () {
    test('strictly throws UnsupportedError if env is prod', () {
      final client = HttpClient();
      expect(
        () => applyDevHostOverrides(client, env: 'prod', rawOverrides: 'api.lmis.imisaxis.com=100.82.8.12:8443'),
        throwsUnsupportedError,
      );
    });

    test('applies connectionFactory in dev and staging without throwing', () {
      final devClient = HttpClient();
      expect(
        () => applyDevHostOverrides(devClient, env: 'dev', rawOverrides: 'api.lmis.imisaxis.com=100.82.8.12:8443'),
        returnsNormally,
      );

      final stagingClient = HttpClient();
      expect(
        () => applyDevHostOverrides(stagingClient, env: 'staging', rawOverrides: 'api.lmis.imisaxis.com=100.82.8.12:8443'),
        returnsNormally,
      );
    });

    test('connectionFactory routes socket to overridden host:port', () async {
      // Bind a dummy server on loopback
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      var receivedHostHeader = '';
      server.listen((req) {
        receivedHostHeader = req.headers.value(HttpHeaders.hostHeader) ?? '';
        req.response
          ..statusCode = 200
          ..write('ok');
        req.response.close();
      });
      addTearDown(server.close);

      final client = HttpClient();
      applyDevHostOverrides(
        client,
        env: 'dev',
        rawOverrides: 'override.target.example=127.0.0.1:${server.port}',
      );

      final req = await client.getUrl(Uri.parse('http://override.target.example/test'));
      final res = await req.close();
      expect(res.statusCode, 200);
      // Confirms Host header is preserved as original domain name, not the override IP
      expect(receivedHostHeader, 'override.target.example');
      client.close();
    });
  });

  group('Patient SecurityContext (REQ-SEC-104 trust rules)', () {
    test('prod returns null context (retains system roots)', () {
      final ctx = buildPatientSecurityContext(env: 'prod');
      expect(ctx, isNull);
    });

    test('dev and staging return SecurityContext with internal CA trusted', () {
      final devCtx = buildPatientSecurityContext(env: 'dev');
      expect(devCtx, isA<SecurityContext>());

      final stagingCtx = buildPatientSecurityContext(env: 'staging');
      expect(stagingCtx, isA<SecurityContext>());
    });
  });
}
