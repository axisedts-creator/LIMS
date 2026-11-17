// REQ-SEC-104 / REQ-SEC-105 (TRD §12): the ONLY place an HttpClient is built. Trust = exactly the bundled issuing-CA
// certs (current + backup); system roots are not trusted, there is no unpinned fallback and no bad-certificate hook.
import 'dart:convert';
import 'dart:io';

final _cert = RegExp(r'-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----');

SecurityContext buildPinnedSecurityContext(List<String> caPems) {
  if (caPems.isEmpty) throw ArgumentError.value(caPems, 'caPems', 'at least one pinned CA is required');
  final ctx = SecurityContext(withTrustedRoots: false);
  for (final pem in caPems) {
    if (!_cert.hasMatch(pem)) throw ArgumentError.value('<redacted>', 'caPems', 'not a PEM certificate');
    try {
      ctx.setTrustedCertificatesBytes(utf8.encode(pem));
    } on TlsException catch (e) {
      throw ArgumentError.value('<redacted>', 'caPems', 'unparseable certificate: ${e.message}');
    }
  }
  return ctx;
}

HttpClient createPinnedHttpClient(List<String> caPems) =>
    HttpClient(context: buildPinnedSecurityContext(caPems))..connectionTimeout = const Duration(seconds: 15);
