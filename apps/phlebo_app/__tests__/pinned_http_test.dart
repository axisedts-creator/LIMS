// HC-T21 / REQ-SEC-104 + REQ-SEC-105 (07-SECURITY §5 item 8 "Pinning": proxy with untrusted CA -> requests fail; no fallback).
// TRD §12: `pinned_http.dart` builds SecurityContext(withTrustedRoots: false) holding only the bundled issuing-CA certs
// (current + backup); there is no unpinned fallback and no badCertificateCallback anywhere.
//
// ASSUMED API (package:phlebo_app/core/net/pinned_http.dart):
//   SecurityContext buildPinnedSecurityContext(List<String> caPems)   // ArgumentError if empty or any PEM is not a certificate
//   HttpClient createPinnedHttpClient(List<String> caPems)            // HttpClient(context: buildPinnedSecurityContext(..)); never sets badCertificateCallback
// The MITM is a real TLS server whose leaf is signed by a CA with the SAME subject DN as the pinned CA but another key.
import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:phlebo_app/core/net/pinned_http.dart';

import 'support/tls_fixture.dart';

Future<String> _get(HttpClient c, Uri url) async {
  final req = await c.getUrl(url);
  final res = await req.close();
  return res.transform(const SystemEncoding().decoder).join();
}

void main() {
  late TestPki pki;
  late TestServer good; // leaf signed by the pinned CA
  late TestServer mitm; // proxy presenting a leaf signed by an untrusted CA
  setUpAll(() async {
    pki = await TestPki.create();
    good = await pki.serve(signedByPinnedCa: true, handler: (r, _) => respond(r, 200, '{"ok":true}'));
    mitm = await pki.serve(signedByPinnedCa: false, handler: (r, _) => respond(r, 200, '{"leaked":true}'));
  });
  tearDownAll(() async {
    await good.close();
    await mitm.close();
    pki.dispose();
  });

  group('pinned client', () {
    test('server chaining to the pinned CA is accepted', () async {
      final c = createPinnedHttpClient([pki.caAPem]);
      addTearDown(() => c.close(force: true));
      expect(await _get(c, good.baseUrl.resolve('/ping')), contains('"ok":true'));
    });

    test('MITM proxy with an untrusted CA is refused at the handshake and no request reaches it', () async {
      final c = createPinnedHttpClient([pki.caAPem]);
      addTearDown(() => c.close(force: true));
      await expectLater(_get(c, mitm.baseUrl.resolve('/ping')), throwsA(isA<HandshakeException>()));
      expect(mitm.requests, isEmpty, reason: 'no HTTP bytes may be sent over an unverified channel');
    });

    test('same subject DN but different key (name-spoofing MITM) is still refused', () async {
      // caB has the identical DN as caA; only the key differs.
      final c = createPinnedHttpClient([pki.caAPem]);
      addTearDown(() => c.close(force: true));
      await expectLater(_get(c, mitm.baseUrl.resolve('/x')), throwsA(isA<HandshakeException>()));
    });

    test('no unpinned fallback: the refusal repeats on every retry, same client', () async {
      final c = createPinnedHttpClient([pki.caAPem]);
      addTearDown(() => c.close(force: true));
      for (var i = 0; i < 3; i++) {
        await expectLater(_get(c, mitm.baseUrl.resolve('/retry')), throwsA(isA<HandshakeException>()));
      }
      expect(mitm.requests, isEmpty);
    });

    test('backup pin: [current, backup] accepts servers chaining to either, still refuses a third CA', () async {
      final both = createPinnedHttpClient([pki.caAPem, pki.caBPem]);
      addTearDown(() => both.close(force: true));
      expect(await _get(both, good.baseUrl.resolve('/a')), contains('ok'));
      expect(await _get(both, mitm.baseUrl.resolve('/b')), contains('leaked')); // caB is the configured backup here
      final onlyB = createPinnedHttpClient([pki.caBPem]);
      addTearDown(() => onlyB.close(force: true));
      await expectLater(_get(onlyB, good.baseUrl.resolve('/c')), throwsA(isA<HandshakeException>()));
    });

  });

  group('buildPinnedSecurityContext', () {
    test('empty pin set -> ArgumentError (never an unpinned/system-trust fallback)', () {
      expect(() => buildPinnedSecurityContext(const []), throwsArgumentError);
      expect(() => createPinnedHttpClient(const []), throwsArgumentError);
    });

    test('garbage / non-certificate PEM -> ArgumentError', () {
      expect(() => buildPinnedSecurityContext(const ['not a pem']), throwsArgumentError);
      expect(() => buildPinnedSecurityContext(const ['-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----']), throwsArgumentError);
    });

    test('a valid pin set builds a context', () {
      expect(buildPinnedSecurityContext([pki.caAPem]), isA<SecurityContext>());
      expect(buildPinnedSecurityContext([pki.caAPem, pki.caBPem]), isA<SecurityContext>());
    });
  });
}
