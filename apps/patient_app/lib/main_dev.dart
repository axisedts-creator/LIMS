import 'app/bootstrap.dart';
import 'app/flavour.dart';

// Android emulator host loopback; override per developer with --dart-define=API_BASE_URL=...
Future<void> main() => runPatientApp(const Flavour(
      env: 'dev',
      tenantCode: 'demo_lab',
      displayName: 'Demo Lab (dev)',
      apiBaseUrl: String.fromEnvironment('API_BASE_URL', defaultValue: 'http://10.0.2.2:3000'),
      portalOrigin: String.fromEnvironment('PORTAL_ORIGIN', defaultValue: 'http://10.0.2.2:3001'),
      storeUrl: String.fromEnvironment('STORE_URL', defaultValue: 'https://store.invalid/demo_lab'),
      // LD-28: legal.privacy_url / legal.terms_url.
      privacyUrl: String.fromEnvironment('PRIVACY_URL', defaultValue: 'https://legal.invalid/privacy'),
      termsUrl: String.fromEnvironment('TERMS_URL', defaultValue: 'https://legal.invalid/terms'),
      tenantPrivacyUrl: String.fromEnvironment('TENANT_PRIVACY_URL'),
    ));
