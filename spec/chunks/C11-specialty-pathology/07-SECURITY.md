# C11 Specialty Pathology — 07 Security

Status: DECISION, 2026-11-06. Phase 2 module; REQ-SEC §1, §3, §4, §6, §7 apply (04 §12 rule). Mobile (§5) and gateway (§2) requirements do not apply. Cited, not copied.

---

## 1. Applicable requirements

| REQ | How it applies in C11 | Where implemented / tested |
|---|---|---|
| REQ-SEC-001/002 | ASVS L2 target; BOLA is the primary threat for every case/part/block/slide/image/template id | handlers load via RLS repo first; probes (§5) |
| REQ-SEC-004 | column classification in 05-SCHEMA §3 feeds the data inventory | `db/meta/tables.yaml` (C0) |
| REQ-SEC-006 | anatomic content leaves the module only through C5/C6 release paths (A1 + view); C11 has no export, no delivery | design; no export endpoint |
| REQ-SEC-007 | images and content stay in the Nepal-hosted DB/Storage; no foreign service | 04 §11; dependency table (none added) |
| REQ-SEC-011/012/014/015/016 | ENABLE+FORCE RLS on every anatomic table (`event_inbox` by C0), per-command policies `TO lims_app`, no DELETE policy, no `USING (true)`; every `__tenant` policy carries `(SELECT app.is_staff_or_system())` (08 A17 P-16); centre predicate cast `::uuid[]` (08 A16.1) | 05-SCHEMA §7; `db/tests` |
| REQ-SEC-013/067 | tenant/centre only from verified claims; worker tenant from the event envelope | C0 core; consumer test |
| REQ-SEC-017 | centre scoping on every case-derived table via `centre_id` | 05-SCHEMA §1, §7; probes |
| REQ-SEC-019/020/021 | guard trigger functions are SECURITY INVOKER with `SET search_path = ''`; no DEFINER added | 05-SCHEMA §6 |
| REQ-SEC-022/023/024 | `(SELECT …)` helper wrapping; `tenant_id` leads every index; explicit tenant filter in repos | 05-SCHEMA; repo lint |
| REQ-SEC-025 | list/detail queries included in the RLS load test at 10× seed | T-26 |
| REQ-SEC-026 | composite `(tenant_id, …)` FKs; extra `(tenant_id, case_id, centre_id)` FK keeps denormalised centre consistent | 05-SCHEMA §6; FK probes |
| REQ-SEC-027/028 | `tenant_id NOT NULL` no default; UUIDv7 ids; accession/labels never in URLs | 05-SCHEMA; 02-TRD §5 (lookup by body) |
| REQ-SEC-031 | `v_pub_report_content` `security_invoker = true` | 05-SCHEMA §8 |
| REQ-SEC-034/035 | private bucket `anatomic-images`, tenant-prefixed paths; no signed URLs handed to browsers (content streamed through API/BFF) | 05-SCHEMA §9; CR-C11-008; all Storage access server-side via `ctx.storage`, end-user `storage.objects` policies only after SP-4 (08 R12b) |
| REQ-SEC-039 | `lims_app` gets only SELECT/INSERT(/UPDATE) per class; no DELETE | 05-SCHEMA §7; grant assertions |
| REQ-SEC-040/041/042/044 | cross-tenant/centre probes for every operation and table; mixed-tenant bulk arrays; id-in-body vs path | §5 |
| REQ-SEC-045/133 | alerts: lookup not-found bursts per user, quarantine spikes, submit failures | 02-TRD §12 |
| REQ-SEC-062/067 | `anatomic.case.signout`, `anatomic.config.manage` privileged → membership re-validation + aal2 | IdentityPort; tests §5.3 |
| REQ-SEC-080 | strict spec validation, `additionalProperties: false`, maxLength on every string, enumerations | `anatomic.yaml` lint |
| REQ-SEC-081 | mappers with explicit field lists; patient fields only with `frontdesk.patient.read`; lab status only with `lab.result.read` | `mappers/`; mapper tests |
| REQ-SEC-082 | parameterised SQL; `ILIKE` escaping for diagnosis search `q` and assignee `q` | repo tests with `%`/`_` input |
| REQ-SEC-083/084/085 | PNG/JPEG only (`x-upload`), magic bytes, ≤15 MB, scan + quarantine (08 A17 P-19: `infected` → quarantined; `pending`/`unavailable` → re-scan job), re-encode with metadata strip. Served only through the API stream helper; not `clean` → `422 common.upload_quarantined`. **REQ-SEC-085 narrowed (08 A17 D-67, recorded by the lead as an accepted risk):** a server re-encoded `image/png`/`image/jpeg` object may be streamed with `Content-Disposition: inline` through the BFF on the staff origin for `<img>` display, with `Content-Type` = stored mime (never client-supplied), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: no-store`, and an access-log row on every call. No other C11 file is served inline; nothing is served from a separate file origin | 02-TRD §4.9, I2; tests AC-12.x, §5.5 |
| REQ-SEC-088 | plain-text fields only (no HTML); React text nodes; synoptic labels/options rendered as text | 02-TRD §4.6; lint |
| REQ-SEC-091/092 | state changes via POST/PUT only, BFF Origin checks (C0) | C0 core |
| REQ-SEC-095 | problem details without PHI (no accession numbers or texts in `detail`) | error tests |
| REQ-SEC-096/097 | data changes audited by `tg_row_audit`; view/print/lookup/sign-out access logged with exactly the registered codes `anatomic_case.view`, `anatomic_report.view`, `anatomic_image.view`, `anatomic_label.print`, `anatomic_object.lookup`, `anatomic_report.sign_out` (08 A17 D-53; 02-TRD §12) | access-log tests; CI literal check (08 A13 P-3) |
| REQ-SEC-098 | no accession numbers, labels, texts, captions, diagnosis codes or patient data in logs/URLs/metrics | log-scan test (T-24) |
| REQ-SEC-099 | every route in `anatomic.yaml` with `x-permission`; no public routes | spec lint |
| REQ-SEC-100 | bulk endpoints capped at 200 ids; label printing capped at 200 per call; access-logged | 02-TRD §5 |
| REQ-SEC-128 | no secrets used by C11 itself (storage credentials live in C0 adapter config) | gitleaks |
| REQ-SEC-136 | synthetic data only; no real images ever in fixtures (generated synthetic images, e.g. solid-colour PNGs) | fixtures review |
| REQ-SEC-139 | no delete paths; retention per tenant setting (B15) | 05-SCHEMA §10 |

## 2. Assets

| Asset | Class | Notes |
|---|---|---|
| Case content: clinical history, gross, microscopy, impression, comments, addenda, synoptic values, diagnosis codes, molecular results | P3 | Privacy Act sensitive health data (04 L17) |
| Images (gross/microscopy photos) and captions | P3 | may show identifying features or labels written on containers; captions free text |
| Accession numbers, block/slide labels | P2 | lab-linked identifiers (02-CV §9.2) |
| Signed report versions + item submissions | P3, integrity-critical | basis of released reports; amendment trail |
| Synoptic templates, text templates, coded lists | P0, integrity-relevant | wrong templates corrupt reports |
| Sign-out privilege | control | only pathologists at aal2 |

## 3. Threat model (STRIDE per entry point)

| Entry point / asset | S | T | R | I | D | E |
|---|---|---|---|---|---|---|
| `GET /cases`, `/cases/{id}`, lookup | stolen staff session → mitigated by BFF cookie rules (C0/C2), idle timeout (04 A8) | — | access_log on detail/lookup | enumeration of accession/labels via lookup → rate limit `general`, not-found burst alert, identical 404 for other tenant/centre | large list queries → `limit ≤200`, indexes | centre-scoped user reading other centre → RLS + probes |
| Sign-out / changes / addenda sign | replayed request → Idempotency-Key + draft version | content altered after sign → insert-only versions, guard triggers | signer membership + time stored in version; `tg_row_audit`; C5 records actor | — | — | technologist signing out → privileged permission + aal2; amendment without `lab.result.amend` blocked by C5 |
| Draft/gross/molecular saves | — | lost update → `If-Match` | audit trigger old/new | PHI in problem `detail` → generic messages | oversized text → maxLength + DB CHECKs | editing after sign-out → `signout_locked` per 08 A17 D-66 + DB guards |
| Image upload/content | malicious file disguised as image → magic bytes + re-encode + scan (re-scan while pending) | object overwrite → write-once paths, random ids | uploader in `created_by`; `anatomic_image.view` on every content call | metadata (EXIF GPS) leak → re-encode strips; filename discarded; content not cacheable; inline display limited to re-encoded rasters with `nosniff` + CSP sandbox (D-67) | decompression bomb / huge files → 15 MB + megapixel cap; per-case image limit | path traversal → server-built path, CHECK `images__path__ck` |
| Labels page | — | — | access_log `anatomic_label.print` | bulk label harvesting → ≤200 per call, logged, no patient data on labels | — | — |
| Templates/config | — | malicious template with script → plain text rendering only, definition schema validated, size cap 256 KiB | audit trigger | — | huge definitions → limits | non-admin editing → `anatomic.config.manage` privileged |
| Consumer `lab.specimen.status_changed.v1` | forged event → only the worker core enqueues `evt.*` tasks from `core.event_log` (C0); tenant from envelope written under RLS | duplicate/stale → inbox + seq | event ids recorded | — | event flood → idempotent, cheap no-op path | — |
| View `v_pub_report_content` | — | — | — | over-broad read → security_invoker RLS; only C6/C14 query it (CI grep rule 02-CV §5.13) | — | — |
| Storage bucket | — | — | — | cross-tenant object read → adapter enforces tenant prefix; Storage policy only after SP-4 | — | — |

## 4. Abuse cases (each has a test in §5)

1. AB-1: Tenant A pathologist calls `GET /v1/anatomic/images/{tenant_b_image}/content` → `404 common.not_found`, no bytes.
2. AB-2: Centre-A1 user looks up a label of a centre-A2 case → `404`.
3. AB-3: Bulk `markAnatomicSlidesReady` with 199 own ids + 1 tenant-B id → B id `not_found`, own ids processed, B slide unchanged.
4. AB-4: Technologist (no `anatomic.case.signout`) posts sign-out → `403 auth.forbidden`; pathologist at aal1 → `403 auth.mfa_required`.
5. AB-5: Body tries to set `tenant_id`, `status`, `accession_no`, `signed_by_membership_id` → `400 common.validation_failed` (`common.unknown_field`).
6. AB-6: Upload of an SVG with `image/png` content type → `415`; JPEG with EXIF GPS → stored object has no EXIF.
7. AB-7: Caption containing `<script>` → stored as text, rendered escaped; never interpreted.
8. AB-8: Synoptic option display `"><img src=x onerror=…>` → rendered as text in editor, preview and report snapshot.
9. AB-9: Replay of a sign-out with a modified body and the same Idempotency-Key → `422 common.idempotency_key_reused`.
10. AB-10: Attempt to edit a signed addendum or published template via direct SQL as `lims_app` → `immutable_row`.
11. AB-11: Script iterates `lookupAnatomicObject` over guessed labels → rate limit 10 req/s/user; not-found burst alert after 50/min.
12. AB-12: `startAnatomicCaseChange` on another tenant's case → `404`; on an approved result by a pathologist without `lab.result.amend` (custom role) → sign-out rolls back with `lab.result_locked`.

## 5. Required security tests

### 5.1 Cross-tenant probes (every operation)

Generator-driven for all operationIds in 02-TRD §5 (A1–A12, M1–M15, R1–R10, I1–I4, Q1–Q7, K1–K22) plus hand-written:
- path ids of tenant B for every `{case_id}`, `{part_id}`, `{slide_id}`, `{block_id}`, `{stain_order_id}`, `{addendum_id}`, `{image_id}`, `{batch_id}`, `{template_id}`, `{stain_id}`, `{assay_id}`, `{text_template_id}`, `{test_id}` (test profile of B), `{code}` (coded value of B) → `404 common.not_found`, no side effect (DB check as owner);
- body ids of tenant B: `part_id`, `block_id`, `specimen_id`, `addon_order_item_id`, `order_item_id`, `stain_order_ids`, `image_ids`, `template_id`, `case_id` (batch members), `addon_case_item_id`, `assigned_pathologist_membership_id` → `404` or `400` per spec, never cross-linking (composite FKs as second line);
- bulk arrays mixing A and B ids (M3, M11, Q5, Q6) → per-id `not_found`;
- list endpoints with B data present → zero B rows (A1, M6, M12, Q2, K3, K6, K8, K11, K13, K20);
- lookup with B labels/accession → `404`.

### 5.2 Cross-centre probes

User with centres {A1} only: every case-scoped operation against an A2 case → `404`; lists exclude A2; batch detail shows A2 members as "Restricted" without accession numbers. Hub user with `all_centres` → sees both (08 A13 D-13(2) provisioning rule, 05-SCHEMA §1). A12 with a `case_id` of A2 → `404`.

Actor-type probe (08 A17 P-16): partner, portal and patient claims of the same tenant read 0 rows from every anatomic table and from `anatomic.v_pub_report_content`.

### 5.3 Privilege tests

- `signOutAnatomicCase`, `startAnatomicCaseChange`, `discardAnatomicCaseChange`, `signAnatomicAddendum`: without permission → 403; aal1 → `auth.mfa_required`; membership revoked after token issue → privileged re-validation fails (IdentityPort contract test 6 pattern).
- All K-ops except reads: `anatomic.config.manage` required; aal2.
- Worker system actor holds only `ModuleManifest.systemPermissions` (`anatomic.case.work`, `frontdesk.order.read`, `catalog.test.read`); it cannot call sign-out logic (service asserts actor type `user` for sign-out — DECISION).
- Signed-out edit matrix (08 A17 D-66): for each operation in 02-TRD §5 "Edits on a `signed_out` case", with and without an open change draft → allowed or `409 anatomic.signout_locked` exactly as listed.
- R4 with a system reason code (`supplementary_report`, `module_phase_progression`, `module_preliminary_update`) → `400 common.validation_failed`.

### 5.4 Table probes (C0 `db/tests`, specified in 05-SCHEMA §11)

All tables: SELECT/INSERT/UPDATE/DELETE cross-tenant; centre probes; immutability; grants (`DELETE` false everywhere); view column list.

### 5.5 Content and upload tests

AB-6/7/8 above; 16 MB → 413; 60 MP synthetic PNG → rejected by pipeline (CR-C11-008); quarantined or still-processing image never served (`422 common.upload_quarantined`); content response headers exactly as 02-TRD I2 (inline, stored mime, `nosniff`, CSP `default-src 'none'; sandbox`, `no-store`) and an `anatomic_image.view` row per call; original filename absent from DB rows, logs and object path (search test).

### 5.6 Logging tests

Log-scan test (05-DoD §1.8): run the e2e scenario with planted values (accession `S26-9999`, caption "Test Patient 0042 left arm", gross text marker `PHI-MARKER-GROSS`, diagnosis code `LOC-0001`) and assert none appear in logs, metrics labels or problem `detail` fields.

## 6. PHI handling rules

1. Logs: ids only (case/part/block/slide/image/template UUIDs). Never accession numbers, labels, texts, captions, codes, assay results, patient names (02-CV §9.2).
2. Metrics labels: `case_kind`, `version_kind`, `outcome`, `reason`, `error_code` only.
3. URLs: no accession/labels/text in paths or query strings; lookup via POST body; `assignees?q=` carries staff names only.
4. Patient demographics are fetched per request through FrontdeskPort (`lab_display`) and never stored in `anatomic` tables or cached.
5. Images: stored only re-encoded; served only through the API stream (inline only under 08 A17 D-67) with `Cache-Control: no-store`; no thumbnails cached in the browser beyond the page.
6. Labels print accession-derived text only; no patient name or registration number.
7. Captions and free text are P3: staff are told in the UI not to type patient identifiers into captions (04-UI-UX §4.2.5); this is guidance, not a control.
8. Problem `detail` strings never include accession numbers, labels, test names or text content.
9. AI tools and fixtures: synthetic data only (02-CV §11.2); real pathology images never enter the repository.

## 7. Secrets used

None owned by C11. The storage adapter and upload pipeline credentials are C0/C1 configuration (REQ-SEC-128). C11 holds no provider keys and uses no `service_role` key (02-CV §10.2 default "not used").
