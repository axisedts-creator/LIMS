Title: CR-C1-NEPAL-005: isolation probe step 6 cannot see a DEFERRABLE INITIALLY DEFERRED foreign key, so homecollection.mutations__batch__fk "accepts" a tenant B parent (probe artifact, not a leak)
From chunk: C1 (nepal)            To owner: C0-0B (db/tools/gen-isolation-probes.ts and the generated db/tests/isolation/homecollection.mutations.test.sql). C17: informed only, no change to its migration (the deferral is specified).
Type: bug (test generator)
Blocking? yes for real data (the isolation suite, AC-0B-3.6 / gate 10, stays red until this lands). No data exposure found: the database refuses the row at COMMIT.

Verdict:
- homecollection.mutations (b) PROBE ARTIFACT: `mutations__batch__fk` is a composite FK (tenant_id, batch_id) -> sync_batches (tenant_id, id) declared DEFERRABLE INITIALLY DEFERRED by the spec; the probe INSERT is only ever rolled back, never committed, so the deferred check never runs and the INSERT reports n=1.

Root cause (file:line):
- db/migrations/20261115170000_homecollection__create_homecollection_schema.sql:298-299:
  `CONSTRAINT mutations__batch__fk FOREIGN KEY (tenant_id, batch_id) REFERENCES homecollection.sync_batches (tenant_id, id) DEFERRABLE INITIALLY DEFERRED`
  Specified, not an accident: C17 05-SCHEMA.md:427 and 02-TRD.md:400 (§6.3 step 6: "the batch row is inserted last ... `mutations__batch__fk` is DEFERRABLE INITIALLY DEFERRED so the earlier mutation inserts may reference it"); db/tests/homecollection/T0B-13.C17_schema.test.sql:78 pins the definition, so the FK must stay deferred.
- db/tools/gen-isolation-probes.ts:158-169 (`pg_temp.fk_try`) runs the INSERT with `pg_temp.x(...)` inside a subtransaction that it always aborts with `probe_rollback`; step 6 is emitted at :1229-1233.
  A deferred constraint is only checked at COMMIT / SET CONSTRAINTS IMMEDIATE, neither of which the probe reaches. `mutations__centre__fk`, `__device__fk`, `__visit__fk` are immediate and give E23503 in the same run. The generator has no notion of deferrable FKs (it is the only DEFERRABLE FK in db/migrations).
- generated probe: db/tests/isolation/homecollection.mutations.test.sql:208-210; failing line `not ok 10 - probe step 6: mutations__batch__fk ... have: n=1 want: refused`.

Evidence (scratch container; the probe's own fk_probes()/fk_try() against homecollection.mutations, fixtures loaded):
  FK                      condeferrable  condeferred  probe result as written   same statement after `SET CONSTRAINTS ALL IMMEDIATE`
  mutations__batch__fk         t             t          n=1                       E23503
  mutations__centre__fk        f             f          E23503                    E23503
  mutations__device__fk        f             f          E23503                    E23503
  mutations__visit__fk         f             f          E23503                    E23503
  So the composite FK does reject the tenant B parent (tenant A row + tenant B batch id: no (tenant_id, id) match); it just does so at commit time. RI checks run as the table owner and are not subject to RLS, so there is no way around it from lims_api.

Proposed change (exact; for the owner and the founder to review; nothing applied to the repo): emit `SET CONSTRAINTS ALL IMMEDIATE;` before step 6 only for tables that own a deferrable FK (read from the migrations), so the step-6 INSERT is checked at statement time.
Patch is against HEAD of db/tools/gen-isolation-probes.ts, `git apply --check` clean, changes exactly one probe file (homecollection.mutations: one added line; helper preamble and the other 454 probes unchanged):
```diff
--- a/db/tools/gen-isolation-probes.ts
+++ b/db/tools/gen-isolation-probes.ts
@@ -258,7 +258,7 @@
 // (test-only; never db/seeds: push-cloud.ps1 applies db/seeds to staging, REQ-SEC-041/136). Plain INSERT ... VALUES only, no constraint
 // disabled; the replica window of the probe is the core fixtures' own. Synthetic values only. Deterministic.
 type Col = { notNull: boolean; hasDefault: boolean; generated: boolean; type: string; def: string | null };
-type Fk = { cols: string[]; parent: string; pcols: string[] };
+type Fk = { cols: string[]; parent: string; pcols: string[]; deferrable?: boolean };
 type Tbl = { cols: Map<string, Col>; pk: string[]; uniques: string[][]; soft: { cols: string[]; where: string }[]; fks: Fk[]; checks: string[] };
 type Val = { sql: string; v: any };
 type Row = Record<string, Val>;
@@ -353,7 +353,7 @@
   if ((m = /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(d))) tblOf(t).pk = m[1].split(",").map(unq);
   else if ((m = /^UNIQUE\s*(?:NULLS\s+NOT\s+DISTINCT\s*)?\(([^)]*)\)/i.exec(d))) tblOf(t).uniques.push(m[1].split(",").map(unq));
   else if ((m = /^FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\s*\(([^)]*)\)/i.exec(d)))
-    tblOf(t).fks.push({ cols: m[1].split(",").map(unq), parent: m[2], pcols: m[3].split(",").map(unq) });
+    tblOf(t).fks.push({ cols: m[1].split(",").map(unq), parent: m[2], pcols: m[3].split(",").map(unq), deferrable: /\bDEFERRABLE\b/i.test(d) && !/\bNOT\s+DEFERRABLE\b/i.test(d) });
   else if ((m = /^CHECK\s*\(/i.exec(d))) tblOf(t).checks.push(paren(d, m[0].length - 1)[0]);
 }
 function readMigrations() {
@@ -1226,6 +1226,8 @@
     L.push(`SELECT is(pg_temp.x('lims_api', pg_temp.cl('user', '31', '41'), 'SELECT 1 FROM ${t} WHERE ${cc} = pg_temp.id(''22'')', 'n'), 'n=0', 'probe step 5: centre A1 claims see 0 centre A2 rows of ${t}');`);
     L.push(`SELECT is(pg_temp.x('lims_api', pg_temp.cl('user', '31', '41'), pg_temp.copy(${rc}, 'tenant_id = pg_temp.id(''01'') AND ${cc} = pg_temp.id(''22'')'), 'w'), 'E42501', 'probe step 5: centre A1 claims INSERT a centre A2 row into ${t} -> 42501');`);
   }
+  // a DEFERRABLE FK (homecollection.mutations__batch__fk, C17 02-TRD 6.3 step 6) is otherwise checked only at COMMIT, which this rolled-back probe never reaches
+  if (SCHEMA[t]?.fks.some((f) => f.deferrable)) L.push("SET CONSTRAINTS ALL IMMEDIATE;   -- step 6: check deferrable FKs at statement time");
   L.push("-- probe step 6: every composite FK carrying the tenant column (pg_constraint): tenant A row referencing a tenant B parent -> 23503 or 42501");
   L.push(`SELECT CASE WHEN f.stmt IS NULL THEN skip('probe step 6: ' || f.conname || ' on ${t}: no tenant A row of the table or no tenant B parent row seeded', 1)`);
   L.push(`            ELSE is(CASE WHEN r.v IN ('E23503', 'E42501'${scoped ? ", 'E23514'" : ""}) THEN 'refused' ELSE r.v END, 'refused', 'probe step 6: ' || f.conname || ' on ${t} refuses a tenant B parent (23503/42501${scoped ? "; 23514 scope_user_only, LD-21" : ""})') END`);
```
Resulting probe (single added line before step 6): `SET CONSTRAINTS ALL IMMEDIATE;   -- step 6: check deferrable FKs at statement time`. `SET CONSTRAINTS` is transaction scoped and the whole probe is one rolled-back transaction, so nothing leaks into later steps.
Rejected variant: putting the same statement inside `pg_temp.fk_try` also works but changes the helper preamble of all 455 probes (tests/db/T0B-DBSEED-1.fixtures.test.mjs:628-646 pins the preamble to baseline 13a5e1cf).
After applying: `node db/tools/gen-isolation-probes.ts` and commit db/tests/isolation/homecollection.mutations.test.sql.

Backward compatible? yes (test-only). T0B-DBSEED-1 compares the probe tail with baseline 13a5e1cf: this one file needs to be recorded as deliberately corrected (allow-list or new baseline).

Tenant/security impact: none from the change. Finding: no tenant B parent can be committed through `mutations__batch__fk`. The cross-tenant boundary of homecollection.mutations (RLS steps 2-5, 7-9 all `ok` in the run) holds.
Limit worth knowing: step 6 only probes composite FKs that include tenant_id (cardinality > 1); a single-column or missing FK would not be flagged by it. For this table that is covered by T0B-13.C17_schema.test.sql:78.

Tests that will prove it:
 1. `node db/tools/gen-isolation-probes.ts && bash db/tests/run-suites.sh db/tests/isolation/homecollection.mutations.test.sql` : steps 6 all `ok` (batch, centre, device, visit). I ran the patched probe in a scratch container (patched generator copy; repo untouched): `ok 10 - probe step 6: mutations__batch__fk ... refuses a tenant B parent (23503/42501)`, 11-13 `ok`, all other steps unchanged.
 2. Real-commit confirmation (what the probe stands in for): inside one transaction INSERT a tenant A mutation whose batch_id is a tenant B sync_batches id, then `SET CONSTRAINTS ALL IMMEDIATE` (the same check COMMIT performs) -> 23503 (shown by the table above).
 3. Unchanged: db/tests/homecollection/T0B-13.C17_schema.test.sql (keeps the FK deferred and composite).
Other red lines, NOT part of this CR: in the isolation suite mutations is the only homecollection probe that fails; the non-isolation suites db/tests/homecollection/T0B-13.C17_schema.test.sql (checks 1, 2, 48, 49, 87, 90, 91, 320: table/policy counts, owner-policy GUC gate) and T0B-13.C17_anonymise.test.sql (checks 3, 12, 13, 15, 21, 23) are red in the same run for other reasons (not diagnosed here; the FK-definition check at :78 of the schema suite passes).
IRD/regulatory impact: none.
Alternatives considered: (1) make the FK immediate: contradicts TRD §6.3 step 6 (the batch row is inserted last because sync_batches is append-only) and would break the push endpoint; rejected. (2) Commit-based probe: needs a committed fixture and cleanup, breaks the "one rolled-back transaction, RLS never disabled" rule of the generator; rejected. (3) Skip the FK in the probe via an exception list: hides a real check; the one-line SET CONSTRAINTS keeps the assertion.
