APPROVE
Round 2. Both round-1 defects fixed:
1. projection.service.ts:71 (`specimensOfOrder`), :132 and :169 now SELECT `specimen_type_code`; lab.specimen.rejected.v1.ts:30 and lab.specimen.status_changed.v1.ts:28 now carry the stored code into `upsertSpecimens`, so the NOT NULL column (05-SCHEMA) is never written NULL. The test pins this on the SQL text and on the row value (`EDTA_WB`).
2. billing.balance.changed.v1.ts accepts a missing `release_basis` (03-IC §3.5 optional). `applyBalance` keeps the stored basis and derives `payment_due` from it. New test covers this.
Round-1 checks still hold (names verbatim, tenant from job, inbox dedupe, seq guards, unlinked no-op, partner filter, no logging, no secrets). patient_events 46/46 pass locally (vitest). Not verified: real Postgres (RLS, NOT NULL, FOR UPDATE races).
