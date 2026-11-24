import 'app/bootstrap.dart';
import 'app/flavour.dart';

// Default to live server; override per developer with --dart-define=API_BASE_URL=...
Future<void> main() => runPatientApp(const Flavour(
      env: 'dev',
      tenantCode: String.fromEnvironment('TENANT_CODE', defaultValue: 'demo_lab4'),
      displayName: 'My Health Now',
      apiBaseUrl: String.fromEnvironment('API_BASE_URL', defaultValue: 'https://api.metrolmis.com:8443'),
      portalOrigin: String.fromEnvironment('PORTAL_ORIGIN', defaultValue: 'https://portal.metrolmis.com:8443'),
      storeUrl: String.fromEnvironment('STORE_URL', defaultValue: 'https://portal.metrolmis.com:8443'),
      // LD-28: legal.privacy_url / legal.terms_url.
      privacyUrl: String.fromEnvironment('PRIVACY_URL', defaultValue: 'https://portal.metrolmis.com:8443/privacy'),
      termsUrl: String.fromEnvironment('TERMS_URL', defaultValue: 'https://portal.metrolmis.com:8443/terms'),
      tenantPrivacyUrl: String.fromEnvironment('TENANT_PRIVACY_URL'),
      googleServerClientId: String.fromEnvironment('GOOGLE_SERVER_CLIENT_ID', defaultValue: '968717539325-nuupeo0hbbde7h9v8hahcbkrrk8lq78m.apps.googleusercontent.com'),
    ));
