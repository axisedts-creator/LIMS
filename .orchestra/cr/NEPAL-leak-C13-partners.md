Title: CR-C1-NEPAL-003: isolation probe step 9 reads "own rows" of a partner as created_by = actor; the C13 partner policy is organisation-wide (probe bug, not a leak)
From chunk: C1 (nepal)            To owner: C0-0B (db/tools/gen-isolation-probes.ts and the generated db/tests/isolation/partners.*.test.sql). C13: informed only, no change to its policies, migrations or tables.yaml.
Type: bug (test generator)
Blocking? yes for real data (the isolation suite, AC-0B-3.6 / gate 10, stays red until this lands and the go-live gate needs it green). No data exposure was found: nothing blocks the C13 code itself.

Verdict per table (all from the 2026-11-18 re-run, log /tmp/claude-0/dbsuite2.log, plus read-only SELECTs in a scratch container):
- partners.access_slips            (b) PROBE BUG: sees 1 row of its own org created by someone else (n=1)
- partners.manifests               (b) PROBE BUG: n=1, same cause
- partners.manifest_lines          (b) PROBE BUG: n=1, same cause
- partners.order_reports           (b) PROBE BUG: n=2, same cause
- partners.order_tracking          (b) PROBE BUG: n=1, same cause
- partners.pickup_request_manifests (b) PROBE BUG: n=1, same cause
- partners.pickup_requests         (b) same probe bug; also red in my re-run (n=1), not in the lead's list
- partners.tracked_specimens       (b) same probe bug; also red in my re-run (n=2), not in the lead's list
No table is (a) or (c). The policies and the data returned are exactly what the spec says; the assertion is wrong.

Problem (what the probe asserts vs what the spec says):
- Probe step 9 for a table marked `shared_with: ["partner"]` runs, as claims {actor_type partner, sub ..35, membership ..45},
  `SELECT 1 FROM T WHERE <owncol> IS DISTINCT FROM id('35') OR tenant_id <> id('01')` and expects 0 rows.
  `owncol` is `actor_id` if the table has one, else `created_by` (db/tools/gen-isolation-probes.ts:111, emitted at :1245;
  e.g. db/tests/isolation/partners.manifests.test.sql:223, partners.access_slips.test.sql:218). So "own row" means "row created_by the fixture actor".
- The C13 partner policy is not per user, it is per partner ORGANISATION: PT = `tenant_id = T AND actor_type = 'partner' AND partner_id = app.current_partner_id()`
  (C13 05-SCHEMA.md:54; matrix rows :12-:27 say "partner own org"; 07-SECURITY.md ST2 :105 / ST5 :108 test cross-PARTNER and cross-tenant, never cross-user).
  Policies: db/policies/partners.sql:97 (manifest_lines), :125 (pickup_request_manifests), :134 (order_tracking), :152 (order_reports), :211 (manifests), :230 (access_slips),
  :111 (pickup_requests), :143 (tracked_specimens); same text in db/migrations/20261115130000_partners__create_partners_schema.sql (:756 manifest_lines .. :917 access_slips; :806 tracked_specimens).
  C0 02-TRD.md:291 (step 9) says "only the rows its actor policy admits", which is the PT predicate, not "created_by = me".
- Why n>0: db/tests/fixtures/probe-rows/partners.sql gives the fixture partner (actor 35, membership 45 -> partner_users f4 -> partners f4) several rows
  whose created_by is another fixture actor (99 system, a3 portal, 34 patient), e.g. manifests f2 (partner f4, created_by 99, centre 22).
  They belong to the same organisation, so the policy correctly shows them. Tables that "pass" today pass only because every row of partner f4 happens to be created_by 35.

Evidence (scratch container, `SET LOCAL ROLE lims_api`, claims as above, probe fixtures loaded; app.current_partner_id() = ...00f4):
  table                     tenant-A rows  of other partner orgs  visible to partner 35  visible and created_by<>35 (= the probe's n)  visible rows of ANOTHER org  visible rows of ANOTHER tenant
  access_slips                    4             3                       1                    1                                              0                             0
  manifest_lines                  6             4                       2                    1                                              0                             0
  manifests                       5             3                       2                    1                                              0                             0
  order_reports                   5             3                       2                    2                                              0                             0
  order_tracking                  3             2                       1                    1                                              0                             0
  pickup_request_manifests        5             3                       2                    1                                              0                             0
  pickup_requests                 5             3                       2                    1                                              0                             0
  tracked_specimens               5             3                       2                    2                                              0                             0
  Read: the partner sees only its own organisation's rows, never a row of the other partner orgs of tenant A (3-4 of them exist per table) and never a tenant B row.

Proposed change (exact; for the owner and the founder to review; nothing applied to the repo): change the partner branch of step 9 so "own" = the partner organisation
for the C13 tables. Patch is against HEAD of db/tools/gen-isolation-probes.ts, `git apply --check` clean, and generates 17 changed probe files (partners.* only):
```diff
--- a/db/tools/gen-isolation-probes.ts
+++ b/db/tools/gen-isolation-probes.ts
@@ -15,6 +15,13 @@
 const ACTORS = ["partner", "portal", "patient"] as const;
 const SCOPE_USER_ONLY = new Set(["core.membership_centres", "core.membership_branches"]); // tables with BEFORE INSERT app.tg_scope_user_only (LD-21)
 const SUBS: Record<string, string> = { partner: "35", portal: "a3", patient: "34" }; // step-9 fixture actor ids (pg_temp.id keys)
+// partner actor policy shape per shared_with=partner table of C13 (05-SCHEMA 2 PT): column compared with app.current_partner_id()
+// ("" = tenant-wide row visible to every active partner of the tenant: partners.settings).
+const PARTNER_ORG_KEY: Record<string, string> = {
+  "partners.settings": "", "partners.partners": "id",
+  ...Object.fromEntries(["partner_users", "partner_referrers", "manifest_counters", "manifests", "manifest_lines", "pickup_requests", "pickup_request_manifests", "order_tracking",
+    "tracked_specimens", "order_reports", "price_list_items", "price_list_syncs", "statement_months", "download_counters", "access_slips"].map((x) => [`partners.${x}`, "partner_id"])),
+};
 const GENERATED = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.test\.sql$/; // hand-written suites in the same dir (T0B-08_*.test.sql) never match
 
 const root = rootDir();
@@ -1241,7 +1248,10 @@
   if (d.shared_with?.length) {
     L.push("-- probe step 9: shared_with table: non-staff actors of tenant A see only the rows their actor policy admits (own rows), never tenant B rows");
     for (const a of ACTORS) {
-      if (d.shared_with.includes(a))
+      if (a === "partner" && d.shared_with.includes(a) && (t in PARTNER_ORG_KEY))
+        // C13 05-SCHEMA 2: the partner actor policy is PT = partner_id = app.current_partner_id(): every row of the actor's ORGANISATION (any created_by), same tenant.
+        L.push(`SELECT is(pg_temp.x('lims_api', ${fixtures[a]}, format('SELECT 1 FROM ${t} WHERE ${PARTNER_ORG_KEY[t] ? `${PARTNER_ORG_KEY[t]} IS DISTINCT FROM (SELECT app.current_partner_id()) OR ` : ""}%I <> pg_temp.id(''01'')', pg_temp.tcol(${rc})), 'n'), 'n=0', 'probe step 9: partner claims read only rows of their own partner organisation of shared_with table ${t} (n=0 foreign rows)');`);
+      else if (d.shared_with.includes(a))
         L.push(`SELECT is(pg_temp.x('lims_api', ${fixtures[a]}, format('SELECT 1 FROM ${t} WHERE %I IS DISTINCT FROM pg_temp.id(''${subs[a]}'') OR %I <> pg_temp.id(''01'')', pg_temp.owncol(${rc}), pg_temp.tcol(${rc})), 'n'), 'n=0', 'probe step 9: ${a} claims read only own rows of shared_with table ${t} (n=0 foreign rows)');`);
       else
         L.push(`SELECT is(pg_temp.x('lims_api', ${fixtures[a]}, 'SELECT 1 FROM ${t}', 'n'), 'n=0', 'probe step 9: ${a} claims read 0 rows of ${t} (${a} not in shared_with)');`);
```
After applying: `node db/tools/gen-isolation-probes.ts` (rewrites the 17 db/tests/isolation/partners.*.test.sql; fixtures and _registry.sql are byte-identical) and commit them.
The new assertion: `partner_id IS DISTINCT FROM (SELECT app.current_partner_id()) OR tenant_id <> A` must return 0 rows (id for partners.partners; tenant only for partners.settings, whose policy admits any active partner of the tenant, 05-SCHEMA policy `settings__select__partner`).
It is stricter than needed to cover cross-partner and cross-tenant reads, and it keeps the portal/patient `n=0` assertions unchanged.
Not touched on purpose: reporting.reports / report_versions (also `shared_with: partner`, pass today; same PT shape, can be added to PARTNER_ORG_KEY by their owner).

Backward compatible? yes (test-only). Who must react: C0-0B owns db/tools and db/tests; tests/db/T0B-DBSEED-1.fixtures.test.mjs:628-646 compares the tail of every probe from
"-- probe step 1: preconditions" with baseline commit 13a5e1cf and will report "assertions from step 1 'preconditions' onward changed" for these 17 files until the owner records them as deliberately corrected
(allow-list or new baseline). The helper preamble is NOT changed by this patch.

Tenant/security impact: none from the change itself (no RLS, grant or migration touched). Finding: no cross-tenant and no cross-partner read exists on these 8 tables for the fixture partner;
the only "foreign" rows are same-organisation rows created by other actors, which C13 intends (a partner organisation's users share the organisation's manifests, tracking, reports). REQ-SEC-040..042 (probe suite) are met once the probe states the same rule.
If the founder instead wants per-USER visibility inside a partner organisation, that is a spec change to C13 05-SCHEMA §2 PT and a policy change (a); the spec text today says the opposite.

Tests that will prove it (run from repo root; docker needed):
 1. `node db/tools/gen-isolation-probes.ts && bash db/tests/run-suites.sh db/tests/isolation/partners.*.test.sql` : step 9 green on all 17 files, 0 new failures.
    I ran the patched probes in a scratch container (patched generator in a copy, repo untouched): all `probe step 9: partner claims ...` are `ok` for access_slips, manifest_lines, manifests, order_reports,
    order_tracking, pickup_request_manifests, pickup_requests, tracked_specimens (+ the 9 other partners tables); the remaining red lines in those files are the same pre-existing ones as before (see below).
 2. Negative control (the patched probe still catches a real leak): in a scratch transaction, `ALTER POLICY manifests__select__partner ON partners.manifests USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner')`
    (drops `partner_id = current_partner_id()`), then the patched probe: `not ok 21 - probe step 9: partner claims read only rows of their own partner organisation ... have: n=3 want: n=0`. Same for access_slips (n=3).
    (Dropping only the `tenant_id` conjunct is not caught by step 9 because `app.current_partner_id()` is itself tenant-bound; tenant isolation is asserted by steps 2-4 and 8.)

Other red lines in the partners probes that are NOT part of this CR (same run; listed so nobody thinks they were fixed or ignored):
 - partners.manifest_lines steps 3, 5, 8: INSERT of a tenant-B / centre-A2 row returns E23503, expected E42501 (a BEFORE/constraint error ahead of the RLS WITH CHECK; not diagnosed); step 6 manifest_lines__order__fk and partners.partner_referrers step 6 partner_referrers__doctor__fk return E23514, expected 23503/42501.
 - partners.settings steps 1-5: "rows seeded" fails (fixture generator did not seed partners.settings).
 - db/tests/grants/T0B-08_grants.test.sql:17 "AC-0B-4.2 lims_app/lims_api/lims_worker has no DELETE on partners.manifest_lines (class C)" fails: C13 05-SCHEMA.md:274, :964, :1002, :1171 deliberately grant DELETE on manifest_lines with a draft-only policy; this is a spec-vs-test conflict for the founder (exception list or reclassification), not a leak.
IRD/regulatory impact: none.
Alternatives considered: (1) per-user "own rows" by adding `partner_user_id`/`created_by` to the partner policies: contradicts the spec and the product (a partner's staff share the lab's reports); rejected. (2) Seed every fixture row of the partner org with created_by = 35: hides the rule instead of stating it, and cannot work for system-written projections (order_tracking, order_reports, tracked_specimens are written by the system actor). (3) Add a `shared_with_scope` field to tables.yaml: more general, needs C0-0B schema work on check-registry; the constant map above is the smallest change.
