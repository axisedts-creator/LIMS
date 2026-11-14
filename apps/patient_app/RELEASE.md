# Patient app release checklist (T-REL1)

Android first (internal track), iOS only after Android is accepted. Store accounts, listings and signing keys are
client-owned (founder decision 2026-11-06, research/04 §13); keys live in the C1 secret store, never in the repo.
Store-policy content requirements are UNVERIFIED: check them at submission time.

## Before the first build
- [ ] Client-owned store accounts exist (Google Play Console; Apple Developer later) and the client holds the listing.
- [ ] Release keystore and its credentials are in the C1 secret store (not on a laptop, not in git).
- [ ] The real per-tenant `applicationId` replaces the `invalid.lims.patient_app` placeholder in `android/app/build.gradle.kts`.
- [ ] CI job exports `LIMS_RELEASE_STORE_FILE`, `LIMS_RELEASE_STORE_PASSWORD`, `LIMS_RELEASE_KEY_ALIAS`, `LIMS_RELEASE_KEY_PASSWORD` from the C1 secret store.

## Build (Android)
- [ ] Run `tool/release_android.sh` (prod flavour only; dev and staging never ship).
- [ ] Build fails if any signing input is missing: confirm it does not fall back to the debug key.
- [ ] Bundle is obfuscated (`--obfuscate --split-debug-info`) and minified; symbol files from `build/symbols` are stored in the C1 artefact store, not committed.
- [ ] Verify the bundle is not debug-signed (`jarsigner -verify -verbose -certs` shows the release certificate).
- [ ] `strings` scan of the release binary finds no secrets; no push or analytics SDK (T-SEC1 checks pass).

## Distribute
- [ ] Upload to the Play **internal** testing track only until the client's accounts are in place and the chunk gate (05-DoD §3) passes.
- [ ] Record version, build number and symbol-file location in the release notes.

## iOS (after Android)
- [ ] Android internal track accepted; client Apple Developer account and signing assets in the C1 secret store; repeat this checklist for iOS.
