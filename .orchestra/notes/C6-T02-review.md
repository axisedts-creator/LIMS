APPROVE
# C6-T02 review (reviewer)
Diff 548783cd..HEAD: only `services/api/src/modules/reporting/domain/*` + own notes (owned paths).
Checked against 02-TRD §4.1/4.2/4.4/4.5/4.6/4.7/4.8, 03-IC §10.3 + §3.18, 05-SCHEMA tg_report_versions_guard, CR-C6-004/005, PRD AC-02.2/02.3/02.6/02.7/06.6/10.5.
- version.state ALLOWED == 05-SCHEMA guard + 03-IC §10.3 table; checkRelease codes verbatim (`reporting.release_not_ready`, `reporting.version_not_latest`), status before latest per CR-C6-005.
- versionKind: rules 0-4 in order, exclusion set D-61 verbatim, narrative always counts, `smart_summary_added` falls through, `addendum` rule 2.
- flags/methodLine/refRange match §4.4 + AC-02.7. Tokens 16/16/32/32 bytes via shared-ts crypto, 32-byte SHA-256 stored only. OTP HMAC msg `challenge_id:code`, timingSafeEqual, 5 attempts / 600 s / 3 per hour.
- Delivery chain matches §4.8 (non-terminal -> failed, failed -> queued, suppressed/read terminal).
- No DB/RLS/routes/permissions/logging in this task (pure domain) — N/A. No PHI, no secrets, no invented names.
Ran: domain suite 7 files / 187 tests pass; `tsc --noEmit` clean.
Non-blocking note (for T19/send task): `delivery.state.canTransition` defaults `channel` to 'whatsapp', so a caller omitting channel may mark an SMS/email delivery `read`. Callers must always pass channel.
