import 'dart:io';

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
