APPROVE

Round 4. Scope: `git diff 0051fe5..HEAD` (625a6b3 tester, 77f565a writer). Evidence: `.orchestra/notes/T0B-08-run-r5.log` (pinned supabase/postgres:17.6.1.136, elapsed 91 s <= 600 s).

Round-3 items:
1. Collation: fixed. T0B-04_audit:70 and roles/00 :13, :29, :37 now use `is(ARRAY(... ORDER BY ... COLLATE "C"), ARRAY[...]::text[])`. The 3-column and 4-column checks are concatenated with `|`. No collation error in the r5 log. The remaining `results_eq` calls (T0B-04_audit:52, views:31) pass.
2. `like()`: fixed. Every listed call is now `ok(<expr> LIKE '<pattern>', '<desc>')`, with patterns and descriptions unchanged. `grep -rnE "SELECT like\(|^\s+like\(" db/tests` returns nothing.
3. rls_exempt: no longer applies. After the 0051fe5 main merge, `db/migrations/20261105000900_core__create_event_log.sql` creates core.g_system_actors, core.g_task_registry and core.rate_limit_counters, so all 5 entries are live tables. policy_shape passes in r5.
4. Routing: done. `.orchestra/cr/T0B-08-T0B-02.md` covers #56. `.orchestra/cr/T0B-08.md` round 2 covers T0B-03_isolation #39, owner_policies #50 (identity.platform_staff absent, 42P01) and the T0B-05_queue abort (refers to CR T0B-05). Every `not ok` line or abort in r5 maps to one of these CR items.

LD-21:
- (1a) The generator applies SCOPE_USER_ONLY only to core.membership_centres and core.membership_branches, and only at steps 3/6/8. Every other table still requires E42501. The LD-21 citation is in a code comment and in the test descriptions. `--check` reports that the 31 probe files are current.
- (2) The access_log__insert__tenant WITH CHECK centre clause matches the ruling verbatim (with the `::uuid[]` cast), in both the migration and the db/policies/audit.sql mirror. Probe step 5 on audit.access_log is green.

Checked OK: names verbatim; no DISABLE / NO FORCE RLS; synthetic ids only; no PHI or secrets; edits limited to owned paths, plus the migration that LD-21 (2) ordered; `node --test tests/db/*.test.mjs` 209/209 (re-run by reviewer).

Not blocking this review, but blocking done_when ("suites re-run on pinned image"): a green run needs lead rulings on CR-C0-T0B-08 round 2, CR-C0-T0B-08-T0B-02 and CR T0B-05 (graphile_worker runner).
