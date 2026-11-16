APPROVE
Round 2. The round-1 finding is fixed: db/tests/identity/T0B-MFAPOL-1_mfa_factors_own.test.sql:91-92 (d) now filters `WHERE user_id = '…a300'` and expects n=1. The partner assertion at 93-94 is unchanged and still expects n=1.
Checked and OK:
- The migration 20261116010000 holds `SET LOCAL ROLE lims_owner;` (per the ruling) and then exactly three ALTER POLICY statements with the LD-252 predicate verbatim: select USING, insert WITH CHECK, update both.
- No DROP, REVOKE or GRANT, and no other policy change. db/policies/identity.sql:105-111 matches the migration. The file name sorts last.
- The edit to tests/db/T0B-10.C2.identity.test.mjs only accounts for the narrowing and weakens nothing.
- The pgTAP (a)-(e) assertions are consistent with the policy set and app.is_platform_actor(), which needs aal2 and scope platform. The fixtures follow the T0B-10.C2_policies shapes and satisfy the CHECK constraints.
- Notes say NOT RUN in the lane and name the founder's run-suites.sh step before push-cloud.ps1. Synthetic data only, no secrets or PHI, owned paths only.
Commands run:
- `node --test tests/db/T0B-MFAPOL-1.static.test.mjs`: 10/10 pass.
- `tests/db/T0B-10.C2.identity.test.mjs`: 45 pass, 4 fail. All 4 failures were already there before this task. The "EXACTLY §10.1" diff lists only extra __platform/owner policies and no __own entry.
Not checked: pnpm -s verify. The impl note says it fails on @lims/api and @lims/worker typecheck errors, which come from code this task did not touch. The pgTAP file and the migration were not run.
