# T0B-PEVPOL-1 impl (writer)
- Files: db/migrations/20261116020000_reporting__narrow_provider_events_update_policy.sql (new: leading `SET LOCAL ROLE lims_owner` + one ALTER POLICY provider_events__update__tenant, USING ... `(SELECT app.current_actor_type()) = 'system' AND applied_at IS NULL`, WITH CHECK same with `IS NOT NULL`); db/policies/reporting.sql (same text). No test, spec, grant, trigger or other policy touched.
- [CONV] 02-CONVENTIONS line 717 leading role switch (T0B-MFAPOL-1 ruling); function calls wrapped `(SELECT ...)` as the rest of the file; LD-257 cited in comments.
- Ran: T0B-PEVPOL-1.static 11/11 pass; T0B-10.C6 policy tests (verify.cmd pattern) 4/4 pass; tests/db/*.test.mjs 1491/1530 pass, 39 fail (pre-existing gate 9 / check-migrations partners GRANT DELETE, stage-order, role and identity inventory failures), plus 2 below.
- OPEN 1 CLOSED: review items 1-2 were test-only; tester fixed both (659998167). Re-ran T0B-PEVPOL-1.static + T0B-MFAPOL-1.static: 21/21 pass. No implementation file changed in this round.
- OPEN 2: T0B-REVIEW-1.reports "git shows no change outside the three CRs" lists the two uncommitted files; expected to clear when the lane harness commits [writer] T0B-PEVPOL-1 - not verified.
- NOT run in the lane: the migration and the pgTAP file (no Postgres); founder runs db/tests/run-suites.sh before push-cloud.ps1.
- SPEC FOLLOW-UP (lead): C6 05-SCHEMA section 5 provider_events U = SYS + applied_at IS NULL (USING) / IS NOT NULL (WITH CHECK). Test 462 of T0B-08_policy_shape not edited (ANY_T exemption stays a lead decision).
