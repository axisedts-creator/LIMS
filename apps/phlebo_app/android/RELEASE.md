# Phlebo app release checklist (HC-T29)

Release tags are `phlebo-v<version>`. Keys live in the C1 secret store, never in the repo. Store-policy content
requirements are UNVERIFIED: check them at submission time.

## Before the build
- [ ] Release keystore and credentials are in the C1 secret store (not on a laptop, not in git).
- [ ] CI exports `LIMS_RELEASE_STORE_FILE`, `LIMS_RELEASE_STORE_PASSWORD`, `LIMS_RELEASE_KEY_ALIAS`, `LIMS_RELEASE_KEY_PASSWORD`.
- [ ] Platform config has `legal.privacy_url` and `legal.terms_url` set for production (LD-28); the same URLs are entered in the store listings.
- [ ] Both links ("Privacy policy", "Terms of use") appear on first run and in the account/about screen, and open in the system browser (LD-28).
- [ ] `min_app_version` is set server-side for this release (REQ-SEC-113); an older build gets 426 `homecollection.app_version_unsupported`.

## Build
- [ ] Run `android/release_android.sh` (prod flavour only).
- [ ] Build fails if any signing input is missing: confirm no fallback to the debug key.
- [ ] Build is obfuscated (`--obfuscate`) and minified (R8); `--split-debug-info` symbols in `build/symbols` are stored in the C1 artefact store (mapping files kept per release), not committed.
- [ ] `jarsigner -verify -verbose -certs` shows the release certificate, not the debug one.
- [ ] CI job runs `tool/ci/scan_apk.sh` on the APK (apktool + strings + gitleaks): clean.

## Manual device test record (FLAG_SECURE, REQ-SEC-109)
Record device model, Android version, date and tester for each line.
- [ ] Screenshot of a visit/patient screen is blocked or black.
- [ ] Recent apps (task switcher) thumbnail is blank on a patient screen.
- [ ] Screen recording / casting shows no patient data.
- [ ] After leaving all patient screens, screenshots work again (flag cleared).
- [ ] Keyboard shows no suggestions or autocorrect in text fields (REQ-SEC-111).
- [ ] Old-version device build is refused with the update message (REQ-SEC-113).
