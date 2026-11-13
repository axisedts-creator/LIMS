# T-A4 impl (writer)
Files: lib/features/auth/{patient_auth_api,auth_providers,sign_in_flow}.dart (new); lib/app/app_lock_gate.dart (A4 copy, 3-try lock-out, `enabled`).
[CONV] outside owned paths but required by tests: Flavour.privacyUrl/termsUrl/tenantPrivacyUrl + main_dev/staging/prod (`--dart-define PRIVACY_URL/TERMS_URL/TENANT_PRIVACY_URL`, `.invalid` placeholders like the other URLs); router.dart mounts SignInFlow at kSignInPath; app.dart passes `enabled: signedIn` to the gate.
[CONV] AppLockGate no longer wraps LimsAppLockGate (kit gate has a fixed button, cannot show the lock-out copy); own lock screen from lims_ui LimsButton + tokens. Opening the app again after lock-out resets the 3 tries.
[CONV] E2 `app_instance_id` = uuidv7 per process, memory only. Pre-auth headers `X-Lims-Patient-PreAuth: t.<tenant>` / `c.<tenant>.<token>` (TRD §4.2).
Result: 4 a3 + 2 app-flow tests fail, all test-side: see T-A4-dispute.md. Everything else passes (a0, a2, a4, design_rules, rest of a3/app-flow).
Open: A0 tenant logo asset not built (no flavour asset field); RateLimitedException.retryAfter needs the HTTP layer to read Retry-After (CR-C16-016/017); integration_test/sign_in_prism_test.dart absent and `integration_test` not in pubspec; prod legal URLs are placeholders until CI passes real ones (T-REL1).
