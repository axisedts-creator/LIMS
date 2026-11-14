// 02-TRD §3.5 flavour config: public values only (tenant code, URLs). No secrets in the binary (REQ-SEC-107).
class Flavour {
  const Flavour({
    required this.env,
    required this.tenantCode,
    required this.displayName,
    required this.apiBaseUrl,
    required this.portalOrigin,
    required this.storeUrl,
    this.privacyUrl,
    this.termsUrl,
    this.tenantPrivacyUrl,
  });

  final String env; // dev | staging | prod
  final String tenantCode; // routing selector for pre-auth calls (TRD §4.1), ^[a-z][a-z0-9_]{2,31}$
  final String displayName;
  final String apiBaseUrl;
  final String portalOrigin;
  final String storeUrl;

  /// LD-28 (A33-5): platform config `legal.privacy_url` / `legal.terms_url` (required in production builds, passed with
  /// --dart-define) and the optional tenant privacy URL shown under the lab name. Empty/null = link hidden.
  final String? privacyUrl;
  final String? termsUrl;
  final String? tenantPrivacyUrl;
}

/// Build-time public values (`--dart-define`); the app version also feeds X-Lims-App-Version.
const kAppVersion = String.fromEnvironment('APP_VERSION', defaultValue: '0.1.0');
const kErrorTrackingDsn = String.fromEnvironment('ERROR_TRACKING_DSN'); // LD-24: runtime config, empty = off
