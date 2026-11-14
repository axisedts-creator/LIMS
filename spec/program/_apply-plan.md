# _apply-plan — edits that make the document set match `08-CR-REGISTER.md`

Status: plan for the apply phase, 2026-11-06. Source of every edit: `program/08-CR-REGISTER.md` (cited as **08 §x / Rn**). Nothing here changes a decision; if an edit below and 08 disagree, 08 wins.

## 0. Rules for the apply phase

1. **Order.** (1) research/04 (three edits, §7) → (2) program/02, 03, 01, 06, 07, 04-CR → (3) chunk documents (§8) → (4) the global mechanical replacements (§9) → (5) the verification greps (§10). Program documents first, so chunk edits can cite final section numbers.
2. **Anchors.** Edits are located by quoted anchor text ("find …"), not by line number. If an anchor is not found exactly, search for the nearest equivalent sentence and record the deviation in the PR description.
3. **Insert, don't re-number.** New 03-IC sections get the next free number (§3.26, §4.15–§4.17, §6.9, §5.3). Existing numbers stay so chunk citations do not break.
4. **Status edits.** Every chunk's `02-TRD.md` "Change requests raised" section gets the generated status table of §8.20 inserted directly under its heading. The CR texts themselves are kept unchanged as history. Where 08 changed the outcome, the chunk's design text is edited as listed in §8.x.
5. **No new decisions.** An editor who finds a further inconsistency files it as a new CR against 08; they do not resolve it inline.

---

## 1. `program/01-CHUNK-MAP.md`

1. **§2 table, C15 row, "Deployables"**: replace `api \`payments\`, worker \`payments\`` with `api \`payments\`, worker \`payments\`, web \`payments\`` (CR-C15-007).
2. **§3 tree**: replace the whole fenced block (from `lims/` to `    └── migration/                    C18`) with the tree in **08 R14**.
3. **§3, below the module→owner table**, insert:
   > Web route groups outside `(staff)`: `apps/web/src/app/(auth)/**` and `(platform)/**` → C2 (incl. their `layout.tsx`); `(display)/**` → C16. Renderer templates: `services/renderer/templates/smart/` → C14, `templates/billing/` → C4, `templates/analytics/` → C8; the rest of `services/renderer/` → C6. CODEOWNERS also maps `docs/manual/<module>/` and `services/worker/src/jobs/<module>/` per this table (CR-C13-001, CR-C16-001). (08 R14)
4. **§4 "May:" list**, replace the bullet "Add dependencies to its own package's `package.json` / `pubspec.yaml` / `go.mod`, subject to the dependency rules in `02-CONVENTIONS.md`." with the text in **08 R14** (last paragraph, CR-C0-002).
5. **§5.1 Events table** — edit consumer cells:
   - `frontdesk.order.cancelled.v1`: `C5, C6, C8` → `C5, C6, C8, C13`
   - `lab.result.approved.v1`: `C6, C8, C14` → `C6, C8, C11, C14`
   - `lab.result.amended.v1`: `C6, C8, C14` → `C6, C8, C11, C14`
   - `catalog.changed.v1`: `C4, C5, C6, C7` → `C4, C5, C6, C7, C13, C16`
   - `engagement.booking.confirmed.v1` meaning: `Booking → pre-registration / home visit` → `Booking → pre-registration (centre_visit, C4) / home visit (home_collection, C17 creates the order — 08 R7)`
   - also apply A2–A5 and A8 (03-IC §5.1 note): `lab.specimen.status_changed.v1` += C9, C10, C11; `lab.result.verified.v1` += C12; `instruments.qc.received.v1` += C12; `reporting.report.released.v1` += C5, C9.
   - append rows: `| \`engagement.booking.cancelled.v1\` | C16 | C4, C17 | Booking cancelled after confirmation (A5) |` and `| \`instruments.calibration.received.v1\` | C7 | C12 | Calibrator record parsed (driver-classified; B2) |`
6. **§5.1 Ports table** — replace cells:
   - CatalogPort consumers += `C13`; methods += `getReferrer`, `getCreditParty`, `resolveCommentCodes`
   - FrontdeskPort methods += `getPatientDemographicsBatch`, `createSelfRegisteredPatient`
   - BillingPort methods += `recordGatewayRefund`; add note "callers staff/system only (08 R8)"
   - LabPort consumers += `C4, C17`; methods += `submitModuleResult`, `getOrderItemProcessingState`, `listPendingForInstrument`, `lookupSpecimens`, `getAnalyteHistory`
   - ReportingPort methods += `openReleasedReportFile`, `redeemPortalLinkForApp`
   - IdentityPort methods += `getSignatories`, `readBrandingAsset`, `provisionPartnerMembership`, `updatePartnerMembership`, `provisionPatientMembership`, `openPatientSession`, `revokePatientSessions`
   - NotificationPort consumers += `C8`
   - PaymentProviderPort methods += `getIntent`, `cancelIntent`
   - append rows: `| \`BillingCommandPort\` | C4 (billing) | C4 (frontdesk only) | per 03-IC §4.15 |`, `| \`RenderPort\` | C6 | C4, C8 | \`renderPdf\` (worker/system only) |`, `| \`EngagementPort\` | C16 | C4, C17 | \`getHomeAddress\`, \`getActiveMembership\` |`
7. **§5 rules, after R5**, insert: "**R6 — Non-staff actors.** Handlers for patient, portal and partner actors use only their own module's tables and the owner-supported actor reads listed in 02-CV §8.5; every other cross-module call on their behalf runs in the module's worker as its system actor (08 R8)."

## 2. `program/02-CONVENTIONS.md`

1. **§3 table**:
   - row "Global (non-tenant) reference table", example: `` `catalog.g_units`, `catalog.g_ast_interpretations` `` → `` `catalog.g_units`, `micro.g_cs_ast_interpretations` `` (CR-C10-009).
   - insert rows after "Published view":
     `| Storage bucket | \`<owner-module>-<purpose>\` (exception: \`reports\`, 04 D15) | \`frontdesk-trf\`, \`micro-imports\` |`
     `| Access-log action code | \`<entity>.<verb>\` (exactly two segments; seeded in \`audit.g_cs_access_actions\`) | \`report.download\`, \`app_link.redeem\` |`
     `| Token hash column | \`<name>_sha256 bytea\`, 32 bytes, \`CHECK (octet_length(...) = 32)\` | \`token_sha256\` |`
   - row "OpenAPI path", append to Convention cell: "Documented exception: \`/v1/core/health/{live,ready}\` (CR-C0-006)."
2. **§4.1**, replace "look them up with a query (`GET /v1/lab/specimens?barcode=E1100001677`)." with "look them up with a body, never a URL (`POST /v1/lab/specimens/lookup` with `{ \"barcode\": \"E1100001677\" }` — REQ-SEC-098, CR-C5-008)."
3. **§4.7**, in the bullet beginning "Never accept `tenant_id`, `created_by`, `price`, `amount_paisa` (for payments)", replace `` `amount_paisa` (for payments) `` with the sentence of **08 R15** (CR-C4-012 + CR-C15-012), keeping the rest of the bullet.
4. **§4.12** (OpenAPI authoring rules), append bullet: "Extensions: `x-context: tenant|platform` (CR-C2-004); `x-edge-exposure: public|internal`, default internal, spec-lint enforced (CR-C1-004); `x-anonymous-tx: true` (module reporting, with `x-public`, CR-C6-001); `x-raw-body: true` (reporting provider callbacks only, ≤ 256 KB); `text/html` responses only for payments operations with `x-public` or `paymentCallbackToken` (CR-C15-004); `x-upload: [<mime>…]` per upload operation (08 R12b)."
5. **§5.2 table**: change the G example `` `catalog.g_cs_ast_interpretations` `` → `` `micro.g_cs_ast_interpretations` ``; insert after row E the class **R** row from **08 R15** (CR-C8-003):
   `| **R — derived rollup** | \`analytics.daily_*\`, \`analytics.tat_facts\` | **never** (delete + insert by refresh) | by the owning module's system actor only | tenant_id, refresh_run_id, refreshed_at; natural composite PK with tenant_id leading; no audit trigger |`
6. **§5.3 Rules**, after "`tenant_id` is the **leading column of every index and every unique constraint** …" append: "Exceptions are listed, with justification, in `db/meta/index-exceptions.yaml` (global unique on a token hash or a one-tenant invariant, used only by inventoried DEFINER functions; 08 §4.7)."
7. **§5.5 table**, row "AST interpretation": append "Owner: C10 (`micro.g_cs_ast_interpretations`), not C3 (CR-C10-009)."
8. **§5.7**, after the trigger example, insert: "`app.tg_row_audit()` takes an optional excluded-column list as trigger argument; columns listed are never copied into `audit_log` (e.g. `payments.merchant_accounts.secret_ciphertext/secret_nonce/secret_auth_tag`, CR-C15-013)."
9. **§5.8 helpers**: replace the `app.has_all_centres()` body's `CASE` with:
   ```sql
     SELECT CASE app.current_actor_type()
       WHEN 'system' THEN app.current_tenant_id() IS NOT NULL
       WHEN 'user'   THEN coalesce((SELECT m.all_centres FROM core.memberships m
                                    WHERE m.tenant_id = app.current_tenant_id()
                                      AND m.id = nullif(app.current_claims() ->> 'membership_id', '')::uuid
                                      AND m.is_active), false)
       ELSE false                                                  -- device, portal, patient, partner (08 R3)
     END
   ```
   and add after the helpers block:
   ```sql
   CREATE FUNCTION app.is_staff_or_system() RETURNS boolean LANGUAGE sql STABLE AS $$
     SELECT coalesce(app.current_actor_type() IN ('user','system','device'), false)
   $$;   -- CR-C13-011: added to every __tenant policy of tables not meant for partner/portal/patient actors
   ```
   Replace "Policy naming: `<table>__<select|insert|update|delete>__<tenant|tenant_centre|owner_only>`." with "Policy naming: `<table>__<command>__<scope>`, scope ∈ `tenant`, `tenant_centre`, `owner_only` (owner-role functions bound to a transaction-local GUC), `lookup` (pre-tenant lookup role bound to the presented token hash), `platform` (`app.is_platform_actor()`), `partner`, `patient` (actor-specific reads)." In the bullet list under "Tenant-only tables …" add: "Every `__tenant` policy also requires `(SELECT app.is_staff_or_system())` unless the table is explicitly shared with partner/portal/patient actors through an actor-specific policy (CR-C13-011)." and "Branch scope is application-level only (IdentityPort `branchIds`); no policy uses branches; P2/P3 data is never protected by branch scope alone (08 R3)." Replace the Storage bullet's last sentence with "Other buckets follow `{tenant_id}/…` as the first segment and are named `<owner-module>-<purpose>` (08 R26); exception: platform-level IRD documents in `identity-assets` under `platform/…`, readable only in platform context."
10. **§5.9 table**: add rows `lims_queue` (NO, NO, owns `graphile_worker` schema + `app.enqueue_job`/`app.queue_depth`; member: `lims_worker`), `lims_monitor` (YES, NO, `pg_monitor`), `lims_replicator` (YES, NO, REPLICATION), `lims_audit_ship` (YES, NO, REPLICATION, publication `lims_audit_ship` insert-only on `audit.audit_log`, `audit.access_log`, `billing.activity_log`), `lims_reporting_lookup` (NO, NO, owns C6 lookup DEFINERs). Replace the CI assertion sentence with: "CI assertion (C0 `db/tests`): no `lims_%` role has `rolsuper` or `rolbypassrls`; `rolreplication` only for `lims_replicator` and `lims_audit_ship`; every tenant table's owner is `lims_owner`." (CR-C1-002, CR-C0-007)
11. **§6** — replace the paragraph "Open item (UNVERIFIED): whether the pinned self-hosted GoTrue supports a server-side custom access-token hook … Either way policies read only `request.jwt.claims`." with:
    > **Claims resolution (binding, 08 R10).** For every GoTrue access JWT the API core verifies the token (step 1) and then calls the identity module's `claimsResolver`, the only source of claims: it maps the JWT's `session_id` + `sub` to the `identity.sessions` row (`app.identity_resolve_session`) and builds the claims JSON. Claims inside the JWT other than `sub`, `session_id`, `aal`, `exp`, `iat` are ignored. The GoTrue custom access-token hook is not used. Session kinds: `tenant_staff`, `platform`, `partner`, `patient`, `staff_mobile` (lifetimes and claim shapes: 08 R10 table). Kind binding comes from the calling BFF's key (`X-Lims-Bff-Key`: staff_web, partner) or from the endpoint family (`/v1/identity/auth/patient/*`, `/v1/identity/mobile/*`), never from a client header. Non-GoTrue credentials (device, queue display, portal, patient pre-auth, payment callback) are resolved by the single module allowed per scheme (08 R10 table). SP-1 proves only that the pinned GoTrue issues `session_id`/`aal` and which `alg`; a missing `session_id` is a blocker for C2, not a reason to fall back to unbound claims.

    Replace step 2 of the API list "Read claims: sub, tenant_id, membership_id, actor_type (written only by the server-side auth hook — REQ-SEC-067)" with "Resolve claims through the identity `claimsResolver` (session row → tenant, membership, actor_type, state; REQ-SEC-067)". In the "PORTAL / PATIENT APP / PARTNER" block replace "Patient app / partner users: GoTrue users whose memberships carry tenant_id and actor_type 'patient' / 'partner'" with "Patient app / partner users / phlebotomy app: GoTrue users with sessions of kind `patient` / `partner` / `staff_mobile`; the app or partner BFF holds an opaque LIMS session token, never a GoTrue refresh token (08 R10)."
12. **§7.2**, append: "An event enum may gain values in `.v1` only when its schema marks it `x-extensible: true`; consumers handle unknown values as documented for that event (today: `catalog.changed.v1.entity_type` → invalidate all; `reporting.report.released.v1.report_kind` → treat as `amended` for display) (08 R13)."
13. **§8.2**, replace "`NODE_ENV=production` (and staging) boot **fails** if any port resolves to a fake." with "`NODE_ENV=production` (and staging) boot **fails** if any port resolves to a fake. The only exception is a **phase stub** for a port listed in `services/api/src/core/ports/phase-stubs.ts` (08 R9: QualityPort, SmartReportPort, PaymentProviderPort, EngagementPort); stubs only deny or disable, are counted by `lims_core_phase_stub_ports_active`, and CI fails when a listed port's owner module exists."
14. **New §8.5** (after §8.4): "### 8.5 Non-staff actors (patient, portal, partner)" + the three numbered rules of **08 R8** verbatim.
15. **§10.2 table**: row "Uploads": replace the allowlist cell with "per-operation allowlist ⊆ `application/pdf`, `image/jpeg`, `image/png`, `text/csv` (UTF-8, no NUL, never rendered, no scan), `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (ZIP magic + `.xlsx`, scanned); extension + magic-byte check; ≤ 15 MB; object under `{tenant_id}/…` in the module's own bucket; ClamAV-class scan **mandatory in staging/production** (scan unavailable ⇒ quarantine); image re-encode strips metadata; all through `ctx.uploads`/`ctx.storage` (08 §4.13)". Row "Supabase keys": append "Audited users: `services/api/src/modules/identity/gotrue/gateway.http.ts` (GoTrue service key, CR-C2-014) and `services/{api,worker}/src/core/storage/` (Storage credential, 08 R12b)."
16. **§10.3 table**, row `login`: replace the Limit cell with the Limit cell of the amended 04 §4 Login row (**08 R6**) and the "Enforced at" cell with "nginx on the public login routes (client IP; registered-IP zone from config) + app (per account; registered-IP demotion)". Append under the table: "The per-IP part of `login` is applied by nginx on the public BFF/app login routes, keyed by the client IP — never on BFF-only internal API routes (08 R6)."
17. **§15.1**, replace "Allowed only in the chunk's own package manifest (01 §4)." with "Allowed only in a package the chunk owns entirely; for `services/api`, `services/worker`, `apps/web` the dependency is added by C0-0D on a CR (01 §4, CR-C0-002)." Append: "Repo-wide pins recorded by C0: `write-excel-file` 4.1.1, `read-excel-file` 9.3.14 (C3 02-TRD §2.2; CR-C8-014)."
18. **§15.2 table**: insert the ops-tools row of **08 R15** (CR-C1-007) between "Review required" and "Banned in shipped code".

## 3. `program/03-INTERFACE-CATALOG.md`

1. **§3.9** `lab.result.verified.v1` payload: add `processing_branch_id` (08 §4.10).
2. **§3.10 / §3.11** Consumers: add C11 (CR-C11-011). **§3.3** Consumers: add C13. **§3.19** Consumers: add C13, C16; payload `entity_type` per 08 §4.10 (`x-extensible`).
3. **§3.14** `instruments.result.received.v1`: Trigger row append the CR-C7-004 sentence ("…or commit of the `scan_attachment` transaction that marks an attachment clean, or of a reprocess/re-match transaction, that produces a record whose key was not published before (re-publication is suppressed by `core.event_log` uniqueness)"); payload adds `captured_at`, `processing_kind`, `source_record_id`; add a "Driver rule (CR-C10-007)" row with the `ORG:`/`AST:` encoding of 08 R13 and "04 N10 key unchanged".
4. **§3.15** adds `captured_at`, `processing_kind`. **§3.16** add note: "Metrics per CR-C1-003 (labels tenant_id, centre_id, agent_id[, state|agent_version]; four state series per agent, value 0/1)."
5. **§3.17** payload: `order_item_ids`; `report_kind` enum + `addendum`, `x-extensible`; Consumers row unchanged.
6. **§3.22** Consumers: "C4 (`booking_kind = centre_visit` only: its consumer calls its own `createOrderFromBooking` logic → `pre_registered` order), C17 (`home_collection`: C17 creates the home visit and, at assignment, the order through `FrontdeskPort.createOrderFromBooking` — 08 R7)".
7. **§3.23** `payments[]` item property `reference`; documentation sentences of CR-C17-006.
8. **§3.24** C4 consumer text: append "For `home_collection` bookings C4 looks up `booking_links (source 'home_collection', source_ref_id = home_visit_id)` and raises a review item if a registered order exists (08 R7)."
9. **New §3.26** `instruments.calibration.received.v1` — table + payload from 08 §4.10.
10. **§3.25 matrix**: add rows for §3.24 consumers check, §3.26; update consumer cells as in items 2/6.
11. **§4.1** `PortRegistry` += `BillingCommandPort`, `RenderPort`, `EngagementPort`.
12. **§4.2–§4.11**: insert the TypeScript additions of **08 §4.14** into each port block (marked `// added by 08`), the contract-case additions into each "Contract tests" row, and these text changes:
    - §4.2 header "consumers C4, C5, C6, C7, C9, C10, C11, C12, C14, C16" += C13; `priceFor` JSDoc `@throws catalog.no_price, catalog.tax_config_missing`.
    - §4.3 "Field allowlist by purpose" row: append the new purposes and the `notification`/non-system rule (08 §4.14). "Semantics" row: append "Order creation owner per booking type: 08 R7 table; authorisation per `source` as in 08 R7."
    - §4.4 "Tenant context" row: replace "C15 calls it under the worker/system context of the verifying job or under the patient/portal request context." with "Callers are staff (`user`) or `system` actors only; C15 calls it in the verifying job/callback context (system) or in a staff request. Patient/portal contexts never call BillingPort (08 R8)." Invariants row: append "`capture_kind = 'gateway'` entries have `collected_by_membership_id = NULL`."
    - §4.5 header consumers += C4, C17; `ingestInstrumentResult` JSDoc: replace "@throws lab.result_locked (approved; never overwritten — becomes 'rejected_state' outcome instead when called from replay)" with "Never throws for an approved target: returns outcome `rejected_state` with `reasonCode: 'result_locked'` (CR-C5-008). A key stored as `unmatched`/`rejected_state` with an open C5 exception is re-evaluated on replay (CR-C7-011)."
    - §4.6: replace the `TenantSettings` interface with 08 §4.12; "Semantics" row append "`branchIds` = explicit `core.membership_branches` grants; `centreScope.all` implies all branches; branch scope is application-level only (08 R3). Partner/patient/queue-display actors per 08 §4.14."
    - §4.7: `ReleasedReportSummary.kind` + `addendum`; "Tenant context" row append the partner/patient predicates of `openReleasedReportFile`.
    - §4.8: `NotificationPurpose` and `related.entityType` per 08 §4.14; header consumers += C8.
    - §4.9: header "consumers C4, C16" + "(callers staff/system only — 08 R8; C6 portal deferred)"; IntentAction `launchUrl`; add `getIntent`/`cancelIntent`; Contract tests: case 5 text replaced by CR-C15-001's wording; append cases 12–18.
    - §4.10: SmartSummary optional fields; semantics rows of CR-C14-006; `@throws` += `smartreport.summary_not_ready`; contract cases 7–14.
    - §4.11: `AutoVerifyReason` += `qc_warning`; JSDoc of CR-C9-003; Semantics row append CR-C9-004 behaviour; Phase-1 note: "Production uses the phase stub (02-CV §8.2, 08 R9)".
13. **New §4.15** `BillingCommandPort` (normative text = C4 02-TRD §6.3 with `catalog.tax_config_missing`), **§4.16** `RenderPort`, **§4.17** `EngagementPort` — from 08 §4.14.
14. **§5.1**: append row "A9 | CR register 08 (2026-11-06) | all | `08-CR-REGISTER.md` §4 transcribed into §3, §4, §6–§11". **New §5.3** "Resolutions from the CR register (binding)": one line per 08 R1–R27 (title + "see 08 Rn").
15. **§6**: apply 08 §4.9 row by row (columns appended at the end; consumers edited). Add **§6.5** row `instruments.v_pub_instrument_directory`; add **new §6.9** `engagement` (owner C16): `v_pub_booking_daily`, `v_pub_queue_daily` (columns from C16 05-SCHEMA §7), consumers C8. §6.2 `v_pub_payment_collection` consumers += C15 and note "C0 DDL: `method_code AS payment_method_code`".
16. **§7**: `origins` += `api`, `files`; append all routes of 08 §4.3 under `routes:` grouped by owner; edit `staff.analytics.*` permission names per §9 R19 rename. Rules paragraph append: "`auth: display_token` routes render without the staff session and are never nav entries."
17. **§8**: append all codes of 08 §4.2 in their module groups; add the emission-exception sentences of 08 §4.2 to the footnote "Codes are emitted only by their owner module…".
18. **§9.1** row CollectionCentre: no change (already `core.collection_centres`). **§9.3**: replace the sentence "Patterns live in `TenantSettings.numbering` (IdentityPort §4.6), set by C2, validated by the owning module." with the rule text of 08 §4.5; add rows `accession_no` prefixes, `receipt_no` pattern key, `po_no`/`grn_no`/`transfer_no`/`count_no`/`doc_no` (08 §4.5).
19. **§10.3** add rows: `rendering` → `discarded`, `rendered` → `discarded`, `render_failed` → `discarded` (trigger: newer version assembled or order cancelled; no event); sentence "QR of a discarded version → `reporting.verify_not_found`; release of a discarded version → `reporting.release_not_ready`." (CR-C6-005)
20. **§10.6**: replace the paragraph with the transition table I1–I14 from C15 02-TRD §4.1 (CR-C15-003), keeping the last sentence on events and the one-open-intent rule.
21. **§11**: apply 08 §4.1 (new codes appended per module group; role-list changes; renames; `radiologist` role row; `partner_roles:` block; `fixed_actor_permissions` replaced). Replace in the rules paragraph "… cannot grant `platform.*` …" sentence end with: "Platform permissions are checked only by C2's `PlatformAuthz` in platform context; `IdentityPort.assertRole` refuses every `platform.*` code (08 R23)." Add the CI rules sentence of 08 §4.1.
22. **§12** `app.enqueue_job` sentence: replace "owned by a role holding the Graphile Worker queue privileges" with "owned by `lims_queue` (NOLOGIN, NOBYPASSRLS; 02-CV §5.9)".

## 4. `program/04-CHANGE-REQUESTS.md`

1. **§4 CR log**: replace the placeholder row `| — | — | — | (empty at program start) | — | — |` with `| CR-C0-001 … CR-C18-010 (220) | all | all | Arbitrated 2026-11-06 | see \`08-CR-REGISTER.md\` §3 | apply phase |`.
2. Append to §3 rule 5: "Program-level arbitration of batches of CRs is recorded in `08-CR-REGISTER.md`; its §2 decisions are binding until applied."

## 5. `program/06-GLOSSARY.md`

1. Row **Collection centre**, column 3: `` `core` table `centres` `` → `` `core.collection_centres` `` (CR-C0-008, CR-C2-015).
2. Row **RLS**, column 3: `` explicit per-command policies `TO authenticated` `` → `` explicit per-command policies `TO lims_app` (group role of the API and worker logins; `authenticated` only on Supabase-served objects — 03-IC X9) ``; append: "Non-staff actors (partner/portal/patient) get no centre scope and are excluded from `__tenant` policies by `app.is_staff_or_system()` unless a table has an actor-specific policy (08 R3/R10)."
3. Row **Sign-out**: replace columns 2–4 with: "The pathologist's signature on an anatomic-pathology report in C11 (01 §2.4)." | "C11 locks that report version (`anatomic.case.signout`). The result then passes C5 verification and pathologist approval (03-IC A1; approver ≠ verifier) before release. Later changes are C11 addenda (reason `supplementary_report`, report kind `addendum`) or amendments (08 R1, R2)." | "Sign-out ≠ C5 approval. Whether sign-out may count as verification is a client decision (08 §5 C-02; default no)."
4. Row **Branch**, column 3: append "Staff branch scope is an explicit grant (`core.membership_branches`), used only for application-level checks on P0/P1 data (e.g. C12 stores); it never widens RLS (08 R3)."
5. Insert rows (alphabetical): **Addendum** — "Supplementary anatomic report that adds information without correcting the original." | "C11 → C5 amendment with reason `supplementary_report`; report kind `addendum` (08 R1)." | "Not an amendment (which corrects)." **Session kind** — "Type of login session." | "`tenant_staff`, `platform`, `partner`, `patient`, `staff_mobile` (C2; 08 R10)." | "Not an actor type (`user`, `system`, `device`, `portal`, `patient`, `partner`)." **Phase stub** — "Minimal deny/disable implementation of a port whose owner ships in a later phase." | "02-CV §8.2 exception; 08 R9." | "Not a fake (no data, no seeding)."

## 6. `program/07-BLOCKERS.md`

1. Row **B4**, column "Build against this default": replace with the B4 text of **08 R15** (CR-C18-010).
2. Row **B2**: append to "Chunks affected" `C7 (calibration event, CR-C12-006)`.
3. Insert after the table a new section:
   > ## Founder, client and auditor decisions raised by the CR register (not 04 §13 items)
   > Tracked in `08-CR-REGISTER.md` §5. Build against the default listed there.
   followed by a 3-column table (`# | Decision | Default`) with the open rows F-01, F-05, F-06, F-07, F-08 and C-02…C-05 copied from 08 §5.1/§5.2, and one line: "Closed by the founder 2026-11-06 (research/04 §11/§13): Authenticode certificate and app-store accounts/keys owned by the client; maps hand-off approved; per-summary smart-report approval kept (08 §5.0)."
4. "Requests to send now", item 1 (to the client): add "C-03 static egress IP per site; client to provide the Authenticode certificate and the app-store accounts/signing keys it owns (founder decision 2026-11-06)". Item "To the founder" (new item 6): "F-01 egress register; F-05 push; F-08 sign-off of the 04/02 wording edits."

## 7. `research/04-consolidated-decisions.md` (minimal — only decided wording)

1. **§2 D4**, Value cell: replace `` `TO authenticated` `` with `` `TO lims_app` (group role of the API/worker logins, narrower than `authenticated` — REQ-SEC-015; `authenticated` only on Supabase-served objects; 03-IC X9) `` (08 R5).
2. **§4 table, "Login" row**: replace the whole row with the row given in **08 R6** (CR-C1-009).
3. **§13 B4**, column "Default until answered": replace "No migration design" with the B4 text of **08 R15** (CR-C18-010).
4. **Verification log**: append rows `| D4 | TO authenticated | TO lims_app (X9 wording) | 08-CR-REGISTER R5 |`, `| §4 Login | 5/min/IP only | + registered lab egress IP zone with compensating controls | 08 R6 (CR-C1-009) |`, `| B4 | No migration design | design only, no build | 08 R15 (CR-C18-010) |`.
No other 04 row changes. In particular **N10 is not amended** (08 R13).

---

## 8. Chunk documents

Each subsection lists the content edits caused by an outcome that differs from what the chunk assumed. All chunks also get the status table of §8.20.

### 8.0 C0 — Foundation & Contracts
- **02-TRD §1.1** 0D row: add `/apps/web/src/app/(auth)/**`, `(platform)/**` are **C2** and `(display)/**` is **C16** (not C0); add `/services/api/src/core/ports/phase-stubs.ts`. 0B row: add `db/meta/index-exceptions.yaml`. 0C row: add `/contracts/render/**`.
- **02-TRD §2 / dev stack** (find "GoTrue in the dev stack: `GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED`"): replace the paragraph with "The GoTrue custom access-token hook is not used (08 R10); the dev stack leaves `GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_*` unset. SMTP → `mailpit:1025`."
- **02-TRD §6.5** (find "Claims source, depending on SP-1:"): replace the bullet and its two sub-bullets with "Claims source: the identity module's `claimsResolver` (mandatory; CR-C2-005; 08 R10) maps `(session_id, sub)` to the session row; claims inside the JWT other than `sub`, `session_id`, `aal`, `exp`, `iat` are ignored. A token without `session_id` → `401 auth.token_invalid`." Remove `core/auth/membership-fallback.ts` from the file tree (find "membership-fallback.ts").
- **02-TRD config table**: delete the row `` `LIMS_CORE_CLAIMS_SOURCE` ``; row `LIMS_CORE_JWT_*`: "SP-1 fixes values per env" unchanged.
- **02-TRD §9 phase stubs** (find "Stubs are allowed in staging/production only for ports listed"): "(default: those three)" → "(default: QualityPort, SmartReportPort, PaymentProviderPort, EngagementPort — 08 R9)"; add the bullet "`EngagementPort`: `getActiveMembership` → `undefined`; `getHomeAddress` → `common.not_found`." and to `PaymentProviderPort` "(incl. `getIntent`, `cancelIntent`)".
- **02-TRD §6.9** `AccessLogEntry`: no change; add sentence "Valid `action` codes: 08 §4.4."
- **02-TRD CR-C0-004 text**: leave as history; status table says ACCEPT-MODIFIED (PlatformAuthz).
- **03-APP-FLOW §2.2** (find "### 2.2 Token issuance and claims (SP-1 decides the path)"): retitle "Token issuance and claims (08 R10)"; delete the `participant H as app.custom_access_token_hook` line and the `alt hook path` branch; keep only the resolver path (`claimsResolver` → `app.identity_resolve_session`).
- **05-SCHEMA §2 roles** (find the rows/lines containing `lims_auth_hook`): delete the `lims_auth_hook` role row, its `CREATE ROLE`, `GRANT … TO lims_migrator`, `ALTER DEFAULT PRIVILEGES FOR ROLE lims_auth_hook`, the schema-usage grants naming it, and "`USAGE` on `app` for `supabase_auth_admin` is granted only when SP-1 selects the hook path …"; add roles `lims_monitor`, `lims_replicator`, `lims_audit_ship`, `lims_reporting_lookup` with the publication SQL of CR-C1-002; CI assertion text per 02-CV §5.9 (item 2.10).
- **05-SCHEMA §3.3**: replace "Branch scope (`ActorProfile.branchIds`, IC §4.6) is derived: … [DECISION — avoids a second scope table]." with "Branch scope is explicit: `core.membership_branches (tenant_id, membership_id, branch_id, created_at, created_by)`, PK (tenant_id, membership_id, branch_id), FKs to memberships and branches, association class, audited (C2 05-SCHEMA). `all_centres = true` implies all branches. Branch scope is application-level only; no RLS policy reads it (08 R3)." Replace "A global unique index would be a cross-tenant existence oracle (REQ-SEC-026), so it is not used." with "A partial global unique index `memberships__user_id__p_uq (user_id) WHERE actor_type = 'user' AND is_active` enforces one tenant per staff user (08 R27; listed in `db/meta/index-exceptions.yaml`); collisions surface only as the generic `identity.user_exists`." Add CHECK `memberships__all_centres_user_only__ck CHECK (actor_type = 'user' OR NOT all_centres)` and a trigger refusing `membership_centres`/`membership_branches` rows for non-`user` memberships.
- **05-SCHEMA §3.7** access-action seed (find "Seed [CONV; chunks add codes by CR]:"): append every code of 08 §4.4.
- **05-SCHEMA §4 policy table** (find "`__auth_hook` (lims_auth_hook"): delete the `__auth_hook` policy and the `lims_auth_hook` SELECT grants; add `__tenant` + `app.is_staff_or_system()` rule; add `core.membership_branches` policies (`__tenant`).
- **05-SCHEMA DEFINER inventory table** (find "| `app.custom_access_token_hook(jsonb)` |"): delete the rows for `app.custom_access_token_hook` and `app.resolve_membership_for_subject`; add the rows of 08 §4.7; delete the SQL block that starts "-- ===================================================================== auth hook (owner lims_auth_hook".
- **05-SCHEMA §5.8 helpers** (wherever `app.has_all_centres` is defined): CASE per 02-CV item 2.9.
- **04-UI-UX §2**: add the components and prop changes of 08 §4.6 (web) to §2.1–§2.6 at their natural place; §8 Flutter widgets list += the 12 C16 widgets; §2.7 message key `ui.status.report_version.discarded`; §10 "CR candidates": mark RichTextEditor and queue display board as accepted (CR-C6-010, CR-C16-016).
- **06-IMPLEMENTATION-PLAN §1 SP-1**: rescope text to "prove `session_id` + `aal` claims and JWT `alg` of the pinned GoTrue (08 R10); a missing `session_id` is raised as a blocker for C2 T1".

### 8.1 C1 — Infrastructure & Ops
- **02-TRD** (rate limits section): implement the amended login row (08 R6): nginx zones `login` (5/min/IP) and `login_registered` (30/min/IP, burst 10) keyed by client IP on the **public** staff-web BFF login/recovery routes (paths from C2), partner-BFF login, `/v1/identity/mobile/sessions`, `/v1/engagement/auth/otp-challenges*`; registered set generated from the C2 platform setting; no per-IP login zone on BFF-only `/v1/identity/auth/*` routes.
- **02-TRD** bucket names per 08 §4.8 wherever C1 lists buckets (backup/replication of object storage).
- Patient session resolve per-IP 120/min (CR-C16-018 as modified).
- Egress register stays the CR default until F-01.

### 8.2 C2 — Identity & Admin
- **02-TRD §4** add item 10: "Session kinds `tenant_staff`, `platform`, `partner`, `patient`, `staff_mobile` (08 R10 table, lifetimes and claims). Each BFF authenticates to `/v1/identity/auth/*` with its own `X-Lims-Bff-Key` (staff_web, partner; secret store); the key, not a header, binds the session kind. Patient and staff-mobile sessions use opaque LIMS session tokens with rotation + reuse detection; GoTrue refresh tokens stay server-side."
- **02-TRD §5.1**: `SessionState.kind` enum → `(tenant_staff|platform|partner|patient|staff_mobile)`; add operations `loginPartner` (POST `/auth/partner/login`, as loginStaff, `x-edge-exposure: internal`, partner BFF), `resolvePatientSession`/`logoutPatientSession` (POST `/auth/patient/session/resolve|logout`, public, header `X-Lims-Patient-Session`), `openMobileSession` (POST `/mobile/sessions`, tier `login`, public), `refreshMobileSession` (POST `/mobile/sessions/refresh`), `logoutMobileSession` (POST `/mobile/sessions/logout`); remove every reference to `X-Lims-Origin`.
- **02-TRD §5.5**: centre `kind` enum `owned` → `own`; branch/centre `code` pattern `^[A-Za-z0-9-]{1,20}$` → `^[A-Za-z0-9-]{1,16}$` (08 §4.11 note).
- **02-TRD §5.10**: add `setTenantEgressIps` (PUT `/platform/tenants/{tenant_id}/egress-ips`, `platform.tenant_egress_ip.manage`, body `ips` 0–4 single addresses, `confirm_until` ≤ 90 days; errors `identity.egress_ip_limit`; access log `tenant_egress_ip.change`; If-Match) and the demotion counter (08 R6).
- **02-TRD §6.1** `ResolvedClaims`: `kind` union += `'partner' | 'patient' | 'staff_mobile'` (claims shapes per 08 R10).
- **02-TRD §7.1**: partner/patient/queue_display rules per 08 §4.14; `branchIds` from `core.membership_branches` only.
- **02-TRD §9** (find "Access-log events C2 writes via `ctx.audit.access`"): replace the list with the C2 codes of 08 §4.4 and the call shape `ctx.audit.access({action, entityType, entityId?, outcome, detail?})`.
- **02-TRD §10/CR-C2-012 consequences**: per-IP login limit belongs to the public edge (08 R6); bucket names `identity-assets`, `identity-exports`.
- **02-TRD §7 / IdentityPort**: add the seven new methods of 08 §4.14 and the merged `TenantSettings` (08 §4.12) incl. mapping from `identity.tenant_settings` columns (add columns for `branding.address_lines`, `phones`, `receipt_footer_note`, `accent_color`, numbering additions, retention, feature flags already present).
- **05-SCHEMA**: `identity.sessions.kind` CHECK `IN ('tenant_staff','platform','partner','patient','staff_mobile')` with `kind_shape` (tenant_id + membership_id NOT NULL for all but `platform`); bucket defaults/CHECKs `'tenant-assets'` → `'identity-assets'`; audit-export object path `exports/{tenant_id}/{yyyy}/{mm}/{id}.csv` (bucket `exports`) → `{tenant_id}/{yyyy}/{mm}/{id}.csv` (bucket `identity-exports`); IRD platform documents keep `platform/ird/…` in `identity-assets` (platform context only); new table `identity.tenant_egress_ips`; `identity.g_feature_flags` seed `smart_report` (CR-C14-005).
- **04-UI-UX §2.2**: rename components per 08 R22 (`OtpInput`, `SecretRevealOnce`, `Timeline`, `DiffTable`; `SupportBanner` = shell slot).
- **07-SECURITY**: add probes "session of kind X on endpoint family Y → 401", "BFF key of partner on staff login → 401", "registered-IP demotion after 20 failures".

### 8.3 C3 — Catalog & Pricing
- **02-TRD §6.1**: apply 08 §4.14 CatalogPort block (purpose `billing`, `pan`, `billingAddressText`, `departmentName`, `usesExistingMaterial`, `asOf`).
- **02-TRD §7.1**: function list `fname` += `"log10"`; replace the first semantics bullet with the numeric semantics of 08 R12a; implementation `@lims/shared-ts/formula` by C0-0A.
- **02-TRD tax rules (find "Rules effective at `at`: orderable rule > department rule > tenant default.")**: append "C3 is the only owner of tax rates (08 R18): `cs_tax_types` rows are effective-dated; C4 has no tax table." **05-SCHEMA** `catalog.cs_tax_types`: add `effective_from timestamptz NOT NULL`, `effective_to timestamptz`, `version int`, unique `(tenant_id, code, effective_from)`.
- **02-TRD §9 events**: `catalog.changed.v1` entity types — remove the interim mapping note once C0 merges (`x-extensible`).
- **04-UI-UX §2**: rename per 08 R22; keep new `EditableGrid`, `CodeField`, `FormulaEditor`, `StatusStepper`, `DiffTable`.
- **Access log**: catalog file/referrer exports use `data.export` (entityType `catalog_file` / `referrer_export`).
- **Import kinds** (CR-C18-008): `catalog.imports.kind` CHECK += `'credit_parties'`; sheet `CreditParties` columns per CR-C18-008; permission `catalog.price_list.manage`.

### 8.4 C4 — Front Desk & Billing
- **05-SCHEMA**: delete `billing.tax_codes` (table row line "| `billing.tax_codes` | M (versioned rows) | tenant | VAT / other tax rates (B7) |", grants row, DDL block "CREATE TABLE billing.tax_codes"); invoice lines keep `vat_rate_bp`, `other_tax_code`, `other_tax_rate_bp`, `hs_code` snapshots from `PriceQuote`. `billing.ledger_entries.collected_by_membership_id` → nullable + CHECK `ledger_entries__collector__ck CHECK ((capture_kind = 'gateway') = (collected_by_membership_id IS NULL))`. `finance_review_items.kind` += `'gateway_payment_exceeds_due'`, `'booking_cancelled_after_registration'`. §6 view SQL: `method_code AS payment_method_code`. Bucket `trf` → `frontdesk-trf`.
- **02-TRD F8/F9 and §6.3**: replace `billing.tax_config_missing` [CR-C4-007] with `catalog.tax_config_missing`; delete the errors.yaml line for it in "Change requests raised" (keep as struck history: append "(not registered — 08 R18)").
- **02-TRD §8.2** consumer row `engagement.booking.confirmed.v1`: prepend "if `booking_kind = 'home_collection'` → inbox only, no order (08 R7); else". Consumer row `engagement.booking.cancelled.v1`: add the `home_visit_id` lookup + review item (08 R7).
- **02-TRD §6.1** `createOrderFromBooking`: authorisation per source (08 R7); `OrderSummary.partnerId`; new methods `getPatientDemographicsBatch`, `createSelfRegisteredPatient`; purposes and `contactPresence`, `status` (08 §4.14).
- **02-TRD §6.2** BillingPort: `recordGatewayRefund`, `allowExceedsDue`; "callers staff/system only; no patient/portal context" (08 R8).
- **02-TRD §5.2 / InvoicePrint** (find "`letterhead` (from `IdentityPort` TenantSettings.letterhead [CR-C4-009])"): → "`branding` (from `IdentityPort` TenantSettings.branding — 08 §4.12)"; §6.4 consumed keys `letterhead` → `branding`.
- **02-TRD exports**: PDF via `RenderPort.renderPdf` (worker, system actor) returning bytes, stored by C4 in `billing-exports`; templates under `services/renderer/templates/billing/**` (C4).
- **02-TRD registration**: membership display via `EngagementPort.getActiveMembership` (phase stub until C16).
- **Permissions**: `billing.export` → `billing.data.export`, `billing.release_override` → `billing.release.override` (§9); `billing.settings.manage` description per 08 §4.1.
- **Access log**: `patient_search` → `patient.search`.
- **04-UI-UX §2**: component names per 08 R22 (MoneyField, MoneyText, DateText AD_BS, Combobox, DataTable, FileUpload+scanState, StatusChip, ConfirmDialog, PrintFrame).
- **07-SECURITY**: remove the statement that patient/portal contexts may call `recordGatewayPayment`; add probe "patient/portal actor → BillingPort auth.forbidden".

### 8.5 C5 — Lab Workflow
- **02-TRD §4.4**: replace the grammar block with "Grammar and semantics: C3 02-TRD §7.1 as amended by 08 R12a, implemented by `@lims/shared-ts/formula` (C0-0A). No local parser." Keep the input/rounding/provenance bullets; map `missing_input:*` to `waiting_for_inputs`; `inexact` per 08 R12a.
- **02-TRD LabPort section**: add `getOrderItemProcessingState`, `listPendingForInstrument`, `lookupSpecimens` (three selectors), `getAnalyteHistory` (`includeLegacy` reserved), `barcode`/`moduleRef`, `amendment` handling incl. the `module_phase_progression`/`supplementary_report` guards (08 R1); `ingestInstrumentResult` JSDoc fix; replay re-evaluation (CR-C7-011) incl. new contract case 21.
- **05-SCHEMA**: seed `lab.g_cs_amendment_reasons` += `module_phase_progression`, `supplementary_report`.
- **02-TRD §6.2** (QualityPort call): behaviour of CR-C9-004.
- **Label prints**: operation of CR-C4-010 (`POST /v1/lab/orders/{order_id}/label-prints`, `lab.specimen.label_print`, idempotency required, 202, 409 when specimens not created); uses `@lims/ui` `BarcodeSymbol`.
- **Add-on tests**: `usesExistingMaterial` → results without specimen requirement (CR-C11-009).
- **Numbering**: `numbering.barcodePrefix` replaces "`{prefix}` rejected" interim.

### 8.6 C6 — Reporting & Delivery
- **02-TRD report-kind rule**: replace with the four-step rule of 08 R1 (adds `addendum`, label "Addendum").
- **02-TRD / 05-SCHEMA buckets**: `report-inputs` → `reporting-inputs`, `report-prints` → `reporting-prints`.
- **05-SCHEMA token hashes**: every `*_sha256 text` (qr_tokens, portal_links, portal_sessions, channel_accounts.callback_token_sha256, destination_sha256) → `bytea` + `CHECK (octet_length(...) = 32)`; DEFINER signatures `(bytea)` per 08 §4.7.
- **02-TRD RenderPort**: implement `RenderPort.renderPdf` per 08 §4.14 (worker/system only; returns bytes); registry loads `templates/billing/` (C4) and `templates/analytics/` (C8) like `templates/smart/`; add `smart-*` print classes (CR-C14-007).
- **02-TRD data sources**: department names from `TestDefinition.departmentName`, partner id from `OrderSummary.partnerId` (08 R25) — not from `catalog.v_pub_department` / `frontdesk.v_pub_order_status`.
- **NotificationPort**: purposes `scheduled_report_ready`, `booking_cancelled`, `booking_reminder`; templates seeded per 08 §4.10; consumers += C8.
- **ReportingPort**: `openReleasedReportFile` (partner + patient policies), `redeemPortalLinkForApp`, kind `addendum`.
- **Portal**: no PaymentProviderPort use (CR-C15-010 deferred); app-link files and fallback pages per CR-C16-010 (content inputs from F-04).
- **Permissions**: `billing.release_override` → `billing.release.override` wherever C6 references the override permission.
- **04-UI-UX**: `OtpInput` (shared with C2).

### 8.7 C7 — Instrument Integration
- Bucket `instrument-attachments` → `instruments-attachments` (02-TRD, 05-SCHEMA, 07-SECURITY, 01-PRD).
- **02-TRD drivers**: add the CR-C10-007 driver rule (08 R13) and two-isolate simulator fixtures.
- **02-TRD events**: produce `instruments.calibration.received.v1` (only for drivers whose manual classifies calibrators; B2).
- **Published view**: `instruments.v_pub_instrument_directory` columns per 08 §4.9.
- **04-UI-UX**: `SecretRevealOnce` with `requireAcknowledgement`.
- **02-TRD release signing / CR-C7-012**: replace "Founder action (not C1): procure a LIMS-provider Authenticode code-signing certificate" and any 06-plan risk text about it with "Authenticode certificate purchased and owned by the client (founder decision 2026-11-06, research/04 §13); held in the C1 secret store; the release pipeline applies it plus the internal Ed25519 signature (04 N11)".

### 8.8 C8 — Analytics & MIS
- Access action `analytics.referral_report.view` → `referral_report.view` (02-TRD, 03-APP-FLOW, 07-SECURITY).
- `analytics.export` → `analytics.data.export` (§9).
- **02-TRD PDF**: RenderPort returns bytes (08 R12c); C8 stores the file as its export design states.
- Published-view columns per 08 §4.9 (C8 already assumed them).

### 8.9 C9 — Quality Engine
- `instruments.v_pub_instrument_directory` final columns (08 §4.9).
- Access actions `autoverify.activate`, `autoverify.retire` are registered (08 §4.4) — no text change beyond the status table.

### 8.10 C10 — Microbiology
- Access actions renamed (08 §4.4): `micro.culture.view` → `culture.view`; `micro.breakpoint_set.{import,activate,retire}` → `breakpoint_set.{…}`; `micro.instrument_record.assign` → `micro_instrument_record.assign`.
- `LabPort.lookupSpecimens` signature per 08 §4.14 (third selector added; C10 unaffected).
- Amendment: `amendment` shape (identical); add the C5 guard that `module_phase_progression` is accepted only for micro final-after-approved-preliminary.
- CSV upload through `ctx.uploads` with `scan: 'not_applicable'` (08 §4.13).

### 8.11 C11 — Specialty Pathology
- Amendment reason `supplementary_report` is now a C5 seed: remove the "Default until merged: C11 sends `other` + reasonText for addenda" interim; report kind `addendum` (08 R1).
- Numbering via `TenantSettings.numbering.accessionNoPattern` / `accessionPrefixes` (08 §4.12).
- Glossary sign-out per 08 R2 (C11 already built to 03-IC).

### 8.12 C12 — Inventory
- **06-IMPLEMENTATION-PLAN** row R6 (find "Branch scope semantics differ between C0 (derived) and C2 (explicit `branch_ids`)"): replace mitigation with "Closed by 08 R3: explicit `core.membership_branches`; probes test that model only." Row in §3 (find "C0 05-SCHEMA derives branch scope from centres; C2 02-TRD stores explicit `branch_ids`: test both models"): replace with "explicit branch grants (08 R3)".
- `instruments.v_pub_instrument_directory` columns (08 §4.9).
- Numbering rule text (08 §4.5) — no design change.

### 8.13 C13 — B2B Partner Portal
- Remove `X-Lims-Origin` (02-TRD, 03-APP-FLOW, 07-SECURITY): "a session of kind `partner` resolves only for requests from the partner BFF, identified by its `X-Lims-Bff-Key` (08 R10)".
- CatalogPort consumer (getTest/getPanel/getReferrer/getCreditParty) — status only.

### 8.14 C14 — Smart Report
- `getAnalyteHistory` gains `includeLegacy` (default false; C14 passes false) and point `source` (08 §4.14).
- 06 R1: replace "reviewed with the client" with "accepted by the founder 2026-11-06: per-summary approval kept, `min_mapped_results` default 3 (research/04 §13; 08 R17)".
- Access action `smart_summary.view` registered (08 §4.4).

### 8.15 C15 — Payment Gateways
- **03-APP-FLOW §2.4 F-04**: redraw: `APP->>ENG: "Pay due"` → `ENG` inserts `payment_requests` and enqueues `engagement.create_payment_intent`; `W (C16 worker, system actor)->>PP: createIntent({…, returnUrl: "<PORTAL>/app/payments/<payment_request_id>/done", …})`; status: `APP->>ENG: status?` → ENG reads `payment_requests`; refresh task (system) calls `getIntent` (08 R8). Rules paragraph: "C16: patient owns the order" → "C16 checks the patient's ownership, then calls the port from its worker as system actor".
- **03-APP-FLOW §2.5 F-05**: prefix "DEFERRED (CR-C15-010, 08 §5 C-04) —".
- **02-TRD §5.3** semantics bullet "C4: `payments.intent.create`; C16: patient owns the order; C6: portal link scope" → "Callers: staff holding `payments.intent.create` (C4) or the engagement system actor (C16); patient/portal actors never call this port (08 R8)".
- **CR-C15-002 alignment notes**: replace with "`collected_by_membership_id` is NULL for gateway capture; BillingPort callers are staff/system only (08 R8)".
- Access action `payment_resolve` → `payment_intent.resolve`.

### 8.16 C16 — Patient Engagement
- **02-TRD §4.7** step 3: replace "`getPaymentRequest` (patient): if `ready`/`completed`-pending, call `PaymentProviderPort.getIntent({intentId})` (read-only …)" with "`getPaymentRequest` (patient) reads `payment_requests` only; when the request is `ready` and was last checked ≥ 3 s ago it enqueues `engagement.refresh_payment_request` (job_key per request), which calls `PaymentProviderPort.getIntent` as the engagement system actor and updates the row (08 R8)." Return URL path stays `/app/payments/{payment_request_id}/done`.
- **02-TRD line "Note for C4/C17 (non-blocking, recorded in 06 §5): C4's consumer pre-registers an order for **every** booking kind …"**: replace with "Order owner per booking type: 08 R7 — home-collection orders are created by C17 at assignment; C4's consumer ignores `home_collection` bookings." **06-IMPLEMENTATION-PLAN R-5**: mitigation → "Resolved by 08 R7".
- **05-SCHEMA §7**: delete `engagement.v_pub_booking_address` and `engagement.v_pub_patient_membership`; implement `EngagementPort` (`getHomeAddress`, `getActiveMembership`) in `services/api/src/modules/engagement/ports/EngagementPort.impl.ts`; 01-PRD AC lines "Given C17 reads `engagement.v_pub_booking_address`…" and "Given C4 reads `engagement.v_pub_patient_membership`…" → "…calls `EngagementPort.getHomeAddress` / `getActiveMembership`…"; 03-APP-FLOW sequence lines accordingly.
- **05-SCHEMA token hashes**: `queue_displays.token_sha256`, pre-auth challenge and link-code hashes `text` → `bytea` (08 R24); DEFINER params per 08 §4.7.
- **02-TRD identity integration**: remove `X-Lims-Origin: patient_app`; binding by endpoint family (08 R10); lifetimes unchanged (14 d / 30 d).
- **Routes**: `display.queue` → `staff.engagement.queue_display` (`nav: false`); fallback id `portal.app_fallback`.
- **Templates**: purposes `booking_cancelled`, `booking_reminder` for the two templates (08 §4.10).
- **Access actions** renamed per 08 §4.4 (`link_code.issue`, `app_link.redeem`, `app_link.revoke`, `patient_membership.lookup`, `patient_account.delete`).
- **02-TRD §11 / CR-C16-018**: session-resolve per-IP limit 120/min (08 R6).
- **FA-1** (01-PRD D-STORE and blocked-items row, 02-TRD §2.3 row, 06 T-REL1/M6, 07-SECURITY signing-keys row): "FOUNDER ACTION FA-1" → "client-owned store accounts, listings and signing keys (founder decision 2026-11-06, research/04 §13); keys held in the C1 secret store". Same edit in C17 docs wherever phlebo-app store distribution is mentioned.

### 8.17 C17 — Home Collection
- Replace `LabPort.listOrderSpecimens(ctx, {orderId, statuses})` with `LabPort.lookupSpecimens(ctx, {orderId, statuses})` returning `readonly SpecimenRef[]` (01-PRD, 02-TRD, 03-APP-FLOW, 06 plan).
- Session kind `'mobile'` → `'staff_mobile'`; replace "→ {access_token, access_expires_at, refresh_token, session_id}" with "→ {session_token (opaque, 256-bit), access_token, access_expires_at, session_expires_at}"; refresh takes `session_token` and rotates it with reuse detection (08 R10).
- Address via `EngagementPort.getHomeAddress` (no view); access action `home_visit.view` replaces `{ type: 'view', entity: 'home_visit' }`.
- CR-C17-001 consequences as accepted (08 R7). Maps hand-off APPROVED by the founder (research/04 §11): replace the "founder decision pending / default off" text of CR-C17-012 and of 01-PRD/02-TRD with "approved 2026-11-06; hand-off to the device's own maps app via OS intent/URL, address only (no name, tests, phone), no embedded map SDK"; the per-tenant `map_handoff_enabled` setting stays as an operational switch.

### 8.18 C18 — Legacy Migration
- Status table only (DEFER rows); B4 wording per 08 R15 where C18 quotes the 04/07 default. Bucket reserved name `reporting-legacy` replaces `legacy-documents` in C18 docs when B4 lifts (no edit now beyond a one-line note in 02-TRD §19: "bucket name reserved as `reporting-legacy` (08 R26)").

### 8.19 Program-wide component and code renames inside chunk docs
See §9 (mechanical).

### 8.20 Batch status edits (insert under each chunk's "Change requests raised" heading in `02-TRD.md`)

Each table below is inserted verbatim. Wording per decision: ACCEPT → "ACCEPTED in 08"; ACCEPT-MODIFIED → "ACCEPTED-MODIFIED in 08 (see note)"; MERGED → "MERGED in 08 into CR-x"; DEFER → "DEFERRED in 08"; FOUNDER → "FOUNDER decision (08 §5)".
#### `chunks/C0-foundation-contracts/02-TRD.md`

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C0-001 | ACCEPTED-MODIFIED in 08 — Merged with CR-C2-001/C13-001/C15-007/C16-001/C4-004/C8-009 into the amended 01 §3 tree (§2 R14). `(auth)` and `(platform)` groups incl. their `layout.tsx` → C2. |
| CR-C0-002 | ACCEPTED in 08 |
| CR-C0-003 | ACCEPTED-MODIFIED in 08 — Shape of CR-C2-009 wins; BFF authenticates to identity with per-BFF key `X-Lims-Bff-Key`; session-kind binding derives from the key (R10). |
| CR-C0-004 | ACCEPTED-MODIFIED in 08 — Check is C2 `PlatformAuthz` in platform context, not `IdentityPort.assertRole` (which refuses `platform.*`, C2 TRD §7.2). DEFINERs `app.dl_list_platform`, `app.dl_resolve`, `app.platform_list_tenants` inventoried. |
| CR-C0-005 | ACCEPTED in 08 |
| CR-C0-006 | ACCEPTED in 08 |
| CR-C0-007 | ACCEPTED-MODIFIED in 08 — `lims_queue` accepted. `lims_auth_hook` + `app.custom_access_token_hook` dropped (no hook path, R10). `owner_only` policy scope accepted; `auth_hook` scope not added. |
| CR-C0-008 | ACCEPTED in 08 |
| CR-C0-009 | MERGED in 08 into CR-C2-008 — Field `branding.accentColor` in the merged branding block (§4.12). |
| CR-C0-010 | ACCEPTED-MODIFIED in 08 — Stub set = QualityPort, SmartReportPort, PaymentProviderPort (+getIntent/cancelIntent), EngagementPort (C4 calls it in Phase 1). Stubs only deny/disable (R9). |

#### `chunks/C1-infrastructure-ops/02-TRD.md`

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C1-001 | ACCEPTED in 08 |
| CR-C1-002 | ACCEPTED in 08 |
| CR-C1-003 | ACCEPTED in 08 |
| CR-C1-004 | ACCEPTED-MODIFIED in 08 — Public paths also listed by C13 (partner login), C15, C16, C17 (mobile); login zones on public BFF/app routes (R6). |
| CR-C1-005 | ACCEPTED in 08 |
| CR-C1-006 | FOUNDER decision (08 §5.1) — Not decided here (§5 F-01). Build default = CR default. |
| CR-C1-007 | ACCEPTED-MODIFIED in 08 — Text accepted + conditions: unmodified, separate process, ops network only (AGPL Grafana never exposed to tenant users), register in `infra/THIRD-PARTY-OPS.md`. |
| CR-C1-008 | ACCEPTED in 08 |
| CR-C1-009 | ACCEPTED-MODIFIED in 08 — 04 §4 amended with a registered-egress-IP zone + compensating controls (R6). |

#### `chunks/C2-identity-admin/02-TRD.md`

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C2-001 | ACCEPTED in 08 |
| CR-C2-002 | ACCEPTED in 08 |
| CR-C2-003 | ACCEPTED-MODIFIED in 08 — Explicit branch scope via `core.membership_branches` (R3); add CHECK `actor_type = 'user' OR NOT all_centres`; token hashes `bytea` (R24). |
| CR-C2-004 | ACCEPTED-MODIFIED in 08 — `withTenantScope` only for an enumerated operationId allowlist in core config + access-log entry per use (R10). |
| CR-C2-005 | ACCEPTED-MODIFIED in 08 — Resolver is the sole claims source for every GoTrue JWT in every environment; extended to kinds partner/patient/staff_mobile (R10). |
| CR-C2-006 | ACCEPTED-MODIFIED in 08 — `identity.self.manage` roles += radiologist (CR-C6-003). |
| CR-C2-007 | ACCEPTED in 08 |
| CR-C2-008 | ACCEPTED-MODIFIED in 08 — Primary of merged TenantSettings change: branding (C0-009, C4-009), retention, featureFlags, ird.annexReadiness, numbering (C5-009, C11-005) — final shape §4.12. |
| CR-C2-009 | ACCEPTED-MODIFIED in 08 — + `X-Lims-Bff-Key`; kind binding from key, not from a free header (R10). |
| CR-C2-010 | ACCEPTED-MODIFIED in 08 — Event types mapped to 2-segment action codes (§4.4). |
| CR-C2-011 | ACCEPTED-MODIFIED in 08 — Primary of merged upload/storage CR (R12); final API §4.13. |
| CR-C2-012 | ACCEPTED-MODIFIED in 08 — Per-IP login zone sits on public BFF/app login routes keyed by client IP, not on BFF-only API routes; buckets renamed `identity-assets`, `identity-exports` (R26). |
| CR-C2-013 | ACCEPTED in 08 |
| CR-C2-014 | ACCEPTED in 08 |
| CR-C2-015 | MERGED in 08 into CR-C0-008 |
| CR-C2-016 | ACCEPTED-MODIFIED in 08 — OtpCodeInput→`OtpInput`; SecretRevealField→`SecretRevealOnce`; StatusTimeline→existing `Timeline`; JsonDiffView→`DiffTable`; SupportBanner = C0 shell slot; new `PermissionMatrix`, `DataUriImage` (R22). |
| CR-C2-017 | ACCEPTED in 08 |

#### `chunks/C3-catalog-pricing/02-TRD.md`

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C3-001 | ACCEPTED-MODIFIED in 08 — Primary of merged CatalogPort set (C4-002, C5-001, C13-007, C11-009, C6-012): purpose `billing` (pan, billingAddressText), `departmentName`, `usesExistingMaterial`, `asOf` on resolveCommentCodes (§4.14). |
| CR-C3-002 | ACCEPTED-MODIFIED in 08 — One grammar = C3 TRD §7.1 + `log10`; exact decimal (≥28 digits), transcendental → `inexact`; C0-0A implements (R12a). |
| CR-C3-003 | ACCEPTED-MODIFIED in 08 — `entity_type` marked `x-extensible: true`; stays .v1 (R13). |
| CR-C3-004 | ACCEPTED in 08 |
| CR-C3-005 | MERGED in 08 into CR-C2-011 — Scanner mandatory in staging/prod (not optional). |
| CR-C3-006 | ACCEPTED-MODIFIED in 08 — Mapped to existing kit names; new `EditableGrid`, `CodeField`, `FormulaEditor`, `StatusStepper`, `DiffTable` (R22). |

#### `chunks/C4-frontdesk-billing/02-TRD.md`

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C4-001 | ACCEPTED in 08 |
| CR-C4-002 | MERGED in 08 into CR-C3-001 — PAN/address via purpose `billing`. |
| CR-C4-003 | ACCEPTED in 08 |
| CR-C4-004 | ACCEPTED-MODIFIED in 08 — Final RenderPort returns PDF bytes to the caller (caller stores in its own bucket); worker/system callers only; template dirs per module (R12c). |
| CR-C4-005 | MERGED in 08 into CR-C2-011 — `trf` renamed `frontdesk-trf`. |
| CR-C4-006 | ACCEPTED in 08 |
| CR-C4-007 | ACCEPTED-MODIFIED in 08 — `billing.tax_config_missing` not added; `catalog.tax_config_missing` propagates from CatalogPort (R18). |
| CR-C4-008 | ACCEPTED-MODIFIED in 08 — `billing.settings.manage` no longer covers tax codes (R18). |
| CR-C4-009 | MERGED in 08 into CR-C2-008 — Fields live in `branding`. |
| CR-C4-010 | ACCEPTED in 08 |
| CR-C4-011 | ACCEPTED in 08 |
| CR-C4-012 | ACCEPTED in 08 |
| CR-C4-013 | ACCEPTED-MODIFIED in 08 — Use MoneyField, MoneyText, DateText(AD_BS), Combobox, DataTable, StatusChip, ConfirmDialog; FileUpload gains `scanState`; new `PrintFrame` (R22). |

#### `chunks/C5-lab-workflow/02-TRD.md`

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C5-001 | MERGED in 08 into CR-C3-001 — `searchCommentCodes` not a port method: UI picker uses C3 HTTP list. |
| CR-C5-002 | MERGED in 08 into CR-C3-002 — C5 local grammar (ternary, \|\|/&&) dropped. |
| CR-C5-003 | ACCEPTED in 08 |
| CR-C5-004 | ACCEPTED in 08 |
| CR-C5-005 | ACCEPTED in 08 |
| CR-C5-006 | ACCEPTED in 08 |
| CR-C5-007 | ACCEPTED in 08 |
| CR-C5-008 | ACCEPTED in 08 |
| CR-C5-009 | MERGED in 08 into CR-C2-008 |

#### `chunks/C6-reporting-delivery/02-TRD.md`

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C6-001 | ACCEPTED in 08 |
| CR-C6-002 | ACCEPTED in 08 |
| CR-C6-003 | ACCEPTED in 08 |
| CR-C6-004 | ACCEPTED in 08 |
| CR-C6-005 | ACCEPTED in 08 |
| CR-C6-006 | ACCEPTED in 08 |
| CR-C6-007 | ACCEPTED in 08 |
| CR-C6-008 | ACCEPTED in 08 |
| CR-C6-009 | ACCEPTED-MODIFIED in 08 — Buckets `reports` (04 D15), `reporting-inputs`, `reporting-prints` (R26). |
| CR-C6-010 | ACCEPTED-MODIFIED in 08 — `OtpInput` also serves C2 (R22). |
| CR-C6-011 | ACCEPTED in 08 |
| CR-C6-012 | ACCEPTED-MODIFIED in 08 — Operational reads use ports: `TestDefinition.departmentName`, `OrderSummary.partnerId` (R25). |
| CR-C6-013 | ACCEPTED in 08 |
| CR-C6-014 | MERGED in 08 into CR-C5-006 |
| CR-C6-015 | ACCEPTED in 08 |

#### `chunks/C7-instrument-integration/02-TRD.md`

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C7-001 | ACCEPTED in 08 |
| CR-C7-002 | ACCEPTED in 08 |
| CR-C7-003 | ACCEPTED in 08 |
| CR-C7-004 | ACCEPTED in 08 |
| CR-C7-005 | ACCEPTED in 08 |
| CR-C7-006 | ACCEPTED in 08 |
| CR-C7-007 | ACCEPTED-MODIFIED in 08 — Renamed `instruments-attachments` (R26); uses CR-C2-011 API. |
| CR-C7-008 | ACCEPTED in 08 |
| CR-C7-009 | ACCEPTED in 08 |
| CR-C7-010 | ACCEPTED-MODIFIED in 08 — `SecretRevealOnce` gains `requireAcknowledgement` (C2 shares it). |
| CR-C7-011 | ACCEPTED in 08 |
| CR-C7-012 | ACCEPTED in 08 |

#### `chunks/C8-analytics-mis/02-TRD.md`

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C8-001 | ACCEPTED in 08 |
| CR-C8-002 | ACCEPTED in 08 |
| CR-C8-003 | ACCEPTED in 08 |
| CR-C8-004 | ACCEPTED in 08 |
| CR-C8-005 | ACCEPTED in 08 |
| CR-C8-006 | ACCEPTED-MODIFIED in 08 — Code `referral_report.view` (2-segment rule, R20). |
| CR-C8-007 | ACCEPTED in 08 |
| CR-C8-008 | ACCEPTED-MODIFIED in 08 — Route `staff.analytics.exports` permission renamed `analytics.data.export` (R19). |
| CR-C8-009 | MERGED in 08 into CR-C4-004 |
| CR-C8-010 | ACCEPTED in 08 |
| CR-C8-011 | ACCEPTED in 08 |
| CR-C8-012 | ACCEPTED in 08 |
| CR-C8-013 | ACCEPTED in 08 |
| CR-C8-014 | ACCEPTED in 08 |

#### `chunks/C9-quality-engine/02-TRD.md`

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C9-001 | ACCEPTED in 08 |
| CR-C9-002 | ACCEPTED in 08 |
| CR-C9-003 | ACCEPTED in 08 |
| CR-C9-004 | ACCEPTED in 08 |
| CR-C9-005 | ACCEPTED in 08 |
| CR-C9-006 | ACCEPTED-MODIFIED in 08 — Primary; columns merged with CR-C12-005 (§4.9). |
| CR-C9-007 | ACCEPTED in 08 |

#### `chunks/C10-microbiology/02-TRD.md`

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C10-001 | ACCEPTED-MODIFIED in 08 — Primary of merged amendment shape; seeds `module_phase_progression` and `supplementary_report` (R1). |
| CR-C10-002 | ACCEPTED-MODIFIED in 08 — + `addendum` report kind for `supplementary_report` (R1). |
| CR-C10-003 | ACCEPTED-MODIFIED in 08 — Primary; adds `{orderId, statuses?}` selector absorbing CR-C17-002 (§4.14). |
| CR-C10-004 | ACCEPTED in 08 |
| CR-C10-005 | ACCEPTED in 08 |
| CR-C10-006 | ACCEPTED in 08 |
| CR-C10-007 | ACCEPTED in 08 |
| CR-C10-008 | MERGED in 08 into CR-C2-011 — `text/csv` allowed with UTF-8/NUL check, scan not applicable. |
| CR-C10-009 | ACCEPTED in 08 |
| CR-C10-010 | ACCEPTED-MODIFIED in 08 — Renamed to 2 segments (§4.4). |

#### `chunks/C11-specialty-pathology/02-TRD.md`

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C11-001 | ACCEPTED in 08 |
| CR-C11-002 | ACCEPTED in 08 |
| CR-C11-003 | ACCEPTED in 08 |
| CR-C11-004 | MERGED in 08 into CR-C10-001 |
| CR-C11-005 | MERGED in 08 into CR-C2-008 — C2 validates with C11 grammar. |
| CR-C11-006 | ACCEPTED in 08 |
| CR-C11-007 | ACCEPTED in 08 |
| CR-C11-008 | ACCEPTED-MODIFIED in 08 — EXIF strip, maxMegapixels, dimensions added to CR-C2-011 options. |
| CR-C11-009 | ACCEPTED in 08 |
| CR-C11-010 | ACCEPTED in 08 |
| CR-C11-011 | ACCEPTED in 08 |

#### `chunks/C12-inventory/02-TRD.md`

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C12-001 | ACCEPTED in 08 |
| CR-C12-002 | ACCEPTED in 08 |
| CR-C12-003 | ACCEPTED in 08 |
| CR-C12-004 | ACCEPTED in 08 |
| CR-C12-005 | MERGED in 08 into CR-C9-006 |
| CR-C12-006 | ACCEPTED in 08 |
| CR-C12-007 | ACCEPTED-MODIFIED in 08 — 03-IC §9.3 rule amended for module-internal non-fiscal numbers. |
| CR-C12-008 | ACCEPTED in 08 |
| CR-C12-009 | ACCEPTED in 08 |

#### `chunks/C13-b2b-partner-portal/02-TRD.md`

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C13-001 | ACCEPTED in 08 |
| CR-C13-002 | ACCEPTED in 08 |
| CR-C13-003 | ACCEPTED-MODIFIED in 08 — Kind `partner`; binding by partner BFF key, not `X-Lims-Origin` (R10). |
| CR-C13-004 | ACCEPTED in 08 |
| CR-C13-005 | ACCEPTED in 08 |
| CR-C13-006 | ACCEPTED in 08 |
| CR-C13-007 | MERGED in 08 into CR-C3-001 |
| CR-C13-008 | ACCEPTED in 08 |
| CR-C13-009 | ACCEPTED in 08 |
| CR-C13-010 | ACCEPTED in 08 |
| CR-C13-011 | ACCEPTED in 08 |
| CR-C13-012 | ACCEPTED in 08 |
| CR-C13-013 | ACCEPTED in 08 |

#### `chunks/C14-smart-report/02-TRD.md`

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C14-001 | ACCEPTED in 08 |
| CR-C14-002 | ACCEPTED-MODIFIED in 08 — + `includeLegacy` (default false) and point `source` for C18 (§4.14). |
| CR-C14-003 | ACCEPTED in 08 |
| CR-C14-004 | ACCEPTED in 08 |
| CR-C14-005 | ACCEPTED in 08 |
| CR-C14-006 | ACCEPTED in 08 |
| CR-C14-007 | ACCEPTED in 08 |
| CR-C14-008 | ACCEPTED in 08 |

#### `chunks/C15-payment-gateways/02-TRD.md`

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C15-001 | ACCEPTED-MODIFIED in 08 — All methods callable by staff or system actors only (R8). |
| CR-C15-002 | ACCEPTED-MODIFIED in 08 — Callers system/staff only (no patient/portal context); `collected_by_membership_id` NULL for gateway capture (R8). |
| CR-C15-003 | ACCEPTED in 08 |
| CR-C15-004 | ACCEPTED in 08 |
| CR-C15-005 | ACCEPTED in 08 |
| CR-C15-006 | ACCEPTED in 08 |
| CR-C15-007 | ACCEPTED in 08 |
| CR-C15-008 | ACCEPTED in 08 |
| CR-C15-009 | ACCEPTED in 08 |
| CR-C15-010 | DEFERRED in 08 — C6 has not agreed; portal checkout out of v1; patient app hosted flow only (R8). |
| CR-C15-011 | ACCEPTED in 08 |
| CR-C15-012 | MERGED in 08 into CR-C4-012 |
| CR-C15-013 | ACCEPTED in 08 |

#### `chunks/C16-patient-engagement/02-TRD.md`

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C16-001 | ACCEPTED in 08 |
| CR-C16-002 | ACCEPTED in 08 |
| CR-C16-003 | ACCEPTED in 08 |
| CR-C16-004 | ACCEPTED-MODIFIED in 08 — Binding by endpoint family (`/v1/identity/auth/patient/*`), not a header; lifetimes 14 d idle / 30 d absolute = DECISION (R10). |
| CR-C16-005 | ACCEPTED-MODIFIED in 08 — Token-hash params `bytea` (R24). |
| CR-C16-006 | ACCEPTED-MODIFIED in 08 — Token hashes `bytea`; `v_pub_booking_address` dropped (R25). |
| CR-C16-007 | ACCEPTED in 08 |
| CR-C16-008 | ACCEPTED in 08 |
| CR-C16-009 | ACCEPTED-MODIFIED in 08 — New purposes `booking_cancelled`, `booking_reminder` (R13). |
| CR-C16-010 | ACCEPTED in 08 |
| CR-C16-011 | ACCEPTED-MODIFIED in 08 — `display.queue` → `staff.engagement.queue_display`; fallback id `portal.app_fallback`. |
| CR-C16-012 | ACCEPTED-MODIFIED in 08 — Keep `v_pub_booking_daily`, `v_pub_queue_daily` (C8); address and membership via EngagementPort (R25). |
| CR-C16-013 | ACCEPTED in 08 |
| CR-C16-014 | ACCEPTED-MODIFIED in 08 — Via `EngagementPort.getActiveMembership` (stubbed until C16 ships). |
| CR-C16-015 | MERGED in 08 into CR-C14-001 |
| CR-C16-016 | ACCEPTED in 08 |
| CR-C16-017 | ACCEPTED in 08 |
| CR-C16-018 | ACCEPTED-MODIFIED in 08 — Per-IP limits stay coarse DoS guards (carrier CGNAT); session resolve 120/min/IP; 04 §4 identity limits enforced in app (R6). |
| CR-C16-019 | ACCEPTED-MODIFIED in 08 — Renamed to 2 segments (§4.4). |
| CR-C16-020 | DEFERRED in 08 — Needs founder B11 first (F-05). |
| CR-C16-021 | DEFERRED in 08 — Out of v1 scope (C16 01-PRD §4.2). |

#### `chunks/C17-home-collection/02-TRD.md`

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C17-001 | ACCEPTED-MODIFIED in 08 — Single order owner per booking type (R7); C4 cancel consumer resolves `home_collection` links by `home_visit_id`. |
| CR-C17-002 | MERGED in 08 into CR-C10-003 — Use `lookupSpecimens({orderId})`. |
| CR-C17-003 | ACCEPTED in 08 |
| CR-C17-004 | ACCEPTED-MODIFIED in 08 — Kind `staff_mobile`; opaque session token + server-held GoTrue refresh token, same model as patient (R10). |
| CR-C17-005 | ACCEPTED in 08 |
| CR-C17-006 | ACCEPTED in 08 |
| CR-C17-007 | ACCEPTED in 08 |
| CR-C17-008 | ACCEPTED in 08 |
| CR-C17-009 | ACCEPTED in 08 |
| CR-C17-010 | ACCEPTED in 08 |
| CR-C17-011 | ACCEPTED in 08 |
| CR-C17-012 | ACCEPTED in 08 |
| CR-C17-013 | ACCEPTED in 08 |

#### `chunks/C18-legacy-migration/02-TRD.md`

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C18-001 | DEFERRED in 08 — B4: contract design accepted in principle; no DDL before B4 lifts (founder timing). |
| CR-C18-002 | DEFERRED in 08 — B4. |
| CR-C18-003 | DEFERRED in 08 — B4. `getAnalyteHistory.includeLegacy` already reserved. |
| CR-C18-004 | DEFERRED in 08 — B4. Bucket name reserved `reporting-legacy` (R26). |
| CR-C18-005 | DEFERRED in 08 — B4. |
| CR-C18-006 | DEFERRED in 08 — B4. |
| CR-C18-007 | DEFERRED in 08 — B4. |
| CR-C18-008 | ACCEPTED in 08 |
| CR-C18-009 | DEFERRED in 08 — B6/B7 auditor (F-07). |
| CR-C18-010 | ACCEPTED in 08 |

---

## 9. Global mechanical replacements (run after §1–§8; scope = `program/*.md` except `_cr-extract.md` and `08-CR-REGISTER.md`, and `chunks/**/*.md`; CR history text inside "Change requests raised" sections is left unchanged)

| # | Find (regex, PCRE) | Replace | Reason |
|---|---|---|---|
| M1 | `\banalytics\.export(?![_a-z.])` | `analytics.data.export` | R19 (must not touch `analytics.export_not_ready` etc.) |
| M2 | `\bbilling\.export(?![_a-z.])` | `billing.data.export` | R19 (must not touch `billing.export_too_large`) |
| M3 | `\bbilling\.release_override\b` | `billing.release.override` | R19 |
| M4 | `` `tenant-assets` `` / `'tenant-assets'` | `identity-assets` (same quoting) | R26 |
| M5 | bucket `` `exports` `` / `'exports'` **only on lines that also contain `bucket`** (C2 05-SCHEMA audit exports) | `identity-exports` | R26 (C3/C8 `exports` tables are not buckets — leave) |
| M6 | `` `trf` `` / `'trf'` **only on lines that also contain `bucket`** | `frontdesk-trf` | R26 (the word TRF elsewhere is the form, not a bucket) |
| M7 | `\breport-inputs\b` | `reporting-inputs` | R26 |
| M8 | `\breport-prints\b` | `reporting-prints` | R26 |
| M9 | `\binstrument-attachments\b` | `instruments-attachments` | R26 |
| M10 | `\bOtpCodeInput\b` → `OtpInput`; `\bSecretRevealField\b` → `SecretRevealOnce`; `\bStatusTimeline\b` → `Timeline`; `\bJsonDiffView\b` → `DiffTable`; `\bStatusBadge\b` → `StatusChip`; `\bMoneyInput\b` → `MoneyField`; `\bAsyncCombobox\b` → `Combobox`; `\bFileDropzone\b`, `\bFileDrop\b` → `FileUpload`; `\bDualDate\b` → `DateText` (mode `AD_BS`) | as listed | R22 (only in 04-UI-UX, 02-TRD, 06 plan files) |
| M11 | `\banalytics\.referral_report\.view\b` | `referral_report.view` | R20 (access-log code; the **permission** `analytics.referral_report.read` is unchanged) |
| M12 | `\bmicro\.culture\.view\b` → `culture.view`; `\bmicro\.breakpoint_set\.(import\|activate\|retire)\b` → `breakpoint_set.$1`; `\bmicro\.instrument_record\.assign\b` → `micro_instrument_record.assign` | as listed | R20 (C10 only) |
| M13 | `\bengagement\.link_code\.issue\b` → `link_code.issue`; `\bengagement\.link\.redeem\b` → `app_link.redeem` **only in access-log contexts** (the permission `engagement.link.redeem` stays); `\bengagement\.link\.revoke\b` → `app_link.revoke` **only in access-log contexts** (permission `engagement.link.revoke` stays); `\bmembership\.lookup\b` → `patient_membership.lookup`; `\bengagement\.account\.delete\b` → `patient_account.delete` | as listed | R20 (C16) — an access-log context is a line containing `access_log`, `audit.access` or `access-log` |
| M14 | `\blistOrderSpecimens\b` | `lookupSpecimens` (then fix the call shape per §8.17) | R11 |
| M15 | `X-Lims-Origin` | remove the clause; use the wording of §8.13 / §8.16 | R10 |
| M16 | `\bbilling\.tax_config_missing\b` (outside CR history) | `catalog.tax_config_missing` | R18 |
| M17 | `TenantSettings\.letterhead\b` | `TenantSettings.branding` | R21 |

## 10. Verification after apply (all must return nothing unless noted)

```bash
cd docs   # repo docs root (program/, chunks/)
# R19 permission format: no two-segment permission codes left
grep -rnoE '\b(analytics\.export|billing\.export|billing\.release_override)\b' program chunks | grep -v -e '_cr-extract' -e '08-CR-REGISTER' -e 'Change requests raised'
# R10: hook path gone
grep -rn 'custom_access_token_hook\|lims_auth_hook\|resolve_membership_for_subject\|LIMS_CORE_CLAIMS_SOURCE\|X-Lims-Origin' program chunks | grep -v -e _cr-extract -e 08-CR-REGISTER
# R26: old bucket names gone (outside CR history)
grep -rnE "tenant-assets|report-inputs|report-prints|instrument-attachments" program chunks | grep -v -e _cr-extract -e 08-CR-REGISTER
# R24: no text token hashes
grep -rnE '_sha256\s+text' chunks/*/05-SCHEMA.md
# R25: views dropped
grep -rn 'v_pub_booking_address\|v_pub_patient_membership' program chunks | grep -v -e _cr-extract -e 08-CR-REGISTER
# R18: C4 tax table gone
grep -rn 'billing\.tax_codes' chunks/C4-frontdesk-billing
# R20: every access-log code has exactly two segments (manual check of hits)
grep -rhoE "action: ?'[a-z_.]+'" chunks | sort -u
# R3: no derived-branch wording left
grep -rn 'derived: the distinct `branch_id`' chunks/C0-foundation-contracts
# R7: C16 note replaced
grep -n 'pre-registers an order for \*\*every\*\* booking kind' chunks/C16-patient-engagement/02-TRD.md
# Status tables present in all 19 TRDs (expect 19)
grep -l 'Status per `program/08-CR-REGISTER.md`' chunks/*/02-TRD.md | wc -l
# research/04: exactly three cells changed + three log rows (diff review); N10 untouched
```
Manual checks: 03-IC §4 port blocks compile as TypeScript when extracted (tools/codegen dry run in C0's first task); permission registry passes `^[a-z_]+\.[a-z_]+\.[a-z_]+$`; access-action seed passes `^[a-z_]+\.[a-z_]+$`; routes.yaml ids unique; errors.yaml codes unique (08 §4 already checked for collisions with the current 03-IC).
