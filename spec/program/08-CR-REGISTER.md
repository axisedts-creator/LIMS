# 08 — CR Register (arbitration of all 245 change requests)

Status: **DECISION, 2026-11-06** (contract arbiter). Input: `program/_cr-extract.md` (220 CRs from 19 chunk TRDs), checked against `research/04-consolidated-decisions.md` (wins), `00-scope-baseline.md`, `program/01`–`07`, and the chunk documents where a CR's context needed it.

How to use this file:
- §2 is binding. When it differs from a chunk document, this file wins until the apply phase (`program/_apply-plan.md`) has edited that document.
- §3 has one row per CR. "Docs to update" names the documents the apply phase edits. A chunk document that assumed a CR exactly as accepted needs only a status change ("CR raised" → "ACCEPTED in 08").
- §4 is the consolidated content that goes into `03-INTERFACE-CATALOG.md` (and 02-CV, 01) in the apply phase. Where §4 and a CR's proposed text differ, §4 is final.
- §5 lists decisions this file does **not** make (founder, client, auditor), with the default every chunk builds against.

Decision rules applied, in order: (a) keep 04 decisions intact; (b) keep chunk boundaries (01 §5 R1–R5); (c) prefer additive/backward-compatible; (d) prefer the safer option for tenant isolation and PHI. No CR that weakens a security requirement was accepted without a compensating control. No UNVERIFIED or BLOCKED item was resolved by assertion: where a CR depended on one, the dependency is kept and named.

Decision vocabulary: **ACCEPT** (as proposed) · **ACCEPT-MODIFIED** (accepted with the change stated in Notes / §2) · **MERGED-INTO CR-x** (the need is met by CR-x's final text) · **REJECT** · **DEFER** (not decided now; reason and trigger stated) · **FOUNDER** (founder decision; not made here, §5).

---

## 1. Decision summary

| Decision | Count |
|---|---|
| ACCEPT | 159 |
| ACCEPT-MODIFIED | 56 |
| MERGED-INTO | 19 |
| REJECT | 0 |
| DEFER | 10 |
| FOUNDER | 1 |
| **Total** | **245** |

Per raising chunk:

| Chunk | ACCEPT | ACCEPT-MODIFIED | MERGED-INTO | REJECT | DEFER | FOUNDER | Total |
|---|---|---|---|---|---|---|---|
| C0 | 4 | 5 | 1 | 0 | 0 | 0 | 10 |
| C1 | 5 | 3 | 0 | 0 | 0 | 1 | 9 |
| C2 | 8 | 10 | 1 | 0 | 0 | 0 | 19 |
| C3 | 4 | 4 | 1 | 0 | 0 | 0 | 9 |
| C4 | 6 | 4 | 3 | 0 | 0 | 0 | 13 |
| C5 | 9 | 0 | 3 | 0 | 0 | 0 | 12 |
| C6 | 14 | 3 | 1 | 0 | 0 | 0 | 18 |
| C7 | 12 | 2 | 0 | 0 | 0 | 0 | 14 |
| C8 | 12 | 2 | 1 | 0 | 0 | 0 | 15 |
| C9 | 7 | 1 | 0 | 0 | 0 | 0 | 8 |
| C10 | 5 | 4 | 1 | 0 | 0 | 0 | 10 |
| C11 | 8 | 1 | 2 | 0 | 0 | 0 | 11 |
| C12 | 9 | 1 | 1 | 0 | 0 | 0 | 11 |
| C13 | 12 | 1 | 1 | 0 | 0 | 0 | 14 |
| C14 | 9 | 1 | 0 | 0 | 0 | 0 | 10 |
| C15 | 11 | 3 | 1 | 0 | 0 | 0 | 15 |
| C16 | 11 | 9 | 1 | 0 | 2 | 0 | 23 |
| C17 | 11 | 2 | 1 | 0 | 0 | 0 | 14 |
| C18 | 2 | 0 | 0 | 0 | 8 | 0 | 10 |

Notes: CR-C16-020 and CR-C16-021 were recorded by C16 as "not raised" candidates; they are registered here (DEFER) so the extract's 220 entries are all decided. Counts above are recomputed by script from the §3 table (final sweep 2026-11-06); they include the rows registered after the extract by Addenda A13–A28 and the fix-pass hand-offs (recounted in the final program-doc sync after CR-C2-019, A28.6). CR-C7-012 is counted as ACCEPT (infra rows); its Authenticode item is founder decision F-03. CR-C18-009 was a draft "do not file" CR; it is registered as DEFER (auditor, F-07).

Partial rejections inside ACCEPT-MODIFIED / MERGED rows (no CR was rejected as a whole):
- `lims_auth_hook` role and `app.custom_access_token_hook` (CR-C0-007) — no GoTrue hook path (R10).
- `billing.tax_config_missing` (CR-C4-007) and `billing.tax_codes` — tax rates have one owner, C3 (R18).
- `CatalogPort.searchCommentCodes` (CR-C5-001) — UI picker reads C3's HTTP list, not a port.
- C5's local formula grammar (ternary, `||`/`&&`) (CR-C5-002) — one grammar (R12a).
- `X-Lims-Origin` request header as session-kind binding (CR-C13-003, CR-C16-004) — binding comes from the BFF key or endpoint family (R10).
- `engagement.v_pub_booking_address`, `engagement.v_pub_patient_membership` (CR-C16-012) and C6 reading `catalog.v_pub_department` / `frontdesk.v_pub_order_status` (CR-C6-012) — operational reads use ports (R25).
- Duplicate UI-kit components (CR-C2-016, C3-006, C4-013) — mapped to existing or merged components (R22).
- Generic bucket names `exports`, `trf`, `tenant-assets`, `report-inputs`, `report-prints`, `instrument-attachments` — renamed (R26).
- GoTrue refresh token held by the phlebotomy app (CR-C17-004) — app holds an opaque LIMS session token instead (R10).

---

## 2. Conflict resolutions (binding)

Format per item: **Problem · Options · Decision · Rationale · Affected chunks · Consequences.** R1–R17 are the conflicts named in the arbitration brief; R18–R26 were found during arbitration.

### R1 — Amendment reason on `LabPort.submitModuleResult` (CR-C10-001 + CR-C11-004; CR-C10-002; C11 supplementary report)

- **Problem.** 03-IC §4.5 makes a module submission on an `approved` result an R7 amendment, and `lab.result.amended.v1` requires `amendment_reason_code`, but `SubmitModuleResultInput` has no reason field. C10 needs a reason that stops C6 printing "Amended" on a normal micro final that follows an approved preliminary. C11 needs to tell an addendum (supplementary report) from a correction.
- **Options.** (1) Two fields (C10 shape, C11 shape). (2) One optional `amendment` object plus two seeded reason codes. (3) A separate `submitModuleAmendment` method.
- **Decision.** Option 2. Final shape (identical in both CRs):
  `SubmitModuleResultInput += readonly amendment?: { readonly reasonCode: Code; readonly reasonText?: string /* ≤ 500 chars, P3 */ }`.
  Semantics: required when the target result is `approved` (missing → `lab.amendment_reason_required`), ignored otherwise; `reasonCode` must be an active code of C5's amendment-reason coded set (`lab.g_cs_amendment_reasons` + tenant `lab.cs_amendment_reasons`); the actor still needs `lab.result.amend` (unchanged A1 rule). Seed rows added to `lab.g_cs_amendment_reasons`:
  - `module_phase_progression` — "Final after preliminary report". C5 accepts it only when `payloadRef.module = 'micro'`, `reportPhase = 'final'` and the approved version being replaced was a `preliminary` submission; otherwise `lab.module_result_invalid`.
  - `supplementary_report` — "Supplementary report (addendum)". C5 accepts it only when `payloadRef.module = 'anatomic'`.
  - `module_preliminary_update` — "Updated preliminary report" (added by Addendum A17 D-61). C5 accepts it only when `payloadRef.module = 'micro'`, `reportPhase = 'preliminary'` and the approved version being replaced was a `preliminary` submission; otherwise `lab.module_result_invalid`. `lab.result.amend` is still required.
  C6 report-kind rule (first match wins, evaluated over the sections of the version being rendered): (0) a version produced by Regenerate (R9) after an earlier version was released → `amended`, except reason `smart_summary_added`, which takes the kind from rules 1–4; the regeneration reason text goes into `amendmentNotes` (added by Addendum A13 D-33); (1) any section whose latest amendment reason is **not** in {`module_phase_progression`, `module_preliminary_update`, `supplementary_report`} (exclusion set per Addendum A17 D-61) and an earlier version was released → `amended`; (2) else any section with `supplementary_report` → **`addendum`** (new kind); (3) else any micro section in phase `preliminary` (including one amended with `module_preliminary_update`, D-61) → `preliminary`; (4) else `final` / `partial` per the existing rule. `ReleasedReportSummary.kind`, `reporting.report.released.v1.report_kind` and `reporting.v_pub_report_release.report_kind` gain `addendum` (enum marked `x-extensible: true`, R13).
- **Rationale.** One port shape, additive, no new method; the reason stays in C5's coded set (single owner); the print label follows clinical meaning (an addendum is not a correction) without weakening the A1 chain.
- **Affected.** C5 (implements, seeds), C6 (rule, label "Addendum"), C10, C11, C8/C13/C16 (tolerate new kind), C0-0C (port, event schema).
- **Consequences.** 03-IC §4.5 (input type + contract cases 21–23: approved + amendment → event carries code; approved without amendment → `lab.amendment_reason_required`; `module_phase_progression` from anatomic → `lab.module_result_invalid`); §3.17 enum; §4.7 kind union; §6.4 view note; C5 TRD seeds; C6 TRD report-kind rule; C10/C11 TRD status edits.

### R2 — Anatomic "sign-out" vs final approval (CR-C11-010)

- **Problem.** 06-GLOSSARY says sign-out is "equivalent to approval for C11 reports"; 03-IC §4.5 A1 (higher precedence) puts module results at `resulted`, then C5 verify (R4) and approve (R6, approver ≠ verifier).
- **Options.** (1) Glossary wins (sign-out = approval; C5 skips R4/R6 for anatomic). (2) 03-IC wins; glossary corrected.
- **Decision.** Option 2. Glossary text: "**Sign-out** = the pathologist signs the anatomic report in C11 (`anatomic.case.signout`, privileged), which locks that C11 report version. The result then passes C5 verification and pathologist approval (A1: approver ≠ verifier) before release. Changes after sign-out are C11 addenda or amendments, which reach C5 as amendments (R1)."
- **Rationale.** 03-IC is the binding interface; one release chain for every department.
- **Affected.** C11, C5, glossary.
- **Consequences.** 06-GLOSSARY "Sign-out" row replaced. Whether a sign-out by a holder of `lab.result.approve` may also count as C5 verification is a **client clinical decision** (§5 C-02), default *no*.

### R3 — Branch / centre scope model (CR-C2-003; C0 05-SCHEMA §3.3; C12 R6)

- **Problem.** C0 derives `ActorProfile.branchIds` from the branches of the member's centres; C2 stores explicit `core.membership_branches`; C12 enforces store access with `assertRole({branchId})` and tested both.
- **Options.** (1) Derived only. (2) Explicit only. (3) Union of both.
- **Decision.** Option 2, **explicit branch scope**:
  - `core.membership_branches (tenant_id, membership_id, branch_id)` (C2 05-SCHEMA) is created by C0.
  - `ActorProfile.branchIds` = the member's `membership_branches` rows; `centreScope.all = true` implies every branch (C2 TRD §7.2 rule 6, unchanged).
  - Branch scope is **application-level only** (IdentityPort). No RLS policy uses branches; no `app.current_branch_ids()` helper is created. RLS centre scope (`app.has_all_centres()`, `app.current_centre_ids()`) is unchanged.
  - Branch scope may only guard data of PHI class P0/P1 (today: C12 stores/stock). Any table holding P2/P3 must be centre-scoped by RLS.
  - New CHECK on `core.memberships`: `actor_type = 'user' OR all_centres = false` (`memberships__all_centres_user_only__ck`); `membership_centres` / `membership_branches` rows only for `actor_type = 'user'` (trigger). `app.has_all_centres()` returns `false` explicitly for `portal`, `patient`, `partner`, `device` (02-CV §5.8 CASE rewritten with explicit branches; ELSE false).
- **Rationale.** Least privilege: an inventory user can be given a branch without receiving PHI-bearing centre scope; one meaning per field; fail-closed for non-staff actors.
- **Affected.** C0 (DDL, helper text), C2 (already explicit), C12 (drop "test both models"), every module using `branchId`.
- **Consequences.** C0 05-SCHEMA §3.3 last paragraph replaced; 02-CV §5.8 helper; 03-IC §4.6 note on `branchIds`; C12 06 plan R6 closed; 06-GLOSSARY "Branch" consequence text.

### R4 — `billing.v_pub_payment_collection` column name (CR-C8-010)

- **Decision.** 03-IC §6.2 wins: the column is `payment_method_code`. C0 DDL selects `l.method_code AS payment_method_code`. C4 05-SCHEMA §6 view SQL gets the alias. ACCEPT. Affected: C4, C8, C15 (consumer, CR-C15-009).

### R5 — Glossary `core.centres` and `TO authenticated` (CR-C0-008, CR-C2-015)

- **Problem.** 06-GLOSSARY says table `centres` and policies `TO authenticated`; 03-IC §9.1 says `core.collection_centres`; X9 binds module policies to `lims_app`. **Also found:** research/04 D4 itself still reads "`TO authenticated`", while X9 records that the lead is aligning that wording.
- **Decision.** Glossary rows "Collection centre" and "RLS" fixed (text in apply plan). Minimal 04 edit: D4 "`TO authenticated`" → "`TO lims_app` (group role of the API and worker logins; narrower than `authenticated`, REQ-SEC-015; `authenticated` only on Supabase-served objects — 03-IC X9)". This changes wording, not the decision (X9 is already binding).
- **Affected.** Glossary, 04 D4, C0, C2.

### R6 — Login rate limit 5/min/IP vs labs behind one NAT (CR-C1-009; CR-C2-012; CR-C16-018)

- **Problem.** 04 §4 sets login 5/min/IP. A hub lab and its centres each sit behind one public IP (00 G3); ~60 staff starting at 07:00 exceed 5 logins/min, which pushes staff to share sessions (a worse failure). **Also found:** CR-C2-012 places the per-IP zone on `/v1/identity/auth/login`, which is reachable only from the BFF network — nginx there would see the BFF's IP, not the user's, so the 04 limit would silently become a per-BFF limit.
- **Options.** (1) Keep 5/min/IP everywhere. (2) Raise the limit for everyone. (3) Separate zone for tenant-registered static egress IPs, with compensating controls.
- **Decision.** Option 3, and fix the placement. **Exact amendment text for research/04 §4, "Login" row** (replace the row):

  | Surface | Limit | Enforced at | Source |
  |---|---|---|---|
  | Login | 5/min/IP + 10/hour/account; ≥5 failures → exponential backoff + step-up. **Registered lab egress IPs:** 30/min/IP (burst 10) for staff login and password recovery on the staff-web origin only, for an IP registered for that tenant by a platform superadmin (at most 4 single addresses per tenant, /32 or /128, each audited and re-confirmed every 90 days, otherwise it expires). Per-account limits, backoff and step-up are unchanged. ≥ 20 failed logins within 10 min from one registered IP demotes that IP to 5/min for 60 min and alerts the tenant admin and the LIMS provider on-call. The registered-IP zone never applies to platform-console, partner, patient OTP or staff-mobile login. The per-IP key is the client IP seen by the public edge in front of the BFF or app login route, never the BFF's own address | nginx (per-IP zones; registered set from config) + app (per-account; per-registered-IP failure counter and demotion) | REQ-SEC-064/078 |

  Placement rule (02-CV §10.3, C1, C2): the `login` tier's per-IP part is enforced by nginx on the **public** login routes — staff-web BFF login and recovery routes (C2 lists the paths, CR-C1-004), partner-BFF login (C13), `/v1/identity/mobile/sessions` (C17), `/v1/engagement/auth/otp-challenges*` (C16). The BFF forwards the client IP (header set by nginx, trusted only from nginx); the identity module applies per-account limits and the registered-IP demotion.
  C16-018's extra per-IP limits are DoS guards, not 04 limits: OTP challenge/verify 5/min/IP stays ([CONV], stricter than 04's 3/hour/phone, which still applies in the app); patient session resolve becomes 120/min/IP because carrier-grade NAT puts many patients behind one IP; per-session limits apply in the app (`general` tier).
- **Rationale.** The per-IP limit slows credential stuffing from one source. A registered IP is the tenant's own premises. The primary brute-force controls stay unchanged (per-account limits, backoff, MFA for privileged roles, breached-password list — REQ-SEC-064, 04 A2/A3/A4). The compensating controls are: an audited, expiring, tightly bounded registration; failure-based automatic demotion; alerting; and exclusion of every non-staff and platform login.
- **Affected.** C1 (zones, config generation), C2 (registration UI in platform console, failure counter, demotion, forwarded IP), C0 (`login` tier description), C13, C16, C17.
- **Consequences.** research/04 §4 row; 02-CV §10.3 `login` row; C1 TRD; C2 TRD (new platform operation `setTenantEgressIps`, access-log action `tenant_egress_ip.change`, error `identity.egress_ip_limit` 422); C16 TRD §11 limits. Founder signs the 04 edit as doc owner. The static IP of each lab is client information (§5 C-03).

### R7 — Duplicate orders for home-collection bookings (CR-C17-001; C4 booking consumer; C16 TRD §4.7 note / R-5)

- **Problem.** C4's `engagement.booking.confirmed.v1` consumer pre-registers an order for every booking, and C17 also creates an order for home visits through `createOrderFromBooking(source 'home_collection')` → two orders.
- **Options.** (1) C17 confirms C4's pre-registered order (needs a new FrontdeskPort method with payment/fingerprint semantics). (2) C4 ignores home-collection bookings; C17 is the order creator. (3) C16 stops sending home-collection bookings to C4.
- **Decision.** Option 2. **Single order-creation owner per booking type:**

  | Origin | Order created by | Path | Status at creation |
  |---|---|---|---|
  | Walk-in at the desk | C4 | registration HTTP | `registered` |
  | C16 booking, `booking_kind = centre_visit` | C4 | consumer of `engagement.booking.confirmed.v1` (`source engagement_booking`, `sourceRefId = booking_id`) | `pre_registered` (confirmed at the desk) |
  | C16 booking, `booking_kind = home_collection` | **C17** | `FrontdeskPort.createOrderFromBooking({source:'home_collection', sourceRefId: visit_id, confirmImmediately: true})` at assignment | `registered` |
  | Staff-created home visit (no booking) | C17 | same as above | `registered` |
  | Partner manifest line | C13 | `createOrderFromBooking({source:'partner_manifest', partnerId, …})` from the C13 worker | per C13 mode |

  C4 changes: the `booking.confirmed` consumer records the event in its inbox and **does nothing** for `home_collection`. The `booking.cancelled` consumer: `centre_visit` → existing behaviour; `home_collection` with `home_visit_id` present → look up `booking_links (source 'home_collection', source_ref_id = home_visit_id)`; if a `registered` order exists → raise review item `booking_cancelled_after_registration` (no automatic cancel; credit notes stay a C4 desk action). C17's consumer keeps flagging `order_cancel_required` on the visit. `createOrderFromBooking` authorisation per source (C4-internal `assertRole`): `engagement_booking` → system actor only; `home_collection` → `homecollection.visit.assign` (dispatcher) or system; `partner_manifest` → system actor of `partners` or `partners.manifest.receive`. The cash invoice issued for a home-collection order records the dispatcher as creator (IRD per-user audit trail); `billing.invoice.issue` is not additionally required for that path.
- **Rationale.** Keeps X5 (C16 by event, C13/C17 by port); no new port method; one owner per order origin; C17 needs the order at assignment for barcodes.
- **Affected.** C4, C16, C17.
- **Consequences.** 03-IC §3.22 consumer text ("C4: `centre_visit` only"), §3.24 C4 consumer text, §4.3 semantics row; FrontdeskPort contract cases (11) home_collection `booking.confirmed` → no order; (12) cancel with linked registered home order → review item. C4 TRD §8; C16 TRD §4.7 note and 06 R-5 replaced by a reference to R7; C17 TRD status.

### R8 — Patient-context payments (C15 F-04; C16 TRD §4.7; C4 RLS; CR-C15-001/002/010)

- **Problem.** C15 F-04 calls `createIntent` in the patient's context, but `createIntent` reads C4 tables through FrontdeskPort/BillingPort, which are invisible to patient actors (centre-scoped RLS, fail-closed; and R10's actor-type guard). C16 instead creates intents in a worker as the engagement system actor. 03-IC §4.4 says C15 may call BillingPort "under the patient/portal request context".
- **Options.** (1) Add patient-actor RLS policies on C4 billing/frontdesk tables. (2) A core "act as system" escape inside a patient request. (3) Worker/system-actor pattern for every cross-module call made on behalf of a non-staff actor.
- **Decision.** Option 3, as a program rule (**non-staff actor rule**, new 02-CV §8.5):
  1. Request handlers for `patient`, `portal` and `partner` actors read and write only their own module's tables (projections) plus owner-supported actor-specific reads, which are exactly: `ReportingPort.getReleasedReports` / `openReleasedReportFile` / `redeemPortalLinkForApp` (partner, patient — CR-C13-005, C16-008) and `SmartReportPort.buildSummary` read-only (patient, portal, partner — CR-C14-006).
  2. Any other cross-module call on their behalf runs in the module's worker as its **system actor**, after the module has checked the actor's ownership in its own tables.
  3. `PaymentProviderPort` (all methods) and `BillingPort` (all methods) are callable only by staff (`user`) or `system` actors. 03-IC §4.4 "or under the patient/portal request context" is deleted.
  C16 flow: `createPaymentRequest` (patient) inserts `payment_requests` and enqueues `engagement.create_payment_intent` (system) → `createIntent`; status polling by the patient reads `payment_requests` only; when a request is `ready` and was last checked ≥ 3 s ago, the GET enqueues `engagement.refresh_payment_request` (job_key per request) which calls `getIntent` as system and updates the row. Return/cancel URL = `<PORTAL>/app/payments/{payment_request_id}/done` (C16 owns the route; C15 F-04 text changed from `<intent>`). C4: `recordGatewayPayment`/`recordGatewayRefund` set `collected_by_membership_id = NULL` for `capture_kind = 'gateway'` (CHECK: NULL iff gateway). C6 portal checkout (CR-C15-010) is **deferred** (C6 has not agreed; out of v1).
- **Rationale.** No new PHI read path for patient actors into billing; no privilege-switch primitive in the core; same pattern C13 already uses (C13 TRD §3.2).
- **Affected.** C15, C16, C4, C6, C13.
- **Consequences.** 03-IC §4.4 tenant-context row, §4.9 caller note; C15 03-APP-FLOW F-04 redrawn, F-05 marked deferred; C16 TRD §4.7 step 3 changed; C4 TRD/05-SCHEMA (CHECK); 02-CV §8.5 new.

### R9 — Production phase stubs (CR-C0-010)

- **Decision.** ACCEPT-MODIFIED. 02-CV §8.2 gets one exception: in staging/production a port may resolve to a **phase stub** (`packages/fakes/src/stubs/<Port>.stub.ts`) only if listed in `services/api/src/core/ports/phase-stubs.ts` (C0-0D). Initial list and behaviour:

  | Port | Stub behaviour | Removed when |
  |---|---|---|
  | `QualityPort` | `canAutoVerify` → `deny` [`feature_disabled`]; `qcStatusFor` → `no_qc_data` (03-IC §4.11) | C9 module present |
  | `SmartReportPort` | throws `smartreport.feature_disabled` | C14 present |
  | `PaymentProviderPort` | every method (incl. `getIntent`, `cancelIntent`) throws `payments.gateway_not_available` | C15 present |
  | `EngagementPort` | `getActiveMembership` → `undefined`; `getHomeAddress` → `common.not_found` | C16 present |

  Stubs never allow, never return data, have no seeding or failure injection, pass the `phase1Stub` subset of the contract suite, and are counted by `lims_core_phase_stub_ports_active`. CI fails if a listed port's owner module exists.
  **Replacing a phase stub (Addendum A17 P-20).** The first PR that creates `services/api/src/modules/<owner>/` removes the port from `phase-stubs.ts` (paired C0-0D PR; AC-0D-6.3 unchanged). In the same PR the module registers its own port implementation, which returns exactly the stub results for every method not yet built and passes the `phase1Stub` contract subset. Each later task replaces one method and adds that method's full contract cases. No C0 manifest flag is added. `RenderPort`, `BillingCommandPort` and the deferred `Legacy*ImportPort`s get no stub (owners ship in the consumers' phase, or nothing consumes them).
- **Affected.** C0, C4 (EngagementPort consumer), C5 (QualityPort), C6 (SmartReportPort), C16, C15, C9, C14.

### R10 — Claims architecture and session kinds (CR-C2-005, C2-009, C2-004, C0-003, C0-007, SP-1; CR-C13-003, C16-004, C17-004)

- **Problem.** C0 prefers a GoTrue custom access-token hook (SP-1) with a membership-lookup fallback; C2 makes a server-side session lookup the only path; C13, C16 and C17 add session kinds; C13/C16 bind kinds with a request header `X-Lims-Origin`; C17 wants the native app to hold a GoTrue refresh token.
- **Options.** (1) Hook path (claims in JWT). (2) Session-resolved claims (C2). (3) Both, switchable by `LIMS_CORE_CLAIMS_SOURCE`.
- **Decision.** Option 2, one architecture for every environment:
  1. **Credential verification (C0 core).** Security schemes and their only resolvers:

     | Scheme | Credential | Resolver (module) | Actor type |
     |---|---|---|---|
     | `bearerJwt` | GoTrue access JWT (alg pinned, 0 s leeway, iss/aud — 04 A7) | identity `claimsResolver` (mandatory) | `user` / `partner` / `patient` |
     | `bffSession` | `__Host-lims_sid` cookie forwarded by a BFF **plus** `X-Lims-Bff-Key` | identity (only `/v1/identity/auth/*`) | — |
     | `deviceToken` | bearer `lims-device-credential` | instruments | `device` (`device_kind = bridge_agent`) |
     | `queueDisplayToken` | header `X-Lims-Display-Token` | engagement | `device` (`device_kind = queue_display`) |
     | `portalSession` | header `X-Lims-Portal-Credential` (`link.`/`session.`) | reporting | `portal` |
     | `patientPreAuth` | header `X-Lims-Patient-PreAuth` | engagement | `patient` (`patient_stage = pre_auth`, no membership) |
     | `paymentCallbackToken` | path param `callback_token` | payments | `system` (payments system actor) |
     | worker | job payload `tenant_id` | worker core | `system` |

     BFF key kinds (`X-Lims-Bff-Key`): `staff_web`, `partner`, and `portal` [CONV] (added by Addendum A13 D-32). `apps/portal` calls the API on the internal network with a `portal` key and forwards `X-Forwarded-For` as received from the public nginx (which overwrites it). The core sets `app.client_ip` from `X-Forwarded-For` (single hop; nginx overwrites it, C1 TRD §6.6) only when (a) the request carries a valid `X-Lims-Bff-Key`, or (b) the TCP peer address is in `LIMS_CORE_TRUSTED_PROXY_CIDRS` [CONV; C1 sets it to the nginx container address on `edge_net`]. Otherwise the core uses the peer address. Module code reads only `ctx.clientIp`; it never parses a header. (Addendum A25 P-61 replaces the earlier sentence.) Tiers `qr_verify`, `otp_request` and `otp_verify` key on `app.client_ip`. The nginx `limit_req` 10 r/m/IP applies only to public `/v/*` on the portal origin, not to `/v1/reporting/verifications`.
     **BFF key secrets (Addendum A19 P-45).** Each BFF holds its own `X-Lims-Bff-Key` as a file-mounted secret from the C1 secret store: `LIMS_WEB_BFF_KEY_FILE` (kind `staff_web`), `LIMS_PARTNER_BFF_KEY_FILE` (`partner`), `LIMS_PORTAL_BFF_KEY_FILE` (`portal`) [CONV]. The key lives in server memory only and is never logged or sent to a browser. Rotation follows the C1 runbook, with the core accepting old and new keys for one overlap window. C0 `LIMS_CORE_BFF_KEY_FILES` lists all three kinds.
  2. **For every GoTrue JWT the identity `claimsResolver` is the only claims source**: `app.identity_resolve_session(gotrue_session_id, sub)` → `identity.sessions` row → claims JSON written to `request.jwt.claims`. Claims inside the JWT other than `sub`, `session_id`, `aal`, `exp`, `iat` are ignored. The GoTrue custom access-token hook is **not used**: `app.custom_access_token_hook`, role `lims_auth_hook`, `app.resolve_membership_for_subject` and `LIMS_CORE_CLAIMS_SOURCE` are removed from C0's design. Revocation, lock, suspension and timeouts act on the next request.
  3. **Session kinds** (`identity.sessions.kind`, C2):

     | Kind | Client | Endpoint family | Binding | Idle / absolute | Claims |
     |---|---|---|---|---|---|
     | `tenant_staff` | staff-web BFF | `/v1/identity/auth/*` | BFF key = staff_web | 15–30 min / ≤ 12 h (04 A8) | `{sub, tenant_id, membership_id, actor_type:'user', aal, lims_session_id, session_state}` |
     | `platform` | staff-web BFF, `(platform)` group | `/v1/identity/auth/*` | BFF key = staff_web + `platform_staff` login | 15–30 min / ≤ 12 h | `{sub, actor_type:'user', scope:'platform', platform_staff_id, platform_role, aal, lims_session_id}`; with support session `{…, tenant_id, scope:'support', support_session_id, support_scope}` (no membership → fail-closed centres) |
     | `partner` | partner BFF (`apps/partner`) | `/v1/identity/auth/partner/*` | BFF key = partner | 15–30 min / ≤ 12 h | `{sub, tenant_id, membership_id, actor_type:'partner', aal, lims_session_id, session_state}` |
     | `patient` | patient app (no BFF) | `/v1/identity/auth/patient/*` | endpoint family | 14 d / 30 d [DECISION; tenant-configurable 1–30 / 1–90 d] + app lock (`LimsAppLockGate`) | `{sub, tenant_id, membership_id, actor_type:'patient', aal:'aal1', lims_session_id, session_state:'active'}` |
     | `staff_mobile` | phlebotomy app | `/v1/identity/mobile/sessions*` | endpoint family; only memberships holding `homecollection.sync.upload` | no idle (04 A16 local re-auth instead) / ≤ 12 h (04 A8) | as `tenant_staff` |

     For `patient` and `staff_mobile` the app holds an **opaque 256-bit LIMS session token** (secure storage, 04 A15) and a short access JWT (≤ 1 h, 04 A5); GoTrue refresh tokens stay server-side, encrypted (C2 TRD §4 item 3). Refresh: `POST …/refresh` with the session token; the session token rotates on every refresh; a reused old token revokes the session (reuse detection in C2, independent of the UNVERIFIED GoTrue setting 04 A6). Offline uploads refresh first (04 A7).
     Kind binding is derived from the BFF key or the endpoint family; a session of one kind presented on another family → `401 auth.session_expired`; a staff credential on partner login (and vice versa) → `401 auth.login_failed`. No `X-Lims-Origin` header is trusted.
  4. **Platform context.** Platform handlers are authorised by C2 `PlatformAuthz` (never `IdentityPort.assertRole`, which refuses `platform.*`). `ctx.db.withTenantScope` exists only in platform context of module `identity`, only for operationIds listed in core config (`provisionTenant`, `inviteTenantAdmin`, `activateTenant`, `suspendTenant`, `reactivateTenant`, `terminateTenant`, `updateTenantSettingsAsPlatform`, `setFeatureFlagAsPlatform`; ~~`setTenantEgressIps`~~ struck per Addendum A1; plus `openSupportSession`, `activateSupportSession`, `endSupportSession`, `revokeSupportSession` (only where C2 TRD §5.10 runs them in platform context) and `getDeadLetter` — Addendum A25 D-214), and every use writes a tenant access-log entry (`tenant.lifecycle_change`, `settings.change`, `support_session.open` / `.activate` / `.close` / `.revoke`, `dead_letter.view` — all existing seed codes). Core-internal uses outside module `identity`: the worker-core cron fan-out (A23.1) and `ctx.core.deadLetters.replay` of a tenant row (A23.2), each under the owning module's system actor. Patient-context `IdentityPort` writes (`provisionPatientMembership`, `openPatientSession`, `revokePatientSessions`) run their identity/core writes inside `withTenantScope(ctx.tenantId, <identity system actor>)`; the patient actor never writes identity tables directly; still gated by D-218 (C2 T1) (Addendum A28.2). No module code calls `withTenantScope`. Pre-auth and session operations of module `identity` use `ctx.db.identityAuthTx` instead (Addendum A25 D-212; allowlist and bounds in 02-CV §6 and 03-IC §13.5).
  5. **Defence in depth.** CR-C13-011 accepted: every `__tenant` policy of a table not meant for non-staff actors adds `AND (SELECT app.is_staff_or_system())` (`actor_type IN ('user','system','device')`); tables that serve partner/patient/portal actors get explicit actor-specific policies. With R3's CHECK and explicit `has_all_centres()`, non-staff actors never get centre scope.
  6. **SP-1 rescoped** (C0): prove that the pinned GoTrue issues `session_id` and `aal` claims and which `alg` it uses. If `session_id` is absent, that is a **blocker for C2 T1** (raise to 07, not assumed away); development continues against the fake resolver.
- **Rationale.** Removes the dependency on an UNVERIFIED hook; live revocation; one code path per credential; header-based binding replaced by credentials the server controls.
- **Affected.** C0, C2, C13, C16, C17, C6 (portal resolver unchanged), C7, C15.
- **Consequences.** 02-CV §6 rewritten (text in apply plan); C0 TRD §6.5, §17, 05-SCHEMA §4.6; C2 TRD §4, §5.1 (`SessionState.kind` enum), §6.1 (`ResolvedClaims` kinds), §6.2; C2 05-SCHEMA `identity.sessions.kind` CHECK; identity.yaml gains `loginPartner`, `resolvePatientSession`, `logoutPatientSession`, `openMobileSession`, `refreshMobileSession`, `logoutMobileSession`; C13/C16/C17 TRDs drop `X-Lims-Origin`.

### R11 — Overlapping port additions (CatalogPort, LabPort, FrontdeskPort, IdentityPort, ReportingPort)

- **Problem.** Several chunks asked for overlapping methods with different shapes.
- **Decision.** One coherent v1 set per port; every port keeps `*_PORT_VERSION = 1` (all additive). Final TypeScript in §4.14. Merges:
  - **CatalogPort:** C3's shapes (CR-C3-001) win. `getCreditParty` gains purpose `billing` returning `pan` and `billingAddressText` (C4-002 need). `resolveCommentCodes` = C3 shape + optional `asOf` (C5-001); `searchCommentCodes` is not a port method. `TestDefinition` gains `departmentName` (C6 render, R25) and `usesExistingMaterial` (C11-009). Consumers += C13 (C13-007).
  - **LabPort:** `lookupSpecimens` (C10-003) absorbs `listOrderSpecimens` (C17-002) through a third selector `{orderId, statuses?}`; plus `getOrderItemProcessingState` (C4-003), `listPendingForInstrument` (C7-005), `getAnalyteHistory` (C14-002, with `includeLegacy` reserved for C18), `OrderResults.specimens[].barcode` and `ResultView.moduleRef` (C6-006), `SubmitModuleResultInput.amendment` (R1); JSDoc/contract fixes CR-C5-008, CR-C7-011.
  - **FrontdeskPort:** purposes `result_evaluation`, `lab_display` (C5-003), `patient_app_link` (C16-007); `home_visit` allowlist += `birthOn`, `sex` (C17-003); `contactPresence` for non-system `notification` callers (C6-015); `status` on `PatientDemographics`; `getPatientDemographicsBatch`; `createSelfRegisteredPatient`; `BookingOrderInput.partnerId`, `OrderSummary.partnerId` (C4-006, R25).
  - **IdentityPort:** `getSignatories`, `readBrandingAsset` (C6-007); `provisionPartnerMembership`, `updatePartnerMembership` (C13-003); `provisionPatientMembership`, `openPatientSession`, `revokePatientSessions` (C16-004); migration actor semantics deferred (C18-007); TenantSettings merged (R21).
  - **ReportingPort:** `openReleasedReportFile` for partner and patient actors (C13-005, C16-008a); `redeemPortalLinkForApp` (C16-008b); kind `addendum` (R1).
  - **Also:** NotificationPort purposes (R13); PaymentProviderPort `launchUrl`, `getIntent`, `cancelIntent` (C15-001, callers per R8); BillingPort `recordGatewayRefund`, `allowExceedsDue` (C15-002); SmartReportPort display fields + actor rules (C14-001/006, C16-015); QualityPort `qc_warning` (C9-003); new ports `BillingCommandPort` (C4-001), `RenderPort` (R12c), `EngagementPort` (C17-005 + R25).
- **Affected.** All port owners and consumers; C0-0C (types, fakes, contract suites).

### R12 — Duplicate shared-library CRs

**R12a Formula grammar (CR-C3-002 vs CR-C5-002).** One grammar, text owned by C3 (C3 TRD §7.1, catalog master data), implemented once by **C0-0A** in `@lims/shared-ts/formula`; C3 validates and C5 evaluates with the same parser. Changes to C3's text: function list += `log10`. Numeric semantics (binding): `+ − × ÷` and comparisons in exact decimal arithmetic with ≥ 28 significant digits (`@lims/shared-ts/decimal`, implementation pinned by C0-0A within the licence allowlist); `sqrt`, `ln`, `log10`, `exp` and `pow` with a non-integer exponent are computed in IEEE-754 double, rounded to 15 significant digits and mark the result `inexact: true` (C5 stores it in provenance). C5's ternary and `||`/`&&` are not in the grammar. Missing input → `{ok:false, reason:'missing_input:<CODE>'}`; C5 maps that to its `waiting_for_inputs` state. Golden vectors G1–G10 + C5's additions in `packages/fakes/contract-tests/formula.vectors.json`; both chunks run them. Final signatures in §4.14.

**R12b Upload / scan / storage pipeline (CR-C2-011 primary; CR-C4-005, C3-005, C10-008 merged; C7-007, C11-008, C6-009 buckets and options).** One core API owned by C0-0D (`ctx.uploads`, `ctx.files.scan`, `ctx.storage`), buckets and policies by C0-0B, scanner service by C1. Final API in §4.13. Rules: per-route MIME allowlist ⊆ {pdf, jpeg, png, csv, xlsx}; ≤ 15 MB (attachments route 16 MB body incl. metadata, CR-C7-009); malware scan **mandatory in staging and production** for every type except `text/csv` (UTF-8, no NUL, never rendered, served only as attachment); scan unavailable → object stays quarantined (fail closed); image re-encode strips metadata (EXIF/GPS), `maxMegapixels` guard; `put` supports `ifAbsent` (write-once); first path segment = `ctx.tenantId`, enforced by the adapter; a module may write only buckets whose name starts with its module prefix (except `reports`, owned by `reporting`). Storage RLS with self-hosted claims stays UNVERIFIED (04 D3): all access is server-side through `ctx.storage`; `storage.objects` end-user policies only after SP-4 passes. The Storage service credential is read only inside `services/{api,worker}/src/core/storage/` (second entry of the audited key list beside C2's GoTrue adapter, CR-C2-014).

**R12c RenderPort (CR-C4-004 primary; CR-C8-009 merged) and renderer templates.** RenderPort is owned by C6 (implemented in the `reporting` module, calling the renderer service), callable **only by system actors in worker tasks**, synchronous in the task, no row locks held across the call, 60 s timeout. It returns the PDF bytes (base64, ≤ 10 MB) with sha256/size/pages; the **caller stores the file in its own bucket** (no cross-module bucket writes). Template keys: `billing.invoice`, `billing.credit_note`, `billing.register`, `analytics.report`; data validated against `contracts/render/<templateKey>.schema.json` (C0-0C). Template directories: `services/renderer/templates/billing/**` → C4, `templates/analytics/**` → C8, `templates/smart/**` → C14 (unchanged); everything else under `services/renderer/**` → C6. Bundled assets only (REQ-SEC-086). CR-C14-007 accepted (C6 adds `smart-*` classes to the shared print stylesheet).

**R12d `instruments.v_pub_instrument_directory` (CR-C9-006 primary; CR-C12-005 merged).** Columns: `tenant_id, instrument_id, centre_id, instrument_code, display_name, vendor, model, state, is_active`; `security_invoker`; consumers C8, C9, C12. P0.

**R12e Excel library pin (CR-C8-014 vs C3 choice).** No conflict: C3's choice is the repo pin — `write-excel-file` 4.1.1 and `read-excel-file` 9.3.14, exact versions, added to `services/worker` by C0-0D (CR-C0-002). C4 BL-T19 uses the same writer. Spreadsheet formula-injection neutralisation moves to `@lims/shared-ts/spreadsheet` so C3, C4 and C8 do not copy it. Amended by Addendum A13 P-9 — the library exports:

  ```ts
  export function neutraliseFormula(cell: string): string;   // prefixes "'" when cell starts with = + - @ \t \r or "'"
  export function restoreNeutralised(cell: string): string;  // strips exactly one leading "'"; restoreNeutralised(neutraliseFormula(s)) === s for all s
  ```

  Every XLSX/CSV text cell written by product code passes `neutraliseFormula`; importers apply `restoreNeutralised` before validation; writer `write-excel-file` 4.1.1; module-local copies are banned (C3, C4, C8). C0-0A adds the function and golden tests (02-CV §10.2 "Spreadsheets").

### R13 — Event changes (CR-C5-006, C7-004, C12-004, C12-006, C17-006, C16-009, C10-007, C3-003, C8-007)

- **Decision.** All additive within `.v1`; full list in §4.10. Rule added to 02-CV §7.2: an event enum may gain values in `.v1` only if its schema marks it `x-extensible: true`; consumers treat unknown values safely (documented per event). Marked now: `catalog.changed.v1.entity_type` (adds `method`, `unit`, `value_set`, `tax_rule`) and `reporting.report.released.v1.report_kind` (adds `addendum`).
- `NotificationPurpose` += `scheduled_report_ready` (C8), `booking_cancelled`, `booking_reminder` (C16; C6 seeds the templates under these purposes instead of reusing `booking_confirmation`). `SendBase.related.entityType` += `report_run`.
- **CR-C10-007 vs 04 N10.** The result-level key stays `(instrument_id, sample_barcode, instrument_analyte_code, instrument_result_time)` — **no 04 N10 amendment**. The isolate is carried inside `instrument_analyte_code` by a C7 driver rule: organism records `ORG:<isolate_seq|1>`, AST records `AST:<isolate_seq|1>:<antibiotic_code_raw>:<method>`, ≤ 64 chars (a longer code is rejected by the driver and logged). C5 ignores `organism_id`/`ast` records; C10 parses the composite code. Simulator fixtures carry two isolates with the same antibiotic.
- New event `instruments.calibration.received.v1` (C7 → C12), P0, emitted only by drivers whose official manual classifies calibrator records (B2).
- Consumer-list changes: C11 ← `lab.result.approved.v1`, `lab.result.amended.v1`; C13 ← `frontdesk.order.cancelled.v1`, `catalog.changed.v1`; C16 ← `catalog.changed.v1`; C12 ← `instruments.calibration.received.v1`; C8 → NotificationPort consumer.

### R14 — Path ownership (CR-C0-001, C0-002, C2-001, C13-001, C15-007, C16-001, C4-004, C8-009)

Amended 01 §3 tree (replaces the block in 01 §3; module→owner table unchanged except the notes listed under it):

```
lims/
├── .github/                          C0-0A (CODEOWNERS, CI workflows incl. deploy-*.yml — C1 required reviewer; PR templates)
├── package.json, pnpm-workspace.yaml, pnpm-lock.yaml, pubspec.yaml (Dart workspace), analysis_options.yaml   C0-0A
├── tsconfig.base.json, eslint config, .prettierrc, .nvmrc, turbo.json, .gitignore, .gitleaks.toml          C0-0A
├── docs/
│   ├── program/                      DOC OWNER (founder)
│   ├── chunks/Cxx-*/                 DOC OWNER
│   └── manual/<module>/              owning chunk (incl. partners → C13, payments → C15, engagement → C16, homecollection → C17)
├── infra/                            C1 (incl. edge/public-routes.yaml, edge/egress-allowlist.yaml, THIRD-PARTY-OPS.md, providers/<name>/)
├── db/                               C0-0B ONLY (migrations/, policies/, seeds/, tests/, bootstrap/, meta/{tables,definer-inventory,system-actors,index-exceptions}.yaml, tools/)
├── contracts/                        C0-0C ONLY
│   ├── openapi/<domain>.yaml, openapi/_common.yaml
│   ├── events/<event-name>.schema.json
│   ├── ports/                        (incl. BillingCommandPort.ts, RenderPort.ts, EngagementPort.ts; legacy-common.ts + Legacy*ImportPort.ts reserved — DEFER B4)
│   ├── render/<templateKey>.schema.json   (new — RenderPort data schemas)
│   ├── errors.yaml, routes.yaml, permissions.yaml
├── packages/
│   ├── shared-ts/                    C0-0A (uuidv7, bsdate, money, decimal, formula, spreadsheet, errors, validation, logger, routes, crypto)
│   ├── shared-dart/                  C0-0A
│   ├── test-fixtures/                C0-0A
│   ├── api-client-ts/, api-client-dart/, fakes/ (incl. src/stubs/, contract-tests/)   C0-0C
│   ├── ui/, ui-flutter/              C0-0D
├── services/
│   ├── api/
│   │   ├── package.json, tsconfig.json, Dockerfile, src/main.ts   C0-0D
│   │   ├── src/core/                 C0-0D (incl. core/ports/phase-stubs.ts, core/storage/, core/uploads/)
│   │   └── src/modules/<module>/     owning chunk
│   ├── worker/
│   │   ├── package.json, tsconfig.json, Dockerfile, src/main.ts   C0-0D
│   │   ├── src/core/                 C0-0D
│   │   └── src/jobs/<module>/        owning chunk
│   └── renderer/                     C6, except templates/smart/ → C14, templates/billing/ → C4, templates/analytics/ → C8
├── apps/
│   ├── web/
│   │   ├── package.json, tsconfig.json, next.config.*, Dockerfile   C0-0D
│   │   ├── src/core/                 C0-0D (shell incl. support-session banner slot, BFF session core, nav registry, API proxy, help)
│   │   ├── src/middleware.ts         C0-0D (excludes (auth) and (display) from the staff-session requirement)
│   │   ├── src/app/layout.tsx        C0-0D
│   │   ├── src/app/(staff)/layout.tsx  C0-0D
│   │   ├── src/app/(staff)/<module>/ owning chunk (incl. admin → C2, partners → C13, payments → C15, engagement → C16)
│   │   ├── src/app/(auth)/**         C2 (incl. its layout.tsx; login, MFA, recovery, session-expired pages; URLs /auth/…)
│   │   ├── src/app/(platform)/**     C2 (incl. its layout.tsx; URLs /platform/…; requires session kind platform)
│   │   ├── src/app/(display)/**      C16 (incl. its layout.tsx; /queue-display; display-token auth, no staff shell, no nav)
│   │   └── src/features/<module>/    owning chunk (identity, admin, platform → C2; partners → C13; payments → C15; engagement → C16)
│   ├── portal/                       C6 (incl. app-link association files and app fallback pages — content inputs from C16 and C17; A13 D-38)
│   ├── partner/                      C13
│   ├── patient_app/                  C16 (Flutter)
│   ├── phlebo_app/                   C17 (Flutter)
│   └── bridge-agent/                 C7 (Go)
└── tools/
    ├── codegen/                      C0-0C
    ├── devstack/, lint/              C0-0A
    └── migration/                    C18
```
01 §4 "May" bullet on dependencies replaced (CR-C0-002): "Add dependencies to a package the chunk owns entirely (`apps/portal`, `apps/partner`, `apps/patient_app`, `apps/phlebo_app`, `apps/bridge-agent`, `services/renderer`, `tools/migration`). Dependencies of the shared packages `services/api`, `services/worker` and `apps/web` are added by C0-0D on a CR (shared-lib type); the requesting chunk lists the dependency row in its own `02-TRD.md`." 01 §2 C15 deployables += "web `payments`".

### R15 — Doc-owner wording CRs (CR-C18-010, CR-C4-012/C15-012, CR-C1-007, CR-C8-003)

- **CR-C18-010 (04 §13 vs 07 B4).** Both get the same text: B4 default = "No migration build. C18's documents specify the canonical export format, staging, mapping, validation and cut-over runbook (design only); no DDL, ports or tool code before the client delivers the eLabs export sample." (research/04 §13 and 07 B4.)
- **CR-C4-012 + CR-C15-012 (02-CV §4.7).** One sentence replaces the `amount_paisa (for payments)` clause: "`amount_paisa` where the server can compute the amount (prices, dues, gateway amounts, discounts after approval). Amounts that are facts entered by a person — cash/card received at the desk (04 P1), a finance-entered refund amount, a bank-statement total on a reconciliation worksheet — are allowed only when the operation names them explicitly (`amount_received_paisa`, `refund_amount_paisa`, `statement_total_paisa`), the server bounds them (≤ due, ≤ refundable) and, for refunds, the operation is privileged and approved by a second person."
- **CR-C1-007 (02-CV §15.2).** New row: "Operations tools run unmodified as separate processes on the LIMS provider servers, never linked into, vendored into or distributed with product code, are outside 'shipped code' (e.g. Ansible, fail2ban, ClamAV, Grafana, testssl.sh, Squid, SOPS, rsync). Conditions: listed in `infra/THIRD-PARTY-OPS.md` with licence; AGPL tools are reachable only from the ops network, never by tenant users; any modification or redistribution needs C0 + founder review. SSPL/BUSL/RSAL stay banned everywhere."
- **CR-C8-003 (02-CV §5.2).** New table class **R — derived rollup**: rebuildable from `v_pub_*` views; natural composite PK with `tenant_id` leading; mandatory columns `tenant_id, refresh_run_id, refreshed_at`; INSERT/DELETE only by the owning module's system actor (policy predicate `app.current_actor_type() = 'system'`), no UPDATE grant; no audit trigger (sources are audited); SELECT under tenant + centre RLS.

### R16 — Founder actions buried in CRs

Open founder items are listed in §5.1 with the default to build against: CR-C1-006 (egress register), CR-C16-020 (push), C18 timing (B4), CR-C18-009 (auditor), and sign-off of the wording edits (F-08). **Decided by the founder on 2026-11-06 (research/04 §11, §13) and incorporated here:** CR-C7-012 Authenticode certificate — purchased and owned by the client; FA-1 store accounts, listings and signing keys for the patient and phlebotomy apps — owned by the client; CR-C17-012 maps hand-off — approved (address only, device's own maps app, 04 §11), so CR-C17-012 is ACCEPT.

### R17 — Smart-report per-summary pathologist approval volume (C14 06 R1)

**Decided by the founder on 2026-11-06 (research/04 §13): per-summary pathologist approval is KEPT.** C14 risk R1 is accepted; volume is mitigated by `min_mapped_results` (default 3), the oldest-first queue with critical filter and the "Approve & next" flow; no bulk approval; tenant flag `smart_report` off by default. The 03-IC §4.10 invariant stays unchanged.

### R18 — Tax-rate ownership duplicated (found: C3 `catalog.tax_rules`/`cs_tax_types` + `PriceQuote.vatRateBp`; C4 `billing.tax_codes` + `billing.tax_config_missing`)

- **Problem.** Two sources of truth for tax rates; two error codes for one fact.
- **Decision.** C3 is the single owner of tax treatment, tax-type codes **and rates** (07-BLOCKERS B7 "tax rules are data, per tenant, per orderable"): `catalog.cs_tax_types` rows are effective-dated (`effective_from`/`effective_to`, versioned) and `CatalogPort.priceFor` returns `vatRateBp`, `otherTaxCode`, `otherTaxRateBp`, `hsCode` effective at `at`. C4 computes amounts (02-CV §4.9) and snapshots code + rate on every invoice line. C4 drops `billing.tax_codes`; `catalog.tax_config_missing` propagates unchanged through C4 (a port-thrown code may cross the owner-emits rule); `billing.tax_config_missing` is not registered; `billing.settings.manage` no longer covers tax codes. Finance edits tax rules in C3 under `catalog.price_list.manage` (privileged; finance + tenant_admin).
- **Affected.** C3, C4. Consequences in apply plan (C4 05-SCHEMA, TRD F8/F9 errors, BillingCommandPort `@throws`; C3 05-SCHEMA `cs_tax_types`).

### R19 — Permission codes with two segments (found)

`analytics.export`, `billing.export` and `billing.release_override` (03-IC §11) break 02-CV §3 `<m>.<resource>.<action>` and C0's `core.g_permissions` CHECK `^[a-z_]+\.[a-z_]+\.[a-z_]+$`, so the seed would fail. **Decision:** rename to `analytics.data.export`, `billing.data.export`, `billing.release.override` (no code exists yet; mechanical replace in 03-IC, C4, C6, C8 — regex in the apply plan, which must not touch error codes such as `analytics.export_not_ready`). Every new code in §4.1 passes the CHECK.

### R20 — Access-log action codes (found)

C0's `audit.g_cs_access_actions` CHECK is `^[a-z_]+\.[a-z_]+$` (`<entity>.<verb>`). CR-C8-006, C10-010 and C16-019 proposed three-segment codes; C2 (CR-C2-010) proposed bare words (`view`, `export`, `role_change`…); C3, C4, C9, C14, C15 and C17 use codes no CR registered. **Decision:** one consolidated seed (§4.4); every code is `<entity>.<verb>`; calls use C0's `ctx.audit.access({action, entityType, entityId?, centreId?, purpose?, outcome, detail?})` (C0 TRD §6.9) — the `event_type`/`type`/`entity` spellings in chunk docs are replaced.

### R21 — `TenantSettings` collisions (found: CR-C0-009 `branding.accentColor`, CR-C2-008 `branding{…}`, CR-C4-009 `letterhead{…}`; numbering CR-C2-008, C5-009, C11-005)

**Decision:** one `branding` block and one `numbering` block (§4.12). `letterhead` is not a separate key; `letterheadDefault` stays. Asset references are asset ids (`Uuidv7`) readable through `IdentityPort.readBrandingAsset`.

### R22 — UI-kit duplicates and look-alikes (found; CR-C2-016, C3-006, C4-013, C6-010, C7-010, others)

**Decision:** requests that duplicate existing kit components map to them; duplicates between chunks merge; genuinely new components are accepted (§4.6). Examples: `OtpCodeInput` + `OtpInput` → `OtpInput`; `SecretRevealField` + `SecretRevealOnce` → `SecretRevealOnce` (`requireAcknowledgement` prop); `StatusTimeline` → `Timeline`; `StatusBadge` → `StatusChip`; `MoneyInput` → `MoneyField`; `DualDate` → `DateText mode='AD_BS'`; `AsyncCombobox` → `Combobox`; `FileDropzone`/`FileDrop` → `FileUpload` (+`scanState`, + csv/xlsx accept values); `JsonDiffView` + `DiffTable` → `DiffTable`; `NumberField` → `DecimalField`; `DateTimeField` → `DateTimePicker`; `AppPage` → `PageShell` + `PageHeader`; `Skeleton` → `LoadingSkeleton`; `KeyboardShortcutsHelp` → `KeyboardShortcutsDialog`; `SupportBanner` → C0 shell slot.

### R23 — Platform authorisation path (found: CR-C0-004 vs C2 TRD §7.2)

CR-C0-004 says platform handlers call `IdentityPort.assertRole` on a `platform.*` permission; C2's `assertRole` refuses every `platform.*` code. **Decision:** C2's design — platform permissions are checked by `PlatformAuthz` in platform context only (R10 item 4). 03-IC §11 rule text gets that sentence.

### R24 — Token-hash representation (found: C6, C16 use `text`; C2, C7, C15 use `bytea`)

**Decision:** every stored token hash is `bytea` holding the 32-byte SHA-256 (`CHECK (octet_length(<col>) = 32)`), column suffix `_sha256`; DEFINER lookup functions take `bytea`. Applies to C6 (`qr_tokens`, `portal_links`, `portal_sessions`, `channel_accounts.callback_token_sha256`, `destination_sha256`) and C16 (`queue_displays`, pre-auth challenges, link codes). Naming row added to 02-CV §3.

### R25 — Published views used for operational reads (found: CR-C6-012, CR-C16-012/014; 01 §5 "views are for reporting reads only")

**Decision:** keep the 01 §5 rule. Operational in-request reads use ports: C6 report rendering gets department names from `TestDefinition.departmentName` and the partner id from `OrderSummary.partnerId`; C17 gets home addresses through `EngagementPort.getHomeAddress` (no `engagement.v_pub_booking_address`); C4 gets memberships through `EngagementPort.getActiveMembership` (no `engagement.v_pub_patient_membership`). Views stay for analytics and read-model projections (C8, C13, C15 reconciliation sums, C16 price-list sync, C9/C12 labels).

**Worker projections (Addendum A17 P-21).** Worker-side projections may read the `v_pub_*` views for which 03-IC §6 lists the chunk as a consumer. These are event consumers and cron tasks that maintain the chunk's own derived state (C8 rollups, C9 QC import and TAT clocks, C12 consumption facts, store resolution and per-day deduction). An HTTP request handler reads another module's views only for reporting/analytics responses and labels. Any other in-request operational read uses a port.

### R26 — Storage bucket naming and ownership (found)

**Decision:** bucket name = `<owner-module>-<purpose>`; exception `reports` (fixed by 04 D15). The adapter refuses writes from a module to another module's bucket. Final list in §4.8 (renames: `tenant-assets` → `identity-assets`, `exports` → `identity-exports`, `trf` → `frontdesk-trf`, `report-inputs` → `reporting-inputs`, `report-prints` → `reporting-prints`, `instrument-attachments` → `instruments-attachments`; reserved `reporting-legacy` for C18).

---
### R27 — Global uniqueness of staff users (found: C0 05-SCHEMA §3.3 vs CR-C2-017)

C0 rejects a global unique index on `core.memberships(user_id)` as a cross-tenant existence oracle; C2 asks for a partial global unique index `WHERE actor_type = 'user'` to enforce "one staff user = one tenant" (02-CV §6). **Decision:** accept C2's index. GoTrue already holds one global user per e-mail, so the existence fact is inherent to the single identity store; the index adds integrity, not a new oracle. Compensating rule kept: every invite/provision collision returns the generic `identity.user_exists` with no tenant information (C2 07-SECURITY A-6), and the check runs only inside the inventoried DEFINER `app.identity_user_exists`. Patients and partners stay multi-tenant-capable (index is partial). C0 05-SCHEMA §3.3 sentence replaced.

---

## 3. Full register (one row per CR)

R-numbers in Notes refer to §2. "Docs to update" names the target; the exact edits are in `_apply-plan.md`.

| CR | From→To | Type | Summary | Decision | Notes | Docs to update |
|---|---|---|---|---|---|---|
| CR-C0-001 | C0→doc owner (01 §3) | docs | Path ownership for C0 sub-paths; home for staff login pages | **ACCEPT-MODIFIED** | Merged with CR-C2-001/C13-001/C15-007/C16-001/C4-004/C8-009 into the amended 01 §3 tree (§2 R14). `(auth)` and `(platform)` groups incl. their `layout.tsx` → C2. | 01 §3; C0 TRD §1.1 |
| CR-C0-002 | C0→doc owner (01 §4) | docs | Dependencies of shared packages added by C0-0D on CR | **ACCEPT** | No per-module package.json in services/api, services/worker, apps/web. | 01 §4; 02-CV §15.1 |
| CR-C0-003 | C0→C2 | api | BffSessionStore/TokenRefresher contract | **ACCEPT-MODIFIED** | Shape of CR-C2-009 wins; BFF authenticates to identity with per-BFF key `X-Lims-Bff-Key`; session-kind binding derives from the key (R10). | 02-CV §6; C0 TRD §12.1; C2 TRD §4 |
| CR-C0-004 | C0→C2 | port/api | Platform operator recognition outside a tenant | **ACCEPT-MODIFIED** | Check is C2 `PlatformAuthz` in platform context, not `IdentityPort.assertRole` (which refuses `platform.*`, C2 TRD §7.2). DEFINERs `app.dl_list_platform`, `app.dl_resolve`, `app.platform_list_tenants` inventoried. | C0 TRD §17; 03-IC §11 rule text |
| CR-C0-005 | C0→doc owner (03 §8) | api | Allow web core to emit auth.session_expired | **ACCEPT** | Owner stays C2. | 03-IC §8 footnote |
| CR-C0-006 | C0→doc owner (02 §3) | api | Health endpoint naming exception | **ACCEPT** | `/v1/core/health/{live,ready}` documented exception. | 02-CV §4.1 |
| CR-C0-007 | C0→doc owner (02 §5.9) | schema | Roles lims_queue and lims_auth_hook | **ACCEPT-MODIFIED** | `lims_queue` accepted. `lims_auth_hook` + `app.custom_access_token_hook` dropped (no hook path, R10). `owner_only` policy scope accepted; `auth_hook` scope not added. | 02-CV §5.8/§5.9; C0 05-SCHEMA §4 |
| CR-C0-008 | C0→doc owner (06) | docs | Glossary: core.collection_centres; policies TO lims_app | **ACCEPT** | Also aligns 04 D4 wording with X9 (minimal 04 edit). | 06-GLOSSARY; research/04 D4 |
| CR-C0-009 | C0→C2+doc owner | port | TenantSettings.branding.accentColor | **MERGED-INTO CR-C2-008** | Field `branding.accentColor` in the merged branding block (§4.12). | 03-IC §4.6 |
| CR-C0-010 | C0→doc owner (02 §8.2, 03 §4.9–4.11) | port | Phase stubs for ports without a Phase-1 owner | **ACCEPT-MODIFIED** | Stub set = QualityPort, SmartReportPort, PaymentProviderPort (+getIntent/cancelIntent), EngagementPort (C4 calls it in Phase 1). Stubs only deny/disable (R9). | 02-CV §8.2; 03-IC §4.9–§4.11; C0 TRD §9 |
| CR-C1-001 | C1→C0-0A | shared-lib (CI) | Deploy workflows + self-hosted Nepal runner | **ACCEPT** | Files owned by C0-0A; C1 required reviewer in CODEOWNERS. | C0 TRD §1.1 CODEOWNERS |
| CR-C1-002 | C1→C0-0B | schema | Ops roles lims_monitor/lims_replicator/lims_audit_ship + insert-only publication | **ACCEPT** | CI role assertion: REPLICATION allowed only for lims_replicator, lims_audit_ship; BYPASSRLS/SUPERUSER still forbidden. | 02-CV §5.9; C0 05-SCHEMA §2 |
| CR-C1-003 | C1→C7 (+C0-0C) | api (metrics) | Bridge-agent health metric series | **ACCEPT** | Extends X6; C7 exports. | 03-IC §3.16 note; C7 TRD |
| CR-C1-004 | C1→C0-0C | api | Edge exposure registry, origins api/files, x-edge-exposure | **ACCEPT-MODIFIED** | Public paths also listed by C13 (partner login), C15, C16, C17 (mobile); login zones on public BFF/app routes (R6). | 03-IC §7; 02-CV §4.12 |
| CR-C1-005 | C1→C6 | port (runtime) | Renderer envelope + qpdf spool contract | **ACCEPT** | Consistent with CR-C6-013. Spool contract (C1 TRD §7.5) superseded by CR-C6-013 / A13 P-13 (batch-4 D-204); envelope part stands. | C6 TRD |
| CR-C1-006 | C1→Founder | foreign touchpoint | Non-PHI egress register (mirrors, images, ClamAV, ACME, Git, SMS paging) | **FOUNDER** | Not decided here (§5 F-01). Build default = CR default. | 07 §Founder list |
| CR-C1-007 | C1→doc owner (02 §15.2) | shared policy | Licence scope for unmodified ops tools | **ACCEPT-MODIFIED** | Text accepted + conditions: unmodified, separate process, ops network only (AGPL Grafana never exposed to tenant users), register in `infra/THIRD-PARTY-OPS.md`. | 02-CV §15.2 |
| CR-C1-008 | C1→C0-0D | shared-lib/core | Liveness, egress proxy, graceful shutdown hooks | **ACCEPT** |  | C0 TRD |
| CR-C1-009 | C1→doc owner (04 §4) | shared policy | Login 5/min/IP vs labs behind one NAT | **ACCEPT-MODIFIED** | 04 §4 amended with a registered-egress-IP zone + compensating controls (R6). | research/04 §4; 02-CV §10.3; C1 TRD; C2 TRD |
| CR-C2-001 | C2→C0-0D | ui-kit (paths) | Route groups (auth) and (platform) | **ACCEPT** | In amended 01 §3 tree; `(staff)/platform/` removed. | 01 §3 |
| CR-C2-002 | C2→C0-0A | shared-lib (CI) | CI allowlist: identity repository on core/audit | **ACCEPT** | Includes `core.membership_branches`. | C0 lint config |
| CR-C2-003 | C2→C0-0B | schema | core columns/constraints/inventory functions | **ACCEPT-MODIFIED** | Explicit branch scope via `core.membership_branches` (R3); add CHECK `actor_type = 'user' OR NOT all_centres`; token hashes `bytea` (R24). | C0 05-SCHEMA §3.3 |
| CR-C2-004 | C2→C0-0D+0B | api/schema | Platform request context, app.is_platform_actor, withTenantScope | **ACCEPT-MODIFIED** | `withTenantScope` only for an enumerated operationId allowlist in core config + access-log entry per use (R10). | 02-CV §6; C0 TRD |
| CR-C2-005 | C2→C0-0D+0B | port/schema | Claims-resolver extension point + identity DEFINERs | **ACCEPT-MODIFIED** | Resolver is the sole claims source for every GoTrue JWT in every environment; extended to kinds partner/patient/staff_mobile (R10). | 02-CV §6; C0 TRD §6.5 |
| CR-C2-006 | C2→C0-0C | api | Permissions audit.log.export, identity.self.manage, platform.staff.manage | **ACCEPT-MODIFIED** | `identity.self.manage` roles += radiologist (CR-C6-003). | 03-IC §11 |
| CR-C2-007 | C2→C0-0C | api | Error codes (6) | **ACCEPT** |  | 03-IC §8 |
| CR-C2-008 | C2→C0-0C | port | TenantSettings additive fields | **ACCEPT-MODIFIED** | Primary of merged TenantSettings change: branding (C0-009, C4-009), retention, featureFlags, ird.annexReadiness, numbering (C5-009, C11-005) — final shape §4.12. | 03-IC §4.6; C2 05-SCHEMA §4.6 |
| CR-C2-009 | C2→C0-0D | api | BFF session integration contract | **ACCEPT-MODIFIED** | + `X-Lims-Bff-Key`; kind binding from key, not from a free header (R10). | 02-CV §6; C0 TRD |
| CR-C2-010 | C2→C0-0B | schema | audit columns/RLS + access-event types | **ACCEPT-MODIFIED** | Event types mapped to 2-segment action codes (§4.4). | C0 05-SCHEMA §3.7; C2 TRD §9 |
| CR-C2-011 | C2→C0-0A | shared-lib | Shared upload pipeline + storage adapter | **ACCEPT-MODIFIED** | Primary of merged upload/storage CR (R12); final API §4.13. | 02-CV §10.2; C0 TRD |
| CR-C2-012 | C2→C1 | infra | Identity infra rules | **ACCEPT-MODIFIED** | Per-IP login zone sits on public BFF/app login routes keyed by client IP, not on BFF-only API routes; buckets renamed `identity-assets`, `identity-exports` (R26). | C1 TRD; C2 TRD §4 |
| CR-C2-013 | C2→C0-0D | shared-lib | ctx.core.systemActorPermissions | **ACCEPT** |  | C0 TRD |
| CR-C2-014 | C2→C0 | security | Service-key confinement to GoTrue adapter | **ACCEPT** | Core storage adapter is the second audited user (R12). | 02-CV §10.2 |
| CR-C2-015 | C2→doc owner | docs | Glossary table name collection_centres | **MERGED-INTO CR-C0-008** |  | 06-GLOSSARY |
| CR-C2-016 | C2→C0-0D | ui-kit | C2 components | **ACCEPT-MODIFIED** | OtpCodeInput→`OtpInput`; SecretRevealField→`SecretRevealOnce`; StatusTimeline→existing `Timeline`; JsonDiffView→`DiffTable`; SupportBanner = C0 shell slot; new `PermissionMatrix`, `DataUriImage` (R22). | C0 04-UI-UX §2; C2 04-UI-UX §2.2 |
| CR-C2-017 | C2→C0-0B | schema | Exceptions to tenant-leading index rule | **ACCEPT** | Recorded in `db/meta/index-exceptions.yaml` with C6/C7/C15/C16 rows. | 02-CV §5.3 |
| CR-C2-018 | C2→C0-0B | schema | `identity.sessions.previous_token_sha256` for rotated app-session reuse detection | **ACCEPT** | Addendum A3.1 (additive schema): `bytea` (32), one previous token kept; partial global unique index `WHERE previous_token_sha256 IS NOT NULL` as index-rule exception (§4.7); reuse revokes the session (`token_reuse`). | C2 05-SCHEMA; 03-IC §13.3; db/meta/index-exceptions.yaml |
| CR-C2-019 | C2→C1+C0-0A | infra/ci | Wiring of C2's alert rules (`services/worker/src/jobs/identity/ops/identity.rules.yml`) and the two C2 02-TRD §13 CI jobs | **ACCEPT** | A28.6 (A13 P-14; review C2 m#55). C1 adds only `team` and `runbook_url`; no new secret. | C1 TRD §11.3; C0 TRD (CI) |
| CR-C3-001 | C3→C0-0C | port | CatalogPort additive fields + getReferrer/getCreditParty/resolveCommentCodes | **ACCEPT-MODIFIED** | Primary of merged CatalogPort set (C4-002, C5-001, C13-007, C11-009, C6-012): purpose `billing` (pan, billingAddressText), `departmentName`, `usesExistingMaterial`, `asOf` on resolveCommentCodes (§4.14). | 03-IC §4.2; C3 TRD §6.1 |
| CR-C3-002 | C3→C0-0A | shared-lib | @lims/shared-ts/formula | **ACCEPT-MODIFIED** | One grammar = C3 TRD §7.1 + `log10`; exact decimal (≥28 digits), transcendental → `inexact`; C0-0A implements (R12a). | C3 TRD §7.1; C5 TRD §4.4 |
| CR-C3-003 | C3→C0-0C | api+event | Permissions (3), errors (3), catalog.changed entity types | **ACCEPT-MODIFIED** | `entity_type` marked `x-extensible: true`; stays .v1 (R13). | 03-IC §3.19/§8/§11 |
| CR-C3-004 | C3→C0-0B | schema | canonical_referrer_id on v_pub_referrer_directory | **ACCEPT** |  | 03-IC §6.6 |
| CR-C3-005 | C3→C0-0D | shared-lib/core | Multipart, xlsx allowlist, scan hook, streaming download | **MERGED-INTO CR-C2-011** | Scanner mandatory in staging/prod (not optional). | 02-CV §10.2 |
| CR-C3-006 | C3→C0-0D | ui-kit | Catalog components | **ACCEPT-MODIFIED** | Mapped to existing kit names; new `EditableGrid`, `CodeField`, `FormulaEditor`, `StatusStepper`, `DiffTable` (R22). | C0 04-UI-UX §2; C3 04-UI-UX §2 |
| CR-C3-007 | C3→C0-0A | shared-lib (fixtures) | Starter catalog workbooks `starter_catalog_master.xlsx`, `starter_price_list.xlsx` in `packages/test-fixtures/catalog/` | **ACCEPT** | Addendum A13 D-17: generated by a script from C3 TRD §8.2 (columns) and SCH §8 (content), every value labelled SYNTHETIC; uses C0 TRD §3.5's existing domain-generator mechanism. | C0 TRD §3.5; C3 PLAN §0 |
| CR-C3-008 | C3→C0-0C | ci/test | Probe generator skips stub operations listed in `__tests__/probes/pending.json`; stubs return `503 common.service_unavailable`; list empty at M6 | **ACCEPT** | C3 fix-pass hand-off (batch-4 §(f) 44). | C0 TRD (C0-0C probe generator); C3 TRD |
| CR-C3-009 | C3→C0-0A+C1 | ci/infra | Wire C3's CI job and alert rules | **ACCEPT** | A13 P-14 (one CR per chunk); C3 fix-pass hand-off. | C0 TRD (C0-0A); C1 TRD §11.3 |
| CR-C4-001 | C4→C0-0C | port | BillingCommandPort (C4-internal) | **ACCEPT** | Consumer allowlist = frontdesk only. | 03-IC §4 (new §4.15) |
| CR-C4-002 | C4→C0-0C | port | CatalogPort.getReferrer/getCreditParty | **MERGED-INTO CR-C3-001** | PAN/address via purpose `billing`. | 03-IC §4.2 |
| CR-C4-003 | C4→C0-0C+C5 | port | LabPort.getOrderItemProcessingState | **ACCEPT** |  | 03-IC §4.5 |
| CR-C4-004 | C4→C0-0C+C6 | port | RenderPort + templates/billing path | **ACCEPT-MODIFIED** | Final RenderPort returns PDF bytes to the caller (caller stores in its own bucket); worker/system callers only; template dirs per module (R12c). | 03-IC new §4.16; C6 TRD |
| CR-C4-005 | C4→C0-0D+0B+C1 | shared-lib/schema | Upload pipeline + buckets trf, billing-exports | **MERGED-INTO CR-C2-011** | `trf` renamed `frontdesk-trf`. | 02-CV §10.2 |
| CR-C4-006 | C4→C0-0C | port | BookingOrderInput.partnerId | **ACCEPT** | + `OrderSummary.partnerId` (for C6, R25). | 03-IC §4.3 |
| CR-C4-007 | C4→C0-0C | api | Error codes (4) | **ACCEPT-MODIFIED** | `billing.tax_config_missing` not added; `catalog.tax_config_missing` propagates from CatalogPort (R18). | 03-IC §8; C4 TRD |
| CR-C4-008 | C4→C0-0C | api | Permissions (3) | **ACCEPT-MODIFIED** | `billing.settings.manage` no longer covers tax codes (R18). | 03-IC §11 |
| CR-C4-009 | C4→C0-0C+C2 | port | TenantSettings.letterhead | **MERGED-INTO CR-C2-008** | Fields live in `branding`. | 03-IC §4.6 |
| CR-C4-010 | C4→C5 | api | C5 label-print operation for an order | **ACCEPT** |  | C5 TRD; lab.yaml |
| CR-C4-011 | C4→C6 | api/data | Templates registration_confirmation, recollection_request | **ACCEPT** |  | C6 seeds |
| CR-C4-012 | C4→doc owner | docs | 02-CV §4.7 operator-entered amounts | **ACCEPT** | One wording covers CR-C15-012 (§3 text). | 02-CV §4.7 |
| CR-C4-013 | C4→C0-0D | ui-kit | C4 components | **ACCEPT-MODIFIED** | Use MoneyField, MoneyText, DateText(AD_BS), Combobox, DataTable, StatusChip, ConfirmDialog; FileUpload gains `scanState`; new `PrintFrame` (R22). | C0 04-UI-UX §2; C4 04-UI-UX §2 |
| CR-C5-001 | C5→C0-0C+C3 | port | CatalogPort.resolveCommentCodes (+searchCommentCodes) | **MERGED-INTO CR-C3-001** | `searchCommentCodes` not a port method: UI picker uses C3 HTTP list. | 03-IC §4.2 |
| CR-C5-002 | C5→C0-0A | shared-lib | Formula grammar + rational decimal | **MERGED-INTO CR-C3-002** | C5 local grammar (ternary, \|\|/&&) dropped. | C5 TRD §4.4 |
| CR-C5-003 | C5→C0-0C+C4 | port | FrontdeskPort purposes result_evaluation, lab_display + batch read | **ACCEPT** |  | 03-IC §4.3 |
| CR-C5-004 | C5→C0-0C | api | Permissions (3) | **ACCEPT** |  | 03-IC §11 |
| CR-C5-005 | C5→C0-0C | api | Error codes (3) | **ACCEPT** |  | 03-IC §8 |
| CR-C5-006 | C5→C0-0C+C6 | event | report.released.v1 optional order_item_ids | **ACCEPT** | Producer agreed (CR-C6-014). | 03-IC §3.17 |
| CR-C5-007 | C5→C0-0C | api | Routes (2) | **ACCEPT** |  | 03-IC §7 |
| CR-C5-008 | C5→lead/C0-0C | docs | 02-CV §4.1 barcode-in-URL example; ingest JSDoc | **ACCEPT** |  | 02-CV §4.1; 03-IC §4.5 |
| CR-C5-009 | C5→C0-0C+C2 | port | numbering.barcodePrefix | **MERGED-INTO CR-C2-008** |  | 03-IC §4.6/§9.3 |
| CR-C5-010 | C5→C1 | infra | Alert rules wiring `services/worker/src/jobs/lab/ops/lab.rules.yml` | **ACCEPT** | A17.3; P-14. | C1 TRD §11.3 |
| CR-C5-011 | C5→doc owner (02-CV §4.1) | docs | Bulk bodies `items[{id,version}]` allowed | **ACCEPT** | A17.3. | 02-CV §4.1 |
| CR-C5-012 | C5→C3+C0-0C | port | `RangeQuery.ageDays` optional (unknown patient age) | **ACCEPT** | A17.1 / A17.3: absent → only age-unrestricted rows match; none → `range_unavailable_age_unknown`, never auto-verified. | 03-IC §4.2; 08 §4.14; C3 TRD; C5 TRD |
| CR-C6-001 | C6→C0-0D | api | Portal credential resolver, link_invalid 404, anonymousTx, raw-body | **ACCEPT** | Security sign-off (05-DoD §4) required. | C0 TRD §6; 02-CV §4.12 |
| CR-C6-002 | C6→C0-0B | schema | Reporting lookup DEFINERs, role, global token indexes | **ACCEPT** | Token hashes `bytea` (R24). | C0 05-SCHEMA; db/meta |
| CR-C6-003 | C6→C0-0C+C2 | api | Reporting permissions + role radiologist | **ACCEPT** |  | 03-IC §11 |
| CR-C6-004 | C6→C0-0C | api | Reporting error codes (8) | **ACCEPT** |  | 03-IC §8 |
| CR-C6-005 | C6→C0-0C | api | Report-version state discarded | **ACCEPT** |  | 03-IC §10.3; C0 kit key |
| CR-C6-006 | C6→C5+C0-0C | port | OrderResults.specimens[].barcode, ResultView.moduleRef | **ACCEPT** |  | 03-IC §4.5 |
| CR-C6-007 | C6→C2+C0-0C | port | IdentityPort.getSignatories, readBrandingAsset | **ACCEPT** |  | 03-IC §4.6 |
| CR-C6-008 | C6→C0-0B | schema | Access-log action codes (8) | **ACCEPT** |  | C0 05-SCHEMA §3.7 |
| CR-C6-009 | C6→C0-0A+0B | shared-lib/schema | Reporting buckets + write-once storage | **ACCEPT-MODIFIED** | Buckets `reports` (04 D15), `reporting-inputs`, `reporting-prints` (R26). | 02-CV §5.8; C6 05-SCHEMA |
| CR-C6-010 | C6→C0-0D | ui-kit | RichTextEditor, OtpInput, ImageThumbnailGrid, PdfFileCard | **ACCEPT-MODIFIED** | `OtpInput` also serves C2 (R22). | C0 04-UI-UX §2 |
| CR-C6-011 | C6→C0-0C | api | Reporting routes (6) | **ACCEPT** |  | 03-IC §7 |
| CR-C6-012 | C6→C0-0C | schema (doc) | C6 as consumer of v_pub_department, v_pub_order_status | **ACCEPT-MODIFIED** | Operational reads use ports: `TestDefinition.departmentName`, `OrderSummary.partnerId` (R25). | 03-IC §4.2/§4.3/§6 |
| CR-C6-013 | C6→C1 | infra | Renderer/sandbox/portal/callback infra | **ACCEPT** |  | C1 TRD |
| CR-C6-014 | C6→C0-0C | event | Agreement to CR-C5-006 | **MERGED-INTO CR-C5-006** |  | 03-IC §3.17 |
| CR-C6-015 | C6→C4+C0-0C | port | notification purpose for non-system callers: contactPresence | **ACCEPT** |  | 03-IC §4.3 |
| CR-C6-018 | C6→C2+C0-0C | port | IdentityPort.getStaffNotificationContact | **ACCEPT** | Addendum A4.2 (additive): system actors only (reporting worker); `eligible` = active `user` membership, not locked, holds `requiredPermission`; `email` = `core.users.email_normalized`. | 03-IC §4.6; C2 TRD; C6 TRD |
| CR-C6-019 | C6→C0-0A | shared-lib | DOMPurify + server DOM; SMTP client | **ACCEPT** | A21.3: C0 pins versions after the licence / no-egress check. | C0 TRD; 02-CV §15 |
| CR-C6-020 | C6→C2+C0-0C | port | `IdentityPort.readSignatureImage` | **ACCEPT** | A21.2 (additive; system actor holding `identity.signatory.read`; throws `common.not_found`); C6 render worker uses it, C2 implements. | 03-IC §4.6; 08 §4.14; C2 TRD |
| CR-C7-001 | C7→C0-0C | api | Permissions (3) | **ACCEPT** |  | 03-IC §11 |
| CR-C7-002 | C7→C0-0C | api | Error codes (8) | **ACCEPT** |  | 03-IC §8 |
| CR-C7-003 | C7→C0-0C | api | Routes (6) | **ACCEPT** |  | 03-IC §7 |
| CR-C7-004 | C7→C0-0C | event | result/qc.received triggers + captured_at/processing_kind/source_record_id | **ACCEPT** |  | 03-IC §3.14/§3.15 |
| CR-C7-005 | C7→C0-0C+C5 | port | LabPort.listPendingForInstrument | **ACCEPT** | US-23 stays BLOCKED B2. | 03-IC §4.5 |
| CR-C7-006 | C7→C0-0B | schema | Device-credential DEFINERs, owner-only policies, column grant | **ACCEPT** | Token hashes `bytea`. | C0 05-SCHEMA; db/meta |
| CR-C7-007 | C7→C0-0B+0D | schema/shared-lib | Bucket instrument-attachments | **ACCEPT-MODIFIED** | Renamed `instruments-attachments` (R26); uses CR-C2-011 API. | C7 05-SCHEMA |
| CR-C7-008 | C7→C0-0B | schema | Access-log action codes (6) | **ACCEPT** |  | C0 05-SCHEMA §3.7 |
| CR-C7-009 | C7→C0-0C+0D | api | deviceToken scheme, extraClaims, route body limits | **ACCEPT** |  | _common.yaml; C0 TRD |
| CR-C7-010 | C7→C0-0D | ui-kit | CodeBlock, SecretRevealOnce, KeyValueListEditor | **ACCEPT-MODIFIED** | `SecretRevealOnce` gains `requireAcknowledgement` (C2 shares it). | C0 04-UI-UX §2 |
| CR-C7-011 | C7→C5 | bug | ingestInstrumentResult replay semantics | **ACCEPT** | Contract case 21 added. | 03-IC §4.5; C5 TRD §4.5 |
| CR-C7-012 | C7→C1 | infra | nginx, secrets, release mount, scrape; code-signing cert | **ACCEPT** | Infra rows accepted. Authenticode certificate: founder decided 2026-11-06 — purchased and owned by the client (04 §13). | C1 TRD |
| CR-C7-013 | C7→C0-0A | ci | C7 CI jobs incl. Windows runner | **ACCEPT** | A16.2; P-14. | C0 TRD (C0-0A) |
| CR-C7-014 | C7→C0-0C+C5 | route | Route `staff.lab.ingest_exceptions` (`/lab/ingest-exceptions`, owner C5, permission `lab.result.read`) | **ACCEPT** | A16.2. | 03-IC §7; 08 §4.3; C5 TRD/UI |
| CR-C8-001 | C8→C0-0C | api | Permissions collections.read, schedule.manage | **ACCEPT** |  | 03-IC §11 |
| CR-C8-002 | C8→C0-0C | api | Error codes (4) | **ACCEPT** |  | 03-IC §8 |
| CR-C8-003 | C8→doc owner+C0-0B | schema | Table class R (derived rollup) | **ACCEPT** |  | 02-CV §5.2 |
| CR-C8-004 | C8→C0-0B+C5 | schema | lab views: centre_id, tests_approved, parent_specimen_id | **ACCEPT** |  | 03-IC §6.3 |
| CR-C8-005 | C8→C0-0B+C6 | schema | v_pub_delivery_daily centre_id + anchors | **ACCEPT** |  | 03-IC §6.4; C6 05-SCHEMA |
| CR-C8-006 | C8→C0-0B | schema | Access action analytics.referral_report.view | **ACCEPT-MODIFIED** | Code `referral_report.view` (2-segment rule, R20). | C0 05-SCHEMA §3.7; C8 TRD |
| CR-C8-007 | C8→C0-0C+C6 | port | NotificationPort consumer C8; purpose scheduled_report_ready | **ACCEPT** |  | 03-IC §4.8; 01 §5.1 |
| CR-C8-008 | C8→C0-0C | api | Analytics routes (5) | **ACCEPT-MODIFIED** | Route `staff.analytics.exports` permission renamed `analytics.data.export` (R19). | 03-IC §7 |
| CR-C8-009 | C8→C0-0C+C6 | port | RenderPort analytics.report + templates/analytics | **MERGED-INTO CR-C4-004** |  | 03-IC §4.16 |
| CR-C8-010 | C8→C0-0B+C4 | schema/bug | payment_collection column name | **ACCEPT** | `method_code AS payment_method_code`; 03-IC wins. | C4 05-SCHEMA §6 |
| CR-C8-011 | C8→C0-0B | schema (perf) | Expression indexes for business_date reads | **ACCEPT** | Immutability stays UNVERIFIED; fallback stored `business_date` column. | owner 05-SCHEMAs |
| CR-C8-012 | C8→C0-0D | shared-lib | WorkerManifest.taskOptions.statementTimeoutMs | **ACCEPT** |  | 02-CV §2.3 |
| CR-C8-013 | C8→C0-0D | ui-kit | PeriodPicker, DurationText, FreshnessBadge | **ACCEPT** |  | C0 04-UI-UX §2 |
| CR-C8-014 | C8→C0-0A | shared-lib | One repo-wide pin write-excel-file 4.1.1 | **ACCEPT** | With `read-excel-file` 9.3.14 (C3); added to services/worker by C0-0D. | C0 dependency review |
| CR-C8-015 | C8→C1+C0-0A | infra/ci | Alert rules `services/worker/src/jobs/analytics/ops/analytics.rules.yml`; CI job `c8-no-commission` | **ACCEPT** | C8 fix-pass hand-off; P-14. | C1 TRD §11.3; C0 TRD (C0-0A) |
| CR-C9-001 | C9→C0-0C | api | Quality permissions (5) | **ACCEPT** |  | 03-IC §11 |
| CR-C9-002 | C9→C0-0C | api | Quality error codes (7) | **ACCEPT** |  | 03-IC §8 |
| CR-C9-003 | C9→C0-0C | port | AutoVerifyReason qc_warning + semantics | **ACCEPT** |  | 03-IC §4.11 |
| CR-C9-004 | C9→C5+C0-0C | port | C5 calls canAutoVerify independent of tenant switch | **ACCEPT** |  | C5 TRD §6.2; 03-IC §4.11 |
| CR-C9-005 | C9→C0-0B+C5 | schema | v_pub_qc_result.created_at + index | **ACCEPT** |  | 03-IC §6.3 |
| CR-C9-006 | C9→C0-0B+C7 | schema | instruments.v_pub_instrument_directory | **ACCEPT-MODIFIED** | Primary; columns merged with CR-C12-005 (§4.9). | 03-IC §6.5 |
| CR-C9-007 | C9→C0-0D | ui-kit | ControlChart | **ACCEPT** |  | C0 04-UI-UX §2 |
| CR-C9-008 | C9→C1 | infra | Alert wiring `services/worker/src/jobs/quality/ops/quality.rules.yml` | **ACCEPT** | C9 fix-pass hand-off; P-14. | C1 TRD §11.3 |
| CR-C10-001 | C10→C0-0C+C5+0B | port | SubmitModuleResultInput.amendment + reason seed | **ACCEPT-MODIFIED** | Primary of merged amendment shape; seeds `module_phase_progression` and `supplementary_report` (R1). | 03-IC §4.5; C5 seeds |
| CR-C10-002 | C10→C6 | behaviour | C6 report-kind rule for phase progression | **ACCEPT-MODIFIED** | + `addendum` report kind for `supplementary_report` (R1). | C6 TRD; 03-IC §3.17/§4.7 |
| CR-C10-003 | C10→C0-0C+C5 | port | LabPort.lookupSpecimens | **ACCEPT-MODIFIED** | Primary; adds `{orderId, statuses?}` selector absorbing CR-C17-002 (§4.14). | 03-IC §4.5 |
| CR-C10-004 | C10→C0-0C | api | Micro permissions | **ACCEPT** |  | 03-IC §11 |
| CR-C10-005 | C10→C0-0C | api | Micro error codes (11) | **ACCEPT** |  | 03-IC §8 |
| CR-C10-006 | C10→C0-0C | api | Micro routes (5) | **ACCEPT** |  | 03-IC §7 |
| CR-C10-007 | C10→C7 | event semantics | Isolate in instrument_analyte_code for ID/AST | **ACCEPT** | 04 N10 key unchanged (the code segment carries the isolate). | 03-IC §3.14; C7 TRD |
| CR-C10-008 | C10→C0-0D+0A+0B | ui-kit/shared-lib/schema | CSV upload + bucket micro-imports | **MERGED-INTO CR-C2-011** | `text/csv` allowed with UTF-8/NUL check, scan not applicable. | 02-CV §10.2 |
| CR-C10-009 | C10→lead | docs | AST coded set owner; X4 scope; 3.14 note | **ACCEPT** | `micro.g_cs_ast_interpretations` (C10). | 02-CV §3/§5.2/§5.5; 03-IC §3.14 |
| CR-C10-010 | C10→C0-0B | schema | Access-log action codes (5) | **ACCEPT-MODIFIED** | Renamed to 2 segments (§4.4). | C0 05-SCHEMA §3.7; C10 TRD |
| CR-C11-001 | C11→C0-0B | schema | Additive columns on anatomic.v_pub_report_content | **ACCEPT** |  | 03-IC §6.8 |
| CR-C11-002 | C11→C0-0C | api | Anatomic permissions | **ACCEPT** |  | 03-IC §11 |
| CR-C11-003 | C11→C0-0C | api | Anatomic error codes (11) | **ACCEPT** |  | 03-IC §8 |
| CR-C11-004 | C11→C0-0C+C5 | port | Amendment reason on submitModuleResult | **MERGED-INTO CR-C10-001** |  | 03-IC §4.5 |
| CR-C11-005 | C11→C0-0C+C2 | port | Accession patterns in TenantSettings.numbering | **MERGED-INTO CR-C2-008** | C2 validates with C11 grammar. | 03-IC §4.6/§9.3 |
| CR-C11-006 | C11→C0-0C | api | Anatomic routes (7) | **ACCEPT** |  | 03-IC §7 |
| CR-C11-007 | C11→C0-0D | ui-kit | BarcodeSymbol (Code 128) | **ACCEPT** | C5 also uses it. | C0 04-UI-UX §2 |
| CR-C11-008 | C11→C0-0B+0A | schema/shared-lib | Bucket anatomic-images + pipeline guarantees | **ACCEPT-MODIFIED** | EXIF strip, maxMegapixels, dimensions added to CR-C2-011 options. | 02-CV §10.2 |
| CR-C11-009 | C11→C3+C5+C0-0C | port | TestDefinition.usesExistingMaterial | **ACCEPT** |  | 03-IC §4.2 |
| CR-C11-010 | C11→doc owner | docs | Glossary sign-out vs A1 chain | **ACCEPT** |  | 06-GLOSSARY |
| CR-C11-011 | C11→C0-0C | event | C11 consumes result.approved/amended | **ACCEPT** |  | 03-IC §3.10/§3.11/§3.25; 01 §5.1 |
| CR-C12-001 | C12→C0-0C | api | Inventory permissions | **ACCEPT** |  | 03-IC §11 |
| CR-C12-002 | C12→C0-0C | api | Inventory routes (19) | **ACCEPT** |  | 03-IC §7 |
| CR-C12-003 | C12→C0-0C | api | Inventory error codes (15) | **ACCEPT** | `owner: C12` per the CR header. | 03-IC §8 |
| CR-C12-004 | C12→C0-0C+C5 | event | lab.result.verified.v1 processing_branch_id | **ACCEPT** |  | 03-IC §3.9 |
| CR-C12-005 | C12→C0-0B+C7 | schema | instruments.v_pub_instrument_directory | **MERGED-INTO CR-C9-006** |  | 03-IC §6.5 |
| CR-C12-006 | C12→C0-0C+C7 | event | New instruments.calibration.received.v1 | **ACCEPT** | Emission gated by B2 (driver classification). | 03-IC new §3.26 |
| CR-C12-007 | C12→doc owner | docs | Numbering registry rows po/grn/transfer/count/doc | **ACCEPT-MODIFIED** | 03-IC §9.3 rule amended for module-internal non-fiscal numbers. | 03-IC §9.3 |
| CR-C12-008 | C12→C0-0B | schema | System actor inventory + purge function | **ACCEPT** | Purge is SECURITY INVOKER (not in DEFINER inventory). | db/meta |
| CR-C12-009 | C12→C0-0D | ui-kit | DecimalField.suffix | **ACCEPT** |  | C0 04-UI-UX §2.2 |
| CR-C12-010 | C12→C0-0C+C3 | port | CatalogPort.getTaxRate (purchase-side rates from C3) | **ACCEPT** | Addendum A2.2 (additive; R18 single source of rates); signature per Addendum A4.1 (`RequestContext`, `kind 'vat' \| 'other'`, `effectiveFrom string \| null`), throws `catalog.tax_config_missing`. | 03-IC §4.2; C3 TRD; C12 TRD/05-SCHEMA |
| CR-C12-011 | C12→C1 | infra | Alert rules wiring `services/worker/src/jobs/inventory/ops/inventory.rules.yml` (4 rules) | **ACCEPT** | C12 fix-pass hand-off; P-14. | C1 TRD §11.3 |
| CR-C13-001 | C13→C0-0A | shared-lib (paths) | CODEOWNERS for staff segment, jobs, manual | **ACCEPT** |  | 01 §3 |
| CR-C13-002 | C13→C0-0C | api | Partner permissions + partner_roles | **ACCEPT** |  | 03-IC §11 |
| CR-C13-003 | C13→C2 | port/api/schema | Partner sessions, login, membership provisioning | **ACCEPT-MODIFIED** | Kind `partner`; binding by partner BFF key, not `X-Lims-Origin` (R10). | 03-IC §4.6; C2 TRD |
| CR-C13-004 | C13→C0-0B | schema | app.current_partner_id() | **ACCEPT** |  | db/meta definer inventory |
| CR-C13-005 | C13→C0-0C+0B+C6 | port/schema | ReportingPort.openReleasedReportFile + partner RLS | **ACCEPT** |  | 03-IC §4.7 |
| CR-C13-006 | C13→C0-0C | event | C13 consumes order.cancelled, catalog.changed | **ACCEPT** |  | 03-IC §3.3/§3.19/§3.25; 01 §5.1 |
| CR-C13-007 | C13→C0-0C | port | C13 as CatalogPort consumer | **MERGED-INTO CR-C3-001** |  | 03-IC §4.2 |
| CR-C13-008 | C13→C0-0C | api | Partner staff routes (7) | **ACCEPT** |  | 03-IC §7 |
| CR-C13-009 | C13→C0-0C | api | Partner error codes (18) | **ACCEPT** | `owner: C13` per the CR header. | 03-IC §8 |
| CR-C13-010 | C13→C4 | port | Agreement on CR-C4-006 + collection_mode partner | **ACCEPT** |  | C4 TRD |
| CR-C13-011 | C13→C0-0B | schema | Actor-type guard on tenant-only policies | **ACCEPT** | `app.is_staff_or_system()` on every `__tenant` policy (R10). | 02-CV §5.8 |
| CR-C13-012 | C13→C0-0B | schema | Access-log codes (3) | **ACCEPT** |  | C0 05-SCHEMA §3.7 |
| CR-C13-013 | C13→C0-0D | ui-kit | QrCode (web) | **ACCEPT** |  | C0 04-UI-UX §2 |
| CR-C13-014 | C13→C0-0C+C6 | port | RenderTemplateKey `partners.access_slip` | **ACCEPT** | Addendum A5.1 (numbered by A7.5; additive): C13 worker (partners system actor) is a RenderPort consumer; QR drawn by C6 from `portalUrl`; data schema `contracts/render/partners.access_slip.schema.json`. | 03-IC §4.16; C6 TRD; C13 TRD |
| CR-C14-001 | C14→C0-0C | port | SmartSummary display fields | **ACCEPT** | Absorbs CR-C16-015. | 03-IC §4.10 |
| CR-C14-002 | C14→C0-0C+C5 | port | LabPort.getAnalyteHistory | **ACCEPT-MODIFIED** | + `includeLegacy` (default false) and point `source` for C18 (§4.14). | 03-IC §4.5 |
| CR-C14-003 | C14→C0-0C | api | Smartreport permissions | **ACCEPT** | `entityType` is free text (≤40); no closed list needed. | 03-IC §11 |
| CR-C14-004 | C14→C0-0C | api | Smartreport error codes (5) | **ACCEPT** |  | 03-IC §8 |
| CR-C14-005 | C14→C2+C0-0B | schema | Feature flag smart_report | **ACCEPT** |  | C2 05-SCHEMA seeds |
| CR-C14-006 | C14→C0-0C | port | SmartReportPort actor rules, status mapping, @throws | **ACCEPT** |  | 03-IC §4.10 |
| CR-C14-007 | C14→C6 | feature | smart-* classes in print stylesheet | **ACCEPT** |  | C6 TRD |
| CR-C14-008 | C14→C0-0D | ui-kit | TextDiff (Phase 3) | **ACCEPT** |  | C0 04-UI-UX §2 |
| CR-C14-009 | C14→C4+C0-0C | port | C14 as FrontdeskPort consumer (`getOrderSummary`, `getPatientDemographicsBatch`, existing purpose `lab_display`) | **ACCEPT** | A19 D-110 / P-46 [CONV id]; names omitted when the caller lacks `lab.worklist.read`/`lab.status_board.read`. C4 fake and contract suite add the caller. | 03-IC §4.3; 01-CM §5.1/§6; C4 TRD |
| CR-C14-010 | C14→C1 | infra | Alert rules wiring `services/worker/src/jobs/smartreport/ops/smartreport.rules.yml` (6 rules) | **ACCEPT** | C14 fix-pass hand-off; P-14. | C1 TRD §11.3 |
| CR-C15-001 | C15→C0-0C | port | PaymentProviderPort launchUrl, getIntent, cancelIntent | **ACCEPT-MODIFIED** | All methods callable by staff or system actors only (R8). | 03-IC §4.9 |
| CR-C15-002 | C15→C0-0C+C4 | port | BillingPort.recordGatewayRefund, allowExceedsDue | **ACCEPT-MODIFIED** | Callers system/staff only (no patient/portal context); `collected_by_membership_id` NULL for gateway capture (R8). | 03-IC §4.4; C4 TRD/05-SCHEMA |
| CR-C15-003 | C15→C0-0C | docs | Payment-intent state table | **ACCEPT** | 03-IC §10.6 replaced by C15 TRD §4.1 I1–I14. | 03-IC §10.6 |
| CR-C15-004 | C15→C0-0D+0B | api/schema | Payment-callback auth resolver + DEFINER | **ACCEPT** | Security sign-off required. | C0 TRD; db/meta |
| CR-C15-005 | C15→C0-0C | api | Payments permissions | **ACCEPT** |  | 03-IC §11 |
| CR-C15-006 | C15→C0-0C | api | Payments error codes (10) | **ACCEPT** |  | 03-IC §8 |
| CR-C15-007 | C15→doc owner+C0-0C | api/docs | Web deployable + routes | **ACCEPT** |  | 01 §2/§3; 03-IC §7 |
| CR-C15-008 | C15→C1 | infra | Public payment routes, egress, KEK | **ACCEPT** |  | C1 TRD |
| CR-C15-009 | C15→C0-0C+C4 | api | C15 consumes v_pub_payment_collection | **ACCEPT** |  | 03-IC §6.2 |
| CR-C15-010 | C15→C0-0C+C6 | port | C6 portal as PaymentProviderPort consumer | **ACCEPT-MODIFIED** | Changed from DEFER by Addendum A11.1 (client decision C-04). Portal is a payment requester: portal actor creates a `reporting.portal_payment_requests` row and enqueues a job; the C6 worker as system actor calls `createIntent`/`getIntent`; amount from `BillingPort.getOrderBalance`; return/cancel URL `<PORTAL>/r/payments/{portal_payment_request_id}/done` (route `portal.payment_done`) [CONV]; ledger only via `payments.intent.settled.v1` → C4. Ships with C15 (R8). | 03-IC §4.9/§7; C6 TRD/SCH |
| CR-C15-011 | C15→C0-0D | ui-kit | SecretField | **ACCEPT** |  | C0 04-UI-UX §2 |
| CR-C15-012 | C15→doc owner | docs | 02-CV §4.7 finance-entered amounts | **MERGED-INTO CR-C4-012** |  | 02-CV §4.7 |
| CR-C15-013 | C15→C0-0B | schema | Audit-trigger excluded columns | **ACCEPT** |  | 02-CV §5.7; C0 05-SCHEMA |
| CR-C15-014 | C15→C4+C0-0C | port | C15 as FrontdeskPort consumer (`getOrderSummary` only, staff or system) | **ACCEPT** | A19 D-110 / P-46 [CONV id]. C4 fake and contract suite add the caller. | 03-IC §4.3; 01-CM §5.1/§6; C4 TRD |
| CR-C15-016 | C15→C4 | api/ui | Front-desk gateway dialog: B12 `returnUrl = cancelUrl = ${LIMS_FRONTDESK_PAYMENT_RESULT_URL}`; `form_post` → QR of `launchUrl` + "Open on this PC"; "Cancel payment" → C15 P5 + P24b via the staff BFF; B12 `x-error-codes` += `payments.amount_not_supported`, `payments.return_url_not_allowed` | **ACCEPT** | A19 D-113 [CONV id]; new C4 config key [CONV], set by C1. | C4 TRD B12, UI §3.6, config; C15 APP-FLOW §2.1/§2.12 |
| CR-C16-001 | C16→C0-0A+0D | shared-lib (paths) | Paths incl. (display) route group | **ACCEPT** |  | 01 §3 |
| CR-C16-002 | C16→C0-0C | api | Engagement permissions + actor sets | **ACCEPT** |  | 03-IC §11 |
| CR-C16-003 | C16→C0-0C | api | Engagement error codes + OTP co-emission | **ACCEPT** |  | 03-IC §8 |
| CR-C16-004 | C16→C2 | port/api/schema | Patient sessions, memberships, device kinds | **ACCEPT-MODIFIED** | Binding by endpoint family (`/v1/identity/auth/patient/*`), not a header; lifetimes 14 d idle / 30 d absolute = DECISION (R10). | 03-IC §4.6; C2 TRD |
| CR-C16-005 | C16→C0-0D+0B+0C | api/schema | Resolvers patientPreAuth, queueDisplayToken + DEFINERs | **ACCEPT-MODIFIED** | Token-hash params `bytea` (R24). | C0 TRD; db/meta |
| CR-C16-006 | C16→C0-0B | schema | Engagement DDL, RLS, helpers | **ACCEPT-MODIFIED** | Token hashes `bytea`; `v_pub_booking_address` dropped (R25). | C16 05-SCHEMA |
| CR-C16-007 | C16→C4 | port | FrontdeskPort patient_app_link, status, createSelfRegisteredPatient | **ACCEPT** |  | 03-IC §4.3 |
| CR-C16-008 | C16→C6 | port/schema | ReportingPort patient actors + redeemPortalLinkForApp | **ACCEPT** |  | 03-IC §4.7 |
| CR-C16-009 | C16→C6 | schema (seed) | Engagement message templates | **ACCEPT-MODIFIED** | New purposes `booking_cancelled`, `booking_reminder` (R13). | 03-IC §4.8; C6 seeds |
| CR-C16-010 | C16→C6 | api | Portal app-link files + fallback pages | **ACCEPT** | Store accounts, listings, signing keys owned by the client (founder 2026-11-06, 04 §13); app ids/fingerprints come from the client. | C6 TRD |
| CR-C16-011 | C16→C0-0C | api | Engagement routes | **ACCEPT-MODIFIED** | `display.queue` → `staff.engagement.queue_display`; fallback id `portal.app_fallback`. | 03-IC §7 |
| CR-C16-012 | C16→C0-0B | schema | engagement.v_pub_* views | **ACCEPT-MODIFIED** | Keep `v_pub_booking_daily`, `v_pub_queue_daily` (C8); address and membership via EngagementPort (R25). | 03-IC §6 (new §6.9) |
| CR-C16-013 | C16→C0-0C | event | C16 consumes catalog.changed, reads v_pub_price_list_items | **ACCEPT** |The `v_pub_price_list_items` read is superseded by CR-C16-023 (A24.1); C16 is no longer a consumer of that view. | 03-IC §3.19/§6.6 |
| CR-C16-014 | C16→C4 | api/ui | C4 shows membership at registration | **ACCEPT-MODIFIED** | Via `EngagementPort.getActiveMembership` (stubbed until C16 ships). | C4 TRD |
| CR-C16-015 | C16→C14 | port | SmartSummary displayName/disclaimerText | **MERGED-INTO CR-C14-001** |  | 03-IC §4.10 |
| CR-C16-016 | C16→C0-0D | ui-kit | Flutter + web components | **ACCEPT** |  | C0 04-UI-UX §2/§8 |
| CR-C16-017 | C16→C0-0D | shared-lib | Flutter dependency pins | **ACCEPT** |  | C0 dependency review |
| CR-C16-018 | C16→C1 | infra | Public exposure + per-IP limits | **ACCEPT-MODIFIED** | Per-IP limits stay coarse DoS guards (carrier CGNAT); session resolve 120/min/IP; 04 §4 identity limits enforced in app (R6). | C1 TRD; C16 TRD |
| CR-C16-019 | C16→C0-0B | schema | Access-log action codes (6) | **ACCEPT-MODIFIED** | Renamed to 2 segments (§4.4). | C0 05-SCHEMA §3.7; C16 TRD |
| CR-C16-020 | C16→(not raised) | feature | Push notifications | **DEFER** | Needs founder B11 first (F-05). | — |
| CR-C16-021 | C16→(not raised) | feature | Coupon redemption at registration | **DEFER** | Out of v1 scope (C16 01-PRD §4.2). | — |
| CR-C16-022 | C16→C5 | view | `lab.v_pub_specimen_timeline` += `replaces_specimen_id`, `specimen_version` | **ACCEPT** | A19 D-106 [CONV id]; additive. | C5 05-SCHEMA §10; 03-IC §6.3; 08 §4.9 |
| CR-C16-023 | C16→C3+C0-0C | port | `CatalogPort.getPriceListStatus` | **ACCEPT** | A24.1 (additive; throws `common.not_found`; C3's status set wins); replaces C16's request-time view read (R25/P-21). | 03-IC §4.2; 08 §4.14; C3 TRD; C16 TRD |
| CR-C17-001 | C17→C4 | event/port | Home-collection orders created by C17, not C4 consumer | **ACCEPT-MODIFIED** | Single order owner per booking type (R7); C4 cancel consumer resolves `home_collection` links by `home_visit_id`. | C4 TRD §8; C16 TRD §4/§7; C17 TRD |
| CR-C17-002 | C17→C0-0C+C5 | port | LabPort.listOrderSpecimens | **MERGED-INTO CR-C10-003** | Use `lookupSpecimens({orderId})`. | 03-IC §4.5 |
| CR-C17-003 | C17→C0-0C+C4 | port | home_visit purpose + birthOn, sex | **ACCEPT** |  | 03-IC §4.3 |
| CR-C17-004 | C17→C2 | api | Native staff-app sessions | **ACCEPT-MODIFIED** | Kind `staff_mobile`; opaque session token + server-held GoTrue refresh token, same model as patient (R10). | C2 TRD; identity.yaml |
| CR-C17-005 | C17→C0-0C+C16 | port | EngagementPort.getHomeAddress | **ACCEPT** | Also hosts `getActiveMembership` (R25). | 03-IC new §4.17 |
| CR-C17-006 | C17→C0-0C | event | collection.synced payments[].reference | **ACCEPT** |  | 03-IC §3.23 |
| CR-C17-007 | C17→C0-0C | api | Homecollection error codes (5) | **ACCEPT** |  | 03-IC §8 |
| CR-C17-008 | C17→C0-0C | api | Homecollection permissions | **ACCEPT** |  | 03-IC §11 |
| CR-C17-009 | C17→C0-0C | api | Homecollection routes (4) | **ACCEPT** |  | 03-IC §7 |
| CR-C17-010 | C17→C0-0D | shared-lib | Flutter dependency pins | **ACCEPT** |  | C0 dependency review |
| CR-C17-011 | C17→C1 | infra | Certificate pin set + rotation runbook | **ACCEPT** |  | C1 TRD |
| CR-C17-012 | C17→Founder | foreign touchpoint | Map hand-off of patient address | **ACCEPT** | Founder APPROVED 2026-11-06 (research/04 §11 row): hand-off to the device's own maps app via OS intent/URL, address only (no name, tests, phone), no embedded map SDK. | C17 TRD/PRD; 07 |
| CR-C17-013 | C17→C0-0D | shared-lib | ctx.core memberships/centres list | **ACCEPT** |  | C0 TRD |
| CR-C17-014 | C17→C6 | seed | Template `homecollection.visit_scheduled` (purpose `booking_confirmation`, SMS, patient; `window_start_local`, `window_end_local` `short_text`) | **ACCEPT** | A19 D-129 [CONV id]; tenant switch stays disabled until the seed exists. | 03-IC §4.8; 08 §4.10; C6 05-SCHEMA §8 |
| CR-C18-001 | C18→C0-0B | schema | migration_staging DDL, lims_migration, system actor | **DEFER** | B4: contract design accepted in principle; no DDL before B4 lifts (founder timing). | — |
| CR-C18-002 | C18→C4+C0 | port/schema/api | LegacyPatientImportPort + legacy refs | **DEFER** | B4. | — |
| CR-C18-003 | C18→C5+C0 | port/schema/api | LegacyResultImportPort + legacy history | **DEFER** | B4. `getAnalyteHistory.includeLegacy` already reserved. | — |
| CR-C18-004 | C18→C6+C0 | port/schema/api | LegacyDocumentImportPort + bucket | **DEFER** | B4. Bucket name reserved `reporting-legacy` (R26). | — |
| CR-C18-005 | C18→C0-0D+0C | shared-lib/port | Tool runtime for tools/* | **DEFER** | B4. | — |
| CR-C18-006 | C18→C1 | infra | Migration host, transfer path, role window | **DEFER** | B4. | — |
| CR-C18-007 | C18→C2 | port semantics | IdentityPort for migration system actor | **DEFER** | B4. | — |
| CR-C18-008 | C18→C3 | api | Catalog import kind credit_parties | **ACCEPT** | Independent of B4 (00 E2/E6 bulk load). | C3 TRD/05-SCHEMA |
| CR-C18-009 | C18→C4+auditor | schema/api | Legacy invoices + opening balances (draft) | **DEFER** | B6/B7 auditor (F-07). | — |
| CR-C18-010 | C18→doc owner | docs | Align B4 default wording | **ACCEPT** | 04 §13 B4 and 07 B4 get the same text. | research/04 §13; 07 |

---

## 4. Consolidated registries (content for 03-IC / 02-CV / C0 in the apply phase)

Everything below is the **final** text. CR-proposed text that differs is superseded. Deferred C18 entries are listed only as reserved names.

### 4.1 Permissions (`contracts/permissions.yaml`)

All new codes pass `^[a-z_]+\.[a-z_]+\.[a-z_]+$` and are unique. `privileged: true` ⇒ aal2 + membership re-validation (04 A4).

```yaml
# contracts/permissions.yaml — additions (append under permissions:)
# --- CR-C2-006
- { code: audit.log.export, privileged: true, roles: [tenant_admin] }   # insider-export control (02 failure mode #10)
- { code: identity.self.manage, privileged: false, roles: [tenant_admin, front_desk, finance, lab_technologist, pathologist, lab_manager, centre_staff, phlebotomist, owner_viewer] }
- { code: platform.staff.manage, privileged: true, roles: [platform_superadmin] }
# --- CR-C3-003
- { code: catalog.referrer.read, privileged: false, roles: [tenant_admin, lab_manager, front_desk, finance, centre_staff] }
- { code: catalog.reference_range.publish, privileged: true, roles: [pathologist, lab_manager] }   # clinical sign-off: analyte versions, ranges, critical limits (A13 D-18)
- { code: catalog.referrer.export, privileged: true, roles: [tenant_admin, lab_manager] }   # doctors' contacts (04 A4 data export)
# --- CR-C4-008
- { code: frontdesk.settings.manage, privileged: true, roles: [tenant_admin] }
- { code: billing.settings.manage, privileged: true, roles: [tenant_admin, finance] }   # tax codes, series scope, CBMS retry
- { code: frontdesk.patient.anonymise, privileged: true, roles: [tenant_admin] }   # 02-CV §5.6, REQ-SEC-139
# --- CR-C4-008/R18
# (description change) billing.settings.manage — "series scope, CBMS retry, payment methods" (no tax codes)
# --- CR-C5-004
- { code: lab.worksheet.manage, privileged: false, roles: [lab_technologist, lab_manager] }
- { code: lab.config.manage, privileged: true, roles: [lab_manager, pathologist] }
- { code: lab.qc_hold.release, privileged: true, roles: [lab_manager, pathologist] }
# --- CR-C6-003
- { code: reporting.report.render, privileged: false, roles: [pathologist, lab_manager] }
- { code: reporting.report.regenerate, privileged: true, roles: [pathologist, lab_manager] }
- { code: reporting.report.bulk_download, privileged: true, roles: [lab_manager, tenant_admin] }   # REQ-SEC-100
- { code: reporting.token.revoke, privileged: true, roles: [tenant_admin] }
- { code: reporting.narrative.write, privileged: false, roles: [pathologist, radiologist, lab_technologist] }
- { code: reporting.narrative.sign, privileged: true, roles: [pathologist, radiologist] }
- { code: reporting.message_template.manage, privileged: true, roles: [tenant_admin] }
- { code: reporting.channel.manage, privileged: true, roles: [tenant_admin] }
- { code: reporting.settings.manage, privileged: true, roles: [tenant_admin, lab_manager] }
- { code: reporting.portal.challenge, privileged: false, roles: [] }   # added to fixed_actor_permissions.portal
# --- CR-C6-007
- { code: identity.signatory.read, privileged: false, roles: [] }   # system actor of reporting only
# --- CR-C7-001
- { code: instruments.instrument.read, privileged: false, roles: [lab_manager, lab_technologist, pathologist] }   # pathologist: A13 D-14
- { code: instruments.instrument.manage, privileged: true, roles: [lab_manager] }
- { code: instruments.ingest.enrol, privileged: false, roles: [] }
# --- CR-C8-001
- { code: analytics.collections.read, privileged: false, roles: [owner_viewer, tenant_admin, finance] }
- { code: analytics.schedule.manage, privileged: false, roles: [owner_viewer, tenant_admin] }
# --- CR-C9-001
- { code: quality.qc_run.review, privileged: false, roles: [lab_technologist, lab_manager, pathologist], phase: 2 }
- { code: quality.autoverify.read, privileged: false, roles: [lab_technologist, pathologist, lab_manager], phase: 2 }
- { code: quality.tat_alert.read, privileged: false, roles: [lab_technologist, pathologist, lab_manager], phase: 2 }
- { code: quality.tat_alert.ack, privileged: false, roles: [lab_technologist, pathologist, lab_manager], phase: 2 }
- { code: quality.config.manage, privileged: false, roles: [lab_manager], phase: 2 }
# --- CR-C10-004
- { code: micro.config.manage, privileged: false, roles: [lab_manager], phase: 2 }
- { code: micro.breakpoint.manage, privileged: true, roles: [lab_manager, pathologist], phase: 2 }
# --- CR-C11-002
- { code: anatomic.case.work, privileged: false, roles: [lab_technologist, pathologist], phase: 2 }
- { code: anatomic.config.manage, privileged: true, roles: [pathologist, lab_manager], phase: 2 }
# --- CR-C12-001
- { code: inventory.master.manage, privileged: false, roles: [lab_manager] }
- { code: inventory.stock.adjust, privileged: true, roles: [lab_manager] }
- { code: inventory.po.manage, privileged: false, roles: [lab_manager, finance] }
- { code: inventory.po.approve, privileged: true, roles: [lab_manager, finance] }
- { code: inventory.cost.read, privileged: false, roles: [lab_manager, finance, owner_viewer] }
- { code: inventory.report.export, privileged: true, roles: [lab_manager, finance, owner_viewer] }
- { code: inventory.bench.record, privileged: false, roles: [lab_technologist, lab_manager] }
# --- CR-C13-002
- { code: partners.partner.read, privileged: false, roles: [tenant_admin, front_desk, centre_staff, finance, lab_manager], phase: 2 }
- { code: partners.manifest.receive, privileged: false, roles: [front_desk, centre_staff, lab_technologist], phase: 2 }
- { code: partners.pickup.manage, privileged: false, roles: [front_desk, centre_staff], phase: 2 }
- { code: partners.referrer.map, privileged: false, roles: [tenant_admin, lab_manager], phase: 2 }
- { code: partners.pickup.request, privileged: false, roles: [], phase: 2 }   # partner actors
- { code: partners.referrer.read, privileged: false, roles: [], phase: 2 }   # partner actors
- { code: partners.referrer.manage, privileged: false, roles: [], phase: 2 }   # partner_admin only
- { code: partners.partner_user.manage, privileged: true, roles: [], phase: 2 }   # partner_admin only
# --- CR-C14-003
- { code: smartreport.template.manage, privileged: false, roles: [pathologist, lab_manager], phase: 2 }
- { code: smartreport.summary.approve, privileged: true, roles: [pathologist], phase: 2 }   # per-summary approval (03-IC §4.10 invariant)
# --- CR-C15-005
- { code: payments.intent.resolve, privileged: true, roles: [finance], phase: 1.5 }
- { code: payments.refund.request, privileged: true, roles: [finance], phase: 1.5 }
- { code: payments.refund.approve, privileged: true, roles: [finance], phase: 1.5 }
- { code: payments.merchant_config.read, privileged: false, roles: [tenant_admin, finance], phase: 1.5 }
- { code: payments.merchant_config.manage, privileged: true, roles: [tenant_admin], phase: 1.5 }
# --- CR-C16-002
- { code: engagement.auth.challenge, privileged: false, roles: [], phase: 3 }   # patient pre_auth stage only
- { code: engagement.self.manage, privileged: false, roles: [], phase: 3 }   # patient
- { code: engagement.link.redeem, privileged: false, roles: [], phase: 3 }   # patient
- { code: engagement.payment.create, privileged: false, roles: [], phase: 3 }   # patient
- { code: engagement.enquiry.create, privileged: false, roles: [], phase: 3 }   # patient
- { code: engagement.queue.board_read, privileged: false, roles: [], phase: 2 }   # device kind queue_display
- { code: engagement.slot.manage, privileged: false, roles: [tenant_admin, lab_manager], phase: 3 }
- { code: engagement.bookable_item.manage, privileged: false, roles: [tenant_admin, lab_manager], phase: 3 }
- { code: engagement.queue.operate, privileged: false, roles: [front_desk, centre_staff], phase: 2 }
- { code: engagement.queue.manage, privileged: false, roles: [tenant_admin, lab_manager], phase: 2 }
- { code: engagement.link.issue, privileged: false, roles: [front_desk, centre_staff], phase: 3 }
- { code: engagement.link.read, privileged: false, roles: [front_desk, centre_staff, tenant_admin], phase: 3 }
- { code: engagement.link.revoke, privileged: false, roles: [front_desk, tenant_admin], phase: 3 }
- { code: engagement.reminder.read, privileged: false, roles: [front_desk, tenant_admin], phase: 2 }
- { code: engagement.reminder.manage, privileged: false, roles: [front_desk], phase: 2 }
- { code: engagement.membership.read, privileged: false, roles: [front_desk, finance, tenant_admin], phase: 3 }
- { code: engagement.membership.enrol, privileged: false, roles: [front_desk], phase: 3 }
- { code: engagement.membership_plan.manage, privileged: true, roles: [tenant_admin, finance], phase: 3 }
- { code: engagement.enquiry.read, privileged: false, roles: [front_desk], phase: 3 }
- { code: engagement.enquiry.respond, privileged: false, roles: [front_desk], phase: 3 }
- { code: engagement.settings.manage, privileged: true, roles: [tenant_admin], phase: 2 }
# --- CR-C17-008
- { code: homecollection.handover.receive, privileged: false, roles: [centre_staff, front_desk, lab_technologist], phase: 3 }
- { code: homecollection.device.manage, privileged: true, roles: [tenant_admin, lab_manager], phase: 3 }
- { code: homecollection.settings.manage, privileged: true, roles: [tenant_admin, lab_manager], phase: 3 }
# --- Addendum A13 (review batch 1)
- { code: identity.centre.read, privileged: false, roles: [tenant_admin, front_desk, finance, lab_technologist, pathologist, lab_manager, centre_staff, owner_viewer] }   # [CONV] centre directory (P0); C2 listCentres (D-16)
- { code: billing.refund.request, privileged: true, roles: [finance] }   # two-person refund, 08 R15 (D-24); billing.refund.approve unchanged
```

Additional permission entries (not in brace form in the CRs):
```yaml
# CR-C6-007 (system actor of reporting only)
- { code: identity.signatory.read, privileged: false, roles: [] }
# R6 (platform console; checked by PlatformAuthz) — removed by Addendum A1 (03-IC §13 preamble)
# - { code: platform.tenant_egress_ip.manage, privileged: true, roles: [platform_superadmin] }
```

Renames (R19) — replace everywhere:
```yaml
# old code: new code (strict YAML mapping; notation changed from `->` by Addendum A13 apply, meaning unchanged)
analytics.export:          analytics.data.export      # { privileged: true, roles: [owner_viewer, tenant_admin] }
billing.export:            billing.data.export        # { privileged: true, roles: [finance] }
billing.release_override:  billing.release.override   # { privileged: true, roles: [finance, tenant_admin] }
```

Role-list changes on existing codes (and one privilege change, A13 D-18):
```yaml
reporting.report.read:      roles += [lab_manager, tenant_admin]                 # CR-C6-003
micro.culture.work:         roles  = [lab_technologist, pathologist]             # CR-C10-004
anatomic.case.read:         roles += [lab_manager]                               # CR-C11-002
inventory.item.read:        roles  = [lab_manager, lab_technologist, finance, owner_viewer]   # CR-C12-001
engagement.booking.read:    roles += [centre_staff, tenant_admin, lab_manager]   # CR-C16-002
engagement.booking.manage:  roles += [centre_staff]                              # CR-C16-002
homecollection.visit.read:  roles += [lab_manager]                               # CR-C17-008
payments.intent.create:     roles += [finance]                                   # CR-C15-005
identity.self.manage:       roles  = [tenant_admin, front_desk, finance, lab_technologist, pathologist, lab_manager,
                                      centre_staff, phlebotomist, owner_viewer, radiologist]   # CR-C2-006 + CR-C6-003
billing.settings.manage:    'description = "Billing settings: invoice series scope, CBMS retry, payment methods (tax rules live in C3)"'  # R18 (quoted for strict YAML, A13 apply)
lab.specimen.read:          roles += [front_desk, phlebotomist]                  # A13 D-4 (RLS keeps centre scope)
frontdesk.patient.read:     roles += [tenant_admin]                              # A13 D-28
frontdesk.order.read:       roles += [tenant_admin]                              # A13 D-28
catalog.instrument_code_map.manage: privileged = true                            # A13 D-18 (lab_manager already mfa_required)
micro.culture.read:         roles += [lab_manager]                               # A17 D-64
reporting.report.read:      roles += [radiologist]                               # A21.3
```

New tenant role and partner roles, final fixed actor sets:
```yaml
# roles / partner_roles additions
# --- CR-C6-003
- { code: radiologist, mfa_required: true, description: "Writes and signs imaging/endoscopy narrative reports" }
# --- CR-C13-002
- { code: partner_member, mfa_required: false }
- { code: partner_admin, mfa_required: true }
```
```yaml
fixed_actor_permissions:
  device:                       # by claims device_kind; absent = bridge_agent (CR-C16-002)
    bridge_agent:  [instruments.ingest.submit, instruments.ingest.heartbeat, instruments.ingest.host_query,
                    instruments.ingest.config_read, instruments.ingest.enrol]                     # + CR-C7-001
    queue_display: [engagement.queue.board_read]
  portal:  [reporting.portal.view, reporting.portal.download, reporting.portal.challenge]          # + CR-C6-003
  patient: [engagement.self.read, engagement.booking.create, engagement.booking.cancel, reporting.portal.view,
            reporting.portal.download, engagement.self.manage, engagement.link.redeem, engagement.payment.create,
            engagement.enquiry.create]                                                            # + CR-C16-002
  patient_pre_auth: [engagement.auth.challenge]                                                   # new key
  partner:                      # by partner role (CR-C13-002)
    partner_member: [partners.order.read, partners.manifest.submit, partners.report.read, partners.statement.read,
                     partners.price_list.read, partners.pickup.request, partners.referrer.read,
                     identity.self.manage]   # 08 A19 D-101 (partner self-service; partner_admin inherits)
    partner_admin:  [<partner_member set>, partners.referrer.manage, partners.partner_user.manage]
  system: declared per worker manifest (02-CV §2.3), subset of tenant permissions, never platform.*
```
CI rules added: a code with `roles: []` is actor-only or system-only and may never be granted to a tenant role; partner-only and patient-only codes may never be granted to tenant roles; staff codes never to partner/patient sets (CR-C13-002, C16-002); the one listed exception is `identity.self.manage` in `fixed_actor_permissions.partner.partner_member` (08 A19 D-101). Reserved (DEFER, B4): `frontdesk.patient.import_legacy`, `lab.legacy_result.import`, `reporting.legacy_document.import`, `reporting.legacy_document.read`.

### 4.2 Error codes (`contracts/errors.yaml`)

No collisions with existing codes; every code is `<owner_module>.<snake_reason>`; `billing.tax_config_missing` excluded (R18).

```yaml
# contracts/errors.yaml — additions
# --- CR-C2-007
- { code: identity.code_duplicate, http: 409, owner: C2, title: "Code already used", meaning: "Tenant/branch/centre/role code not unique in scope" }
- { code: identity.self_action_forbidden, http: 409, owner: C2, title: "Not allowed on your own account", meaning: "Lock/deactivate/revoke-current/MFA-reset of self" }
- { code: identity.tenant_not_ready, http: 409, owner: C2, title: "Tenant not ready", meaning: "Activation needs an accepted admin, a branch and a centre" }
- { code: identity.annex_invalid_transition, http: 409, owner: C2, title: "IRD annex status change not allowed", meaning: "03-APP-FLOW §2.5" }
- { code: identity.export_too_large, http: 422, owner: C2, title: "Export range too large", meaning: "Range > 31 days or > 500,000 rows" }
- { code: identity.platform_ip_denied, http: 403, owner: C2, title: "Access not allowed from this network", meaning: "Platform staff IP allowlist (REQ-SEC-063)" }
# --- CR-C3-003
- { code: catalog.tax_config_missing, http: 422, owner: C3, title: "Tax configuration missing", meaning: "No tenant-default tax rule (04 L15/L25, B7)" }
- { code: catalog.import_not_committable, http: 409, owner: C3, title: "Import cannot be committed", meaning: "Not in validated state, expired, or already committed" }
- { code: catalog.import_stale_base, http: 409, owner: C3, title: "Price list changed since export", meaning: "Base version superseded; resend with accept_stale_base" }
# --- CR-C4-007
- { code: billing.credit_period_already_billed, http: 409, owner: C4, title: "Credit period already billed", meaning: "No uninvoiced charges for the credit party and month" }
- { code: frontdesk.discount_self_approval_forbidden, http: 403, owner: C4, title: "Requester cannot approve own discount", meaning: "Segregation of duties (00 A8)" }
- { code: frontdesk.retention_not_elapsed, http: 409, owner: C4, title: "Retention period not elapsed", meaning: "Anonymisation before tenant retentionYears (B15)" }
# --- CR-C5-005
- { code: lab.barcode_pattern_invalid, http: 500, owner: C5, title: "Barcode numbering configuration invalid", meaning: "Rendered barcode violates [A-Z0-9]{1,20} or counter overflow" }
- { code: lab.specimen_inactive, http: 409, owner: C5, title: "Specimen inactive", meaning: "Order cancelled or test removed; specimen not usable" }
- { code: lab.flag_ack_required, http: 409, owner: C5, title: "Flag acknowledgement required", meaning: "Delta/critical/unit/instrument flag must be acknowledged before verification" }
# --- CR-C6-004
- { code: reporting.version_not_latest, http: 409, owner: C6, title: "A newer report version exists", meaning: "Only the latest non-discarded version can be released/printed as current" }
- { code: reporting.report_cancelled, http: 409, owner: C6, title: "Report cancelled", meaning: "Order cancelled; no new versions or releases" }
- { code: reporting.narrative_locked, http: 409, owner: C6, title: "Narrative report is signed", meaning: "Start an amendment instead" }
- { code: reporting.narrative_incomplete, http: 422, owner: C6, title: "Required sections are empty", meaning: "Fill required sections before signing" }
- { code: reporting.input_file_not_ready, http: 409, owner: C6, title: "File not ready", meaning: "Scan/sanitise still running or file rejected" }
- { code: reporting.print_not_ready, http: 409, owner: C6, title: "Print file not ready", meaning: "Plain/bulk print still rendering" }
- { code: reporting.channel_not_configured, http: 422, owner: C6, title: "Channel not configured", meaning: "No active channel account for this channel" }
- { code: reporting.callback_rejected, http: 400, owner: C6, title: "Callback rejected", meaning: "Unknown callback token or bad signature; identical response" }
# --- CR-C7-002
- { code: instruments.agent_not_active, http: 409, owner: C7, title: "Agent not active", meaning: "Agent retired (or revoked where the action needs an active agent)" }
- { code: instruments.agent_has_active_instruments, http: 409, owner: C7, title: "Agent still has instruments", meaning: "Retire or move instruments first" }
- { code: instruments.invalid_transition, http: 409, owner: C7, title: "State change not allowed", meaning: "Agent/instrument/command state machine (03-APP-FLOW §2)" }
- { code: instruments.go_live_checklist_incomplete, http: 422, owner: C7, title: "Go-live checklist incomplete", meaning: "All checklist items and an evidence note are required" }
- { code: instruments.capability_not_supported, http: 422, owner: C7, title: "Capability not supported", meaning: "Driver/instrument does not support host query, worklist or file drop" }
- { code: instruments.message_too_large, http: 413, owner: C7, title: "Message too large", meaning: "Single message above the per-message limit" }
- { code: instruments.reprocess_not_allowed, http: 409, owner: C7, title: "Message cannot be reprocessed", meaning: "Host query, retired instrument, or record not eligible" }
- { code: instruments.code_duplicate, http: 409, owner: C7, title: "Code already used", meaning: "agent_code or instrument_code exists in the tenant" }
# --- CR-C8-002
- { code: analytics.export_not_ready, http: 409, owner: C8, title: "Export not ready", meaning: "Queued or building" }
- { code: analytics.export_unavailable, http: 410, owner: C8, title: "Export no longer available", meaning: "Expired, failed or download limit reached" }
- { code: analytics.export_too_large, http: 422, owner: C8, title: "Export too large", meaning: "Row or size cap exceeded; narrow the period" }
- { code: analytics.recipient_ineligible, http: 422, owner: C8, title: "Recipient not eligible", meaning: "Membership inactive or lacks the report permission" }
# --- CR-C9-002
- { code: quality.code_duplicate, http: 409, owner: C9, title: "Already exists", meaning: "Material/level/lot code, control-ID map or QC plan for the pair already exists" }
- { code: quality.rerun_required, http: 409, owner: C9, title: "Accepted QC rerun required", meaning: "Rejected run can be closed only after a later accepted run (01 §2.5)" }
- { code: quality.rule_set_invalid, http: 422, owner: C9, title: "Auto-verification rules invalid", meaning: "DSL validation errors in errors[]" }
- { code: quality.rule_set_invalid_transition, http: 409, owner: C9, title: "Rule set version cannot change state", meaning: "03-APP-FLOW §2.3" }
- { code: quality.simulation_incomplete, http: 409, owner: C9, title: "Simulation not long enough", meaning: "sim_min_days / sim_min_decisions not met" }
- { code: quality.self_activation_forbidden, http: 403, owner: C9, title: "Another person must activate", meaning: "Four-eyes activation of auto-verification rules" }
- { code: quality.insufficient_qc_data, http: 422, owner: C9, title: "Not enough QC data", meaning: "Fewer observations than target_min_points" }
# --- CR-C10-005
- { code: micro.culture_invalid_transition, http: 409, owner: C10, title: "Culture cannot move to the requested state", meaning: "03-APP-FLOW §2.1" }
- { code: micro.isolate_invalid_transition, http: 409, owner: C10, title: "Isolate cannot move to the requested state", meaning: "03-APP-FLOW §2.2" }
- { code: micro.ast_value_invalid, http: 422, owner: C10, title: "AST value invalid", meaning: "MIC/zone syntax or range" }
- { code: micro.ast_category_not_allowed, http: 422, owner: C10, title: "Interpretive category not allowed", meaning: "Not a code of the standard, or restricted for this antibiotic (04 D14)" }
- { code: micro.report_incomplete, http: 422, owner: C10, title: "Report is incomplete", meaning: "Preliminary/final completeness guards" }
- { code: micro.amendment_reason_required, http: 422, owner: C10, title: "Amendment reason required", meaning: "Reopen/amend needs a coded reason" }
- { code: micro.instrument_record_conflict, http: 409, owner: C10, title: "Instrument record conflicts with existing data", meaning: "Choose use_instrument or keep_existing" }
- { code: micro.breakpoint_import_invalid, http: 422, owner: C10, title: "Breakpoint file rejected", meaning: "Not UTF-8 text, NUL bytes, or duplicate file" }
- { code: micro.breakpoint_set_invalid_transition, http: 409, owner: C10, title: "Breakpoint set cannot change state", meaning: "03-APP-FLOW §2.5" }
- { code: micro.breakpoint_four_eyes_required, http: 403, owner: C10, title: "Another user must activate this set", meaning: "Importer cannot activate own import" }
- { code: micro.code_duplicate, http: 409, owner: C10, title: "Code already used", meaning: "Protocol/panel code or active vocabulary map key exists" }
# --- CR-C11-003
- { code: anatomic.case_invalid_transition, http: 409, owner: C11, title: "Case cannot move to the requested state", meaning: "C11 TRD §7" }
- { code: anatomic.accession_pattern_invalid, http: 500, owner: C11, title: "Accession numbering configuration invalid", meaning: "Pattern tokens/charset invalid or counter overflow" }
- { code: anatomic.report_incomplete, http: 422, owner: C11, title: "Report incomplete", meaning: "Required report content missing at sign-out; details in errors[]" }
- { code: anatomic.template_invalid, http: 422, owner: C11, title: "Template definition invalid", meaning: "Synoptic definition violates schema; details in errors[]" }
- { code: anatomic.template_not_published, http: 409, owner: C11, title: "Template not published", meaning: "Draft or retired template used/retired" }
- { code: anatomic.block_not_available, http: 409, owner: C11, title: "Block not available", meaning: "Block sent out or discarded" }
- { code: anatomic.image_limit_reached, http: 422, owner: C11, title: "Image limit reached", meaning: "Per-case or per-report image limit" }
- { code: anatomic.image_not_ready, http: 409, owner: C11, title: "Image not ready", meaning: "Still processing or quarantined", retired: true }
- { code: anatomic.order_item_inactive, http: 409, owner: C11, title: "Order item no longer active", meaning: "Item removed/cancelled at front desk" }
- { code: anatomic.batch_closed, http: 409, owner: C11, title: "Batch closed", meaning: "" }
- { code: anatomic.batch_position_taken, http: 409, owner: C11, title: "Batch position already used", meaning: "" }
# --- CR-C12-003
- { code: inventory.code_duplicate, http: 409, owner: C12, title: "Code already used", meaning: "item/pack/store/supplier/barcode code exists in the tenant" }
- { code: inventory.item_inactive, http: 409, owner: C12, title: "Item inactive", meaning: "" }
- { code: inventory.item_in_use, http: 409, owner: C12, title: "Item in use", meaning: "Deactivation blocked: stock or open PO lines" }
- { code: inventory.store_not_empty, http: 409, owner: C12, title: "Store not empty", meaning: "Deactivation blocked: non-zero balance" }
- { code: inventory.po_self_approval_forbidden,http: 403, owner: C12, title: "Approver must differ from creator", meaning: "Tenant setting" }
- { code: inventory.over_receipt, http: 422, owner: C12, title: "Received quantity exceeds order", meaning: "Beyond tolerance" }
- { code: inventory.document_invalid_transition,http: 409, owner: C12, title: "Document state change not allowed", meaning: "GRN/transfer/count/container/fact/alert" }
- { code: inventory.lot_unavailable, http: 409, owner: C12, title: "Lot not available", meaning: "Quarantined or blocked" }
- { code: inventory.reason_required, http: 422, owner: C12, title: "Reason required", meaning: "" }
- { code: inventory.fact_not_reversible, http: 409, owner: C12, title: "Consumption cannot be reversed", meaning: "Only manual facts are reversible" }
- { code: inventory.store_locked_for_count, http: 409, owner: C12, title: "Store is being counted", meaning: "Tenant setting count_locks_store" }
- { code: inventory.count_already_open, http: 409, owner: C12, title: "A count is already open for this store", meaning: "" }
- { code: inventory.rule_conflict, http: 409, owner: C12, title: "A current rule exists", meaning: "Supersede the existing rule instead" }
- { code: inventory.export_too_large, http: 422, owner: C12, title: "Export too large", meaning: "Row cap exceeded; narrow the range" }
- { code: inventory.range_too_large, http: 422, owner: C12, title: "Date range too large", meaning: "" }
# --- CR-C13-009
- { code: partners.manifest_not_editable, http: 409, owner: C13, title: "Manifest can no longer be edited", meaning: "Lines are read-only after submit" }
- { code: partners.manifest_invalid_transition, http: 409, owner: C13, title: "Manifest cannot move to the requested state", meaning: "03-APP-FLOW §2.1" }
- { code: partners.manifest_line_invalid_transition, http: 409, owner: C13, title: "Manifest line cannot move to the requested state", meaning: "03-APP-FLOW §2.2" }
- { code: partners.orderable_not_offered, http: 422, owner: C13, title: "Test not offered to this partner", meaning: "Not in the partner price-list projection" }
- { code: partners.pickup_invalid, http: 422, owner: C13, title: "Pickup request invalid", meaning: "Window or manifest rules" }
- { code: partners.pickup_invalid_transition, http: 409, owner: C13, title: "Pickup cannot move to the requested state", meaning: "03-APP-FLOW §2.3" }
- { code: partners.partner_invalid_transition, http: 409, owner: C13, title: "Partner cannot move to the requested state", meaning: "" }
- { code: partners.partner_user_invalid_transition, http: 409, owner: C13, title: "Partner user cannot move to the requested state", meaning: "" }
- { code: partners.last_partner_admin, http: 409, owner: C13, title: "Cannot remove the last partner admin", meaning: "" }
- { code: partners.self_action_forbidden, http: 409, owner: C13, title: "You cannot change your own access", meaning: "" }
- { code: partners.code_duplicate, http: 409, owner: C13, title: "Partner code already used", meaning: "" }
- { code: partners.credit_party_in_use, http: 409, owner: C13, title: "Credit party already linked to a partner", meaning: "" }
- { code: partners.credit_party_inactive, http: 422, owner: C13, title: "Credit party inactive", meaning: "" }
- { code: partners.referrer_duplicate, http: 409, owner: C13, title: "Referrer already exists", meaning: "" }
- { code: partners.referrer_not_mapped, http: 422, owner: C13, title: "Referrer not yet linked by the lab", meaning: "require_mapped_referrer" }
- { code: partners.referrer_doctor_inactive, http: 422, owner: C13, title: "Doctor record inactive", meaning: "" }
- { code: partners.referrer_invalid_transition, http: 409, owner: C13, title: "Referrer mapping cannot change", meaning: "" }
- { code: partners.setting_out_of_range, http: 422, owner: C13, title: "Setting out of allowed range", meaning: "02-TRD §10.2" }
# --- CR-C14-004
- { code: smartreport.library_invalid, http: 422, owner: C14, title: "Template library invalid", meaning: "Validation rules V1–V14 failed; details in errors[]" }
- { code: smartreport.library_invalid_transition, http: 409, owner: C14, title: "Template library cannot change state", meaning: "Edit outside draft, second open draft, or illegal transition" }
- { code: smartreport.summary_invalid_transition, http: 409, owner: C14, title: "Summary cannot change state", meaning: "Approve/reject outside draft" }
- { code: smartreport.summary_superseded, http: 409, owner: C14, title: "Summary built on superseded results", meaning: "Approved results changed after the summary was built" }
- { code: smartreport.summary_not_ready, http: 409, owner: C14, title: "Smart summary not available yet", meaning: "No approved summary for the current results (patient/portal/partner callers)" }
# --- CR-C15-006
- { code: payments.amount_not_supported, http: 422, owner: C15, title: "Amount not supported by this payment method", meaning: "Khalti < 1000 paisa (04 P4); eSewa fractional rupees while unverified" }
- { code: payments.return_url_not_allowed, http: 422, owner: C15, title: "Return address not allowed", meaning: "returnUrl/cancelUrl outside the allowlist" }
- { code: payments.intent_invalid_transition, http: 409, owner: C15, title: "Payment cannot move to the requested state", meaning: "02-TRD §4.1" }
- { code: payments.intent_not_verifiable, http: 409, owner: C15, title: "Payment not confirmed by the provider", meaning: "Resolve requires gateway success + exact amount" }
- { code: payments.refund_not_allowed, http: 409, owner: C15, title: "Refund not allowed", meaning: "Intent not settled, refund in progress, or wrong refund state" }
- { code: payments.refund_self_approval_forbidden, http: 403, owner: C15, title: "Refund needs a second approver", meaning: "REQ-SEC-055 two-person rule" }
- { code: payments.credential_invalid, http: 422, owner: C15, title: "Merchant credentials rejected", meaning: "Gateway rejected the key during test" }
- { code: payments.reconciliation_in_progress, http: 409, owner: C15, title: "Reconciliation already running", meaning: "" }
- { code: payments.callback_mismatch, http: 400, owner: C15, title: "Callback does not match payment", meaning: "Recorded outcome only; callbacks never change state" }
- { code: payments.static_qr_already_reconciled, http: 409, owner: C15, title: "Already reconciled", meaning: "One worksheet per date and centre" }
# --- CR-C16-003
- { code: engagement.link_code_invalid, http: 422, owner: C16, title: "Code not valid", meaning: "Unknown, expired, used, wrong phone, or report link not valid — identical response" }
- { code: engagement.link_limit_reached, http: 409, owner: C16, title: "Profile limit reached", meaning: "Per-account or per-patient link limit; self profile exists; address limit" }
- { code: engagement.booking_invalid_transition, http: 409, owner: C16, title: "Booking cannot move to the requested state", meaning: "03-APP-FLOW §4.1" }
- { code: engagement.slot_outside_window, http: 422, owner: C16, title: "Slot not bookable", meaning: "Past, inside lead time, beyond horizon, or not a generated slot" }
- { code: engagement.orderable_not_bookable, http: 422, owner: C16, title: "Test not available for booking", meaning: "Not in the bookable catalogue for this kind, or sex restriction" }
- { code: engagement.address_required, http: 422, owner: C16, title: "Address required", meaning: "Home collection needs an address" }
- { code: engagement.queue_closed, http: 409, owner: C16, title: "Queue not open", meaning: "Queue inactive or queue feature off" }
- { code: engagement.queue_token_invalid_transition, http: 409, owner: C16, title: "Token cannot move to the requested state", meaning: "03-APP-FLOW §4.3" }
- { code: engagement.membership_overlap, http: 409, owner: C16, title: "Membership already active", meaning: "One active membership per patient" }
- { code: engagement.plan_inactive, http: 409, owner: C16, title: "Membership plan inactive", meaning: "" }
- { code: engagement.reminder_invalid_transition, http: 409, owner: C16, title: "Reminder cannot change", meaning: "Already sent/cancelled" }
- { code: engagement.enquiry_invalid_transition, http: 409, owner: C16, title: "Enquiry cannot change", meaning: "Closed, or open-enquiry limit" }
- { code: engagement.setting_out_of_range, http: 422, owner: C16, title: "Setting out of allowed range", meaning: "05-SCHEMA §2.1" }
# --- CR-C17-007
- { code: homecollection.app_version_unsupported, http: 426, owner: C17, title: "App update required", meaning: "Below tenant min_app_version (REQ-SEC-113)" }
- { code: homecollection.device_not_registered, http: 409, owner: C17, title: "Device not registered", meaning: "Unknown device id or bound to another user" }
- { code: homecollection.visit_incomplete, http: 422, owner: C17, title: "Visit is not ready to assign", meaning: "Address and time window required" }
- { code: homecollection.phlebotomist_not_eligible, http: 422, owner: C17, title: "Phlebotomist cannot take this visit", meaning: "Inactive, other centre, or no phlebotomist role" }
- { code: homecollection.collection_not_held, http: 409, owner: C17, title: "Collection is not awaiting review", meaning: "" }
# --- Addendum A13 (review batch 1)
- { code: billing.numbering_pattern_invalid, http: 409, owner: C4, title: "Invoice pattern lacks {branch} for branch series", meaning: "invoice_series_scope = branch but invoiceNoPattern has no {branch} at allocation; no invoice issued; alert" }   # D-23
- { code: billing.refund_self_approval_forbidden, http: 403, owner: C4, title: "Refund approver must differ from requester", meaning: "Approver of a refund request is its requester (08 R15)" }   # D-24; title [CONV]
```

Meaning changes on existing codes (Addendum A13): `billing.counter_busy` → "Counter row lock timeout or FY rollover during allocation; retry" (D-25; FY rollover carries `detail: "fiscal_year_rollover"`). `common.validation_failed` stays `400` only (P-1; 02-CV §4.7).

Additional entries:
```yaml
# - { code: identity.egress_ip_limit, … }   # (R6) — removed by Addendum A1 (03-IC §13 preamble)
```
Emission exceptions (03-IC §8 footnote): `auth.session_expired` may also be emitted by `apps/web/src/core/session/policy.ts` (CR-C0-005); module `engagement` may emit `auth.otp_invalid` and `auth.otp_attempts_exhausted` with the C6 meaning (CR-C16-003); a code thrown by a port propagates unchanged through the calling module (R18): the handler rethrows the original `LimsError` and never constructs it, and the caller may list the code in its `x-error-codes`; current users C4 and C12 (`catalog.*`), C10 and C11 (`lab.*`) (A17 P-23). Reserved (DEFER, B4): `frontdesk.legacy_batch_conflict`, `frontdesk.legacy_void_window_closed`, `lab.legacy_batch_conflict`, `lab.legacy_void_window_closed`, `reporting.legacy_batch_conflict`, `reporting.legacy_void_window_closed`.

### 4.3 Routes (`contracts/routes.yaml`)

No id or path collisions (checked against 03-IC §7). Origins added (CR-C1-004): `api: { env: LIMS_ORIGIN_API, owner: C1 }` (the `files` origin of CR-C1-004 is removed — A14.2). New auth value `display_token`; new fallback id `portal.app_fallback` (served by C6, CR-C16-010).

```yaml
# contracts/routes.yaml — additions (append under routes:)
# --- CR-C5-007
- { id: staff.lab.order_labels, origin: staff_web, path: "/lab/orders/{order_id}/labels", owner: C5, permission: lab.specimen.label_print }
- { id: staff.lab.ingest_exception, origin: staff_web, path: "/lab/ingest-exceptions/{exception_id}", owner: C5, permission: lab.result.read }
# --- CR-C7-014 (A16.2)
- { id: staff.lab.ingest_exceptions, origin: staff_web, path: /lab/ingest-exceptions, owner: C5, permission: lab.result.read }
# --- CR-C6-011
- { id: staff.reporting.worklist, origin: staff_web, path: /reporting, owner: C6, permission: reporting.report.read }
- { id: staff.reporting.narrative, origin: staff_web, path: "/reporting/narratives/{narrative_id}", owner: C6, permission: reporting.narrative.write }
- { id: staff.reporting.outsourced, origin: staff_web, path: /reporting/outsourced, owner: C6, permission: reporting.outsourced.attach }
- { id: staff.reporting.template, origin: staff_web, path: "/reporting/templates/{template_id}", owner: C6, permission: reporting.template.manage }
- { id: staff.reporting.settings, origin: staff_web, path: /reporting/settings, owner: C6, permission: reporting.settings.manage }
- { id: staff.reporting.messages, origin: staff_web, path: /reporting/messages, owner: C6, permission: reporting.message_template.manage }
# --- CR-C7-003
- { id: staff.instruments.agents, origin: staff_web, path: /instruments/agents, owner: C7, permission: instruments.agent.read }
- { id: staff.instruments.instruments, origin: staff_web, path: /instruments/instruments, owner: C7, permission: instruments.instrument.read }
- { id: staff.instruments.instrument, origin: staff_web, path: "/instruments/instruments/{instrument_id}", owner: C7, permission: instruments.instrument.read }
- { id: staff.instruments.instrument_mappings, origin: staff_web, path: "/instruments/instruments/{instrument_id}/mappings", owner: C7, permission: instruments.instrument.read }
- { id: staff.instruments.messages, origin: staff_web, path: /instruments/messages, owner: C7, permission: instruments.message.read }
- { id: staff.instruments.settings, origin: staff_web, path: /instruments/settings, owner: C7, permission: instruments.instrument.read }
# --- CR-C8-008
- { id: staff.analytics.reports, origin: staff_web, path: /analytics/reports, permission: analytics.dashboard.read, owner: C8 }
- { id: staff.analytics.referral_incentive, origin: staff_web, path: /analytics/referral-incentive, permission: analytics.referral_report.read, owner: C8 }
- { id: staff.analytics.exports, origin: staff_web, path: /analytics/exports, permission: analytics.data.export, owner: C8 }
- { id: staff.analytics.schedules, origin: staff_web, path: /analytics/schedules, permission: analytics.schedule.manage, owner: C8 }
- { id: staff.analytics.report_run, origin: staff_web, path: "/analytics/report-runs/{report_run_id}", permission: analytics.dashboard.read, owner: C8 }
# --- A17 D-46
- { id: staff.analytics.collections, origin: staff_web, path: /analytics/collections, permission: analytics.collections.read, owner: C8 }
# --- CR-C10-006
- { id: staff.micro.worklist, origin: staff_web, path: /micro/worklist, owner: C10, permission: micro.culture.read }
- { id: staff.micro.instrument_records, origin: staff_web, path: /micro/instrument-records, owner: C10, permission: micro.culture.read }
- { id: staff.micro.settings, origin: staff_web, path: /micro/settings, owner: C10, permission: micro.config.manage }
- { id: staff.micro.breakpoint_sets, origin: staff_web, path: /micro/breakpoint-sets, owner: C10, permission: micro.breakpoint.manage }
- { id: staff.micro.breakpoint_set, origin: staff_web, path: "/micro/breakpoint-sets/{breakpoint_set_id}", owner: C10, permission: micro.breakpoint.manage }
# --- CR-C11-006
- { id: staff.anatomic.worklist, origin: staff_web, path: /anatomic, owner: C11, permission: anatomic.case.read }
- { id: staff.anatomic.labels, origin: staff_web, path: "/anatomic/cases/{case_id}/labels", owner: C11, permission: anatomic.case.work }
- { id: staff.anatomic.tracking, origin: staff_web, path: /anatomic/tracking, owner: C11, permission: anatomic.case.read }
- { id: staff.anatomic.batches, origin: staff_web, path: /anatomic/batches, owner: C11, permission: anatomic.case.read }
- { id: staff.anatomic.batch, origin: staff_web, path: "/anatomic/batches/{batch_id}", owner: C11, permission: anatomic.case.read }
- { id: staff.anatomic.config, origin: staff_web, path: /anatomic/config, owner: C11, permission: anatomic.config.manage }
- { id: staff.anatomic.template, origin: staff_web, path: "/anatomic/config/templates/{template_id}", owner: C11, permission: anatomic.config.manage }
# --- CR-C12-002
- { id: staff.inventory.home, origin: staff_web, path: /inventory, owner: C12, permission: inventory.item.read }
- { id: staff.inventory.items, origin: staff_web, path: /inventory/items, owner: C12, permission: inventory.item.read }
- { id: staff.inventory.stock, origin: staff_web, path: /inventory/stock, owner: C12, permission: inventory.item.read }
- { id: staff.inventory.purchase_orders, origin: staff_web, path: /inventory/purchase-orders, owner: C12, permission: inventory.item.read }
- { id: staff.inventory.purchase_order, origin: staff_web, path: "/inventory/purchase-orders/{po_id}", owner: C12, permission: inventory.item.read }
- { id: staff.inventory.receipts, origin: staff_web, path: /inventory/receipts, owner: C12, permission: inventory.item.read }
- { id: staff.inventory.receipt, origin: staff_web, path: "/inventory/receipts/{grn_id}", owner: C12, permission: inventory.item.read }
- { id: staff.inventory.transfers, origin: staff_web, path: /inventory/transfers, owner: C12, permission: inventory.item.read }
- { id: staff.inventory.transfer, origin: staff_web, path: "/inventory/transfers/{transfer_id}", owner: C12, permission: inventory.item.read }
- { id: staff.inventory.counts, origin: staff_web, path: /inventory/counts, owner: C12, permission: inventory.item.read }
- { id: staff.inventory.count, origin: staff_web, path: "/inventory/counts/{count_id}", owner: C12, permission: inventory.item.read }
- { id: staff.inventory.bench, origin: staff_web, path: /inventory/bench, owner: C12, permission: inventory.bench.record }
- { id: staff.inventory.rules, origin: staff_web, path: /inventory/rules, owner: C12, permission: inventory.item.read }
- { id: staff.inventory.unresolved, origin: staff_web, path: /inventory/unresolved, owner: C12, permission: inventory.item.read }
- { id: staff.inventory.alerts, origin: staff_web, path: /inventory/alerts, owner: C12, permission: inventory.item.read }
- { id: staff.inventory.reports, origin: staff_web, path: /inventory/reports, owner: C12, permission: inventory.item.read }
- { id: staff.inventory.suppliers, origin: staff_web, path: /inventory/suppliers, owner: C12, permission: inventory.item.read }
- { id: staff.inventory.stores, origin: staff_web, path: /inventory/stores, owner: C12, permission: inventory.item.read }
- { id: staff.inventory.settings, origin: staff_web, path: /inventory/settings, owner: C12, permission: inventory.master.manage }
# --- CR-C13-008
- { id: staff.partners.list, origin: staff_web, path: /partners, owner: C13, permission: partners.partner.read }
- { id: staff.partners.partner, origin: staff_web, path: "/partners/{partner_id}", owner: C13, permission: partners.partner.read }
- { id: staff.partners.inbox, origin: staff_web, path: /partners/manifests, owner: C13, permission: partners.manifest.receive }
- { id: staff.partners.manifest, origin: staff_web, path: "/partners/manifests/{manifest_id}", owner: C13, permission: partners.manifest.receive }
- { id: staff.partners.pickups, origin: staff_web, path: /partners/pickups, owner: C13, permission: partners.pickup.manage }
- { id: staff.partners.referrers, origin: staff_web, path: /partners/referrers, owner: C13, permission: partners.referrer.map }
- { id: staff.partners.settings, origin: staff_web, path: /partners/settings, owner: C13, permission: partners.partner.manage }
# --- CR-C15-007
- { id: staff.payments.review, origin: staff_web, path: /payments/review, owner: C15, permission: payments.reconciliation.read }
- { id: staff.payments.intent, origin: staff_web, path: "/payments/intents/{intent_id}", owner: C15, permission: payments.reconciliation.read }
- { id: staff.payments.refunds, origin: staff_web, path: /payments/refunds, owner: C15, permission: payments.reconciliation.read }
- { id: staff.payments.reconciliation, origin: staff_web, path: /payments/reconciliation, owner: C15, permission: payments.reconciliation.read }
- { id: staff.payments.static_qr, origin: staff_web, path: /payments/static-qr, owner: C15, permission: payments.reconciliation.read }
- { id: staff.payments.settings, origin: staff_web, path: /payments/settings, owner: C15, permission: payments.merchant_config.read }
# --- CR-C16-011
- { id: staff.engagement.bookings, origin: staff_web, path: /engagement/bookings, owner: C16, permission: engagement.booking.read }
- { id: staff.engagement.slots, origin: staff_web, path: /engagement/slots, owner: C16, permission: engagement.slot.manage }
- { id: staff.engagement.bookable, origin: staff_web, path: /engagement/bookable-items, owner: C16, permission: engagement.bookable_item.manage }
- { id: staff.engagement.queue, origin: staff_web, path: /engagement/queue, owner: C16, permission: engagement.queue.operate }
- { id: staff.engagement.queue_setup, origin: staff_web, path: /engagement/queue/setup, owner: C16, permission: engagement.queue.manage }
- { id: staff.engagement.app_access, origin: staff_web, path: "/engagement/app-access/{patient_id}", owner: C16, permission: engagement.link.read }
- { id: staff.engagement.reminders, origin: staff_web, path: /engagement/reminders, owner: C16, permission: engagement.reminder.read }
- { id: staff.engagement.memberships, origin: staff_web, path: /engagement/memberships, owner: C16, permission: engagement.membership.read }
- { id: staff.engagement.enquiries, origin: staff_web, path: /engagement/enquiries, owner: C16, permission: engagement.enquiry.read }
- { id: staff.engagement.settings, origin: staff_web, path: /engagement/settings, owner: C16, permission: engagement.settings.manage }
- { id: staff.engagement.queue_display, origin: staff_web, path: /queue-display, owner: C16, auth: display_token, nav: false }
- { id: patient_app.payment_done, origin: patient_app, path: "/payments/{payment_request_id}/done", owner: C16, auth: patient, fallback: portal.app_fallback }
# --- CR-C17-009
- { id: staff.homecollection.dispatch, origin: staff_web, path: /homecollection/dispatch, owner: C17, permission: homecollection.visit.read }
- { id: staff.homecollection.handovers, origin: staff_web, path: /homecollection/handovers, owner: C17, permission: homecollection.handover.receive }
- { id: staff.homecollection.devices, origin: staff_web, path: /homecollection/devices, owner: C17, permission: homecollection.device.manage }
- { id: staff.homecollection.settings, origin: staff_web, path: /homecollection/settings, owner: C17, permission: homecollection.settings.manage }
# --- Addendum A11.1 (CR-C15-010 ACCEPT-MODIFIED; id and auth [CONV], A14.3) — in 03-IC §7 under "portal"
- { id: portal.payment_done, origin: portal, path: "/r/payments/{portal_payment_request_id}/done", owner: C6, auth: link_token+otp }
# --- A21.1 dues link (path from the C6 second-pass hand-off, accepted; id [CONV]) — in 03-IC §7 under "portal"
- { id: portal.dues_link, origin: portal, path: "/r/{link_token}/dues", owner: C6, auth: link_token+otp }
```
API operations recorded in the final sweep (not app routes; listed in 03-IC §7 after the YAML block): C6 P7 `getPortalDues`; C15 P7b `recheckPaymentRefund`, P11b `failManualPaymentRefund`, P24b `listPaymentCancelReasons`; coded set `payments.refund_fail_reasons`.

### 4.4 Access-log action codes (`audit.g_cs_access_actions` seed; CHECK `^[a-z_]+\.[a-z_]+$`)

Existing C0 seed kept. Additions (code — display — requested by):
```yaml
# Strict YAML list, one code per line (as 03-IC §13.1, A4.8; converted by the A13 apply); display text and provenance as trailing comments
# C2 (CR-C2-010, mapped from bare event types)
- audit_entry.view                  # "Audit entry viewed" — was 'view' (audit_entry)
- dead_letter.view                  # "Dead letter viewed" — was 'view' (dead_letter)
- audit_export.download             # "Audit export downloaded" — create uses existing data.export
- ird_document.download             # "IRD annex document downloaded"
- branding_asset.download           # "Branding asset downloaded"
- support_session.approve           # "Support session approved"
- support_session.deny              # "Support session denied"
- support_session.activate          # "Support session activated"
- support_session.revoke            # "Support session revoked" — 'open'/'close' exist; 'end' maps to close
- tenant.lifecycle_change           # "Tenant provisioned/activated/suspended/terminated"
- settings.change                   # "Tenant settings changed"
- feature_flag.change               # "Feature flag changed"
# tenant_egress_ip.change           # "Registered egress IPs changed" (R6) — removed by Addendum A1 (03-IC §13 preamble)
# role_change -> existing role.change; session_revoke -> existing session.revoke; export -> existing data.export
# C4
- patient.search                    # "Patient search performed" — was 'patient_search'
- patient.update                    # 08 Addendum A2.9
- patient.anonymise                 # 08 Addendum A2.9
- credit_note.print                 # 08 Addendum A2.9
- receipt.print                     # 08 Addendum A2.9
# C5 (triage batch 1) — 08 A13 D-11
- specimen_label.print              # per specimen, #14
- lab_result.view                   # order results grid
- lab_result_history.view           # history + trend (#26)
- critical_value.view
- worksheet.print
- ingest_exception.view             # exception detail (raw values)
# C6 (CR-C6-008)
- report.release
- report.portal_view
- report.portal_download
- report.outsourced_view
- report.narrative_sign
- report.token_revoke
- portal.session_start
- portal.link_reissue
# C7 (CR-C7-008)
- instrument_message.raw_view
- instrument_message.attachment_view
- instrument_message.reprocess
- instrument_message.rematch
- device_credential.issue
- device_credential.revoke
# C8 (CR-C8-006)
- referral_report.view              # "Referral business report viewed" — was analytics.referral_report.view
# C9 (used in C9 docs, not CR-registered)
- autoverify.activate
- autoverify.retire
# C9 (triage batch 2) — 08 A17 D-53
- autoverify_decision.view         # decision detail drawer (P3 inputs)
- autoverify_simulation.view       # simulation report
# C10 (CR-C10-010, renamed)
- culture.view                      # was micro.culture.view
- breakpoint_set.import             # were micro.breakpoint_set.*
- breakpoint_set.activate           # were micro.breakpoint_set.*
- breakpoint_set.retire             # were micro.breakpoint_set.*
- micro_instrument_record.assign    # was micro.instrument_record.assign
# C11 (triage batch 2; replaces the anatomic.* three-segment strings) — 08 A17 D-53
- anatomic_case.view
- anatomic_report.view             # report version view
- anatomic_image.view              # image content stream
- anatomic_label.print
- anatomic_object.lookup           # success only
- anatomic_report.sign_out
# C13 (CR-C13-012)
- manifest.print
- report.access_slip
- statement.view
# C14 / C16
- smart_summary.view
# C15 (used in C15 docs)
- payment_intent.resolve            # was 'payment_resolve'
# C16 (CR-C16-019, renamed)
- link_code.issue                   # was engagement.link_code.issue
- app_link.redeem                   # was engagement.link.redeem
- app_link.revoke                   # was engagement.link.revoke
- patient_membership.lookup         # was membership.lookup (collided in meaning with staff membership.lock/unlock)
- patient_account.delete            # was engagement.account.delete
# C17 (used in C17 docs)
- home_visit.view                   # was { type: 'view', entity: 'home_visit' }
# C3: catalog file / referrer exports use existing data.export (entityType 'catalog_file' / 'referrer_export')
# Reserved (DEFER, B4): legacy_document.download
```

### 4.5 Human-readable numbering keys (03-IC §9.3)

| Key | Owner | Pattern lives in | Default pattern | Counter scope | Note |
|---|---|---|---|---|---|
| `patient_code` | C4 | `TenantSettings.numbering.patientCodePattern` | `{prefix}{seq:8}` | tenant | unchanged |
| `registration_no` | C4 | `numbering.registrationNoPattern` | `{branch}{prefix}{seq:6}` | tenant + branch | unchanged; C4 grammar (applied by C2): pattern must contain `{branch}` (A13 D-23) |
| `barcode` | C5 | `numbering.barcodePattern` + **`numbering.barcodePrefix`** (`[A-Z0-9]{0,4}`) | `{prefix}{yy}{seq:8}` (A13 D-8: client format 00 §4 `E1100001677` = prefix + yy + 8 digits) | tenant | CR-C5-009; A13 D-8 |
| `invoice_no` | C4 | `numbering.invoiceNoPattern` | `{fy}-{seq:6}` | tenant + FY (B6/L8) | unchanged, gapless; `invoice_series_scope = branch` requires `{branch}` in the pattern (`400 common.validation_failed`, path `/invoice_series_scope`); lost at allocation → `409 billing.numbering_pattern_invalid` (A13 D-23) |
| `credit_note_no` | C4 | `numbering.creditNoteNoPattern` | `CN-{fy}-{seq:6}` | tenant + FY | gapless |
| `receipt_no` | C4 | **`numbering.receiptNoPattern`** | `RC-{fy}-{seq:6}` | tenant + FY | CR-C2-008 |
| `accession_no` | C11 | **`numbering.accessionNoPattern`** + **`numbering.accessionPrefixes{histology,cytology,ihc,molecular}`** (`[A-Z0-9]{0,4}`; defaults S/C/I/M) | `{prefix}{yy}-{seq:4}` | tenant + year + case kind | CR-C11-005; C2 validates with C11's grammar |
| `booking_no` | C16 | engagement settings | `BK{yy}{seq:6}` | tenant | unchanged |
| `manifest_no` | C13 | partners settings | `MF{yy}{seq:6}` | tenant + partner | unchanged |
| `po_no`, `grn_no`, `transfer_no`, `count_no`, `doc_no` | C12 | `inventory.settings` | `PO{yy}{seq:6}`, `GR{yy}{seq:6}`, `TR{yy}{seq:6}`, `SC{yy}{seq:5}`, `SD{yy}{seq:6}` | tenant + period; gaps allowed | CR-C12-007 |

03-IC §9.3 rule text amended: "Patterns of fiscal numbers and of numbers used across modules live in `TenantSettings.numbering` (set by C2, validated with the owning module's grammar). Module-internal, non-fiscal document numbers may live in the owning module's settings table. Every number is unique-indexed with `tenant_id` leading, never a foreign key, never in a URL, never logged except `invoice_no`/`credit_note_no`."

### 4.6 UI-kit components

**Web (`@lims/ui`, C0-0D).** New components and prop changes (props as in the requesting chunk's 04-UI-UX unless stated):

| Component / change | Requested by | Note |
|---|---|---|
| `PermissionMatrix` | C2 | keyboard grid; non-assignable codes disabled |
| `DataUriImage` | C2 | `<img>` from PNG or SVG data URI only; never inline SVG markup |
| `EditableGrid` | C3 | cell editing, per-row status/error cell |
| `CodeField` | C3 | upper-casing, regex hint |
| `FormulaEditor` | C3 | diagnostics from `@lims/shared-ts/formula` |
| `StatusStepper` | C3 | import/publish progress |
| `DiffTable` | C3 + C2 (`JsonDiffView`) | rows `{label, before, after, changed}`; values as text nodes; "changed" text marker |
| `PrintFrame` | C4 | print-only iframe, `@media print` |
| `FileUpload` + `scanState?: Record<string,'pending'\|'clean'\|'infected'\|'unavailable'>`; `accept` union += `'text/csv'`, `'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'` | C4, C10, C3 | replaces FileDropzone/FileDrop |
| `RichTextEditor` | C6 | allowlisted marks; sanitised client + server |
| `OtpInput` | C6 + C2 (`OtpCodeInput`) | 6 numeric cells, `autocomplete="one-time-code"`, paste fills, Enter submits |
| `ImageThumbnailGrid`, `PdfFileCard` | C6 (C11 uses the grid) | |
| `CodeBlock`, `KeyValueListEditor` | C7 | |
| `SecretRevealOnce` (+ `requireAcknowledgement?: boolean` default true) | C7 + C2 (`SecretRevealField`) | secret never re-rendered after close |
| `PeriodPicker`, `DurationText`, `FreshnessBadge` | C8 | C4 may reuse PeriodPicker |
| `ControlChart` | C9 | Levey-Jennings; shapes + text, hidden table |
| `BarcodeSymbol` (Code 128 SVG) | C11 (C5 uses it) | value `^[A-Z0-9-]{1,32}$`, never logged |
| `DecimalField.suffix?: string` | C12 | |
| `QrCode` | C4 (front-desk gateway dialog: QR of `action.launchUrl` / `qrPayload`, 08 A19 D-113; C4 04-UI-UX §3.6). CR-C13-013 withdrawn by C13 (QR drawn by C6 inside the slip PDF, A5.1) | local SVG, no network |
| `TextDiff` | C14 (Phase 3) | grapheme-aware |
| `SecretField` | C15 | masked, never pre-filled |
| `QueueBoard`, `TokenSlip`, `WeekdayTimeRangeEditor` | C16 | |
| message key `ui.status.report_version.discarded` "Discarded" | C6 | CR-C6-005 |
| shell slot: support-session banner | C2 (CR-C2-009) | part of C0 shell, not a feature component |

Mapped to existing components (no new component): `MoneyInput`→`MoneyField`; `MoneyText` (exists); `DualDate`→`DateText mode="AD_BS"`; `AsyncCombobox`→`Combobox`; `DataTable` (exists); `StatusBadge`→`StatusChip`; `ShortcutHint`→`Button.shortcut` / `KeyboardShortcutsDialog`; `ConfirmDialog` with reason (exists); `StatusTimeline`→`Timeline`; `AppPage`→`PageShell`+`PageHeader`; `NumberField`→`DecimalField`; `Textarea`→`TextArea`; `DateTimeField`→`DateTimePicker`; `Skeleton`→`LoadingSkeleton`; `Toast`→`useToast`; `KeyboardShortcutsHelp`→`KeyboardShortcutsDialog`; `Badge` (exists).

**Flutter (`lims_ui`, C0-0D).** New (CR-C16-016): `LimsPhoneField`, `LimsOtpField`, `LimsCodeField` (grouped `XXXXX-XXXXX`), `LimsStageTimeline`, `LimsSlotPicker`, `LimsSegmentedControl`, `LimsBottomNav`, `LimsCard`, `LimsQrCode`, `LimsPdfViewer`, `LimsProfileSwitcher`, `LimsAppLockGate`. Dependency pins (licence + no runtime egress) for router/app links, external browser, local auth, PDF render, QR render (CR-C16-017), and `local_auth`-class biometric prompt, `url_launcher`-class hand-off, on-device location capture, on-device `LimsBarcodeScanner` confirmation (CR-C17-010).

### 4.7 SECURITY DEFINER inventory, DB roles, index exceptions

**DB roles** (02-CV §5.9 additions; all NOSUPERUSER, NOBYPASSRLS):

| Role | LOGIN | Special | Purpose | CR |
|---|---|---|---|---|
| `lims_queue` | no | — | owns `graphile_worker` schema, `app.enqueue_job`, `app.queue_depth`; `lims_worker` is a member | C0-007 |
| `lims_monitor` | yes | `pg_monitor` | metrics exporter | C1-002 |
| `lims_replicator` | yes | REPLICATION | standby streaming | C1-002 |
| `lims_audit_ship` | yes | REPLICATION | logical decoding of publication `lims_audit_ship` (INSERT only) | C1-002 |
| `lims_reporting_lookup` | no | — | owns C6 pre-tenant token lookup DEFINERs | C6-002 |
| ~~`lims_auth_hook`~~ | — | — | **not created** (R10) | C0-007 |
| `lims_migration` | reserved | — | DEFER (B4) | C18-001 |

CI assertion: `rolreplication` true only for `lims_replicator`, `lims_audit_ship`; `rolbypassrls`/`rolsuper` false for every `lims_%` role.

**DEFINER inventory additions** (`db/meta/definer-inventory.yaml`; all `SET search_path = ''`, schema-qualified, no caller-supplied tenant; pre-tenant lookups bind their policies to a transaction-local GUC set inside the function from the presented hash):

| Function | Owner | EXECUTE to | Source |
|---|---|---|---|
| `app.enqueue_job(...)`, `app.queue_depth() RETURNS TABLE (task_identifier text, ready bigint, locked bigint, failed bigint)` (counts only, never payloads or keys) | `lims_queue` | `lims_app` (`queue_depth`: `lims_worker`) | C0-007, 03-IC §12; C0 05-SCHEMA §4.3 |
| `app.has_all_centres()` (rewritten CASE: `system` → tenant set; `user` → membership; every other actor type → false), `app.current_centre_ids()` (02-CV §5.8; policies cast it `::uuid[]`, 08 A16.1) | `lims_owner` | `lims_app` | R3; `memberships__select__owner_only`, `membership_centres__select__owner_only` |
| `app.tg_row_audit()` (+ per-table excluded-column trigger argument; `coalesce(TG_ARGV::text[], '{}')`, A15.5; no `audit_log` row for a NULL-tenant row of a table other than `core.tenants`, A25 D-215) | `lims_owner` | trigger | C15-013 |
| `app.ratelimit_hit(text, int, int)` | `lims_owner` | `lims_api`, `lims_worker` | C0 05-SCHEMA §4.3 (RLS-exempt counter table, 02-CV §5.9; A20.4) |
| `app.purge_idempotency_keys()`, `app.purge_event_log()`, `app.purge_event_inboxes()`, `app.purge_dead_letters()`, `app.purge_ratelimit_counters()` (no input arguments, A12.4/A15.4; each returns `(OUT deleted bigint, OUT capped boolean)` [CONV, accepted 08 A29.2; `capped` feeds `lims_core_retention_purge_capped_total{table}`, D-200]; loop cap `clock_timestamp() - now() > interval '4 minutes'`, own transaction each, task `core.retention_purge` with `taskOptions: { statementTimeoutMs: 300000 }` — A25 D-200; SQL in C0 05-SCHEMA §10) | `lims_owner` | `lims_worker` | A15.3 (`app.maintenance = '<function name>'`); D-200 |
| `app.dl_insert_platform(uuid, text, jsonb, text, text, integer, timestamptz, text)` (8 arguments; last `p_job_key text DEFAULT NULL`, A23.2), `app.dl_list_platform(text, text, timestamptz, timestamptz, timestamptz, uuid, integer, uuid)`, `app.dl_resolve(uuid, integer, text, text)` (RETURNS TABLE = the `DeadLetterRow` columns plus core-only `job_payload` (A10.1) and `job_key` (replay source, A23.2), neither ever in `DeadLetterRow`), `app.platform_list_tenants(text, text, text, timestamptz, uuid, integer)` (SQL in C0 05-SCHEMA §10) | `lims_owner` | `lims_worker` (insert); `lims_api` (list, resolve, tenants — platform context only) | C0-004; `platform_list_tenants`: maintenance GUC `app.maintenance = 'platform_list_tenants'`, platform claims check, non-PHI tenant columns, keyset paging (08 A12.3) |
| `app.cron_tenant_ids() RETURNS SETOF uuid` | `lims_owner` | `lims_worker` | 08 A13 P-6, A23.1 (tenant list for `tenantScope: 'per_tenant'` cron ticks; `core.tenants.status IN ('active','suspended')` [CONV]; `core.tenants__select__owner_only` per A10.5, gated by `app.maintenance = 'cron_tenant_ids'` per A12.2). EXECUTE += `lims_migration` only when CR-C18-001 is accepted after B4 (D-134, deferred) |
| `app.core_resolve_tenant_code(p_code text) RETURNS TABLE (tenant_id uuid, status text)` (plpgsql; replaces `app.engagement_resolve_tenant_code`) | `lims_owner` | `lims_api` | 08 A19 D-121: body `set_config('app.pre_tenant_code', p_code, true)` → select → reset to `''`; `core.tenants__select__owner_only` ORed with `tenant_code = nullif(current_setting('app.pre_tenant_code', true), '')`; the caller filters `status = 'active'`. EXECUTE += `lims_migration` only when CR-C18-001 is accepted after B4 (D-134, deferred) |
| `app.is_platform_actor()` (C0-owned DDL, A15.6) | `lims_owner` | `lims_app` | C2-004; `platform_staff__select__owner_only` |
| `app.identity_resolve_session(uuid, uuid)`, `app.identity_login_context(uuid)`, `app.identity_session_by_token(bytea)`, `app.identity_record_auth_event(jsonb)`, `app.identity_user_exists(uuid)`, `app.identity_bootstrap_platform_admin(uuid, uuid, text, text, uuid)` | `lims_owner` | `lims_api` | C2-005 (SQL in C2 05-SCHEMA §10); pre-tenant GUCs per 08 A12.1 (below), incl. `app.pre_support_session_id` (A15.1) and `app.pre_tenant_id` = the support session's `support_tenant_id` for a platform support session (A20.1); `identity_user_exists` takes the GoTrue `sub` |
| `app.identity_purge_sessions()`, `app.identity_expire_support_sessions()`, `app.identity_expire_invitations()` (each `RETURNS integer`), `app.identity_expire_audit_exports() RETURNS TABLE (object_path text)`, `app.identity_purge_auth_events() RETURNS integer` | `lims_owner` | `lims_worker` | 08 A12.2, A15.3 (each sets `app.maintenance = '<function name>'`; owner policies gated on it; `identity_purge_auth_events` reads `identity.tenant_settings` retention for all tenants); SQL in C2 05-SCHEMA §10.3 |
| `app.identity_load_breached_batch(p_hashes bytea[], p_version text) RETURNS integer`, `app.identity_finish_breached_import(p_version text) RETURNS integer` | `lims_owner` | `lims_worker` | C2 05-SCHEMA §10.3 (breached-password list import into class G `identity.g_breached_passwords`; no RLS, no owner policy) |
| `app.identity_tenants_for_email_hmacs(p_hmacs bytea[]) RETURNS SETOF uuid` (≤ 100 values) | `lims_owner` | `lims_worker` only | 08 A25 D-217 (task `identity.notify_ip_throttle`); owner policy `users__select__owner_only` ORed with `current_setting('app.maintenance', true) = 'identity_tenants_for_email_hmacs' AND email_hmac IS NOT NULL` (A12.2); A12.7 tests; SQL in C0 05-SCHEMA §10 / C2 05-SCHEMA §10.3 |
| `app.identity_platform_auth_write_session_insert(p_user_id uuid, p_row jsonb) RETURNS void`, `app.identity_platform_auth_write_session_update(p_user_id uuid, p_session_id uuid, p_set jsonb) RETURNS integer`, `app.identity_platform_auth_write_mfa_factor(p_user_id uuid, p_factor_id uuid, p_row jsonb) RETURNS integer`, `app.identity_platform_auth_write_invitation_accept(p_user_id uuid, p_invitation_id uuid) RETURNS integer`, `app.identity_platform_auth_write_staff_login(p_user_id uuid) RETURNS integer` [CONV names, C2] | `lims_owner` | `lims_api` only | 08 A28.1 (platform-staff session / MFA-factor / invitation / last-login writes during authentication, before a platform session exists; whitelisted columns only): each sets `app.pre_user_id = p_user_id` and resets it before return; owner policies `sessions__insert/update/select__owner_only` (`tenant_id IS NULL AND kind = 'platform' AND user_id = app.pre_user_id`), `mfa_factors__insert/update__owner_only` and `invitations__update/select__owner_only` (`tenant_id IS NULL AND user_id = app.pre_user_id`), `platform_staff__update__owner_only` (`user_id = app.pre_user_id`); SQL in C2 05-SCHEMA §10.3, policies §5.4 |
| `app.identity_notify_ip_throttle_hmacs(p_client_ip inet, p_since timestamptz) RETURNS SETOF bytea` (≤ 100 values) [CONV name, C2] | `lims_owner` | `lims_worker` only | 08 A28.4 (task `identity.notify_ip_throttle`; reads tenant-less `login_failed` `auth_events`): sets `app.maintenance = 'identity_notify_ip_throttle'` and resets it; `auth_events__select__owner_only` gains `app.maintenance = 'identity_notify_ip_throttle' AND tenant_id IS NULL AND event_type = 'login_failed' AND email_hmac IS NOT NULL`; SQL in C2 05-SCHEMA §10.3 |
| `app.reporting_verify_qr(bytea)`, `app.reporting_resolve_portal_credential(text, bytea)`, `app.reporting_ingest_provider_callback(text, bytea, jsonb)` | `lims_reporting_lookup` | `lims_api` | C6-002 (+R24 types); GUC names per 08 A21.4 (each set inside the body and reset to `''` before every return): `app.pre_qr_token_sha256` (`qr_tokens__select__lookup`, `report_versions__select__lookup`), `app.pre_portal_credential_sha256` (`portal_links__select__lookup`, `portal_sessions__select__lookup`), `app.pre_callback_token_sha256` + `app.pre_callback_tenant_id` + `app.pre_callback_channel_account_id` (`channel_accounts__select__lookup`, `provider_events__insert__lookup`, `provider_events__select__lookup` — the SELECT policy and `GRANT SELECT, INSERT ON reporting.provider_events` are needed by `INSERT … ON CONFLICT` under FORCE RLS; accepted from the C6 second pass) [CONV names, C6 05-SCHEMA §6.2] |
| `app.reporting_redeem_link_for_app(p_token_sha256 bytea, p_phone_sha256 bytea) RETURNS TABLE (tenant_id uuid, patient_id uuid, report_id uuid, version_no integer, released_at timestamptz)` | `lims_reporting_lookup` | `lims_api` | 08 A13 D-30 (`ReportingPort.redeemPortalLinkForApp`): returns a row only for a valid link with recipient `patient`, channel `sms`\|`whatsapp` and `coalesce(portal_links.destination_sha256, delivery destination) = p_phone_sha256`; a mismatch increments `portal_links.redeem_failures smallint NOT NULL DEFAULT 0 CHECK (redeem_failures BETWEEN 0 AND 5)`, at ≥ 5 nothing is returned; GUC `app.pre_portal_token_sha256`; policies `TO lims_reporting_lookup`: `portal_links__select__owner_only` / `__update__owner_only` `USING (token_sha256 = <GUC>)`, and `reports__select__owner_only`, `report_versions__select__owner_only`, `deliveries__select__owner_only` (rows of the link's report, its versions and the link's delivery); column grant `GRANT UPDATE (redeem_failures, updated_at, version) ON reporting.portal_links TO lims_reporting_lookup`; the failure-counter increment persists through `ctx.commitOnError()` (A19 P-42); A12.7 tests; probe: 5 wrong phones → the 6th, correct phone fails |
| `app.instruments_resolve_device_credential(bytea)`, `app.instruments_agent_state_snapshot()`, `app.purge_instruments_archive(p_raw_retention_days integer)` (≥ 365; signature changed by 08 A13 D-42) | `lims_owner` | `lims_api` / `lims_worker` | C7-006; D-42: `instruments.purge_archive` runs `per_tenant` (P-6) and passes `TenantSettings.retention.rawInstrumentYears` read via IdentityPort; maintenance GUC `app.maintenance = 'purge_instruments_archive'` (A12.2, A13) |
| `app.current_partner_id()` | `lims_owner` | `lims_app` | C13-004 |
| `partners.redact_lines(p_tenant_id uuid, p_older_than timestamptz) RETURNS integer` | `lims_owner` | `lims_worker` | C13 hand-off (SQL in C13 05-SCHEMA): task `partners.redact_expired_lines` (`per_tenant`, partners system actor); refuses unless `p_tenant_id = app.current_tenant_id()` and actor type `system`; sets `app.maintenance = 'partners_redact_lines'`; owner policies `manifest_lines__select/update__owner_only`, `order_reports__select/update__owner_only`, `order_tracking__select__owner_only` gated by that value **and** `tenant_id = (SELECT app.current_tenant_id())` |
| `app.payments_resolve_callback_token(p_token_sha256 bytea) RETURNS TABLE (tenant_id uuid, intent_id uuid)` | `lims_owner` | `lims_api` | C15-004; A19 P-41 / A12.1: GUC `app.pre_payments_callback_token_sha256` (hex), policy `intents__select__owner_only ON payments.intents TO lims_owner USING (callback_token_sha256 = decode(current_setting('app.pre_payments_callback_token_sha256', true), 'hex'))`; reset before return; 30-day acceptance window [CONV] (SQL in C15 05-SCHEMA) |
| `app.engagement_resolve_preauth(text, bytea)`, `app.engagement_resolve_display(bytea)` (plpgsql) | `lims_owner` | `lims_api` | C16-005 (+R24 types); 08 A19 D-121: GUCs `app.pre_engagement_otp_token_sha256` / `app.pre_engagement_display_token_sha256` (hex); `otp_challenges__select__owner_only` / `queue_displays__select__owner_only TO lims_owner USING (token_sha256 = decode(current_setting('<GUC>', true), 'hex'))`; `app.pre_tenant_id` set after the row is found (A12.1) for C0 `tenants__select__owner_only`; all reset before return. `app.engagement_resolve_tenant_code(text)` is **removed** (→ `app.core_resolve_tenant_code`, D-121) |
| `app.engagement_account_id()`, `app.engagement_patient_ids()`, `app.engagement_patient_visible(uuid, timestamptz)`, `app.engagement_redeem_link_code(bytea)` (08 A2.4: takes the 32-byte HMAC), `app.engagement_apply_report_link(uuid, timestamptz)`, `app.engagement_code_redeemed_by_me(uuid, uuid)` | `lims_owner` | `lims_app` | C16-006; 08 A19 D-121 tenant-claim owner policies (C16 05-SCHEMA §6.5–§6.6): `accounts__select__owner_only` (`tenant_id = (SELECT app.current_tenant_id()) AND membership_id = nullif(app.current_claims() ->> 'membership_id', '')::uuid`), `account_patient_links__select/update__owner_only` (`account_id = app.engagement_account_id()`), `link_codes__select__owner_only` (`status = 'issued' OR redeemed_account_id = app.engagement_account_id()`), `link_codes__update__owner_only` (`status = 'issued'` / WITH CHECK `redeemed_account_id = app.engagement_account_id()`); C0 `memberships__select__owner_only` |
| `engagement.purge_payment_requests()`, `engagement.purge_queue()` (each `RETURNS integer`) | `lims_owner` | `lims_worker` | 08 A19 D-121 last bullet (purges that touch non-E rows; C16 05-SCHEMA §6.4/§6.6): `payment_requests__select/delete__owner_only` (`app.maintenance = 'engagement_purge_payment_requests'`); `queue_tokens__…`, `queue_day_counters__select/delete__owner_only` (`app.maintenance = 'engagement_purge_queue'`); each also bound to the job's tenant claims |
| `frontdesk.purge_trf_drafts(p_older_than interval, p_ids uuid[]) RETURNS integer` | `lims_owner` | `lims_worker` | C4 hand-off (SQL in C4 05-SCHEMA): task `frontdesk.trf_draft_purge` (`per_tenant`, tenant claims) after deleting the draft objects (P-12 a); sets `app.maintenance = 'frontdesk_purge_trf_drafts'`; `trf_attachments__select/delete__owner_only` gated by that value, `order_id IS NULL` and `tenant_id = (SELECT app.current_tenant_id())` |
| `app.homecollection_anonymise_retired_visits(p_before timestamptz) RETURNS TABLE (visits_anonymised integer, handover_items_anonymised integer)` | `lims_owner` | `lims_worker` | C17 hand-off (SQL in C17 05-SCHEMA): one tenant per call (system claims); sets `app.maintenance = 'homecollection_anonymise_retired_visits'`; `visits__select/update__owner_only`, `handover_items__select/update__owner_only` gated by that value plus `app.current_tenant_id()` |
| **Removed:** `app.custom_access_token_hook`, `app.resolve_membership_for_subject` (R10); `app.engagement_resolve_tenant_code` (D-121) | — | — | — |

Not DEFINER (INVOKER, listed for completeness): `app.is_staff_or_system()` (CR-C13-011), `app.current_lims_session_id()` (C0 DDL, 08 A20.2; `GRANT EXECUTE … TO lims_app, lims_api, lims_worker`), `app.engagement_preauth_stage()` (no table read; C16 05-SCHEMA §6.6), `app.purge_inventory_alerts()` (CR-C12-008; per-tenant class-E delete, A17 D-72). Class-E retention deletes of other modules are not DEFINERs (02-CV §5.11, P-18(c)).

**Pre-tenant and maintenance GUCs (A10.5, A12, A13).** Pre-tenant DEFINERs set `app.pre_*` GUCs (text) inside the function body with `set_config(name, value, true)` before each read; maintenance DEFINERs set `app.maintenance = '<function name>'`; owner policies `TO <function owner>` match on them; every function resets them to `''` before returning; A12.7 tests. Names: `app.pre_session_token_sha256` (`identity_session_by_token`), `app.pre_gotrue_session_id` (`identity_resolve_session`), `app.pre_user_id` (`identity_login_context`, `identity_resolve_session`, `identity_user_exists`, the five `identity_platform_auth_write_*`, A28.1), `app.pre_tenant_id` (set after the membership is chosen; `core.tenants`, `core.membership_roles`, `core.roles`, `identity.mfa_factors`, `identity.tenant_settings`, `identity.support_sessions`), `app.pre_portal_token_sha256` (`reporting_redeem_link_for_app`, A13 D-30), `app.pre_support_session_id` (`identity_resolve_session`, A15.1), `app.pre_tenant_code` (`core_resolve_tenant_code`, A19 D-121), `app.pre_qr_token_sha256` / `app.pre_portal_credential_sha256` / `app.pre_callback_token_sha256` + `app.pre_callback_tenant_id` + `app.pre_callback_channel_account_id` (C6 lookups, A21.4), `app.pre_payments_callback_token_sha256` (`payments_resolve_callback_token`), `app.pre_engagement_otp_token_sha256` / `app.pre_engagement_display_token_sha256` (C16 resolvers, D-121); `app.maintenance`: C0 `purge_*`, `identity_purge_sessions`, `identity_expire_{support_sessions,invitations,audit_exports}`, `identity_purge_auth_events`, `identity_tenants_for_email_hmacs`, `identity_notify_ip_throttle` (`identity_notify_ip_throttle_hmacs`, A28.4), `platform_list_tenants`, `cron_tenant_ids`, `purge_instruments_archive`, `partners_redact_lines`, `engagement_purge_payment_requests`, `engagement_purge_queue`, `frontdesk_purge_trf_drafts`, `homecollection_anonymise_retired_visits`. Policy predicates verbatim in A12.1; table form in 03-IC §13.3; rule in 02-CV §5.8.

**Index-rule exceptions** (`db/meta/index-exceptions.yaml`; global unique on a hash or a one-tenant invariant, used only by inventoried DEFINERs; a tenant-leading secondary index also exists): `identity.sessions(token_sha256)`, `identity.sessions(gotrue_session_id)`, partial `identity.sessions(previous_token_sha256) WHERE previous_token_sha256 IS NOT NULL` (A3.1), partial `core.memberships(user_id) WHERE actor_type = 'user'` (R27), `reporting.qr_tokens(token_sha256)`, `reporting.portal_links(token_sha256)`, `reporting.portal_sessions(token_sha256)`, `reporting.channel_accounts(callback_token_sha256)`, `instruments.agent_credentials(secret_sha256)`, `payments.intents(callback_token_sha256)`, `engagement.queue_displays(token_sha256)`, `identity.auth_events(occurred_at DESC, id DESC)` (`auth_events__occurred_at__idx`, platform-wide sign-in list PL-8; 08 A28.6). Tables with platform rows may use `UNIQUE NULLS NOT DISTINCT (tenant_id, …)` (CR-C2-017).

### 4.8 Storage buckets (all private; first path segment `{tenant_id}`; server-side `ctx.storage` only; `storage.objects` end-user policies only after SP-4)

| Bucket | Owner module | Paths | Writes | Source |
|---|---|---|---|---|
| `reports` | reporting (C6) | `{tenant_id}/{yyyy}/{mm}/{report_id}-v{n}.pdf` | worker, write-once | 04 D15 |
| `reporting-inputs` | reporting | `{tenant_id}/quarantine/…`, `{tenant_id}/outsourced/…`, `{tenant_id}/narrative-images/…`, `{tenant_id}/instrument-sanitized/{yyyy}/{mm}/{sha256}.pdf` (08 A21.3) | API/worker | C6-009 (renamed) |
| `reporting-prints` | reporting | `{tenant_id}/prints/{yyyy}/{mm}/{print_id}.pdf` (24 h) | worker | C6-009 (renamed) |
| `identity-assets` | identity (C2) | logos, letterhead images, signature images; superseded objects kept | API | C2-012 (renamed) |
| `identity-exports` | identity | audit CSV exports (expire) | worker | C2-012 (renamed) |
| `frontdesk-trf` | frontdesk (C4) | TRF uploads | API | C4-005 (renamed) |
| `billing-exports` | billing (C4) | Excel/XML/PDF exports incl. RenderPort output | worker | C4-005 |
| `instruments-attachments` | instruments (C7) | `{tenant_id}/q/{yyyy}/{mm}/{id}.{ext}`, `{tenant_id}/{yyyy}/{mm}/{id}.{ext}` | API/worker | C7-007 (renamed) |
| `micro-imports` | micro (C10) | breakpoint CSV files | API | C10-008 |
| `anatomic-images` | anatomic (C11) | `{tenant_id}/{yyyy}/{mm}/{image_id}.{png\|jpg}` | API/worker | C11-008 |
| `reporting-legacy` | reporting | reserved (DEFER, B4) | — | C18-004 |
| `partners-slips` | partners (C13) | `{tenant_id}/access-slips/{yyyy}/{mm}/{slip_id}.pdf` (deleted at link expiry) | worker, write-once per successful issue; a retry before the row is `issued` may replace (upsert) (C13 hand-off) | A5.2 |

C8 analytics exports and C3 catalog files are stored as their TRDs specify (no bucket requested); if they move to Storage they use `analytics-exports` / `catalog-files` under the same rules.

### 4.9 Published views (03-IC §6)

| View | Change | Consumers (final) | Source |
|---|---|---|---|
| `billing.v_pub_payment_collection` | column stays `payment_method_code` (`method_code AS payment_method_code`) | C8, **C15** | C8-010, C15-009 |
| `lab.v_pub_result_daily` | + `centre_id` (order's collection centre; grouping key), + `tests_approved bigint` | C8, C9, C12 | C8-004 |
| `lab.v_pub_critical_value_daily` | + `centre_id` (grouping key) | C8, C9 | C8-004 |
| `lab.v_pub_specimen_timeline` | + `parent_specimen_id`; + `replaces_specimen_id`, `specimen_version` (= `lab.specimens.version`, the event aggregate seq; A19 D-106) | C8, C9, C13, C16 | C8-004; CR-C16-022 |
| `lab.v_pub_qc_result` | + `created_at` (appended); index `qc_results__tenant_id_created_at__idx (tenant_id, created_at, id)` | C9 | C9-005 |
| `reporting.v_pub_delivery_daily` | + `centre_id` (NULL for non-report deliveries; grouped by it); `business_date` = delivery creation date for every count (cohort; A17 D-48) | C8 | C8-005; A17 D-48 |
| `billing.v_pub_credit_party_statement` | consumers = C13 only (C8 removed; a later additive C8 CR may add it once a credit-party label source exists) | C13 | A17 D-51 |
| `reporting.v_pub_report_release` | `report_kind` may be `addendum` | C8 | R1 |
| `catalog.v_pub_referrer_directory` | + `canonical_referrer_id` | C8 | C3-004 |
| `catalog.v_pub_price_list_items` | C16 consumer withdrawn — C16 uses `CatalogPort.getPriceListStatus` (A24.1, CR-C16-023); + `falls_through` (`boolean`, appended); rows only for versions `status IN ('published','superseded')` of active lists (`WHERE v.status IN ('published','superseded') AND l.is_active`); inactive lists excluded; consumers apply fall-through to the tenant default list themselves | C13 | C16-013 (superseded by CR-C16-023 / A24.1); A13 D-19 |
| `anatomic.v_pub_report_content` | + `version_kind`, `scope`, `change_reason_code`, `clinical_history_text`, `comment_text`, `specimen_parts`, `slides`, `ancillary`, `molecular`, `addenda`, `diagnosis_codes` (appended; JSON Schemas in C11 05-SCHEMA §5) | C6, C14 | C11-001 |
| **`instruments.v_pub_instrument_directory`** (new) | `tenant_id, instrument_id, centre_id, instrument_code, display_name, vendor, model, state, is_active` | C8, C9, C12 | C9-006 + C12-005 |
| **`engagement.v_pub_booking_daily`**, **`engagement.v_pub_queue_daily`** (new, columns per C16 05-SCHEMA §7) | | C8 | C16-012 |
| ~~`engagement.v_pub_booking_address`~~, ~~`engagement.v_pub_patient_membership`~~ | not created — EngagementPort instead (R25) | — | C16-012 |
| `catalog.v_pub_department`, `frontdesk.v_pub_order_status` | C6 is **not** added as consumer (ports instead, R25) | unchanged | C6-012 |

Expression indexes for date-bounded reads (CR-C8-011): C0 creates them in the owner schemas; whether `(ts AT TIME ZONE 'Asia/Kathmandu')::date` is indexable on PG 17 stays UNVERIFIED and is proven in the migration PR; fallback = a stored `business_date` column written by the owner (as `billing.ledger_entries` already has).

### 4.10 Events (03-IC §3) — new and changed payload fields

All additive within `.v1` (02-CV §7.2). JSON fragments to add to `properties` (JSON with `//` comments, property fragments only — fence labelled `jsonc` by the A13 apply, content unchanged):

```jsonc
// instruments.result.received.v1  (CR-C7-004) — trigger text extended (scan_attachment commit, reprocess, re-match; re-publication suppressed by core.event_log uniqueness)
"captured_at":      { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
"processing_kind":  { "enum": ["live", "reprocess", "rematch"] },          // absent = live
"source_record_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" }
// instrument_analyte_code for organism_id/ast records follows the CR-C10-007 driver rule (R13); maxLength 64 unchanged

// instruments.qc.received.v1  (CR-C7-004)
"captured_at":      { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
"processing_kind":  { "enum": ["live", "reprocess", "rematch"] }

// lab.result.verified.v1  (CR-C12-004)
"processing_branch_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" }

// reporting.report.released.v1  (CR-C5-006 / C6-014; R1)
"order_item_ids": { "type": "array", "maxItems": 200, "items": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" } },
"report_kind":    { "enum": ["final", "partial", "preliminary", "amended", "addendum"], "x-extensible": true }

// catalog.changed.v1  (CR-C3-003)
"entity_type": { "enum": [ …existing…, "method", "unit", "value_set", "tax_rule" ], "x-extensible": true }

// homecollection.collection.synced.v1  (CR-C17-006) — inside payments[] items
"reference": { "type": "string", "minLength": 1, "maxLength": 100 }
// documented: collected_at_device / captured_at_device = server-corrected capture time; trigger also covers a dispatcher "apply" of a held collection (payments empty)
```

New event **`instruments.calibration.received.v1`** (CR-C12-006): producer C7 (`instruments`), consumer C12; trigger = commit that stores a parsed record a driver classifies as calibrator (only drivers with an official manual, B2); aggregate `instrument_message`; idempotency key `<instrument_id>:cal:<instrument_analyte_code>:<instrument_result_time or sha256(raw)>`; PHI P0.
```json
"Payload": { "type": "object", "additionalProperties": false,
  "required": ["instrument_message_id", "instrument_id", "centre_id", "instrument_analyte_code", "mapping_status", "received_at"],
  "properties": {
    "instrument_message_id": { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "instrument_id":         { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "centre_id":             { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "instrument_analyte_code": { "type": "string", "minLength": 1, "maxLength": 64 },
    "mapping_status":        { "enum": ["mapped", "unmapped"] },
    "analyte_id":            { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "test_id":               { "$ref": "urn:lims:event:_defs.v1#/$defs/Uuidv7" },
    "calibrator_id_raw":     { "type": "string", "maxLength": 64 },
    "calibrator_lot_raw":    { "type": "string", "maxLength": 64 },
    "instrument_result_time": { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" },
    "received_at":           { "$ref": "urn:lims:event:_defs.v1#/$defs/IsoUtc" } } }
```

Consumer-list changes (03-IC §3.x + §3.25 + 01 §5.1): `lab.result.approved.v1` += C11; `lab.result.amended.v1` += C11; `frontdesk.order.cancelled.v1` += C13; `catalog.changed.v1` += C13, C16; `engagement.booking.confirmed.v1` C4 row reads "C4 (`centre_visit` only — R7)"; `instruments.calibration.received.v1` → C12. Also the 01 §5.1 tables absorb A2–A5, A8 (pending lead edit noted in 03-IC §5.1).

`NotificationPurpose` (port, not event): += `'scheduled_report_ready' | 'booking_cancelled' | 'booking_reminder'`; `SendBase.related.entityType` += `'report_run'`; NotificationPort consumers += C8.

Templates seeded by C6 (`reporting.g_message_templates`): `frontdesk.registration_confirmation` (registration_confirmation), `frontdesk.recollection_request` (recollection_request), `analytics.report_ready` (scheduled_report_ready, email, staff only; renamed by A2.6), `engagement.login_otp` (otp), `engagement.booking_confirmation` (booking_confirmation), `engagement.booking_cancelled` (**booking_cancelled**), `engagement.booking_reminder` (**booking_reminder**), `engagement.follow_up_reminder` (follow_up_reminder), `homecollection.visit_assigned` (visit_assignment, channel `sms`, params `route_date` and `visit_count`, both kind `short_text`; A13 D-34), `reporting.dues_due` (dues_reminder, `sms`/`whatsapp`, recipient patient; params `lab_name`, `amount_text` (both `short_text`) and `url` (kind `url`, the portal dues link `/r/{token}/dues`); A21.1 + C6 second-pass hand-off), `homecollection.visit_scheduled` (booking_confirmation, channel `sms`, recipient patient; params `window_start_local`, `window_end_local`, both `short_text` (A4.3), no lab-name parameter; A19 D-129, CR-C17-014). Params non-PHI only (04 R6).

Addendum A13 event changes (applied in 03-IC §3): `billing.invoice.issued.v1` `required` without `centre_id` + `if`/`then`/`else` on `is_periodic_credit_bill` (D-1; C8 tolerates); `lab.result.verified.v1` `specimen_id` and `verified_by_membership_id` leave `required`, `if mode = manual then required verified_by_membership_id else not` (D-2; C8, C9, C12 tolerate); `reporting.delivery.status_changed.v1.recipient_kind` += `phone_otp`, `x-extensible: true` (D-3; C8 counts unknown as `other`); `catalog.changed.v1.entity_type` += `catalog_import` (D-21); `lab.specimen.status_changed.v1` consumers += C4 (`to_status = recollection_ordered` only, D-6).

Addendum A17/A19 event changes (applied in 03-IC §3): `reporting.delivery.status_changed.v1` += optional `delivery_created_at` (IsoUtc; not in `required`; C6 always sets it — A17 D-48); `homecollection.collection.synced.v1` += optional `booking_id` (Uuidv7; present iff the visit has `kind = 'booking'`, stated in Notes per P-5; consumers += C16; C4, C5 tolerate — A19 D-120); `engagement.booking.cancelled.v1` trigger = transition from `confirmed` or `checked_in` to `cancelled` (C16 hand-off); `reporting.report.released.v1` `report_kind` rule (1) exclusion set += `module_preliminary_update`, rule (3) labels it `preliminary` (A17 D-61).

### 4.11 Core runtime and manifest additions (C0-0D)

```ts
// services/api/src/core/module.ts
interface ModuleManifest {
  /* existing */
  claimsResolver?: ClaimsResolver;                      // accepted only from module 'identity' (R10)
  authResolvers?: {                                     // module → allowed resolvers (CI-checked)
    deviceToken?: AuthResolver;          // 'instruments'
    portalSession?: AuthResolver;        // 'reporting'   (may return { error: 'reporting.link_invalid' } → 404, CR-C6-001)
    paymentCallback?: AuthResolver;      // 'payments'    (actor: system of payments; extraClaims { payment_intent_id })
    patientPreAuth?: AuthResolver;       // 'engagement'  (actor: patient, extraClaims { patient_stage, otp_token_sha256 })
    queueDisplayToken?: AuthResolver;    // 'engagement'  (actor: device, extraClaims { device_kind: 'queue_display' })
  };
}
// AuthResolver result: { actor: Actor; tenantId: Uuidv7; centreId?: Uuidv7; extraClaims?: Readonly<Record<string, string>> } | { error: ErrorCode }
// Allowed extraClaims keys per module: reporting {portal_stage, portal_report_id, portal_session_id}; instruments {credential_kind, credential_id};
// payments {payment_intent_id}; engagement {patient_stage, otp_token_sha256, device_kind}. Core copies them into request.jwt.claims.
interface WorkerManifest { /* existing */ taskOptions?: Readonly<Record<string, { statementTimeoutMs?: number /* ≤ 300000 */ }>> }   // CR-C8-012
// OpenAPI extensions: x-context: tenant|platform (CR-C2-004); x-edge-exposure: public|internal (CR-C1-004);
// x-anonymous-tx: true (module reporting only, with x-public; CR-C6-001); x-raw-body: true (reporting provider callbacks only, ≤ 256 KB);
// text/html responses only for payments operations with x-public or paymentCallbackToken (CR-C15-004).
ctx.db.anonymousTx(): DbTx                               // reporting only, x-public + x-anonymous-tx
ctx.db.withTenantScope(tx, tenantId, fn)                 // identity, platform context, operationId allowlist (R10 item 4 as amended by 08 A25 D-214);
                                                         // core-internal uses: worker-core cron fan-out (A23.1), deadLetters.replay of a tenant row (A23.2)
                                                         // + IdentityPort patient-context writes (provisionPatientMembership, openPatientSession,
                                                         //   revokePatientSessions) under <identity system actor> (08 A28.2)
ctx.db.identityAuthTx(fn)                                // 08 A25 D-212: module identity only, operations tagged x-context: identity_auth and listed in
  // core config (loginStaff, loginPartner, openMobileSession, refreshMobileSession, logoutMobileSession, confirmEmailToken,
  // requestPasswordRecovery, verifyMfaChallenge, startMfaEnrolment, completeMfaEnrolment, resolveSession, logoutSession,
  // setPasswordFromSetup, resolvePatientSession, logoutPatientSession); claims {sub: <identity system actor>, actor_type: 'system'}, no tenant_id;
  // tx.bindTenant(tenantId) at most once, after identity_login_context / identity_session_by_token / identity_resolve_session chose the membership;
  // authz guard (stage 9) exempts x-context: identity_auth; every listed operation carries x-public with a justification (02-CV §6)
ctx.core.systemActorPermissions(actorId): readonly PermissionCode[]                         // CR-C2-013
// 08 A17 D-47 (P-17): MembershipRow defined; memberships.list widened (all new inputs optional, so the C17 call stays valid)
export interface MembershipRow { readonly membershipId: Uuidv7; readonly userId: Uuid; readonly actorType: 'user'|'system'|'device'|'portal'|'patient'|'partner';
  readonly displayName: string; readonly status: 'invited'|'active'|'deactivated'; readonly isActive: boolean; readonly lockedAt?: IsoUtc;
  readonly allCentres: boolean; readonly centreIds: readonly Uuidv7[]; readonly roleCodes: readonly string[] }
memberships: { list(tx: RequestContext, input: { centreId?: Uuidv7; roleCode?: string; permission?: PermissionCode;
    membershipIds?: readonly Uuidv7[] /* ≤ 200 */; activeOnly?: boolean /* default true */; limit?: number /* 1–500, default 200 */ }):
  Promise<readonly { membershipId: Uuidv7; displayName: string; roleCodes: readonly string[]; allCentres: boolean; isActive: boolean }[]> }   // CR-C17-013, D-47
// list semantics (D-47): tenant from ctx only; actor_type = 'user' memberships only; centreId → all_centres or member of that centre;
// permission → a role of the membership grants it (core.role_permissions); unknown/other-tenant membershipIds omitted; displayName from core.users;
// callers staff or system only — portal, patient and partner actors get auth.forbidden. Users: C8 #16, C10 *_display, C11 A12 (08 A17 D-47).
ctx.core.centres.list(tx, { kinds?: readonly ('own' | 'franchise' | 'home_collection')[] })                            // CR-C17-013
  // rows include the centre's phone_display (core.collection_centres.phone_display, ≤ 40; C4 hand-off)
// Config keys: LIMS_CORE_SCANNER_URL (default tcp://clamd:3310, INSTREAM), LIMS_CORE_SCANNER_TIMEOUT_MS (default 30000) [CONV] — 08 A25 D-209, set by C1;
// LIMS_CORE_BFF_KEY_FILES lists kinds staff_web, partner, portal (08 A19 P-45); LIMS_CORE_TRUSTED_PROXY_CIDRS [CONV] (08 A25 P-61; C1 sets it to
// the nginx container address on edge_net) — app.client_ip from X-Forwarded-For only with a valid BFF key or a trusted peer; modules read ctx.clientIp.
// Idempotency (08 A25 D-202, D-213): responses stored only for status < 400 (a ctx.commitOnError() path deletes the key row before commit);
// core.idempotency_keys.tenant_id NULL for platform-context operations (provisionTenant, openSupportSession, invitePlatformStaff), UNIQUE NULLS NOT DISTINCT
// (tenant_id, actor_id, key) and __platform policies (03-IC §12).
// Runtime hooks (CR-C1-008): GET /health/live on LIMS_CORE_METRICS_PORT (API + worker); outbound HTTP honours LIMS_CORE_EGRESS_PROXY_URL;
// SIGTERM: worker drains up to LIMS_CORE_SHUTDOWN_GRACE_S (default 55); API stops accepting, drains, exits.
// Health exception: /v1/core/health/{live,ready} (CR-C0-006).
```
Note (found during arbitration): C0 05-SCHEMA `core.collection_centres.centre_kind` uses `own` and codes `^[A-Za-z0-9-]{1,16}$`; C2 TRD §5.5 uses `owned` and `{1,20}`. **Final: `own` and `{1,16}`** (DDL wins; C2's tighter text limits for address ≤ 300 and phone ≤ 30 are fine inside the DDL limits). C2 TRD/OpenAPI aligned in the apply plan.

### 4.12 `IdentityPort.TenantSettings` — final shape (CR-C2-008 primary; C0-009, C4-009, C5-009, C11-005)

```ts
export interface TenantSettings {
  /* unchanged: calendarDisplay, timezone, idleTimeoutMinutes, absoluteSessionHours, reportLinkTtlDays,
     releaseRequiresPayment, partialReleaseAllowed, letterheadDefault, channels, referralIncentiveReportEnabled,
     autoVerificationEnabled, westgardMode */
  readonly numbering: {
    readonly registrationNoPattern: string; readonly barcodePattern: string; readonly patientCodePattern: string;
    readonly invoiceNoPattern: string; readonly creditNoteNoPattern: string;
    readonly receiptNoPattern: string;                       // default 'RC-{fy}-{seq:6}'            (CR-C2-008)
    readonly barcodePrefix?: string;                         // [A-Z0-9]{0,4}                        (CR-C5-009)
    readonly accessionNoPattern?: string;                    // default '{prefix}{yy}-{seq:4}'       (CR-C11-005)
    readonly accessionPrefixes?: { readonly histology?: string; readonly cytology?: string;
                                   readonly ihc?: string; readonly molecular?: string };   // [A-Z0-9]{0,4}; defaults S/C/I/M
  };
  readonly branding: {                                       // replaces CR-C4-009 'letterhead' and CR-C0-009 'branding'
    readonly legalName: string; readonly displayName: string;
    readonly addressLines: readonly string[];                // ≤ 4 lines, each ≤ 120
    readonly phones: readonly string[];                      // ≤ 3 display strings, each ≤ 40
    readonly contactEmail?: string; readonly website?: string;
    readonly logoAssetId?: Uuidv7; readonly letterheadHeaderAssetId?: Uuidv7; readonly letterheadFooterAssetId?: Uuidv7;
    readonly receiptFooterNote?: string;                     // ≤ 200
    readonly accentColor?: string;                           // '#RRGGBB'; kit derives accessible variants (C0 04-UI-UX §1.6)
  };
  readonly retentionYears: number;                           // kept = retention.clinicalYears (back-compat)
  readonly retention: { readonly clinicalYears: number; readonly auditYears: number; readonly rawInstrumentYears: number }; // floors 5/5/1 (04 I8, B15)
  readonly featureFlags: Readonly<Record<string, boolean>>;  // codes from identity.g_feature_flags (+ 'smart_report', CR-C14-005)
  readonly ird: { readonly pan?: string; readonly cbmsRealtimeRequired: boolean; readonly abbreviatedInvoiceLimitPaisa?: number;
                  readonly annexReadiness: 'complete' | 'incomplete' };   // tracking-derived, not a legal determination
}
```
C2 validates every field on write (`identity.setting_out_of_range`; pattern grammar errors at JSON pointer); the fake returns defaults.

### 4.13 Shared libraries and storage API (C0-0A / C0-0D)

```ts
// @lims/shared-ts/formula  (C0-0A; grammar text C3 TRD §7.1 + log10 — R12a)
export type FormulaAst = { readonly __brand: 'FormulaAst' };
export type FormulaContextVar = '@age_days' | '@age_years' | '@is_female' | '@is_male';
export interface FormulaParseError { readonly offset: number; readonly code: 'syntax' | 'too_long' | 'too_deep' | 'too_many_refs' | 'unknown_function'; readonly message: string }
export function parseFormula(text: string): { readonly ast?: FormulaAst; readonly refs: readonly Code[]; readonly contextVars: readonly FormulaContextVar[]; readonly errors: readonly FormulaParseError[] };
export function formulaRefs(ast: FormulaAst): readonly Code[];
export function evaluateFormula(ast: FormulaAst, inputs: Readonly<Record<Code, DecimalString | undefined>>,
  ctx: { readonly ageDays?: number; readonly ageYears?: number; readonly sex: Sex }):
  { readonly ok: true; readonly value: DecimalString; readonly inexact: boolean } | { readonly ok: false; readonly reason: string }; // reasons: missing_input:<CODE> | division_by_zero | domain_error | <invalid() code>
// @lims/shared-ts/decimal — exact decimal, ≥ 28 significant digits, half-up rounding; implementation pinned by C0-0A.
// @lims/shared-ts/spreadsheet (C0-0A; R12e as amended by 08 A13 P-9) — the one CSV/XLSX injection guard; writer write-excel-file 4.1.1; module-local copies banned
export function neutraliseFormula(cell: string): string;   // prefixes "'" when cell starts with = + - @ \t \r or "'"
export function restoreNeutralised(cell: string): string;  // strips exactly one leading "'"; restoreNeutralised(neutraliseFormula(s)) === s for all s

// services/{api,worker}/src/core/uploads + core/storage  (C0-0D; R12b)
export type UploadMime = 'application/pdf' | 'image/jpeg' | 'image/png' | 'text/csv'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export type BucketName = 'reports' | 'reporting-inputs' | 'reporting-prints' | 'identity-assets' | 'identity-exports'
  | 'frontdesk-trf' | 'billing-exports' | 'instruments-attachments' | 'micro-imports' | 'anatomic-images'
  | 'partners-slips';                                  // 08 A26.3 (§13.4 / 08 §4.8 bucket of C13)
export interface UploadAcceptOptions {
  readonly allow: readonly UploadMime[];              // ⊆ the operation's declared x-upload allowlist
  readonly maxBytes: number;                          // ≤ 15 MB file (02-CV §10.2)
  readonly bucket: BucketName; readonly objectPath: string;   // first segment must equal ctx.tenantId; bucket prefix must match the module
  readonly images?: { readonly reencode: true; readonly stripMetadata: true; readonly maxMegapixels?: number /* default 40 */ };
  readonly scan: 'required' | 'not_applicable';       // not_applicable only for text/csv (UTF-8, no NUL)
}
export interface AcceptedUpload {
  readonly objectId: Uuidv7; readonly bucket: BucketName; readonly objectPath: string; readonly sha256: string; readonly byteSize: number;
  readonly mime: UploadMime; readonly image?: { readonly width: number; readonly height: number };
  readonly scanState: 'pending' | 'clean' | 'infected' | 'unavailable';   // pending/unavailable/infected ⇒ stays in quarantine (fail closed)
}
ctx.uploads.accept(file: IncomingFile, opts: UploadAcceptOptions): Promise<AcceptedUpload>;   // magic bytes + extension; xlsx = ZIP magic + .xlsx (C3 adds its ZIP inspection)
ctx.files.scan(bytes: Uint8Array): Promise<'clean' | 'infected' | 'unavailable'>;              // ClamAV-class service (C1); mandatory in staging/prod
ctx.storage.put(bucket: BucketName, objectPath: string, bytes: Uint8Array, opts: { contentType: string; ifAbsent?: boolean }): Promise<{ sha256: string; byteSize: number }>;
ctx.storage.read(bucket: BucketName, objectPath: string): Promise<Uint8Array>;
ctx.storage.move(bucket: BucketName, fromPath: string, toPath: string): Promise<void>;
ctx.storage.signedUrl(bucket: BucketName, objectPath: string, ttlSeconds: number /* ≤ 300 */): Promise<string>;   // internal only; never logged or sent to browsers
ctx.storage.delete(bucket: BucketName, objectPath: string): Promise<void>;
// delete (08 A13 P-12): owner bucket only. Allowed for (a) E-class objects (prints, expired exports, quarantine rejects); (b) objects whose
// retention period has elapsed, deleted by the owning module's purge task; (c) a patient's objects deleted by that module's anonymisation
// handler once retention has elapsed. Each delete increments lims_core_storage_deletes_total{bucket,reason} [CONV].
// read (08 A13 P-13): another module's bucket only for a (bucket, objectPath) pair received in the same flow (port output, event payload,
// published view); paths are never constructed; writes stay owner-only (R26). signedUrl (08 A13 P-2): never in a response, header or log.
// HTTP: multipart parser with per-route cap; streaming download helper (Content-Disposition: attachment, nosniff, no-store) (CR-C3-005);
// inline variant only for objects accepted with images.reencode: true and stored mime image/png|image/jpeg (CSP default-src 'none'; sandbox) — 08 A17 D-67, 02-CV §10.2 (I1).
```

### 4.14 Port method additions — final TypeScript

All additive; every `*_PORT_VERSION` stays `1`. "Existing" members unchanged. Contract-suite additions are listed after each block; fakes implement the same behaviour (02-CV §8.3).

```ts
// ===== contracts/ports/CatalogPort.ts  (owner C3; consumers += C13)  — CR-C3-001 + C4-002 + C5-001 + C11-009 + C13-007 + R25; getTaxRate CR-C12-010 (A2.2/A4.1)
export interface RangeQuery { /* existing */ readonly ageDays?: number; readonly birthOn?: IsoDate }   // birthOn: exact calendar age when known; ageDays optional (A17.1: absent → only rows with no age restriction match)
export interface ReferenceRangeMatch { /* existing */ readonly kind?: 'numeric' | 'text' | 'ordinal'; readonly normalCodes?: readonly Code[] }
export interface AnalyteDefinition { /* existing */
  readonly formula?: { readonly expression: string; readonly inputAnalyteCodes: readonly Code[]; readonly inputUnitCodes?: Readonly<Record<Code, Code>> };
  readonly printName?: string }
export interface TestDefinition { /* existing */
  readonly departmentName?: string;                               // R25 (C6 report headings)
  readonly tatTargetSegment?: 'within_lab' | 'total';
  readonly specimenReportLabel?: string;                          // printed "Specimen:" line (00 §4)
  readonly usesExistingMaterial?: boolean }                       // CR-C11-009: C5 creates results without a specimen requirement
export interface PriceQuote { /* existing */
  readonly tax: { readonly vat: 'exempt' | 'taxable'; readonly otherTaxCode?: Code; readonly vatRateBp?: number;
                  readonly otherTaxRateBp?: number; readonly hsCode?: string } }   // rates owned by C3 (R18)
export type CatalogPartyPurpose = 'display' | 'notification' | 'billing';
export interface ReferrerProfile {
  readonly referrerId: Uuidv7; readonly canonicalReferrerId: Uuidv7; readonly code: Code; readonly displayName: string;
  readonly qualification?: string; readonly registrationNo?: string; readonly isVerified: boolean; readonly isActive: boolean;
  readonly contact?: { readonly phoneE164?: string; readonly email?: string } }      // purpose 'notification' + actor user|system only
export interface CreditPartyProfile {
  readonly creditPartyId: Uuidv7; readonly code: Code; readonly name: string;
  readonly kind: 'hospital' | 'company' | 'clinic' | 'partner_lab' | 'insurer' | 'other';
  readonly allowsCredit: boolean; readonly isActive: boolean; readonly priceListId?: Uuidv7;
  readonly pan?: string; readonly billingAddressText?: string;                     // purpose 'billing' only (C4 receipts/periodic invoices)
  readonly contact?: { readonly phoneE164?: string; readonly email?: string } }      // purpose 'notification' only
export interface CommentCodeResolution {
  readonly resolved: readonly { readonly code: Code; readonly commentCodeId: Uuidv7; readonly version: number; readonly departmentId?: Uuidv7; readonly text: string }[];
  readonly unknown: readonly Code[] }
export interface CatalogPortV1 { /* 7 existing methods */
  /** @throws common.not_found; auth.forbidden (purpose 'notification' from device/portal/patient/partner actor) */
  getReferrer(ctx: RequestContext, input: { referrerId: Uuidv7; purpose: 'display' | 'notification' }): Promise<ReferrerProfile>;
  /** @throws common.not_found; auth.forbidden (purpose 'notification'|'billing' from a non user/system actor) */
  getCreditParty(ctx: RequestContext, input: { creditPartyId: Uuidv7; purpose: CatalogPartyPurpose }): Promise<CreditPartyProfile>;
  /** Department-specific active code wins over tenant-wide; unknown/inactive codes → `unknown`; ≤ 50 codes.
   *  `asOf` returns the text version effective then. @throws common.validation_failed */
  resolveCommentCodes(ctx: RequestContext, input: { codes: readonly Code[]; departmentId?: Uuidv7; asOf?: IsoUtc }): Promise<CommentCodeResolution>;
  // ---- added by 08 Addendum A2.2 (CR-C12-010, additive). Signature verbatim from 08 Addendum A4.1 (supersedes the A2.2 text).
  /** Rate of one tax code effective on date `on` (tenant-local ISO date), read from C3's tax-rule data (R18 single source of rates).
   *  No 'exempt' kind (08 A4.1): exemption is a treatment (C3 `tax_rules.vat_treatment`; C12 purchase lines with no tax code), not a
   *  rate — C12 never calls getTaxRate for an exempt line. `effectiveFrom` is null for a rate with no versioned history (the global VAT
   *  row in `g_tax_types`); never derived from `created_at`.
   *  @throws catalog.tax_config_missing (no rate for taxCode effective on `on`) */
  getTaxRate(ctx: RequestContext, input: { taxCode: string; on: string /* ISO date, tenant timezone */ }): Promise<{ taxCode: string; ratePercentBasisPoints: number; kind: 'vat' | 'other'; effectiveFrom: string | null }>;
  // A24.1 (CR-C16-023; consumer C16): status set = C3 price_list_versions set (C3's set wins)
  /** @throws common.not_found */
  getPriceListStatus(ctx: RequestContext, input: { priceListId: Uuidv7 }): Promise<{ priceListId: Uuidv7; isActive: boolean; status: 'draft' | 'published' | 'superseded' | 'discarded' }>;   // C3 set wins (A24.1); derivation C3 TRD §7.4a: published > draft > discarded; superseded never returned
}
// getTest, getPanel, resolveOrderables, priceFor, referenceRangeFor, criticalLimitsFor @throws += common.not_found (C3 hand-off).
// priceFor @throws += catalog.tax_config_missing.  Contract cases: C3 TRD §14 cases 14–23 + (24) purpose 'billing' returns pan, never contact;
// (25) TestDefinition.departmentName present; (26) resolveCommentCodes asOf before a text change returns the old text.

// ===== contracts/ports/FrontdeskPort.ts  (owner C4) — CR-C5-003, C6-015, C16-007, C17-003, C4-006, R25
export type DemographicsPurpose = 'report_render' | 'label_print' | 'notification' | 'instrument_host_query' | 'portal_display'
  | 'partner_display' | 'smart_report' | 'home_visit' | 'result_evaluation' | 'lab_display' | 'patient_app_link';
export interface PatientDemographics { /* existing */
  readonly status: 'active' | 'merged' | 'anonymised';           // all purposes (CR-C16-007)
  readonly contactPresence?: { readonly phone: boolean; readonly email: boolean } }   // purpose 'notification' for non-system actors (CR-C6-015)
// Allowlist additions: result_evaluation → sex, ageAtOrder, birthOn (system, lab.result.enter/verify holders);
//   lab_display → fullName, sex, ageAtOrder, patientCode (lab.worklist.read or lab.status_board.read holders, system);
//   patient_app_link → fullName, sex, birthOn, phoneE164, status (engagement.link.issue holders, engagement system actor);
//   home_visit → fullName, phoneE164, consents, birthOn, sex (CR-C17-003);
//   notification + non-system actor → consents + contactPresence only (no phoneE164/email); system actors keep the full set.
export interface BookingOrderInput { /* existing */ readonly partnerId?: Uuidv7 }         // required iff source = 'partner_manifest'; immutable on the order
export interface OrderSummary { /* existing */ readonly partnerId?: Uuidv7 }               // R25
export interface FrontdeskPortV1 { /* 3 existing methods */
  /** Missing/invisible ids omitted. ≤ 200 ids. @throws auth.forbidden (purpose not covered) */
  getPatientDemographicsBatch(ctx: RequestContext, input: { patientIds: readonly Uuidv7[]; purpose: DemographicsPurpose }): Promise<readonly PatientDemographics[]>;
  /** Engagement system actor only. Always creates a NEW patient (source 'self_service'); never returns an existing id.
   *  @throws frontdesk.consent_required, auth.forbidden */
  createSelfRegisteredPatient(ctx: RequestContext, input: { fullName: string; sex: Sex; birthOn?: IsoDate; ageYears?: number; phoneE164: string;
    consents: PatientDemographics['consents']; idempotencyKey: string }): Promise<{ patientId: Uuidv7; patientCode: string; duplicateSuspected: boolean; replayed: boolean }>;
}
// createOrderFromBooking authorisation per source (R7). Contract cases (11)–(18): R7 cases (11)(12); batch omits other-tenant ids (13);
// lab_display returns no phone (14); notification by user actor returns contactPresence only (15); self-registration replay (16);
// duplicate-suspected still new id (17); patient_app_link refused without engagement.link.issue (18).

// ===== contracts/ports/BillingPort.ts  (owner C4) — CR-C15-002; callers staff or system only (R8)
export interface GatewayPaymentInput { /* existing */ readonly allowExceedsDue?: boolean }  // true: record full amount + finance_review_items 'gateway_payment_exceeds_due'
export interface GatewayRefundInput {
  readonly refundId: Uuidv7; readonly intentId: Uuidv7; readonly orderId: Uuidv7;
  readonly gateway: 'esewa' | 'khalti' | 'fonepay'; readonly gatewayTxnRef: string;
  readonly amount: Money;                      // positive; stored negative, entry_kind 'refund', capture_kind 'gateway'
  readonly reasonCode: Code; readonly approvedByMembershipId: Uuidv7; readonly refundedAt: IsoUtc }
export interface BillingPortV1 { /* 3 existing methods */
  /** Idempotent on refundId (idempotency_key 'gw_refund:'+refundId). @throws billing.ledger_reversal_invalid */
  recordGatewayRefund(ctx: RequestContext, input: GatewayRefundInput): Promise<{ ledgerEntryId: Uuidv7; duplicate: boolean; balance: OrderBalance }>;
}
// Contract cases (11) refund idempotent; (12) refund > refundable → billing.ledger_reversal_invalid; (13) allowExceedsDue records + review item;
// (14) patient/portal actor → auth.forbidden.

// ===== contracts/ports/LabPort.ts  (owner C5; consumers += C4, C17) — CR-C4-003, C6-006, C7-005, C10-001/C11-004, C10-003/C17-002, C14-002
export interface ResultView { /* existing */ readonly moduleRef?: { readonly module: 'micro' | 'anatomic'; readonly entityId: Uuidv7; readonly versionNo: number } }
export interface OrderResults { /* existing; specimens[] items gain: */ }   // specimens[].barcode?: string — P2, scope 'approved' only
export interface SubmitModuleResultInput { /* existing */ readonly amendment?: { readonly reasonCode: Code; readonly reasonText?: string } }  // R1
export type SpecimenSelector =
  | { readonly barcode: string }
  | { readonly specimenIds: readonly Uuidv7[] }                                  // 1..200
  | { readonly orderId: Uuidv7; readonly statuses?: readonly SpecimenStatus[] };
export interface SpecimenRef {
  readonly specimenId: Uuidv7; readonly barcode: string; readonly orderId: Uuidv7; readonly patientId: Uuidv7; readonly centreId: Uuidv7;
  readonly processingCentreId?: Uuidv7; readonly specimenTypeCode: Code; readonly containerCode?: Code; readonly status: SpecimenStatus;
  readonly isActive: boolean; readonly replacesSpecimenId?: Uuidv7; readonly parentSpecimenId?: Uuidv7; readonly version: number }
export interface AnalyteHistoryPoint {
  readonly source: 'lis' | 'legacy';                 // 'legacy' only when includeLegacy and C18 data exist (DEFER B4)
  readonly resultId: Uuidv7;                         // lab.results id, or lab.legacy_results id when source = 'legacy'
  readonly orderId?: Uuidv7; readonly versionNo?: number; readonly approvedAt: IsoUtc;
  readonly valueNumeric?: DecimalString; readonly unitCode?: Code; readonly flag?: 'N' | 'L' | 'H' | 'LL' | 'HH' | 'A' }
export interface LabPortV1 { /* 5 existing methods */
  /** Callers holding frontdesk.order.read or frontdesk.order.edit, or system. No PHI. (08 A13 D-5) */
  getOrderItemProcessingState(ctx: RequestContext, input: { orderId: Uuidv7 }): Promise<readonly { orderItemId: Uuidv7; removable: boolean; reasonCode?: Code;
    processingStatus: 'not_started' | 'in_progress' | 'reported' | 'cancelled' }[]>;
  // A17.2: not_started only when no specimen received AND no result beyond pending; removable false with reasonCode 'result_entered'
  //        when any result is resulted or later. Contract cases (35)(36) for D-61 (module_preliminary_update), 03-IC §4.5.
  /** Worklist download (BLOCKED B2 per instrument). Received specimens of the device's centre with ≥ 1 pending result mapped outbound for instrumentId. */
  listPendingForInstrument(ctx: RequestContext, input: { instrumentId: Uuidv7; receivedSince?: IsoUtc; limit?: number /* ≤ 200 */; cursor?: string }):
    Promise<Page<{ specimenId: Uuidv7; barcode: string; priority: Priority; patient: { sex: Sex; ageDays?: number };
                   tests: readonly { orderItemId: Uuidv7; testId: Uuidv7; analyteIds: readonly Uuidv7[] }[] }>>;
  /** No side effects; caller RLS. Users: lab.specimen.read; the {orderId} form also with homecollection.visit.read (C17 checks assignment);
   *  system: tenant-wide; device: refused. Unknown/invisible → omitted. An old barcode of a recollected specimen resolves only to the old specimen. */
  lookupSpecimens(ctx: RequestContext, input: SpecimenSelector): Promise<readonly SpecimenRef[]>;
  /** Approved results only, latest version, approvedAt in [since, before), newest first, RLS-scoped; unknown patient → empty series. */
  getAnalyteHistory(ctx: RequestContext, input: { patientId: Uuidv7; analyteIds: readonly Uuidv7[] /* 1..100 */; before: IsoUtc; since?: IsoUtc;
    limitPerAnalyte: number /* 1..10 */; excludeOrderId?: Uuidv7; includeLegacy?: boolean /* default false */ }):
    Promise<{ series: readonly { analyteId: Uuidv7; points: readonly AnalyteHistoryPoint[] }[] }>;
}
// JSDoc fixes: ingestInstrumentResult on an approved target returns outcome 'rejected_state' + reasonCode 'result_locked' and never throws
// lab.result_locked (CR-C5-008); a key stored as 'unmatched'/'rejected_state' with an OPEN exception is re-evaluated on replay and the
// exception closed on success (CR-C7-011). Contract cases (21) replay of unmatched key after fix → applied; (22)(23) R1 cases;
// (24) approved scope returns barcode; (25) module result returns moduleRef; (26) lookupSpecimens other tenant omitted / old barcode;
// (27) {orderId} form with homecollection.visit.read; (28) getAnalyteHistory never returns another patient's results; (29) listPendingForInstrument
// excludes approved/cancelled; (30) getOrderItemProcessingState: received specimen → removable false; (31) item whose only specimen is
// rejected without recollection → removable true, processingStatus 'cancelled' (A13 D-5); (32) all items reported → 'reported' (A13 D-5).
// Behaviour (CR-C9-004): with LIMS_LAB_AUTOVERIFY_HOOK_ENABLED=true, C5 calls QualityPort.canAutoVerify for every instrument-origin save
// (not on hold, no unit mismatch) and auto-verifies only on 'allow'.

// ===== contracts/ports/IdentityPort.ts  (owner C2) — CR-C6-007, C13-003, C16-004, C6-018 (A4.2); BrandingAssetContent.kind per A14.1; TenantSettings §4.12
export interface Signatory { readonly membershipId: Uuidv7; readonly displayName: string; readonly displayTitle?: string; readonly registrationNo?: string;
  readonly signatureAssetId?: Uuidv7; readonly signatureSha256?: string; readonly isActive: boolean }      // inactive still returned
export interface BrandingAssetContent { readonly assetId: Uuidv7; readonly kind: 'logo' | 'letterhead_header' | 'letterhead_footer';
  readonly mimeType: 'image/png' | 'image/jpeg'; readonly sha256: string; readonly base64: string }        // ≤ 2 MB
export type PartnerRole = 'partner_admin' | 'partner_member';
export interface IdentityPortV1 { /* 3 existing methods */
  /** System actor holding identity.signatory.read only. ≤ 20 ids; unknown/other tenant omitted. */
  getSignatories(ctx: RequestContext, input: { membershipIds: readonly Uuidv7[] }): Promise<readonly Signatory[]>;
  /** Callers: any `user` or `system` actor of the tenant. Returns only branding assets (kinds `logo`, `letterhead_header`, `letterhead_footer`);
   *  signature images are never returned here and stay behind `getSignatories` (system actor holding `identity.signatory.read`). (08 A13 D-26)
   *  Assets referenced by a released report stay readable (never deleted). @throws common.not_found */
  readBrandingAsset(ctx: RequestContext, input: { assetId: Uuidv7 }): Promise<BrandingAssetContent>;
  /** Caller: C13 service with partners.partner.manage (staff) or partners.partner_user.manage (partner admin of the same partner).
   *  @throws identity.user_exists, identity.tenant_suspended */
  provisionPartnerMembership(ctx: RequestContext, input: { email: string; displayName: string; partnerRole: PartnerRole }):
    Promise<{ membershipId: Uuidv7; userId: Uuid; invitationId: Uuidv7; status: 'invited' }>;
  /** Revokes sessions on deactivate/role change. Non-partner membership → common.not_found.
   *  expectedVersion (A19 D-100): omitted → applied to the current row under SELECT … FOR UPDATE; present → common.version_conflict on mismatch.
   *  @throws common.version_conflict, identity.membership_inactive */
  updatePartnerMembership(ctx: RequestContext, input: { membershipId: Uuidv7; action: 'deactivate' | 'reactivate' | 'set_role' | 'resend_invitation';
    partnerRole?: PartnerRole; reasonCode?: Code; expectedVersion?: number }): Promise<{ membershipId: Uuidv7; status: 'invited' | 'active' | 'deactivated'; version: number }>;
  /** Caller: patient pre_auth context only; idempotent per accountId; no phone/e-mail stored in GoTrue; GoTrue never messages these users. */
  provisionPatientMembership(ctx: RequestContext, input: { accountId: Uuidv7 }): Promise<{ membershipId: Uuidv7; userId: Uuid }>;
  /** Same caller restriction; membership must be actor_type 'patient' and active. Returns the opaque session token (R10). */
  openPatientSession(ctx: RequestContext, input: { membershipId: Uuidv7; appInstanceId: Uuidv7; appPlatform: 'android' | 'ios' }):
    Promise<{ sessionToken: string; accessToken: string; accessExpiresAt: IsoUtc; sessionExpiresAt: IsoUtc }>;
  /** Caller: the patient whose claims membership_id = membershipId, or the engagement system actor. */
  revokePatientSessions(ctx: RequestContext, input: { membershipId: Uuidv7; reason: Code; deactivateMembership: boolean }): Promise<{ revokedSessions: number }>;
  // ---- added by 08 Addendum A4.2 (CR-C6-018, additive)
  /** Caller: system actors only (reporting worker). `eligible` = membership status = 'active', actor_type = 'user', not locked
   *  (locked_at IS NULL — 08 A3.4), holds `requiredPermission`. `email` = core.users.email_normalized (08 A3.4). */
  getStaffNotificationContact(ctx: RequestContext, input: { membershipId: Uuidv7; requiredPermission: PermissionCode }): Promise<{ membershipId: Uuidv7; email: string | null; eligible: boolean }>;
  // ---- A21.2 (CR-C6-020, additive): C6 render worker; C2 implements
  /** Caller: system actor holding identity.signatory.read only. @throws common.not_found */
  readSignatureImage(ctx: RequestContext, input: { membershipId: Uuidv7 }): Promise<SignatureImageContent>;   // A26.1
}
export interface SignatureImageContent { readonly membershipId: Uuidv7; readonly contentBase64: string;      // A26.1 (not BrandingAssetContent)
  readonly mimeType: 'image/png' | 'image/jpeg'; readonly sha256: string }
// getActor additions: partner → permissions = fixed_actor_permissions.partner[role], centreScope {all:false, centreIds:[]}, roles [role];
// patient → fixed patient set (pre_auth stage → patient_pre_auth set); device with device_kind 'queue_display' → [engagement.queue.board_read],
// centreScope {all:false, centreIds:[claims.centre_id]}; branchIds = explicit membership_branches (R3).
// Migration system actor (CR-C18-007): DEFER (B4).

// ===== contracts/ports/ReportingPort.ts  (owner C6) — CR-C13-005, C16-008, R1
export interface ReleasedReportSummary { /* existing; kind gains 'addendum' */ readonly kind: 'final' | 'partial' | 'preliminary' | 'amended' | 'addendum' }
export interface ReleasedReportFile { readonly reportVersionId: Uuidv7; readonly reportId: Uuidv7; readonly versionNo: number;
  readonly status: 'valid' | 'superseded'; readonly contentType: 'application/pdf'; readonly byteSize: number; readonly sha256: string;
  readonly signedUrl: string /* internal Storage URL, TTL ≤ 300 s, never logged or returned to browsers */; readonly expiresAt: IsoUtc }
export interface ReportingPortV1 { /* 2 existing methods */
  /** Released or superseded versions only. Partner actors: reports.partner_id = app.current_partner_id(); patient actors:
   *  patient_id ∈ app.engagement_patient_ids() (C16 also checks visible_from). @throws common.not_found (indistinguishable) */
  openReleasedReportFile(ctx: RequestContext, input: { reportId: Uuidv7; versionNo: number }): Promise<ReleasedReportFile>;
  /** Patient actor. Valid unexpired unrevoked link, recipient 'patient', channel sms|whatsapp, destination = phoneE164.
   *  Never consumes/extends/reveals the link; 5 failures per token. @throws reporting.link_invalid (identical for every failure) */
  redeemPortalLinkForApp(ctx: RequestContext, input: { linkToken: string; phoneE164: string }): Promise<{ patientId: Uuidv7; reportId: Uuidv7; versionNo: number; releasedAt: IsoUtc }>;
}

// ===== contracts/ports/NotificationPort.ts (owner C6; consumers += C8) — CR-C8-007, C16-009
export type NotificationPurpose = /* existing */ 'registration_confirmation' | 'report_ready' | 'otp' | 'dues_reminder' | 'recollection_request'
  | 'critical_value_alert' | 'booking_confirmation' | 'visit_assignment' | 'follow_up_reminder'
  | 'scheduled_report_ready' | 'booking_cancelled' | 'booking_reminder';
// SendBase.related.entityType += 'report_run'

// ===== contracts/ports/PaymentProviderPort.ts (owner C15; consumers C4, C6, C16; callers staff or system only — R8; C6 = portal dues-payment
//       worker as system actor, createIntent/getIntent only — A11.1, CR-C15-010 ACCEPT-MODIFIED) — CR-C15-001 (exact C15 TRD §5.3)
export type IntentAction = | { kind: 'form_post'; url: string; fields: Readonly<Record<string, string>>; launchUrl?: string } | { kind: 'redirect'; url: string } | { kind: 'qr'; qrPayload: string };
export interface PaymentProviderPortV1 { /* createIntent, verify, refund existing */
  /** Read-only, no gateway call. `action` only while initiated/pending. */
  getIntent(ctx: RequestContext, input: { intentId: Uuidv7 }): Promise<{ intentId: Uuidv7; orderId: Uuidv7; gateway: Gateway; status: IntentStatus;
    amount: Money; refundedAmount: Money; expiresAt?: IsoUtc; settledAt?: IsoUtc; action?: IntentAction }>;
  /** Verifies first; settles instead if paid. @throws payments.intent_invalid_transition */
  cancelIntent(ctx: RequestContext, input: { intentId: Uuidv7; reasonCode: Code }): Promise<{ intentId: Uuidv7; status: IntentStatus }>;
}
// createIntent @throws += payments.amount_not_supported, payments.return_url_not_allowed. Contract case 5 refined + cases 12–18 (C15 TRD §5.3).
// 03-IC §10.6 replaced by C15 TRD §4.1 (I1–I14) incl. failed|expired → held_for_review (late_payment_found), partially_refunded → partially_refunded|refunded.

// ===== contracts/ports/SmartReportPort.ts (owner C14) — CR-C14-001 (+C16-015), C14-006
export interface SmartSummary { /* existing fields */
  readonly language?: 'en' | 'ne'; readonly builtAt?: IsoUtc; readonly disclaimerText?: string;
  // healthScore.explanationText?; panels[].displayName?; deranged[].analyteName?; followUps[].suggestedTestName?;
  // trends[].analyteName?, trends[].unitCode?, trends[].points?: { resultId: Uuidv7; approvedAt: IsoUtc; valueNumeric: DecimalString }[]
}
// buildSummary: callers staff (user) and system only (A2.3); internal 'rejected' maps to status 'draft'; contract cases 7–14 (C14 TRD §7.1).
// A19 D-111: buildSummary never throws smartreport.summary_not_ready (a not-yet-approved summary returns status 'draft'); the code stays registered, unused by the port.

// ===== contracts/ports/QualityPort.ts (owner C9) — CR-C9-003
export type AutoVerifyReason = /* existing */ 'feature_disabled' | 'instrument_flag' | 'outside_autoverify_limits' | 'critical' | 'delta_failure'
  | 'qc_out_of_control' | 'qc_no_data' | 'manual_origin' | 'rule_missing' | 'qc_warning';
// JSDoc: qcStatusFor returns out_of_control while a rejected run is not closed; no_qc_data when the last in-control run is older than the
// plan's validity; violatedRules may contain 'incomplete_run'. Contract cases 8–12 (C9 TRD §11.1).

// ===== NEW contracts/ports/BillingCommandPort.ts (owner C4/billing; consumer allowlist: frontdesk only) — CR-C4-001
// Normative text: C4 02-TRD §6.3 (signatures + 11 contract cases), with @throws billing.tax_config_missing replaced by catalog.tax_config_missing (R18).

// ===== NEW contracts/ports/RenderPort.ts (owner C6/reporting; consumers C4, C8, C13 (worker, partners system actor — A5.1)) — CR-C4-004 + C8-009 (R12c); CR-C13-014
export const RENDER_PORT_VERSION = 1 as const;
export type RenderTemplateKey = 'billing.invoice' | 'billing.credit_note' | 'billing.register' | 'analytics.report'
  | 'partners.access_slip';                                   // added by 08 Addendum A5.1 (CR-C13-014, additive)
export interface RenderPortV1 {
  /** System actors in worker tasks only. Data validated against contracts/render/<templateKey>.schema.json; bundled assets only (REQ-SEC-086);
   *  60 s timeout; the caller stores the bytes in its own bucket. analytics.report: ≤ 5,000 rows.
   *  @throws reporting.render_unavailable, reporting.template_invalid, common.payload_too_large (> 10 MB output), auth.forbidden (non-system actor) */
  renderPdf(ctx: RequestContext, input: { templateKey: RenderTemplateKey; data: Readonly<Record<string, unknown>>; idempotencyKey: string }):
    Promise<{ contentBase64: string; sha256: string; byteSize: number; pageCount: number }>;
}
// Contract cases: (1) unknown key → validation_failed; (2) data violating schema → reporting.template_invalid; (3) user actor → auth.forbidden;
// (4) same idempotencyKey + data → identical sha256; (5) renderer down → reporting.render_unavailable.

// ===== NEW contracts/ports/EngagementPort.ts (owner C16/engagement; consumers C4, C17; phase stub until C16 ships — R9) — CR-C17-005 + R25
export const ENGAGEMENT_PORT_VERSION = 1 as const;
export interface EngagementPortV1 {
  /** System actors, or staff holding homecollection.visit.assign / homecollection.visit.read (C17 checks the assignment). P2.
   *  Callers write access_log 'home_visit.view'. @throws common.not_found */
  getHomeAddress(ctx: RequestContext, input: { homeAddressId: Uuidv7; purpose: 'home_visit' }):
    Promise<{ addressText: string; landmark?: string; latitude?: DecimalString; longitude?: DecimalString }>;
  /** Registration (C4, frontdesk.registration.create holders). Returns undefined when no active membership. */
  getActiveMembership(ctx: RequestContext, input: { patientId: Uuidv7; at?: IsoUtc }):
    Promise<{ membershipId: Uuidv7; planCode: Code; planName: string; priceListId?: Uuidv7; validTo: IsoUtc } | undefined>;
}
// Contract cases: (1) other tenant → not_found / undefined; (2) device/patient actor → auth.forbidden; (3) expired membership → undefined.

// ===== PortRegistry (contracts/ports/common.ts) += BillingCommandPort, RenderPort, EngagementPort
// Reserved, DEFER (B4): LegacyPatientImportPort, LegacyResultImportPort, LegacyDocumentImportPort, legacy-common.ts.
```

01 §5.1 port table, final consumer lists: CatalogPort += C13 (getPriceListStatus: C16, A24.1) · FrontdeskPort = C5, C6, C10, C11, C13, C14, C15, C16, C17 (A19 D-110) · IdentityPort methods += getStaffNotificationContact (A4.2), readSignatureImage (A21.2; returns SignatureImageContent, A26.1) · SmartReportPort = C6 (A5.7) · BillingPort unchanged (callers staff/system) · LabPort += C4, C17 · ReportingPort unchanged · NotificationPort += C8 · PaymentProviderPort = C4, C6 (portal dues-payment worker, A11.1), C16 · new BillingCommandPort (C4 internal), RenderPort (C4, C8, C13 — A5.1), EngagementPort (C4, C17).

---

## 5. Founder, client and auditor decisions — with the default to build against

### 5.0 Decided by the founder on 2026-11-06 (recorded in research/04 §11 and §13; closed)

| Item | Decision | Effect in this register |
|---|---|---|
| Authenticode code-signing certificate for the bridge agent (CR-C7-012) | Purchased and owned by the **client** | C7 release pipeline signs with the client's certificate (held in the C1 secret store) plus the internal Ed25519 signature (04 N11); no longer an open item |
| App-store developer accounts, listings, signing keys — patient and phlebotomy apps (C16 FA-1, C17) | Owned by the **client** | Release pipelines use client-owned accounts and keys via the C1 secret store; app ids/fingerprints for CR-C16-010 come from the client |
| Maps hand-off from the phlebotomy app to the device's own maps app (CR-C17-012) | **Approved** (04 §11 row) | CR-C17-012 = ACCEPT; hand-off via OS intent/URL carries the address only (no name, tests, phone); no embedded map SDK |
| Per-summary pathologist approval of smart reports (C14 R1) | **Kept** | 03-IC §4.10 invariant unchanged; `min_mapped_results` default 3; no bulk approval (R17) |

Rule (07-BLOCKERS): build against the default, keep the decision behind configuration or an interface, never present the default as the answer.

### 5.1 Open founder decisions

| # | Decision | Raised by | Options | Default to build against | How it stays swappable |
|---|---|---|---|---|---|
| F-01 | Non-PHI egress register: OS package mirrors, container-image registries, ClamAV signature mirrors, ACME CA, Git host, optional SMS paging of ops (B11 scope) | CR-C1-006 | approve all / approve subset / mirror everything offline | No product host has direct egress except worker → approved provider FQDNs (04 §11) and app-1 → ACME CA; all other fetches only from ops-1 through logging Squid; ops paging by e-mail only; SMS paging off | `infra/edge/egress-allowlist.yaml`; paging channel config |
| F-05 | Push notifications through FCM/APNs (foreign touchpoint, B11) | CR-C16-020 (not raised) | approve generic-text push / no push | No push; in-app polling and SMS via NotificationPort | feature flag, default off |
| F-06 | When C18 work starts (B4 lifted only by the client's eLabs sample) | CR-C18-001…007 | — | Design only; no DDL, ports or tool code (R15 wording) | C18 isolated in `tools/migration` and `migration_staging` |
| F-07 | Legacy eLabs invoices and opening balances — to the client's auditor via the founder (B6/B7) | CR-C18-009 (draft) | (A) no import, eLabs read-only; (B) read-only legacy reference table outside the billing sequence; (C) opening balances per credit party | (A) | no billing schema change until decided |
| F-08 | Doc-owner sign-off on the program-level wording changes decided here: research/04 P4 Khalti `Initiated` (A19.2 / D-114), research/04 §4 Login row (R6), 04 D4 wording (R5), 04 §13 B4 default (R15), 02-CV §15.2 ops-tool licence row (R15), 02-CV §4.7 amounts (R15) | this register | sign / return with comments | Apply phase edits the documents as decided; if R6 is returned, build the unamended 04 §4 values (5/min/IP everywhere) | nginx zone config |
| F-09 | Confirm the cost of the 32 GB app VM (8 vCPU / 32 GB); 16 GB is not deployable as specified | A25.1 / D-207 / A27.1 | confirm | Build for 32 GB (CR to research/04 I1); `container_hardening.py` asserts Σ `mem_limit` ≤ 85 % of host RAM |
| F-10 | DR site storage may need ~2 TB instead of 1 TB (worst-case WAL ≈ 840 GiB over 35 days) | A27.4 | confirm after measurement | Measure in C1 T-09 before go-live |

### 5.2 Open client (clinical / operational) decisions

| # | Decision | Raised by | Options | Default to build against |
|---|---|---|---|---|
| C-02 | Whether an anatomic sign-out by a holder of `lab.result.approve` may also count as C5 first-level verification (C11 Q4) | CR-C11-010 | yes (one-step for anatomic) / no | **No** — A1 chain: sign-out → verify → approve (approver ≠ verifier) (R2) |
| ~~C-03~~ | ~~Static public egress IP of each lab/centre to register for the 30/min login zone~~ — **withdrawn by Addendum A1** | R6 | — | — |
| C-04 | Paying dues from the web portal (patient link) in addition to the patient app | CR-C15-010 | add later by CR (C6 must agree; worker pattern R8) / never | **CLOSED 2026-11-06: YES — ships with C15 (A11.1)** |
| C-05 | Module priority (B1) still decides when C13, C16, C17 ship; the phase stubs (R9) keep Phase-1 production bootable meanwhile | 07 B1 | — | 01 §1 wave order |
| C-06 | Does the client have or plan its own patient/phlebotomy app? (00 §3 item 5) | A19.4 / D-124 | — | The LIMS provider builds both (C16, C17) |
| C-07 | May a person deactivated at one lab be invited by another lab with the same e-mail? | D-220 (C2 #57) | — | **No** in v1 (`identity.user_exists` restriction stays); C2 PRD §11 Q5 cites it |

---

## Addendum A1 (2026-11-06, founder decision) — R6 replaced: login rate limiting must not depend on static IPs

**Founder instruction:** labs without a static IP must still be able to log in normally.

**Decision (supersedes R6's registered-egress-IP zone entirely):**
- **Per-IP limit counts FAILED attempts only, enforced in the identity module (C2).** A per-IP failure counter keyed by the client IP the BFF forwards (header set by nginx, trusted only from nginx). Successful logins never consume per-IP quota.
- **Failure threshold:** ≥ 10 failed staff logins within 10 min from one client IP throttles that IP to 5 attempts/min for 30 min. It also emits a security event and alerts the tenant admin(s) of every tenant whose accounts were targeted, plus the LIMS provider on-call. Values are [CONV] tunables in tenant-independent config.
- **Edge flood guard (nginx, C1):** 60 requests/min/IP (burst 20) on public login and recovery routes. This is a DoS ceiling only; legitimate shared-NAT traffic stays far below it.
- **Unchanged primary controls:** 10/hour/account; exponential backoff and step-up after ≥ 5 failures per account; MFA for privileged roles (04 A4); breached-password list (04 A3); bcrypt (04 A2).
- **Scope:** applies to staff web, partner and staff-mobile login. Patient OTP keeps its own limits (04 A9 + R6 placement text).
- **Placement rule from R6 kept:** the limit is keyed on the client IP seen at the public edge, never the BFF's address.
- **Removed:** registered lab egress IPs, `platform.tenant_egress_ip.manage`, the `setTenantEgressIps` operation and its error/access-log codes, and client decision **C-03** (static IPs). Remove them wherever the apply phase already inserted them.

**Exact replacement for research/04 §4 "Login" row, Limit cell:**
"Per account: 10/hour; ≥5 failures → exponential backoff + step-up. Per client IP (as seen by the public edge, never the BFF): failed attempts only — ≥10 failures in 10 min → that IP limited to 5 attempts/min for 30 min + security alert; successful logins never count. Edge flood guard: 60 req/min/IP (burst 20) on public login/recovery routes. No static-IP or IP-registration dependency (founder decision 2026-11-06)."
Enforced at: "nginx (flood guard) + identity module (per-account and per-IP failure counters)".

**Rationale:**
- Per-IP *attempt* limits punish shared NAT, which is the normal setup at Nepali labs.
- Per-IP *failure* limits still slow single-source credential stuffing.
- Distributed stuffing is handled by the per-account limits, breach-list, MFA and alerting.
- Nothing becomes weaker than R6 for credential guessing; the only change is that legitimate successful logins are never throttled.

**F-08** now covers this text instead of R6's.

## Addendum A2 (2026-11-06, lead decisions on apply-phase findings)

**A2.1 — C13 patient access slip vs R8.**
- **Problem:** `ReportingPort.issuePortalLink` creates a link token, so it is a write, not a read. R8 allows partner actors only the listed reporting reads.
- **Decision:** move the call to the worker, consistent with R8.
  - A partner request `POST …/access-slips` records a slip request in `partners.*`.
  - The C13 worker, running as the partners system actor, calls `issuePortalLink`, then stores the slip's reference in `partners.*`.
  - The partner UI polls the slip status, typically under 5 s [CONV].
  - No token or link is returned in the partner HTTP response. Only the printable slip is available to download from `partners.*`. The plaintext link token is never stored; the slip PDF is rendered once from the worker and stored in the partners bucket.
- **R8 allowlist:** unchanged.
- `access_slip_enabled` may be turned on once this is implemented.

**A2.2 — C12 purchase-tax tables vs R18.**
- **Decision:** R18's single-source rule covers tax **rates**, on both the sales side and the purchase side.
  - C12 keeps its purchase-side treatment data in `inventory.*`: tax code per item and supplier, and the `vat_in_cost` flag.
  - C12 does not store rate values. It reads them from C3's tax-rule data through a new additive `CatalogPort.getTaxRate(ctx, {taxCode, on})`, which C3 implements.
- **Accepted as CR-C12-010 (additive).**
- C12 docs: rate columns removed from `inventory.g_cs_tax_codes` / `cs_tax_codes`, and the `getTaxRate` usage added.
- C3 docs: the method is added to its CatalogPort implementation.
- 03-IC §4: **superseded by A4.1** — original text: `getTaxRate(ctx: PortCtx, input: { taxCode: string; on: string /* ISO date */ }): Promise<{ taxCode: string; ratePercentBasisPoints: number; kind: 'vat'|'other'|'exempt'; effectiveFrom: string }>`, throws `catalog.tax_config_missing`.

**A2.3 — Smart summaries for patient, portal and partner readers (C14, C16, C6, C13).**
- **Problem:** R8 allowed non-staff `buildSummary` reads, but no RLS exists for them.
- **Decision (least privilege):** `smartreport.*` stays staff/system-only, with no non-staff RLS policies.
  - Non-staff actors receive smart-summary content only through reporting. When staff attach an approved summary (C6 Regenerate, reason `smart_summary_added`), C6 stores the approved `SmartSummary` JSON snapshot alongside that report version.
  - Patient (C16), portal (C6) and partner (C13) readers get it via `ReportingPort` / portal reads, which already have their actor policies (CR-C13-005, CR-C16-008).
- **Changes:**
  - R8's allowlist entry "SmartReportPort reads" is removed for non-staff actors.
  - C16's smart tab reads from ReportingPort.
  - C14 05-SCHEMA note is updated accordingly.
  - C6 05-SCHEMA adds `smart_summary_json jsonb NULL` (+ `smart_summary_id`, `smart_summary_version`) to the report-version table.

**A2.4 — R24 scope.** Stored token **hashes and HMACs** that are compared for authentication or redemption are `bytea` with `octet_length = 32`. This includes C16 `link_codes.code_hmac` and `bound_phone_hmac`; `app.engagement_redeem_link_code` takes `bytea`. Content and row digests (file checksums, payload digests) may stay hex `text` with a format CHECK.

**A2.5 — C17 `map_handoff_enabled`.** The founder approved the maps hand-off, so the default becomes **true**. It remains a tenant operational switch.

**A2.6 — C8 scheduled-report e-mails through C6.**
- **Template code:** `analytics.report_ready`, which satisfies `g_message_templates__code__ck`. `analytics_report_ready` is renamed everywhere.
- **New C6 param kind `short_text`:** ≤ 80 characters, plain text, no URLs, escaped. It is used by `schedule_name`.
- **Staff recipients for purpose `scheduled_report_ready`:**
  - C6 resolves the recipient's e-mail through `IdentityPort` (staff profile e-mail of an active membership holding `analytics.report.read` in that tenant), not through FrontdeskPort.
  - Link-only, no PHI in the body.
  - Phase-1 suppression of staff recipients is lifted for this purpose only.

**A2.7 — C8 and the engagement daily views.** C8 is removed from the consumer list of `engagement.v_pub_booking_daily` / `v_pub_queue_daily` for now. Booking/queue dashboard tiles will come as a later additive C8 CR once C16 ships. The views stay; C16 owns them.

**A2.8 — A2.3 in C6.** C6 already added the partner/patient SELECT policies on `reports` / `report_versions` / `qr_tokens`. Still to add: the `smart_summary_json` / `smart_summary_id` / `smart_summary_version` columns on the report-version table, and the snapshot write at Regenerate.

**A2.9 — Missing access-log codes from C4.** Accept `patient.update`, `patient.anonymise`, `credit_note.print` and `receipt.print` into the access-log seed (03-IC §13.1).

**A2.10 — C5 label-print conflict.** Keep `409 common.version_conflict` with a detail message. No dedicated code.

**A2.11 — `contracts/routes.yaml` block in 03-IC §7 must be strict YAML.** Quote every path string that contains `{param}`. Validate it with a YAML parser.

**A2.12 — Home-collection booking cancelled after registration (R7).** The existing `frontdesk.order_flags` kind satisfies R7's review requirement. The `finance_review_items.kind` addition is withdrawn.

## Addendum A3 (2026-11-06, lead decisions on the C0–C2 apply report)

**A3.1 — Reuse detection for rotated app session tokens (patient, staff_mobile).**
- **Decision:** ACCEPT as CR-C2-018 (additive schema).
- `identity.sessions` gains `previous_token_sha256 bytea NULL CHECK (previous_token_sha256 IS NULL OR octet_length(previous_token_sha256) = 32)`. On rotation the old `token_sha256` moves here; only one previous token is kept.
- New index-rule exception: partial global unique index `identity.sessions(previous_token_sha256) WHERE previous_token_sha256 IS NOT NULL`, used only by the inventoried session-resolve DEFINER. Added to 08 §4.7 and `db/meta/index-exceptions.yaml`.
- Presenting a token that matches `previous_token_sha256` revokes the session (`revoke_reason = 'token_reuse'`) and writes `auth_events.session_token_reused`.

**A3.2 — C1 fail2ban `lims-auth` jail vs A1.**
- **Problem:** the jail bans an IP for 1 h after 10 login 401/429 responses in 10 min, which would lock out a whole lab behind one shared NAT. That breaks the founder requirement (no static IP needed).
- **Decision:** the jail no longer counts 401 responses at all; failed-password handling belongs to the identity module (A1).
  - It counts only nginx `limit_req` rejections (429) in the `login` zone. Threshold: ≥ 300 rejections in 10 min → ban 15 min [CONV: roughly 5× the flood guard sustained for 10 minutes, which no legitimate shared NAT produces].
  - Ban events raise the same security alert as A1.
- C1 02-TRD, 07-SECURITY and runbooks are updated; AC: 60 failed logins/min from one IP for 10 min do **not** trigger a fail2ban ban (the identity throttle handles them).

**A3.3 — C2 `05-SCHEMA` §3.1 vs C0 core DDL.**
- **Decision:** C0 owns `core.*` DDL (01 §3). C0 `05-SCHEMA` is authoritative.
- C2 §3.1 is rewritten to mirror C0 column-for-column (`status` + generated `is_active`, `code` naming, lengths) and is labelled "mirror of C0 05-SCHEMA §10 — C0 wins on conflict". C2 code reads `core.*` only through CoreRepository/ports as already specified.

**A3.4 — Correction to A3.3 (memberships lifecycle columns).**
- **Error in A3.3:** it said C0 has `status` + generated `is_active` on `core.memberships`. It does not; C0 §10 has a plain `is_active` and no `status`. The C2 mirror correctly follows C0 as written.
- **Decision:** CR-C2-003's remaining columns are merged into **C0 05-SCHEMA §10** (C0 owns them; additive), so C2's lifecycle logic has real columns:
  - `core.memberships`: `status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','deactivated'))`; `is_active` becomes `GENERATED ALWAYS AS (status = 'active') STORED` on this table only (writers set `status`, never `is_active`); `invited_at`, `accepted_at`, `deactivated_at timestamptz NULL`, `deactivated_by uuid NULL`, `deactivation_reason_code text NULL`, `lock_reason_text text NULL CHECK (≤ 500)`, `last_login_at timestamptz NULL`; `lock_reason_code` CHECK IN (`left_organisation`,`security_concern`,`policy_violation`,`other`). **No `is_locked` column:** locked = `locked_at IS NOT NULL` (C0's existing pair); C2 logic and DEFINER SQL use that expression.
  - Both partial unique indexes (`memberships__tenant_id_user_id_actor_type__p_uq` and R27 `memberships__user_id__p_uq`) use `WHERE status IN ('invited','active')` instead of `WHERE is_active`, so a pending invite also blocks a duplicate membership / second tenant.
  - `core.users`: `email_normalized text NULL CHECK (≤ 254)` with `UNIQUE (tenant_id, email_normalized)`; `phone_e164 text NULL CHECK (~ '^\+[1-9][0-9]{7,14}$')`; `last_login_at timestamptz NULL`.
  - `core.tenants`: `status_reason text NULL CHECK (≤ 500)`, `activated_at`, `suspended_at`, `offboarded_at timestamptz NULL` (renamed from C2's `terminated_at` to match C0's status value), `billing_live_on date NULL`.
  - `core.dead_letters`: `version integer NOT NULL DEFAULT 1`.
  - Indexes: `role_permissions (tenant_id, permission_code)`, `membership_roles (tenant_id, role_id)`.
- C2 §3.1a is closed by moving these into the §3.1 mirror; C2 §10.2 proposal removed.
- **C1 `lims-ratelimit` jail change** made during A3.2 (exclude login-zone routes and app-generated 429s) is **accepted**: without it, C2's own throttle 429s would get a shared-NAT IP banned and A3.2 would have no effect.

## Addendum A4 (2026-11-06, lead decisions on the A2 fix-pass report)

**A4.1 — `PortCtx` was a lead typo in A2.2.** No such type exists. The signature is:
`getTaxRate(ctx: RequestContext, input: { taxCode: string; on: string /* ISO date, tenant timezone */ }): Promise<{ taxCode: string; ratePercentBasisPoints: number; kind: 'vat' | 'other'; effectiveFrom: string | null }>`, throws `catalog.tax_config_missing`.
- `kind: 'exempt'` is removed: exemption is a treatment (C3 `tax_rules.vat_treatment`; C12 purchase lines with no tax code), not a rate. C12 never calls `getTaxRate` for an exempt line.
- `effectiveFrom` is `null` for a rate with no versioned history (the global VAT row in `g_tax_types`); never fake it from `created_at`.

**A4.2 — Wrong permission name in A2.6.** `analytics.report.read` does not exist (03 §11). The recipient must hold the **permission the scheduled report itself requires** (`analytics.dashboard.read`, `analytics.collections.read`, or `analytics.referral_report.read`, per C8's report catalogue).
- New additive IdentityPort method (CR-C6-018), caller: system actors only (reporting worker):
  `getStaffNotificationContact(ctx: RequestContext, input: { membershipId: Uuidv7; requiredPermission: PermissionCode }): Promise<{ membershipId: Uuidv7; email: string | null; eligible: boolean }>`
  `eligible` = membership `status = 'active'`, `actor_type = 'user'`, not locked, holds `requiredPermission`. `email` = `core.users.email_normalized` (A3.4).
- C8's notification request for purpose `scheduled_report_ready` carries `recipient: { kind: 'staff'; membershipId; requiredPermission }`. Ineligible or no e-mail → C6 records `suppressed_no_contact`; C8 already validates at schedule time with `analytics.recipient_ineligible`.

**A4.3 — `short_text` collision.** C6 already had `short_text` (≤ 40, charset regex, used by `ref`/`booking_no`); A2.6 must not loosen it. Restore `short_text` exactly as before. The new kind is **`label_text`**: ≤ 80 characters, plain text, no URLs (`://` or `www.` rejected), HTML-escaped. `schedule_name` uses `label_text`.

**A4.4 — Snapshot timing.** Every report version assembled with an approved smart summary fills `smart_summary_json` / `smart_summary_id` / `smart_summary_version` — at first assembly and at Regenerate alike. `smartSummaryAvailable` = those columns are non-null on the version being read.

**A4.5 — `receipt.print`.** If C4 renders the receipt server-side (PDF/print payload endpoint), that handler writes `receipt.print`, including reprints marked "Copy of Original". If C4 has no such endpoint, the code stays registered but unused in v1 — no new endpoint is added for logging only.

**A4.6 — `smartreport.summary_not_ready`.** Kept; meaning narrowed to staff callers: summary requested before it is approved. The patient/portal/partner wording is removed.

**A4.7 — Portal display of the smart summary.** C6 owns the portal UI: add a "Health summary" section on the portal report page rendered from the version snapshot only, hidden when `smart_summary_json` is null, read-only, with the same plain-language disclaimer text C14 defines for the printed summary.

**A4.8 — §13.1 access-log block.** Convert it to a strict YAML list (`- patient.update`, one code per line) and validate it; content unchanged.

## Addendum A5 (2026-11-06, lead decisions on the C8/C12–C17 fix-pass report)

**A5.1 — Access-slip rendering (C13).** Add `'partners.access_slip'` to `RenderTemplateKey` (03 §4, RenderPort, owner C6; additive, CR-C13-014). C13's worker (partners system actor) is a listed RenderPort consumer. The QR code is drawn inside C6's render pipeline from a `portalUrl` field in the template data (C6 already renders report QR codes), so C13 adds no QR library. Data schema `contracts/render/partners.access_slip.schema.json`: `{ tenantDisplayName, partnerName, patientDisplayName, orderRef, portalUrl, expiresAtLocal, issuedAtLocal }` — no results, no PHI beyond name and order ref. The portal URL exists only in worker memory and inside the PDF; it is never logged or stored as text.

**A5.2 — Partners bucket.** `partners-slips` is registered in 08 §4.8 (row added).

**A5.3 — Accepted [CONV] values from C13/C12.** Poll every 1 s, give up after 30 s; purge task 02:50 deletes the PDF at link expiry; access-log row on every slip download; R6 returns `404 common.not_found` when no file exists; C12 `getTaxRate` `on` = tenant business date of the line write.

**A5.4 — C8 schedule name validation.** C8's `schedules__name__ck` mirrors `label_text` (A4.3): length 1–80, rejects `://` and `www.` (case-insensitive), keeps its existing `@` and 7-digit-run rejections. C8 sends `recipient: { kind: 'staff', membershipId, requiredPermission }` where `requiredPermission` comes from C8's report catalogue (A4.2).

**A5.5 — A2.4 wider scope.** Every HMAC compared for authentication, redemption or phone matching is `bytea` with `octet_length = 32`: C16 `otp_challenges.code_hmac`, `otp_challenges.phone_hmac`, `accounts.phone_hmac`, `link_codes.record_phone_hmac`, and any equal column in C6/C13/C17. Comparisons are bytea = bytea; `decode(…,'hex')` workarounds are removed.

**A5.6 — Tax code values (C3 ↔ C12).** Tax codes are C3's (`^[A-Z0-9_]{1,16}$`, e.g. `VAT`). C12's `g_cs_tax_codes` / `cs_tax_codes` hold C3 tax-code values plus purchase treatment only; C12 seeds and examples use uppercase C3 codes. A code with no C3 rate → `catalog.tax_config_missing`.

**A5.7 — 03 §4.10 consumer list.** C16 is removed as a SmartReportPort consumer (A2.3); the rest of the list is unchanged.

## Addendum A6 (2026-11-06, lead decisions on the A3.4 apply report)

- **A6.1 — Wire names stay.** `is_locked` (API filter/field) and `ActorProfile.isLocked` remain wire names, always computed as `locked_at IS NOT NULL`. No API rename.
- **A6.2 — Phone pattern.** The DDL is the source: API validation for `phone_e164` uses `^\+[1-9][0-9]{7,14}$`, identical to the A3.4 CHECK.
- **A6.3 — `deactivation_reason_code`.** Same CHECK set as `lock_reason_code` (`left_organisation`,`security_concern`,`policy_violation`,`other`). Reactivate sets `status='active'` and clears `deactivated_at`/`deactivated_by`/`deactivation_reason_code` (history stays in `audit.audit_log`). `suspendTenant`/`terminateTenant` `reason_text` is stored in `core.tenants.status_reason`. The admin UI shows `memberships.last_login_at` (per tenant); `users.last_login_at` is internal.
- **A6.4 — Dead letters.** C0 `ctx.core.deadLetters.replay/discard` take `expectedVersion` (If-Match); mismatch → `409 common.version_conflict`.
- **A6.5 — Confirmed:** `version` in the dead-letter trigger allowed-change list; lifecycle timestamps as state-machine side effects; DEFINER output `membership_locked`; `__platform` policy SQL kept in C2 §10.2.
- **A6.6 — Login membership count.** `app.identity_login_context` counts only memberships with `status = 'active'` and `actor_type = 'user'`; deactivated memberships never trigger `identity_multi_membership`.

## Addendum A7 (2026-11-06, notes on the A4/A5 apply report for 03, C3, C4, C6)
- **A7.1** C6 `decode(…,'hex')` in token-lookup policies converts a text session setting to compare with bytea SHA-256 token hashes. Allowed; A5.5 covers stored HMAC columns only.
- **A7.2** C4 renders receipts client-side (`PrintFrame`); `receipt.print` stays registered, unused in v1 (A4.5 second branch).
- **A7.3** `NotificationPort` staff recipient `requiredPermission?` optional is accepted; for purpose `scheduled_report_ready` a missing value → `suppressed_no_contact`.
- **A7.4** C6 01-PRD gets an acceptance criterion for the portal Health summary in the review fix pass.
- **A7.5** The RenderTemplateKey addition in A5.1 is **CR-C13-014** (A5.1 mistakenly reused CR-C13-012, which is C13's access-log-codes CR).
- **A7.6** Accepted: C8 `requiredPermission = analytics.dashboard.read` for every pack (the per-report permissions only filter pack content); C12 exempt purchase lines carry `tax_code: null`, `tax_rate_bp = 0`, never call `getTaxRate` (clarified by A17 D-70: this describes the stored column; on the wire the line carries `is_exempt: true` and omits `tax_code`); C16 `account_patient_links.record_phone_hmac_at_link` converted to bytea(32) under A5.5; C16 `decode(<JWT claim>,'hex')` in pre-auth policies allowed (same as A7.1).

## Addendum A8 (2026-11-06, lead decisions on the A6 apply report)
- **A8.1 — Login membership choice.** `app.identity_login_context` picks the `actor_type='user'` membership with `status='active'` (at most one exists, R27/A3.4). If none is active, it reports the most recently updated one (`ORDER BY updated_at DESC LIMIT 1`) so the error reflects that membership's state. Never `LIMIT 1` without ORDER BY.
- **A8.2 — M6 (reactivate a never-accepted member → `invited`).** Also clears `deactivated_at`/`deactivated_by`/`deactivation_reason_code`.
- **A8.3 — T5 terminateTenant.** Each membership set to `deactivated` gets `deactivated_at = now()`, `deactivated_by = <platform actor>`, `deactivation_reason_code = 'other'`; the reason text lives in `core.tenants.status_reason`.
- **A8.4 — Dead-letter discard reason.** C0 adds `core.dead_letters.resolution_note text NULL CHECK (char_length(resolution_note) BETWEEN 1 AND 500)`; `ctx.core.deadLetters.discard({ deadLetterId, expectedVersion, reasonText })` stores it; replay may pass an optional note. The trigger's allowed-change list includes `resolution_note`.
- **A8.5 — `DeadLetterRow` (C0 defines it).** `{ id; tenantId: Uuidv7 | null; taskIdentifier; lastErrorCode; lastErrorMessageRedacted; attempts; firstFailedAt; deadAt; state; resolvedBy; resolvedAt; resolutionNote; version }`. `job_payload` is never returned (may contain identifiers). C2 list/get responses include `version` for If-Match.
- **A8.6 — Single write path.** C2 writes dead letters only through `ctx.core.deadLetters`; C2's own repository allowlist proposal and direct UPDATE grant are removed. The `__platform` SELECT/UPDATE policies stay (C0 writes them; `ctx.core` runs under platform claims and needs them).

## Addendum A9 (2026-11-06, lead decisions on the A8 apply report)
- **A9.1** `ctx.core.deadLetters` gains `get({ deadLetterId }): Promise<DeadLetterRow>` (throws `common.not_found`). C2 `getDeadLetter` uses it.
- **A9.2** `ctx.core.deadLetters.list` filters become `{ state?; platformRows?; tenantId?; taskIdentifier?; deadAtFrom?; deadAtTo?; cursor?; limit? }`, matching C2 `listDeadLetters`; index `(state, dead_at)` and `(tenant_id, state, dead_at)` already cover them (task_identifier filtered in-page [CONV]).
- **A9.3** Replay note: `replay({ deadLetterId, expectedVersion, reasonText? })`; C2 `replayDeadLetter` accepts optional `reason_text` (1–500), stored in `resolution_note`.
- **A9.4** C0 writes full SQL bodies for the `app.dl_*` DEFINER functions (version guard, state transition, note write, no `job_payload` in output).
- **A9.5** `deactivated_by` at terminateTenant = the platform staff user id who performed it (the human actor), never a system actor.
- **A9.6** Fix the broken C0 02-TRD §6.8 reference to "05-SCHEMA §4.8" to the correct section.

## Addendum A10 (2026-11-06, lead decisions on the A9 apply report)
- **A10.1 — Platform-row replay payload.** `app.dl_resolve(... p_action => 'replay')` also returns `job_payload` to the core service only; `services/api/src/core` strips it before building `DeadLetterRow` and re-enqueues through the existing core enqueue path. No HTTP response or log ever contains it (A8.5 still holds at every API boundary).
- **A10.2 — C2 `platform_rows` query parameter.** `listDeadLetters` accepts `platform_rows` (boolean, default false) → `platformRows`; with `true`, `tenant_id` must be absent (400 `common.validation_failed` otherwise).
- **A10.3 — Confirmed:** `get` via optional `p_dead_letter_id` on `app.dl_list_platform`; sort `dead_at DESC, id DESC` [CONV]; defensive message `dl_resolve_invalid_input`.
- **A10.4 — Platform policies on `core.dead_letters`.** `__select__platform` / `__update__platform` add `AND tenant_id IS NOT NULL`. NULL-tenant rows are reachable only through the `app.dl_*` DEFINERs.
- **A10.5 — Program-wide rule: every DEFINER read of a FORCE-RLS table needs an owner policy.** FORCE RLS applies to `lims_owner`, so any SECURITY DEFINER that reads, updates or deletes a FORCE-RLS table must have a matching `__<cmd>__owner_only` policy `TO lims_owner` with the narrowest USING clause that the function needs. Immediate cases: `identity.platform_staff` (`__select__owner_only USING (true)`, used by `app.is_platform_actor()`), and the C7 purge targets (see batch-1 triage). CI test (C0-0B): for each function in `db/meta/definer-inventory.yaml`, run its contract test with FORCE RLS on and assert non-empty results where expected; schema tests must never disable RLS on stand-in tables.

## Addendum A11 (2026-11-06, client decisions relayed by the founder)
- **A11.1 — C-04 CLOSED: YES.** Patients can pay dues from the web portal (report link), not only the patient app. It ships together with C15 (eSewa ePay v2 and Khalti KPG-2; Fonepay stays BLOCKED B8). It cannot ship earlier than C15 because no gateway exists before it. CR-C15-010 changes **DEFER → ACCEPT-MODIFIED**:
  - C6 portal is a payment *requester*, following the C16 worker pattern (R8): the portal actor creates a `reporting.portal_payment_requests` row (spec by C6) and enqueues a job; the worker as system actor calls `PaymentProviderPort.createIntent` / `getIntent`. Portal actors never call PaymentProvider or Billing ports directly.
  - Amount = `BillingPort.getOrderBalance` read by the worker at request time; the patient never supplies the amount.
  - Return/cancel URL = `<PORTAL>/r/payments/{portal_payment_request_id}/done` (C6 route) [CONV].
  - Ledger entry only via `payments.intent.settled.v1` → C4 `recordGatewayPayment` (unchanged).
  - Before C15 is live the portal shows the balance and "pay at the counter or in the app" with no payment button (the C15 phase stub reports gateways unavailable).
- **A11.2 — C-05 / B1 CLOSED.** The client confirmed the current module order (01 §1 wave order) as the priority. B1 is closed with that order.

## Addendum A12 (2026-11-06, lead decisions on the A10 apply report — pre-tenant and maintenance DEFINERs under FORCE RLS)
- **A12.1 — Pre-tenant lookup GUCs (applies 08 §4.7 rule; names fixed here).** A pre-tenant DEFINER sets transaction-local GUCs **inside the function body** with `set_config(name, value, true)` before each read, and its owner policies (`TO lims_owner`) match on them. Names (all `app.pre_*`, text values):
  - `app.pre_session_token_sha256` (hex of the presented 32-byte hash) — `identity.sessions` owner SELECT `USING (token_sha256 = decode(current_setting('app.pre_session_token_sha256', true), 'hex') OR previous_token_sha256 = decode(current_setting('app.pre_session_token_sha256', true), 'hex'))`; used by `app.identity_session_by_token`.
  - `app.pre_gotrue_session_id` — `identity.sessions` owner SELECT on `gotrue_session_id`; used by `app.identity_resolve_session`.
  - `app.pre_user_id` (GoTrue `sub`) — `core.memberships` / `core.users` owner SELECT `USING (user_id = / id = nullif(current_setting('app.pre_user_id', true), '')::uuid)`; used by `identity_login_context`, `identity_resolve_session`, `identity_user_exists` (which receives the `sub`; if it currently takes another key, change its input to the `sub`).
  - `app.pre_tenant_id` — set by the function **after** it has chosen the membership (A8.1); owner SELECT policies on `core.tenants` (`id = …`), `core.membership_roles`, `core.roles`, `identity.mfa_factors`, `identity.tenant_settings`, `identity.support_sessions` use `tenant_id = nullif(current_setting('app.pre_tenant_id', true), '')::uuid` (plus `user_id`/`membership_id` = the chosen ones where the table has them).
  - Each function resets its GUCs to `''` before returning. Callers (`lims_app`) cannot benefit from setting these GUCs because the policies are `TO lims_owner` only; a test asserts this.
- **A12.2 — Maintenance DEFINERs.** Cross-tenant maintenance functions set `set_config('app.maintenance', '<function name>', true)`; their owner policies are `USING (current_setting('app.maintenance', true) = '<function name>' AND <narrow predicate>)`. This replaces ad-hoc names (e.g. C7 `app.instruments_purge` becomes `app.maintenance = 'instruments_purge_messages'` style). Applies to `identity_purge_auth_events` (reads `identity.tenant_settings` retention for all tenants), and to C6, C7, C13, C15, C16 purge/expiry functions in the review fix pass.
- **A12.3 — `app.platform_list_tenants`.** C0 writes the SQL body: platform claims check `(SELECT app.is_platform_actor())`, owner SELECT on `core.tenants` gated by `app.maintenance = 'platform_list_tenants'`, returns non-PHI tenant columns only, keyset paging.
- **A12.4 — `app.purge_event_log`** takes no argument; the C0 02-TRD §7.6 call is corrected to match the 05-SCHEMA function.
- **A12.5 — Audit of platform rows.** `app.tg_row_audit` is **not** attached to `identity.platform_staff` or other platform-only tables; their changes are recorded in `identity.platform_events` by the C2 service/DEFINER. For `core.tenants`, `tg_row_audit` uses the row's own `id` as `tenant_id` when no tenant claim is present (platform context). Bootstrap CLI paths are covered by a test.
- **A12.6 — `app.identity_expire_invitations`** is rewritten as one `UPDATE … SET status = CASE … END` (no two CTEs updating the same table in one statement).
- **A12.7 — Tests.** For every function in A12.1–A12.3, a FORCE-RLS contract test proves (a) it returns the expected row, (b) a `lims_app` session that sets the same GUC directly sees nothing, (c) GUCs are empty after return.

## Addendum A13 (2026-11-06, lead acceptance of review batch 1 — C3–C7)
Source: `review/_triage-batch1.md` (109 BLOCKER/MAJOR/lead items verified: 109 confirmed). The lead **accepts P-1…P-15 and D-1…D-43 as written below**, with these modifications:
- **D-30:** the transaction-local GUC is `app.pre_portal_token_sha256` (A12.1 naming); policies are `TO lims_reporting_lookup` (the function owner) with the narrow USING clause; same FORCE-RLS tests as A12.7.
- **P-6 / D-42 / C7 purge:** maintenance DEFINERs use `app.maintenance = '<function name>'` (A12.2).
- **D-40:** build the default (instrument graphs stored as attachments and shown in the C7 viewer); reported to the founder as information, not a blocker.
- Every `[CONV]` value in A13 is accepted as a convention.
Per-chunk LOCAL fix lists and the MINOR findings stay in `review/_triage-batch1.md` §(c) and `review/<chunk>.md`.

### A13 (a) Program-wide rules P-1 … P-15

**P-1 — `common.validation_failed` is HTTP 400 only.** (C3 #1, C5 m#21)
Text for 02-CV §4.7 (new bullet): "`common.validation_failed` is always `400` (03-IC §8). A business rule with no registered code of its own is reported as `400 common.validation_failed` with a JSON-pointer path in `errors[]`. No document writes '422 common.validation_failed'; 422 is used only by codes registered with `http: 422`." No new code is registered.
Mechanical sweep (the same string, counted by grep): C3 PRD 9, TRD 7, AF 2, SEC 1; C4 PRD 1, AF 1; C5 PRD 4, TRD 1, SEC 1; C7 PRD 5, TRD 2. Outside this batch: C2, C10, C12, C13, C15, C16, C17 (for the batch-2 reviewers).

**P-2 — Stored files reach browsers only by streaming through the API.** (C4 #2, C7 #2)
Text for 02-CV §10.2, row "Serving uploads" (replaces the row): "Through an API `GET …/content` (or `…/file`) operation using the core streaming download helper (`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`; BFF proxies the stream). The object must be `clean`, otherwise `422 common.upload_quarantined`. Every call writes an `access_log` row. `ctx.storage.signedUrl` is internal to `services/{api,worker}` and never appears in a response, header or log (03-IC §13.6). Never inline on an app origin." Exception (I1) added by A17 D-67 (accepted risk; full text in D-67 and 02-CV §10.2): re-encoded `image/png` / `image/jpeg` objects may be streamed `inline` for `<img>` display with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: no-store`, access-logged.
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

### A13 (b) Decisions D-1 … D-43

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


## Addendum A14 (2026-11-06, lead follow-ups from the A13 program-doc apply)
- **A14.1** `BrandingAssetContent.kind` drops `'signature'` (D-26: signature images only via `getSignatories`).
- **A14.2** P-2 consequence for C1: `LIMS_ORIGIN_FILES` and the browser signed-URL download path are **removed** (no remaining user); C1 docs updated in its fix pass.
- **A14.3** Accepted [CONV]: route id `portal.payment_done` with auth `link_token+otp`; error title "Refund approver must differ from requester" for `billing.refund_self_approval_forbidden`.
- **A14.4** 08 §3 rows, §4.3 routes YAML (quote `{param}` paths), §4.9 (`v_pub_price_list_items`, D-19) and §4.14 (port text) are synchronised with 03 by the lead's follow-up edit; where they still differ, the newer addendum wins.

## Addendum A15 (2026-11-06, lead decisions on the A12 apply report)
- **A15.1 — Support sessions in pre-tenant resolve.** New GUC `app.pre_support_session_id`, set by `app.identity_resolve_session` from the session row's `support_session_id` before reading `identity.support_sessions`; owner SELECT branch `id = nullif(current_setting('app.pre_support_session_id', true), '')::uuid`. Reset before return.
- **A15.2 — Platform-staff MFA factors (tenant_id NULL).** `mfa_factors__select__owner_only` uses `user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid AND tenant_id IS NOT DISTINCT FROM nullif(current_setting('app.pre_tenant_id', true), '')::uuid`, so platform staff (no tenant) match their own factors.
- **A15.3 — All cross-tenant maintenance DEFINERs use `app.maintenance`** (A12.2), including C0 `app.purge_*` and C2 `identity_purge_sessions` / `identity_expire_*`; no static owner policies for maintenance remain.
- **A15.4 — Call signatures.** C0 02-TRD §7.6 calls `app.purge_event_inboxes()` and `app.purge_dead_letters()` with no arguments (same as A12.4).
- **A15.5 — `app.tg_row_audit` bug.** Use `coalesce(TG_ARGV::text[], '{}')` for the excluded-column list; INSERT records `new_row`, DELETE records `old_row`, UPDATE records changed columns. Schema test: a trigger with no arguments audits an UPDATE.
- **A15.6 — `app.is_platform_actor()` moves to C0.** C0 owns `db/` and `app.*` helpers; its DDL is created before any policy that references it, with `GRANT EXECUTE … TO lims_app` (and `lims_api`/`lims_worker` as the inventory lists). C2 docs reference it and keep its contract tests.

## Addendum A16 (2026-11-06, program-wide SQL correction found by testing)
- **A16.1 — Centre-scope predicate cast.** On PostgreSQL 16, `centre_id = ANY ((SELECT app.current_centre_ids()))` is parsed as a subquery comparison and fails with `operator does not exist: uuid = uuid[]`. Every policy uses **`centre_id = ANY ((SELECT app.current_centre_ids())::uuid[])`** (the `(SELECT …)` wrapper keeps the per-statement initplan; the cast makes it an array). This corrects the 02-CV §5.8 template and every chunk DDL; the final sweep greps for the uncast form and fails on any hit.
- **A16.2 — Accepted from the C7 fix pass:** CR-C7-013 (CI jobs incl. Windows runner, C0-0A) and CR-C7-014 (route `staff.lab.ingest_exceptions`, `/lab/ingest-exceptions`, owner C5, permission `lab.result.read`) — ACCEPT.

## Addendum A17 (2026-11-06, lead acceptance of review batch 2 — C8–C12, plus C5 fix-pass items)
Source: `review/_triage-batch2.md` (76 items verified: 74 confirmed, 2 already fixed). The lead **accepts P-16…P-23 and D-44…D-75 as written below**. Additional lead decisions:
- **A17.1 — Unknown patient age (C5 #39, CR-C5-012, clinical safety).** `RangeQuery.ageDays` becomes optional. When absent, C3 matches only reference-range and critical-limit rows with **no age restriction** (age bounds NULL). If such rows exist, flags and critical-value checks run normally. If none exist, C5 marks the result `range_unavailable_age_unknown`, it is **never auto-verified**, and the verification screen shows "Age unknown — reference range and critical check not applied". C4 registration keeps requiring date of birth or age (existing rule); this path is the exception.
- **A17.2 — D-5 refinement.** `processingStatus = 'not_started'` only when no specimen of the item is received **and** no result of the item is beyond `pending` (covers existing-material items). `removable = false` also when any result of the item is `resulted` or later, with `reasonCode: 'result_entered'`.
- **A17.3 — Accepted from the C5 fix pass:** `order_tests.reported_at` (set by the release consumer); late-recollection rule (re-open order tests cancelled with `specimen_rejected`, 409 if none); #14a body `{}`; CR-C5-010 (alert rules wiring), CR-C5-011 (bulk bodies `items[{id,version}]` allowed in 02-CV §4.1), CR-C5-012 (= A17.1) — ACCEPT.
- **A17.4 — A16.1 cast** applies in every chunk (C2, C4, C6, C10, C11, C13, C14, C16, C17 still carry the uncast form).

### A17 (a) Program-wide rules P-16 … P-23

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

### A17 (b) Decisions Decisions proposed (D-44 onward)

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


## Addendum A18 (2026-11-06, lead notes on the C4 fix pass)
- **A18.1** Staff-web CSP allows `img-src 'self' data:` so `PrintFrame` can show branding images embedded as base64 from `readBrandingAsset` (no remote image origins).
- **A18.2** Accepted [CONV] from C4: B21 requires `branch_id`; B10c `listRefundRequests` (approver inbox, `billing.refund.approve`); refund ledger row records the approver as collector and uses the approver's cash session; requester may withdraw via B10b; F26 logs `patient.search` with `mode: possible_duplicates`; `LIMS_BILLING_EXPORT_PDF_MAX_ROWS = 5000`; order "History" tab dropped in v1; `Quote.credit_status = {state: ok|locked|over_limit}`.

## Addendum A19 (2026-11-06, lead acceptance of review batch 3 — C13–C18)
Source: `review/_triage-batch3.md` (92 items verified: 90 confirmed, 2 partly confirmed). The lead **accepts P-40…P-46 and D-100…D-136 as written below**, plus:
- **A19.1 — Device actors on non-instruments tables (open item from D-109).** RLS keeps admitting `device` through `app.is_staff_or_system()` (C7 ingest handlers call Catalog/Lab ports in-process under device claims). The boundary is enforced above the database: a `staff_mobile`/`device` session can reach only `/v1/instruments/agent/*` routes (session-kind binding, 08 R10), and those handlers may call only the ports listed in C7 02-TRD. A C0 probe asserts that device claims get 401/403 on every non-agent route, and a C7 test asserts the agent handlers' port list. `smartreport.*` additionally excludes devices (D-109).
- **A19.2 — D-114 amends research/04 P4** (Khalti `Initiated` non-terminal until `expires_at` + grace, then hold + escalate). The lead applies the text to 04 now; F-08 (founder sign-off of program-level wording changes) gains this item.
- **A19.3 — D-115 replaces A11.1 bullet 4** (C15 calls `BillingPort.recordGatewayPayment` in its settle transaction; the C4 consumer of `payments.intent.settled.v1` is the idempotent safety net).
- **A19.4 — New client question C-06** (D-124): "Does the client have or plan its own patient/phlebotomy app? Default: the LIMS provider builds both (C16, C17)." Added to 07-BLOCKERS.

### A19 (a) Program-wide rules P-40 … P-46

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

### A19 (b) Decisions Decisions proposed

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


## Addendum A20 (2026-11-06, lead decisions on the A15 apply report; applied in the C0/C2 review fix pass)
- **A20.1** `app.identity_resolve_session` for a platform support session sets `app.pre_tenant_id` to the active support session's `support_tenant_id` before reading `core.tenants`, so `support_tenant_status` is filled; reset before return. Test 22 asserts it.
- **A20.2** `app.current_lims_session_id()` moves to C0 with `is_platform_actor()` (created before any reference) and gets `GRANT EXECUTE … TO lims_app, lims_api, lims_worker`.
- **A20.3** `app.enforce_mutable_columns()` uses `coalesce(TG_ARGV::text[], '{}')` like `tg_row_audit` (A15.5): with no arguments it allows nothing mutable and raises on any change; schema test added.
- **A20.4** `purge_ratelimit_counters` stays as is (table exempt from RLS by design, 02-CV §5.9).

## Addendum A21 (2026-11-06, lead decisions on the C6 fix pass)
- **A21.1 — Dues link under hold-till-paid (makes A11.1 reachable).** When a released report is held because the order has dues (hold-till-paid on), C6 sends the patient a **dues link** instead of nothing: a `portal_links` row with `purpose = 'dues'` [CONV column/value], same OTP flow, whose portal page shows only the balance, the pay button (A11.1) and "your report will be sent once payment is complete" — never report content. After `payments.intent.settled.v1` makes the order eligible and the report is released, the normal report notification goes out as today. Before C15 is live the dues page shows "pay at the counter" (A11.1 last bullet). Template `reporting.dues_due` (purpose `dues_reminder`, sms/whatsapp, params `amount_text` `short_text`, `lab_name` `short_text`) [CONV].
- **A21.2 — Signature images.** New system-only `IdentityPort.readSignatureImage(ctx: RequestContext, input: { membershipId: Uuidv7 }): Promise<BrandingAssetContent>` (caller: system actor holding `identity.signatory.read`; throws `common.not_found`). C6 render worker uses it; C2 implements (CR-C6-020).
- **A21.3 — Accepted from C6:** `report_versions.patient_id` / `partner_id` copies (avoid RLS recursion); `portal_links` conditional audit triggers instead of the default; `radiologist` += `reporting.report.read` roles; `reporting-inputs` path `{tenant_id}/instrument-sanitized/{yyyy}/{mm}/{sha256}.pdf`; D-31 CHECK extension and `failure_code`; portal payment [CONV]s (reuse `reporting.portal.view`, patient links only); CR-C6-019 (DOMPurify + server DOM, SMTP client — C0 pins versions after licence/no-egress check) ACCEPT.
- **A21.4 — GUC naming everywhere.** All pre-auth/lookup DEFINERs (incl. C6's `app.lookup_*`) use `app.pre_*` names and reset before return (A12.1 rule generalised).
- **A21.5 — Idempotency keys passed to ports** follow P-40's grammar `[A-Za-z0-9_-]` (C16 `'eng:'+id` must change, e.g. `eng_<uuid>`).

## Addendum A22 (2026-11-06, lead corrections and notes)
- **A22.0 — A21.5 withdrawn (lead error).** Port `idempotencyKey` inputs follow P-40 (`^[A-Za-z0-9_.:-]{1,200}$`, colons allowed); only the HTTP `Idempotency-Key` header uses `[A-Za-z0-9_-]{1,64}`. C16's `eng:<id>` keys are valid and need no change.
- **A22.1** C14 SR-02 history: the staff getSummary response includes `reviews[]` (action, actor display name, reason code, at) from `summary_reviews`; no new endpoint.
- **A22.2** 02-CV §8.5 item 1 (D-119) also allows the partner-admin port writes `IdentityPort.provisionPartnerMembership` / `updatePartnerMembership` (CR-C13-003).
- **A22.3** C15: `reconciliation_runs` / `reconciliation_findings` stay class C (5-year financial evidence, REQ-SEC-054) although `lims_app` updates run state/resolution — documented exception to P-18(a).
- **A22.4** C15 P-14: C15 defines the backing gauges it needs (e.g. `lims_payments_held_for_review_oldest_age_seconds`, `lims_payments_reconciliation_stalled_runs`) [CONV] and then the "Alert rules for C1" table; done in the final sweep.

## Addendum A23 (2026-11-06, lead decisions on the C0 review blockers)
- **A23.1 — Per-tenant cron fan-out.** At each tick the worker core reads `app.cron_tenant_ids()` (DEFINER, P-6), then for each tenant enqueues the job **inside `withTenantScope(tenantId, <module system actor>)`**, so `app.enqueue_job` sees matching tenant claims and never raises `job_tenant_mismatch`. `job_key = '<identifier>:<tenant_id>:<tick ISO minute>'` (P-6). C0 specifies `cron_tenant_ids` DDL (owner `lims_owner`, EXECUTE `lims_worker`, `SET search_path = ''`, owner policy on `core.tenants` gated by `app.maintenance = 'cron_tenant_ids'`, returns `status IN ('active','suspended')`).
- **A23.2 — Replay of tenant dead letters.** `ctx.core.deadLetters.replay` for a row with `tenant_id` re-enqueues inside `withTenantScope(row.tenant_id, <owning module's system actor from g_task_registry>)`; the platform actor never enqueues tenant jobs directly. Replay `job_key = '<original job_key or task_identifier:id>:replay:<dead_letter.version>'`; `core.dead_letters` gains `job_key text NULL` (copied at dead-lettering).
- **A23.3 — Non-staff writes to core/audit tables.** `core.event_log`, `core.idempotency_keys` and `audit.access_log` are marked `shared_with: [partner, portal, patient]` in `db/meta/tables.yaml`, with actor-specific policies: INSERT `WITH CHECK (tenant_id = app.current_tenant_id() AND actor_id = app.current_actor_id())`; `core.idempotency_keys` also SELECT/UPDATE on rows with `actor_id = app.current_actor_id()` (replay lookup). No non-staff SELECT on `event_log` or `access_log`. `core.tenants` and every other core table get the `is_staff_or_system()` guard (non-staff read tenant data only through `ctx.core` under a system actor).

## Addendum A24 (2026-11-06)
- **A24.1** New additive `CatalogPort.getPriceListStatus(ctx: RequestContext, input: { priceListId: Uuidv7 }): Promise<{ priceListId: Uuidv7; isActive: boolean; status: 'draft'|'published'|'superseded'|'retired' }>` (throws `common.not_found`); C3 implements; C16 is consumer (CR-C16-023, ACCEPT). Request handlers never read `v_pub_*` views (R25/P-21). If C3's price-list status set differs, C3's set wins and this signature follows it.

## Addendum A25 (2026-11-06, lead acceptance of review batch 4 — C0, C1, C2)
Source: `review/_triage-batch4.md` (79 items verified: 76 confirmed, 2 partly, 1 already fixed). The lead **accepts P-60, P-61 and D-200…D-220 as written below**, plus:
- **A25.1** D-207 (app-1 VM 8 vCPU / 32 GB) is built as the default and added to the founder list as **F-09** (cost confirmation), with the stated fallback if refused.
- **A25.2** D-218 / D-219 are release preconditions verified in C2 T1 (GoTrue checks), not blockers to building.
- **A25.3** The per-chunk work lists in `review/_triage-batch4.md` §(c)–(e) and the final-sweep lists §(f)–(g) are binding work orders.

### A25 (a) Program-wide rules P-60, P-61

**P-60 — Every chunk records each addendum as applied or not applicable.** (C0 #29)
Text for 05-DEFINITION-OF-DONE (new item) and 01-CM §4 "Must": "Each chunk's 02-TRD change-history table has one row per 08 Addendum (A1 onward). The row is either 'applied <date> — <P-/D-/A-items that touch this chunk, with the files changed>' or 'not applicable'. A chunk whose table stops before the latest addendum is not 'done'. The final sweep checks this by script (every chunk × every addendum id)."
Why: C0's table (02-TRD §17) stops at A15. That hid 23 unapplied rules behind documents that agents read as current. No other mechanism catches this.

**P-61 — The client IP comes from the trusted edge only.** (C2 #25; refines A13 D-32 / 08 R10 BFF-key paragraph)
Text for 08 R10 item 1 (replaces the sentence "The core sets `app.client_ip` from that header only on requests with a valid BFF key; otherwise it uses the peer address") and 02-CV §10.3: "The core sets `app.client_ip` from `X-Forwarded-For` (single hop; nginx overwrites it, C1 TRD §6.6) only when (a) the request carries a valid `X-Lims-Bff-Key`, or (b) the TCP peer address is in `LIMS_CORE_TRUSTED_PROXY_CIDRS` [CONV; C1 sets it to the nginx container address on `edge_net`]. Otherwise the core uses the peer address. Module code reads only `ctx.clientIp`; it never parses a header."
Why: `openMobileSession`, `refreshMobileSession` and the patient routes are `x-edge-exposure: public` and have no BFF. Under D-32 as written, their peer is nginx, so every phone in every tenant would share one A1 per-IP failure counter. A1's placement rule ("client IP as seen at the public edge") already requires (b). No new secret and no new header are added.

---

### A25 (b) Decisions Decisions

**D-200 — Running the core retention purge.** Refs: C0 #20, C0 lead 5.
- Problem: `statement_timeout` defaults to 5000 ms (C0 TRD l.557). `core.retention_purge` (l.789) declares no `taskOptions`, and the five purge functions loop for up to 5 minutes. Each `SELECT app.purge_*()` is therefore cancelled with `57014`.
- Decision (no new manifest feature; it uses the existing CR-C8-012 `taskOptions`):
  - `core.retention_purge` declares `taskOptions: { statementTimeoutMs: 300000 }`.
  - It calls each purge function in **its own transaction**.
  - The loop cap inside each function is `clock_timestamp() - now() > interval '4 minutes'`, which stays under the 300 s ceiling.
  - A function that hits its cap returns its count, and the next day's run continues. A metric `lims_core_retention_purge_capped_total{table}` [CONV] records it, and C1 alerts when it is > 0 for 3 days in a row.
  - New test: a 10k-row expired seed per table completes, and a capped run resumes.
- Files: C0 TRD §7.2/§7.6, 05-SCHEMA §10 purge bodies, 06 T0D-09, C1 alert intake.

**D-201 — No standing CREATE for queue and lookup owners.** Refs: C0 #21, C0 lead 4.
- Problem (confirmed): `GRANT lims_queue TO lims_worker WITH INHERIT TRUE` (C0 SCH l.54), together with `GRANT CREATE ON DATABASE … TO lims_owner, lims_queue` (l.65) and `GRANT CREATE ON SCHEMA app TO lims_queue, lims_reporting_lookup` (l.115), gives `lims_worker` CREATE on the database and on `app`.
- Decision:
  - The migration that creates `lims_queue`- or `lims_reporting_lookup`-owned objects does `GRANT CREATE … TO <role>` → `SET ROLE <role>` → create → `RESET ROLE` → `REVOKE CREATE … FROM <role>`, all in the same migration file. No standing CREATE remains. (PostgreSQL also needs CREATE on the schema for `ALTER … OWNER TO`, so "create as owner, then ALTER OWNER" does not avoid the grant.)
  - The `graphile_worker` schema is installed by the migration runner in the same grant/revoke window. If SP-2 shows that Graphile Worker must run its own migrations at worker start, C0 records that residual privilege as the SP-2 outcome in `DECISIONS.md` and in 07 §6. It is not silently kept.
  - Role tests: `has_database_privilege('lims_worker', current_database(), 'CREATE') = false`; `has_schema_privilege('lims_worker','app','CREATE') = false`; the same for `lims_api`.
- Files: C0 05-SCHEMA §1/§2, 06 SP-2/T0B-02, 07 §6.

**D-202 — Idempotency keys are not stored for 4xx.** Refs: C0 #30, C0 lead 6.
- Status < 400: the response is stored and replayed (K2).
- Status ≥ 400: the response is not stored. The `in_progress` row goes with the rollback. When the handler called `ctx.commitOnError()` (P-42), the core deletes the key row in the same transaction before commit.
- A retry with the same key re-runs the handler. For P-42 security counters, this means a retried wrong password counts again, which is the intended behaviour.
- Edits: C0 TRD §6.6 steps 4–5 ("for status < 400"), §6.2 stage 10, APP-FLOW K2/K3, AC-0D-4.5, plus one test for each branch (4xx rollback, 4xx `commitOnError`, 5xx).

**D-203 — Container networks that need the database or SMTP.** Refs: C1 #1, C1 lead 3.
- Problem (confirmed): `app_net`, `auth_net` and `render_net` are `internal: true` (C1 TRD §3.2). The worker (`app_net`, `render_net`), `auth`, `rest` and `storage` must reach `data-1:5432` on another VM. GoTrue must reach its SMTP relay. `edge_net` is a normal bridge, so api/web/portal have an unfiltered route out.
- Decision (no host networking):
  - (1) New non-internal bridge `db_net`. Members: api-a/b, worker-a/b, auth, rest, storage. `DOCKER-USER` allows forwarding from `db_net` only to the data-1 wg IP on 5432/6432, and to the dr-1 wg IP on the same ports after failover (inventory variable). Everything else from `db_net` is dropped.
  - (2) `DOCKER-USER` drops all forwarded traffic from `edge_net` except to and from the nginx container.
  - (3) GoTrue SMTP: an nftables allow from the `auth` container IP to the relay FQDN:587 only, listed in `infra/edge/egress-allowlist.yaml`. Squid cannot proxy SMTP, and an ops-1 smarthost would add a new service. This is the transactional relay C1 §7.3 already names (REQ-ARCH-018), so it adds no new touchpoint. It must appear in the F-01 egress register.
  - Update §3.2 table, §5.5, AC-09.1, `egress_probe.sh`, and the T-05 fallback text.

**D-204 — `pdf-sandbox` is owned and built by C6.** Refs: C1 #3, C1 lead 1.
- 08 A13 P-13 (binding) names "the renderer's `/internal/sanitize`". C6 TRD l.78/195/457 builds the sandbox as an HTTP service from `services/renderer`, and 01-CM §3 gives `services/renderer` to C6. C1's spool and `network_mode: none` design contradicts this.
- Decision:
  - C6 owns the image and its HTTP interface.
  - C1 provides only the runtime envelope: network `render_net` only, inbound from the worker only, no egress; non-root; `read_only`; `tmpfs /work`; 1 CPU / 512 MiB; `pids_limit: 64`; its inbound auth token as the only secret; health check = C6 `GET /internal/health`.
  - The 08 §3 row CR-C1-005 Notes gain: "spool contract (C1 TRD §7.5) superseded by CR-C6-013 / A13 P-13 (batch-4 D-204); envelope part stands".
  - C1 deletes §1 `images/pdf-sandbox`, §7.5, AF §14, AC-10.2, the T-16 image work and the `lims_ops_pdf_sandbox_*` metrics.

**D-205 — RPO parameters.** Refs: C1 #4, C1 lead 5.
- One set everywhere:
  - `archive_timeout = 60s` (config `archive_timeout_s: 60`).
  - Metric `lims_ops_wal_repo2_newest_age_seconds` = now − time of the newest WAL segment in repo2 (from `pgbackrest info --output=json`). It is no longer measured from the `check` completion time.
  - `WalArchiveLagging` > 600 s (warn).
  - `RpoAtRisk` > 840 s (page; one minute before the 04 I2 15-minute RPO).
  - `WalArchiveFailing` = 2 failed checks in a row (page).
- `RpoBreached` and the 1200 s threshold are deleted. The WAL-volume arithmetic in TRD §9.4 is redone for 60 s switching (1,440 forced segments/day worst case + 96 `check` switches), and C1 PLAN R8 tracks it.
- Files: C1 PRD AC-12.1/12.2, TRD §7.7/§9.4/§11.3/§15, AF §3.1, UI D1/§8.

**D-206 — `X-Lims-Background` at the edge.** Refs: C1 #5, C1 lead 10.
- The header can only make the BFF call `resolveSession` with `touch: false`. Spoofing it only shortens the sender's own session.
- Decision: nginx **passes it through unchanged** on the staff_web, partner and portal origins (BFF origins; C13 AF l.181 and C16 UI l.229 set it in the browser). It keeps stripping it on the api origin.
- C2 resolves its own inconsistency (TRD l.124 "set by C0's BFF proxy" vs l.676 "the browser request carries"): the browser sets it through the `@lims/ui` polling/SSE helpers, and the BFF maps it to `touch: false`.
- C1 rewrites §6.6, AF §1.5 row 2 and SEC AB-14 ("can only reduce touching; not stripped on BFF origins").

**D-207 — app-1 memory.** Refs: C1 #14, C1 lead 9.
- Confirmed: Σ `mem_limit` = 16.8 GiB on a 16 GB VM before Supabase services, exporters and the OS.
- research/04 I1 labels the sizing "DECISION (sizing = assumptions)". Default to build: **CR to research/04 I1: VM-2 app = 8 vCPU / 32 GB.** This keeps clamd next to the uploads (no PHI scan traffic to site B, and scanning keeps working during a site-B outage).
- `container_hardening.py` asserts Σ `mem_limit` ≤ 85 % of host RAM.
- Founder confirmation is needed because of the cost; this is added to the F-08 list. If refused, the fallback is to lower api/worker to 1.5 GiB each and move Squid (0.5 GiB) to ops-1. That still has to pass the 85 % test with Supabase services counted, or the stack is not deployable.

**D-208 — One Supabase snapshot pin.** Refs: C1 #16, C1 lead 4.
- `infra/compose/supabase/upstream/UPSTREAM.lock` (C1) is the single source of image digests.
- C0's dev stack (`tools/devstack/compose.yaml`) reads them from it, and a CI check (C0-0A, wired per P-14) fails when the digests differ.
- SP-1 records the lock commit it ran against.
- Files: C0 TRD §3 devstack row (CR from C0's side, ACCEPT), 01-CM §3 note (C0 reads a C1 file; ownership unchanged), C1 TRD §2/§7.1.

**D-209 — Scanner address.** Refs: C1 #17.
- `clamd` listens on `3310` on `app_net` with `StreamMaxLength 20M` and `MaxFileSize 20M` (above the 16 MB attachment route).
- C0-0D adds config keys `LIMS_CORE_SCANNER_URL` (default `tcp://clamd:3310`) and `LIMS_CORE_SCANNER_TIMEOUT_MS` (default 30000) [CONV]. C1 sets them. The protocol is INSTREAM.
- C1 fixes the PRD §8 reference (§7.6 → §7.4).
- Files: C0 TRD §11, C1 TRD §7.4/§15, 08 §4.11 row.

**D-210 — Degraded mode after DR promotion.** Refs: C1 #18, C1 lead 6.
- Promotion to dr-1 leaves no second-site WAL archive (04 I2) and no separate-host audit store (04 D11).
- Decision:
  - (a) Within 4 h of promotion [CONV], `dr-promote.yml` creates a pgBackRest repo on ops-1. That is a different host on the same site, and only an interim measure.
  - (b) A new alert `NoOffsiteArchive` (page) fires until a repo on a site other than dr-1's site is configured.
  - (c) The incident record names the period.
  - (d) PRD AC-22.1 states the degraded mode explicitly: RPO holds against host loss, but not against site-B loss.
- No new site is ordered here. A third site stays a B12 procurement item.

**D-211 — `lims-scan` jail removed.** Refs: C1 #19, C1 lead 7.
- Same reasoning as 08 A1/A3.2: a 404-count ban hits a lab's shared NAT, and with C1 #2 it would ban every lab with a bridge agent.
- The edge is already default-deny.
- Decision: delete the `lims-scan` jail. Replace it with warn alert `EdgeNotFoundSpike` (404 rate per IP above 30/5 min for 15 min; no ban) [CONV].
- New AC mirroring AC-04.6: 30 agent 404s in 5 min from one IP → no ban.

**D-212 — Transactions for pre-auth and session operations.** Refs: C2 #1, C2 lead 1.
- Problem (confirmed): C0 TRD l.453 gives public operations no transaction except `anonymousTx()` (reporting only). `withTenantScope` is platform-only (R10.4). The `__own` INSERT policy needs a session id that does not exist yet. The bffSession operations have neither `x-permission` nor `x-public` (C2 TRD l.151–157).
- Decision (one core API, bounded by an allowlist):
  - New `ctx.db.identityAuthTx(fn)`. It exists only for module `identity` operations tagged `x-context: identity_auth` and listed in core config.
  - The list: `loginStaff`, `loginPartner`, `openMobileSession`, `refreshMobileSession`, `logoutMobileSession`, `confirmEmailToken`, `requestPasswordRecovery`, `verifyMfaChallenge`, `startMfaEnrolment`, `completeMfaEnrolment`, `resolveSession`, `logoutSession`, `setPasswordFromSetup`, `resolvePatientSession`, `logoutPatientSession`.
  - It opens the request transaction with claims `{sub: <identity system actor>, actor_type: 'system'}` and **no** `tenant_id`. Only the inventoried DEFINERs and the tenant-less `auth_events` insert work in that state.
  - `tx.bindTenant(tenantId)` may be called **once**, after a DEFINER (`identity_login_context` / `identity_session_by_token` / `identity_resolve_session`) has chosen the membership. It rewrites the transaction-local claims to `{…, tenant_id}`, so the ordinary `__tenant` policies (with the P-16 guard, which admits system) apply.
  - The C0 authz guard (stage 9) exempts `x-context: identity_auth`. Every listed operation carries `x-public` with a justification.
  - The `__own` session INSERT policy is not used by these paths. C2 SCH §5.2 states which policy admits each pre-auth write.
  - Least-privilege bound: only the listed operationIds, only the identity system actor, at most one tenant per transaction, and an access-log or auth event on every success path (existing C2 events).
- Files: C0 TRD §6.2 stage 7/9, §6.3, 08 §4.11 and R10 item 4, 02-CV §6; C2 TRD §5.1, SCH §5.2; AC in C0 T0D-03 and C2 T6.

**D-213 — Idempotency for platform-context operations.** Refs: C2 #17, C2 lead 2.
- Keeps P-8 for `provisionTenant`, `openSupportSession` and `invitePlatformStaff`.
- `core.idempotency_keys.tenant_id` becomes NULLable. `PRIMARY KEY (tenant_id, actor_id, key)` is replaced by `CONSTRAINT idempotency_keys__tenant_id_actor_id_key__uq UNIQUE NULLS NOT DISTINCT (tenant_id, actor_id, key)` (PostgreSQL ≥ 15; the target is 17).
- New policies `idempotency_keys__{select,insert,update}__platform TO lims_app USING / WITH CHECK (tenant_id IS NULL AND actor_id = (SELECT app.current_actor_id()) AND (SELECT app.is_platform_actor()))`.
- The purge predicate (`expires_at`) already covers NULL-tenant rows.
- 03-IC §12 row and 08 §4.11 note. C0 schema test: the same key from two platform actors makes two rows, and the same actor and key replays.

**D-214 — `withTenantScope` allowlist (08 R10 item 4).** Refs: C2 #18, C2 lead 3; also records A23.1/A23.2.
- New R10 item 4 list: the existing eight operationIds (the void `setTenantEgressIps` entry is struck, per A1) plus `openSupportSession`, `activateSupportSession`, `endSupportSession`, `revokeSupportSession` (only where C2 TRD §5.10 runs them in platform context) and `getDeadLetter`.
- Each use writes a tenant access-log row. The codes already exist in the C0 seed: `support_session.open` / `.activate` / `.close` / `.revoke`, `dead_letter.view`.
- New sentence: "Core-internal uses outside module `identity`: the worker-core cron fan-out (A23.1) and `ctx.core.deadLetters.replay` of a tenant row (A23.2), each under the owning module's system actor. No module code calls `withTenantScope`."
- Files: 08 R10, C0 core config and TRD §6.3, C2 AF §8/§9.3.

**D-215 — Audit of NULL-tenant rows in mixed tables.** Refs: C2 #19, C2 lead 4.
- Extends A12.5 without splitting tables.
- `app.tg_row_audit` writes **no** `audit_log` row when the row's `tenant_id` is NULL **and** the table is not `core.tenants`. It never raises for this case.
- C2 writes `identity.platform_events` for these changes. The existing kinds `platform_staff_invited`, `platform_mfa_reset` and `annex_1_changed` stay; C2 adds `platform_mfa_enrolled` to its kind CHECK.
- Tests: C0 schema test (NULL-tenant UPDATE → 0 `audit_log` rows), C2 SCH §11 (one `platform_events` row).
- Files: C0 05-SCHEMA `tg_row_audit`, C2 SCH §3.1/§4.x/§11.

**D-216 — Annex readiness reads the platform Annex 1 row.** Refs: C2 #20, C2 lead 8.
- Least surface: a policy, with no new column and no allowlist growth.
- `CREATE POLICY ird_annex_records__select__tenant_platform_ref ON identity.ird_annex_records FOR SELECT TO lims_app USING (tenant_id IS NULL AND annex_code = 'annex_1' AND id = (SELECT ts.ird_annex_1_record_id FROM identity.tenant_settings ts WHERE ts.tenant_id = (SELECT app.current_tenant_id())) AND (SELECT app.is_staff_or_system()));`
- SCH §11 test 2 is amended: only the referenced Annex 1 row is visible, and no other platform row is.

**D-217 — A1 "alert the tenant admins of every targeted tenant".** Refs: C2 #23, C2 lead 5.
- A1 is a founder decision, so it is implemented, not narrowed.
- (1) C0 adds `core.users.email_hmac bytea NULL CHECK (octet_length = 32)`. C2 writes it on user create and on email change with the existing `LIMS_IDENTITY_EMAIL_HMAC_KEY`.
- (2) New DEFINER `app.identity_tenants_for_email_hmacs(p_hmacs bytea[]) RETURNS SETOF uuid`:
  - owner `lims_owner`, EXECUTE `lims_worker` only, `SET search_path = ''`;
  - at most 100 values;
  - owner policy `users__select__owner_only` ORed with `current_setting('app.maintenance', true) = 'identity_tenants_for_email_hmacs' AND email_hmac IS NOT NULL` (A12.2);
  - inventory row and A12.7 tests.
- (3) Worker task `identity.notify_ip_throttle` (platform, enqueued when the throttle fires). It collects the `email_hmac` values of that IP's failure window from `auth_events`, resolves the tenants, and for each tenant inserts `admin_notices` (kind `login_ip_throttled`, `subject_id` NULL) under `withTenantScope(tenant, identity system actor)`.
- (4) `admin_notices.subject_id` becomes NULLable for this kind only (CHECK).
- No HTTP response can observe the mapping, so there is no oracle. The LIMS provider on-call is alerted as before.

**D-218 — Patient session kind against GoTrue.** Refs: C2 #24, C2 lead 6.
- No R10 change now.
- C2 TRD §8 lists, as UNVERIFIED T1 items: `adminCreateUser` without email, and an admin path that issues a session/access JWT for a credential-less user.
- Default: "patient session kind blocked until T1 confirms". If T1 refutes both, a CR to 08 R10 for a LIMS-issued patient access JWT goes to the lead and founder (it touches 04 A5/A7).
- C16 build continues against the fake resolver (as R10 item 6 does for SP-1).

**D-219 — Recovery-link TTL fallback.** Refs: C2 #26, C2 lead 9.
- The `recovery_issued_at` fallback is deleted (it has no storage).
- "GoTrue recovery/invite TTL configurable to ≤ 60 min (04 A12)" becomes a C2 T1 verification and a **release precondition**. If T1 refutes it, a CR adds `identity.recovery_requests` (class E) before release.
- C2 PRD §10, AF §3.7 note and TRD §10 follow. C1 §7.3 keeps the UNVERIFIED label.

**D-220 — Re-inviting someone who was staff at another lab.** Refs: C2 #57, C2 lead 10.
- Client and product question. Least surface in v1: the current restriction (`identity.user_exists`) stays.
- It is recorded as client question C-07 in 08 §5.2: "May a person deactivated at one lab be invited by another lab with the same e-mail? Default: no in v1."
- C2 PRD §11 Q5 cites it.

---


## Addendum A26 (2026-11-06, lead decisions on the program-doc sweep)
- **A26.1** `IdentityPort.readSignatureImage` returns a new type `SignatureImageContent { membershipId: Uuidv7; contentBase64: string; mimeType: 'image/png' | 'image/jpeg'; sha256: string }` (not `BrandingAssetContent`).
- **A26.2** The 02-CV §5.8 example policy SQL includes `AND (SELECT app.is_staff_or_system())` (P-16) in its `__tenant` template.
- **A26.3** 03 §4.5 LabPort consumer heading drops C9 (C9 TRD: C9 does not call LabPort); 01-CM §6 adds C6→C14 `p` (SmartReportPort), C4→C16 `p` and C17→C16 `p` (EngagementPort); 03 §13.6 `BucketName` union adds `partners-slips`; 08 heading count reads "244 change requests" (recount if changed).
- **A26.4** Repo-wide greps for superseded forms ignore addendum text that quotes the old form and the archive files `program/_cr-extract.md` and `program/_apply-plan.md` (history).

## Addendum A27 (2026-11-06, lead decisions on the C1 fix pass)
- **A27.1 — app-1 memory.** The D-207 16 GB fallback sums to 19.25 GiB and fails its own 85 % test, so it is withdrawn. **32 GB is required** for the specified stack; F-09 is reworded: "confirm the 32 GB app VM cost (16 GB is not deployable as specified)".
- **A27.2 — `lims-ratelimit` jail.** Like A3.2 for login, the jail never counts `agent`-zone (or `otp`/`psession`) rejections; those zones are shared-NAT traffic handled by app tiers. C1 AC tests run from distinct source IPs or with the jail disabled in the test profile.
- **A27.3 — Renderer metrics.** Prometheus stays off `render_net`. The C6 worker that calls the renderer reads `/internal/metrics` over `render_net` each scrape cycle and re-exports the renderer counters under its own `/metrics`; renderer/pdf-sandbox liveness uses `lims_ops_container_health`. C6 names the sandbox inbound-token key `LIMS_RENDER_SANDBOX_TOKEN_FILE` [CONV].
- **A27.4 — DR storage risk.** Worst-case WAL ≈ 840 GiB over 35 days vs dr-1 1 TB: added to the founder list as **F-10** ("DR site storage may need 2 TB; confirmed by the T-09 measurement before go-live").
- **A27.5 — Accepted:** C1 spacing-exact rate-limit ACs; EDB-hosted pgBackRest docs as a secondary source (UNVERIFIED until T-09 re-checks 2.60); C1 [CONV] network/IP choices.

## Addendum A28 (2026-11-06, lead decisions on the C2 fix pass)
- **A28.1 — Platform-staff writes.** During authentication (before a platform session exists) platform-staff session, MFA-factor and invitation writes go through C2 DEFINERs `app.identity_platform_auth_write_*` [CONV names] whose owner policies match `tenant_id IS NULL AND user_id = nullif(current_setting('app.pre_user_id', true), '')::uuid` (A12.1 pattern; GUC reset before return). After login, platform writes use `__platform` policies `USING/WITH CHECK (tenant_id IS NULL AND (SELECT app.is_platform_actor()))`. Platform login is unblocked by this.
- **A28.2 — Patient-context IdentityPort writes** (`provisionPatientMembership`, `openPatientSession`, `revokePatientSessions`) execute inside `withTenantScope(ctx.tenantId, <identity system actor>)` (added to the R10 item-4 allowlist); the patient actor never writes identity tables directly. Still gated by D-218 (T1).
- **A28.3 — Partner role.** C0 adds `core.memberships.partner_role text NULL` with `CHECK ((actor_type = 'partner') = (partner_role IS NOT NULL))` and `CHECK (partner_role IN ('partner_admin','partner_member'))`; C2 reads it.
- **A28.4 — `identity.notify_ip_throttle`** reads tenant-less `auth_events` via an owner policy gated by `app.maintenance = 'identity_notify_ip_throttle'` (DEFINER, A12.2 pattern).
- **A28.5 — Audit inside maintenance DEFINERs.** `app.tg_row_audit` with no claims but `app.maintenance` set records `actor_type = 'system'`, `actor_id = NULL`, `detail.maintenance = <function name>`, and uses the row's `tenant_id` (or the row's own id for `core.tenants`); it raises `audit_context_missing` only when neither claims nor `app.maintenance` are present. Fixes `identity_expire_invitations` / `identity_expire_support_sessions`.
- **A28.6 — Accepted:** IRD document re-scan on download, logged in `platform_events`; `sessions__update__own_user`; contract cases C2-1…C2-10; CR-C2-019 ACCEPT; `ird_annex_documents` class M; `sessions`/`mfa_factors` `shared_with: [partner]`; C0 indexes on audit/access log `(tenant_id, request_id)` and partial `(tenant_id, support_session_id, occurred_at DESC)`; C0 audit SELECT policies add the CR-C2-010 centre clause (cast form); `auth_events__occurred_at__idx` index exception.

## Addendum A29 (2026-11-06, lead decisions on the C0 fix pass)
- **A29.1 — Seeds under FORCE RLS.** Global `g_*` seeds run as the migration owner (no RLS on G tables). Tenant-row seeds (fixtures, demo tenants, per-tenant defaults) run as `lims_app` inside `withTenantScope(tenantId, <owning module's system actor>)`, never as `lims_owner`.
- **A29.2 — Accepted [CONV] from C0:** `__portal` policy scope (added to the 02-CV §5.8 list); non-staff/platform DELETE of their own `in_progress` idempotency key; `actor_type` bound in each actor policy; `event_log.created_by` as the actor column; `audit_log.detail` and nullable `actor_id`/`created_by` (A28.5); purge return `(deleted, capped)`; `job_key` 1–400 chars; `BranchRow`/`CentreRow` shapes; the other C0 [CONV] names. The `ALTER DEFAULT PRIVILEGES` fix (each role runs its own) is accepted.

## Addendum A30 (2026-11-06, final-check decisions)
- **A30.1 — Helper-function migration stage.** Every `app.*` helper used inside RLS policies (C0's, and module-requested ones such as `app.current_partner_id()` (C13) and `app.engagement_patient_ids()` (C16)) is created in C0's early "helpers" migration stage, before any module's tables/policies. Bodies that read module tables are created with `check_function_bodies = off` in that stage. C0 05-SCHEMA records the stage order.
- **A30.2 — `event_inbox` tables** are generated by C0 only (C0 §3.9); a module 05-SCHEMA never creates its own (C10 removes its `micro.event_inbox` DDL and points to C0).
- **A30.3 — C4 chronology guard** stays SECURITY INVOKER as specified; whole-series integrity relies on counter equality, the unique key and the nightly `integrity_check` (accepted as documented).

## Addendum A31 (2026-11-06, last design items from the smoke load)
- **A31.1** C0 bootstrap installs `pg_trgm` and `btree_gin` in schema `extensions`, grants `USAGE ON SCHEMA extensions` to `lims_owner` and `lims_migrator`, and migrations reference operator classes schema-qualified (`extensions.gin_trgm_ops`). `btree_gin` availability in the Supabase Postgres image stays an SP-3 check.
- **A31.2** C16 writes full DDL + RLS for `engagement.cs_reminder_reasons` and `engagement.cs_enquiry_categories` (same shape as its other `cs_*` tables).
- **A31.3** C11 example `cases` policies include `(SELECT app.is_staff_or_system())` (P-16).
- **A31.4** C0 §3.9 drops `catalog` from the `event_inbox` list (C3 consumes no events).

## Addendum A32 — reserved: universal patient app (client answer C-06)

One patient app for all labs, sold as a package (no referral commissions; patient-to-patient referral not in v1). The C16 change pass is written here once the client confirms U-1…U-4; until then C16 builds as specified.

## Addendum A33 — Production readiness gaps (2026-11-07)

Source: production-readiness review against the Plan E checklist (LIMS Production Readiness Checklist doc). Binding wording per task lives in `C:\LIMS-state\lead-decisions-<chunk>.md` (LD-24…LD-29); summary:

- **A33-1 Error tracking (C1 T-18, C0 T0D-14/T0D-15, C16 T-A1, C17 HC-T21):** self-hosted GlitchTip (Sentry-protocol) in Nepal; web + Flutter SDKs with the shared PHI scrubber in beforeSend; disabled when no DSN.
- **A33-2 Downtime mode (C4 FD-T06/FD-T13/BL-T06, C5 T-07/T-14/T-20):** `entry_mode` live | downtime_backentry with `occurred_at` (≤ now, ≥ now − tenant `downtime_backentry_max_hours`, default 72) and `downtime_ref`; audited and labelled "Entered after downtime"; invoices issued at back-entry time; manual-bill tax treatment UNVERIFIED (accountant).
- **A33-3 Training tenant (C2 T16/T22, C4 BL-T14, C6 C6-T07/C6-T19, C15 PG-T01):** `tenant.training_mode` set at provisioning only; no CBMS, `TRN-` invoice prefix, TRAINING watermark, recording notification adapter, sandbox gateways only.
- **A33-4 Signatory council (C2 T16, C6 C6-T07/C6-T09):** signatory `council` NMC | NHPC + `registration_no`; footer prints "<council> No.".
- **A33-5 App legal links (C16 T-A4/T-AC1/T-DOC1, C17 HC-T29):** privacy policy + terms links on first run and in about/account; URLs from platform config, required in production builds.
- **A33-6 Contract acceptance (C2 T22):** append-only record of ToS and DPA versions accepted per tenant; provisioning requires both.

## Addendum A34 — Lean hosting profile for launch (2026-11-07, owner decision)

Owner: the 4-VM production topology (~NPR 60k/month) is too costly before revenue. C1 builds two inventory profiles: `lean` (default until a scale trigger) and `full` (02-TRD §3.1 as written). `lean` = prod-1 (16 vCPU / 32 GB / ~640 GB NVMe, site A, all app/data/ops roles) + backup-1 (4 vCPU / 8 GB / >=160 GB, site B, different provider: WAL archive + base backups (RPO <= 15 min), object replica, audit digests, external uptime check + alert relay). No hot standby: DR = restore to a new VM, RTO <= 4 h, rehearsed monthly. Audit store = separate `lims_audit` database in the same cluster with off-host digests. Scale to `full` when: peak CPU > 60 % or RAM > 80 % for 7 days, DB > 150 GB, or a second lab group signs. Encryption, off-site WAL and the restore drill are never cut. Binding wording: `C:\LIMS-state\lead-decisions-C1-infrastructure-ops.md` LD-45.

## Addendum A35 — Patient session access token is issued by LIMS, not GoTrue (2026-11-09, founder decision; resolves D-218)

Source: C2 T1 live probes against GoTrue v2.197.0 (`services/api/src/modules/identity/gotrue/mapping.md`, CR-C2-T1-a): `POST /admin/users` with no email or phone returns 400, and no admin route issues a session or access JWT for a user, so both D-218 routes (A: create a user without email, B: credential-less session) are refuted. This addendum is the CR to R10 that D-218 reserved for the lead and the founder. Binding wording per task: `C:\LIMS-state\lead-decisions.md` LD-80.

- **A35-1 Decision.** For session kind `patient` (R10 item 3) the short access JWT (≤ 1 h, 04 A5) is issued by the LIMS core, not by GoTrue; patient sessions no longer depend on a GoTrue user or session. Staff, platform, partner and `staff_mobile` sessions are unchanged. The app keeps the opaque 256-bit LIMS session token; `POST …/refresh` rotates it, a reused old token revokes the session (R10 item 3), and every refresh issues a new access JWT. There are no GoTrue refresh tokens for patient sessions.
- **A35-2 Signing and verification.** EdDSA (Ed25519). The private key is a file-mounted secret from the C1 secret store, handled like the BFF keys (R10 item 1, A19 P-45): never in the repository, an environment value, a log or a browser. The patient token has its own issuer and its own audience, different from GoTrue's. The core verifier applies 04 A7 unchanged (pinned algorithm, reject `none` and substitution, check exp, aud and iss, 0 s leeway, no grace) per issuer: the patient endpoint family accepts only the patient issuer and every other family accepts only GoTrue's, so a patient token can never pass the staff verifier and the reverse. A token of one issuer presented on the other family → `401 auth.session_expired` (R10 item 3).
- **A35-3 Claims.** As R10 item 2: the core trusts only `sub`, `session_id`, `aal`, `exp` and `iat` from the token (plus `iss` and `aud` for verification) and ignores every other claim. Claims reach `request.jwt.claims` only through the identity `claimsResolver`, resolved as for `patient` in R10 item 3 (`{sub, tenant_id, membership_id, actor_type:'patient', aal:'aal1', lims_session_id, session_state:'active'}`).
- **A35-4 Email.** A patient email is not part of this design. It is added later as an additional contact channel and changes nothing above.
- **A35-5 Resolved (2026-11-09, founder accepted the lead recommendation).** (a) **Session lookup:** `sub` is the patient's `core.users.id`, generated by LIMS (that column has no FK into `auth`, C2 05-SCHEMA `core.users` row); the `session_id` claim is `identity.sessions.id` (= `lims_session_id`). For `kind = 'patient'` the columns `gotrue_session_id`, `refresh_token_enc`, `access_token_enc` and `enc_key_id` are NULL; for every other kind they stay NOT NULL (one CHECK ties the two). One sibling DEFINER lookup keyed on `(id, sub)` mirrors `app.identity_resolve_session`, with its own `app.pre_*` setting and `owner_only` policy branch; the isolation registry and the pgTAP tests change with it. No invented value is ever stored in `gotrue_session_id`. (b) **`iss` and `aud`:** fixed constants in code, not per-environment config: `iss` = `urn:lims:identity:patient`, `aud` = `urn:lims:api:patient`. The patient verifier pins `EdDSA`; `LIMS_CORE_JWT_ALG` stays for GoTrue only. (c) **Keys:** the JWT header carries `kid` = `pat-YYYY-MM` (same pattern as the C7 config key id `cfg-YYYY-MM`). The private key is a file-mounted secret read only by the identity signer (`LIMS_IDENTITY_PATIENT_JWT_KEY_FILE`); the core verifier reads a separate list of public keys (`LIMS_CORE_PATIENT_JWT_PUBLIC_KEY_FILES`, like `LIMS_CORE_BFF_KEY_FILES`). Rotation: add the new public key, switch the signer, keep the old public key for at least 2 h (token lifetime plus skew), then remove it; the C1 dual-key rotation runbook applies. An unknown `kid` is rejected like any other bad signature. (d) **Names:** no new `IdentityPort` method and no new API operation. The access JWT is minted inside `IdentityPort.openPatientSession` and the existing patient refresh endpoint (`/v1/identity/auth/patient/*`). The core `auth/jwt.ts` gets a per-issuer table selected by endpoint family; the `claimsResolver` interface is unchanged (the patient variant resolves through the sibling lookup in (a)). Implementation belongs to C2 T31 (patient session kind); it touches C0-owned files (`auth/jwt.ts`, the DDL and isolation registry under `db/`), so it needs change requests or a lead exception when it starts. C2 T1 itself is not unblocked by this: its remaining item is the live GoTrue contract run.
- **A35-6 Effect on older text.** For the `patient` kind only, this supersedes D-218's "patient session kind blocked until T1 confirms", the GoTrue-JWT credential in the R10 item 1 row `bearerJwt`, and the GoTrue-refresh-token sentence in R10 item 3. D-219 is unchanged.

## Addendum A36 — Bridge agent OS set for v1 is Windows 10 and 11; Server 2016 dropped; Windows 10 verification is a pre-pilot release gate (2026-11-11, founder decision)

Source: the AG-T02 spike (C7 06-IMPLEMENTATION-PLAN row AG-T02) needs measured results on every OS in its list, and the founder has no Windows Server 2016 machine to run it on. Dropping the OS from the list is the honest alternative to waiving the test or writing a verdict without a run.

- **A36-1 Decision.** For v1 the bridge agent's supported OS set is Windows 10 and Windows 11 only. Windows Server 2016+ is not claimed: the Go >= 1.21 floor of 04 S16 is unchanged, so the binary is expected to run there, but it is not verified and not supported until a Server VM exists and the AG-T02 spikes and the AG-T15 install/uninstall check have been run on it. Reversible: a later addendum adds Server back to the list.
- **A36-2 What does not change.** Every OS in the list still needs a measured per-OS verdict for S1, S2 and S3, with one line of evidence, and the three DECISION lines. No verdict is written without a run. The fallbacks (LocalService / machine-scope DPAPI / request.json) stay as written.
- **A36-3 Effect on older text.** For v1 this supersedes the OS lists in 04 S16 ("Windows 10/11 or Server 2016+ only"), C7 01-PRD IS-01, C7 02-TRD line 36 (target), and C7 06-IMPLEMENTATION-PLAN rows AG-T02 ("Windows 10, 11, Server 2016 VMs" becomes "Windows 10 and 11 VMs") and AG-T15 ("Win10/11/2016 VMs" becomes "Win10/11 VMs"). The apply phase edits those documents.
- **A36-4 Verification status and release gate (2026-11-11, founder decision).** AG-T02 was measured on Windows 11 Home (build 26300.9711, amd64); evidence in `C:\LIMS-state\spikes\ag-t02\evidence-RAUNAK-20261111-101527.txt`. The founder has no Windows 10 machine, so Windows 10 is recorded as NOT RUN, never as PASS. Windows 10 verification is a pre-pilot **release gate**, not a build gate: S1-S3 and the AG-T15 install/uninstall check are run and recorded on a real Windows 10 machine before the first pilot install. The COM part of S1 (the virtual account opens a real serial device) could not be tested on the Windows 11 machine (no COM port) and belongs to the same gate. A FAIL or PARTIAL on Windows 10 reopens the AG-T02 decisions (account, DPAPI scope, control path) before release; the fallbacks of 02-TRD §5.12 and 06-PLAN R4 stay implemented. AG-T04-T07, T09, T10, T12-T18 and INT-T01 are not held back by the gate. Tracker: `C:\LIMS-state\release-gates.md`.

## Addendum A37 — Reporting extraClaims gains `portal_link_purpose` (2026-11-11, founder decision; resolves the blocking CR of C6-T43)

Source: the C6-T43 blocking CR (`.orchestra/cr/C6-T43.md` in lane C6), escalated by the lead agent because it touches `core/auth`. The FORCE-RLS policies on `report_versions` and `qr_tokens` (08 A21.1, C6 02-TRD §6.6, C6 05-SCHEMA) read `app.current_claims() ->> 'portal_link_purpose'`, and `services/api/src/core/auth/claims.ts` rejects every extraClaims key that is not allow-listed, so the claim could not be emitted and a dues-link session was not isolated from report content (AC-18.9).

- **A37-1 Decision.** The allowed extraClaims keys for the `reporting` module are `portal_stage`, `portal_report_id`, `portal_session_id` and `portal_link_purpose`. The change is additive, reserved claims stay out of the list, and the value comes from the `purpose` column the DEFINER lookup already returns (never from the credential).
- **A37-2 Who changes what.** The founder/lead makes the one-line edit of the C0-owned `claims.ts` allow-list; C6 emits the claim in its portal resolver (C6-T43, LD-96).
- **A37-3 Effect on older text.** For the `reporting` module this supersedes the allowed-keys comments at 03-INTERFACE-CATALOG (line 3474) and at 08 §4.11 (line 1405). The apply phase edits the catalog.

## Addendum A38 — C2 platform-staff set-password: two additive DEFINERs; password-change sign-out and setup-session lifetime for the `platform` kind (2026-11-11, founder decision; resolves the blocking CR of C2-T9)

Source: the C2-T9 blocking CR (`.orchestra/cr/T9.md` in lane C2), escalated by the lead agent because it touches the identity DEFINERs (the auth/RLS layer). Set-password for a platform-staff user (recovery or invite, state SS8) could not complete: no DEFINER lists or revokes a platform user's other sessions, and `app.identity_platform_auth_write_invitation_accept` needs an invitation id that no `identity_auth` lookup returns.

- **A38-1 Decision (two new DEFINERs).** Same pattern as the A28.1 DEFINERs: `SECURITY DEFINER`, `SET search_path = ''`, `app.pre_user_id` set from `p_user_id` and cleared inside the body, `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO lims_api`. No policy change: `sessions__select__owner_only` / `sessions__update__owner_only` already admit `tenant_id IS NULL AND kind = 'platform' AND user_id = app.pre_user_id`, and `invitations__select__owner_only` / `invitations__update__owner_only` already admit `tenant_id IS NULL AND user_id = app.pre_user_id`.
  - (a) `app.identity_platform_auth_write_revoke_other_sessions(p_user_id uuid, p_except_session_id uuid, p_reason text) RETURNS uuid[]` sets `state = 'revoked'`, `revoked_at = now()`, `revoked_by = p_user_id`, `revoke_reason = p_reason`, `updated_at = now()`, `updated_by = p_user_id`, `version = version + 1` on every session with `user_id = p_user_id AND kind = 'platform' AND tenant_id IS NULL AND id <> p_except_session_id AND state NOT IN ('revoked','expired')`, and returns the revoked ids (empty array when none). `p_reason` must be `'password_change'`; any other value raises `P0001 identity_platform_auth_write_invalid_input`. It does not touch `identity.support_sessions` (A38-4).
  - (b) `app.identity_platform_auth_write_invitation_accept_by_user(p_user_id uuid) RETURNS integer` sets `status = 'accepted'`, `accepted_at = now()`, `updated_at = now()`, `updated_by = p_user_id`, `version = version + 1` on every invitation with `tenant_id IS NULL AND user_id = p_user_id AND status = 'sent' AND expires_at > now()` and returns the row count. The two-argument `app.identity_platform_auth_write_invitation_accept(uuid, uuid)` of A28.1 stays as it is.
- **A38-2 Password-change sign-out for the `platform` kind.** `setPasswordFromSetup` does NOT enqueue `identity.gotrue_signout` for a platform user. The platform job is always `adminSignOutUser(user_id)` (02-TRD §10; a worker cannot read a platform session row), which would also invalidate the GoTrue tokens of the live setup session that the user needs next for MFA enrolment (platform staff always enrol, SS3). The requirement is met by the LIMS session revocation of A38-1(a): REQ-SEC-065 makes revocation effective on the next request through the resolver, AU-T11 tests exactly that, and the GoTrue tokens of the other sessions live only in encrypted session rows, never in a browser (08 R10, A35). Tenant kinds are unchanged.
- **A38-3 Setup-session lifetime (SS8).** Unchanged: after set-password the platform session keeps the 15-minute `absolute_expires_at` of SS1 (`…_session_update` deliberately has no key for it). A staff user who runs out of time signs in normally with the new password.
- **A38-4 Known limit.** Revoking a platform session does not end a support session bound to it: the `support_sessions` update policy admits only the expiry maintenance job, and widening it is an RLS change. The bound support session is unreachable (the resolver rejects the revoked platform session) and ends by itself at `expires_at` (`app.identity_expire_support_sessions`); until then a tenant admin's support banner may still list it.
- **A38-5 Who changes what.** C2-T9 writer, additive only, in the C0-owned migration `db/migrations/20261105000800_app__create_identity_definers.sql` (the two functions and their `REVOKE` / `GRANT` lines), under LD-99; C2-T9 tester writes the tests. The apply phase edits 05-SCHEMA (§6 function list and §5.4 table, §10.1 grants, §11 test 34), 02-TRD §10 (`identity.gotrue_signout` row) and 03-APP-FLOW §3.7.
- **A38-6 Effect on older text.** For the `platform` kind this supersedes the "password change" trigger of `identity.gotrue_signout` in 02-TRD §10, and 05-SCHEMA's use of `…_invitation_accept(uuid, uuid)` by `setPasswordFromSetup` (the by-user variant replaces it there; the two-argument function is kept, unused).
