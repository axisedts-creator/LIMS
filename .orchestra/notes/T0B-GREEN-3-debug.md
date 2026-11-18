# T0B-GREEN-3 debugger (2026-11-18)
- Verify log: 10 not ok only. identity/PLATFORM-DDL-1 105,113,115,117,135,198,202,203 (all E42501) + identity/T0B-ASYNC-1 58,59. 0 psql aborts. Rest pass.
- Cause 1: platform write fires AFTER trigger app.tg_row_audit (DEFINER); audit_log__insert__owner_only (20261105000600:41) refuses audit row with tenant_id != current_tenant_id -> E42501. Platform policies fine (trigger-disabled probe gives n=1). 202/203 follow from 198 leaving no rows.
- Cause 2: app.uuidv7() ACL = lims_owner only; worker consumers lab.result.verified.v1.ts:13, instruments.result.received.v1.ts:11 call it as lims_worker.
- No fix applied: both fixes are policy/grant migrations (or worker runtime edit), stop-list under LD-268; tests are correct, no dispute. Lead decides via CR-001 (identity-platform-audit), CR-002 (identity-worker-uuidv7), plus the definer-inventory CR.

## Round 2 (2026-11-18 00:59)
- Re-verify log (00:58:49) identical: same 10 not ok (PLATFORM-DDL-1 x8, T0B-ASYNC-1 58/59), 0 aborts. Cause unchanged: audit_log__insert__owner_only vs DEFINER tg_row_audit; app.uuidv7() EXECUTE missing for lims_worker.
- No code fix: both need policy/grant migration (LD-268 stop-list); tests match spec, no dispute. CRs already filed (.orchestra/cr/T0B-GREEN-3.*.nonblocking.md). Verify stays red until lead rules on CR-001/002.

## Round 3 (2026-11-18)
- Re-verify log (01:03:07) still the same 10 not ok (PLATFORM-DDL-1 x8, T0B-ASYNC-1 58/59), 0 aborts. Cause unchanged: audit_log__insert__owner_only vs DEFINER tg_row_audit; app.uuidv7() EXECUTE missing for lims_worker.
- No code fix: both are policy/grant migrations (LD-268 stop-list); tests match spec, no dispute. CRs filed in .orchestra/cr/T0B-GREEN-3.*.nonblocking.md. Needs lead ruling; more debugger rounds change nothing.

## Round 4 (2026-11-18, LD-365/LD-367)
- Ran verify first: identity PLATFORM-DDL-1, T0B-ASYNC-1, definers T0B-08 all ok now (LD-365 migrations 20261118000000/000100 work). 0 psql aborts. 7 not ok left, all in engagement: T0B-13.C16_schema (1,2,520,642,698) and T-SEC1_table_probes (1,3).
- Cause: STALE expectations. Merge of main brought T0C-CONTENT-1 migration 20261117130000_engagement__add_portal_content.sql (tables portal_content, profile_image): schema has 45 tables, tests want 43; the table, index, audit-trigger and FK counts omit them.
- No implementation fix possible: code is right, tests are older than the migration. Tester must update those expectations (cite 20261117130000) and, if probe fixture needs rows, file a CR (db/tests/fixtures is harness-owned; the pending probe-rows/engagement.sql edit is the writer's reverted one, left untouched).
