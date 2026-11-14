APPROVE

# T-REL1 review (reviewer)
- Diff 47d5ac71..HEAD touches only apps/patient_app/** plus the T-REL1 notes files. Owned paths only.
- Matches TRD §2.3 (D-STORE): Android first on the internal track, iOS second; `--obfuscate --split-debug-info` (REQ-SEC-112); symbols go to the C1 store under build/symbols and are not committed; keys are client-owned and held in the C1 secret store (REQ-SEC-128); store policy is marked UNVERIFIED.
- Signing: the release buildType no longer uses the debug key. Inputs come from env or the git-ignored android/key.properties (android/.gitignore covers key.properties, *.jks and *.keystore). Gradle fails closed on release tasks when an input is missing or the keystore file is absent. No secrets or key material are in the repo.
- Names: the LIMS_RELEASE_* env vars and RELEASE.md are flagged as [CONV]/tester assumptions because the spec names none. They are build inputs, not spec entities (tables, routes, events, permissions or error codes), so no CR is needed.
- The RLS, permission, idempotency, rate-tier, error-code and PHI-in-logs checks do not apply: no backend or log code changed.
- Tests: `flutter test test/release_pipeline_test.dart` gives 10/10 passing (rerun by reviewer). They cover the plan row's "release checklist" plus signing, fail-closed, minify, gitignore and script checks.
- Not blocking: done_when (client store accounts and keys in C1) is an external precondition. The applicationId placeholder, the CI secret-export job and iOS remain open, and RELEASE.md records them. The fail-closed guard only fires for task names containing "release". A bare `assemble` would give an unsigned release artefact, never a debug-signed one.
