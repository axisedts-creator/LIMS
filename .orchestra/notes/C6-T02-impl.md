# C6-T02 impl (writer)
Files: services/api/src/modules/reporting/domain/{readiness,version.state,version,flags,delivery.state,tokens,otp}.ts — all match tester's assumed API; no dispute.
[CONV] fingerprint: lines `<id>|lab:<h>|nar:<ids sorted, ",">|out:<file>` sorted, joined "\n", then `|demog:<n>`; absent lab/out = empty string.
[CONV] shared-ts imported by relative path (same as core/errors.ts, frontdesk/domain) until it is a services/api dependency.
[CONV] OTP verify: ASCII `^[0-9]{6}$` + 32-byte length check before node timingSafeEqual; OTP_MAX_TTL_SECONDS=600 (TRD §6 env cap).
Run: verify.cmd suite 7 files / 187 tests pass; `tsc --noEmit` clean; no eslint installed in services/api.
Open: full api suite has 5 core boot tests (C0-owned) timing out at 5 s under 50-worker load; health.test passes alone with longer timeout — not caused by this task.
