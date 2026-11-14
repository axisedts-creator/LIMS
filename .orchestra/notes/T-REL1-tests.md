# T-REL1 tests (tester)
- File: apps/patient_app/test/release_pipeline_test.dart (static checks; no store account or key needed).
- Run: `.orchestra\notes\T-REL1-verify.cmd` (or `cd apps/patient_app && flutter test test/release_pipeline_test.dart`).
- Proves: release not debug-signed; signing read from file/env (C1 secret store), fails closed; minify; no keystore/key.properties/password in repo + gitignore; prod-only `flutter build appbundle --obfuscate --split-debug-info` script; RELEASE.md checklist.
- Now: 3 pass (guards), 7 fail for the right reason (gradle still debug-signs; no script, no RELEASE.md, no gitignore entries).
- Writer assumptions (spec names none): checklist `apps/patient_app/RELEASE.md`; script = any *.sh/*.cmd/*.ps1 under apps/patient_app (e.g. tool/); gradle defines signingConfigs release with storeFile/storePassword/keyAlias/keyPassword from file or env, throws GradleException if missing.
- Not testable here: actual signing, Play upload, iOS (after Android), C1 store contents.
