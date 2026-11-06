# Triage — review batch 3 (C13–C18)

Date 2026-11-06. Inputs: `review/C13-b2b-partner-portal.md`, `C14-smart-report.md`, `C15-payment-gateways.md`, `C16-patient-engagement.md`, `C17-home-collection.md`, `C18-legacy-migration.md`. Authority applied: 00 > research/04 > 08 (§2 + Addenda A1–A13; A13 = P-1…P-15, D-1…D-43, reused and not re-decided) > 03-IC > 01/02-CV > research/01–03 > chunk docs. Founder rules respected: no new foreign touchpoint, all data in Nepal, synthetic data only. C18 is judged as **design only** (B4 open, 08 F-06): no decision below authorises C18 DDL, ports or tool code. **No spec file was edited.**

Scope of verification: every BLOCKER and MAJOR, and every "Needs lead decision" item, including the minors named there (C13 m#28; C15 m#25, m#28, m#29; C16 m#36, m#37; C17 m#35; C18 m#20, m#21 and C18 lead item 6, called **C18-L6**: `lims_migration` as a member of `lims_app`). Each was checked by opening the cited file. MINOR findings that are not on a lead list were **not** re-verified; (c) lists them as reported.

Result: 92 items verified. **90 CONFIRMED, 0 FALSE, 0 ALREADY-FIXED, 2 CONFIRMED-PARTIAL**: C16 #15 (one sub-claim is false) and C17 #15 (one half was already decided by A13 D-34). See (d). Classification: **LOCAL 46 · CROSS 8 · DECISION 38**.

Numbering: rules **P-40…P-46**, decisions **D-100…D-136**. These ranges avoid collisions with batch 2 (P-16…P-23, D-44…D-75). `review/_triage-batch2.md` appeared while this triage was being finished. It was read, and overlaps are marked "instance of P-16/P-18/P-20/P-22/P-23" or "consistent with D-nn". No batch-3 decision duplicates a batch-2 decision; see the end of (b).

Conventions: `[CONV]` = value chosen in this triage; "m#" = MINOR finding number; "instance of A10.5 / A12.1 / A12.2" refers to the 08 Addenda.

---

## (a) Program-wide rules proposed

**P-40 — Port idempotency keys have their own grammar.** (C15 #1, C15 m#17)
Text for 02-CV §4.5 (new paragraph after the table): "The `Idempotency-Key` **HTTP header** keeps the format above (1–64 `[A-Za-z0-9_-]`). An `idempotencyKey` **input of a port** (any `contracts/ports/*`) matches `^[A-Za-z0-9_.:-]{1,200}$` [CONV]. Callers build it as `<prefix>:<id>[:<suffix>]`. A port owner that stores the key uses exactly this CHECK."
Why: callers already use colons, and the C8 key contains an ISO timestamp (`.`): C3 l.651, C4, C8 l.657, C9 l.398, C10 l.180, C11 l.230, C13, C15 l.332, C16 l.209/261/312/326/373, C17 l.439. Owners other than C15 already accept up to 200 characters (C0 `event_log__idem__ck`, C4 `booking_links__key__ck`, C10 `instrument_records`). Only C15 applies the HTTP-header grammar to a port key. The key never reaches a gateway, because eSewa `transaction_uuid` is the intent id (C15 TRD §7.2.3).
Chunk effect: C15 `intents__idem__ck` → `CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{1,200}$')`, TRD §6.1 step 1 and SCH §2 row use the same rule, and `refunds__idem__ck` is added with the same CHECK (m#17). C16 needs no change.

**P-41 — The chunk that requests a SECURITY DEFINER writes its owner policies.** (C13 #1, #2, lead 7; C15 m#14; C16 #1, lead 3; C17 #5)
Text for 02-CV §5.9 (append) and 01-CM §4 "Must": "Every DEFINER requested by a chunk is specified in that chunk's 05-SCHEMA with: (a) the full SQL body; (b) every `__<cmd>__owner_only` policy `TO <function owner>` that it needs, with the narrowest USING (08 A10.5); (c) how the policies are gated: tenant-claim functions on `app.current_tenant_id()` plus the claim columns they need; pre-tenant functions on an `app.pre_*` GUC set inside the body (08 A12.1); maintenance functions on `app.maintenance = '<function name>'` (08 A12.2); (d) its 08 §4.7 / 03-IC §13.3 inventory row; (e) the A12.7 FORCE-RLS tests. Wording such as 'C0 assigns the mechanism' or 'C0 decides' is not allowed. Module-specific GUC names (`partners.redaction`, `app.payments_lookup_token`, `app.purge_tenant`, `app.retention_purge`) are replaced by the A12 names. A per-tenant class-E retention delete is **not** a DEFINER: it follows batch-2 P-18(c), with a system-actor `__delete__tenant` policy in a `per_tenant` task. C0-0B transcribes the SQL."

**P-42 — Security counters on a failing request persist only through `ctx.commitOnError()`.** (C16 #2, C16 m#25)
Text for 02-CV §4.7 (new bullet): "A handler that records an attempt, a failure counter or a `denied` access-log row and then returns ≥ 400 calls `ctx.commitOnError()` (C0 TRD §5 step 11) right after those writes and makes no other write in that transaction. Each such path has an integration test that asserts the write survives the 4xx. A path whose other writes must roll back (for example a redemption that hits a limit) does not call it."
Consequence outside the batch: C6 `redeemPortalLinkForApp` increments `portal_links.redeem_failures` (A13 D-30) on a failing request. C6 TRD contains no `commitOnError` (grep), so C6 checks this in its fix pass. C6 is not reviewed here.

**P-43 — One permission floor per operation; no "any of".** (C14 m#16, C15 P24, C16 #19)
Consistent with batch-2 D-46/D-64, which split or unified operations the same way, but batch 2 states no general rule. Text for 02-CV §4.12 (append to P-10): "`x-permission` is one code that every caller holds. An operation never accepts 'A **or** B'. Where two audiences need the same data, there are two operationIds, each with its own floor (for example a staff path and a `/me/…` patient path, or one coded-set operation per audience). The extra conditions of P-10 still apply inside each handler."
Chunk effect: C14 #26 is split into `getSmartCodedSet` (`smartreport.summary.read`, set `summary_reject_reasons`) and `getSmartLibraryCodedSet` (`smartreport.template.manage`, set `organ_groups`). C15 P24 is split into `listPaymentCodes` (`payments.reconciliation.read`) and `listPaymentCancelReasons` (`payments.intent.create`, set `cancel_reasons` only). C16 T1/T3/Q1/M1 are split as the reviewer proposes (#19).

**P-44 — A worker job that catches a port business error and commits uses a savepoint.** (C13 #3; C15 TRD §6.3 step 5 already does this)
Text for 02-CV §8.1 (append): "If a job or handler catches a `LimsError` from a port and then commits, the port call runs inside `ctx.db.tx(…)` (C0 `SAVEPOINT`/`ROLLBACK TO`, C0 TRD §6). The catch block runs after the rollback to the savepoint, so nothing the port wrote before the error is committed. Each such path has a test: the fake writes a marker row, then fails (`failNext`), and the marker is absent after commit."

**P-45 — BFF key secrets are named and listed.** (C13 #9; consequence of A13 D-32)
Text for 02-CV §6 / 08 R10 table (append): "Each BFF holds its own `X-Lims-Bff-Key` as a file-mounted secret from the C1 secret store: `LIMS_WEB_BFF_KEY_FILE` (kind `staff_web`), `LIMS_PARTNER_BFF_KEY_FILE` (`partner`), `LIMS_PORTAL_BFF_KEY_FILE` (`portal`) [CONV]. The key lives in server memory only and is never logged or sent to a browser. Rotation follows the C1 runbook, with the core accepting old and new keys for one overlap window. C0 `LIMS_CORE_BFF_KEY_FILES` lists all three kinds."
Edits: C0 TRD config row (currently "`staff_web`, `partner`") += `portal`. C13 07 §7 and TRD §10.1 add `LIMS_PARTNER_BFF_KEY_FILE`, marked secret. C1 secret inventory adds the three names.

**P-46 — A port call needs a declared consumer.** (C14 #4, C15 #4, C13 m#31, C14 m#14, C16 m#29)
Text for 01-CM §5.1 (header note): "Consumer lists are copied from the 03-IC §4.x headings. A chunk TRD may call a port only if its chunk appears there and in the 01-CM §6 matrix (`p`). A new caller is an additive CR to the owner (fake and contract suite updated). The C0 port-manifest check fails a call from a non-listed module." D-110 applies the rule to this batch.

---

## (b) Decisions proposed

**D-100 — Partner membership version.** Refs: C13 #6, lead 5. Problem: 03-IC §4.6 `updatePartnerMembership` requires `expectedVersion` (the `core.memberships` version), `provisionPartnerMembership` returns no version, and C13 cannot read `core.memberships` (R1). A stored copy, as the reviewer proposes, goes stale whenever C2 changes the membership (invitation acceptance, lock), because every UPDATE bumps `version` (02-CV §5 repository rule). Decision (additive, no new column):
- 03-IC §4.6: `updatePartnerMembership(… expectedVersion?: number …)`. JSDoc: "Omitted → C2 applies the action to the current row under `SELECT … FOR UPDATE`. Present → `common.version_conflict` on mismatch."
- C13 controls concurrency on its own row: U3–U5 take `If-Match` = `partner_users.version`, lock that row `FOR UPDATE`, call the port without `expectedVersion`, and store the returned `status`.
- C2 contract case: "(13) partner update without expectedVersion succeeds; with a stale version → version_conflict".
Files: 03-IC §4.6, C2 TRD §7, C13 TRD §6.2/§5.2.

**D-101 — Partner self-service.** Refs: C13 #7, lead 1. 03-IC §11 / 08 §4.1 `fixed_actor_permissions.partner.partner_member` += `identity.self.manage`. `partner_admin` inherits it. C2 §5.2 self-service operations accept session kind `partner` (CR-C13-003 already says so). PX-1 is kept as specified. No new code. Files: 03-IC §11, 08 §4.1, C2 TRD §5.2.

**D-102 — Clinical note and collection time from partners.** Refs: C13 #8, lead 2. Least surface: no `BookingOrderInput` change in v1 (C4 has no order note column; collection time would also need a C5 specimen path).
- C13 04-UI-UX labels the fields: "Shown to the receiving lab staff; not part of the lab order or the report".
- SM-2 shows `clinical_note`, `collected_at`, manifest `notes` and `collected_on` per line.
- C13 06 §5 records "CR-C13-015 candidate (C4 `clinicalNote?` ≤ 300, `collectedAt?`) if the client asks".
Files: C13 PRD IS-03, UI, 06.

**D-103 — Partner column guards.** Refs: C13 #4, lead 4. Decision: trigger-enforced column allowlists, as the reviewer proposes.
- New `partners.guard_partner_columns()` BEFORE UPDATE on `manifests`, `manifest_lines`, `pickup_requests`, `partner_users`, `partner_referrers`. It acts when `app.current_actor_type() = 'partner'` and uses the column sets in C13 review #4.
- `draft → converting` is allowed only when the manifest's `conversion_mode = 'on_submit'`.
- On `partner_users`, a BEFORE INSERT OR UPDATE check: when the actor is a partner, the caller's own `partner_users` row (by claims `membership_id`) must be `partner_role = 'partner_admin' AND status = 'active'`. Otherwise `immutable_row`. A member may change only their own row, and only `invited → active`.
- AB11/AB12/ST9 are extended to these column sets.
Files: C13 SCH §8, 07.

**D-104 — `on_submit` receipt semantics.** Refs: C13 #10, lead 6.
- Accept the reviewer's definition: "A line is *pending receipt* iff (on_receipt: `state = 'submitted'`) or (on_submit: `sample_received_at IS NULL AND NOT sample_missing AND state IN ('converting','converted','conversion_failed')`). MS6 = some pending lines remain; MS7 = none remain. SI3 returns a per-line error only for a line that is not pending."
- Withdraw (MS5) is unavailable in `on_submit`, and US-04 says so.
- The staff task is the SM-1 filter `has_missing_samples`, backed by `CREATE INDEX manifest_lines__tenant_id_receiving_centre_id__missing__p_idx ON partners.manifest_lines (tenant_id, receiving_centre_id) WHERE sample_missing AND state = 'converted';`. There is no new table.
Files: C13 APP-FLOW §2.1/§4.2, TRD §5.3, PRD US-04, UI SM-1, SCH.

**D-105 — Access slip for a line without a phone.** Refs: C13 m#28, lead 3. A13 D-31 already routes the portal OTP to the patient's phone on file in C4 (resolved by the C6 worker), so C13 needs no phone of its own. Decision: R4 stays allowed. When the manifest line has no `patient_phone_e164`, PR-2 shows the warning "The slip opens only if the lab has a mobile number for this patient." No new data flow and no new code. The redemption failure path is D-31's `no_contact`. Files: C13 UI PR-2, TRD R4 note.

**D-106 — `lab.v_pub_specimen_timeline` additions.** Refs: C13 m#22, C16 #15, lead 6. Additive C5 view change (CR-C16-022 [CONV id]): append the columns `replaces_specimen_id` (from `lab.specimens.replaces_specimen_id`, C5 SCH l.263) and `specimen_version` (= `lab.specimens.version`, the event aggregate seq, 03-IC §3.5 "seq = specimen version"). 03-IC §6.3 and 08 §4.9 rows are updated; consumers stay C8, C9, C13, C16.
- C16 backfill sets `status_seq = specimen_version`.
- C13 reconcile reads `replaces_specimen_id`.
- Until the view change merges, C16 backfill writes `status_seq = 0` and derives `recollection_required` from `status = 'recollection_ordered'`.
Files: C5 SCH §10, 03-IC §6.3, 08 §4.9, C13 TRD §8.1, C16 TRD §4.4.

**D-107 — Smart-summary supersede chain.** Refs: C14 #1, lead 4. Decision: a guarded `superseded → superseded` transition. The FK stays non-deferrable, because a supersede with no successor must still be valid. Add the pair `('superseded','superseded')` to `smartreport.check_summary_transition()` with this guard:
```sql
IF OLD.status = 'superseded' AND NEW.status = 'superseded' AND (OLD.superseded_by_summary_id IS NOT NULL
   OR (to_jsonb(NEW) - ARRAY['superseded_by_summary_id','updated_at','updated_by','version'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['superseded_by_summary_id','updated_at','updated_by','version'])) THEN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'invalid_transition', DETAIL = 'smartreport.summaries';
END IF;
```
TRD §7.1 step 7b: "mark superseded; after 7c insert, set `superseded_by_summary_id` (one UPDATE, NULL → id)". New DB test: §10 item 10. Files: C14 SCH §9, TRD §7.1, APP-FLOW S5.

**D-108 — Deny list vs the starter text.** Refs: C14 #2, lead 3. Keep `diagnos` as an unremovable global term (strictest reading of 04 R8). The starter `score.explanation` becomes: "The health score shows how many of your measured results are within the reference range, averaged across the body systems tested. It does not tell you whether you have a disease." New unit test: "starter library passes V1–V13 (V14 `no_mappings` expected)". Files: C14 TRD §9.3, tests.

**D-109 — Device actors and `smartreport.*`.** Refs: C14 #3, lead 2. Least privilege: every `smartreport.*` policy keeps `(SELECT app.is_staff_or_system())`, which batch-2 P-16's `check-registry` requires, and adds `AND (SELECT app.current_actor_type()) IN ('user','system')`. The C13 schema already uses this positive list. 07 §5 item 5 (the device probe) and 05 §6 then hold as written. **Program-wide question (not verified here):** `app.is_staff_or_system()` admits `device` on every `__tenant` table of C3–C12 (C0 SCH l.285). Whether those tables should exclude devices, given that C7 device paths need some of them, is left to the lead or batch 2. Files: C14 SCH §6/§9.

**D-110 — Port consumer lists (P-46).** Refs: C14 #4, lead 5; C15 #4; C13 m#31; C14 m#14; C16 m#29.
- 03-IC §4.3 heading and 01-CM §5.1: FrontdeskPort consumers = "C5, C6, C10, C11, C13, **C14**, **C15**, C16, C17". C10 and C11 come from batch-2 C11 m#30, as reported there. C14 calls `getOrderSummary` and `getPatientDemographicsBatch` with the **existing** purpose `lab_display` (no new purpose). If the caller lacks `lab.worklist.read`/`lab.status_board.read`, names are omitted, as C14 TRD §7.2 already states. C15 calls `getOrderSummary` only (staff or system).
- 01-CM §5.1: RenderPort consumers += C13 (A5.1). SmartReportPort consumers = "C6" (A5.7).
- 01-CM §6 matrix: row C14 gets `p` under C4; row C15 gets `p` under C4, `v` under C4 (CR-C15-009) and a C1 dependency (CR-C15-008); row C13 gets `v` under C3/C4/C5.
- These are registered as CR-C14-009 and CR-C15-014 [CONV ids]. C4 fake and contract suite add the two callers.
- C0 05-SCHEMA l.313: `app.engagement_redeem_link_code(bytea)` (A2.4).
Files: 03-IC §4.3, 01-CM §5.1/§6, C0 SCH, C4 contract suite.

**D-111 — `smartreport.summary_not_ready`.** Refs: C14 #5, lead 1. Keep the C14 design: the port returns `status: 'draft'` (03-IC case 10). Remove `summary_not_ready` from the 03-IC §4.10 `@throws`. The code stays registered but is unused by the port, the same treatment as A7.2. C14 TRD §7.1 step 9 and §13 say "never thrown by `buildSummary`". The C0 fake and contract suite follow. C6 needs no change (it prints only `approved`). Files: 03-IC §4.10, C14 TRD.

**D-112 — C15 access logging uses no new codes.** Refs: C15 #5. REQ-SEC-096 separates view, print and download events (`access_log`) from modifications (row audit). Decision:
- `payment_intent.resolve` (registered) covers P4 and P16 (`entityType` `payment_intent` / `reconciliation_finding`).
- The existing seed code `settings.change` covers P21 and P23 (`entityType` `payment_merchant_account` / `payment_settings`; detail holds field names only, never the secret).
- Refund request, approve, reject, confirm and fail, static-QR reconciliation and P22 credential tests are recorded by the `app.tg_row_audit` trigger only (secrets excluded, CR-C15-013).
- C15 07 REQ-SEC-096/097 row and TRD §4.2 R1 ("row; audit") are corrected.
Files: C15 TRD §4.2/§6.5/§6.6/§6.9, 07 §1.

**D-113 — C4 ↔ C15 front-desk gateway dialog.** Refs: C15 #8, #9, leads 3–4.
- C4 B12 passes `returnUrl = cancelUrl = ${LIMS_FRONTDESK_PAYMENT_RESULT_URL}` (new C4 config key [CONV], set by C1 to `<payments public base>/v1/payments/result`).
- For `action.kind = 'form_post'`, the C4 dialog shows a QR of `action.launchUrl` and an "Open on this PC" button that opens `launchUrl` in a new window. C4 never posts `fields` itself (C15 UI §4).
- Cancel: the C4 dialog's "Cancel payment" calls C15 P5 `cancelPaymentIntent` through the staff BFF (`payments.intent.create`, held by `front_desk`; precedent A13 D-14). There is no new C4 endpoint. C15 PRD §2 / APP-FLOW §2.12 keep this text.
- C4 B12 `x-error-codes` += `payments.amount_not_supported`, `payments.return_url_not_allowed` (m#16).
This is CR-C15-016 [CONV id] to C4. Files: C4 TRD B12, UI §3.6, config; C15 APP-FLOW §2.1/§2.12.

**D-114 — Khalti `Initiated` (04 P4).** Refs: C15 #12, lead 1. 04 outranks 08, so 04 is amended (doc-owner sign-off is added to F-08). New text for 04 P4, "Hold + escalate" part: "Hold + escalate: `Pending`, `Refunded`, `Partially Refunded`, unknown; `Initiated` is non-terminal (keep polling) until `expires_at` + grace, then hold + escalate (CR-C15-001, 08)." Until it is signed, the C15 rows are marked "pending 04 P4 amendment (F-08)". The 03-IC §4.9 `verify` JSDoc (m#26) is aligned in the same edit. Files: research/04 P4, 08 §5.1 F-08, 03-IC §4.9, C15 TRD §7.3.4.

**D-115 — A11.1 ledger wording.** Refs: C15 #13, lead 2. A11.1 bullet 4 is replaced by: "Ledger entry as for every gateway payment: C15 calls `BillingPort.recordGatewayPayment` inside its settle transaction (03-IC X3, canonical); C4's `payments.intent.settled.v1` consumer is the idempotent safety net." Files: 08 A11.1 (by the A14 apply), C6/C15 references.

**D-116 — Rate tier for public payment routes.** Refs: C15 m#25, lead 6. No new tier, because 02-CV §10.3 tiers come only from 04 §4. P30–P34 declare `x-rate-limit-tier: general`. 02-CV §10.3 gets a documented variant under `general`: "unauthenticated callback/launch routes: per-IP at nginx 10 r/s burst 20 (CR-C15-008) + app key per intent (`payments:cb:<intent_id>`)". Files: 02-CV §10.3, C15 TRD §5.2.

**D-117 — Vendor facts V1–V15.** Refs: C15 m#28, lead 7. 04 P3/P4 Source cells get "re-read 2026-11-06; details and open points in C15 02-TRD §0 (V1–V15)". V1–V15 stay in the C15 TRD with their UNVERIFIED labels. Adapter code depends on a V-row only where it is VERIFIED. UNVERIFIED rows (for example V3) stay non-decisive, as the TRD already states. Files: research/04 P3/P4, C15 TRD §0.

**D-118 — REQ-SEC-058 / REQ-SEC-052 deviations.** Refs: C15 m#29, lead 8. Recorded as DECISION in C15 07 §2:
- (1) REQ-SEC-058: gateway secrets are stored as AES-GCM ciphertext in `payments.merchant_accounts` under a KEK held in the C1 secret store (SOPS). The KEK never enters the DB.
- (2) REQ-SEC-052: callback and gateway payloads are stored redacted (allowlisted keys; Khalti `mobile` dropped per REQ-SEC-056) in append-only tables. Raw storage would retain PII.
The lead accepts both deviations. Files: C15 07 §2.

**D-119 — Reads allowed to non-staff request handlers.** Refs: C16 #4, lead 2. Also fixes C13 m#32 and C14 m#14.
New 02-CV §8.5 item 1: "Request handlers for `patient`, `portal` and `partner` actors read and write only their own module's tables, plus exactly these owner-supported reads: `IdentityPort.getActor` / `assertRole`; `IdentityPort.getTenantSettings` with `keys` ⊆ {`timezone`, `calendarDisplay`} (C2 refuses other keys for these actors with `auth.forbidden`); `ReportingPort.getReleasedReports` / `openReleasedReportFile` / `redeemPortalLinkForApp` (partner, patient — CR-C13-005, C16-008). `SmartReportPort` is not callable by them (08 A2.3)."
Centre data for patients:
- C16 adds the projection `engagement.booking_centres (tenant_id, centre_id, branch_id, display_name, address_text, is_active, synced_at)` with `UNIQUE (tenant_id, centre_id)`. Its table class and mandatory columns follow 02-CV §5.2, the same class as C13's `price_list_items` projection.
- The table is written only by the system actor in a new task `engagement.sync_booking_centres` (nightly `per_tenant` per P-6, and enqueued on slot-template save).
- E31, booking DTOs and `createMyBooking` (`branch_id`) read only this table. `ctx.core` is not called in patient context.
Files: 02-CV §8.5, C2 TRD (key filter), C16 SCH/TRD §4.8/§8.2.

**D-120 — Completion of home-collection bookings.** Refs: C16 #5, lead 1.
- `homecollection.collection.synced.v1` gets an optional field `booking_id` (Uuidv7), present iff the visit has `kind = 'booking'` (C17 `visits.booking_id`, SCH l.88). Per P-5 it is not in `required`. Consumers += C16; C4 and C5 confirm they tolerate the field.
- C16: `reconcile_bookings` and `mark_no_shows` act on `booking_kind = 'centre_visit'` only. A `home_collection` booking becomes `completed` on the first synced event that carries its `booking_id`, and is never auto-no-showed. Staff cancel it manually (existing `cancelBooking`).
Files: 03-IC §3.23/§3.25, C17 TRD §7, C16 TRD §4.8/§7.2.

**D-121 — C16 DEFINER owner policies and one tenant-code resolver.** Refs: C16 #1, lead 3 (P-41); also used by D-134.
- **C0 resolver** (replaces `app.engagement_resolve_tenant_code`): `app.core_resolve_tenant_code(p_code text) RETURNS TABLE (tenant_id uuid, status text)`, owner `lims_owner`, EXECUTE `lims_api`, `SET search_path = ''`, plpgsql. The body is `set_config('app.pre_tenant_code', p_code, true)` → select → reset to `''`. `core.tenants__select__owner_only` is ORed with `tenant_code = nullif(current_setting('app.pre_tenant_code', true), '')` (A12.1 naming; one owner SELECT policy per table). The caller filters `status = 'active'`.
- `app.engagement_resolve_preauth` and `app.engagement_resolve_display` are rewritten in plpgsql. They set `app.pre_engagement_otp_token_sha256` / `app.pre_engagement_display_token_sha256` (hex). Owner SELECT policies:
  - `otp_challenges__select__owner_only TO lims_owner USING (token_sha256 = decode(current_setting('app.pre_engagement_otp_token_sha256', true), 'hex'))`;
  - `queue_displays__select__owner_only … USING (token_sha256 = decode(current_setting('app.pre_engagement_display_token_sha256', true), 'hex'))`.
  - The tenant-status check sets `app.pre_tenant_id` after the row is found (A12.1).
- Tenant-claim DEFINERs (owner `lims_owner`):
  - `accounts__select__owner_only USING (tenant_id = (SELECT app.current_tenant_id()) AND membership_id = nullif(app.current_claims() ->> 'membership_id', '')::uuid)`;
  - `account_patient_links__select__owner_only USING (tenant_id = (SELECT app.current_tenant_id()) AND account_id = app.engagement_account_id())`;
  - `link_codes__select__owner_only USING (tenant_id = (SELECT app.current_tenant_id()) AND (status = 'issued' OR redeemed_account_id = app.engagement_account_id()))`;
  - `link_codes__update__owner_only USING (tenant_id = (SELECT app.current_tenant_id()) AND status = 'issued') WITH CHECK (redeemed_account_id = app.engagement_account_id())`.
- `engagement.purge_*`: retention deletes of class-E tables follow batch-2 P-18(c) (system actor, `per_tenant`, no DEFINER). Only a purge that updates or deletes non-E rows stays a DEFINER, with `app.maintenance = '<function name>'` plus its expiry predicate (A12.2), written by C16.
- All rows go into 03-IC §13.3 / 08 §4.7, with A12.7 tests in 06 T-A2/T-L2/T-Q3.
Files: C0 SCH §10, 03-IC §13.3, 08 §4.7, C16 SCH §5–§6/§9.

**D-122 — OTP per-IP limit under carrier NAT.** Refs: C16 m#37, lead 8. Same reasoning as A1 (shared NAT is normal in Nepal). The OTP challenge/verify per-IP 5/min [CONV] from R6 becomes an edge flood guard: 60 r/m/IP, burst 20, nginx [CONV]. The binding limits stay `otp_request` 3/hour/phone and `otp_verify` 5/OTP (04 §4). The 04 A9 and A1 scope lines are unchanged. Files: 08 R6 text (by the A14 apply), C16 TRD §11, C1 nginx.

**D-123 — B2C dashboard (00 §3 item 11).** Refs: C16 #21, lead 5. Owner **C8**, delivered as the later additive CR that A2.7 foresees, after C16 ships (01 §1 wave order, B1 closed A11.2). 01-CM §2 row C8 notes "B2C dashboard (00 §3.11): booking/queue tiles from `engagement.v_pub_*` after C16". The C16 PRD §4.2/M-6 text follows. Files: 01-CM §2, C16 PRD.

**D-124 — "Their own developed Patient App" (00 §3 item 5).** Refs: C16 m#36, lead 7. Build per 04 §12 phase 3 (native patient app, C16). Recorded as open client question **C-06** in 08 §5.2: "Does the client have or plan its own patient/phlebotomy app? Default: the LIMS provider builds both (C16, C17)." Files: 08 §5.2, C16 PRD §1.

**D-125 — Handover visibility at the receiving centre.** Refs: C17 #1, lead 3. Decision: the reviewer's denormalisation, with the smallest field set.
- `handover_items` += `barcode text NOT NULL CHECK (barcode ~ '^[A-Z0-9]{1,20}$')` (P2) and `specimen_type_code text NOT NULL`. Both are filled when `handover.recorded` is applied, from that push's `lookupSpecimens` result. They follow the visits' retention and anonymisation.
- There is no `window_start`; W3 drops the "Visit window" column.
- H14 reads only `handovers`/`handover_items`.
- H15 enqueues `homecollection.flag_handover_discrepancy` (system actor) instead of inserting `visit_flags` in the receiver's transaction.
- Receivers do not join the home-collection centre (data minimisation).
Files: C17 SCH §3/§4.1, TRD §5.4, UI W3.

**D-126 — Missed-visit sweep vs late offline uploads.** Refs: C17 #11, lead 1. No new transition. The 00:20 sweep (V7) skips any visit whose route has `last_snapshot_at` on `route_date` (tenant business date, P-15), because a phone holds it. Such visits get flag `missed` and stay `assigned` until the dispatcher acts (H4 unassign is still blocked by an applied mutation). Test: an offline upload on day +1 for a pulled route applies cleanly. Files: C17 APP-FLOW V7/E15, TRD §10.

**D-127 — Re-auth fallback without the biometric plugin.** Refs: C17 #13, lead 2. There is no offline PIN (no new secret). CR-C17-010 (plugin pinning by C0) becomes a hard precondition of HC-T23 and of any app release (06 §0). Until then the app is not shipped, and the "> 5 min background → online login" fallback is deleted. Files: C17 06 §0, TRD CR-C17-010.

**D-128 — Field payment-method codes.** Refs: C17 #16, lead 4. No new C4 read path.
- C17 `payment_methods` codes are restricted to C4's global seed codes {`cash`, `card`, `esewa`, `khalti`, `fonepay_qr`, `bank_transfer`} (C4 SCH l.1212, 00 A9). H19 rejects other codes (`400 common.validation_failed`).
- `requires_reference` defaults copy C4's seed: `fonepay_qr`, `card` and `bank_transfer` are true; `cash`, `esewa` and `khalti` are false.
- C4 confirms that its `collection.synced` consumer never dead-letters on a tenant-inactive method and raises a finance review item instead (C4 to confirm).
Files: C17 TRD §11.2, PRD US-07-7, C4 TRD §8 (confirmation).

**D-129 — C17 SMS templates.** Refs: C17 #15, lead 5.
- `homecollection.visit_assigned` was already decided by **A13 D-34**, including staff `suppressed_no_contact` in Phase 1. C17 says the assignment SMS is not sent in Phase 1.
- New seed: `homecollection.visit_scheduled` (purpose `booking_confirmation`, channel `sms`, recipient patient, params `window_start_local` and `window_end_local`, both `short_text` (A4.3); no lab-name parameter). This is CR-C17-014 [CONV id] to C6.
- The tenant switch stays disabled until the seed exists.
Files: 03-IC §4.8 template list, 08 §4.10, C6 SCH §8, C17 TRD §9.2.

**D-130 — Tenant-editable reason codes.** Refs: C17 m#35, lead 6. Drop `homecollection.cs_reasons` from v1. Global seeds only, with no endpoint or UI. Files: C17 SCH, TRD.

**D-131 — Per-phlebotomist daily cap.** Refs: C17 #9, lead 7. Confirm `LIMS_HOMECOLLECTION_SNAPSHOT_MAX_VISITS` = 60 [CONV] as the cap across all of one phlebotomist's routes on a `route_date`. H3 refuses past it with `400 common.validation_failed`, pointer `/phlebotomist_membership_id` (P-1). The snapshot never truncates, and E14 is rewritten to match. Files: C17 TRD H3/§11.1, APP-FLOW E14.

**D-132 — C18 gates (design only).** Refs: C18 #2, lead 1. 08 F-06 and 07 B4 are binding and are not re-decided here.
- Delete G-1. Every task except T00 requires "B4 lifted (eLabs sample received), 08 F-06". Gate order: G-4 → G-2 → G-3 → G-5.
- If the founder later changes F-06, 08 §5.1 records it and the gates are revisited.
- PRD §0 cites 06 §1. PRD §8 says "C0 fake, created when the CR is accepted after B4".
Files: C18 06 §1, PRD §0/§8.

**D-133 — C18 four-eyes (design text).** Refs: C18 #6, lead 2.
- Void and early purge are two commands, `… request` by operator A and `… approve <run>` by B. B runs it from B's own Unix account, mapped through `LIMS_MIGRATION_OPERATOR_MAP`, with B ≠ A. Each command writes a `signoffs` row (`void_approval` / `early_purge_approval`). Purge checks for that row, and `--approval <ref>` is deleted.
- Lab-lead match decisions and the sign-off rest on the paper sign-off form. Its reference is stored on every `match decide` and `signoff`. 07 §4 lists this as a design choice for the security reviewer.
- A web review screen stays a 06 §5 candidate.
Files: C18 UI §3, APP-FLOW §3.6/§3.12, PRD AC-12.2, 07.

**D-134 — Tenant resolution in the C18 tool (design text for CR-C18-005, DEFERRED).** Refs: C18 #4, lead 3.
- `--tenant <code>` is required on every run-addressed command.
- The code is resolved through D-121's `app.core_resolve_tenant_code` (EXECUTE += `lims_migration` when CR-C18-001 is accepted after B4).
- Reads use `ctx.core.centres`/`centre`/`membership` (C0 TRD §6.8).
- `status --metrics` enumerates tenants with the existing A13 P-6 `app.cron_tenant_ids()` (EXECUTE += `lims_migration`, same condition).
- No new C0 capability is requested.
Files: C18 APP-FLOW §3.2/§3.4/§3.6, TRD CR-C18-005 text, UI §2.

**D-135 — Legacy history default.** Refs: C18 #9, lead 4. The binding 03-IC §4.5 default `includeLegacy = false` stands. CR-C18-003 is rewritten to the reserved contract: `source: 'legacy'` points, `resultId = lab.legacy_results.id`, `approvedAt = reported_at`. The C5 routes #25/#26 pass `includeLegacy = lab_settings.legacy_in_history`, whose proposed default becomes **false**, matching the port. The lab turns it on after cut-over. `legacy_in_delta` stays false. Files: C18 TRD CR-C18-003, PRD AC-14.x.

**D-136 — C18 schema exceptions and the `lims_migration` role.** Refs: C18 m#20, m#21, C18-L6, lead 5–6. Not accepted now; deferred to the acceptance of CR-C18-001 after B4 (08 F-06). This is not a re-decision, because no C18 DDL is allowed before B4. In C18 05 §1.2/§1.5/§1.6 and 07 §4 item 3, each item is labelled "PROPOSED EXCEPTION — needs 08 acceptance after B4". The items are:
- policies `TO lims_migration`;
- no row audit on `stg_*`, `match_pairs`, `issues`, `samples`;
- class E without `expires_at`;
- class "C-legacy";
- `GRANT lims_app TO lims_migration`.
Meanwhile the C18 design adds `AND (SELECT app.is_staff_or_system())` to its §5 policy templates (instance of batch-2 P-16) and `id`/`UNIQUE (tenant_id, id)` to `issues`. Files: C18 SCH §1/§5, 07 §4.

Overlap check against `_triage-batch2.md` (read at finish):
- No D-100…D-136 duplicates a D-44…D-75.
- Batch-2 P-16 (staff guard in the DDL) covers C15 #3, C17 #6 and C18 m#20. Those items are marked "instance of P-16" in (c) and get no new rule.
- Batch-2 P-18(c) (purge path by class) narrows P-41 and is applied in D-121, C13 #2 and C17 #5.
- Batch-2 P-20 (phase stubs) applies to C14, C15 and C16.
- Batch-2 P-22 (lazy singleton rows) covers C13 m#19.
- Batch-2 P-23 (port error propagation) covers C15 m#16 / D-113's `x-error-codes` line.
- D-110 includes batch 2's FrontdeskPort consumers C10 and C11.
- The device question in D-109 (devices admitted on C3–C12 `__tenant` tables) is not addressed by batch 2 and stays open.

---

## (c) Per-chunk LOCAL fix lists

Verified LOCAL items show their finding number. Items covered by a P-rule or D are marked. Minors not on a lead list are listed as reported (not re-verified).

**C13** — LOCAL (verified): #1 (instance of A10.5 / P-41): owner policies `partner_users__select__owner_only` `USING (tenant_id = (SELECT app.current_tenant_id()) AND membership_id = nullif(app.current_claims() ->> 'membership_id', '')::uuid)` and `partners__select__owner_only` `USING (tenant_id = (SELECT app.current_tenant_id()))`, `TO lims_owner`, plus A12.7 tests; this is narrower than the reviewer's USING. #3 (P-44). #5 (3-column composite FKs, as proposed). Cross/decision items: #2 CROSS (P-41: owner policies on `manifest_lines`, `order_reports`, `order_tracking` gated by `app.maintenance = 'partners_redact_lines'` per A12.2, replacing `partners.redaction` here and in `guard_line_update`; the `download_counters` 30-day delete leaves the DEFINER and becomes a P-18(c) system-actor delete in the task; inventory row in 08 §4.7 / 03-IC §13.3), #4 D-103, #6 D-100, #7 D-101, #8 D-102, #9 CROSS P-45, #10 D-104, m#28 D-105, m#22 D-106, m#31/m#32 D-110/D-119.
Minors (as reported): 11–21, 23–27, 29, 30. Applicable existing rules: m#17 = P-11; m#16 = A11.2; m#19 = batch-2 P-22 (lazy settings row; readers use code defaults); m#20 = A5.1/A7.5; m#29 write-once follows 08 §4.8 (C0 to state the "retry before `issued` may replace" rule); `partners.sync_statements` "hourly cron (tenant iteration)" = P-6 `per_tenant`; `purge_access_slips` delete = P-12(a); any `422 common.validation_failed` = P-1.

**C14** — LOCAL (verified): #6 (`input_result_versions` = exactly the hashed `getOrderResults({scope:'approved'})` set, sorted; with m#15, raise the CHECK to 1–2000 [CONV] and state it in E19), #7 (A4.4 wording in 4 places + AC-17.4), #8 (A2.3: remove the read-only actor path from 06 T13, 06 §4, 07 §1/§3). Cross/decision items: #1 D-107, #2 D-108, #3 D-109, #4 D-110, #5 D-111, m#14 D-110/D-119, m#16 P-43.
Minors (as reported): 9–13, 15, 17, 18. m#13 = A4.7; m#11: `systemPermissions` belongs in `ModuleManifest` (C0 TRD; same finding as batch-2 C11 #2). Batch-2 P-20 applies to the `SmartReportPort` phase-stub replacement.

**C15** — LOCAL (verified): #2 (P34 declares optional `intent_id` (uuid, ignored, never echoed) + HTTP contract test), #3 (instance of batch-2 P-16 / 02-CV §5.8: `AND (SELECT app.is_staff_or_system())` on every `payments.*` policy + non-staff probes), #6 (P11b `failManualPaymentRefund` + `refund_fail_reasons`, as proposed), #7 (P7b `recheckPaymentRefund`, as proposed), #11 (instance of A11.1: C6 reporting worker as a system-actor consumer, US-PG-11b, F-05 rewritten to the F-04 pattern, PG-T24, CR table "ACCEPT-MODIFIED (A11.1)"). Cross/decision items: #1 P-40 (CROSS), #4 D-110 (CROSS), #5 D-112, #8/#9 D-113, #10 CROSS (C1 02-TRD/07 take CR-C15-008 items (1)–(6); C1 has no `payments` text), #12 D-114, #13 D-115, m#25 D-116, m#28 D-117, m#29 D-118, m#17 P-40, P24 P-43.
Minors (as reported): 14–24, 26, 27, 30, 31. m#14 is an instance of A12.1: GUC becomes `app.pre_payments_callback_token_sha256` (hex), policy `USING (callback_token_sha256 = decode(current_setting('app.pre_payments_callback_token_sha256', true), 'hex'))`, the `OR tenant_id = …` disjunct is dropped, plus A12.7 tests. m#16 is absorbed by D-113. m#26 is absorbed by D-114. m#27 is absorbed by D-110. Batch-2 P-20 applies to the `PaymentProviderPort` phase stub, and P-23 to the propagated `payments.*` codes.

**C16** — LOCAL (verified): #2 (P-42: `commitOnError()` on the OTP mismatch path and the `linkfail:` path, not on the step-4 limit path), #3 (`__Secure-lims_qdisp; Path=/queue-display; HttpOnly; Secure; SameSite=Strict` [CONV, narrower path than `__Host-`]), #6 (P-1), #7 (`403 common.feature_disabled`), #8 (supersession in `send_login_otp` task), #9 (one rollback rule in 3 places), #10 (key `otp_day:<yyyymmdd>`), #11 (P-4: add `addendum`; unknown kinds stored, stage `in_lab`), #12 (default `other` when a self link exists; staff code `self` → `other`), #13 (active **or suspended** link reactivated, as proposed), #14 (patient column guard + probe P-L9; reactivation only via DEFINER/system), #16 (`sex_snapshot` on `link_codes`, copied on redeem; NULL = not enforced), #17 (US-EN-02.6 rewritten), #18 (`syn_alpha`/`syn_beta`; regex `^[a-z][a-z0-9_]{2,31}$`), #19 (P-43), #20 (rotated `session_token` in APP-FLOW §2.2 + T-A1 test). Cross/decision items: #1 D-121, #4 D-119, #5 D-120, #15 D-106 (CROSS), #21 D-123, m#36 D-124, m#37 D-122.
Minors (as reported): 22–35. m#22 = A11.2; m#25 codes `auth.otp_sent`/`auth.otp_failure`/`patient_account.delete` are already in the C0 seed (C0 SCH l.263 / 03-IC §13.1), so only the `ctx.audit.access` calls are missing, with `commitOnError` per P-42; m#26 = R10; m#27 = R25; m#29 = D-110; OTP challenge POSTs = P-8 E2; purge tasks = P-6 `per_tenant` + batch-2 P-18(c) / A12.2; batch-2 P-20 applies to the `EngagementPort` phase stub.

**C17** — LOCAL (verified): #2 (snapshot always calls `lookupSpecimens`; on port error `specimens: []` + `specimens_stale: true`, Collect disabled), #3 (stored batch body re-sent byte for byte; on `422 idempotency_key_reused` a new `batch_id`), #4 (P-1; H7 parent precondition → `409 homecollection.visit_closed`), #6 (instance of batch-2 P-16: `is_staff_or_system()` on §4.1 (3) tables), #7 (not-found mutations are not stored; `handover.recorded` centre rule), #8 (`openMobileSession({email,password,app_instance_id: phlebo.device_id, app_platform})`; `logoutMobileSession({session_token})`), #10 (every committed change to a visit with `route_id` bumps the route `version`), #12 (outbox bound to the first user; other user refused; A1 for a foreign device → `409 homecollection.device_not_registered`), #14 (SELECT → guard → INSERT with outcome), #17 (DTO field tables), #18 (H21 `revealHomeVisitPhone` → `home_visit.view` purpose `phone_reveal`; H2 writes `home_visit.view` purpose `visit_detail`; no new action code), #19 (chord `g t`). Cross/decision items: #1 D-125, #5 CROSS. `visit_locations` (class E) retention delete follows batch-2 P-18(c): system actor in the `per_tenant` task, `visit_locations__delete__tenant_centre … USING (… AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now())`, DELETE granted on this E table only, and the 05 "no DELETE grant" CI line amended. `anonymise_retired_visits` stays a DEFINER under P-41 / A10.5 + A12.2, with `app.maintenance = 'homecollection_anonymise_retired_visits'` and the reviewer's narrow predicate replacing `app.purge_tenant`/`app.retention_purge`. The transition guard skips only under that maintenance value. Inventory row added., #9 D-131, #11 D-126, #13 D-127, #15 D-129, #16 D-128, m#35 D-130.
Minors (as reported): 20–34, 36–39. m#21 = A11.2; m#26 = P-8 (H5, H6, H15, H17 `required`); m#25 purge task = P-6 `per_tenant`, A12.2; m#24 inbox generated by C0 (C0 SCH §3.9); m#34 uses `getPatientDemographicsBatch` (03-IC §4.3); m#36 UNVERIFIED labels. Batch 1's D-34 and D-38 (phlebotomy app ids for `/.well-known`) apply.

**C18** (design only) — LOCAL (verified): #1 (ancestor chain via `parent_run_id` in `verified`/`signed_off`, or any `signed_off` run; AC-09.4), #3 (R26: `reporting-legacy` everywhere; delete the l.714 deferral sentence), #5 (dry-run outcomes in `stg_<entity>.dry_run_outcome` only; delete `markDryRunOk` and `batches.dry_run_outcomes`), #7 (`reviewedDuplicates: true` for `keep_separate`/`create_new`; same-run candidates not stored; contract case), #8 (`ref_low_target`/`ref_high_target`; checksum on `value_numeric_target`; AC-03.6), #10 (CR-C18-008 is already ACCEPT in 08 §3: add `credit_parties` to `masters build` mapped to the C3 `CreditParties` sheet (C3 TRD §8.2); `allows_credit` default Y; phone via §9.2 normalisation to `^\+[1-9][0-9]{7,14}$` (P-11)), #11 (CR-C18-004 design text adds `reporting.sweep_legacy_orphans` (daily [CONV]) + contract case 11; the l.202 note cites it; the false claim about an existing C6 sweep is removed). Decision items: #2 D-132, #4 D-134, #6 D-133, #9 D-135, m#20/m#21/C18-L6 D-136.
Minors (as reported): 12–19, 22–28. m#24: T00 → "confirm 08 §3 status of CR-C18-001…010; no filing". m#19 `tool_run_id` claim: drop it (not in 03-IC §13 `extraClaims`).

---

## (d) FALSE / ALREADY-FIXED findings

No verified finding is wholly FALSE or ALREADY-FIXED. Partial results and corrections to reviewers' *proposed fixes* (the findings themselves stand):
- **C16 #15 — CONFIRMED-PARTIAL.** The claim "consumers of `lab.v_pub_specimen_timeline` are C8, C9, C13 (C16 not granted)" is **false**: 03-IC §6.3 (l.2164) and 08 §4.9 (l.1253) list "C8, C9, C13, C16". The rest is confirmed: the view has no seq or `replaces_specimen_id` column. Fixed by D-106 (no consumer CR needed).
- **C17 #15 — CONFIRMED-PARTIAL / ALREADY-FIXED in part.** `homecollection.visit_assigned` was decided by **08 A13 D-34**, which also keeps staff recipients `suppressed_no_contact` in Phase 1. The reviewer's "lift staff suppression for `visit_assignment`" contradicts D-34 and is not adopted. Only `homecollection.visit_scheduled` is new (D-129).
- **C13 #1** — the reviewer's owner-policy USING (`tenant_id` only) is wider than needed. The `partner_users` policy also binds `membership_id` to the claims (see (c)).
- **C13 #2** — the reviewer's GUC `partners.redaction` is an ad-hoc name, which A12.2 replaces with `app.maintenance = '<function name>'`.
- **C13 #6** — both proposed options (a stored `membership_version`, or `version` returned at provision) go stale whenever C2 updates the membership, because the repository bumps `version` on every UPDATE (02-CV §5). Superseded by D-100.
- **C13 #7** — the reviewer's "allowed by the CI rule because it is a self-scoped code" has no source in 03-IC §11 / 08 §4.1. D-101 is decided on its own merits.
- **C14 #3** — the reviewer's option (a) `<> 'device'` would still admit any future actor type. D-109 uses the positive list `IN ('user','system')` and keeps `is_staff_or_system()` for batch-2 P-16.
- **C15 #1** — the reviewer's fix (change C16 to `eng_`) would leave every other port caller's colon keys (C3, C4, C8–C11, C13, C15, C16, C17) unvalidated against any grammar. P-40 fixes the grammar once, at the owner.
- **C15 #5** — new codes CR-C15-015 are not needed: refund and config writes are modifications covered by the row-audit trigger (REQ-SEC-096 split), and `settings.change` / `payment_intent.resolve` already exist (D-112).
- **C15 #9 / #8** — no new C4 endpoint B14 is needed: C15 P5 already exists with `payments.intent.create`, which `front_desk` holds (D-113).
- **C16 #1** — the reviewer's GUC `app.lookup_token_sha256` is the old C6 name. A12.1 requires `app.pre_*` names, so D-121 uses `app.pre_engagement_*`. C16's separate tenant-code resolver is folded into one C0 resolver (D-121), which C18 reuses (D-134).
- **C16 #3** — of the two options, the reviewer did not choose. `__Host-` with `Path=/` would send the display cookie on every staff-web path, so the narrower `__Secure-…; Path=/queue-display` is chosen (least privilege).
- **C17 #5** — the reviewer's `app.purge_tenant` / `app.retention_purge` GUCs are replaced by A12.2's `app.maintenance` (P-41). The `visit_locations` delete needs no DEFINER at all (batch-2 P-18(c)).
- **C17 #16** — the reviewer's proposed C4 `BillingPort.listPaymentMethods()` adds a port method. D-128 validates against the fixed C4 global seed instead.
- **C18 #4** — the requested new `ToolRuntime.resolveTenantByCode` / `listTenantIds` capabilities are not needed: D-121's resolver and A13 P-6's `app.cron_tenant_ids()` cover both (D-134).
- **C18 #9** — the reviewer left the default to the lead. Keeping the binding port default (false) avoids two defaults for one read path (D-135).
