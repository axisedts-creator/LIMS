Title: CR-C1-NEPAL-006: triage of the remaining 115 red pgTAP files (505 assertions + 5 aborted files) of the 2026-11-18 run: no cross-tenant leak found; 4 (a?) items and 2 (c) items need a decision
From chunk: C1 (nepal, diagnosis only)            To owner: per section below (C0-0B, C0-0A, C2, C3, C4, C5, C6, C7, C9, C10, C11, C12, C13, C14, C15, C16, C17, C18); founder for D1 (08 A19.1) and D-136
Type: bug (mostly test / fixture / generator drift; 3 schema defects: C15 static_qr trigger, C14 NULL-passing CHECKs, app.uuidv7 grants)
Blocking? yes for real data (gate 10 / AC-0B-3.6 stays red); no host bring-up is blocked. Nothing in db/, tests, migrations, policies, grants, auth or permission code was changed by this diagnosis; the proposed diffs below are NOT applied.

Problem: `bash db/tests/run-suites.sh` exits 1 with 115 red files. NEPAL-leak-C13/C16/C17 explained 15 isolation assertions; this CR explains the rest. Class legend: (a) a non-owner actor or another tenant gets rows, a write succeeds that must be refused, or a SECURITY DEFINER lacks a guard; (a?) the same but not certain / accepted by an earlier decision; (b) test, fixture, probe or schema drift that fails CLOSED (permission denied, missing object, check violation, guard error); (c) unknown: what was checked and what is missing is stated.

## Summary table (every red file; biggest first)

| file (db/tests/...) | count | class | one-line cause | owner |
|---|---:|---|---|---|
| payments/T0B-13.C15_behaviour | 55 | (a?)+(b) | 23 (a?): a `device` actor passes app.is_staff_or_system(), so it READS 11 payments tables, INSERTs into 11 and UPDATEs merchant_accounts (08 A19.1 accepted this; test expects 0). 32 (b): 3 UPDATE asserts run in 'n' mode (E42601, never executed), static_qr_reconciliations trigger omits generated column difference_paisa (every UPDATE raises immutable_row), 28 transition-pair rows lack FK parents (RI re-check on same-txn UPDATE) | C15 (+ decision A19.1) |
| isolation/T0B-08_step9_fixed | 48 | (b) | generator runs the step-9 partner/portal/patient probe as lims_api on the 16 migration_staging tables; lims_api has no grant there (E42501, closed). Same cause as the 16 migration_staging files | C0-0B (+C18/C0-0A D-136) |
| engagement/T-L2_redeem_link_code | 14 | (b)+(c) | fixture link_codes/links reference patients that were never inserted; RI is re-checked on the DEFINER's UPDATE (same txn) -> E23503. File then aborts at line 126 (psql `\'` inside a string), so every later assertion is unrun. Redeem DEFINER itself is guarded (returns nothing when app.engagement_account_id() is NULL) | C16 |
| anatomic/T0B-13.C11_behaviour | 12 | (a?)+(b) | 9 (a?): device actor reads 9 anatomic tables (A19.1). 2 (b): 'n'-mode asserts. 1 (b): lims_analytics has SELECT on v_pub_report_content but the view is security_invoker and lims_analytics has no grant on the base tables -> permission denied | C11 (+ decision A19.1) |
| micro/T0B-13.C10_behaviour | 12 | (b) | 2 asserts in 'n' mode (E42601, unrun); 10 fixture rows without FK parents (cultures__order__fk, instrument_records__instrument__fk, specimen_isolate_counters__specimen__fk) -> cascade to immutable_row / audit-count asserts | C10 |
| frontdesk_billing/T0B-10.C4_schema | 11 | (b) | schema ran ahead of the test: parity migrations 20261117100000/110000/140000 add 6 frontdesk + 6 billing relations, own-row DELETE policies `registration_drafts__delete__owner` / `favourite_tests__delete__owner` (TO lims_app, user_id = membership) and DELETE grants; test still expects the 96-policy / no-DELETE shape | C4 |
| partners/T0B-13.C13_schema | 11 | (b) | schema ran ahead of the test: migration 20261117210000 adds party_sales_assignment, sales functions, 4 triggers; event_inbox owner policies not excluded; redact_lines ACL test `LIKE '%=X/%'` matches `lims_owner=X/lims_owner` (no PUBLIC grant exists) | C13 |
| quality/T0B-13.C9_behaviour | 11 | (a?)+(b) | 1 (a?): device actor sees qc_plans (A19.1). 2 (b): 'n'-mode asserts. 8 (b): fixture rows without FK parents (qc_targets__lot__fk, qc_observations__source_row__fk, qc_runs__instrument__fk, qc_plans__instrument__fk) -> audit asserts cascade | C9 (+ decision A19.1) |
| views/C9-T20.v_pub_qc_summary | 9 | (b) | 4-argument col_type_is(schema, view, col, type) binds as (table, column, type, description) -> 'Column quality.v_pub_qc_summary does not exist'. View exists, security_invoker, columns_are passes | C9 |
| homecollection/T0B-13.C17_schema | 8 | (b) | drift: collector_flags table and extra triggers; regex `(^/[ (])true($/[ )])` hits `current_setting('app.maintenance', true)`; event_inbox owner policy GUC is purge_event_inboxes, test names the visits GUC | C17 |
| isolation/migration_staging.batches | 7 | (b) | generator ignores `policy_role: lims_migration`: step 2-9 run as lims_api/lims_worker, which have no grant on the table (E42501, closed); lims_migration itself needs the D-136 membership to run the policies | C0-0B (+ C0-0A D-136) |
| isolation/migration_staging.crosswalk_entries | 7 | (b) | generator ignores `policy_role: lims_migration`: step 2-9 run as lims_api/lims_worker, which have no grant on the table (E42501, closed); lims_migration itself needs the D-136 membership to run the policies | C0-0B (+ C0-0A D-136) |
| isolation/migration_staging.issues | 7 | (b) | generator ignores `policy_role: lims_migration`: step 2-9 run as lims_api/lims_worker, which have no grant on the table (E42501, closed); lims_migration itself needs the D-136 membership to run the policies | C0-0B (+ C0-0A D-136) |
| isolation/migration_staging.match_pairs | 7 | (b) | generator ignores `policy_role: lims_migration`: step 2-9 run as lims_api/lims_worker, which have no grant on the table (E42501, closed); lims_migration itself needs the D-136 membership to run the policies | C0-0B (+ C0-0A D-136) |
| isolation/migration_staging.reports | 7 | (b) | generator ignores `policy_role: lims_migration`: step 2-9 run as lims_api/lims_worker, which have no grant on the table (E42501, closed); lims_migration itself needs the D-136 membership to run the policies | C0-0B (+ C0-0A D-136) |
| isolation/migration_staging.run_events | 7 | (b) | generator ignores `policy_role: lims_migration`: step 2-9 run as lims_api/lims_worker, which have no grant on the table (E42501, closed); lims_migration itself needs the D-136 membership to run the policies | C0-0B (+ C0-0A D-136) |
| isolation/migration_staging.run_files | 7 | (b) | generator ignores `policy_role: lims_migration`: step 2-9 run as lims_api/lims_worker, which have no grant on the table (E42501, closed); lims_migration itself needs the D-136 membership to run the policies | C0-0B (+ C0-0A D-136) |
| isolation/migration_staging.runs | 7 | (b) | generator ignores `policy_role: lims_migration`: step 2-9 run as lims_api/lims_worker, which have no grant on the table (E42501, closed); lims_migration itself needs the D-136 membership to run the policies | C0-0B (+ C0-0A D-136) |
| isolation/migration_staging.samples | 7 | (b) | generator ignores `policy_role: lims_migration`: step 2-9 run as lims_api/lims_worker, which have no grant on the table (E42501, closed); lims_migration itself needs the D-136 membership to run the policies | C0-0B (+ C0-0A D-136) |
| isolation/migration_staging.signoffs | 7 | (b) | generator ignores `policy_role: lims_migration`: step 2-9 run as lims_api/lims_worker, which have no grant on the table (E42501, closed); lims_migration itself needs the D-136 membership to run the policies | C0-0B (+ C0-0A D-136) |
| isolation/migration_staging.stg_documents | 7 | (b) | generator ignores `policy_role: lims_migration`: step 2-9 run as lims_api/lims_worker, which have no grant on the table (E42501, closed); lims_migration itself needs the D-136 membership to run the policies | C0-0B (+ C0-0A D-136) |
| isolation/migration_staging.stg_financial | 7 | (b) | generator ignores `policy_role: lims_migration`: step 2-9 run as lims_api/lims_worker, which have no grant on the table (E42501, closed); lims_migration itself needs the D-136 membership to run the policies | C0-0B (+ C0-0A D-136) |
| isolation/migration_staging.stg_masters | 7 | (b) | generator ignores `policy_role: lims_migration`: step 2-9 run as lims_api/lims_worker, which have no grant on the table (E42501, closed); lims_migration itself needs the D-136 membership to run the policies | C0-0B (+ C0-0A D-136) |
| isolation/migration_staging.stg_patients | 7 | (b) | generator ignores `policy_role: lims_migration`: step 2-9 run as lims_api/lims_worker, which have no grant on the table (E42501, closed); lims_migration itself needs the D-136 membership to run the policies | C0-0B (+ C0-0A D-136) |
| isolation/migration_staging.stg_results | 7 | (b) | generator ignores `policy_role: lims_migration`: step 2-9 run as lims_api/lims_worker, which have no grant on the table (E42501, closed); lims_migration itself needs the D-136 membership to run the policies | C0-0B (+ C0-0A D-136) |
| isolation/migration_staging.stg_visits | 7 | (b) | generator ignores `policy_role: lims_migration`: step 2-9 run as lims_api/lims_worker, which have no grant on the table (E42501, closed); lims_migration itself needs the D-136 membership to run the policies | C0-0B (+ C0-0A D-136) |
| smartreport/T0B-13.C14_behaviour | 7 | (a?)+(b) | 3 (a?): CHECKs rules__followup_fields__ck, summaries__score__ck, library_versions__hash__ck are NULL-passing (follow-up rule with NULL interval_days, score without band, published library without hash are ACCEPTED). 4 (b): 'n'-mode UPDATE asserts | C14 |
| grants/T0B-08_grants | 6 | (b) | partners.manifest_lines DELETE is specified (C13 05-SCHEMA s5, policy manifest_lines__delete__partner: own partner org AND state='draft'); reporting.provider_events UPDATE is LD-257 (system actor, applied_at NULL->NOT NULL, mutable-columns trigger). Registry class says otherwise | C0-0B |
| homecollection/T0B-13.C17_anonymise | 6 | (b) | fixture visits__centre__fk missing parent (RI re-check on same-txn UPDATE) and `search_path=` literal vs PG17 `search_path=""` | C17 |
| policy/T0B-08_policy_shape | 6 | (b) | test knows only lims_owner for GUC/owner policies; reporting `__lookup`/`__owner_only` policies are TO lims_reporting_lookup (only lims_migrator is a member, no SET for lims_api); RESTRICTIVE number_counters policies and ANY_T engagement tables are LD-215; actor-policy name regex misses `__patient_account`, `__own` | C0-0B |
| catalog/T0B-10.C3_schema | 5 | (b) | schema ran ahead of the test: 20261117170000 / 20261117200000 add 4 tables, 11 policies, 1 tg function, 1 lifecycle trigger, 3 audit triggers | C3 |
| engagement/T-OPS1_purge | 5 | (b) | `search_path=` literal vs PG17 `search_path=""` (2); DELETE of referenced link_code now returns 0 rows (policy NOT EXISTS) instead of 23503; system actor has no DELETE/UPDATE grant on links/self_registrations (E42501 instead of 0) - both stricter than the test | C16 |
| engagement/T0B-13.C16_schema | 5 | (b) | drift: number_counters__patient_no_decrease trigger + guard_counter_decrease (20261116030000); v_pub_* views have nullable tenant_id; regex hits `current_setting(..., true)`; RESTRICTIVE nonstaff_keys policies have no tenant predicate by design (AND-ed with the tenant policy) | C16 |
| identity/PLATFORM-DDL-1_policies | 5 | (b)+(c) | platform UPDATE of audited per-tenant tables (feature_flags, support_sessions, ird_annex_records, tenant_settings) fails: app.tg_row_audit (DEFINER) writes audit_log under platform claims (no tenant claim) and audit_log__insert__owner_only refuses -> 42501. Fails closed. File aborts at line 193 (same cause), later assertions unrun | C2 / C0-0B (audit policy) |
| identity/T0B-10.C2_schema | 5 | (b) | drift: tenant_contract_acceptances (20261115192000), platform policies (…191000), `__own` policies (…116010000); seeded invited membership missing; 23502 raised before 23505 | C2 |
| isolation/billing.credit_note_lines | 5 | (b) | BEFORE INSERT guard billing.credit_note_lines_guard raises P0001 before RLS WITH CHECK / FK (steps 3,5,6,8) | C0-0B |
| isolation/engagement.booking_centres | 5 | (b) | same: no fixture rows (policies read, tenant-bound; not exercised with rows) | C0-0B |
| isolation/partners.manifest_lines | 5 | (b) | 4: BEFORE INSERT partners.check_line_parent raises 23503/23514 before RLS (steps 3,5,6,8); 1: the known org-wide step-9 probe bug (NEPAL-leak-C13) | C0-0B |
| isolation/partners.settings | 5 | (b) | fixture builder emitted no rows (step 1 'seeded' fails; steps 2-9 vacuous). Manual check with rows: tenant B rows visible to nobody of tenant A; policies tenant-bound | C0-0B |
| isolation/reporting.settings | 5 | (b) | same: no fixture rows. Manual check with rows: 0 tenant B rows for every actor; portal and device read the own-tenant row | C0-0B |
| isolation/smartreport.rules | 5 | (b) | assert_library_draft P0001; step 6 E23514 | C0-0B |
| definers/T0B-08_contracts_platform | 4 | (b) | run-suites loads seeds 010 (tenants a001/b001) before suites that assume only their own tenants | C0-0B |
| engagement/T-A2_resolve_preauth | 4 | (b) | `search_path=` literal (1); number_counters fixture INSERT omits created_by (NOT NULL) -> 3 cascade | C16 |
| identity/T0B-ASYNC-1_worker_grants | 4 | (a?)+(b) | 1 (a?): app.identity_login_context(uuid) is SECURITY DEFINER keyed only by a caller-supplied user id and now EXECUTE for lims_worker (20261116040000); for an unknown id it returns one all-NULL row (test wants none). 3 (b): lookup-role policies; app.uuidv7() has no EXECUTE for lims_worker/lims_api but worker + API SQL calls it (permission denied at runtime) | C2 / C9 / C0-0B |
| isolation/billing.credit_notes | 4 | (b) | BEFORE INSERT credit_notes_chronology_guard raises P0001 (steps 5,6) | C0-0B |
| isolation/billing.ledger_entries | 4 | (b) | BEFORE INSERT ledger_reversal_guard raises P0001; step 6 E23514 | C0-0B |
| core/T0B-05_platform | 3 | (b) | seeded tenants a001/b001 counted by cron_tenant_ids; lookup-role policies | C0-0B |
| engagement/T-SEC1_table_probes | 3 | (b) | class G g_cs_* tables have no RLS by design (SELECT-only); RESTRICTIVE nonstaff_keys policies | C16 |
| identity/AUTH-MFA-COMPLETE-1_platform_event | 3 | (b) | test leaks app.pre_user_id (set_config is_local) from case 1 into case 2 ('no GUC set'), so the insert is legitimately accepted; with the GUC empty the policy refuses (verified); lookup-role policies | C2 |
| identity/T0B-10.C2_maintenance | 3 | (b) | sessions__revoke__ck now requires revoke fields; 2 asserts wrap DML in WITH (E0A000) | C2 |
| instruments/T0B-10.C7_schema | 3 | (b) | stale: expects no is_staff_or_system on centre tables (P-16 added it; device still admitted), event_inbox DELETE policy, 14 later FKs into instruments | C7 |
| inventory/T0B-13.C12_behaviour | 3 | (b) | 3 asserts in 'n' mode (E42601); D-72 purge policy already requires actor_type = 'system' | C12 |
| isolation/billing.invoices | 3 | (b) | BEFORE INSERT invoices_chronology_guard raises P0001 (steps 5,6) | C0-0B |
| isolation/catalog.critical_limits | 3 | (b) | BEFORE INSERT catalog.tg_parent_is_draft raises P0001 (steps 3,6,8) | C0-0B |
| isolation/catalog.formula_dependencies | 3 | (b) | tg_parent_is_draft P0001 | C0-0B |
| isolation/catalog.price_list_assignments | 3 | (b) | step 6 E23514 before FK (3 FKs); composite | C0-0B |
| isolation/catalog.price_list_items | 3 | (b) | tg_parent_is_draft P0001 | C0-0B |
| isolation/catalog.reference_ranges | 3 | (b) | tg_parent_is_draft P0001 | C0-0B |
| isolation/smartreport.analyte_groups | 3 | (b) | BEFORE INSERT smartreport.assert_library_draft P0001 | C0-0B |
| isolation/smartreport.group_settings | 3 | (b) | assert_library_draft P0001 | C0-0B |
| isolation/smartreport.template_blocks | 3 | (b) | assert_library_draft P0001 | C0-0B |
| frontdesk_billing/T0C-REGPARITY-2_registration_parity | 2 | (b) | delete of a favourite is own-row only (user_id = membership) since 20261117140000, fixture row belongs to another user; policy count test taken before re-apply | C4 |
| instruments/T0B-10.C7_behaviour | 2 | (b) | test role has no grant on agent_credentials (E42501 closed) instead of immutable_row | C7 |
| inventory/T0B-13.C12_schema | 2 | (b) | event_inbox DELETE owner policy; proconfig printed as `{"search_path=\"\""}` not `{search_path=""}` | C12 |
| isolation/billing.refund_requests | 2 | (b) | step 6 E23514 before FK; composite | C0-0B |
| isolation/catalog.surcharge_rules | 2 | (b) | step 6 E23514 before FK; composite | C0-0B |
| isolation/catalog.tax_rules | 2 | (b) | step 6 E23514 before FK; composite | C0-0B |
| migration_staging/T0B-13.C18_schema | 2 | (b) | test wants `GRANT lims_app TO lims_migration WITH INHERIT TRUE, SET FALSE`; bootstrap deliberately creates the role with NO membership (D-136 undecided) | C0-0A / C18 (founder D-136) |
| reporting/T0B-10.C6_schema | 2 | (b) | event_inbox DELETE owner policy not excluded | C6 |
| anatomic/T0B-13.C11_schema | 1 | (b) | event_inbox DELETE owner policy not excluded | C11 |
| core/T0B-03_isolation | 1 | (b) | membership_centres INSERT of tenant B row raises 23514 (BEFORE INSERT scope_user_only) before the RLS check | C0-0B |
| core/T0B-03_schema | 1 | (b) | lookup-role policies | C0-0B |
| definers/T0B-08_contracts_helpers | 1 | (b) | platform session reads identity.platform_staff directly: policy platform_staff__select__platform added by PLATFORM-DDL-1 (aal2 + active staff row required) | C0-0B |
| definers/T0B-08_inventory | 1 | (a?) | inventory row says lims_worker has no EXECUTE on app.identity_login_context(uuid); 20261116040000 granted it (founder-approved LD-277). Test stale; the widened DEFINER has no claims guard | C2 / C0-0B |
| definers/T0B-08_owner_policies | 1 | (b) | seeded tenants make cron_tenant_ids return 3 not 1 | C0-0B |
| engagement/T-Q3_resolve_display | 1 | (b) | `search_path=` literal | C16 |
| identity/SESSION-ACTOR-1_session_actor | 1 | (b) | lookup-role policies (same as policy_shape 463/476) | C0-0B |
| immutability/T0B-08_immutability | 1 | (a?) | 39 class C/B tables lack an app.enforce_mutable_columns trigger: 21 have a bespoke guard trigger (test only recognises the generic one), 18 have NO BEFORE UPDATE guard at all although lims_app can UPDATE them | C0-0B + C5/C11/C4/C3/C15 owners |
| isolation/analytics.schedules | 1 | (b) | step 6: CHECK fires before FK (E23514); schedules__owner__fk is (tenant_id, owner_membership_id) -> core.memberships (tenant_id, id) | C0-0B |
| isolation/anatomic.item_submissions | 1 | (b) | step 6 E23514 before FK; composite (tenant_id, case_item_id, case_id) | C0-0B |
| isolation/anatomic.report_versions | 1 | (b) | step 6 E23514 before FK; composite | C0-0B |
| isolation/anatomic.stain_orders | 1 | (b) | step 6 E23514 before FK; composite | C0-0B |
| isolation/billing.credit_charges | 1 | (b) | step 6 E23514 before FK; composite | C0-0B |
| isolation/catalog.doctors | 1 | (b) | step 6 E23514 before FK; composite | C0-0B |
| isolation/engagement.bookings | 1 | (b) | step 6 E23514 before FK; composite | C0-0B |
| isolation/engagement.cs_booking_cancel_reasons | 1 | (b) | KNOWN (C16) | C0-0B |
| isolation/engagement.cs_enquiry_categories | 1 | (b) | KNOWN (C16) | C0-0B |
| isolation/engagement.cs_reminder_reasons | 1 | (b) | KNOWN (C16) | C0-0B |
| isolation/engagement.number_counters | 1 | (b) | KNOWN (C16) | C0-0B |
| isolation/engagement.queue_tokens | 1 | (b) | step 6 E23514 before FK; composite | C0-0B |
| isolation/engagement.settings | 1 | (b) | KNOWN (NEPAL-leak-C16): LD-215 ANY_T | C0-0B |
| isolation/frontdesk.discounts | 1 | (b) | step 6 E23514 before FK; composite | C0-0B |
| isolation/homecollection.mutations | 1 | (b) | KNOWN (NEPAL-leak-C17): deferred FK | C0-0B |
| isolation/identity.branding_assets | 1 | (b) | step 6 E23514 before FK; composite | C0-0B |
| isolation/inventory.consumption_rules | 1 | (b) | step 6 E23514 before FK; composite | C0-0B |
| isolation/partners.access_slips | 1 | (b) | KNOWN (NEPAL-leak-C13): step 9 org-wide | C0-0B |
| isolation/partners.manifests | 1 | (b) | KNOWN (C13) | C0-0B |
| isolation/partners.order_reports | 1 | (b) | KNOWN (C13) | C0-0B |
| isolation/partners.order_tracking | 1 | (b) | KNOWN (C13) | C0-0B |
| isolation/partners.partner_referrers | 1 | (b) | step 6 E23514 before FK; composite | C0-0B |
| isolation/partners.pickup_request_manifests | 1 | (b) | KNOWN (C13) | C0-0B |
| isolation/partners.pickup_requests | 1 | (b) | KNOWN (C13) | C0-0B |
| isolation/partners.tracked_specimens | 1 | (b) | KNOWN (C13) | C0-0B |
| lab/T0B-10.C5_schema | 1 | (b) | 14 FKs from later chunks into lab now exist (test says 'none yet') | C5 |
| micro/T0B-13.C10_schema | 1 | (b) | event_inbox DELETE owner policy not excluded | C10 |
| payments/T0B-13.C15_schema | 1 | (b) | event_inbox DELETE owner policy not excluded | C15 |
| quality/T0B-13.C9_schema | 1 | (b) | event_inbox DELETE owner policy not excluded | C9 |
| seeds/T0B-09_seeds | 1 | (b) | g_permissions in seeds has 12+ codes (billing.account*, billing.cash_transfer*, sync.*, partners.sales.*) that db/meta/permissions.yaml does not list | C0-0B (seeds/meta) + C4/C13 |
| smartreport/T0B-13.C14_schema | 1 | (b) | event_inbox DELETE owner policy not excluded | C14 |
| storage/T0B-12_storage | 1 | (c) | bucket rows are provisioned by the Storage API (LD-54) and the stub schema has none; file then aborts at line 48 (syntax error), so the policy asserts are unrun in this harness | C0-0B (test env) |
| identity/AUTH-PLATFORM-SESSION-1_platform_reads | 0 | (c) | file aborts at line 81: sessions__kind_shape__ck now forbids a platform session without platform_staff_id; 0 assertions ran, so the two platform-auth DEFINERs it covers are unverified here | C2 |
| identity/T0B-06_definers | 0 | (c) | file aborts at line 88: mfa_factors.gotrue_factor_id NOT NULL, status 'pending' no longer allowed, support_sessions.platform_staff_id NOT NULL; the identity DEFINER suite (08 A12.1 pre-tenant lookups) did not run | C2 |
| identity/T0B-10.C2_lookups | 0 | (b) | file aborts at line 141: deactivation_reason_code 'admin_deactivate' no longer in the CHECK. With 'other' substituted in a scratch copy: 61 of 62 ok | C2 |
| migration_staging/T0B-13.C18_behaviour | 0 | (b)+(c) | lims_migration cannot EXECUTE app.current_tenant_id() (no lims_app membership, D-136) -> permission denied at line 92. With the membership granted in a scratch cluster 214 assertions run (RLS, append-only) with 1 count mismatch, then abort at T5 (audit_context_missing: test sets no sub); the rest is unrun | C18 / C0-0A (founder D-136) |
| partners/T0B-13.C13_behaviour | 0 | (b) | file aborts at line 73: fixture inserts a tenant B row under tenant A claims, the audit trigger refuses. With the fixture block run under session_replication_role=replica in a scratch copy: 130 of 132 ok (the 2 audit counts are an artefact of that change) | C13 |

**(a): none found. (a?): D1 `device` actor admitted by app.is_staff_or_system() on 249 tables, shown red on payments (C15_behaviour 23 assertions: 11 reads, 11 INSERTs, 1 UPDATE), anatomic (C11_behaviour 9) and quality (C9_behaviour 1); D2 18 class-C tables that lims_app can UPDATE have no BEFORE UPDATE guard (T0B-08_immutability: anatomic.batch_members/batches/case_items/gross_records/molecular_results/parts/specimen_links/stain_orders, billing.credit_note_tasks/finance_review_items, frontdesk.order_flags, lab.ingest_exceptions/order_readiness/order_tests/orders/qc_holds/worksheets, payments.reconciliation_runs); D3 smartreport CHECKs rules__followup_fields__ck / summaries__score__ck / library_versions__hash__ck accept NULL (C14_behaviour 357, 370, 373); D4 SECURITY DEFINER app.identity_login_context(uuid) has no claims guard and is now EXECUTE for lims_worker (T0B-08_inventory 204, T0B-ASYNC-1 13). (c): C1 identity DEFINER suites that did not run (T0B-06_definers, AUTH-PLATFORM-SESSION-1_platform_reads, T-L2_redeem_link_code after line 126, PLATFORM-DDL-1_policies after line 193, T0B-12_storage); C2 migration_staging RLS never exercised as lims_migration (C18_behaviour, 16 migration_staging isolation files, T0B-08_step9_fixed) until D-136 is decided.**

## Method and evidence (read this first)

- Evidence: `/tmp/claude-0/dbsuite2.log` (full run of `bash db/tests/run-suites.sh`, 2026-11-18, 407 s), split per `# --- <file>` header: 115 red files = 110 with `not ok` lines (505 assertions) + 5 files that aborted on a psql error before any `not ok` (AUTH-PLATFORM-SESSION-1_platform_reads, T0B-06_definers, T0B-10.C2_lookups, T0B-13.C13_behaviour, T0B-13.C18_behaviour).
- Two scratch containers (`LIMS_PG_PREPARE_ONLY=1`, image pin from run-suites.sh): one clean (all patched test copies ran there), one with the generated probe fixtures committed (read-only sweeps). Nothing in the repo was changed except this file; both containers are removed at the end. Every "verified" below was executed; every diff below was applied only to scratch copies (`git apply --check` clean against HEAD).
- Class counts. Assertions (505 `not ok`): (a?) 39, (c) 20, (b) 446. Files (115): 7 carry an (a?) item, 6 are (c) (three of them have no `not ok` line because they abort), 102 are pure (b). No (a) (confirmed leak or RLS/grant bypass) was found.
- No cross-tenant leak was found. Every red assertion about another tenant's rows is a probe/test/fixture artefact or a guard that fires before the RLS check. Evidence for that claim:
  - Policy sweep of the migrated database: every `lims_app` policy outside the platform set, the LD-215 `number_counters` RESTRICTIVE trio and the owner-only/maintenance policies carries `app.current_tenant_id()` (or an actor-bound helper). No policy has a literal `true` qual outside `lims_owner`.
  - All 41 composite FKs named in the red step-6 probes were read from `pg_constraint`: each starts with `tenant_id` on both sides (e.g. `smartreport.rules__block__fk (tenant_id, library_version_id, block_id, block_kind) -> template_blocks (tenant_id, library_version_id, id, kind)`), so a tenant B parent cannot be referenced.
  - Sweep with probe fixtures committed (tenant A claims, `lims_api`, every RLS table, 4 non-staff actor types): partner sees 16 partners.* tables (own organisation) + core.idempotency_keys (own rows); patient sees 5 engagement ANY_T tables + idempotency_keys; portal sees idempotency_keys; none of them sees anything else. `device` sees 249 tables (see item D1).
  - All 66 SECURITY DEFINER functions in the app schemas: none has PUBLIC EXECUTE, none lacks a pinned `search_path` (the T-A2 / T-Q3 / T-OPS1 `search_path` failures are a PG17 text format difference: `search_path=""` vs the literal `search_path=` in the test).

## Items that need a decision (every (a)/(a?)/(c) item)

### (a?) D1. `device` actors are admitted by `app.is_staff_or_system()` on 249 tables (the C15, C11, C9 behaviour suites assert 0)
- Where: `db/migrations/20261105000100_app__create_context_helpers.sql:22-24` `SELECT coalesce(app.current_actor_type() IN ('user','system','device'), false)`; every `__tenant` policy (e.g. `db/policies/payments.sql:5-48`, migration `20261115150000_payments__create_payments_schema.sql:395`) calls only that helper. `smartreport.*` alone adds `AND current_actor_type() IN ('user','system')` (D-109).
- What a device session gets today (verified, `lims_app`, tenant A claims, `actor_type: device`): SELECT of payments.settings/merchant_accounts/intents/intent_transitions/gateway_calls/callbacks/refunds/reconciliation_*/static_qr/cs_reasons (11 tables, test 119-159); INSERT into those 11 (tests 248-288: n=1 or E23505 after the policy passed); UPDATE of payments.merchant_accounts (test 185 after the mode fix); 9 anatomic tables (C11 149-201); quality.qc_plans (C9 166). From the policy list: DELETE of core.membership_roles / role_permissions / membership_centres / membership_branches, panel_members, files (all `... AND is_staff_or_system()`).
- Why only (a?): 08 A19.1 accepts it ("RLS keeps admitting device ... the boundary is enforced above the database: a staff_mobile/device session reaches only /v1/instruments/agent/*", probe in `tools/codegen/gen-probe-manifest.ts`). The C15/C11/C9 suites were written to the P-16 text, which says the opposite. Defence in depth is one API-layer bug away from money and role tables.
- Decision for the founder: (A) keep A19.1 and change the tests (delete `('device')` from the 4 read/update/insert lists in the three suites); or (B) extend D-109 to payments (and, if wanted, anatomic, quality, identity role tables). Option B is a migration, tested in a scratch cluster: after it, device reads 0 payments.intents, a `user` still reads 1, and the whole C15 behaviour file is green (518/518 with the other fixes below). Patch in section C15.

### (a?) D2. 18 class-C tables that `lims_app` can UPDATE have no BEFORE UPDATE guard of any kind (T0B-08_immutability #1)
- `anatomic.batch_members, batches, case_items, gross_records, molecular_results, parts, specimen_links, stain_orders`; `billing.credit_note_tasks, finance_review_items`; `frontdesk.order_flags`; `lab.ingest_exceptions, order_readiness, order_tests, orders, qc_holds, worksheets`; `payments.reconciliation_runs`. tables.yaml says class C ("only lifecycle columns change", AC-0B-4.1). Queried `pg_trigger`: none of them has any BEFORE UPDATE trigger. The other 21 listed tables have a bespoke guard (`lab.enforce_result_lock`, `anatomic.guard_case`, `inventory.tg_doc_guard`, `micro.tg_child_final_lock`, partners guards, ...) and are only a test recognition problem.
- Effect: a same-tenant staff (or device, D1) session can rewrite immutable columns, e.g. `lab.orders.patient_id / registration_no`, `lab.order_tests.order_id`, `payments.reconciliation_runs.business_date`. Not cross-tenant (RLS WITH CHECK still binds tenant_id) but it is "a write succeeds that should be refused". C5 05-SCHEMA s7 lists lab immutability and does not mention orders/order_tests/worksheets/qc_holds/order_readiness, so the gap is in the spec table too.
- Needs: per-table mutable-column lists from the owners (C3/C4/C5/C11/C15); a generic `app.enforce_mutable_columns(<list>)` trigger each, as migration `20261115200000_core__add_mutable_columns_triggers.sql` does for others. Not drafted here (the lists are theirs to decide).

### (a?) D3. Three CHECK constraints in smartreport accept NULL, so the rule they state is not enforced (C14 behaviour 357, 370, 373)
- `db/migrations/20261115140000_smartreport__create_smartreport_schema.sql:215-217` `rules__followup_fields__ck`: `rule_kind='followup' AND suggested_test_id IS NOT NULL AND interval_days BETWEEN 1 AND 730` is NULL (passes) when `interval_days` is NULL. Same file `:382` `summaries__score__ck` (value 50 with band NULL passes) and `:134` `library_versions__hash__ck` (`status='draft' OR content_sha256 ~ regex` is NULL when the hash is NULL, so a published/in_review version with no hash passes). Columns are nullable (`interval_days`, `health_score_band`, `content_sha256`).
- Verified on a temp table with the same expression, and on the real tables: after the migration in section C14 the three tests pass (the whole C14 behaviour file is green with the one-argument test fix).
- Effect: a follow-up advice rule with no interval, a health score with no band, a published library with no content hash are accepted (library hash is the integrity anchor of a published library, REQ-SEC). Same-tenant data integrity, not exposure.

### (a?) D4. SECURITY DEFINER `app.identity_login_context(uuid)` has no claims guard and is now EXECUTE for `lims_worker` (T0B-08_inventory #204, T0B-ASYNC-1 #13)
- `20261105000800_app__create_identity_definers.sql:83` + `20261116040000_identity__grant_login_context_to_worker.sql`: returns platform_staff id/role, tenant id/status, membership id/status, mfa_required, has_verified_factor for ANY user id given by the caller (it sets `app.pre_user_id` itself). Guard = knowledge of the user uuid + EXECUTE only to lims_api, lims_owner and now lims_worker. For an unknown id it returns one all-NULL row (`FROM (SELECT 1) x`), the test wants zero rows.
- Accepted design for the pre-tenant login path (08 A12.1; LD-277 widened it deliberately); marked because the instruction is strict. If it should stay: update the inventory row and make the function return no row when `membership_count = 0 AND platform_staff_id IS NULL`.

### (c) C1. The identity DEFINER suites did not run: T0B-06_definers, AUTH-PLATFORM-SESSION-1_platform_reads (0 assertions each), T-L2_redeem_link_code (after line 126), PLATFORM-DDL-1_policies (after line 193), C18_behaviour (after T5), T0B-12_storage
- Checked: why each aborts (fixture rows no longer satisfy later constraints; see the rows in the table). T0B-10.C2_lookups and C13_behaviour were un-blocked in scratch copies and are green apart from 1 resp. 2 count artefacts.
- Still missing: execution of the pre-tenant identity DEFINERs that take caller-supplied ids and return or write credentials: `identity_platform_auth_load_session(p_user_id, p_session_id)` (returns the encrypted access/refresh tokens), `identity_platform_auth_write_*` (staff_login, session_insert/update, mfa_factor, invitation_accept), `identity_session_by_token(bytea)`, `identity_bootstrap_platform_admin` (one-shot, guarded by `bootstrap_closed`). All are `lims_api`-only, pinned, but none binds its parameter to the claims. They need the fixtures of T0B-06_definers / AUTH-PLATFORM-SESSION-1_platform_reads repaired (C2) before anyone can say "guarded". Until then treat as (a?).
- storage: bucket rows are created by the Storage API in production; the harness stub has none. The `storage.objects` policy asserts after line 48 never ran.

### (c) C2. migration_staging RLS has never run in the suite as the role that owns the policies
- Facts: the 53 policies are `TO lims_migration`; `lims_migration` has no `lims_app` membership (bootstrap, D-136 undecided) and so cannot EXECUTE `app.current_tenant_id()` / `app.is_staff_or_system()`: verified `permission denied for function current_tenant_id`. lims_api/lims_worker have no grant on the tables, so the 16 generated probes and `T0B-08_step9_fixed` (64 assertions) can only ever see E42501 (closed). The loader (C18) cannot read or write its own staging tables as shipped.
- Verified in a scratch cluster after `GRANT lims_app TO lims_migration WITH INHERIT TRUE, SET FALSE` (what C18_schema #37/38 assert): the 16 generated probes (with the generator patch below, role = lims_migration) are all green, including step 9 (partner/portal/patient read 0 rows) and the cross-tenant INSERT/UPDATE/DELETE steps; `C18_behaviour` runs 214 assertions (213 ok, 1 fixture count mismatch) before its T5 fixture aborts on `audit_context_missing`.
- Trade-off the founder must own: membership gives lims_migration every lims_app table privilege in every schema (RLS-bound by claims the caller sets itself). Least-privilege alternative below (EXECUTE on the two helpers only) passes the same RLS probes but fails the two C18_schema membership assertions.


## Sections per owner chunk

Convention: "verified" = run in the scratch cluster. Diffs are against HEAD, `git apply --check` clean, NOT applied. Test-only diffs touch db/tests (owner C0-0B for the harness, the named chunk for its own suite); migrations are new files, never edits of applied ones.

### C0-0B (db/tools, db/tests harness, tables.yaml, seeds, registry)

1. **Probe generator** (all red generated isolation files except the 11 + 5 + 1 already diagnosed and the 3 fixture-less ones). Three changes in `db/tools/gen-isolation-probes.ts`:
   - tables with `policy_role: lims_migration` are probed as `lims_migration` (steps 2-7, 9); step 8 asserts that lims_api and lims_worker hold no privilege on them. Valid only after D-136 (section C0-0A).
   - an explicit `INSERT_GUARD_CODES` table: tables whose BEFORE INSERT guard raises before the RLS WITH CHECK (billing chronology/lines/ledger guards, `catalog.tg_parent_is_draft`, `smartreport.assert_library_draft`, `partners.check_line_parent`) also accept that SQLSTATE in steps 3, 5, 6, 8.
   - step 6 accepts `E23514` (a CHECK on the copied row fired before the FK, 20 tables). The 41 FKs involved were checked in `pg_constraint`: all are tenant-composite, so the refusal is real.
   Verified: after regenerating in a scratch copy and running every previously red isolation probe against the scratch cluster (with the D-136 membership), only the already-diagnosed ones stay red (11 partners step 9, 5 engagement ANY_T, homecollection.mutations step 6) plus the 3 fixture-less tables below.
```diff
diff --git a/db/tools/gen-isolation-probes.ts b/db/tools/gen-isolation-probes.ts
index 98c43d9..f18fd55 100644
--- a/db/tools/gen-isolation-probes.ts
+++ b/db/tools/gen-isolation-probes.ts
@@ -15,6 +15,14 @@ const CLASSES = new Set(["M", "C", "B", "A", "E", "G", "R"]); // CV §5.2 table
 const ACTORS = ["partner", "portal", "patient"] as const;
 const SCOPE_USER_ONLY = new Set(["core.membership_centres", "core.membership_branches"]); // tables with BEFORE INSERT app.tg_scope_user_only (LD-21)
 const SUBS: Record<string, string> = { partner: "35", portal: "a3", patient: "34" }; // step-9 fixture actor ids (pg_temp.id keys)
+// tables with a BEFORE INSERT guard trigger (parent-must-be-draft / chronology / final-lock / line-parent check) that raises before the RLS WITH CHECK or the FK is evaluated:
+// the INSERT is refused either way, so steps 3 / 5 / 6 / 8 additionally accept the listed SQLSTATE for exactly these tables (explicit list: a new guard has to be added here on purpose).
+const INSERT_GUARD_CODES: Record<string, string[]> = {
+  "billing.credit_note_lines": ["EP0001"], "billing.credit_notes": ["EP0001"], "billing.invoices": ["EP0001"], "billing.ledger_entries": ["EP0001"],
+  "catalog.critical_limits": ["EP0001"], "catalog.formula_dependencies": ["EP0001"], "catalog.price_list_items": ["EP0001"], "catalog.reference_ranges": ["EP0001"],
+  "smartreport.analyte_groups": ["EP0001"], "smartreport.group_settings": ["EP0001"], "smartreport.rules": ["EP0001"], "smartreport.template_blocks": ["EP0001"],
+  "partners.manifest_lines": ["E23503"],   // partners.check_line_parent (BEFORE INSERT) raises 23503
+};
 const GENERATED = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.test\.sql$/; // hand-written suites in the same dir (T0B-08_*.test.sql) never match
 
 const root = rootDir();
@@ -1199,12 +1207,16 @@ function probeSql(t: string): string {
   ];
   const staff = "pg_temp.cl('user', '32', '42')"; // tenant A, all-centres staff
   const sys = "pg_temp.cl('system', '99')"; //      tenant A, system claims
+  const gx = (INSERT_GUARD_CODES[t] ?? []).map((c) => `, '${c}'`).join("");   // extra refusal codes of this table's BEFORE INSERT guard
+  // tables whose policies are TO lims_migration (C18 staging, tables.yaml policy_role): lims_api / lims_worker hold no grant on them (E42501 is the correct, closed answer);
+  // the probe runs as the policy role instead. Needs C18 05-SCHEMA s2 membership (D-136) so that lims_migration can EXECUTE app.current_tenant_id() / app.is_staff_or_system().
+  const runRole = (d as { policy_role?: string }).policy_role === "lims_migration" ? "lims_migration" : "lims_api";
   const writes = (role: string, claims: string, step: number) => {
     const tag = step === 8 ? `probe step 8: ${role} system claims` : `probe step ${step}:`;
     L.push(`SELECT is(pg_temp.x('${role}', ${claims}, pg_temp.q('SELECT 1 FROM %s WHERE %I = pg_temp.id(''02'')', ${rc}), 'n'), 'n=0', '${step === 8 ? tag : "probe step 2:"} tenant A claims see 0 tenant B rows of ${t}');`);
     const ins = `pg_temp.x('${role}', ${claims}, pg_temp.q('INSERT INTO %s (%I) VALUES (pg_temp.id(''02''))', ${rc}), 'w')`;
-    L.push(scoped
-      ? `SELECT is(CASE WHEN ${ins} IN ('E42501', 'E23514') THEN 'refused' ELSE ${ins} END, 'refused', '${step === 8 ? tag : "probe step 3:"} INSERT of a tenant B row into ${t} -> 42501 (23514 scope_user_only, LD-21)');`
+    L.push(scoped || gx
+      ? `SELECT is(CASE WHEN ${ins} IN ('E42501'${scoped ? ", 'E23514'" : ""}${gx}) THEN 'refused' ELSE ${ins} END, 'refused', '${step === 8 ? tag : "probe step 3:"} INSERT of a tenant B row into ${t} -> 42501 (${scoped ? "23514 scope_user_only, LD-21; " : ""}${gx ? "insert guard; " : ""}refused)');`
       : `SELECT is(${ins}, 'E42501', '${step === 8 ? tag : "probe step 3:"} INSERT of a tenant B row into ${t} -> 42501');`);
     L.push(`SELECT is(pg_temp.x('${role}', ${claims}, pg_temp.q('UPDATE %1$s SET %3$I = %3$I WHERE %2$I = pg_temp.id(''02'')', ${rc}), 'w'), pg_temp.want('${role}', ${rc}, 'UPDATE', pg_temp.ucol(${rc})), '${step === 8 ? tag : "probe step 4:"} UPDATE of tenant B rows of ${t} affects 0 rows');`);
     if (d.class === "M")
@@ -1220,36 +1232,45 @@ function probeSql(t: string): string {
     for (const a of ACTORS)
       L.push(`SELECT ok(pg_temp.n(format('SELECT 1 FROM ${t} WHERE %I = pg_temp.id(''${SUBS[a]}'')', pg_temp.owncol(${rc}))) > 0, 'probe step 1: ${a} fixture actor rows of ${t} seeded');`);
   L.push("-- probe step 2/3/4: lims_api, claims of tenant A (all-centres staff): no tenant B row visible, insertable or changeable (expect 0 rows / 42501)");
-  writes("lims_api", staff, 2);
+  writes(runRole, staff, 2);
   if (d.centre_scoped) {
     L.push("-- probe step 5: centre-A1 membership sees no centre A2 row and cannot insert one (42501)");
     L.push(`SELECT is(pg_temp.x('lims_api', pg_temp.cl('user', '31', '41'), 'SELECT 1 FROM ${t} WHERE ${cc} = pg_temp.id(''22'')', 'n'), 'n=0', 'probe step 5: centre A1 claims see 0 centre A2 rows of ${t}');`);
-    L.push(`SELECT is(pg_temp.x('lims_api', pg_temp.cl('user', '31', '41'), pg_temp.copy(${rc}, 'tenant_id = pg_temp.id(''01'') AND ${cc} = pg_temp.id(''22'')'), 'w'), 'E42501', 'probe step 5: centre A1 claims INSERT a centre A2 row into ${t} -> 42501');`);
+    const ins5 = `pg_temp.x('lims_api', pg_temp.cl('user', '31', '41'), pg_temp.copy(${rc}, 'tenant_id = pg_temp.id(''01'') AND ${cc} = pg_temp.id(''22'')'), 'w')`;
+    L.push(gx
+      ? `SELECT is(CASE WHEN ${ins5} IN ('E42501'${gx}) THEN 'refused' ELSE ${ins5} END, 'refused', 'probe step 5: centre A1 claims INSERT a centre A2 row into ${t} -> 42501 (insert guard; refused)');`
+      : `SELECT is(${ins5}, 'E42501', 'probe step 5: centre A1 claims INSERT a centre A2 row into ${t} -> 42501');`);
   }
   L.push("-- probe step 6: every composite FK carrying the tenant column (pg_constraint): tenant A row referencing a tenant B parent -> 23503 or 42501");
   L.push(`SELECT CASE WHEN f.stmt IS NULL THEN skip('probe step 6: ' || f.conname || ' on ${t}: no tenant A row of the table or no tenant B parent row seeded', 1)`);
-  L.push(`            ELSE is(CASE WHEN r.v IN ('E23503', 'E42501'${scoped ? ", 'E23514'" : ""}) THEN 'refused' ELSE r.v END, 'refused', 'probe step 6: ' || f.conname || ' on ${t} refuses a tenant B parent (23503/42501${scoped ? "; 23514 scope_user_only, LD-21" : ""})') END`);
+  L.push(`            ELSE is(CASE WHEN r.v IN ('E23503', 'E42501', 'E23514'${gx}) THEN 'refused' ELSE r.v END, 'refused', 'probe step 6: ' || f.conname || ' on ${t} refuses a tenant B parent (23503/42501/23514${scoped ? "; scope_user_only, LD-21" : ""}${gx ? "; insert guard" : ""})') END`);
   L.push(`  FROM pg_temp.fk_probes(${rc}) f CROSS JOIN LATERAL (SELECT CASE WHEN f.stmt IS NULL THEN NULL ELSE pg_temp.fk_try(${rc}, f.stmt) END AS v) r;`);
   L.push(`SELECT pass('probe step 6: ${t} has no composite tenant FK') WHERE NOT EXISTS (SELECT 1 FROM pg_temp.fk_probes(${rc}));`);
   L.push("-- probe step 7: no claims -> fail closed (AC-0B-3.7)");
-  L.push(`SELECT is(pg_temp.x('lims_api', '', 'SELECT 1 FROM ${t}', 'n'), 'n=0', 'probe step 7: lims_api without claims reads 0 rows of ${t}');`);
-  L.push("-- probe step 8: the same probes as lims_worker with system claims of tenant A");
-  writes("lims_worker", sys, 8);
-  L.push(`SELECT is(pg_temp.x('lims_worker', '', 'SELECT 1 FROM ${t}', 'n'), 'n=0', 'probe step 8: lims_worker without claims reads 0 rows of ${t}');`);
+  L.push(`SELECT is(pg_temp.x('${runRole}', '', 'SELECT 1 FROM ${t}', 'n'), 'n=0', 'probe step 7: ${runRole} without claims reads 0 rows of ${t}');`);
+  if (runRole === "lims_api") {
+    L.push("-- probe step 8: the same probes as lims_worker with system claims of tenant A");
+    writes("lims_worker", sys, 8);
+    L.push(`SELECT is(pg_temp.x('lims_worker', '', 'SELECT 1 FROM ${t}', 'n'), 'n=0', 'probe step 8: lims_worker without claims reads 0 rows of ${t}');`);
+  } else {
+    L.push("-- probe step 8: lims_api and lims_worker hold no privilege on a lims_migration-only table");
+    for (const r of ["lims_api", "lims_worker"])
+      L.push(`SELECT is(has_table_privilege('${r}', ${rc}, 'SELECT') OR has_table_privilege('${r}', ${rc}, 'INSERT') OR has_table_privilege('${r}', ${rc}, 'UPDATE') OR has_table_privilege('${r}', ${rc}, 'DELETE'), false, 'probe step 8: ${r} has no privilege on ${t}');`);
+  }
   const fixtures: Record<string, string> = { partner: "pg_temp.cl('partner', '35', '45')", portal: "pg_temp.cl('portal', 'a3')", patient: "pg_temp.cl('patient', '34', '44')" };
   const subs = SUBS;
   if (d.shared_with?.length) {
     L.push("-- probe step 9: shared_with table: non-staff actors of tenant A see only the rows their actor policy admits (own rows), never tenant B rows");
     for (const a of ACTORS) {
       if (d.shared_with.includes(a))
-        L.push(`SELECT is(pg_temp.x('lims_api', ${fixtures[a]}, format('SELECT 1 FROM ${t} WHERE %I IS DISTINCT FROM pg_temp.id(''${subs[a]}'') OR %I <> pg_temp.id(''01'')', pg_temp.owncol(${rc}), pg_temp.tcol(${rc})), 'n'), 'n=0', 'probe step 9: ${a} claims read only own rows of shared_with table ${t} (n=0 foreign rows)');`);
+        L.push(`SELECT is(pg_temp.x('${runRole}', ${fixtures[a]}, format('SELECT 1 FROM ${t} WHERE %I IS DISTINCT FROM pg_temp.id(''${subs[a]}'') OR %I <> pg_temp.id(''01'')', pg_temp.owncol(${rc}), pg_temp.tcol(${rc})), 'n'), 'n=0', 'probe step 9: ${a} claims read only own rows of shared_with table ${t} (n=0 foreign rows)');`);
       else
-        L.push(`SELECT is(pg_temp.x('lims_api', ${fixtures[a]}, 'SELECT 1 FROM ${t}', 'n'), 'n=0', 'probe step 9: ${a} claims read 0 rows of ${t} (${a} not in shared_with)');`);
+        L.push(`SELECT is(pg_temp.x('${runRole}', ${fixtures[a]}, 'SELECT 1 FROM ${t}', 'n'), 'n=0', 'probe step 9: ${a} claims read 0 rows of ${t} (${a} not in shared_with)');`);
     }
   } else {
     L.push("-- probe step 9: partner, portal and patient claims of tenant A read 0 rows (table not shared with non-staff actors)");
     for (const a of ACTORS)
-      L.push(`SELECT is(pg_temp.x('lims_api', ${fixtures[a]}, 'SELECT 1 FROM ${t}', 'n'), 'n=0', 'probe step 9: ${a} claims read 0 rows of ${t}');`);
+      L.push(`SELECT is(pg_temp.x('${runRole}', ${fixtures[a]}, 'SELECT 1 FROM ${t}', 'n'), 'n=0', 'probe step 9: ${a} claims read 0 rows of ${t}');`);
   }
   L.push("", "SELECT * FROM finish();", "ROLLBACK;", "");
   return L.join("\n");
```
   `T0B-08_step9_fixed` (48) is a hand-written registry-wide file, not generated; it needs its own change (a table on which lims_api holds no column privilege answers 42501). Verified: 1232/1232 ok with it.
```diff
diff --git a/db/tests/isolation/T0B-08_step9_fixed.test.sql b/db/tests/isolation/T0B-08_step9_fixed.test.sql
index e224ac6..dc8cf1f 100644
--- a/db/tests/isolation/T0B-08_step9_fixed.test.sql
+++ b/db/tests/isolation/T0B-08_step9_fixed.test.sql
@@ -49,7 +49,9 @@ SELECT is(pg_temp.x('lims_api', pg_temp.actor('user', '99'), 'SELECT 1 FROM ' ||
   FROM unnest(ARRAY['core.branches','core.users','core.memberships','audit.audit_log','audit.access_log']) t;
 
 -- probe step 9: every registered tenant table that is not shared_with reads 0 rows for partner, portal and patient claims of tenant A
-SELECT is(pg_temp.x('lims_api', pg_temp.actor(a.a, a.sub), 'SELECT 1 FROM ' || to_regclass(g.tbl)::text, 'n'), 'n=0',
+-- a table lims_api holds no SELECT on (migration_staging.*: policies are TO lims_migration, C18 05-SCHEMA s2) refuses with 42501, which is the closed answer; the lims_migration role is probed by the generated files
+SELECT is(pg_temp.x('lims_api', pg_temp.actor(a.a, a.sub), 'SELECT 1 FROM ' || to_regclass(g.tbl)::text, 'n'),
+          CASE WHEN has_any_column_privilege('lims_api', to_regclass(g.tbl), 'SELECT') THEN 'n=0' ELSE 'E42501' END,
           'probe step 9: ' || a.a || ' claims read 0 rows of ' || g.tbl)
   FROM registry g, actors a
  WHERE g.class <> 'G' AND NOT g.rls_exempt AND to_regclass(g.tbl) IS NOT NULL AND cardinality(g.shared_with) = 0;
```
2. **No fixture rows for `partners.settings`, `reporting.settings`, `engagement.booking_centres`** (15 assertions): `buildFixtures()` emits nothing for them (no warning), so step 1 fails and steps 2-9 run on an empty table. Not diagnosed in the builder (c-ish, no exposure): with rows inserted by hand, tenant A claims see 0 tenant B rows for all six actor types on partners.settings and reporting.settings (portal and device read the own-tenant reporting row); booking_centres policies were read, not exercised.
3. **Harness recognition fixes** (test-only): T0B-08_policy_shape #463/#464/#476 (and core/T0B-03_schema #15, core/T0B-05_platform #43, SESSION-ACTOR-1 #15, T0B-ASYNC-1 #22, AUTH-MFA-COMPLETE-1 #89) must allow `lims_reporting_lookup` for the policies that use `app.pre_*` (that role is held only by `lims_migrator`, SET TRUE / INHERIT FALSE; lims_api cannot assume it, so the GUC cannot be forged); #469/#479 the LD-215 exceptions (`db/tools/check-registry.ts:12-22` already has them); #481 the actor-policy name regex must accept `__patient_account`, `__own`, `__own_user`. T0B-08_grants: set `partners.manifest_lines` DELETE and `reporting.provider_events` UPDATE as expected exceptions (C13 s5, LD-257). T0B-08_immutability: recognise the bespoke guards (21 tables) and fail only for the 18 listed in D2.
4. **Seeds vs suites**: `run-suites.sh` loads seeds 010 (tenants a001/b001) before suites that assume only their own tenants: `definers/T0B-08_contracts_platform` #2,12,13,14, `definers/T0B-08_owner_policies` #31, `core/T0B-05_platform` #146,147. Either exclude seeds for those files (`--no-seeds` exists) or assert on the fixture ids only.
5. **`app.uuidv7()`** has EXECUTE for `lims_owner` only. Worker consumers `services/worker/src/jobs/quality/consumers/lab.result.verified.v1.ts:13`, `instruments.result.received.v1.ts:11` and API `services/api/src/modules/quality/repository/tat.repo.ts:134,162,237` call it as lims_worker / lims_api: permission denied at runtime (fail closed; breaks C9 TAT and QC consumers). Fix: grant (pure function) or change the three call sites to `@lims/shared-ts/uuidv7` as the function's own comment says (04 D9).
6. `T0B-09_seeds` #1: `db/meta/permissions.yaml` lacks `billing.account.*`, `billing.account_entry.*`, `billing.cash_transfer.*`, `billing.expense.manage`, `sync.*`, `partners.sales.*` that seeds 001 (g_permissions) now contain. Update the yaml or the seed (C4/C13/C0-0B).
7. C9-T20 view test: `col_type_is(schema, view, col, type)` with 4 args binds to the (table, column, type, description) overload. Verified: with a 5th description argument all 19 pass.
```diff
diff --git a/db/tests/views/C9-T20.v_pub_qc_summary.test.sql b/db/tests/views/C9-T20.v_pub_qc_summary.test.sql
index 5bed6b0..ca8bf0f 100644
--- a/db/tests/views/C9-T20.v_pub_qc_summary.test.sql
+++ b/db/tests/views/C9-T20.v_pub_qc_summary.test.sql
@@ -10,11 +10,11 @@ SELECT * FROM no_plan();
 SELECT has_view('quality', 'v_pub_qc_summary', 'the published view exists');
 SELECT columns_are('quality', 'v_pub_qc_summary', ARRAY['tenant_id','instrument_id','analyte_id','business_date','runs','accepted_runs','rejected_runs','warnings','last_in_control_run_at'],
   'AC-15.1 exactly the 03-IC §6.7 columns (no more, no fewer)');
-SELECT col_type_is('quality', 'v_pub_qc_summary', 'tenant_id', 'uuid'); SELECT col_type_is('quality', 'v_pub_qc_summary', 'instrument_id', 'uuid'); SELECT col_type_is('quality', 'v_pub_qc_summary', 'analyte_id', 'uuid');
-SELECT col_type_is('quality', 'v_pub_qc_summary', 'business_date', 'date');
-SELECT col_type_is('quality', 'v_pub_qc_summary', 'runs', 'bigint'); SELECT col_type_is('quality', 'v_pub_qc_summary', 'accepted_runs', 'bigint');
-SELECT col_type_is('quality', 'v_pub_qc_summary', 'rejected_runs', 'bigint'); SELECT col_type_is('quality', 'v_pub_qc_summary', 'warnings', 'bigint');
-SELECT col_type_is('quality', 'v_pub_qc_summary', 'last_in_control_run_at', 'timestamp with time zone');
+SELECT col_type_is('quality', 'v_pub_qc_summary', 'tenant_id', 'uuid', 'tenant_id is uuid'); SELECT col_type_is('quality', 'v_pub_qc_summary', 'instrument_id', 'uuid', 'instrument_id is uuid'); SELECT col_type_is('quality', 'v_pub_qc_summary', 'analyte_id', 'uuid', 'analyte_id is uuid');
+SELECT col_type_is('quality', 'v_pub_qc_summary', 'business_date', 'date', 'business_date is date');
+SELECT col_type_is('quality', 'v_pub_qc_summary', 'runs', 'bigint', 'runs is bigint'); SELECT col_type_is('quality', 'v_pub_qc_summary', 'accepted_runs', 'bigint', 'accepted_runs is bigint');
+SELECT col_type_is('quality', 'v_pub_qc_summary', 'rejected_runs', 'bigint', 'rejected_runs is bigint'); SELECT col_type_is('quality', 'v_pub_qc_summary', 'warnings', 'bigint', 'warnings is bigint');
+SELECT col_type_is('quality', 'v_pub_qc_summary', 'last_in_control_run_at', 'timestamp with time zone', 'last_in_control_run_at is timestamp with time zone');
 SELECT ok((SELECT coalesce(c.reloptions @> ARRAY['security_invoker=true'] OR c.reloptions @> ARRAY['security_invoker=on'], false)
              FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'quality' AND c.relname = 'v_pub_qc_summary'), 'REQ-SEC-031 security_invoker = true (S-20: the caller''s RLS applies)');
 SELECT ok(has_table_privilege('lims_app', 'quality.v_pub_qc_summary', 'SELECT'), 'lims_app may SELECT');
```
```diff
diff --git a/db/migrations/20261118050000_app__grant_uuidv7_to_service_roles.sql b/db/migrations/20261118050000_app__grant_uuidv7_to_service_roles.sql
new file mode 100644
index 0000000..dbda0c7
--- /dev/null
+++ b/db/migrations/20261118050000_app__grant_uuidv7_to_service_roles.sql
@@ -0,0 +1,5 @@
+-- NEPAL-pgtap-triage (C0-0B / C9): services/worker/src/jobs/quality/consumers/{lab.result.verified.v1,instruments.result.received.v1}.ts and
+-- services/api/src/modules/quality/repository/tat.repo.ts:134,162,237 call app.uuidv7() as lims_worker / lims_api, which hold no EXECUTE (permission denied at runtime;
+-- T0B-ASYNC-1_worker_grants #58/#59). The function is pure (no table access, SECURITY INVOKER). Alternative: change those three call sites to @lims/shared-ts uuidv7 (04 D9).
+SET LOCAL ROLE lims_owner;
+GRANT EXECUTE ON FUNCTION app.uuidv7() TO lims_api, lims_worker;
```

### C0-0A and C18 (db/bootstrap/00_roles.sql, migration_staging) - founder decision D-136

See (c) C2 above. Without the membership the loader role cannot read or write any staging table; with it, C18 RLS holds in every probe run here. Option A is what `T0B-13.C18_schema` #37/#38 assert; option B is least privilege. C18_behaviour then still needs its T5 fixture to set a `sub` claim (audit_context_missing at the first runs UPDATE).
```diff
diff --git a/db/bootstrap/00_roles.sql b/db/bootstrap/00_roles.sql
index 481380b..3eb0180 100644
--- a/db/bootstrap/00_roles.sql
+++ b/db/bootstrap/00_roles.sql
@@ -36,6 +36,9 @@ ALTER ROLE lims_api    SET search_path = '';                              -- eve
 ALTER ROLE lims_worker SET search_path = '';
 
 -- C18 loader role (LD-226; C18 05-SCHEMA s2 bootstrap part without the password and without the lims_app membership)
+-- D-136 (FOUNDER DECISION): the staging policies call app.current_tenant_id() / app.is_staff_or_system(), EXECUTE for lims_app only. Option A (what C18_schema #37/#38 assert):
+GRANT lims_app TO lims_migration WITH INHERIT TRUE, SET FALSE;
+-- Option B (least privilege, fails those two assertions): GRANT EXECUTE ON FUNCTION app.current_tenant_id(), app.is_staff_or_system() TO lims_migration;  -- in a migration, not bootstrap
 ALTER ROLE lims_migration SET search_path = '';
 ALTER ROLE lims_migration SET idle_in_transaction_session_timeout = '300s';   -- [CONV] dry-run transactions hold work between port calls
 ALTER ROLE lims_migration SET statement_timeout = '30min';                    -- [CONV] set-based validation on 10 M rows
```

### C2 (identity)

- **Platform writes to audited tenant rows fail closed** (PLATFORM-DDL-1_policies #105,113,115,117,135 + abort at line 193): `app.tg_row_audit` (db/migrations/20261105000600_audit__create_audit_tables.sql:41, db/policies/audit.sql:10) only admits the audit row when the row's tenant equals the claim tenant, or core.tenants. A platform actor has no tenant claim. Verified: with the policy change below a platform UPDATE of `identity.feature_flags` succeeds and is audited. Decision-gated (it lets platform context audit any tenant row; the row is still written only by the DEFINER trigger as lims_owner).
```diff
diff --git a/db/migrations/20261118040000_audit__platform_writes_audited.sql b/db/migrations/20261118040000_audit__platform_writes_audited.sql
new file mode 100644
index 0000000..c36e157
--- /dev/null
+++ b/db/migrations/20261118040000_audit__platform_writes_audited.sql
@@ -0,0 +1,10 @@
+-- NEPAL-pgtap-triage (C2 / C0-0B, DECISION-GATED): a platform actor (aal2 staff, no tenant claim) updating an audited per-tenant row (identity.feature_flags, support_sessions,
+-- ird_annex_records, tenant_settings) failed closed: app.tg_row_audit inserts audit_log under the row's tenant_id and audit_log__insert__owner_only only admitted core.tenants.
+-- Verified: platform UPDATE of identity.feature_flags succeeds afterwards and writes its audit row. db/policies/audit.sql carries the same text.
+SET LOCAL ROLE lims_owner;
+ALTER POLICY audit_log__insert__owner_only ON audit.audit_log WITH CHECK (
+     tenant_id = (SELECT app.current_tenant_id())
+  OR ((SELECT app.current_tenant_id()) IS NULL AND (SELECT app.is_platform_actor()))     -- 08 A12.5: platform context audits any tenant row under that row's tenant_id
+  OR ((SELECT app.current_actor_id()) IS NULL AND actor_id IS NULL AND actor_type = 'system'
+      AND nullif(current_setting('app.maintenance', true), '') IS NOT NULL
+      AND detail ->> 'maintenance' = current_setting('app.maintenance', true)));

diff --git a/db/policies/audit.sql b/db/policies/audit.sql
index e75f182..964c5c4 100644
--- a/db/policies/audit.sql
+++ b/db/policies/audit.sql
@@ -9,9 +9,7 @@ CREATE POLICY audit_log__select__tenant ON audit.audit_log FOR SELECT TO lims_ap
               OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));                        -- cast form (08 A28.6, A16.1)
 CREATE POLICY audit_log__insert__owner_only ON audit.audit_log FOR INSERT TO lims_owner
   WITH CHECK (tenant_id = (SELECT app.current_tenant_id())
-           OR ((SELECT app.current_tenant_id()) IS NULL                                   -- 08 A12.5: a core.tenants change in
-               AND schema_name = 'core' AND table_name = 'tenants' AND row_id = tenant_id  -- platform context, audited under the
-               AND (SELECT app.is_platform_actor()))                                      -- tenant row's own id
+           OR ((SELECT app.current_tenant_id()) IS NULL AND (SELECT app.is_platform_actor()))   -- 08 A12.5: platform context audits any tenant row under that row's tenant_id
            OR ((SELECT app.current_actor_id()) IS NULL                                    -- 08 A28.5: a row changed inside a
                AND actor_id IS NULL AND actor_type = 'system'                             -- maintenance DEFINER (no claims),
                AND nullif(current_setting('app.maintenance', true), '') IS NOT NULL       -- audited under the row's tenant_id
```
- **Fixture drift, fail closed** (all test-side): `T0B-06_definers:88` needs `gotrue_factor_id` and status `unverified` (not `pending`) and `support_sessions.platform_staff_id`; `AUTH-PLATFORM-SESSION-1_platform_reads:81` session 104 (`kind = platform`, no `platform_staff_id`) is now impossible (`sessions__kind_shape__ck`); `T0B-10.C2_lookups:141` reason code `admin_deactivate` is not in `memberships__deactivation_reason__ck` (use `other`; then 61/62 pass, the one left counts audit rows after the extra UPDATE); `T0B-10.C2_maintenance` #78 (`sessions__revoke__ck`), #90/#91 (DML inside `WITH` -> E0A000); `T0B-10.C2_schema` #2,555,591,680,681 count drift from migrations 20261115155000..192000 and 20261116010000.
- `AUTH-MFA-COMPLETE-1_platform_event` #75/#84: not a policy hole. `pg_temp.x` sets `app.pre_user_id` with `set_config(..., true)` in case 1 and never clears it, so case 2 ("no GUC set") runs with the GUC set. Verified: as lims_owner with the GUC empty the insert is refused (42501). Fix: `SELECT set_config('app.pre_user_id','',true)` before case 2.
- `T0B-08_contracts_helpers` #20: `platform_staff__select__platform` (20261115191000) intentionally lets an aal2 active platform session read the staff table; update the expectation.
- D4 above (`identity_login_context`).

### C3 (catalog)
`T0B-10.C3_schema` #1,216,1224,1230,1231: migrations 20261117170000 / 20261117200000 add 4 tables, 11 policies, 1 `catalog.tg_*` function, 1 lifecycle trigger, 3 audit triggers; update the expected counts (and 123 -> 134). Isolation files `catalog.*` (critical_limits, formula_dependencies, price_list_items, reference_ranges: `tg_parent_is_draft`; doctors, price_list_assignments, surcharge_rules, tax_rules: step-6 CHECK) are generator items (C0-0B section).

### C4 (frontdesk / billing)
- `T0B-10.C4_schema` #1,2,385,388,528,529,1597,1598,1637,1638,1658: 20 frontdesk and 31 billing relations now (test expects 14 and 25); own-row DELETE policies `registration_drafts__delete__owner`, `favourite_tests__delete__owner` are `TO lims_app` (tenant + staff + `user_id = current_membership_id()`), so the `__owner` suffix (reserved for `TO lims_owner`, AC-0B-2.2) is misleading: rename to `__own` when the test is updated. DELETE grants for lims_api/lims_worker follow from lims_app membership. Not a leak: another user's draft or favourite is not deletable.
- `T0C-REGPARITY-2` #299 fixture favourite belongs to another user; #340 policy count 141 vs 139 (before_state taken before the narrowing migration).

### C5 (lab)
`T0B-10.C5_schema` #942: 14 FKs into lab from later chunks exist. D2: lab.ingest_exceptions, order_readiness, order_tests, orders, qc_holds, worksheets have no BEFORE UPDATE guard (spec s7 does not list them).

### C6 (reporting)
`T0B-10.C6_schema` #243/#244: the event_inbox DELETE owner policy (maintenance GUC purge_event_inboxes, received_at < now() - 90 days, TO lims_owner) is not in the test's expected set. `reporting.settings` has no probe fixture row (C0-0B item 2).

### C7 (instruments)
`T0B-10.C7_schema` #169 (event_inbox), #284 (policies now carry `is_staff_or_system`; device is still admitted, so the "device writes the centre tables" intent holds), #670 (14 later FKs into instruments). `T0B-10.C7_behaviour` #292/#293: the test role has no grant on `agent_credentials` -> E42501 (closed) instead of immutable_row: run the assertion as the role that holds UPDATE.

### C9 (quality)
- `T0B-13.C9_behaviour` #164/#165: `pg_temp.x(..., 'UPDATE ...')` and the INSERT assertion run in count mode ('n') -> E42601, so the non-staff UPDATE/INSERT checks never executed. One-argument fix (verified on the C15 and C14 copies: the assertions then pass for partner/portal/patient). #248,250,256,257,272-276: fixture rows without FK parents (RI is re-checked on UPDATE for rows inserted in the same transaction): insert the parents (lots, instruments, source rows) the FKs name. #166: D1.
```diff
diff --git a/db/tests/quality/T0B-13.C9_behaviour.test.sql b/db/tests/quality/T0B-13.C9_behaviour.test.sql
index ad0beca..e8d496e 100644
--- a/db/tests/quality/T0B-13.C9_behaviour.test.sql
+++ b/db/tests/quality/T0B-13.C9_behaviour.test.sql
@@ -133,8 +133,8 @@ SELECT matches(pg_temp.ua(pg_temp.m('a50a'), 'INSERT INTO quality.tat_alert_acks
 
 -- C9 check 11: non-staff actors (AC-0B-3.6) and fail-closed without claims (AC-0B-3.7)
 SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), k.t, pg_temp.m('a500')), 'SELECT 1 FROM ' || tt.q, 'n'), 'n=0', 'C9 check 11 / AC-0B-3.6: ' || k.t || ' actor sees 0 rows of ' || tt.q) FROM tt CROSS JOIN (VALUES ('partner'),('portal'),('patient')) k(t);
-SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'portal', pg_temp.m('a500')), 'UPDATE quality.qc_plans SET status = ''inactive'''), 'n=0', 'C9 check 11 / AC-0B-3.6: a portal actor updates 0 plans');
-SELECT matches(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'partner', pg_temp.m('a500')), 'INSERT INTO quality.sync_state (id, tenant_id, qc_cursor_at) VALUES (' || quote_literal(pg_temp.uid(903)) || ', ' || quote_literal(pg_temp.ta()) || ', now())'), '^E42501\|', 'C9 check 11 / AC-0B-3.6: a partner actor cannot INSERT');
+SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'portal', pg_temp.m('a500')), 'UPDATE quality.qc_plans SET status = ''inactive''', 'w'), 'n=0', 'C9 check 11 / AC-0B-3.6: a portal actor updates 0 plans');
+SELECT matches(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'partner', pg_temp.m('a500')), 'INSERT INTO quality.sync_state (id, tenant_id, qc_cursor_at) VALUES (' || quote_literal(pg_temp.uid(903)) || ', ' || quote_literal(pg_temp.ta()) || ', now())', 'w'), '^E42501\|', 'C9 check 11 / AC-0B-3.6: a partner actor cannot INSERT');
 SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), 'device'), 'SELECT 1 FROM quality.qc_plans', 'n'), 'n=0', 'C9 check 11: a device actor is not staff and sees 0 plans');
 SELECT is(pg_temp.x('lims_api', NULL, 'SELECT 1 FROM ' || q, 'n'), 'n=0', 'C9 check 11 / AC-0B-3.7: no claims -> lims_api sees 0 rows of ' || q) FROM tt;
 SELECT is(pg_temp.x('lims_api', '{}'::jsonb, 'SELECT 1 FROM ' || q, 'n'), 'n=0', 'C9 check 11 / AC-0B-3.7: empty claims -> 0 rows of ' || q) FROM tt;
```
- `T0B-13.C9_schema` #114 and `views/C9-T20` (C0-0B item 7).
- D2: `quality.qc_runs` has the bespoke `enforce_run_frozen`; no gap.

### C10 (micro)
`T0B-13.C10_behaviour`: #233/#234 same 'n'-mode fix as C9 (lines 155 and 156-157); #350,359,385,387: fixture rows lacking their FK parents (orders, instruments, specimens) (cultures__order__fk, instrument_records__instrument__fk, specimen_isolate_counters__specimen__fk); #360-363,384,386 are cascades (the culture never reached `amending`, so child INSERT/UPDATE hit micro.tg_child_final_lock and no audit row was written). `T0B-13.C10_schema` #186 event_inbox.

### C11 (anatomic)
`T0B-13.C11_behaviour`: #149-201 D1; #266/#267 'n'-mode (lines 162 and 163-164); #432 `lims_analytics` has `GRANT SELECT` on `anatomic.v_pub_report_content` (migration line 834) but the view is `security_invoker=true` and lims_analytics holds no grant on `anatomic.item_submissions` etc.: "permission denied for table item_submissions" (verified). Closed; the analytics consumer cannot use the view. Grant SELECT on the underlying columns to lims_analytics, or make it a definer view (C8/C11 decision). `T0B-13.C11_schema` #140 event_inbox. D2: 8 anatomic tables without guard.

### C12 (inventory)
`T0B-13.C12_behaviour` #175/#176 ('n' mode, lines 120 and 121-122), #327 (line 203: DELETE passed through the count wrapper; the policy `alerts__delete__tenant` already requires `actor_type = 'system'`, so a device cannot purge). `T0B-13.C12_schema` #153 (event_inbox), #753 (compare `proconfig::text` with `{"search_path=\"\""}`).

### C13 (partners)
- `T0B-13.C13_schema` #1,33,72,74,75,80,246,250,253,280,281: expected sets predate migration 20261117210000 (party_sales_assignment, sales hierarchy functions, 4 triggers, 12 policies) and event_inbox; #246 `proacl::text LIKE '%=X/%'` matches `lims_owner=X/lims_owner`; real ACL is `{lims_owner=X/lims_owner,lims_worker=X/lims_owner}`: use `~ '(^\{|,)=X/'`.
- `T0B-13.C13_behaviour` aborts at line 73 (fixture inserts a tenant B row under tenant A claims; the audit trigger refuses). Verified green (130/132, the 2 audit counts differ only because fixtures skipped the trigger) when the fixture block runs under `session_replication_role = replica`; partner policies behave as the spec says. Isolation: the 8 org-wide step-9 files are in NEPAL-leak-C13-partners.md; `partners.manifest_lines` also needs the guard-code allowance (C0-0B item 1).

### C14 (smartreport)
- D3 migration, verified (357, 370, 373 pass afterwards):
```diff
diff --git a/db/migrations/20261118020000_smartreport__make_checks_null_safe.sql b/db/migrations/20261118020000_smartreport__make_checks_null_safe.sql
new file mode 100644
index 0000000..df5400d
--- /dev/null
+++ b/db/migrations/20261118020000_smartreport__make_checks_null_safe.sql
@@ -0,0 +1,14 @@
+-- NEPAL-pgtap-triage (C14): three CHECKs evaluated to NULL (= pass) for NULL inputs. Same predicates, NULL made explicit. Verified against the probe fixture rows.
+SET LOCAL ROLE lims_owner;
+ALTER TABLE smartreport.rules DROP CONSTRAINT rules__followup_fields__ck;
+ALTER TABLE smartreport.rules ADD CONSTRAINT rules__followup_fields__ck CHECK (
+     (rule_kind = 'followup' AND suggested_test_id IS NOT NULL AND interval_days IS NOT NULL AND interval_days BETWEEN 1 AND 730)
+  OR (rule_kind <> 'followup' AND suggested_test_id IS NULL AND interval_days IS NULL));
+ALTER TABLE smartreport.summaries DROP CONSTRAINT summaries__score__ck;
+ALTER TABLE smartreport.summaries ADD CONSTRAINT summaries__score__ck CHECK (
+     (health_score_value IS NULL AND health_score_band IS NULL)
+  OR (health_score_value IS NOT NULL AND health_score_band IS NOT NULL AND health_score_value BETWEEN 0 AND 100
+      AND health_score_band IN ('good','fair','needs_attention')));
+ALTER TABLE smartreport.library_versions DROP CONSTRAINT library_versions__hash__ck;
+ALTER TABLE smartreport.library_versions ADD CONSTRAINT library_versions__hash__ck CHECK (
+  status = 'draft' OR (content_sha256 IS NOT NULL AND content_sha256 ~ '^[0-9a-f]{64}$'));
```
- `T0B-13.C14_behaviour` #181-184: line 169 needs the `'w'` mode (verified: after it all four pass, including device, which D-109 excludes).
- `T0B-13.C14_schema` #70: event_inbox DELETE policy.

### C15 (payments)
- Test patch (fixture parents + UPDATE mode), verified: with it and the two migrations below the C15 behaviour file is 518/518:
```diff
diff --git a/db/tests/payments/T0B-13.C15_behaviour.test.sql b/db/tests/payments/T0B-13.C15_behaviour.test.sql
index b856fa5..90deb8b 100644
--- a/db/tests/payments/T0B-13.C15_behaviour.test.sql
+++ b/db/tests/payments/T0B-13.C15_behaviour.test.sql
@@ -170,7 +170,7 @@ SELECT matches(pg_temp.sa('UPDATE payments.g_cs_reasons SET is_active = false'),
 -- C15 test 2 (reads): staff-actor guard (AC-0B-3.6, 08 A17 P-16): partner, portal, patient (and device) claims of the same tenant read 0 rows of every payments tenant table; user and system see their rows
 SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), k.t, pg_temp.m('a500')), 'SELECT 1 FROM ' || tt.q, 'n'), 'n=0', 'C15 test 2 / AC-0B-3.6: ' || k.t || ' actor sees 0 rows of ' || tt.q) FROM tt CROSS JOIN (VALUES ('partner'),('portal'),('patient'),('device')) k(t);
 SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), k.t, pg_temp.m('a500')), 'SELECT 1 FROM ' || tt.q, 'n') ~ '^n=[1-9]', true, 'C15 test 2: ' || k.t || ' actor sees its rows of ' || tt.q) FROM tt CROSS JOIN (VALUES ('user'),('system')) k(t);
-SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), k.t, pg_temp.m('a500')), 'UPDATE payments.merchant_accounts SET updated_by = updated_by'), 'n=0', 'C15 test 2 / AC-0B-3.6: a ' || k.t || ' actor updates 0 merchant accounts') FROM (VALUES ('partner'),('portal'),('patient'),('device')) k(t);
+SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), k.t, pg_temp.m('a500')), 'UPDATE payments.merchant_accounts SET updated_by = updated_by', 'w'), 'n=0', 'C15 test 2 / AC-0B-3.6: a ' || k.t || ' actor updates 0 merchant accounts') FROM (VALUES ('partner'),('portal'),('patient'),('device')) k(t);
 SELECT is(pg_temp.x('lims_app', pg_temp.cl(pg_temp.ta(), k.t, pg_temp.m('a500')), 'SELECT 1 FROM ' || tg.q, 'n'), 'n=55', 'C15 test 2 / AC-0B-3.5: global coded set stays readable for a ' || k.t || ' claim (no tenant data)') FROM tg CROSS JOIN (VALUES ('partner'),('portal'),('patient')) k(t);
 -- AC-0B-3.7: no claims / empty claims fail closed
 SELECT is(pg_temp.x('lims_api', NULL, 'SELECT 1 FROM ' || q, 'n'), 'n=0', 'C15 test 2 / AC-0B-3.7: no claims -> lims_api sees 0 rows of ' || q) FROM tt;
@@ -311,8 +311,14 @@ CREATE TEMP TABLE rpair AS SELECT row_number() OVER (ORDER BY a.s, b.s)::int AS
 SELECT is((SELECT count(*)::int FROM ipair), 72, 'C15 test 4: 72 ordered intent status pairs'); SELECT is((SELECT count(*)::int FROM ipair WHERE ok), 18, 'C15 test 4: 18 allowed intent transitions');
 SELECT is((SELECT count(*)::int FROM rpair), 42, 'C15 test 5: 42 ordered refund status pairs'); SELECT is((SELECT count(*)::int FROM rpair WHERE ok), 8, 'C15 test 5: 8 allowed refund transitions');
 SET LOCAL session_replication_role = replica;
+-- parents of the pair rows (RI is re-checked on UPDATE for rows inserted in the same transaction, so every FK target must exist): one order per intent (82000 + n),
+-- one order (85000 + n) and one parent intent (84000 + n) per refund
+SELECT pg_temp.ins('frontdesk.orders', jsonb_build_object('id', pg_temp.uid(o.k), 'tenant_id', pg_temp.ta(), 'branch_id', pg_temp.id('00000000a101'), 'centre_id', pg_temp.id('00000000a201'), 'patient_id', pg_temp.uid(2201), 'registration_no', 'R-' || o.k, 'status', 'registered',
+    'visit_type', 'opd', 'billing_mode', 'cash', 'priority', 'routine', 'collection_mode', 'walk_in', 'source', 'front_desk', 'is_first_order_of_patient', true, 'catalog_revision', 1, 'registered_at', now()))
+  FROM (SELECT 82000 + n AS k FROM ipair UNION ALL SELECT 85000 + n FROM rpair) o;
 SELECT pg_temp.ins('payments.intents', pg_temp.ib(81000 + n, pg_temp.ta(), 82000 + n, 'khalti', f)) FROM ipair;
-SELECT pg_temp.ins('payments.refunds', pg_temp.rb(83000 + n, pg_temp.ta(), 84000 + n, 82000 + n, 'khalti', 'manual', f)) FROM rpair;
+SELECT pg_temp.ins('payments.intents', pg_temp.ib(84000 + n, pg_temp.ta(), 85000 + n, 'khalti', 'settled')) FROM rpair;
+SELECT pg_temp.ins('payments.refunds', pg_temp.rb(83000 + n, pg_temp.ta(), 84000 + n, 85000 + n, 'khalti', 'manual', f)) FROM rpair;
 SET LOCAL session_replication_role = origin;
 
 -- C15 test 4: every allowed and every forbidden intent pair (AC-0B-4.1; §10 test 4): allowed -> one row updated; forbidden -> P0001 invalid_transition (the supporting columns of the target status are always set, so only the guard can fail)
```
- Real schema defect, fails closed: `static_qr_reconciliations` has `difference_paisa ... GENERATED ALWAYS AS (...) STORED` (migration `20261115150000_payments__create_payments_schema.sql:357`) and `static_qr__mutable_columns` (`:376-377`) does not list it; in a BEFORE UPDATE trigger NEW holds the uncomputed value, so every UPDATE (incl. `is_active`) raises `immutable_row` (verified by direct UPDATE). It is the only generated column under `enforce_mutable_columns` in the database.
```diff
diff --git a/db/migrations/20261118010000_payments__fix_static_qr_mutable_columns.sql b/db/migrations/20261118010000_payments__fix_static_qr_mutable_columns.sql
new file mode 100644
index 0000000..51e9d8e
--- /dev/null
+++ b/db/migrations/20261118010000_payments__fix_static_qr_mutable_columns.sql
@@ -0,0 +1,6 @@
+-- NEPAL-pgtap-triage (C15): payments.static_qr_reconciliations.difference_paisa is a STORED generated column; in a BEFORE UPDATE trigger NEW carries it uncomputed,
+-- so app.enforce_mutable_columns saw it "change" on every UPDATE and raised immutable_row even for is_active. Add it to the mutable list (it is derived, never written).
+SET LOCAL ROLE lims_owner;
+DROP TRIGGER static_qr__mutable_columns ON payments.static_qr_reconciliations;
+CREATE TRIGGER static_qr__mutable_columns BEFORE UPDATE ON payments.static_qr_reconciliations FOR EACH ROW
+  EXECUTE FUNCTION app.enforce_mutable_columns('is_active','updated_at','updated_by','version','difference_paisa');   -- worksheets are not edited
```
- D1 option B (decision-gated, tested):
```diff
diff --git a/db/migrations/20261118030000_payments__exclude_device_actor.sql b/db/migrations/20261118030000_payments__exclude_device_actor.sql
new file mode 100644
index 0000000..83a09e6
--- /dev/null
+++ b/db/migrations/20261118030000_payments__exclude_device_actor.sql
@@ -0,0 +1,17 @@
+-- NEPAL-pgtap-triage D1 option B (DECISION-GATED, 08 A19.1 / D-109): payments policies admit only user and system actors (device excluded), like smartreport.*.
+-- Keeps (SELECT app.is_staff_or_system()) in every policy (P-16 check-registry) and ANDs the positive list. Tested on the 11 tenant policies: device reads 0, user reads 1.
+-- db/policies/payments.sql must be regenerated from pg_policies (AC-0B-2.3).
+SET LOCAL ROLE lims_owner;
+DO $m$
+DECLARE p record; v_using text; v_check text;
+  h constant text := '( SELECT app.is_staff_or_system() AS is_staff_or_system)';
+  g constant text := h || ' AND (( SELECT app.current_actor_type() AS current_actor_type) = ANY (ARRAY[''user''::text, ''system''::text]))';
+BEGIN
+  FOR p IN SELECT schemaname, tablename, policyname, qual, with_check FROM pg_policies
+           WHERE schemaname = 'payments' AND 'lims_app' = ANY (roles::name[]) AND policyname ~ '__tenant$' LOOP
+    v_using := replace(p.qual, h, g);  v_check := replace(p.with_check, h, g);
+    EXECUTE format('ALTER POLICY %I ON %I.%I %s %s', p.policyname, p.schemaname, p.tablename,
+      CASE WHEN v_using IS NOT NULL THEN format('USING (%s)', v_using) ELSE '' END,
+      CASE WHEN v_check IS NOT NULL THEN format('WITH CHECK (%s)', v_check) ELSE '' END);
+  END LOOP;
+END $m$;
```
- `T0B-13.C15_schema` #68: event_inbox DELETE policy. D2: `payments.reconciliation_runs` has no BEFORE UPDATE guard.

### C16 (engagement)
`T-L2_redeem_link_code`: fixture rows (link_codes 601.., links 801..) point at patients that are not in frontdesk.patients; the DEFINER's UPDATE re-checks `link_codes__patient__fk` and `account_patient_links__patient__fk` (rows were inserted under replica in the same transaction) -> 14 reds; then line 126 `'another account\'s link ...'` is a psql syntax error (use `''`), so assertions 35+ never ran. The DEFINER `app.engagement_redeem_link_code` returns nothing unless `app.engagement_account_id()` is set, binds the code to the account's phone hmac and tenant: no guard gap found. `T-A2`, `T-Q3`, `T-OPS1`: `search_path=` literal -> `ARRAY['search_path=""']` (T-A2:55, T-Q3:67, T-OPS1:96-97); T-A2 #45-47 INSERT into number_counters without `created_by`; T-OPS1 #49,55,58 expectations are looser than the policies/grants. `T0B-13.C16_schema` and `T-SEC1`: drift and the g_cs_* class-G tables (no RLS by design, SELECT-only). The 5 ANY_T files are NEPAL-leak-C16-engagement.md.

### C17 (homecollection)
`T0B-13.C17_anonymise`: `visits__centre__fk` parent missing (same RI re-check), `search_path=` literal; `T0B-13.C17_schema`: collector_flags table, 11 audit triggers, regex false positive on `current_setting('app.maintenance', true)`, event_inbox GUC name; `homecollection.mutations` is NEPAL-leak-C17.

## Clean-up
Both scratch containers were removed; scratch files are under the session scratchpad only. Not run: the full suite after the patches (only the files named above, on scratch copies), `check-registry` against the proposed migrations, db/policies regeneration for the payments option.

Backward compatible? yes for every test/fixture/generator change; the migrations are additive or restrict (static_qr trigger, CHECKs: existing rows verified valid; payments device exclusion and audit policy are decision-gated; uuidv7 grant widens EXECUTE on a pure function).
Tenant/security impact: no RLS weakening proposed. Two proposals widen something on purpose and are decision-gated: lims_migration membership/EXECUTE (D-136) and the platform-context audit insert. D1 option B narrows payments policies. REQ-SEC-016/-031, 08 A12.7, A17 P-16, A19.1, D-109, LD-215, LD-257 cited above.
IRD/regulatory impact: none (payments gateway tables only gain a stricter actor list in D1 option B).
Alternatives considered: for D1 keep A19.1 and change the three suites; for D-136 option B (EXECUTE on two helpers); for uuidv7 change the three call sites instead of granting.
Tests that will prove it: the named files turn green; after the patches the scratch runs gave C15 behaviour 518/518, C14 behaviour all ok, C9-T20 19/19 ok, T0B-08_step9_fixed 1232/1232, 16/16 migration_staging probes and every regenerated guard/FK probe ok (with D-136 option A).
