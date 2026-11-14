// HC-T21: build flavours + runtime config from --dart-define (no secrets here, REQ-SEC-107).
enum Flavor { dev, staging, prod }

class AppConfig {
  const AppConfig({required this.flavor, required this.apiBaseUrl, this.sentryDsn});

  final Flavor flavor;
  final Uri apiBaseUrl;

  /// LD-24: null -> error tracking stays off.
  final String? sentryDsn;

  /// Keys: FLAVOR, API_BASE_URL, SENTRY_DSN. Throws ArgumentError on anything unexpected (no silent default flavour).
  factory AppConfig.fromDefines(Map<String, String> defines) {
    final name = defines['FLAVOR'];
    final flavor = Flavor.values.where((f) => f.name == name).firstOrNull;
    if (flavor == null) throw ArgumentError.value(name, 'FLAVOR', 'must be one of ${Flavor.values.map((f) => f.name)}');
    final url = Uri.tryParse(defines['API_BASE_URL'] ?? '');
    // REQ-SEC-104: TLS only; REQ-SEC-107: no credentials in the URL.
    if (url == null || url.scheme != 'https' || url.host.isEmpty || url.userInfo.isNotEmpty) {
      throw ArgumentError.value(defines['API_BASE_URL'], 'API_BASE_URL', 'must be an absolute https URL without credentials');
    }
    final dsn = defines['SENTRY_DSN']?.trim();
    return AppConfig(flavor: flavor, apiBaseUrl: url, sentryDsn: (dsn == null || dsn.isEmpty) ? null : dsn);
  }
}
