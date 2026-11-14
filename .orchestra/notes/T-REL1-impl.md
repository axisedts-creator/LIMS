# T-REL1 impl (writer)
- Changed: apps/patient_app/android/app/build.gradle.kts (release signingConfig, isMinifyEnabled, fail-closed), tool/release_android.sh (new), RELEASE.md (new). android/.gitignore already blocks key.properties/*.jks/*.keystore.
- [CONV] Signing inputs: env LIMS_RELEASE_STORE_FILE/_STORE_PASSWORD/_KEY_ALIAS/_KEY_PASSWORD, or git-ignored android/key.properties; supplied from the C1 secret store by CI (REQ-SEC-128). Names are mine (spec names none).
- [CONV] Gradle throws GradleException on any release task when inputs are missing; verified: `flutter build appbundle --flavor prod` fails with that message and no debug-signing fallback.
- Tests: release_pipeline_test.dart 10/10 pass. Not run: a real signed build (no key), R8 with keep rules on a signed release.
- Open: applicationId is still the `invalid.lims.patient_app` placeholder (RELEASE.md checklist item); CI job exporting the secrets and uploading build/symbols to the C1 store is outside owned paths; iOS not started (after Android).
