import 'app/bootstrap.dart';
import 'app/flavour.dart';

// .invalid defaults are placeholders: CI passes the real public URLs with --dart-define (release checklist, T-REL1).
Future<void> main() => runPatientApp(const Flavour(
      env: 'staging',
      tenantCode: 'demo_lab',
      displayName: 'Demo Lab (staging)',
      apiBaseUrl: String.fromEnvironment('API_BASE_URL', defaultValue: 'https://api.staging.invalid'),
      portalOrigin: String.fromEnvironment('PORTAL_ORIGIN', defaultValue: 'https://portal.staging.invalid'),
      storeUrl: String.fromEnvironment('STORE_URL', defaultValue: 'https://store.invalid/demo_lab'),
    ));
