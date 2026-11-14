APPROVE

Re-review of `git diff 63451b6b..HEAD` (BL-T14) after review round 1. Ran BL-T14 verify suites: api 4 files 53/53 pass; worker 28 pass / 14 skipped (cbms.live.test.ts skipped, no LIMS_TEST_DATABASE_URL, so SQL/RLS/triggers are not verified live).
Round-1 item 1 fixed: cbms_sweep.ts `stale_1h` now ages from invoices.created_at / cancelled_at / credit_notes.created_at (`age_at`), and is forced to 0 unless LIMS_BILLING_CBMS_MODE=live; wiring and live tests pin both cases.
Round-1 item 2 fixed: alerts/cbms.rules.yaml (matches the TRD glob alerts/*.yaml).
Checked: column names in cbms.repo.ts / cbms_sweep.ts match billing schema migration 20261105001700 (cbms_*, cbms_cancel_*, credit_note_id, cancelled_at); every query filters by tenant_id; payload tenant guard (REQ-SEC-024); stub returns only stub_recorded, so it never marks synced; client error message is dropped (no PHI/secrets in logs); LD-26 is cited and applied (TRN- prefix, not_required, B31 refused).
Open (not defects in BL-T14): CR C2.T16 (`trainingMode` key in the real C2 port); registry rows for billing.cbms_sync/cbms_sweep; live-DB run still needed.
