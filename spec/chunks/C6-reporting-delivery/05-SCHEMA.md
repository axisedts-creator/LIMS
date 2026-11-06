# C6 Reporting & Delivery — 05 Schema (`reporting`)

Status: DECISION, 2026-11-06. This is the specification C0-0B transcribes into `db/migrations/*_reporting__*.sql` and `db/policies/reporting.sql` (C0 05-SCHEMA §9). Conventions: 02-CV §5 (mandatory columns, composite FKs, no ENUM types, RLS template, `lims_app` target, tenant-leading indexes). PHI classes from 03-IC §1: **P0** none · **P1** pseudonymous ids · **P2** identifiers/personal data · **P3** health data. Table classes from 02-CV §5.2: **M** master, **C** clinical, **A** append-only, **E** ephemeral, **G** global.

Cross-schema FKs (01-CM §5 R3, downstream → upstream only): `reporting` → `core` (tenants, branches, collection_centres, memberships), `catalog` (tests, doctors), `frontdesk` (orders, order_items, patients). **No FK into `billing`** (02-CV §5.4). No FK into `lab`, because no reporting row needs one: lab facts arrive by events and ports.

---

## 1. Table inventory

| Table | Class | Scope | Purpose |
|---|---|---|---|
| `reporting.settings` | M | tenant | C6 tenant settings (02-TRD §10.2), one row per tenant |
| `reporting.staff_assignments` | M | tenant | nominated signatories, critical-alert recipients |
| `reporting.centre_contacts` | M | tenant+centre | delivery contacts per centre |
| `reporting.referrer_preferences` | M | tenant | disabled channels per referrer |
| `reporting.channel_accounts` | M | tenant | provider config per channel (secret *reference* only) |
| `reporting.g_message_templates` | G | global | message template registry with declared params |
| `reporting.message_template_texts` | M | tenant | tenant texts per template × channel × language |
| `reporting.report_templates` / `report_template_versions` | M | tenant | layout templates, immutable published versions |
| `reporting.narrative_templates` | M | tenant | narrative section templates |
| `reporting.g_cs_reasons` / `reporting.cs_reasons` | G / M | global / tenant | coded reasons (4 sets) |
| `reporting.reports` | C | tenant+centre | report shell per order × family |
| `reporting.report_order_items` | C (read model) | tenant+centre | item readiness |
| `reporting.report_versions` | C | tenant+centre | immutable rendered versions |
| `reporting.qr_tokens` | C | tenant+centre | QR verify tokens (hash only) + minimal snapshots |
| `reporting.portal_links` | C (lifecycle) | tenant+centre | report link tokens (hash only) |
| `reporting.otp_challenges` | E | tenant | OTP challenges (HMAC only) |
| `reporting.portal_sessions` | E | tenant | portal sessions (hash only) |
| `reporting.deliveries` | C (lifecycle) | tenant (+ nullable centre) | delivery log |
| `reporting.delivery_attempts` | A | tenant | per-attempt log |
| `reporting.provider_events` | A (one lifecycle column) | tenant | inbound provider status events |
| `reporting.input_files` | C (lifecycle) | tenant+centre | outsourced PDFs, narrative images |
| `reporting.narrative_reports` / `narrative_versions` | C | tenant+centre | narrative engine |
| `reporting.print_jobs` | E | tenant+centre | plain/bulk prints, template previews (24 h) |
| `reporting.portal_payment_requests` | E | tenant (portal link) | portal dues-payment requests (08 A11.1; ships with C15) |
| `reporting.event_inbox` | A | tenant | C0 platform table (03-IC §12) |

Audited (C0 `app.tg_row_audit`, C0 05-SCHEMA "default: every class M, C and B table is audited"): every M and C table above, with one exception: `portal_links` uses the two conditional audit triggers in §6 (an update that changes only `redeem_failures`/`updated_at`/`version` is written by the pre-tenant DEFINER `app.reporting_redeem_link_for_app`, which has no claims `sub`, so it is not row-audited; the failure is counted in the metric `lims_reporting_link_redeem_failures_total`) [CONV]. E, A and G tables are not audited.

## 2. Columns (types, nulls, defaults, checks, PHI)

Mandatory columns per class (02-CV §5.3) are included in the DDL (§6) and not repeated here: `id uuid` (UUIDv7, app), `tenant_id`, `created_at`, `created_by`, plus `updated_at`, `updated_by`, `version` for M/C/lifecycle tables and `is_active` for M.

### 2.1 `reports`
| Column | Type | Null | Default / check | PHI |
|---|---|---|---|---|
| centre_id | uuid | N | FK collection_centres | P1 |
| branch_id | uuid | N | FK branches | P1 |
| order_id | uuid | N | FK frontdesk.orders | P1 |
| patient_id | uuid | N | FK frontdesk.patients | P1 |
| referrer_id | uuid | Y | FK catalog.doctors | P1 |
| partner_id | uuid | Y | snapshot from `FrontdeskPort.getOrderSummary` (`OrderSummary.partnerId`, 08 R25); no FK (partners schema is Wave 2) | P1 |
| family | text | N | `IN ('laboratory','narrative')` | P0 |
| order_source | text | N | `IN ('front_desk','engagement_booking','home_collection','partner_manifest')` | P0 |
| registered_at | timestamptz | N | | P1 |
| state | text | N | `'open'`, `IN ('open','cancelled')` | P0 |
| needs_assembly | boolean | N | false | P0 |
| needs_assembly_since | timestamptz | Y | | P0 |
| latest_version_no | integer | N | 0, ≥ 0 | P0 |
| released_version_no | integer | Y | ≥ 1 | P0 |
| lab_ready_seq | integer | Y | last applied `aggregate.seq` of ready events | P0 |
| lab_approved_set_hash | text | Y | `~ '^[0-9a-f]{64}$'` | P1 |
| lab_completeness | text | Y | `IN ('complete','partial')` | P0 |
| lab_contains_amendment | boolean | N | false | P0 |
| regeneration_counter | integer | N | 0 | P0 |
| billing_balance_due_paisa | bigint | Y | hint only | P1 |
| billing_release_eligible | boolean | Y | hint only | P0 |
| billing_balance_version | integer | Y | | P0 |
| first_released_at / final_released_at | timestamptz | Y | | P0 |
| review_flag | text | Y | `IN ('released_order_cancelled','released_item_removed')` | P0 |
| cancelled_at | timestamptz | Y | | P0 |
| registration_no | text | N | ≤ 20; snapshot of `OrderSummary.registrationNo` at shell creation (immutable in C4, 03-IC §4.3) — review fix #6 | P2 |
| patient_display_name | text | Y | ≤ 200 [CONV]; `PatientDemographics.fullName` (purpose `report_render`, system actor) at shell creation, refreshed at every assembly (incl. Regenerate); NULL when anonymised | P2 |
| centre_code | text | N | ≤ 32 [CONV]; `ctx.core.centre` code at shell creation (`centre_id` is immutable, 08 A13 D-36) | P0 |
| referrer_name | text | Y | ≤ 200 [CONV]; `CatalogPort.getReferrer({purpose: 'display'})` display name, refreshed at every assembly | P1 |

UNIQUE (tenant_id, order_id, family). The four snapshot columns serve R1/R2/O6 list and search without per-row port calls (review fix #6). Barcode search does not use a snapshot: R2 `{barcode}` calls `LabPort.lookupSpecimens({barcode})` → `orderId` (02-TRD §6.2).

### 2.2 `report_order_items`
centre_id N · report_id N (FK reports) · order_id N · order_item_id N (FK frontdesk.order_items; UNIQUE (tenant_id, order_item_id, report_id)) · orderable_id N · orderable_kind text N `IN ('test','panel')` · test_ids uuid[] N (1–200) · narrative_test_ids uuid[] N default `'{}'` · priority text N `IN ('routine','urgent')` · item_status text N `'active'` `IN ('active','removed','cancelled')` · requires_lab / requires_narrative / requires_outsourced boolean N · lab_ready / narrative_ready / outsourced_ready boolean N default false · ready_marker text Y (≤ 600; fingerprint line) · approved_results integer N default 0 · amendment_pending boolean N false · specimen_hint text Y `IN ('rejected','recollection_ordered')` · specimen_hint_seq integer Y · items_version integer Y (C4 items version). PHI: P3 (orderables linked to an order) — ids only.

### 2.3 `report_versions`
| Column | Type | Null | Default / check | PHI |
|---|---|---|---|---|
| centre_id, report_id, order_id | uuid | N | FK reports (tenant_id, report_id) | P1 |
| patient_id | uuid | N | copy of `reports.patient_id` at insert (FK frontdesk.patients); immutable — lets the patient-actor policy avoid a recursive policy on `reports` (review fix #12) [CONV] | P1 |
| partner_id | uuid | Y | copy of `reports.partner_id` at insert; immutable; same reason (partner-actor policy) [CONV] | P1 |
| version_no | integer | N | ≥ 1; UNIQUE (tenant_id, report_id, version_no) | P0 |
| status | text | N | `IN ('rendering','rendered','render_failed','released','superseded','discarded')` | P0 |
| report_kind | text | N | `IN ('final','partial','preliminary','amended','addendum')` (`addendum`: 08 R1) | P0 |
| completeness | text | N | `IN ('complete','partial')` | P0 |
| order_item_ids | uuid[] | N | 1–200 | P1 |
| content_fingerprint | text | N | hex64 | P1 |
| approved_set_hash | text | Y | hex64 | P1 |
| content_snapshot | jsonb | N | ReportDocument (02-TRD §4.3) | **P3 + P2** |
| content_sha256 | text | N | hex64 | P0 |
| template_version_id | uuid | N | FK report_template_versions | P0 |
| pdf_object_path | text | Y | CHECK: NULL or `= tenant_id::text || '/' || to_char(created_at AT TIME ZONE 'UTC','YYYY/MM') || '/' || report_id::text || '-v' || version_no || '.pdf'` | P1 |
| pdf_sha256 | text | Y | hex64 | P0 |
| pdf_bytes / page_count | bigint / integer | Y | > 0 | P0 |
| render_attempts | integer | N | 0 | P0 |
| last_render_error_code | text | Y | ≤ 64 | P0 |
| rendering_started_at / rendered_at / reported_at | timestamptz | Y / Y / N | reported_at = snapshot time (printed "Reported Date") | P1 |
| released_at / released_by | timestamptz / uuid | Y | | P1 |
| release_mode | text | Y | `IN ('manual','bulk','auto')` | P0 |
| release_basis | text | Y | `IN ('paid_in_full','zero_balance','credit_party','override','policy_not_enforced')` | P0 |
| release_override_id | uuid | Y | C4 override id; no FK (billing) | P1 |
| audiences | text[] | Y | ⊆ {patient, referrer, centre, partner, print_only} | P0 |
| supersedes_version_no | integer | Y | | P0 |
| superseded_at / superseded_by_version_no | timestamptz / integer | Y | | P0 |
| discarded_at / discard_reason | timestamptz / text | Y | `IN ('superseded_unreleased','order_cancelled')` | P0 |
| held_basis / held_checked_at | text / timestamptz | Y | `IN ('due_outstanding','no_invoice')` | P0 |
| regeneration_reason_code / _text | text | Y | ≤ 64 / ≤ 500 | P0 / P2 (free text) |
| smart_summary_json | jsonb | Y | NULL = no smart summary attached to this version; else the approved `SmartSummary` JSON (03-IC §4.10) as returned by `SmartReportPort.buildSummary`, `jsonb_typeof = 'object'` [CONV] — 08 Addendum A2.3/A2.8 | **P3** |
| smart_summary_id | uuid | Y | `SmartSummary.summaryId`; no FK (smartreport schema) — 08 A2.3 | P0 |
| smart_summary_version | text | Y | `SmartSummary.templateLibraryVersion` [CONV: the port exposes no other summary version], ≤ 32 [CONV] — 08 A2.3 | P0 |

CHECKs: `status = 'released'` ⇒ released_at, release_basis, audiences NOT NULL; `status IN ('rendered','released','superseded')` ⇒ pdf_object_path, pdf_sha256, page_count NOT NULL. Partial unique: one `released` per report. Smart-summary snapshot (08 A2.3/A2.8/A4.4): `smart_summary_json`, `smart_summary_id`, `smart_summary_version` are all NULL or all NOT NULL (`report_versions__smart_summary__ck`); filled on every version assembled with an approved summary (first assembly and Regenerate alike); set only when the version is inserted (never updated — not in the mutable-column list). Non-staff readers (portal, partner, patient) see them only through the existing `report_versions` SELECT policies (§4, §6.1) and the ReportingPort / portal reads (02-TRD §6.6, §7.1); `smartreport.*` has no non-staff policies.

### 2.4 `qr_tokens`
centre_id, report_id, report_version_id N (UNIQUE (tenant_id, report_version_id)) · token_sha256 bytea N 32 bytes (global UNIQUE, CR-C6-002; 08 R24) · lab_name_snapshot text N ≤ 160 · patient_display_snapshot text N ≤ 60 (initials from FrontdeskPort `portal_display`) **P2** · panel_names_snapshot text[] N (≤ 20 × ≤ 120) **P3** · issued_at timestamptz N · revoked_at, revoked_by, revoke_reason_code, revoke_reason_text (≤ 500) Y.

### 2.5 `portal_links`
centre_id, report_id N · bound_version_no integer N · channel text N `IN ('whatsapp','sms','email','print_qr','patient_app')` · recipient_kind text N `IN ('patient','referrer','centre','partner')` · recipient_ref_id uuid Y (patient/referrer/centre_contact/partner id) · otp_channel text Y `IN ('sms','email')` · destination_masked text Y ≤ 40 **P2** · destination_sha256 bytea Y 32 bytes · patient_display_snapshot text N ≤ 60 **P2** · token_sha256 bytea N 32 bytes (global UNIQUE) · expires_at timestamptz N · revoked_at, revoked_by, revoke_reason_code Y · delivery_id uuid Y (FK deliveries) · reissued_from_link_id uuid Y (FK self) · last_used_at Y · use_count integer N 0 · reissue_count_day integer N 0 · reissue_day date Y · redeem_failures smallint N 0, CHECK 0–5 (failed `redeemPortalLinkForApp` phone matches; written only by `app.reporting_redeem_link_for_app` — 08 A13 D-30) · purpose text N `'report'` `IN ('report','dues')`, immutable (08 A21.1 [CONV column/value]): a `dues` link is issued by C6 for a **held** version (`bound_version_no` = that rendered, unreleased version), only to the patient by sms/whatsapp, and its sessions never see report content (portal policies below require claim `portal_link_purpose = 'report'`); revoked with reason `dues_settled` when a version of the report is released.

### 2.6 `otp_challenges` (E)
link_id N (FK portal_links) · channel text N `IN ('sms','email')` · destination_sha256 bytea **Y** 32 bytes — NULL until the `reporting.send_portal_otp` worker resolves the destination (08 A13 D-31) · code_hmac bytea Y 32 bytes (HMAC-SHA256, set by the send task; 08 Addendum A2.4) · status text N `'pending_send'` `IN ('pending_send','pending','verified','exhausted','expired','superseded','failed')` · failure_code text Y `IN ('no_contact','send_rate_limited')` (`failed` ⇒ NOT NULL) · attempts smallint N 0, CHECK 0–5 · expires_at timestamptz N (≤ created_at + 10 min, CHECK) · verified_at Y · delivery_id Y. CHECK `otp_challenges__dest_resolved__ck`: `status IN ('pending_send','failed','superseded','expired') OR destination_sha256 IS NOT NULL` — D-31's CHECK (`status = 'pending_send' OR destination_sha256 IS NOT NULL`) extended to the three end states a challenge can reach before its destination is resolved (no phone → `failed`; a newer P1 → `superseded`; worker never ran → `expired`) [CONV]. PHI: P1 (credential material as HMAC only).

### 2.7 `portal_sessions` (E)
link_id N · report_id N · token_sha256 bytea N 32 bytes (global UNIQUE) · last_seen_at N · idle_expires_at N · absolute_expires_at N · ended_at Y · user_agent_sha256 Y · link_purpose text N `'report'` `IN ('report','dues')` (copied from the link at P2; resolver returns it — 08 A21.1). P1.

### 2.8 `deliveries`
| Column | Type | Null | Check | PHI |
|---|---|---|---|---|
| centre_id | uuid | Y | NULL for OTP-by-phone and staff deliveries | P1 |
| channel | text | N | `IN ('whatsapp','sms','email','print','portal')` | P0 |
| purpose | text | N | NotificationPurpose codes (03-IC §4.8) | P0 |
| template_code | text | **Y** | FK g_message_templates(code) (G, plain FK); CHECK `(channel IN ('print','portal')) = (template_code IS NULL)` — print/portal deliveries have no message template (review fix #5) | P0 |
| recipient_kind | text | N | `IN ('patient','referrer','centre','partner','staff','phone_otp')` | P0 |
| recipient_id | uuid | Y | patient / referrer / **centre_contact** (kind `centre`; the centre is `centre_id`) / partner / membership id [CONV] | P1 |
| destination_masked | text | Y | ≤ 40 | P2 |
| destination_sha256 | bytea | Y | 32 bytes (08 R24) | P1 |
| destination_e164 | text | Y | only `phone_otp`; NULLed at terminal status | P2 |
| params | jsonb | N | declared params only; secrets (`url`, `otp_code`) removed at terminal status | P2 (credential until scrubbed) |
| language | text | N | `'en'`, `IN ('en','ne')` | P0 |
| idempotency_key | text | N | ≤ 200; UNIQUE (tenant_id, idempotency_key) | P1 |
| related_entity_type / related_entity_id | text / uuid | Y | `IN ('order','report','specimen','booking','visit','critical_event','report_run')` (`report_run`: 08 R13) | P1 |
| report_id / report_version_no | uuid / integer | Y | FK reports | P1 |
| deferred_link | jsonb | Y | `{report_id, version_no, channel, recipient_kind, purpose?: 'report'|'dues' (default report; 08 A21.1), reissued_from_link_id?}` — link issued at send time (`reissued_from_link_id` set only by `reporting.reissue_portal_link`) | P1 |
| link_id | uuid | Y | FK portal_links | P1 |
| status | text | N | `IN ('queued','sent','delivered','read','failed','suppressed')` | P0 |
| failure_code | text | Y | ≤ 64 | P0 |
| attempt_no | integer | N | 1 | P0 |
| channel_account_id | uuid | Y | FK channel_accounts | P0 |
| provider_kind | text | Y | 02-TRD §5.4 ProviderKind | P0 |
| provider_message_id | text | Y | ≤ 128 | P1 |
| fallback_of_delivery_id | uuid | Y | FK self; UNIQUE partial (one fallback per delivery) | P1 |
| fallback_check_at | timestamptz | Y | | P0 |
| queued_at / sent_at / delivered_at / read_at / failed_at / suppressed_at | timestamptz | Y | | P0 |

Print deliveries (AC-12.1, review fix #5): `channel = 'print'`, `purpose = 'report_ready'`, `template_code` NULL, `recipient_kind = 'patient'`, `status = 'sent'` at creation with `sent_at`, `idempotency_key = '<print_job_id>:print'` (every R10 print, letterhead included, has a `print_jobs` row — §2.14).

### 2.9 `delivery_attempts` (A)
delivery_id N · attempt_no integer N (UNIQUE (tenant_id, delivery_id, attempt_no)) · started_at N · finished_at Y · outcome text N `IN ('accepted','retryable_error','permanent_error','suppressed','circuit_open')` · error_code text Y ≤ 64 · provider_status_raw text Y ≤ 64 · latency_ms integer Y. P0/P1.

### 2.10 `provider_events` (A + `applied_at`, `delivery_id`)
channel_account_id N · provider_kind N · provider_message_id N ≤ 128 · status_raw N ≤ 64 · mapped_status N `IN ('sent','delivered','read','failed')` · occurred_at Y · received_at N · delivery_id Y · applied_at Y · ignored_reason Y `IN ('unknown_message','duplicate','backwards')`. UNIQUE (tenant_id, channel_account_id, provider_message_id, mapped_status). P1.

### 2.11 `input_files`
centre_id, order_id N · order_item_id Y (FK frontdesk.order_items) · narrative_report_id Y (FK narrative_reports) · kind text N `IN ('outsourced_pdf','narrative_image')` · state text N `IN ('pending_scan','scanning','quarantined','sanitizing','ready','rejected','confirmed','withdrawn')` · original_filename text N ≤ 200 (metadata only) **P2** · declared_mime / detected_mime text N/Y `IN ('application/pdf','image/png','image/jpeg')` · size_bytes bigint N ≤ 15,728,640 · sha256_original hex64 N · quarantine_object_path text N (`{tenant_id}/quarantine/…` in bucket `reporting-inputs`, 08 §4.8) · sanitized_object_path text Y · sanitized_sha256 Y · page_count Y · image_width / image_height Y · external_lab_name text Y ≤ 120 · caption text Y ≤ 200 **P3** · sort_order smallint N 0 · confirmed_by / confirmed_at Y · withdrawn_reason_code / withdrawn_reason_text Y · last_error_code Y. CHECK: kind outsourced ⇒ order_item_id and external_lab_name NOT NULL; kind narrative_image ⇒ narrative_report_id NOT NULL. Content of the objects: **P3**.

### 2.12 `narrative_reports` / `narrative_versions`
`narrative_reports`: centre_id, report_id, order_id, order_item_id, test_id (FK catalog.tests) N · template_kind text N `IN ('xray','usg','endoscopy','cytogenetics','other')` · status text N `IN ('draft','signed','amending','cancelled')` · current_version_no integer N 1 · signed_version_no integer Y. UNIQUE (tenant_id, order_item_id, test_id).
`narrative_versions`: centre_id, narrative_report_id N · version_no N (UNIQUE per narrative) · status N `IN ('draft','signed','superseded','cancelled')` · template_id Y (FK narrative_templates) · sections jsonb N (array ≤ 12 of `{key, heading, html}`; html sanitised, ≤ 20,000 chars each) **P3** · image_file_ids uuid[] N `'{}'` (≤ 12) · signed_by_membership_id Y (FK memberships) · signed_at Y · content_sha256 Y · amendment_of_version_no Y · amendment_reason_code / _text Y.

### 2.13 Templates and masters
- `report_templates`: family text `IN ('laboratory','narrative')`, name ≤ 80, current_version_id Y, is_default boolean (partial UNIQUE (tenant_id, family) WHERE is_default).
- `report_template_versions`: template_id N, version_no N, status `IN ('draft','published','retired')`, config jsonb N (validated by 02-TRD `TemplateConfig` schema in the API; DB CHECK `jsonb_typeof(config) = 'object'` and `octet_length(config::text) <= 32768`), config_sha256 hex64, published_at/by Y. Partial UNIQUE one draft per template; one published per template.
- `narrative_templates`: code `~ '^[A-Z0-9_]{1,32}$'` (UNIQUE per tenant), name ≤ 120, kind (as narrative_reports.template_kind), test_id Y (FK catalog.tests), sections jsonb N (1–12 of `{key ^[a-z0-9_]{1,40}$, heading ≤ 80, required bool, default_html ≤ 5000}`).
- `settings`: columns of 02-TRD §10.2 with the CHECKs given there.
- `staff_assignments`: membership_id N (FK core.memberships), assignment text N `IN ('nominated_signatory','critical_alert_recipient')`, sort_order smallint; UNIQUE (tenant_id, assignment, membership_id).
- `centre_contacts`: centre_id N, channel `IN ('whatsapp','sms','email')`, address text N ≤ 254 (E.164 for whatsapp/sms, email otherwise; CHECK by regex) **P2**, label ≤ 80.
- `referrer_preferences`: referrer_id N (FK catalog.doctors, UNIQUE per tenant), disabled_channels text[] N ⊆ {whatsapp, sms, email}.
- `channel_accounts`: channel `IN ('whatsapp','sms','email')` (UNIQUE per tenant), provider_kind `IN ('recording','whatsapp_cloud_api','sms_sparrow','sms_aakash','email_smtp_relay')`, sender_id ≤ 64, secret_ref `~ '^[a-z0-9_./-]{1,128}$'`, callback_token_sha256 bytea Y 32 bytes (global UNIQUE; 08 R24).
- `g_message_templates` (G): code PK `~ '^[a-z_]+\.[a-z0-9_]{1,60}$'`, purpose, channels text[], params jsonb (array of `{name, kind, max_length}`), default_texts jsonb (`{"<channel>": {"body": …, "subject": …}}`), is_active.
- `message_template_texts`: template_code N (FK g), channel N, language N `IN ('en','ne')`, body_text ≤ 1000, subject_text ≤ 150 Y, provider_template_name ≤ 128 Y, provider_template_language ≤ 16 Y, provider_variable_order text[] Y, approval_status `IN ('not_required','draft','submitted','approved','rejected')`, approval_recorded_by/at Y. UNIQUE (tenant_id, template_code, channel, language).
- `g_cs_reasons` (G): PK (set_name, code); set_name `IN ('regeneration_reasons','token_revoke_reasons','outsourced_withdraw_reasons','narrative_amend_reasons')`; columns per 02-CV §5.5. `cs_reasons` (M): same + tenant_id, shadows by code. DECISION: one table per G/M pair with a `set_name` column instead of four `cs_<name>` tables (same semantics, fewer objects).

### 2.14 `print_jobs` (E)
centre_id N · kind `IN ('single','bulk','template_preview')` · report_version_ids uuid[] N (0–200; 0 for preview) · excluded_ids uuid[] N `'{}'` · template_version_id Y · variant `IN ('letterhead','plain')` · copies smallint 1–5 · draft_watermark boolean N false · state `IN ('rendering','ready','failed','expired')` · object_path Y (`{tenant_id}/prints/…` in bucket `reporting-prints`) · sha256 / page_count Y · expires_at N · error_code Y. P1 (object content P3).

`centre_id` rule (review fix #36): `single` → the version's report centre; `bulk` → the requesting user's working centre, and every id in `report_version_ids` must be inside the caller's centre scope (ids outside it are reported `not_found` per id — RLS hides them — and listed in `excluded_ids`); `template_preview` → the requesting user's working centre. A `single` **letterhead** print of a released version stores no file: `object_path` stays NULL, `state = 'ready'` at creation, and R12 streams the canonical version PDF of `report_version_ids[0]` from bucket `reports` (AC-12.1). Plain variants, drafts (`draft_watermark`) and bulk prints store their file under `{tenant_id}/prints/`.

### 2.15 `portal_payment_requests` (E) — 08 Addendum A11.1 (ships with C15)
link_id N (FK portal_links; the session's link) · report_id N (FK reports; the link's report) · order_id N (FK frontdesk.orders; `reports.order_id`) · gateway text N `IN ('esewa','khalti')` (Fonepay BLOCKED B8) · status text N `'queued'` `IN ('queued','ready','completed','failed','expired')` · review boolean N false (C15 `held_for_review`) · intent_id uuid Y (C15 intent; no FK — `payments` schema) · amount_paisa bigint Y > 0 (the intent's `amount`, computed by C15 from `BillingPort.getOrderBalance`; never from the request) · action_json jsonb Y (`{"url": <gateway URL>}` — secret-bearing; only while `status = 'ready'` and `review = false`, scrubbed otherwise) **credential** · failure_code text Y ≤ 64 · intent_expires_at timestamptz Y · last_checked_at timestamptz Y · completed_at timestamptz Y · expires_at timestamptz N (= created_at + 90 days, row retention; E class) · version, updated_at, updated_by. Partial UNIQUE one open (`queued`/`ready`) request per order. PHI: P1 (ids, amount).

Patterned on C16 `engagement.payment_requests` (same status set, same scrub rule) [CONV].

---

## 3. Mutability rules

| Table | Mechanism | Columns allowed to change |
|---|---|---|
| `report_versions` | `app.enforce_mutable_columns` + `reporting.tg_report_versions_guard` | status, render_attempts, last_render_error_code, rendering_started_at, rendered_at, pdf_object_path, pdf_sha256, pdf_bytes, page_count, released_at, released_by, release_mode, release_basis, release_override_id, audiences, supersedes_version_no, superseded_at, superseded_by_version_no, discarded_at, discard_reason, held_basis, held_checked_at, updated_at, updated_by, version. Guard: pdf_* only NULL → value (write-once); status transitions only per 03-APP-FLOW §1.2 |
| `narrative_versions` | `reporting.tg_narrative_versions_guard` | while `draft`: everything except id/tenant/narrative/version_no; once `signed`: only status (`signed → superseded`), updated_*, version |
| `qr_tokens` | enforce_mutable_columns | revoked_at, revoked_by, revoke_reason_code, revoke_reason_text, updated_at, updated_by, version (revoked_at NULL → value only) |
| `portal_links` | enforce_mutable_columns + `reporting.tg_portal_links_guard` (review fix #35) | revoked_*, last_used_at, use_count, reissue_count_day, reissue_day, delivery_id (NULL → value), redeem_failures, updated_*, version. Guard: `revoked_at` only NULL → value; once set, `revoked_at`/`revoked_by`/`revoke_reason_code` never change; `delivery_id` only NULL → value; `redeem_failures` never decreases; a **portal** actor may change only `last_used_at`, `use_count`, `reissue_count_day`, `reissue_day`, `updated_*`, `version`; the lookup role (`current_user = 'lims_reporting_lookup'`, i.e. inside `app.reporting_redeem_link_for_app`) may change only `redeem_failures`, `updated_at`, `version` |
| `portal_payment_requests` | enforce_mutable_columns + `reporting.tg_portal_payment_requests_guard` | status, review, intent_id (NULL → value), amount_paisa (NULL → value), action_json, failure_code, intent_expires_at, last_checked_at, completed_at, updated_*, version. Guard: transitions `queued → ready|failed`, `ready → ready|completed|failed|expired`; terminal states never change |
| `deliveries` | enforce_mutable_columns + `reporting.tg_deliveries_scrub_only` | status, failure_code, attempt_no, channel_account_id, provider_kind, provider_message_id, link_id, fallback_check_at, *_at status timestamps, destination_masked, destination_sha256, params, destination_e164, updated_*, version. Scrub guard: `params` may only lose the keys `url`/`otp_code`; `destination_e164` may only go to NULL |
| `input_files` | enforce_mutable_columns | state, detected_mime, sanitized_object_path, sanitized_sha256, page_count, image_width, image_height, caption, sort_order, confirmed_*, withdrawn_*, last_error_code, updated_*, version |
| `provider_events` | enforce_mutable_columns | applied_at, delivery_id, ignored_reason (NULL → value) |
| `delivery_attempts` | class A: no UPDATE grant | — |
| `reports`, `report_order_items`, `narrative_reports` | normal UPDATE through repositories (C read-model/lifecycle rows; no clinical values) | all except identity/tenant/order keys (enforced by `enforce_mutable_columns` excluding `id, tenant_id, order_id, family, created_*`) |

No DELETE grant on any C/A table. E tables (`otp_challenges`, `portal_sessions`, `print_jobs`, `portal_payment_requests`) are deleted only by `reporting.purge_ephemeral` (cron `tenantScope: 'per_tenant'`, 08 A13 P-6) under the system actor through `__delete__tenant_expired` policies. C6 has **no** cross-tenant maintenance DEFINER (its purge runs per tenant through policies), so 08 A12.2 (`app.maintenance` owner policies) has nothing to apply in C6.

## 4. RLS

Helpers from 02-CV §5.8. Abbreviations used in the SQL below (written out in full in the DDL):
- **T** = `tenant_id = (SELECT app.current_tenant_id())`
- **CS** = `((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))`
- **PORTAL_SESSION** = `(SELECT app.current_actor_type()) = 'portal' AND (SELECT app.current_claims() ->> 'portal_stage') = 'session'`
- **PORTAL_ANY** = `(SELECT app.current_actor_type()) = 'portal'`
- **PRID** = `(SELECT nullif(app.current_claims() ->> 'portal_report_id', '')::uuid)`
- **PLINK** = `(SELECT app.current_actor_id())` (portal `sub` = link id)

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| reports | `__tenant_centre` (T AND CS AND staff/system); `__owner_only` (TO lims_reporting_lookup: `id` = the report of the portal link whose `token_sha256` matches `app.pre_portal_token_sha256` — D-30); `__portal` (T AND PORTAL_SESSION AND id = PRID); `__partner` (T AND actor_type = 'partner' AND partner_id = `app.current_partner_id()` AND EXISTS released/superseded version — CR-C13-005); `__patient` (T AND actor_type = 'patient' AND `patient_id = ANY ((SELECT app.engagement_patient_ids())::uuid[])` (08 A16.1 cast) AND EXISTS released/superseded version — CR-C16-008) | `__tenant_centre` | `__tenant_centre` | none |
| report_order_items, narrative_reports, narrative_versions, input_files, print_jobs | `__tenant_centre` | `__tenant_centre` | `__tenant_centre` | print_jobs: `__tenant_expired` (T AND expires_at < now() AND actor_type = 'system'); others none |
| report_versions | `__tenant_centre`; `__portal` (T AND PORTAL_SESSION AND claim `portal_link_purpose = 'report'` — 08 A21.1 — AND report_id = PRID AND status IN ('released','superseded')); `__partner` / `__patient` (T AND actor predicate on the version's own `partner_id` / `patient_id` copy AND status IN ('released','superseded') — no subquery on `reports`, which would recurse) | `__tenant_centre` | `__tenant_centre` | none |
| qr_tokens | `__tenant_centre`; `__portal` (T AND PORTAL_SESSION AND claim `portal_link_purpose = 'report'` AND report_id = PRID); `__partner` / `__patient` (as report_versions — `panel_names_snapshot` for `getReleasedReports`); `__lookup` (TO lims_reporting_lookup: `token_sha256 = decode(nullif(current_setting('app.pre_qr_token_sha256', true), ''), 'hex')`) | `__tenant_centre` | `__tenant_centre` | none |
| portal_links | `__tenant_centre`; `__portal` (T AND PORTAL_ANY AND id = PLINK); `__lookup` (TO lims_reporting_lookup: token match on `app.pre_portal_credential_sha256`); `__owner_only` (TO lims_reporting_lookup: token match on `app.pre_portal_token_sha256` — D-30) | `__tenant_centre` | `__tenant_centre`; `__portal` (T AND PORTAL_ANY AND id = PLINK); `__owner_only` (TO lims_reporting_lookup, `app.pre_portal_token_sha256` match — D-30 counter) | none |
| otp_challenges | `__portal` (T AND PORTAL_ANY AND link_id = PLINK); `__tenant_system` (T AND actor_type = 'system') — staff never read OTP rows (review fix #34) | `__portal`; `__tenant_system` | `__portal`; `__tenant_system` | `__tenant_expired` (system, expires_at < now() - interval '24 hours') |
| portal_payment_requests | `__portal` (T AND PORTAL_SESSION AND link_id = PLINK); `__tenant_system` — staff never read them [CONV] | `__portal` (T AND PORTAL_SESSION AND link_id = PLINK AND report_id = PRID AND `order_id` = that report's order) | `__tenant_system` only (the portal never updates; refresh runs in the worker) | `__tenant_expired` (system, `expires_at < now()`) |
| settings | `__tenant`; + `__portal` (T AND PORTAL_SESSION) — read-only, for `portal_payment_gateways` (A11.1) [CONV: P0 configuration] | `__tenant` | `__tenant` | none |
| portal_sessions | `__portal` (T AND PORTAL_ANY AND link_id = PLINK); `__tenant_system`; `__lookup` (token match) | `__portal` | `__portal`; `__tenant_system` | `__tenant_expired` |
| deliveries | `__tenant_centre_nullable` (T AND (has_all_centres OR (centre_id IS NOT NULL AND centre_id = ANY(current_centre_ids)))); + `__owner_only` (TO lims_reporting_lookup: `id` = the `delivery_id` of the link matching `app.pre_portal_token_sha256` — D-30) | same (no lookup) | same (no lookup) | none |
| delivery_attempts, provider_events, settings (staff side), staff_assignments, referrer_preferences, channel_accounts, message_template_texts, report_templates, report_template_versions, narrative_templates, cs_reasons | `__tenant` | `__tenant` | `__tenant` (not attempts) | none |
| provider_events | + `__select__lookup` (same predicate; required by `ON CONFLICT`) + `__insert__lookup` (TO lims_reporting_lookup, INSERT WITH CHECK `channel_account_id = current_setting('app.pre_callback_channel_account_id', true)::uuid AND tenant_id = current_setting('app.pre_callback_tenant_id', true)::uuid`) | | | |
| channel_accounts | + `__lookup` (TO lims_reporting_lookup: `callback_token_sha256 = decode(nullif(current_setting('app.pre_callback_token_sha256', true), ''), 'hex')`) | | | |
| report_versions | + `__lookup` (TO lims_reporting_lookup: `id IN (SELECT q.report_version_id FROM reporting.qr_tokens q WHERE q.token_sha256 = decode(nullif(current_setting('app.pre_qr_token_sha256', true), ''), 'hex'))`); + `__owner_only` (TO lims_reporting_lookup: `report_id` = the report of the link matching `app.pre_portal_token_sha256` — D-30) | | | |
| centre_contacts | `__tenant_centre` | `__tenant_centre` | `__tenant_centre` | none |
| g_message_templates, g_cs_reasons | no RLS (G; `rls_exempt.txt`: "global registry, no tenant data") | — | — | — |

Portal, partner and patient actors never match `__tenant_centre` (`has_all_centres()` returns false for every non-staff actor type, `current_centre_ids()` = `'{}'` — 08 R3), so they see only rows granted by the explicit `__portal` / `__partner` / `__patient` policies. Staff never match those policies. Every `__tenant` and `__tenant_centre` policy also requires `(SELECT app.is_staff_or_system())` (CR-C13-011, 08 R10 item 5; written out in the §6.1 template — review fix #34); the actor-specific policies above are the only paths for non-staff actors. The deliberate exceptions are `otp_challenges`/`portal_sessions`/`portal_payment_requests` (`__portal`, `__tenant_system`) and the read-only `settings__select__portal`.

Lookup GUCs (08 A21.4 — A12.1 generalised): `app.pre_qr_token_sha256` (`reporting_verify_qr`), `app.pre_portal_credential_sha256` (`reporting_resolve_portal_credential`), `app.pre_callback_token_sha256` / `app.pre_callback_tenant_id` / `app.pre_callback_channel_account_id` (`reporting_ingest_provider_callback`) [CONV names], `app.pre_portal_token_sha256` (`reporting_redeem_link_for_app`, D-30). Every function resets its GUCs to `''` before each return. All are set with `set_config(…, true)` inside the function body; the policies are `TO lims_reporting_lookup` only, so a `lims_app` session that sets the same GUC sees nothing (A12.7 test).

## 5. Indexes (every query in 02-TRD)

| Index | Serves |
|---|---|
| `reports__tenant_id_order_id_family__uq` | shell upsert, search by order |
| `reports__tenant_id_centre_id_state_updated_at__idx` | worklist (R1) |
| `reports__tenant_id_needs_assembly__p_idx (tenant_id, needs_assembly_since) WHERE needs_assembly` | sweep_assembly |
| `reports__tenant_id_patient_id__idx`, `reports__tenant_id_partner_id__p_idx WHERE partner_id IS NOT NULL` | ReportingPort filters, R2 |
| `reports__tenant_id_registration_no__idx (tenant_id, registration_no)` | R2 `{registration_no}` (review fix #6) |
| `reports__tenant_id_registered_at__idx (tenant_id, registered_at DESC)` | R1 sort/filter `registered_at` (review fix #42) |
| `reports__tenant_id_first_released_at__p_idx (tenant_id, first_released_at DESC) WHERE first_released_at IS NOT NULL` | R1 `released_at_from/_to`, sort `-released_at` (both on `first_released_at` [CONV]) |
| `report_order_items__tenant_id_order_item_id_report_id__uq`, `report_order_items__tenant_id_report_id__idx` | readiness |
| `report_order_items__tenant_id_requires_outsourced__p_idx (tenant_id, report_id) WHERE requires_outsourced AND item_status = 'active'` | O6 (review fix #42) |
| `report_versions__tenant_id_report_id_version_no__uq` | version numbering |
| `report_versions__tenant_id_report_id__released__p_uq (tenant_id, report_id) WHERE status = 'released'` | one released per report |
| `report_versions__tenant_id_status_created_at__p_idx WHERE status IN ('rendering','rendered','render_failed')` | worklist tabs, sweeps |
| `report_versions__tenant_id_released_at__p_idx WHERE released_at IS NOT NULL` | released today, `v_pub_*`, ReportingPort cursor |
| `report_versions__tenant_id_patient_id__p_idx`, `report_versions__tenant_id_partner_id__p_idx` (both `WHERE status IN ('released','superseded')`) | patient/partner actor policies, `getReleasedReports` |
| `qr_tokens__token_sha256__uq` (**global**, CR-C6-002) · `qr_tokens__tenant_id_report_version_id__uq` | verify; join |
| `portal_links__token_sha256__uq` (**global**) · `portal_links__tenant_id_report_id__idx` · `portal_links__tenant_id_delivery_id__p_idx` | resolve; R15 |
| `otp_challenges__tenant_id_link_id_created_at__idx` · `otp_challenges__tenant_id_expires_at__idx` | P1/P2; purge |
| `portal_sessions__token_sha256__uq` (**global**) · `portal_sessions__tenant_id_absolute_expires_at__idx` | resolve; purge |
| `deliveries__tenant_id_idempotency_key__uq` | NotificationPort replay |
| `deliveries__tenant_id_report_id_created_at__idx` | report detail, D1 filter |
| `deliveries__tenant_id_status_fallback_check_at__p_idx WHERE status IN ('queued','sent')` | fallback, stuck sends |
| `deliveries__tenant_id_channel_account_id_provider_message_id__p_uq WHERE provider_message_id IS NOT NULL` | callback apply |
| `deliveries__tenant_id_fallback_of_delivery_id__p_uq WHERE fallback_of_delivery_id IS NOT NULL` | one fallback |
| `deliveries__tenant_id_created_at__idx` | D1 list, `v_pub_delivery_daily` |
| `deliveries__tenant_id_related_entity_id__p_idx WHERE related_entity_id IS NOT NULL` | critical alerts grouping |
| `deliveries__tenant_id_purpose_created_at__idx (tenant_id, purpose, created_at DESC)` | `listCriticalAlerts` (purpose `critical_value_alert`, `since`, cursor — review fix #16) |
| `portal_payment_requests__tenant_id_order_id__open__p_uq (tenant_id, order_id) WHERE status IN ('queued','ready')` · `portal_payment_requests__tenant_id_link_id_created_at__idx` · `portal_payment_requests__tenant_id_intent_expires_at__p_idx WHERE status = 'ready'` · `portal_payment_requests__tenant_id_expires_at__idx` | one open request per order; PP1/PP2; expiry cron; purge |
| `delivery_attempts__tenant_id_delivery_id_attempt_no__uq` | D2 |
| `provider_events__tenant_id_received_at__idx` · uq in §2.10 | apply, retention |
| `channel_accounts__callback_token_sha256__p_uq` (**global**, WHERE NOT NULL) · `channel_accounts__tenant_id_channel__uq` | callbacks |
| `input_files__tenant_id_order_item_id__idx` · `input_files__tenant_id_state__p_idx WHERE state IN ('pending_scan','scanning','sanitizing')` · `input_files__tenant_id_narrative_report_id__p_idx` | O2/O6, processing, N2 |
| `narrative_reports__tenant_id_order_item_id_test_id__uq` · `narrative_reports__tenant_id_centre_id_status__idx` | N1 |
| `narrative_versions__tenant_id_narrative_report_id_version_no__uq` | N2 |
| `print_jobs__tenant_id_expires_at__idx` | purge |
| `message_template_texts__tenant_id_template_code_channel_language__uq` | NotificationPort text lookup |
| `staff_assignments__tenant_id_assignment_membership_id__uq` · `centre_contacts__tenant_id_centre_id_channel__idx` · `referrer_preferences__tenant_id_referrer_id__uq` · `settings__tenant_id__uq` · `narrative_templates__tenant_id_code__uq` · `narrative_templates__tenant_id_test_id__p_idx` · `report_template_versions__tenant_id_template_id_version_no__uq` | settings and template lookups |

Global (non-tenant-leading) indexes are the four token-hash uniques only. Justification: pre-tenant lookups through inventoried DEFINER functions. The values are 128/256-bit random hashes, so a collision is not a practical existence oracle (same reasoning as CR-C2-017).

## 6. DDL

```sql
-- ===================== reporting: masters =====================
CREATE TABLE reporting.settings (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  auto_release text NOT NULL DEFAULT 'when_eligible',
  narrative_report_mode text NOT NULL DEFAULT 'separate',
  patient_mobile_channel_order text[] NOT NULL DEFAULT '{whatsapp,sms}',
  patient_email_enabled boolean NOT NULL DEFAULT true,
  referrer_delivery_enabled boolean NOT NULL DEFAULT true,
  referrer_channels text[] NOT NULL DEFAULT '{sms}',
  centre_delivery_enabled boolean NOT NULL DEFAULT false,
  whatsapp_fallback_minutes integer NOT NULL DEFAULT 30,
  critical_alert_referrer_enabled boolean NOT NULL DEFAULT true,
  bulk_release_max integer NOT NULL DEFAULT 200,
  print_critical_label boolean NOT NULL DEFAULT false,
  link_reissue_max_per_day smallint NOT NULL DEFAULT 3,
  portal_payment_gateways text[] NOT NULL DEFAULT '{}',                  -- 08 A11.1; empty = no portal payment button [CONV]
  dues_link_enabled boolean NOT NULL DEFAULT true,                       -- 08 A21.1 [CONV switch]
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT settings__pk PRIMARY KEY (id),
  CONSTRAINT settings__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT settings__tenant_id__uq UNIQUE (tenant_id),
  CONSTRAINT settings__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT settings__auto_release__ck CHECK (auto_release IN ('when_eligible','manual')),
  CONSTRAINT settings__narrative_mode__ck CHECK (narrative_report_mode IN ('separate','combined')),
  CONSTRAINT settings__channel_order__ck CHECK (patient_mobile_channel_order <@ ARRAY['whatsapp','sms']
             AND cardinality(patient_mobile_channel_order) BETWEEN 1 AND 2),
  CONSTRAINT settings__referrer_channels__ck CHECK (referrer_channels <@ ARRAY['whatsapp','sms','email']),
  CONSTRAINT settings__fallback__ck CHECK (whatsapp_fallback_minutes BETWEEN 5 AND 240),
  CONSTRAINT settings__bulk__ck CHECK (bulk_release_max BETWEEN 1 AND 200),
  CONSTRAINT settings__reissue__ck CHECK (link_reissue_max_per_day BETWEEN 0 AND 5),
  CONSTRAINT settings__portal_gateways__ck CHECK (portal_payment_gateways <@ ARRAY['esewa','khalti'])   -- Fonepay BLOCKED B8
);

CREATE TABLE reporting.staff_assignments (
  id uuid NOT NULL, tenant_id uuid NOT NULL, membership_id uuid NOT NULL, assignment text NOT NULL,
  sort_order smallint NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT staff_assignments__pk PRIMARY KEY (id),
  CONSTRAINT staff_assignments__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT staff_assignments__tenant_id_assignment_membership_id__uq UNIQUE (tenant_id, assignment, membership_id),
  CONSTRAINT staff_assignments__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT staff_assignments__membership__fk FOREIGN KEY (tenant_id, membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT staff_assignments__assignment__ck CHECK (assignment IN ('nominated_signatory','critical_alert_recipient'))
);

CREATE TABLE reporting.centre_contacts (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, channel text NOT NULL,
  address text NOT NULL, label text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT centre_contacts__pk PRIMARY KEY (id),
  CONSTRAINT centre_contacts__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT centre_contacts__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT centre_contacts__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT centre_contacts__channel__ck CHECK (channel IN ('whatsapp','sms','email')),
  CONSTRAINT centre_contacts__address__ck CHECK (
    (channel IN ('whatsapp','sms') AND address ~ '^\+[1-9][0-9]{7,14}$') OR
    (channel = 'email' AND char_length(address) <= 254 AND address ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  CONSTRAINT centre_contacts__label__ck CHECK (label IS NULL OR char_length(label) <= 80)
);
CREATE INDEX centre_contacts__tenant_id_centre_id_channel__idx ON reporting.centre_contacts (tenant_id, centre_id, channel);

CREATE TABLE reporting.referrer_preferences (
  id uuid NOT NULL, tenant_id uuid NOT NULL, referrer_id uuid NOT NULL,
  disabled_channels text[] NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT referrer_preferences__pk PRIMARY KEY (id),
  CONSTRAINT referrer_preferences__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT referrer_preferences__tenant_id_referrer_id__uq UNIQUE (tenant_id, referrer_id),
  CONSTRAINT referrer_preferences__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT referrer_preferences__referrer__fk FOREIGN KEY (tenant_id, referrer_id) REFERENCES catalog.doctors (tenant_id, id),
  CONSTRAINT referrer_preferences__channels__ck CHECK (disabled_channels <@ ARRAY['whatsapp','sms','email'])
);

CREATE TABLE reporting.channel_accounts (
  id uuid NOT NULL, tenant_id uuid NOT NULL, channel text NOT NULL, provider_kind text NOT NULL,
  sender_id text, secret_ref text NOT NULL, callback_token_sha256 bytea,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT channel_accounts__pk PRIMARY KEY (id),
  CONSTRAINT channel_accounts__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT channel_accounts__tenant_id_channel__uq UNIQUE (tenant_id, channel),
  CONSTRAINT channel_accounts__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT channel_accounts__channel__ck CHECK (channel IN ('whatsapp','sms','email')),
  CONSTRAINT channel_accounts__provider__ck CHECK (provider_kind IN ('recording','whatsapp_cloud_api','sms_sparrow','sms_aakash','email_smtp_relay')),
  CONSTRAINT channel_accounts__sender__ck CHECK (sender_id IS NULL OR char_length(sender_id) <= 64),
  CONSTRAINT channel_accounts__secret_ref__ck CHECK (secret_ref ~ '^[a-z0-9_./-]{1,128}$'),
  CONSTRAINT channel_accounts__cb__ck CHECK (callback_token_sha256 IS NULL OR octet_length(callback_token_sha256) = 32)   -- 08 R24
);
CREATE UNIQUE INDEX channel_accounts__callback_token_sha256__p_uq ON reporting.channel_accounts (callback_token_sha256)
  WHERE callback_token_sha256 IS NOT NULL;                      -- global: CR-C6-002

CREATE TABLE reporting.g_message_templates (
  code text NOT NULL, purpose text NOT NULL, channels text[] NOT NULL, params jsonb NOT NULL,
  default_texts jsonb NOT NULL, description text, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_message_templates__pk PRIMARY KEY (code),
  CONSTRAINT g_message_templates__code__ck CHECK (code ~ '^[a-z_]+\.[a-z0-9_]{1,60}$'),
  CONSTRAINT g_message_templates__purpose__ck CHECK (purpose IN ('registration_confirmation','report_ready','otp','dues_reminder',
    'recollection_request','critical_value_alert','booking_confirmation','visit_assignment','follow_up_reminder',
    'scheduled_report_ready','booking_cancelled','booking_reminder')),   -- 08 R13
  CONSTRAINT g_message_templates__channels__ck CHECK (channels <@ ARRAY['whatsapp','sms','email'] AND cardinality(channels) >= 1),
  CONSTRAINT g_message_templates__params__ck CHECK (jsonb_typeof(params) = 'array')
);

CREATE TABLE reporting.message_template_texts (
  id uuid NOT NULL, tenant_id uuid NOT NULL, template_code text NOT NULL, channel text NOT NULL, language text NOT NULL,
  body_text text NOT NULL, subject_text text, provider_template_name text, provider_template_language text,
  provider_variable_order text[], approval_status text NOT NULL DEFAULT 'not_required',
  approval_recorded_by uuid, approval_recorded_at timestamptz,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT message_template_texts__pk PRIMARY KEY (id),
  CONSTRAINT message_template_texts__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT message_template_texts__tenant_id_template_code_channel_language__uq UNIQUE (tenant_id, template_code, channel, language),
  CONSTRAINT message_template_texts__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT message_template_texts__template__fk FOREIGN KEY (template_code) REFERENCES reporting.g_message_templates (code),
  CONSTRAINT message_template_texts__channel__ck CHECK (channel IN ('whatsapp','sms','email')),
  CONSTRAINT message_template_texts__language__ck CHECK (language IN ('en','ne')),
  CONSTRAINT message_template_texts__len__ck CHECK (char_length(body_text) BETWEEN 1 AND 1000
     AND (subject_text IS NULL OR char_length(subject_text) <= 150)
     AND (provider_template_name IS NULL OR char_length(provider_template_name) <= 128)
     AND (provider_template_language IS NULL OR char_length(provider_template_language) <= 16)),
  CONSTRAINT message_template_texts__approval__ck CHECK (approval_status IN ('not_required','draft','submitted','approved','rejected'))
);

CREATE TABLE reporting.report_templates (
  id uuid NOT NULL, tenant_id uuid NOT NULL, family text NOT NULL, name text NOT NULL,
  current_version_id uuid, is_default boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT report_templates__pk PRIMARY KEY (id),
  CONSTRAINT report_templates__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT report_templates__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT report_templates__family__ck CHECK (family IN ('laboratory','narrative')),
  CONSTRAINT report_templates__name__ck CHECK (char_length(name) BETWEEN 1 AND 80)
);
CREATE UNIQUE INDEX report_templates__tenant_id_family__default__p_uq ON reporting.report_templates (tenant_id, family) WHERE is_default;

CREATE TABLE reporting.report_template_versions (
  id uuid NOT NULL, tenant_id uuid NOT NULL, template_id uuid NOT NULL, version_no integer NOT NULL,
  status text NOT NULL DEFAULT 'draft', config jsonb NOT NULL, config_sha256 text NOT NULL,
  published_at timestamptz, published_by uuid,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT report_template_versions__pk PRIMARY KEY (id),
  CONSTRAINT report_template_versions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT report_template_versions__tenant_id_template_id_version_no__uq UNIQUE (tenant_id, template_id, version_no),
  CONSTRAINT report_template_versions__template__fk FOREIGN KEY (tenant_id, template_id) REFERENCES reporting.report_templates (tenant_id, id),
  CONSTRAINT report_template_versions__status__ck CHECK (status IN ('draft','published','retired')),
  CONSTRAINT report_template_versions__config__ck CHECK (jsonb_typeof(config) = 'object' AND octet_length(config::text) <= 32768),
  CONSTRAINT report_template_versions__sha__ck CHECK (config_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX report_template_versions__tenant_id_template_id__draft__p_uq ON reporting.report_template_versions (tenant_id, template_id) WHERE status = 'draft';
CREATE UNIQUE INDEX report_template_versions__tenant_id_template_id__published__p_uq ON reporting.report_template_versions (tenant_id, template_id) WHERE status = 'published';
ALTER TABLE reporting.report_templates ADD CONSTRAINT report_templates__current_version__fk
  FOREIGN KEY (tenant_id, current_version_id) REFERENCES reporting.report_template_versions (tenant_id, id);
-- published versions immutable (only status published → retired):
CREATE TRIGGER report_template_versions__mutable_columns BEFORE UPDATE ON reporting.report_template_versions
  FOR EACH ROW WHEN (OLD.status <> 'draft') EXECUTE FUNCTION app.enforce_mutable_columns('status','updated_at','updated_by','version');

CREATE TABLE reporting.narrative_templates (
  id uuid NOT NULL, tenant_id uuid NOT NULL, code text NOT NULL, name text NOT NULL, kind text NOT NULL,
  test_id uuid, sections jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT narrative_templates__pk PRIMARY KEY (id),
  CONSTRAINT narrative_templates__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT narrative_templates__tenant_id_code__uq UNIQUE (tenant_id, code),
  CONSTRAINT narrative_templates__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT narrative_templates__test__fk FOREIGN KEY (tenant_id, test_id) REFERENCES catalog.tests (tenant_id, id),
  CONSTRAINT narrative_templates__code__ck CHECK (code ~ '^[A-Z0-9_]{1,32}$'),
  CONSTRAINT narrative_templates__name__ck CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT narrative_templates__kind__ck CHECK (kind IN ('xray','usg','endoscopy','cytogenetics','other')),
  CONSTRAINT narrative_templates__sections__ck CHECK (jsonb_typeof(sections) = 'array'
     AND jsonb_array_length(sections) BETWEEN 1 AND 12 AND octet_length(sections::text) <= 65536)
);
CREATE INDEX narrative_templates__tenant_id_test_id__p_idx ON reporting.narrative_templates (tenant_id, test_id) WHERE test_id IS NOT NULL;

CREATE TABLE reporting.g_cs_reasons (
  set_name text NOT NULL, code text NOT NULL, display text NOT NULL, system text NOT NULL DEFAULT 'lims',
  system_version text NOT NULL DEFAULT '1', sort_order integer NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_cs_reasons__pk PRIMARY KEY (set_name, code),
  CONSTRAINT g_cs_reasons__set__ck CHECK (set_name IN ('regeneration_reasons','token_revoke_reasons','outsourced_withdraw_reasons','narrative_amend_reasons')),
  CONSTRAINT g_cs_reasons__code__ck CHECK (code ~ '^[a-z0-9_]{1,64}$')
);
CREATE TABLE reporting.cs_reasons (
  id uuid NOT NULL, tenant_id uuid NOT NULL, set_name text NOT NULL, code text NOT NULL, display text NOT NULL,
  system text NOT NULL DEFAULT 'tenant', system_version text NOT NULL DEFAULT '1', sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT cs_reasons__pk PRIMARY KEY (id),
  CONSTRAINT cs_reasons__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT cs_reasons__tenant_id_set_name_code__uq UNIQUE (tenant_id, set_name, code),
  CONSTRAINT cs_reasons__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT cs_reasons__set__ck CHECK (set_name IN ('regeneration_reasons','token_revoke_reasons','outsourced_withdraw_reasons','narrative_amend_reasons')),
  CONSTRAINT cs_reasons__code__ck CHECK (code ~ '^[a-z0-9_]{1,64}$')
);

-- ===================== reporting: clinical =====================
CREATE TABLE reporting.reports (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, branch_id uuid NOT NULL,
  order_id uuid NOT NULL, patient_id uuid NOT NULL, referrer_id uuid, partner_id uuid,
  family text NOT NULL, order_source text NOT NULL, registered_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'open',
  needs_assembly boolean NOT NULL DEFAULT false, needs_assembly_since timestamptz,
  latest_version_no integer NOT NULL DEFAULT 0, released_version_no integer,
  lab_ready_seq integer, lab_approved_set_hash text, lab_completeness text,
  lab_contains_amendment boolean NOT NULL DEFAULT false, regeneration_counter integer NOT NULL DEFAULT 0,
  billing_balance_due_paisa bigint, billing_release_eligible boolean, billing_balance_version integer,
  first_released_at timestamptz, final_released_at timestamptz, review_flag text, cancelled_at timestamptz,
  registration_no text NOT NULL, patient_display_name text, centre_code text NOT NULL, referrer_name text,   -- review fix #6
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT reports__pk PRIMARY KEY (id),
  CONSTRAINT reports__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT reports__tenant_id_order_id_family__uq UNIQUE (tenant_id, order_id, family),
  CONSTRAINT reports__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT reports__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT reports__branch__fk FOREIGN KEY (tenant_id, branch_id) REFERENCES core.branches (tenant_id, id),
  CONSTRAINT reports__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES frontdesk.orders (tenant_id, id),
  CONSTRAINT reports__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT reports__referrer__fk FOREIGN KEY (tenant_id, referrer_id) REFERENCES catalog.doctors (tenant_id, id),
  CONSTRAINT reports__family__ck CHECK (family IN ('laboratory','narrative')),
  CONSTRAINT reports__source__ck CHECK (order_source IN ('front_desk','engagement_booking','home_collection','partner_manifest')),
  CONSTRAINT reports__state__ck CHECK (state IN ('open','cancelled')),
  CONSTRAINT reports__lab_hash__ck CHECK (lab_approved_set_hash IS NULL OR lab_approved_set_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT reports__lab_completeness__ck CHECK (lab_completeness IS NULL OR lab_completeness IN ('complete','partial')),
  CONSTRAINT reports__review_flag__ck CHECK (review_flag IS NULL OR review_flag IN ('released_order_cancelled','released_item_removed')),
  CONSTRAINT reports__snapshot__ck CHECK (char_length(registration_no) BETWEEN 1 AND 20 AND char_length(centre_code) BETWEEN 1 AND 32
     AND (patient_display_name IS NULL OR char_length(patient_display_name) <= 200)
     AND (referrer_name IS NULL OR char_length(referrer_name) <= 200))
);
CREATE INDEX reports__tenant_id_centre_id_state_updated_at__idx ON reporting.reports (tenant_id, centre_id, state, updated_at DESC);
CREATE INDEX reports__tenant_id_needs_assembly__p_idx ON reporting.reports (tenant_id, needs_assembly_since) WHERE needs_assembly;
CREATE INDEX reports__tenant_id_patient_id__idx ON reporting.reports (tenant_id, patient_id);
CREATE INDEX reports__tenant_id_partner_id__p_idx ON reporting.reports (tenant_id, partner_id) WHERE partner_id IS NOT NULL;
CREATE INDEX reports__tenant_id_registration_no__idx ON reporting.reports (tenant_id, registration_no);                 -- review fix #6
CREATE INDEX reports__tenant_id_registered_at__idx ON reporting.reports (tenant_id, registered_at DESC);                -- review fix #42
CREATE INDEX reports__tenant_id_first_released_at__p_idx ON reporting.reports (tenant_id, first_released_at DESC)
  WHERE first_released_at IS NOT NULL;                                                                                  -- review fix #42
CREATE TRIGGER reports__mutable_columns BEFORE UPDATE ON reporting.reports FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('referrer_id','partner_id','state','needs_assembly','needs_assembly_since','latest_version_no',
   'released_version_no','lab_ready_seq','lab_approved_set_hash','lab_completeness','lab_contains_amendment','regeneration_counter',
   'billing_balance_due_paisa','billing_release_eligible','billing_balance_version','first_released_at','final_released_at',
   'review_flag','cancelled_at','patient_display_name','referrer_name','updated_at','updated_by','version');

CREATE TABLE reporting.report_order_items (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, report_id uuid NOT NULL,
  order_id uuid NOT NULL, order_item_id uuid NOT NULL, orderable_id uuid NOT NULL, orderable_kind text NOT NULL,
  test_ids uuid[] NOT NULL, narrative_test_ids uuid[] NOT NULL DEFAULT '{}', priority text NOT NULL,
  item_status text NOT NULL DEFAULT 'active',
  requires_lab boolean NOT NULL, requires_narrative boolean NOT NULL, requires_outsourced boolean NOT NULL,
  lab_ready boolean NOT NULL DEFAULT false, narrative_ready boolean NOT NULL DEFAULT false, outsourced_ready boolean NOT NULL DEFAULT false,
  ready_marker text, approved_results integer NOT NULL DEFAULT 0, amendment_pending boolean NOT NULL DEFAULT false,
  specimen_hint text, specimen_hint_seq integer, items_version integer,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT report_order_items__pk PRIMARY KEY (id),
  CONSTRAINT report_order_items__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT report_order_items__tenant_id_order_item_id_report_id__uq UNIQUE (tenant_id, order_item_id, report_id),
  CONSTRAINT report_order_items__report__fk FOREIGN KEY (tenant_id, report_id) REFERENCES reporting.reports (tenant_id, id),
  CONSTRAINT report_order_items__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT report_order_items__order_item__fk FOREIGN KEY (tenant_id, order_item_id) REFERENCES frontdesk.order_items (tenant_id, id),
  CONSTRAINT report_order_items__kind__ck CHECK (orderable_kind IN ('test','panel')),
  CONSTRAINT report_order_items__priority__ck CHECK (priority IN ('routine','urgent')),
  CONSTRAINT report_order_items__status__ck CHECK (item_status IN ('active','removed','cancelled')),
  CONSTRAINT report_order_items__tests__ck CHECK (cardinality(test_ids) BETWEEN 1 AND 200),
  CONSTRAINT report_order_items__requires__ck CHECK (requires_lab OR requires_narrative OR requires_outsourced),
  CONSTRAINT report_order_items__marker__ck CHECK (ready_marker IS NULL OR char_length(ready_marker) <= 600),
  CONSTRAINT report_order_items__hint__ck CHECK (specimen_hint IS NULL OR specimen_hint IN ('rejected','recollection_ordered'))
);
CREATE INDEX report_order_items__tenant_id_report_id__idx ON reporting.report_order_items (tenant_id, report_id);
CREATE INDEX report_order_items__tenant_id_requires_outsourced__p_idx ON reporting.report_order_items (tenant_id, report_id)
  WHERE requires_outsourced AND item_status = 'active';                                                                -- O6, review fix #42

CREATE TABLE reporting.report_versions (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, report_id uuid NOT NULL, order_id uuid NOT NULL,
  patient_id uuid NOT NULL, partner_id uuid,                                               -- copies of reports.* (review fix #12)
  version_no integer NOT NULL, status text NOT NULL DEFAULT 'rendering', report_kind text NOT NULL, completeness text NOT NULL,
  order_item_ids uuid[] NOT NULL, content_fingerprint text NOT NULL, approved_set_hash text,
  content_snapshot jsonb NOT NULL, content_sha256 text NOT NULL, template_version_id uuid NOT NULL,
  pdf_object_path text, pdf_sha256 text, pdf_bytes bigint, page_count integer,
  render_attempts integer NOT NULL DEFAULT 0, last_render_error_code text,
  rendering_started_at timestamptz, rendered_at timestamptz, reported_at timestamptz NOT NULL,
  released_at timestamptz, released_by uuid, release_mode text, release_basis text, release_override_id uuid, audiences text[],
  supersedes_version_no integer, superseded_at timestamptz, superseded_by_version_no integer,
  discarded_at timestamptz, discard_reason text, held_basis text, held_checked_at timestamptz,
  regeneration_reason_code text, regeneration_reason_text text,
  smart_summary_json jsonb, smart_summary_id uuid, smart_summary_version text,          -- 08 Addendum A2.3/A2.8
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT report_versions__pk PRIMARY KEY (id),
  CONSTRAINT report_versions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT report_versions__tenant_id_report_id_version_no__uq UNIQUE (tenant_id, report_id, version_no),
  CONSTRAINT report_versions__report__fk FOREIGN KEY (tenant_id, report_id) REFERENCES reporting.reports (tenant_id, id),
  CONSTRAINT report_versions__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT report_versions__patient__fk FOREIGN KEY (tenant_id, patient_id) REFERENCES frontdesk.patients (tenant_id, id),
  CONSTRAINT report_versions__template__fk FOREIGN KEY (tenant_id, template_version_id) REFERENCES reporting.report_template_versions (tenant_id, id),
  CONSTRAINT report_versions__status__ck CHECK (status IN ('rendering','rendered','render_failed','released','superseded','discarded')),
  CONSTRAINT report_versions__kind__ck CHECK (report_kind IN ('final','partial','preliminary','amended','addendum')),   -- 08 R1
  CONSTRAINT report_versions__completeness__ck CHECK (completeness IN ('complete','partial')),
  CONSTRAINT report_versions__items__ck CHECK (cardinality(order_item_ids) BETWEEN 1 AND 200),
  CONSTRAINT report_versions__hashes__ck CHECK (content_fingerprint ~ '^[0-9a-f]{64}$' AND content_sha256 ~ '^[0-9a-f]{64}$'
     AND (approved_set_hash IS NULL OR approved_set_hash ~ '^[0-9a-f]{64}$') AND (pdf_sha256 IS NULL OR pdf_sha256 ~ '^[0-9a-f]{64}$')),
  CONSTRAINT report_versions__path__ck CHECK (pdf_object_path IS NULL OR pdf_object_path =
     tenant_id::text || '/' || to_char(created_at AT TIME ZONE 'UTC', 'YYYY/MM') || '/' || report_id::text || '-v' || version_no::text || '.pdf'),
  CONSTRAINT report_versions__pdf_present__ck CHECK (status NOT IN ('rendered','released','superseded')
     OR (pdf_object_path IS NOT NULL AND pdf_sha256 IS NOT NULL AND page_count > 0 AND pdf_bytes > 0)),
  CONSTRAINT report_versions__released__ck CHECK (status NOT IN ('released','superseded')
     OR (released_at IS NOT NULL AND release_basis IS NOT NULL AND audiences IS NOT NULL AND release_mode IS NOT NULL)),
  CONSTRAINT report_versions__mode__ck CHECK (release_mode IS NULL OR release_mode IN ('manual','bulk','auto')),
  CONSTRAINT report_versions__basis__ck CHECK (release_basis IS NULL OR release_basis IN ('paid_in_full','zero_balance','credit_party','override','policy_not_enforced')),
  CONSTRAINT report_versions__audiences__ck CHECK (audiences IS NULL OR (audiences <@ ARRAY['patient','referrer','centre','partner','print_only'] AND cardinality(audiences) BETWEEN 1 AND 5)),
  CONSTRAINT report_versions__discard__ck CHECK (discard_reason IS NULL OR discard_reason IN ('superseded_unreleased','order_cancelled')),
  CONSTRAINT report_versions__held__ck CHECK (held_basis IS NULL OR held_basis IN ('due_outstanding','no_invoice')),
  CONSTRAINT report_versions__regen__ck CHECK (regeneration_reason_text IS NULL OR char_length(regeneration_reason_text) <= 500),
  CONSTRAINT report_versions__smart_summary__ck CHECK (                                  -- 08 A2.3/A2.8: all three or none
       (smart_summary_json IS NULL AND smart_summary_id IS NULL AND smart_summary_version IS NULL)
    OR (smart_summary_json IS NOT NULL AND smart_summary_id IS NOT NULL AND smart_summary_version IS NOT NULL
        AND jsonb_typeof(smart_summary_json) = 'object' AND char_length(smart_summary_version) BETWEEN 1 AND 32))   -- object/length [CONV]
);
CREATE UNIQUE INDEX report_versions__tenant_id_report_id__released__p_uq ON reporting.report_versions (tenant_id, report_id) WHERE status = 'released';
CREATE INDEX report_versions__tenant_id_status_created_at__p_idx ON reporting.report_versions (tenant_id, status, created_at)
  WHERE status IN ('rendering','rendered','render_failed');
CREATE INDEX report_versions__tenant_id_released_at__p_idx ON reporting.report_versions (tenant_id, released_at, id) WHERE released_at IS NOT NULL;
CREATE INDEX report_versions__tenant_id_patient_id__p_idx ON reporting.report_versions (tenant_id, patient_id)
  WHERE status IN ('released','superseded');                                                 -- patient-actor policy / getReleasedReports
CREATE INDEX report_versions__tenant_id_partner_id__p_idx ON reporting.report_versions (tenant_id, partner_id)
  WHERE partner_id IS NOT NULL AND status IN ('released','superseded');                       -- partner-actor policy
CREATE TRIGGER report_versions__mutable_columns BEFORE UPDATE ON reporting.report_versions FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('status','render_attempts','last_render_error_code','rendering_started_at','rendered_at',
   'pdf_object_path','pdf_sha256','pdf_bytes','page_count','released_at','released_by','release_mode','release_basis',
   'release_override_id','audiences','supersedes_version_no','superseded_at','superseded_by_version_no','discarded_at',
   'discard_reason','held_basis','held_checked_at','updated_at','updated_by','version');

CREATE FUNCTION reporting.tg_report_versions_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.pdf_object_path IS NOT NULL AND (NEW.pdf_object_path IS DISTINCT FROM OLD.pdf_object_path
       OR NEW.pdf_sha256 IS DISTINCT FROM OLD.pdf_sha256 OR NEW.pdf_bytes IS DISTINCT FROM OLD.pdf_bytes
       OR NEW.page_count IS DISTINCT FROM OLD.page_count) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'reporting.report_versions pdf';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'rendering'     AND NEW.status IN ('rendered','render_failed','discarded')) OR
       (OLD.status = 'render_failed' AND NEW.status IN ('rendering','discarded')) OR
       (OLD.status = 'rendered'      AND NEW.status IN ('released','discarded')) OR
       (OLD.status = 'released'      AND NEW.status = 'superseded')) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'reporting.report_versions status';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER report_versions__guard BEFORE UPDATE ON reporting.report_versions FOR EACH ROW EXECUTE FUNCTION reporting.tg_report_versions_guard();

CREATE TABLE reporting.qr_tokens (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, report_id uuid NOT NULL, report_version_id uuid NOT NULL,
  token_sha256 bytea NOT NULL, lab_name_snapshot text NOT NULL, patient_display_snapshot text NOT NULL,
  panel_names_snapshot text[] NOT NULL, issued_at timestamptz NOT NULL,
  revoked_at timestamptz, revoked_by uuid, revoke_reason_code text, revoke_reason_text text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT qr_tokens__pk PRIMARY KEY (id),
  CONSTRAINT qr_tokens__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT qr_tokens__tenant_id_report_version_id__uq UNIQUE (tenant_id, report_version_id),
  CONSTRAINT qr_tokens__version__fk FOREIGN KEY (tenant_id, report_version_id) REFERENCES reporting.report_versions (tenant_id, id),
  CONSTRAINT qr_tokens__report__fk FOREIGN KEY (tenant_id, report_id) REFERENCES reporting.reports (tenant_id, id),
  CONSTRAINT qr_tokens__sha__ck CHECK (octet_length(token_sha256) = 32),   -- 08 R24
  CONSTRAINT qr_tokens__len__ck CHECK (char_length(lab_name_snapshot) <= 160 AND char_length(patient_display_snapshot) <= 60
     AND cardinality(panel_names_snapshot) <= 20 AND (revoke_reason_text IS NULL OR char_length(revoke_reason_text) <= 500))
);
CREATE UNIQUE INDEX qr_tokens__token_sha256__uq ON reporting.qr_tokens (token_sha256);       -- global: CR-C6-002
CREATE TRIGGER qr_tokens__mutable_columns BEFORE UPDATE ON reporting.qr_tokens FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('revoked_at','revoked_by','revoke_reason_code','revoke_reason_text','updated_at','updated_by','version');

CREATE TABLE reporting.deliveries (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid,
  channel text NOT NULL, purpose text NOT NULL, template_code text,                               -- NULL only for print/portal (review fix #5)
  recipient_kind text NOT NULL, recipient_id uuid, destination_masked text, destination_sha256 bytea, destination_e164 text,
  params jsonb NOT NULL DEFAULT '{}', language text NOT NULL DEFAULT 'en', idempotency_key text NOT NULL,
  related_entity_type text, related_entity_id uuid, report_id uuid, report_version_no integer, deferred_link jsonb, link_id uuid,
  status text NOT NULL, failure_code text, attempt_no integer NOT NULL DEFAULT 1,
  channel_account_id uuid, provider_kind text, provider_message_id text, fallback_of_delivery_id uuid, fallback_check_at timestamptz,
  queued_at timestamptz, sent_at timestamptz, delivered_at timestamptz, read_at timestamptz, failed_at timestamptz, suppressed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT deliveries__pk PRIMARY KEY (id),
  CONSTRAINT deliveries__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT deliveries__tenant_id_idempotency_key__uq UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT deliveries__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT deliveries__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT deliveries__template__fk FOREIGN KEY (template_code) REFERENCES reporting.g_message_templates (code),
  CONSTRAINT deliveries__report__fk FOREIGN KEY (tenant_id, report_id) REFERENCES reporting.reports (tenant_id, id),
  CONSTRAINT deliveries__account__fk FOREIGN KEY (tenant_id, channel_account_id) REFERENCES reporting.channel_accounts (tenant_id, id),
  CONSTRAINT deliveries__fallback__fk FOREIGN KEY (tenant_id, fallback_of_delivery_id) REFERENCES reporting.deliveries (tenant_id, id),
  CONSTRAINT deliveries__channel__ck CHECK (channel IN ('whatsapp','sms','email','print','portal')),
  CONSTRAINT deliveries__template_presence__ck CHECK ((channel IN ('print','portal')) = (template_code IS NULL)),
  CONSTRAINT deliveries__purpose__ck CHECK (purpose IN ('registration_confirmation','report_ready','otp','dues_reminder',
    'recollection_request','critical_value_alert','booking_confirmation','visit_assignment','follow_up_reminder',
    'scheduled_report_ready','booking_cancelled','booking_reminder')),   -- 08 R13
  CONSTRAINT deliveries__recipient__ck CHECK (recipient_kind IN ('patient','referrer','centre','partner','staff','phone_otp')),
  CONSTRAINT deliveries__e164__ck CHECK (destination_e164 IS NULL OR (recipient_kind = 'phone_otp' AND destination_e164 ~ '^\+[1-9][0-9]{7,14}$')),
  CONSTRAINT deliveries__dest__ck CHECK ((destination_masked IS NULL OR char_length(destination_masked) <= 40)
     AND (destination_sha256 IS NULL OR octet_length(destination_sha256) = 32)),
  CONSTRAINT deliveries__language__ck CHECK (language IN ('en','ne')),
  CONSTRAINT deliveries__key__ck CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  CONSTRAINT deliveries__related__ck CHECK (related_entity_type IS NULL OR related_entity_type IN ('order','report','specimen','booking','visit','critical_event','report_run')),
  CONSTRAINT deliveries__status__ck CHECK (status IN ('queued','sent','delivered','read','failed','suppressed')),
  CONSTRAINT deliveries__provider__ck CHECK (provider_kind IS NULL OR provider_kind IN ('recording','whatsapp_cloud_api','sms_sparrow','sms_aakash','email_smtp_relay')),
  CONSTRAINT deliveries__params__ck CHECK (jsonb_typeof(params) = 'object' AND octet_length(params::text) <= 2048)
);
CREATE INDEX deliveries__tenant_id_report_id_created_at__idx ON reporting.deliveries (tenant_id, report_id, created_at DESC);
CREATE INDEX deliveries__tenant_id_status_fallback_check_at__p_idx ON reporting.deliveries (tenant_id, status, fallback_check_at) WHERE status IN ('queued','sent');
CREATE UNIQUE INDEX deliveries__tenant_id_channel_account_id_provider_message_id__p_uq ON reporting.deliveries (tenant_id, channel_account_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX deliveries__tenant_id_fallback_of_delivery_id__p_uq ON reporting.deliveries (tenant_id, fallback_of_delivery_id) WHERE fallback_of_delivery_id IS NOT NULL;
CREATE INDEX deliveries__tenant_id_created_at__idx ON reporting.deliveries (tenant_id, created_at);
CREATE INDEX deliveries__tenant_id_related_entity_id__p_idx ON reporting.deliveries (tenant_id, related_entity_id) WHERE related_entity_id IS NOT NULL;
CREATE INDEX deliveries__tenant_id_purpose_created_at__idx ON reporting.deliveries (tenant_id, purpose, created_at DESC);   -- listCriticalAlerts
CREATE TRIGGER deliveries__mutable_columns BEFORE UPDATE ON reporting.deliveries FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('status','failure_code','attempt_no','channel_account_id','provider_kind','provider_message_id','link_id',
   'fallback_check_at','queued_at','sent_at','delivered_at','read_at','failed_at','suppressed_at','destination_masked','destination_sha256',
   'params','destination_e164','updated_at','updated_by','version');
CREATE FUNCTION reporting.tg_deliveries_scrub_only() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.params IS DISTINCT FROM OLD.params AND NEW.params IS DISTINCT FROM (OLD.params - 'url' - 'otp_code') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'reporting.deliveries params';
  END IF;
  IF NEW.destination_e164 IS DISTINCT FROM OLD.destination_e164 AND NEW.destination_e164 IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'reporting.deliveries destination';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deliveries__scrub_only BEFORE UPDATE ON reporting.deliveries FOR EACH ROW EXECUTE FUNCTION reporting.tg_deliveries_scrub_only();

CREATE TABLE reporting.portal_links (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, report_id uuid NOT NULL, bound_version_no integer NOT NULL,
  channel text NOT NULL, recipient_kind text NOT NULL, recipient_ref_id uuid, otp_channel text,
  destination_masked text, destination_sha256 bytea, patient_display_snapshot text NOT NULL,
  token_sha256 bytea NOT NULL, expires_at timestamptz NOT NULL,
  revoked_at timestamptz, revoked_by uuid, revoke_reason_code text,
  delivery_id uuid, reissued_from_link_id uuid, last_used_at timestamptz, use_count integer NOT NULL DEFAULT 0,
  reissue_count_day integer NOT NULL DEFAULT 0, reissue_day date,
  redeem_failures smallint NOT NULL DEFAULT 0,                                                  -- 08 A13 D-30
  purpose text NOT NULL DEFAULT 'report',                                                       -- 08 A21.1: 'dues' = dues-only link
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT portal_links__pk PRIMARY KEY (id),
  CONSTRAINT portal_links__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT portal_links__report__fk FOREIGN KEY (tenant_id, report_id) REFERENCES reporting.reports (tenant_id, id),
  CONSTRAINT portal_links__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT portal_links__delivery__fk FOREIGN KEY (tenant_id, delivery_id) REFERENCES reporting.deliveries (tenant_id, id),
  CONSTRAINT portal_links__reissued__fk FOREIGN KEY (tenant_id, reissued_from_link_id) REFERENCES reporting.portal_links (tenant_id, id),
  CONSTRAINT portal_links__channel__ck CHECK (channel IN ('whatsapp','sms','email','print_qr','patient_app')),
  CONSTRAINT portal_links__recipient__ck CHECK (recipient_kind IN ('patient','referrer','centre','partner')),
  CONSTRAINT portal_links__otp_channel__ck CHECK (otp_channel IS NULL OR otp_channel IN ('sms','email')),
  CONSTRAINT portal_links__sha__ck CHECK (octet_length(token_sha256) = 32 AND (destination_sha256 IS NULL OR octet_length(destination_sha256) = 32)),   -- 08 R24
  CONSTRAINT portal_links__len__ck CHECK (char_length(patient_display_snapshot) <= 60 AND (destination_masked IS NULL OR char_length(destination_masked) <= 40)),
  CONSTRAINT portal_links__ttl__ck CHECK (expires_at > created_at AND expires_at <= created_at + interval '90 days'),    -- 04 A10
  CONSTRAINT portal_links__redeem_failures__ck CHECK (redeem_failures BETWEEN 0 AND 5),                                -- 08 A13 D-30
  CONSTRAINT portal_links__purpose__ck CHECK (purpose IN ('report','dues')
     AND (purpose = 'report' OR (recipient_kind = 'patient' AND channel IN ('sms','whatsapp'))))                     -- 08 A21.1
);
CREATE UNIQUE INDEX portal_links__token_sha256__uq ON reporting.portal_links (token_sha256);  -- global: CR-C6-002
CREATE INDEX portal_links__tenant_id_report_id__idx ON reporting.portal_links (tenant_id, report_id);
CREATE INDEX portal_links__tenant_id_delivery_id__p_idx ON reporting.portal_links (tenant_id, delivery_id) WHERE delivery_id IS NOT NULL;
ALTER TABLE reporting.deliveries ADD CONSTRAINT deliveries__link__fk FOREIGN KEY (tenant_id, link_id) REFERENCES reporting.portal_links (tenant_id, id);  -- circular pair: added after portal_links
CREATE TRIGGER portal_links__mutable_columns BEFORE UPDATE ON reporting.portal_links FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('revoked_at','revoked_by','revoke_reason_code','delivery_id','last_used_at','use_count',
   'reissue_count_day','reissue_day','redeem_failures','updated_at','updated_by','version');
-- review fix #35: revocation is one-way; portal actors and the lookup role may touch only their own counters
CREATE FUNCTION reporting.tg_portal_links_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_changed text[];
BEGIN
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
       OR NEW.revoke_reason_code IS DISTINCT FROM OLD.revoke_reason_code) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'reporting.portal_links revoked';
  END IF;
  IF OLD.delivery_id IS NOT NULL AND NEW.delivery_id IS DISTINCT FROM OLD.delivery_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'reporting.portal_links delivery';
  END IF;
  IF NEW.redeem_failures < OLD.redeem_failures THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'reporting.portal_links redeem_failures';
  END IF;
  SELECT coalesce(array_agg(n.key), '{}') INTO v_changed
    FROM jsonb_each(to_jsonb(NEW)) n JOIN jsonb_each(to_jsonb(OLD)) o ON o.key = n.key
   WHERE n.value IS DISTINCT FROM o.value;
  IF current_user = 'lims_reporting_lookup' THEN          -- inside app.reporting_redeem_link_for_app (no claims)
    IF NOT (v_changed <@ ARRAY['redeem_failures','updated_at','version']) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'reporting.portal_links lookup';
    END IF;
  ELSIF (SELECT app.current_actor_type()) = 'portal'
     AND NOT (v_changed <@ ARRAY['last_used_at','use_count','reissue_count_day','reissue_day','updated_at','updated_by','version']) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'reporting.portal_links portal';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER portal_links__guard BEFORE UPDATE ON reporting.portal_links FOR EACH ROW EXECUTE FUNCTION reporting.tg_portal_links_guard();
-- Row audit (§1 note): C0 attaches these two triggers instead of its default single audit trigger on this table.
CREATE TRIGGER portal_links__audit_ins AFTER INSERT ON reporting.portal_links FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE TRIGGER portal_links__audit_upd AFTER UPDATE ON reporting.portal_links FOR EACH ROW
  WHEN ((to_jsonb(OLD) - ARRAY['redeem_failures','updated_at','version']) IS DISTINCT FROM
        (to_jsonb(NEW) - ARRAY['redeem_failures','updated_at','version']))
  EXECUTE FUNCTION app.tg_row_audit();

CREATE TABLE reporting.otp_challenges (
  id uuid NOT NULL, tenant_id uuid NOT NULL, link_id uuid NOT NULL, channel text NOT NULL,
  destination_sha256 bytea,                                                                -- NULL until resolved by the worker (08 A13 D-31)
  code_hmac bytea, status text NOT NULL DEFAULT 'pending_send', attempts smallint NOT NULL DEFAULT 0,   -- bytea: 08 Addendum A2.4
  failure_code text,
  expires_at timestamptz NOT NULL, verified_at timestamptz, delivery_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT otp_challenges__pk PRIMARY KEY (id),
  CONSTRAINT otp_challenges__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT otp_challenges__link__fk FOREIGN KEY (tenant_id, link_id) REFERENCES reporting.portal_links (tenant_id, id),
  CONSTRAINT otp_challenges__channel__ck CHECK (channel IN ('sms','email')),
  CONSTRAINT otp_challenges__dest__ck CHECK (destination_sha256 IS NULL OR octet_length(destination_sha256) = 32),   -- 08 R24
  CONSTRAINT otp_challenges__dest_resolved__ck CHECK (status IN ('pending_send','failed','superseded','expired')
     OR destination_sha256 IS NOT NULL),                                                   -- 08 A13 D-31 (extended, §2.6)
  CONSTRAINT otp_challenges__hmac__ck CHECK (code_hmac IS NULL OR octet_length(code_hmac) = 32),   -- 08 A2.4 (R24 scope)
  CONSTRAINT otp_challenges__status__ck CHECK (status IN ('pending_send','pending','verified','exhausted','expired','superseded','failed')),
  CONSTRAINT otp_challenges__failure__ck CHECK ((failure_code IS NULL OR failure_code IN ('no_contact','send_rate_limited'))
     AND (status <> 'failed' OR failure_code IS NOT NULL)),
  CONSTRAINT otp_challenges__attempts__ck CHECK (attempts BETWEEN 0 AND 5),                  -- 04 A9
  CONSTRAINT otp_challenges__ttl__ck CHECK (expires_at <= created_at + interval '10 minutes') -- 04 A9
);
CREATE INDEX otp_challenges__tenant_id_link_id_created_at__idx ON reporting.otp_challenges (tenant_id, link_id, created_at DESC);
CREATE INDEX otp_challenges__tenant_id_expires_at__idx ON reporting.otp_challenges (tenant_id, expires_at);

CREATE TABLE reporting.portal_sessions (
  id uuid NOT NULL, tenant_id uuid NOT NULL, link_id uuid NOT NULL, report_id uuid NOT NULL, token_sha256 bytea NOT NULL,
  last_seen_at timestamptz NOT NULL, idle_expires_at timestamptz NOT NULL, absolute_expires_at timestamptz NOT NULL,
  ended_at timestamptz, user_agent_sha256 text,
  link_purpose text NOT NULL DEFAULT 'report',                                              -- copy of portal_links.purpose (08 A21.1)
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT portal_sessions__pk PRIMARY KEY (id),
  CONSTRAINT portal_sessions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT portal_sessions__link__fk FOREIGN KEY (tenant_id, link_id) REFERENCES reporting.portal_links (tenant_id, id),
  CONSTRAINT portal_sessions__sha__ck CHECK (octet_length(token_sha256) = 32),   -- 08 R24
  CONSTRAINT portal_sessions__abs__ck CHECK (absolute_expires_at <= created_at + interval '12 hours'),
  CONSTRAINT portal_sessions__purpose__ck CHECK (link_purpose IN ('report','dues'))
);
CREATE UNIQUE INDEX portal_sessions__token_sha256__uq ON reporting.portal_sessions (token_sha256);  -- global: CR-C6-002
CREATE INDEX portal_sessions__tenant_id_absolute_expires_at__idx ON reporting.portal_sessions (tenant_id, absolute_expires_at);

CREATE TABLE reporting.delivery_attempts (
  id uuid NOT NULL, tenant_id uuid NOT NULL, delivery_id uuid NOT NULL, attempt_no integer NOT NULL,
  started_at timestamptz NOT NULL, finished_at timestamptz, outcome text NOT NULL, error_code text,
  provider_status_raw text, latency_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT delivery_attempts__pk PRIMARY KEY (id),
  CONSTRAINT delivery_attempts__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT delivery_attempts__tenant_id_delivery_id_attempt_no__uq UNIQUE (tenant_id, delivery_id, attempt_no),
  CONSTRAINT delivery_attempts__delivery__fk FOREIGN KEY (tenant_id, delivery_id) REFERENCES reporting.deliveries (tenant_id, id),
  CONSTRAINT delivery_attempts__outcome__ck CHECK (outcome IN ('accepted','retryable_error','permanent_error','suppressed','circuit_open')),
  CONSTRAINT delivery_attempts__len__ck CHECK ((error_code IS NULL OR char_length(error_code) <= 64) AND (provider_status_raw IS NULL OR char_length(provider_status_raw) <= 64))
);

CREATE TABLE reporting.provider_events (
  id uuid NOT NULL, tenant_id uuid NOT NULL, channel_account_id uuid NOT NULL, provider_kind text NOT NULL,
  provider_message_id text NOT NULL, status_raw text NOT NULL, mapped_status text NOT NULL, occurred_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(), delivery_id uuid, applied_at timestamptz, ignored_reason text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT provider_events__pk PRIMARY KEY (id),
  CONSTRAINT provider_events__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT provider_events__dedupe__uq UNIQUE (tenant_id, channel_account_id, provider_message_id, mapped_status),
  CONSTRAINT provider_events__account__fk FOREIGN KEY (tenant_id, channel_account_id) REFERENCES reporting.channel_accounts (tenant_id, id),
  CONSTRAINT provider_events__mapped__ck CHECK (mapped_status IN ('sent','delivered','read','failed')),
  CONSTRAINT provider_events__len__ck CHECK (char_length(provider_message_id) <= 128 AND char_length(status_raw) <= 64),
  CONSTRAINT provider_events__ignored__ck CHECK (ignored_reason IS NULL OR ignored_reason IN ('unknown_message','duplicate','backwards'))
);
CREATE INDEX provider_events__tenant_id_received_at__idx ON reporting.provider_events (tenant_id, received_at);
CREATE TRIGGER provider_events__mutable_columns BEFORE UPDATE ON reporting.provider_events FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('applied_at','delivery_id','ignored_reason');

CREATE TABLE reporting.narrative_reports (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, report_id uuid NOT NULL, order_id uuid NOT NULL,
  order_item_id uuid NOT NULL, test_id uuid NOT NULL, template_kind text NOT NULL, status text NOT NULL DEFAULT 'draft',
  current_version_no integer NOT NULL DEFAULT 1, signed_version_no integer,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT narrative_reports__pk PRIMARY KEY (id),
  CONSTRAINT narrative_reports__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT narrative_reports__tenant_id_order_item_id_test_id__uq UNIQUE (tenant_id, order_item_id, test_id),
  CONSTRAINT narrative_reports__report__fk FOREIGN KEY (tenant_id, report_id) REFERENCES reporting.reports (tenant_id, id),
  CONSTRAINT narrative_reports__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT narrative_reports__item__fk FOREIGN KEY (tenant_id, order_item_id) REFERENCES frontdesk.order_items (tenant_id, id),
  CONSTRAINT narrative_reports__test__fk FOREIGN KEY (tenant_id, test_id) REFERENCES catalog.tests (tenant_id, id),
  CONSTRAINT narrative_reports__kind__ck CHECK (template_kind IN ('xray','usg','endoscopy','cytogenetics','other')),
  CONSTRAINT narrative_reports__status__ck CHECK (status IN ('draft','signed','amending','cancelled'))
);
CREATE INDEX narrative_reports__tenant_id_centre_id_status__idx ON reporting.narrative_reports (tenant_id, centre_id, status);

CREATE TABLE reporting.input_files (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, order_id uuid NOT NULL, order_item_id uuid,
  narrative_report_id uuid, kind text NOT NULL, state text NOT NULL DEFAULT 'pending_scan',
  original_filename text NOT NULL, declared_mime text NOT NULL, detected_mime text, size_bytes bigint NOT NULL,
  sha256_original text NOT NULL, quarantine_object_path text NOT NULL, sanitized_object_path text, sanitized_sha256 text,
  page_count integer, image_width integer, image_height integer, external_lab_name text, caption text,
  sort_order smallint NOT NULL DEFAULT 0, confirmed_by uuid, confirmed_at timestamptz,
  withdrawn_reason_code text, withdrawn_reason_text text, last_error_code text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT input_files__pk PRIMARY KEY (id),
  CONSTRAINT input_files__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT input_files__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT input_files__item__fk FOREIGN KEY (tenant_id, order_item_id) REFERENCES frontdesk.order_items (tenant_id, id),
  CONSTRAINT input_files__narrative__fk FOREIGN KEY (tenant_id, narrative_report_id) REFERENCES reporting.narrative_reports (tenant_id, id),
  CONSTRAINT input_files__kind__ck CHECK (kind IN ('outsourced_pdf','narrative_image')),
  CONSTRAINT input_files__state__ck CHECK (state IN ('pending_scan','scanning','quarantined','sanitizing','ready','rejected','confirmed','withdrawn')),
  CONSTRAINT input_files__mime__ck CHECK (declared_mime IN ('application/pdf','image/png','image/jpeg')
     AND (detected_mime IS NULL OR detected_mime IN ('application/pdf','image/png','image/jpeg'))),
  CONSTRAINT input_files__size__ck CHECK (size_bytes BETWEEN 1 AND 15728640),                -- 02-CV §10.2
  CONSTRAINT input_files__paths__ck CHECK (quarantine_object_path LIKE tenant_id::text || '/quarantine/%'
     AND (sanitized_object_path IS NULL OR sanitized_object_path LIKE tenant_id::text || '/%')),
  CONSTRAINT input_files__kind_fields__ck CHECK ((kind = 'outsourced_pdf' AND order_item_id IS NOT NULL AND external_lab_name IS NOT NULL)
     OR (kind = 'narrative_image' AND narrative_report_id IS NOT NULL)),
  CONSTRAINT input_files__len__ck CHECK (char_length(original_filename) <= 200 AND (external_lab_name IS NULL OR char_length(external_lab_name) <= 120)
     AND (caption IS NULL OR char_length(caption) <= 200) AND (withdrawn_reason_text IS NULL OR char_length(withdrawn_reason_text) <= 500)),
  CONSTRAINT input_files__sha__ck CHECK (sha256_original ~ '^[0-9a-f]{64}$' AND (sanitized_sha256 IS NULL OR sanitized_sha256 ~ '^[0-9a-f]{64}$'))
);
CREATE INDEX input_files__tenant_id_order_item_id__idx ON reporting.input_files (tenant_id, order_item_id);
CREATE INDEX input_files__tenant_id_state__p_idx ON reporting.input_files (tenant_id, state) WHERE state IN ('pending_scan','scanning','sanitizing');
CREATE INDEX input_files__tenant_id_narrative_report_id__p_idx ON reporting.input_files (tenant_id, narrative_report_id) WHERE narrative_report_id IS NOT NULL;
CREATE TRIGGER input_files__mutable_columns BEFORE UPDATE ON reporting.input_files FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('state','detected_mime','sanitized_object_path','sanitized_sha256','page_count','image_width','image_height',
   'caption','sort_order','confirmed_by','confirmed_at','withdrawn_reason_code','withdrawn_reason_text','last_error_code','updated_at','updated_by','version');

CREATE TABLE reporting.narrative_versions (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, narrative_report_id uuid NOT NULL, version_no integer NOT NULL,
  status text NOT NULL DEFAULT 'draft', template_id uuid, sections jsonb NOT NULL, image_file_ids uuid[] NOT NULL DEFAULT '{}',
  signed_by_membership_id uuid, signed_at timestamptz, content_sha256 text,
  amendment_of_version_no integer, amendment_reason_code text, amendment_reason_text text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT narrative_versions__pk PRIMARY KEY (id),
  CONSTRAINT narrative_versions__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT narrative_versions__tenant_id_narrative_report_id_version_no__uq UNIQUE (tenant_id, narrative_report_id, version_no),
  CONSTRAINT narrative_versions__narrative__fk FOREIGN KEY (tenant_id, narrative_report_id) REFERENCES reporting.narrative_reports (tenant_id, id),
  CONSTRAINT narrative_versions__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT narrative_versions__template__fk FOREIGN KEY (tenant_id, template_id) REFERENCES reporting.narrative_templates (tenant_id, id),
  CONSTRAINT narrative_versions__signer__fk FOREIGN KEY (tenant_id, signed_by_membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT narrative_versions__status__ck CHECK (status IN ('draft','signed','superseded','cancelled')),
  CONSTRAINT narrative_versions__sections__ck CHECK (jsonb_typeof(sections) = 'array' AND jsonb_array_length(sections) <= 12
     AND octet_length(sections::text) <= 262144),
  CONSTRAINT narrative_versions__images__ck CHECK (cardinality(image_file_ids) <= 12),
  CONSTRAINT narrative_versions__signed__ck CHECK (status NOT IN ('signed','superseded') OR (signed_by_membership_id IS NOT NULL
     AND signed_at IS NOT NULL AND content_sha256 ~ '^[0-9a-f]{64}$')),
  CONSTRAINT narrative_versions__reason__ck CHECK (amendment_reason_text IS NULL OR char_length(amendment_reason_text) <= 500)
);
CREATE FUNCTION reporting.tg_narrative_versions_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.status IN ('signed','superseded','cancelled') THEN
    IF (to_jsonb(OLD) - ARRAY['status','updated_at','updated_by','version']) IS DISTINCT FROM
       (to_jsonb(NEW) - ARRAY['status','updated_at','updated_by','version'])
       OR NOT (OLD.status = NEW.status OR (OLD.status = 'signed' AND NEW.status = 'superseded')) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'reporting.narrative_versions';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER narrative_versions__guard BEFORE UPDATE ON reporting.narrative_versions FOR EACH ROW EXECUTE FUNCTION reporting.tg_narrative_versions_guard();

CREATE TABLE reporting.print_jobs (
  id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid NOT NULL, kind text NOT NULL,
  report_version_ids uuid[] NOT NULL DEFAULT '{}', excluded_ids uuid[] NOT NULL DEFAULT '{}', template_version_id uuid,
  variant text NOT NULL, copies smallint NOT NULL DEFAULT 1, draft_watermark boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'rendering', object_path text, sha256 text, page_count integer,
  expires_at timestamptz NOT NULL, error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL, version integer NOT NULL DEFAULT 1,
  CONSTRAINT print_jobs__pk PRIMARY KEY (id),
  CONSTRAINT print_jobs__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT print_jobs__centre__fk FOREIGN KEY (tenant_id, centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT print_jobs__kind__ck CHECK (kind IN ('single','bulk','template_preview')),
  CONSTRAINT print_jobs__ids__ck CHECK (cardinality(report_version_ids) <= 200),
  CONSTRAINT print_jobs__variant__ck CHECK (variant IN ('letterhead','plain')),
  CONSTRAINT print_jobs__copies__ck CHECK (copies BETWEEN 1 AND 5),
  CONSTRAINT print_jobs__state__ck CHECK (state IN ('rendering','ready','failed','expired')),
  CONSTRAINT print_jobs__path__ck CHECK (object_path IS NULL OR object_path LIKE tenant_id::text || '/prints/%'),
  CONSTRAINT print_jobs__ttl__ck CHECK (expires_at <= created_at + interval '48 hours')
);
CREATE INDEX print_jobs__tenant_id_expires_at__idx ON reporting.print_jobs (tenant_id, expires_at);

-- ===================== reporting: portal dues payment (08 Addendum A11.1; ships with C15) =====================
CREATE TABLE reporting.portal_payment_requests (
  id uuid NOT NULL, tenant_id uuid NOT NULL, link_id uuid NOT NULL, report_id uuid NOT NULL, order_id uuid NOT NULL,
  gateway text NOT NULL, status text NOT NULL DEFAULT 'queued', review boolean NOT NULL DEFAULT false,
  intent_id uuid, amount_paisa bigint, action_json jsonb, failure_code text,
  intent_expires_at timestamptz, last_checked_at timestamptz, completed_at timestamptz,
  expires_at timestamptz NOT NULL,                                                         -- row retention (E): created_at + 90 days [CONV]
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT portal_payment_requests__pk PRIMARY KEY (id),
  CONSTRAINT portal_payment_requests__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT portal_payment_requests__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT portal_payment_requests__link__fk FOREIGN KEY (tenant_id, link_id) REFERENCES reporting.portal_links (tenant_id, id),
  CONSTRAINT portal_payment_requests__report__fk FOREIGN KEY (tenant_id, report_id) REFERENCES reporting.reports (tenant_id, id),
  CONSTRAINT portal_payment_requests__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES frontdesk.orders (tenant_id, id),
  CONSTRAINT portal_payment_requests__gateway__ck CHECK (gateway IN ('esewa','khalti')),                 -- Fonepay BLOCKED B8
  CONSTRAINT portal_payment_requests__status__ck CHECK (status IN ('queued','ready','completed','failed','expired')),
  CONSTRAINT portal_payment_requests__action__ck CHECK ((status = 'ready' AND NOT review) OR action_json IS NULL),
  CONSTRAINT portal_payment_requests__action_shape__ck CHECK (action_json IS NULL
     OR (jsonb_typeof(action_json) = 'object' AND jsonb_typeof(action_json -> 'url') = 'string' AND octet_length(action_json::text) <= 4096)),
  CONSTRAINT portal_payment_requests__ready__ck CHECK (status NOT IN ('ready','completed') OR (intent_id IS NOT NULL AND amount_paisa IS NOT NULL)),
  CONSTRAINT portal_payment_requests__amount__ck CHECK (amount_paisa IS NULL OR amount_paisa > 0),
  CONSTRAINT portal_payment_requests__failure__ck CHECK ((failure_code IS NULL OR char_length(failure_code) BETWEEN 1 AND 64)
     AND (status <> 'failed' OR failure_code IS NOT NULL)),
  CONSTRAINT portal_payment_requests__completed__ck CHECK (status <> 'completed' OR completed_at IS NOT NULL),
  CONSTRAINT portal_payment_requests__ttl__ck CHECK (expires_at > created_at AND expires_at <= created_at + interval '120 days')
);
CREATE UNIQUE INDEX portal_payment_requests__tenant_id_order_id__open__p_uq ON reporting.portal_payment_requests (tenant_id, order_id)
  WHERE status IN ('queued','ready');
CREATE INDEX portal_payment_requests__tenant_id_link_id_created_at__idx ON reporting.portal_payment_requests (tenant_id, link_id, created_at DESC);
CREATE INDEX portal_payment_requests__tenant_id_intent_expires_at__p_idx ON reporting.portal_payment_requests (tenant_id, intent_expires_at)
  WHERE status = 'ready';
CREATE INDEX portal_payment_requests__tenant_id_expires_at__idx ON reporting.portal_payment_requests (tenant_id, expires_at);
CREATE TRIGGER portal_payment_requests__mutable_columns BEFORE UPDATE ON reporting.portal_payment_requests FOR EACH ROW EXECUTE FUNCTION
  app.enforce_mutable_columns('status','review','intent_id','amount_paisa','action_json','failure_code','intent_expires_at',
   'last_checked_at','completed_at','updated_at','updated_by','version');
CREATE FUNCTION reporting.tg_portal_payment_requests_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.status IN ('completed','failed','expired') AND (to_jsonb(NEW) - ARRAY['updated_at','updated_by','version'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['updated_at','updated_by','version']) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'reporting.portal_payment_requests terminal';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'queued' AND NEW.status IN ('ready','failed')) OR
       (OLD.status = 'ready'  AND NEW.status IN ('completed','failed','expired'))) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'reporting.portal_payment_requests status';
  END IF;
  IF (OLD.intent_id IS NOT NULL AND NEW.intent_id IS DISTINCT FROM OLD.intent_id)
     OR (OLD.amount_paisa IS NOT NULL AND NEW.amount_paisa IS DISTINCT FROM OLD.amount_paisa) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'reporting.portal_payment_requests intent';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER portal_payment_requests__guard BEFORE UPDATE ON reporting.portal_payment_requests FOR EACH ROW
  EXECUTE FUNCTION reporting.tg_portal_payment_requests_guard();
```

`reporting.event_inbox` is created by C0 (03-IC §12). `centre_id` for `print_jobs.kind = 'template_preview'` = the requesting user's working centre (any of their centres; previews contain synthetic data only).

### 6.1 RLS DDL

```sql
-- Repeated for every centre-scoped table: reports, report_order_items, report_versions, qr_tokens, portal_links,
-- narrative_reports, narrative_versions, input_files, print_jobs, centre_contacts  (shown once for reports)
-- `= ANY ((SELECT f())::uuid[])`: the explicit cast is required. Without it PostgreSQL 16 parses `= ANY ((SELECT f()))`
-- as ANY(sub-query) and fails with "operator does not exist: uuid = uuid[]" (checked on a scratch PG 16, review fix pass
-- 2026-11-06); the cast keeps the init-plan caching of the 02-CV §5.8 template.
ALTER TABLE reporting.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting.reports FORCE ROW LEVEL SECURITY;
CREATE POLICY reports__select__tenant_centre ON reporting.reports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())                 -- review fix #34
         AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY reports__insert__tenant_centre ON reporting.reports FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY reports__update__tenant_centre ON reporting.reports FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND ((SELECT app.has_all_centres()) OR centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));

-- Portal read policies
CREATE POLICY reports__select__portal ON reporting.reports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal'
         AND (SELECT app.current_claims() ->> 'portal_stage') = 'session'
         AND id = (SELECT nullif(app.current_claims() ->> 'portal_report_id', '')::uuid));
CREATE POLICY report_versions__select__portal ON reporting.report_versions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal'
         AND (SELECT app.current_claims() ->> 'portal_stage') = 'session'
         AND (SELECT app.current_claims() ->> 'portal_link_purpose') = 'report'                     -- 08 A21.1: dues links see no content
         AND report_id = (SELECT nullif(app.current_claims() ->> 'portal_report_id', '')::uuid)
         AND status IN ('released','superseded'));
CREATE POLICY qr_tokens__select__portal ON reporting.qr_tokens FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal'
         AND (SELECT app.current_claims() ->> 'portal_stage') = 'session'
         AND (SELECT app.current_claims() ->> 'portal_link_purpose') = 'report'                     -- 08 A21.1
         AND report_id = (SELECT nullif(app.current_claims() ->> 'portal_report_id', '')::uuid));
CREATE POLICY portal_links__select__portal ON reporting.portal_links FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND id = (SELECT app.current_actor_id()));
CREATE POLICY portal_links__update__portal ON reporting.portal_links FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND id = (SELECT app.current_actor_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND id = (SELECT app.current_actor_id()));

-- Partner / patient read policies (CR-C13-005, CR-C16-008; 08 R8 rule 1) — reports shown; report_versions and qr_tokens
-- use the same actor predicate through the parent report plus status IN ('released','superseded')
CREATE POLICY reports__select__partner ON reporting.reports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND partner_id = (SELECT app.current_partner_id())
         AND EXISTS (SELECT 1 FROM reporting.report_versions v WHERE v.tenant_id = reports.tenant_id     -- review fix #12
                     AND v.report_id = reports.id AND v.status IN ('released','superseded')));
CREATE POLICY reports__select__patient ON reporting.reports FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
         AND patient_id = ANY ((SELECT app.engagement_patient_ids())::uuid[])
         AND EXISTS (SELECT 1 FROM reporting.report_versions v WHERE v.tenant_id = reports.tenant_id     -- review fix #12
                     AND v.report_id = reports.id AND v.status IN ('released','superseded')));
-- report_versions carries its own patient_id / partner_id copies (§2.3), so these policies do not query reports: a
-- report_versions → reports → report_versions policy chain would be rejected as infinite recursion (review fix #12).
CREATE POLICY report_versions__select__partner ON reporting.report_versions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND status IN ('released','superseded')
         AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY report_versions__select__patient ON reporting.report_versions FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
         AND status IN ('released','superseded')
         AND patient_id = ANY ((SELECT app.engagement_patient_ids())::uuid[]));
CREATE POLICY qr_tokens__select__partner ON reporting.qr_tokens FOR SELECT TO lims_app                 -- review fix #12
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND report_version_id IN (SELECT v.id FROM reporting.report_versions v WHERE v.tenant_id = qr_tokens.tenant_id
                                   AND v.status IN ('released','superseded') AND v.partner_id = (SELECT app.current_partner_id())));
CREATE POLICY qr_tokens__select__patient ON reporting.qr_tokens FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'patient'
         AND report_version_id IN (SELECT v.id FROM reporting.report_versions v WHERE v.tenant_id = qr_tokens.tenant_id
                                   AND v.status IN ('released','superseded') AND v.patient_id = ANY ((SELECT app.engagement_patient_ids())::uuid[])));

-- otp_challenges / portal_sessions: portal (own link) + system; staff never
ALTER TABLE reporting.otp_challenges ENABLE ROW LEVEL SECURITY; ALTER TABLE reporting.otp_challenges FORCE ROW LEVEL SECURITY;
CREATE POLICY otp_challenges__select__portal ON reporting.otp_challenges FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND link_id = (SELECT app.current_actor_id()));
CREATE POLICY otp_challenges__insert__portal ON reporting.otp_challenges FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND link_id = (SELECT app.current_actor_id()));
CREATE POLICY otp_challenges__update__portal ON reporting.otp_challenges FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND link_id = (SELECT app.current_actor_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal' AND link_id = (SELECT app.current_actor_id()));
CREATE POLICY otp_challenges__select__tenant_system ON reporting.otp_challenges FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY otp_challenges__update__tenant_system ON reporting.otp_challenges FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY otp_challenges__delete__tenant_expired ON reporting.otp_challenges FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system'
         AND expires_at < now() - interval '24 hours');
-- portal_sessions: identical pattern (select/insert/update __portal on link_id = actor id; select/update __tenant_system;
-- delete __tenant_expired with coalesce(ended_at, absolute_expires_at) < now() - interval '24 hours')
-- print_jobs: __tenant_centre select/insert/update + delete __tenant_expired (system, expires_at < now())

-- portal_payment_requests (08 A11.1): portal session of the link (select/insert), system (select/update/delete); staff never
ALTER TABLE reporting.portal_payment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting.portal_payment_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY portal_payment_requests__select__portal ON reporting.portal_payment_requests FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal'
         AND (SELECT app.current_claims() ->> 'portal_stage') = 'session' AND link_id = (SELECT app.current_actor_id()));
CREATE POLICY portal_payment_requests__insert__portal ON reporting.portal_payment_requests FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal'
              AND (SELECT app.current_claims() ->> 'portal_stage') = 'session' AND link_id = (SELECT app.current_actor_id())
              AND report_id = (SELECT nullif(app.current_claims() ->> 'portal_report_id', '')::uuid)
              AND EXISTS (SELECT 1 FROM reporting.reports r WHERE r.tenant_id = portal_payment_requests.tenant_id
                          AND r.id = portal_payment_requests.report_id AND r.order_id = portal_payment_requests.order_id));
CREATE POLICY portal_payment_requests__select__tenant_system ON reporting.portal_payment_requests FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY portal_payment_requests__update__tenant_system ON reporting.portal_payment_requests FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');
CREATE POLICY portal_payment_requests__delete__tenant_expired ON reporting.portal_payment_requests FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now());

-- settings: read-only portal policy (portal_payment_gateways, A11.1); staff/system keep the __tenant policies below
CREATE POLICY settings__select__portal ON reporting.settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'portal'
         AND (SELECT app.current_claims() ->> 'portal_stage') = 'session');

-- deliveries: nullable centre
ALTER TABLE reporting.deliveries ENABLE ROW LEVEL SECURITY; ALTER TABLE reporting.deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY deliveries__select__tenant_centre ON reporting.deliveries FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY deliveries__insert__tenant_centre ON reporting.deliveries FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));
CREATE POLICY deliveries__update__tenant_centre ON reporting.deliveries FOR UPDATE TO lims_app
  USING      (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
              AND ((SELECT app.has_all_centres()) OR (centre_id IS NOT NULL AND centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))));

-- tenant-only tables (settings, staff_assignments, referrer_preferences, channel_accounts, message_template_texts,
-- report_templates, report_template_versions, narrative_templates, cs_reasons, delivery_attempts (select/insert only),
-- provider_events): __select__tenant / __insert__tenant / __update__tenant with USING/WITH CHECK
--   tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())   -- CR-C13-011
-- __tenant_centre policies rely on has_all_centres()/current_centre_ids(), which are false/empty for every
-- non-staff actor (08 R3); every one of them also carries (SELECT app.is_staff_or_system()), as written out in the
-- reports template above (defence in depth, 08 R10 item 5; review fix #34). deliveries__*__tenant_centre likewise.
```

### 6.2 Lookup role and DEFINER functions (CR-C6-002; C0 adds to the inventory)

Final check 2026-11-06 (08 A25 D-201): the four DEFINERs are created inside a grant-then-revoke `CREATE ON SCHEMA app` window for `lims_reporting_lookup` in this one migration file; the role itself is C0's; `EXECUTE` on `app.enqueue_job` is granted by its owner `lims_queue`. Loaded on scratch PostgreSQL 16 after C3–C5 (C0 objects and the C13/C16 helpers `app.current_partner_id()` / `app.engagement_patient_ids()` stubbed): no errors; afterwards `has_schema_privilege('lims_reporting_lookup','app','CREATE')` and `has_database_privilege(…,'CREATE')` are false and the four functions are owned by `lims_reporting_lookup`.

```sql
-- Role lims_reporting_lookup is created by C0 (db/bootstrap/00_roles.sql, C0 05-SCHEMA §1: NOLOGIN, NOBYPASSRLS, SET-only member of
-- lims_migrator; USAGE on app granted there). This migration runs as lims_owner (SET LOCAL ROLE lims_owner, C0 rule).
GRANT USAGE ON SCHEMA reporting TO lims_reporting_lookup;
GRANT SELECT ON reporting.qr_tokens, reporting.report_versions, reporting.portal_links, reporting.portal_sessions,
                reporting.channel_accounts, reporting.reports, reporting.deliveries TO lims_reporting_lookup;   -- reports, deliveries: D-30
GRANT SELECT, INSERT ON reporting.provider_events TO lims_reporting_lookup;   -- SELECT: needed by INSERT … ON CONFLICT (second fix pass)
GRANT UPDATE (redeem_failures, updated_at, version) ON reporting.portal_links TO lims_reporting_lookup;          -- D-30 counter only

-- 08 A21.4 (A12.1 generalised): every C6 pre-tenant DEFINER uses its own app.pre_* GUC [CONV names], set inside the body
-- with set_config(…, true) and reset to '' before every return. The former shared lookup GUC names are retired.
CREATE POLICY qr_tokens__select__lookup ON reporting.qr_tokens FOR SELECT TO lims_reporting_lookup
  USING (token_sha256 = decode(nullif(current_setting('app.pre_qr_token_sha256', true), ''), 'hex'));
CREATE POLICY report_versions__select__lookup ON reporting.report_versions FOR SELECT TO lims_reporting_lookup
  USING (id IN (SELECT q.report_version_id FROM reporting.qr_tokens q
                WHERE q.token_sha256 = decode(nullif(current_setting('app.pre_qr_token_sha256', true), ''), 'hex')));
CREATE POLICY portal_links__select__lookup ON reporting.portal_links FOR SELECT TO lims_reporting_lookup
  USING (token_sha256 = decode(nullif(current_setting('app.pre_portal_credential_sha256', true), ''), 'hex'));
-- D-30 (08 A13; A10.5 owner-policy rule, owner = lims_reporting_lookup): the redeem DEFINER's narrowest read/update paths,
-- named __owner_only as in 03-IC §13.3 / 08 A13 D-30, bound to app.pre_portal_token_sha256 set inside the function.
CREATE POLICY portal_links__select__owner_only ON reporting.portal_links FOR SELECT TO lims_reporting_lookup
  USING (token_sha256 = decode(nullif(current_setting('app.pre_portal_token_sha256', true), ''), 'hex'));
CREATE POLICY portal_links__update__owner_only ON reporting.portal_links FOR UPDATE TO lims_reporting_lookup
  USING      (token_sha256 = decode(nullif(current_setting('app.pre_portal_token_sha256', true), ''), 'hex'))
  WITH CHECK (token_sha256 = decode(nullif(current_setting('app.pre_portal_token_sha256', true), ''), 'hex'));
-- The function body also reads the link's report, its released version and the link's delivery (destination fallback),
-- so three more owner_only SELECT policies are needed beyond the two named in 03-IC §13.3 (handed off to 03-IC):
CREATE POLICY reports__select__owner_only ON reporting.reports FOR SELECT TO lims_reporting_lookup
  USING (id IN (SELECT l.report_id FROM reporting.portal_links l
                WHERE l.token_sha256 = decode(nullif(current_setting('app.pre_portal_token_sha256', true), ''), 'hex')));
CREATE POLICY report_versions__select__owner_only ON reporting.report_versions FOR SELECT TO lims_reporting_lookup
  USING (report_id IN (SELECT l.report_id FROM reporting.portal_links l
                WHERE l.token_sha256 = decode(nullif(current_setting('app.pre_portal_token_sha256', true), ''), 'hex')));
CREATE POLICY deliveries__select__owner_only ON reporting.deliveries FOR SELECT TO lims_reporting_lookup
  USING (id IN (SELECT l.delivery_id FROM reporting.portal_links l
                WHERE l.token_sha256 = decode(nullif(current_setting('app.pre_portal_token_sha256', true), ''), 'hex')));
CREATE POLICY portal_sessions__select__lookup ON reporting.portal_sessions FOR SELECT TO lims_reporting_lookup
  USING (token_sha256 = decode(nullif(current_setting('app.pre_portal_credential_sha256', true), ''), 'hex'));
CREATE POLICY channel_accounts__select__lookup ON reporting.channel_accounts FOR SELECT TO lims_reporting_lookup
  USING (callback_token_sha256 = decode(nullif(current_setting('app.pre_callback_token_sha256', true), ''), 'hex'));
CREATE POLICY provider_events__insert__lookup ON reporting.provider_events FOR INSERT TO lims_reporting_lookup
  WITH CHECK (tenant_id = nullif(current_setting('app.pre_callback_tenant_id', true), '')::uuid
              AND channel_account_id = nullif(current_setting('app.pre_callback_channel_account_id', true), '')::uuid);
-- INSERT … ON CONFLICT DO NOTHING under FORCE RLS also needs SELECT privilege and a SELECT policy on the target: without them
-- the ingest function fails ("permission denied" / "violates row-level security policy") — found on scratch PG 16.
CREATE POLICY provider_events__select__lookup ON reporting.provider_events FOR SELECT TO lims_reporting_lookup
  USING (tenant_id = nullif(current_setting('app.pre_callback_tenant_id', true), '')::uuid
         AND channel_account_id = nullif(current_setting('app.pre_callback_channel_account_id', true), '')::uuid);

-- 08 A25 D-201: no standing CREATE. This migration file is the only window in which lims_reporting_lookup holds CREATE on schema
-- app (same pattern as C0 05-SCHEMA §10 "queue wrapper"): as lims_owner grant → SET LOCAL ROLE lims_reporting_lookup → create the
-- four DEFINERs → back to lims_owner → revoke, all in this one file. The role creates no schema, so it gets no CREATE on the database.
-- (PostgreSQL also needs CREATE on the schema for ALTER … OWNER TO, so "create as lims_owner, then ALTER OWNER" would not avoid it.)
GRANT CREATE ON SCHEMA app TO lims_reporting_lookup;
RESET ROLE;  SET LOCAL ROLE lims_reporting_lookup;          -- lims_migrator holds SET on this role (C0 05-SCHEMA §1)

CREATE FUNCTION app.reporting_verify_qr(p_token_sha256 bytea)
RETURNS TABLE (lab_name text, patient_display text, panel_names text[], issued_at timestamptz, version_no integer, status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_token_sha256 IS NULL OR octet_length(p_token_sha256) <> 32 THEN RETURN; END IF;
  PERFORM set_config('app.pre_qr_token_sha256', encode(p_token_sha256, 'hex'), true);
  RETURN QUERY
    SELECT q.lab_name_snapshot, q.patient_display_snapshot, q.panel_names_snapshot, v.released_at, v.version_no,
           CASE v.status WHEN 'released' THEN 'valid' ELSE 'superseded' END
    FROM reporting.qr_tokens q
    JOIN reporting.report_versions v ON v.tenant_id = q.tenant_id AND v.id = q.report_version_id
    WHERE q.token_sha256 = p_token_sha256 AND q.revoked_at IS NULL AND v.status IN ('released','superseded');
  PERFORM set_config('app.pre_qr_token_sha256', '', true);              -- A21.4: reset before return
  RETURN;
END $$;
ALTER FUNCTION app.reporting_verify_qr(bytea) OWNER TO lims_reporting_lookup;
REVOKE ALL ON FUNCTION app.reporting_verify_qr(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reporting_verify_qr(bytea) TO lims_api;

CREATE FUNCTION app.reporting_resolve_portal_credential(p_kind text, p_token_sha256 bytea)
RETURNS TABLE (tenant_id uuid, link_id uuid, report_id uuid, stage text, session_id uuid, purpose text)   -- purpose: 08 A21.1
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_token_sha256 IS NULL OR octet_length(p_token_sha256) <> 32 OR p_kind NOT IN ('link','session') THEN RETURN; END IF;
  PERFORM set_config('app.pre_portal_credential_sha256', encode(p_token_sha256, 'hex'), true);
  IF p_kind = 'link' THEN
    RETURN QUERY SELECT l.tenant_id, l.id, l.report_id,
      CASE WHEN l.expires_at > now() THEN 'link' ELSE 'expired_link' END, NULL::uuid, l.purpose
      FROM reporting.portal_links l WHERE l.token_sha256 = p_token_sha256 AND l.revoked_at IS NULL;
  ELSE
    RETURN QUERY SELECT s.tenant_id, s.link_id, s.report_id, 'session'::text, s.id, s.link_purpose
      FROM reporting.portal_sessions s
      WHERE s.token_sha256 = p_token_sha256 AND s.ended_at IS NULL
        AND s.idle_expires_at > now() AND s.absolute_expires_at > now();
  END IF;
  PERFORM set_config('app.pre_portal_credential_sha256', '', true);     -- A21.4: reset before return
  RETURN;
END $$;
-- session rows of revoked links: the API checks the link (portal_links__select__portal) after resolution and ends the session.
ALTER FUNCTION app.reporting_resolve_portal_credential(text, bytea) OWNER TO lims_reporting_lookup;
REVOKE ALL ON FUNCTION app.reporting_resolve_portal_credential(text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reporting_resolve_portal_credential(text, bytea) TO lims_api;

CREATE FUNCTION app.reporting_ingest_provider_callback(p_provider_kind text, p_token_sha256 bytea, p_events jsonb)   -- 08 §4.7 signature
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tenant uuid; v_account uuid; v_n integer := 0; e jsonb;
BEGIN
  IF p_token_sha256 IS NULL OR octet_length(p_token_sha256) <> 32 OR jsonb_typeof(p_events) <> 'array' OR jsonb_array_length(p_events) > 100 THEN RETURN -1; END IF;
  PERFORM set_config('app.pre_callback_token_sha256', encode(p_token_sha256, 'hex'), true);
  SELECT a.tenant_id, a.id INTO v_tenant, v_account FROM reporting.channel_accounts a
   WHERE a.callback_token_sha256 = p_token_sha256 AND a.is_active AND a.provider_kind = p_provider_kind;
  IF v_tenant IS NULL THEN
    PERFORM set_config('app.pre_callback_token_sha256', '', true);
    RETURN -1;
  END IF;
  PERFORM set_config('app.pre_callback_tenant_id', v_tenant::text, true);
  PERFORM set_config('app.pre_callback_channel_account_id', v_account::text, true);
  FOR e IN SELECT * FROM jsonb_array_elements(p_events) LOOP
    INSERT INTO reporting.provider_events (id, tenant_id, channel_account_id, provider_kind, provider_message_id, status_raw,
                                           mapped_status, occurred_at, created_by)
    VALUES ((e->>'id')::uuid, v_tenant, v_account, p_provider_kind, left(e->>'provider_message_id', 128), left(e->>'status_raw', 64),
            e->>'mapped_status', (e->>'occurred_at')::timestamptz, v_account)
    ON CONFLICT ON CONSTRAINT provider_events__dedupe__uq DO NOTHING;
    v_n := v_n + 1;
  END LOOP;
  PERFORM app.enqueue_job('reporting.apply_provider_events', jsonb_build_object('tenant_id', v_tenant), 'pe:' || v_tenant::text, NULL, NULL);
  PERFORM set_config('app.pre_callback_token_sha256', '', true);        -- A21.4: reset all three before return
  PERFORM set_config('app.pre_callback_tenant_id', '', true);
  PERFORM set_config('app.pre_callback_channel_account_id', '', true);
  RETURN v_n;
END $$;
-- 'id' values are UUIDv7 generated by the API handler (04 D9: app-generated ids).
ALTER FUNCTION app.reporting_ingest_provider_callback(text, bytea, jsonb) OWNER TO lims_reporting_lookup;
REVOKE ALL ON FUNCTION app.reporting_ingest_provider_callback(text, bytea, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reporting_ingest_provider_callback(text, bytea, jsonb) TO lims_api;
-- (EXECUTE on app.enqueue_job for this role is granted after the window closes, by its owner lims_queue — see below.)

-- 08 A13 D-30: ReportingPort.redeemPortalLinkForApp (patient actor via C16). Inventory row: 03-IC §13.3 / 08 §4.7.
CREATE FUNCTION app.reporting_redeem_link_for_app(p_token_sha256 bytea, p_phone_sha256 bytea)
RETURNS TABLE (tenant_id uuid, patient_id uuid, report_id uuid, version_no integer, released_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_link reporting.portal_links%ROWTYPE; v_dest bytea;
BEGIN
  IF p_token_sha256 IS NULL OR octet_length(p_token_sha256) <> 32
     OR p_phone_sha256 IS NULL OR octet_length(p_phone_sha256) <> 32 THEN RETURN; END IF;
  PERFORM set_config('app.pre_portal_token_sha256', encode(p_token_sha256, 'hex'), true);
  SELECT l.* INTO v_link FROM reporting.portal_links l
   WHERE l.token_sha256 = p_token_sha256 AND l.revoked_at IS NULL AND l.expires_at > now()
     AND l.recipient_kind = 'patient' AND l.channel IN ('sms','whatsapp') AND l.purpose = 'report'   -- A21.1
   FOR UPDATE;
  IF NOT FOUND OR v_link.redeem_failures >= 5 THEN                      -- invalid / wrong kind / locked: no counter change
    PERFORM set_config('app.pre_portal_token_sha256', '', true);
    RETURN;
  END IF;
  IF v_link.destination_sha256 IS NULL AND v_link.delivery_id IS NOT NULL THEN
    SELECT d.destination_sha256 INTO v_dest FROM reporting.deliveries d
     WHERE d.tenant_id = v_link.tenant_id AND d.id = v_link.delivery_id;
  END IF;
  IF coalesce(v_link.destination_sha256, v_dest) IS DISTINCT FROM p_phone_sha256 THEN   -- bytea = bytea (A5.5)
    UPDATE reporting.portal_links pl SET redeem_failures = pl.redeem_failures + 1, updated_at = now(), version = pl.version + 1
     WHERE pl.tenant_id = v_link.tenant_id AND pl.id = v_link.id;
    PERFORM set_config('app.pre_portal_token_sha256', '', true);
    RETURN;
  END IF;
  RETURN QUERY
    SELECT r.tenant_id, r.patient_id, r.id, v.version_no, v.released_at
      FROM reporting.reports r
      JOIN reporting.report_versions v ON v.tenant_id = r.tenant_id AND v.report_id = r.id AND v.status = 'released'
     WHERE r.tenant_id = v_link.tenant_id AND r.id = v_link.report_id;
  PERFORM set_config('app.pre_portal_token_sha256', '', true);           -- A12.1: GUC empty on return
  RETURN;
END $$;
ALTER FUNCTION app.reporting_redeem_link_for_app(bytea, bytea) OWNER TO lims_reporting_lookup;
REVOKE ALL ON FUNCTION app.reporting_redeem_link_for_app(bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reporting_redeem_link_for_app(bytea, bytea) TO lims_api;
RESET ROLE;  SET LOCAL ROLE lims_owner;
REVOKE CREATE ON SCHEMA app FROM lims_reporting_lookup;                                  -- D-201: close the window
-- app.enqueue_job is owned by lims_queue (C0 05-SCHEMA §10); only its owner can grant EXECUTE on it (a grant by lims_owner would
-- only warn "no privileges were granted"). Needed by app.reporting_ingest_provider_callback.
RESET ROLE;  SET LOCAL ROLE lims_queue;
GRANT EXECUTE ON FUNCTION app.enqueue_job(text, jsonb, text, timestamptz, integer) TO lims_reporting_lookup;
RESET ROLE;  SET LOCAL ROLE lims_owner;
-- Role test (C0 05-SCHEMA §10 test 30, D-201): after this migration has_schema_privilege('lims_reporting_lookup','app','CREATE') = false
-- and has_database_privilege('lims_reporting_lookup', current_database(), 'CREATE') = false; the four functions are owned by it.
-- Never consumes, extends or reveals the link: the only write is redeem_failures (+ updated_at, version), allowed by the
-- column grant, portal_links__update__owner_only and tg_portal_links_guard; that update is not row-audited (§1 note).
-- The caller (ReportingPort impl, patient actor) passes sha256(token) and sha256(phoneE164) and requires the returned
-- tenant_id = ctx.tenantId; no row → reporting.link_invalid (identical for every failure).
```

### 6.3 Grants

| Table(s) | lims_app |
|---|---|
| reports, report_order_items, report_versions, qr_tokens, portal_links, deliveries, input_files, narrative_reports, narrative_versions, all M tables | SELECT, INSERT, UPDATE |
| otp_challenges, portal_sessions, print_jobs, portal_payment_requests | SELECT, INSERT, UPDATE, DELETE (policies restrict DELETE to the system purge) |
| delivery_attempts | SELECT, INSERT |
| provider_events | SELECT, INSERT, UPDATE (mutable trigger limits to apply columns) |
| g_message_templates, g_cs_reasons | SELECT |
| v_pub_* | SELECT (also lims_analytics) |

## 7. Published views (03-IC §6.4, exact columns)

```sql
CREATE VIEW reporting.v_pub_report_release WITH (security_invoker = true) AS
SELECT v.tenant_id, v.report_id, v.version_no, v.order_id, v.centre_id, v.report_kind,
       v.released_at, v.release_basis, v.superseded_at
FROM reporting.report_versions v
WHERE v.status IN ('released','superseded');
-- report_kind may be 'addendum' (08 R1, 03-IC §6.4 note); consumers tolerate new values.

CREATE VIEW reporting.v_pub_order_report_tat WITH (security_invoker = true) AS
SELECT r.tenant_id, r.order_id, r.centre_id, min(r.registered_at) AS registered_at,
       min(r.first_released_at) AS first_released_at, max(r.final_released_at) AS final_released_at,
       CASE WHEN bool_and(r.final_released_at IS NOT NULL)
            THEN extract(epoch FROM (max(r.final_released_at) - min(r.registered_at)))::bigint END AS total_tat_seconds
FROM reporting.reports r
WHERE r.state = 'open'
GROUP BY r.tenant_id, r.order_id, r.centre_id;
-- final_released_at = first release of a version with completeness 'complete' (set by release.service).
-- An order with two families counts as finally released when both are (bool_and).

-- CR-C8-005 (08 §4.9) + 08 A17 D-48: every count anchors on the delivery's creation date (cohort); centre_id NULL for
-- non-report deliveries (CR-C8-005). Each status column counts the deliveries of that creation-day cohort whose status
-- timestamp is set (queued_at, sent_at, delivered_at, read_at, failed_at, suppressed_at — the same per-delivery test as
-- before D-48); a delivery created on day 1 and delivered on day 2 counts as sent and delivered on day 1, and the day-1
-- row changes when the later status arrives (C8 re-reads it: 02-TRD §8.1 `delivery_created_at`). This replaces the
-- per-status anchors of review fix #9. Column order = 03-IC §6.4 (centre_id appended); grouped by tenant_id,
-- business_date, channel, purpose, recipient_kind and centre_id (D-48 "group by it"; written as expressions because
-- centre_id is the last column, not the 6th).
CREATE VIEW reporting.v_pub_delivery_daily WITH (security_invoker = true) AS
SELECT d.tenant_id, (d.created_at AT TIME ZONE 'Asia/Kathmandu')::date AS business_date,
       d.channel, d.purpose, d.recipient_kind,
       count(*) FILTER (WHERE d.queued_at     IS NOT NULL) AS queued,
       count(*) FILTER (WHERE d.sent_at       IS NOT NULL) AS sent,
       count(*) FILTER (WHERE d.delivered_at  IS NOT NULL) AS delivered,
       count(*) FILTER (WHERE d.read_at       IS NOT NULL) AS read,
       count(*) FILTER (WHERE d.failed_at     IS NOT NULL) AS failed,
       count(*) FILTER (WHERE d.suppressed_at IS NOT NULL) AS suppressed,
       d.centre_id
FROM reporting.deliveries d
GROUP BY d.tenant_id, (d.created_at AT TIME ZONE 'Asia/Kathmandu')::date, d.channel, d.purpose, d.recipient_kind, d.centre_id;
-- 08 A13 P-15: in v1 TenantSettings.timezone accepts only Asia/Kathmandu, so every v_pub_* view uses that literal; a
-- per-tenant timezone needs a CR that adds stored business_date columns (08 §4.9 fallback).

GRANT SELECT ON reporting.v_pub_report_release, reporting.v_pub_order_report_tat, reporting.v_pub_delivery_daily TO lims_app, lims_analytics;
```

## 8. Seed data (synthetic; global seeds by migration, tenant defaults created lazily by `settings.service` on first access)

- `g_message_templates`: the rows of 04-UI-UX §7 (nine C6/C4 rows + the C16 and C8 rows of 08 §4.10: `engagement.login_otp`, `engagement.booking_confirmation`, `engagement.booking_cancelled` (purpose `booking_cancelled`), `engagement.booking_reminder` (purpose `booking_reminder`), `engagement.follow_up_reminder`, `analytics.report_ready` (purpose `scheduled_report_ready`; code per 08 Addendum A2.6, renamed from the earlier underscore spelling) — 04-UI-UX §7) the C6 row `reporting.dues_due` (purpose `dues_reminder`, channels sms/whatsapp, params `amount_text`, `lab_name` (both `short_text`, as 08 A21.1 states) and `url` (kind `url`) — the `url` param is added because a dues link must carry its URL [CONV]) and the C17 rows `homecollection.visit_assigned` (purpose `visit_assignment`, channel `sms`, params `route_date`, `visit_count`, both kind `short_text` — 08 A13 D-34) and `homecollection.visit_scheduled` (purpose `booking_confirmation`, channel `sms`, patient recipient, params `window_start_local`, `window_end_local`, both kind `short_text`, no lab-name parameter — CR-C17-014, 08 A19 D-129). Params kinds: `lab_name` (text ≤ 120), `url` (kind `url`: portal URL) — except `analytics.report_ready`, whose `url` param has kind `staff_url` (08 A13 D-29), `route_date`/`visit_count`/`window_start_local`/`window_end_local` (`short_text`), `otp_code` (6 digits), `minutes` (1–60), `registered_time_hhmm`, `lab_phone`/`centre_phone` (`phone` ≤ 40), `ref`, `booking_no` (`short_text`: ≤ 40, `^[A-Za-z0-9 .,:/()-]*$`), `schedule_name` (`label_text`: ≤ 80, plain text, no URLs — `://` or `www.` rejected — HTML-escaped; 08 Addendum A4.3, 02-TRD §7.2).
- `g_cs_reasons`: regeneration_reasons {demographic_correction, referrer_correction, template_correction, smart_summary_added, other} (`centre_correction` removed — 08 A13 D-36: C4 has no centre-change operation and `reports.centre_id` is immutable); token_revoke_reasons {issued_in_error, wrong_recipient, security_concern, dues_settled (system only, 08 A21.1), other}; outsourced_withdraw_reasons {wrong_patient, wrong_file, unreadable, other}; narrative_amend_reasons {transcription_error, additional_findings, wrong_side_or_site, other}.
- Per tenant (lazy): `settings` defaults (02-TRD §10.2); one default `laboratory` and one `narrative` report template (published v1, config defaults of 04-UI-UX §2.6); narrative templates `XRAY_CHEST`, `USG_ABDOMEN`, `ENDOSCOPY_UGI`, `CYTOGENETICS_KARYOTYPE` with synthetic section headings (Clinical history / Technique / Findings / Impression; for cytogenetics: Specimen / Method / Result / Interpretation). Template text is a placeholder for the tenant's radiologist/pathologist to replace. No clinical content is invented.
- Test fixtures (`packages/test-fixtures`, C0): tenants A/B each with a released, a held, a superseded and a discarded version; QR and link tokens with known synthetic plaintexts for probes.

## 9. Retention

| Data | Retention | Mechanism |
|---|---|---|
| report_versions + PDFs (`reports` bucket), qr_tokens, narrative_*, confirmed input files | ≥ `retentionYears` (default 5, B15; 04 I8) online, then archive (C1) | no purge in v1 |
| deliveries, delivery_attempts | same as reports [CONV] | none in v1 |
| deliveries `params` secrets / `destination_e164` | scrubbed ≤ 1 h after terminal status | `purge_ephemeral` |
| provider_events | 1 year [CONV] | purge function by CR when needed (append-only; owner purge per 02-CV §5.11) |
| portal_links | as reports (audit of who received what) | none |
| otp_challenges | expiry + 24 h (02-CV §5.11) | `purge_ephemeral` |
| portal_sessions | end/expiry + 24 h [CONV] | `purge_ephemeral` |
| print_jobs + `reporting-prints` objects | 24 h [CONV] | `purge_ephemeral` (object delete under 08 A13 P-12 (a)) |
| portal_payment_requests | created + 90 days (`expires_at`) [CONV, as C16 `payment_requests`]; `action_json` scrubbed when the request leaves `ready` | `purge_ephemeral` |
| quarantined/rejected input objects | 30 days [CONV] then object deleted (row kept, state terminal) | `purge_ephemeral` (P-12 (a)) |
| event_inbox | 90 days | C0 |

## 10. Data classification summary

P3: `report_versions.content_snapshot`, `report_versions.smart_summary_json` (08 A2.3), report PDFs, `qr_tokens.panel_names_snapshot`, narrative sections/images, input file objects, `report_order_items` (orderables). P2: patient display snapshots, `reports.registration_no`/`patient_display_name` (review fix #6), destination masked/e164, centre contact addresses, original filenames, delivery params (until scrubbed: credentials). Credential until scrubbed: `portal_payment_requests.action_json` (gateway URL). P1: ids, hashes. P0: settings, templates, statuses. Credential material is stored only as SHA-256 (tokens, 32-byte `bytea`, 08 R24) or HMAC (OTP).
