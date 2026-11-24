// REQ-SEC-104 / REQ-SEC-105 (TRD §12): the ONLY place an HttpClient is built. Trust = exactly the bundled issuing-CA
// certs (current + backup); system roots are not trusted, there is no unpinned fallback and no bad-certificate hook.
import 'dart:convert';
import 'dart:io';

final _cert = RegExp(r'-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----');

const kPhleboInternalCaPem = '''-----BEGIN CERTIFICATE-----
MIIBrTCCAVKgAwIBAgIUeHoN/3qsqdNSUF/3VHKpuIu3YvswCgYIKoZIzj0EAwIw
IjEgMB4GA1UEAwwXTElNUyBpbnRlcm5hbCBDQSAocHJvZCkwHhcNMjYxMTIwMTkx
MDQ3WhcNMzExMTE5MTkxMDQ3WjAiMSAwHgYDVQQDDBdMSU1TIGludGVybmFsIENB
IChwcm9kKTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABIoFAZXV4is6tVM/k53R
eA9Jw+plQxmh0mP7P84QAmv43QdvTOzm5y6Wd1fkcFJWVCrWbrZYq5nb5NxzZmkp
kYWjZjBkMB0GA1UdDgQWBBShvB2CL5XFQAzC3/xcRY5V3WPq6DAfBgNVHSMEGDAW
gBShvB2CL5XFQAzC3/xcRY5V3WPq6DASBgNVHRMBAf8ECDAGAQH/AgEAMA4GA1Ud
DwEB/wQEAwIBBjAKBggqhkjOPQQDAgNJADBGAiEA+2aa1dqUT6CXgbi9SiGVNGQl
zFIEKQ/Ucn7HlIIktO4CIQCQi4WKu6piFWXBzCyikwYx8dfFpcde4obwNss2jN5r
TA==
-----END CERTIFICATE-----''';

class HostOverride {
  const HostOverride(this.ip, this.port);

  final String ip;
  final int port;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is HostOverride && runtimeType == other.runtimeType && ip == other.ip && port == other.port;

  @override
  int get hashCode => Object.hash(ip, port);
}

Map<String, HostOverride> parseHostOverrides(String raw) {
  if (raw.trim().isEmpty) return const {};
  final map = <String, HostOverride>{};
  for (final pair in raw.split(',')) {
    final trimmed = pair.trim();
    if (trimmed.isEmpty) continue;
    final eq = trimmed.indexOf('=');
    if (eq == -1) continue;
    final host = trimmed.substring(0, eq).trim();
    final target = trimmed.substring(eq + 1).trim();
    final colon = target.lastIndexOf(':');
    if (colon == -1) continue;
    final ip = target.substring(0, colon).trim();
    final port = int.tryParse(target.substring(colon + 1).trim());
    if (host.isNotEmpty && ip.isNotEmpty && port != null && port > 0) {
      map[host] = HostOverride(ip, port);
    }
  }
  return map;
}

void applyDevHostOverrides(
  HttpClient client, {
  required String env,
  String? rawOverrides,
  SecurityContext? context,
}) {
  final overrides = (rawOverrides ?? const String.fromEnvironment('DEV_HOST_OVERRIDE')).trim();
  if (overrides.isEmpty) return;
  if (env == 'prod') {
    throw UnsupportedError('DEV_HOST_OVERRIDE is forbidden in prod');
  }
  final map = parseHostOverrides(overrides);
  if (map.isEmpty) return;

  client.connectionFactory = (Uri uri, String? proxyHost, int? proxyPort) async {
    final target = map[uri.host];
    final host = target?.ip ?? proxyHost ?? uri.host;
    final port = target?.port ?? proxyPort ?? uri.port;
    final task = await Socket.startConnect(host, port);
    if (uri.isScheme('https')) {
      final secureSocket = task.socket.then((raw) => SecureSocket.secure(
        raw,
        host: uri.host,
        context: context,
      ));
      return ConnectionTask.fromSocket(secureSocket, task.cancel);
    }
    return task;
  };
}

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

HttpClient createPinnedHttpClient(
  List<String> caPems, {
  String env = 'dev',
  String? rawOverrides,
}) {
  final ctx = buildPinnedSecurityContext(caPems);
  final client = HttpClient(context: ctx)..connectionTimeout = const Duration(seconds: 15);
  applyDevHostOverrides(client, env: env, rawOverrides: rawOverrides, context: ctx);
  return client;
}
