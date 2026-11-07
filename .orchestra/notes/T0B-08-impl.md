# T0B-08 impl (writer, review round)
- Files: `db/tools/gen-isolation-probes.ts`; regenerated `db/tests/isolation/*` (12 probes + `_registry.sql`). No test file edited. CR: `.orchestra/cr/T0B-08.md`.
- Review 1 [CONV]: step-1 seeds inline in the generator (writer may not add `db/tests/fixtures/**`): tenant A+B rows for all 12 tables, centres A1/A2 on audit tables, access_log rows per step-9 actor. `probe_fixture:` still unsupported (later chunks add seeds there).
- Review 2: step-1 preconditions as superuser (tenant A/B rows, centre A1/A2 rows, fixture-actor rows) -> missing fixture fails, not passes.
- [CONV] step 5 INSERT and step 6 use full-row copies; step 6 runs in a rolled-back subtxn with T emptied so UNIQUE keys (e.g. memberships__user_id__p_uq) cannot mask the FK; step 6 now prints `have`.
- Review 3 live run (`bash db/tests/run-suites.sh`, supabase/postgres:17.6.1.136): elapsed 59 s (first cold run 169 s), <= 600 s. Probes: 10/12 files clean; 7 `not ok` = CR-C0-T0B-08 (scope trigger 23514 on membership_{centres,branches} steps 3/6/8; access_log INSERT has no centre clause, step 5 n=1 = real centre gap).
- Non-probe `not ok` / aborts (tester or earlier-task files, not mine): T0B-02 #56 default ACL; T0B-03_isolation #39 (same 23514); T0B-04_audit + roles/00 collation error in results_eq; T0B-06 `like(text,unknown,unknown)`; contracts_platform needs core.event_log (T0B-05); policy_shape #1 rls_exempt; roles #42-48 SET ROLE.
- Ran: `node --test tests/db/*.test.mjs` 170/170; `gen-isolation-probes.ts --check` ok.
