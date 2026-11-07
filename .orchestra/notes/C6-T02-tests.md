# C6-T02 tests (tester)
Dir: services/api/src/modules/reporting/domain/__tests__/ — readiness, version.state, version, flags, delivery.state, tokens, otp (.test.ts). Run: `.orchestra\notes\C6-T02-verify.cmd`.
Spec names no function signatures; API is ASSUMED (header comment of each test lists it). Writer must match or raise a dispute.
- Fail now: modules under domain/ do not exist (import resolution). Cover AC-02.2/02.3 (readiness), 02.6/06.6 (version.state, version), 02.7 (flags), 10.5 (tokens), SEC test 8 (otp).
- Exhaustive 6x6 matrices for version + delivery states (+ named forbidden). Delivery assumption: strict chain (no queued->delivered, no sent->read); delivered->failed allowed; `read` only for channel whatsapp.
- checkRelease: status checked before latest (discarded+newer -> release_not_ready, CR-C6-005). Narrative amendment counts as `amended` even with an excluded code.
- Fingerprint is tested by properties only (exact line/join format not specified in TRD §4.2). Imports relative `../x.js`; tokens/otp may use packages/shared-ts/src/crypto/index.js.
- Not covered here: document grouping/decimals (T06), messages (T19), narrative/report states, assembly debounce scheduling (service, T08).
