# Triage — review batch 1 (C3–C7)

Date 2026-11-06. Inputs: `review/C3-catalog-pricing.md`, `C4-frontdesk-billing.md`, `C5-lab-workflow.md`, `C6-reporting-delivery.md`, `C7-instrument-integration.md`. Authority applied: 00 > research/04 > 08 (§2 + Addenda A1–A11) > 03-IC > 01/02-CV > research/01–03 > chunk docs. Founder rules respected: no new foreign touchpoint, all data in Nepal, synthetic data only. **No spec file was edited.**

Scope of verification: every BLOCKER and MAJOR, every "Needs lead decision" item (incl. the minors listed there and C6 lead item 14, referred to as **C6-L14**). Each was checked against the cited source text by opening the file. MINOR findings that are not on a lead list were **not** re-verified; they are listed in (c) as reported.

Result: 109 items verified — **109 CONFIRMED, 0 FALSE, 0 ALREADY-FIXED** (two reviewer *proposals* contain errors, corrected in (d)). Classification: **LOCAL 54 · CROSS 17 · DECISION 38**.

New binding input taken into account: **08 A10.5** (every DEFINER touching a FORCE-RLS table needs a narrow `__<cmd>__owner_only` policy) — applied to C7 #1/#3, D-30, P-6, C4 m#32; **08 A11.1** (portal dues payment, worker pattern) — applied to P-8; **A11.2** (B1 closed) — no batch-1 finding depends on it.

Conventions: `[CONV]` = value chosen in this triage; "m#" = a MINOR finding number.

---

## (a) Program-wide rules proposed

**P-1 — `common.validation_failed` is HTTP 400 only.** (C3 #1, C5 m#21)
Text for 02-CV §4.7 (new bullet): "`common.validation_failed` is always `400` (03-IC §8). A business rule with no registered code of its own is reported as `400 common.validation_failed` with a JSON-pointer path in `errors[]`. No document writes '422 common.validation_failed'; 422 is used only by codes registered with `http: 422`." No new code is registered.
Mechanical sweep (the same string, counted by grep): C3 PRD 9, TRD 7, AF 2, SEC 1; C4 PRD 1, AF 1; C5 PRD 4, TRD 1, SEC 1; C7 PRD 5, TRD 2. Outside this batch: C2, C10, C12, C13, C15, C16, C17 (for the batch-2 reviewers).

**P-2 — Stored files reach browsers only by streaming through the API.** (C4 #2, C7 #2)
Text for 02-CV §10.2, row "Serving uploads" (replaces the row): "Through an API `GET …/content` (or `…/file`) operation using the core streaming download helper (`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`; BFF proxies the stream). The object must be `clean`, otherwise `422 common.upload_quarantined`. Every call writes an `access_log` row. `ctx.storage.signedUrl` is internal to `services/{api,worker}` and never appears in a response, header or log (03-IC §13.6). Never inline on an app origin."
Consequence outside the batch: C1 `LIMS_ORIGIN_FILES` ("Storage signed-URL downloads only") and C1 03-APP-FLOW §1.3 describe a browser signed-URL path. That path has no remaining user, so C1 removes it or marks it unused (lead to confirm; C1 not reviewed here).

**P-3 — Every access-log action is registered before use.** (C5 #1; previous case 08 A2.9)
Text for 02-CV §10.2, row "Audit" (append): "Each chunk TRD lists every `ctx.audit.access` call as operation → `action` → `entityType`. Every `action` must exist in 03-IC §13.1 / the C0 seed. CI (C0-0C) fails a string-literal `action:` in `services/**` that is not in `audit.g_cs_access_actions`."

**P-4 — Consumers do not close `x-extensible` enums.** (C5 #4)
Text for 02-CV §7.2 (append): "A consumer that stores a field marked `x-extensible: true` must not constrain it with a closed `CHECK … IN (…)`. Use `CHECK (char_length(<col>) BETWEEN 1 AND 32)`, and state in the consumer TRD how an unknown value is treated."

**P-5 — Conditionally present event fields use `if/then`, not `required`.** (C4 #1, C5 #8)
Text for 02-CV §7.2 (append): "A payload field that is legitimately absent in some cases is not listed in top-level `required`. The condition is expressed with JSON Schema 2020-12 `if`/`then`/`else`, or, when no payload field can express it, stated in the event's Notes. Consumers must tolerate the absence. This counts as an additive `.v1` change only if every listed consumer confirms it tolerates the absence; the apply phase records that confirmation."

**P-6 — Module cron tasks run per tenant.** (C3 #6; same pattern in C4 TRD §10 [7 tasks] and C7 TRD §10)
Text for C0 TRD §7.2 (after `crontab`): "`tenantScope: 'per_tenant'`: at each schedule tick the worker core enqueues one job per tenant with `core.tenants.status IN ('active','suspended')` [CONV]. Payload is `{tenant_id}`, `job_key = '<identifier>:<tenant_id>:<tick, ISO minute>'` [CONV]. The job runs under that tenant's claims for the module's system actor. The tenant list comes from the new DEFINER `app.cron_tenant_ids() RETURNS SETOF uuid` (owner `lims_owner`, EXECUTE `lims_worker`, `SET search_path = ''`), which needs `core.tenants__select__owner_only` per 08 A10.5. `tenantScope: 'platform'` is for C0 core tasks and for module tasks that only call an inventoried DEFINER without tenant claims."
Add the function to 03-IC §13.3 / 08 §4.7. Chunk effect:
- C3: `catalog.expire_imports`, `purge_files`, `global_release_fanout` become `per_tenant`.
- C4: every §10 row marked "platform (iterates tenants)" becomes `per_tenant`.
- C7: `evaluate_agent_health`, `expire_credentials_and_commands` and `purge_archive` become `per_tenant` (see D-42). `export_agent_state_metrics` stays `platform` (DEFINER snapshot).
- C6 already says "per tenant", so it only needs the explicit field.

**P-7 — Tenant-leading key rule: the PK exemption.** (C4 #12)
Text for 02-CV §5.3 first rule (replaces it): "`tenant_id` is the leading column of every index and unique constraint on tenant tables **except the single-column `PRIMARY KEY (id)`** (UUIDv7, globally unique, 04 D9). Every tenant table also has `UNIQUE (tenant_id, id)` (§5.4). Other exceptions are listed in `db/meta/index-exceptions.yaml`." The C4 CI check (US-BL-15 AC2, 05-SCHEMA §9 item 2) uses the same wording. The template already does this, so no DDL changes.

**P-8 — Idempotency: required on creates, with two named exceptions.** (C3 #46, C5 m#44, C6 #17, C6 #26, C7 #12)
Text for 02-CV §4.5 (append under the first paragraph): "'Creates state' includes master-data creates (catalog rows, rules, templates, contacts). There are two exceptions, each with `x-idempotency: none` and a justification string:
- **(E1) secret shown once.** The 2xx body contains a secret, so storing it for replay would persist the secret. Double submit is guarded by `If-Match` on the parent row's `version`. Existing user: C7 E14; C6 C3 `rotateChannelCallbackToken`.
- **(E2) portal / patient pre-auth OTP POSTs.** Rows are superseded and bounded by the `otp_request`/`otp_verify` tiers. Covers C6 P1, P2, P5 and the C16 OTP challenge POSTs.

The portal dues-payment request POST (08 A11.1, C6 spec) is **not** an exception: `x-idempotency: required`."

**P-9 — One spreadsheet writer and one injection guard.** (C3 #8, C4 #8; C8 is outside the batch and has a local `domain/csv.ts#neutraliseFormula`)
Text for 08 R12e / 03-IC §13.6 `@lims/shared-ts/spreadsheet` (replaces the one-line comment):

```ts
export function neutraliseFormula(cell: string): string;   // prefixes "'" when cell starts with = + - @ \t \r or "'"
export function restoreNeutralised(cell: string): string;  // strips exactly one leading "'"; restoreNeutralised(neutraliseFormula(s)) === s for all s
```

Rule (02-CV §10.2 new row "Spreadsheets"): "Every XLSX/CSV text cell written by product code passes `neutraliseFormula`; importers apply `restoreNeutralised` before validation. Writer: `write-excel-file` 4.1.1. Module-local copies are banned (C3, C4, C8)." C0-0A adds the function and golden tests.

**P-10 — Conditional permissions stay in the handler; there is no vendor extension.** (C3 #10, C3 #7, C6 m#24)
Text for 02-CV §4.12 (append): "`x-permission` names the permission required on every call (the floor). Permissions that depend on a request value or on resource state are checked in the handler with `IdentityPort.assertRole` immediately after loading the target. They are written in the TRD row as `+ <code> when <condition>`, each branch has a hand-written permission test, and `auth.forbidden` / `auth.mfa_required` are in `x-error-codes`. `x-permission-by-param` / `x-permission-by-kind` do not exist."

**P-11 — One E.164 pattern.** (C3 m#43; also C13, outside the batch)
Text for 02-CV §3 (naming/format table, new row): "`phone_e164` columns and `phoneE164`/`phone_e164` fields: `^\+[1-9][0-9]{7,14}$` everywhere (08 A6.2 made program-wide)." Edits: C3 TRD l.165, SCH l.775 and l.809 (`{6,14}` → `{7,14}`); C13 has the same pattern in 5 places (batch 2).

**P-12 — Scope of `ctx.storage.delete`.** (C7 #14, C4 #23b)
Text for 03-IC §13.6 / 08 §4.13 comment on `delete` (replaces it): "Owner bucket only. Allowed for (a) E-class objects (prints, expired exports, quarantine rejects); (b) objects whose retention period has elapsed, deleted by the owning module's purge task; (c) a patient's objects deleted by that module's anonymisation handler once retention has elapsed. Each delete increments `lims_core_storage_deletes_total{bucket,reason}` [CONV]."

**P-13 — Cross-module storage reads.** (C6 m#38)
Text for 02-CV §10.2 (new row "Cross-module file reads"): "A module may `ctx.storage.read` another module's bucket only for a `(bucket, objectPath)` pair received in the same flow from the owner's port output, event payload or published view (for example `InstrumentResultInput.attachment`, `anatomic.v_pub_report_content`). Paths are never constructed. Writes stay owner-only (R26). Untrusted PDFs (instrument and outsourced) pass the renderer's `/internal/sanitize` before assembly, and `sanitized_sha256` is recorded."

**P-14 — Gates and alerts on paths the chunk does not own.** (C7 #13, C5 m#41)
Text for 01-CM §4 "May" (append): "A chunk keeps CI gate scripts and alert rule files in its own paths and lists them in its TRD tables 'CI jobs for C0-0A' (job id, trigger paths, runner OS, command) and 'Alert rules for C1' (expr, for, severity, route). C0-0A and C1 wire them through one CR per chunk."

**P-15 — Business-date timezone in v1.** (C3 m#40, C4 m#35, C6 SCH view comment; derived from minors, but the 02-CV §5.13 vs 03-IC §6 conflict is confirmed)
Text for 03-IC §6 header and C2 settings: "In v1, `TenantSettings.timezone` accepts only `Asia/Kathmandu` (C2 rejects other values with `identity.setting_out_of_range`). Views use the literal `AT TIME ZONE 'Asia/Kathmandu'`, and app code reads `timezone`. A per-tenant timezone needs a CR that adds stored `business_date` columns (08 §4.9 fallback)."

---

## (b) Decisions proposed

**D-1 — `billing.invoice.issued.v1` for periodic credit bills.** Refs: C4 #1. Problem: the payload requires `centre_id`, but periodic bills have none, so publishing fails. Decision (P-5): in 03-IC §3.4 replace `required` with
```json
"required": ["invoice_id","invoice_no","fiscal_year_bs","invoice_kind","branch_id","issued_at","totals"],
"if":   { "required": ["is_periodic_credit_bill"], "properties": { "is_periodic_credit_bill": { "const": true } } },
"then": { "required": ["credit_party_id"], "not": { "anyOf": [ { "required": ["order_id"] }, { "required": ["centre_id"] } ] } },
"else": { "required": ["order_id", "centre_id"] }
```
Notes: "`centre_id` absent for periodic credit bills". C8 confirms it tolerates the absence. C4 TRD §8.1 states the same and also states which `branch_id` a periodic bill carries (`invoices.branch_id` is NOT NULL; C4 local follow-up). Files: 03-IC §3.4, C4 TRD/AF §2.14, C8 consumer note.

**D-2 — `lab.result.verified.v1` optional fields.** Refs: C5 #8. Decision (P-5): remove `specimen_id` and `verified_by_membership_id` from `required` and add
```json
"if": { "properties": { "mode": { "const": "manual" } } },
"then": { "required": ["verified_by_membership_id"] },
"else": { "not": { "required": ["verified_by_membership_id"] } }
```
Notes: "`specimen_id` absent iff the result has no specimen (`TestDefinition.usesExistingMaterial`, CR-C11-009)." Consumers C8, C9, C12 confirm. Files: 03-IC §3.9, C5 TRD §7.1, C9/C12 consumer notes.

**D-3 — `reporting.delivery.status_changed.v1` with `phone_otp`.** Refs: C6 #2. Decision: in §3.18, `"recipient_kind": { "enum": ["patient","referrer","centre","partner","staff","phone_otp"], "x-extensible": true }`. C8 counts an unknown value as `other`. C6 adds the contract test "phone_otp delivery event validates". Files: 03-IC §3.18, C6 TRD §8.1, C8.

**D-4 — Label printing seam (C4 ↔ C5).** Refs: C4 #21, C5 #5, C5 #11 (reconciles both reviewers).
- C5 #14a `requestOrderLabelPrint`: `x-idempotency: none`. Returns `200 { order_id, specimens:[{specimen_id, barcode, outcome: 'ready'|'inactive'}], labels_route: 'staff.lab.order_labels' }`. It is a readiness call only: no counter and no access log. Not ready → `409 common.version_conflict` with detail (A2.10 kept); a retry with no key now works.
- C5 #14 `printSpecimenLabels` is the only place that increments `label_print_count` and writes access-log `specimen_label.print` (one row per specimen, D-11). Its response carries `label_copies_default` and the label size, so the label page needs neither #15 nor #47.
- One setting: C4 `frontdesk.label_autoprint` decides whether C4 opens `staff.lab.order_labels` after save. The label page always calls `window.print()` after render. **Delete `lab_settings.auto_print_labels`.**
- 03-IC §11: `lab.specimen.read` roles += `front_desk`, `phlebotomist` (RLS keeps centre scope), so the collect screen (#1) works.
- C4 US-FD-15 / AF §2.3 / UI §3.4 text: "after `200`, open `staff.lab.order_labels` in a print frame; panel 'Labels ready — printing'".
Files: 03-IC §11; C4 PRD/AF/UI; C5 PRD §2, AC-02.x, TRD #14/#14a/#47, AF §2.1/§3.1/§3.2, SCH `lab_settings`.

**D-5 — Order status and item removability come from LabPort, not a view.** Refs: C4 #22, C5 #13. Decision (R25 kept):
- 03-IC §4.5 signature:
  ```ts
  /** Callers holding frontdesk.order.read or frontdesk.order.edit, or system. No PHI. */
  getOrderItemProcessingState(ctx: RequestContext, input: { orderId: Uuidv7 }): Promise<readonly { orderItemId: Uuidv7; removable: boolean; reasonCode?: Code;
    processingStatus: 'not_started' | 'in_progress' | 'reported' | 'cancelled' }[]>;
  ```
- Semantics:
  - `removable` = no non-rejected specimen linked to the item has `received_at`, and no result of the item is `resulted` or later; otherwise `false` with `reasonCode: specimen_received`.
  - `cancelled` = every `order_test` of the item is `cancelled`.
  - `reported` = every non-cancelled `order_test` is reported (S10).
  - `not_started` = no specimen of the item received.
  - Otherwise `in_progress`.
- C5 rule: a specimen rejected without recollection sets its `order_tests.status = 'cancelled'` (cancel reason `specimen_rejected`). Its pending results go to R8 `cancelled`, and readiness excludes them.
- 03-IC §10.4 rows `in_progress`/`completed`: "derived on read from `LabPort.getOrderItemProcessingState`: `in_progress` iff any active item is `in_progress`/`reported`; `completed` iff every active item is `reported` or `cancelled` and ≥ 1 is `reported`" (the view text is deleted).
- 03-IC §3.2 trigger: "C4 may remove an item only when `getOrderItemProcessingState` returns `removable: true`".
- New contract cases: (31) item whose only specimen is rejected without recollection → `removable: true`, `processingStatus: 'cancelled'`; (32) all items reported → `reported`.
Files: 03-IC §3.2, §4.5, §10.4; C4 TRD §6.1/§6.4, AF O5, PRD US-FD-10 AC3; C5 TRD §3.3/§4.7/§6.1, AF E19.

**D-6 — Recollection requested after the rejection event.** Refs: C5 #12. Decision (least surface, no new event): 03-IC §3.7 consumers += "C4 (only `to_status = recollection_ordered`)". C4's handler upserts the `frontdesk.order_flags` row `kind = 'recollection_required'` for the old `specimen_id`. The existing unique index `order_flags__tenant_id_kind_specimen__p_uq` deduplicates it with the `lab.specimen.rejected.v1` path. C5 AC-05.5 is kept (no second `rejected` event). Files: 03-IC §3.7, §3.25; 01-CM §5.1; C4 TRD §8.2.

**D-7 — A1 `submitModuleResult` versioning.** Refs: C5 #9. Decision: change 03-IC to fit C5's model.
- §4.5 semantics, first sentence (replaces it): "Creates/updates the `lab.results` row for the order item with `origin: 'module'`; that row holds `payloadRef` and `summaryText`. `result_versions` rows are created only at approval (R6) and amendment (R7). A submission on a `verified` result performs a system R5 (`reason_code = module_resubmitted`) followed by R3, in one transaction."
- Line `readonly versionNo: number;` comment → `// results.current_version_no after the call (1 until first approval; n+1 for an amendment)`.
- §10.2 R5 actor += "system (A1 resubmission)".
- C5 seeds `module_resubmitted` in `lab.g_cs_return_reasons`.
- Contract cases (33) resubmission on `verified` → `resulted`, verification cleared; (34) `versionNo` = 1 before approval, n+1 after amendment.
Files: 03-IC §4.5, §10.2; C5 TRD §6.1, SCH seeds; C10/C11 fakes.

**D-8 — Barcode sequence width.** Refs: C5 #6. Decision: the client format wins (00 §4 `E1100001677` = prefix + yy + **8** digits). Default pattern `{prefix}{yy}{seq:8}` in 03-IC §9.3, 08 §4.5 and the C2 numbering default. Example `E2600000042` is now correct. Files: 03-IC §9.3, 08 §4.5, C2 SCH default, C5 PRD AC-01.3, UI mock, SCH §9 seed.

**D-9 — Ordinal value codes on the port.** Refs: C5 #18. Decision: in 03-IC §4.2 `AnalyteDefinition`, add
`readonly ordinalSetValues?: readonly { readonly code: string; readonly display: string; readonly sortOrder: number }[]; // active values of ordinalSetCode, sortOrder asc; present iff ordinalSetCode is set`.
C3 fills it from `g_value_set_values` / `cs_value_set_values` (codes `^[A-Z0-9_+\-]{1,16}$`). C5 validates entries against it and flags `A` via the existing `ReferenceRangeMatch.normalCodes`. C3 contract case: "analyte with ordinalSetCode → ordinalSetValues equals the active set". Files: 03-IC §4.2, C3 TRD §6.1, C5 TRD §4.3, PRD AC-08.6.

**D-10 — `InstrumentResultInput` = the payload, camelCased, field for field.** Refs: C7 #9, C5 m#31 (same seam). Decision: in 03-IC §4.5 add `agentId: Uuidv7`, `protocol: 'astm'|'hl7v2'|'file_drop'`, `mappingStatus: 'mapped'|'unmapped'`, `unitRaw?: string`, `instrumentClockOffsetSeconds?: number`, `capturedAt?: IsoUtc`, `processingKind?: 'live'|'reprocess'|'rematch'`, `sourceRecordId?: Uuidv7`, `organism?`/`ast?` (shapes as §3.14). Change `instrumentFlags` → `instrumentFlags?` (absent = `[]`) and `isRerun` → `isRerun?: boolean` (absent = `false`). `attachment?` is unchanged (port only). C7 TRD §6.7 then states "1:1 camelCase", and C5's port path runs unit conversion from `unitRaw`. Files: 03-IC §4.5, C5 TRD §4.5, C7 TRD §6.7.

**D-11 — C5 access-log codes.** Refs: C5 #1 (P-3). Add to 03-IC §13.1 / 08 §4.4 / C0 seed:
```yaml
# C5 (triage batch 1)
- specimen_label.print        # per specimen, #14
- lab_result.view             # order results grid
- lab_result_history.view     # history + trend (#26)
- critical_value.view
- worksheet.print
- ingest_exception.view       # exception detail (raw values)
```
C5 TRD §11, SEC §1 and S-10 name exactly these.

**D-12 — Result rows after recollection.** Refs: C5 #3. Decision: new rows; no re-pointing of results (that would need a `resulted → pending` transition, which does not exist). Replace `results__test_analyte__uq` with `CREATE UNIQUE INDEX results__tenant_id_test_analyte__p_uq ON lab.results (tenant_id, order_test_id, analyte_id) WHERE status <> 'cancelled';`. Recollection inserts new `pending` rows (R1). Old rows stay `cancelled` with `cancel_reason = 'specimen_rejected'`. This is consistent with 03-IC §10.1 S12 ("tests re-pointed"). C5 only.

**D-13 — Centre scope of hub-lab users.** Refs: C5 #14. Decision, in two parts:
- (1) Data rule (C5 SCH §1, TRD): recollection and aliquot specimens copy `processing_centre_id`/`processing_branch_id` from the rejected or parent specimen. Existing-material order tests and results copy them from the order's received specimen.
- (2) Binding provisioning rule (C5 SCH §1 + C2 TRD invite/role screens, warning text [CONV]): "memberships holding `lab.specimen.receive` or any `lab.result.*` permission need `all_centres = true` or membership of every collection centre whose samples they process; before receipt only `centre_id` matches."
- Probe: a hub user without the centre cannot see the specimen (expected, documented).
Files: C5 SCH/TRD, C2 TRD (note only).

**D-14 — Instrument display names in C5 screens.** Refs: C5 m#29. Decision (R25 kept; same pattern as comment codes, CR-C5-001): the C5 BFF reads C7 `GET /v1/instruments/instruments` (E23). 03-IC §11 `instruments.instrument.read` roles += `pathologist`. On 403 the screen shows `IdText`. No view consumer and no port. Files: 03-IC §11, C5 UI §3.4/§3.10/§3.15.

**D-15 — Discarding the rejected tube.** Refs: C5 m#38. 03-IC §10.1 S14 From = `stored` / `reported` / `rejected` / `recollection_ordered`. Files: 03-IC §10.1, C5 AF §1.1.

**D-16 — Centre list for C3 price-list screens.** Refs: C3 #3. Decision: one reusable read permission instead of per-module endpoints. Add to 03-IC §11: `- { code: identity.centre.read, privileged: false, roles: [tenant_admin, front_desk, finance, lab_technologist, pathologist, lab_manager, centre_staff, owner_viewer] }   # [CONV] centre directory (P0)`. C2 `listCentres` `x-permission: identity.centre.read`. C3 UI SCR-13/SCR-15 call it via the BFF. Files: 03-IC §11, 08 §4.1, C2 TRD §5.x, C3 UI.

**D-17 — Starter catalog workbooks.** Refs: C3 #4. Decision: use C0 TRD §3.5's existing mechanism ("each feature chunk's domain generator is added by C0 … from that chunk's 05-SCHEMA"). Accept **CR-C3-007** (C3 → C0-0A): `packages/test-fixtures/catalog/starter_catalog_master.xlsx` and `starter_price_list.xlsx`, generated by a script from C3 TRD §8.2 (columns) and SCH §8 (content), every value labelled SYNTHETIC. Files: 08 §3 row, C0 TRD §3.5, C3 PLAN §0.

**D-18 — Clinical catalog changes need clinical sign-off.** Refs: C3 #7 (P-10).
- #34 `publishAnalyteVersion`: `x-permission: catalog.reference_range.publish` (privileged), and the handler also asserts `catalog.test.manage`.
- #102 `commitImport` (`catalog_master`): "+ `catalog.reference_range.publish` when the commit creates or publishes analyte versions, range sets or critical sets".
- 03-IC §11: `catalog.reference_range.publish` comment → "clinical sign-off: analyte versions, ranges, critical limits"; `catalog.instrument_code_map.manage` → `privileged: true` (lab_manager already has `mfa_required: true`).
Files: 03-IC §11, C3 PRD AC-03.x, TRD #34/#102, SEC §3 A1/A4, S-4; C7 UI note (aal2 on map edits).

**D-19 — `catalog.v_pub_price_list_items`.** Refs: C3 m#32. Decision: add `WHERE v.status IN ('published','superseded') AND l.is_active`, and append the column `l.falls_through` (`boolean`, additive). In 03-IC §6.6, column list += `falls_through`; note "inactive lists excluded; consumers apply fall-through to the tenant default list themselves". Files: 03-IC §6.6, C3 SCH §10.4, C13/C16 notes.

**D-20 — "File not ready".** Refs: C3 m#37. Accepted as a reuse of `409 common.version_conflict` with `detail: "file_not_ready"`, on the precedent of 08 A2.10. The UI copy says "Still preparing — try again shortly". C3 TRD #101/#106, UI SCR-18.

**D-21 — One event per catalog import commit.** Refs: C3 m#44. Decision:
- A `catalog_master` / `referrers` / `credit_parties` import commit bumps `catalog_revision` once. It emits one `catalog.changed.v1` with `entity_type: 'catalog_import'` (added to the `x-extensible` enum), `entity_id = import_id`, `change_kind: 'updated'`.
- Every affected `orderables.revision` is stamped with that revision (C3 #9 rule).
- Consumers apply the existing unknown-value rule (invalidate the whole tenant cache).
- A price-list import stays one `price_list` event.
Files: 03-IC §3.19, C3 PRD AC-19.2, TRD §9.1.

**D-22 — Privileged-export rule and P0 data.** Refs: C3 m#49. Text for 02-CV §10.1 bullet "Refunds, …, data export, …": "data export of personal (P1–P3) or financial data". Exports holding only P0 master data (C3 `catalog_master`) are not privileged. C3 SEC REQ-SEC-100 row states it.

**D-23 — Numbering under branch-scoped invoice series.** Refs: C4 #13 (B6 stays BLOCKED; default tenant scope unchanged).
- (1) C4 grammar, which C2 applies: `registrationNoPattern` must contain `{branch}` (its counter is tenant + branch, 03-IC §9.3).
- (2) B32 rejects `invoice_series_scope = branch` unless `invoiceNoPattern` contains `{branch}` → `400 common.validation_failed`, path `/invoice_series_scope`.
- (3) If the pattern later loses `{branch}` while scope = branch: at allocation → `409 billing.numbering_pattern_invalid` (new, owner C4, title "Invoice pattern lacks {branch} for branch series"), no invoice issued, alert.
Files: 03-IC §8, 08 §4.2, C4 TRD §11.2/§12, C2 TRD (grammar note).

**D-24 — Refunds need two people (08 R15 is binding).** Refs: C4 #16. Decision, mirroring C15 P8/P9:
- 03-IC §11 += `- { code: billing.refund.request, privileged: true, roles: [finance] }`. `billing.refund.approve` is unchanged.
- C4 B10 becomes `requestRefund` POST `/v1/billing/orders/{order_id}/refund-requests` (`billing.refund.request`, Idem R, body `{method_code, refund_amount_paisa, reason_code, reason_text?, reference?}` → `201 RefundRequestDto`, status `pending`).
- B10a `approveRefund` POST `/v1/billing/refund-requests/{refund_request_id}/approve` (If-Match, `billing.refund.approve`, Idem R): writes the refund ledger entry.
- B10b `rejectRefund`.
- Approver = requester → `403 billing.refund_self_approval_forbidden` (new, owner C4). Above refundable → existing `billing.ledger_reversal_invalid`.
- New C4 table `billing.refund_requests`.
Files: 03-IC §8/§11, 08 §4.1/§4.2, C4 PRD/TRD/AF §2.12/SCH/SEC REQ-SEC-055.

**D-25 — Fiscal-year retry across the port.** Refs: C4 #18. Decision:
- Billing maps `RetryFiscalYear` to the already-declared `billing.counter_busy` with `detail: "fiscal_year_rollover"`.
- 03-IC §8 meaning → "Counter row lock timeout or FY rollover during allocation; retry".
- C4 TRD: "frontdesk registration/confirmation retries the whole transaction once on `billing.counter_busy` and SQLSTATE 40P01".
Files: 03-IC §8, C4 TRD §6.3/§12.

**D-26 — Branding assets for invoices.** Refs: C4 #19. In 03-IC §4.6, the `readBrandingAsset` JSDoc (replaces "Same caller rule"): "Callers: any `user` or `system` actor of the tenant. Returns only branding assets (kinds `logo`, `letterhead_header`, `letterhead_footer`); signature images are never returned here and stay behind `getSignatories` (system actor holding `identity.signatory.read`). @throws common.not_found". No new permission. Files: 03-IC §4.6, C2 TRD §6, C4 TRD.

**D-27 — Anonymisation completeness.** Refs: C4 #23.
- (a) The `frontdesk.patients` audit trigger passes the excluded columns `full_name, name_search, birth_on, phone_e164, email, address_text` (existing CR-C15-013 mechanism). Compensating control: every demographic change writes access-log `patient.update` with `detail.changed_fields` (names only). Trade-off: `audit_log` no longer holds old/new demographic values; this is accepted for REQ-SEC-139.
- (b) Delete TRF objects under P-12(c) (retention has already elapsed, per the US-FD-16 guard).
Files: C4 SCH trigger list, TRD, AF §2.18; C0 trigger inventory.

**D-28 — `tenant_admin` read grants.** Refs: C4 #24. 03-IC §11: `frontdesk.patient.read` roles += `tenant_admin`; `frontdesk.order.read` roles += `tenant_admin`. This matches its existing merge, cancel and anonymise grants.

**D-29 — Staff links in C8 scheduled e-mails.** Refs: C6 #1. Text for 03-IC §4.8 semantics (append): "Param kind `staff_url`: an absolute URL with origin `LIMS_ORIGIN_STAFF_WEB` whose path matches a `staff_web` route of `contracts/routes.yaml`. Allowed only for purpose `scheduled_report_ready` to a `staff` recipient. `analytics.report_ready` validates `linkUrl` as `staff_url`." C8 builds the URL with `@lims/shared-ts/routes` for `staff.analytics.report_run`. Files: 03-IC §4.8, C6 TRD §7.2/SCH §8/UI §7, C8 AF l.184.

**D-30 — `redeemPortalLinkForApp` DEFINER.** Refs: C6 #3. Add to 03-IC §13.3 / 08 §4.7:
`app.reporting_redeem_link_for_app(p_token_sha256 bytea, p_phone_sha256 bytea) RETURNS TABLE (tenant_id uuid, patient_id uuid, report_id uuid, version_no integer, released_at timestamptz)` — owner `lims_reporting_lookup`, EXECUTE `lims_api`, `SET search_path = ''`.
- Returns a row only when the link is valid, has recipient `patient` and channel `sms`|`whatsapp`, and `coalesce(portal_links.destination_sha256, delivery destination) = p_phone_sha256` (bytea = bytea).
- A mismatch increments `portal_links.redeem_failures smallint NOT NULL DEFAULT 0 CHECK (redeem_failures BETWEEN 0 AND 5)` (mutable column). At ≥ 5 it returns nothing.
- Per A10.5 it needs `portal_links__select__owner_only` / `__update__owner_only TO lims_owner`-equivalent policies for `lims_reporting_lookup`, `USING (token_sha256 = <transaction-local GUC set inside the function>)`.
- Probe: 5 wrong phones → the 6th, correct phone fails.
Files: 03-IC §13.3, 08 §4.7, C6 SCH §6/§2, TRD §7.1.

**D-31 — OTP destination for links with no stored destination.** Refs: C6 #4, C6 m#41. Decision:
- The OTP goes to (a) the link's `destination_sha256` when the link was sent to a known destination, else (b) **the patient's phone on file**, resolved by the `reporting.send_portal_otp` worker (system actor, `FrontdeskPort.getPatientDemographics({purpose:'notification'})`). This applies to `patient_app`, `print_qr` and C13 partner access slips alike.
- P1 inserts `otp_challenges` with `destination_sha256 NULL` and status `pending_send` (CHECK `status = 'pending_send' OR destination_sha256 IS NOT NULL`) and returns `202 {challenge_id}` with no mask (UI copy "Code sent to the mobile number registered with the lab").
- P1 rate key is `otp:l:<link_id>`; the worker applies the per-destination key `otp:p:<hex>` once.
- No phone on file → challenge `failed` (`no_contact`), with no oracle in the response.
- A rate-limited send → challenge `superseded`, metric `otp_send_rate_limited`.
C6 only (SCH §2.6, TRD §6.6/§9, AF §1.6).

**D-32 — Client IP for portal-originated limits.** Refs: C6 #7. Decision (reuses the R6/A1 placement rule; no HMAC header):
- `apps/portal` calls the API on the internal network with `X-Lims-Bff-Key` of new kind `portal` [CONV] and forwards `X-Forwarded-For` as received from the public nginx (which overwrites it).
- The core sets `app.client_ip` from that header only on requests with a valid BFF key; otherwise it uses the peer address.
- Tiers `qr_verify`, `otp_request` and `otp_verify` key on `app.client_ip`.
- The nginx `limit_req` 10 r/m/IP applies only to public `/v/*` on the portal origin, not to `/v1/reporting/verifications`.
Files: 08 R10 table (BFF key kinds), C0 TRD §5/§6.5, C1 TRD §6.6 + secret store, C6 TRD CR-C6-013/§6.7.

**D-33 — Report kind after Regenerate.** Refs: C6 #10. Amend the 08 R1 rule list by adding first: "(0) a version produced by Regenerate (R9) after an earlier version was released → `amended`, except reason `smart_summary_added`, which takes the kind from rules 1–4; the regeneration reason text goes into `amendmentNotes`." Files: 08 R1, C6 TRD §4.5/R9, AF E8.

**D-34 — C17 `visit_assigned` template.** Refs: C6 #18. Seed `homecollection.visit_assigned` (purpose `visit_assignment`, channel `sms`, params `route_date` and `visit_count`, both kind `short_text`, so no new kinds). Staff recipients stay `suppressed_no_contact` in Phase 1 (contract case 11), so C17 gets no error. Files: 03-IC §4.8 template list, 08 §4.10, C6 SCH §8/UI §7, C17 TRD note.

**D-35 — Critical-value alert link.** Refs: C6 m#23. 03-IC §4.8 PHI rule → "`critical_value_alert` to clinicians: message says 'critical result — call the lab'; no value, no link [CONV]" (no released report may exist yet).

**D-36 — `centre_correction`.** Refs: C6 m#37. C4 has no centre-change operation. Remove `centre_correction` from `regeneration_reasons` (C6 SCH §8, UI §2.2); `reports.centre_id` stays immutable.

**D-37 — Draft printing.** Refs: C6 m#40. No role grant (least privilege). AC-12.3 → "staff holding both `reporting.report.print` and `reporting.report.release`".

**D-38 — Phlebotomy app links.** Refs: C6-L14. The portal `/.well-known` association files cover both `patient_app` and `phlebo_app` (03-IC §7 `base_origin: portal`). C17 supplies the phlebo app ids and fingerprints (client-owned, 08 §5.0) as content input, like C16 (CR-C16-010). 08 R14 tree note "content inputs from C16" → "from C16 and C17". Files: 08 R14, C6 TRD §3, C17 TRD.

**D-39 — Code-map panel for read-only users.** Refs: C7 #16. No C3 change. Without `catalog.instrument_code_map.manage` the panel is hidden, with the text "Mappings are visible to users who can manage them". C7 AC-17.4, SCR-08.

**D-40 — Instrument graphs (client baseline 00 §3 item 3).** Refs: C7 #17. Not dropped (00 is top precedence). **Founder confirmation required.** Default to build: new C7 IS-27 "histogram/scattergram payloads from a `verified` driver (B2) are stored as `attachment`-kind records (PNG if sent as image, otherwise raw) and shown in the C7 message viewer". Printing on reports is a later C6 CR once a driver is verified. Files: C7 PRD §4.2/IS-27, 07-BLOCKERS B2 note.

**D-41 — ASTM timer defaults.** Refs: C7 m#29. Relabel them `[CONV]` configurable defaults with the vendor document as reference only, and fix the document id (AF vs AE). No 04 row. C7 TRD header/§5.2.4.

**D-42 — Raw-archive retention source.** Refs: C7 m#30. Single source (R18 pattern): C7 drops `settings.archive_retention_days` and uses `TenantSettings.retention.rawInstrumentYears` (C2, default 1, floor 1 = 04 I8). `instruments.purge_archive` runs `per_tenant` (P-6), reads the value via IdentityPort, and calls `app.purge_instruments_archive(p_raw_retention_days integer)` (≥ 365; signature changed in the 03-IC §13.3 / 08 §4.7 row). 07-BLOCKERS B15 "Affects" += C7 with "raw analyser archive = `retention.rawInstrumentYears`". Files: 07-BLOCKERS, 03-IC §13.3, C7 PRD IS-13, TRD §10/§11, SCH.

**D-43 — Edge limit on agent paths.** Refs: C7 m#37. CR-C7-012 nginx `/v1/instruments/agent/` → flood guard 600 r/m/IP, burst 200 [CONV] (shared NAT, A1 rationale). The per-device app tier `ingest` (04 §4) is the real limit. Files: C7 TRD CR-C7-012, C1 TRD.

---

## (c) Per-chunk LOCAL fix list

Verified LOCAL items show their finding number. Items covered by a P-rule or D are marked. Minors not on a lead list are listed as reported (not re-verified).

**C3** — LOCAL (verified): #1 (P-1), #2 (also add #3 to T-12 per m#31), #5 (also apply the overlap check to surcharge rules), #9, #46 (P-8: mark creates `R`). Cross/decision items: #3 D-16, #4 D-17, #6 P-6, #7 D-18, #8 P-9, #10 P-10 (delete both extension names; hand-written tests in T-36), m#32 D-19, m#37 D-20, m#43 P-11, m#44 D-21, m#49 D-22.
Minors (as reported): 11–31, 33–36, 38–42, 45, 47, 48. Program-doc owners: m#23 (03-IC JSDoc — map to listed codes), m#36 (03-IC `catalog.import_invalid` retire), m#41 (01-CM), m#42 (02-CV §10.2 carve-out). m#40 follows P-15.

**C4** — LOCAL (verified): #2 (P-2: F21 → `GET /v1/frontdesk/trf-attachments/{attachment_id}/content`, access `trf.view`; B29 → `GET /v1/billing/exports/{export_id}/content`, access `data.export`; drop both URL TTL vars), #3, #4, #5, #6, #7, #8 (P-9), #9, #10, #11, #14, #15, #17, #20, #25, #26. Cross/decision items: #1 D-1, #12 P-7, #13 D-23, #16 D-24, #18 D-25, #19 D-26, #21 D-4, #22 D-5, #23 D-27, #24 D-28.
Minors (as reported): 27–47. m#32: the DEFINER `frontdesk.purge_trf_drafts` also needs an owner_only DELETE policy on `trf_attachments` (08 A10.5) and a §13.3 inventory row. m#35 follows P-15. m#44: CR-C15-002 is already accepted (stale row).

**C5** — LOCAL (verified): #2 (`qc_results` needs its own policy set on `centre_id`; manual-capture values per reviewer), #4 (P-4), #7, #10, #15 (make `collection_mode` nullable; `lab_status`), #16 (R22 names), #17, #19, #20 (08 R3). Cross/decision items: #1 D-11, #3 D-12, #5/#11 D-4, #6 D-8, #8 D-2, #9 D-7, #12 D-6, #13 D-5, #14 D-13, #18 D-9, m#29 D-14, m#38 D-15.
Minors (as reported): 21 (P-1), 22–28, 30, 32–37, 39–46. m#31 is absorbed by D-10. m#44 follows P-8. m#41 follows P-14. m#18 default regex: see (d).

**C6** — LOCAL (verified): #5, #6, #8 (add `identity.signatory.read` to PRD §2 and TRD §9), #9, #11, #12, #13, #14, #15, #16, #17 (P-8 E1: Idem none + If-Match), #19. Cross/decision items: #1 D-29, #2 D-3, #3 D-30, #4 D-31, #7 D-32, #10 D-33, #18 D-34, m#23 D-35, m#26 P-8 E2, m#37 D-36, m#38 P-13 (plus instrument PDFs through `/internal/sanitize`), m#40 D-37, L14 D-38.
Minors (as reported): 20–22, 24 (P-10), 25, 27–36, 39, 41 (absorbed by D-31), 42, 43. New per 08 A11.1: C6 adds the portal dues-payment spec (`reporting.portal_payment_requests`, worker job, route `/r/payments/{id}/done`). That is outside this triage; flagged for the C6 fix pass.

**C7** — LOCAL (verified): #1 (write full `__select__owner_only` / `__delete__owner_only` policies `USING (current_setting('app.instruments_purge', true) = 'on')` per 08 A10.5, plus a FORCE-RLS DB test), #2 (P-2: `GET /v1/instruments/messages/{instrument_message_id}/attachment/content`), #3, #4, #5, #6, #7, #8, #10, #11, #12 (P-8: `required`), #15. Cross/decision items: #9 D-10, #13 P-14 (CR-C7-013 to C0-0A), #14 P-12, #16 D-39, #17 D-40, m#29 D-41, m#30 D-42, m#37 D-43.
Minors (as reported): 18–28, 31–36, 38, 39. m#36 is consistent with P-2/R12b (`ctx.uploads.accept` only, re-encode on).

---

## (d) FALSE / ALREADY-FIXED findings

No verified finding is FALSE or ALREADY-FIXED. Corrections to reviewers' *proposed fixes* (the findings themselves stand):
- **C5 #18** — the proposed interim code regex `^[a-z0-9_+\-]{1,64}$` is wrong. C3 value-set codes are `^[A-Z0-9_+\-]{1,16}$` (C3 SCH `g_value_set_values__code__ck`). Superseded by D-9.
- **C4 #2 / C7 #2** — the reviewers cite only 03-IC §13.6. 02-CV §10.2 "Serving uploads" still permits "Storage signed URL", which is the lower-precedence source of the conflict. Fixed by P-2.
- **C3 #6** — the proposed fix "declare `per_tenant`" does not work alone: C0 does not yet define `per_tenant` cron fan-out (C0 TRD §7.2/§7.6), and no worker-callable tenant list exists. Hence P-6.
- **C6 #7** — the proposed HMAC client-IP header adds a new secret. D-32 reuses the existing BFF-key and `X-Forwarded-For` trust path instead.
- **C6 #18** — new param kinds `date`/`count` are unnecessary; the existing `short_text` covers both values (D-34).
- **C7 #1** — no longer an open program question: 08 A10.5 now makes owner_only policies mandatory. The C7 document is still unfixed, so it stays CONFIRMED/LOCAL.
