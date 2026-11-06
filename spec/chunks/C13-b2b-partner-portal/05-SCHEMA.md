# C13 — B2B Partner Portal — 05 Schema (`partners`)

Status: DECISION draft, 2026-11-06. This is the specification C0-0B implements as DDL (01 §0). Conventions: 02-CV §5 (classes, mandatory columns, composite FKs, no ENUM types, RLS template, roles). PHI classes P0–P3 per 03 §1. The schema `partners` already exists in C0's bootstrap (C0 05-SCHEMA: `CREATE SCHEMA partners`, usage granted to `lims_app`). Cross-schema FKs point downstream → upstream only (`partners` → `core`, `catalog`, `frontdesk`), never into `billing` (02-CV §5.4).

---

## 1. Table inventory

| Table | Class (02-CV §5.2) | Scope (RLS) | Purpose |
|---|---|---|---|
| `partners.settings` | M | staff tenant-wide; partner read | per-tenant module settings (02-TRD §10.2) |
| `partners.partners` | M | staff tenant-wide; partner reads own row | partner organisations |
| `partners.partner_users` | M | staff tenant-wide; partner own org | partner membership mirror (role, status) |
| `partners.partner_referrers` | M | staff tenant-wide; partner own org | partner's referring doctors + mapping to C3 |
| `partners.manifest_counters` | E (counter) | staff + partner (own org, insert/update) | `manifest_no` sequence per (tenant, partner, yy) |
| `partners.manifests` | C (partner-submitted record; lifecycle trigger) | staff receiving-centre; partner own org | manifests |
| `partners.manifest_lines` | C (lifecycle trigger; patient fields redactable) | staff receiving-centre; partner own org | samples on a manifest |
| `partners.pickup_requests` | C (lifecycle) | staff receiving-centre; partner own org | pickup requests |
| `partners.pickup_request_manifests` | C (link, append-only) | as parent | pickup ↔ manifest |
| `partners.order_tracking` | E (projection) | staff receiving-centre; partner own org; writes system/staff only | per-order tracking read model |
| `partners.tracked_specimens` | E (projection) | as above | per-specimen status read model |
| `partners.order_reports` | E (projection) | as above; partner may update `is_new`/`seen_*` only | released report versions of partner orders |
| `partners.price_list_items` | E (projection) | staff tenant-wide; partner own org (read) | partner price list |
| `partners.price_list_syncs` | E | staff; partner own org (read) | sync status |
| `partners.statement_months` | E (projection) | staff; partner own org (read) | monthly statement rows |
| `partners.download_counters` | E | partner own user (insert/update), staff read; system delete after `expires_at` (A17 P-18(c)) | daily download cap (REQ-SEC-100) |
| `partners.access_slips` | C (lifecycle; system-only transitions) | staff tenant-wide read; partner own org (read, insert `requested`); writes after insert system only | patient access-slip requests and the stored slip reference (08 A2.1) |
| `partners.event_inbox` | A | tenant (C0 standard, 03 §12) | consumer dedupe |
| `partners.g_cs_reasons` | G | none (RLS-exempt list) | reason coded sets |

"Projection" rows are rebuildable from other modules' views/events; they are class E (UPDATE/DELETE allowed to the system path) but **never** deleted by partner actors.

Every tenant table above except `event_inbox` is declared `shared_with: [partner]` in `db/meta/tables.yaml` (A17 P-16 exception): each has actor-specific `__partner` policies, and its staff policies use the positive list `app.current_actor_type() IN ('user','system')`, which is stricter than `app.is_staff_or_system()` (it also excludes `device`; same pattern as 08 A19 D-109). The only `__tenant`-named policy in this schema (`download_counters__delete__tenant`, P-18(c)) carries `(SELECT app.is_staff_or_system())`.

**Mandatory-column exceptions (A17 P-18(b); copied to `db/meta/tables.yaml`).**

| Table | Omits | Reason |
|---|---|---|
| `settings` | `id`, `is_active` | one row per tenant; natural key `tenant_id` is the PK |
| `manifest_counters` | `id`, `version`, `is_active`, `expires_at` | counter, natural PK (tenant, partner, yy); never edited by users; never expires |
| `pickup_request_manifests` | `id`, `version`, `is_active` | link row, natural PK (tenant, pickup, manifest); only `is_open` changes |
| `order_tracking` | `id`, `is_active`, `expires_at` | projection keyed by `order_id`; kept while the line exists |
| `tracked_specimens`, `order_reports` | `id`, `version`, `is_active`, `expires_at` | projections keyed by the source ids; never edited by users (except `order_reports` mark-seen flags); kept while the line exists |
| `price_list_items` | `id`, `version`, `is_active`, `updated_at`, `updated_by`, `expires_at` | replace-on-sync projection (delete-insert); natural PK |
| `price_list_syncs`, `statement_months` | `id`, `version`, `is_active`, `expires_at` | sync state / projection keyed by natural PK; never expire |
| `download_counters` | `id`, `version`, `is_active` | per-(user, day) counter, natural PK; `expires_at` kept (P-18(c) purge) |

## 2. RLS predicates (exact SQL fragments used by every policy below)

Helpers: `app.current_tenant_id()`, `app.current_actor_type()`, `app.has_all_centres()`, `app.current_centre_ids()` (02-CV §5.8, C0) and `app.current_partner_id()` (**CR-C13-004**, definition in 02-TRD §15). Always wrapped in `(SELECT …)` (REQ-SEC-022).

| Name | SQL |
|---|---|
| **PT** partner predicate | `tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND partner_id = (SELECT app.current_partner_id())` |
| **ST** staff/system tenant-wide | `tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system')` |
| **SC** staff/system receiving-centre | `tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system') AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[]))` (cast per 08 A16.1) |
| **SY** system only | `tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system'` |

Policy naming extends 02-CV §3 with scope words `partner`, `staff`, `staff_centre`, `system` (e.g. `manifests__select__partner`), plus `owner_only` for the DEFINER policies in §8 (after `app.current_partner_id()` and `partners.redact_lines`). Several permissive policies on one command OR together; each targets `lims_app` (binding X9), except the `__owner_only` policies, which target `lims_owner` (08 A10.5, A19 P-41). No policy uses `USING (true)`; commands without a policy are denied (REQ-SEC-016). FORCE RLS on every table (04 D4).

Support sessions (C2): platform staff in a support session carry `actor_type 'user'` without `membership_id` → `has_all_centres()` false and `current_centre_ids()` `{}` → SC rows invisible; ST rows (partner master data) visible. C2's support allowlist (C2 02-TRD §7.4) grants no `partners.*` permission, so handlers still deny; RLS is the second line.

## 3. Column specifications

Mandatory columns per class (02-CV §5.3) are listed once here and present on every table unless stated: `id uuid` (UUIDv7, app-generated, no default), `tenant_id uuid NOT NULL` (no default), `version integer NOT NULL DEFAULT 1`, `is_active boolean NOT NULL DEFAULT true` (M/C), `created_at timestamptz NOT NULL DEFAULT now()`, `created_by uuid NOT NULL`, `updated_at timestamptz NOT NULL DEFAULT now()`, `updated_by uuid NOT NULL`.

### 3.1 `partners.partners`

| Column | Type | Null | Default / check | PHI |
|---|---|---|---|---|
| partner_code | text | N | `^[A-Z0-9_-]{1,20}$`; UNIQUE (tenant_id, partner_code) | P0 |
| name | text | N | 1–160 chars | P0 (organisation) |
| status | text | N | `IN ('active','suspended')` default `active` | P0 |
| credit_party_id | uuid | N | FK (tenant_id, credit_party_id) → `catalog.credit_parties`; UNIQUE (tenant_id, credit_party_id) | P0 |
| receiving_branch_id | uuid | N | FK → `core.branches` | P0 |
| receiving_centre_id | uuid | N | FK → `core.collection_centres` | P0 |
| conversion_mode | text | N | `IN ('on_receipt','on_submit')` | P0 |
| contact_email | text | Y | ≤ 254 | P2-personal (business contact) |
| contact_phone_e164 | text | Y | `^\+[1-9][0-9]{7,14}$` (A13 P-11) | P2-personal |
| address_text | text | Y | ≤ 300 | P2-personal/business |
| suspended_at, suspended_by | timestamptz, uuid | Y | both set iff status = suspended | P0 |
| suspend_reason_code | text | Y | coded set `partner_suspend_reasons` | P0 |
| suspend_reason_text | text | Y | ≤ 300 | P2 (free text) |

### 3.2 `partners.partner_users`

| Column | Type | Null | Default / check | PHI |
|---|---|---|---|---|
| partner_id | uuid | N | FK (tenant_id, partner_id) → partners | P1 |
| membership_id | uuid | N | FK (tenant_id, membership_id) → `core.memberships`; UNIQUE (tenant_id, membership_id) | P1 |
| partner_role | text | N | `IN ('partner_admin','partner_member')` | P0 |
| status | text | N | `IN ('invited','active','deactivated')` | P0 |
| display_name | text | N | 1–120 (snapshot given at invite; display only) | P2-personal |
| email_masked | text | N | ≤ 64, e.g. `a***@p***.invalid` (computed at invite; the clear e-mail lives only in C2/GoTrue) | P2-personal (masked) |
| activated_at | timestamptz | Y | first partner request | P0 |
| deactivated_at, deactivated_by | timestamptz, uuid | Y | set iff status = deactivated | P0 |
| deactivate_reason_code | text | Y | `partner_user_deactivate_reasons` | P0 |
| invited_by_actor_type | text | N | `IN ('user','partner')` | P0 |

### 3.3 `partners.partner_referrers`

| Column | Type | Null | Default / check | PHI |
|---|---|---|---|---|
| partner_id | uuid | N | FK → partners | P1 |
| display_name | text | N | 1–120, NFC | P2-personal (doctor) |
| display_name_norm | text | N | lower(trim, collapsed spaces) — set by app | P2 |
| qualification | text | Y | ≤ 120 | P2 |
| registration_council | text | Y | ≤ 20 | P0 |
| registration_no | text | Y | ≤ 30 | P2 |
| mapping_state | text | N | `IN ('unmapped','mapped','rejected')` default `unmapped` | P0 |
| catalog_doctor_id | uuid | Y | FK (tenant_id, catalog_doctor_id) → `catalog.doctors`; NOT NULL iff mapped | P1 |
| mapped_at, mapped_by | timestamptz, uuid | Y | | P0 |
| mapping_reject_reason_code | text | Y | `referrer_mapping_reject_reasons`; NOT NULL iff rejected | P0 |
| mapping_reject_text | text | Y | ≤ 300 | P2 |
| UNIQUE | (tenant_id, partner_id, display_name_norm, coalesce(registration_no,'')) | | partial on `is_active` | |

### 3.4 `partners.manifests`

| Column | Type | Null | Check | PHI |
|---|---|---|---|---|
| partner_id | uuid | N | FK | P1 |
| manifest_no | text | N | `^MF[0-9]{2}[0-9]{6}$`; UNIQUE (tenant_id, partner_id, manifest_no) | P2 (lab-linked id) |
| state | text | N | `IN ('draft','submitted','partially_received','received','withdrawn','discarded')` | P0 |
| receiving_branch_id, receiving_centre_id | uuid | N | FKs → core. Rule: snapshot from the partner at create (MS1); refreshed from the partner at submit (MS3), and the same submit transaction sets `manifest_lines.receiving_centre_id` of every line to the refreshed value | P0 |
| conversion_mode | text | N | `IN ('on_receipt','on_submit')` (copied from the partner at create; re-snapshotted at submit) | P0 |
| notes | text | Y | ≤ 500 | P3-possible (free text to lab) |
| collected_on | date | Y | | P0 |
| line_count | integer | N | default 0, ≥ 0 | P0 |
| submitted_at, submitted_by | timestamptz, uuid | Y | set iff state ∉ (draft, discarded) | P0 |
| received_at, received_by | timestamptz, uuid | Y | | P0 |
| in_transit_at | timestamptz | Y | pickup picked up | P0 |
| withdrawn_at, withdrawn_by, withdraw_reason_code, withdraw_reason_text | | Y | iff withdrawn; text ≤ 300 | P2 |
| discarded_at | timestamptz | Y | iff discarded | P0 |

Lifecycle trigger: when `OLD.state <> 'draft'`, only these columns may change: `state, line_count, received_at, received_by, in_transit_at, withdrawn_at, withdrawn_by, withdraw_reason_code, withdraw_reason_text, updated_at, updated_by, version` (function `partners.guard_manifest_update()`, §8). For **partner** actors the narrower column allowlist of `partners.guard_partner_columns()` (§8, 08 A19 D-103) also applies, in every state.

### 3.5 `partners.manifest_lines`

| Column | Type | Null | Check | PHI |
|---|---|---|---|---|
| partner_id | uuid | N | = manifest's partner (trigger check) | P1 |
| manifest_id | uuid | N | FK (tenant_id, manifest_id) | P1 |
| receiving_centre_id | uuid | N | = manifest's (copied for SC policy; rewritten with the manifest's refreshed value at submit, §3.4) | P0 |
| line_no | integer | N | 1–200; UNIQUE (tenant_id, manifest_id, line_no) | P0 |
| state | text | N | `IN ('draft','submitted','converting','converted','conversion_failed','not_received','withdrawn','discarded','cancelled')` | P0 |
| partner_sample_ref | text | Y | `^[A-Za-z0-9_./-]{1,40}$`; UNIQUE (tenant_id, manifest_id, partner_sample_ref) WHERE NOT NULL | P2 |
| patient_full_name | text | Y | 1–120; NULL only when `is_redacted` | P2 |
| patient_sex | text | Y | `IN ('male','female','other','unknown')`; NULL only when redacted | P2 |
| patient_birth_on | date | Y | ≥ 1900-01-01 | P2 |
| patient_age_years | smallint | Y | 0–130; exactly one of birth_on/age_years unless redacted | P2 |
| patient_phone_e164 | text | Y | E.164 `^\+[1-9][0-9]{7,14}$` (A13 P-11) | P2 |
| consent_attested | boolean | N | must be true unless redacted | P2 |
| consent_sms, consent_whatsapp, consent_email, consent_share_with_referrer | boolean | N | default false | P2 |
| consent_text_version | text | N | 1–32 | P0 |
| orderable_ids | uuid[] | N | cardinality 1–30 | P3 (with patient) |
| orderables_snapshot | jsonb | N | array of `{orderable_id, kind, code, name}`, same length as `orderable_ids` (app-checked; CHECK `jsonb_typeof = 'array'`) | P3 |
| priority | text | N | `IN ('routine','urgent')` | P3-adjacent |
| referrer_id | uuid | Y | FK (tenant_id, referrer_id, partner_id) → partner_referrers (MATCH SIMPLE: NULL referrer allowed; a referrer of another partner is rejected by the DB) | P1 |
| collected_at | timestamptz | Y | | P3-adjacent |
| clinical_note | text | Y | ≤ 300 | **P3** |
| resolved_patient_id | uuid | Y | C4 patient id chosen by staff (no FK: frontdesk.patients FK allowed by R3 but intentionally omitted so redaction/anonymisation in C4 never blocks) | P1 |
| conversion_attempt | integer | N | default 0, ≥ 0 | P0 |
| order_id | uuid | Y | FK (tenant_id, order_id) → `frontdesk.orders`; UNIQUE (tenant_id, order_id) WHERE NOT NULL | P1 |
| registration_no | text | Y | ≤ 40 | P2 |
| converted_at | timestamptz | Y | iff order_id set | P0 |
| failure_code | text | Y | errors.yaml code ≤ 64; iff state = conversion_failed | P0 |
| failed_at | timestamptz | Y | | P0 |
| sample_received_at, received_by | timestamptz, uuid | Y | | P0 |
| sample_missing | boolean | N | default false | P0 |
| not_received_reason_code | text | Y | `line_not_received_reasons`; iff state = not_received or sample_missing | P0 |
| is_redacted | boolean | N | default false | P0 |
| redacted_at | timestamptz | Y | | P0 |

Lifecycle trigger `partners.guard_line_update()`: when `OLD.state <> 'draft'`, only `state, conversion_attempt, resolved_patient_id, order_id, registration_no, converted_at, failure_code, failed_at, sample_received_at, received_by, sample_missing, not_received_reason_code, updated_at, updated_by, version` may change — **except** the redaction function `partners.redact_lines` (owner role), which also nulls the patient fields and sets `is_redacted`, `redacted_at`; the trigger admits these columns only when `current_user = 'lims_owner'` and `current_setting('app.maintenance', true) = 'partners_redact_lines'` (08 A12.2, A19 P-41 — replaces the former ad-hoc `partners.redaction` GUC). For **partner** actors `partners.guard_partner_columns()` (§8, D-103) applies in addition.

### 3.6 `partners.pickup_requests`, `partners.pickup_request_manifests`

`pickup_requests`: partner_id; receiving_centre_id (= manifests' common centre); state `IN ('requested','scheduled','picked_up','cancelled','rejected')`; window_start, window_end timestamptz N (CHECK start < end); packages_count smallint N 1–50; notes ≤ 500 (P2 — address hints); contact_name ≤ 80 (P2-personal); contact_phone_e164 `^\+[1-9][0-9]{7,14}$` (P2-personal); scheduled_start, scheduled_end Y (both or neither; start < end); assignee_text ≤ 80 (P2-personal staff name); picked_up_at Y; cancel_reason_code Y; reject_reason_code Y; resolved_at, resolved_by Y.

`pickup_request_manifests`: tenant_id, pickup_request_id, manifest_id, partner_id, receiving_centre_id, created_at, created_by. PK (tenant_id, pickup_request_id, manifest_id). FKs `(tenant_id, manifest_id, partner_id) → manifests (tenant_id, id, partner_id)` and `(tenant_id, pickup_request_id, partner_id) → pickup_requests (tenant_id, id, partner_id)`, so a link can never join two partners. Partial UNIQUE (tenant_id, manifest_id) WHERE `is_open` — implemented as column `is_open boolean NOT NULL DEFAULT true` set false when the pickup becomes terminal **or when the manifest is detached from a still-open pickup** (MS5 withdraw, 03-APP-FLOW §2.1; "detach" = `is_open = false` on that link row; rows are never deleted) (the only updatable column besides `updated_*`) — enforces "one open pickup per manifest". Reads of a pickup's manifests (K3, SP1, PickupRequest DTO) list only `is_open` links.

### 3.7 Projections

`order_tracking` (PK (tenant_id, order_id); no `id` column — order_id is the key; UNIQUE (tenant_id, order_id, partner_id) as FK target for the per-partner children): partner_id N, line_id N (UNIQUE), manifest_id N, receiving_centre_id N, registration_no ≤ 40 (P2), tracking_status `IN ('registered','in_transit','in_lab','action_needed','partially_reported','reported','cancelled')`, registered_at N, last_event_at N, cancelled_at Y, report_count int N default 0 (`has_new_report` is computed on read: `EXISTS order_reports … is_new`, so partner mark-seen never writes this system-owned row), stored_order_status text Y (`pre_registered|registered|cancelled` from `frontdesk.v_pub_order_status`), reconciled_at Y, version, created/updated.

`tracked_specimens` (PK (tenant_id, specimen_id)): order_id N (FK (tenant_id, order_id, partner_id) → order_tracking — the copy of `partner_id` must equal the tracking row's), partner_id N, receiving_centre_id N, specimen_type_code ≤ 64 N, status N (CHECK = 03 §2.1 `SpecimenStatus` list), last_seq int N, collected_at, in_transit_at, received_at, rejected_at, reported_at Y, rejection_reason_code ≤ 64 Y, replaces_specimen_id Y, parent_specimen_id Y, changed_at N, created/updated. P1 (+ codes).

`order_reports` (PK (tenant_id, report_id, version_no); UNIQUE (tenant_id, report_id, version_no, partner_id)): order_id N (FK (tenant_id, order_id, partner_id) → order_tracking), partner_id N, receiving_centre_id N, kind text 1–32 (`report_kind` is `x-extensible`, so no closed CHECK — A13 P-4; known values `final`, `partial`, `preliminary`, `amended`, `addendum` (08 R1); an unknown value is stored as received and treated as `amended` for tracking and display, 02-TRD §7.2), status `IN ('valid','superseded')`, released_at N, panel_names text[] Y (P3), is_new bool N default true, seen_at Y, seen_by Y, enriched_at Y, created/updated.

`price_list_items` (PK (tenant_id, partner_id, orderable_id)): kind `IN ('test','panel')`, code ≤ 64, name ≤ 200, department_name ≤ 120 Y, unit_price_paisa bigint N ≥ 0, source `IN ('partner','standard')`, price_list_id uuid N, price_list_version int N, effective_from timestamptz N, effective_to Y, synced_at N. P0.

`price_list_syncs` (PK (tenant_id, partner_id)): synced_at, price_list_version Y, row_count int, last_error_code Y. P0.

`statement_months` (PK (tenant_id, partner_id, period_month, fiscal_year_bs)): credit_party_id N, period_month date N (first day of A.D. month; CHECK `extract(day from period_month) = 1`), fiscal_year_bs `^[0-9]{4}/[0-9]{2}$`, invoiced_paisa, paid_paisa, credited_paisa, closing_balance_paisa bigint N, synced_at N, is_stale bool N default false. P0 (organisation finance).

`download_counters` (PK (tenant_id, partner_user_id, day)): partner_id N, partner_user_id N (FK (tenant_id, partner_user_id, partner_id) → partner_users (tenant_id, id, partner_id)), day date N, count int N ≥ 0, `expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days'` [CONV: §6 retention 30 days], updated_at. P0. Deleted after `expires_at` by the system actor in the `partners.redact_expired_lines` per-tenant task (A17 P-18(c)).

### 3.7a `partners.access_slips` (08 A2.1)

One row per slip request. **No column holds the link token or URL** (08 A2.1; 03 §4.7). Mandatory class-C columns (§3 header) apply: `id` (UUIDv7, app-generated), `tenant_id`, `version`, `created_at/by`, `updated_at/by`.

| Column | Type | Null | Default / check | PHI |
|---|---|---|---|---|
| partner_id | uuid | N | FK (tenant_id, partner_id) → `partners.partners` | P0 |
| partner_user_id | uuid | N | FK (tenant_id, partner_user_id) → `partners.partner_users`; the requesting user | P0 |
| report_id | uuid | N | FK (tenant_id, report_id, version_no, partner_id) → `partners.order_reports` (tenant_id, report_id, version_no, partner_id) | P1 |
| version_no | integer | N | ≥ 1; the `valid` version at request time | P1 |
| order_id | uuid | N | FK (tenant_id, order_id, partner_id) → `partners.order_tracking` (tenant_id, order_id, partner_id) | P1 |
| state | text | N | `IN ('requested','issued','failed','expired')`, default `requested` | P0 |
| link_id | uuid | Y | `ReportingPort.issuePortalLink` → `linkId` (identifier, not a secret); NOT NULL iff state ∈ (`issued`,`expired`) | P1 |
| link_expires_at | timestamptz | Y | → `expiresAt`; NOT NULL iff state ∈ (`issued`,`expired`) | P0 |
| file_path | text | Y | `partners-slips` bucket object path `{tenant_id}/access-slips/{yyyy}/{mm}/{id}.pdf` (08 §4.8, A5.2), ≤ 200; NOT NULL iff state = `issued`; NULL after purge | P0 |
| file_sha256 | text | Y | content digest, hex `^[0-9a-f]{64}$` (08 A2.4: content digests may stay hex text); NOT NULL iff state = `issued` | P0 |
| file_byte_size | integer | Y | 1–10,485,760 [CONV]; NOT NULL iff state = `issued` | P0 |
| failure_code | text | Y | an `errors.yaml` code (≤ 64, `^[a-z_]+\.[a-z_]+$`); NOT NULL iff state = `failed` | P0 |
| issued_at | timestamptz | Y | set with `issued` | P0 |
| expired_at | timestamptz | Y | set with `expired` | P0 |

Transitions (trigger `partners.guard_access_slip_update`): `requested → issued | failed`, `issued → expired`; every UPDATE requires `app.current_actor_type() = 'system'`; partner actors may only INSERT rows with state `requested` (RLS WITH CHECK). The slip PDF itself (P2: patient display name, order ref, link as QR + text; rendered by `RenderPort` template `partners.access_slip`, 08 A5.1) lives only in the `partners-slips` bucket, registered in 08 §4.8 (A5.2): owner partners (C13), private, first path segment `{tenant_id}`, path `{tenant_id}/access-slips/{yyyy}/{mm}/{slip_id}.pdf`, written by the worker (write-once), deleted at link expiry, read server-side by R6 only.

### 3.8 `partners.settings` (PK (tenant_id); one row per tenant, lazy per A17 P-22)

A reader that finds no row uses the 02-TRD §10.2 defaults in code (partner requests included; partner claims never INSERT this table). The row is created only by staff paths: SS1 `updatePartnerSettings`, or SA2 `createPartner` in the same transaction, with `INSERT … ON CONFLICT (tenant_id) DO NOTHING` and the §10.2 defaults. `consent_statement` has a DB default equal to the §10.2 placeholder text.

Columns and ranges = 02-TRD §10.2 (`default_conversion_mode`, `include_default_price_list`, `require_mapped_referrer`, `access_slip_enabled`, `max_lines_per_manifest` 1–200, `draft_ttl_days` 1–90, `pickup_max_days_ahead` 1–30, `report_download_daily_cap_per_user` 50–5000, `consent_text_version` 1–32, `consent_statement` 1–2000), plus `version`, `created_*`, `updated_*`.

## 4. Indexes (one per query in 02-TRD; tenant_id leading — REQ-SEC-023)

| Index | Serves |
|---|---|
| `partners__tenant_id_status__idx` (tenant_id, status, partner_code) | SA1 |
| `partner_users__tenant_id_partner_id_status__idx` | U1, SA8, last-admin check |
| `partner_users__tenant_id_membership_id__uq` | helper + partner context (hot path) |
| `partner_referrers__tenant_id_partner_id_is_active__idx` (…, display_name_norm) | F1, line form |
| `partner_referrers__tenant_id_mapping_state__p_idx` WHERE mapping_state = 'unmapped' | SR1 |
| `manifests__tenant_id_partner_id_created_at__idx` (tenant_id, partner_id, created_at DESC, id) | M2 |
| `manifests__tenant_id_receiving_centre_id_state__p_idx` (tenant_id, receiving_centre_id, state, submitted_at DESC) WHERE state IN ('submitted','partially_received') | SI1 |
| `manifests__tenant_id_state_updated_at__p_idx` WHERE state = 'draft' | expire job |
| `manifest_lines__tenant_id_manifest_id_line_no__uq` | M3, SI2 |
| `manifest_lines__tenant_id_order_id__p_uq` WHERE order_id IS NOT NULL | consumers (order → line) |
| `manifest_lines__tenant_id_state_updated_at__p_idx` WHERE state IN ('converting','conversion_failed') | reconcile, SM-2 attention |
| `manifest_lines__tenant_id_partner_id_referrer_id__p_idx` WHERE state = 'converted' | samples_this_month, O1 filter by referrer |
| `manifest_lines__tenant_id_partner_id_sample_ref__idx` (tenant_id, partner_id, partner_sample_ref) | O2 exact |
| `manifest_lines__patient_name_trgm__idx` GIN (patient_full_name extensions.gin_trgm_ops) — **only if** C0 enables `pg_trgm` (REQ-ARCH-023 assumes it for C4); otherwise btree (tenant_id, partner_id, lower(patient_full_name) text_pattern_ops) for prefix search | O2 name |
| `manifest_lines__tenant_id_created_at__p_idx` WHERE NOT is_redacted | redaction job |
| `manifest_lines__tenant_id_receiving_centre_id__missing__p_idx` (tenant_id, receiving_centre_id) WHERE sample_missing AND state = 'converted' | SI1 filter `has_missing_samples` (on_submit "order exists, sample missing" staff task — 08 A19 D-104) |
| `pickup_requests__tenant_id_partner_id_created_at__idx` | K2 |
| `pickup_requests__tenant_id_receiving_centre_id_state__p_idx` WHERE state IN ('requested','scheduled') | SP1 |
| `pickup_request_manifests__tenant_id_manifest_id__p_uq` WHERE is_open | one open pickup per manifest |
| `order_tracking__tenant_id_partner_id_registered_at__idx` (…, registered_at DESC, order_id) | O1 default sort |
| `order_tracking__tenant_id_partner_id_status__idx` (tenant_id, partner_id, tracking_status, last_event_at DESC) | O1 filter, dashboard |
| `order_tracking__tenant_id_manifest_id__idx` | O1 `manifest_id` filter |
| `order_tracking__tenant_id_tracking_status_updated_at__p_idx` WHERE tracking_status NOT IN ('reported','cancelled') | reconcile |
| `tracked_specimens__tenant_id_order_id__idx` | O3, derivation |
| `order_reports__tenant_id_partner_id_released_at__idx` (…, released_at DESC, report_id, version_no) | R1 |
| `order_reports__tenant_id_partner_id_is_new__p_idx` WHERE is_new | dashboard, R1 `is_new` |
| `order_reports__tenant_id_order_id__idx` | O3, supersede |
| `price_list_items__tenant_id_partner_id_code__idx`, `…_name__idx` | P1/P2 |
| `statement_months__tenant_id_partner_id_period__idx` (…, period_month DESC) | S1 |
| `statement_months__tenant_id_credit_party_id__idx` | sync |
| `access_slips__tenant_id_partner_id_report_id_created_at__idx` (…, created_at DESC) | R5/R6 lookups, PR-2 |
| `access_slips__tenant_id_state_link_expires_at__p_idx` WHERE state = 'issued' | `partners.purge_access_slips` |
| `access_slips__tenant_id_state_created_at__p_idx` WHERE state = 'requested' | stuck-request alert |
| `download_counters__tenant_id_expires_at__idx` (tenant_id, expires_at) | P-18(c) purge in `partners.redact_expired_lines` |
| `partner_users__tenant_id_id_partner_id__uq`, `partner_referrers__tenant_id_id_partner_id__uq`, `manifests__tenant_id_id_partner_id__uq`, `pickup_requests__tenant_id_id_partner_id__uq`, `order_tracking__tenant_id_order_id_partner_id__uq`, `order_reports__tenant_id_report_id_version_no_partner_id__uq` | targets of the 3/4-column partner-consistency FKs (review C13 #5; 07-SECURITY ST7) |

## 5. Immutability, delete and grant rules

| Table | lims_app grants | DELETE |
|---|---|---|
| settings, partners, partner_users, partner_referrers | SELECT, INSERT, UPDATE | none (deactivate) |
| manifest_counters | SELECT, INSERT, UPDATE | none |
| manifests | SELECT, INSERT, UPDATE | none (discard = state) |
| manifest_lines | SELECT, INSERT, UPDATE, DELETE | DELETE policy only `state = 'draft'` and parent manifest draft (§6) — 02-CV §4.1 drafts |
| pickup_requests, pickup_request_manifests | SELECT, INSERT, UPDATE | none |
| order_tracking, tracked_specimens, order_reports, statement_months, price_list_syncs | SELECT, INSERT, UPDATE | none (projections are corrected in place by the system path) |
| download_counters | SELECT, INSERT, UPDATE, DELETE | DELETE policy `download_counters__delete__tenant`: system actor and `expires_at < now()` only (A17 P-18(c); class E) |
| access_slips | SELECT, INSERT, UPDATE | none (state `expired`; UPDATE policy system only) |
| price_list_items | SELECT, INSERT, UPDATE, DELETE | DELETE policy **SY** only (replace-on-sync) |
| event_inbox | SELECT, INSERT | owner purge only (C0) |
| g_cs_reasons | SELECT | owner only |

CI assertion (02-CV §5.6): `has_table_privilege('lims_app', 'partners.manifests', 'DELETE') = false` etc. for every row with "none".

## 6. Data classification and retention

| Data | Class | Retention |
|---|---|---|
| Manifest line patient block (name, sex, DOB/age, phone, consents) | P2 | redacted when the line's `created_at` is older than `TenantSettings.retentionYears` (default 5 — 04 I8; B15); drafts redacted on discard/expiry |
| `orderable_ids`, `orderables_snapshot`, `clinical_note`, `panel_names` | P3 | same as above (clinical_note and snapshot nulled/emptied by redaction; `orderable_ids` kept — ids only, P1 once the patient block is gone) |
| Projections | P1 (+P3 panel names) | kept while the line exists; `panel_names` nulled with the line redaction |
| Partner org contacts, doctors | P2-personal | life of the record (master data, deactivate only) |
| event_inbox | P1 | 90 days (C0) |
| download_counters | P0 | 30 days [CONV] via `expires_at`; deleted by the system actor in the `partners.redact_expired_lines` per-tenant task under `download_counters__delete__tenant` (A17 P-18(c); not a DEFINER) |
| `manifest_lines.registration_no`, `manifest_lines.partner_sample_ref`, `order_tracking.registration_no` (P2, lab-linked identifiers, 02-CV §9.2) | P2 | **kept** after redaction [CONV, review C13 m#30 option 2]: they are the keys partners and the lab use to reconcile statements and orders; once the patient block is nulled, C13 holds no name, demographics or phone to link them to a person |
| `pickup_requests.contact_name`, `contact_phone_e164`, `notes` | P2-personal (partner staff contact, address hints) | **kept** for the life of the record, like the partner organisation contacts below [CONV, m#30 option 2]: they are the partner's business contact data, not patient data |
| access_slips rows | P0/P1 (ids, no token/URL) | life of the line (ids only) |
| Slip PDF in the `partners-slips` bucket | P2 (+ link as QR/text) | until `link_expires_at`; deleted by `partners.purge_access_slips` at 02:50 (08 A2.1; accepted, 08 A5.3) |

`audit_log` triggers (C0 generic, 04 D11) on: `partners`, `partner_users`, `partner_referrers`, `manifests`, `manifest_lines`, `pickup_requests`, `settings`, `access_slips`. Not on projections (high churn, rebuildable).

## 7. Coded sets (global, `partners.g_cs_reasons`, class G; tenant extension not needed v1)

| set_name | codes (display; `other` has `requires_text = true`) |
|---|---|
| `manifest_withdraw_reasons` | `entered_in_error` "Entered by mistake", `samples_not_sent` "Samples not sent", `duplicate_manifest` "Duplicate manifest", `other` "Other" |
| `line_not_received_reasons` | `sample_missing` "Sample missing", `label_unreadable` "Label unreadable", `wrong_container` "Wrong container", `leaked_or_broken` "Leaked or broken", `test_not_available` "Test not available", `other` "Other" |
| `pickup_cancel_reasons` | `no_longer_needed` "No longer needed", `will_deliver_ourselves` "We will deliver ourselves", `manifest_withdrawn` "Manifest withdrawn", `other` "Other" |
| `pickup_reject_reasons` | `outside_service_area` "Outside service area", `no_rider_available` "No rider available", `window_too_short` "Window too short", `other` "Other" |
| `partner_suspend_reasons` | `credit_hold` "Credit hold", `agreement_ended` "Agreement ended", `security_concern` "Security concern", `other` "Other" |
| `partner_user_deactivate_reasons` | `left_organisation` "Left organisation", `role_changed` "Role changed", `security_concern` "Security concern", `other` "Other" |
| `referrer_mapping_reject_reasons` | `not_identifiable` "Cannot identify this doctor", `duplicate_entry` "Duplicate entry", `other` "Other" |

All codes are [CONV] seeds (synthetic-safe). Wire: `x-coded-set: <set_name>` (02-CV §5.5).

## 8. DDL (C0 transcribes into `db/migrations/<ts>_partners__*.sql` and `db/policies/partners.sql`)

```sql
-- =====================================================================
-- partners schema — C13 (spec). Prerequisites: core, catalog, frontdesk DDL;
-- app.current_partner_id() (CR-C13-004) created right after partners.partner_users.
-- =====================================================================

-- ---------- coded sets (G) ----------
CREATE TABLE partners.g_cs_reasons (
  id uuid NOT NULL,
  set_name text NOT NULL, code text NOT NULL, display text NOT NULL,
  requires_text boolean NOT NULL DEFAULT false, sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT g_cs_reasons__pk PRIMARY KEY (id),
  CONSTRAINT g_cs_reasons__set_code__uq UNIQUE (set_name, code),
  CONSTRAINT g_cs_reasons__set__ck CHECK (set_name IN ('manifest_withdraw_reasons','line_not_received_reasons',
    'pickup_cancel_reasons','pickup_reject_reasons','partner_suspend_reasons','partner_user_deactivate_reasons',
    'referrer_mapping_reject_reasons')),
  CONSTRAINT g_cs_reasons__code__ck CHECK (code ~ '^[a-z][a-z0-9_]{1,63}$')
);
GRANT SELECT ON partners.g_cs_reasons TO lims_app;   -- RLS-exempt (db/tests/rls_exempt.txt: "global coded set, no tenant data")

-- ---------- settings ----------
CREATE TABLE partners.settings (
  tenant_id uuid NOT NULL,
  default_conversion_mode text NOT NULL DEFAULT 'on_receipt',
  include_default_price_list boolean NOT NULL DEFAULT true,
  require_mapped_referrer boolean NOT NULL DEFAULT false,
  access_slip_enabled boolean NOT NULL DEFAULT false,
  max_lines_per_manifest integer NOT NULL DEFAULT 200,
  draft_ttl_days integer NOT NULL DEFAULT 30,
  pickup_max_days_ahead integer NOT NULL DEFAULT 7,
  report_download_daily_cap_per_user integer NOT NULL DEFAULT 500,
  consent_text_version text NOT NULL DEFAULT 'partner-v1',
  consent_statement text NOT NULL DEFAULT 'The patient has agreed that the lab may process their sample and contact them about the result.',  -- 02-TRD §10.2 placeholder [CONV; B16]
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT settings__pk PRIMARY KEY (tenant_id),
  CONSTRAINT settings__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT settings__mode__ck CHECK (default_conversion_mode IN ('on_receipt','on_submit')),
  CONSTRAINT settings__lines__ck CHECK (max_lines_per_manifest BETWEEN 1 AND 200),
  CONSTRAINT settings__draft_ttl__ck CHECK (draft_ttl_days BETWEEN 1 AND 90),
  CONSTRAINT settings__pickup_days__ck CHECK (pickup_max_days_ahead BETWEEN 1 AND 30),
  CONSTRAINT settings__dl_cap__ck CHECK (report_download_daily_cap_per_user BETWEEN 50 AND 5000),
  CONSTRAINT settings__consent_ver__ck CHECK (char_length(consent_text_version) BETWEEN 1 AND 32),
  CONSTRAINT settings__consent_stmt__ck CHECK (char_length(consent_statement) BETWEEN 1 AND 2000)
);

-- ---------- partners ----------
CREATE TABLE partners.partners (
  id uuid NOT NULL, tenant_id uuid NOT NULL,
  partner_code text NOT NULL, name text NOT NULL, status text NOT NULL DEFAULT 'active',
  credit_party_id uuid NOT NULL, receiving_branch_id uuid NOT NULL, receiving_centre_id uuid NOT NULL,
  conversion_mode text NOT NULL,
  contact_email text, contact_phone_e164 text, address_text text,
  suspended_at timestamptz, suspended_by uuid, suspend_reason_code text, suspend_reason_text text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT partners__pk PRIMARY KEY (id),
  CONSTRAINT partners__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT partners__tenant_id_partner_code__uq UNIQUE (tenant_id, partner_code),
  CONSTRAINT partners__tenant_id_credit_party_id__uq UNIQUE (tenant_id, credit_party_id),
  CONSTRAINT partners__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT partners__credit_party__fk FOREIGN KEY (tenant_id, credit_party_id) REFERENCES catalog.credit_parties (tenant_id, id),
  CONSTRAINT partners__branch__fk FOREIGN KEY (tenant_id, receiving_branch_id) REFERENCES core.branches (tenant_id, id),
  CONSTRAINT partners__centre__fk FOREIGN KEY (tenant_id, receiving_centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT partners__code__ck CHECK (partner_code ~ '^[A-Z0-9_-]{1,20}$'),
  CONSTRAINT partners__name__ck CHECK (char_length(name) BETWEEN 1 AND 160),
  CONSTRAINT partners__status__ck CHECK (status IN ('active','suspended')),
  CONSTRAINT partners__mode__ck CHECK (conversion_mode IN ('on_receipt','on_submit')),
  CONSTRAINT partners__email__ck CHECK (contact_email IS NULL OR char_length(contact_email) <= 254),
  CONSTRAINT partners__phone__ck CHECK (contact_phone_e164 IS NULL OR contact_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),   -- A13 P-11
  CONSTRAINT partners__addr__ck CHECK (address_text IS NULL OR char_length(address_text) <= 300),
  CONSTRAINT partners__suspend__ck CHECK ((status = 'suspended') = (suspended_at IS NOT NULL AND suspend_reason_code IS NOT NULL)),
  CONSTRAINT partners__suspend_text__ck CHECK (suspend_reason_text IS NULL OR char_length(suspend_reason_text) <= 300)
);
CREATE INDEX partners__tenant_id_status__idx ON partners.partners (tenant_id, status, partner_code);

-- ---------- partner users ----------
CREATE TABLE partners.partner_users (
  id uuid NOT NULL, tenant_id uuid NOT NULL, partner_id uuid NOT NULL, membership_id uuid NOT NULL,
  partner_role text NOT NULL, status text NOT NULL DEFAULT 'invited',
  display_name text NOT NULL, email_masked text NOT NULL,
  activated_at timestamptz, deactivated_at timestamptz, deactivated_by uuid, deactivate_reason_code text,
  invited_by_actor_type text NOT NULL,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT partner_users__pk PRIMARY KEY (id),
  CONSTRAINT partner_users__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT partner_users__tenant_id_membership_id__uq UNIQUE (tenant_id, membership_id),
  CONSTRAINT partner_users__tenant_id_id_partner_id__uq UNIQUE (tenant_id, id, partner_id),   -- FK target (review #5)
  CONSTRAINT partner_users__partner__fk FOREIGN KEY (tenant_id, partner_id) REFERENCES partners.partners (tenant_id, id),
  CONSTRAINT partner_users__membership__fk FOREIGN KEY (tenant_id, membership_id) REFERENCES core.memberships (tenant_id, id),
  CONSTRAINT partner_users__role__ck CHECK (partner_role IN ('partner_admin','partner_member')),
  CONSTRAINT partner_users__status__ck CHECK (status IN ('invited','active','deactivated')),
  CONSTRAINT partner_users__name__ck CHECK (char_length(display_name) BETWEEN 1 AND 120),
  CONSTRAINT partner_users__email__ck CHECK (char_length(email_masked) BETWEEN 3 AND 64),
  CONSTRAINT partner_users__deact__ck CHECK ((status = 'deactivated') = (deactivated_at IS NOT NULL)),
  CONSTRAINT partner_users__inviter__ck CHECK (invited_by_actor_type IN ('user','partner'))
);
CREATE INDEX partner_users__tenant_id_partner_id_status__idx ON partners.partner_users (tenant_id, partner_id, status, partner_role);

-- ---------- helper (CR-C13-004) — created here because it reads partner_users/partners ----------
-- Created first by the C0 helpers stage (C0 05-SCHEMA §4.5, 08 A30.1; C6 policies use it); same text, so CREATE OR REPLACE here.
CREATE OR REPLACE FUNCTION app.current_partner_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN app.current_actor_type() = 'partner' THEN (
    SELECT pu.partner_id
    FROM partners.partner_users pu
    JOIN partners.partners p ON p.tenant_id = pu.tenant_id AND p.id = pu.partner_id
    WHERE pu.tenant_id = app.current_tenant_id()
      AND pu.membership_id = nullif(app.current_claims() ->> 'membership_id', '')::uuid
      AND pu.status IN ('invited','active')
      AND p.status = 'active') END
$$;
ALTER FUNCTION app.current_partner_id() OWNER TO lims_owner;
REVOKE ALL ON FUNCTION app.current_partner_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_partner_id() TO lims_app;
-- Owner policies (08 A10.5, A19 P-41(b)/(c); review C13 #1 with the narrower USING of triage batch 3 §(c)):
-- FORCE RLS applies to lims_owner, and the lims_app policies below do not match lims_owner, so without these the
-- DEFINER would always see 0 rows and return NULL. Tenant-claim DEFINER → gated on app.current_tenant_id() + the claim column.
CREATE POLICY partner_users__select__owner_only ON partners.partner_users FOR SELECT TO lims_owner
  USING (tenant_id = (SELECT app.current_tenant_id())
         AND membership_id = nullif(app.current_claims() ->> 'membership_id', '')::uuid);
CREATE POLICY partners__select__owner_only ON partners.partners FOR SELECT TO lims_owner
  USING (tenant_id = (SELECT app.current_tenant_id()));
-- Inventory row (P-41(d); 08 §4.7 / 03-IC §13.3, already listed): app.current_partner_id() — owner lims_owner, EXECUTE lims_app, C13-004.

-- ---------- referrers ----------
CREATE TABLE partners.partner_referrers (
  id uuid NOT NULL, tenant_id uuid NOT NULL, partner_id uuid NOT NULL,
  display_name text NOT NULL, display_name_norm text NOT NULL,
  qualification text, registration_council text, registration_no text,
  mapping_state text NOT NULL DEFAULT 'unmapped', catalog_doctor_id uuid,
  mapped_at timestamptz, mapped_by uuid, mapping_reject_reason_code text, mapping_reject_text text,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT partner_referrers__pk PRIMARY KEY (id),
  CONSTRAINT partner_referrers__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT partner_referrers__tenant_id_id_partner_id__uq UNIQUE (tenant_id, id, partner_id),   -- FK target (review #5)
  CONSTRAINT partner_referrers__partner__fk FOREIGN KEY (tenant_id, partner_id) REFERENCES partners.partners (tenant_id, id),
  CONSTRAINT partner_referrers__doctor__fk FOREIGN KEY (tenant_id, catalog_doctor_id) REFERENCES catalog.doctors (tenant_id, id),
  CONSTRAINT partner_referrers__name__ck CHECK (char_length(display_name) BETWEEN 1 AND 120 AND char_length(display_name_norm) BETWEEN 1 AND 120),
  CONSTRAINT partner_referrers__qual__ck CHECK (qualification IS NULL OR char_length(qualification) <= 120),
  CONSTRAINT partner_referrers__council__ck CHECK (registration_council IS NULL OR char_length(registration_council) <= 20),
  CONSTRAINT partner_referrers__regno__ck CHECK (registration_no IS NULL OR char_length(registration_no) <= 30),
  CONSTRAINT partner_referrers__state__ck CHECK (mapping_state IN ('unmapped','mapped','rejected')),
  CONSTRAINT partner_referrers__mapped__ck CHECK ((mapping_state = 'mapped') = (catalog_doctor_id IS NOT NULL)),
  CONSTRAINT partner_referrers__rejected__ck CHECK ((mapping_state = 'rejected') = (mapping_reject_reason_code IS NOT NULL)),
  CONSTRAINT partner_referrers__rej_text__ck CHECK (mapping_reject_text IS NULL OR char_length(mapping_reject_text) <= 300)
);
CREATE UNIQUE INDEX partner_referrers__tenant_id_partner_id_name_regno__p_uq
  ON partners.partner_referrers (tenant_id, partner_id, display_name_norm, coalesce(registration_no, '')) WHERE is_active;
CREATE INDEX partner_referrers__tenant_id_partner_id_is_active__idx ON partners.partner_referrers (tenant_id, partner_id, is_active, display_name_norm);
CREATE INDEX partner_referrers__tenant_id_mapping_state__p_idx ON partners.partner_referrers (tenant_id, created_at) WHERE mapping_state = 'unmapped';

-- ---------- manifest counters ----------
CREATE TABLE partners.manifest_counters (
  tenant_id uuid NOT NULL, partner_id uuid NOT NULL, yy smallint NOT NULL, last_seq integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT manifest_counters__pk PRIMARY KEY (tenant_id, partner_id, yy),
  CONSTRAINT manifest_counters__partner__fk FOREIGN KEY (tenant_id, partner_id) REFERENCES partners.partners (tenant_id, id),
  CONSTRAINT manifest_counters__yy__ck CHECK (yy BETWEEN 0 AND 99),
  CONSTRAINT manifest_counters__seq__ck CHECK (last_seq BETWEEN 1 AND 999999)
);

-- ---------- manifests ----------
CREATE TABLE partners.manifests (
  id uuid NOT NULL, tenant_id uuid NOT NULL, partner_id uuid NOT NULL,
  manifest_no text NOT NULL, state text NOT NULL DEFAULT 'draft',
  receiving_branch_id uuid NOT NULL, receiving_centre_id uuid NOT NULL, conversion_mode text NOT NULL,
  notes text, collected_on date, line_count integer NOT NULL DEFAULT 0,
  submitted_at timestamptz, submitted_by uuid, received_at timestamptz, received_by uuid, in_transit_at timestamptz,
  withdrawn_at timestamptz, withdrawn_by uuid, withdraw_reason_code text, withdraw_reason_text text,
  discarded_at timestamptz,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT manifests__pk PRIMARY KEY (id),
  CONSTRAINT manifests__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT manifests__tenant_id_id_partner_id__uq UNIQUE (tenant_id, id, partner_id),   -- FK target (review #5)
  CONSTRAINT manifests__tenant_id_partner_id_no__uq UNIQUE (tenant_id, partner_id, manifest_no),
  CONSTRAINT manifests__partner__fk FOREIGN KEY (tenant_id, partner_id) REFERENCES partners.partners (tenant_id, id),
  CONSTRAINT manifests__branch__fk FOREIGN KEY (tenant_id, receiving_branch_id) REFERENCES core.branches (tenant_id, id),
  CONSTRAINT manifests__centre__fk FOREIGN KEY (tenant_id, receiving_centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT manifests__no__ck CHECK (manifest_no ~ '^MF[0-9]{8}$'),
  CONSTRAINT manifests__state__ck CHECK (state IN ('draft','submitted','partially_received','received','withdrawn','discarded')),
  CONSTRAINT manifests__mode__ck CHECK (conversion_mode IN ('on_receipt','on_submit')),
  CONSTRAINT manifests__notes__ck CHECK (notes IS NULL OR char_length(notes) <= 500),
  CONSTRAINT manifests__lines__ck CHECK (line_count BETWEEN 0 AND 200),
  CONSTRAINT manifests__submitted__ck CHECK ((state IN ('draft','discarded')) = (submitted_at IS NULL)),
  CONSTRAINT manifests__withdrawn__ck CHECK ((state = 'withdrawn') = (withdrawn_at IS NOT NULL AND withdraw_reason_code IS NOT NULL)),
  CONSTRAINT manifests__withdraw_text__ck CHECK (withdraw_reason_text IS NULL OR char_length(withdraw_reason_text) <= 300),
  CONSTRAINT manifests__discarded__ck CHECK ((state = 'discarded') = (discarded_at IS NOT NULL))
);
CREATE INDEX manifests__tenant_id_partner_id_created_at__idx ON partners.manifests (tenant_id, partner_id, created_at DESC, id);
CREATE INDEX manifests__tenant_id_receiving_centre_id_state__p_idx ON partners.manifests (tenant_id, receiving_centre_id, state, submitted_at DESC)
  WHERE state IN ('submitted','partially_received');
CREATE INDEX manifests__tenant_id_state_updated_at__p_idx ON partners.manifests (tenant_id, updated_at) WHERE state = 'draft';

-- ---------- manifest lines ----------
CREATE TABLE partners.manifest_lines (
  id uuid NOT NULL, tenant_id uuid NOT NULL, partner_id uuid NOT NULL, manifest_id uuid NOT NULL,
  receiving_centre_id uuid NOT NULL, line_no integer NOT NULL, state text NOT NULL DEFAULT 'draft',
  partner_sample_ref text,
  patient_full_name text, patient_sex text, patient_birth_on date, patient_age_years smallint, patient_phone_e164 text,
  consent_attested boolean NOT NULL, consent_sms boolean NOT NULL DEFAULT false, consent_whatsapp boolean NOT NULL DEFAULT false,
  consent_email boolean NOT NULL DEFAULT false, consent_share_with_referrer boolean NOT NULL DEFAULT false,
  consent_text_version text NOT NULL,
  orderable_ids uuid[] NOT NULL, orderables_snapshot jsonb NOT NULL,
  priority text NOT NULL, referrer_id uuid, collected_at timestamptz, clinical_note text,
  resolved_patient_id uuid, conversion_attempt integer NOT NULL DEFAULT 0,
  order_id uuid, registration_no text, converted_at timestamptz,
  failure_code text, failed_at timestamptz,
  sample_received_at timestamptz, received_by uuid, sample_missing boolean NOT NULL DEFAULT false,
  not_received_reason_code text,
  is_redacted boolean NOT NULL DEFAULT false, redacted_at timestamptz,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT manifest_lines__pk PRIMARY KEY (id),
  CONSTRAINT manifest_lines__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT manifest_lines__tenant_id_manifest_id_line_no__uq UNIQUE (tenant_id, manifest_id, line_no),
  CONSTRAINT manifest_lines__manifest__fk FOREIGN KEY (tenant_id, manifest_id) REFERENCES partners.manifests (tenant_id, id),
  CONSTRAINT manifest_lines__partner__fk FOREIGN KEY (tenant_id, partner_id) REFERENCES partners.partners (tenant_id, id),
  CONSTRAINT manifest_lines__centre__fk FOREIGN KEY (tenant_id, receiving_centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT manifest_lines__referrer__fk FOREIGN KEY (tenant_id, referrer_id, partner_id)
    REFERENCES partners.partner_referrers (tenant_id, id, partner_id),   -- MATCH SIMPLE: NULL referrer_id is not checked
  CONSTRAINT manifest_lines__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES frontdesk.orders (tenant_id, id),
  CONSTRAINT manifest_lines__line_no__ck CHECK (line_no BETWEEN 1 AND 200),
  CONSTRAINT manifest_lines__state__ck CHECK (state IN ('draft','submitted','converting','converted','conversion_failed',
    'not_received','withdrawn','discarded','cancelled')),
  CONSTRAINT manifest_lines__ref__ck CHECK (partner_sample_ref IS NULL OR partner_sample_ref ~ '^[A-Za-z0-9_./-]{1,40}$'),
  CONSTRAINT manifest_lines__name__ck CHECK (patient_full_name IS NULL OR char_length(patient_full_name) BETWEEN 1 AND 120),
  CONSTRAINT manifest_lines__sex__ck CHECK (patient_sex IS NULL OR patient_sex IN ('male','female','other','unknown')),
  CONSTRAINT manifest_lines__dob__ck CHECK (patient_birth_on IS NULL OR patient_birth_on >= DATE '1900-01-01'),
  CONSTRAINT manifest_lines__age__ck CHECK (patient_age_years IS NULL OR patient_age_years BETWEEN 0 AND 130),
  CONSTRAINT manifest_lines__phone__ck CHECK (patient_phone_e164 IS NULL OR patient_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),   -- A13 P-11
  CONSTRAINT manifest_lines__patient__ck CHECK (is_redacted OR (patient_full_name IS NOT NULL AND patient_sex IS NOT NULL
    AND ((patient_birth_on IS NULL) <> (patient_age_years IS NULL)) AND consent_attested)),
  CONSTRAINT manifest_lines__consent_ver__ck CHECK (char_length(consent_text_version) BETWEEN 1 AND 32),
  CONSTRAINT manifest_lines__orderables__ck CHECK (cardinality(orderable_ids) BETWEEN 1 AND 30),
  CONSTRAINT manifest_lines__snapshot__ck CHECK (jsonb_typeof(orderables_snapshot) = 'array'),
  CONSTRAINT manifest_lines__priority__ck CHECK (priority IN ('routine','urgent')),
  CONSTRAINT manifest_lines__note__ck CHECK (clinical_note IS NULL OR char_length(clinical_note) <= 300),
  CONSTRAINT manifest_lines__attempt__ck CHECK (conversion_attempt BETWEEN 0 AND 100),
  CONSTRAINT manifest_lines__converted__ck CHECK ((order_id IS NOT NULL) = (converted_at IS NOT NULL)),
  CONSTRAINT manifest_lines__converted_state__ck CHECK (state NOT IN ('converted','cancelled') OR order_id IS NOT NULL),
  CONSTRAINT manifest_lines__regno__ck CHECK (registration_no IS NULL OR char_length(registration_no) <= 40),
  CONSTRAINT manifest_lines__failed__ck CHECK ((state = 'conversion_failed') = (failure_code IS NOT NULL)),
  CONSTRAINT manifest_lines__failure_code__ck CHECK (failure_code IS NULL OR failure_code ~ '^[a-z_]+\.[a-z_]+$'),
  CONSTRAINT manifest_lines__not_received__ck CHECK ((state = 'not_received' OR sample_missing) = (not_received_reason_code IS NOT NULL)),
  CONSTRAINT manifest_lines__redacted__ck CHECK (is_redacted = (redacted_at IS NOT NULL))
);
CREATE UNIQUE INDEX manifest_lines__tenant_id_manifest_id_ref__p_uq ON partners.manifest_lines (tenant_id, manifest_id, partner_sample_ref)
  WHERE partner_sample_ref IS NOT NULL;
CREATE UNIQUE INDEX manifest_lines__tenant_id_order_id__p_uq ON partners.manifest_lines (tenant_id, order_id) WHERE order_id IS NOT NULL;
CREATE INDEX manifest_lines__tenant_id_state_updated_at__p_idx ON partners.manifest_lines (tenant_id, state, updated_at)
  WHERE state IN ('converting','conversion_failed');
CREATE INDEX manifest_lines__tenant_id_partner_id_referrer_id__p_idx
  ON partners.manifest_lines (tenant_id, partner_id, referrer_id, converted_at) WHERE state = 'converted';
CREATE INDEX manifest_lines__tenant_id_partner_id_sample_ref__idx ON partners.manifest_lines (tenant_id, partner_id, partner_sample_ref);
-- name search: C0 picks ONE of the two, depending on whether pg_trgm is enabled in the pinned image (REQ-ARCH-023)
-- (a) CREATE INDEX manifest_lines__patient_name_trgm__idx ON partners.manifest_lines USING gin (patient_full_name extensions.gin_trgm_ops);
-- (b) CREATE INDEX manifest_lines__tenant_id_partner_id_name__idx ON partners.manifest_lines (tenant_id, partner_id, lower(patient_full_name) text_pattern_ops);
CREATE INDEX manifest_lines__tenant_id_created_at__p_idx ON partners.manifest_lines (tenant_id, created_at) WHERE NOT is_redacted;
CREATE INDEX manifest_lines__tenant_id_receiving_centre_id__missing__p_idx ON partners.manifest_lines (tenant_id, receiving_centre_id)
  WHERE sample_missing AND state = 'converted';   -- 08 A19 D-104 (SI1 has_missing_samples)

-- ---------- pickups ----------
CREATE TABLE partners.pickup_requests (
  id uuid NOT NULL, tenant_id uuid NOT NULL, partner_id uuid NOT NULL, receiving_centre_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'requested',
  window_start timestamptz NOT NULL, window_end timestamptz NOT NULL, packages_count smallint NOT NULL,
  notes text, contact_name text, contact_phone_e164 text,
  scheduled_start timestamptz, scheduled_end timestamptz, assignee_text text, picked_up_at timestamptz,
  cancel_reason_code text, reject_reason_code text, resolved_at timestamptz, resolved_by uuid,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT pickup_requests__pk PRIMARY KEY (id),
  CONSTRAINT pickup_requests__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT pickup_requests__tenant_id_id_partner_id__uq UNIQUE (tenant_id, id, partner_id),   -- FK target (review #5)
  CONSTRAINT pickup_requests__partner__fk FOREIGN KEY (tenant_id, partner_id) REFERENCES partners.partners (tenant_id, id),
  CONSTRAINT pickup_requests__centre__fk FOREIGN KEY (tenant_id, receiving_centre_id) REFERENCES core.collection_centres (tenant_id, id),
  CONSTRAINT pickup_requests__state__ck CHECK (state IN ('requested','scheduled','picked_up','cancelled','rejected')),
  CONSTRAINT pickup_requests__window__ck CHECK (window_start < window_end),
  CONSTRAINT pickup_requests__packages__ck CHECK (packages_count BETWEEN 1 AND 50),
  CONSTRAINT pickup_requests__notes__ck CHECK (notes IS NULL OR char_length(notes) <= 500),
  CONSTRAINT pickup_requests__contact__ck CHECK (contact_name IS NULL OR char_length(contact_name) <= 80),
  CONSTRAINT pickup_requests__phone__ck CHECK (contact_phone_e164 IS NULL OR contact_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),   -- A13 P-11
  CONSTRAINT pickup_requests__sched__ck CHECK ((scheduled_start IS NULL) = (scheduled_end IS NULL) AND (scheduled_start IS NULL OR scheduled_start < scheduled_end)),
  CONSTRAINT pickup_requests__sched_state__ck CHECK (state <> 'scheduled' OR scheduled_start IS NOT NULL),
  CONSTRAINT pickup_requests__assignee__ck CHECK (assignee_text IS NULL OR char_length(assignee_text) <= 80),
  CONSTRAINT pickup_requests__picked__ck CHECK ((state = 'picked_up') = (picked_up_at IS NOT NULL)),
  CONSTRAINT pickup_requests__cancel__ck CHECK ((state = 'cancelled') = (cancel_reason_code IS NOT NULL)),
  CONSTRAINT pickup_requests__reject__ck CHECK ((state = 'rejected') = (reject_reason_code IS NOT NULL))
);
CREATE INDEX pickup_requests__tenant_id_partner_id_created_at__idx ON partners.pickup_requests (tenant_id, partner_id, created_at DESC, id);
CREATE INDEX pickup_requests__tenant_id_receiving_centre_id_state__p_idx ON partners.pickup_requests (tenant_id, receiving_centre_id, window_start)
  WHERE state IN ('requested','scheduled');

CREATE TABLE partners.pickup_request_manifests (
  tenant_id uuid NOT NULL, pickup_request_id uuid NOT NULL, manifest_id uuid NOT NULL,
  partner_id uuid NOT NULL, receiving_centre_id uuid NOT NULL, is_open boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT pickup_request_manifests__pk PRIMARY KEY (tenant_id, pickup_request_id, manifest_id),
  CONSTRAINT pickup_request_manifests__pickup__fk FOREIGN KEY (tenant_id, pickup_request_id, partner_id)
    REFERENCES partners.pickup_requests (tenant_id, id, partner_id),
  CONSTRAINT pickup_request_manifests__manifest__fk FOREIGN KEY (tenant_id, manifest_id, partner_id)
    REFERENCES partners.manifests (tenant_id, id, partner_id),
  CONSTRAINT pickup_request_manifests__partner__fk FOREIGN KEY (tenant_id, partner_id) REFERENCES partners.partners (tenant_id, id)
);
CREATE UNIQUE INDEX pickup_request_manifests__tenant_id_manifest_id__p_uq ON partners.pickup_request_manifests (tenant_id, manifest_id) WHERE is_open;

-- ---------- projections ----------
CREATE TABLE partners.order_tracking (
  tenant_id uuid NOT NULL, order_id uuid NOT NULL, partner_id uuid NOT NULL, line_id uuid NOT NULL, manifest_id uuid NOT NULL,
  receiving_centre_id uuid NOT NULL, registration_no text,
  tracking_status text NOT NULL, registered_at timestamptz NOT NULL, last_event_at timestamptz NOT NULL,
  cancelled_at timestamptz, report_count integer NOT NULL DEFAULT 0,
  stored_order_status text, reconciled_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT order_tracking__pk PRIMARY KEY (tenant_id, order_id),
  CONSTRAINT order_tracking__tenant_id_line_id__uq UNIQUE (tenant_id, line_id),
  CONSTRAINT order_tracking__tenant_id_order_id_partner_id__uq UNIQUE (tenant_id, order_id, partner_id),   -- FK target (review #5)
  CONSTRAINT order_tracking__line__fk FOREIGN KEY (tenant_id, line_id) REFERENCES partners.manifest_lines (tenant_id, id),
  CONSTRAINT order_tracking__manifest__fk FOREIGN KEY (tenant_id, manifest_id) REFERENCES partners.manifests (tenant_id, id),
  CONSTRAINT order_tracking__partner__fk FOREIGN KEY (tenant_id, partner_id) REFERENCES partners.partners (tenant_id, id),
  CONSTRAINT order_tracking__order__fk FOREIGN KEY (tenant_id, order_id) REFERENCES frontdesk.orders (tenant_id, id),
  CONSTRAINT order_tracking__status__ck CHECK (tracking_status IN ('registered','in_transit','in_lab','action_needed',
    'partially_reported','reported','cancelled')),
  CONSTRAINT order_tracking__stored__ck CHECK (stored_order_status IS NULL OR stored_order_status IN ('pre_registered','registered','cancelled')),
  CONSTRAINT order_tracking__regno__ck CHECK (registration_no IS NULL OR char_length(registration_no) <= 40)
);
CREATE INDEX order_tracking__tenant_id_partner_id_registered_at__idx ON partners.order_tracking (tenant_id, partner_id, registered_at DESC, order_id);
CREATE INDEX order_tracking__tenant_id_partner_id_status__idx ON partners.order_tracking (tenant_id, partner_id, tracking_status, last_event_at DESC);
CREATE INDEX order_tracking__tenant_id_manifest_id__idx ON partners.order_tracking (tenant_id, manifest_id);
CREATE INDEX order_tracking__tenant_id_updated_at__p_idx ON partners.order_tracking (tenant_id, updated_at)
  WHERE tracking_status NOT IN ('reported','cancelled');

CREATE TABLE partners.tracked_specimens (
  tenant_id uuid NOT NULL, specimen_id uuid NOT NULL, order_id uuid NOT NULL, partner_id uuid NOT NULL,
  receiving_centre_id uuid NOT NULL, specimen_type_code text NOT NULL, status text NOT NULL, last_seq integer NOT NULL,
  collected_at timestamptz, in_transit_at timestamptz, received_at timestamptz, rejected_at timestamptz, reported_at timestamptz,
  rejection_reason_code text, replaces_specimen_id uuid, parent_specimen_id uuid, changed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT tracked_specimens__pk PRIMARY KEY (tenant_id, specimen_id),
  CONSTRAINT tracked_specimens__order__fk FOREIGN KEY (tenant_id, order_id, partner_id)
    REFERENCES partners.order_tracking (tenant_id, order_id, partner_id),
  CONSTRAINT tracked_specimens__type__ck CHECK (char_length(specimen_type_code) BETWEEN 1 AND 64),
  CONSTRAINT tracked_specimens__status__ck CHECK (status IN ('ordered','collected','in_transit','received','aliquoted','in_process',
    'resulted','verified','approved','reported','rejected','recollection_ordered','stored','discarded')),
  CONSTRAINT tracked_specimens__seq__ck CHECK (last_seq >= 0),
  CONSTRAINT tracked_specimens__reason__ck CHECK (rejection_reason_code IS NULL OR char_length(rejection_reason_code) <= 64)
);
CREATE INDEX tracked_specimens__tenant_id_order_id__idx ON partners.tracked_specimens (tenant_id, order_id);

CREATE TABLE partners.order_reports (
  tenant_id uuid NOT NULL, report_id uuid NOT NULL, version_no integer NOT NULL, order_id uuid NOT NULL,
  partner_id uuid NOT NULL, receiving_centre_id uuid NOT NULL,
  kind text NOT NULL, status text NOT NULL DEFAULT 'valid', released_at timestamptz NOT NULL,
  panel_names text[], is_new boolean NOT NULL DEFAULT true, seen_at timestamptz, seen_by uuid, enriched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT order_reports__pk PRIMARY KEY (tenant_id, report_id, version_no),
  CONSTRAINT order_reports__tenant_id_report_id_version_no_partner_id__uq UNIQUE (tenant_id, report_id, version_no, partner_id),   -- FK target (review #5)
  CONSTRAINT order_reports__order__fk FOREIGN KEY (tenant_id, order_id, partner_id)
    REFERENCES partners.order_tracking (tenant_id, order_id, partner_id),
  CONSTRAINT order_reports__kind__ck CHECK (char_length(kind) BETWEEN 1 AND 32),   -- report_kind is x-extensible (A13 P-4); known: final, partial, preliminary, amended, addendum (08 R1)
  CONSTRAINT order_reports__status__ck CHECK (status IN ('valid','superseded')),
  CONSTRAINT order_reports__version__ck CHECK (version_no >= 1),
  CONSTRAINT order_reports__panels__ck CHECK (panel_names IS NULL OR cardinality(panel_names) <= 50),
  CONSTRAINT order_reports__seen__ck CHECK (is_new OR seen_at IS NOT NULL)
);
CREATE INDEX order_reports__tenant_id_partner_id_released_at__idx ON partners.order_reports (tenant_id, partner_id, released_at DESC, report_id, version_no);
CREATE INDEX order_reports__tenant_id_partner_id_is_new__p_idx ON partners.order_reports (tenant_id, partner_id, released_at DESC) WHERE is_new;
CREATE INDEX order_reports__tenant_id_order_id__idx ON partners.order_reports (tenant_id, order_id, is_new);

CREATE TABLE partners.price_list_items (
  tenant_id uuid NOT NULL, partner_id uuid NOT NULL, orderable_id uuid NOT NULL,
  kind text NOT NULL, code text NOT NULL, name text NOT NULL, department_name text,
  unit_price_paisa bigint NOT NULL, source text NOT NULL, price_list_id uuid NOT NULL, price_list_version integer NOT NULL,
  effective_from timestamptz NOT NULL, effective_to timestamptz, synced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT price_list_items__pk PRIMARY KEY (tenant_id, partner_id, orderable_id),
  CONSTRAINT price_list_items__partner__fk FOREIGN KEY (tenant_id, partner_id) REFERENCES partners.partners (tenant_id, id),
  CONSTRAINT price_list_items__kind__ck CHECK (kind IN ('test','panel')),
  CONSTRAINT price_list_items__code__ck CHECK (char_length(code) BETWEEN 1 AND 64),
  CONSTRAINT price_list_items__name__ck CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT price_list_items__dept__ck CHECK (department_name IS NULL OR char_length(department_name) <= 120),
  CONSTRAINT price_list_items__price__ck CHECK (unit_price_paisa BETWEEN 0 AND 9007199254740991),
  CONSTRAINT price_list_items__source__ck CHECK (source IN ('partner','standard'))
);
CREATE INDEX price_list_items__tenant_id_partner_id_code__idx ON partners.price_list_items (tenant_id, partner_id, code);
CREATE INDEX price_list_items__tenant_id_partner_id_name__idx ON partners.price_list_items (tenant_id, partner_id, lower(name) text_pattern_ops);

CREATE TABLE partners.price_list_syncs (
  tenant_id uuid NOT NULL, partner_id uuid NOT NULL, synced_at timestamptz NOT NULL, price_list_version integer,
  row_count integer NOT NULL DEFAULT 0, last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT price_list_syncs__pk PRIMARY KEY (tenant_id, partner_id),
  CONSTRAINT price_list_syncs__partner__fk FOREIGN KEY (tenant_id, partner_id) REFERENCES partners.partners (tenant_id, id)
);

CREATE TABLE partners.statement_months (
  tenant_id uuid NOT NULL, partner_id uuid NOT NULL, credit_party_id uuid NOT NULL,
  period_month date NOT NULL, fiscal_year_bs text NOT NULL,
  invoiced_paisa bigint NOT NULL, paid_paisa bigint NOT NULL, credited_paisa bigint NOT NULL, closing_balance_paisa bigint NOT NULL,
  synced_at timestamptz NOT NULL, is_stale boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT statement_months__pk PRIMARY KEY (tenant_id, partner_id, period_month, fiscal_year_bs),
  CONSTRAINT statement_months__partner__fk FOREIGN KEY (tenant_id, partner_id) REFERENCES partners.partners (tenant_id, id),
  CONSTRAINT statement_months__month__ck CHECK (extract(day FROM period_month) = 1),
  CONSTRAINT statement_months__fy__ck CHECK (fiscal_year_bs ~ '^[0-9]{4}/[0-9]{2}$')
);
CREATE INDEX statement_months__tenant_id_partner_id_period__idx ON partners.statement_months (tenant_id, partner_id, period_month DESC);
CREATE INDEX statement_months__tenant_id_credit_party_id__idx ON partners.statement_months (tenant_id, credit_party_id);

CREATE TABLE partners.download_counters (
  tenant_id uuid NOT NULL, partner_user_id uuid NOT NULL, day date NOT NULL, partner_id uuid NOT NULL,
  count integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),   -- [CONV] §6 retention; P-18(c) purge
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT download_counters__pk PRIMARY KEY (tenant_id, partner_user_id, day),
  CONSTRAINT download_counters__user__fk FOREIGN KEY (tenant_id, partner_user_id, partner_id)
    REFERENCES partners.partner_users (tenant_id, id, partner_id),
  CONSTRAINT download_counters__count__ck CHECK (count >= 0)
);
CREATE INDEX download_counters__tenant_id_expires_at__idx ON partners.download_counters (tenant_id, expires_at);

CREATE TABLE partners.access_slips (   -- 08 A2.1; no column holds the link token or URL
  id uuid NOT NULL, tenant_id uuid NOT NULL, partner_id uuid NOT NULL, partner_user_id uuid NOT NULL,
  report_id uuid NOT NULL, version_no integer NOT NULL, order_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'requested',
  link_id uuid, link_expires_at timestamptz,
  file_path text, file_sha256 text, file_byte_size integer,
  failure_code text, issued_at timestamptz, expired_at timestamptz,
  version integer NOT NULL DEFAULT 1, is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid NOT NULL,
  CONSTRAINT access_slips__pk PRIMARY KEY (id),
  CONSTRAINT access_slips__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT access_slips__partner__fk FOREIGN KEY (tenant_id, partner_id) REFERENCES partners.partners (tenant_id, id),
  CONSTRAINT access_slips__user__fk FOREIGN KEY (tenant_id, partner_user_id) REFERENCES partners.partner_users (tenant_id, id),
  CONSTRAINT access_slips__report__fk FOREIGN KEY (tenant_id, report_id, version_no, partner_id)
    REFERENCES partners.order_reports (tenant_id, report_id, version_no, partner_id),
  CONSTRAINT access_slips__order__fk FOREIGN KEY (tenant_id, order_id, partner_id)
    REFERENCES partners.order_tracking (tenant_id, order_id, partner_id),
  CONSTRAINT access_slips__state__ck CHECK (state IN ('requested','issued','failed','expired')),
  CONSTRAINT access_slips__version_no__ck CHECK (version_no >= 1),
  CONSTRAINT access_slips__link__ck CHECK ((state IN ('issued','expired')) = (link_id IS NOT NULL AND link_expires_at IS NOT NULL)),
  CONSTRAINT access_slips__file__ck CHECK ((state = 'issued') = (file_path IS NOT NULL AND file_sha256 IS NOT NULL AND file_byte_size IS NOT NULL)),
  CONSTRAINT access_slips__path__ck CHECK (file_path IS NULL OR char_length(file_path) BETWEEN 1 AND 200),
  CONSTRAINT access_slips__sha__ck CHECK (file_sha256 IS NULL OR file_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT access_slips__size__ck CHECK (file_byte_size IS NULL OR file_byte_size BETWEEN 1 AND 10485760),
  CONSTRAINT access_slips__failure__ck CHECK ((state = 'failed') = (failure_code IS NOT NULL)
    AND (failure_code IS NULL OR (char_length(failure_code) <= 64 AND failure_code ~ '^[a-z_]+\.[a-z_]+$'))),
  CONSTRAINT access_slips__issued_at__ck CHECK ((state IN ('issued','expired')) = (issued_at IS NOT NULL)),
  CONSTRAINT access_slips__expired_at__ck CHECK ((state = 'expired') = (expired_at IS NOT NULL))
);
CREATE INDEX access_slips__tenant_id_partner_id_report_id_created_at__idx ON partners.access_slips (tenant_id, partner_id, report_id, created_at DESC);
CREATE INDEX access_slips__tenant_id_state_link_expires_at__p_idx ON partners.access_slips (tenant_id, link_expires_at) WHERE state = 'issued';
CREATE INDEX access_slips__tenant_id_state_created_at__p_idx ON partners.access_slips (tenant_id, created_at) WHERE state = 'requested';

-- partners.event_inbox: created by C0's standard template (03 §12), columns (tenant_id, event_id, event_type, received_at, created_by),
-- PK (tenant_id, event_id), __tenant policies, 90-day owner purge.

-- ---------- triggers ----------
CREATE FUNCTION partners.guard_manifest_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.state <> 'draft' AND
     (to_jsonb(OLD) - ARRAY['state','line_count','received_at','received_by','in_transit_at','withdrawn_at','withdrawn_by',
        'withdraw_reason_code','withdraw_reason_text','updated_at','updated_by','version'])
     IS DISTINCT FROM
     (to_jsonb(NEW) - ARRAY['state','line_count','received_at','received_by','in_transit_at','withdrawn_at','withdrawn_by',
        'withdraw_reason_code','withdraw_reason_text','updated_at','updated_by','version']) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'partners.manifests';
  END IF;
  IF OLD.state IN ('received','withdrawn','discarded') AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'partners.manifests';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER manifests__guard BEFORE UPDATE ON partners.manifests FOR EACH ROW EXECUTE FUNCTION partners.guard_manifest_update();

CREATE FUNCTION partners.guard_line_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  lifecycle text[] := ARRAY['state','conversion_attempt','resolved_patient_id','order_id','registration_no','converted_at',
    'failure_code','failed_at','sample_received_at','received_by','sample_missing','not_received_reason_code',
    'updated_at','updated_by','version'];
  redaction text[] := ARRAY['patient_full_name','patient_sex','patient_birth_on','patient_age_years','patient_phone_e164',
    'orderables_snapshot','clinical_note','is_redacted','redacted_at'];
BEGIN
  IF NEW.partner_id <> OLD.partner_id OR NEW.manifest_id <> OLD.manifest_id OR NEW.tenant_id <> OLD.tenant_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'partners.manifest_lines';
  END IF;
  IF OLD.state <> 'draft' THEN
    IF current_setting('app.maintenance', true) = 'partners_redact_lines' AND current_user = 'lims_owner' THEN
      lifecycle := lifecycle || redaction;
    END IF;
    IF (to_jsonb(OLD) - lifecycle) IS DISTINCT FROM (to_jsonb(NEW) - lifecycle) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'partners.manifest_lines';
    END IF;
    IF OLD.state IN ('withdrawn','discarded','cancelled','not_received') AND NEW.state <> OLD.state THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'partners.manifest_lines';
    END IF;
    IF OLD.order_id IS NOT NULL AND NEW.order_id IS DISTINCT FROM OLD.order_id THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'partners.manifest_lines';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER manifest_lines__guard BEFORE UPDATE ON partners.manifest_lines FOR EACH ROW EXECUTE FUNCTION partners.guard_line_update();

CREATE FUNCTION partners.check_line_parent() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM partners.manifests m WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.manifest_id
                 AND m.partner_id = NEW.partner_id AND m.receiving_centre_id = NEW.receiving_centre_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'manifest_line_parent_mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER manifest_lines__parent BEFORE INSERT ON partners.manifest_lines FOR EACH ROW EXECUTE FUNCTION partners.check_line_parent();
-- Rule (review m#18): receiving branch/centre are snapshotted at create and refreshed at submit; the MS3 submit transaction
-- updates the manifest first, then sets manifest_lines.receiving_centre_id of every line to the refreshed value.
-- This trigger runs on INSERT only.

-- Redaction DEFINER (owner role). Called only by task partners.redact_expired_lines (per_tenant, P-6) under the job's
-- tenant claims as the partners system actor. Gating per 08 A12.2 / A19 P-41(c): the body sets
-- app.maintenance = 'partners_redact_lines'; the owner policies below match only that value AND the caller's tenant.
-- The download_counters purge is NOT done here any more: it is a P-18(c) system-actor delete in the same task.
CREATE FUNCTION partners.redact_lines(p_tenant_id uuid, p_older_than timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer;
BEGIN
  IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() OR app.current_actor_type() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'redaction_scope';
  END IF;
  PERFORM set_config('app.maintenance', 'partners_redact_lines', true);
  UPDATE partners.manifest_lines SET patient_full_name = NULL, patient_sex = NULL, patient_birth_on = NULL,
         patient_age_years = NULL, patient_phone_e164 = NULL, orderables_snapshot = '[]'::jsonb, clinical_note = NULL,
         is_redacted = true, redacted_at = now(), updated_at = now(), updated_by = app.current_actor_id()
   WHERE tenant_id = p_tenant_id AND NOT is_redacted AND created_at < p_older_than;
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE partners.order_reports r SET panel_names = NULL, updated_at = now(), updated_by = app.current_actor_id()
   WHERE r.tenant_id = p_tenant_id AND r.panel_names IS NOT NULL
     AND EXISTS (SELECT 1 FROM partners.order_tracking t JOIN partners.manifest_lines l ON l.tenant_id = t.tenant_id AND l.id = t.line_id
                 WHERE t.tenant_id = r.tenant_id AND t.order_id = r.order_id AND l.is_redacted);
  PERFORM set_config('app.maintenance', '', true);
  RETURN n;
END $$;
ALTER FUNCTION partners.redact_lines(uuid, timestamptz) OWNER TO lims_owner;
REVOKE ALL ON FUNCTION partners.redact_lines(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION partners.redact_lines(uuid, timestamptz) TO lims_worker;
-- Inside the DEFINER current_user = lims_owner, which guard_line_update checks together with app.maintenance.
-- Inventory row (P-41(d); to be added to 08 §4.7 / 03-IC §13.3 / db/meta/definer-inventory.yaml — handed off):
--   partners.redact_lines(uuid, timestamptz) — owner lims_owner, EXECUTE lims_worker, maintenance GUC
--   app.maintenance = 'partners_redact_lines' (tenant-bound), source C13.

-- Owner policies for partners.redact_lines (08 A10.5; A12.2; A19 P-41(b)/(c)). TO lims_owner only, so a lims_app
-- session that sets app.maintenance itself gains nothing (A12.7 (b)).
CREATE POLICY manifest_lines__select__owner_only ON partners.manifest_lines FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'partners_redact_lines'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY manifest_lines__update__owner_only ON partners.manifest_lines FOR UPDATE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'partners_redact_lines'
         AND tenant_id = (SELECT app.current_tenant_id()) AND NOT is_redacted)
  WITH CHECK (current_setting('app.maintenance', true) = 'partners_redact_lines'
              AND tenant_id = (SELECT app.current_tenant_id()) AND is_redacted);
CREATE POLICY order_reports__select__owner_only ON partners.order_reports FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'partners_redact_lines'
         AND tenant_id = (SELECT app.current_tenant_id()));
CREATE POLICY order_reports__update__owner_only ON partners.order_reports FOR UPDATE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'partners_redact_lines'
         AND tenant_id = (SELECT app.current_tenant_id()) AND panel_names IS NOT NULL)
  WITH CHECK (current_setting('app.maintenance', true) = 'partners_redact_lines'
              AND tenant_id = (SELECT app.current_tenant_id()) AND panel_names IS NULL);
CREATE POLICY order_tracking__select__owner_only ON partners.order_tracking FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'partners_redact_lines'
         AND tenant_id = (SELECT app.current_tenant_id()));

-- ---------- RLS ----------
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['settings','partners','partner_users','partner_referrers','manifest_counters','manifests',
    'manifest_lines','pickup_requests','pickup_request_manifests','order_tracking','tracked_specimens','order_reports',
    'price_list_items','price_list_syncs','statement_months','download_counters','access_slips'] LOOP
    EXECUTE format('ALTER TABLE partners.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE partners.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE partners.%I OWNER TO lims_owner', t);
  END LOOP; END $$;

-- settings: staff all commands; partner SELECT (needed for PartnerContext features + consent statement)
CREATE POLICY settings__select__staff ON partners.settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY settings__select__partner ON partners.settings FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND (SELECT app.current_partner_id()) IS NOT NULL);
CREATE POLICY settings__insert__staff ON partners.settings FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY settings__update__staff ON partners.settings FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));

-- partners: staff all; partner SELECT own row (id = current partner)
CREATE POLICY partners__select__staff ON partners.partners FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY partners__select__partner ON partners.partners FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND id = (SELECT app.current_partner_id()));
CREATE POLICY partners__insert__staff ON partners.partners FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY partners__update__staff ON partners.partners FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
```

The remaining policies follow four fixed shapes. C0 writes each one out (no dynamic SQL in the canonical `db/policies/partners.sql`):

| Shape | Commands and predicates |
|---|---|
| **A** (tenant-wide staff + partner own org, partner may write) | `__select__staff` ST · `__insert__staff` ST · `__update__staff` ST/ST · `__select__partner` PT · `__insert__partner` WITH CHECK PT · `__update__partner` USING PT WITH CHECK PT |
| **B** (receiving-centre staff + partner own org, partner may write) | `__select__staff_centre` SC · `__insert__staff_centre` SC · `__update__staff_centre` SC/SC · `__select__partner` PT · `__insert__partner` PT · `__update__partner` PT/PT |
| **C** (projection: staff centre read, system write, partner read) | `__select__staff_centre` SC · `__select__partner` PT · `__insert__system` SY · `__update__system` SY/SY |
| **D** (projection tenant-wide: staff read, system write, partner read) | `__select__staff` ST · `__select__partner` PT · `__insert__system` SY · `__update__system` SY/SY |

| Table | Shape | Extra |
|---|---|---|
| partner_users | A | partner INSERT/UPDATE allowed by RLS (same partner) but restricted by trigger `partners.guard_partner_users()` (caller must be an active `partner_admin`; a member may only flip its own row `invited → active`) and by `partners.guard_partner_columns()` (08 A19 D-103) |
| partner_referrers | A | `partners.guard_partner_columns()` for partner actors (D-103) |
| manifest_counters | A (no `__select__staff` needed but harmless) | — |
| manifests | B | `partners.guard_partner_columns()` + `guard_partner_transitions()` for partner actors (D-103) |
| manifest_lines | B | `manifest_lines__delete__partner` USING PT AND `state = 'draft'`; no staff DELETE; `guard_partner_columns()` + `guard_partner_transitions()` for partner actors (D-103); owner policies for `partners.redact_lines` (above) |
| pickup_requests | B | `guard_partner_columns()` + `guard_partner_transitions()` for partner actors (D-103) |
| pickup_request_manifests | B | partner_id consistency enforced by the 3-column FKs (review #5) |
| order_tracking | C | only system writes (staff actions write lines; the worker/consumer updates tracking); `order_tracking__select__owner_only` for `partners.redact_lines` |
| tracked_specimens | C | — |
| order_reports | C | owner policies for `partners.redact_lines` (above); plus `order_reports__update__partner` USING PT WITH CHECK PT (mark-seen; the service changes only `is_new`, `seen_at`, `seen_by`; a column-guard trigger `partners.guard_report_seen()` rejects any other column change when `app.current_actor_type() = 'partner'`) |
| price_list_items | D | `price_list_items__delete__system` USING SY |
| price_list_syncs | D | — |
| statement_months | D | — |
| access_slips | — (written out below, 08 A2.1) | `__select__staff` ST · `__select__partner` PT · `__insert__partner` WITH CHECK PT AND `state = 'requested'` · `__update__system` SY/SY. No partner UPDATE, no DELETE |
| download_counters | — | `__select__partner` / `__insert__partner` / `__update__partner` with PT **and** `partner_user_id = (SELECT pu.id FROM partners.partner_users pu WHERE pu.tenant_id = (SELECT app.current_tenant_id()) AND pu.membership_id = nullif((SELECT app.current_claims()) ->> 'membership_id','')::uuid)`; `__select__staff` ST; `download_counters__delete__tenant` (written out below; A17 P-18(c)) |

Shape B written out for `manifests` (template for the other B tables):

```sql
CREATE POLICY manifests__select__staff_centre ON partners.manifests FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system')
         AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY manifests__insert__staff_centre ON partners.manifests FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system')
         AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY manifests__update__staff_centre ON partners.manifests FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system')
         AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system')
         AND ((SELECT app.has_all_centres()) OR receiving_centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])));
CREATE POLICY manifests__select__partner ON partners.manifests FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY manifests__insert__partner ON partners.manifests FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY manifests__update__partner ON partners.manifests FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND partner_id = (SELECT app.current_partner_id()))
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND partner_id = (SELECT app.current_partner_id()));

CREATE POLICY manifest_lines__delete__partner ON partners.manifest_lines FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND partner_id = (SELECT app.current_partner_id()) AND state = 'draft');

CREATE POLICY download_counters__delete__tenant ON partners.download_counters FOR DELETE TO lims_app   -- A17 P-18(c)
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
         AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now());

CREATE FUNCTION partners.guard_report_seen() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF app.current_actor_type() = 'partner' AND
     (to_jsonb(OLD) - ARRAY['is_new','seen_at','seen_by','updated_at','updated_by']) IS DISTINCT FROM
     (to_jsonb(NEW) - ARRAY['is_new','seen_at','seen_by','updated_at','updated_by']) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'partners.order_reports';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER order_reports__guard_seen BEFORE UPDATE ON partners.order_reports FOR EACH ROW EXECUTE FUNCTION partners.guard_report_seen();

-- access_slips (08 A2.1): partner reads/inserts requests; only the system actor (worker) moves state.
CREATE POLICY access_slips__select__staff ON partners.access_slips FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system'));
CREATE POLICY access_slips__select__partner ON partners.access_slips FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND partner_id = (SELECT app.current_partner_id()));
CREATE POLICY access_slips__insert__partner ON partners.access_slips FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
         AND partner_id = (SELECT app.current_partner_id()) AND state = 'requested');
CREATE POLICY access_slips__update__system ON partners.access_slips FOR UPDATE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system')
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system');

CREATE FUNCTION partners.guard_access_slip_update() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT ((OLD.state = 'requested' AND NEW.state IN ('requested','issued','failed'))
       OR (OLD.state = 'issued' AND NEW.state IN ('issued','expired'))) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'partners.access_slips';
  END IF;
  IF (to_jsonb(OLD) - ARRAY['state','link_id','link_expires_at','file_path','file_sha256','file_byte_size','failure_code',
        'issued_at','expired_at','version','updated_at','updated_by'])
     IS DISTINCT FROM
     (to_jsonb(NEW) - ARRAY['state','link_id','link_expires_at','file_path','file_sha256','file_byte_size','failure_code',
        'issued_at','expired_at','version','updated_at','updated_by']) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'partners.access_slips';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER access_slips__guard BEFORE UPDATE ON partners.access_slips FOR EACH ROW EXECUTE FUNCTION partners.guard_access_slip_update();

-- Partner-side guards that RLS cannot express (enforced in service AND by trigger, defence in depth; 08 A19 D-103).
-- (1) States: a partner actor may only move manifests/lines draft→submitted/discarded (lines also draft→converting,
--     on_submit only — checked in guard_partner_columns), submitted→withdrawn, and pickups requested/scheduled→cancelled.
CREATE FUNCTION partners.guard_partner_transitions() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF app.current_actor_type() = 'partner' AND NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (TG_TABLE_NAME IN ('manifests','manifest_lines') AND OLD.state = 'draft' AND NEW.state IN ('submitted','discarded'))
    OR (TG_TABLE_NAME = 'manifest_lines' AND OLD.state = 'draft' AND NEW.state = 'converting')
    OR (TG_TABLE_NAME IN ('manifests','manifest_lines') AND OLD.state = 'submitted' AND NEW.state = 'withdrawn')
    OR (TG_TABLE_NAME = 'pickup_requests' AND OLD.state IN ('requested','scheduled') AND NEW.state = 'cancelled')) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER manifests__partner_transitions BEFORE UPDATE ON partners.manifests FOR EACH ROW EXECUTE FUNCTION partners.guard_partner_transitions();
CREATE TRIGGER manifest_lines__partner_transitions BEFORE UPDATE ON partners.manifest_lines FOR EACH ROW EXECUTE FUNCTION partners.guard_partner_transitions();
CREATE TRIGGER pickup_requests__partner_transitions BEFORE UPDATE ON partners.pickup_requests FOR EACH ROW EXECUTE FUNCTION partners.guard_partner_transitions();

-- (2) Columns (D-103, column sets of review C13 #4): for partner actors only the listed columns may change.
--     Lifecycle facts written by staff or the system (order linkage, receipt, pickup scheduling, mapping) are never
--     writable under partner claims, whatever the state. Non-partner actors are unaffected (their own guards apply).
CREATE FUNCTION partners.guard_partner_columns() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  changed text[];
  allowed text[];
  v_mode text;
BEGIN
  IF app.current_actor_type() IS DISTINCT FROM 'partner' THEN
    RETURN NEW;
  END IF;
  SELECT coalesce(array_agg(n.key), '{}') INTO changed
    FROM jsonb_each(to_jsonb(NEW)) n JOIN jsonb_each(to_jsonb(OLD)) o USING (key)
   WHERE n.value IS DISTINCT FROM o.value;
  IF TG_TABLE_NAME = 'manifests' THEN
    allowed := ARRAY['notes','collected_on','line_count','state','submitted_at','submitted_by','withdrawn_at','withdrawn_by',
      'withdraw_reason_code','withdraw_reason_text','discarded_at','conversion_mode','updated_at','updated_by','version'];
    IF OLD.state = 'draft' THEN
      allowed := allowed || ARRAY['receiving_branch_id','receiving_centre_id'];   -- refreshed at submit (m#18)
    END IF;
  ELSIF TG_TABLE_NAME = 'manifest_lines' THEN
    IF OLD.state = 'draft' THEN
      allowed := ARRAY['partner_sample_ref','patient_full_name','patient_sex','patient_birth_on','patient_age_years',
        'patient_phone_e164','consent_attested','consent_sms','consent_whatsapp','consent_email','consent_share_with_referrer',
        'consent_text_version','orderable_ids','orderables_snapshot','priority','referrer_id','collected_at','clinical_note',
        'receiving_centre_id','state','conversion_attempt','is_redacted','redacted_at','updated_at','updated_by','version'];
      IF 'conversion_attempt' = ANY (changed) THEN
        SELECT m.conversion_mode INTO v_mode FROM partners.manifests m
         WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.manifest_id;
        IF NOT (OLD.conversion_attempt = 0 AND NEW.conversion_attempt = 1 AND NEW.state = 'converting'
                AND v_mode = 'on_submit') THEN
          RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'partners.manifest_lines';
        END IF;
      END IF;
      IF NEW.state = 'converting' AND 'conversion_attempt' <> ALL (changed) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'partners.manifest_lines';
      END IF;
    ELSE
      allowed := ARRAY['state','updated_at','updated_by','version'];   -- only submitted → withdrawn (transition guard)
    END IF;
  ELSIF TG_TABLE_NAME = 'pickup_requests' THEN
    allowed := ARRAY['state','cancel_reason_code','resolved_at','resolved_by','updated_at','updated_by','version'];
  ELSIF TG_TABLE_NAME = 'partner_users' THEN
    allowed := ARRAY['status','activated_at','partner_role','deactivated_at','deactivated_by','deactivate_reason_code',
      'updated_at','updated_by','version'];   -- who may change what: partners.guard_partner_users()
  ELSIF TG_TABLE_NAME = 'partner_referrers' THEN
    -- [CONV] derived from 03-APP-FLOW §2.6 (F2–F5): partner edits its own fields, (de)activates, and an edit of a
    -- rejected entry returns it to unmapped (reason cleared). Mapping columns are staff-only (SR2/SR3).
    allowed := ARRAY['display_name','display_name_norm','qualification','registration_council','registration_no',
      'is_active','updated_at','updated_by','version'];
    IF OLD.mapping_state = 'rejected' AND NEW.mapping_state = 'unmapped' THEN
      allowed := allowed || ARRAY['mapping_state','mapping_reject_reason_code','mapping_reject_text'];
    END IF;
  END IF;
  IF NOT (changed <@ allowed) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER manifests__partner_columns BEFORE UPDATE ON partners.manifests FOR EACH ROW EXECUTE FUNCTION partners.guard_partner_columns();
CREATE TRIGGER manifest_lines__partner_columns BEFORE UPDATE ON partners.manifest_lines FOR EACH ROW EXECUTE FUNCTION partners.guard_partner_columns();
CREATE TRIGGER pickup_requests__partner_columns BEFORE UPDATE ON partners.pickup_requests FOR EACH ROW EXECUTE FUNCTION partners.guard_partner_columns();
CREATE TRIGGER partner_users__partner_columns BEFORE UPDATE ON partners.partner_users FOR EACH ROW EXECUTE FUNCTION partners.guard_partner_columns();
CREATE TRIGGER partner_referrers__partner_columns BEFORE UPDATE ON partners.partner_referrers FOR EACH ROW EXECUTE FUNCTION partners.guard_partner_columns();

-- (3) partner_users writes under partner claims (D-103): the caller's own row (by claims membership_id) must be an
--     active partner_admin; the one exception is a member's (or admin's) own first-sign-in flip invited → active
--     (02-TRD §4.8), which may change only status/activated_at/updated_*/version. Otherwise immutable_row.
CREATE FUNCTION partners.guard_partner_users() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_me uuid := nullif(app.current_claims() ->> 'membership_id', '')::uuid;
  v_is_admin boolean;
  changed text[];
BEGIN
  IF app.current_actor_type() IS DISTINCT FROM 'partner' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.membership_id = v_me AND OLD.status = 'invited' AND NEW.status = 'active' THEN
    SELECT coalesce(array_agg(n.key), '{}') INTO changed
      FROM jsonb_each(to_jsonb(NEW)) n JOIN jsonb_each(to_jsonb(OLD)) o USING (key)
     WHERE n.value IS DISTINCT FROM o.value;
    IF changed <@ ARRAY['status','activated_at','updated_at','updated_by','version'] THEN
      RETURN NEW;
    END IF;
  END IF;
  SELECT EXISTS (SELECT 1 FROM partners.partner_users pu
                  WHERE pu.tenant_id = NEW.tenant_id AND pu.membership_id = v_me
                    AND pu.partner_id = NEW.partner_id
                    AND pu.partner_role = 'partner_admin' AND pu.status = 'active') INTO v_is_admin;
  IF NOT v_is_admin THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = 'partners.partner_users';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER partner_users__partner_guard BEFORE INSERT OR UPDATE ON partners.partner_users FOR EACH ROW EXECUTE FUNCTION partners.guard_partner_users();

-- ---------- grants ----------
GRANT SELECT, INSERT, UPDATE ON partners.settings, partners.partners, partners.partner_users, partners.partner_referrers,
  partners.manifest_counters, partners.manifests, partners.pickup_requests, partners.pickup_request_manifests,
  partners.order_tracking, partners.tracked_specimens, partners.order_reports, partners.price_list_syncs,
  partners.statement_months, partners.access_slips TO lims_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON partners.manifest_lines, partners.price_list_items, partners.download_counters TO lims_app;
-- (DELETE is policy-limited: lines draft-only by partner; price_list_items system-only; download_counters system-only
--  after expires_at, A17 P-18(c).)
```

Note on `manifest_lines` partner UPDATE of `state = 'converting'`: in mode `on_submit` the submit handler (partner actor) moves lines `draft → converting` (with `conversion_attempt` 0 → 1) and enqueues jobs; the job itself runs as system. `guard_partner_transitions` admits the state change and `guard_partner_columns` admits it only when the manifest's `conversion_mode = 'on_submit'` (D-103). The submit handler therefore updates the manifest row (state, `conversion_mode`, refreshed receiving branch/centre) **before** its lines.

**DEFINER tests (A19 P-41(e); 08 A10.5 CI; A12.7), run with FORCE RLS on, never disabling RLS on stand-in tables:**
1. `app.current_partner_id()`: returns the partner id for an active/invited partner user of an active partner; NULL for a suspended partner, a deactivated user, every non-partner actor type, and a membership id of another tenant (truth table, 07-SECURITY ST6). A `lims_app` session under partner claims sees no `partner_users` row of another partner (the owner policies are `TO lims_owner` only).
2. `partners.redact_lines`: (a) redacts the expected lines and nulls `panel_names` of their reports (non-zero counts); (b) a `lims_app` session that sets `app.maintenance = 'partners_redact_lines'` itself gains no extra row and cannot write the redaction columns of a non-draft line (`guard_line_update` → `immutable_row`); (c) `app.maintenance` is `''` after return; (d) a call with another tenant id or a non-system actor → `42501 redaction_scope`.
3. `download_counters__delete__tenant`: the system actor deletes only rows with `expires_at < now()`; partner and staff (`user`) claims delete 0 rows.
4. `partners.guard_partner_columns()` / `guard_partner_users()`: for every column outside the allowlists, an UPDATE under partner claims raises `immutable_row` (generated from the arrays); a member INSERT/UPDATE of another user's row → `immutable_row`; own `invited → active` flip passes; `draft → converting` passes only when the manifest is `on_submit` (07-SECURITY AB11/AB12, ST9).

## 9. Foreign views read (system actor only, `repository/views.repo.ts`)

| View (03 §6) | Columns used | Query |
|---|---|---|
| `frontdesk.v_pub_order_status` | order_id, status, partner_id, updated_at | `WHERE tenant_id = $1 AND order_id = ANY($2)` (batch ≤ 500) |
| `lab.v_pub_specimen_timeline` | specimen_id, order_id, specimen_type_code, status, collected_at, in_transit_at, received_at, reported_at, rejected_at, rejection_reason_code, `replaces_specimen_id` (column added by 08 A19 D-106, CR-C16-022; until that view change merges the reconcile path leaves `replaces_specimen_id` as delivered by events) | `WHERE tenant_id = $1 AND order_id = ANY($2)` |
| `catalog.v_pub_price_list_items` | price_list_id, price_list_version, owner_kind, owner_id, orderable_id, unit_price_paisa, effective_from, effective_to | `WHERE tenant_id = $1 AND ((owner_kind = 'credit_party' AND owner_id = $2) OR owner_kind = 'default') AND effective_from <= $3 AND (effective_to IS NULL OR effective_to > $3)` |
| `catalog.v_pub_test_directory` | test_id, code, name, department_id, is_active | `WHERE tenant_id = $1 AND test_id = ANY($2)` |
| `billing.v_pub_credit_party_statement` | all | `WHERE tenant_id = $1 AND credit_party_id = ANY($2) AND period_month >= $3` |

C13 publishes **no** `v_pub_*` view (03 §6 requires none).

## 10. Seed data (synthetic, `packages/test-fixtures` — C0)

Per synthetic tenant: 2 partners (`SYN-PARTNER-X`, `SYN-PARTNER-Y`) linked to two synthetic credit parties (kind `partner_lab` / `clinic`), each with 1 partner_admin and 2 partner_members (memberships via C2 fixtures, e-mails `@partner-x.invalid`), 3 referrers (one mapped), 2 manifests (one draft, one received with converted lines whose orders exist in the C4 fixtures), 1 pickup per state, price-list projection rows, 3 statement months. Patient names visibly synthetic ("Test Patient 0042").
