# Triage — review batch 2 (C8–C12)

Date 2026-11-06. Inputs: `review/C8-analytics-mis.md`, `C9-quality-engine.md`, `C10-microbiology.md`, `C11-specialty-pathology.md`, `C12-inventory.md`. Authority applied: 00 > research/04 > 08 (§2 + Addenda A1–A13; A13 = P-1…P-15, D-1…D-43, reused, not re-decided) > 03-IC > 01/02-CV > research/01–03 > chunk docs. Founder rules respected: no new foreign touchpoint, all data in Nepal, synthetic data only. **No spec file was edited.**

Scope of verification: every BLOCKER and MAJOR, and every "Needs lead decision" item, including the minors on those lists (C8 m#15, m#22, m#24, m#31; C9 m#17–m#20, m#35; C10 m#14, m#15, m#38; C11 m#26 and C11 lead item 6 "plain vs rich text", called **C11-L6**; C12 m#40). Each was checked by opening the cited source text. MINOR findings not on a lead list were **not** re-verified; (c) lists them as reported. A few were checked incidentally and are marked "(checked)".

Result: 76 items verified. **74 CONFIRMED, 0 FALSE, 2 ALREADY-FIXED** (C9 m#17, C10 m#38). Two confirmed findings rest partly on a wrong premise (C10 #6, C9 m#19); (d) corrects them. Classification of the 74: **LOCAL 34 · CROSS 9 · DECISION 31**.

Concurrency note: `program/03-INTERFACE-CATALOG.md`, `07-BLOCKERS.md` and `08-CR-REGISTER.md` were being modified while this triage ran (mtimes 13:00–13:08 UTC, A13 apply in progress). The ALREADY-FIXED checks reflect those files as read at about 13:08 UTC. 08 contains nothing after A13.

Conventions: `[CONV]` = a value chosen in this triage; "m#" = a MINOR finding number.

---

## (a) Program-wide rules proposed (new patterns only; P-16 onward)

Findings that are instances of an existing rule are tagged "instance of P-n" in (c) and get no new rule. Instances found in this batch: P-1 (C12 #4, C10 TRD), P-3 (C9 #5, C11 #1), P-6 (C10 #4, C12 #7 and four more C12 tasks), P-8 (C10 m#15, C9 m#30, C11 m#19, C12 m#24), P-9 (C8 #9, C12 m#29), P-10 (C10 #5, C8 m#16, C12 m#25), P-13 (C11 m#31), P-15 (C8 m#29, C9 m#17).

**P-16 — The staff-actor guard is in the DDL, not only in prose.** (C8 #13, C9 #3, C10 #2)
Text for 02-CV §5.8 (replaces the CR-C13-011 bullet): "Every `__tenant` policy's USING and WITH CHECK contain `(SELECT app.is_staff_or_system())`. The only exception is a table marked `shared_with: [partner|portal|patient]` in `db/meta/tables.yaml`, which also has the matching actor-specific policy. A chunk's 05-SCHEMA puts the guard in the predicate it actually transcribes (the `pred_t` variable or the policy SQL template), not only in prose. C0-0B `check-registry` fails any `__tenant` policy without it. The generated probe adds a test that partner, portal and patient claims of the same tenant read 0 rows."
Mechanical sweep (`grep -c is_staff_or_system` on 05-SCHEMA): C8 0, C9 0, C10 1 (prose only; the DDL at l.847 lacks it). C5 and C11 already have the guard in `pred_t`. Outside this batch with 0 hits: C1, C2, C13, C15, C16, C17. Batch-3 reviewers check these; some of their tables are legitimately shared.

**P-17 — Staff names and staff pickers come from `ctx.core`.** (C8 #7, C10 #6, C11 #8)
Text for 02-CV §8 (new bullet): "A response field that shows another staff member's name (`*_display`, `*_display_name`), and any staff picker, uses `ctx.core.memberships.list` (batched by `membershipIds`, or filtered by centre, role or permission; signature in D-47) and `ctx.core.user` for user ids such as `created_by`. Results are memoised per request. `IdentityPort.getActor` returns only the caller. `IdentityPort.getSignatories` is reserved for report signatures (system actor holding `identity.signatory.read`). Modules never read `core.memberships` directly."

**P-18 — The table class follows the write path, and the purge path follows the class.** (C8 #3, m#15; C10 #8, m#14, m#36; C11 m#32; C12 #6, #7)
Text for 02-CV §5.2/§5.6/§5.11 (append):
- (a) "Class C, B and A rows are never deleted by `lims_app`, and class A rows are never updated. A table whose rows `lims_app` updates (run state) or deletes on expiry is class E. A row removed from an M or C parent is deactivated (`is_active = false` for M, `removed_at`/`removed_by` for C draft lines), never deleted."
- (b) "Mandatory-column exceptions (C5 05-SCHEMA §1 precedent): a one-row-per-key table (settings, counter, sync or refresh state, per-export file) whose natural key is its PK may omit `id`. It may also omit `version`/`is_active` when users never edit it, and `expires_at` when it never expires or is deleted when processed. Each exception is listed in the chunk's 05-SCHEMA §1 paragraph 'Mandatory-column exceptions' with its reason and copied to `db/meta/tables.yaml`."
- (c) "Purge path. A class E retention delete runs in the owning module's `per_tenant` task (P-6) as its system actor, under `<t>__delete__tenant` (or `__tenant_centre`) `FOR DELETE TO lims_app USING (<tenant predicate> AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now())`. DELETE is granted to `lims_app` on E tables only. A class A purge, or any cross-tenant purge, is a `lims_owner` DEFINER with `__select__owner_only`/`__delete__owner_only` policies bound to `app.maintenance = '<function>'` (08 A10.5, A12.2) and an 08 §4.7 inventory row."

**P-19 — Upload scan outcome without a status API.** (C11 #3; C6 TRD l.750 `reporting.process_input_file` has the same gap)
Text for 02-CV §10.2 row "Uploads" (append): "`ctx.uploads.accept` returns `scanState`. `clean`: the object is usable. `infected`: the module marks its row `quarantined` (terminal). `pending`/`unavailable`: the module stores `scan_state` on its own row and enqueues its own job. That job re-scans with `ctx.files.scan(await ctx.storage.read(bucket, objectPath))` (08 §4.13; ≤ 5 attempts with backoff [CONV]) and updates the row. Until the row is `clean`, a download returns `422 common.upload_quarantined` (P-2). There is no `ctx.uploads.status` method, and none is added."

**P-20 — Replacing a phase stub.** (C9 #1; applies equally to C14 `SmartReportPort`, C15 `PaymentProviderPort` and C16 `EngagementPort`, 08 R9)
Text for 08 R9 (append) and 02-CV §8.2: "The first PR that creates `services/api/src/modules/<owner>/` removes the port from `phase-stubs.ts` (paired C0-0D PR; AC-0D-6.3 unchanged). In the same PR the module registers its own port implementation, which returns exactly the stub results for every method not yet built and passes the `phase1Stub` contract subset. Each later task replaces one method and adds that method's full contract cases. No C0 manifest flag is added."

**P-21 — R25 scope: worker projections may read listed views.** (C9 m#20, C12 m#40)
Text appended to 08 R25: "Worker-side projections may read the `v_pub_*` views for which 03-IC §6 lists the chunk as a consumer. These are event consumers and cron tasks that maintain the chunk's own derived state (C8 rollups, C9 QC import and TAT clocks, C12 consumption facts, store resolution and per-day deduction). An HTTP request handler reads another module's views only for reporting/analytics responses and labels. Any other in-request operational read uses a port." 03-IC already lists C9 for `reporting.v_pub_order_report_tat` and C12 for `instruments.v_pub_instrument_directory` and `v_pub_message_daily`. No list changes.

**P-22 — Per-tenant singleton rows are created lazily.** (C8 #2, C9 #11; precedents C5 `barcode_counters`, C6 settings "created lazily by `settings.service` on first access", C7 settings)
Text for 02-CV §5 (new bullet): "Module settings, sync cursors, counters and refresh-state rows are created by the owning module on first use in any path (API, consumer, cron) with `INSERT … ON CONFLICT (<natural key>) DO NOTHING` and the TRD defaults. A read that finds no row uses the defaults. There is no tenant-provisioning event or hook. A user-path INSERT policy on such a table is allowed only for the row kind that a user writes first, restricted to that kind."

**P-23 — Error codes propagated from ports.** (C12 m#26 (checked); same pattern C10 TRD §12, C11 TRD l.239)
Text for 03-IC §8 emission note (replaces "`catalog.*` codes thrown by CatalogPort propagate unchanged through C4 (R18)"): "A code thrown by a port propagates unchanged through the calling module (R18): the handler rethrows the original `LimsError` and never constructs it, and the caller may list the code in its `x-error-codes`. Current users: C4 and C12 (`catalog.*`), C10 and C11 (`lab.*`)."

---

## (b) Decisions proposed (D-44 onward)

**D-44 — Top referrers show volume only (B13).** Refs: C8 #1, m#28. Problem: `getTopReferrersReport` returns net billed per doctor at aal1, with the flag off and without an access log. That defeats 07-BLOCKERS B13 ("Tenant flag hides the report entirely"; 04 L19).
- C8 TRD §5 #6 `sort` enum → `[-orders, -patient_visits, -tests_ordered]`.
- §5.1 `TopReferrersReport.rows[]` and `totals` drop `net_billed_paisa`; `billed_note_key` is dropped.
- §3.3 registry row `top_referrers` families → `referrer_volume` only.
- PRD US-05.3 → "Top referrers shows volume only (M30–M32). Net billed per referrer (M33) appears only in the referral business report (US-07: flag `referralIncentiveReportEnabled`, privileged `analytics.referral_report.read` at aal2, access log `referral_report.view`)."
- UI dashboard card "Top referrers": orders and patient visits only. The `top_referrers` export and schedule carry no money columns. m#28 (SELF row) applies to the referral report only.
- New 07-SECURITY probe: "flag off → no endpoint, export, schedule or dashboard card returns `net_billed_paisa`".
Files: C8 PRD, TRD §3.3/§5/§5.1, UI §3, SEC.

**D-45 — C8 bookkeeping tables (P-18).** Refs: C8 #3, m#15, m#17.
- `refresh_runs`, `report_runs` and `report_run_recipients` → class **E**. Add `expires_at timestamptz NOT NULL`: `started_at + 90 days` for `refresh_runs`, `created_at + 400 days` for the other two (the 05-SCHEMA §1 retention values). The system-only UPDATE policies and column-guard triggers stay. The deletes in `analytics.purge` (already `per_tenant`) use `<t>__delete__tenant` per P-18(c). `refresh_runs __delete__owner_only` is renamed `refresh_runs__delete__tenant` (fixes m#17 for this table).
- 05-SCHEMA §1 gets a "Mandatory-column exceptions" paragraph (P-18(b)): `refresh_state` (PK `(tenant_id, family)`, no `id`/`expires_at`, life of tenant); `dirty_partitions` (PK `(tenant_id, family, business_date)`, deleted when processed); `export_files` (PK `export_id`, no `id`); `order_index` (PK `(tenant_id, order_id)`, no `id`; it gains `expires_at = coalesce(registered_at, created_at) + 400 days` for the purge).
- `schedule_recipients` stays M. Add `id`, `is_active`, `updated_at`, `updated_by` and `version`. Removing a recipient on edit sets `is_active = false`; re-adding reactivates the row (`UNIQUE (tenant_id, schedule_id, membership_id)`). Its DELETE policy and grant are removed.
Files: C8 SCH §1/§3/§6, TRD §9.5.

**D-46 — Finance reaches collections history.** Refs: C8 #6, m#16 (P-10).
- 03-IC §7: `- { id: staff.analytics.collections, origin: staff_web, path: /analytics/collections, permission: analytics.collections.read, owner: C8 }`.
- C8 nav: `{ id: 'analytics.collections', label: 'analytics.nav.collections', routeId: 'staff.analytics.collections', permission: 'analytics.collections.read', group: 'analytics', order: 25, icon: 'table' }`. The page renders US-08 with #4. The report-hub tab links to the new route.
- #16 `getAnalyticsFilterOptions`: `x-permission: analytics.dashboard.read` only.
- New #30 `getCollectionsFilterOptions`, GET `/filter-options/collections`, `analytics.collections.read`, Idem none, → `{ centres, branches, payment_methods }`, same shapes as #16, within caller scope; errors `auth.forbidden`.
- APP-FLOW S2 → `analytics.dashboard.read`, and a new row S2b. TRD §5 and 07-SECURITY endpoint count 29 → 30.
Files: 03-IC §7, 08 §4.3, C8 TRD §5, AF §1, UI §1, SEC.

**D-47 — Staff directory on `ctx.core` (P-17).** Refs: C8 #7, C10 #6, C11 #8. C0 02-TRD §6.8 / 08 §4.11. `MembershipRow` is defined (it is referenced but never defined today), and `memberships.list` is widened. All new inputs are optional, so the existing C17 call stays valid.
```ts
export interface MembershipRow { readonly membershipId: Uuidv7; readonly userId: Uuid; readonly actorType: 'user'|'system'|'device'|'portal'|'patient'|'partner';
  readonly displayName: string; readonly status: 'invited'|'active'|'deactivated'; readonly isActive: boolean; readonly lockedAt?: IsoUtc;
  readonly allCentres: boolean; readonly centreIds: readonly Uuidv7[]; readonly roleCodes: readonly string[] }
memberships: { list(tx: RequestContext, input: { centreId?: Uuidv7; roleCode?: string; permission?: PermissionCode;
    membershipIds?: readonly Uuidv7[] /* ≤ 200 */; activeOnly?: boolean /* default true */; limit?: number /* 1–500, default 200 */ }):
  Promise<readonly { membershipId: Uuidv7; displayName: string; roleCodes: readonly string[]; allCentres: boolean; isActive: boolean }[]> }
```
Semantics:
- Tenant from `ctx` only; `actor_type = 'user'` memberships only.
- `centreId`: `all_centres` or member of that centre.
- `permission`: a role of the membership grants it (`core.role_permissions`).
- `membershipIds`: unknown or other-tenant ids are omitted.
- `displayName` comes from `core.users`.
- Callers must be staff or system; portal, patient and partner actors get `auth.forbidden`.
Uses:
- C8 #16 adds `recipients` (P-10 conditional: "+ when caller holds `analytics.schedule.manage`") = `list({ permission: 'analytics.dashboard.read' })`.
- C10 `*_display` = `list({ membershipIds, activeOnly: false })`, and `ctx.core.user` for `created_by`/`activated_by`.
- C11 A12 = `list({ permission: 'anatomic.case.signout', centreId: case.centre_id })` filtered by `q` in memory (case-insensitive prefix), capped at `limit`.
Files: C0 TRD §6.8, 08 §4.11, C8 TRD #16/UI §8, C10 TRD §5.6/§7.1, C11 TRD §6.2/A12.

**D-48 — Delivery figures: cohort anchor and `centre_id`.** Refs: C8 #12 (C6 part = lead item 8).
- C6 05-SCHEMA `reporting.v_pub_delivery_daily`: select `d.centre_id` and group by it (`GROUP BY 1,2,3,4,5,6`). Comment: "every count anchors on the delivery's creation date (cohort); `centre_id` NULL for non-report deliveries (CR-C8-005)".
- 03-IC §6.4 note "anchors per status documented in C6 05-SCHEMA" → "`business_date` = delivery creation date for every count".
- 03-IC §3.18: properties += `"delivery_created_at": { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" }`, not in `required` (additive, R13). C6 always sets it. Notes: "C8 dirties `deliveries @ bd(delivery_created_at)`; when it is absent, bd(changed_at) + nightly sweep".
- C8 TRD §8.2 row and PRD M80 ("creation-day cohort") follow.
Files: 03-IC §3.18/§6.4, C6 SCH view + TRD §8.1, C8 TRD §8.2, PRD M80.

**D-49 — Live pending scope = C5 RLS.** Refs: C8 m#22.
- The live summary and list (#11, #12) drop the implicit `($2 OR centre_id = ANY ($3))` predicate and rely on C5 RLS in the user transaction. This is consistent with C8 US-10.1 and with 08 A13 D-13 for hub users.
- An explicit `centre_id` filter in ScopeQuery still applies `centre_id = ANY(…)`.
- Exports keep D-C8-08 (collection centre only, system actor). D-C8-08 wording → "exports list by collection centre; the screen also shows items received at your centres".
Files: C8 TRD §6.7, SEC D-C8-08.

**D-50 — Seeding `order_index`.** Refs: C8 m#24. The `analytics.backfill` task also runs, per 7-day step:
```sql
INSERT INTO analytics.order_index (tenant_id, order_id, centre_id, registered_at, registered_on, created_by, expires_at)
SELECT t.tenant_id, t.order_id, t.centre_id, t.registered_at, (t.registered_at AT TIME ZONE 'Asia/Kathmandu')::date, $actor,
       t.registered_at + interval '400 days'
FROM reporting.v_pub_order_report_tat t
WHERE t.tenant_id = $1 AND t.registered_at >= $from_ts AND t.registered_at < $to_ts
ON CONFLICT (tenant_id, order_id) DO NOTHING;
```
C8 is a listed consumer of the view. Seeded rows have `branch_id`/`referrer_id` NULL and serve `report_backlog` only. The view keeps only `state = 'open'` report rows, so cancelled orders are not seeded. Files: C8 TRD §9.3.

**D-51 — `billing.v_pub_credit_party_statement` consumers.** Refs: C8 m#31. 03-IC §6.2 consumers → "C13". C8 is removed; a later additive C8 CR may add it once a credit-party label source exists (same handling as 08 A2.7). Files: 03-IC §6.2.

**D-52 — Early-rejected QC runs keep their late members.** Refs: C9 #2. C9 TRD §7.3, new step 1a: "If no collecting run exists, let `R` = the pair's latest run with `status = 'evaluated' AND outcome = 'rejected' AND is_complete = false`. If `o.observed_at − R.run_at ≤ run_window_minutes` and `count(R, o.level) < composition[o.level]`, attach `o` to `R` (observation `assigned`, `observation_count + 1`, append to `rule_detail`), never re-evaluate, and stop." QR7 guard → "a later run of the plan with outcome `accepted`/`accepted_warning` **and `run_at > R.run_at + run_window_minutes`**". New assembly vector: V27 followed by an L2 member within the window → one run and one event. Files: C9 TRD §7.3, AF QR6/QR7, PRD AC-06.6 test.

**D-53 — Access-log codes for C9 and C11 (P-3).** Refs: C9 #5, C11 #1. Add to 03-IC §13.1 / 08 §4.4 / C0 seed:
```yaml
# C9 (triage batch 2)
- autoverify_decision.view     # decision detail drawer (P3 inputs)
- autoverify_simulation.view   # simulation report
# C11 (triage batch 2; replaces the anatomic.* three-segment strings)
- anatomic_case.view
- anatomic_report.view         # report version view
- anatomic_image.view          # image content stream
- anatomic_label.print
- anatomic_object.lookup       # success only
- anatomic_report.sign_out
```
The `anatomic_` prefix follows the `micro_instrument_record.assign` precedent (CR-C10-010). C9 TRD §14 and 06 T-17 (which also gains the simulation view) name exactly these codes, as do C11 TRD §12, PRD AC-13.3 and SEC §3.

**D-54 — QC arithmetic is decimal-only.** Refs: C9 #7 (consistent with 08 R12a).
- `Rational` → `Decimal` (`@lims/shared-ts/decimal`). `dev = v − mean` is exact, and rules compare `|dev| > k × sd` with no division.
- Targets: `S1 = Σv` and `S2 = Σv²` are exact. `mean = S1 / n` (one division, 28 significant digits, half-up). `variance = (n·S2 − S1²) / (n·(n − 1))` (exact numerator, one division). `sd = sqrt(variance)` in IEEE double, rounded to 15 significant digits and marked `inexact` (R12a).
- `z = dev / sd` is for display only. Stored mean and sd keep the existing half-up rounding to analyte decimals + 2.
- A golden case of 20 synthetic values pins mean and sd. The "exact rationals" wording is deleted.
Files: C9 TRD §2, §7.5, §7.6; PLAN T-02.

**D-55 — Stopping a simulation is terminal.** Refs: C9 #10.
- AV4 → `simulating → stopped` (#41; terminal; `simulation_stopped_at` set, pointer cleared, shadow rows kept). A new draft is created with #37 `copy_from_version_id`.
- `autoverify_versions.status` CHECK += `'stopped'`. `enforce_version_frozen` is unchanged, so "definition immutable once it leaves draft" becomes true.
- TRD §8.1: "`draft → simulating → active → retired`; `simulating → stopped` (terminal); `draft → discarded`".
- A simulation report covers that version's shadow rows only.
Files: C9 TRD §8.1, AF AV4, SCH CHECK.

**D-56 — C9 settings bootstrap (P-22).** Refs: C9 #11.
- `settings.service.ensure(tx)` inserts `quality.settings` with defaults and `activated_at = now()` at the first ensure for the tenant. A tenant created after C9 ships gets its first-use time.
- `sync_state` is ensured with `qc_cursor_at = activated_at − 400 days`.
- The settings repository and `ensure` move into T-01. T-20 keeps handlers #51–#54.
Files: C9 TRD §12.1, §6.2; PLAN T-01/T-20.

**D-57 — Blocker-register rows.** Refs: C9 m#18, C12 m#27 (checked). 07-BLOCKERS:
- B14 "Chunks affected" → "C14, C5, C9 (auto-verify rule-set sign-off; default four-eyes activation by two holders of `quality.autoverify.manage`, nothing activates by default)".
- B15 += C9.
- B7 → "C4, C12 (`inventory.settings.vat_in_cost`, default true)".
04 §13 has no chunk column, so it is unchanged. Files: 07-BLOCKERS.

**D-58 — Sources for the Westgard rules.** Refs: C9 m#19.
- C9 TRD §7 intro → "Rule definitions: 04 L23 and research/01 §2.5 (1-2s, 1-3s, 2-2s, R-4s, 4-1s, 10x — VERIFIED). The N = 3 rules (2of3-2s, 3-1s, 6x, 9x) and 8x/12x are named in 04 L23, but research holds no exact text for them. Their §7.5 definitions are **DECISION (by analogy with 2-2s/4-1s/10x; UNVERIFIED as to the letter)** and pinned by golden vectors."
- The claim "re-read on 2026-11-06 … quoted where used" is deleted.
- PRD D-QC-1 quotes only research/01 text.
No web source is added to research. Files: C9 TRD §7/§7.5, PRD D-QC-1.

**D-59 — Start of the total-TAT clock (P-21).** Refs: C9 m#20.
- `total` starts at `registered_at` of the order from `reporting.v_pub_order_report_tat` (C9 is a listed consumer), read by the TAT worker when it creates the clock.
- If no row exists yet, the start falls back to the earliest specimen `ordered_at`. The basis is recorded in `tat_items.start_basis text NOT NULL CHECK (start_basis IN ('registered_at','specimen_ordered_at'))`.
Files: C9 TRD §9.2, PRD AC-14.3, SCH `tat_items`.

**D-60 — Adopting Phase-1 QC history without retroactive runs.** Refs: C9 m#35.
- The 400-day import stays (research/01 §1 "capture QC data from day one").
- When a plan is activated, `quality.reprocess_pending_observations {plan_id}` also takes the pair's `no_plan` observations older than `reprocess_window_days`. It re-runs §6.3 rows 4–8 only. An observation that would reach row 10 is set to `late_unassigned` (charted, never assembled).
- So history feeds charts (#26) and "establish" (#22, `no_target` rows) but never creates runs, events or result holds.
Files: C9 TRD §6.3/§6.4, PRD AC-04.x note.

**D-61 — Second preliminary after an approved preliminary (08 R1 extended).** Refs: C10 #1. Option (b), releasing micro preliminaries without C5 approval, is rejected because it breaks the A1 chain.
- 08 R1 seed list += `module_preliminary_update` — "Updated preliminary report". C5 accepts it only when `payloadRef.module = 'micro'`, `reportPhase = 'preliminary'` and the approved version being replaced was a `preliminary` submission; otherwise `lab.module_result_invalid`. `lab.result.amend` is still required (R1 unchanged).
- C6 report-kind rule (1) exclusion set → {`module_phase_progression`, `module_preliminary_update`, `supplementary_report`}; rule (3) labels the version `preliminary`.
- C10 §4.7 sends `amendment: { reasonCode: 'module_preliminary_update' }` automatically when the culture is not `amending`, the C5 line is `approved`, the last approved phase is `preliminary` and the new phase is `preliminary`. C7 (amending → preliminary) stays forbidden.
- 03-IC §4.5 contract cases: (35) micro preliminary over approved preliminary with this code → version n+1 and `lab.result.amended.v1` carries the code; (36) the same code with `reportPhase = 'final'` or from anatomic → `lab.module_result_invalid`.
Files: 08 R1, 03-IC §4.5/§3.17 note, C5 TRD seeds, C6 TRD report-kind rule, C10 TRD §4.7, AF C4 guard, PRD AC-09.x.

**D-62 — Amendment and change reasons come from C5's set.** Refs: C10 m#34, C11 m#26.
- Module UIs offer C5 `amendment_reasons` (global + tenant) through the BFF `listLabCodedSet` (C5 #53, `lab.specimen.read`). The system codes `module_phase_progression`, `module_preliminary_update` and `supplementary_report` are excluded.
- C11 drops `anatomic.g_cs_change_reasons` and `anatomic.cs_change_reasons`. `change_reason_code` keeps a format CHECK only.
- C5 validates the code at submission for approved targets (R1). For unapproved targets (revisions) the code is a label checked for format only.
- C10 M17 says "validated by C5 at submission; C10 checks format only".
Files: C10 TRD M17/UI §3.4, C11 SCH §1/§2.2, TRD, UI.

**D-63 — Culture visibility follows D-13.** Refs: C10 #3 (lead item 2). No event CR.
- C10 05-SCHEMA §1 centre decision → "Visibility = all centres, or `centre_id` (the collection centre from the event, copied onto every culture and child row at insert) among the actor's centres. Hub microbiology staff follow 08 A13 D-13(2), extended to holders of `micro.culture.read`/`micro.culture.work`."
- Remove `processing_centre_id` from every C10 table, from `pred_c` and from the §8.2 snapshot, and delete the parity sentence.
- New probe: user of centre A1 only → A1 cultures only; D-13 hub user → all.
- The C2 TRD D-13 warning text adds the micro permissions.
Files: C10 SCH §1/§4/§8, TRD §8.2, C2 TRD note.

**D-64 — One `x-permission` for micro config reads (P-10).** Refs: C10 #5.
- 03-IC §11 `micro.culture.read` roles += `lab_manager`. This matches the `lab.result.read` and `anatomic.case.read` that lab_manager already holds, and adds no permission and no endpoint.
- M23, M25, M29, M33, M37 and M39 use `x-permission: micro.culture.read`; writes keep `micro.config.manage`.
Files: 03-IC §11, 08 §4.1, C10 TRD §5.4/§5.5.

**D-65 — `micro.instrument_records` is class E (P-18).** Refs: C10 #8, m#14.
- Class C → **E**. `expires_at timestamptz` is set when `match_status` becomes `applied`/`ignored`: that time + `TenantSettings.retention.rawInstrumentYears` (D-42 single source; default 1, floor 1). This replaces the 365-day [CONV].
- New task `micro.purge_instrument_records` (`per_tenant`, system actor). Policy `instrument_records__delete__tenant_centre FOR DELETE TO lims_app USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now())`. Rows referenced by `ast_results.instrument_record_id` are skipped by the task predicate.
- The DEFINER text (SCH l.892) and the "inventoried" claim (SEC REQ-SEC-019–021) are deleted. No 08 §4.7 row is needed, which resolves m#14.
Files: C10 PRD §11, SCH §1/§7/§8, TRD §9, SEC.

**D-66 — What may change after sign-out.** Refs: C11 #7 (lead item 4). Recommended default for a `signed_out` case:
- (a) Always allowed: image upload (I1), caption edits on images not yet in any signed version, and stain orders/slides for add-on items (addendum path).
- (b) Allowed only while a revision/amendment draft is open: draft content, gross records, part site/description (no new or removed parts), molecular results.
- (c) Never: accession, case kind, removing parts or blocks, edits to images or content already in a signed version.
- A blocked edit → `409 anatomic.signout_locked`. AC-03.4 = (b) without a draft. The I1/A7/A8 error lists follow.
Files: C11 PRD AC-03.4, TRD §7, I1/A7/A8.

**D-67 — Inline display of re-encoded images (P-2 amended).** Refs: C11 #9 (C6 serves image previews the same way, C6 l.1085 as cited by the reviewer). P-2 gets this exception text:
"(I1) An object accepted with `images.reencode: true` whose stored mime is `image/png` or `image/jpeg` may be streamed by its owner's `GET …/content` with `Content-Disposition: inline`, for `<img>` display through the BFF. Headers: `Content-Type` = the stored mime (never client-supplied), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: no-store`. Every call is access-logged. All other files stay attachment-only."
Rationale: server re-encoded rasters carry no active content. The alternative (a separate file origin, C1 `LIMS_ORIGIN_FILES`) adds cross-origin authentication surface. This narrows REQ-SEC-085 as written, so **the lead records it as an accepted risk**. Files: 08 A13 P-2 text, 02-CV §10.2, C11 SEC §1/UI §4.2.5, C6 UI.

**D-68 — Anatomic report text stays plain text.** Refs: C11-L6. Confirmed. 03-IC §6.8 defines `*_text` columns that C6 renders. research/01 §2.4 ("rich-text templates with placeholders") is met by plain-text section templates (`;code` text templates) plus synoptic JSON. No HTML in v1. A later change to rich text needs a CR on 03-IC §6.8 and the C6 renderer sanitiser. C11 TRD §4.6 records "DECISION confirmed by lead (08)".

**D-69 — Accounting for transit loss.** Refs: C12 #2 (default (a)). When r < d units are received (d dispatched, dispatched value V):
- Destination: `transfer_in` +r, value `round_half_up(r / d × V)`.
- Source, on the same (store, item, lot) row as the `transfer_out`, in the same transaction, doc_type `transfer`: `transfer_in` +(d − r) at the remaining value, then `wastage` −(d − r) at the same value, reason = the discrepancy code (default `transit_loss`).
- The source nets −d. The loss appears in the wastage report at the source. The paired `transfer_in` means the `wastage` row never raises `insufficient_stock` or violates `lot_nonneg`.
Files: C12 PRD AC-10.2, TRD §4.3, AF T3, SCH §6.4.

**D-70 — Exempt purchase lines without null on the wire.** Refs: C12 #5. 02-CV §4.2 stands and gets no exception.
- Purchase-line request field `is_exempt: boolean` (default false).
- `is_exempt: true` ⇒ `tax_code` must be absent (else `400 common.validation_failed`, path `/lines/n/tax_code`). `is_exempt: false` with `tax_code` absent ⇒ the item/supplier default code.
- Responses carry `is_exempt` and omit `tax_code` on exempt lines. The DB is unchanged (`tax_code NULL`, `tax_rate_bp = 0`).
- 08 A7.6 ("exempt purchase lines carry `tax_code: null`") is read as describing the stored column.
Files: C12 TRD #50/#52/#81/#83, PRD AC-05.x, UI S6, AF §4.1; 08 A7.6 clarifying note.

**D-71 — Draft lines are soft-deleted (P-18(a)).** Refs: C12 #6.
- `purchase_order_lines`, `goods_receipt_lines` and `transfer_lines` gain `removed_at timestamptz NULL` and `removed_by uuid NULL` with `CHECK ((removed_at IS NULL) = (removed_by IS NULL))`.
- Line uniques become partial `WHERE removed_at IS NULL`. `tg_doc_guard` allows setting `removed_*` only while the parent `status = 'draft'`. Reads filter `removed_at IS NULL`.
- DELETE grants and `__delete__tenant` policies are removed. "Replace lines" = mark absent lines removed, then upsert.
- The class stays C, with no CV exception.
Files: C12 SCH §1/§4.2/§4.4/DDL, TRD P2/G2/#59.

**D-72 — Alert purge (P-18(c), P-6).** Refs: C12 #7 (lead item 3). The 08 §4.7 row (INVOKER `app.purge_inventory_alerts()`) stays correct.
- `inventory.purge_alerts` → `per_tenant`.
- Add `CREATE POLICY alerts__delete__tenant ON inventory.alerts FOR DELETE TO lims_app USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now());` and `GRANT DELETE ON inventory.alerts TO lims_app`. The function body deletes `WHERE tenant_id = app.current_tenant_id() AND expires_at < now()`.
- No DEFINER and no index exception.
- The other four C12 `platform` cron tasks (`daily_fixed_consumption`, `daily_alert_scan`, `balance_integrity_check`, `reconciliation_scan`) also become `per_tenant` (P-6).
Files: C12 TRD §9/CR-C12-008, SCH §4.2/§11, SEC §1/§8.

**D-73 — Counters are written while consumption is off.** Refs: C12 #9. TRD §8.1 order → steps 1 → 3 → 6 (counters) for every non-duplicate event. The step-2 gate (`consumption_enabled_at`) applies to steps 4–5 (facts, movements) only. The PLAN §5 trial week then works as written. Files: C12 TRD §8.1, AF §4.7.

**D-74 — QC reconciliation grain.** Refs: C12 #10.
- New counter table `inventory.instrument_qc_daily (tenant_id uuid NOT NULL, business_date date NOT NULL, instrument_id uuid NOT NULL, qc_observations integer NOT NULL DEFAULT 0 CHECK (qc_observations >= 0), created_at, created_by, updated_at, updated_by, PRIMARY KEY (tenant_id, business_date, instrument_id))`. It is a P-18(b) exception (no `id`), and `instrument_id` follows the same FK rule as `test_counts_daily.instrument_id`.
- Every non-duplicate `instruments.qc.received.v1` adds `qc_observations += 1` for (bd(`received_at`), `instrument_id`). This happens before the mapping filter and the switch gate.
- `test_counts_daily.qc_events` = +1 per **distinct** attributed test of a newly inserted QC fact.
- AC-21.7 compares the instrument block `instrument_qc_daily.qc_observations` with `v_pub_message_daily.qc_records`. `reconciliation_scan` alerts on the test block only; the instrument block is listed without alerts [CONV].
Files: C12 PRD AC-21.7, TRD §8.1/#92, SCH §2.26/DDL.

**D-75 — Inbound movements into negative rows.** Refs: C12 #12. Add to PRD §8.1 / TRD §4.3:
- "Inbound q into a row with Q < 0 and value V: if q ≥ −Q, the first −Q units take value −V (clearing it) and the remainder is valued by the normal rule; if q < −Q, value = `round_half_up(q × V / Q)`."
- "Unlotted-row fallback with no lot: the item's average cost in the store, else 0 with `value_basis = 'none'`."
- Golden cases for both branches.
Files: C12 PRD §8.1, TRD §4.3, AF E7.

---

## (c) Per-chunk LOCAL fix lists

Verified LOCAL items show their finding number, and items covered by a P-rule or D are marked. Minors not on a lead list are listed as reported (not re-verified) unless marked "(checked)". "Applies" names the existing A13 rules and decisions the fix pass must honour in that chunk.

**C8** — LOCAL (verified): #2 (P-22: `INSERT … ON CONFLICT (tenant_id, family) DO UPDATE` for every family; manual throttle via `refresh_state__insert__tenant_manual` (P_TENANT AND family = '_manual') plus `INSERT … ON CONFLICT … DO UPDATE SET last_manual_at = now() WHERE refresh_state.last_manual_at IS NULL OR refresh_state.last_manual_at < now() - interval '5 minutes' RETURNING …`), #4, #5, #8 (CR-C8-004 is ACCEPTED; C5 view SQL already has `centre_id`, `tests_approved`, `parent_specimen_id`), #9 (instance of P-9), #10, #11 (C0-0C transcribes the data schema from C8 TRD §10.2, as 08 A5.1 did for `partners.access_slip`), #13 (P-16: `P_STAFF`). Cross/decision items: #1 D-44, #3 D-45, #6 D-46, #7 D-47, #12 D-48, m#15 D-45, m#22 D-49, m#24 D-50, m#31 D-51.
Minors (as reported): 14, 16 (P-10 / D-46), 17 (part D-45), 18, 19 (use `400 common.validation_failed` per P-1, see (d)), 20, 21 (checked: 03-IC §4.8 still has the superseded text; replace per 08 A7.6), 23, 25, 26, 27, 28 (D-44), 30 (C4 cross), 32–36. m#29 is fixed by P-15 (see (d)).
Applies: P-1, P-2 (#23 streaming download + access log), P-4/D-3 (unknown `recipient_kind` → `other`), P-5 with D-1/D-2 (tolerate absent `centre_id`, `specimen_id`, `verified_by_membership_id`), P-6 (all four crons already `per_tenant`), P-9, P-10, P-14, P-15, D-29 (`staff_url` for `analytics.report_ready`), 08 A7.6.

**C9** — LOCAL (verified): #3 (P-16, including the three centre-variant TAT policies), #4 (keyset `(created_at, qc_result_id)` continuation; persist both cursor columns; re-enqueue only if the page is full and the key advanced), #6, #8 (option (a): #21 accepts `source: 'manufacturer'` only, and the UI drops "Established-manual"), #9, #12. Cross/decision items: #1 P-20 (stub removal moves to T-01; TRD §11.1 and 06 §3 last row say T-01), #2 D-52, #5 D-53, #7 D-54, #10 D-55, #11 D-56, m#18 D-57, m#19 D-58, m#20 D-59, m#35 D-60. m#17 is ALREADY-FIXED (P-15).
Minors (as reported): 13–16, 21–29, 30 (P-8: #30, #32, #33, #50 → `required`), 31–34, 36 (program doc 01-CM §6 row C9). m#34 also needs 01-CM §3 to map `apps/web/tests/e2e/<module>/` to the module owner (program doc).
Applies: P-3, P-5/D-2 (verified-event consumer), P-6 (crons already `per_tenant`), P-8, P-14 ("registered with C1" alerts → TRD table), P-15, 08 R9 (with P-20), 08 R12a.

**C10** — LOCAL (verified): #2 (P-16: `pred_t` at SCH l.847), #4 (instance of P-6: `reconcile_chain_status` and `refresh_metrics` → `per_tenant`; fix SEC §2 row), #7, #9 (PostgreSQL `LIKE` never copies FOREIGN KEY constraints; write explicit `CREATE TABLE`s or add each `__tenant__fk`, and C0 confirms the constraint names in the migration PR), #10, #11, #12, #13, m#15 (instance of P-8: M3, M11, M20, M21 → `required`). P-1 sweep (checked): "422 common.validation_failed" at TRD l.114, l.271, l.448 → `400`. Cross/decision items: #1 D-61, #3 D-63, #5 D-64, #6 D-47, #8 D-65, m#14 D-65, m#34 D-62. m#38: graphs part is ALREADY-FIXED by D-40; the matrix part is program doc (01-CM §6 row C10).
Minors (as reported): 16–33, 35, 36 (P-18(b) exception for `specimen_isolate_counters`; `processing_branch_id`: fill from the event with an FK, or drop), 37 (use C2 `listCentres`, `identity.centre.read`, D-16).
Applies: P-1, P-3 (CR-C10-010 codes), P-6, P-8, P-10, P-16, P-17, P-18, D-7 (fake `versionNo` semantics), D-13, D-40, D-42 (via D-65), 08 R1.

**C11** — LOCAL (verified): #2 (`ModuleManifest.systemPermissions` in `services/api/src/modules/anatomic/index.ts`; the WorkerManifest has no `permissions` field), #4 (reviewer's fix: always send `amendment` for revision/amendment drafts and `supplementary_report` for full-scope addenda; port calls first, then INSERT `report_versions` with kind `amendment` if any `out.status === 'approved'`, then `item_submissions`; add `lab.amendment_reason_required` to the propagated list — P-23), #5, #6 (`max(item_version_no)` where `lab_version_no = payload.result_version_no` (approved) or `new_version_no` (amended); `greatest(current, that)`). Cross/decision items: #1 D-53, #3 P-19 (`process_image` re-scans via `ctx.files.scan`), #7 D-66, #8 D-47, #9 D-67, m#26 D-62, L6 D-68.
Minors (as reported): 10–25, 27–30, 32 (P-18(b) counter exception, C5 precedent). m#19 follows P-8. m#20 adds `x-upload: [image/png, image/jpeg]`. m#30 is a program doc (03-IC §4.3 consumers += C10, C11; 01-CM §6). m#31 is fixed by P-13 (see (d)).
Applies: P-2 (image content GET, with D-67), P-3, P-8, P-12 (image objects at anonymisation), P-13, P-16 (already in `pred_t`), P-17, P-19, P-23, D-2 (`specimen_id` absent for add-on results, CR-C11-009), D-7, D-13, 08 R1/R2.

**C12** — LOCAL (verified): #1 (reviewer's step-4 rewrite plus the 20-analyte contract test), #3, #4 (instance of P-1: 8 places, PRD l.153/161/188, TRD l.148/208/245/435, AF l.154), #8 (reviewer's `assertStoreAccess` order), #11, #13 (`DecimalStringPacks` `^[0-9]{1,9}(\.[0-9]{1,3})?$`), #14. Cross/decision items: #2 D-69, #5 D-70, #6 D-71, #7 D-72, #9 D-73, #10 D-74, #12 D-75, m#40 P-21. P-6 (checked): all five `platform` cron tasks become `per_tenant` (D-72).
Minors (as reported): 15–23. m#24 follows P-8, m#25 P-10, m#26 P-23 (checked), m#27 D-57 (checked), m#28, m#29 P-9 (character set = `= + - @ \t \r '`), m#30–m#39.
Applies: P-1, P-6, P-8, P-9, P-10, P-14, P-18, P-21, P-23, D-2 (tolerate absent `specimen_id`/`verified_by_membership_id`), 08 A2.2, A4.1, A5.6, A7.6 (with D-70).

---

## (d) FALSE / ALREADY-FIXED findings and corrections

**ALREADY-FIXED**
- **C9 m#17** (lead item 6, timezone of `business_date`): decided by 08 A13 **P-15**. Views use the literal `Asia/Kathmandu`, so C9's view is correct as written. Only the 03-IC §6 header sentence (still "tenant timezone" at about 13:08 UTC) awaits the P-15 apply. The same holds for C8 m#29 (not a lead item).
- **C10 m#38** (lead item 6, ID/AST "graphs", client baseline research/00 §3 item 3): covered by 08 A13 **D-40**. Graphs from any verified driver, the ID/AST system included, are stored as attachment records and shown in the C7 viewer. What remains is the 01-CM §6 matrix cell (program doc).
- **C11 m#31** (not a lead item): fixed by 08 A13 **P-13**, which uses `anatomic.v_pub_report_content` as its own example; 08 §4.13 already carries the read rule.

**No finding is FALSE.** Corrections to premises and proposals (the findings themselves stand):
- **C10 #6**: "No `ctx.core.membership` exists" is wrong; C0 02-TRD §6.8 defines `membership(ctx, {membershipId}): Promise<MembershipRow>`. The real gaps are that `MembershipRow` is never defined, and that there is no batch or permission-filtered lookup and no source named for `*_display`. Fixed by D-47.
- **C9 m#19**: the second URL (`westgard.com/westgard-rules.html`) **is** in research/01 §2.5 (l.180). Only the exact definitions of the N = 3 rules and 8x/12x are missing from research (D-58).
- **C8 m#15**: `export_files` already has `expires_at` (SCH l.419); it lacks only `id`.
- **C11 #3**: no C0 change request is needed. `ctx.files.scan` and `ctx.storage.read` already exist (08 §4.13), so P-19 uses them.
- **C12 #7**: the reviewer's proposed DEFINER plus index exception adds surface. `inventory.alerts` is class E, so a `per_tenant` system delete is enough, and the existing 08 §4.7 INVOKER row stays (D-72).
- **C12 #4**: the reviewer counted six places; grep finds eight (listed in (c)).
- **C12 #10**: the proposed counter on `test_counts_daily` cannot hold instrument-level rows because `test_id` is NOT NULL there. D-74 uses a separate counter table.
- **C10 #3**: the proposed event change (`processing_centre_id` on `lab.specimen.status_changed.v1`) is unnecessary given 08 A13 D-13 (D-63).
- **C10 #1** option (b) is rejected because it bypasses the A1 verify → approve chain (D-61).
- **C9 #1**: the alternative, a C0 manifest flag for AC-0D-6.3, is rejected as extra surface (P-20).
- **C9 m#35**: reviewer option (a) as written would assemble old history into runs and could emit `quality.qc_run.rejected.v1` and hold results retroactively. D-60 prevents this.
- **C8 m#19**: the proposed "`422 common.validation_failed` … `common.field_invalid`" violates P-1, and `common.field_invalid` is not a registered code. Use `400 common.validation_failed` with a JSON pointer.
- **C8 #2**: the reviewer's first alternative (UPDATE, then a separate SELECT when no row is found) is racy. The single `INSERT … ON CONFLICT … DO UPDATE … WHERE … RETURNING` is used (c).
- **C11 #1**: `anatomic.lookup` matches the two-segment CHECK; it fails only because it is unregistered. The reviewer's "five of six" is correct.
