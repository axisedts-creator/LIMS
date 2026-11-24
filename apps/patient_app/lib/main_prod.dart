import 'app/bootstrap.dart';
import 'app/flavour.dart';

const _override = String.fromEnvironment('DEV_HOST_OVERRIDE');

const _flavour = Flavour(
  env: 'prod',
  tenantCode: String.fromEnvironment('TENANT_CODE', defaultValue: 'demo_lab4'),
  displayName: 'My Health Now',
  apiBaseUrl: String.fromEnvironment('API_BASE_URL', defaultValue: 'https://api.metrolmis.com:8443'),
  portalOrigin: String.fromEnvironment('PORTAL_ORIGIN', defaultValue: 'https://portal.metrolmis.com:8443'),
  storeUrl: String.fromEnvironment('STORE_URL', defaultValue: 'https://portal.metrolmis.com:8443'),
  // LD-28: legal.privacy_url / legal.terms_url are required in production builds (no default; checked in main), also
  // recorded in the release checklist for the store listings.
  privacyUrl: String.fromEnvironment('PRIVACY_URL'),
  termsUrl: String.fromEnvironment('TERMS_URL'),
  tenantPrivacyUrl: String.fromEnvironment('TENANT_PRIVACY_URL'),
  googleServerClientId: String.fromEnvironment('GOOGLE_SERVER_CLIENT_ID', defaultValue: '968717539325-nuupeo0hbbde7h9v8hahcbkrrk8lq78m.apps.googleusercontent.com'),
);

Future<void> main() {
  // REQ-SEC-105: DEV_HOST_OVERRIDE is strictly impossible in production.
  if (_override.isNotEmpty) {
    throw UnsupportedError('DEV_HOST_OVERRIDE is forbidden in prod');
  }
  if (_flavour.privacyUrl == null || _flavour.privacyUrl!.isEmpty || _flavour.termsUrl == null || _flavour.termsUrl!.isEmpty) {
    throw StateError('PRIVACY_URL/TERMS_URL required for prod (LD-28)');
  }
  return runPatientApp(_flavour);
}
