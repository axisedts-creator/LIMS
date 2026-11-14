# Hand-offs from chunk fix passes (to apply in the final program-doc sync)

## From C3 (2026-11-06)
- 03-IC §4.2: add `@throws common.not_found` to getTest, getPanel, resolveOrderables, priceFor, referenceRangeFor, criticalLimitsFor.
- 03-IC §8: mark `catalog.import_invalid` `retired: true` (C3 never returns it).
- 01-CM §5.1: add `getTaxRate` to the CatalogPort method list.
- 02-CV §10.2: "Exception: C3 catalog import/export files in `catalog.files` (03-IC §13.4); scan via `ctx.files.scan`."
- 08 §3: register CR-C3-008 (C3→C0-0C: probe generator skips stub ops listed in `__tests__/probes/pending.json`; stubs return 503 `common.service_unavailable`; list empty at M6) — ACCEPT; CR-C3-009 (C3→C0-0A+C1: wire CI job and alert rules per P-14) — ACCEPT.
- D-16/D-17/D-18/D-19/D-21/P-6/P-9 program halves: already applied by the A13 program-doc agent (verify in final sync).

## From the 08 sync (2026-11-06)
- 08 §1 decision summary: recount from the §3 table (expected ACCEPT 139, ACCEPT-MODIFIED 56, DEFER 10; per-chunk rows C2, C3, C6, C12, C13, C15) — recount by script, do not hand-copy.
- 03 §7 `origins` and 08 §4.3 intro: remove `files: { env: LIMS_ORIGIN_FILES }` (A14.2).

## From C7 (2026-11-06)
- A16.1: fix 02-CV §5.8 template and grep ALL chunks for `ANY ((SELECT app.current_centre_ids()))` without `::uuid[]`; fix each.
- 03-IC §4.5 D-10 fields — verify present (A13 agent reported done).
- 03-IC §13.3 / 08 §4.7 purge signature `(integer)` and 07-BLOCKERS B15 — verify (A13 agent reported done).
- 03-IC §13.6 P-12 delete comment — verify.
- 03-IC §7 + 08 §4.3: add route `staff.lab.ingest_exceptions` (CR-C7-014); C5 TRD/UI note.
- 08 §3: register CR-C7-013, CR-C7-014 (ACCEPT).
- C1: nginx `/v1/instruments/agent/` 600 r/m burst 200 (D-43); wire `services/worker/src/jobs/instruments/alerts/instruments.rules.yml` (CR-C7-012); remove LIMS_ORIGIN_FILES (A14.2).

## From C5 (2026-11-06)
- Program halves of D-2/D-4/D-5/D-6/D-7/D-8/D-10/D-11/D-14/D-15: verify in 03/08 (A13 agent reported done); add A17.2 to 03-IC §4.5 getOrderItemProcessingState semantics.
- 03-IC §4.2: `RangeQuery.ageDays` optional + A17.1 semantics (C3 must implement).
- 02-CV §4.1: allow bulk bodies `items[{id,version}]` (CR-C5-011).
- C1 02-TRD §11.3: wire `services/worker/src/jobs/lab/ops/lab.rules.yml` (CR-C5-010).
- C2 TRD invite/role screens: provisioning warning (D-13).
- C4: "after 200, open staff.lab.order_labels…" text (D-4) — C4 fix pass.
- 08 §3: register CR-C5-010/011/012 (ACCEPT).
- C3: implement A17.1 (age-unrestricted rows when ageDays absent) — C3 second touch.

## From C4 (2026-11-06)
- 03-IC §4.15 BillingCommandPort: copy C4 TRD §6.3 (QuoteResult.baseFingerprint; throws comments incl. detail `fiscal_year_rollover`, `billing.numbering_pattern_invalid`; recordCreditCharges account-upsert doc; assertCreditAllowed allowsCredit/isActive; raiseCreditNoteRequirement periodic doc; contract cases 12–15).
- 03-IC §13.3 / 08 §4.7 / C0 definer-inventory: add `frontdesk.purge_trf_drafts(p_older_than interval, p_ids uuid[]) RETURNS integer` (owner lims_owner, EXECUTE lims_worker, search_path '', owner policies on trf_attachments gated by app.maintenance='frontdesk_purge_trf_drafts').
- C0 trigger inventory: tg_row_audit on frontdesk.patients with excluded columns full_name, name_search, birth_on, phone_e164, email, address_text (D-27a).
- C0 03-IC §13.6: `ctx.core.centres.list` return shape includes `phone_display`.
- C1/C0: staff-web CSP `img-src 'self' data:` (for PrintFrame embedded branding images) — ACCEPTED (A18.1).
- C2 TRD: D-23 grammar note; P-15 timezone Asia/Kathmandu only.
- C8: D-1 consumer note (periodic credit bills have no centre_id).
- C1: CR wiring C4 alert rules `services/worker/src/jobs/{billing,frontdesk}/alerts/*.yaml`; C0-0A: CI job `c04-copy-scan`.
- 03-IC §4.3 FrontdeskPort contract case (12): order_flags `booking_cancelled_after_registration` (A2.12).
- C0 seed: `patient.demographics_access` unused by C4 — keep (other users?) → verify in sweep; retire if no user.

## From C6 (2026-11-06)
- A16.1 cast also for `engagement_patient_ids()`.
- 03-IC §13.3 D-30 row: add reports/report_versions/deliveries `__select__owner_only` (for lims_reporting_lookup) and column grant `UPDATE (redeem_failures, updated_at, version) ON reporting.portal_links TO lims_reporting_lookup`.
- C0 audit inventory: no default tg_row_audit on reporting.portal_links (C6 own triggers).
- 03-IC §4.6 + C2: `readSignatureImage` (A21.2).
- 03-IC §11: radiologist += reporting.report.read.
- 08 §4.8 / 03-IC §13.4: reporting-inputs instrument-sanitized path.
- C15: add `<LIMS_ORIGIN_PORTAL>/r/payments/` to return-URL allowlist; replace DEFERRED text (TRD l.271, 555; PRD l.28, 65, 75, US-PG-11, l.214).
- C1: CR-C6-013 per D-32 (nginx 10 r/m only on /v/*; portal BFF key secret; alert-rules wiring).
- C0-0D: BFF key kind `portal`, app.client_ip (D-32); CR-C6-019 libs.
- C8: absolute staff URL for linkUrl (D-29); v_pub_delivery_daily per-status anchors.
- C6 second touch: A21.1 dues link + A21.4 GUC renames.

## From C10 (2026-11-06)
- D-61 program halves: 08 R1 seed `module_preliminary_update`; 03-IC §4.5 contract cases (35)(36) + §3.17 note. C5 seeds + guard (C5 second touch); C6 report-kind rule exclusion + label (C6 second touch or sweep).
- C2 TRD D-13 warning names `micro.culture.read`, `micro.culture.work`.
- 03-IC §11 / 08 §4.1: lab_manager += micro.culture.read (D-64).
- C0 TRD §6.8 / 08 §4.11: `MembershipRow` + widened `memberships.list` (D-47).
- 01-CM §6: C10 × C4 = `p`.
- C0 db/meta/tables.yaml: micro.specimen_isolate_counters and event_inbox mandatory-column exceptions (P-18b).
- C1: alert `increase(lims_micro_unmapped_received_total[1h]) > 0`.
- Lead: D-65 literal purge filter ACCEPTED (retention elapsed → evidence purge ok); M41/M43 permission [CONV] ACCEPTED.

## From C12 (2026-11-06)
- 03-IC §8 emission note → P-23 text naming C4 and C12 for `catalog.*`.
- 07-BLOCKERS B7 "Chunks affected" → "C4, C12 (`inventory.settings.vat_in_cost`, default true)" (D-57).
- 08 §3: CR-C12-011 (alert rules wiring) ACCEPT; C1 §11.3 intake row `services/worker/src/jobs/inventory/ops/inventory.rules.yml` (4 rules).
- 08 A7.6: clarifying note (stored column `tax_code NULL`; wire field `is_exempt`, D-70).
- Metric `lims_inventory_unresolved_oldest_age_seconds` (gauge) in C1 registry.
- Lead: D-75 narrowed scope ACCEPTED (only row-valued kinds return_to_store, adjust_in, count_adjust_in; source-valued kinds keep source value — consistent with AC-06.4). D-71 guard in tg_line_guard ACCEPTED; replace semantics ACCEPTED.

## From C14 (2026-11-06)
- 03-IC §4.3 heading + 01-CM §5.1: C14 += FrontdeskPort consumers (purpose `lab_display`); 01-CM §6 C14×C4 = `p`; C4 fake/contract suite adds C14; 08 §3 register CR-C14-009 ACCEPT.
- 03-IC §4.10: remove `smartreport.summary_not_ready` from buildSummary @throws (D-111).
- 02-CV §8.5 item 1 → D-119 text; 01-CM §5: SmartReportPort consumers = "C6".
- C0-0C: `getSmartLibraryCodedSet` (#35) in contracts/openapi/smartreport.yaml.
- CR-C14-010 (alert rules wiring `services/worker/src/jobs/smartreport/ops/smartreport.rules.yml`, 6 rules) ACCEPT; C1 intake row.
- C6: wrap buildSummary calls that catch smartreport.* errors in ctx.db.tx (savepoint, P-44) — C6 second touch / sweep.
- Lead A22.1: SR-02 history timeline — the existing staff getSummary response includes `reviews[]` (action, actor display name, reason code, at) from `summary_reviews`; no new endpoint. C14 small follow-up in sweep.
- Lead: C14 class-M soft delete (P-18a), 1–2000 limit + `no_eligible_results`/`too_many_results`, constraint rename — ACCEPTED.

## From C11 (2026-11-06)
- 03-IC §4.3: C10, C11 += FrontdeskPort consumers; 01-CM §6 C11 row: `p` under C4, `e` under C5.
- 03-IC §13.1 / 08 §4.4 / C0 seed: anatomic_case.view, anatomic_report.view, anatomic_image.view, anatomic_label.print, anatomic_object.lookup, anatomic_report.sign_out (D-53; verify not already added).
- 02-CV §10.2 + 08 A13 P-2 text: P-19 scan outcome rule; D-67 inline re-encoded image exception.
- C0 TRD §6.8 / 08 §4.11: MembershipRow + widened memberships.list (D-47) — also from C10.
- 03-IC §8: `anatomic.image_not_ready` retired.
- C0: confirm btree_gin + pg_trgm in DB image (else index exception for cs_diagnoses trigram index); db/meta/tables.yaml accession_counters exception; confirm anatomic.event_inbox policies in C0 §3.9.
- C2 D-13 warning: add anatomic.case.read/work/signout.
- Lead: C11 [CONV]s ACCEPTED (Alt shortcuts; supplementary_report on addendum_only; not_anatomic link rows; D-66 gap choices; no anonymisation hook in v1).

## From C18 (2026-11-06) — all deferred until B4 except where noted
- C3: confirm blank `_meta.tenant_catalog_revision` accepted in fresh price_list template (or C18 reads revision via CatalogPort after B4) — check in sweep.
- Deferred (record only): C18 in CatalogPort consumers; lims_migration EXECUTE on core_resolve_tenant_code/cron_tenant_ids; five schema exceptions; C4/C5/C6 CRs CR-C18-002/003/004.
- Lead: C18 [CONV] command/message names ACCEPTED (design-only).

## From C9 (2026-11-06)
- 01-CM §6 row C9: C5 `e,v`, C6 `e,v` (incl. reporting.v_pub_order_report_tat), C7 `e,v`; drop `p` under C5 (C9 provides QualityPort).
- 01-CM §3: map `apps/web/tests/e2e/<module>/` to module owner.
- 03-IC §13.1 / 08 §4.4 / C0 seed: autoverify_decision.view, autoverify_simulation.view (D-53).
- 07-BLOCKERS: B14 "Chunks affected" per D-57; B15 += C9.
- 08 §3: CR-C9-008 (alert wiring `services/worker/src/jobs/quality/ops/quality.rules.yml`) ACCEPT; C1 intake row.
- Deferred CR: C9 class-A purge DEFINER (no row eligible < 5 years) — later CR, recorded in C9 06 §6.
- 06-GLOSSARY Westgard lines 176–179 → point to D-58 (N=3, 8x, 12x DECISION/UNVERIFIED).
- Lead: D-59 third value `specimen_received_at` ACCEPTED; D-55 `stopped` in terminal list ACCEPTED; m#27 no auto-retry ACCEPTED; TAT purge skips rows with class-A children ACCEPTED.

## From C13 (2026-11-06)
- 08 §4.7 / 03-IC §13.3 / C0 definer-inventory: `partners.redact_lines(uuid, timestamptz)` (owner lims_owner, EXECUTE lims_worker, app.maintenance='partners_redact_lines', tenant-bound, source C13); note owner policies on app.current_partner_id().
- 03-IC §4.6 + C2: updatePartnerMembership `expectedVersion?` optional + JSDoc; C2 contract case (13) (D-100).
- 03-IC §11 / 08 §4.1 / C2 TRD §5.2: partner_member += identity.self.manage; C2 accepts session kind `partner` on self-service ops (D-101).
- 02-CV §6 / 08 R10 / C0 TRD LIMS_CORE_BFF_KEY_FILES adds `portal`; C1 secret inventory lists three BFF key names (P-45).
- C0 / 08 §4.6: drop `QrCode` component row unless another chunk uses it (C16 LimsQrCode is Flutter — separate) — check.
- C5 SCH §10 / 03-IC §6.3 / 08 §4.9: lab.v_pub_specimen_timeline += replaces_specimen_id, specimen_version (CR-C16-022, D-106) — C5 second touch.
- C0 / 08 §4.8 partners-slips: "write-once per successful issue; a retry before the row is `issued` may replace (upsert)".
- 01-CM §5.1 RenderPort consumers += C13; §6 row C13: `v` under C3, C4, C5.
- 02-CV §8.5 item 1 → D-119 text **plus** (lead A22.2) the partner-admin port writes `IdentityPort.provisionPartnerMembership` / `updatePartnerMembership` (CR-C13-003) as allowed non-staff calls.
- Lead: C13 P-16 handling for shared-with-partner tables ACCEPTED; partner_referrers column set ACCEPTED; m#30 option 2 ACCEPTED.

## From C15 (2026-11-06)
- C1: CR-C15-008 items (1)–(6) verbatim (public payment nginx locations, token-path log masking, egress allowlist, SOPS KEK file, alert routing) + `LIMS_FRONTDESK_PAYMENT_RESULT_URL`.
- C4 (CR-C15-016): B12 returnUrl=cancelUrl=${LIMS_FRONTDESK_PAYMENT_RESULT_URL} (new config key); form_post dialog QR of launchUrl + "Open on this PC"; Cancel payment → C15 P5 + P24b via staff BFF; B12 x-error-codes += payments.amount_not_supported, payments.return_url_not_allowed. (C4 second touch in sweep.)
- 03-IC §4.3 heading + 01-CM §5.1: FrontdeskPort consumers = C5, C6, C10, C11, C13, C14, C15, C16, C17; 01-CM §6 row C15: `p`,`v` under C4 + C1 dep; C4 fake/contract adds C15 (CR-C15-014 ACCEPT).
- 03-IC §4.9 verify JSDoc: eSewa PENDING/NOT_FOUND and Khalti Initiated before expires_at+grace non-terminal (case 5); §4.9 "Tenant context" → D-115 text.
- research/04 P3/P4 Source cells: "re-read 2026-11-06; details and open points in C15 02-TRD §0 (V1–V15)" (D-117).
- 08 §4.7 / 03-IC §13.3: C15 DEFINER row names policy + `app.pre_payments_callback_token_sha256`.
- 03-IC routes/OpenAPI: P7b recheckPaymentRefund, P11b failManualPaymentRefund, P24b listPaymentCancelReasons; coded set payments.refund_fail_reasons.
- C6: portal payment worker uses createIntent/getIntent as reporting system actor; return URL <PORTAL>/r/payments/{id}/done; no event-only ledger expectation (D-115) — verify in C6 second touch.
- C15 itself: A22.4 gauges + alert table (sweep).

## From C6 second pass (2026-11-06)
- Lead: `url` param on `reporting.dues_due`, path `/r/{token}/dues`, P5 dues-link rule, C6 `app.pre_*` names, and the `provider_events__select__lookup` policy + GRANT SELECT fix — ACCEPTED.
- 08 §4.10 / 03-IC §4.8: template `reporting.dues_due` (purpose dues_reminder; params lab_name, amount_text short_text, url) ; 03-IC §7: portal route `/r/{token}/dues` + API P7 `GET /portal/dues`; 03-IC §13.3/08 §4.7: C6 DEFINER rows with new GUC names and the provider_events lookup policy.

## From C8 (2026-11-06)
- 03-IC §7 / 08 §4.3: route `staff.analytics.collections` `/analytics/collections` permission analytics.collections.read owner C8 (D-46).
- C0 TRD §6.8 / 08 §4.11: MembershipRow + widened memberships.list (D-47) — third request.
- C0-0C: contracts/render/analytics.report.schema.json from C8 TRD §10.2 step 6a; #30 in analytics.yaml.
- C6: v_pub_delivery_daily += centre_id, group by it; always set delivery_created_at (D-48). 03-IC §3.18 += delivery_created_at; §6.4 note "business_date = delivery creation date".
- 03-IC §4.8: requiredPermission sentence → "C8 always sends analytics.dashboard.read (08 A7.6); per-report permissions only filter pack content".
- 03-IC §6 header P-15; §6.2 / 08 §4.9 v_pub_credit_party_statement consumers = C13 (D-51).
- C4: publish B26 getCreditNoteRegister row shape (field `net`).
- 08 §3: CR-C8-015 ACCEPT (alert rules `services/worker/src/jobs/analytics/ops/analytics.rules.yml`; CI job `c8-no-commission`).
- C0-0B: C8 mandatory-column exceptions → db/meta/tables.yaml.
- Lead: exports metadata purge by requested_at < now()−400d ACCEPTED; report_run_recipients id + schedule_id (recursion fix) ACCEPTED; other C8 [CONV]s ACCEPTED.

## From C17 (2026-11-06)
- 08 §4.7 / 03-IC §13.3: `app.homecollection_anonymise_retired_visits(timestamptz)` (owner lims_owner, EXECUTE lims_worker, app.maintenance='homecollection_anonymise_retired_visits' + tenant claim; policies visits__select/update__owner_only, handover_items__select/update__owner_only).
- 03-IC §3.23: optional booking_id (if/then on visit kind) + C16 consumer; §3.25 row 23 += C16 (D-120). C4/C5 tolerate booking_id (note).
- 08 §3: CR-C17-014 ACCEPT; C6 seeds `homecollection.visit_scheduled` (purpose booking_confirmation, SMS, patient; window_start_local, window_end_local short_text); 03-IC §4.8 + 08 §4.10 template lists.
- C4: collection.synced consumer never dead-letters on tenant-inactive payment method → finance review item (D-128).
- C1: wire `services/worker/src/jobs/homecollection/alerts.yaml` (5 rules); C0-0A: CI jobs c17-no-bad-cert-callback, c17-db-forensics, c17-release-binary-scan.
- C0-0B transcription notes: visits transition-guard maintenance exception; handover_items mutable_columns WHEN clause; mutations__batch__fk DEFERRABLE INITIALLY DEFERRED; generate homecollection.event_inbox.
- Lead: C17 extra fixes and [CONV]s ACCEPTED (sync_batches insert-last; lookupSpecimens({orderId}); 'ANONYMISED' placeholder; route_full; device re-registration reset).

## From C16 (2026-11-06)
- 03-IC §3.24: cancelled-event trigger "from `confirmed` or `checked_in`".
- 01-CM §5.1: SmartReportPort consumers = "C6" (also from C14).
- C0 05-SCHEMA l.313 + 03-IC §13.3 + 08 §4.7: replace C16 inventory with C16 05 §6.6 — add app.engagement_apply_report_link(uuid, timestamptz), engagement.purge_payment_requests(), engagement.purge_queue(); engagement_redeem_link_code(bytea); remove app.engagement_resolve_tenant_code (→ app.core_resolve_tenant_code, D-121).
- 03-IC §3.23: C16 consumer (D-120) — also from C17.
- C6: CR-C16-008 policy must use `patient_id = ANY ((SELECT app.engagement_patient_ids())::uuid[])` — verify C6 applied.
- C0 A19.1 device probe: exempt `getQueueBoard` (queue-display device actor).
- C2: note on CR-C16-004 — account id = challenge id; provisioning idempotent per accountId.
- Lead A24.1: C16 M1b staff validation of price_list_id → new additive `CatalogPort.getPriceListStatus(ctx: RequestContext, input: { priceListId: Uuidv7 }): Promise<{ priceListId: Uuidv7; isActive: boolean; status: 'draft'|'published'|'superseded'|'retired' }>` (throws common.not_found), C3 implements, C16 consumer (CR-C16-023). No view read in request handlers (R25/P-21).
- Lead: C16 [CONV]s ACCEPTED; purge_by_retention deferred to post-B15 CR ACCEPTED; non-standard policy scope names to be normalised in sweep only if trivial (otherwise documented).

## FINAL CHECK list (after all sweeps)
- C4 05-SCHEMA: DDL references guard trigger functions it never defines + one forward reference + a template block that doesn't load — define the functions (spec already describes behaviour), fix ordering; load cleanly on PG16.
- C5 05-SCHEMA: `lab.v_return_reasons` comment-only definition — write it or remove references.
- P-60: every chunk 02-TRD gets an "Addenda applied" table A1–A25 (applied / not applicable) — mechanical.
- Program docs: getPriceListStatus status set {draft,published,superseded,discarded} with C3's derived rule; result flag `range_unavailable_age_unknown` (C5) in 03-IC §4.5 / glossary; finance review kind `home_payment_method_inactive` (C4) in 03-IC if listed; C1 finance alert receiver optional (payments alerts → ops-digest-email).
- Repo-wide greps: uncast centre predicate; `422 common.validation_failed`; `LIMS_ORIGIN_FILES`; `analytics.report.read`; `PortCtx`; `signedUrl` in responses; `x-permission-by-`; `app.lookup_`; superseded names.
- Load every chunk's 05-SCHEMA SQL in dependency order on one PG16 (C0 first) as a smoke test where feasible; report remaining errors per chunk.

## From C1 (2026-11-06) → final check
- C1 apply A27.2 (lims-ratelimit excludes agent/otp/psession zones; ACs adjusted).
- C6 apply A27.3 (worker re-exports renderer /internal/metrics; LIMS_RENDER_SANDBOX_TOKEN_FILE).
- C0: LIMS_CORE_REDIS_URL_FILE, LIMS_CORE_SCANNER_URL / _TIMEOUT_MS, LIMS_CORE_TRUSTED_PROXY_CIDRS, `portal` in LIMS_CORE_BFF_KEY_FILES, devstack reads UPSTREAM.lock + CI digest check (D-208) — verify C0 fix pass did these.
- 01-CM §3 note: C0 reads C1 UPSTREAM.lock — verify.
- 08 §3 CR-C1-005 notes (D-204) — verify done by program sweep.

## From C2 (2026-11-06) → final check
- Apply A28 in C0 (partner_role column; tg_row_audit maintenance branch; audit/access log indexes + centre clause) and C2 (A28.1 platform auth DEFINERs + __platform policies; A28.2 withTenantScope; A28.4 notify_ip_throttle).
- 03-IC §4.6 / 01-CM §5.1: IdentityPort methods list += getStaffNotificationContact, readSignatureImage; readSignatureImage returns SignatureImageContent (A26.1).
- 08 §4.7 / 03-IC §13.3: C2 maintenance rows (identity_purge_sessions, identity_expire_*, identity_load_breached_batch, identity_finish_breached_import, notify_ip_throttle, platform_auth_write_*).
- index-exceptions: auth_events__occurred_at__idx; tables.yaml class/shared_with changes; 08 §3 CR-C2-019.

## From C0 (2026-11-06) → final check
- 03-IC §12: request_sha256 bytea(32); idempotency_keys.tenant_id NULLable + UNIQUE NULLS NOT DISTINCT (D-213); dead_letters.job_key.
- 02-CV §5.8: scope `portal`.
- 03-IC §13.3 / 08 §4.7: identity_tenants_for_email_hmacs, core_resolve_tenant_code rows; dl_insert_platform 8 args (p_job_key); dl_resolve returns job_key; purges return (OUT deleted, OUT capped); queue_depth returns TABLE(task_identifier, ready, locked, failed); engagement_preauth_stage → INVOKER list.
- 08 R10 item 4: D-214 operationIds + A28.2 port writes.
- C1: alert lims_core_retention_purge_capped_total > 0 for 3 days; LIMS_CORE_TRUSTED_PROXY_CIDRS, scanner keys, LIMS_CORE_STORAGE_KEY_FILE secret; auditstore drift check for audit_log.detail + nullable actor_id/created_by.
- C2: identity_tenants_for_email_hmacs text equals C0's; stop creating current_lims_session_id(); update §3.2 mirror; A28.1/A28.4 function names → C0 inventory.
- C6: lims_reporting_lookup migration uses D-201 grant-then-revoke CREATE window.
- C8, C10, C11: list mandatory-column exceptions in own 05-SCHEMA §1 (verify).
- 01-CM §3: C0 reads C1 UPSTREAM.lock.
- Seeds: A29.1 (C0 02-TRD §4.6 fix).

## For the final verification agent
- C0 05-SCHEMA §4.3 inventory + db/meta definer-inventory text: add C2's A28.1 functions app.identity_platform_auth_write_session_insert / _session_update / _mfa_factor / _invitation_accept / _staff_login (EXECUTE lims_api) and A28.4 app.identity_notify_ip_throttle_hmacs(inet, timestamptz) (EXECUTE lims_worker), names exactly as in C2 05-SCHEMA §10.3; C0 "translates verbatim".
- 08 R10 item 4: A28.2 entries (verify program agent did it).
