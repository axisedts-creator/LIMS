import 'app/bootstrap.dart';
import 'app/flavour.dart';

// .invalid defaults are placeholders: CI passes the real public URLs with --dart-define (release checklist, T-REL1).
const _flavour = Flavour(
  env: 'prod',
  tenantCode: 'demo_lab',
  displayName: 'Demo Lab',
  apiBaseUrl: String.fromEnvironment('API_BASE_URL', defaultValue: 'https://api.invalid'),
  portalOrigin: String.fromEnvironment('PORTAL_ORIGIN', defaultValue: 'https://portal.invalid'),
  storeUrl: String.fromEnvironment('STORE_URL', defaultValue: 'https://store.invalid/demo_lab'),
  // LD-28: legal.privacy_url / legal.terms_url are required in production builds (no default; checked in main), also
  // recorded in the release checklist for the store listings.
  privacyUrl: String.fromEnvironment('PRIVACY_URL'),
  termsUrl: String.fromEnvironment('TERMS_URL'),
  tenantPrivacyUrl: String.fromEnvironment('TENANT_PRIVACY_URL'),
);

Future<void> main() {
  if (_flavour.privacyUrl!.isEmpty || _flavour.termsUrl!.isEmpty) {
    throw StateError('PRIVACY_URL/TERMS_URL required for prod (LD-28)');
  }
  return runPatientApp(_flavour);
}
