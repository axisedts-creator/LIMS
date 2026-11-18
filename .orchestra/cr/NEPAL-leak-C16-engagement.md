Title: CR-C1-NEPAL-004: isolation probe step 9 expects 0 rows for patient claims on the five engagement ANY_T tables that LD-215 deliberately lets patients read (probe bug, not a leak)
From chunk: C1 (nepal)            To owner: C0-0B (db/tools/gen-isolation-probes.ts and the 5 generated db/tests/isolation/engagement.*.test.sql). C16: informed only, no change to its policies, migrations or tables.yaml. Optional hardening item for C16 at the end (separate decision).
Type: bug (test generator)
Blocking? yes for real data (the isolation suite, AC-0B-3.6 / gate 10, stays red until this lands). No data exposure found.

Verdict per table (2026-11-18 re-run, log /tmp/claude-0/dbsuite2.log, plus read-only SELECTs in a scratch container):
- engagement.settings                   (b) PROBE BUG: patient reads its own tenant's single settings row by design (S = ANY_T, 05-SCHEMA.md:1329)
- engagement.cs_booking_cancel_reasons  (b) PROBE BUG: tenant coded set, S = ANY_T (:1358)
- engagement.cs_reminder_reasons        (b) PROBE BUG: same
- engagement.cs_enquiry_categories      (b) PROBE BUG: same
- engagement.number_counters            (b) PROBE BUG: S/I/U = ANY_T (:1355), narrowed to booking_no / otp_day / linkfail keys by the RESTRICTIVE policy of migration 20261116030000; the patient read is the fixture row `otp_day:99999999` of tenant A
No table is (a) a cross-tenant leak: in every case the n=1 row is a tenant-A row.

Problem:
- The probe sees these tables as "not shared_with" because db/meta/tables.yaml has no `shared_with: ["patient"]` for them (lines 544, 574, 577-579), so db/tools/gen-isolation-probes.ts:1250-1252 asserts
  `patient claims read 0 rows of T` (n=0). Observed: `have: n=1  want: n=0` on step 9 of each of the five files (db/tests/isolation/engagement.settings.test.sql:219, cs_*.test.sql:219, number_counters.test.sql:217).
- The spec says the opposite: C16 05-SCHEMA.md:1319 defines ANY_T = `tenant_id = T AND K IN ('user','system','patient','device')`; the matrix gives `settings | S ANY_T` (:1329), `number_counters | ANY_T ANY_T ANY_T` (:1355),
  `cs_* | S ANY_T` (:1358); 02-TRD.md:923 (A31.2) repeats `cs_*` S ANY_T. The app needs them (min app version, support phone, cancel/reminder reasons, enquiry categories, booking/OTP counters).
- The founder already ruled it: LD-215 (2026-11-15) allows exactly these 7 (table, command) pairs without the staff guard; db/tools/check-registry.ts:12-22 (ANY_T_EXCEPTIONS) and
  .orchestra/cr/T0B-13.C16-GATE.nonblocking.md ("shared_with + __patient duplicates - rejected: changes the s5.2 matrix"). The static gate was taught the exception; the generated probe was not.
- Policies as built: db/policies/engagement.sql:5 (settings__select__tenant), :448 (number_counters__select__tenant), :459-:466 (RESTRICTIVE `number_counters__*__nonstaff_keys`), :513 / :520 / :527 (cs_* select);
  db/migrations/20261115160000_engagement__create_engagement_schema.sql:1494, :1937, :1976, :1983, :1990; db/migrations/20261116030000_engagement__narrow_number_counters_access.sql:11.

Evidence (scratch container, `SET LOCAL ROLE lims_api`, claims {actor_type patient, sub ..34, membership ..44}, probe fixtures loaded):
  table                          rows visible to the patient   of which tenant B
  settings                        1 (id ..f1, tenant A)            0
  cs_booking_cancel_reasons       1 (code 'b', tenant A)           0
  cs_reminder_reasons             1                                 0
  cs_enquiry_categories           1                                 0
  number_counters                 1 (otp_day:99999999, tenant A)    0   (tenant B fixture row `card_no:11` is invisible)
  Key-family check with extra tenant-A rows added in the same rolled-back transaction: the patient sees `booking_no:26`, `otp_day:..` and `linkfail:<any uuid>:..`, and does NOT see `card_no:26` (RESTRICTIVE policy works as written).
  Negative control for the proposed probe: with `settings__select__tenant` / `cs_enquiry_categories__select__tenant` altered to drop `tenant_id = current_tenant_id()`, the patched probe fails
  `not ok 16 - probe step 9: patient claims read no tenant B row of engagement.settings (ANY_T, LD-215)` (and the steps 2 and 8 fail too).

Proposed change (exact; for the owner and the founder to review; nothing applied to the repo). Smallest change: a constant set in the generator that mirrors check-registry's LD-215 list and
asserts the property the policy really promises (a patient never reads a tenant B row). Patch is against HEAD of db/tools/gen-isolation-probes.ts, `git apply --check` clean, changes exactly the 5 probe files:
```diff
--- a/db/tools/gen-isolation-probes.ts
+++ b/db/tools/gen-isolation-probes.ts
@@ -15,6 +15,10 @@
 const ACTORS = ["partner", "portal", "patient"] as const;
 const SCOPE_USER_ONLY = new Set(["core.membership_centres", "core.membership_branches"]); // tables with BEFORE INSERT app.tg_scope_user_only (LD-21)
 const SUBS: Record<string, string> = { partner: "35", portal: "a3", patient: "34" }; // step-9 fixture actor ids (pg_temp.id keys)
+// LD-215 (founder, 2026-11-15; db/tools/check-registry.ts ANY_T_EXCEPTIONS): C16 05-SCHEMA 5.1 ANY_T admits the patient actor on these tables by design
+// (tenant settings and coded sets, booking / OTP rate counters); they are NOT shared_with. The patient probe asserts tenant isolation only: the key-family
+// restriction of number_counters (RESTRICTIVE policy, migration 20261116030000) has its own pgTAP suite db/tests/engagement/T0B-CNTPOL-1_number_counters.test.sql.
+const ANY_T_PATIENT_READ = new Set(["engagement.settings", "engagement.cs_booking_cancel_reasons", "engagement.cs_reminder_reasons", "engagement.cs_enquiry_categories", "engagement.number_counters"]);
 const GENERATED = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.test\.sql$/; // hand-written suites in the same dir (T0B-08_*.test.sql) never match
 
 const root = rootDir();
@@ -1249,7 +1253,10 @@
   } else {
     L.push("-- probe step 9: partner, portal and patient claims of tenant A read 0 rows (table not shared with non-staff actors)");
     for (const a of ACTORS)
-      L.push(`SELECT is(pg_temp.x('lims_api', ${fixtures[a]}, 'SELECT 1 FROM ${t}', 'n'), 'n=0', 'probe step 9: ${a} claims read 0 rows of ${t}');`);
+      if (a === "patient" && ANY_T_PATIENT_READ.has(t))   // LD-215: ANY_T table: the patient reads rows of tenant A only, never a tenant B row
+        L.push(`SELECT is(pg_temp.x('lims_api', ${fixtures[a]}, format('SELECT 1 FROM ${t} WHERE %I <> pg_temp.id(''01'')', pg_temp.tcol(${rc})), 'n'), 'n=0', 'probe step 9: patient claims read no tenant B row of ${t} (ANY_T, LD-215)');`);
+      else
+        L.push(`SELECT is(pg_temp.x('lims_api', ${fixtures[a]}, 'SELECT 1 FROM ${t}', 'n'), 'n=0', 'probe step 9: ${a} claims read 0 rows of ${t}');`);
   }
   L.push("", "SELECT * FROM finish();", "ROLLBACK;", "");
   return L.join("\n");
```
After applying: `node db/tools/gen-isolation-probes.ts` and commit the 5 regenerated engagement probes (fixtures and _registry.sql stay byte-identical).
The partner and portal assertions on these tables stay `n=0`. The key-family restriction of number_counters is not repeated in the probe: with the current fixture tenant A has no row outside the allowed key families,
so such an assertion would pass vacuously; it is covered by db/tests/engagement/T0B-CNTPOL-1_number_counters.test.sql.
Single source of truth (optional, owner's call): export one ANY_T table list from db/tools/sql-lib.ts and use it in both check-registry.ts and the generator, so the two cannot drift again.

Backward compatible? yes (test-only). tests/db/T0B-DBSEED-1.fixtures.test.mjs:628-646 compares each probe's tail from "-- probe step 1: preconditions" with baseline commit 13a5e1cf; the 5 files need to be recorded as deliberately corrected (allow-list or new baseline). Helper preamble unchanged.

Tenant/security impact: none from the change (no RLS, grant or migration touched). Finding: patient claims never read a tenant B row on these tables; the cross-tenant boundary holds.
Risk accepted by LD-215 and recorded in T0B-13.C16-GATE-review.md:11: patient/device may INSERT/UPDATE number_counters rows of their tenant; narrowed since by the RESTRICTIVE key-family policies (T0B-CNTPOL-1) and the `patient_no_decrease` trigger.

Tests that will prove it:
 1. `node db/tools/gen-isolation-probes.ts && bash db/tests/run-suites.sh db/tests/isolation/engagement.settings.test.sql db/tests/isolation/engagement.cs_booking_cancel_reasons.test.sql db/tests/isolation/engagement.cs_reminder_reasons.test.sql db/tests/isolation/engagement.cs_enquiry_categories.test.sql db/tests/isolation/engagement.number_counters.test.sql`
    (I ran the patched probes in a scratch container with a patched generator copy: all five `probe step 9` lines `ok`; the repo was not changed.)
 2. The negative control above (weakened policy must turn step 9 red).
 3. unchanged: `node db/tools/check-registry.ts` (LD-215) and db/tests/engagement/T0B-CNTPOL-1_number_counters.test.sql.
Other red lines in engagement probes, NOT part of this CR: step 6 E23514 on engagement.bookings (bookings__address__fk), queue_tokens (queue_tokens__to__fk), smart_summaries (discounts__approval__fk on frontdesk.discounts); engagement.booking_centres step 1 "rows seeded" fails.

Optional hardening for C16 (separate decision, NOT blocking, not verified beyond the SELECT above): the RESTRICTIVE policy admits `linkfail:<account_id>:<yyyymmddhh>` keys for ANY patient of the tenant,
so patient A can read the failed-link-redeem counter of account B (a count under an opaque uuid; no PHI, low impact). If wanted, narrow to the caller's own account (05-SCHEMA.md:1153 defines the key; `app.engagement_account_id()` exists):
  patient branch of the three RESTRICTIVE policies: `counter_key ~ '^(booking_no:[0-9]{2}|otp_day:[0-9]{8})$' OR counter_key ~ ('^linkfail:' || (SELECT app.engagement_account_id())::text || ':[0-9]{10}$')`
This would be a new migration owned by C16/C0-0B plus a case in T0B-CNTPOL-1; not proposed as a diff here because it changes a policy.
IRD/regulatory impact: none.
Alternatives considered: (1) mark the five tables `shared_with: ["patient"]` in tables.yaml: the generator then asserts "own rows" via created_by = 34 and fails the same way (the rows are tenant-wide, created by the system), and check-registry would then demand `__patient` policies LD-215 rejected; (2) delete the patient read: contradicts the spec (the app cannot read its settings and coded sets); (3) a new tables.yaml field: more general, but changes the registry schema.
