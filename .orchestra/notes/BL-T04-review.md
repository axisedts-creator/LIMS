APPROVE
# BL-T04 review (reviewer) — diff 25eafad..5e79ae6
- Matches 02-TRD §12 steps 0–3: pattern check before SQL; `set_config('lock_timeout', $1, true)`; UPDATE … `last_no + 1`, `updated_at`, `updated_by`, `closed_at IS NULL` RETURNING `last_no, clock_timestamp() AS allocated_at`; 0 rows → INSERT (last_no 0) ON CONFLICT DO NOTHING, retried once → `billing.fiscal_year_closed`; 55P03 → `billing.counter_busy` (Retry-After 1); reset to '0' right after; FY check → `counter_busy` detail `fiscal_year_rollover`. No self-retry (D-25).
- Error codes/http verbatim from 03-IC §errors (counter_busy 503, fiscal_year_closed 409, numbering_pattern_invalid 409, common.validation_failed 400). Columns match migration 20261105001700 DDL; SERIES/FY regexes = DDL CHECKs.
- Tenant isolation: runs in caller's `tx` (RLS via requestTx); all values bound, no interpolation. No PHI/log lines, no secrets. Only billing-owned paths + own notes.
- [CONV] accepted: 55P03 from the row-create INSERT also mapped to counter_busy (still a counter statement); `AND is_active` mirrors counters.repo.ts.
- Ran `.orchestra/notes/BL-T04-verify.cmd` equivalent: 48 passed, 7 skipped (counter.live.test.ts, no DB), 0 failed.
- Not verified: live PG run (200 real parallel tx, real lock timeout) — needs LIMS_TEST_DATABASE_URL + LIMS_TEST_APP_DATABASE_URL before merge-to-main gate.
