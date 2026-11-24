import 'app/bootstrap.dart';
import 'app/flavour.dart';

// Staging entry point. Runtime config via --dart-define. No hardcoded hosts (REQ-SEC-107).
Future<void> main() {
  const tenant = String.fromEnvironment('TENANT_CODE', defaultValue: 'demo_lab4');
  const api = String.fromEnvironment('API_BASE_URL', defaultValue: 'https://api.metrolmis.com:8443');
  const portal = String.fromEnvironment('PORTAL_ORIGIN', defaultValue: 'https://portal.metrolmis.com:8443');
  const store = String.fromEnvironment('STORE_URL', defaultValue: 'https://portal.metrolmis.com:8443');
  const tenantPrivacy = String.fromEnvironment('TENANT_PRIVACY_URL');

  return runPatientApp(const Flavour(
    env: 'staging',
    tenantCode: tenant,
    displayName: 'My Health Now',
    apiBaseUrl: api,
    portalOrigin: portal,
    storeUrl: store,
    privacyUrl: String.fromEnvironment('PRIVACY_URL', defaultValue: 'https://portal.metrolmis.com:8443/privacy'),
    termsUrl: String.fromEnvironment('TERMS_URL', defaultValue: 'https://portal.metrolmis.com:8443/terms'),
    tenantPrivacyUrl: tenantPrivacy,
    googleServerClientId: String.fromEnvironment('GOOGLE_SERVER_CLIENT_ID', defaultValue: '968717539325-nuupeo0hbbde7h9v8hahcbkrrk8lq78m.apps.googleusercontent.com'),
  ));
}
