# T0B-MFAPOL-1 impl (writer)
- New db/migrations/20261116010000_identity__narrow_mfa_factors_own_policies.sql: `SET LOCAL ROLE lims_owner;` [CONV 02-CONVENTIONS:717, ruling] + exactly 3 ALTER POLICY (select USING, insert WITH CHECK, update USING+WITH CHECK) = `user_id = (SELECT app.current_actor_id()) AND tenant_id = (SELECT app.current_tenant_id())` (LD-252). No DROP/REVOKE/GRANT/other change.
- db/policies/identity.sql: same three definitions narrowed in place + LD-252 comment.
- Checks: tests/db/T0B-MFAPOL-1.static.test.mjs 10/10 pass. tests/db/T0B-10.C2.identity.test.mjs 45 pass / 4 fail = the 4 pre-existing failures named in the tests note (gate 9 on 20261115130000 partners GRANT DELETE, no-ENUM, tables.yaml, extra __platform policies); none about the __own policies.
- pnpm -s verify NOT green: @lims/api / @lims/worker typecheck errors (e.g. send_delivery.ts TS2339), pre-existing; no TS touched by this task.
- NOT RUN in the lane: the migration and db/tests/identity/T0B-MFAPOL-1_mfa_factors_own.test.sql (no psql/docker).
- FOUNDER STEP: run db/tests/run-suites.sh (T0B-10.C2_policies tests 63, 72 and AUTH-MFA-COMPLETE-1 must pass) BEFORE push-cloud.ps1.
