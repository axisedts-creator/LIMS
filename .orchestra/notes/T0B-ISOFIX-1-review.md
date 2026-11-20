APPROVE

Scope: `git diff 8fac4c994..HEAD` = regenerated probe-rows fixtures (8 files, tester commit 9fee429 per LD-270) + impl note line; no generator, policy, migration, grant, spec or product change (LD-263 respected). The .orchestra/cr PLATFORM-WIRE-1 rename is lane harness, not task code.

Verified by running:
- `node db/tools/gen-isolation-probes.ts --check`: ok (438 probe files, 18 fixture files current).
- `node --test tests/db/T0B-DBSEED-1.fixtures.test.mjs`: 35/35 pass, incl. the 5 ISOFIX tests.

Verified by reading:
- analytics.exports / analytics.schedules rows now `scope_all_centres = true`; satisfies exports__scope__ck / schedules__scope__ck (migration 20261105002100 lines 290, 333); no other value in those rows changed.
- object_path rows now start with `pg_temp.id(tenant)` text ('01900000-0000-7000-8000-0000000000NN', generator line 84), so `split_part(object_path,'/',1) = tenant_id::text` holds for each row's tenant.
- smallint[]/integer[] columns now '{n}' (valid numeric array input).
- analytics.report_runs keeps scope_all_centres = false: that table has no scope CHECK (lines 352-367), so correct.
- Names verbatim; synthetic UUIDs only; no PHI, no secrets.

Not verified: pgTAP isolation suites (docker, founder step in LD-263); evaluator TRUE/NULL verdicts in the checks note are judged, not executed.
