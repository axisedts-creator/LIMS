Title: CR-C17-MOBILE-GATES-1-a: isolation probes fail on tables whose SELECT policy is ANY_T (patient reads own-tenant rows)
From chunk: C16 / C17 (mobile plan gates)            To owner: C0-0B (db/tools/gen-isolation-probes.ts, db/meta/tables.yaml)
Type: bug
Blocking? no — the tenant-isolation gate of docs/mobile-implementation-plan-corrected.md stays red for 6 suites until decided.
Problem: Run 2026-11-25, pinned image supabase/postgres:17.6.1.136, seeds, freshly generated probes. Probe step 9 "patient claims read 0 rows" fails with n=1 on engagement.settings, engagement.number_counters, engagement.portal_content, engagement.cs_booking_cancel_reasons, engagement.cs_enquiry_categories, engagement.cs_reminder_reasons. The policies match C16 05-SCHEMA §5.2 (settings / number_counters / cs_* SELECT = ANY_T = `tenant_id = T AND K IN ('user','system','patient','device')`; portal_content has `portal_content__select__patient`, T0C-CONTENT-1). The row read is the patient's OWN tenant's row. tables.yaml marks `shared_with: [patient]` only for PAT_*/PRE*/DISP tables (05-SCHEMA §5.2 note), so the generator emits the "not shared: 0 rows" probe for ANY_T tables.
Proposed change (exact): the owner decides how tables.yaml expresses a tenant-wide patient read (no name is proposed here: 02-CONVENTIONS forbids inventing one). For such tables step 9 for `patient` must assert "0 rows of another tenant" (`WHERE tenant_id <> A` -> n=0) instead of "0 rows". partner and portal stay at 0 rows. If instead the read is NOT wanted, the fix is a policy change in C16 05-SCHEMA §5.2 and db/policies/engagement.sql.
Backward compatible? yes (test tooling only) — unless the policy is tightened: then apps/patient_app loses reads of settings / reason codes / portal content.
Tenant/security impact: no cross-tenant read was observed in any of the 104 suites run (billing, engagement, homecollection, payments). Open question for the owner: engagement.settings is readable by every patient session of the tenant, including columns such as otp_daily_cap, max_accounts_per_patient, allowed_phone_prefixes, dormant_after_days. Confirm that is intended (REQ-SEC review).
Alternatives considered: deriving the expectation from pg_policies at probe time — rejected: the policy would then define its own test and a wrongly added patient policy would never be flagged.
Tests that will prove it: `bash db/tests/run-suites.sh db/tests/isolation/engagement.settings.test.sql db/tests/isolation/engagement.number_counters.test.sql db/tests/isolation/engagement.portal_content.test.sql db/tests/isolation/engagement.cs_*.test.sql` all ok.

---

Title: CR-C17-MOBILE-GATES-1-b: isolation probes cannot reach RLS on tables with BEFORE INSERT guards or CHECKs that fire first
From chunk: C4 / C16 (mobile plan gates)            To owner: C0-0B (db/tools/gen-isolation-probes.ts)
Type: bug
Blocking? no — 8 suites red: billing.credit_charges, credit_note_lines, credit_notes, invoices, ledger_entries, refund_requests; engagement.bookings, queue_tokens.
Problem: Same run. Steps 3 / 5 / 6 / 8 expect 42501 (RLS) or 23503 (FK). 14 assertions get P0001 and 7 get 23514. The write IS refused, but by a BEFORE INSERT trigger (billing.invoices__chronology_guard, credit_notes__chronology_guard, credit_note_lines__guard, ledger_entries__reversal_guard) or by a CHECK the probe row breaks (e.g. engagement.bookings__address_kind__ck on the bookings__address__fk probe). The probe therefore never exercises the RLS WITH CHECK / the FK it names: a missing INSERT policy on these tables would not be detected by these assertions.
Proposed change (exact): make the generated probe rows satisfy the table's guards and CHECKs (per-table fixture values in the generator), so the refusal comes from RLS / the FK. Do NOT simply add P0001 / 23514 to the accepted codes for these tables: that would turn the assertions into "something refused it".
Backward compatible? yes (test tooling only)
Tenant/security impact: none in product code. It restores the coverage the probes are meant to give on the billing document tables (REQ-SEC tenant isolation).
Alternatives considered: accept P0001 / 23514 as the SCOPE_USER_ONLY exception does for 23514 (LD-21) — weaker, see above.
Tests that will prove it: the 8 suites above ok under `bash db/tests/run-suites.sh`, with each step-3/5/6/8 assertion reporting 42501 or 23503.

---

Title: CR-C17-MOBILE-GATES-1-c: probe step 1 does not seed engagement.booking_centres
From chunk: C16            To owner: C0-0B (db/tools/gen-isolation-probes.ts)
Type: bug
Blocking? no — 1 suite red (5 assertions, all "rows seeded"); steps 2-3 of the same suite pass.
Problem: Same run. db/tests/isolation/engagement.booking_centres.test.sql: "tenant A rows seeded", "tenant B rows seeded" and the three non-staff fixture rows are not ok. The table is a system-written projection (engagement.sync_booking_centres; tables.yaml `shared_with: [patient]`, DISP policy). The cause of the failed seed was not established in this run.
Proposed change (exact): fix the fixture insert for this table in the generator (owner to determine: writer role / required columns).
Backward compatible? yes (test tooling only)
Tenant/security impact: until fixed, the patient / partner / portal read probes of this table run against an empty fixture and prove nothing.
Tests that will prove it: `bash db/tests/run-suites.sh db/tests/isolation/engagement.booking_centres.test.sql` ok.

---

Title: CR-C17-MOBILE-GATES-1-d: probe step 6 checks a DEFERRED foreign key at statement time (homecollection.mutations__batch__fk)
From chunk: C17            To owner: C0-0B (db/tools/gen-isolation-probes.ts)
Type: bug
Blocking? no — 1 suite red (1 assertion).
Problem: Same run. db/tests/isolation/homecollection.mutations.test.sql step 6: "mutations__batch__fk refuses a tenant B parent" has n=1. The constraint is `FOREIGN KEY (tenant_id, batch_id) REFERENCES homecollection.sync_batches (tenant_id, id) DEFERRABLE INITIALLY DEFERRED` (migration 20261115170000, C17 02-TRD §6.3 step 6: the batch row is inserted last). A deferred FK is checked at commit, so the INSERT succeeds at statement time. The key includes tenant_id, so a tenant B batch id cannot satisfy it at commit; that was read from the DDL, NOT executed.
Proposed change (exact): for a deferrable FK the probe runs `SET CONSTRAINTS <name> IMMEDIATE` before the insert (or checks at the end of the probe transaction) and then expects 23503.
Backward compatible? yes (test tooling only)
Tenant/security impact: none in product code; closes an unproven assertion.
Tests that will prove it: `bash db/tests/run-suites.sh db/tests/isolation/homecollection.mutations.test.sql` ok.

---

Title: CR-C17-MOBILE-GATES-1-e: a device outbox row with a schema-invalid payload blocks sync forever
From chunk: C17 (apps/phlebo_app)            To owner: C17 contracts (homecollection.yaml) via C0-0C
Type: api
Blocking? no — new rows cannot enter this state since commit 967e3762f (payload shape is checked at enqueue, apps/phlebo_app/lib/features/outbox/data/mutation_payload.dart). Only rows queued by an older build are affected.
Problem: C17 02-TRD §6.3 step 1 validates the whole push envelope, so one mutation whose payload fails the schema makes `POST /sync/mutations` answer `400 common.validation_failed` for the batch. The device re-sends the same frozen body (§7.2) and SyncStatus stays `blocked`: every later visit on that device is held back, and US-13-5 wipe is never carried out because the outbox never drains.
Proposed change (exact): one of — (1) server: a mutation whose `payload` fails its type schema is answered per mutation as `rejected` + `common.validation_failed` (the code is already in the §6.3 result-code list), recorded in `sync_batches.unresolved_mutations` like the `common.not_found` case of step 4.3; the envelope fields keep the batch-level 400. (2) client: on a batch-level `400 common.validation_failed` the device re-validates the rows of the batch locally, marks the ones that fail as a local terminal state and re-forms the batch. Option 2 needs a new local state and its rules for wipe gating and `max_device_seq_acked`.
Backward compatible? (1) yes for devices: the response shape is unchanged, a batch that failed now succeeds with a `rejected` row. (2) client only.
Tenant/security impact: none (no new surface). With (1) the refused mutation is visible to the server (ids, type, seq — no payload), which today it is not.
Alternatives considered: leaving it — a device can be recovered only by reinstalling, which loses unsynced collections.
Tests that will prove it: api homecollection sync test: a batch of 3 with the middle payload invalid -> 200, outcomes applied / rejected(common.validation_failed) / applied; phlebo `sync_engine_push_test.dart`: a pre-existing invalid row no longer leaves the engine `blocked`.

---

Title: CR-C17-MOBILE-GATES-1-f: the renderer image (services/renderer/Dockerfile.renderer) cannot be built
From chunk: C6 (mobile plan step 1)            To owner: C6 (services/renderer) + C1 (infra/ci/build.sh, compose `renderer`)
Type: bug
Blocking? yes for deployment of report rendering — compose.app.yml requires LIMS_RENDERER_IMAGE; without the image the worker's render tasks end in reporting.render_unavailable.
Problem: `docker build -f services/renderer/Dockerfile.renderer .` on 2026-11-25:
 (1) `RUN corepack enable` -> exit 127: node:26 ships no corepack. FIXED in the working tree (same `npm install -g pnpm@12.18.0` as Dockerfile.sandbox).
 (2) then `tsc ... --rootDir src` fails: `src/templates/lab/shared.ts(4,62): error TS2307: Cannot find module '../../../../../packages/shared-ts/src/bsdate/index.js'`. The Dockerfile copies only services/renderer; packages/shared-ts is outside the build context copy and outside --rootDir. NOT fixed.
 (3) packages/shared-ts bsdate imports `@remotemerge/nepali-date-converter`, a dependency of @lims/shared-ts but not of @lims/renderer: `pnpm deploy --filter @lims/renderer` will not ship it. NOT fixed.
 (4) templates/registry.ts loads `templates/{billing,analytics,smart}/index.ts` (TypeScript, DEFAULT_ROOT = ../../templates) at run time; the image copies only `dist`. NOT fixed.
 (5) the process entry started the server without the template registry, so every report template was an unknown template_id (400). FIXED in the working tree (`startFromEnv`, test in worker-clients.e2e.test.ts).
Proposed change (exact): owner decision on the image layout: compile with rootDir at the repo root including packages/shared-ts/src/bsdate and services/renderer/templates (adjusting DEFAULT_ROOT and CMD to the new dist path), and add `@remotemerge/nepali-date-converter` (or `@lims/shared-ts`) to @lims/renderer dependencies.
Backward compatible? yes
Tenant/security impact: none (no new surface); the hardening of compose.app.yml is unchanged.
Tests that will prove it: `bash infra/ci/build.sh` builds the image; with the container and the pdf-sandbox container running, `LIMS_E2E_RENDERER_URL=... LIMS_E2E_SANDBOX_URL=... LIMS_E2E_RENDERER_TOKEN_FILE=... LIMS_E2E_SANDBOX_TOKEN_FILE=... npx vitest run src/__tests__/worker-clients.e2e.test.ts` (container mode of that test) passes.
Status 2026-11-26: (2), (3), (4) fixed on branch `fix/renderer-image` (commit 046cb2d2d): tsconfig.build.json compiles from the repo root (bsdate + templates), `@remotemerge/nepali-date-converter` is a direct dependency of @lims/renderer, registry.ts loads `index.js` when `index.ts` is absent. Image builds; under the compose.app.yml hardening and limits the container mode of worker-clients.e2e.test.ts passes 7/7 against the renderer and pdf-sandbox containers. Open for the owner: review, `infra/ci/build.sh` not run, first render after a cold start took up to ~90 s on a loaded host (compose healthcheck start_period is 30 s).

---

Title: CR-C17-MOBILE-GATES-1-g: full db suite run — 293 failing assertions in 76 suites
From chunk: C6 (mobile plan, verification)            To owner: C0B (db/tests generator, db/policies) + schema owners named below
Type: bug (tests) / question
Blocking? no for mobile; yes for a green `db/tests/run-suites.sh`.
Problem: `bash db/tests/run-suites.sh` on ui/redesign 7bf082270 + 046cb2d2d (no db/ change), supabase/postgres:17.6.1.136, 2026-11-26: 572 suites, 0 psql failures, 293 `not ok` in 76 suites, elapsed 9198 s (budget 600 s; host was loaded).
 Isolation suites (259 `not ok`; 244 by what the probe got instead of what it wanted, 15 are step 1 "rows seeded" preconditions of engagement.booking_centres, partners.settings, reporting.settings — the fixture seeds no rows there, so those probes prove nothing):
 (1) 160 x `E42501` where `n=0` is wanted — 112 of them the 16 `migration_staging.*` tables (steps 2, 7, 8, 9: lims_api / lims_worker have no SELECT at all), 48 the same tables again in T0B-08_step9_fixed. Refused harder than the probe expects; same kind as entry a.
 (2) 39 x `EP0001`, 27 x `E23514`, 3 x `E23503` where `E42501`/refused is wanted (billing, catalog, smartreport, partners.manifest_lines, engagement.booking_centres, reporting.settings ...): the probe row is refused by a trigger or CHECK before RLS/FK is reached; same kind as entry b.
 (3) 6 x `n=1`: patient claims read a row of engagement.settings, cs_booking_cancel_reasons, cs_enquiry_categories, cs_reminder_reasons, number_counters, portal_content. Entry a covers settings; the other five need the same owner decision (number_counters looks unintended).
 (4) 8 x `n=1`/`n=2`: "partner claims read only own rows" on partners.access_slips, manifest_lines, manifests, order_reports, order_tracking, pickup_request_manifests, pickup_requests, tracked_specimens. Probe mistake, not a leak found: the policy scopes by `partner_id = app.current_partner_id()`, the probe compares `created_by` (pg_temp.owncol) with the acting user, so same-partner rows of another creator count as foreign. The probe has no second partner, so cross-partner isolation of these tables is NOT tested.
 (5) 1 x `n=1`: homecollection.mutations `mutations__batch__fk` accepts a tenant B parent inside the probe; same kind as entry d (deferred constraint) — to be confirmed by the owner.
 Other suites (34 `not ok`): frontdesk_billing/T0B-10.C4_schema 11, lab/T0B-10.C5_schema 5, reporting/T0B-10.C6_schema 4 (table / policy counts no longer match), grants/T0B-08_grants 3 (lims_app, lims_api hold DELETE on partners.manifest_lines, class C), smartreport/T0B-13.C14_behaviour 3, seeds/T0B-09_seeds 2 (g_permissions / role_permissions differ from permissions.yaml), frontdesk_billing/T0C-REGPARITY-2 2, policy/T0B-08_policy_shape 1, payments/T0B-13.C15_behaviour 1, immutability/T0B-08_immutability 1, anatomic/T0B-13.C11_behaviour 1 (lims_analytics SELECT on the view).
Proposed change (exact): generator: expect `E42501` where the role has no table privilege; build valid probe rows per table so the refusal comes from RLS/FK; for partner-scoped tables compare `partner_id` and seed a second partner. Owners: decide (3); fix or re-baseline the count, grants, seeds and behaviour suites.
Backward compatible? yes (tests) — except the grants finding, which removes a privilege.
Tenant/security impact: (3) and the DELETE grant on partners.manifest_lines are real questions; (4) is an untested boundary.
Tests that will prove it: `bash db/tests/run-suites.sh` ends with 0 `not ok`.

---

Title: CR-C17-MOBILE-GATES-1-h: renderer template tests that fail on text extracted from the PDF
From chunk: C6 (mobile plan, verification)            To owner: C6 tester (services/renderer/src/templates/__tests__)
Type: bug (tests)
Blocking? no
Problem: 7 tests failed on a Windows developer host (lab-report 3, modules-smart 3, printcfg-report 1). Run inside the renderer image (bundled fonts) on 2026-11-26: 5 fail.
 (1) 4 of them: the bundled Noto Sans has fi / fl ligatures, so the PDF text held U+FB01 / U+FB02 ("ﬁndings", "Signiﬁcant", "Ciproﬂoxacin"): a search or copy of those words in a report fails. FIXED: `font-variant-ligatures:none` on the lab report body (src/templates/lab/shared.ts); in the image those 4 pass. The billing and analytics templates name the same font and were NOT changed (no failing test there).
 (2) lab-report "contact_strip_extra is printed in the footer when configured": still fails in the image. The footer strip wraps between "contact" and "line" and the test's PDF text helper joins wrapped lines without a space ("contactline"). Test not changed.
 (3) lab-report "prints each analyte ...", printcfg-report "a header of 8 lines of 120 characters ...", and on the host modules-smart "AST rows": fail only on a host whose installed "Noto Sans" is not the bundled build (word spaces are lost in extraction); they pass in the image.
Proposed change (exact): tester: (2) assert the two halves or make the helper join wrapped lines with a space; (3) run these files only where the bundled fonts are installed, as devanagari.test.ts already does for its image-only check. Owner of billing / analytics templates: decide on the same ligature setting.
Backward compatible? yes
Tenant/security impact: none
Tests that will prove it: the three files pass inside the renderer image.
