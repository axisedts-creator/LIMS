import 'app/bootstrap.dart';
import 'app/flavour.dart';

// Staging entry point. Runtime config via --dart-define. No hardcoded hosts (REQ-SEC-107).
Future<void> main() {
  const tenant = String.fromEnvironment('TENANT_CODE', defaultValue: 'demo_lab4');
  const api = String.fromEnvironment('API_BASE_URL');
  const portal = String.fromEnvironment('PORTAL_ORIGIN');
  const store = String.fromEnvironment('STORE_URL', defaultValue: 'https://store.invalid/demo_lab');
  const tenantPrivacy = String.fromEnvironment('TENANT_PRIVACY_URL');

  return runPatientApp(const Flavour(
    env: 'staging',
    tenantCode: tenant,
    displayName: 'My Health Now',
    apiBaseUrl: api,
    portalOrigin: portal,
    storeUrl: store,
    privacyUrl: String.fromEnvironment('PRIVACY_URL', defaultValue: 'https://legal.invalid/privacy'),
    termsUrl: String.fromEnvironment('TERMS_URL', defaultValue: 'https://legal.invalid/terms'),
    tenantPrivacyUrl: tenantPrivacy,
  ));
}
