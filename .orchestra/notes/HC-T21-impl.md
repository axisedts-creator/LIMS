# HC-T21 impl (writer)
- Added apps/phlebo_app: pubspec.yaml (exact pins sentry_flutter 10.3.0, go_router 18.1.3), lib/main.dart, lib/app/{flavor,error_tracking,routes,router,app}.dart, lib/core/net/{pinned_http,api_factory}.dart, android/ (flutter create + productFlavors dev/staging/prod, INTERNET, no cleartext). Root pubspec.yaml: workspace += apps/phlebo_app.
- [CONV] pinned_http: SecurityContext(withTrustedRoots:false), empty/garbage PEM -> ArgumentError; only file with `HttpClient(`. No badCertificateCallback.
- [CONV] api_factory: TlsException -> ApiTransportException(isTlsFailure) never retried; non-registered code/HTML/bad JSON -> common.internal, no server text. Idempotency-Key validated synchronously.
- LD-24: error_tracking.dart delegates to lims_ui LimsErrorTracking (DSN unset -> off).
- Ran `flutter test __tests__`: 38 pass (pinned_http, api_factory, ci_guards); app_skeleton_test fails to COMPILE (test bug, see HC-T21-dispute.md), so router/flavor/theme impl is unverified by tests.
- Open: main.dart does not yet build ApiClient (pinned CA PEM assets from C1, CR-C17-011, wired in a later task); no Android SDK here, so no real `flutter build apk`; release signing left to CI.
