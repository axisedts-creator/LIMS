APPROVE
Round 2 review of `git diff 2b61a6d2a..HEAD` (T0C-REGPARITY-2, fix commit fe1d4074f).

Item 1 (gate 9 DROP POLICY) is fixed. All 18 `DROP POLICY IF EXISTS` lines are gone. Each CREATE POLICY now sits in a DO block guarded by NOT EXISTS on pg_policy (polrelid + polname), with the same names and bodies, and the header line 18-19 matches. `node db/tools/check-migrations.ts` now reports only the old partners.manifest_lines line.

Re-checked and unchanged from round 1: the contract diff is additive. x-permission, x-idempotency, x-rate-limit-tier and x-error-codes use existing values only. RLS ENABLE+FORCE is set on all 6 tables, and the policies are shaped like frontdesk.patients. reward_points_ledger is SELECT+INSERT only. The D-27a exclusion is extended on orders__audit. There are no secrets and no PHI in logs, and only owned paths are touched.

Runs by the reviewer (2026-11-17 07:45 NPT): vitest regparity2+regparity1+c4 passed 776/776. The pgTAP suite db/tests/frontdesk_billing/T0C-REGPARITY-2_registration_parity.test.sql, run from the lane root, gave no `not ok` and no ERROR.

LEAD MERGE BLOCKER (outside this task's file list, so not a writer defect; carried over from round 1 item 2 with no ruling yet): the PR steps `check-registry` and `policy diff vs db/policies` will fail. The reason is that db/meta/tables.yaml has no rows for the 6 new tables or the new columns, and neither do the 13 REGPARITY-1 patients columns. Also, db/policies/frontdesk.sql does not mirror the 18 new policies. The lead must open a follow-up task (or extend the file list) that merges together with this one before main.
