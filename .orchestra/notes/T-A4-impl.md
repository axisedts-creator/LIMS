# T-A4 impl (writer)
Files: lib/features/auth/{patient_auth_api,auth_providers,sign_in_flow}.dart (new); lib/app/app_lock_gate.dart (A4 copy, 3-try lock-out, `enabled`).
[CONV] outside owned paths but required by tests: Flavour.privacyUrl/termsUrl/tenantPrivacyUrl + main_dev/staging/prod (`--dart-define PRIVACY_URL/TERMS_URL/TENANT_PRIVACY_URL`, `.invalid` placeholders); router.dart mounts SignInFlow at kSignInPath; app.dart passes `enabled: signedIn` to the gate.
[CONV] AppLockGate no longer wraps LimsAppLockGate (kit gate has a fixed button, cannot show the lock-out copy); own lock screen from lims_ui LimsButton + tokens. Opening the app again after lock-out resets the 3 tries.
[CONV] E2 `app_instance_id` = uuidv7 per process, memory only. Pre-auth headers `X-Lims-Patient-PreAuth: t.<tenant>` / `c.<tenant>.<token>` (TRD §4.2).
Round 2 (after ruling): core/lifecycle/secure_temp_files.dart deleteAll uses sync IO (one step; async exists+list needed several real event-loop turns, so US-EN-02.4 test still failed after the ruling's single runAsync); sign_in_flow A0 retry back-off is a cancellable Timer (cold_start_lock_test failed on a pending Future.delayed).
Result: `flutter test` 143/143 pass; analyze: 2 infos (unnecessary imports in tester's a3_otp_entry_test.dart).
Open: A0 tenant logo asset; RateLimitedException.retryAfter needs HTTP Retry-After (CR-C16-016/017); integration_test/sign_in_prism_test.dart + `integration_test` dev_dep absent; prod legal URLs placeholders until T-REL1.
